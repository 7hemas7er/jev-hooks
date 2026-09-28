// Measures the effort router's questions on labelled prompts, and replays the answers
// with another router.json. It is the router's counterpart of measure-questions.ts:
// the request is built by prepareRequest and the answer read by parseClassification,
// the same functions the function hook uses, with the plugin's router.json (or a trial
// one given with --config) as the user layer.
//
// Measuring asks the backend once per prompt and writes raw.jsonl (the answers as they
// came) and report.md. Replaying reads raw.jsonl and prints the report computed with
// the configuration given now: thresholds, base steps, adjustments and floors change
// without the network, as long as the question texts stay the ones measured.
//
// The report has, per question, how well the answer matches the label, and end to end
// how the chosen effort compares with the labelled one for a session at each effort of
// --sessions. The outputs hold ids, numbers, option names and hashes: never a prompt,
// never the backend's host, never a key.
//
// Usage:
//   node scripts/measure-router.ts --out DIR [--dataset FILE] [--url URL] [--model NAME]
//     [--config FILE] [--date TEXT] [--timeout-ms N] [--sessions LIST] [--overwrite]
//   node scripts/measure-router.ts --replay DIR [--dataset FILE] [--config FILE] [--sessions LIST]
//
// The key is never a flag: JEV_HOOKS_KEY goes to the backend only when JEV_HOOKS_URL
// has the same origin as --url, as in the CLI.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isObject } from '../src/core/json.ts'
import { formatNumber } from '../src/core/numbers.ts'
import { chooseEffort, effectiveRouterConfig, parseClassification, prepareRequest } from '../src/core/router.ts'
import { sha256Hex } from '../src/core/sha256.ts'
import { identityOf, parseResponse, questionHash } from '../src/core/systemone.ts'
import { EFFORT_SCALE } from '../src/core/types.ts'
import type { Backend, Classification, Effort, RouterBackend, RouterConfig, Transport } from '../src/core/types.ts'
import { backendFrom, backendSources } from '../src/node/run.ts'
import { nodeTransport } from '../src/node/transport.ts'
import { metrics } from './measure-questions.ts'
import type { Sample } from './measure-questions.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXIT_OK = 0
const EXIT_INTERRUPTED = 1
const EXIT_USAGE = 2
const MAX_CONSECUTIVE_FAILURES = 3
const FATAL_STATUS = new Set([401, 403, 404])

export class InputError extends Error {}

// ─── Dataset ──────────────────────────────────────────────────────────────────

export interface RouterRow {
  id: string
  text: string
  language: string | null
  // choice and score answers as option names and levels, nouls as booleans, effort as
  // the ideal absolute level (null: not judged, as for a confirmation whose effort
  // depends on the turn before)
  labels: Record<string, string | number | boolean | null>
}

const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/

// The labels are checked against the configuration's questions: an option that does
// not exist or a level out of range is a typo, and it would silently count as wrong.
export function parseRouterDataset(text: string, file: string, cfg: RouterConfig): RouterRow[] {
  const rows: RouterRow[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const where = `${file}:${i + 1}`
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      problems.push(`${where}: not JSON`)
      return
    }
    if (!isObject(v)) return void problems.push(`${where}: expected an object`)
    const id = v.id
    if (typeof id !== 'string' || !RE_ID.test(id)) return void problems.push(`${where}: invalid id`)
    if (seen.has(id)) problems.push(`${where}: duplicate id ${id}`)
    seen.add(id)
    if (typeof v.text !== 'string' || v.text.trim() === '') return void problems.push(`${where} (${id}): "text" must be a non-empty string`)
    const raw = isObject(v.labels) ? v.labels : {}
    const labels: RouterRow['labels'] = {}
    for (const [k, x] of Object.entries(raw)) {
      if (x === null) {
        labels[k] = null
        continue
      }
      if (k === 'effort') {
        if (typeof x !== 'string' || !(EFFORT_SCALE as readonly string[]).includes(x)) problems.push(`${where} (${id}): effort must be one of ${EFFORT_SCALE.join(', ')} or null`)
        else labels[k] = x
        continue
      }
      const q = Object.hasOwn(cfg.questions, k) ? cfg.questions[k] : undefined
      if (!q) {
        problems.push(`${where} (${id}): label for ${k}, which is not a router question`)
        continue
      }
      if (q.type === 'noul') {
        if (typeof x !== 'boolean') problems.push(`${where} (${id}): ${k} must be true, false or null`)
        else labels[k] = x
      } else if (q.type === 'choice') {
        const options = isObject(q.criteria) ? Object.keys(q.criteria) : []
        if (typeof x !== 'string' || !options.includes(x)) problems.push(`${where} (${id}): ${k} must be one of ${options.join(', ')}`)
        else labels[k] = x
      } else {
        const levels = Array.isArray(q.criteria) ? q.criteria.length : 0
        if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= levels) problems.push(`${where} (${id}): ${k} must be a level from 0 to ${levels - 1}`)
        else labels[k] = x
      }
    }
    rows.push({ id, text: v.text, language: typeof v.language === 'string' ? v.language : null, labels })
  })
  if (problems.length > 0) throw new InputError(problems.slice(0, 20).join('\n'))
  if (rows.length === 0) throw new InputError(`${file}: no rows`)
  return rows
}

