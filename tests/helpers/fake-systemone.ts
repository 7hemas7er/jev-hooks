// Fake /v1/systemone server, for the tests and for the Action smoke test. It
// behaves like rizzo-flow (commit f363583) or like TypeSafe's Jev, and a scenario in
// tests/scenarios/*.json decides the answers.
//
// It validates requests on its own, without importing anything from src/core: if the
// client and the fake shared the validator, a client bug would pass here too. The
// rules and the error texts come from the rizzo-flow source (compat.py, schema.py,
// prompts.py, api.py): a Pydantic-style 422 with the "input" field for shape errors, a
// 422 with a text "detail" for the engine's errors, 400 for an unknown model, 401 for
// the key.
//
// Token counting deliberately uses a tokenizer different from the client's (1 token
// every 1.5 ASCII characters and 1 per non-ASCII character, against the 3 characters
// per token of chars_per_token): the re-split on overflow must not succeed by
// construction. The question's tokens are counted separately and do not drop when the
// state gets shorter, as in rizzo.
//
// As a library: startFake(options) → { url, requests, close }.
// As a program:
//   node tests/helpers/fake-systemone.ts --port 8765 --mode rizzo --scenario tests/scenarios/demo.json
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FakeMode = 'rizzo' | 'jev'

// A scripted fault. It applies to one request by index (sequence) or to all of them
// (always); the sequence's fields win over those of always.
export interface Fault {
  http?: number                       // answers with this status (and with a body, if any)
  body?: unknown                     // text sent as it is, or serialized JSON
  retry_after?: number                // Retry-After header, in seconds
  delay_ms?: number                 // wait before answering, holding the lock
  no_answers?: boolean             // 200 response without answers
  malformed?: Record<string, unknown>   // answers replaced by these raw values
  nan?: string[]                      // noul written as a literal NaN, like Python's json.dumps
  sum?: number                      // choice and score probabilities scaled to this sum
  mib?: number                        // 200 response padded up to this many MiB
  redirect?: string                   // 307 to this address
  fingerprint?: string                // x_rizzo.fingerprint of this response
  model?: string                    // model of this response
  black_hole?: boolean                 // no response, ever (without holding the lock)
}

// Value of an answer: number = p for a noul or level for a score, string = option of
// a choice, object = raw answer sent as it is.
export interface ScenarioRule { if_state_contains?: string; answers: Record<string, unknown> }

export interface Scenario {
  rules?: ScenarioRule[]
  defaults?: { noul?: number; choice?: string; score?: number }
  sequence?: Fault[]
  always?: Fault
}

export interface FakeOptions {
  port?: number                      // 0 or missing: a free port chosen by the system
  host?: string                       // default 127.0.0.1
  mode?: FakeMode                    // default rizzo
  scenario?: Scenario | string        // object, file path or name in tests/scenarios/
  key?: string                     // required Bearer; without it, no check (like rizzo without RIZZO_API_KEY)
  ctx?: number                        // rizzo's --ctx: maximum tokens per question (state + question)
  serverCalibrated?: boolean           // probability_status all "temperature_scaled_…"
  serverCalibratedPartial?: boolean   // temperature for noul only: both values
  blackHole?: boolean                  // accepts the connection and never answers
  fingerprint?: string                // default fake-fp-1
}

export interface RecordedRequest {
  index: number
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
  json?: unknown
  arrival: number                      // ms since the server started
  start?: number                     // lock taken
  end?: number                       // response written (or abandoned)
  status?: number
  abandoned: boolean                // the client closed before the response
}

export interface FakeServer {
  url: string                         // root, without /v1/systemone
  port: number
  requests: RecordedRequest[]
  maxInFlight(): number             // maximum number of HTTP requests open at once
  close(): Promise<void>
}

const RIZZO_MODEL = 'rizzo-spark-x2.5-4b-bf16'
const JEV_MODEL = 'jev-1.13.0'
const STATUS_UNCALIBRATED = 'uncalibrated_conditional_option_scores'
const STATUS_CALIBRATED = 'temperature_scaled_requires_held_out_validation'
const MAX_TEXT = 8000
const MAX_STATE_BYTES = 256_000
const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios')

type PlainObject = Record<string, unknown>
const isObject = (v: unknown): v is PlainObject => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStructured = (v: unknown): boolean => typeof v === 'string' || Array.isArray(v) || isObject(v)

