// Fits the per-question Platt scaling of a backend from the bench measurements already
// taken, with no request to the backend. One measurement fits (the dev set's), another
// one checks (the holdout set's, never used by the fit):
//
//   p' = σ(a · logit(p) + b)
//
// on the p of the sent question (yes = problem, as raw.jsonl records it), for every
// probability of config/checks.json (the nouls and the choices with a value) whose
// measured text is today's (the sha256 in both report.md files).
//
// Why it is built this way:
// - Platt's smoothed targets, (N₊ + 1)/(N₊ + 2) for a positive and 1/(N₋ + 2) for a
//   negative, instead of 1 and 0: with a question that separates the dev set almost
//   perfectly the plain fit runs a to infinity, and the targets keep it finite;
// - Newton's method on the two parameters, with a backtracking step: deterministic, and
//   a handful of iterations;
// - a question is adopted only if a > 0 (the answers order the labels the right way:
//   a Platt with a ≤ 0 would turn the scale round or flatten it) and the log-loss on
//   the check set goes down. Otherwise its entry keeps only the sha256, and its values
//   stay as they come;
// - a and b are rounded to four decimals before the metrics are computed, so the
//   report describes the entry that is written;
// - errors in the entry is the size of the smaller class on the fit set, the number a
//   fit of two parameters rests on (about ten per parameter is the usual minimum);
// - one answer per diff: the first repeat, as the policy simulator replays it;
// - the check set must be another measurement of another dataset: a fit checked on the
//   diffs it was fitted on would always look adopted.
//
// It does not choose thresholds: on a calibrated question the reviewer keeps deciding on
// the raw value against the policy's threshold (src/core/calibration.ts, decidesOnRaw),
// so the verdicts stay those of the raw scale, and shows the threshold moved through the
// same function. The report shows where the thresholds land. The probabilities are calibrated to the bench's mix of problems,
// which has more positives than real commits: on a real commit they read high.
//
// Usage:
//   node scripts/fit-calibration.ts --fit DIR --check DIR --out DIR [--date TEXT] [--overwrite]
// DIR are bench/results/<dir> measurements (raw.jsonl and report.md). --out gets
// report.md and profile.json (the per_question block to put in config/calibration.json).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaledThreshold, withThresholdScales } from '../src/core/calibration.ts'
import { validateChecks, validatePolicy } from '../src/core/config.ts'
import { clippedLogit, formatNumber, sigmoid } from '../src/core/numbers.ts'
import { questionHash, wireQuestion } from '../src/core/systemone.ts'
import type { CalibrationEntry, Checks, Policy, ProfileSelection, WireQuestion } from '../src/core/types.ts'
import { auroc, InputError } from './measure-questions.ts'
import type { Sample } from './measure-questions.ts'
import { parseReport } from './simulate-policy.ts'
import type { Measurement } from './simulate-policy.ts'

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const EXIT_OK = 0
const EXIT_USAGE = 2
const VARIANT = 'attuale'
const DECIMALS = 4
const MAX_ITERATIONS = 100
const ECE_BINS = 10

const HELP = `usage: node scripts/fit-calibration.ts --fit DIR --check DIR --out DIR [--date TEXT] [--overwrite]

Fits a Platt scaling per question on the measurement in --fit and checks it on the one
in --check (bench/results/<dir>, raw.jsonl and report.md). Writes report.md and
profile.json (the per_question block for config/calibration.json) into --out.
No network, no key.`

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface Measured { measurement: Measurement; samples: Map<string, Sample[]> }

