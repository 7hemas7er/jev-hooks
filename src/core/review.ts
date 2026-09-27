// Review orchestrator: from the text of the diff to the result that hook, CLI
// and Action each render in their own way. This is where it is decided what is sent,
// in which order, with how much concurrency, when to stop and how to read what comes
// back; the detailed rules live in the modules called from here (chunks, systemone,
// calibration, verdict, escalation).
//
// Three choices hold up the rest:
// - never a retry on a timeout, and towards rizzo not even other requests: rizzo
//   serializes and keeps computing abandoned requests, so every extra request would
//   queue behind that one and lengthen the wait;
// - detector floors always apply, even when the backend is missing, does not answer
//   or changes midway: a secret recognized by the regex blocks anyway;
// - the review always ends within limits[origin].total_ms from the start of the entry
//   point: beyond that, Claude Code would cancel the hook and the commit would go
//   through without even the floors.
//
// Pure (rule 4): time, network, randomness and project regexes come from outside.
import { aggregateNoul, calibrate, calibrateDerived, consistentHashes, derivedOption, derivedProbability, chooseProfile } from './calibration.ts'
import type { SentNoul } from './calibration.ts'
import { canonical } from './canonical.ts'
import { prng } from './random.ts'
import { matchesAny, parseDiff } from './diff.ts'
import { escalation } from './escalation.ts'
import { isObject } from './json.ts'
import { mask } from './mask.ts'
import { planChunks } from './chunks.ts'
import { shownIdentity, safeLevel, safeChoice } from './provenance.ts'
import { redactForBackend } from './redaction.ts'
import { detect, mergeDetectorResults } from './detectors.ts'
import { sha256Hex } from './sha256.ts'
import { estimateTokens, truncate } from './state.ts'
import { ask, wireQuestion, questionHash, identityOf, MARGIN_MS, whichQuestion } from './systemone.ts'
import { ciConclusion, decide, mergeReady, valuesFromVerdict } from './verdict.ts'
import type { CoverageGaps } from './verdict.ts'
import type {
  Backend, CheckDef, Checks, ReviewConfig, Lane, ReviewDeps, WireQuestion, Failure, Result, DetectorResult, FileDiff, Identity,
  ReviewInput, Json, Plan, Policy, ReviewResult, BackendResponse, DiscardedAnswer, ProfileSelection, Transport, CheckValue,
  EscalationItem,
} from './types.ts'
import { errResult, okResult } from './types.ts'

export type { ReviewConfig, ReviewDeps, ReviewInput, ReviewResult } from './types.ts'

// The new budget after an overflow is taken with this margin: the client's
// token estimate and the backend's tokenizer never quite agree.
const OVERFLOW_MARGIN = 0.85

// Exit code of a review without a verdict: backend missing, broken or changed.
const EXIT_ERROR = 4

type Questions = Record<string, WireQuestion>
type CiClass = 'backend_unavailable' | 'untrusted_input'

// A request to make: the state of a chunk (chunk questions) or the global one (global
// questions). text is the state before redaction and masking.
interface Job {
  kind: 'chunk' | 'global'
  index: number                          // chunk number, 0 for the global state: it is ChunkValue.chunk
  file: string[]                          // raw paths of the chunk's files
  text: string
  depth: number                      // re-splits already done on this branch
}

interface DoneJob { job: Job; response: BackendResponse; discarded: DiscardedAnswer[] }

// http: the HTTP status of the last response, if there was one. It tells a 422
// (content of the request, that is of the PR) apart from a 400 or a 404 (backend
// configuration).
interface JobFailure { error: Failure; http?: number }
interface FailedJob extends JobFailure { job: Job }

function isBackend(b: Backend | Failure): b is Backend {
  return !Object.hasOwn(b, 'kind')
}

// ─── Config hashes ────────────────────────────────────────────────────────────

// The effective configuration contains RegExps: for the hash they are written as
// /source/flags. The top-level file and fromProject fields say where the file comes
// from, not what it contains: two identical copies of the same JSON must have the same
// hash.
function toJson(v: unknown, root: boolean = false): Json {
  if (v instanceof RegExp) return `/${v.source}/${v.flags}`
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.map((x) => toJson(x))
  if (typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === 'function' || (root && (k === 'file' || k === 'fromProject'))) continue
      out[k] = toJson(x)
    }
    return out
  }
  return null
}

// Canonical JSON sorts the keys, the options of a choice too: two checks.json with
// swapped options would give the same hash, that is the same entry in the hook's
// cache, with opposite answers from the model (rizzo assigns the letters in option
// order). Next to the file there are therefore the hashes of the questions asked of
// the model, which keep the option order (hashForm).
function checksHash(ch: Checks): string {
  const questions: { [k: string]: Json } = {}
  for (const id of ch.order) if (ch.defs[id].source === 'model') questions[id] = questionHash(wireQuestion(ch.defs[id]))
  return sha256Hex(canonical({ ...(toJson(ch, true) as { [k: string]: Json }), questions }))
}

