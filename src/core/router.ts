// The effort router's decisions, pure (rule 4). hooks/register.ts only carries data
// between Claude Code's `$` and these functions: the plugin scanner does not let `$`
// reach an imported function, so every read, fetch and log stays there, and what is
// decided (which configuration, which backend, what is sent, how the answer reads,
// which effort, when the cache guard gives up, what the lines say) is here, where
// node:test and the vm test run it without Claude Code.
//
// Every exported function is total on what the prompt, the backend, the options and
// the engine hand it: bad input gives a skip, an error Result or a reason, never an
// exception. The hook fails open, so an exception would only be a turn left as it was
// with nothing said. The RouterConfig is trusted: effectiveRouterConfig built it. The
// lines built here are English, never carry the prompt, a key or text written by the
// backend, and print numbers with formatNumber.
import { keyFromFileText, parseUrl, requestHeaders, resolveBackend, sanitize } from './backend.ts'
import { argmax, calibrate, chooseProfile } from './calibration.ts'
import { routerRestrictions, validateCalibration, validateRouter } from './config.ts'
import { DEFAULT_CALIBRATION, DEFAULT_ROUTER } from './defaults.ts'
import { formatProblem, isObject, parseJson } from './json.ts'
import { mask, parseMaskMap } from './mask.ts'
import { formatNumber } from './numbers.ts'
import { prng } from './random.ts'
import { redactForBackend } from './redaction.ts'
import { neutralize } from './state.ts'
import { classifyStatus, identityOf, parseResponse, validateBody } from './systemone.ts'
import { EFFORT_SCALE, PROMPT_ORIGIN_KINDS, errResult, okResult } from './types.ts'
import type {
  CacheGuard, Calibration, Classification, Effort, EffortChoice, EffortStep, Failure, GuardState, GuardStep, MaskPair, Result,
  RouterBackend, RouterCondition, RouterConfig, RouterContext, RouterRequest, SessionEffort, StepUsage,
} from './types.ts'

export type {
  CacheGuard, Classification, EffortChoice, GuardState, GuardStep, RouterBackend, RouterContext, RouterRequest, SessionEffort,
  StepUsage,
} from './types.ts'

// How the notes name the files. Labels, not paths: the note tells the user which file
// to open, and ~/.config is where it is unless XDG_CONFIG_HOME moves it.
// For a linked worktree there are two project files: the checkout's own, and the
// main working tree's.
export const ROUTER_FILES = {
  user: '~/.config/jev-hooks/router.json',
  userCalibration: '~/.config/jev-hooks/calibration.json',
  project: '.jev-hooks/router.json',
  projectMainTree: '.jev-hooks/router.json (main working tree)',
  plugin: 'router.json (plugin)',
  pluginCalibration: 'calibration.json (plugin)',
} as const

// Between the head and the tail of a clipped prompt: the model sees that something is
// missing, and "[…]" cannot pass for a line of the prompt.
const CLIP_MARK = '\n[…]\n'

const MSG_MASK = 'guardrail mask map unreadable: nothing is sent to a non-local backend'
const MSG_MASK_NO_HOME = 'guardrail mask map location unknown (no HOME and no GUARDRAIL_MASK_MAP): nothing is sent to a non-local backend'

// ─── Files and backend ────────────────────────────────────────────────────────

// The user's configuration directory, the same rule as src/node/file-config.ts:
// XDG_CONFIG_HOME only when absolute (a relative one does not count, XDG Base
// Directory specification), otherwise ~/.config; null when there is neither.
export function userConfigDir(xdg: string | undefined, home: string | undefined): string | null {
  if (typeof xdg === 'string' && xdg.startsWith('/')) return xdg
  if (typeof home === 'string' && home !== '') return `${home}/.config`
  return null
}

function textOf(o: unknown, k: string): string | null {
  if (!isObject(o)) return null
  const v = o[k]
  return typeof v === 'string' ? v : null
}

function firstProblem(e: Failure): string {
  return e.problems && e.problems.length > 0 ? formatProblem(e.problems[0]) : e.message
}