// The answers of the current variant, per question: the p of the sent question and its label.
export function readMeasured(dir: string): Measured {
  const raw = join(dir, 'raw.jsonl')
  const report = join(dir, 'report.md')
  if (!existsSync(raw) || !existsSync(report)) throw new InputError(`${dir}: raw.jsonl and report.md are needed`)
  const measurement = parseReport(readFileSync(report, 'utf8'), dir)
  const samples = new Map<string, Sample[]>()
  readFileSync(raw, 'utf8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    let r: { question?: unknown; variant?: unknown; p?: unknown; label?: unknown; repeat?: unknown }
    try {
      r = JSON.parse(line)
    } catch {
      throw new InputError(`${raw}:${i + 1}: invalid JSON`)
    }
    if (r.variant !== VARIANT || typeof r.question !== 'string') return
    if (r.repeat !== undefined && r.repeat !== 1) return
    if (typeof r.p !== 'number' || !Number.isFinite(r.p) || typeof r.label !== 'boolean') return
    const list = samples.get(r.question) ?? []
    list.push({ p: r.p, y: r.label })
    samples.set(r.question, list)
  })
  return { measurement, samples }
}

// ─── The fit ──────────────────────────────────────────────────────────────────

export interface Platt { a: number; b: number }

const targetsOf = (s: readonly Sample[]): number[] => {
  const pos = s.filter((x) => x.y).length
  const neg = s.length - pos
  return s.map((x) => (x.y ? (pos + 1) / (pos + 2) : 1 / (neg + 2)))
}