// ─── Configuration ────────────────────────────────────────────────────────────

// The plugin's router.json, or a trial one as the user layer. An invalid trial file
// stops everything: the router would fall back to the plugin's and the numbers would
// silently describe another configuration.
export function routerConfig(configText: string | null, label: string): RouterConfig {
  const { cfg, notes } = effectiveRouterConfig({ user: configText, projects: [], userCalibration: null }, { effort_router: true })
  const bad = notes.find((n) => n.includes('invalid') || n.includes('unreadable'))
  if (!cfg || bad !== undefined) throw new InputError(`${label}: ${bad ?? 'invalid router configuration'}`)
  return cfg
}

export function questionHashes(cfg: RouterConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg.questions).map(([id, w]) => [id, questionHash(w)]))
}

// ─── Measuring ────────────────────────────────────────────────────────────────

export interface RawRow {
  id: string
  ms: number
  status?: number
  body?: unknown               // the backend's JSON answer, as it came
  error?: string
  model: string                // the model requested
  local: boolean
}

export interface MeasureOptions {
  out: string
  dataset: string
  url?: string
  model?: string
  config?: string
  date: string
  timeoutMs: number
  sessions: Effort[]
  overwrite: boolean
  env?: NodeJS.ProcessEnv
  transport?: Transport
  progress?: (line: string) => void
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new InputError(`${file}: cannot be read`)
  }
}

