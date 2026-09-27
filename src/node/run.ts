// runReview(): the only point from which the hook, the CLI and the Action reach the
// core's review(). It puts the adapters together: configuration from the
// three layers, diff from git or from a file, backend from the (URL, key, model)
// layers, Node's transport and clock, project regexes in the Worker. This way
// the only thing that changes from one entry point to another is how the result is
// rendered.
//
// The status probe lives here too (CLI `status` and /jev-status): GET /v1/models plus a
// real decision, because a backend that answers /health can still reject the
// questions.
import { MODEL_ALIASES, DEFAULT_MODEL, requestHeaders, SYSTEMONE_PATH, resolveBackend } from '../core/backend.ts'
import { chooseProfile, SERVER_CALIBRATED_STATUS } from '../core/calibration.ts'
import { shownIdentity, backendName } from '../core/provenance.ts'
import { review } from '../core/review.ts'
import { ask, classifyStatus, wireQuestion, identityOf } from '../core/systemone.ts'
import { errResult, okResult } from '../core/types.ts'
import type {
  Backend, Failure, Result, HttpOutcome, BackendSources, Identity, BackendLayer, CalibrationMode, Clock, Origin, HttpRequest,
  ReviewResult, DiffSource, Transport,
} from '../core/types.ts'
import { ciConclusion } from '../core/verdict.ts'
import { loadConfig } from './file-config.ts'
import type { LoadedConfig } from './file-config.ts'
import { readSource } from './git.ts'
import { matchPathsInWorker, detectInWorker } from './regex.ts'
import { nodeGet, nodeClock, nodeTransport } from './transport.ts'

const MAX_MODEL = 128
const EXIT_ERROR = 4

// ─── Backend ──────────────────────────────────────────────────────────────────

function nonBlank(s: string | undefined): string | undefined {
  return s !== undefined && s.trim() !== '' ? s : undefined
}

// The (URL, key, model) layers of src/core/backend.ts for one entry point. The key in
// the file ~/.config/jev-hooks/key is the fallback for the key of the first layer
// (userConfig for the hooks, JEV_HOOKS_* for the CLI), never of another one: it stays
// tied to that layer's URL.
export function backendSources(origin: Origin, env: NodeJS.ProcessEnv, o: { explicitUrl?: string; keyFile?: string } = {}): BackendSources {
  const layers: BackendLayer[] = []
  if (origin === 'hook' || origin === 'skill') {
    layers.push({
      name: 'userConfig (review_url, api_key)',
      url: env.CLAUDE_PLUGIN_OPTION_REVIEW_URL,
      key: nonBlank(env.CLAUDE_PLUGIN_OPTION_API_KEY) ?? o.keyFile,
      model: env.CLAUDE_PLUGIN_OPTION_MODEL,
    })
    layers.push({ name: 'JEV_HOOKS_*', url: env.JEV_HOOKS_URL, key: env.JEV_HOOKS_KEY, model: env.JEV_HOOKS_MODEL })
  } else {
    layers.push({ name: 'JEV_HOOKS_*', url: env.JEV_HOOKS_URL, key: nonBlank(env.JEV_HOOKS_KEY) ?? o.keyFile, model: env.JEV_HOOKS_MODEL })
  }
  const f: BackendSources = { layers, typesafe: { key: env.TYPESAFE_API_KEY, baseUrl: env.TYPESAFE_BASE_URL, model: env.TYPESAFE_DEFAULT_MODEL } }
  if (nonBlank(o.explicitUrl) !== undefined) f.explicitUrl = o.explicitUrl
  return f
}

// resolveBackend's messages point to /plugin (userConfig), which applies to the hook
// and the skill; from the CLI the configuration comes from the environment, the key
// file or --url.
function forEntry(e: Failure, origin: Origin | undefined): Failure {
  if (origin !== 'cli' || e.kind !== 'not_configured') return e
  if (e.message.startsWith('backend not configured')) {
    return { ...e, message: 'backend not configured: set JEV_HOOKS_URL (or TYPESAFE_API_KEY for Jev), or use --url' }
  }
  return { ...e, message: e.message.replace('set api_key with /plugin', 'set TYPESAFE_API_KEY') }
}

// The resolved backend, with the CLI's explicit model (--model) if there is one. A
// Failure does not stop the review: review() still applies the detectors' floors.
export function backendFrom(f: BackendSources, model?: string, origin?: Origin): { backend: Backend | Failure; layer?: string } {
  const r = resolveBackend(f)
  if (!r.ok) return { backend: forEntry(r.error, origin) }
  const { layer, ...b } = r.value
  const m = model?.trim()
  if (m !== undefined && m !== '') {
    if (m.length > MAX_MODEL) return { backend: { kind: 'config', message: `model name too long: ${m.length} characters, at most ${MAX_MODEL}` }, layer }
    b.model = m
  }
  return { backend: b, layer }
}