// The sha of the three effective JSON files: they go into the log line and into the
// key of the hook's cache, which computes them before calling review().
export function configHashes(c: ReviewConfig): { checks: string; policy: string; calibration: string } {
  return {
    checks: checksHash(c.checks),
    policy: sha256Hex(canonical(toJson(c.policy, true))),
    calibration: sha256Hex(canonical(toJson(c.calibration, true))),
  }
}

// The sha of the log line: diff, the three effective JSON files and every sent
// question. They are the material for the 0.2 calibration fit.
function hashesOf(i: ReviewInput, c: ReviewConfig, questions: Questions): Record<string, string> {
  const out: Record<string, string> = { diff: sha256Hex(i.diff), ...configHashes(c) }
  for (const id of Object.keys(questions)) out[`question.${id}`] = questionHash(questions[id])
  return out
}

// ─── Path regexes of a project checks.json ────────────────────────────────────
//
// escalation_patterns and all_files_match of a project checks.json are regexes written
// by whoever prepared the repo: one with catastrophic backtracking, on a long path,
// would hold the hook until Claude Code's timeout, and the commit would go through
// without even the floors. So they run outside (a Worker with a time limit) on
// every path of the diff, and here each regex is replaced by the literal list of the
// paths it matched: same results for priority, escalation and docs_only, no
// backtracking.

type PathField = 'escalation_patterns' | 'all_files_match'

function pathRegexes(ch: Checks): { id: string; field: PathField; k: number; re: RegExp }[] {
  const out: { id: string; field: PathField; k: number; re: RegExp }[] = []
  for (const id of ch.order) {
    const def = ch.defs[id]
    def.escalation_patterns.forEach((re, k) => out.push({ id, field: 'escalation_patterns', k, re }))
    def.compute?.all_files_match?.forEach((re, k) => out.push({ id, field: 'all_files_match', k, re }))
  }
  return out
}

// A regex that matches exactly these paths and nothing else.
function literalRegex(paths: readonly string[]): RegExp {
  if (paths.length === 0) return /(?!)/
  return new RegExp(`^(?:${paths.map((x) => x.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})$`)
}