// The router's configuration: the user's router.json in full, or the plugin's; from
// each project file only the restrictions (routerRestrictions); the calibration the
// user's or the plugin's, baked into the config by validateRouter. Off unless the
// effort_router option is true, whatever the files say: the option is the user's
// consent, a file in ~/.config or in a cloned repo is not.
//
// The user's "enabled": false is a switch, not a field of a valid file: it holds even
// when the rest of the file is wrong, or a required field added in a later version
// would turn the router back on for everyone who switched it off. A file that is not
// JSON at all says nothing, so the plugin's router.json applies to it. A user file that
// exists but cannot be read (userUnreadable: its permissions, a loop of links, another
// hook's refusal) may hold that switch, and nothing can tell: the router stays off, with
// a note, until it can be read. An unreadable calibration.json holds no switch: the
// plugin's calibration applies, with a note.
//
// projects: the project files the hook found, each with the label its notes carry.
// Each one can only restrict, so they apply in turn: "enabled": false from any of them
// sticks, and the lowest max_effort is the cap. The same text read at two paths (a
// plain repository, where the checkout and the main working tree are one) counts once.
// A project file that is there but cannot be read (unreadable) is like the user's: it
// may be the repository's "enabled": false, so the router stays off, with a note that
// names the file and nothing of it, until it can be read.
export function effectiveRouterConfig(
  f: {
    user: string | null; userUnreadable?: boolean; projects: readonly { label: string; text: string | null; unreadable?: boolean }[]
    userCalibration: string | null; userCalibrationUnreadable?: boolean
  },
  options: Readonly<Record<string, unknown>>,
): { cfg: RouterConfig | null; notes: string[] } {
  const notes: string[] = []
  const userCalibration = textOf(f, 'userCalibration')
  const user = textOf(f, 'user')
  const projects = isObject(f) && Array.isArray(f.projects) ? f.projects : []
  // a text that came wins over the flag: only a file with no text can be unreadable
  const userUnreadable = user === null && isObject(f) && f.userUnreadable === true
  const calibrationUnreadable = userCalibration === null && isObject(f) && f.userCalibrationUnreadable === true

  let calibration: Calibration | undefined
  if (userCalibration !== null) {
    const parsed = parseJson(userCalibration, ROUTER_FILES.userCalibration)
    const v = parsed.ok ? validateCalibration(parsed.value, ROUTER_FILES.userCalibration) : parsed
    if (v.ok) calibration = v.value
    else notes.push(`${ROUTER_FILES.userCalibration}: invalid, the plugin's calibration is used (${firstProblem(v.error)})`)
  } else if (calibrationUnreadable) notes.push(`${ROUTER_FILES.userCalibration}: unreadable, the plugin's calibration is used`)
  if (!calibration) {
    const d = validateCalibration(DEFAULT_CALIBRATION, ROUTER_FILES.pluginCalibration)
    if (!d.ok) return { cfg: null, notes: [...notes, `${ROUTER_FILES.pluginCalibration}: invalid (${firstProblem(d.error)})`] }
    calibration = d.value
  }

  let cfg: RouterConfig | undefined
  let userOff = userUnreadable
  if (userUnreadable) notes.push(`${ROUTER_FILES.user}: unreadable, the router stays off until it can be read`)
  if (user !== null) {
    const parsed = parseJson(user, ROUTER_FILES.user)
    userOff = parsed.ok && isObject(parsed.value) && parsed.value.enabled === false
    const v = parsed.ok ? validateRouter(parsed.value, calibration, ROUTER_FILES.user) : parsed
    if (v.ok) cfg = v.value
    else if (userOff) notes.push(`${ROUTER_FILES.user}: invalid, the router stays off as the file asks (${firstProblem(v.error)})`)
    else notes.push(`${ROUTER_FILES.user}: invalid, the plugin's router.json is used (${firstProblem(v.error)})`)
  }
  if (!cfg) {
    const d = validateRouter(DEFAULT_ROUTER, calibration, ROUTER_FILES.plugin)
    if (!d.ok) return { cfg: null, notes: [...notes, `${ROUTER_FILES.plugin}: invalid (${firstProblem(d.error)})`] }
    cfg = d.value
  }
  if (userOff) cfg = { ...cfg, enabled: false }

  const seen = new Set<string>()
  for (const project of projects) {
    const label = isObject(project) && typeof project.label === 'string' ? project.label : ROUTER_FILES.project
    const text = textOf(project, 'text')
    if (text === null) {
      // a text that came wins over the flag, as for the user's file
      if (isObject(project) && project.unreadable === true) {
        cfg = { ...cfg, enabled: false }
        notes.push(`${label}: unreadable, the router stays off until it can be read`)
      }
      continue
    }
    if (seen.has(text)) continue
    seen.add(text)
    // untrusted: a parse error names a position, never a piece of the file
    const parsed = parseJson(text, label, true)
    if (!parsed.ok) {
      notes.push(`${label}: invalid, ignored`)
      continue
    }
    const r = routerRestrictions(cfg, parsed.value, label)
    cfg = r.router
    // a loop, not push(...): the notes are bounded, but no spread of a list whose
    // length a file decides
    for (const n of r.notes) notes.push(n)
  }

  if (!(isObject(options) && options.effort_router === true)) cfg = { ...cfg, enabled: false }
  return { cfg, notes }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Two layers and nothing else. The first is the user's (router_url or review_url,
// router_api_key or api_key or the key file): a key stays with the URL of its own
// layer. The second takes only a URL from the environment, never a key: a variable
// exported in a shell is not the user's choice of where a key may go, and the router
// has no TYPESAFE_* fallback either.
//
// api_key and the key file were given for review_url: they follow router_url only to
// the same scheme and host. The port does not count, so two instances on one box
// (8017 and 8019) share the key; a router_url elsewhere, a LAN rizzo over http next to
// a TypeSafe review_url for one, gets router_api_key or nothing, never the TypeSafe
// key in clear.
export function routerBackend(options: Readonly<Record<string, unknown>>,
  env: { routerUrl?: string; url?: string; keyFile?: string | null }): Result<RouterBackend> {
  const o = isObject(options) ? options : {}
  const e = isObject(env) ? env : {}
  const routerUrl = str(o.router_url)
  const reviewUrl = str(o.review_url)
  let inherit = routerUrl === ''
  if (!inherit) {
    const a = parseUrl(routerUrl)
    const b = parseUrl(reviewUrl)
    inherit = a.ok && b.ok && a.value.scheme === b.value.scheme && a.value.host === b.value.host
  }
  const r = resolveBackend({
    layers: [
      {
        name: 'userConfig (router_url, router_api_key)',
        url: routerUrl || reviewUrl,
        key: str(o.router_api_key) || (inherit ? str(o.api_key) || keyFromFileText(textOf(e, 'keyFile')) : ''),
        model: str(o.model),
      },
      { name: 'JEV_HOOKS_ROUTER_URL / JEV_HOOKS_URL', url: str(e.routerUrl) || str(e.url) },
    ],
  })
  if (!r.ok) return r
  const { url, key, model, local, host } = r.value
  return okResult({ url, key, model, local, host })
}

// ─── The request ──────────────────────────────────────────────────────────────

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff
const count = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0)

