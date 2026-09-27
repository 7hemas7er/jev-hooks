// Question measurement on the bench (a small evaluation protocol): for each question
// several texts (variants) are tried, and for each one we measure how well the model's
// p separates the diffs with the problem from those without. It is for choosing the
// text of checks.json with numbers, not by eye: the first probe on the Spark showed
// questions that answer "yes" to almost everything (injection_risk, breaks_api).
//
// Why it is built this way:
// - the state is built with the same functions as the reviewer (parseDiff, detect,
//   planChunks: the chunk state for chunk questions, the global state for global
//   ones) and with the plugin configuration: the question is measured in the form in
//   which the plugin really sends it;
// - one request per state with all the variants as questions: rizzo computes the
//   state's prefix once, and each question is a prompt of its own that the id does not
//   enter, so the variants do not influence each other and cost little. Beyond 64
//   questions (the limit shared by Jev and rizzo) it is split into several requests on
//   the same state;
// - the dataset's secrets and injection phrases are {{SEGRETO:type}} placeholders,
//   composed here at runtime with one seed per row: no realistic value enters the
//   repo, and two runs send the same states;
// - the outputs contain only ids, names, numbers and hashes: never diff lines, never
//   the composed values, never the key.
//
// Usage (on the Spark too, Node >= 22.18 without a build):
//   node scripts/measure-questions.ts --out DIR [--dataset bench/dev.jsonl]
//     [--variants bench/variants.json] [--url http://127.0.0.1:8017] [--model jev-latest]
//     [--repeats N] [--date YYYY-MM-DD] [--seed N] [--timeout-ms N] [--overwrite]
// Docs: bench/MEASUREMENT.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prng } from '../src/core/random.ts'
import { composeConfig, questionProblems } from '../src/core/config.ts'
import { matchesAny, parseDiff } from '../src/core/diff.ts'
import { isObject, formatProblem } from '../src/core/json.ts'
import { clippedLogit, formatNumber, sigmoid } from '../src/core/numbers.ts'
import { planChunks } from '../src/core/chunks.ts'
import { redactForBackend } from '../src/core/redaction.ts'
import { configHashes } from '../src/core/review.ts'
import { detect } from '../src/core/detectors.ts'
import { sha256Hex } from '../src/core/sha256.ts'
import { truncate } from '../src/core/state.ts'
import { ask, wireQuestion, questionHash, identityOf } from '../src/core/systemone.ts'
import { LIMITS } from '../src/core/types.ts'
import type {
  Backend, Checks, ReviewConfig, WireQuestion, ConfigFile, Identity, Clock, Origin, Answer, Transport,
} from '../src/core/types.ts'
import { backendFrom, backendSources } from '../src/node/run.ts'
import { nodeClock, nodeTransport } from '../src/node/transport.ts'
import {
  randomChars, awsKey, stripeLiveKey, stripeTestKey, injectionPhrase, generator, highEntropyValue,
} from '../tests/helpers/fake-secrets.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Chunks are planned with the commit hook's limits: it is the entry point that matters
// most, and on the bench's (small) diffs the limits of the origins do not differ.
const ORIGIN: Origin = 'hook'

// After this many failed requests in a row the backend is not answering: going on would
// only make the wait longer (with rizzo abandoned requests stay in the queue).
const MAX_CONSECUTIVE_FAILURES = 3

// Errors about the backend or the configuration, not the single request: the other
// requests would go the same way.
const FATAL_ERRORS = new Set(['auth', 'config', 'not_configured', 'validation', 'network', 'backend_changed'])

const EXIT_OK = 0
const EXIT_INTERRUPTED = 1
const EXIT_USAGE = 2

export class InputError extends Error {}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Scope = 'chunk' | 'global'

// How the p that the "yes = problem" label is true is derived from the answer.
export type Readout =
  | { kind: 'p'; text: string }                              // noul: P(yes)
  | { kind: 'inverse'; text: string }                        // noul in inverse polarity: 1 − P(yes)
  | { kind: 'one_minus'; option: string; text: string }      // choice or score: 1 − p(option), for example 1-p(none)
  | { kind: 'option'; option: string; text: string }       // choice or score: p(option)
  | { kind: 'at_least'; level: number; text: string }        // score: P(level ≥ k)

export interface Variant {
  question: string
  name: string
  qid: string                             // id in the request: it does not enter rizzo's prompt
  wire: WireQuestion
  readout: Readout
  fromChecks: boolean
}

// A p derived in the code from variants already asked, as the reviewer would do if
// that form entered checks.json: the maximum of two one-directional questions, the
// logit mean of two option orders, or a variant set to zero when the diff contains a
// test file (the conjunction "behaviour changed and no test" done by the code on the
// paths, with policy.test_paths, instead of by the model).
export type Combination =
  | { name: string; kind: 'max' | 'mean'; variants: string[] }
  | { name: string; kind: 'without_tests'; variant: string }

export interface Question {
  id: string
  scope: Scope
  checksScope?: Scope                     // the checks.json scope, if the question is there
  requiresDescription: boolean
  variants: Variant[]
  pairs: { direct: string; inverse: string }[]
  combinations: Combination[]
}

export interface DatasetRow {
  id: string
  diff: string
  title: string
  description: string | null
  labels: Record<string, boolean | null>
}

export interface Sample { p: number; y: boolean }

export interface Metrics {
  positives: number
  negatives: number
  auroc: number | null
  meanPositives: number | null
  meanNegatives: number | null
  separation: number | null
  brier: number | null
  bestThreshold: number | null           // p ≥ threshold → yes; null if no threshold beats chance
  balAccAtBest: number | null
  balAccAt05: number | null
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)

// AUROC as the Mann-Whitney statistic: the probability that a random positive has a
// higher p than a random negative, with ties counting one half. With the mean ranks of
// the ties it is exact and costs one sort.
export function auroc(c: readonly Sample[]): number | null {
  const pos = c.filter((x) => x.y).length
  const neg = c.length - pos
  if (pos === 0 || neg === 0) return null
  const o = [...c].sort((a, b) => a.p - b.p)
  let rankSum = 0
  for (let i = 0; i < o.length;) {
    let j = i
    while (j + 1 < o.length && o[j + 1].p === o[i].p) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (o[k].y) rankSum += rank
    i = j + 1
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg)
}

// Balanced accuracy of the rule "p ≥ threshold → yes": the mean of sensitivity and
// specificity, which does not reward always answering the larger class.
export function balancedAccuracy(c: readonly Sample[], threshold: number): number | null {
  const pos = c.filter((x) => x.y)
  const neg = c.filter((x) => !x.y)
  if (pos.length === 0 || neg.length === 0) return null
  const tpr = pos.filter((x) => x.p >= threshold).length / pos.length
  const tnr = neg.filter((x) => x.p < threshold).length / neg.length
  return (tpr + tnr) / 2
}

