// Policy simulator on the bench: replays the answers already measured
// (bench/results/<dir>/raw.jsonl, variant "attuale", that is, the questions of
// checks.json) through the real verdict and escalation code, with the effective
// configuration (plugin, plus the user layer or --config-dir). Whoever changes a
// threshold in policy.json sees right away how many clean diffs end up in each lane or
// go to Claude, without querying the model.
//
// Why it is built this way:
// - the answers are those of the measured backend, already in "yes = problem"
//   polarity and already the maximum across chunks: they are calibrated with the
//   profile the reviewer would choose for that backend (the identity comes from the
//   measurement's report.md) and go through the core's aggregateNoul, decide and
//   escalation, as in review();
// - the detectors run on the diff composed with the same seed as the measurement: the
//   floors (an AKIA… key in src/) are part of the verdict, and apply even without the
//   model;
// - "clean" diffs are those without any true label among the questions that have a
//   rule: there every lane other than MERGE and every escalation is a false alarm;
// - no network, no key, no writes: only reads.
//
// Usage:
//   node scripts/simulate-policy.ts bench/results/2026-09-26-holdout [more dirs]
//     [--config-dir DIR] [--dataset FILE] [--json]
// Docs: bench/MEASUREMENT.md.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateNoul, calibrate, calibrateDerived, consistentHashes, chooseProfile } from '../src/core/calibration.ts'
import type { SentNoul } from '../src/core/calibration.ts'
import { composeConfig, isModelProbability } from '../src/core/config.ts'
import { parseDiff } from '../src/core/diff.ts'
import { escalation } from '../src/core/escalation.ts'
import { formatNumber } from '../src/core/numbers.ts'
import { planChunks } from '../src/core/chunks.ts'
import { valuesFromPaths } from '../src/core/review.ts'
import { detect } from '../src/core/detectors.ts'
import { sha256Hex } from '../src/core/sha256.ts'
import { truncate } from '../src/core/state.ts'
import { wireQuestion, questionHash } from '../src/core/systemone.ts'
import type {
  Checks, ComposedConfig, WireQuestion, ConfigFile, Identity, Policy, Rule, ProfileSelection, CheckValue, EscalationItem,
} from '../src/core/types.ts'
import { decide, evaluateRule } from '../src/core/verdict.ts'
import { userConfigDir, displayPath } from '../src/node/file-config.ts'
import { composeRow, InputError, parseDataset } from './measure-questions.ts'
import type { DatasetRow } from './measure-questions.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Chunks are planned as in the measurement (scripts/measure-questions.ts): with the
// commit hook's limits.
const ORIGIN = 'hook' as const
const VARIANT = 'attuale'
const EXIT_OK = 0
const EXIT_USAGE = 2

// ─── The measurement's report ─────────────────────────────────────────────────

export interface Measurement {
  dir: string
  identity: Identity | null               // null: report without a declared model
  dataset?: { path: string; sha256: string }
  seed: number
  questionHashes: Record<string, string>        // question → sha256 of the measured current variant
}

const captured = (text: string, re: RegExp): string | undefined => re.exec(text)?.[1]

// The header lines of report.md, as measure-questions.ts's renderReport writes them.
export function parseReport(text: string, dir: string): Measurement {
  const host = captured(text, /^- Backend: `([^`]+)`/m) ?? ''
  const model = captured(text, /^- Declared model: `([^`]+)`/m)
  const fingerprint = captured(text, /^- Fingerprint: `([0-9a-f]+)`/m)
  const states = captured(text, /^- probability_status: (.+)$/m)
  const dataset = /^- Dataset: `([^`]+)`, \d+ diffs, sha256 `([0-9a-f]{64})`/m.exec(text)
  const seed = captured(text, /^- Placeholder seed: (\d+)/m)
  const questionHashes: Record<string, string> = {}
  for (const m of text.matchAll(/^\| ([a-z][a-z0-9_]*) \| attuale \(checks\.json\) \| [a-z]+ \| `([0-9a-f]{64})` \|$/gm)) questionHashes[m[1]] = m[2]
  let identity: Identity | null = null
  if (model !== undefined) {
    identity = { host, model, family: fingerprint !== undefined ? 'rizzo' : 'other' }
    if (fingerprint !== undefined) identity.fingerprint = fingerprint
    if (states !== undefined) identity.probabilityStatus = [...states.matchAll(/`([^`]+)`/g)].map((x) => x[1])
  }
  const out: Measurement = { dir, identity, seed: seed === undefined ? 1 : Number(seed), questionHashes }
  if (dataset) out.dataset = { path: dataset[1], sha256: dataset[2] }
  return out
}

