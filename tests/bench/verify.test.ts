// bench/verify.ts: the repo's dataset passes, and every defect the check must stop it
// really stops, with a message that says which row and why. The defects are built here
// starting from the real rows; realistic values (keys with a production prefix) are
// composed at runtime, as in the rest of the tests.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hitsOnFile, benchConfig, plaintextValues, verifyBench } from '../../bench/verify.ts'
import type { BenchRow } from '../../bench/verify.ts'
import { composeRow } from '../../scripts/measure-questions.ts'
import { stripeLiveKey, generator } from '../helpers/fake-secrets.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATASET = join(ROOT, 'bench', 'dev.jsonl')
const CONFIG = benchConfig(ROOT)
const TEXT = readFileSync(DATASET, 'utf8')
const ROWS: BenchRow[] = TEXT.trim().split('\n').map((l) => JSON.parse(l) as BenchRow)

const line = (id: string): BenchRow => {
  const r = ROWS.find((x) => x.id === id)
  assert.ok(r, `row ${id} missing from the bench`)
  return structuredClone(r)
}
const jsonl = (lines: readonly unknown[]): string => lines.map((r) => JSON.stringify(r)).join('\n') + '\n'

// Checks a dataset made of the real rows plus the given ones: the counts stay above the
// minimums, and the problems that show up are only those of the added rows.
function problemsWith(...extra: unknown[]): string[] {
  return verifyBench(jsonl([...ROWS, ...extra]), 'test.jsonl', CONFIG).problems
}

let dir = ''
after(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'bench', 'verify.ts'), ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => { out += d })
    p.stderr.on('data', (d: Buffer) => { err += d })
    p.on('error', ko)
    p.on('close', (code) => ok({ code: code ?? -1, out, err }))
  })
}

test('the repo\'s bench passes the check, with the minimums for every question', () => {
  const e = verifyBench(TEXT, 'bench/dev.jsonl', CONFIG)
  assert.deepEqual(e.problems, [])
  assert.ok(e.rows >= 60)
  assert.deepEqual(e.counts.map((x) => x.question), CONFIG.questions, 'one column for every noul asked of the model')
  for (const x of e.counts) {
    assert.ok(x.yes >= 6 && x.no >= 6 && x.hardNegatives >= 6, `${x.question}: ${JSON.stringify(x)}`)
  }
  assert.ok(e.commitLanguages.it > e.rows / 2, 'most titles are in Italian')
})

test('node bench/verify.ts: exit 0 on the bench, 1 with problems, 2 without a file', async () => {
  const good = await run([])
  assert.equal(good.code, 0, good.err + good.out)
  assert.match(good.out, /no problems/)

  const asJson = await run(['--json'])
  assert.equal(asJson.code, 0, asJson.err)
  assert.deepEqual(JSON.parse(asJson.out).problems, [])

  dir = mkdtempSync(join(tmpdir(), 'jev-hooks-bench-'))
  const broken = join(dir, 'broken.jsonl')
  writeFileSync(broken, jsonl([line('md-refuso-readme'), line('md-refuso-readme')]))
  const bad = await run([broken])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /repeated id/)
  assert.match(bad.out, /at least 60 are needed/)

  const absent = await run([join(dir, 'does-not-exist.jsonl')])
  assert.equal(absent.code, 2)
  assert.match(absent.err, /cannot read/)
})

test('schema: fields, id, language, labels', () => {
  const extra = { ...line('md-refuso-readme'), id: 'extra', group: 'x' }
  const withoutNote: Partial<BenchRow> = { ...line('md-refuso-readme'), id: 'no-note' }
  delete withoutNote.note
  const badId = { ...line('md-refuso-readme'), id: 'Ugly Id' }
  const language = { ...line('md-refuso-readme'), id: 'language', commit_language: 'fr' }
  const title = { ...line('md-refuso-readme'), id: 'title-row', title: 'two\nlines' }
  const labels = line('md-refuso-readme')
  labels.id = 'labels-row'
  delete (labels.labels as Record<string, boolean>).debug_leftovers
  ;(labels.labels as Record<string, unknown>).made_up = true
  ;(labels.labels as Record<string, unknown>).breaks_api = 'no'

  const p = problemsWith(extra, withoutNote, badId, language, title, labels).join('\n')
  assert.match(p, /unexpected field "group"/)
  assert.match(p, /missing field "note"/)
  assert.match(p, /"id" must be lowercase/)
  assert.match(p, /\(language\): "commit_language"/)
  assert.match(p, /\(title-row\): "title" must be a non-empty line/)
  assert.match(p, /label for a question that checks\.json does not ask the model: "made_up"/)
  assert.match(p, /the label of debug_leftovers must be true or false/)
  assert.match(p, /the label of breaks_api must be true or false/)
})

