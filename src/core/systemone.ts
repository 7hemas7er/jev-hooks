// Client of POST /v1/systemone, the same for TypeSafe's Jev and for rizzo-flow.
// The wire rules live here: what goes out (only type, instructions and criteria), what
// is checked before sending (the limits shared by the two backends), how an answer is
// read (question by question: a malformed one does not throw away the others) and when
// to retry. Time and network come from outside (Transport, Clock): the module is pure
// and the router uses it too, in Claude Code's node:vm context.
//
// Never a retry on a timeout: rizzo serializes requests and keeps computing the ones
// the client abandoned, so a second send would queue behind the first and double the
// wait.
import { TYPESAFE_HOST, requestHeaders, parseUrl, sanitize } from './backend.ts'
import { canonical, canonicalInOrder } from './canonical.ts'
import { questionProblems } from './config.ts'
import { isJson, isObject, childPointer, formatProblem } from './json.ts'
import { sha256Hex } from './sha256.ts'
import { utf8ByteLength } from './utf8.ts'
import { errResult, okResult, LIMITS } from './types.ts'
import type {
  Backend, RequestBody, WireQuestion, Failure, Result, Identity, Json, Clock, Policy, Problem, Answer,
  BackendResponse, DiscardedAnswer, QuestionType, Transport,
} from './types.ts'

export { LIMITS } from './types.ts'
export type { RequestBody, DiscardedAnswer } from './types.ts'

// rizzo-flow's fixed text (prompts.py) when state + question exceed --ctx. The first
// group is the question id, not a number (measured on the Spark:
// "Question hardcoded_secret: 8385 tokens exceeds the context limit 8192 (--ctx); no truncation").
export const RE_OVERFLOW = /Question (.+?): (\d+) tokens exceeds the context limit (\d+) \(--ctx\); no truncation/

// rizzo-flow limits outside LIMITS (compat.py and schema.py): model of 1 to 128
// characters, question id of 1 to 128 characters, not all spaces.
const MAX_MODEL = 128
const MAX_ID = 128

// Jev declares probabilities that sum to "about 1" and shows them with two decimals:
// within this tolerance they are renormalized, outside it the answer is wrong.
const SUM_TOLERANCE = 0.02
// Rounding error allowed on the numbers that must be in [0, 1] or [0, n−1].
const EPSILON = 1e-9

// With less than this left before the deadline nothing more is sent: the answer would
// not arrive in time, and on rizzo it would hold the lock for nothing.
export const MARGIN_MS = 1000

const REQUEST_FILE = 'request'

// ─── Questions and body ───────────────────────────────────────────────────────

// Only type, instructions and criteria: rizzo has extra=forbid on every question and
// an extra label or critical would give 422. The other fields of CheckDef are not sent.
export function wireQuestion(d: { type: QuestionType; instructions?: Json; criteria?: Json }): WireQuestion {
  const w = { type: d.type, instructions: d.instructions } as WireQuestion
  if (d.criteria !== undefined) w.criteria = d.criteria
  return w
}

// The form a question's hash is computed on: the canonical JSON of the wire form
// (sorted keys, no whitespace), except the options of a choice, which stay in the
// order they are sent in. rizzo assigns the letters in that order and does not correct
// the position bias: with the options in alphabetical order two choices with the same
// options in a different order had the same hash and opposite answers (c_scelta and
// c_scelta_none_ultima on the bench). Nouls stay canonical (rizzo always puts No in A
// and Yes in B), and the levels of a score are a list, already in their order.
export function hashForm(w: WireQuestion): string {
  const d = wireQuestion(w)
  if (d.type !== 'choice' || !isObject(d.criteria)) return canonical(d as unknown as Json)
  // the top-level keys in canonical order: criteria, instructions, type
  const fields = [`"criteria":${canonicalInOrder(d.criteria)}`]
  if (d.instructions !== undefined) fields.push(`"instructions":${canonical(d.instructions as Json)}`)
  fields.push(`"type":${JSON.stringify(d.type)}`)
  return `{${fields.join(',')}}`
}

// A calibration fit is valid only for the exact text of the sent question: the
// sha is computed on the wire form, hence on what the model sees, option order
// included (hashForm).
export function questionHash(w: WireQuestion): string {
  return sha256Hex(hashForm(w))
}