// Cross-entropy of the Platt against the smoothed targets: what Newton minimizes.
function objective(x: readonly number[], t: readonly number[], f: Platt): number {
  let sum = 0
  for (let i = 0; i < x.length; i++) {
    const z = f.a * x[i] + f.b
    // log(1 + e^z) − t·z, written to stay finite for large |z|
    sum += (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - t[i] * z
  }
  return sum
}

export function fitPlatt(s: readonly Sample[]): Platt {
  const pos = s.filter((x) => x.y).length
  const neg = s.length - pos
  if (pos === 0 || neg === 0) throw new InputError('a fit needs both labels')
  const x = s.map((v) => clippedLogit(v.p))
  const t = targetsOf(s)
  // Platt's start: no slope, the prior as intercept
  let f: Platt = { a: 0, b: Math.log((pos + 1) / (neg + 1)) }
  let value = objective(x, t, f)
  for (let k = 0; k < MAX_ITERATIONS; k++) {
    let ga = 0, gb = 0, haa = 1e-9, hab = 0, hbb = 1e-9
    for (let i = 0; i < x.length; i++) {
      const q = sigmoid(f.a * x[i] + f.b)
      const d = q - t[i]
      const w = q * (1 - q)
      ga += d * x[i]
      gb += d
      haa += w * x[i] * x[i]
      hab += w * x[i]
      hbb += w
    }
    const det = haa * hbb - hab * hab
    if (!(det > 0)) break
    const da = -(hbb * ga - hab * gb) / det
    const db = -(haa * gb - hab * ga) / det
    let step = 1
    let next: Platt = { a: f.a + da, b: f.b + db }
    let nextValue = objective(x, t, next)
    while (nextValue > value && step > 1e-8) {
      step /= 2
      next = { a: f.a + step * da, b: f.b + step * db }
      nextValue = objective(x, t, next)
    }
    if (nextValue > value) break
    const done = Math.abs(value - nextValue) < 1e-12 * Math.max(1, Math.abs(value))
    f = next
    value = nextValue
    if (done) break
  }
  return f
}

const round = (v: number): number => Number(v.toFixed(DECIMALS)) + 0

export const applyPlatt = (p: number, f: Platt): number => sigmoid(f.a * clippedLogit(p) + f.b)

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function logLoss(s: readonly Sample[], map: (p: number) => number = (p) => p): number {
  const eps = 1e-15
  let sum = 0
  for (const v of s) {
    const q = Math.min(1 - eps, Math.max(eps, map(v.p)))
    sum -= v.y ? Math.log(q) : Math.log(1 - q)
  }
  return sum / s.length
}

export function brier(s: readonly Sample[], map: (p: number) => number = (p) => p): number {
  return s.reduce((a, v) => a + (map(v.p) - (v.y ? 1 : 0)) ** 2, 0) / s.length
}

// Expected calibration error on ten equal-width bins: the mean gap, weighted by the
// bin's share, between the p it holds and the share of positives in it.
export function ece(s: readonly Sample[], map: (p: number) => number = (p) => p): number {
  const bins = Array.from({ length: ECE_BINS }, () => ({ n: 0, p: 0, y: 0 }))
  for (const v of s) {
    const q = map(v.p)
    const b = bins[Math.min(ECE_BINS - 1, Math.floor(q * ECE_BINS))]
    b.n++
    b.p += q
    b.y += v.y ? 1 : 0
  }
  return bins.reduce((a, b) => a + (b.n === 0 ? 0 : Math.abs(b.p - b.y) / s.length), 0)
}

export interface SetMetrics { n: number; positives: number; logLoss: [number, number]; brier: [number, number]; ece: [number, number]; auroc: number | null }

function setMetrics(s: readonly Sample[], f: Platt): SetMetrics {
  const map = (p: number): number => applyPlatt(p, f)
  return {
    n: s.length,
    positives: s.filter((x) => x.y).length,
    logLoss: [logLoss(s), logLoss(s, map)],
    brier: [brier(s), brier(s, map)],
    ece: [ece(s), ece(s, map)],
    auroc: auroc(s),
  }
}

// ─── Per question ─────────────────────────────────────────────────────────────

export interface QuestionFit {
  id: string
  sha256: string
  platt?: Platt
  fit?: SetMetrics
  check?: SetMetrics
  adopted: boolean
  reason: string
}

// The probabilities the reviewer compares: nouls and choices with a value, asked of the
// model, with labels of their own (a second reading shares another question's).
export function fittableQuestions(checks: Checks): string[] {
  return checks.order.filter((id) => {
    const d = checks.defs[id]
    return d.source === 'model' && (d.type === 'noul' || (d.type === 'choice' && d.value !== undefined)) && d.bench_labels === undefined
  })
}

export function fitQuestions(checks: Checks, fit: Measured, check: Measured): QuestionFit[] {
  return fittableQuestions(checks).map((id): QuestionFit => {
    const w: WireQuestion = wireQuestion(checks.defs[id])
    const sha256 = questionHash(w)
    for (const [name, m] of [['fit', fit], ['check', check]] as const) {
      const measured = m.measurement.questionHashes[id]
      if (measured === undefined) return { id, sha256, adopted: false, reason: `not measured in the ${name} set` }
      if (measured !== sha256) return { id, sha256, adopted: false, reason: `the ${name} set measured another text (sha256 ${measured.slice(0, 12)}…)` }
    }
    const sf = fit.samples.get(id) ?? []
    const sc = check.samples.get(id) ?? []
    const posF = sf.filter((x) => x.y).length
    if (posF === 0 || posF === sf.length) return { id, sha256, adopted: false, reason: 'the fit set has a single label' }
    if (sc.length === 0) return { id, sha256, adopted: false, reason: 'no answer in the check set' }
    const raw = fitPlatt(sf)
    const platt = { a: round(raw.a), b: round(raw.b) }
    const f = setMetrics(sf, platt)
    const c = setMetrics(sc, platt)
    let reason = 'adopted: the log-loss goes down on the check set'
    let adopted = true
    if (!(platt.a > 0)) {
      adopted = false
      reason = `a = ${formatNumber(platt.a, DECIMALS)}: the answers do not order the labels`
    } else if (!(c.logLoss[1] < c.logLoss[0])) {
      adopted = false
      reason = 'the log-loss does not go down on the check set'
    }
    return { id, sha256, platt, fit: f, check: c, adopted, reason }
  })
}

export function perQuestion(fits: readonly QuestionFit[]): Record<string, CalibrationEntry> {
  const out: Record<string, CalibrationEntry> = {}
  for (const q of fits) {
    const e: CalibrationEntry = { sha256: q.sha256 }
    if (q.adopted && q.platt && q.fit) {
      e.a = q.platt.a
      e.b = q.platt.b
      e.n = q.fit.n
      e.errors = Math.min(q.fit.positives, q.fit.n - q.fit.positives)
    }
    out[q.id] = e
  }
  return out
}

// Where each rule of the policy lands once its check is calibrated.
export function scaledRules(checks: Checks, policy: Policy, entries: Record<string, CalibrationEntry>):
  { lane: string; check: string; op: string; raw: number; scaled: number }[] {
  const questions: Record<string, WireQuestion> = {}
  for (const id of Object.keys(entries)) if (Object.hasOwn(checks.defs, id)) questions[id] = wireQuestion(checks.defs[id])
  const s: ProfileSelection = withThresholdScales(
    { profile: { name: 'fit', match: {}, calibrated: true, per_question: entries }, mode: 'client', deltaLogit: 0, notes: [] }, questions, checks)
  const out: { lane: string; check: string; op: string; raw: number; scaled: number }[] = []
  for (const lane of policy.lanes) {
    for (const r of lane.rules) {
      if (!s.scales || !Object.hasOwn(s.scales, r.check)) continue
      out.push({ lane: lane.name, check: r.check, op: r.op, raw: r.value, scaled: scaledThreshold(r.check, r.value, s) })
    }
  }
  return out
}

// ─── Report ───────────────────────────────────────────────────────────────────

const OPS: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<' }
const n2 = (v: number): string => formatNumber(v, 3)
const pair = (x: [number, number]): string => `${n2(x[0])} → ${n2(x[1])}`

export function renderReport(o: {
  date: string; fitDir: string; checkDir: string; fit: Measured; fits: QuestionFit[]
  rules: ReturnType<typeof scaledRules>
}): string {
  const fp = o.fit.measurement.identity?.fingerprint
  const lines = [
    `# Calibration fit (${o.date})`,
    '',
    `- Fit set: \`${o.fitDir}\``,
    `- Check set: \`${o.checkDir}\` (never used by the fit)`,
    `- Backend fingerprint: ${fp ? `\`${fp}\`` : 'not declared'}`,
    '- Method: Platt scaling per question, p\' = σ(a · logit(p) + b), on the p of the sent question, with Platt\'s smoothed targets; adopted when a > 0 and the check set\'s log-loss goes down',
    '',
    'Values are raw → calibrated. Lower is better for log-loss, Brier and ECE; AUROC does not change with calibration.',
    '',
    '| question | a | b | fit n (pos.) | check n (pos.) | log-loss fit | log-loss check | Brier check | ECE check | AUROC check | decision |',
    '|---|--:|--:|--:|--:|---|---|---|---|--:|---|',
  ]
  for (const q of o.fits) {
    if (!q.platt || !q.fit || !q.check) {
      lines.push(`| ${q.id} | | | | | | | | | | kept as it comes: ${q.reason} |`)
      continue
    }
    lines.push(`| ${q.id} | ${formatNumber(q.platt.a, DECIMALS)} | ${formatNumber(q.platt.b, DECIMALS)} | ${q.fit.n} (${q.fit.positives}) | ${q.check.n} (${q.check.positives}) | ${pair(q.fit.logLoss)} | ${pair(q.check.logLoss)} | ${pair(q.check.brier)} | ${pair(q.check.ece)} | ${q.check.auroc === null ? '—' : n2(q.check.auroc)} | ${q.adopted ? 'adopted' : `kept as it comes: ${q.reason}`} |`)
  }
  lines.push('', '## Thresholds on the calibrated scale', '',
    'On a calibrated question the reviewer still decides on the raw value against the policy\'s threshold, so every verdict stays as on the raw scale; it shows the threshold moved through the fit, next to the calibrated value.',
    '', '| lane | rule | raw | calibrated |', '|---|---|--:|--:|')
  for (const r of o.rules) lines.push(`| ${r.lane} | ${r.check} ${OPS[r.op] ?? r.op} | ${formatNumber(r.raw, 2)} | ${formatNumber(r.scaled, 3)} |`)
  if (o.rules.length === 0) lines.push('| — | no rule on an adopted question | | |')
  const fitPos = o.fits.reduce((a, q) => a + (q.fit?.positives ?? 0), 0)
  const fitN = o.fits.reduce((a, q) => a + (q.fit?.n ?? 0), 0)
  lines.push('', '## Reading it', '',
    `The fit set has ${fitPos} positives in ${fitN} answers (${formatNumber(fitN === 0 ? 0 : (100 * fitPos) / fitN, 1)}%). The calibrated p is right for a mix of problems like the bench's; real commits have fewer, so on them it reads high.`,
    '')
  return lines.join('\n')
}