// A long prompt keeps its head (what is asked) and its tail (often the error or the
// last instruction): headChars units, the mark, then max − headChars units. A cut
// never splits a surrogate pair: it moves inwards, so the piece gets one unit shorter.
export function clipPrompt(text: string, max: number, headChars: number): string {
  const t = typeof text === 'string' ? text : ''
  const m = count(max)
  if (t.length <= m) return t
  const h = Math.min(m, count(headChars))
  let headEnd = h
  if (headEnd > 0 && isHigh(t.charCodeAt(headEnd - 1)) && isLow(t.charCodeAt(headEnd))) headEnd--
  let tailStart = t.length - (m - h)
  if (tailStart < t.length && isLow(t.charCodeAt(tailStart)) && isHigh(t.charCodeAt(tailStart - 1))) tailStart++
  return `${t.slice(0, headEnd)}${CLIP_MARK}${t.slice(tailStart)}`
}

// The prompt's origin kind; an input without one (a test kit) counts as unclassified.
function originKind(e: unknown): string {
  const origin = isObject(e) ? e.origin : undefined
  return isObject(origin) && typeof origin.kind === 'string' ? origin.kind : 'unclassified'
}

// What goes to the backend for one prompt, or why nothing goes. The state is the
// prompt as plain text (rizzo wraps a string state in its own evidence tag): towards a
// backend that leaves the machine, redacted and masked like the reviewer's diff (redact
// first, then mask), then clipped, and neutralized last, so no step can reintroduce the
// tag. Redaction and masking see the whole prompt, before the clip: a cut through a
// secret or a mask term would leave two pieces too short to match, and a PEM block
// whose BEGIN line falls in the dropped middle would lose what marks it; clipping
// afterwards only cuts through substitutes. So redactions counts the whole prompt,
// the middle the clip drops included. Towards a local backend: clipped, neutralized.
//
// A mask map that exists but cannot be read, or cannot be looked for (error 'no home':
// neither HOME nor GUARDRAIL_MASK_MAP), stops the request towards a non-local backend,
// as it stops the reviewer's: a skip with problem, which the user must hear about.
export function prepareRequest(cfg: RouterConfig, e: { text: string; origin?: { kind?: string } | null },
  b: RouterBackend, maskFile: { text: string | null; error?: string }, seed: number): RouterRequest {
  const kind = originKind(e)
  if (!cfg.only_origins.includes(kind)) {
    const shown = (PROMPT_ORIGIN_KINDS as readonly string[]).includes(kind) ? kind : 'other'
    return { skip: `origin "${shown}" is not classified` }
  }
  const text = isObject(e) && typeof e.text === 'string' ? e.text : ''
  if (text.trim() === '') return { skip: 'empty prompt' }
  const lead = text.trimStart()
  const prefix = cfg.skip_prefixes.find((x) => lead.startsWith(x))
  if (prefix !== undefined) return { skip: `starts with "${prefix}"` }

  let source = text
  let redactions = 0
  if (!b.local) {
    // no answer about the map counts as an unreadable map: when in doubt, nothing is sent
    const m = isObject(maskFile) ? maskFile : { text: null, error: 'missing' }
    if (m.error !== undefined) return { skip: m.error === 'no home' ? MSG_MASK_NO_HOME : MSG_MASK, problem: true }
    let pairs: MaskPair[] = []
    if (typeof m.text === 'string') {
      const parsed = parseMaskMap(m.text)
      if (!parsed.ok) return { skip: MSG_MASK, problem: true }
      pairs = parsed.value
    }
    const r = redactForBackend(b, text, null, prng(seed))
    redactions = r.redactions
    source = pairs.length > 0 ? mask(r.text, pairs) : r.text
  }
  const state = neutralize(clipPrompt(source, cfg.prompt_max_chars, cfg.prompt_head_chars)).text
  const body = { state, model: b.model, questions: cfg.questions }
  const problems = validateBody(body)
  if (problems.length > 0) return { skip: `request outside the limits shared by Jev and rizzo-flow: ${problems[0].message}` }
  return { url: b.url, init: { method: 'POST', headers: requestHeaders(b), body: JSON.stringify(body) }, redactions }
}

