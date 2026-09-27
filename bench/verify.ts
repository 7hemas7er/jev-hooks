// Checks the bench (bench/dev.jsonl) before every measurement. A wrong label or a
// diff that the parser only half reads shifts AUROC and calibration without anyone
// noticing, so everything that is not certain is rejected here:
// - the schema of every row, with no extra and no missing fields;
// - diffs that the core parser (src/core/diff.ts) reads in full: every line of the
//   text ends up in a header or in a hunk, and the counts of every @@ add up.
//   For robustness the parser silently drops stray lines and closes a hunk that is
//   shorter than declared: here those same things are errors;
// - {{SEGRETO:type}} placeholders that the measurement script can compose, and no
//   detector hit on the text as it is in the repo: neither line by line nor
//   on the whole file, which the reviewer would see when it is committed;
// - consistency between labels and floors: if a detector with a floor fires on the
//   composed diff, the label of its question must be yes;
// - counts per question (positives and hard negatives) and unique ids.
//
// The questions are the probabilities asked of the model in config/checks.json (the
// noul checks and the choice checks with a value): a new question there makes the
// bench incomplete until it is labelled.
//
// Usage: node bench/verify.ts [file.jsonl] [--json]
// Exit 0 if everything adds up, 1 with the list of problems, 2 if the file cannot be read.
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeRow, InputError, parseDataset, SECRET_TYPES } from '../scripts/measure-questions.ts'
import type { DatasetRow } from '../scripts/measure-questions.ts'
import { isModelProbability, validateChecks, validatePolicy } from '../src/core/config.ts'
import { NO_NAME, parseDiff, parseHunkHeader } from '../src/core/diff.ts'
import { entropy, detect } from '../src/core/detectors.ts'
import type { Checks, Hit, ParsedDiff, Result, Policy } from '../src/core/types.ts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Requirements of the bench, not reviewer thresholds: that is why they live here and not in config/.
export const MINIMUMS = { lines: 60, positives: 6, negatives: 6, hardNegatives: 6 }
export const DIFF_LINES = { min: 3, max: 40 }
const MAX_TITLE = 200                       // the title is one line, at most 200 characters
const MAX_ID = 64

export const FIELDS = ['id', 'commit_language', 'language', 'title', 'description', 'diff', 'labels', 'note'] as const
export const COMMIT_LANGUAGES = ['it', 'en'] as const
export const CODE_LANGUAGES = ['python', 'javascript', 'typescript', 'php', 'blade', 'sql', 'markdown', 'yaml', 'toml', 'json', 'text'] as const