test('diff: hunk counts, lines lost by the parser, length, duplicates', () => {
  // one context line fewer: the hunk declares more lines than it has
  const short = line('md-refuso-readme')
  short.id = 'short-hunk'
  short.diff = short.diff.replace(' # Pagamenti\n', '')

  // a stray line between two files: the parser would drop it silently
  const foreign = line('js-spedizione-con-test')
  foreign.id = 'stray-line'
  foreign.diff = foreign.diff.replace('diff --git a/src/spedizioni.test.js', 'text that is not a diff\ndiff --git a/src/spedizioni.test.js')

  const long = line('md-refuso-readme')
  long.id = 'too-long'
  long.diff = long.diff.replace('@@ -1,3 +1,3 @@', `@@ -1,43 +1,43 @@`).replace(' # Pagamenti\n', ' # Pagamenti\n' + ' line\n'.repeat(40))

  const duplicate = { ...line('md-refuso-readme'), id: 'duplicate' }
  const withoutNewline = { ...line('md-refuso-readme'), id: 'no-newline', diff: line('md-refuso-readme').diff.trimEnd() + ' ' }

  const p = problemsWith(short, foreign, long, duplicate, withoutNewline).join('\n')
  assert.match(p, /\(short-hunk\): README\.md: "@@ -1,3 \+1,3 @@" declares -3 \+3, but the hunk has -2 \+2/)
  assert.match(p, /\(stray-line\): the parser keeps \d+ of \d+ lines/)
  assert.match(p, /\(too-long\): the diff has 49 lines \(allowed 3 to 40\)/)
  assert.match(p, /\(duplicate\): same diff as row md-refuso-readme/)
  assert.match(p, /\(no-newline\): the diff does not end with a newline/)
})

test('placeholders: known types, right shape, no plaintext keys', () => {
  const unknown = line('py-segreto-firma-token') // check-english: allow (a row id of bench/dev.jsonl)
  unknown.id = 'unknown-type'
  unknown.diff = unknown.diff.replace('{{SEGRETO:alta_entropia}}', '{{SEGRETO:dunno}}')

  const malformed = line('py-segreto-firma-token') // check-english: allow (a row id of bench/dev.jsonl)
  malformed.id = 'malformed'
  malformed.diff = malformed.diff.replace('{{SEGRETO:alta_entropia}}', '{{ SEGRETO:alta_entropia }}')

  // a key with a production prefix written out in full: the test composes it
  const key = stripeLiveKey(generator(20260926))
  const inPlaintext = line('php-segreto-stripe-servizio') // check-english: allow (a row id of bench/dev.jsonl)
  inPlaintext.id = 'plaintext-key'
  inPlaintext.diff = inPlaintext.diff.replace('{{SEGRETO:stripe_live}}', key)

  const p = problemsWith(unknown, malformed, inPlaintext).join('\n')
  assert.match(p, /\(unknown-type\) diff: unknown secret type "dunno"/)
  assert.match(p, /\(malformed\) diff: malformed placeholder/)
  assert.match(p, /\(plaintext-key\): detector stripe_live fires on app\/Services\/Pagamenti\.php:9/)
  assert.match(p, /\(plaintext-key\) diff: a value of \d+ characters looks like a key written in plain text/)
  assert.match(p, /test\.jsonl:\d+: detector stripe_live fires on the JSON line/)
  assert.ok(!p.includes(key.slice(8)), 'the value found is not repeated in the messages')
})