async function checksWithMatches(ch: Checks, paths: string[], port: ReviewDeps['matchProjectPaths']):
  Promise<{ checks: Checks; done: boolean }> {
  const all = pathRegexes(ch)
  if (all.length === 0) return { checks: ch, done: true }
  let table: number[][] | null = null
  if (port) {
    try {
      table = await port(all.map((x) => ({ source: x.re.source, flags: x.re.flags })), paths)
    } catch {
      table = null
    }
  }
  const valid = table !== null && table.length === all.length
    && table.every((lines) => Array.isArray(lines) && lines.every((j) => Number.isInteger(j) && j >= 0 && j < paths.length))
  const items: Record<string, CheckDef> = {}
  for (const id of ch.order) {
    const def = ch.defs[id]
    items[id] = { ...def, escalation_patterns: [...def.escalation_patterns] }
    if (def.compute?.all_files_match) items[id].compute = { ...def.compute, all_files_match: [...def.compute.all_files_match] }
  }
  all.forEach((x, n) => {
    const re = literalRegex(valid ? (table as number[][])[n].map((j) => paths[j]) : [])
    if (x.field === 'escalation_patterns') items[x.id].escalation_patterns[x.k] = re
    else (items[x.id].compute?.all_files_match as RegExp[])[x.k] = re
  })
  return { checks: { ...ch, defs: items }, done: valid }
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

// An empty or whitespace-only description is no description: description_matches
// does not come into play.
function descriptionOf(d: string | null, max: number): string | null {
  if (d === null || d.trim() === '') return null
  return truncate(d, max)
}

// The most severe lane among the floors: needed when every other verdict is missing
// (internal exception), so that a recognized secret blocks anyway.
function laneFromFloors(p: Policy, floors: DetectorResult['floors']): Lane | undefined {
  let best = -1
  for (const f of floors) {
    const k = p.lanes.findIndex((c) => c.name === f.lane)
    if (k >= 0 && (best < 0 || k < best)) best = k
  }
  return best < 0 ? undefined : p.lanes[best]
}

// Without any answer there is no profile: no transformations, policy thresholds.
function neutralSelection(p: Policy): ProfileSelection {
  return { profile: { name: 'none', match: {}, calibrated: false }, mode: 'client', deltaLogit: p.band.delta_logit, notes: [] }
}

// Whose problem it is, for the conclusion of the check run. A backend
// that is off, slow, without a key, with a wrong model or URL: it does not depend on
// the PR author (neutral by default). Everything the content of the PR can cause (a
// 422 on the request, malformed answers, an overflow that does not fit back, a backend
// that changes midway, an exception while reading the input): untrusted input.
function classOf(e: Failure, http: number | undefined): CiClass {
  switch (e.kind) {
    case 'not_configured':
    case 'network':
    case 'timeout':
    case 'auth':
    case 'server':
    case 'overloaded':
    case 'mask_map':
      return 'backend_unavailable'
    case 'config':
      return http === 422 ? 'untrusted_input' : 'backend_unavailable'
    default:
      return 'untrusted_input'
  }
}

// The [diff] section of a chunk state: the diff lines as they were sent, file headers
// included. The paths of the [files] list go through safePath, which does not let "["
// through: the first header is the real one.
function chunkDiff(text: string): string {
  const k = text.indexOf('\n[diff]\n')
  return k < 0 ? '' : text.slice(k + '\n[diff]\n'.length)
}

// The level of a score, for whoever prints it: the criterion of the trusted
// checks.json closest to the score. Never the legend of the answer: it is text from
// the backend, and the level goes out to Claude. For a project checks.json,
// safeLevel.
function levelLabel(score: number, w: WireQuestion): string | undefined {
  const v = Array.isArray(w.criteria) ? w.criteria[Math.round(score)] : undefined
  if (v === undefined) return undefined
  return typeof v === 'string' ? v : canonical(v)
}

// The paths that go out to Claude go through guardrail's mask map, if there is one:
// guardrail's masking does not cover other plugins'
// additionalContext, and render.ts does not receive the map.
function maskPaths(r: ReviewResult, c: ReviewConfig): ReviewResult {
  const maskMap = c.maskMap
  if (!maskMap || maskMap.length === 0) return r
  const m = (s: string): string => mask(s, maskMap)
  return {
    ...r,
    hits: r.hits.map((k) => (k.file === undefined ? k : { ...k, file: m(k.file) })),
    escalation: r.escalation.map((v): EscalationItem => {
      const out: EscalationItem = { ...v, files: v.files.map(m) }
      if (v.lines) out.lines = Object.fromEntries(Object.entries(v.lines).map(([f, x]) => [m(f), x]))
      return out
    }),
    files: {
      examined: r.files.examined.map(m),
      ignored: r.files.ignored.map(m),
      unreviewable: r.files.unreviewable.map(m),
      omitted: r.files.omitted.map((o) => ({ path: m(o.path), reason: o.reason })),
    },
    values: Object.fromEntries(Object.entries(r.values).map(([id, v]) => {
      if (!v.worst && !v.perChunk) return [id, v]
      const out: CheckValue = { ...v }
      if (v.worst) out.worst = v.worst.map(m)
      if (v.perChunk) out.perChunk = v.perChunk.map((pp) => ({ ...pp, files: pp.files.map(m) }))
      return [id, out]
    })),
  }
}

// The checks computed from the paths (compute.all_files_match): docs_only looks at
// every path of the diff, examined, ignored and omitted, and also at the original name
// of a rename (moving code into docs/ is not a docs-only change). Exported for
// scripts/simulate-policy.ts, which replays the bench answers with the same code.
export function valuesFromPaths(checks: Checks, file: readonly FileDiff[]): Record<string, CheckValue> {
  const out: Record<string, CheckValue> = {}
  const paths = file.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.path, f.oldPath]))
  for (const id of checks.order) {
    const re = checks.defs[id].compute?.all_files_match
    if (checks.defs[id].source !== 'computed' || !re) continue
    out[id] = { value: paths.length > 0 && paths.every((x) => matchesAny(re, x)) ? 1 : 0, source: 'computed' }
  }
  return out
}

// ─── review() ─────────────────────────────────────────────────────────────────