// ─── raw.jsonl ─────────────────────────────────────────────────────────────

export interface RecordedAnswer { p: number | null; label: boolean | null; chunks?: number[] }

// diff id → question → answer, only the current variant and the first repeat: it is
// the one the reviewer would have received the first time.
export function parseRaw(text: string, file: string): Map<string, Map<string, RecordedAnswer>> {
  const out = new Map<string, Map<string, RecordedAnswer>>()
  text.split('\n').forEach((line, k) => {
    if (line.trim() === '') return
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      throw new InputError(`${file}:${k + 1}: invalid JSON`)
    }
    const x = r as { id?: unknown; question?: unknown; variant?: unknown; repeat?: unknown; p?: unknown; label?: unknown; chunks?: unknown }
    if (typeof x.id !== 'string' || typeof x.question !== 'string') throw new InputError(`${file}:${k + 1}: "id" and "question" are needed`)
    if (x.variant !== VARIANT || (x.repeat !== undefined && x.repeat !== 1)) return
    const p = typeof x.p === 'number' && Number.isFinite(x.p) ? x.p : null
    const response: RecordedAnswer = { p, label: x.label === true ? true : x.label === false ? false : null }
    if (Array.isArray(x.chunks) && x.chunks.every((y) => typeof y === 'number' && Number.isFinite(y))) response.chunks = x.chunks as number[]
    const perId = out.get(x.id) ?? new Map<string, RecordedAnswer>()
    perId.set(x.question, response)
    out.set(x.id, perId)
  })
  if (out.size === 0) throw new InputError(`${file}: no answer of variant "${VARIANT}"`)
  return out
}

// ─── Effective configuration ──────────────────────────────────────────────────

// Plugin plus user layer (or --config-dir), like the CLI: not the project, the bench is
// not a repo. An invalid user file stops the simulation: silently falling back to the
// defaults would show numbers that are not those of the file just changed.
export function effectiveConfig(o: { root?: string; configDir?: string; env?: NodeJS.ProcessEnv } = {}): ComposedConfig {
  const root = o.root ?? ROOT
  const env = o.env ?? process.env
  const read = (path: string): ConfigFile | undefined =>
    existsSync(path) ? { path: displayPath(path, env), text: readFileSync(path, 'utf8') } : undefined
  const plugin = (n: string): ConfigFile => ({ path: `config/${n}.json`, text: readFileSync(join(root, 'config', `${n}.json`), 'utf8') })
  const userDir = o.configDir ?? userConfigDir(env)
  const user: Record<string, ConfigFile> = {}
  for (const n of ['checks', 'policy', 'calibration']) {
    const f = read(join(userDir, `${n}.json`))
    if (f) user[n] = f
  }
  const r = composeConfig({ plugin: { checks: plugin('checks'), policy: plugin('policy'), calibration: plugin('calibration') }, user, project: {} })
  if (!r.ok) throw new InputError(`invalid plugin configuration: ${r.error.message}`)
  if (r.value.userProblems.length > 0 || r.value.warnings.length > 0) {
    throw new InputError(['invalid user configuration:', ...r.value.warnings.map((w) => `  ${w}`)].join('\n'))
  }
  return r.value
}

// ─── Simulation ───────────────────────────────────────────────────────────────

export interface DiffOutcome {
  id: string
  clean: boolean
  lane: string
  fromFloor: boolean                      // the lane comes from a detector floor
  items: EscalationItem[]
  expectedFromThresholds: boolean              // at least one rule with escalation fires
  fires: boolean[]                       // per rule (in rules), false also when there is no value
  labels: Record<string, boolean | null>
}

export interface SimulatedRule { lane: string; rule: Rule; text: string }

export interface Simulation {
  measurement: Measurement
  config: { sources: Record<string, string>; profile: string; calibrated: boolean }
  warnings: string[]
  rules: SimulatedRule[]
  diffs: DiffOutcome[]
}

const SYMBOL = { gte: '≥', gt: '>', lte: '≤', lt: '<' } as const