export async function measureRouter(o: MeasureOptions): Promise<{ code: number; report: string; raw: string }> {
  const configText = o.config !== undefined ? readText(o.config) : null
  const cfg = routerConfig(configText, o.config ?? 'router.json (plugin)')
  const datasetText = readText(o.dataset)
  const rows = parseRouterDataset(datasetText, o.dataset, cfg)

  const found = backendFrom(backendSources('cli', o.env ?? process.env, o.url !== undefined ? { explicitUrl: o.url } : {}), o.model, 'cli').backend
  if (Object.hasOwn(found, 'kind')) throw new InputError(`backend: ${(found as { message: string }).message}`)
  const b = found as Backend as RouterBackend

  mkdirSync(o.out, { recursive: true })
  const rawFile = join(o.out, 'raw.jsonl')
  const reportFile = join(o.out, 'report.md')
  if (!o.overwrite && (existsSync(rawFile) || existsSync(reportFile))) {
    throw new InputError(`${o.out} already contains a measurement: choose another directory or use --overwrite`)
  }
  writeFileSync(rawFile, '')

  const transport = o.transport ?? nodeTransport()
  const raw: RawRow[] = []
  let failures = 0
  let fingerprint: string | undefined
  let stop: string | undefined
  for (const [i, r] of rows.entries()) {
    const rq = prepareRequest(cfg, { text: r.text, origin: { kind: cfg.only_origins[0] ?? 'composer' } }, b, { text: null }, 1)
    const line: RawRow = { id: r.id, ms: 0, model: b.model, local: b.local }
    if ('skip' in rq) line.error = `not sent: ${rq.skip}`
    else {
      const e = await transport({ url: rq.url, headers: rq.init.headers, body: rq.init.body, timeoutMs: o.timeoutMs })
      line.ms = Math.round(e.ms)
      if (e.kind === 'response') {
        line.status = e.status
        try {
          line.body = JSON.parse(e.text)
        } catch {
          line.error = 'answer is not JSON'
        }
        if (FATAL_STATUS.has(e.status)) stop = `backend answered ${e.status}`
        else if (e.status !== 200) line.error = `status ${e.status}`
        else {
          const parsed = parseResponse(e.text, cfg.questions)
          if (parsed.ok) {
            const f = identityOf(parsed.value.response, b).fingerprint
            if (fingerprint !== undefined && f !== fingerprint) stop = 'fingerprint changed during the measurement'
            fingerprint ??= f
          }
        }
      } else line.error = e.kind === 'timeout' ? 'timeout' : `network: ${e.message}`
    }
    failures = line.error !== undefined ? failures + 1 : 0
    raw.push(line)
    appendFileSync(rawFile, JSON.stringify(line) + '\n')
    o.progress?.(`${i + 1}/${rows.length} ${r.id}: ${line.error ?? `${formatNumber(line.ms / 1000, 2)} s`}`)
    if (failures >= MAX_CONSECUTIVE_FAILURES) stop ??= `${MAX_CONSECUTIVE_FAILURES} failed requests in a row`
    if (stop !== undefined) break
  }

  const report = renderRouterReport({
    rows, raw, cfg, sessions: o.sessions, date: o.date, interrupted: stop,
    dataset: { file: showFile(o.dataset), sha: sha256Hex(datasetText) },
    config: { file: o.config !== undefined ? showFile(o.config) : 'config/router.json (plugin)', sha: configText !== null ? sha256Hex(configText) : null },
  })
  writeFileSync(reportFile, report)
  return { code: stop !== undefined ? EXIT_INTERRUPTED : EXIT_OK, report: reportFile, raw: rawFile }
}

function showFile(f: string): string {
  const r = relative(ROOT, resolve(f))
  return r.startsWith('..') || isAbsolute(r) ? f : r
}

// ─── Replaying ────────────────────────────────────────────────────────────────

export function readRaw(text: string, file: string): RawRow[] {
  const out: RawRow[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      throw new InputError(`${file}:${i + 1}: not JSON`)
    }
    if (!isObject(v) || typeof v.id !== 'string') throw new InputError(`${file}:${i + 1}: not a measurement line`)
    out.push(v as unknown as RawRow)
  })
  return out
}

// ─── Classification and effort ────────────────────────────────────────────────

const rank = (e: Effort): number => EFFORT_SCALE.indexOf(e)

// The classification of a recorded answer with the configuration given now: the
// calibration profile comes from the answer's identity, as in the hook.
export function classify(r: RawRow, cfg: RouterConfig): Classification | string {
  if (r.error !== undefined) return r.error
  if (r.status !== 200 || r.body === undefined) return 'no answer'
  const b: RouterBackend = { url: '', key: '', model: r.model, local: r.local, host: '' }
  const c = parseClassification(cfg, b, 200, JSON.stringify(r.body))
  return c.ok ? c.value : `answer discarded: ${c.error.kind}`
}

interface EffortOutcome { id: string; ideal: Effort; chosen: Effort; reason: string }