// ─── Review ───────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  origin: Origin
  cwd: string
  source: DiffSource
  sources: BackendSources
  pluginRoot: string
  projectDir?: string
  start: number                          // start of the entry point, on the clock's scale
  config?: LoadedConfig                 // already loaded (the CLI checks it before starting)
  userDir?: string                      // the CLI's --config-dir
  model?: string                        // the CLI's --model
  title?: string                         // --title and --description: they override the diff source's
  description?: string | null
  seed?: number
  transport?: Transport
  clock?: Clock
  env?: NodeJS.ProcessEnv
  tmpDir?: string                    // temporary index of the commit source
  skipIfTopFloor?: boolean       // hook: already the top floor, no request
}

// A result without a review: the diff could not be read.
function withoutReview(error: Failure, config: LoadedConfig, ms: number): ReviewResult {
  const p = config.policy
  const ci = ciConclusion({
    lane: p.lanes[p.lanes.length - 1], escalation: [],
    partial: { omitted: 0, unreviewable: 0, incomplete: true }, outcome: 'error',
  }, p)
  ci.reason = error.message
  return {
    outcome: 'error', exit_code: EXIT_ERROR, fired: [], unevaluated: [], values: {}, escalation: [], merge_ready: false,
    hits: [], files: { examined: [], ignored: [], unreviewable: [], omitted: [] }, ci,
    backend: { host: '', calibrated: false, delta_logit: p.band.delta_logit, notes: [] },
    requests: 0, ms, input_tokens: 0, shape: 'single', redactions: 0, config_sources: { ...config.sources }, config_hashes: {}, error,
  }
}

// The redaction seed comes from the clock: it only has to change from one
// review to the next; xorshift does not accept zero.
function seedFromClock(): number {
  return (Date.now() >>> 0) || 1
}

// Throws only if the plugin's own configuration is missing or invalid: then no
// fallback makes sense. identity: who answered, with the real names, for the log line;
// the result has them only if the trusted configuration knows them, otherwise
// as a hash (provenance.ts).
export async function runReview(o: ReviewOptions):
  Promise<{ result: ReviewResult; config: LoadedConfig; warnings: string[]; title: string; identity?: Identity }> {
  const clock = o.clock ?? nodeClock
  let config = o.config
  if (!config) {
    const c = loadConfig({
      cwd: o.cwd, pluginRoot: o.pluginRoot, projectDir: o.projectDir, userDir: o.userDir, origin: o.origin, env: o.env,
    })
    if (!c.ok) throw new Error(c.error.message)
    config = c.value
  }
  const warnings = [...config.warnings]
  const p = config.policy
  const deadline = o.start + p.limits[o.origin].total_ms
  const s = readSource(o.source, o.cwd, deadline, { maxBytes: p.state.max_diff_bytes, env: o.env, tmpDir: o.tmpDir })
  if (!s.ok) return { result: withoutReview(s.error, config, clock.now() - o.start), config, warnings, title: o.title ?? '' }
  const title = o.title ?? s.value.title
  const description = o.description !== undefined ? o.description : s.value.description
  const { backend, layer } = backendFrom(o.sources, o.model, o.origin)
  let responder: Identity | undefined
  const result = await review(
    { diff: s.value.diff, title, description, origin: o.origin },
    config,
    {
      transport: o.transport ?? nodeTransport(),
      clock,
      backend,
      seed: o.seed ?? seedFromClock(),
      start: o.start,
      runProjectDetectors: (pp, d, meta) => detectInWorker(pp, d, meta),
      matchProjectPaths: (regex, paths) => matchPathsInWorker(regex, paths),
      onIdentity: (id) => { responder = id },
      ...(o.skipIfTopFloor ? { skipIfTopFloor: true } : {}),
    },
  )
  if (s.value.note !== undefined) result.notes = [...(result.notes ?? []), s.value.note]
  // A rejected key is fixed at its source: say which layer gave it.
  if (result.error?.kind === 'auth' && layer !== undefined) {
    const before = result.error.message
    result.error = { ...result.error, message: `${before} (source: ${layer})` }
    if (result.ci.reason === before) result.ci.reason = result.error.message
  }
  return responder ? { result, config, warnings, title, identity: responder } : { result, config, warnings, title }
}

// ─── Status probe ─────────────────────────────────────────────────────────────
//
// Claude reads its text too (/jev-status, the CLI through Bash): the names the backend
// gives itself (models, model, fingerprint, probability_status) leave only if the
// trusted configuration knows them, otherwise as a hash (provenance.ts). Whoever has to
// write a calibration profile finds the real names in the log line.

// The state of the probe decision: one line, no user content.
export const PROBE_STATE = 'jev-status: backend probe decision, no diff'