test('labels consistent with the floors and with the hard negatives', () => {
  // an added production prefix is a secret even in a test file
  const falseNegative = line('py-fixture-stripe-live')
  falseNegative.id = 'floor-without-label'
  falseNegative.labels.hardcoded_secret = false

  const hardPositive = line('py-sql-fstring')
  hardPositive.id = 'hard-but-positive'
  hardPositive.note = '[difficile: injection_risk] note'

  const marker = line('md-refuso-readme')
  marker.id = 'broken-marker'
  marker.note = '[difficile injection_risk] note'

  const p = problemsWith(falseNegative, hardPositive, marker).join('\n')
  assert.match(p, /\(floor-without-label\): after composition detector stripe_live \(floor\) fires on tests\/conftest\.py:7, but hardcoded_secret is false/)
  assert.match(p, /\(hard-but-positive\): declared a hard negative for injection_risk, but the label is true/)
  assert.match(p, /\(broken-marker\): the note starts with "\["/)
})

test('minimums: too few positives or too few hard negatives show per question', () => {
  const docsOnly = Array.from({ length: 60 }, (_, i) => {
    const r = line('md-refuso-readme')
    r.id = `docs-${i}`
    r.diff = r.diff.replace('pagamenti con carta', `pagamenti con carta ${i}`)
    return r
  })
  const e = verifyBench(jsonl(docsOnly), 'docs.jsonl', CONFIG)
  const p = e.problems.join('\n')
  for (const q of CONFIG.questions) {
    assert.match(p, new RegExp(`${q}: 0 positives, at least 6 are needed`))
    assert.match(p, new RegExp(`${q}: 0 hard negatives, at least 6 are needed`))
  }
})

test('values composed without a prefix look like keys, placeholders do not', () => {
  // plaintextValues is the net for secrets without a prefix: it must recognize what the
  // measurement script composes, otherwise it would not stop even a real value. Values
  // with a production prefix are stopped by the detectors with a floor (the placeholder
  // test above); 24 random characters may also have no digits.
  let seen = 0
  for (const r of ROWS) {
    if (!/\{\{SEGRETO:(alta_entropia|aws_segreta)\b/.test(r.diff)) continue
    assert.deepEqual(plaintextValues(r.diff), [], `${r.id}: the placeholder must not look like a key`)
    const composed = composeRow({ id: r.id, diff: r.diff, title: r.title, description: r.description, labels: r.labels }, 7)
    assert.ok(plaintextValues(composed.diff).length > 0, `${r.id}: the composed value must look like a key`)
    seen++
  }
  assert.ok(seen >= 6, `rows with composed secrets: ${seen}`)
})

// The files under a directory, with the subdirectories: the results of a measurement
// live in bench/results/<date>/ and are committed too.
function filesUnder(relative: string): string[] {
  return readdirSync(join(ROOT, relative), { withFileTypes: true }).flatMap((d) => {
    const name = `${relative}/${d.name}`
    return d.isDirectory() ? filesUnder(name) : d.isFile() ? [name] : []
  })
}

test('the bench files do not make the reviewer fire when they are committed', () => {
  // all the bench files, measurement results included, and the script and the tests
  // that go with it
  const files = [...filesUnder('bench'), 'scripts/measure-questions.ts', ...filesUnder('tests/bench')]
  assert.ok(files.includes('bench/variants.json') && files.includes('bench/dev.jsonl'))
  assert.ok(files.some((f) => f.startsWith('bench/results/') && f.endsWith('/report.md')), 'the measurement reports')
  for (const name of files) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    assert.deepEqual(hitsOnFile(text, name, CONFIG.policy), [], name)
    assert.deepEqual(plaintextValues(text), [], name)
  }
})

test('verify --only: a set labelled for one question is checked row by row, not rejected whole', () => {
  const script = fileURLToPath(new URL('../../bench/verify.ts', import.meta.url))
  const file = fileURLToPath(new URL('../../bench/holdout-weakens.jsonl', import.meta.url))
  const run = (...a: string[]) => spawnSync(process.execPath, [script, file, ...a], { encoding: 'utf8' })
  const narrowed = run('--only', 'weakens_tests')
  assert.equal(narrowed.status, 0, narrowed.stdout)
  assert.match(narrowed.stdout, /weakens_tests\s+16\s+44\s+29/)
  // without it, the eight unlabelled questions reject every row
  const whole = run()
  assert.equal(whole.status, 1)
  assert.match(whole.stdout, /0 valid rows/)
  assert.equal(run('--only', 'not_a_question').status, 2)
  assert.equal(run('--only').status, 2)
})