function ruleText(lane: string, r: Rule): string {
  const unless = r.unless ? ` unless ${r.unless.map((c) => `${c.check} ${SYMBOL[c.op]} ${formatNumber(c.value, 2)}`).join(' or ')}` : ''
  return `${lane} ${r.check} ${SYMBOL[r.op]} ${formatNumber(r.value, 2)}${unless}${r.action === 'escalation' ? ' → escalation' : ''}`
}

// The questions with a rule: their labels say whether a diff is clean.
function questionsWithRules(p: Policy): Set<string> {
  return new Set(p.lanes.flatMap((c) => c.rules.map((r) => r.check)))
}

// The profile choice as in review(): on the identity of the first answer. Without a
// report, no profile: raw probabilities and the policy's thresholds.
function selectionFor(c: ComposedConfig, id: Identity | null): ProfileSelection {
  if (id) return chooseProfile(c.calibration, id, c.policy.band)
  return { profile: { name: 'none', match: {}, calibrated: false }, mode: 'client', deltaLogit: c.policy.band.delta_logit, notes: [] }
}

// The measured answers as the reviewer would have received them: one SentNoul per
// chunk, calibrated with the chosen profile. raw.jsonl has the maximum across chunks;
// if it also has the p of each chunk and the plan has as many chunks, those are used,
// otherwise a single chunk with all the files (this changes only which files an item
// cites, not the verdict nor whether there is an escalation).
function valuesOf(
  answers: ReadonlyMap<string, RecordedAnswer>, checks: Checks, questions: Readonly<Record<string, WireQuestion>>, s: ProfileSelection,
  chunks: { index: number; files: string[] }[],
): { values: Record<string, CheckValue>; missing: number } {
  const values: Record<string, CheckValue> = {}
  let missing = 0
  const all = [...new Set(chunks.flatMap((x) => x.files))]
  for (const id of checks.order) {
    const def = checks.defs[id]
    const r = answers.get(id)
    if (!r || !isModelProbability(def) || !Object.hasOwn(questions, id)) continue
    if (r.p === null) {
      missing++
      continue
    }
    const w = questions[id]
    const calibrated = (q: number): number => (def.type === 'noul'
      ? (calibrate(id, w, { type: 'noul', noul: q }, s).response as { noul: number }).noul
      : calibrateDerived(id, w, q, s).p)
    const perChunk = def.scope === 'chunk'
    const sent: SentNoul[] = perChunk && r.chunks && r.chunks.length === chunks.length && chunks.length > 1
      ? r.chunks.map((q, k) => ({ chunk: chunks[k].index, files: chunks[k].files, p: calibrated(q), raw: q }))
      : [{ chunk: chunks[0]?.index ?? 0, files: perChunk ? all : [], p: calibrated(r.p), raw: r.p }]
    const v = aggregateNoul(sent, { invert: def.invert, perChunk })
    if (v) values[id] = v
  }
  return { values, missing }
}