export interface BackendStatus {
  host: string
  local: boolean
  layer: string
  requestedModel: string
  models?: string[]
  modelsNote?: string
  model: string
  family: string
  fingerprint?: string
  probabilityStatus?: string[]
  question: string
  ms: number
  profile: string
  calibrated: boolean
  mode: CalibrationMode
  deltaLogit: number
  notes: string[]
  sources: Record<string, string>
}

function modelNames(text: string): string[] | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  // "data" is the OpenAI-style list ({ object: "list", data: [...] }): a wire name
  const o = v as { models?: unknown; data?: unknown }
  const list = Array.isArray(o?.models) ? o.models : Array.isArray(o?.data) ? o.data : undefined
  if (!list) return undefined
  const names: string[] = []
  for (const x of list.slice(0, 50)) {
    const n = typeof x === 'string' ? x : (x as { name?: unknown; id?: unknown })?.name ?? (x as { id?: unknown })?.id
    if (typeof n === 'string' && /^[\w.:@/-]{1,128}$/.test(n)) names.push(n)
  }
  return names
}

function httpFailure(e: HttpOutcome, key: string, what: string): Failure | null {
  if (e.kind === 'timeout') return { kind: 'timeout', message: `${what}: no response within the time limit` }
  if (e.kind === 'network') return { kind: 'network', message: `${what}: backend unreachable (${e.message})` }
  if (e.status === 401 || e.status === 403) return classifyStatus(e.status, e.text, key)
  return null
}

export async function probeStatus(o: {
  config: LoadedConfig
  sources: BackendSources
  origin?: Origin
  model?: string
  transport?: Transport
  clock?: Clock
  read?: (r: Omit<HttpRequest, 'body'>) => Promise<HttpOutcome>
}): Promise<Result<BackendStatus>> {
  const clock = o.clock ?? nodeClock
  const p = o.config.policy
  const { backend, layer } = backendFrom(o.sources, o.model, o.origin)
  if (Object.hasOwn(backend, 'kind')) return { ok: false, error: backend as Failure }
  const b = backend as Backend
  const notes: string[] = []

  // 1. GET /v1/models: with rizzo it tells whether the key is valid (it is protected like /v1/systemone)
  const base = b.url.endsWith(SYSTEMONE_PATH) ? b.url.slice(0, -SYSTEMONE_PATH.length) : b.url
  const { 'Content-Type': _ct, ...headers } = requestHeaders(b)
  const read = o.read ?? ((r) => nodeGet(r))
  const response = await read({ url: `${base}/v1/models`, headers, timeoutMs: Math.min(p.network.timeout_ms, 10_000) })
  const err = httpFailure(response, b.key, 'GET /v1/models')
  if (err) return { ok: false, error: err }
  let models: string[] | undefined
  let modelsNote: string | undefined
  if (response.kind === 'response' && response.status === 200) {
    models = modelNames(response.text)
    if (!models) modelsNote = 'GET /v1/models: response not recognized'
  } else if (response.kind === 'response') modelsNote = `GET /v1/models: HTTP ${response.status}`

  // 2. a real decision: the first model noul of checks.json, on a one-line state
  const id = o.config.checks.order.find((k) => o.config.checks.defs[k].source === 'model' && o.config.checks.defs[k].type === 'noul')
  if (id === undefined) return errResult('config', 'checks.json has no noul question for the model: nothing to ask in the probe')
  const questions = { [id]: wireQuestion(o.config.checks.defs[id]) }
  const t0 = clock.now()
  const e = await ask(o.transport ?? nodeTransport(), clock, b, { state: PROBE_STATE, model: b.model, questions },
    p.network, t0 + p.network.timeout_ms + 2000)
  if (!e.ok) return e
  const ident = identityOf(e.value.response, b)
  const selection = chooseProfile(o.config.calibration, ident, p.band)
  notes.push(...selection.notes)
  const requested = b.model || DEFAULT_MODEL
  const shown = shownIdentity(ident, requested, o.config.calibration)
  const out: BackendStatus = {
    host: b.host, local: b.local, layer: layer ?? '', requestedModel: requested,
    model: shown.model, family: ident.family, question: id, ms: e.value.ms,
    profile: selection.profile.name, calibrated: selection.profile.calibrated, mode: selection.mode, deltaLogit: selection.deltaLogit,
    notes, sources: { ...o.config.sources },
  }
  if (models) out.models = models.map((m) => backendName(m, [requested, ...MODEL_ALIASES]))
  if (modelsNote) out.modelsNote = modelsNote
  if (shown.fingerprint !== undefined) out.fingerprint = shown.fingerprint
  if (ident.probabilityStatus !== undefined) out.probabilityStatus = ident.probabilityStatus.map((x) => backendName(x, [SERVER_CALIBRATED_STATUS]))
  return okResult(out)
}
