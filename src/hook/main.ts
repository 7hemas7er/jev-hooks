// jev-hooks' command hook. run-node.sh runs it with the event as its argument and
// Claude Code's input on standard input. It handles:
// - commit (PreToolUse on Bash): reviews what the commit will contain and
//   decides. A BLOCK (only from the floors, by default) denies; an escalation denies
//   the first time, with the prompt for Claude, and the second time lets the lane
//   decide (deny_then_allow, the default, only for the model's escalations) or asks
//   the user (deny_then_ask, and always for the deterministic ones); a SECURITY REVIEW
//   asks; nits go into the context; a MERGE is one line. The plugin never emits allow:
//   letting the command through means no decision, and Claude Code's permissions decide
//   the rest. An allow would approve the whole Bash command, including whatever follows
//   the commit;
// - post-commit (PostToolUse on Bash): records whether the reviewed commit
//   really happened, material for the 0.2 calibration fit;
// - expand (UserPromptExpansion) and skill (PreToolUse on Skill): /jev-review and
//   /jev-status, served here so that they run outside the sandbox (on-demand.ts);
// - guard (PreToolUse on Edit and Write): asks before Claude edits the project's
//   reviewer rules in .jev-hooks/.
//
// Command hooks run outside the sandbox and reach the LAN, which is why the review
// lives here and not in a git pre-commit hook. On the same repo that Claude can write
// to: git always goes through src/node/git.ts.
//
// Visible fail-open: a backend that is off, slow or refused, or a broken configuration,
// does not block the commit; it says so in one line. Only the detectors' floors apply
// even without a backend. Two guarantees: stdout contains only the decision's
// JSON; an exception ends up on stderr and in the log, with exit 0, without a decision.
import { randomInt, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeCommand, unwrapGuardrail } from '../core/commit.ts'
import { escalationPrompt } from '../core/escalation.ts'
import { mask, unmask } from '../core/mask.ts'
import { formatNumber } from '../core/numbers.ts'
import { claudeContext, hookReason, safeText } from '../core/render.ts'
import { configHashes } from '../core/review.ts'
import { STATE_FORMAT } from '../core/state.ts'
import type { Backend, MaskPair, Failure, HttpOutcome, Identity, CommitIntent, ReviewResult, Transport, EscalationItem } from '../core/types.ts'
import {
  appendLog, dataDir, escalationAlreadyDenied, LOG_FILE, seenFingerprint, localIso, readCache, readPending, firstNotice,
  prunePending, recordFingerprint, logLine, writeCache, writePending, markEscalationDenied, sha256, removePending,
} from '../node/data.ts'
import { backendFrom, runReview, backendSources } from '../node/run.ts'
import { loadConfig, loadMaskMap, describeModifiedRules, readKeyFile, displayPath, pluginVersion, newerInstalledVersion } from '../node/file-config.ts'
import type { LoadedConfig } from '../node/file-config.ts'
import { git, readSource, repoRoot } from '../node/git.ts'
import { nodeClock, nodeTransport } from '../node/transport.ts'
import { onDemandCommand, reviewContext, statusText } from './on-demand.ts'
import type { OnDemandRun } from './on-demand.ts'

// The hook's input is read with a cap.
export const STDIN_CAP = 1024 * 1024

const PREFIX = '[jev-review] '
const MAX_WARNING_LINES = 5

export interface HookContext {
  env: NodeJS.ProcessEnv
  stdin: string
  stdinTruncated: boolean
  write: (s: string) => void             // stdout: only the decision's JSON
  writeErr: (s: string) => void             // stderr
  pluginRoot: string
  transport?: Transport
}

// ─── Output ───────────────────────────────────────────────────────────────────

interface HookOutput {
  decision?: 'deny' | 'ask'
  reason?: string
  context?: string
  messages: string[]
}

function severity(u: HookOutput): number {
  return u.decision === 'deny' ? 3 : u.decision === 'ask' ? 2 : u.context !== undefined ? 1 : 0
}