export function simulate(o: {
  dir: string; config: ComposedConfig; dataset?: string; root?: string
}): Simulation {
  const root = o.root ?? ROOT
  const c = o.config
  const p = c.policy
  const warnings: string[] = []
  const reportFile = join(o.dir, 'report.md')
  const rawFile = join(o.dir, 'raw.jsonl')
  if (!existsSync(rawFile)) throw new InputError(`${o.dir}: raw.jsonl is missing`)
  const measurement = existsSync(reportFile)
    ? parseReport(readFileSync(reportFile, 'utf8'), o.dir)
    : { dir: o.dir, identity: null, seed: 1, questionHashes: {} }
  if (!existsSync(reportFile)) warnings.push('report.md missing: unknown backend, no calibration profile, seed 1')
  const raw = parseRaw(readFileSync(rawFile, 'utf8'), rawFile)

  const datasetPath = o.dataset ?? (measurement.dataset ? resolve(root, measurement.dataset.path) : undefined)
  if (datasetPath === undefined) throw new InputError(`${o.dir}: the report does not name the dataset, pass --dataset FILE`)
  if (!existsSync(datasetPath)) throw new InputError(`${datasetPath}: dataset not found`)
  const datasetText = readFileSync(datasetPath, 'utf8')
  if (measurement.dataset && sha256Hex(datasetText) !== measurement.dataset.sha256) {
    warnings.push(`${relative(root, datasetPath)} changed after the measurement (different sha256): labels and paths may not match`)
  }
  const rows = parseDataset(datasetText, datasetPath)

  const questions: Record<string, WireQuestion> = {}
  for (const id of c.checks.order) if (c.checks.defs[id].source === 'model') questions[id] = wireQuestion(c.checks.defs[id])
  // a question changed after the measurement has no valid answers: the replay says so
  for (const [id, sha] of Object.entries(measurement.questionHashes)) {
    if (Object.hasOwn(questions, id) && questionHash(questions[id]) !== sha) warnings.push(`${id}: the checks.json question is not the measured one (different sha256): its answers do not apply to today's text`)
  }
  const selection = selectionFor(c, measurement.identity)
  const hashOk = consistentHashes(questions, selection)
  const withRules = questionsWithRules(p)
  const rules: SimulatedRule[] = p.lanes.flatMap((lane) => lane.rules.map((rule) => ({ lane: lane.name, rule, text: ruleText(lane.name, rule) })))

  const outcomes: DiffOutcome[] = []
  const notMeasured: string[] = []
  for (const template of rows) {
    const answers = raw.get(template.id)
    if (!answers) {
      notMeasured.push(template.id)
      continue
    }
    const r: DatasetRow = composeRow(template, measurement.seed)
    // the same steps as review() (and as the measurement's statesOf): empty description
    // = missing, title and description truncated, detectors, then the chunk plan
    const description = r.description === null || r.description.trim() === '' ? null : truncate(r.description, p.state.max_description_chars)
    const meta = { title: truncate(r.title, p.state.max_description_chars), description }
    const d = parseDiff(r.diff, { maxBytes: p.state.max_diff_bytes, maxLineChars: p.state.max_line_chars })
    const det = detect(d, meta, p)
    const plan = planChunks(d, meta, c.checks, p, { maxChunks: p.limits[ORIGIN].max_chunks, tokensPerState: p.state.tokens_per_state }, det.hits)
    const { values, missing } = valuesOf(answers, c.checks, questions, selection, plan.chunks)
    Object.assign(values, valuesFromPaths(c.checks, d.files))
    const partial = { omitted: plan.omitted.length, unreviewable: plan.unreviewable.length, incomplete: missing > 0, truncated: d.truncated }
    const decision = decide(values, p, selection, det.floors, partial, hashOk)
    const items = escalation(values, c.checks, selection, det, plan, p, { hashOk, file: d.files, truncated: d.truncated, incomplete: missing > 0 })
    const labels: Record<string, boolean | null> = {}
    for (const [q, x] of answers) labels[q] = x.label
    const fires = rules.map((x) => evaluateRule(x.rule, values, selection, hashOk)?.fires === true)
    outcomes.push({
      id: template.id,
      clean: ![...withRules].some((q) => labels[q] === true),
      lane: decision.lane.name,
      fromFloor: decision.fired.some((x) => x.source === 'floor' && x.lane === decision.lane.name),
      items,
      expectedFromThresholds: rules.some((x, k) => x.rule.action === 'escalation' && fires[k]),
      fires,
      labels,
    })
  }
  if (notMeasured.length > 0) warnings.push(`${notMeasured.length} dataset diffs without answers in raw.jsonl: excluded`)
  if (outcomes.length === 0) throw new InputError(`${o.dir}: no dataset diff has answers in raw.jsonl`)
  return {
    measurement,
    config: { sources: { ...c.sources }, profile: selection.profile.name, calibrated: selection.profile.calibrated && selection.mode === 'client' },
    warnings,
    rules,
    diffs: outcomes,
  }
}

// ─── Counts and text ──────────────────────────────────────────────────────────

export interface Count { n: number; of: number }
export interface RuleRate { text: string; tp: number; positives: number; fp: number; negatives: number }

export interface Summary {
  clean: number
  withProblem: number
  lanes: { lane: string; clean: Count; withProblem: Count; fromFloor: Count }[]
  escalation: { item: string; clean: Count; withProblem: Count }[]
  fromModel: { clean: Count; expectedClean: Count; withProblem: Count; expected: Count }
  rules: RuleRate[]
}