export async function review(i: ReviewInput, c: ReviewConfig, deps: ReviewDeps): Promise<ReviewResult> {
  const o = deps.clock
  const start = deps.start ?? o.now()
  const p = c.policy
  const host = isBackend(deps.backend) ? deps.backend.host : ''
  let det: DetectorResult | null = null
  try {
    return maskPaths(await reviewInner(i, c, deps, start, (r) => { det = r }), c)
  } catch (e) {
    // An exception here is almost always an input the code did not expect: for the
    // Action it is untrusted input (a diff crafted on purpose must not produce a
    // neutral), and the floors already computed apply anyway.
    const floors = (det as DetectorResult | null)?.floors ?? []
    const lane = laneFromFloors(p, floors)
    const error: Failure = { kind: 'internal', message: `internal error during the review: ${e instanceof Error ? e.message : String(e)}` }
    const ci = ciConclusion({
      lane: lane ?? p.lanes[p.lanes.length - 1], escalation: [],
      partial: { omitted: 0, unreviewable: 0, incomplete: true }, outcome: 'error',
    }, p)
    ci.reason = error.message
    const r: ReviewResult = {
      outcome: 'error', exit_code: lane ? lane.exit_code : EXIT_ERROR, fired: [], unevaluated: [], values: {},
      escalation: [], merge_ready: false, hits: (det as DetectorResult | null)?.hits ?? [],
      files: { examined: [], ignored: [], unreviewable: [], omitted: [] },
      ci,
      backend: { host, calibrated: false, delta_logit: p.band.delta_logit, notes: [] }, requests: 0, ms: o.now() - start, input_tokens: 0, shape: 'single',
      redactions: 0, config_sources: { ...c.sources }, config_hashes: { diff: sha256Hex(i.diff) }, error,
    }
    if (lane) r.lane = lane.name
    return maskPaths(r, c)
  }
}