// The decision's JSON. permissionDecision always sits inside hookSpecificOutput with
// hookEventName. Every text goes through guardrail's mask map: its masking does not
// cover what other plugins write.
function emit(u: HookOutput, ctx: HookContext, maskMap: readonly MaskPair[], eventName: string = 'PreToolUse'): void {
  const m = (s: string): string => (maskMap.length > 0 ? mask(s, maskMap) : s)
  const out: Record<string, unknown> = {}
  if (u.decision !== undefined || u.context !== undefined) {
    const h: Record<string, unknown> = { hookEventName: eventName }
    if (u.decision !== undefined) {
      h.permissionDecision = u.decision
      h.permissionDecisionReason = m(u.reason ?? PREFIX.trim())
    }
    if (u.context !== undefined) h.additionalContext = m(u.context)
    out.hookSpecificOutput = h
  }
  if (u.messages.length > 0) out.systemMessage = m(u.messages.join('\n'))
  if (Object.keys(out).length > 0) ctx.write(`${JSON.stringify(out)}\n`)
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

// Once per session, with a commit review, /jev-review or /jev-status: the session still
// runs an older version than the one installed, so the newer one's rules do not apply.
function staleNotice(ctx: HookContext, dataDir: string, session: string): string[] {
  const newer = newerInstalledVersion(ctx.pluginRoot)
  if (newer === null || !firstNotice(dataDir, session, 'stale_version')) return []
  return [`${PREFIX}jev-hooks ${newer} is installed, but this session still runs ${pluginVersion(ctx.pluginRoot)}: /reload-plugins loads it`]
}

function parseInput(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// commit_review is a userConfig boolean: it arrives in the environment as text.
function isOff(v: string | undefined): boolean {
  return v !== undefined && /^(false|0|no|off)$/i.test(v.trim())
}

function isFailure(b: Backend | Failure): b is Failure {
  return Object.hasOwn(b, 'kind')
}

export function resolvePluginRoot(env: NodeJS.ProcessEnv): string {
  const r = env.CLAUDE_PLUGIN_ROOT
  return r !== undefined && r !== '' ? r : fileURLToPath(new URL('../../', import.meta.url))
}

// The commit directory: `git -C`, a leading `cd`, or the input's cwd. ~ means the
// hook's HOME, as in Claude's shell.
function resolveDir(cwd: string, dir: string | undefined, env: NodeJS.ProcessEnv): string {
  if (dir === undefined) return cwd
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir()
  const c = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir
  return resolve(cwd, c)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// For a detector item the detector counts, not the check: ci_workflow and zero_width
// have no check, and in the log both would be "detector:".
function itemId(v: EscalationItem): string {
  return `${v.reason}:${v.detector ?? v.check ?? ''}`
}

function itemsSummary(items: readonly EscalationItem[]): string {
  return items.map((v) => {
    const name = v.detector ?? v.check
    return `${v.reason}${name !== undefined ? ` ${name}` : ''}${v.p !== undefined ? ` ${formatNumber(v.p, 2)}` : ''}`
  }).join(', ')
}

function seconds(ms: number): string {
  return `${formatNumber(ms / 1000, 1)} s`
}

// ─── commit event ─────────────────────────────────────────────────────────────

interface Examination {
  dir: string
  result: ReviewResult
  config: LoadedConfig
  fromCache: boolean
  approximate: boolean
  addsFirst: boolean                    // a git add before the commit in the same command
  note?: string
  rules?: { files: string[]; withModified?: string }
  reviewId: string
  keyWarning?: string                   // key file readable by others
}

interface CommitRun {
  ctx: HookContext
  dataDir: string
  session: string
  start: number
  cwd: string
  log: (line: Record<string, unknown>) => void
}

// The warning lines of the configuration (non-default sources, ignored project fields,
// invalid files) and of the diff source (approximate review).
function warningLines(e: Examination, a: CommitRun): string[] {
  const lines: string[] = []
  const isDefault = (name: string, source: string): boolean =>
    source === displayPath(join(a.ctx.pluginRoot, 'config', `${name}.json`), a.ctx.env)
  const others = Object.entries(e.config.sources).filter(([k, f]) => !isDefault(k, f))
  if (others.length > 0) lines.push(`config: ${others.map(([k, f]) => `${k}.json = ${f}`).join('; ')}`)
  for (const x of e.config.warnings) if (!x.startsWith('reviewer rules modified')) lines.push(x)
  if (e.note !== undefined) lines.push(e.note)
  if (e.keyWarning !== undefined) lines.push(e.keyWarning)
  return lines.slice(0, MAX_WARNING_LINES).map((r) => PREFIX + safeText(r, 400))
}

function mergeLine(e: Examination): string {
  const r = e.result
  const pieces = [r.lane ?? 'MERGE']
  if (e.fromCache) pieces.push('from the cache')
  else {
    pieces.push(`${r.requests} ${r.requests === 1 ? 'request' : 'requests'}`)
    pieces.push(seconds(r.ms))
  }
  if (r.backend.profile !== undefined) pieces.push(`profile ${r.backend.profile}`)
  return PREFIX + pieces.join(' · ')
}

// What the commit hook answers for a review: nothing, a notice, ask or deny.
function decideHook(e: Examination, a: CommitRun): HookOutput {
  const r = e.result
  const p = e.config.policy
  const warnings = warningLines(e, a)
  const lane = r.lane !== undefined ? p.lanes.find((l) => l.name === r.lane) : undefined
  const rules = e.rules
    ? `reviewer rules modified and not committed: ${describeModifiedRules(e.rules.files)}; verdict with the HEAD rules: ${r.lane ?? 'none'}`
      + (e.rules.withModified !== undefined ? ` (with the modified ones: ${e.rules.withModified})` : '')
    : undefined
  const queue: string[] = []
  if (rules !== undefined) queue.push(rules)
  if (e.approximate) queue.push('approximate review')

  if (!lane) {
    if (r.outcome === 'empty') return { messages: [] }
    // error without floors: visible fail-open
    const reason = `review not run: ${safeText(r.error?.message ?? 'unknown reason', 300)}; commit not reviewed`
    if (rules !== undefined || p.hook.on_error === 'ask') {
      return { decision: 'ask', reason: PREFIX + [reason, ...queue].join(' · '), messages: warnings }
    }
    const first = firstNotice(a.dataDir, a.session, `error:${r.error?.kind ?? 'unknown'}`)
    return { messages: first ? [PREFIX + reason, ...warnings] : [] }
  }

  const context = claudeContext(r, e.config.checks)
  const base = hookReason(r)
  const reason = (extra: string[] = []): string => PREFIX + [base, ...extra, ...queue].join(' · ')
  // A deny stops the whole Bash command, the git add before the commit too: git commit
  // alone would then commit the old index, or nothing, and its diff would not match
  // the escalation key.
  const whole = e.addsFirst ? ' Nothing in the command ran, git add included: repeat the whole command, not git commit alone.' : ''
  // BLOCK floors always deny, on every attempt, whatever the mode
  if (lane.hook === 'deny') {
    return { decision: 'deny', reason: `${reason()}. Fix it before committing, or ask the user.${whole}`, context, messages: warnings }
  }
  // Escalation: the first attempt on a key (diff + items) denies with the
  // prompt, and Claude rereads the listed files. The second, on the same diff and with
  // the same items, means that Claude has reread them and repeats the commit: with
  // deny_then_allow the lane decides, as if there were no escalation, and a log line
  // records it; with deny_then_ask the user decides. Never two escalation denies for
  // the same key: no loops. With context the escalation stays in the context.
  // The go-ahead of deny_then_allow applies only to the model's escalations (threshold,
  // band), the only ones that policy v2 removed from the lanes. A deterministic item
  // (detector, coverage, disagreement) comes from a regex or from files the model has
  // not seen: Claude repeating the commit is not enough, and on the second attempt the
  // user decides, as before v2.
  const modelOnly = r.escalation.every((v) => v.reason === 'threshold' || v.reason === 'band')
  const mode = p.escalation.hook === 'deny_then_allow' && !modelOnly ? 'deny_then_ask' : p.escalation.hook
  // The go-ahead removes the escalation, not the ask there would be without it: with a
  // lane that asks (SECURITY REVIEW) or with modified .jev-hooks/ rules, on the second
  // attempt the user decides anyway. The message and the log must say so: "the commit
  // goes ahead" and escalation_allowed only when the hook decides nothing.
  const asksAfter = mode === 'deny_then_ask' || lane.hook === 'ask' || rules !== undefined
  const after: string[] = []
  if (r.escalation.length > 0 && mode !== 'context') {
    const key = sha256(`${r.config_hashes.diff ?? ''}\n${r.escalation.map(itemId).sort().join('\n')}`)
    if (!escalationAlreadyDenied(a.dataDir, key, p.escalation.ttl_min)) {
      markEscalationDenied(a.dataDir, key, p.escalation.ttl_min)
      const then = asksAfter
        ? 'Then repeat the same commit: the second time the user will decide.'
        : 'If the problem is real, fix it before committing or ask the user; if it is not, repeat the same commit: '
          + 'the second time it goes through without escalation.'
      return {
        decision: 'deny',
        reason: `${reason(['escalation to check before committing'])}\n\n${escalationPrompt(r.escalation)}\n\n${then}${whole}`,
        context,
        messages: warnings,
      }
    }
    if (asksAfter) {
      return { decision: 'ask', reason: reason([`escalation already passed to Claude (${itemsSummary(r.escalation)}): you decide`]), context, messages: warnings }
    }
    a.log({ outcome: 'escalation_allowed', review_id: e.reviewId, escalation: r.escalation.map(itemId) })
    after.push(`escalation already passed to Claude (${itemsSummary(r.escalation)}): the commit goes ahead`)
  }
  if (lane.hook === 'ask' || rules !== undefined) return { decision: 'ask', reason: reason(), context, messages: warnings }
  if (lane.hook === 'warn') return { context, messages: [reason(after), ...warnings] }
  // none: one line; the context only if there is an escalation (context mode, or the
  // second attempt of deny_then_allow)
  const u: HookOutput = { messages: [[mergeLine(e), ...after].join(' · '), ...warnings] }
  if (r.escalation.length > 0) u.context = context
  return u
}

// The verdict with the working tree rules, without the network: if only
// policy.json changed the model's answers do not change, and the recorded ones are
// replayed.
async function withModifiedRules(
  a: CommitRun, dir: string, cfg: LoadedConfig, source: { diff: string; title: string; description: string | null },
  replay: Transport, seed: number, sources: ReturnType<typeof backendSources>,
): Promise<string | undefined> {
  const mod = cfg.modifiedRules
  if (mod.includes('checks.json')) return 'questions modified'
  if (!mod.includes('policy.json')) return undefined
  // the working tree rules are the ones the CLI would use
  const wt = loadConfig({ cwd: dir, pluginRoot: a.ctx.pluginRoot, origin: 'cli', env: a.ctx.env })
  if (!wt.ok) return undefined
  const { result } = await runReview({
    origin: 'hook', cwd: dir, source: { kind: 'text', ...source }, sources, pluginRoot: a.ctx.pluginRoot,
    start: nodeClock.now(), config: wt.value, env: a.ctx.env, transport: replay, seed,
  })
  return result.outcome === 'ok' && result.lane !== undefined ? result.lane : 'cannot be computed without the network'
}

async function examine(intent: CommitIntent, a: CommitRun, maskMap: readonly MaskPair[]): Promise<Examination | HookOutput | null> {
  const env = a.ctx.env
  const dir = resolveDir(a.cwd, intent.dir, env)
  // A directory that does not exist or is outside a repo: never silently, because a
  // guardrail placeholder that was not unmasked would end up right here.
  if (!isDir(dir) || repoRoot(dir, a.start + 10_000, env) === null) {
    const reason = isDir(dir) ? 'the commit directory is not in a git repo' : 'the commit directory does not exist'
    a.log({ outcome: 'uncertain', reason })
    return { messages: [`${PREFIX}${reason}: review skipped`] }
  }

  const c = loadConfig({ cwd: dir, pluginRoot: a.ctx.pluginRoot, origin: 'hook', env: env })
  if (!c.ok) throw new Error(c.error.message)
  const cfg = c.value
  const p = cfg.policy
  if (!p.hook.enabled) return null
  const deadline = a.start + p.limits.hook.total_ms

  const keyFile = readKeyFile(env)
  const sources = backendSources('hook', env, { keyFile: keyFile.key })
  const { backend } = backendFrom(sources, undefined, 'hook')

  const dataDir = a.dataDir
  const s = readSource({ kind: 'commit', intent }, dir, deadline, {
    maxBytes: p.state.max_diff_bytes, env: env, tmpDir: join(dataDir, 'tmp'),
  })
  if (!s.ok) {
    const reason = `review not run: ${safeText(s.error.message, 300)}; commit not reviewed`
    a.log({ outcome: 'error', error: s.error.kind })
    if (p.hook.on_error === 'ask') return { decision: 'ask', reason: PREFIX + reason, messages: [] }
    return { messages: firstNotice(dataDir, a.session, `error:${s.error.kind}`) ? [PREFIX + reason] : [] }
  }
  // empty diff (or --allow-empty without changes): nothing to review
  if (s.value.diff.trim() === '') return null
  const source = { diff: s.value.diff, title: s.value.title, description: s.value.description }
  const approximate = s.value.approximate

  // Cache: only ok outcomes and never approximate reviews. With
  // .jev-hooks/ rules that differ from HEAD the review always runs: the second verdict
  // replays the answers just received.
  const url = isFailure(backend) ? '' : backend.url
  const key = (fingerprint: string): string => sha256(JSON.stringify({
    version: pluginVersion(a.ctx.pluginRoot), url, model: isFailure(backend) ? '' : backend.model, fingerprint,
    state_format: STATE_FORMAT, ...configHashes(cfg), mask_map: sha256(JSON.stringify(maskMap)),
    diff: sha256(source.diff), title: source.title, description: source.description,
  }))
  const useCache = url !== '' && !approximate && cfg.modifiedRules.length === 0
  const cached = useCache ? readCache(dataDir, key(seenFingerprint(dataDir, url)), p.hook.cache_ttl_min) : undefined

  let result: ReviewResult
  let identity: Identity | undefined
  let rules: Examination['rules']
  if (cached) result = cached
  else {
    const recorded = new Map<string, HttpOutcome>()
    const real = a.ctx.transport ?? nodeTransport()
    const transport: Transport = async (rq) => {
      const e = await real(rq)
      if (e.kind === 'response' && e.status === 200) recorded.set(rq.body, e)
      return e
    }
    const seed = randomInt(1, 2 ** 31)
    const done = await runReview({
      origin: 'hook', cwd: dir, source: { kind: 'text', ...source }, sources, pluginRoot: a.ctx.pluginRoot,
      start: a.start, config: cfg, env: env, transport, seed, skipIfTopFloor: true,
    })
    result = done.result
    identity = done.identity
    if (s.value.note !== undefined) result.notes = [...(result.notes ?? []), s.value.note]
    const seen = result.backend.fingerprint ?? (result.backend.model !== undefined ? `model ${result.backend.model}` : undefined)
    if (url !== '' && seen !== undefined) {
      recordFingerprint(dataDir, url, seen)
      if (useCache) writeCache(dataDir, key(seen), result, p.hook.cache_ttl_min)
    }
    if (cfg.modifiedRules.length > 0) {
      const deny = p.lanes.find((l) => l.name === result.lane)?.hook === 'deny'
      const replay: Transport = async (rq) => recorded.get(rq.body)
        ?? { kind: 'network', beforeSend: false, message: 'answer not recorded: the network would be needed', ms: 0 }
      rules = { files: cfg.modifiedRules }
      if (!deny) {
        const cm = await withModifiedRules(a, dir, cfg, source, replay, seed, sources)
        if (cm !== undefined) rules.withModified = cm
      }
    }
  }

  const reviewId = randomUUID()
  const root = repoRoot(dir, a.start + 10_000, env) ?? dir
  const line: Record<string, unknown> = {
    ...logLine(result, {
      origin: 'hook', session: a.session, repo: basename(root), version: pluginVersion(a.ctx.pluginRoot), ...(identity ? { identity } : {}),
    }),
    review_id: reviewId,
  }
  if (cached) line.from_cache = true
  if (approximate) line.approximate = true
  appendLog(join(dataDir, LOG_FILE), line)

  const e: Examination = { dir, result, config: cfg, fromCache: cached !== undefined, approximate, addsFirst: intent.adds !== null, reviewId }
  if (s.value.note !== undefined) e.note = s.value.note
  if (rules) e.rules = rules
  if (keyFile.warning !== undefined) e.keyWarning = keyFile.warning
  return e
}

async function commit(ctx: HookContext, dataDir: string, start: number): Promise<void> {
  const env = ctx.env
  const input = parseInput(ctx.stdin)
  const session = typeof input?.session_id === 'string' && input.session_id !== '' ? input.session_id : 'unknown'
  const log = (line: Record<string, unknown>): void => {
    appendLog(join(dataDir, LOG_FILE), { ts: localIso(), origin: 'hook', session, ...line })
  }
  // A command over the cap cannot be read: say so, so that a commit with a message
  // inflated on purpose does not go through silently.
  if (ctx.stdinTruncated) {
    log({ outcome: 'uncertain', reason: 'input over 1 MB' })
    emit({ messages: [`${PREFIX}command over 1 MB: commit not reviewed`] }, ctx, [])
    return
  }
  if (!input) return
  if (env.JEV_HOOKS_DISABLE === '1' || isOff(env.CLAUDE_PLUGIN_OPTION_COMMIT_REVIEW)) return
  if (input.tool_name !== 'Bash') return
  const ti = input.tool_input as { command?: unknown } | null | undefined
  const command = typeof ti?.command === 'string' ? ti.command : ''
  if (!command.includes('commit')) return

  // 1. The command as the machine will run it: outside guardrail's wrapper, with the
  // real terms in place of the placeholders (same semantics as mask.unmask).
  const m = loadMaskMap(env)
  if (m.error) {
    log({ outcome: 'uncertain', reason: 'invalid guardrail mask map' })
    if (firstNotice(dataDir, session, 'mask_map')) emit({ messages: [`${PREFIX}${m.error.message}: commit not reviewed`] }, ctx, [])
    return
  }
  const maskMap = m.maskMap ?? []
  const inner = unwrapGuardrail(command) ?? command
  const analysis = analyzeCommand(maskMap.length > 0 ? unmask(inner, maskMap) : inner)
  if (analysis.outcome === 'none') return
  if (analysis.outcome === 'uncertain') {
    // a safety net, not a barrier: record it and let it through. The reason can quote
    // an option of the command: it goes through the mask map like every output.
    const reason = analysis.reason ?? 'command not recognized'
    log({ outcome: 'uncertain', reason: maskMap.length > 0 ? mask(reason, maskMap) : reason })
    return
  }

  // 2. Backend not configured: one notice per session, then silence.
  const { backend } = backendFrom(backendSources('hook', env, { keyFile: readKeyFile(env).key }), undefined, 'hook')
  if (isFailure(backend) && backend.kind === 'not_configured') {
    if (firstNotice(dataDir, session, 'not_configured')) {
      emit({ messages: [`${PREFIX}${backend.message}: commit review turned off`] }, ctx, maskMap)
    }
    return
  }

  const a: CommitRun = {
    ctx, dataDir, session, start, log,
    cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd(),
  }
  // Several commits in the same command: all of them are reviewed, within the same
  // deadline, and the most severe decision wins.
  let selection: { u: HookOutput; e?: Examination } | undefined
  for (const intent of analysis.outcome) {
    const x = await examine(intent, a, maskMap)
    if (x === null) continue
    const u = 'result' in x ? decideHook(x, a) : x
    const e = 'result' in x ? x : undefined
    if (!selection || severity(u) > severity(selection.u)) selection = e ? { u, e } : { u }
  }
  if (!selection) return

  // 3. For post-commit: HEAD as it is now, to know whether the commit happened.
  const e = selection.e
  if (e && session !== 'unknown') {
    const h = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: e.dir, deadline: nodeClock.now() + 5000, env: env })
    writePending(dataDir, {
      session, head_before: h.ok && h.value.code === 0 ? h.value.stdout.trim() : null, review_id: e.reviewId,
      diff_sha: e.result.config_hashes.diff ?? '', escalation: e.result.escalation.map(itemId), ts: localIso(), dir: e.dir,
    })
  }
  emit({ ...selection.u, messages: [...selection.u.messages, ...staleNotice(ctx, dataDir, session)] }, ctx, maskMap)
}

// ─── post-commit event ────────────────────────────────────────────────────────

// Only the file of the input's session is read: two sessions with overlapping commits
// do not step on each other's toes. The file is removed in any case.
function postCommit(ctx: HookContext, dataDir: string): void {
  prunePending(dataDir)
  const input = parseInput(ctx.stdin)
  const session = typeof input?.session_id === 'string' && input.session_id !== '' ? input.session_id : undefined
  if (session === undefined) return
  const expected = readPending(dataDir, session)
  if (!expected) return
  try {
    const h = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: expected.dir, deadline: nodeClock.now() + 5000, env: ctx.env })
    const head = h.ok && h.value.code === 0 ? h.value.stdout.trim() : null
    if (head !== null && head !== expected.head_before) {
      appendLog(join(dataDir, LOG_FILE), {
        ts: localIso(), origin: 'hook', session, outcome: 'commit_done', review_id: expected.review_id, escalation: expected.escalation,
      })
    }
  } finally {
    removePending(dataDir, session)
  }
}