// Limits shared by Jev and rizzo on the body as it will be sent. The questions go
// through the same rules as checks.json and router.json (questionProblems), so a body
// built by hand or from an already validated config has a single check. The 256 KB of
// the state are measured as rizzo does: UTF-8 bytes of the serialized JSON.
export function validateBody(c: RequestBody): Problem[] {
  const problems: Problem[] = []
  const addProblem = (pointer: string, message: string): void => {
    problems.push({ file: REQUEST_FILE, pointer, message })
  }
  const body = c as unknown as { [k: string]: unknown }
  if (!isObject(body)) {
    addProblem('', 'the request body must be an object')
    return problems
  }
  const state = body.state
  if (typeof state !== 'string') {
    addProblem('/state', 'the state must be a string (text@1 format): rizzo would render an object as indented JSON')
  } else {
    if (state.trim() === '') addProblem('/state', 'empty state: rizzo-flow answers 422')
    const bytes = utf8ByteLength(JSON.stringify(state))
    if (bytes > LIMITS.maxStateBytes) addProblem('/state', `state too large: ${bytes} serialized bytes, at most ${LIMITS.maxStateBytes}`)
  }
  const model = body.model
  if (typeof model !== 'string' || model.trim() === '' || model.length > MAX_MODEL) {
    addProblem('/model', `expected the model name, 1 to ${MAX_MODEL} characters`)
  }
  const questions = body.questions
  if (!isObject(questions)) {
    addProblem('/questions', 'expected a map id → question')
    return problems
  }
  const ids = Object.keys(questions)
  if (ids.length === 0) addProblem('/questions', 'no questions: rizzo-flow and Jev need at least one')
  if (ids.length > LIMITS.maxQuestions) addProblem('/questions', `too many questions: ${ids.length}, at most ${LIMITS.maxQuestions}`)
  for (const id of ids) {
    const p = childPointer('/questions', id)
    if (id.trim() === '' || id.length > MAX_ID) addProblem(p, `invalid question id: 1 to ${MAX_ID} characters, not only spaces`)
    problems.push(...questionProblems(questions[id], REQUEST_FILE, p))
  }
  return problems
}

// ─── HTTP error classification ────────────────────────────────────────────────

// What is derived from the error body. The backend's text never enters a message:
// the messages end up in the deny reason, in the additionalContext and in the
// CLI, which Claude reads, and the backend is not a trusted layer. A "detail" asking
// Claude to let the commit through would arrive as a note from the reviewer. Only the
// facts the code recognizes are kept: how many entries a Pydantic-style validation
// list has, rizzo's overflow (numbers, and the question id only if it is one of those
// sent), the engine error.
interface ErrorDetail {
  entries?: number
  overflow?: { question: string; tokens: number; limit: number }
  engine: boolean
}

function errorDetail(text: string, questions: readonly string[]): ErrorDetail {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { engine: text.includes('llama_decode') }
  }
  const d = isObject(v) ? v.detail : undefined
  if (Array.isArray(d)) return { entries: d.length, engine: false }
  if (typeof d !== 'string') return { engine: false }
  const m = RE_OVERFLOW.exec(d)
  if (m) {
    // the backend repeats the id: it counts only if it is one of those it was asked
    const question = questions.includes(m[1]) ? m[1] : ''
    return { overflow: { question, tokens: Number(m[2]), limit: Number(m[3]) }, engine: false }
  }
  return { engine: d.includes('llama_decode') }
}

const OVERLOAD_STATUSES = [429, 503, 529]

// "question hardcoded_secret" or "a question": the id only if it is one of those sent
// (errorDetail). For the overflow messages, here and in the re-split.
export function whichQuestion(ov: { question: string }): string {
  return ov.question !== '' ? `question ${ov.question}` : 'a question'
}