const REASONS: EscalationItem['reason'][] = ['threshold', 'band', 'disagreement', 'detector', 'coverage']
const fromModel = (v: EscalationItem): boolean => v.reason === 'threshold' || v.reason === 'band'

export function summarize(s: Simulation, lanes: readonly string[]): Summary {
  const clean = s.diffs.filter((d) => d.clean)
  const dirty = s.diffs.filter((d) => !d.clean)
  const count = (xs: readonly DiffOutcome[], f: (d: DiffOutcome) => boolean): Count => ({ n: xs.filter(f).length, of: xs.length })
  const escalation: Summary['escalation'] = [
    { item: 'at least one item', clean: count(clean, (d) => d.items.length > 0), withProblem: count(dirty, (d) => d.items.length > 0) },
  ]
  for (const reason of REASONS) {
    const has = (d: DiffOutcome): boolean => d.items.some((v) => v.reason === reason)
    if (!s.diffs.some(has) && reason !== 'threshold') continue
    escalation.push({ item: reason, clean: count(clean, has), withProblem: count(dirty, has) })
    if (reason !== 'threshold' && reason !== 'band') continue
    const checks = [...new Set(s.diffs.flatMap((d) => d.items.filter((v) => v.reason === reason && v.check !== undefined).map((v) => v.check as string)))]
    for (const id of checks) {
      const on = (d: DiffOutcome): boolean => d.items.some((v) => v.reason === reason && v.check === id)
      escalation.push({ item: `  ${id}`, clean: count(clean, on), withProblem: count(dirty, on) })
    }
  }
  const rules = s.rules.map((r, k): RuleRate => {
    const labeled = s.diffs.filter((d) => typeof d.labels[r.rule.check] === 'boolean')
    const pos = labeled.filter((d) => d.labels[r.rule.check] === true)
    const neg = labeled.filter((d) => d.labels[r.rule.check] === false)
    return { text: r.text, tp: pos.filter((d) => d.fires[k]).length, positives: pos.length, fp: neg.filter((d) => d.fires[k]).length, negatives: neg.length }
  })
  return {
    clean: clean.length,
    withProblem: dirty.length,
    lanes: lanes.map((lane) => ({
      lane,
      clean: count(clean, (d) => d.lane === lane),
      withProblem: count(dirty, (d) => d.lane === lane),
      fromFloor: count(s.diffs, (d) => d.lane === lane && d.fromFloor),
    })),
    escalation,
    fromModel: {
      clean: count(clean, (d) => d.items.some(fromModel)),
      expectedClean: count(clean, (d) => d.expectedFromThresholds),
      withProblem: count(dirty, (d) => d.items.some(fromModel)),
      expected: count(dirty, (d) => d.expectedFromThresholds),
    },
    rules,
  }
}

function fraction(c: Count): string {
  const pct = c.of === 0 ? '—' : `${formatNumber((100 * c.n) / c.of, 1)}%`
  return `${`${c.n}/${c.of}`.padStart(7)} ${pct.padStart(6)}`
}

function rate(n: number, of: number): string {
  return of === 0 ? '—' : `${formatNumber(n / of, 3)} (${n}/${of})`
}

const pad = (x: string, n: number): string => (x.length >= n ? x : x + ' '.repeat(n - x.length))