// Scenario from a file: a name without "/" or ".json" is looked up in tests/scenarios/.
export function loadScenario(source: string): Scenario {
  const path = !source.includes('/') && !source.endsWith('.json')
    ? join(SCENARIOS_DIR, `${source}.json`)
    : isAbsolute(source) ? source : resolve(process.cwd(), source)
  const v = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(v)) throw new Error(`invalid scenario: ${path}`)
  return v as Scenario
}

// ─── rizzo's native text and token count ──────────────────────────────────────

// json.dumps(ensure_ascii=False, sort_keys=True, separators=(",", ":")) from prompts.py
function pythonCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pythonCanonical).join(',')}]`
  if (isObject(v)) {
    const keys = Object.keys(v).sort((a, b) => {
      const x = [...a].map((c) => c.codePointAt(0) as number)
      const y = [...b].map((c) => c.codePointAt(0) as number)
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
      return x.length - y.length
    })
    return `{${keys.map((k) => `${JSON.stringify(k)}:${pythonCanonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

// text() from compat.py: strip for strings, canonical JSON for the rest
const nativeText = (v: unknown): string => (typeof v === 'string' ? v.trim() : pythonCanonical(v))
const charCount = (s: string): number => [...s].length

function tokenCount(s: string): number {
  let ascii = 0
  let others = 0
  for (const c of s) {
    if ((c.codePointAt(0) as number) < 0x80) ascii++
    else others++
  }
  return Math.ceil(ascii / 1.5) + others
}

// render_state from prompts.py: a string goes as it is, an object or a string that
// contains the closing evidence tag becomes indented JSON. The tag is composed at
// runtime: written out in full it would make evidence_delimiter fire on the repo's commits.
const EVIDENCE_CLOSE = '</' + 'evidence>'

function renderedState(state: unknown): string {
  if (typeof state === 'string' && !state.toLowerCase().includes(EVIDENCE_CLOSE)) return state.trim()
  return JSON.stringify(state, null, 1)
}

// Native texts of a question: instructions, then the candidates' descriptions
// ("Yes. …"/"No. …", "name: detail", levels). With the field name for the 422s.
function nativeTexts(q: PlainObject): { field: string; text: string }[] {
  const out = [{ field: 'instructions', text: nativeText(q.instructions) }]
  const c = q.criteria
  if (q.type === 'noul') {
    const cr = isObject(c) ? c : {}
    out.push({ field: 'true_description', text: cr.true == null ? 'Yes. The evidence supports an affirmative answer to the question.' : `Yes. ${nativeText(cr.true)}` })
    out.push({ field: 'false_description', text: cr.false == null ? 'No. The evidence supports a negative answer to the question.' : `No. ${nativeText(cr.false)}` })
  } else if (q.type === 'choice' && isObject(c)) {
    Object.entries(c).forEach(([name, d], i) => out.push({ field: `options.${i}.description`, text: d === null ? name : `${name}: ${nativeText(d)}` }))
  } else if (q.type === 'score' && Array.isArray(c)) {
    c.forEach((l, i) => out.push({ field: `levels.${i}`, text: nativeText(l) }))
  }
  return out
}

// ─── Validation like rizzo ────────────────────────────────────────────────────

interface Result { status: number; body: unknown }

type PydanticError = { type: string; loc: (string | number)[]; msg: string; input: unknown }

// Request shape (compat.py, strict and extra=forbid per question): a FastAPI-style
// 422, with "input" repeating the offending value. The client must not report it.
function shapeErrors(body: unknown): PydanticError[] {
  const e: PydanticError[] = []
  if (!isObject(body)) return [{ type: 'model_attributes_type', loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', input: body }]
  if (!('state' in body)) e.push({ type: 'missing', loc: ['body', 'state'], msg: 'Field required', input: body })
  else if (!isStructured(body.state)) e.push({ type: 'string_type', loc: ['body', 'state', 'str'], msg: 'Input should be a valid string', input: body.state })
  if (typeof body.model !== 'string') e.push({ type: 'missing', loc: ['body', 'model'], msg: 'Field required', input: body })
  else if (body.model.length < 1 || body.model.length > 128) e.push({ type: 'string_too_long', loc: ['body', 'model'], msg: 'String should have between 1 and 128 characters', input: body.model })
  const qs = body.questions
  if (!isObject(qs)) {
    e.push({ type: 'dict_type', loc: ['body', 'questions'], msg: 'Input should be a valid dictionary', input: qs })
    return e
  }
  const ids = Object.keys(qs)
  if (ids.length < 1 || ids.length > 64) e.push({ type: 'too_long', loc: ['body', 'questions'], msg: 'Dictionary should have between 1 and 64 items', input: qs })
  for (const id of ids) {
    const q = qs[id]
    const loc = ['body', 'questions', id]
    if (!isObject(q) || !['noul', 'choice', 'score'].includes(q.type as string)) {
      e.push({ type: 'union_tag_invalid', loc, msg: "Input tag does not match any of the expected tags: 'noul', 'choice', 'score'", input: q })
      continue
    }
    const t = q.type as string
    for (const k of Object.keys(q)) {
      if (!['type', 'instructions', 'criteria'].includes(k)) e.push({ type: 'extra_forbidden', loc: [...loc, t, k], msg: 'Extra inputs are not permitted', input: q[k] })
    }
    if (!('instructions' in q)) e.push({ type: 'missing', loc: [...loc, t, 'instructions'], msg: 'Field required', input: q })
    else if (!isStructured(q.instructions)) e.push({ type: 'string_type', loc: [...loc, t, 'instructions', 'str'], msg: 'Input should be a valid string', input: q.instructions })
    const c = q.criteria
    if (t === 'noul') {
      if (c === undefined || c === null) continue
      if (!isObject(c)) {
        e.push({ type: 'model_type', loc: [...loc, t, 'criteria'], msg: 'Input should be an object', input: c })
        continue
      }
      for (const [k, v] of Object.entries(c)) {
        if (k !== 'true' && k !== 'false') e.push({ type: 'extra_forbidden', loc: [...loc, t, 'criteria', k], msg: 'Extra inputs are not permitted', input: v })
        else if (v !== null && !isStructured(v)) e.push({ type: 'string_type', loc: [...loc, t, 'criteria', k, 'str'], msg: 'Input should be a valid string', input: v })
      }
    } else if (t === 'choice') {
      if (!isObject(c)) {
        e.push({ type: c === undefined ? 'missing' : 'dict_type', loc: [...loc, t, 'criteria'], msg: 'Input should be a valid dictionary', input: c })
        continue
      }
      const n = Object.keys(c).length
      if (n < 2 || n > 26) e.push({ type: 'too_long', loc: [...loc, t, 'criteria'], msg: 'Dictionary should have between 2 and 26 items', input: c })
      for (const [k, v] of Object.entries(c)) {
        if (v !== null && !isStructured(v)) e.push({ type: 'string_type', loc: [...loc, t, 'criteria', k, 'str'], msg: 'Input should be a valid string', input: v })
      }
    } else {
      if (!Array.isArray(c)) {
        e.push({ type: c === undefined ? 'missing' : 'list_type', loc: [...loc, t, 'criteria'], msg: 'Input should be a valid list', input: c })
        continue
      }
      if (c.length < 2 || c.length > 10) e.push({ type: 'too_long', loc: [...loc, t, 'criteria'], msg: 'List should have between 2 and 10 items', input: c })
      c.forEach((v, i) => {
        if (!isStructured(v)) e.push({ type: 'string_type', loc: [...loc, t, 'criteria', i, 'str'], msg: 'Input should be a valid string', input: v })
      })
    }
  }
  // nonblank_option_keys: a model_validator, so a value_error on the whole body
  if (e.length === 0) {
    for (const q of Object.values(qs)) {
      if (isObject(q) && q.type === 'choice' && isObject(q.criteria) && Object.keys(q.criteria).some((k) => k.trim() === '')) {
        e.push({ type: 'value_error', loc: ['body'], msg: 'Value error, Choice option keys must not be blank', input: body })
        break
      }
    }
  }
  return e
}

// Engine checks (schema.py and prompts.py): 422 with a text detail.
function engineError(body: PlainObject, ctx: number | undefined): string | null {
  const state = body.state
  if (!state || (typeof state === 'string' && state.trim() === '') || (Array.isArray(state) && state.length === 0) || (isObject(state) && Object.keys(state).length === 0)) {
    return 'State must not be empty'
  }
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) return 'State exceeds 256 KB; no silent truncation'
  const qs = body.questions as Record<string, PlainObject>
  if (Object.keys(qs).some((k) => k.trim() === '' || k.length > 128)) return 'Question IDs must have 1–128 nonblank characters'
  for (const [id, q] of Object.entries(qs)) {
    const kind = q.type === 'noul' ? 'boolean' : q.type
    for (const { field, text } of nativeTexts(q)) {
      if (charCount(text) < 1) return `1 validation error for Request\nquestions.${id}.${kind}.${field}\n  String should have at least 1 character`
      if (charCount(text) > MAX_TEXT) return `1 validation error for Request\nquestions.${id}.${kind}.${field}\n  String should have at most ${MAX_TEXT} characters`
    }
    if (q.type === 'score') {
      const levels = (q.criteria as unknown[]).map(nativeText)
      if (new Set(levels).size !== levels.length) return 'Levels must have distinct descriptions'
    }
  }
  if (ctx !== undefined) {
    const stateTokens = tokenCount(renderedState(state))
    for (const [id, q] of Object.entries(qs)) {
      const total = stateTokens + tokenCount(nativeTexts(q).map((x) => x.text).join('\n'))
      if (total > ctx) return `Question ${id}: ${total} tokens exceeds the context limit ${ctx} (--ctx); no truncation`
    }
  }
  return null
}

function modelAccepted(mode: FakeMode, m: string): boolean {
  return mode === 'rizzo' ? m === 'rizzo-latest' || m === RIZZO_MODEL || m.startsWith('jev-') : m.startsWith('jev-')
}

// ─── Answers ──────────────────────────────────────────────────────────────────

const NAN = '__fake_systemone_nan__'

function confidence(ps: number[]): number {
  const n = ps.length
  return Math.max(0, Math.min(1, (n * Math.max(...ps) - 1) / (n - 1)))
}

function answer(q: PlainObject, value: unknown, fallback: Required<NonNullable<Scenario['defaults']>>): unknown {
  if (isObject(value)) return value
  if (q.type === 'noul') return { type: 'noul', noul: typeof value === 'number' ? value : fallback.noul }
  if (q.type === 'choice') {
    const options = Object.keys(q.criteria as PlainObject)
    const selection = typeof value === 'string' ? value : options.includes(fallback.choice) ? fallback.choice : options[0]
    const probabilities = Object.fromEntries(options.map((o) => [o, o === selection ? 1 : 0]))
    return { type: 'choice', choice: selection, probabilities, confidence: confidence(Object.values(probabilities)) }
  }
  const levels = q.criteria as unknown[]
  const n = levels.length
  const l = Math.max(0, Math.min(n - 1, Math.round(typeof value === 'number' ? value : fallback.score)))
  const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === l ? 1 : 0]))
  const legend = Object.fromEntries(levels.map((x, i) => [String(i), nativeText(x)]))
  return { type: 'score', score: l, legend, probabilities, confidence: confidence(Object.values(probabilities)) }
}

function roundValues(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 100) / 100
  if (Array.isArray(v)) return v.map(roundValues)
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'legend' ? x : roundValues(x)]))
  return v
}

function scale(r: unknown, sum: number): unknown {
  if (!isObject(r) || !isObject(r.probabilities)) return r
  const ps = r.probabilities as Record<string, number>
  const s = Object.values(ps).reduce((a, b) => a + b, 0)
  return { ...r, probabilities: Object.fromEntries(Object.entries(ps).map(([k, p]) => [k, (p * sum) / s])) }
}

// ─── Server ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ko) => {
    const pieces: Buffer[] = []
    req.on('data', (b: Buffer) => pieces.push(b))
    req.on('end', () => ok(Buffer.concat(pieces).toString('utf8')))
    req.on('error', ko)
  })
}

// A backend that refuses the connection at once (ECONNREFUSED). Not a port freed by
// closing a fake: test files run in parallel, and another one's fake could take it in
// the meantime and answer 404. Port 4 is privileged (no fake can bind it, they take
// ephemeral ports), nothing listens on it, and fetch does not count it among the
// "bad ports" it refuses before connecting.
export const REFUSED_URL = 'http://127.0.0.1:4'

export async function startFake(o: FakeOptions = {}): Promise<FakeServer> {
  const mode: FakeMode = o.mode ?? 'rizzo'
  const scenario: Scenario = typeof o.scenario === 'string' ? loadScenario(o.scenario) : o.scenario ?? {}
  const fallback = { noul: 0.02, choice: 'nothing', score: 0, ...scenario.defaults }
  const requests: RecordedRequest[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const t0 = performance.now()
  const now = (): number => performance.now() - t0
  let queue: Promise<void> = Promise.resolve()
  let inFlight = 0
  let max = 0
  let systemoneIndex = 0

  const sleep = (ms: number): Promise<void> => new Promise((ok) => {
    const t = setTimeout(() => { timers.delete(t); ok() }, ms)
    timers.add(t)
  })

  const write = (res: ServerResponse, rec: RecordedRequest, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    rec.status = status
    rec.end = now()
    if (res.destroyed || res.writableEnded) return
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    const kind = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'
    try {
      res.writeHead(status, { 'content-type': kind, ...extra })
      res.end(text)
    } catch {
      // the client has gone: for rizzo the request has been computed anyway
    }
  }

  const answerSystemone = (rec: RecordedRequest, body: PlainObject, g: Fault): { status: number; body: unknown; extra?: Record<string, string> } => {
    if (g.redirect !== undefined) return { status: 307, body: '', extra: { location: g.redirect } }
    if (g.http !== undefined && g.http !== 200) {
      const extra: Record<string, string> = g.retry_after !== undefined ? { 'retry-after': String(g.retry_after) } : {}
      return { status: g.http, body: g.body ?? { detail: `scripted error ${g.http}` }, extra }
    }
    if (g.body !== undefined) return { status: 200, body: g.body }
    const qs = body.questions as Record<string, PlainObject>
    const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state)
    const values: Record<string, unknown> = {}
    for (const r of scenario.rules ?? []) {
      if (r.if_state_contains === undefined || stateText.includes(r.if_state_contains)) Object.assign(values, r.answers)
    }
    let answers: Record<string, unknown> = {}
    for (const [id, q] of Object.entries(qs)) {
      let a = answer(q, values[id], fallback)
      if (g.sum !== undefined) a = scale(a, g.sum)
      if (mode === 'jev') a = roundValues(a)
      answers[id] = a
    }
    for (const id of g.nan ?? []) if (id in answers) answers[id] = { type: 'noul', noul: NAN }
    if (g.malformed) answers = { ...answers, ...g.malformed }
    const stateTokens = tokenCount(renderedState(body.state))
    const questionTokens = Object.values(qs).reduce((n, q) => n + tokenCount(nativeTexts(q).map((x) => x.text).join('\n')), 0)
    const r: PlainObject = { model: g.model ?? (mode === 'rizzo' ? RIZZO_MODEL : JEV_MODEL) }
    if (!g.no_answers) r.answers = answers
    if (mode === 'rizzo') {
      r.usage = { input_tokens: stateTokens + questionTokens, output_tokens: 0 }
      const status = o.serverCalibratedPartial ? [STATUS_CALIBRATED, STATUS_UNCALIBRATED] : [o.serverCalibrated ? STATUS_CALIBRATED : STATUS_UNCALIBRATED]
      r.x_rizzo = {
        timing: { queue_seconds: ((rec.start ?? rec.arrival) - rec.arrival) / 1000, inference_seconds: (g.delay_ms ?? 0) / 1000, shared_prefix_tokens: stateTokens },
        probability_status: status,
        fingerprint: g.fingerprint ?? o.fingerprint ?? 'fake-fp-1',
      }
    } else {
      r.usage = { input_tokens: stateTokens + questionTokens, output_tokens: Object.keys(qs).length }
    }
    if (g.mib !== undefined) r.x_pad = 'x'.repeat(Math.ceil(g.mib * 1024 * 1024))
    // NaN does not exist in JSON: it is written literally, as Python's json.dumps does
    return { status: 200, body: JSON.stringify(r).split(`"${NAN}"`).join('NaN') }
  }

  const server = createServer(async (req, res) => {
    res.on('error', () => {})
    inFlight++
    max = Math.max(max, inFlight)
    const rec: RecordedRequest = {
      index: requests.length,
      method: req.method ?? '',
      path: req.url ?? '',
      headers: { ...req.headers },
      body: '',
      arrival: now(),
      abandoned: false,
    }
    requests.push(rec)
    res.on('close', () => {
      inFlight--
      if (!res.writableFinished) {
        rec.abandoned = true
        rec.end ??= now()
      }
    })
    rec.body = await readBody(req).catch(() => '')
    try { rec.json = JSON.parse(rec.body) } catch { /* recorded as it is */ }

    if (o.blackHole) return
    const authorized = o.key === undefined || req.headers.authorization === `Bearer ${o.key}`
    const path = (req.url ?? '').split('?')[0]

    if (req.method === 'GET' && path === '/health') {
      write(res, rec, 200, { status: 'ready', model: { source: 'fake', precision: 'bf16', fingerprint: o.fingerprint ?? 'fake-fp-1' } })
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (!authorized) { write(res, rec, 401, { detail: 'Missing or invalid API key' }); return }
      write(res, rec, 200, { models: [{ name: mode === 'rizzo' ? 'rizzo-latest' : 'jev-latest' }, { name: mode === 'rizzo' ? RIZZO_MODEL : JEV_MODEL }] })
      return
    }
    if (req.method !== 'POST' || path !== '/v1/systemone') {
      write(res, rec, 404, { detail: 'Not Found' })
      return
    }
    const g: Fault = { ...scenario.always, ...scenario.sequence?.[systemoneIndex] }
    systemoneIndex++
    if (g.black_hole) return
    // FastAPI resolves the key dependency before validating the body
    if (!authorized) {
      write(res, rec, 401, { detail: mode === 'rizzo' ? 'Missing or invalid API key' : 'Invalid API key' })
      return
    }
    let body: unknown
    try {
      body = JSON.parse(rec.body)
    } catch {
      write(res, rec, 422, { detail: [{ type: 'json_invalid', loc: ['body', 0], msg: 'JSON decode error', input: {} }] })
      return
    }
    const shape = shapeErrors(body)
    if (shape.length > 0) {
      write(res, rec, 422, { detail: shape })
      return
    }
    const b = body as PlainObject
    if (!modelAccepted(mode, b.model as string)) {
      const note = mode === 'rizzo' ? `Use 'rizzo-latest', '${RIZZO_MODEL}' or a jev-* alias.` : 'Use jev-latest.'
      write(res, rec, 400, { detail: { error_type: 'api_usage_error', message: `Unknown model '${b.model}'. ${note}` } })
      return
    }
    // A single lock, like rizzo: requests queue up, and a request abandoned by the
    // client is computed anyway and holds the lock until the end.
    const turn = queue.then(async () => {
      rec.start = now()
      if (g.delay_ms) await sleep(g.delay_ms)
      const engine = engineError(b, o.ctx)
      if (engine !== null && g.http === undefined) {
        write(res, rec, 422, { detail: engine })
        return
      }
      const r = answerSystemone(rec, b, g)
      write(res, rec, r.status, r.body, r.extra)
    })
    queue = turn.catch(() => {})
    await turn
  })

  await new Promise<void>((ok) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const host = o.host ?? '127.0.0.1'
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    requests,
    maxInFlight: () => max,
    close: async () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      server.closeAllConnections()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}

// ─── As a program ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): FakeOptions {
  const o: FakeOptions = { port: 8765 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === '--port') o.port = Number(value())
    else if (a === '--host') o.host = value()
    else if (a === '--mode') {
      const m = value()
      if (m !== 'rizzo' && m !== 'jev') throw new Error(`unknown mode: ${m} (rizzo or jev)`)
      o.mode = m
    } else if (a === '--scenario') o.scenario = value()
    else if (a === '--key') o.key = value()
    else if (a === '--ctx') o.ctx = Number(value())
    else if (a === '--fingerprint') o.fingerprint = value()
    else if (a === '--server-calibrated') o.serverCalibrated = true
    else if (a === '--server-calibrated-partial') o.serverCalibratedPartial = true
    else if (a === '--black-hole') o.blackHole = true
    else throw new Error(`unknown option: ${a}`)
  }
  return o
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) {
  try {
    const f = await startFake(parseArgs(process.argv.slice(2)))
    process.stdout.write(`fake-systemone listening on ${f.url}\n`)
    const stop = (): void => { f.close().then(() => process.exit(0), () => process.exit(1)) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } catch (err) {
    process.stderr.write(`fake-systemone: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
}