export function endToEnd(rows: readonly RouterRow[], cls: ReadonlyMap<string, Classification | string>, cfg: RouterConfig, session: Effort):
  { outcomes: EffortOutcome[]; unanswered: number } {
  const outcomes: EffortOutcome[] = []
  let unanswered = 0
  const model = cfg.only_models[0] ?? ''
  for (const r of rows) {
    const label = r.labels.effort
    if (typeof label !== 'string') continue
    const c = cls.get(r.id)
    if (c === undefined || typeof c === 'string') {
      unanswered++
      continue
    }
    const choice = chooseEffort(c, { model, effort: session }, cfg)
    const ideal = rank(label as Effort) <= rank(session) ? label as Effort : session
    outcomes.push({ id: r.id, ideal, chosen: choice.effort ?? session, reason: choice.reason })
  }
  return { outcomes, unanswered }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const code = (s: string): string => `\`${s}\``
const n2 = (x: number | null): string => (x === null ? '—' : formatNumber(x, 3))
const pct = (a: number, b: number): string => (b === 0 ? '—' : `${a}/${b} (${formatNumber((100 * a) / b, 0)}%)`)

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// The thresholds the configuration applies to a noul, from the adjustments and floors.
function thresholdsOf(cfg: RouterConfig, id: string): number[] {
  const out: number[] = []
  for (const a of [...cfg.adjust, ...cfg.floors]) if (a.if.question === id && a.if.p_gte !== undefined) out.push(a.if.p_gte)
  return out
}

function confusion(pairs: readonly [string, string][], options: readonly string[]): string[] {
  const lines = [`| label \\ answer | ${options.join(' | ')} |`, `|---|${options.map(() => '--:').join('|')}|`]
  for (const y of options) {
    const row = options.map((o) => pairs.filter(([a, b]) => a === y && b === o).length)
    if (row.every((x) => x === 0)) continue
    lines.push(`| ${y} | ${row.map((x) => (x === 0 ? '·' : String(x))).join(' | ')} |`)
  }
  return lines
}

export interface ReportData {
  rows: readonly RouterRow[]
  raw: readonly RawRow[]
  cfg: RouterConfig
  sessions: readonly Effort[]
  date?: string
  interrupted?: string
  dataset: { file: string; sha: string }
  config: { file: string; sha: string | null }
}

export function renderRouterReport(d: ReportData): string {
  const { rows, raw, cfg } = d
  const cls = new Map<string, Classification | string>(raw.map((r) => [r.id, classify(r, cfg)]))
  const answered = [...cls.values()].filter((c): c is Classification => typeof c !== 'string')
  const first = raw.find((r) => r.body !== undefined)
  const body = isObject(first?.body) ? first.body : {}
  const out: string[] = ['# Router measurement', '']
  if (d.interrupted !== undefined) out.push(`**Measurement interrupted: ${d.interrupted}.** The numbers cover the prompts measured so far.`, '')
  const ms = raw.filter((r) => r.status === 200).map((r) => r.ms)
  const late = ms.filter((x) => x > cfg.timeout_ms).length
  out.push(
    ...(d.date !== undefined ? [`- Date: ${d.date}`] : []),
    `- Backend: ${raw[0]?.local === false ? 'remote' : 'local'}, requested model ${code(raw[0]?.model ?? '?')}, declared model ${code(typeof body.model === 'string' ? body.model : '?')}`,
    `- Fingerprint: ${code(isObject(body.x_rizzo) && typeof body.x_rizzo.fingerprint === 'string' ? body.x_rizzo.fingerprint : '?')}`,
    `- Calibration profile: ${answered[0] ? `${code(answered[0].profile)} (${answered[0].calibrated ? 'calibrated' : 'uncalibrated'})` : '—'}`,
    `- Dataset: ${code(d.dataset.file)}, ${rows.length} prompts, sha256 ${code(d.dataset.sha)}`,
    `- Router configuration: ${code(d.config.file)}${d.config.sha !== null ? `, sha256 ${code(d.config.sha)}` : ''}`,
    `- Answers: ${answered.length} of ${raw.length} requests (${raw.length - answered.length} failed or discarded)`,
    `- Latency: first request ${raw[0] ? `${formatNumber(raw[0].ms / 1000, 2)} s` : '—'}, median ${ms.length ? `${formatNumber((quantile(ms, 0.5) ?? 0) / 1000, 2)} s` : '—'}, p95 ${ms.length ? `${formatNumber((quantile(ms, 0.95) ?? 0) / 1000, 2)} s` : '—'}, max ${ms.length ? `${formatNumber(Math.max(...ms) / 1000, 2)} s` : '—'}; ${pct(late, ms.length)} above timeout_ms (${cfg.timeout_ms} ms), which the hook would drop`,
    '',
  )

  // ── per question ──
  out.push('## Questions', '')
  const pairsOf: { r: RouterRow; c: Classification }[] = []
  for (const r of rows) {
    const c = cls.get(r.id)
    if (c !== undefined && typeof c !== 'string') pairsOf.push({ r, c })
  }
  for (const [id, q] of Object.entries(cfg.questions)) {
    const labelled = pairsOf.filter((x) => x.r.labels[id] !== undefined && x.r.labels[id] !== null)
    out.push(`### ${id} (${q.type})`, '')
    if (labelled.length === 0) {
      out.push('No labelled prompt.', '')
      continue
    }
    if (q.type === 'noul') {
      const s: Sample[] = []
      for (const { c, r } of labelled) if (Object.hasOwn(c.p, id)) s.push({ p: c.p[id], y: r.labels[id] === true })
      const m = metrics(s)
      out.push('| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |', '|--:|--:|--:|--:|--:|--:|--:|',
        `| ${m.positives} | ${m.negatives} | ${n2(m.auroc)} | ${n2(m.meanPositives)} | ${n2(m.meanNegatives)} | ${n2(m.bestThreshold)} | ${n2(m.balAccAtBest)} |`, '')
      for (const t of thresholdsOf(cfg, id)) {
        const tp = s.filter((x) => x.y && x.p >= t).length
        const fp = s.filter((x) => !x.y && x.p >= t).length
        out.push(`- At the configured threshold ${formatNumber(t, 2)}: TPR ${pct(tp, m.positives)}, FPR ${pct(fp, m.negatives)}.`)
      }
      out.push('')
    } else if (q.type === 'choice') {
      const options = isObject(q.criteria) ? Object.keys(q.criteria) : []
      const pairs: [string, string][] = []
      const tops: number[] = []
      for (const { c, r } of labelled) {
        const ch = c.choices[id]
        if (!ch) continue
        pairs.push([String(r.labels[id]), ch.option])
        tops.push(ch.p)
      }
      const right = pairs.filter(([a, b]) => a === b).length
      out.push(`Accuracy ${pct(right, pairs.length)}; mean p of the chosen option ${n2(tops.length ? tops.reduce((a, b) => a + b, 0) / tops.length : null)}.`, '')
      if (id === cfg.taskQuestion) {
        const kept = labelled.filter(({ c }) => c.pTask >= cfg.min_top_probability)
        const keptRight = kept.filter(({ c, r }) => c.taskKind === r.labels[id]).length
        out.push(`At min_top_probability ${formatNumber(cfg.min_top_probability, 2)}: ${pct(kept.length, labelled.length)} classified, of which ${pct(keptRight, kept.length)} right.`, '')
      }
      out.push(...confusion(pairs, options), '')
    } else {
      const levels = Array.isArray(q.criteria) ? q.criteria.length : 0
      const pairs: [string, string][] = []
      for (const { c, r } of labelled) if (Object.hasOwn(c.levels, id)) pairs.push([String(r.labels[id]), String(c.levels[id])])
      const right = pairs.filter(([a, b]) => a === b).length
      const near = pairs.filter(([a, b]) => Math.abs(Number(a) - Number(b)) <= 1).length
      out.push(`Accuracy ${pct(right, pairs.length)}; within one level ${pct(near, pairs.length)}.`, '')
      for (const a of cfg.adjust) {
        if (a.if.question !== id || a.if.level_gte === undefined) continue
        const t = a.if.level_gte
        const pos = pairs.filter(([y]) => Number(y) >= t)
        const neg = pairs.filter(([y]) => Number(y) < t)
        out.push(`- Rule level ≥ ${t}: TPR ${pct(pos.filter(([, x]) => Number(x) >= t).length, pos.length)}, FPR ${pct(neg.filter(([, x]) => Number(x) >= t).length, neg.length)}.`, '')
      }
      out.push(...confusion(pairs, Array.from({ length: levels }, (_, k) => String(k))), '')
    }
  }

  // ── end to end ──
  out.push('## Effort, end to end', '',
    'The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.', '')
  for (const session of d.sessions) {
    const { outcomes, unanswered } = endToEnd(rows, cls, cfg, session)
    const under = outcomes.filter((x) => rank(x.chosen) < rank(x.ideal))
    const exact = outcomes.filter((x) => x.chosen === x.ideal)
    const over = outcomes.filter((x) => rank(x.chosen) > rank(x.ideal))
    const lowered = outcomes.filter((x) => x.chosen !== session)
    const saved = outcomes.reduce((a, x) => a + rank(session) - rank(x.chosen), 0)
    const possible = outcomes.reduce((a, x) => a + rank(session) - rank(x.ideal), 0)
    out.push(`### Session at ${session}`, '',
      `- ${outcomes.length} prompts judged${unanswered ? ` (${unanswered} without an answer left out)` : ''}; lowered ${pct(lowered.length, outcomes.length)}.`,
      `- Under ${pct(under.length, outcomes.length)}, exact ${pct(exact.length, outcomes.length)}, over ${pct(over.length, outcomes.length)}.`,
      `- Steps saved ${saved} of the ${possible} the labels allow.`, '')
    const efforts = EFFORT_SCALE.slice(0, rank(session) + 1) as readonly string[]
    out.push(...confusion(outcomes.map((x) => [x.ideal, x.chosen]), efforts).map((l, i) => (i === 0 ? l.replace('label \\ answer', 'ideal \\ chosen') : l)), '')
    if (under.length > 0) {
      out.push('Under the ideal:', '', '| prompt | ideal | chosen | trace |', '|---|---|---|---|')
      for (const x of under) out.push(`| ${x.id} | ${x.ideal} | ${x.chosen} | ${x.reason.replace(/\|/g, '/')} |`)
      out.push('')
    }
    const left = outcomes.filter((x) => x.chosen === session)
    const why = new Map<string, number>()
    for (const x of left) {
      const k = x.reason.startsWith('unchanged (') ? 'rules gave the session effort' : x.reason.replace(/\(.*$/, '').trim()
      why.set(k, (why.get(k) ?? 0) + 1)
    }
    if (left.length > 0) out.push(`Left at ${session}: ${[...why].map(([k, v]) => `${k} ${v}`).join('; ')}.`, '')
  }

  out.push('## Question hashes', '', '| question | sha256 |', '|---|---|')
  for (const [id, h] of Object.entries(questionHashes(cfg))) out.push(`| ${id} | ${code(h)} |`)
  out.push('')
  return out.join('\n')
}

// ─── Command line ─────────────────────────────────────────────────────────────

const HELP = `Usage:
  node scripts/measure-router.ts --out DIR [--dataset FILE] [--url URL] [--model NAME]
    [--config FILE] [--date TEXT] [--timeout-ms N] [--sessions LIST] [--overwrite]
  node scripts/measure-router.ts --replay DIR [--dataset FILE] [--config FILE] [--sessions LIST]

  --out DIR        where to write raw.jsonl and report.md (measuring)
  --replay DIR     recompute the report from DIR/raw.jsonl with --config, no network
  --dataset FILE   labelled prompts (default bench/router-dev.jsonl)
  --url URL        the /v1/systemone backend (default: JEV_HOOKS_URL)
  --model NAME     requested model (default jev-latest)
  --config FILE    a trial router.json, applied as the user layer
  --date TEXT      the date written in the report (default today)
  --timeout-ms N   time limit of one request (default 30000; the hook's is timeout_ms)
  --sessions LIST  session efforts for the end-to-end table (default xhigh,high)
  --overwrite      rewrite a measurement already in DIR

The key is never a flag: JEV_HOOKS_KEY goes only to the origin of JEV_HOOKS_URL.
`

export interface Args {
  mode: 'measure' | 'replay'
  dir: string
  dataset: string
  url?: string
  model?: string
  config?: string
  date: string
  timeoutMs: number
  sessions: Effort[]
  overwrite: boolean
}

export function parseArgs(argv: readonly string[], cwd: string, today: string): Args | 'help' {
  const a: Partial<Args> & { sessions: Effort[] } = {
    dataset: resolve(ROOT, 'bench', 'router-dev.jsonl'), date: today, timeoutMs: 30000, sessions: ['xhigh', 'high'], overwrite: false,
  }
  const path = (v: string): string => (isAbsolute(v) ? v : resolve(cwd, v))
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return 'help'
    if (flag === '--overwrite') {
      a.overwrite = true
      continue
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new InputError(`${flag}: missing value`)
    i++
    switch (flag) {
      case '--out': a.mode = 'measure'; a.dir = path(v); break
      case '--replay': a.mode = 'replay'; a.dir = path(v); break
      case '--dataset': a.dataset = path(v); break
      case '--url': a.url = v; break
      case '--model': a.model = v; break
      case '--config': a.config = path(v); break
      case '--date': a.date = v; break
      case '--timeout-ms': {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 100 || n > 600000) throw new InputError('--timeout-ms: an integer from 100 to 600000')
        a.timeoutMs = n
        break
      }
      case '--sessions': {
        const list = v.split(',').map((s) => s.trim())
        const bad = list.find((s) => !(EFFORT_SCALE as readonly string[]).includes(s))
        if (bad !== undefined || list.length === 0) throw new InputError(`--sessions: levels among ${EFFORT_SCALE.join(', ')}`)
        a.sessions = list as Effort[]
        break
      }
      default: {
        const key = /key|token/i.test(flag) ? ' (the key is not a flag: use JEV_HOOKS_URL + JEV_HOOKS_KEY)' : ''
        throw new InputError(`unknown option: ${flag.slice(0, 40)}${key}`)
      }
    }
  }
  if (a.mode === undefined || a.dir === undefined) throw new InputError('--out DIR or --replay DIR is required')
  return a as Args
}

export async function main(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = {
  out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s),
}): Promise<number> {
  let args: Args | 'help'
  try {
    args = parseArgs(argv, process.cwd(), new Date().toISOString().slice(0, 10))
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`)
    return EXIT_USAGE
  }
  if (args === 'help') {
    io.out(HELP)
    return EXIT_OK
  }
  try {
    if (args.mode === 'replay') {
      const configText = args.config !== undefined ? readText(args.config) : null
      const cfg = routerConfig(configText, args.config ?? 'router.json (plugin)')
      const datasetText = readText(args.dataset)
      const rows = parseRouterDataset(datasetText, args.dataset, cfg)
      const rawFile = join(args.dir, 'raw.jsonl')
      const raw = readRaw(readText(rawFile), rawFile)
      const measured = readMeasuredHashes(join(args.dir, 'report.md'))
      const now = questionHashes(cfg)
      const changed = Object.keys(now).filter((id) => measured[id] !== undefined && measured[id] !== now[id])
      if (changed.length > 0) io.err(`warning: question text changed since the measurement (${changed.join(', ')}): the answers do not hold for today's text\n`)
      io.out(renderRouterReport({
        rows, raw, cfg, sessions: args.sessions,
        dataset: { file: showFile(args.dataset), sha: sha256Hex(datasetText) },
        config: { file: args.config !== undefined ? showFile(args.config) : 'config/router.json (plugin)', sha: configText !== null ? sha256Hex(configText) : null },
      }))
      return EXIT_OK
    }
    const r = await measureRouter({
      out: args.dir, dataset: args.dataset, url: args.url, model: args.model, config: args.config, date: args.date,
      timeoutMs: args.timeoutMs, sessions: args.sessions, overwrite: args.overwrite, progress: (l) => io.err(`${l}\n`),
    })
    io.out(`${r.report}\n${r.raw}\n`)
    return r.code
  } catch (e) {
    if (e instanceof InputError) {
      io.err(`${e.message}\n`)
      return EXIT_USAGE
    }
    throw e
  }
}

// The per-question hashes a report recorded, to warn when a replay uses other texts.
function readMeasuredHashes(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const m of readFileSync(file, 'utf8').matchAll(/^\| ([a-z_]+) \| `([0-9a-f]{64})` \|$/gm)) out[m[1]] = m[2]
  return out
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = await main(process.argv.slice(2))
