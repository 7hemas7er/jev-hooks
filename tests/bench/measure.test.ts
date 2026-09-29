// The question measurement script (scripts/measure-questions.ts), offline against the
// fake server: metrics on known cases, variant readouts ("p", "inverse", "1-p(none)"),
// one request per state with at most 64 questions, states identical to those review()
// sends, placeholders composed at runtime and never in the outputs. It writes only to
// temporary directories, and no process sees the real variables.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  balancedAccuracy, auroc, composeRow, pluginConfig, InputError, parseDataset, readValue, parseVariants, logitMean, metrics,
  measure, ROOT, PATHS_ONLY, statesOf, questionTable, withSharedLabels,
} from '../../scripts/measure-questions.ts'
import type { Readout, MeasureOptions, RawRow } from '../../scripts/measure-questions.ts'
import { isModelProbability } from '../../src/core/config.ts'
import { review } from '../../src/core/review.ts'
import { wireQuestion, questionHash } from '../../src/core/systemone.ts'
import { nodeClock, nodeTransport } from '../../src/node/transport.ts'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer, Scenario } from '../helpers/fake-systemone.ts'

const SCRIPT = join(ROOT, 'scripts', 'measure-questions.ts')
const DATE = '2026-09-26'

let base = ''
let n = 0

before(() => {
  base = mkdtempSync(join(tmpdir(), 'jev-measure-'))
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

function tempDir(): string {
  return mkdtempSync(join(base, `c${n++}-`))
}

const near = (a: number | null, b: number, msg?: string): void => {
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, found ${a}`)
}

// A git diff that adds a new file with these lines.
function newFile(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((r) => `+${r}`), '',
  ].join('\n')
}

interface Case { dataset: object[]; variants: object; scenario?: Scenario }

async function prepare(c: Case): Promise<{ fake: FakeServer; options: MeasureOptions; dir: string }> {
  const dir = tempDir()
  const dataset = join(dir, 'dev.jsonl')
  const variants = join(dir, 'variants.json')
  writeFileSync(dataset, c.dataset.map((x) => JSON.stringify(x)).join('\n') + '\n')
  writeFileSync(variants, JSON.stringify(c.variants, null, 2))
  const fake = await startFake({ mode: 'rizzo', scenario: c.scenario ?? {} })
  const options: MeasureOptions = {
    dataset, variants, url: fake.url, model: 'jev-latest', out: join(dir, 'output'), repeats: 1, date: DATE,
    seed: 1, timeoutMs: 10_000, overwrite: false, env: {}, log: () => {},
  }
  return { fake, options, dir }
}

const bodies = (f: FakeServer): { state: string; questions: Record<string, unknown> }[] =>
  f.requests.filter((r) => r.path === '/v1/systemone').map((r) => r.json as { state: string; questions: Record<string, unknown> })

const raw = (file: string): RawRow[] => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RawRow)

// A readout as variants.json writes it, going through the real validator.
function readout(text: string, question: object): Readout {
  const d = parseVariants(JSON.stringify({ trial: { scope: 'chunk', variants: { v: { readout: text, question } } } }), 'v.json', pluginConfig().checks)
  return d[0].variants[0].readout
}

const NOUL = { type: 'noul', instructions: 'Does the [diff] section add a credential?', criteria: { true: 'A credential is added.', false: 'No credential is added.' } }
const CHOICE = {
  type: 'choice', instructions: 'Which credential does the [diff] section add?',
  criteria: { aws: 'An AWS access key.', stripe: 'A Stripe key.', none: 'No credential.' },
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

test('metrics: perfect separation, AUROC 1', () => {
  const m = metrics([{ p: 0.9, y: true }, { p: 0.8, y: true }, { p: 0.1, y: false }, { p: 0.2, y: false }])
  assert.equal(m.positives, 2)
  assert.equal(m.negatives, 2)
  near(m.auroc, 1)
  near(m.meanPositives, 0.85)
  near(m.meanNegatives, 0.15)
  near(m.separation, 0.7)
  near(m.brier, 0.025)
  // midpoint in logit between 0.2 and 0.8: symmetric logits, so 0.5
  near(m.bestThreshold, 0.5)
  near(m.balAccAtBest, 1)
  near(m.balAccAt05, 1)
})

test('metrics: no signal, AUROC 0.5', () => {
  const flat = metrics([{ p: 0.7, y: true }, { p: 0.7, y: true }, { p: 0.7, y: false }, { p: 0.7, y: false }])
  near(flat.auroc, 0.5)
  near(flat.separation, 0)
  assert.equal(flat.bestThreshold, null, 'no threshold beats chance')
  near(flat.balAccAtBest, 0.5)
  near(flat.balAccAt05, 0.5, 'all yes: sensitivity 1, specificity 0')
  // the same distribution on the two classes, without ties everywhere
  near(auroc([{ p: 0.9, y: true }, { p: 0.1, y: true }, { p: 0.9, y: false }, { p: 0.1, y: false }]), 0.5)
})

test('metrics: reversed question, AUROC 0', () => {
  const m = metrics([{ p: 0.1, y: true }, { p: 0.2, y: true }, { p: 0.8, y: false }, { p: 0.9, y: false }])
  near(m.auroc, 0)
  near(m.separation, -0.7)
  assert.equal(m.bestThreshold, null)
  near(m.balAccAtBest, 0.5)
  near(m.balAccAt05, 0)
})

test('metrics: ties count as half; a single class has no AUROC', () => {
  near(auroc([{ p: 0.5, y: true }, { p: 0.9, y: true }, { p: 0.5, y: false }, { p: 0.1, y: false }]), 0.875)
  const only = metrics([{ p: 0.9, y: true }, { p: 0.4, y: true }])
  assert.equal(only.auroc, null)
  assert.equal(only.balAccAt05, null)
  assert.equal(only.bestThreshold, null)
  near(only.meanPositives, 0.65)
  assert.equal(only.meanNegatives, null)
  assert.equal(balancedAccuracy([], 0.5), null)
})

test('metrics: the best threshold lies between the p of the sample, at the midpoint in logit', () => {
  // positives at 0.99 and 0.999, negatives at 0.9 and 0.5: the separation is all above 0.9
  const m = metrics([{ p: 0.99, y: true }, { p: 0.999, y: true }, { p: 0.9, y: false }, { p: 0.5, y: false }])
  near(m.balAccAtBest, 1)
  const logit = (p: number): number => Math.log(p / (1 - p))
  near(m.bestThreshold, 1 / (1 + Math.exp(-(logit(0.9) + logit(0.99)) / 2)))
  near(m.balAccAt05, 0.5, 'at 0.5 both negatives (0.9 and 0.5) pass as yes')
})

// ─── Readouts ─────────────────────────────────────────────────────────────────

test('readout: p, inverse, 1-p(none), p(option), p(>=k)', () => {
  const p = readValue(readout('p', NOUL), { type: 'noul', noul: 0.8 })
  assert.deepEqual(p, { p: 0.8, raw: 0.8 })
  const inv = readValue(readout('inverse', NOUL), { type: 'noul', noul: 0.8 })
  assert.ok(typeof inv !== 'string')
  near(inv.p, 0.2)
  const selection = { type: 'choice' as const, choice: 'none', probabilities: { aws: 0.2, stripe: 0.1, none: 0.7 }, confidence: 0.55 }
  const none = readValue(readout('1-p(none)', CHOICE), selection)
  assert.ok(typeof none !== 'string')
  near(none.p, 0.3)
  near(none.raw, 0.7)
  const aws = readValue(readout('p(aws)', CHOICE), selection)
  assert.ok(typeof aws !== 'string')
  near(aws.p, 0.2)
  const score = { type: 'score', instructions: 'How far does the change reach?', criteria: ['none', 'one function', 'several modules', 'core'] }
  const atLeast = readValue(readout('p(>=2)', score), {
    type: 'score', score: 2, legend: {}, probabilities: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 }, confidence: 0.1,
  })
  assert.ok(typeof atLeast !== 'string')
  near(atLeast.p, 0.7)
  // an answer of the wrong type does not become a number
  assert.equal(typeof readValue(readout('p', NOUL), selection), 'string')
})

test('variants: errors are found before sending', () => {
  const checks = pluginConfig().checks
  const error = (j: object, expected: RegExp): void => {
    assert.throws(() => parseVariants(JSON.stringify(j), 'v.json', checks), (e: unknown) => e instanceof InputError && expected.test(e.message))
  }
  error({ hardcoded_secret: { variants: { a: { readout: 'p', question: CHOICE } } } }, /"p" only applies to a noul/)
  error({ hardcoded_secret: { variants: { a: { readout: '1-p(nothing)', question: CHOICE } } } }, /"nothing" is not among the choice's options/)
  error({ hardcoded_secret: { variants: { a: { question: CHOICE } } } }, /a choice wants "readout"/)
  error({ new_question: { variants: { a: { question: NOUL } } } }, /missing "scope"/)
  error({ new_question: { scope: 'global', variants: { a: { from_checks: true } } } }, /is not a model question/)
  error({ hardcoded_secret: { variants: { a: { question: { ...NOUL, label: 'x' } } } } }, /field not allowed/)
  error({ hardcoded_secret: { variants: { a: { question: { ...NOUL, instructions: '' } } } } }, /hardcoded_secret\/variants\/a\/question/)
  error({ hardcoded_secret: { variants: { a: { question: NOUL }, b: { readout: 'inverse', pair: 'c', question: NOUL } } } }, /"pair" names "c"/)
  error({ a__b: { scope: 'chunk', variants: { c: { question: NOUL } } }, a: { scope: 'chunk', variants: { b__c: { question: NOUL } } } }, /same request id a__b__c/)
  // the current variant of a choice with a value is read as the reviewer reads it:
  // another readout would measure something other than what decides the verdict
  assert.ok(checks.defs.injection_risk.value, 'injection_risk is a choice with a value')
  error({ injection_risk: { variants: { attuale: { from_checks: true, readout: 'p(none)' } } } }, /differs from the checks\.json value \("1-p\(none\)"\)/)
  const same = parseVariants(JSON.stringify({ injection_risk: { variants: { attuale: { from_checks: true, readout: '1-p(none)' } } } }), 'v.json', checks)
  assert.equal(same[0].variants[0].readout.text, '1-p(none)')
})

test('variants: from_checks, scope and requires from checks.json, pairs by name or explicit', () => {
  const checks = pluginConfig().checks
  const d = parseVariants(JSON.stringify({
    _comment: 'comment',
    description_matches: { variants: { attuale: { from_checks: true } } },
    injection_risk: {
      variants: {
        concrete: { question: NOUL },
        concrete_inversa: { readout: 'inverse', question: NOUL },
        other: { readout: 'inverse', pair: 'concrete', question: NOUL },
        inverse_only: { readout: 'inverse', question: NOUL },
      },
    },
    breaks_api: { scope: 'global', variants: { v: { question: NOUL } } },
  }), 'v.json', checks)
  const [desc, inj, api] = d
  assert.equal(desc.scope, 'global')
  assert.equal(desc.requiresDescription, true)
  assert.deepEqual(desc.variants[0].wire, {
    type: 'noul', instructions: checks.defs.description_matches.instructions, criteria: checks.defs.description_matches.criteria,
  })
  assert.equal(inj.scope, 'chunk')
  assert.deepEqual(inj.pairs, [{ direct: 'concrete', inverse: 'concrete_inversa' }, { direct: 'concrete', inverse: 'other' }])
  assert.equal(api.scope, 'global')
  assert.equal(api.checksScope, 'chunk', 'a scope different from checks.json stays visible for the report')
})

test('combinations: max, mean in logit and zero on diffs with a test file', () => {
  const [d] = parseVariants(JSON.stringify({
    adds_tests: {
      variants: { a: { question: NOUL }, b: { question: NOUL }, c: { question: NOUL } },
      combinations: {
        _comment: 'comment',
        maximum: { _approach: 'x', max: ['a', 'b'] },
        mean: { mean: ['a', 'b'] },
        c_without_tests: { variant: 'c', zero_if_test_file: true },
      },
    },
  }), 'v.json', pluginConfig().checks)
  assert.deepEqual(d.combinations, [
    { name: 'maximum', kind: 'max', variants: ['a', 'b'] },
    { name: 'mean', kind: 'mean', variants: ['a', 'b'] },
    { name: 'c_without_tests', kind: 'without_tests', variant: 'c' },
  ])
  near(logitMean([0.9, 0.1]), 0.5)
  near(logitMean([0.1, 0.2]), 1 / 7, 'odds 1/9 and 1/4: geometric mean 1/6')
  assert.ok(logitMean([1, 1]) < 1 && logitMean([0, 0]) > 0, 'clipped logits: no infinities')

  // r5 has only variant a: it stays out of the combinations that also name b
  const labels: Record<string, boolean> = { r1: true, r2: true, r3: false, r4: false, r5: false }
  const p: Record<string, Record<string, number>> = {
    a: { r1: 0.9, r2: 0.2, r3: 0.1, r4: 0.3, r5: 0.95 },
    b: { r1: 0.1, r2: 0.8, r3: 0.2, r4: 0.1 },
    c: { r1: 0.7, r2: 0.6, r3: 0.9, r4: 0.2, r5: 0.1 },
  }
  const g: RawRow[] = Object.entries(p).flatMap(([variant, xs]) => Object.entries(xs).map(([id, x]) => ({
    id, repeat: 1, question: 'adds_tests', variant, readout: 'p', p: x, raw: x, label: labels[id], ms: 1,
  })))
  const lines = Object.entries(labels).map(([id, y]) => ({ id, diff: '', title: '', description: null, labels: { adds_tests: y } }))
  const t = questionTable(d, lines, g, new Set(['r3']))
  const line = (name: string): (typeof t)[number] => t.find((x) => x.variant === name) as (typeof t)[number]

  const max = line('maximum')
  assert.equal(max.readout, 'max')
  assert.equal(max.derived, true)
  assert.equal(max.metrics.negatives, 2, 'r5 without b does not enter')
  near(max.metrics.auroc, 1)
  near(max.metrics.meanPositives, 0.85)
  near(max.metrics.meanNegatives, 0.25)

  const mean = line('mean')
  assert.equal(mean.readout, 'mean')
  near(mean.metrics.meanPositives, 0.5, 'r1 and r2 have opposite logits')
  near(mean.metrics.meanNegatives, (1 / 7 + 1 / (1 + Math.sqrt(21))) / 2)

  // c on its own separates badly (r3 is the highest negative); set to zero on the diff with the test it does
  near(line('c').metrics.auroc, 4 / 6)
  const without = line('c_without_tests')
  assert.equal(without.readout, 'p × no test')
  near(without.metrics.auroc, 1)
  near(without.metrics.meanNegatives, (0 + 0.2 + 0.1) / 3)
  // the reference without the model: 1 on diffs without a test file, 0 on the others
  const paths = line(PATHS_ONLY)
  assert.equal(paths.readout, 'no test')
  assert.equal(paths.metrics.negatives, 3)
  near(paths.metrics.meanPositives, 1)
  near(paths.metrics.meanNegatives, 2 / 3)
  near(paths.metrics.auroc, 2 / 3, 'r3 below the positives, r4 and r5 tied: (1 + ½ + ½)/3')
  assert.equal(line('a').derived, false)
  assert.equal(line('a').metrics.negatives, 3)
})

test('combinations: errors are found before sending', () => {
  const checks = pluginConfig().checks
  const error = (combinations: object, expected: RegExp): void => {
    const j = { adds_tests: { variants: { a: { question: NOUL }, b: { question: NOUL } }, combinations } }
    assert.throws(() => parseVariants(JSON.stringify(j), 'v.json', checks), (e: unknown) => e instanceof InputError && expected.test(e.message))
  }
  error({ x: { max: ['a', 'z'] } }, /combinations\.x: "max" wants at least two different variant names/)
  error({ x: { mean: ['a'] } }, /"mean" wants at least two/)
  error({ x: { max: ['a', 'a'] } }, /"max" wants at least two different variant names/)
  error({ a: { max: ['a', 'b'] } }, /a variant with this name already exists/)
  error({ x: { max: ['a', 'b'], variant: 'a' } }, /exactly one of "max", "mean" and "variant"/)
  error({ x: { variant: 'a' } }, /needs "zero_if_test_file": true/)
  error({ x: { variant: 'z', zero_if_test_file: true } }, /"variant" must be the name of one of the question's variants/)
  error({ x: { max: ['a', 'b'], zero_if_test_file: true } }, /only applies with "variant"/)
  error({ x: { max: ['a', 'b'], threshold: 1 } }, /unknown field "threshold"/)
  error([], /"combinations" must be an object/)
})

test('test file in the diff: from the paths, with test_paths from policy.json', () => {
  const config = pluginConfig()
  const state = (diff: string): boolean => statesOf({ id: 'x', diff, title: 't', description: null, labels: {} }, config).hasTestFile
  assert.equal(state(newFile('src/a.py', ['x = 1'])), false)
  assert.equal(state(newFile('src/a.py', ['x = 1']) + newFile('tests/test_a.py', ['def test_x(): pass'])), true)
  assert.equal(state(newFile('src/prices.test.ts', ['it("x", () => {})'])), true)
})

// ─── The repo's bench ─────────────────────────────────────────────────────────

// The three parts of the bench (dev.jsonl, variants.json, the script) are born separate:
// here we check that they fit together, so that a format changed on one side only shows
// before leaving for the Spark and not once the measurement has started.
test('the repo\'s bench: variants.json and dev.jsonl are readable, and every question has its labels', () => {
  const config = pluginConfig()
  const questions = parseVariants(readFileSync(join(ROOT, 'bench', 'variants.json'), 'utf8'), 'bench/variants.json', config.checks)
  const dataset = parseDataset(readFileSync(join(ROOT, 'bench', 'dev.jsonl'), 'utf8'), 'bench/dev.jsonl')
  for (const d of questions) {
    assert.ok(d.checksScope !== undefined && d.checksScope === d.scope, `${d.id}: the same question and the same scope as checks.json`)
    const current = d.variants.find((v) => v.name === 'attuale')
    assert.ok(current?.fromChecks, `${d.id}: the "attuale" (current) variant is the text of checks.json`)
    for (const r of dataset) assert.equal(typeof r.labels[d.id], 'boolean', `${r.id}: the label of ${d.id} is missing`)
  }
  // one request per state: the variants of each scope stay under the limit of 64
  for (const s of ['chunk', 'global'] as const) {
    const n = questions.filter((d) => d.scope === s).reduce((k, d) => k + d.variants.length, 0)
    assert.ok(n > 0 && n <= 64, `${n} variants on the ${s} state`)
  }
  for (const r of dataset) {
    const c = composeRow(r, 1)
    // looking for "{{" is not enough: Blade views use it for escaped output
    for (const t of [c.diff, c.title, c.description ?? '']) assert.ok(!/\{\{\s*SEGRETO/i.test(t), `${r.id}: placeholder left behind`)
    assert.ok(statesOf(c, config).chunks.length >= 1, `${r.id}: no chunk to send`)
  }
})

// The holdout set (holdout.jsonl) does not choose between wordings: it measures those
// of checks.json, read as the reviewer reads them, on diffs that were not used to choose
// them. A new probability in checks.json without its entry here would stay out of the
// holdout without anyone noticing.
test('the repo\'s bench: variants-holdout.json has only the current variant of each probability in checks.json', () => {
  const config = pluginConfig()
  const questions = parseVariants(readFileSync(join(ROOT, 'bench', 'variants-holdout.json'), 'utf8'), 'bench/variants-holdout.json', config.checks)
  assert.deepEqual(questions.map((d) => d.id), config.checks.order.filter((id) => isModelProbability(config.checks.defs[id])))
  for (const d of questions) {
    const def = config.checks.defs[d.id]
    assert.deepEqual(d.variants.map((v) => [v.name, v.fromChecks]), [['attuale', true]], d.id)
    assert.deepEqual([d.pairs, d.combinations], [[], []], d.id)
    assert.equal(d.scope, def.scope, d.id)
    // the reviewer's readout: 1 − p(none) for choices with a value, P(yes) for nouls
    assert.equal(d.variants[0].readout.text, def.value ? `1-p(${def.value.option})` : 'p', d.id)
    assert.equal(questionHash(d.variants[0].wire), questionHash(wireQuestion(def)), d.id)
  }
})

// ─── Placeholders ─────────────────────────────────────────────────────────────

test('placeholders: composed at runtime, stable per row, never left in the text', () => {
  const [line] = parseDataset(JSON.stringify({
    id: 'r1', title: 'S3 client {{SEGRETO:aws}}', labels: { hardcoded_secret: true },
    diff: newFile('src/s3.py', ['A = "{{SEGRETO:aws}}"', 'B = "{{SEGRETO:aws}}"', 'C = "{{SEGRETO:aws:2}}"', 'D = "{{SEGRETO:stripe_live}}"', '# {{SEGRETO:iniezione}}']),
  }), 'd.jsonl')
  const a = composeRow(line, 1)
  const values = [...a.diff.matchAll(/^\+[A-D] = "(.+)"$/gm)].map((m) => m[1])
  const aws = new RegExp(`^${['AK', 'IA'].join('')}[A-Z2-7]{16}$`)
  assert.ok(aws.test(values[0]), 'shape of an AWS key')
  assert.equal(values[0], values[1], 'same placeholder, same value')
  assert.notEqual(values[0], values[2], 'different discriminator, different value')
  assert.ok(a.title.includes(values[0]), 'the same value in the title too')
  assert.ok(values[3].startsWith(['sk', 'live', ''].join('_')))
  assert.ok(!a.diff.includes('{{'), 'no placeholder left')
  assert.deepEqual(composeRow(line, 1), a, 'same seed, same values')
  assert.notEqual(composeRow(line, 2).diff, a.diff)

  const withType = (t: string): unknown => composeRow({ ...line, diff: newFile('a.py', [`x = "${t}"`]) }, 1)
  assert.throws(() => withType('{{SEGRETO:madeup}}'), (e: unknown) => e instanceof InputError && /unknown secret type "madeup"/.test(e.message))
  assert.throws(() => withType('{{SEGRETO:}}'), (e: unknown) => e instanceof InputError && /malformed placeholder/.test(e.message))
})

test('dataset: malformed rows, repeated ids and invalid labels', () => {
  assert.throws(() => parseDataset('{"id":"a","diff":"x","labels":{"h":"yes"}}\n{"id":"a","diff":"x"}\nnot json\n', 'd.jsonl'), (e: unknown) =>
    e instanceof InputError && /invalid label for h/.test(e.message) && /repeated id "a"/.test(e.message) && /d\.jsonl:3: invalid JSON/.test(e.message))
  const [r] = parseDataset('{"id":"a","diff":"x","title":"t","labels":{"h":1,"k":null}}\n', 'd.jsonl')
  assert.equal(r.title, 't')
  assert.equal(r.description, null)
  assert.deepEqual(r.labels, { h: true, k: null })
})

// ─── Measurement against the fake server ──────────────────────────────────────

const SECRET_VARIANTS = {
  hardcoded_secret: {
    variants: {
      direct: { readout: 'p', question: NOUL },
      direct_inversa: { readout: 'inverse', question: { ...NOUL, instructions: 'Is the [diff] section free of credentials?' } },
      reversed: { question: { ...NOUL, instructions: 'Does the [diff] section look harmless?' } },
      flat: { question: { ...NOUL, instructions: 'Does the [diff] section change code?' } },
      kind: { readout: '1-p(none)', question: CHOICE },
      attuale: { from_checks: true },
    },
  },
  description_matches: { variants: { attuale: { from_checks: true } } },
}

const selection = (none: number, aws: number): object => ({
  type: 'choice', choice: none >= 0.5 ? 'none' : 'aws', probabilities: { aws, stripe: 1 - none - aws, none }, confidence: 0.5,
})

// p per diff: the positives (with the key) above the negatives for direct, inverse and
// kind; below for reversed; flat and attuale at the fake's default (0.02).
const SCENARIO: Scenario = {
  rules: [
    { if_state_contains: 'marker_pos1', answers: { hardcoded_secret__direct: 0.9, hardcoded_secret__direct_inversa: 0.1, hardcoded_secret__reversed: 0.1, hardcoded_secret__kind: selection(0.7, 0.2), description_matches__attuale: 0.3 } },
    { if_state_contains: 'marker_pos2', answers: { hardcoded_secret__direct: 0.8, hardcoded_secret__direct_inversa: 0.3, hardcoded_secret__reversed: 0.2, hardcoded_secret__kind: selection(0.4, 0.5) } },
    { if_state_contains: 'marker_neg1', answers: { hardcoded_secret__direct: 0.1, hardcoded_secret__direct_inversa: 0.8, hardcoded_secret__reversed: 0.8, hardcoded_secret__kind: selection(0.9, 0.05) } },
    { if_state_contains: 'marker_neg2', answers: { hardcoded_secret__direct: 0.2, hardcoded_secret__direct_inversa: 0.9, hardcoded_secret__reversed: 0.9, hardcoded_secret__kind: selection(0.95, 0.03), description_matches__attuale: 0.8 } },
  ],
}

const DATASET = [
  { id: 'pos1', title: 'feat: S3 client', description: 'Adds the S3 client.', labels: { hardcoded_secret: true, description_matches: false }, diff: newFile('src/s3.py', ['import boto3', 'KEY = "{{SEGRETO:aws}}"  # marker_pos1']) },
  { id: 'pos2', title: 'feat: payments', labels: { hardcoded_secret: true }, diff: newFile('src/payments.py', ['KEY = "{{SEGRETO:stripe_live}}"  # marker_pos2']) },
  { id: 'neg1', title: 'feat: constant', labels: { hardcoded_secret: false }, diff: newFile('src/c.py', ['x = 1  # marker_neg1']) },
  { id: 'neg2', title: 'refactor: names', description: 'Refactoring only.', labels: { hardcoded_secret: false, description_matches: true }, diff: newFile('src/d.py', ['y = 2  # marker_neg2']) },
]

test('measurement: one request per state, readouts, metrics and report', async () => {
  const { fake, options } = await prepare({ dataset: DATASET, variants: SECRET_VARIANTS, scenario: SCENARIO })
  try {
    const e = await measure(options)
    assert.equal(e.exitCode, 0)

    // 4 chunk states (the 6 chunk variants together) + 2 global ones (only the diffs
    // with a description: description_matches requires it, as in the reviewer)
    const c = bodies(fake)
    assert.equal(c.length, 6)
    const chunks = c.filter((x) => !x.state.includes('[title]'))
    const global = c.filter((x) => x.state.includes('[title]'))
    assert.equal(chunks.length, 4)
    assert.equal(global.length, 2)
    for (const x of chunks) {
      assert.ok(x.state.startsWith('[files]\n'), 'chunk state, without title or description')
      assert.deepEqual(Object.keys(x.questions).sort(), Object.keys(SECRET_VARIANTS.hardcoded_secret.variants).map((v) => `hardcoded_secret__${v}`).sort())
    }
    for (const x of global) assert.deepEqual(Object.keys(x.questions), ['description_matches__attuale'])

    // the secret goes out composed, and never comes out in the outputs
    const state = chunks.find((x) => x.state.includes('marker_pos1'))?.state ?? ''
    const key = new RegExp(`${['AK', 'IA'].join('')}[A-Z2-7]{16}`).exec(state)?.[0]
    assert.ok(key !== undefined, 'key composed in the state')
    assert.ok(!state.includes('{{'), 'no placeholder in the state')
    const report = readFileSync(e.report, 'utf8')
    const rawText = readFileSync(e.raw, 'utf8')
    for (const t of [report, rawText]) {
      assert.ok(!t.includes(key), 'the composed key does not appear in the outputs')
      assert.ok(!t.includes('marker_pos1'), 'the diff lines do not appear in the outputs')
    }

    // raw rows: one row per diff and variant asked (4 × 6 chunk + 2 global)
    const g = raw(e.raw)
    assert.equal(g.length, 26)
    const line = (id: string, variant: string, question = 'hardcoded_secret'): RawRow =>
      g.find((x) => x.id === id && x.variant === variant && x.question === question) as RawRow
    near(line('pos1', 'kind').p, 0.3, '1 − p(none)')
    near(line('pos1', 'kind').raw, 0.7)
    near(line('neg2', 'direct_inversa').p, 0.1, '1 − P(yes)')
    assert.equal(line('pos1', 'direct').label, true)
    assert.equal(line('neg1', 'direct').label, false)
    assert.equal(line('neg2', 'attuale', 'description_matches').label, true)
    assert.equal(g.filter((x) => x.question === 'description_matches').length, 2)
    for (const x of g) {
      assert.equal(x.repeat, 1)
      assert.equal(typeof x.ms, 'number')
      assert.equal(x.error, undefined)
    }
    assert.deepEqual(e.rows, g)

    // report: metadata at the top, a table ordered by AUROC with the best one highlighted
    const sha = createHash('sha256').update(readFileSync(options.dataset)).digest('hex')
    assert.match(report, /^# Question measurement\n/)
    assert.ok(report.includes(`- Date: ${DATE}`))
    assert.ok(report.includes('`fake-fp-1`'), 'backend fingerprint')
    assert.ok(report.includes('`rizzo-spark-x2.5-4b-bf16`'), 'declared model')
    assert.ok(report.includes(sha), 'dataset hash')
    const section = report.slice(report.indexOf('## hardcoded_secret'), report.indexOf('## description_matches'))
    const lines = section.split('\n').filter((l) => l.startsWith('| ') && !l.includes('| variant |'))
    const names = lines.map((l) => l.split(' | ')[1].replace(/\*/g, ''))
    assert.deepEqual(names, ['direct', 'direct + direct_inversa', 'direct_inversa', 'kind', 'attuale', 'flat', 'reversed'])
    assert.match(lines[0], /^\| ★ \| \*\*direct\*\* \| `p` \| \*\*1\.000\*\* \| 0\.850 \| 0\.150 \| 0\.700 \|/)
    // mean in logit: pos2 = σ((logit 0.8 + logit 0.7)/2) = 0.753; neg1 and neg2 = 1/7
    assert.match(lines[1], /\| `mean` \| 1\.000 \| 0\.827 \| 0\.143 \|/)
    assert.match(lines[3], /\| kind \| `1-p\(none\)` \| 1\.000 \| 0\.450 \| 0\.075 \|/)
    assert.match(lines[5], /\| flat \| `p` \| 0\.500 \|/)
    assert.match(lines[6], /\| reversed \| `p` \| 0\.000 \|/)
    assert.match(report, /\| hardcoded_secret \| chunk state \| direct \| `p` \| 1\.000 \| 0\.700 \| 1\.000 \| 2 \| 2 \|/)
    assert.match(report, /\| description_matches \| global state \| attuale \| `p` \| 1\.000 \| 0\.500 \| 1\.000 \| 1 \| 1 \|/)
    assert.match(report, /2 questions not asked because the diff has no description/)

    // a second measurement in the same directory does not wipe out the first
    await assert.rejects(measure(options), (err: unknown) => err instanceof InputError && /already contains a measurement/.test(err.message))
  } finally {
    await fake.close()
  }
})

test('measurement: over 64 variants, several requests on the same state', async () => {
  const variants: Record<string, object> = {}
  for (let i = 0; i < 70; i++) variants[`v${String(i).padStart(2, '0')}`] = { question: { ...NOUL, instructions: `${NOUL.instructions} (${i})` } }
  const { fake, options } = await prepare({
    dataset: [{ id: 'only', labels: { hardcoded_secret: false }, diff: newFile('src/a.py', ['x = 1']) }],
    variants: { hardcoded_secret: { variants } },
  })
  try {
    const e = await measure(options)
    assert.equal(e.exitCode, 0)
    const c = bodies(fake)
    assert.deepEqual(c.map((x) => Object.keys(x.questions).length), [64, 6])
    assert.equal(c[0].state, c[1].state)
    const g = raw(e.raw)
    assert.equal(g.length, 70)
    for (const x of g) near(x.p, 0.02)
  } finally {
    await fake.close()
  }
})

test('measurement: the states are those review() sends, even with several chunks', async () => {
  const long = Array.from({ length: 400 }, (_, i) => `value_${i} = compute(${i}, "${'x'.repeat(20)}")`)
  const diff = newFile('src/auth/session.py', ['def log_in(user):', '    return user.ok']) + newFile('src/long.py', long)
  const title = 'feat: sessions'
  const description = 'Adds sessions.\nAnd a long module.'
  const config = pluginConfig()
  const s = statesOf({ id: 'x', diff, title, description, labels: {} }, config)
  assert.ok(s.chunks.length > 1, 'the diff must be split into several chunks')

  const { fake, options } = await prepare({
    dataset: [{ id: 'large', title, description, labels: {}, diff }],
    variants: { hardcoded_secret: { variants: { attuale: { from_checks: true } } }, description_matches: { variants: { attuale: { from_checks: true } } } },
  })
  const reviewed = await startFake({ mode: 'rizzo' })
  try {
    await measure(options)
    const port = new URL(reviewed.url).port
    const r = await review({ diff, title, description, origin: 'hook' }, config, {
      transport: nodeTransport(), clock: nodeClock, seed: 1,
      backend: { url: `${reviewed.url}/v1/systemone`, key: '', model: 'jev-latest', local: true, host: `127.0.0.1:${port}` },
    })
    assert.equal(r.outcome, 'ok')
    const measured = bodies(fake).map((x) => x.state).sort()
    const sent = bodies(reviewed).map((x) => x.state).sort()
    assert.equal(sent.length, s.chunks.length + 1)
    assert.deepEqual(measured, sent)
  } finally {
    await fake.close()
    await reviewed.close()
  }
})

test('measurement: a backend error stops it, and the report says so', async () => {
  const { fake, options } = await prepare({
    dataset: DATASET, variants: SECRET_VARIANTS, scenario: { always: { http: 401 } },
  })
  try {
    const e = await measure(options)
    assert.equal(e.exitCode, 1)
    assert.equal(bodies(fake).length, 1, 'after a 401 nothing else goes out')
    const report = readFileSync(e.report, 'utf8')
    assert.match(report, /\*\*Measurement interrupted\*\*: auth:/)
    const g = raw(e.raw)
    assert.ok(g.length > 0 && g.every((x) => x.p === null && typeof x.error === 'string'))
  } finally {
    await fake.close()
  }
})

test('measurement: an unknown placeholder stops everything before sending', async () => {
  const { fake, options } = await prepare({
    dataset: [{ id: 'a', labels: {}, diff: newFile('src/a.py', ['x = "{{SEGRETO:dunno}}"']) }],
    variants: SECRET_VARIANTS,
  })
  try {
    await assert.rejects(measure(options), (err: unknown) => err instanceof InputError && /unknown secret type "dunno"/.test(err.message))
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

// ─── Command line ─────────────────────────────────────────────────────────────

function launch(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok, ko) => {
    // an environment from scratch: no real key or URL reaches the process
    const env = { PATH: process.env.PATH, HOME: base, TMPDIR: tmpdir() }
    const p = spawn(process.execPath, [SCRIPT, ...args], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (s: string) => { out += s })
    p.stderr.on('data', (s: string) => { err += s })
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000)
    p.on('error', ko)
    p.on('close', (code) => {
      clearTimeout(timer)
      ok({ code: code ?? -1, out, err })
    })
  })
}

test('command line: node scripts/measure-questions.ts', async () => {
  const { fake, options } = await prepare({ dataset: DATASET, variants: SECRET_VARIANTS, scenario: SCENARIO })
  try {
    const args = ['--dataset', options.dataset, '--variants', options.variants, '--url', fake.url, '--out', options.out, `--date=${DATE}`]
    const a = await launch(args)
    assert.equal(a.code, 0, a.err)
    assert.equal(a.out, `${join(options.out, 'report.md')}\n${join(options.out, 'raw.jsonl')}\n`)
    assert.match(a.err, /\[1\/1\] 4\/4 neg2: 2 requests/)
    assert.ok(readFileSync(join(options.out, 'report.md'), 'utf8').includes(`- Date: ${DATE}`))

    const b = await launch(args)
    assert.equal(b.code, 2)
    assert.match(b.err, /already contains a measurement/)
    const c = await launch([...args, '--overwrite', '--repeats', '2'])
    assert.equal(c.code, 0, c.err)
    assert.match(readFileSync(join(options.out, 'report.md'), 'utf8'), /Δ rep\./)
    assert.equal(raw(join(options.out, 'raw.jsonl')).length, 52)

    const d = await launch(['--out', options.out, '--api-key', 'x'])
    assert.equal(d.code, 2)
    assert.match(d.err, /the key is not passed as a flag/)
    assert.ok(!d.err.includes(' x\n'))
  } finally {
    await fake.close()
  }
})

test('withSharedLabels: a second reading takes the label of the question it reads again, unless the row has its own', () => {
  const { checks } = pluginConfig()
  const rows = parseDataset([
    JSON.stringify({ id: 'a', diff: 'x', labels: { weakens_tests: true } }),
    JSON.stringify({ id: 'b', diff: 'x', labels: { weakens_tests: true, weakens_expected: false } }),
    JSON.stringify({ id: 'c', diff: 'x', labels: { hardcoded_secret: true } }),
  ].join('\n'), 'd.jsonl')
  const [a, b, c] = withSharedLabels(rows, checks)
  assert.equal(a.labels.weakens_expected, true)
  assert.equal(b.labels.weakens_expected, false)
  assert.equal(c.labels.weakens_expected, undefined)
  // the rows it was given stay as they were
  assert.equal(rows[0].labels.weakens_expected, undefined)
})