export function renderSimulation(s: Simulation, r: Summary, root: string = ROOT): string {
  const m = s.measurement
  const lines: string[] = [`simulate-policy · ${relative(root, resolve(m.dir)) || m.dir}`]
  const id = m.identity
  const backend = id ? `backend ${id.model}${id.fingerprint ? ` · fingerprint ${id.fingerprint.slice(0, 12)}…` : ''}` : 'unknown backend'
  lines.push(`${backend} · profile ${s.config.profile} (${s.config.calibrated ? 'calibrated' : 'uncalibrated'})`)
  if (m.dataset) lines.push(`dataset ${m.dataset.path} · seed ${m.seed}`)
  lines.push(`config: ${Object.entries(s.config.sources).map(([k, f]) => `${k}.json = ${f}`).join('; ')}`)
  lines.push(`diffs: ${s.diffs.length} · clean ${r.clean} (no true label among the questions with rules) · with at least one problem ${r.withProblem}`)
  for (const w of s.warnings) lines.push(`warning: ${w}`)

  const w = Math.max(18, ...r.lanes.map((x) => x.lane.length + 2), ...r.escalation.map((x) => x.item.length + 2))
  lines.push('', `${pad('lane', w)}${'clean'.padStart(14)}  ${'with problem'.padStart(14)}  of which from a floor`)
  for (const c of r.lanes) lines.push(`${pad(c.lane, w)}${fraction(c.clean)}  ${fraction(c.withProblem)}  ${c.fromFloor.n}`)
  lines.push('', `${pad('escalation', w)}${'clean'.padStart(14)}  ${'with problem'.padStart(14)}`)
  for (const e of r.escalation) lines.push(`${pad(e.item, w)}${fraction(e.clean)}  ${fraction(e.withProblem)}`)
  const dm = r.fromModel
  lines.push(`from the model (threshold or band): clean ${dm.clean.n}/${dm.clean.of}, expected from the thresholds ${dm.expectedClean.n}/${dm.expectedClean.of}; `
    + `with problem ${dm.withProblem.n}/${dm.withProblem.of}, expected ${dm.expected.n}/${dm.expected.of}`)

  const wr = Math.max(...r.rules.map((x) => x.text.length), 10) + 2
  lines.push('', `${pad('rule', wr)}${pad('tpr', 16)}fpr`)
  for (const x of r.rules) lines.push(`${pad(x.text, wr)}${pad(rate(x.tp, x.positives), 16)}${rate(x.fp, x.negatives)}`)
  return `${lines.join('\n')}\n`
}

// ─── Command line ─────────────────────────────────────────────────────────────

const HELP = `Usage: node scripts/simulate-policy.ts DIR [DIR…] [options]

  DIR                 a bench measurement: bench/results/<date>[-name], with raw.jsonl and report.md
  --config-dir DIR    policy.json, checks.json and calibration.json from DIR instead of the user layer
  --dataset FILE      the measurement's dataset, if the report does not name it or it was moved
  --json              the summary as JSON

Replays the measured answers (current variant) through the core's verdict and escalation,
with the effective configuration (plugin + user or --config-dir), and prints per lane
and per escalation the counts on clean diffs and on diffs with at least one problem,
plus TPR and FPR per rule. No network. Docs: bench/MEASUREMENT.md.`

export interface SimulateOptions { dirs: string[]; configDir?: string; dataset?: string; json: boolean }

export function parseArgs(argv: readonly string[], cwd: string): SimulateOptions | 'help' {
  const o: SimulateOptions = { dirs: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return 'help'
    if (a === '--json') {
      o.json = true
      continue
    }
    if (a === '--config-dir' || a === '--dataset') {
      const v = argv[++i]
      if (v === undefined) throw new InputError(`missing value for ${a}`)
      if (a === '--config-dir') o.configDir = resolve(cwd, v)
      else o.dataset = resolve(cwd, v)
      continue
    }
    if (a.startsWith('-')) throw new InputError(`unknown option: ${a}`)
    o.dirs.push(resolve(cwd, a))
  }
  if (o.dirs.length === 0) throw new InputError('missing the directory of a measurement (bench/results/…)')
  if (o.dataset !== undefined && o.dirs.length > 1) throw new InputError('--dataset applies to a single directory')
  return o
}

export function main(
  argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
  write: (s: string) => void = (s) => process.stdout.write(s), error: (s: string) => void = (s) => process.stderr.write(s),
): number {
  try {
    const o = parseArgs(argv, process.cwd())
    if (o === 'help') {
      write(`${HELP}\n`)
      return EXIT_OK
    }
    const c = effectiveConfig({ configDir: o.configDir, env })
    const lanes = c.policy.lanes.map((x) => x.name)
    const outputs = o.dirs.map((dir) => {
      const s = simulate({ dir, config: c, dataset: o.dataset })
      return { s, r: summarize(s, lanes) }
    })
    if (o.json) write(`${JSON.stringify(outputs.map(({ s, r }) => ({ dir: relative(ROOT, s.measurement.dir), config: s.config, warnings: s.warnings, ...r })), null, 2)}\n`)
    else write(outputs.map(({ s, r }) => renderSimulation(s, r)).join('\n'))
    return EXIT_OK
  } catch (err) {
    if (err instanceof InputError) {
      error(`simulate-policy: ${err.message}\n`)
      return EXIT_USAGE
    }
    throw err
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