async function reviewInner(
  i: ReviewInput, c: ReviewConfig, deps: ReviewDeps, start: number, detected: (r: DetectorResult) => void,
): Promise<ReviewResult> {
  const o = deps.clock
  const p = c.policy
  let checks = c.checks
  const limits = p.limits[i.origin]
  const deadline = start + limits.total_ms
  const backend = isBackend(deps.backend) ? deps.backend : null
  const notes: string[] = []
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n)
  }

  // The questions that are sent: the model's, minus those that need a description
  // when there is none. The chunk ones go to every chunk, the global ones to the
  // global state; only type, instructions and criteria reach the backend.
  const description = descriptionOf(i.description, p.state.max_description_chars)
  const meta = { title: truncate(i.title, p.state.max_description_chars), description }
  const chunkQuestions: Questions = {}
  const globalQuestions: Questions = {}
  for (const id of checks.order) {
    const def = checks.defs[id]
    if (def.source !== 'model') continue
    if (description === null && def.requires.includes('description')) continue
    ;(def.scope === 'chunk' ? chunkQuestions : globalQuestions)[id] = wireQuestion(def)
  }
  const all: Questions = { ...chunkQuestions, ...globalQuestions }

  const base: Omit<ReviewResult, 'outcome' | 'exit_code' | 'ci' | 'ms' | 'config_hashes'> = {
    fired: [], unevaluated: [], values: {}, escalation: [], merge_ready: false, hits: [],
    files: { examined: [], ignored: [], unreviewable: [], omitted: [] },
    backend: { host: backend?.host ?? '', calibrated: false, notes: [] },
    requests: 0, input_tokens: 0, shape: 'single', redactions: 0, config_sources: { ...c.sources },
  }

  // 1. Empty diff: nothing to review, no request.
  if (i.diff.trim() === '') {
    return { ...base, outcome: 'empty', exit_code: 0, ci: { conclusion: 'success' }, ms: o.now() - start, config_hashes: { diff: sha256Hex(i.diff) } }
  }

  // 2. Parsing, with the caps of policy.state. A non-empty text in which the parser
  // recognizes no file is not an empty diff: calling it "empty" would be a go-ahead.
  const d = parseDiff(i.diff, { maxBytes: p.state.max_diff_bytes, maxLineChars: p.state.max_line_chars })
  if (d.files.length === 0) {
    throw new Error('no file recognized in the diff (expected a git unified diff)')
  }

  // 3. Detectors, before any call and without the network. The project ones run
  // outside, with a time limit: if they time out or nothing can run them, coverage is
  // partial, because a detector that did not run saw nothing.
  let det = detect(d, meta, { ...p, detectors: p.detectors.filter((r) => !r.fromProject) })
  detected(det)
  // Floor already at the top (commit hook): the most severe lane cannot go up
  // and the model cannot lower it. No request, and not even the project detectors,
  // which could only add floors.
  const max = p.lanes[0].name
  const withoutBackend = deps.skipIfTopFloor === true && det.floors.some((f) => f.lane === max)
  const fromProject = withoutBackend ? [] : p.detectors.filter((r) => r.fromProject)
  let projectDetectorsTimedOut = 0
  if (fromProject.length > 0) {
    let outcome: DetectorResult | null = null
    try {
      outcome = deps.runProjectDetectors ? await deps.runProjectDetectors({ ...p, detectors: fromProject }, d, meta) : null
    } catch {
      outcome = null
    }
    if (outcome) {
      det = mergeDetectorResults(det, outcome, p)
      detected(det)
    } else {
      projectDetectorsTimedOut = fromProject.length
      note(`project detectors not evaluated (${fromProject.map((r) => r.name).join(', ')}): time ran out or execution unavailable`)
    }
  }

  // 3b. The path regexes of a project checks.json, outside the core and with a time
  // limit, like the project detectors. If they time out nothing matches (docs_only is
  // 0) and coverage is partial. With the floor already at the top they are not needed:
  // no chunk is sent.
  let pathRegexesTimedOut = false
  if (checks.fromProject) {
    const paths = [...new Set(d.files.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.path, f.oldPath])))]
    const r = await checksWithMatches(checks, paths, withoutBackend ? undefined : deps.matchProjectPaths)
    checks = r.checks
    if (!r.done && !withoutBackend) {
      pathRegexesTimedOut = true
      note(`path regexes of ${c.sources.checks ?? 'checks.json'} not evaluated: time ran out or execution unavailable`)
    }
  }

  // 4. Plan: chunks in priority order, global state.
  const plan = planChunks(d, meta, checks, p, { maxChunks: limits.max_chunks, tokensPerState: p.state.tokens_per_state }, det.hits)
  const hasChunk = Object.keys(chunkQuestions).length > 0
  let examined = plan.examined
  let globalOmitted = plan.omitted
  const extraOmitted = new Map<string, string>()

  // 5. Reasons to send nothing: backend not resolved, broken guardrail mask map towards
  // a backend that leaves the machine (better nothing sent than something sent in
  // plain text).
  let early: Failure | undefined
  if (!backend) early = deps.backend as Failure
  else if (!backend.local && c.maskMapError) early = c.maskMapError

  // ─── Sending ────────────────────────────────────────────────────────────────
  const queue: Job[] = []
  if (hasChunk) for (const pt of plan.chunks) queue.push({ kind: 'chunk', index: pt.index, file: pt.files, text: pt.text, depth: 0 })
  if (Object.keys(globalQuestions).length > 0) queue.push({ kind: 'global', index: 0, file: [], text: plan.global, depth: 0 })
  const jobs = queue.length

  const rnd = prng(deps.seed)
  const memo = new Map<string, string>()   // one secret, a single substitute across the whole review
  let redactions = 0
  let requests = 0
  let inputTokens = 0
  let family: Identity['family'] | undefined
  let first: Identity | undefined
  let firstKey: string | undefined
  let changed: Failure | undefined
  let stopped: FailedJob | undefined          // the error that stopped the sending
  let notSent = 0
  let nextIndex = plan.chunks.reduce((m, pt) => Math.max(m, pt.index), 0) + 1
  const succeeded: DoneJob[] = []
  const failed: FailedJob[] = []

  const stop = (f: FailedJob): void => {
    if (!stopped) stopped = f
  }

  // Towards a non-local backend the state goes through redaction and the mask map.
  const prepare = (b: Backend, text: string): string => {
    if (b.local) return text
    const r = redactForBackend(b, text, p, rnd, memo)
    redactions += r.redactions
    return c.maskMap && c.maskMap.length > 0 ? mask(r.text, c.maskMap) : r.text
  }

  // Overflow: the chunk is re-split with a budget that accounts for the
  // question's tokens not shrinking when the state gets shorter. T is the client's
  // estimate of the state that overflowed, qId that of the named question: N covers the
  // state plus that question, so scale = N/(T + qId) brings the client's estimates onto
  // the backend's scale. Q is the longest question of the request, not only the named
  // one: the backend names the first one that overflows, and a budget cut for a short
  // question would make the next one overflow. The new state must fit with Q:
  // T' = (C − Q)/scale, that is the design's (C − Q)·T/(N − qId·scale). With Q in the
  // denominator too the estimate was inflated by T/(T − (qMax − qId)), the margin
  // vanished and the re-split overflowed again, using up an overflow_resplits attempt.
  const resplit = (l: Job, ov: NonNullable<Failure['overflow']>, state: string, questions: Questions): Result<Job[]> => {
    const message = `${whichQuestion(ov)} exceeds the backend context (${ov.tokens} tokens, limit ${ov.limit})`
    if (l.depth >= p.network.overflow_resplits) {
      return errResult('overflow', `${message}: already re-split ${l.depth} ${l.depth === 1 ? 'time' : 'times'}`, { overflow: ov })
    }
    const cpt = p.state.chars_per_token
    const T = estimateTokens(state, cpt)
    const estimates = Object.entries(questions).map(([id, w]) => ({ id, q: estimateTokens(canonical(w as unknown as Json), cpt) }))
    const longest = estimates.reduce((a, b) => (b.q > a.q ? b : a))
    const qId = estimates.find((x) => x.id === ov.question)?.q ?? longest.q
    const scale = ov.tokens / (T + qId)
    const Q = longest.q * scale
    const newT = Math.floor(((ov.limit - Q) / scale) * OVERFLOW_MARGIN)
    if (!(ov.limit - Q > 0) || !(newT >= 1)) {
      // the longest question is one of the sent ones: its id comes from the
      // configuration, not from the backend
      return errResult('config', `--ctx too small for question ${longest.id}: the backend has ${ov.limit} tokens of context and the question alone takes about ${Math.ceil(Q)}`)
    }
    const options = { maxChunks: limits.max_chunks, tokensPerState: newT }
    if (l.kind === 'global') {
      const g = planChunks(d, meta, checks, p, options, det.hits)
      // without chunk questions the global state is the only one that sees the files:
      // whatever no longer fits in it is omitted
      if (!hasChunk) {
        examined = g.examined
        globalOmitted = g.omitted
      }
      note(`global state reduced to ${newT} tokens after the overflow (${whichQuestion(ov)})`)
      return okResult([{ kind: 'global', index: 0, file: [], text: g.global, depth: l.depth + 1 }])
    }
    // Only what the chunk contained is parsed again (a file split across several
    // chunks does not come back whole) and replanned with the new budget.
    const dp = parseDiff(chunkDiff(l.text), { maxBytes: p.state.max_diff_bytes, maxLineChars: p.state.max_line_chars })
    const sub = planChunks(dp, meta, checks, p, options, det.hits)
    if (sub.chunks.length === 0) return errResult('overflow', `${message}: the chunk cannot be split`, { overflow: ov })
    for (const om of sub.omitted) extraOmitted.set(om.path, `${om.reason} (after the re-split for the backend context)`)
    note(`chunk ${l.index} re-split into ${sub.chunks.length} (budget ${newT} tokens) after the overflow (${whichQuestion(ov)})`)
    return okResult(sub.chunks.map((pt) => ({ kind: 'chunk', index: nextIndex++, file: pt.files, text: pt.text, depth: l.depth + 1 })))
  }

  const runJob = async (b: Backend, l: Job): Promise<void> => {
    if (deadline - o.now() < MARGIN_MS) {
      notSent++
      stop({ job: l, error: { kind: 'timeout', message: 'review time used up: requests not sent' } })
      return
    }
    const questions = l.kind === 'chunk' ? chunkQuestions : globalQuestions
    const state = prepare(b, l.text)
    let http: number | undefined
    const t: Transport = async (r) => {
      const e = await deps.transport(r)
      http = e.kind === 'response' ? e.status : undefined
      return e
    }
    requests++
    const e = await ask(t, o, b, { state: state, model: b.model, questions: questions }, p.network, deadline)
    if (e.ok) {
      // All the answers of a review must come from the same backend: a profile chosen
      // on one model and applied to another would give meaningless thresholds.
      const id = identityOf(e.value.response, b)
      const key = id.fingerprint !== undefined ? `fingerprint ${id.fingerprint}` : `model ${id.model}`
      if (firstKey === undefined) {
        firstKey = key
        first = id
        family = id.family
      } else if (key !== firstKey && first !== undefined) {
        // in the message the names as they are shown: they come from the backend
        const show = (x: Identity): string => {
          const m = shownIdentity(x, b.model, c.calibration)
          return m.fingerprint !== undefined ? `fingerprint ${m.fingerprint}` : `model ${m.model}`
        }
        changed ??= { kind: 'backend_changed', message: `the backend changed mid-review (${show(first)}, then ${show(id)}): answers discarded` }
        stop({ job: l, error: changed })
        return
      }
      inputTokens += e.value.response.usage?.input_tokens ?? 0
      succeeded.push({ job: l, response: e.value.response, discarded: e.value.discarded })
      return
    }

    let error = e.error
    if (error.kind === 'overflow' && error.overflow) {
      const r = resplit(l, error.overflow, state, questions)
      if (r.ok) {
        // the sub-chunks take the place of the chunk, before the ones that follow
        if (l.kind === 'chunk') queue.unshift(...r.value)
        else queue.push(...r.value)
        return
      }
      error = r.error
      if (error.kind === 'config') http = undefined   // backend context, not PR content
    }
    const f: FailedJob = { job: l, error, http }
    failed.push(f)
    switch (error.kind) {
      case 'timeout':
        // rizzo is still computing the abandoned request: every other request would
        // wait behind it. As long as the family is unknown, caution.
        if (family === undefined || family === 'rizzo') stop(f)
        break
      case 'network':
      case 'auth':
      case 'config':
      case 'overloaded':
        // they concern the backend, not this request: the others would go the same way
        stop(f)
        break
      default:
        // server, response, validation, overflow: they concern this request
        break
    }
  }

  if (backend && !early && !withoutBackend && queue.length > 0) {
    await new Promise<void>((finished) => {
      let inFlight = 0
      // The first request is always sent alone: only its answer says whether the
      // backend is rizzo (it serializes, parallel_rizzo) or not (parallel_other).
      const limit = (): number => {
        if (family === undefined) return 1
        return Math.max(1, family === 'rizzo' ? p.network.parallel_rizzo : p.network.parallel_other)
      }
      const start = (): void => {
        while (stopped === undefined && queue.length > 0 && inFlight < limit()) {
          const l = queue.shift() as Job
          inFlight++
          runJob(backend, l)
            .catch((err: unknown) => {
              failed.push({ job: l, error: { kind: 'internal', message: `internal error during a request: ${err instanceof Error ? err.message : String(err)}` } })
            })
            .then(() => {
              inFlight--
              start()
            })
        }
        if (inFlight === 0) finished()
      }
      start()
    })
    // whatever is left in the queue after a stop was not sent
    notSent += queue.length
    queue.length = 0
  }

  // ─── Outcome ────────────────────────────────────────────────────────────────
  const discarded = succeeded.flatMap((r) => r.discarded)
  let outcome: 'ok' | 'incomplete' | 'error'
  let main: JobFailure | undefined
  if (withoutBackend) {
    // an outcome without answers from the model, but without an error: there is nothing to fix
    outcome = 'error'
    note(`backend not queried: the detectors' ${max} floor is already the most severe lane`)
  } else if (early) {
    outcome = 'error'
    main = { error: early }
  } else if (changed) {
    outcome = 'error'
    main = stopped
  } else if (jobs > 0 && succeeded.length === 0) {
    outcome = 'error'
    main = stopped ?? failed[0]
  } else if (failed.length > 0 || notSent > 0 || discarded.length > 0) {
    outcome = 'incomplete'
    main = stopped ?? failed[0]
  } else {
    outcome = 'ok'
  }
  for (const s of discarded) note(`answer discarded for ${s.id}: ${s.reason}`)
  if (notSent > 0) note(`${notSent} ${notSent === 1 ? 'request not sent' : 'requests not sent'}${stopped ? `: ${stopped.error.message}` : ''}`)

  // ─── Values ─────────────────────────────────────────────────────────────────
  // The profile is chosen on the identity of the first answer and applies to all of
  // them. With a changed backend no answer is kept: there is no knowing which to trust.
  const selection = first && !changed ? chooseProfile(c.calibration, first, p.band) : neutralSelection(p)
  const calibrationNotes: string[] = []
  const values: Record<string, CheckValue> = {}
  const noul = new Map<string, SentNoul[]>()
  for (const r of changed ? [] : succeeded) {
    const questions = r.job.kind === 'chunk' ? chunkQuestions : globalQuestions
    for (const [id, raw] of Object.entries(r.response.answers)) {
      if (!Object.hasOwn(questions, id) || !Object.hasOwn(checks.defs, id)) continue
      const w = questions[id]
      const def = checks.defs[id]
      // The options of a project checks.json are text from the repo: in the result an
      // option goes out only if a trusted layer defines it for the same check,
      // otherwise its position
      const showable = (option: string): string => {
        if (!checks.fromProject) return option
        const trusted = checks.trustedOptions && Object.hasOwn(checks.trustedOptions, id) ? checks.trustedOptions[id] : []
        return safeChoice(option, isObject(w.criteria) ? Object.keys(w.criteria) : [], trusted)
      }
      if (raw.type === 'choice' && def.value) {
        // a choice with a value counts as a noul: 1 − p(option), calibrated on its
        // logit, then the maximum over the chunks as for nouls (aggregateNoul)
        const q = derivedProbability(def.value, raw.probabilities)
        if (q === undefined) continue
        const cal = calibrateDerived(id, w, q, selection)
        if (cal.note && !calibrationNotes.includes(cal.note)) calibrationNotes.push(cal.note)
        const list = noul.get(id) ?? []
        const option = derivedOption(def.value, raw.probabilities)
        list.push({ chunk: r.job.index, files: [...r.job.file], p: cal.p, raw: q, ...(option !== undefined ? { option: showable(option) } : {}) })
        noul.set(id, list)
        continue
      }
      const cal = calibrate(id, w, raw, selection)
      if (cal.note && !calibrationNotes.includes(cal.note)) calibrationNotes.push(cal.note)
      const x = cal.response
      if (raw.type === 'noul' && x.type === 'noul') {
        const list = noul.get(id) ?? []
        list.push({ chunk: r.job.index, files: [...r.job.file], p: x.noul, raw: raw.noul })
        noul.set(id, list)
      } else if (raw.type === 'choice' && x.type === 'choice') {
        // a choice without a value does not enter the rules (validation forbids it): the
        // value is the confidence, the choice is kept separately
        values[id] = { value: x.confidence, raw: raw.confidence, source: 'model', choice: showable(x.choice), confidence: x.confidence }
      } else if (raw.type === 'score' && x.type === 'score') {
        const v: CheckValue = { value: x.score, raw: raw.score, source: 'model', confidence: x.confidence }
        const level = checks.fromProject ? safeLevel(x.score) : levelLabel(x.score, w)
        if (level !== undefined) v.level = level
        values[id] = v
      }
    }
  }
  for (const [id, list] of noul) {
    const def = checks.defs[id]
    const v = aggregateNoul(list, { invert: def.invert, perChunk: def.scope === 'chunk' })
    if (v) values[id] = v
  }
  Object.assign(values, valuesFromPaths(checks, d.files))

  // ─── Verdict ────────────────────────────────────────────────────────────────
  const omitted = [...globalOmitted]
  for (const [path, reason] of extraOmitted) if (!omitted.some((x) => x.path === path)) omitted.push({ path, reason })
  const finalPlan: Plan = { ...plan, examined: examined.filter((x) => !extraOmitted.has(x)), omitted }
  const partial: CoverageGaps = {
    omitted: omitted.length,
    unreviewable: plan.unreviewable.length,
    incomplete: outcome !== 'ok',
    truncated: d.truncated,
    projectDetectorsTimedOut,
    pathRegexesTimedOut,
  }
  const hashOk = consistentHashes(all, selection)
  const decision = decide(values, p, selection, det.floors, partial, hashOk)
  // With an error there is no review to quote, only what is known without the model:
  // detectors that always need a look and files not examined.
  const items = escalation(values, checks, selection, det, finalPlan, p, {
    hashOk, file: d.files, truncated: d.truncated, incomplete: outcome === 'incomplete',
  })
  Object.assign(values, valuesFromVerdict(checks, decision.lane, items, partial))

  const withVerdict = outcome !== 'error' || det.floors.length > 0
  const error = main?.error
  const cls = outcome === 'error' && main ? classOf(main.error, main.http) : undefined
  const ci = ciConclusion({
    lane: decision.lane,
    escalation: items,
    partial: { ...partial, incomplete: outcome === 'incomplete' || cls === 'untrusted_input' },
    outcome,
    backendUnavailable: cls === 'backend_unavailable',
  }, p)
  if (error && cls !== undefined && ci.class === cls) ci.reason = error.message

  const unevaluated = [...decision.unevaluated]
  for (const id of Object.keys(all)) if (!Object.hasOwn(values, id) && !unevaluated.includes(id)) unevaluated.push(id)
  unevaluated.sort((a, b) => checks.order.indexOf(a) - checks.order.indexOf(b))
  for (const n of decision.notes) note(n)

  const backendInfo: ReviewResult['backend'] = { host: backend?.host ?? '', calibrated: false, delta_logit: selection.deltaLogit, notes: [] }
  if (first && !changed && backend) {
    // the log wants the real names (a calibration fit is tied to match.fingerprint),
    // the result the ones that can be shown
    deps.onIdentity?.(first)
    const m = shownIdentity(first, backend.model, c.calibration)
    backendInfo.model = m.model
    if (m.fingerprint !== undefined) backendInfo.fingerprint = m.fingerprint
    backendInfo.profile = selection.profile.name
    backendInfo.calibrated = selection.profile.calibrated
    backendInfo.mode = selection.mode
    backendInfo.notes = [...selection.notes, ...calibrationNotes.filter((n) => !selection.notes.includes(n))]
  }

  const r: ReviewResult = {
    outcome,
    exit_code: withVerdict ? decision.lane.exit_code : EXIT_ERROR,
    fired: withVerdict ? decision.fired : [],
    unevaluated: unevaluated,
    values,
    escalation: items,
    merge_ready: mergeReady(decision.lane, p, items, partial),
    hits: det.hits,
    files: { examined: finalPlan.examined, ignored: plan.ignored, unreviewable: plan.unreviewable, omitted },
    ci,
    backend: backendInfo,
    requests,
    ms: o.now() - start,
    input_tokens: inputTokens,
    shape: plan.shape,
    redactions,
    config_sources: { ...c.sources },
    config_hashes: hashesOf(i, c, all),
  }
  if (withVerdict) r.lane = decision.lane.name
  if (error) r.error = error
  if (notes.length > 0) r.notes = notes
  return r
}