// The threshold with the highest balanced accuracy. Between two consecutive p of the
// sample every threshold classifies the same way: the logit midpoint is reported,
// because rizzo's p are very peaked (0.99 against 0.9999 is a real difference). On a
// tie the threshold closer to 0.5 wins.
function bestThreshold(c: readonly Sample[]): { threshold: number | null; acc: number | null } {
  const P = c.filter((x) => x.y).length
  const N = c.length - P
  if (P === 0 || N === 0) return { threshold: null, acc: null }
  const o = [...c].sort((a, b) => a.p - b.p)
  let best: { threshold: number; acc: number } | null = null
  let posBelow = 0
  let negBelow = 0
  for (let i = 0; i < o.length;) {
    let j = i
    while (j + 1 < o.length && o[j + 1].p === o[i].p) j++
    if (i > 0) {
      // rule: yes from o[i].p up
      const acc = ((P - posBelow) / P + negBelow / N) / 2
      const threshold = sigmoid((clippedLogit(o[i - 1].p) + clippedLogit(o[i].p)) / 2)
      const better = best === null || acc > best.acc + 1e-12
        || (Math.abs(acc - best.acc) <= 1e-12 && Math.abs(clippedLogit(threshold)) < Math.abs(clippedLogit(best.threshold)))
      if (better) best = { threshold, acc }
    }
    for (let k = i; k <= j; k++) {
      if (o[k].y) posBelow++
      else negBelow++
    }
    i = j + 1
  }
  // always yes or always no score 0.5: a threshold that does no better separates nothing
  if (best === null || best.acc <= 0.5 + 1e-12) return { threshold: null, acc: 0.5 }
  return best
}

export function metrics(c: readonly Sample[]): Metrics {
  const pos = c.filter((x) => x.y).map((x) => x.p)
  const neg = c.filter((x) => !x.y).map((x) => x.p)
  const mp = mean(pos)
  const mn = mean(neg)
  const s = bestThreshold(c)
  return {
    positives: pos.length,
    negatives: neg.length,
    auroc: auroc(c),
    meanPositives: mp,
    meanNegatives: mn,
    separation: mp !== null && mn !== null ? mp - mn : null,
    brier: mean(c.map((x) => (x.p - (x.y ? 1 : 0)) ** 2)),
    bestThreshold: s.threshold,
    balAccAtBest: s.acc,
    balAccAt05: balancedAccuracy(c, 0.5),
  }
}

// ─── Reading the answer ───────────────────────────────────────────────────────

// The "yes = problem" p from the backend's answer, and the raw value it comes from.
export function readValue(l: Readout, r: Answer): { p: number; raw: number } | string {
  if (l.kind === 'p' || l.kind === 'inverse') {
    if (r.type !== 'noul') return `answer of type ${r.type}, expected noul`
    return { p: l.kind === 'p' ? r.noul : 1 - r.noul, raw: r.noul }
  }
  if (r.type === 'noul') return 'answer of type noul, expected choice or score'
  if (l.kind === 'at_least') {
    if (r.type !== 'score') return `answer of type ${r.type}, expected score`
    let q = 0
    for (const [k, x] of Object.entries(r.probabilities)) if (Number(k) >= l.level) q += x
    return { p: Math.min(1, q), raw: r.score }
  }
  if (!Object.hasOwn(r.probabilities, l.option)) return `option ${l.option} missing from the answer`
  const q = r.probabilities[l.option]
  return { p: l.kind === 'one_minus' ? 1 - q : q, raw: q }
}

// The options of a choice are the keys of its criteria; those of a score are the
// levels "0", "1"…, as Jev and rizzo index them.
function parseReadout(v: unknown, w: WireQuestion | undefined): Readout | string {
  if (w === undefined) return 'invalid question'
  const options = w.type === 'choice' && isObject(w.criteria)
    ? Object.keys(w.criteria)
    : w.type === 'score' && Array.isArray(w.criteria) ? w.criteria.map((_, i) => String(i)) : []
  if (v === undefined) return w.type === 'noul' ? { kind: 'p', text: 'p' } : `a ${w.type} wants "readout": 1-p(<option>), p(<option>)${w.type === 'score' ? ' or p(>=<level>)' : ''}`
  if (typeof v !== 'string') return '"readout" must be a string'
  if (v === 'p' || v === 'inverse') {
    return w.type === 'noul' ? { kind: v, text: v } : `"${v}" only applies to a noul`
  }
  const cumulative = /^p\(>=(\d+)\)$/.exec(v)
  if (cumulative) {
    if (w.type !== 'score') return `"${v}" only applies to a score`
    const k = Number(cumulative[1])
    if (!options.includes(String(k))) return `level ${k} does not exist: the score has ${options.length} levels, from 0`
    return { kind: 'at_least', level: k, text: v }
  }
  const m = /^(1-)?p\((.+)\)$/.exec(v)
  if (!m) return `unknown readout "${v}": allowed p, inverse, 1-p(<option>), p(<option>), p(>=<level>)`
  if (w.type === 'noul') return `"${v}" only applies to a choice or a score`
  if (!options.includes(m[2])) return `"${m[2]}" is not ${w.type === 'choice' ? "among the choice's options" : 'a level of the score (0, 1, …)'}`
  return m[1] ? { kind: 'one_minus', option: m[2], text: v } : { kind: 'option', option: m[2], text: v }
}

// ─── Variants ─────────────────────────────────────────────────────────────────

const RE_QUESTION_ID = /^[a-z][a-z0-9_]{0,63}$/
const RE_VARIANT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/
const INVERSE_SUFFIX = '_inversa'
const unknownFields = (o: Record<string, unknown>, allowed: readonly string[]): string[] =>
  Object.keys(o).filter((k) => !k.startsWith('_') && !allowed.includes(k))

// A question's "combinations". Each combination names variants of the same question,
// and its name must not be confused with a variant's name in the report.
function parseCombinations(v: unknown, variants: readonly Variant[], where: string, problems: string[]): Combination[] {
  if (v === undefined) return []
  if (!isObject(v)) {
    problems.push(`${where}: "combinations" must be an object { "<name>": … }`)
    return []
  }
  const names = new Set(variants.map((x) => x.name))
  const out: Combination[] = []
  for (const [name, c] of Object.entries(v)) {
    if (name.startsWith('_')) continue
    const here = `${where}.combinations.${name}`
    if (!RE_VARIANT_NAME.test(name)) {
      problems.push(`${here}: invalid name (expected ${RE_VARIANT_NAME.source})`)
      continue
    }
    if (names.has(name)) {
      problems.push(`${here}: a variant with this name already exists`)
      continue
    }
    if (!isObject(c)) {
      problems.push(`${here}: expected an object with "max", "mean" or "variant" and "zero_if_test_file"`)
      continue
    }
    for (const k of unknownFields(c, ['max', 'mean', 'variant', 'zero_if_test_file'])) problems.push(`${here}: unknown field "${k}"`)
    const shapes = ['max', 'mean', 'variant'].filter((k) => c[k] !== undefined)
    if (shapes.length !== 1) {
      problems.push(`${here}: exactly one of "max", "mean" and "variant" is needed`)
      continue
    }
    const quote = (x: unknown): x is string => typeof x === 'string' && names.has(x)
    if (c.variant !== undefined) {
      if (!quote(c.variant)) problems.push(`${here}: "variant" must be the name of one of the question's variants`)
      else if (c.zero_if_test_file !== true) problems.push(`${here}: "variant" needs "zero_if_test_file": true`)
      else out.push({ name, kind: 'without_tests', variant: c.variant })
      continue
    }
    if (c.zero_if_test_file !== undefined) problems.push(`${here}: "zero_if_test_file" only applies with "variant"`)
    const kind = shapes[0] as 'max' | 'mean'
    const list = c[kind]
    if (!Array.isArray(list) || list.length < 2 || !list.every(quote) || new Set(list).size !== list.length) {
      problems.push(`${here}: "${kind}" wants at least two different variant names of the question`)
      continue
    }
    out.push({ name, kind, variants: list })
  }
  return out
}