// From an HTTP status other than 200 to the typed failure. questions: the
// ids of the request, to recognize the one an overflow names. Every message is a
// phrase from here with the HTTP status and, at most, numbers: the backend's detail is
// read with curl, not in Claude's context.
export function classifyStatus(status: number, text: string, key: string, questions: readonly string[] = []): Failure | null {
  if (status === 200) return null
  const k = typeof key === 'string' ? key : ''
  const d = errorDetail(typeof text === 'string' ? text : '', questions)

  if (status === 401 || status === 403) {
    const m = k.trim() === ''
      ? `the backend asks for a key (HTTP ${status}) and none is configured`
      : `key rejected by the backend (HTTP ${status})`
    return { kind: 'auth', message: m }
  }
  if (status === 400) return { kind: 'config', message: 'request rejected by the backend (HTTP 400; unknown model? rizzo-flow accepts jev-latest, rizzo-latest or jev-*)' }
  if (status === 404) return { kind: 'config', message: 'wrong URL (HTTP 404): the URL must lead to …/v1/systemone' }
  if (status === 422) {
    if (d.overflow) {
      const ov = d.overflow
      return {
        kind: 'overflow',
        message: `${whichQuestion(ov)} exceeds the backend context: ${ov.tokens} tokens, limit ${ov.limit} (--ctx)`,
        overflow: ov,
      }
    }
    // ValueError from rizzo's engine (also "the context is full"): it is not the user's
    // configuration, and the user must not be invited to fix it
    if (d.engine) return { kind: 'server', message: 'backend engine error (HTTP 422)' }
    const items = d.entries !== undefined && d.entries > 0 ? `: ${d.entries} ${d.entries === 1 ? 'problem reported' : 'problems reported'}` : ''
    return { kind: 'config', message: `request not valid for the backend (HTTP 422${items})` }
  }
  if (OVERLOAD_STATUSES.includes(status)) return { kind: 'overloaded', message: `backend overloaded (HTTP ${status})` }
  if (status === 502) return { kind: 'network', message: 'the proxy cannot reach the backend (HTTP 502)' }
  // 504: the proxy stopped waiting, the backend did not. For rizzo it is a timeout in
  // every respect (it is still computing); with TypeSafe the request may already be billed.
  if (status === 504) return { kind: 'timeout', message: 'the proxy stopped waiting (HTTP 504): the backend may still be working' }
  if (status >= 500 && status <= 599) return { kind: 'server', message: `backend error (HTTP ${status})` }
  if (status >= 400 && status <= 499) return { kind: 'config', message: `request rejected by the backend (HTTP ${status})` }
  return { kind: 'response', message: `unexpected HTTP status: ${Number.isInteger(status) ? status : '?'}` }
}

// ─── Reading the response ─────────────────────────────────────────────────────

// JSON.parse, and if it fails a second attempt with NaN and ±Infinity outside strings
// replaced by null: Python's json.dumps writes them that way, and a single non-finite
// value must not lose the other answers of the same request.
function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // try below
  }
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') { out += text[i + 1] ?? ''; i++ } else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    const rest = text.slice(i, i + 9)
    if (rest.startsWith('NaN')) { out += 'null'; i += 2; continue }
    if (rest.startsWith('-Infinity')) { out += 'null'; i += 8; continue }
    if (rest.startsWith('Infinity')) { out += 'null'; i += 7; continue }
    out += c
  }
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

function probability(x: unknown): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < -EPSILON || x > 1 + EPSILON) return null
  return Math.min(1, Math.max(0, x))
}

// probabilities with exactly the expected keys, each in [0, 1], summing to 1 ± 0.02;
// returned renormalized in the order of the expected keys. The reason for a discard
// ends up in the notes for Claude: it names the position, not the key, because the
// options of a choice are written by checks.json, which can come from the project.
function distribution(v: unknown, keys: string[], what: 'option' | 'level'): Record<string, number> | string {
  if (!isObject(v)) return 'probabilities missing or not an object'
  const found = Object.keys(v)
  if (found.length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) {
    return `probabilities with keys other than the expected ones (${keys.length} expected, ${found.length} found)`
  }
  const values: number[] = []
  for (const [i, k] of keys.entries()) {
    const p = probability(v[k])
    if (p === null) return `invalid probability for ${what === 'option' ? `option ${i + 1}` : `level ${i}`}: expected between 0 and 1`
    values.push(p)
  }
  const sum = values.reduce((a, b) => a + b, 0)
  if (!(Math.abs(sum - 1) <= SUM_TOLERANCE + EPSILON)) return `probabilities summing to ${sum.toFixed(3)}, expected 1 ± ${SUM_TOLERANCE}`
  const out: Record<string, number> = {}
  keys.forEach((k, i) => { out[k] = values[i] / sum })
  return out
}

