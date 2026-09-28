// /jev-review and /jev-status, served by the command hook. Inside Claude's sandbox the
// LAN is blocked and the sensitive key is not there, so the skills never run the
// reviewer through Bash: the hook runs it, outside the sandbox, and hands the result to
// the skill as additionalContext. Two routes reach it: the user types the command
// (UserPromptExpansion, event expand) or Claude invokes the skill (PreToolUse on Skill,
// event skill). The arguments are untrusted on both routes: Claude writes them in the
// second, and an injection can steer Claude. They are validated, never echoed back.
//
// The output is always a data block, an error included: the skill tells "the hook did
// not run" (no block) from "the review failed" (a block with an error).
import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { claudeContext, reviewErrorContext, safeText, statusContext } from '../core/render.ts'
import { errResult, okResult } from '../core/types.ts'
import type { DiffSource, Json, Result, Transport } from '../core/types.ts'
import { appendLog, LOG_FILE, logLine } from '../node/data.ts'
import { loadConfig, loadMaskMap, readKeyFile } from '../node/file-config.ts'
import { defaultSource, RE_REF, repoRoot } from '../node/git.ts'
import { backendSources, probeStatus, runReview } from '../node/run.ts'

export type OnDemand = 'review' | 'status'

// A plugin's skill is namespaced (jev-hooks:jev-review); the bare name is accepted in
// case a build or a user-level copy drops the namespace.
const COMMANDS: Record<string, OnDemand> = {
  'jev-review': 'review', 'jev-hooks:jev-review': 'review',
  'jev-status': 'status', 'jev-hooks:jev-status': 'status',
}

export function onDemandCommand(name: unknown): OnDemand | undefined {
  if (typeof name !== 'string') return undefined
  const n = name.startsWith('/') ? name.slice(1) : name
  return Object.hasOwn(COMMANDS, n) ? COMMANDS[n] : undefined
}

const MAX_ARGS = 1000
const INVALID = 'invalid argument: use nothing, --staged, --working, a git reference, or a .diff or .patch file inside the repo'

// Nothing (the default source), --staged, --working, a git reference, or a .diff or
// .patch file whose real path is inside the repo: a file outside it could be any file
// the user can read, and its text would reach the backend.
export function parseReviewArgs(text: string, cwd: string, root: string): Result<DiffSource | null> {
  if (text.length > MAX_ARGS) return errResult('config', INVALID)
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return okResult(null)
  if (words.length > 1) return errResult('config', `${INVALID}; one at a time`)
  const w = words[0]
  if (w === '--staged') return okResult({ kind: 'staged' })
  if (w === '--working') return okResult({ kind: 'working' })
  if (/\.(diff|patch)$/i.test(w)) {
    let real: string
    let realRoot: string
    try {
      real = realpathSync(resolve(cwd, w))
      realRoot = realpathSync(root)
    } catch {
      return errResult('config', 'invalid argument: the diff file does not exist')
    }
    const rel = relative(realRoot, real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return errResult('config', 'invalid argument: the diff file is outside the repo')
    return okResult({ kind: 'file', path: real })
  }
  if (RE_REF.test(w) && !w.startsWith('-')) return okResult({ kind: 'ref', ref: w })
  return errResult('config', INVALID)
}

export interface OnDemandRun {
  env: NodeJS.ProcessEnv
  pluginRoot: string
  cwd: string
  session: string
  start: number
  dataDir: string
  transport?: Transport
}

const GIT_MS = 10_000

export async function reviewContext(o: OnDemandRun, args: string): Promise<string> {
  const env = o.env
  if (env.JEV_HOOKS_DISABLE === '1') return reviewErrorContext('off', 'jev-hooks is turned off (JEV_HOOKS_DISABLE=1)')
  // the same rule as the commit hook: a map that exists but cannot be read stops sending
  if (loadMaskMap(env).error) return reviewErrorContext('config', 'invalid guardrail mask map: review not run')
  const root = repoRoot(o.cwd, o.start + GIT_MS, env)
  if (root === null) return reviewErrorContext('git', 'the current directory is not in a git repo')
  const a = parseReviewArgs(args, o.cwd, root)
  if (!a.ok) return reviewErrorContext(a.error.kind, a.error.message)

  // origin skill: .jev-hooks/ rules that differ from HEAD are read at HEAD, as in the
  // commit hook, and the warning goes into the notes
  const c = loadConfig({ cwd: o.cwd, pluginRoot: o.pluginRoot, origin: 'skill', env })
  if (!c.ok) return reviewErrorContext(c.error.kind, c.error.message)
  const cfg = c.value
  const notes: string[] = []
  let source = a.value
  if (source === null) {
    const d = defaultSource(o.cwd, o.start + cfg.policy.limits.skill.total_ms, env)
    if (!d.ok) return reviewErrorContext(d.error.kind, d.error.message)
    source = d.value.source
    notes.push(d.value.note)
  }

  const keyFile = readKeyFile(env)
  const { result, warnings, identity } = await runReview({
    origin: 'skill', cwd: o.cwd, source, sources: backendSources('skill', env, { keyFile: keyFile.key }),
    pluginRoot: o.pluginRoot, start: o.start, config: cfg, env,
    ...(o.transport ? { transport: o.transport } : {}),
  })
  notes.push(...warnings)
  if (keyFile.warning !== undefined) notes.push(keyFile.warning)
  if (notes.length > 0) result.notes = [...notes, ...(result.notes ?? [])]

  appendLog(join(o.dataDir, LOG_FILE), logLine(result, {
    origin: 'skill', session: o.session, repo: basename(root), ...(identity ? { identity } : {}),
  }))
  return claudeContext(result, cfg.checks)
}

export async function statusText(o: OnDemandRun, args: string): Promise<string> {
  const env = o.env
  const fail = (kind: string, message: string): string =>
    statusContext({ ok: false, error: { kind: safeText(kind, 40), message: safeText(message, 600) } })
  if (env.JEV_HOOKS_DISABLE === '1') return fail('off', 'jev-hooks is turned off (JEV_HOOKS_DISABLE=1)')
  if (args.trim() !== '') return fail('config', 'invalid argument: /jev-status takes none')
  const c = loadConfig({ cwd: o.cwd, pluginRoot: o.pluginRoot, origin: 'skill', env })
  if (!c.ok) return fail(c.error.kind, c.error.message)
  const keyFile = readKeyFile(env)
  const s = await probeStatus({
    config: c.value, sources: backendSources('skill', env, { keyFile: keyFile.key }), origin: 'skill',
    ...(o.transport ? { transport: o.transport } : {}),
  })
  if (!s.ok) return fail(s.error.kind, s.error.message)
  const v = s.value
  const warnings = [...c.value.warnings, ...(keyFile.warning !== undefined ? [keyFile.warning] : [])]
  const data: { [k: string]: Json } = {
    ok: true,
    host: v.host, local: v.local, source: v.layer,
    requested_model: v.requestedModel, model: v.model, family: v.family,
    fingerprint: v.fingerprint ?? null,
    probability_status: v.probabilityStatus ?? null,
    probe: { question: v.question, ms: Math.round(v.ms) },
    profile: v.profile, calibrated: v.calibrated, mode: v.mode, delta_logit: v.deltaLogit,
    config: { ...v.sources },
  }
  if (v.models) data.models = v.models
  if (v.modelsNote) data.models_note = v.modelsNote
  if (v.notes.length > 0) data.notes = v.notes.map((n) => safeText(n, 600))
  if (warnings.length > 0) data.warnings = warnings.map((n) => safeText(n, 600))
  return statusContext(data)
}