// The engine's two refusals of $.http.fetch, made before any request, and the fixed
// phrase each becomes in the line.
const FETCH_REFUSALS: Readonly<Record<string, string>> = {
  'network access from plugins is disabled by policy': ' (network disabled by policy)',
  'nonessential network traffic is disabled for this session': ' (nonessential traffic disabled)',
}

// The detail of a rejected $.http.fetch in the fail-open line, as a fixed token or
// nothing. The engine's message can carry text the backend chose: after a redirect it
// quotes the Location (`$.http.fetch(<href>) failed: …`, `$.http.fetch: <href>
// refused: http or https only`), and the cause's own message follows the code. So the
// line never repeats the message. The two refusals become a fixed phrase only as the
// engine's whole fixed message, `<plugin>: $.http.fetch: refused: <reason>` and nothing
// after it: a Location of another scheme is quoted with its spaces, and a URL that
// does not parse is quoted in the cause, so a reason found anywhere else in the message
// may be the backend's choice. A failure gives only its code, read where the engine
// writes it (`<plugin>: $.http.fetch(<href>) failed: <code>: …`). An http(s) href has
// no whitespace, so the text between the parentheses cannot fake that shape; a message
// of any other shape gives nothing.
export function fetchFailure(message: string): string {
  const m = typeof message === 'string' ? message : ''
  const refused = /^(?:[A-Za-z]+: )?[^\s:]+: \$\.http\.fetch: refused: (.+)$/.exec(m)
  if (refused && Object.hasOwn(FETCH_REFUSALS, refused[1])) return FETCH_REFUSALS[refused[1]]
  const code = /^(?:[A-Za-z]+: )?[^\s:]+: \$\.http\.fetch\(\S*\) failed: ([A-Za-z][A-Za-z0-9_]{1,40}): /.exec(m)
  return code ? ` (${code[1]})` : ''
}