// A valid answer for question w, or the reason it is discarded.
function parseAnswer(v: unknown, w: WireQuestion): Answer | string {
  if (v === undefined) return 'answer missing'
  if (!isObject(v)) return 'the answer is not an object'
  // the wrong type is not repeated: it is backend text, and the reason goes into the notes
  if (v.type !== w.type) return typeof v.type === 'string' ? `answer type other than "${w.type}"` : `answer type missing (expected "${w.type}")`
  if (w.type === 'noul') {
    const p = probability(v.noul)
    return p === null ? 'invalid noul: expected a number between 0 and 1' : { type: 'noul', noul: p }
  }
  const confidence = probability(v.confidence)
  if (confidence === null) return 'invalid confidence: expected between 0 and 1'
  if (w.type === 'choice') {
    if (!isObject(w.criteria)) return 'choice question without options'
    const options = Object.keys(w.criteria)
    if (typeof v.choice !== 'string' || !options.includes(v.choice)) return 'choice not among the question\'s options'
    const probabilities = distribution(v.probabilities, options, 'option')
    if (typeof probabilities === 'string') return probabilities
    return { type: 'choice', choice: v.choice, probabilities, confidence }
  }
  if (!Array.isArray(w.criteria)) return 'score question without levels'
  const levels = w.criteria
  const n = levels.length
  // Jev and rizzo index the levels by their number as a string, lowest first
  const probabilities = distribution(v.probabilities, levels.map((_, i) => String(i)), 'level')
  if (typeof probabilities === 'string') return probabilities
  const s = v.score
  if (typeof s !== 'number' || !Number.isFinite(s) || s < -EPSILON || s > n - 1 + EPSILON) return `invalid score: expected between 0 and ${n - 1}`
  // the legend is only for printing; if it is missing or not JSON it is rebuilt from the levels
  const legend: Record<string, Json> = {}
  if (isObject(v.legend) && isJson(v.legend)) Object.assign(legend, v.legend)
  else levels.forEach((l, i) => { legend[String(i)] = l })
  return { type: 'score', score: Math.min(n - 1, Math.max(0, s)), legend, probabilities, confidence }
}

// Strict reading, answer by answer: a malformed question ends up among the
// discarded ones and the others stay valid. The whole request fails only if the JSON
// cannot be read, if answers or model are missing, or if no valid answer is left. Ids
// beyond the ones asked are ignored.
export function parseResponse(text: string, expected: Record<string, WireQuestion>):
  Result<{ response: BackendResponse; discarded: DiscardedAnswer[] }> {
  const v = parseJsonLenient(typeof text === 'string' ? text : '')
  if (v === undefined) return errResult('response', 'unreadable backend response: invalid JSON')
  if (!isObject(v)) return errResult('response', 'invalid backend response: expected a JSON object')
  if (!isObject(v.answers)) return errResult('response', 'backend response without answers')
  if (typeof v.model !== 'string' || v.model.trim() === '') return errResult('response', 'backend response without model')

  const answers: Record<string, Answer> = {}
  const discarded: DiscardedAnswer[] = []
  const ids = Object.keys(expected)
  for (const id of ids) {
    const r = parseAnswer(Object.hasOwn(v.answers, id) ? v.answers[id] : undefined, expected[id])
    if (typeof r === 'string') discarded.push({ id, reason: r })
    else answers[id] = r
  }
  if (ids.length > 0 && discarded.length === ids.length) {
    return errResult('response', `no valid answer among the ${ids.length} expected (${discarded[0].id}: ${discarded[0].reason})`)
  }

  const response: BackendResponse = { model: sanitize(v.model, '', 200), answers }
  const u = v.usage
  if (isObject(u) && typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)
    && typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) {
    response.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens }
  }
  // x_rizzo is a rizzo-flow extension: its presence alone tells the family
  if (isObject(v.x_rizzo)) {
    const x = v.x_rizzo
    const xr: NonNullable<BackendResponse['x_rizzo']> = {}
    if (typeof x.fingerprint === 'string' && x.fingerprint !== '') xr.fingerprint = sanitize(x.fingerprint, '', 200)
    if (Array.isArray(x.probability_status)) {
      xr.probability_status = x.probability_status.filter((s): s is string => typeof s === 'string').map((s) => sanitize(s, '', 100))
    }
    if (isObject(x.timing)) {
      const timing: Record<string, number> = {}
      for (const [k, t] of Object.entries(x.timing)) if (typeof t === 'number' && Number.isFinite(t)) timing[k] = t
      xr.timing = timing
    }
    response.x_rizzo = xr
  }
  return okResult({ response, discarded })
}

// Who answered: it is used to choose the calibration profile and to check that
// all the answers of a review come from the same backend. The family decides the
// concurrency: rizzo serializes, whatever host is in front of it.
export function identityOf(r: BackendResponse, b: Backend): Identity {
  const u = parseUrl(b.url)
  const host = u.ok ? u.value.host : ''
  const family: Identity['family'] = r.x_rizzo !== undefined || r.model.startsWith('rizzo-')
    ? 'rizzo'
    : host === TYPESAFE_HOST || host.endsWith('.typesafe.ai') || r.model.startsWith('jev-') ? 'typesafe' : 'other'
  const id: Identity = { host: b.host, model: r.model, family }
  if (r.x_rizzo?.fingerprint !== undefined) id.fingerprint = r.x_rizzo.fingerprint
  if (r.x_rizzo?.probability_status !== undefined) id.probabilityStatus = r.x_rizzo.probability_status
  return id
}