// ─── expand and skill events ──────────────────────────────────────────────────

// The same review or probe on both routes, as context and never as a decision: a
// block (decision on UserPromptExpansion, deny on Skill) would hide the error from the
// skill, which is there to explain it.
async function onDemand(ctx: HookContext, dataDir: string, start: number, event: 'expand' | 'skill'): Promise<void> {
  const input = parseInput(ctx.stdin)
  if (!input) return
  let name: unknown
  let args: unknown
  if (event === 'expand') {
    name = input.command_name
    args = input.command_args
  } else {
    if (input.tool_name !== 'Skill') return
    const ti = input.tool_input as { skill?: unknown; args?: unknown } | null | undefined
    name = ti?.skill
    args = ti?.args
  }
  const command = onDemandCommand(name)
  if (command === undefined) return
  const run: OnDemandRun = {
    env: ctx.env, pluginRoot: ctx.pluginRoot, dataDir, start,
    cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd(),
    session: typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : 'unknown',
    ...(ctx.transport ? { transport: ctx.transport } : {}),
  }
  const text = typeof args === 'string' ? args : ''
  const context = command === 'review' ? await reviewContext(run, text) : await statusText(run, text)
  emit({ context, messages: staleNotice(ctx, dataDir, run.session) }, ctx, loadMaskMap(ctx.env).maskMap ?? [], event === 'expand' ? 'UserPromptExpansion' : 'PreToolUse')
}