// ─── The answer ───────────────────────────────────────────────────────────────

// The level with the highest probability, the higher one on a tie: the argmax does not
// move with the temperature, the calibrated score (Σ k·p'_k) does. -1 without levels.
function argmaxLevel(prob: Record<string, number>): number {
  let best = -1
  let max = -1
  for (const [k, p] of Object.entries(prob)) {
    if (!/^(0|[1-9][0-9]*)$/.test(k) || !Number.isFinite(p)) continue
    const level = Number(k)
    if (p > max || (p === max && level > best)) {
      best = level
      max = p
    }
  }
  return best
}

// The backend's answer as a Classification, calibrated with the profile its identity
// picks. Every error message goes through sanitize with the key: classifyStatus and
// parseResponse never quote the backend, and sanitize keeps it that way for the key.
export function parseClassification(cfg: RouterConfig, b: RouterBackend, status: number, text: string): Result<Classification> {
  const key = isObject(b) && typeof b.key === 'string' ? b.key : ''
  const failed = (f: Failure): Result<Classification> => ({ ok: false, error: { ...f, message: sanitize(f.message, key, 300) } })
  const ids = Object.keys(cfg.questions)
  const refused = classifyStatus(status, text, key, ids)
  if (refused) return failed(refused)
  const parsed = parseResponse(text, cfg.questions)
  if (!parsed.ok) return failed(parsed.error)
  const resp = parsed.value.response
  // the router has no policy: the band's δ plays no part in its decisions
  const sel = chooseProfile(cfg.calibration, identityOf(resp, b), { delta_logit: cfg.calibration.wide_delta_logit })

  const p: Record<string, number> = {}
  const levels: Record<string, number> = {}
  const choices: Record<string, { option: string; p: number }> = {}
  const missing: string[] = []
  // a calibrated profile says nothing about the router's questions: only a question
  // that went through a fit of its own makes the classification calibrated
  let fitted = false
  for (const id of ids) {
    const answer = Object.hasOwn(resp.answers, id) ? resp.answers[id] : undefined
    if (!answer) {
      missing.push(id)
      continue
    }
    const c = calibrate(id, cfg.questions[id], answer, sel)
    if (c.tier === 'question') fitted = true
    const r = c.response
    if (r.type === 'noul') p[id] = r.noul
    else if (r.type === 'choice') {
      // Without a temperature (a server-calibrated answer, a profile with no choice
      // block) calibrate keeps the backend's `choice`, and nothing checks that it is the
      // most probable option: a claimed small_edit at 0.35 next to design at 0.55 would
      // lower the turn. The option is the argmax; the claim only breaks an exact tie.
      const option = argmax(r.probabilities, r.choice)
      choices[id] = { option, p: r.probabilities[option] }
    } else {
      const level = argmaxLevel(r.probabilities)
      if (level < 0) missing.push(id)
      else levels[id] = level
    }
  }
  missing.sort()
  const task = Object.hasOwn(choices, cfg.taskQuestion) ? choices[cfg.taskQuestion] : undefined
  if (!task) return errResult('response', `the backend did not answer the task-kind question (${cfg.taskQuestion})`)
  return okResult({
    taskQuestion: cfg.taskQuestion,
    taskKind: task.option,
    pTask: task.p,
    p,
    levels,
    choices,
    missing,
    profile: sel.profile.name,
    calibrated: sel.profile.calibrated && sel.mode === 'client' && fitted,
  })
}

// ─── The effort ───────────────────────────────────────────────────────────────

// A map of a Classification, or an empty one: a malformed classification leaves the
// turn alone instead of throwing.
function mapOf<T>(v: unknown): Record<string, T> {
  return isObject(v) ? v as Record<string, T> : {}
}