// ─── Command line ─────────────────────────────────────────────────────────────

export interface FitOptions { fit: string; check: string; out: string; date: string; overwrite: boolean }

export function parseArgs(argv: readonly string[], cwd: string, today: string): FitOptions | 'help' {
  const o: Partial<FitOptions> = { date: today, overwrite: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return 'help'
    if (a === '--overwrite') {
      o.overwrite = true
      continue
    }
    if (a === '--fit' || a === '--check' || a === '--out' || a === '--date') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new InputError(`missing value for ${a}`)
      if (a === '--date') o.date = v
      else o[a.slice(2) as 'fit' | 'check' | 'out'] = resolve(cwd, v)
      continue
    }
    throw new InputError(`unknown argument: ${a}`)
  }
  for (const k of ['fit', 'check', 'out'] as const) if (o[k] === undefined) throw new InputError(`missing --${k}`)
  return o as FitOptions
}

export function run(o: FitOptions, root: string = ROOT): { report: string; profile: string } {
  const checksJson = JSON.parse(readFileSync(join(root, 'config', 'checks.json'), 'utf8'))
  const checksResult = validateChecks(checksJson, 'checks.json')
  if (!checksResult.ok) throw new InputError(checksResult.error.message)
  const policyResult = validatePolicy(JSON.parse(readFileSync(join(root, 'config', 'policy.json'), 'utf8')), checksResult.value, 'policy.json')
  if (!policyResult.ok) throw new InputError(policyResult.error.message)
  const fit = readMeasured(o.fit)
  const check = readMeasured(o.check)
  const a = fit.measurement.identity?.fingerprint
  const b = check.measurement.identity?.fingerprint
  if (a !== b) throw new InputError(`the two measurements come from different backends (fingerprint ${a ?? 'none'} and ${b ?? 'none'})`)
  if (resolve(o.fit) === resolve(o.check)) throw new InputError('the check set is the fit set: give the measurement of another dataset')
  const df = fit.measurement.dataset?.sha256
  if (df !== undefined && df === check.measurement.dataset?.sha256) throw new InputError('the check set measures the same dataset as the fit set')
  const fits = fitQuestions(checksResult.value, fit, check)
  const entries = perQuestion(fits)
  const rules = scaledRules(checksResult.value, policyResult.value, Object.fromEntries(Object.entries(entries).filter(([, e]) => e.a !== undefined)))
  const report = renderReport({ date: o.date, fitDir: relative(root, o.fit) || o.fit, checkDir: relative(root, o.check) || o.check, fit, fits, rules })
  const profile = `${JSON.stringify({ per_question: entries }, null, 2)}\n`
  return { report, profile }
}

export function main(argv: readonly string[], write: (s: string) => void = (s) => process.stdout.write(s),
  error: (s: string) => void = (s) => process.stderr.write(s)): number {
  try {
    const o = parseArgs(argv, process.cwd(), new Date().toISOString().slice(0, 10))
    if (o === 'help') {
      write(`${HELP}\n`)
      return EXIT_OK
    }
    const reportPath = join(o.out, 'report.md')
    if (!o.overwrite && existsSync(reportPath)) throw new InputError(`${reportPath} already exists: --overwrite to replace it`)
    const r = run(o)
    mkdirSync(o.out, { recursive: true })
    writeFileSync(reportPath, r.report)
    writeFileSync(join(o.out, 'profile.json'), r.profile)
    write(`${reportPath}\n${join(o.out, 'profile.json')}\n`)
    return EXIT_OK
  } catch (err) {
    if (err instanceof InputError) {
      error(`fit-calibration: ${err.message}\n`)
      return EXIT_USAGE
    }
    throw err
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