// ─── Sending with retries ─────────────────────────────────────────────────────

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`
}

// One request, with its retries:
// - network before sending: up to connect_attempts attempts, backoff backoff_ms·2^k;
// - 429, 503, 529: up to overload_attempts retries, with Retry-After (if within
//   max_retry_after_ms: beyond it, the backend asks for a wait the review cannot
//   afford, and retrying sooner would mean another refusal) or the backoff;
// - 502: one retry;
// - timeout, 504, reset after sending and any other error: no retry.
// No send and no wait beyond the deadline (minus MARGIN_MS). The overflow goes back to
// the caller (an 'overflow' failure with question, tokens and limit): re-splitting is
// the planner's job. The body goes through validateBody before it is sent.
export async function ask(t: Transport, o: Clock, b: Backend, c: RequestBody,
  network: Policy['network'], deadline: number):
  Promise<Result<{ response: BackendResponse; ms: number; attempts: number; discarded: DiscardedAnswer[] }>> {
  const problems = validateBody(c)
  if (problems.length > 0) {
    const others = problems.length > 1 ? ` (and ${problems.length - 1} more problems)` : ''
    return errResult('validation', `request not sent, outside the limits shared by Jev and rizzo-flow: ${formatProblem(problems[0])}${others}`, { problems })
  }
  const body = JSON.stringify({ state: c.state, model: c.model, questions: c.questions })
  const headers = requestHeaders(b)
  const error = (e: Failure): { ok: false; error: Failure } => ({ ok: false, error: { ...e, message: sanitize(e.message, b.key, 600) } })
  const start = o.now()
  let attempts = 0
  let connections = 0
  let overloads = 0
  let gateway = 0
  let last: Failure | null = null

  for (;;) {
    const remaining = deadline - o.now()
    if (remaining < MARGIN_MS) {
      return error(last ?? { kind: 'timeout', message: 'review time used up: request not sent' })
    }
    // an integer: a clock in fractional milliseconds (performance.now) would give a
    // fractional timeout, and Node's AbortSignal.timeout rejects it with a RangeError
    const timeoutMs = Math.floor(Math.min(network.timeout_ms, remaining))
    attempts++
    const e = await t({ url: b.url, headers: { ...headers }, body, timeoutMs })
    let wait: number

    if (e.kind === 'timeout') {
      return error({ kind: 'timeout', message: `no response from the backend within ${seconds(timeoutMs)}: no retry (rizzo-flow keeps computing abandoned requests)` })
    }
    if (e.kind === 'network') {
      if (!e.beforeSend) {
        return error({ kind: 'network', message: `connection dropped after sending: ${e.message} (no retry: the request may be in progress)` })
      }
      connections++
      last = { kind: 'network', message: `backend unreachable: ${e.message}` }
      if (connections >= Math.max(1, network.connect_attempts)) return error(last)
      wait = network.backoff_ms * 2 ** (connections - 1)
    } else if (e.status === 200) {
      const parsed = parseResponse(e.text, c.questions)
      if (!parsed.ok) return error(parsed.error)
      return okResult({ ...parsed.value, ms: o.now() - start, attempts })
    } else {
      const classified = classifyStatus(e.status, e.text, b.key, Object.keys(c.questions)) as Failure
      last = classified
      if (OVERLOAD_STATUSES.includes(e.status)) {
        overloads++
        if (overloads > network.overload_attempts) return error(classified)
        if (e.retryAfterMs !== undefined && e.retryAfterMs > network.max_retry_after_ms) {
          return error({ ...classified, message: `${classified.message}; the backend asks to retry in ${seconds(e.retryAfterMs)}, beyond the maximum of ${seconds(network.max_retry_after_ms)}` })
        }
        wait = e.retryAfterMs !== undefined ? Math.max(0, e.retryAfterMs) : network.backoff_ms * 2 ** (overloads - 1)
      } else if (e.status === 502) {
        gateway++
        if (gateway > 1) return error(classified)
        wait = network.backoff_ms
      } else {
        return error(classified)
      }
    }
    if (o.now() + wait + MARGIN_MS > deadline) return error(last)
    await o.sleep(wait)
  }
}