function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORT_SCALE as readonly string[]).includes(v)
}

const rank = (e: Effort): number => EFFORT_SCALE.indexOf(e)

// n steps along low < medium < high < xhigh < max, clamped at both ends.
export function shiftEffort(e: Effort, n: number): Effort {
  const i = rank(e)
  if (i < 0) return e
  const k = i + (Number.isFinite(n) ? Math.trunc(n) : 0)
  return EFFORT_SCALE[Math.min(EFFORT_SCALE.length - 1, Math.max(0, k))]
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return rank(a) >= rank(b) ? a : b
}

export function minEffort(a: Effort, b: Effort): Effort {
  return rank(a) <= rank(b) ? a : b
}

// A substring of the model id, case-insensitive: "opus-5-5" matches claude-opus-5-5 and
// its [1m] variant. Outside these models an effort change clears the prompt cache.
export function modelAllowed(cfg: RouterConfig, model: string): boolean {
  if (typeof model !== 'string' || model === '') return false
  const m = model.toLowerCase()
  return cfg.only_models.some((x) => m.includes(x.toLowerCase()))
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))
const stepText = (s: EffortStep | 'previous'): string => (typeof s === 'number' ? signed(s) : s)

// The value that makes a condition hold, as the trace prints it; null when it does not
// hold or its answer is missing.
function holds(c: Classification, cond: RouterCondition): string | null {
  const q = cond.question
  if (cond.p_gte !== undefined) {
    const ps = mapOf<number>(c.p)
    const p = Object.hasOwn(ps, q) ? ps[q] : undefined
    return p !== undefined && p >= cond.p_gte ? formatNumber(p) : null
  }
  if (cond.level_gte !== undefined) {
    const levels = mapOf<number>(c.levels)
    const level = Object.hasOwn(levels, q) ? levels[q] : undefined
    return level !== undefined && level >= cond.level_gte ? String(level) : null
  }
  return null
}