// ─── guard event ──────────────────────────────────────────────────────────────

// A path with a .jev-hooks segment, in any case: on a case-insensitive file system
// .JEV-HOOKS/ is the same directory.
const RE_RULES_DIR = /(^|[\\/])\.jev-hooks([\\/]|$)/i

// Not the main protection: sed or cat > through Bash write .jev-hooks/ as well, and the
// sandbox lets Claude write in the working directory. The rules of file-config.ts are
// (HEAD rules and ask when .jev-hooks/ differs; the project can only tighten), plus the
// reviewer_rules detector. This hook only stops Claude from loosening them in silence
// with its own editing tools. A link to .jev-hooks/ under another name is not followed:
// making one takes Bash, which can write the rules directly anyway.
function guard(ctx: HookContext): void {
  if (ctx.env.JEV_HOOKS_DISABLE === '1') return
  const reason = `${PREFIX}change to the reviewer rules in .jev-hooks/ (thresholds, questions or profiles): confirm it yourself`
  // an input over the cap cannot be parsed: a Write of a huge file must not pass for that
  if (ctx.stdinTruncated) {
    if (/\.jev-hooks/i.test(ctx.stdin)) emit({ decision: 'ask', reason, messages: [] }, ctx, [])
    return
  }
  const input = parseInput(ctx.stdin)
  if (!input || (input.tool_name !== 'Edit' && input.tool_name !== 'Write')) return
  const ti = input.tool_input as { file_path?: unknown } | null | undefined
  if (typeof ti?.file_path !== 'string') return
  if (RE_RULES_DIR.test(ti.file_path)) emit({ decision: 'ask', reason, messages: [] }, ctx, [])
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main(event: string, ctx: HookContext): Promise<void> {
  const start = nodeClock.now()
  const stateDir = dataDir(ctx.env)
  try {
    if (event === 'commit') await commit(ctx, stateDir, start)
    else if (event === 'post-commit') postCommit(ctx, stateDir)
    else if (event === 'expand' || event === 'skill') await onDemand(ctx, stateDir, start, event)
    else if (event === 'guard') guard(ctx)
    else ctx.writeErr(`[jev-hooks] unhandled event: ${safeText(event, 40)}\n`)
  } catch (err) {
    // A bug in the hook never stops the work: no decision, one line on stderr and in
    // the log. The message goes through the mask map, if it can be read.
    let message = safeText(err instanceof Error ? err.message : String(err), 300)
    const m = loadMaskMap(ctx.env).maskMap
    if (m) message = mask(message, m)
    ctx.writeErr(`[jev-hooks] internal error in the ${safeText(event, 40)} hook: ${message}\n`)
    try {
      appendLog(join(stateDir, LOG_FILE), { ts: localIso(), origin: 'hook', event, outcome: 'exception', message })
    } catch {
      // not even the log: the line on stderr remains
    }
  }
}

async function readStdin(cap: number): Promise<{ text: string; truncated: boolean }> {
  const pieces: Buffer[] = []
  let n = 0
  for await (const piece of process.stdin) {
    const b = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece))
    pieces.push(b)
    n += b.length
    if (n > cap) break
  }
  const all = Buffer.concat(pieces)
  return { text: all.subarray(0, cap).toString('utf8'), truncated: all.length > cap }
}

function runDirectly(): boolean {
  const a = process.argv[1]
  if (a === undefined) return false
  try {
    return realpathSync(a) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runDirectly()) {
  let out = ''
  const { text, truncated } = await readStdin(STDIN_CAP)
  await main(process.argv[2] ?? '', {
    env: process.env, stdin: text, stdinTruncated: truncated,
    write: (s) => { out += s },
    writeErr: (s) => { process.stderr.write(s) },
    pluginRoot: resolvePluginRoot(process.env),
  })
  // Exit as soon as the decision is written: a keep-alive connection to the backend or
  // a Worker must not keep the hook open until Claude Code's timeout.
  process.exitCode = 0
  if (out === '') process.exit(0)
  else process.stdout.write(out, () => process.exit(0))
}