const RE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// "[difficile: a, b] text": the row is a hard negative for the listed questions. The
// marker is recorded dataset content, so it stays in Italian.
const RE_HARD_NEGATIVE = /^\[difficile: ([a-z_]+(?:, [a-z_]+)*)\] \S/
// the same form the measurement script accepts; the type is checked separately
const RE_PLACEHOLDER = /\{\{SEGRETO:([a-z_]+)(?::[A-Za-z0-9_-]{1,32})?\}\}/g
const RE_PLACEHOLDER_START = /\{\{\s*SEGRETO/gi

// The diff is read with the reviewer's default limits (config/policy.json); a line
// longer than max_line_chars would be shortened, and the model would see something else.
const MAX_DIFF_BYTES = 4_000_000

export interface BenchRow {
  id: string
  commit_language: string
  language: string
  title: string
  description: string
  diff: string
  labels: Record<string, boolean>
  note: string
}

export interface QuestionCount { question: string; yes: number; no: number; hardNegatives: number }

export interface VerifyResult {
  file: string
  rows: number
  problems: string[]
  counts: QuestionCount[]
  commitLanguages: Record<string, number>
  codeLanguages: Record<string, number>
}

export interface BenchConfig { checks: Checks; policy: Policy; questions: string[] }

function valueOrThrow<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

// The plugin's checks.json and policy.json, without user or project layers: the bench
// is labelled on the definitions the plugin actually sends to the model.
export function benchConfig(root: string = ROOT): BenchConfig {
  const json = (n: string): unknown => JSON.parse(readFileSync(join(root, 'config', `${n}.json`), 'utf8'))
  const checks = valueOrThrow(validateChecks(json('checks'), 'checks.json'))
  const policy = valueOrThrow(validatePolicy(json('policy'), checks, 'policy.json'))
  const questions = checks.order.filter((id) => isModelProbability(checks.defs[id]))
  return { checks, policy, questions }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const short = (s: string, n = 60): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

// ─── Diff ─────────────────────────────────────────────────────────────────────

// Problems of a diff for the core parser. Empty = the parser reads it in full and as
// it is written.
export function diffProblems(diff: string, policy: Policy): string[] {
  const out: string[] = []
  if (diff === '') return ['empty diff']
  if (!diff.endsWith('\n')) out.push('the diff does not end with a newline')
  if (/[\r\0]/.test(diff)) out.push('the diff contains CR or NUL: the parser removes them and the model would see something else')
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length < DIFF_LINES.min || lines.length > DIFF_LINES.max) {
    out.push(`the diff has ${lines.length} lines (allowed ${DIFF_LINES.min} to ${DIFF_LINES.max})`)
  }
  const maxLineChars = policy.state.max_line_chars
  lines.forEach((r, i) => {
    if (r.length > maxLineChars) out.push(`diff line ${i + 1} over ${maxLineChars} characters: the parser would shorten it`)
  })

  const parsed: ParsedDiff = parseDiff(diff, { maxBytes: MAX_DIFF_BYTES, maxLineChars })
  if (parsed.truncated) out.push('diff truncated by the parser')
  if (parsed.files.length === 0) return [...out, 'the parser finds no file']

  // Every line of the text must have ended up in a header or in a hunk: the parser
  // silently drops the ones it does not recognise, and closes a hunk that runs out.
  let counted = 0
  for (const f of parsed.files) {
    if (f.path === NO_NAME) out.push('a file in the diff has no readable name')
    counted += f.header === '' ? 0 : f.header.split('\n').length
    if (f.hunks.length === 0 && f.status !== 'R') out.push(`${f.path}: no hunk (allowed only for a pure rename)`)
    let oldEnd = 0
    for (const h of f.hunks) {
      counted += 1 + h.lines.length
      const hh = parseHunkHeader(h.header)
      if (!hh) {
        out.push(`${f.path}: unreadable hunk header "${short(h.header)}"`)
        continue
      }
      const oldLines = h.lines.filter((r) => r[0] === ' ' || r[0] === '-').length
      const newLines = h.lines.filter((r) => r[0] === ' ' || r[0] === '+').length
      if (oldLines !== hh.oldCount || newLines !== hh.newCount) {
        out.push(`${f.path}: "${short(h.header, 40)}" declares -${hh.oldCount} +${hh.newCount}, but the hunk has -${oldLines} +${newLines}`)
      }
      if (hh.oldStart < oldEnd) out.push(`${f.path}: "${short(h.header, 40)}" overlaps the previous hunk`)
      oldEnd = hh.oldStart + hh.oldCount
    }
  }
  if (counted !== lines.length) {
    out.push(`the parser keeps ${counted} of ${lines.length} lines: there are lines outside headers and hunks, or hunks shorter than declared`)
  }
  return out
}

// ─── Detectors and plain-text values ──────────────────────────────────────────

// What counts are the detectors that stop or ask something on their own: those with a
// floor (production prefixes, phrases addressed to the reviewer) and those that always
// escalate. The others, such as secret_assignment, also fire on harmless bench code
// (aws_access_key_id=AWS_ACCESS_KEY_ID: the = sign is part of the token, and name plus
// value has the entropy of a key); secrets without a prefix are left to plaintextValues.
function heavyDetectors(policy: Policy): Set<string> {
  return new Set(policy.detectors.filter((d) => d.floor !== null || d.escalate === 'always').map((d) => d.name))
}

// A value that looks like a key: at least 20 key characters, with digits, lowercase
// and uppercase together, and at least 4 bits per character. No name, path or
// identifier in the bench has this shape, while a random 40-character value does: a
// secret without a prefix written in plain text instead of as a placeholder shows up
// here. It is a heuristic (24 random characters may have no digit): values with a
// production prefix are stopped by the detectors with a floor.
const RE_CANDIDATE = /[A-Za-z0-9+/=_-]{20,}/g
export function plaintextValues(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(RE_CANDIDATE)) {
    const t = m[0]
    if (/\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && entropy(t) >= 4) out.push(t)
  }
  return out
}

// Detector hits on a text added in full as a new file: it is what the reviewer would
// see when that file is committed. Used for the jsonl and for the README.
export function hitsOnFile(text: string, path: string, policy: Policy): Hit[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const d: ParsedDiff = {
    files: [{
      path, status: 'A', header: '', hunks: [], added: lines.length, removed: 0,
      addedLines: lines.map((t, i) => ({ number: i + 1, text: t })),
    }],
    truncated: false,
    bytes: 0,
  }
  const heavy = heavyDetectors(policy)
  return detect(d, { title: '', description: null }, policy).hits.filter((c) => c.where !== 'paths' && heavy.has(c.detector))
}

// Hits on the text of a row as it is in the repo, that is with the placeholders. Hits
// on paths do not count: a row that touches .github/workflows/ is legitimate.
function hitsOnText(r: BenchRow, policy: Policy): Hit[] {
  const d = parseDiff(r.diff, { maxBytes: MAX_DIFF_BYTES, maxLineChars: policy.state.max_line_chars })
  const heavy = heavyDetectors(policy)
  return detect(d, { title: r.title, description: r.description }, policy).hits.filter((c) => c.where !== 'paths' && heavy.has(c.detector))
}

const hitLocation = (c: Hit): string => (c.where === 'added_lines' ? `${c.file}:${c.line}` : c.where === 'title' ? 'title' : 'description')

// ─── Rows ─────────────────────────────────────────────────────────────────────

function placeholders(text: string, where: string): string[] {
  const out: string[] = []
  const valid = [...text.matchAll(RE_PLACEHOLDER)]
  for (const m of valid) {
    if (!Object.hasOwn(SECRET_TYPES, m[1])) out.push(`${where}: unknown secret type "${m[1]}" (known: ${Object.keys(SECRET_TYPES).join(', ')})`)
  }
  const starts = [...text.matchAll(RE_PLACEHOLDER_START)].length
  if (starts !== valid.length) out.push(`${where}: malformed placeholder (expected {{SEGRETO:type}} or {{SEGRETO:type:n}})`)
  return out
}

// Checks the fields of a row already read as JSON. Returns the typed row only if the
// fields have the right shape; the problems accumulate in `out`.
function readRow(v: unknown, where: string, c: BenchConfig, out: string[]): BenchRow | null {
  if (!isObject(v)) {
    out.push(`${where}: expected an object`)
    return null
  }
  const allowed = new Set<string>(FIELDS)
  for (const k of Object.keys(v)) if (!allowed.has(k)) out.push(`${where}: unexpected field "${k}"`)
  for (const k of FIELDS) if (!(k in v)) out.push(`${where}: missing field "${k}"`)
  const id = typeof v.id === 'string' ? v.id : ''
  const here = id === '' ? where : `${where} (${id})`
  const before = out.length

  if (!RE_ID.test(id) || id.length > MAX_ID) out.push(`${where}: "id" must be lowercase with hyphens (${RE_ID.source}), at most ${MAX_ID} characters`)
  if (!(COMMIT_LANGUAGES as readonly unknown[]).includes(v.commit_language)) out.push(`${here}: "commit_language" must be one of ${COMMIT_LANGUAGES.join(', ')}`)
  if (!(CODE_LANGUAGES as readonly unknown[]).includes(v.language)) out.push(`${here}: "language" must be one of ${CODE_LANGUAGES.join(', ')}`)
  if (typeof v.title !== 'string' || v.title.trim() === '' || /[\r\n]/.test(v.title) || v.title.length > MAX_TITLE) {
    out.push(`${here}: "title" must be a non-empty line of at most ${MAX_TITLE} characters`)
  }
  const maxDescription = c.policy.state.max_description_chars
  if (typeof v.description !== 'string' || v.description.trim() === '' || v.description.length > maxDescription) {
    // description_matches is only asked when there is a description: every row has one
    out.push(`${here}: "description" must be a non-empty string of at most ${maxDescription} characters`)
  }
  if (typeof v.diff !== 'string') out.push(`${here}: "diff" must be a string`)
  if (typeof v.note !== 'string' || v.note.trim() === '') out.push(`${here}: "note" must explain the labels`)

  const labels: Record<string, boolean> = {}
  if (!isObject(v.labels)) out.push(`${here}: "labels" must be an object`)
  else {
    for (const k of Object.keys(v.labels)) if (!c.questions.includes(k)) out.push(`${here}: label for a question that checks.json does not ask the model: "${k}"`)
    for (const q of c.questions) {
      const e = v.labels[q]
      if (typeof e !== 'boolean') out.push(`${here}: the label of ${q} must be true or false`)
      else labels[q] = e
    }
  }
  if (out.length > before) return null
  return {
    id, commit_language: v.commit_language as string, language: v.language as string, title: v.title as string,
    description: v.description as string, diff: v.diff as string, labels, note: v.note as string,
  }
}

// The hard negatives declared in the note: known questions, no repetitions, and with
// the label set to no (a "hard negative" that is positive is a labelling error).
function hardNegativesOf(r: BenchRow, here: string, c: BenchConfig, out: string[]): string[] {
  if (!r.note.startsWith('[')) return []
  const m = RE_HARD_NEGATIVE.exec(r.note)
  if (!m) {
    out.push(`${here}: the note starts with "[" but does not have the form "[difficile: question, question] explanation"`)
    return []
  }
  const ids = m[1].split(', ')
  const seen = new Set<string>()
  for (const q of ids) {
    if (!c.questions.includes(q)) out.push(`${here}: hard negative for an unknown question "${q}"`)
    else if (r.labels[q]) out.push(`${here}: declared a hard negative for ${q}, but the label is true`)
    if (seen.has(q)) out.push(`${here}: ${q} repeated among the hard negatives`)
    seen.add(q)
  }
  return [...seen]
}

// The composed diff (placeholders replaced as in the measurement) stays valid, and
// every detector floor that fires on the added lines has its question set to yes: an
// added AKIA… or sk_live_… is a secret by definition, even in a test or in a comment.
function checkComposed(r: BenchRow, here: string, c: BenchConfig, out: string[]): void {
  const row: DatasetRow = { id: r.id, diff: r.diff, title: r.title, description: r.description, labels: r.labels }
  let composed: DatasetRow
  try {
    composed = composeRow(row, 1)
  } catch (e) {
    out.push(`${here}: the measurement script cannot compose the row: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  if (composed.diff === r.diff) return
  for (const p of diffProblems(composed.diff, c.policy)) out.push(`${here}: after composing the placeholders, ${p}`)
  const withFloor = new Map(c.policy.detectors.filter((d) => d.floor !== null && d.check !== undefined).map((d) => [d.name, d.check as string]))
  const d = parseDiff(composed.diff, { maxBytes: MAX_DIFF_BYTES, maxLineChars: c.policy.state.max_line_chars })
  for (const hit of detect(d, { title: '', description: null }, c.policy).hits) {
    const q = withFloor.get(hit.detector)
    if (hit.where === 'added_lines' && q !== undefined && c.questions.includes(q) && r.labels[q] !== true) {
      out.push(`${here}: after composition detector ${hit.detector} (floor) fires on ${hitLocation(hit)}, but ${q} is false`)
    }
  }
}

// ─── Verification ─────────────────────────────────────────────────────────────

export function verifyBench(text: string, file: string, c: BenchConfig = benchConfig()): VerifyResult {
  const problems: string[] = []
  const rows: BenchRow[] = []
  const ids = new Set<string>()
  const seenDiffs = new Map<string, string>()
  const hardNegatives = new Map<string, number>(c.questions.map((q) => [q, 0]))

  const textLines = text.split('\n')
  if (textLines[textLines.length - 1] === '') textLines.pop()
  textLines.forEach((line, k) => {
    const where = `${file}:${k + 1}`
    if (line.trim() === '') {
      problems.push(`${where}: empty line`)
      return
    }
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      problems.push(`${where}: invalid JSON`)
      return
    }
    const r = readRow(v, where, c, problems)
    if (!r) return
    const here = `${where} (${r.id})`
    if (ids.has(r.id)) problems.push(`${here}: repeated id`)
    ids.add(r.id)
    const twin = seenDiffs.get(r.diff)
    if (twin !== undefined) problems.push(`${here}: same diff as row ${twin}`)
    seenDiffs.set(r.diff, r.id)

    for (const p of diffProblems(r.diff, c.policy)) problems.push(`${here}: ${p}`)
    for (const [field, t] of [['title', r.title], ['description', r.description], ['diff', r.diff]] as const) {
      problems.push(...placeholders(t, `${here} ${field}`))
      // the value is not repeated in the message: it could be a real key pasted in
      for (const x of plaintextValues(t)) {
        problems.push(`${here} ${field}: a value of ${x.length} characters looks like a key written in plain text; use a {{SEGRETO:type}} placeholder`)
      }
    }
    for (const hit of hitsOnText(r, c.policy)) {
      problems.push(`${here}: detector ${hit.detector} fires on ${hitLocation(hit)}; secrets and phrases addressed to the reviewer must be written as placeholders`)
    }
    checkComposed(r, here, c, problems)
    for (const q of hardNegativesOf(r, here, c, problems)) hardNegatives.set(q, (hardNegatives.get(q) ?? 0) + 1)
    rows.push(r)
  })

  // The whole file as the reviewer would see it when committing it: every JSON row is
  // an added line, with the quotes escaped.
  for (const hit of hitsOnFile(text, relative(ROOT, resolve(file)) || file, c.policy)) {
    problems.push(`${file}:${hit.line}: detector ${hit.detector} fires on the JSON line; use a placeholder`)
  }

  // The bench exists for the measurement: if the script cannot read it, it is useless.
  try {
    parseDataset(text, file)
  } catch (e) {
    if (!(e instanceof InputError)) throw e
    problems.push(`the measurement script cannot read the dataset: ${e.message}`)
  }

  const counts: QuestionCount[] = c.questions.map((q) => {
    const yes = rows.filter((r) => r.labels[q]).length
    return { question: q, yes, no: rows.length - yes, hardNegatives: hardNegatives.get(q) ?? 0 }
  })
  if (rows.length < MINIMUMS.lines) problems.push(`${rows.length} valid rows: at least ${MINIMUMS.lines} are needed`)
  for (const x of counts) {
    if (x.yes < MINIMUMS.positives) problems.push(`${x.question}: ${x.yes} positives, at least ${MINIMUMS.positives} are needed`)
    if (x.no < MINIMUMS.negatives) problems.push(`${x.question}: ${x.no} negatives, at least ${MINIMUMS.negatives} are needed`)
    if (x.hardNegatives < MINIMUMS.hardNegatives) problems.push(`${x.question}: ${x.hardNegatives} hard negatives, at least ${MINIMUMS.hardNegatives} are needed`)
  }
  const commitLanguages: Record<string, number> = Object.fromEntries(COMMIT_LANGUAGES.map((l) => [l, rows.filter((r) => r.commit_language === l).length]))
  if (rows.length > 0 && commitLanguages.it * 2 <= rows.length) problems.push(`Italian titles: ${commitLanguages.it} of ${rows.length}, they must be the majority`)
  const codeLanguages: Record<string, number> = {}
  for (const r of rows) codeLanguages[r.language] = (codeLanguages[r.language] ?? 0) + 1

  return { file, rows: rows.length, problems, counts, commitLanguages, codeLanguages }
}

// ─── Output ───────────────────────────────────────────────────────────────────

export function renderVerifyResult(e: VerifyResult): string {
  const width = Math.max(...e.counts.map((x) => x.question.length), 'question'.length)
  const line = (a: string, b: string, c: string, d: string): string => `  ${a.padEnd(width)}  ${b.padStart(4)}  ${c.padStart(4)}  ${d.padStart(9)}`
  const out = [
    `${e.file}: ${e.rows} rows, titles it ${e.commitLanguages.it ?? 0} / en ${e.commitLanguages.en ?? 0}`,
    'labels in the polarity of the sent question (yes = problem; for adds_tests "missing tests",',
    'for description_matches "description that omits or invents"):',
    line('question', 'yes', 'no', 'hard neg.'),
    ...e.counts.map((x) => line(x.question, String(x.yes), String(x.no), String(x.hardNegatives))),
    `languages: ${Object.entries(e.codeLanguages).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  ]
  if (e.problems.length === 0) out.push('no problems')
  else out.push(`${e.problems.length} ${e.problems.length === 1 ? 'problem' : 'problems'}:`, ...e.problems.map((p) => `  - ${p}`))
  return out.join('\n') + '\n'
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const json = argv.includes('--json')
  const rest = argv.filter((a) => a !== '--json')
  if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) {
    process.stderr.write('usage: node bench/verify.ts [file.jsonl] [--json]\n')
    return 2
  }
  const path = rest[0] !== undefined ? resolve(cwd, rest[0]) : join(ROOT, 'bench', 'dev.jsonl')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    process.stderr.write(`verify: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const name = relative(cwd, path) || path
  const outcome = verifyBench(text, name)
  process.stdout.write(json ? JSON.stringify(outcome, null, 2) + '\n' : renderVerifyResult(outcome))
  return outcome.problems.length === 0 ? 0 : 1
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