// The effort for the turn, or why it stays as it is. Base step from the task kind,
// then the adjustments in file order, then the explicit request for depth (it replaces
// what came before), then the floors, then min_effort and the cap, which wins over the
// floor: by default the cap is the session's effort, so the router only lowers. The
// reason is a one-line trace of the rules that fired, with ids from the trusted
// configuration and the calibrated numbers.
export function chooseEffort(c: Classification | null, ctx: RouterContext, cfg: RouterConfig): EffortChoice {
  if (!cfg.enabled) return { reason: 'router off' }
  if (!isObject(c)) return { reason: 'no classification' }
  const context: Partial<RouterContext> = isObject(ctx) ? ctx : {}
  const model = typeof context.model === 'string' ? context.model : ''
  if (!modelAllowed(cfg, model)) return { reason: `model ${sanitize(model, '', 80)} not allowed: an effort change would clear the prompt cache` }

  let reference: Effort
  if (typeof context.effort === 'number') return { reason: 'session effort is a token budget, not a level' }
  if (typeof context.effort === 'string') {
    if (!isEffort(context.effort)) return { reason: 'session effort is not a known level' }
    reference = context.effort
  } else if (cfg.assume_session_effort === null) return { reason: 'session effort not declared' }
  else reference = cfg.assume_session_effort

  if (!(c.pTask >= cfg.min_top_probability)) {
    return { reason: `uncertain classification (${c.taskKind} ${formatNumber(c.pTask)} < ${formatNumber(cfg.min_top_probability)})` }
  }
  // In the shipped config every adjust and every floor raises: skipping one because its
  // answer is missing would bias the effort downwards, so the turn is left alone.
  const referenced = new Set<string>([
    ...cfg.adjust.map((a) => a.if.question),
    ...cfg.floors.map((x) => x.if.question),
    ...(cfg.explicit_depth ? [cfg.explicit_depth.question] : []),
  ])
  const missing = (Array.isArray(c.missing) ? c.missing : []).filter((q) => referenced.has(q))
  if (missing.length > 0) return { reason: `incomplete classification (missing: ${missing.join(', ')})` }
  if (!Object.hasOwn(cfg.base, c.taskKind)) return { reason: 'unchanged (task kind not in base)' }

  const trace: string[] = []
  const step = cfg.base[c.taskKind]
  let result: Effort
  if (step === 'previous') result = isEffort(context.previous) ? context.previous : reference
  else if (typeof step === 'number') result = shiftEffort(reference, step)
  else result = step
  trace.push(`${c.taskKind} ${formatNumber(c.pTask)}: ${stepText(step)} → ${result}`)

  for (const a of cfg.adjust) {
    const v = holds(c, a.if)
    if (v === null) continue
    if (a.raise !== undefined) {
      result = shiftEffort(result, a.raise)
      trace.push(`${a.if.question} ${v}: ${signed(a.raise)} → ${result}`)
    } else if (a.at_least !== undefined) {
      result = maxEffort(result, a.at_least)
      trace.push(`${a.if.question} ${v}: at least ${a.at_least} → ${result}`)
    }
  }

  const x = cfg.explicit_depth
  if (x) {
    const choices = mapOf<{ option: string; p: number }>(c.choices)
    const ch = Object.hasOwn(choices, x.question) ? choices[x.question] : undefined
    const mapped = ch && ch.p >= x.min_probability && Object.hasOwn(x.map, ch.option) ? x.map[ch.option] : null
    if (ch && mapped !== null) {
      result = typeof mapped === 'number' ? shiftEffort(reference, mapped) : mapped
      trace.push(`${x.question} ${ch.option} ${formatNumber(ch.p)}: ${stepText(mapped)} → ${result}`)
    }
  }

  for (const fl of cfg.floors) {
    const v = holds(c, fl.if)
    if (v === null) continue
    result = maxEffort(result, fl.at_least)
    trace.push(`floor ${fl.if.question} ${v} → ${result}`)
  }

  let cap = cfg.respect_session_effort ? reference : cfg.max_effort
  if (cfg.projectCap) cap = minEffort(cap, cfg.projectCap)
  const floored = maxEffort(result, cfg.min_effort)
  if (floored !== result) trace.push(`min ${cfg.min_effort}`)
  const capped = minEffort(floored, cap)
  if (capped !== floored) trace.push(`cap ${cap}`)
  result = capped

  const reason = trace.join('; ')
  return result === reference ? { reason: `unchanged (${reason})` } : { effort: result, reason }
}

// ─── Cache guard ──────────────────────────────────────────────────────────────
//
// Without the per-turn-control beta an effort change empties the prompt cache, and
// every changed turn pays the whole context again. The plugin cannot see the beta, but
// it sees the usage of each step: after a change of effort the cache should still
// serve most of the previous request. A first step after an idle gap longer than the
// cache TTL misses legitimately, so only steps whose gap is known to be short are
// judged. The gap the hook passes runs from the start of the turn that produced the
// previous recorded step to this turn's start: that turn's last request came at or
// after its start, and this turn's first request follows its start with little delay,
// which the margin between max_gap_ms and the cache TTL covers. So the gap bounds the
// idle time between the two requests from above. Measured between prompts it would
// not: the wait for the classification, a queue behind a running turn and the
// UserPromptSubmit hooks all fall between a prompt and its turn's start. A prompt that
// starts no turn, a turn that sends no request or one whose start time is unknown does
// not move the start of the gap. Only main-loop steps are fed to it (no agentId).

export const GUARD_START: GuardState = Object.freeze({ last: null, suspects: 0, tripped: false })