// Logit mean (clipped at ±36, as in the reviewer): a constant bias towards one letter
// moves the logits of two opposite readouts in opposite directions, and in the mean it
// cancels out. The mean of the p does not, and with rizzo's peaked p it would squash
// everything towards 0.5.
export function logitMean(ps: readonly number[]): number {
  return sigmoid(ps.reduce((s, p) => s + clippedLogit(p), 0) / ps.length)
}

// variants.json: { "<question>": { scope?, requires?, variants: { "<name>": { readout?,
// question? | from_checks?, pair? } }, combinations?: { "<name>": { max | mean: [names] }
// | { variant, zero_if_test_file: true } } } }. Keys that start with "_" are comments.
// Every question goes through the same rules as checks.json (questionProblems): a
// variant that rizzo would reject is found here, not halfway through the measurement.
export function parseVariants(text: string, file: string, checks: Checks): Question[] {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    throw new InputError(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!isObject(j)) throw new InputError(`${file}: expected an object { "<question>": { "variants": … } }`)
  const problems: string[] = []
  const questions: Question[] = []
  for (const [id, v] of Object.entries(j)) {
    if (id.startsWith('_')) continue
    const where = `${file}: ${id}`
    if (!RE_QUESTION_ID.test(id)) {
      problems.push(`${where}: invalid question id (expected ${RE_QUESTION_ID.source})`)
      continue
    }
    if (!isObject(v)) {
      problems.push(`${where}: expected an object with "variants"`)
      continue
    }
    for (const k of unknownFields(v, ['scope', 'requires', 'variants', 'combinations'])) problems.push(`${where}: unknown field "${k}"`)
    const def = Object.hasOwn(checks.defs, id) && checks.defs[id].source === 'model' ? checks.defs[id] : undefined

    let scope: Scope | undefined = def?.scope
    if (v.scope !== undefined) {
      if (v.scope === 'chunk' || v.scope === 'global') scope = v.scope
      else problems.push(`${where}: "scope" must be "chunk" or "global"`)
    } else if (!def) problems.push(`${where}: missing "scope" ("chunk" or "global"): the question is not one of the model questions in checks.json`)

    let requiresDescription = def ? def.requires.includes('description') : false
    if (v.requires !== undefined) {
      if (Array.isArray(v.requires) && v.requires.every((x) => x === 'description')) requiresDescription = v.requires.length > 0
      else problems.push(`${where}: "requires" can only be [] or ["description"]`)
    }

    if (!isObject(v.variants) || Object.keys(v.variants).every((k) => k.startsWith('_'))) {
      problems.push(`${where}: "variants" must be an object with at least one variant`)
      continue
    }
    const variants: Variant[] = []
    const askedPairs = new Map<string, string>()     // inverse → direct written in "pair"
    for (const [name, x] of Object.entries(v.variants)) {
      if (name.startsWith('_')) continue
      const here = `${where}.${name}`
      if (!RE_VARIANT_NAME.test(name)) {
        problems.push(`${here}: invalid variant name (expected ${RE_VARIANT_NAME.source})`)
        continue
      }
      if (!isObject(x)) {
        problems.push(`${here}: expected an object with "question" or "from_checks"`)
        continue
      }
      for (const k of unknownFields(x, ['readout', 'question', 'from_checks', 'pair'])) problems.push(`${here}: unknown field "${k}"`)
      let wire: WireQuestion | undefined
      const fromChecks = x.from_checks === true
      if (x.from_checks !== undefined && typeof x.from_checks !== 'boolean') problems.push(`${here}: "from_checks" must be true or false`)
      if (fromChecks) {
        if (x.question !== undefined) problems.push(`${here}: "from_checks" and "question" together: pick one`)
        else if (!def) problems.push(`${here}: "from_checks", but ${id} is not a model question in checks.json`)
        else wire = wireQuestion(def)
      } else if (x.question === undefined) {
        problems.push(`${here}: missing "question" (or "from_checks": true)`)
      } else {
        const pr = questionProblems(x.question, file, `/${id}/variants/${name}/question`)
        if (pr.length > 0) problems.push(...pr.map(formatProblem))
        else wire = wireQuestion(x.question as WireQuestion)
      }
      if (wire === undefined) continue
      // The current variant is read as the reviewer reads it: a choice with a value in
      // checks.json ("1-p(none)") already has its readout, and a different one would
      // measure something other than what decides the verdict.
      const value = fromChecks && def?.value ? `1-p(${def.value.option})` : undefined
      if (value !== undefined && x.readout !== undefined && x.readout !== value) {
        problems.push(`${here}: "readout" ${JSON.stringify(x.readout)} differs from the checks.json value ("${value}"): the current variant is read as the reviewer reads it`)
        continue
      }
      const readout = parseReadout(x.readout ?? value, wire)
      if (typeof readout === 'string') {
        problems.push(`${here}: ${readout}`)
        continue
      }
      if (x.pair !== undefined) {
        if (readout.kind !== 'inverse') problems.push(`${here}: "pair" only applies to a variant with "readout": "inverse"`)
        else if (typeof x.pair !== 'string') problems.push(`${here}: "pair" must be the name of the direct variant`)
        else askedPairs.set(name, x.pair)
      }
      variants.push({ question: id, name, qid: `${id}__${name}`, wire, readout, fromChecks })
    }

    // Direct + inverse pairs: explicit with "pair", otherwise by name (x and x_inversa).
    // The mean of the two removes the part of "yes" that does not depend on the diff.
    const pairs: Question['pairs'] = []
    for (const inv of variants.filter((x) => x.readout.kind === 'inverse')) {
      const written = askedPairs.get(inv.name)
      const directName = written ?? (inv.name.endsWith(INVERSE_SUFFIX) ? inv.name.slice(0, -INVERSE_SUFFIX.length) : undefined)
      const direct = variants.find((x) => x.name === directName)
      if (direct && direct.readout.kind !== 'inverse') pairs.push({ direct: direct.name, inverse: inv.name })
      else if (written !== undefined) problems.push(`${where}.${inv.name}: "pair" names "${written}", which is not a direct variant of ${id}`)
    }
    const combinations = parseCombinations(v.combinations, variants, where, problems)
    if (scope !== undefined && variants.length > 0) {
      const d: Question = { id, scope, requiresDescription, variants, pairs, combinations }
      if (def) d.checksScope = def.scope
      questions.push(d)
    }
  }
  // "a__b" + "c" and "a" + "b__c" would give the same id in the request
  const qid = new Map<string, string>()
  for (const v of questions.flatMap((d) => d.variants)) {
    const already = qid.get(v.qid)
    if (already !== undefined) problems.push(`${file}: ${v.question}.${v.name} and ${already} give the same request id ${v.qid}: rename one`)
    qid.set(v.qid, `${v.question}.${v.name}`)
  }
  if (problems.length > 0) throw new InputError(['invalid variants:', ...problems.map((p) => `  ${p}`)].join('\n'))
  if (questions.length === 0) throw new InputError(`${file}: no question with variants`)
  return questions
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

function parseLabel(v: unknown): boolean | null | undefined {
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  if (v === null) return null
  return undefined
}

// dev.jsonl: one JSON line per diff, { id, diff, title?, description?, labels }.
// labels: { "<question>": true | false | null }, where true means that the right
// answer, in "yes = problem" polarity, is yes. Extra fields (group, note…) are ignored.
export function parseDataset(text: string, file: string): DatasetRow[] {
  const rows: DatasetRow[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  text.split('\n').forEach((line, k) => {
    const t = line.trim()
    if (t === '') return
    const where = `${file}:${k + 1}`
    let v: unknown
    try {
      v = JSON.parse(t)
    } catch {
      problems.push(`${where}: invalid JSON`)
      return
    }
    if (!isObject(v)) {
      problems.push(`${where}: expected an object`)
      return
    }
    const id = v.id
    if (typeof id !== 'string' || id.trim() === '' || id.length > 200 || /[\u0000-\u001f\u007f`|]/.test(id)) {
      problems.push(`${where}: "id" must be a string of 1 to 200 characters, without control characters, backticks or "|"`)
      return
    }
    if (seen.has(id)) problems.push(`${where}: repeated id "${id}"`)
    seen.add(id)
    const diff = v.diff
    if (typeof diff !== 'string' || diff.trim() === '') problems.push(`${where} (${id}): "diff" must be a non-empty string`)
    const title = v.title ?? ''
    if (typeof title !== 'string') problems.push(`${where} (${id}): "title" must be a string`)
    const description = v.description ?? null
    if (description !== null && typeof description !== 'string') problems.push(`${where} (${id}): "description" must be a string or null`)
    const rawLabels = v.labels ?? {}
    const labels: Record<string, boolean | null> = {}
    if (!isObject(rawLabels)) problems.push(`${where} (${id}): "labels" must be an object { "<question>": true | false }`)
    else {
      for (const [q, x] of Object.entries(rawLabels)) {
        const e = parseLabel(x)
        if (e === undefined) problems.push(`${where} (${id}): invalid label for ${q} (allowed true, false, 1, 0, null)`)
        else labels[q] = e
      }
    }
    if (typeof diff === 'string' && typeof title === 'string' && (description === null || typeof description === 'string')) {
      rows.push({ id, diff, title, description, labels })
    }
  })
  if (problems.length > 0) throw new InputError(['invalid dataset:', ...problems.map((p) => `  ${p}`)].join('\n'))
  if (rows.length === 0) throw new InputError(`${file}: no diffs`)
  return rows
}

// ─── Secret placeholders ──────────────────────────────────────────────────────

// Production prefixes and phrases addressed to the reviewer are composed from pieces
// (in tests/helpers/fake-secrets.ts and here): written out in full in the repo they
// would make the reviewer fire on the repo itself, and GitHub's push protection too.
// The type names (aws_segreta, alta_entropia, iniezione…) are dataset values: the
// placeholders in bench/*.jsonl use them, so they stay as recorded.
const DIGITS = '0123456789'
export const SECRET_TYPES: Readonly<Record<string, (rnd: () => number) => string>> = {
  aws: awsKey,                                                            // AKIA + 16
  aws_segreta: (rnd) => highEntropyValue(40, rnd),
  stripe_live: stripeLiveKey,
  stripe_test: stripeTestKey,
  github: (rnd) => ['gh', 'p_'].join('') + highEntropyValue(36, rnd),
  slack: (rnd) => `${['xo', 'xb'].join('')}-${randomChars(12, rnd, DIGITS)}-${randomChars(12, rnd, DIGITS)}-${highEntropyValue(24, rnd)}`,
  alta_entropia: (rnd) => highEntropyValue(40, rnd),
  iniezione: () => injectionPhrase(),
}

const RE_PLACEHOLDER = /\{\{SEGRETO:([a-z_]+)(?::([A-Za-z0-9_-]{1,32}))?\}\}/g
const RE_LEFTOVER = /\{\{\s*SEGRETO/i

// One seed per row, from the global seed and the id: the values do not depend on the
// order of the rows, and the same row gets the same values on every run.
export function rowSeed(seed: number, id: string): number {
  return Number.parseInt(sha256Hex(`${seed}\u0000${id}`).slice(0, 8), 16)
}

// Replaces the placeholders of a row. The same placeholder (with its discriminator
// too, {{SEGRETO:aws:2}}) gets the same value in the row's diff, title and
// description: a key defined and then used stays the same.
export function composeRow(r: DatasetRow, seed: number): DatasetRow {
  const rnd = generator(rowSeed(seed, r.id))
  const values = new Map<string, string>()
  const replaceTerm = (text: string): string => {
    const out = text.replace(RE_PLACEHOLDER, (all, kind: string) => {
      const composer = Object.hasOwn(SECRET_TYPES, kind) ? SECRET_TYPES[kind] : undefined
      if (!composer) throw new InputError(`${r.id}: unknown secret type "${kind}" (known: ${Object.keys(SECRET_TYPES).join(', ')})`)
      let v = values.get(all)
      if (v === undefined) {
        v = composer(rnd)
        values.set(all, v)
      }
      return v
    })
    if (RE_LEFTOVER.test(out)) throw new InputError(`${r.id}: malformed placeholder (expected {{SEGRETO:type}} or {{SEGRETO:type:n}})`)
    return out
  }
  return {
    ...r,
    diff: replaceTerm(r.diff),
    title: replaceTerm(r.title),
    description: r.description === null ? null : replaceTerm(r.description),
  }
}

// ─── Configuration and state ──────────────────────────────────────────────────

// Only the plugin configuration: no user or project layer, so the measurement is the
// same on every machine and tells what the plugin sends by default.
export function pluginConfig(root: string = ROOT): ReviewConfig {
  const file = (n: string): ConfigFile => ({ path: `config/${n}.json`, text: readFileSync(join(root, 'config', `${n}.json`), 'utf8') })
  const r = composeConfig({ plugin: { checks: file('checks'), policy: file('policy'), calibration: file('calibration') }, user: {}, project: {} })
  if (!r.ok) throw new InputError(`invalid plugin configuration: ${r.error.message}`)
  return { checks: r.value.checks, policy: r.value.policy, calibration: r.value.calibration, maskMap: null, sources: r.value.sources }
}

export interface States {
  chunks: { index: number; text: string }[]
  global: string
  hasDescription: boolean
  hasTestFile: boolean                  // a path of the diff (the old one of a rename too) is in policy.test_paths
  warnings: string[]
}

// The states the reviewer would send for this diff, with the same steps as review()
// in src/core/review.ts (points 1–4): empty description = missing, title and
// description truncated as there, detectors for the file priority, then planChunks().
// tests/bench/measure.test.ts compares these states with those that review() sends.
export function statesOf(r: DatasetRow, c: ReviewConfig): States {
  const p = c.policy
  const description = r.description === null || r.description.trim() === '' ? null : truncate(r.description, p.state.max_description_chars)
  const meta = { title: truncate(r.title, p.state.max_description_chars), description }
  const d = parseDiff(r.diff, { maxBytes: p.state.max_diff_bytes, maxLineChars: p.state.max_line_chars })
  if (d.files.length === 0) throw new InputError(`${r.id}: no file recognized in the diff (expected a git unified diff)`)
  const det = detect(d, meta, { ...p, detectors: p.detectors.filter((x) => !x.fromProject) })
  const plan = planChunks(d, meta, c.checks, p, { maxChunks: p.limits[ORIGIN].max_chunks, tokensPerState: p.state.tokens_per_state }, det.hits)
  const warnings: string[] = []
  if (d.truncated) warnings.push(`${r.id}: diff truncated at ${p.state.max_diff_bytes} bytes`)
  if (plan.omitted.length > 0) warnings.push(`${r.id}: ${plan.omitted.length} ${plan.omitted.length === 1 ? 'file' : 'files'} beyond the chunk limit, not measured`)
  if (plan.unreviewable.length > 0) warnings.push(`${r.id}: ${plan.unreviewable.length} unreviewable files (binary, minified, dist/…), never sent`)
  if (plan.chunks.length === 0) warnings.push(`${r.id}: no file to send, chunk questions are not asked`)
  if (plan.chunks.length > 1) warnings.push(`${r.id}: split into ${plan.chunks.length} chunks; for chunk questions the maximum across chunks counts`)
  const hasTestFile = d.files.some((f) => matchesAny(p.test_paths, f.path) || (f.oldPath !== undefined && matchesAny(p.test_paths, f.oldPath)))
  return {
    chunks: plan.chunks.map((x) => ({ index: x.index, text: x.text })), global: plan.global, hasDescription: description !== null, hasTestFile, warnings,
  }
}

function inGroups<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// ─── Measurement ──────────────────────────────────────────────────────────────

export interface MeasureOptions {
  dataset: string
  variants: string
  url: string
  model: string
  out: string
  repeats: number
  date: string
  seed: number
  timeoutMs: number
  overwrite: boolean
  env?: NodeJS.ProcessEnv            // for the key (JEV_HOOKS_*, TYPESAFE_*); default process.env
  transport?: Transport
  clock?: Clock
  root?: string                          // where config/*.json lives
  log?: (line: string) => void
}

export interface RawRow {
  id: string
  repeat: number
  question: string
  variant: string
  readout: string
  p: number | null
  raw: number | null
  label: boolean | null
  ms: number
  chunks?: number[]
  error?: string
}

interface RequestStat { ms: number; tokens?: number; error?: string }

export interface MeasureResult {
  exitCode: number
  report: string
  raw: string
  rows: RawRow[]
}

interface Collected { chunks: { p: number; raw: number }[]; expected: number; ms: number; error?: string }

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    const code = (e as { code?: unknown }).code
    throw new InputError(`${file}: not readable${typeof code === 'string' ? ` (${code})` : ''}`)
  }
}

export async function measure(o: MeasureOptions): Promise<MeasureResult> {
  const log = o.log ?? ((s: string) => process.stderr.write(`${s}\n`))
  const clock = o.clock ?? nodeClock
  const transport = o.transport ?? nodeTransport()
  const config = pluginConfig(o.root)
  const p = config.policy

  const datasetText = readText(o.dataset)
  const variantsText = readText(o.variants)
  const templates = parseDataset(datasetText, o.dataset)
  const questions = parseVariants(variantsText, o.variants, config.checks)
  const rows = templates.map((r) => composeRow(r, o.seed))
  const states = new Map<string, States>()
  const warnings: string[] = []
  for (const r of rows) {
    const s = statesOf(r, config)
    states.set(r.id, s)
    warnings.push(...s.warnings)
  }
  const notes: string[] = []
  for (const d of questions) {
    const labeled = templates.filter((r) => typeof r.labels[d.id] === 'boolean').length
    if (labeled === 0) notes.push(`${d.id}: no diff in the dataset has the label: measuring, but without metrics`)
    if (d.checksScope !== undefined && d.checksScope !== d.scope) {
      notes.push(`${d.id}: measured with scope ${d.scope}, while checks.json asks it with scope ${d.checksScope}`)
    }
  }

  const b = backendFrom(backendSources('cli', o.env ?? process.env, { explicitUrl: o.url }), o.model, 'cli').backend
  if (Object.hasOwn(b, 'kind')) throw new InputError(`backend: ${(b as { message: string }).message}`)
  const backend = b as Backend

  mkdirSync(o.out, { recursive: true })
  const rawFile = join(o.out, 'raw.jsonl')
  const reportFile = join(o.out, 'report.md')
  if (!o.overwrite && (existsSync(rawFile) || existsSync(reportFile))) {
    throw new InputError(`${o.out} already contains a measurement: choose another directory or use --overwrite`)
  }
  writeFileSync(rawFile, '')

  const network = { ...p.network, timeout_ms: o.timeoutMs }
  const requests: RequestStat[] = []
  const raw: RawRow[] = []
  let first: Identity | undefined
  let firstKey: string | undefined
  let interrupted: string | undefined
  let consecutiveFailures = 0
  let notAsked = 0

  // One request: state + a group of variants. The answers go into the variant's
  // collection; an error marks all the variants of the group.
  const send = async (state: string, group: Variant[], collected: Map<string, Collected>): Promise<void> => {
    const questions: Record<string, WireQuestion> = {}
    for (const v of group) questions[v.qid] = v.wire
    const deadline = clock.now() + 3 * o.timeoutMs + 60_000
    const e = await ask(transport, clock, backend, { state: state, model: backend.model, questions }, network, deadline)
    if (!e.ok) {
      requests.push({ ms: 0, error: `${e.error.kind}: ${e.error.message}` })
      for (const v of group) (collected.get(v.qid) as Collected).error ??= `${e.error.kind}: ${e.error.message}`
      consecutiveFailures++
      if (FATAL_ERRORS.has(e.error.kind)) interrupted = `${e.error.kind}: ${e.error.message}`
      else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) interrupted = `${consecutiveFailures} requests failed in a row (the last: ${e.error.kind}: ${e.error.message})`
      return
    }
    consecutiveFailures = 0
    const { response, discarded, ms } = e.value
    // A measurement mixed across two models compares nothing: as in the reviewer, the
    // backend must stay the same from the first answer to the last.
    const id = identityOf(response, backend)
    const key = id.fingerprint !== undefined ? `fingerprint ${id.fingerprint}` : `model ${id.model}`
    if (firstKey === undefined) {
      firstKey = key
      first = id
    } else if (key !== firstKey) {
      requests.push({ ms, error: 'backend_changed' })
      interrupted = `backend changed mid-measurement (${firstKey}, then ${key}): answers discarded`
      for (const v of group) (collected.get(v.qid) as Collected).error ??= 'backend changed'
      return
    }
    const r: RequestStat = { ms }
    if (response.usage) r.tokens = response.usage.input_tokens
    requests.push(r)
    for (const v of group) {
      const coll = collected.get(v.qid) as Collected
      coll.ms += ms
      const a = Object.hasOwn(response.answers, v.qid) ? response.answers[v.qid] : undefined
      if (a === undefined) {
        coll.error ??= `answer discarded: ${discarded.find((s) => s.id === v.qid)?.reason ?? 'missing'}`
        continue
      }
      const x = readValue(v.readout, a)
      if (typeof x === 'string') coll.error ??= x
      else coll.chunks.push(x)
    }
  }

  const all = questions.flatMap((d) => d.variants)
  const perQuestion = new Map(questions.map((d) => [d.id, d]))
  measuring: for (let rep = 1; rep <= o.repeats; rep++) {
    for (const [k, row] of rows.entries()) {
      const s = states.get(row.id) as States
      const t0 = clock.now()
      const collected = new Map<string, Collected>()
      // redaction only towards a non-local backend, with one seed per row: the states
      // stay the same from one repeat to the next
      const rnd = prng(rowSeed(o.seed, row.id))
      const memo = new Map<string, string>()
      const prepare = (text: string): string => redactForBackend(backend, text, p, rnd, memo).text

      const local = all.filter((v) => perQuestion.get(v.question)?.scope === 'chunk')
      const global = all.filter((v) => {
        const d = perQuestion.get(v.question) as Question
        return d.scope === 'global' && (!d.requiresDescription || s.hasDescription)
      })
      if (rep === 1) notAsked += all.length - local.length - global.length
      for (const v of local) collected.set(v.qid, { chunks: [], expected: s.chunks.length, ms: 0 })
      for (const v of global) collected.set(v.qid, { chunks: [], expected: 1, ms: 0 })
      const jobs: { state: string; variants: Variant[] }[] = []
      if (local.length > 0) for (const pt of s.chunks) jobs.push({ state: pt.text, variants: local })
      if (global.length > 0) jobs.push({ state: s.global, variants: global })
      const n0 = requests.length
      for (const job of jobs) {
        const state = prepare(job.state)
        for (const g of inGroups(job.variants, LIMITS.maxQuestions)) {
          await send(state, g, collected)
          if (interrupted !== undefined) break
        }
        if (interrupted !== undefined) break
      }

      for (const v of all) {
        const coll = collected.get(v.qid)
        if (!coll) continue
        const rg: RawRow = {
          id: row.id, repeat: rep, question: v.question, variant: v.name, readout: v.readout.text,
          p: null, raw: null, label: row.labels[v.question] ?? null, ms: Math.round(coll.ms),
        }
        if (coll.error === undefined && coll.chunks.length === coll.expected && coll.expected > 0) {
          // for chunk questions the maximum across chunks, as aggregateNoul in the
          // reviewer: the readout already puts every p in "yes = problem" polarity
          const worst = coll.chunks.reduce((a, x) => (x.p > a.p ? x : a))
          rg.p = worst.p
          rg.raw = worst.raw
          if (coll.chunks.length > 1) rg.chunks = coll.chunks.map((x) => x.p)
        } else {
          rg.error = coll.error
            ?? (coll.expected === 0 ? 'no chunk to send: all files ignored' : interrupted !== undefined ? 'measurement interrupted' : 'missing answers')
        }
        raw.push(rg)
        appendFileSync(rawFile, `${JSON.stringify(rg)}\n`)
      }
      const done = requests.length - n0
      log(`[${rep}/${o.repeats}] ${k + 1}/${rows.length} ${row.id}: ${done} ${done === 1 ? 'request' : 'requests'}, ${formatNumber((clock.now() - t0) / 1000)} s`)
      if (interrupted !== undefined) break measuring
    }
  }

  const withTest = new Set([...states].filter(([, s]) => s.hasTestFile).map(([id]) => id))
  const report = renderReport({
    options: o, backend, first, questions, rows: templates, raw, requests, warnings, notes, interrupted,
    notAsked, config, withTest, datasetHash: sha256Hex(datasetText), variantsHash: sha256Hex(variantsText),
  })
  writeFileSync(reportFile, report)
  if (interrupted !== undefined) log(`measurement interrupted: ${interrupted}`)
  return { exitCode: interrupted === undefined ? EXIT_OK : EXIT_INTERRUPTED, report: reportFile, raw: rawFile, rows: raw }
}

// ─── Aggregation per variant ──────────────────────────────────────────────────

export interface TableRow {
  variant: string
  readout: string
  metrics: Metrics
  missing: number                        // diffs with a label but without a p (errors)
  repeatSpread: number | null         // largest spread of p across repeats
  derived: boolean                       // pair or combination: computed from other variants, not asked
}

// For each (diff, variant) the mean across repeats; the metrics are computed on it.
function means(raw: readonly RawRow[], question: string): Map<string, Map<string, { p: number; spread: number }>> {
  const byVariant = new Map<string, Map<string, number[]>>()
  for (const g of raw) {
    if (g.question !== question || g.p === null) continue
    const m = byVariant.get(g.variant) ?? new Map<string, number[]>()
    const xs = m.get(g.id) ?? []
    xs.push(g.p)
    m.set(g.id, xs)
    byVariant.set(g.variant, m)
  }
  const out = new Map<string, Map<string, { p: number; spread: number }>>()
  for (const [v, m] of byVariant) {
    out.set(v, new Map([...m].map(([id, xs]) => [id, { p: mean(xs) as number, spread: Math.max(...xs) - Math.min(...xs) }])))
  }
  return out
}

// withTest: the ids of the diffs that contain a test file, for the "zero_if_test_file"
// combinations.
export const PATHS_ONLY = 'paths only (no model)'
export function questionTable(
  d: Question, rows: readonly DatasetRow[], raw: readonly RawRow[], withTest: ReadonlySet<string> = new Set(),
): TableRow[] {
  const labels = new Map<string, boolean>()
  for (const r of rows) {
    const e = r.labels[d.id]
    if (typeof e === 'boolean') labels.set(r.id, e)
  }
  const m = means(raw, d.id)
  const asked = new Set(raw.filter((g) => g.question === d.id).map((g) => g.id))
  const tableRow = (name: string, readout: string, values: Map<string, { p: number; spread: number }>, derived: boolean): TableRow => {
    const samples: Sample[] = []
    let missing = 0
    let spread: number | null = null
    for (const [id, y] of labels) {
      const x = values.get(id)
      if (x === undefined) {
        if (asked.has(id)) missing++
        continue
      }
      samples.push({ p: x.p, y })
      spread = Math.max(spread ?? 0, x.spread)
    }
    return { variant: name, readout, metrics: metrics(samples), missing, repeatSpread: spread, derived }
  }
  // A derived p exists for a diff only if all the variants it comes from are there.
  // The spread across repeats is that of the variant that moved the most.
  const drift = (names: readonly string[], f: (ps: number[], id: string) => number): Map<string, { p: number; spread: number }> => {
    const values = new Map<string, { p: number; spread: number }>()
    for (const id of m.get(names[0])?.keys() ?? []) {
      const xs = names.map((n) => m.get(n)?.get(id))
      if (xs.every((x): x is { p: number; spread: number } => x !== undefined)) {
        values.set(id, { p: f(xs.map((x) => x.p), id), spread: Math.max(...xs.map((x) => x.spread)) })
      }
    }
    return values
  }
  const out = d.variants.map((v) => tableRow(v.name, v.readout.text, m.get(v.name) ?? new Map(), false))
  for (const c of d.pairs) out.push(tableRow(`${c.direct} + ${c.inverse}`, 'mean', drift([c.direct, c.inverse], logitMean), true))
  for (const c of d.combinations) {
    if (c.kind === 'max') out.push(tableRow(c.name, 'max', drift(c.variants, (ps) => Math.max(...ps)), true))
    else if (c.kind === 'mean') out.push(tableRow(c.name, 'mean', drift(c.variants, logitMean), true))
    else out.push(tableRow(c.name, 'p × no test', drift([c.variant], ([p], id) => (withTest.has(id) ? 0 : p)), true))
  }
  // The path rule already separates on its own (a diff with a test is rarely missing
  // tests): without this baseline the model's merit in "p × no test" could not be told
  // apart from the rule's.
  if (d.combinations.some((c) => c.kind === 'without_tests')) {
    out.push(tableRow(PATHS_ONLY, 'no test', new Map([...asked].map((id) => [id, { p: withTest.has(id) ? 0 : 1, spread: 0 }])), true))
  }
  return out.sort(compareRows)
}

// Highest AUROC first (without AUROC at the bottom), then widest separation, then
// lowest Brier, then the name.
function compareRows(a: TableRow, b: TableRow): number {
  const x = a.metrics
  const y = b.metrics
  if ((x.auroc === null) !== (y.auroc === null)) return x.auroc === null ? 1 : -1
  if (x.auroc !== null && y.auroc !== null && x.auroc !== y.auroc) return y.auroc - x.auroc
  if ((x.separation ?? -Infinity) !== (y.separation ?? -Infinity)) return (y.separation ?? -Infinity) - (x.separation ?? -Infinity)
  if ((x.brier ?? Infinity) !== (y.brier ?? Infinity)) return (x.brier ?? Infinity) - (y.brier ?? Infinity)
  return a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0
}

// ─── Report ───────────────────────────────────────────────────────────────────

const n3 = (x: number | null): string => (x === null ? '—' : formatNumber(x, 3))
const n4 = (x: number | null): string => (x === null ? '—' : formatNumber(x, 4))
// Names written by the backend (model, fingerprint): in a code span, without backticks or newlines.
const code = (s: string): string => `\`${s.replace(/[`\r\n|]/g, '')}\``
const stateName = (s: Scope): string => (s === 'chunk' ? 'chunk state' : 'global state')
// A repo file is shown relative to the root: the report does not depend on where the clone lives.
const showFile = (f: string): string => {
  const r = relative(ROOT, f)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : f
}

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null
  const o = [...xs].sort((a, b) => a - b)
  return o[Math.min(o.length - 1, Math.max(0, Math.ceil(q * o.length) - 1))]
}

interface ReportData {
  options: MeasureOptions
  backend: Backend
  first: Identity | undefined
  questions: Question[]
  rows: DatasetRow[]
  raw: RawRow[]
  requests: RequestStat[]
  warnings: string[]
  notes: string[]
  interrupted: string | undefined
  notAsked: number
  config: ReviewConfig
  withTest?: ReadonlySet<string>           // ids of the diffs with a test file (zero_if_test_file combinations)
  datasetHash: string
  variantsHash: string
}

export function renderReport(r: ReportData): string {
  const o = r.options
  const cfg = configHashes(r.config)
  const succeeded = r.requests.filter((x) => x.error === undefined)
  const failed = r.requests.length - succeeded.length
  const ms = succeeded.map((x) => x.ms)
  const tokens = succeeded.flatMap((x) => (x.tokens === undefined ? [] : [x.tokens]))
  const withRepeat = o.repeats > 1
  const out: string[] = []

  out.push('# Question measurement', '')
  if (r.interrupted !== undefined) out.push(`> **Measurement interrupted**: ${r.interrupted}. The numbers below cover only what arrived.`, '')
  out.push(
    `- Date: ${o.date}`,
    `- Backend: ${code(r.backend.host)}${r.backend.local ? ' (local)' : ' (non-local: states redacted as in the reviewer)'}, requested model ${code(r.backend.model)}`,
    `- Declared model: ${r.first ? code(r.first.model) : '—'}`,
    `- Fingerprint: ${r.first?.fingerprint !== undefined ? code(r.first.fingerprint) : '— (the backend does not declare it)'}`,
  )
  if (r.first?.probabilityStatus && r.first.probabilityStatus.length > 0) {
    out.push(`- probability_status: ${r.first.probabilityStatus.map(code).join(', ')}`)
  }
  out.push(
    `- Dataset: ${code(showFile(o.dataset))}, ${r.rows.length} diffs, sha256 ${code(r.datasetHash)}`,
    `- Variants: ${code(showFile(o.variants))}, ${r.questions.length} questions, ${r.questions.reduce((n, d) => n + d.variants.length, 0)} variants, sha256 ${code(r.variantsHash)}`,
    `- Plugin configuration: checks.json sha256 ${code(cfg.checks)}, policy.json sha256 ${code(cfg.policy)}; ${r.config.policy.state.tokens_per_state} tokens per state, chunks planned with the ${ORIGIN} limits`,
    `- Placeholder seed: ${o.seed}; repeats: ${o.repeats}; Node ${process.version}`,
    `- Requests: ${r.requests.length} (${failed} failed); median latency ${ms.length > 0 ? `${formatNumber((quantile(ms, 0.5) as number) / 1000)} s` : '—'}, p95 ${ms.length > 0 ? `${formatNumber((quantile(ms, 0.95) as number) / 1000)} s` : '—'}${tokens.length > 0 ? `; mean input tokens per request (usage) ${Math.round(mean(tokens) as number)}` : ''}`,
    '',
  )

  out.push(
    '## How to read',
    '',
    '- **p** is the probability that the label is true, that is, that the right answer to the question in "yes = problem" polarity is yes. The readout derives it from the answer: `p` = P(yes), `inverse` = 1 − P(yes) of a question written the other way round, `1-p(x)` = 1 − p of option x of a choice (or of level x of a score), `p(x)` = p of option x, `p(>=k)` = P(level ≥ k) of a score.',
    '- Computed rows, not asked: `mean` = logit mean of a direct variant and its inverse (or of the variants of a combination), `max` = the maximum of the combined variants, `p × no test` = the variant\'s p, set to zero on diffs that contain a test file (`test_paths` in policy.json); `no test` = 1 on diffs without a test file and 0 on the others, i.e. the path rule without the model: it is the baseline to beat for `p × no test`.',
    '- Raw values, no calibration. For questions on the chunk state, with several chunks the maximum counts, as in the reviewer.',
    '- **AUROC**: probability that a positive diff has a higher p than a negative one (1 separates everything, 0.5 is chance, below 0.5 the question is reversed). It does not change with calibration.',
    '- **Separation**: mean p on positives minus mean on negatives. **Brier**: mean squared error of p against the label (0 is perfect; always answering 0.5 scores 0.25).',
    '- **Best threshold**: the threshold (yes from there up) with the highest balanced accuracy, at the logit midpoint between two p of the sample; "—" if no threshold beats chance. **Bal. acc.** is the mean of sensitivity and specificity.',
    ...(withRepeat ? ['- With several repeats the metrics use the mean p per diff; **Δ rep.** is the largest spread of p across repeats.'] : []),
    '- ★ marks the question\'s best variant (AUROC, then separation, then Brier).',
    '',
  )

  const tables = r.questions.map((d) => ({ d, rows: questionTable(d, r.rows, r.raw, r.withTest) }))

  out.push('## Summary', '', '| question | state | best | readout | AUROC | separation | bal. acc. | n+ | n− |', '|---|---|---|---|--:|--:|--:|--:|--:|')
  for (const { d, rows } of tables) {
    const m = rows[0]
    const withAuroc = m !== undefined && m.metrics.auroc !== null
    out.push(`| ${d.id} | ${stateName(d.scope)} | ${withAuroc ? m.variant : '—'} | ${withAuroc ? code(m.readout) : '—'} | ${withAuroc ? n3(m.metrics.auroc) : '—'} | ${withAuroc ? n3(m.metrics.separation) : '—'} | ${withAuroc ? n3(m.metrics.balAccAtBest) : '—'} | ${m?.metrics.positives ?? 0} | ${m?.metrics.negatives ?? 0} |`)
  }
  out.push('')

  for (const { d, rows } of tables) {
    out.push(`## ${d.id}`, '')
    const scope = d.checksScope === undefined
      ? `scope \`${d.scope}\` from variants.json (the question is not in checks.json)`
      : d.checksScope === d.scope ? `scope \`${d.scope}\` as in checks.json` : `scope \`${d.scope}\` from variants.json, **different** from checks.json (\`${d.checksScope}\`)`
    const requires = d.requiresDescription ? '; asked only of diffs with a description' : ''
    out.push(`Question asked on the ${stateName(d.scope)} (${scope})${requires}.`, '')
    const header = ['', 'variant', 'readout', 'AUROC', 'mean +', 'mean −', 'separation', 'Brier', 'best threshold', 'bal. acc.', 'bal. acc. at 0.5', 'n+', 'n−']
    if (withRepeat) header.push('Δ rep.')
    out.push(`| ${header.join(' | ')} |`, `|${header.map((_, i) => (i < 3 ? '---' : '--:')).join('|')}|`)
    rows.forEach((x, i) => {
      const m = x.metrics
      const best = i === 0 && m.auroc !== null
      const cells = [
        best ? '★' : '',
        best ? `**${x.variant}**` : x.variant,
        code(x.readout),
        best ? `**${n3(m.auroc)}**` : n3(m.auroc),
        n3(m.meanPositives), n3(m.meanNegatives), n3(m.separation), n3(m.brier), n4(m.bestThreshold), n3(m.balAccAtBest), n3(m.balAccAt05),
        String(m.positives), String(m.negatives),
      ]
      if (withRepeat) cells.push(n3(x.repeatSpread))
      out.push(`| ${cells.join(' | ')} |`)
    })
    const missing = rows.filter((x) => x.missing > 0 && !x.derived)
    if (missing.length > 0) out.push('', `No p because of an error: ${missing.map((x) => `${x.variant} (${x.missing})`).join(', ')}.`)
    out.push('')
  }

  const errors = new Map<string, number>()
  for (const x of r.requests) if (x.error !== undefined) errors.set(x.error, (errors.get(x.error) ?? 0) + 1)
  if (errors.size > 0 || r.warnings.length > 0 || r.notes.length > 0 || r.notAsked > 0) {
    out.push('## Notes', '')
    for (const [e, n] of errors) out.push(`- ${n} ${n === 1 ? 'failed request' : 'failed requests'}: ${e}`)
    if (r.notAsked > 0) out.push(`- ${r.notAsked === 1 ? '1 question not asked' : `${r.notAsked} questions not asked`} because the diff has no description (as in the reviewer)`)
    for (const n of [...r.notes, ...r.warnings]) out.push(`- ${n}`)
    out.push('')
  }

  // Each variant's hash is the one a calibration fit cites (per_question.sha256): it
  // ties a number in this report to the exact text that produced it.
  out.push('## Variant hashes', '', '| question | variant | type | sha256 |', '|---|---|---|---|')
  for (const d of r.questions) for (const v of d.variants) out.push(`| ${d.id} | ${v.name}${v.fromChecks ? ' (checks.json)' : ''} | ${v.wire.type} | ${code(questionHash(v.wire))} |`)
  out.push('')
  return `${out.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trimEnd()}\n`
}

// ─── Command line ─────────────────────────────────────────────────────────────

const HELP = `Usage: node scripts/measure-questions.ts --out DIR [options]

  --dataset FILE       labelled diffs, one JSON line per diff (default bench/dev.jsonl)
  --variants FILE      alternative question texts (default bench/variants.json)
  --url URL            /v1/systemone backend (default http://127.0.0.1:8017)
  --model NAME         requested model (default jev-latest)
  --out DIR            where to write raw.jsonl and report.md
  --repeats N          how many times to repeat the whole dataset (default 1)
  --date TEXT          date to write in the report (default: today, YYYY-MM-DD)
  --seed N             seed of the {{SEGRETO:type}} placeholders (default 1)
  --timeout-ms N       time limit per request (default 120000)
  --overwrite          rewrites a measurement already in DIR

Docs: bench/MEASUREMENT.md`

export function parseArgs(argv: readonly string[], cwd: string, today: string): MeasureOptions | 'help' {
  const o: MeasureOptions = {
    dataset: resolve(cwd, 'bench/dev.jsonl'), variants: resolve(cwd, 'bench/variants.json'), url: 'http://127.0.0.1:8017',
    model: 'jev-latest', out: '', repeats: 1, date: today, seed: 1, timeoutMs: 120_000, overwrite: false,
  }
  const integer = (name: string, v: string, min: number): number => {
    const n = Number(v)
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min) throw new InputError(`${name} wants an integer ≥ ${min}, found "${v}"`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return 'help'
    if (a === '--overwrite') {
      o.overwrite = true
      continue
    }
    const equal = a.indexOf('=')
    const name = a.startsWith('--') && equal > 0 ? a.slice(0, equal) : a
    let value: string
    if (name !== a) value = a.slice(equal + 1)
    else {
      const v = argv[i + 1]
      if (v === undefined) throw new InputError(`missing value for ${a}`)
      value = v
      i++
    }
    switch (name) {
      case '--dataset': o.dataset = resolve(cwd, value); break
      case '--variants': o.variants = resolve(cwd, value); break
      case '--url': o.url = value; break
      case '--model': o.model = value; break
      case '--out': o.out = resolve(cwd, value); break
      case '--repeats': o.repeats = integer(name, value, 1); break
      case '--date':
        if (value.trim() === '' || value.length > 40 || /[\u0000-\u001f`|]/.test(value)) throw new InputError('--date wants a short text, for example 2026-09-26')
        o.date = value
        break
      case '--seed': o.seed = integer(name, value, 0); break
      case '--timeout-ms': o.timeoutMs = integer(name, value, 1000); break
      default: {
        // "chiave" is Italian for key: --chiave gets the same hint (check-english: allow-next-line)
        const key = /key|chiave|token/i.test(name) ? ' (the key is not passed as a flag: use JEV_HOOKS_URL + JEV_HOOKS_KEY or TYPESAFE_API_KEY)' : ''
        throw new InputError(`unknown option: ${name}${key}`)
      }
    }
  }
  if (o.out === '') throw new InputError('missing --out DIR')
  return o
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const o = parseArgs(argv, process.cwd(), new Date().toISOString().slice(0, 10))
    if (o === 'help') {
      process.stdout.write(`${HELP}\n`)
      return EXIT_OK
    }
    const e = await measure(o)
    process.stdout.write(`${e.report}\n${e.raw}\n`)
    return e.exitCode
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`measure-questions: ${err.message}\n`)
      return EXIT_USAGE
    }
    throw err
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = await main(process.argv.slice(2))