// The request's whole input: what the next request should find in the cache.
function prefixTokens(u: StepUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

function copyStep(s: GuardStep): GuardStep {
  const u = isObject(s.usage) ? s.usage : null
  const out: GuardStep = {
    usage: u ? { input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens } : null,
    messageCount: s.messageCount,
    model: s.model,
  }
  if (s.effort !== undefined) out.effort = s.effort
  return out
}

// read and prefix come with every judged step (hit, suspect, tripped): the numbers
// the lines print.
export function cacheGuard(g: CacheGuard | null, s: GuardState, step: GuardStep, gapMs: number | null):
  { state: GuardState; verdict: 'none' | 'hit' | 'suspect' | 'tripped'; read?: number; prefix?: number } {
  const state: GuardState = isObject(s) ? s : GUARD_START
  const current = copyStep(isObject(step) ? step : { usage: null, messageCount: 0, model: '' })
  const none = { state: { last: current, suspects: state.suspects, tripped: state.tripped }, verdict: 'none' as const }
  const prev = state.last
  if (!g || state.tripped || !prev) return none
  if (!current.usage || !prev.usage) return none
  if (current.effort === prev.effort || current.model !== prev.model) return none
  // fewer messages than before: a compaction rewrote the conversation, the prefix is new
  if (current.messageCount < prev.messageCount) return none
  if (gapMs === null || !(gapMs <= g.max_gap_ms)) return none
  const prefix = prefixTokens(prev.usage)
  const read = current.usage.cache_read_input_tokens
  if (!Number.isFinite(prefix) || !Number.isFinite(read) || !(prefix >= g.min_prefix_tokens) || prefix <= 0) return none
  if (read / prefix >= g.max_read_ratio) return { state: { last: current, suspects: 0, tripped: false }, verdict: 'hit', read, prefix }
  const suspects = state.suspects + 1
  if (suspects >= g.trips) return { state: { last: current, suspects, tripped: true }, verdict: 'tripped', read, prefix }
  return { state: { last: current, suspects, tripped: false }, verdict: 'suspect', read, prefix }
}

// ─── Lines ────────────────────────────────────────────────────────────────────

// The status bar after a decision: "jev router: small_edit 0.91 → low".
export function statusLine(c: Classification, choice: EffortChoice, ctx: RouterContext): string {
  const task = `${c.taskKind} ${formatNumber(c.pTask)}`
  if (isObject(choice) && choice.effort) return `jev router: ${task} → ${choice.effort}`
  const level = isObject(ctx) && isEffort(ctx.effort) ? ` (${ctx.effort})` : ''
  return `jev router: ${task}, effort unchanged${level}`
}

// The debug line of a classification: the task kind first, then scores, nouls and the
// other choices, each group in the config's order, then what was not answered.
export function routerLogLine(c: Classification, ms: number): string {
  const parts = [`${c.taskKind} ${formatNumber(c.pTask)}`]
  for (const [id, level] of Object.entries(mapOf<number>(c.levels))) parts.push(`${id} ${level}`)
  for (const [id, p] of Object.entries(mapOf<number>(c.p))) parts.push(`${id} ${formatNumber(p)}`)
  for (const [id, ch] of Object.entries(mapOf<{ option: string; p: number }>(c.choices))) {
    if (id !== c.taskQuestion) parts.push(`${id} ${ch.option} ${formatNumber(ch.p)}`)
  }
  if (Array.isArray(c.missing) && c.missing.length > 0) parts.push(`missing ${c.missing.join(' ')}`)
  return `[jev-hooks] router: ${parts.join(', ')} in ${formatNumber(ms, 0)} ms (profile ${c.profile})`
}

function effortText(e: SessionEffort | undefined): string {
  if (typeof e === 'number') return formatNumber(e, 0)
  return isEffort(e) ? e : 'default'
}

// "[jev-hooks] effort xhigh → low: <reason>" for a change; without one there is no
// arrow: "[jev-hooks] effort xhigh: unchanged (…)".
export function decisionLine(ctx: RouterContext, choice: EffortChoice): string {
  const from = effortText(isObject(ctx) ? ctx.effort : undefined)
  if (!isObject(choice)) return `[jev-hooks] effort ${from}: no decision`
  return choice.effort ? `[jev-hooks] effort ${from} → ${choice.effort}: ${choice.reason}` : `[jev-hooks] effort ${from}: ${choice.reason}`
}

// The transcript line when the guard trips (prefix: the tokens of the request before
// the change, as cacheGuard returns them).
export function guardLine(step: GuardStep, prevTotal: number, trips: number): string {
  const read = isObject(step) && isObject(step.usage) ? step.usage.cache_read_input_tokens : 0
  return `[jev-hooks] router off for this session: after an effort change the prompt cache served ${formatNumber(read, 0)} of ${formatNumber(prevTotal, 0)} tokens, ${formatNumber(trips, 0)} times in a row. The per-turn-control beta is probably not active (or was dropped until /clear or /compact); set effort_router to false if this repeats.`
}
