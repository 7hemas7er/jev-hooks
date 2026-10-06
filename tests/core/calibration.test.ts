import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateNoul, calibrate, calibrateDerived, consistentHashes, derivedOption, derivedProbability, restorePolarity, chooseProfile, profileThreshold,
  ruleThreshold, SERVER_CALIBRATED_STATUS, applyTemperature, scaledThreshold, thresholdScales, withThresholdScales,
} from '../../src/core/calibration.ts'
import { compare, evaluateRule } from '../../src/core/verdict.ts'
import { canonical } from '../../src/core/canonical.ts'
import { validateCalibration, validateChecks, validatePolicy } from '../../src/core/config.ts'
import { formatNumber } from '../../src/core/numbers.ts'
import { questionHash } from '../../src/core/systemone.ts'
import type { Calibration, WireQuestion, Result, Identity, Json, Profile, Answer, DerivedValue, ProfileSelection, Op, CheckValue, Rule } from '../../src/core/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

function valueOf<T>(e: Result<T>): T {
  if (!e.ok) assert.fail(`expected ok, found: ${e.error.message}`)
  return e.value
}

const CHECKS = valueOf(validateChecks(json('config/checks.json'), 'checks.json'))
const POLICY = valueOf(validatePolicy(json('config/policy.json'), CHECKS, 'policy.json'))
const CALIB = valueOf(validateCalibration(json('config/calibration.json'), 'calibration.json'))

// The questions as they go out to the backend: only type, instructions and criteria.
function wire(id: string): WireQuestion {
  const d = CHECKS.defs[id]
  const w: WireQuestion = { type: d.type, instructions: d.instructions as WireQuestion['instructions'] }
  if (d.criteria !== undefined) w.criteria = d.criteria
  return w
}

// sha256 computed independently (node:crypto) on the same canonical form
function shaWire(w: WireQuestion): string {
  const o: { [k: string]: Json } = { type: w.type, instructions: w.instructions }
  if (w.criteria !== undefined) o.criteria = w.criteria
  return createHash('sha256').update(canonical(o), 'utf8').digest('hex')
}

const RIZZO: Identity = { host: '192.168.1.50', model: 'rizzo-spark-x2.5-4b-bf16', fingerprint: 'fake-fp-1', family: 'rizzo' }
const JEV: Identity = { host: 'api.typesafe.ai', model: 'jev-1.13.0', family: 'typesafe' }
const OTHER: Identity = { host: 'llm.example.org', model: 'something-7b', family: 'other' }

const noul = (p: number): Answer => ({ type: 'noul', noul: p })
const gte = (check: string, value: number): Rule => ({ check, op: 'gte', value })
const pick = (e: { fires: boolean; source: string; onRaw: boolean } | undefined): unknown => e && { fires: e.fires, source: e.source, onRaw: e.onRaw }
const pNoul = (r: Answer): number => {
  assert.equal(r.type, 'noul')
  return r.type === 'noul' ? r.noul : Number.NaN
}

// A user calibration.json with a calibrated profile first.
function withCalibrated(calibrated: Record<string, unknown>): Calibration {
  const base = json('config/calibration.json') as { profiles: unknown[] }
  return valueOf(validateCalibration({ ...base, profiles: [calibrated, ...base.profiles] }, 'calibration.json'))
}

const CALIBRATED = {
  name: 'spark-bf16-2026-10', match: { fingerprint: 'fake-fp-1' }, calibrated: true,
  noul: { a: 0.31, b: -0.2 }, choice: { t: 2.8 }, score: { t: 2.5 },
  per_question: { hardcoded_secret: { sha256: shaWire(wire('hardcoded_secret')), a: 0.29, b: -0.4, n: 312, errors: 17 } },
  thresholds: { hardcoded_secret: 0.62 }, band_delta_logit: 0.5,
}

// ─── Platt and temperature ─────────────────────────────────────────────────────

// The old rizzo-provisional (a = 1/3, T ≈ 3): the design numbers remain the test of
// the Platt, even though the plugin's profile no longer applies it.
const THIRD: Profile = { name: 'third', match: {}, calibrated: false, noul: { a: 0.3333, b: 0 }, choice: { t: 3 }, score: { t: 3 } }
const withThird = (): Calibration => ({ wide_delta_logit: 1.39, profiles: [THIRD], file: 'third.json' })
const SPARK: Identity = { ...RIZZO, fingerprint: '64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a' }

test('Platt with a = 1/3: the design numbers', () => {
  const s = chooseProfile(withThird(), RIZZO, POLICY.band)
  assert.equal(s.profile.name, 'third')
  const cal = (p: number): number => pNoul(calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(p), s).response)
  assert.equal(formatNumber(cal(0.997), 3), '0.874')
  assert.equal(formatNumber(cal(0.9), 3), '0.675')
  assert.equal(formatNumber(cal(0.5), 3), '0.500')
  assert.equal(formatNumber(cal(0.02), 3), '0.215')
  assert.equal(formatNumber(cal(0.98), 3), '0.785')
  assert.equal(calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.9), s).tier, 'type')
})

test('Platt with the logit clipped at ±36: exact 0 and 1 stay finite and inside (0, 1)', () => {
  const plattIdentity: Profile = { name: 'one', match: {}, calibrated: false, noul: { a: 1, b: 0 } }
  const s = chooseProfile({ wide_delta_logit: 1.39, profiles: [plattIdentity], file: 'x' }, OTHER, POLICY.band)
  const w = wire('hardcoded_secret')
  const high = pNoul(calibrate('hardcoded_secret', w, noul(1), s).response)
  const low = pNoul(calibrate('hardcoded_secret', w, noul(0), s).response)
  assert.ok(high < 1 && high > 0.999999, `${high}`)
  assert.ok(low > 0 && low < 1e-15, `${low}`)
  assert.equal(high, 1 / (1 + Math.exp(-36)))
  // with a = 1/3 the extreme becomes σ(12): far from 1, as the calibration fit wants
  const r = chooseProfile(withThird(), RIZZO, POLICY.band)
  const one = pNoul(calibrate('hardcoded_secret', w, noul(1), r).response)
  assert.ok(Math.abs(one - 1 / (1 + Math.exp(-0.3333 * 36))) < 1e-15)
})

test('rizzo profiles in the plugin: the measured Spark is calibrated per question, any other rizzo keeps the raw p', () => {
  // the measured Spark is recognized by its fingerprint, every other rizzo by the prefix
  const spark = chooseProfile(CALIB, SPARK, POLICY.band)
  assert.equal(spark.profile.name, 'spark-bf16-2026-09')
  assert.equal(spark.profile.calibrated, true)
  assert.ok(!spark.notes.some((n) => n.startsWith('thresholds not calibrated')), JSON.stringify(spark.notes))
  // a fitted question: its Platt, per question
  const fitted = calibrateDerived('injection_risk', wire('injection_risk'), 0.9, spark)
  const e = spark.profile.per_question?.injection_risk
  assert.equal(fitted.tier, 'question')
  assert.ok(Math.abs(fitted.p - 1 / (1 + Math.exp(-((e?.a ?? 0) * Math.log(9) + (e?.b ?? 0))))) < 1e-12)
  const other = chooseProfile(CALIB, RIZZO, POLICY.band)
  assert.equal(other.profile.name, 'rizzo-provisional')
  assert.equal(calibrateDerived('injection_risk', wire('injection_risk'), 0.9, other).p, 0.9)
  // hardcoded_secret keeps its raw p on both: the fit made the holdout worse
  for (const s of [spark, other]) {
    for (const p of [0.02, 0.5, 0.874, 0.997]) {
      const out = calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(p), s)
      assert.deepEqual([pNoul(out.response), out.tier, out.note], [p, 'identity', undefined], `${s.profile.name} ${p}`)
    }
  }
  // plain choices (primary_concern) keep the temperature 3
  const c: Answer = { type: 'choice', choice: 'nothing', probabilities: { secret: 0.1, nothing: 0.9 }, confidence: 0.8 }
  const out = calibrate('primary_concern', wire('primary_concern'), c, spark)
  assert.deepEqual(out.response.type === 'choice' && out.response.probabilities, applyTemperature(c.probabilities, 3))
})

test('temperature: p^(1/t) normalized, order kept, zeros clipped at e⁻³⁶', () => {
  const t3 = applyTemperature({ a: 0.9, b: 0.1 }, 3)
  const za = Math.cbrt(0.9)
  const zb = Math.cbrt(0.1)
  assert.ok(Math.abs(t3.a - za / (za + zb)) < 1e-12)
  assert.ok(Math.abs(t3.b - zb / (za + zb)) < 1e-12)
  const one = applyTemperature({ x: 0.25, y: 0.75 }, 1)
  assert.ok(Math.abs(one.x - 0.25) < 1e-12 && Math.abs(one.y - 0.75) < 1e-12)
  const zero = applyTemperature({ yes: 1, no: 0 }, 3)
  assert.ok(zero.no > 0, 'a probability of 0 does not stay exactly 0')
  assert.ok(Math.abs(zero.no - Math.exp(-12) / (1 + Math.exp(-12))) < 1e-15)
  assert.deepEqual(Object.keys(applyTemperature({ c: 0.2, a: 0.5, b: 0.3 }, 2)), ['c', 'a', 'b'])
  const sum = Object.values(applyTemperature({ a: 0.7, b: 0.2, c: 0.1 }, 0.5)).reduce((x, y) => x + y, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12)
})

test('choice: argmax and confidence (n·p′max − 1)/(n − 1) on the scaled probabilities', () => {
  const s = chooseProfile(CALIB, RIZZO, POLICY.band)
  const prob = { secret: 0.02, nothing: 0.9, hygiene: 0.08 }
  const r: Answer = { type: 'choice', choice: 'nothing', probabilities: prob, confidence: 0.85 }
  const out = calibrate('primary_concern', wire('primary_concern'), r, s)
  assert.equal(out.tier, 'type')
  assert.equal(out.response.type, 'choice')
  if (out.response.type !== 'choice') return
  const expected = applyTemperature(prob, 3)
  assert.deepEqual(out.response.probabilities, expected)
  assert.equal(out.response.choice, 'nothing')
  assert.ok(Math.abs(out.response.confidence - (3 * expected.nothing - 1) / 2) < 1e-12)
  assert.equal(r.probabilities, prob, 'the raw answer is not touched')
  assert.equal(r.confidence, 0.85)
})

test('score: Σ k·p′_k recomputed, the backend\'s legend kept, keys in any order', () => {
  const s = chooseProfile(CALIB, RIZZO, POLICY.band)
  const legend = { '0': 'no change', '1': 'local', '2': 'cross-cutting', '3': 'infrastructure' }
  const prob = { '2': 0.005, '0': 0.97, '3': 0.005, '1': 0.02 }
  const r: Answer = { type: 'score', score: 0.045, legend, probabilities: prob, confidence: 0.96 }
  const out = calibrate('blast_radius', wire('blast_radius'), r, s)
  assert.equal(out.response.type, 'score')
  if (out.response.type !== 'score') return
  const p = applyTemperature(prob, 3)
  const expected = 0 * p['0'] + 1 * p['1'] + 2 * p['2'] + 3 * p['3']
  assert.ok(Math.abs(out.response.score - expected) < 1e-12, `${out.response.score} ≠ ${expected}`)
  assert.ok(out.response.score > r.score, 'the temperature moves mass away from the extremes')
  assert.deepEqual(out.response.legend, legend)
  assert.ok(Math.abs(out.response.confidence - (4 * p['0'] - 1) / 3) < 1e-12)
})

test('profile without blocks (jev): identity, answer unchanged', () => {
  const s = chooseProfile(CALIB, JEV, POLICY.band)
  assert.equal(s.profile.name, 'jev')
  const out = calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.997), s)
  assert.deepEqual(out, { response: noul(0.997), tier: 'identity' })
  const c: Answer = { type: 'choice', choice: 'auth', probabilities: { auth: 0.6, nothing: 0.4 }, confidence: 0.2 }
  assert.deepEqual(calibrate('primary_concern', wire('primary_concern'), c, s).response, c)
})

// ─── invert ────────────────────────────────────────────────────────────────────

test('invert: the sent question is calibrated, then 1 − p is reported (design numbers, with a = 1/3)', () => {
  const s = chooseProfile(withThird(), RIZZO, POLICY.band)
  const sent = pNoul(calibrate('adds_tests', wire('adds_tests'), noul(0.99), s).response)
  assert.equal(formatNumber(sent, 3), '0.822')
  const v = aggregateNoul([{ chunk: 0, files: [], p: sent, raw: 0.99 }], { invert: true, perChunk: false })
  assert.ok(v)
  assert.equal(formatNumber(v.value, 3), '0.178')
  assert.ok(Math.abs((v.raw ?? Number.NaN) - 0.01) < 1e-12, 'the raw value is on the reported scale too')
  assert.equal(v.source, 'model')
  assert.equal(v.perChunk, undefined)
  assert.equal(restorePolarity(0.3, false), 0.3)
  assert.equal(restorePolarity(0.3, true), 0.7)
})

test('aggregateNoul: maximum over the chunks of the sent question, perChunk and worst kept', () => {
  const chunks = [
    { chunk: 0, files: ['a.py'], p: 0.3, raw: 0.9 },
    { chunk: 1, files: ['b.py', 'c.py'], p: 0.8, raw: 0.999 },
    { chunk: 2, files: ['d.py'], p: 0.1, raw: 0.5 },
  ]
  const v = aggregateNoul(chunks, { invert: false, perChunk: true })
  assert.deepEqual(v, {
    value: 0.8, raw: 0.999, source: 'model', worst: ['b.py', 'c.py'],
    perChunk: chunks.map((x) => ({ chunk: x.chunk, files: x.files, p: x.p, raw: x.raw })),
  })
  // inverted: the worst chunk is the one with the lowest reported value
  const inv = aggregateNoul(chunks, { invert: true, perChunk: true })
  assert.ok(inv)
  assert.ok(Math.abs(inv.value - 0.2) < 1e-12)
  assert.deepEqual(inv.worst, ['b.py', 'c.py'])
  assert.ok(Math.abs((inv.perChunk?.[0].p ?? 0) - 0.7) < 1e-12)
  assert.equal(aggregateNoul([], { invert: false, perChunk: true }), undefined)
  assert.equal(aggregateNoul([{ chunk: 0, files: [], p: Number.NaN, raw: 0.5 }], { invert: false, perChunk: true }), undefined)
})

test('aggregateNoul with counts: the maximum and perChunk over the counted chunks; with none counted, every chunk', () => {
  const chunks = [
    { chunk: 1, files: ['tests/a.test.ts'], p: 0.2, raw: 0.2 },
    { chunk: 2, files: ['src/a.ts'], p: 0.9, raw: 0.9 },
    { chunk: 3, files: ['src/b.ts', 'tests/b.test.ts'], p: 0.4, raw: 0.4 },
  ]
  const counts = (files: readonly string[]): boolean => files.some((f) => f.startsWith('tests/'))
  const v = aggregateNoul(chunks, { invert: false, perChunk: true, counts })
  assert.deepEqual(v, {
    value: 0.4, raw: 0.4, source: 'model', worst: ['src/b.ts', 'tests/b.test.ts'],
    perChunk: [chunks[0], chunks[2]].map((x) => ({ chunk: x.chunk, files: x.files, p: x.p, raw: x.raw })),
  })
  const none = aggregateNoul(chunks, { invert: false, perChunk: true, counts: () => false })
  assert.equal(none?.value, 0.9)
  assert.equal(none?.perChunk?.length, 3)
  // a counted chunk without a finite p does not hide the others
  const nan = aggregateNoul([{ chunk: 1, files: ['tests/a.test.ts'], p: Number.NaN, raw: 0.5 }, chunks[1]], { invert: false, perChunk: true, counts })
  assert.equal(nan?.value, 0.9)
})

// ─── Choice with a value ──────────────────────────────────────────────────────

// A choice with none first, like the ones measured on the bench, and its value.
const CHOICE: WireQuestion = {
  type: 'choice',
  instructions: 'Which string-building pattern appears in an added line of the [diff] section?',
  criteria: { none: 'Only safe or unrelated code.', sql: 'A variable glued into SQL.', shell: 'A variable glued into a shell command.' },
}
const MINUS_NONE: DerivedValue = { kind: 'one_minus', option: 'none' }
const sigma = (z: number): number => 1 / (1 + Math.exp(-z))
const logit = (p: number): number => Math.log(p / (1 - p))

test('choice with a value: 1 − p(none) and the most probable option among the others', () => {
  assert.ok(Math.abs((derivedProbability(MINUS_NONE, { none: 0.7, sql: 0.2, shell: 0.1 }) ?? Number.NaN) - 0.3) < 1e-12)
  assert.equal(derivedProbability(MINUS_NONE, { none: 1, sql: 0, shell: 0 }), 0)
  assert.equal(derivedProbability(MINUS_NONE, { sql: 0.5, shell: 0.5 }), undefined, 'option missing')
  assert.equal(derivedProbability(MINUS_NONE, { none: Number.NaN, sql: 0.5 }), undefined)
  // the subtracted option is never the detail, even when it is the most probable
  assert.equal(derivedOption(MINUS_NONE, { none: 0.9, sql: 0.03, shell: 0.07 }), 'shell')
  // on a tie the first in the order of the options wins
  assert.equal(derivedOption(MINUS_NONE, { none: 0.5, sql: 0.25, shell: 0.25 }), 'sql')
  assert.equal(derivedOption(MINUS_NONE, { none: 1 }), undefined)
  assert.equal(derivedOption(MINUS_NONE, { none: 1, sql: 0, shell: 0 }), undefined, 'zero probability: no detail')
})

test('choice with a value: calibrated like a noul on the logit of 1 − p(none), not with the choices\' temperature', () => {
  // a profile with noul a = 1/3 and choice t = 3: the noul block applies
  const r = chooseProfile(withThird(), RIZZO, POLICY.band)
  const x = calibrateDerived('pattern', CHOICE, 0.997, r)
  assert.equal(x.tier, 'type')
  assert.equal(x.note, undefined)
  const a = r.profile.noul?.a ?? Number.NaN
  assert.ok(Math.abs(x.p - sigma(a * logit(0.997))) < 1e-12, `${x.p}`)
  assert.equal(formatNumber(calibrateDerived('pattern', CHOICE, 0.02, r).p, 3), formatNumber(sigma(a * logit(0.02)), 3))
  // the clip at ±36: 1 − p(none) = exactly 1 stays inside (0, 1)
  assert.ok(Math.abs(calibrateDerived('pattern', CHOICE, 1, r).p - sigma(a * 36)) < 1e-15)
  assert.ok(calibrateDerived('pattern', CHOICE, 0, r).p > 0)
  // profile without blocks (jev): identity
  assert.deepEqual(calibrateDerived('pattern', CHOICE, 0.42, chooseProfile(CALIB, JEV, POLICY.band)), { p: 0.42, tier: 'identity' })
  // server-side calibration: identity, no double calibration
  const server = chooseProfile(CALIB, { ...RIZZO, probabilityStatus: [SERVER_CALIBRATED_STATUS] }, POLICY.band)
  assert.deepEqual(calibrateDerived('pattern', CHOICE, 0.9, server), { p: 0.9, tier: 'identity' })
})

test('choice with a value: the per-question entry (Platt or temperature) applies only to the calibrated text', () => {
  const sha = questionHash(CHOICE)
  const platt = chooseProfile(withCalibrated({ ...CALIBRATED, per_question: { pattern: { sha256: sha, a: 0.5, b: 0.25 } } }), RIZZO, POLICY.band)
  const x = calibrateDerived('pattern', CHOICE, 0.9, platt)
  assert.equal(x.tier, 'question')
  assert.ok(Math.abs(x.p - sigma(0.5 * logit(0.9) + 0.25)) < 1e-12)
  // an entry with only a temperature: σ(z/t) on the value's logit
  const temp = chooseProfile(withCalibrated({ ...CALIBRATED, per_question: { pattern: { sha256: sha, t: 2 } } }), RIZZO, POLICY.band)
  const y = calibrateDerived('pattern', CHOICE, 0.9, temp)
  assert.equal(y.tier, 'question')
  assert.ok(Math.abs(y.p - sigma(logit(0.9) / 2)) < 1e-12)
  // sha of another text: the entry is ignored with the note, the profile's noul block applies
  const stale = chooseProfile(withCalibrated({ ...CALIBRATED, per_question: { pattern: { sha256: '0'.repeat(64), a: 5 } } }), RIZZO, POLICY.band)
  const z = calibrateDerived('pattern', CHOICE, 0.9, stale)
  assert.equal(z.tier, 'type')
  assert.equal(z.note, 'question pattern changed after the calibration fit: thresholds not calibrated for this question')
  assert.ok(Math.abs(z.p - sigma(0.31 * logit(0.9) - 0.2)) < 1e-12)
})

test('choice with a value: aggregated like a noul, with the option of the worst chunk', () => {
  const chunks = [
    { chunk: 0, files: ['a.py'], p: 0.2, raw: 0.6, option: 'shell' },
    { chunk: 1, files: ['b.py'], p: 0.8, raw: 0.99, option: 'sql' },
  ]
  const v = aggregateNoul(chunks, { invert: false, perChunk: true })
  assert.ok(v)
  assert.equal(v.value, 0.8)
  assert.equal(v.option, 'sql')
  assert.deepEqual(v.worst, ['b.py'])
  // perChunk keeps the ChunkValue shape, without the option
  assert.deepEqual(v.perChunk?.map((x) => Object.keys(x).sort()), [['chunk', 'files', 'p', 'raw'], ['chunk', 'files', 'p', 'raw']])
  // invert: 1 − p is reported, and the worst chunk stays that of the sent question
  const inv = aggregateNoul(chunks, { invert: true, perChunk: false })
  assert.ok(inv)
  assert.ok(Math.abs(inv.value - 0.2) < 1e-12)
  assert.equal(inv.option, 'sql')
})

// ─── Profile choice ───────────────────────────────────────────────────────────

test('profile choice: a fingerprint profile first, before the prefix, then model, then host', () => {
  const c = withCalibrated(CALIBRATED)
  assert.equal(chooseProfile(c, RIZZO, POLICY.band).profile.name, 'spark-bf16-2026-10')
  assert.equal(chooseProfile(c, { ...RIZZO, fingerprint: 'other-fp' }, POLICY.band).profile.name, 'rizzo-provisional')
  assert.equal(chooseProfile(c, { ...RIZZO, fingerprint: undefined }, POLICY.band).profile.name, 'rizzo-provisional')
  assert.equal(chooseProfile(c, JEV, POLICY.band).profile.name, 'jev')
  assert.equal(chooseProfile(c, OTHER, POLICY.band).profile.name, 'unknown')
  // CLM: its own name and note, with the unknown backend's wide band until it is measured
  const clm = chooseProfile(c, { host: '192.168.1.50:8700', model: 'clm-latest', family: 'other' }, POLICY.band)
  assert.equal(clm.profile.name, 'clm-provisional')
  assert.equal(clm.profile.calibrated, false)
  assert.equal(clm.profile.band_delta_logit, chooseProfile(c, OTHER, POLICY.band).profile.band_delta_logit)
  // host: every match field must hold, and the host is case-insensitive
  const perHost: Calibration = {
    wide_delta_logit: 1.39, file: 'c.json',
    profiles: [
      { name: 'spark', match: { host: 'Spark.Local', model_prefix: 'rizzo-' }, calibrated: false },
      { name: 'rest', match: {}, calibrated: false },
    ],
  }
  assert.equal(chooseProfile(perHost, { ...RIZZO, host: 'spark.local' }, POLICY.band).profile.name, 'spark')
  assert.equal(chooseProfile(perHost, { ...JEV, host: 'spark.local' }, POLICY.band).profile.name, 'rest')
})

test('no profile matches: identity, the policy band and a note', () => {
  const rizzoOnly: Calibration = { wide_delta_logit: 1.39, file: 'user.json', profiles: CALIB.profiles.filter((x) => x.name === 'rizzo-provisional') }
  const s = chooseProfile(rizzoOnly, JEV, POLICY.band)
  assert.equal(s.profile.calibrated, false)
  assert.equal(s.mode, 'client')
  assert.equal(s.deltaLogit, POLICY.band.delta_logit)
  assert.ok(s.notes.some((n) => n.includes('no profile in user.json')), s.notes.join(' | '))
  assert.equal(calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.9), s).tier, 'identity')
})

test('δ: the unknown profile\'s band_delta_logit applies even with calibrated false', () => {
  const s = chooseProfile(CALIB, OTHER, POLICY.band)
  assert.equal(s.profile.name, 'unknown')
  assert.equal(s.profile.calibrated, false)
  assert.equal(s.deltaLogit, 1.39)
  assert.ok(s.notes.includes('thresholds not calibrated for this backend (profile unknown)'))
  // rizzo-provisional does not redefine the band: the policy's applies
  assert.equal(chooseProfile(CALIB, RIZZO, POLICY.band).deltaLogit, 0.62)
  assert.equal(chooseProfile(CALIB, RIZZO, { delta_logit: 0.3 }).deltaLogit, 0.3)
  // a calibrated profile with its own band imposes it
  assert.equal(chooseProfile(withCalibrated(CALIBRATED), RIZZO, POLICY.band).deltaLogit, 0.5)
})

test('server mode only with probability_status exactly temperature_scaled…: identity and wide_delta_logit', () => {
  const id: Identity = { ...RIZZO, probabilityStatus: [SERVER_CALIBRATED_STATUS] }
  const s = chooseProfile(CALIB, id, POLICY.band)
  assert.equal(s.mode, 'server')
  assert.equal(s.profile.name, 'rizzo-provisional')
  assert.equal(s.deltaLogit, CALIB.wide_delta_logit)
  assert.ok(s.notes.includes('server-side calibration: thresholds not calibrated'))
  const out = calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.997), s)
  assert.deepEqual(out, { response: noul(0.997), tier: 'identity' })
  // even a calibrated profile loses its thresholds: they are measured on the client's calibration
  const t = chooseProfile(withCalibrated(CALIBRATED), id, POLICY.band)
  assert.equal(t.mode, 'server')
  assert.equal(t.profile.calibrated, false)
  assert.deepEqual(profileThreshold('hardcoded_secret', 0.7, t, true), { value: 0.7, source: 'policy' })
  // and no transformation, even with a profile that has one for every type and per
  // question: the server has already calibrated, and the client does not calibrate a
  // second time. rizzo-provisional no longer has a Platt on the noul: with it the
  // identity would come anyway, and the assertion above would not see a double
  // calibration.
  assert.deepEqual(calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.997), t), { response: noul(0.997), tier: 'identity' })
  assert.deepEqual(calibrate('injection_risk', wire('injection_risk'), noul(0.9), t), { response: noul(0.9), tier: 'identity' })
  const selection: Answer = { type: 'choice', choice: 'nothing', probabilities: { secret: 0.1, nothing: 0.9 }, confidence: 0.8 }
  assert.deepEqual(calibrate('primary_concern', wire('primary_concern'), selection, t), { response: selection, tier: 'identity' })
  assert.deepEqual(calibrateDerived('injection_risk', wire('injection_risk'), 0.9, t), { p: 0.9, tier: 'identity' })
})

test('mixed statuses: client mode, uncalibrated profile and a "partial server-side calibration" note', () => {
  const id: Identity = { ...RIZZO, probabilityStatus: [SERVER_CALIBRATED_STATUS, 'uncalibrated_temperature_1'] }
  const s = chooseProfile(withCalibrated(CALIBRATED), id, POLICY.band)
  assert.equal(s.mode, 'client')
  assert.equal(s.profile.name, 'spark-bf16-2026-10')
  assert.equal(s.profile.calibrated, false)
  assert.ok(s.notes.includes('partial server-side calibration: serve rizzo without --calibration'), s.notes.join(' | '))
  assert.ok(s.notes.includes('thresholds not calibrated for this backend (profile spark-bf16-2026-10)'))
  assert.deepEqual(profileThreshold('hardcoded_secret', 0.7, s, true), { value: 0.7, source: 'policy' })
  // the transformations apply anyway
  assert.equal(calibrate('injection_risk', wire('injection_risk'), noul(0.9), s).tier, 'type')
  // statuses without server-side calibration: normal client, calibrated profile
  const clean = chooseProfile(withCalibrated(CALIBRATED), { ...RIZZO, probabilityStatus: ['uncalibrated_temperature_1'] }, POLICY.band)
  assert.equal(clean.mode, 'client')
  assert.equal(clean.profile.calibrated, true)
  assert.deepEqual(clean.notes, [])
  // an empty array is not "exactly" the server's status
  assert.equal(chooseProfile(CALIB, { ...RIZZO, probabilityStatus: [] }, POLICY.band).mode, 'client')
})

// ─── per_question and thresholds ──────────────────────────────────────────────

test('per_question with a matching sha wins over the type block', () => {
  const s = chooseProfile(withCalibrated(CALIBRATED), RIZZO, POLICY.band)
  const out = calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.9), s)
  assert.equal(out.tier, 'question')
  assert.equal(out.note, undefined)
  const z = Math.log(0.9 / 0.1)
  assert.ok(Math.abs(pNoul(out.response) - 1 / (1 + Math.exp(-(0.29 * z - 0.4)))) < 1e-12)
  // another question uses the type block
  const other = calibrate('injection_risk', wire('injection_risk'), noul(0.9), s)
  assert.equal(other.tier, 'type')
  assert.ok(Math.abs(pNoul(other.response) - 1 / (1 + Math.exp(-(0.31 * z - 0.2)))) < 1e-12)
})

test('per_question with a different sha: ignored, with the note, and the policy threshold', () => {
  const stale = { ...CALIBRATED, per_question: { hardcoded_secret: { sha256: '0'.repeat(64), a: 0.29, b: -0.4 } } }
  const s = chooseProfile(withCalibrated(stale), RIZZO, POLICY.band)
  const out = calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.9), s)
  assert.equal(out.tier, 'type')
  assert.equal(out.note, 'question hardcoded_secret changed after the calibration fit: thresholds not calibrated for this question')
  const questions = Object.fromEntries(['hardcoded_secret', 'injection_risk'].map((id) => [id, wire(id)]))
  const hashOk = consistentHashes(questions, s)
  assert.deepEqual(hashOk, { hardcoded_secret: false, injection_risk: true })
  assert.deepEqual(ruleThreshold(gte('hardcoded_secret', 0.7), s, hashOk), { value: 0.7, source: 'policy' })
  // matching sha: the profile's threshold replaces the rule's value
  const good = chooseProfile(withCalibrated(CALIBRATED), RIZZO, POLICY.band)
  const h2 = consistentHashes(questions, good)
  assert.deepEqual(h2, { hardcoded_secret: true, injection_risk: true })
  assert.deepEqual(ruleThreshold(gte('hardcoded_secret', 0.7), good, h2), { value: 0.62, source: 'profile' })
  // a check without a threshold in the profile stays on the policy
  assert.deepEqual(ruleThreshold(gte('injection_risk', 0.7), good, h2), { value: 0.7, source: 'policy' })
  // missing map: consistent only if the profile has no entry for that question
  assert.deepEqual(ruleThreshold(gte('hardcoded_secret', 0.7), good), { value: 0.7, source: 'policy' })
  const withoutEntry = chooseProfile(withCalibrated({ ...CALIBRATED, per_question: undefined }), RIZZO, POLICY.band)
  assert.deepEqual(ruleThreshold(gte('hardcoded_secret', 0.7), withoutEntry), { value: 0.62, source: 'profile' })
})

test('a rule of the project gives way to a profile threshold only where the profile is stricter', () => {
  const good = chooseProfile(withCalibrated(CALIBRATED), RIZZO, POLICY.band)
  const h = consistentHashes({ hardcoded_secret: wire('hardcoded_secret') }, good)
  const project = (op: Op, value: number): Rule => ({ check: 'hardcoded_secret', op, value, fromProject: true })
  // the same 0.5 from the user or the plugin: the profile's 0.62 replaces it
  assert.deepEqual(ruleThreshold(gte('hardcoded_secret', 0.5), good, h), { value: 0.62, source: 'profile' })
  // from the project it is a restriction, and 0.62 would loosen it
  assert.deepEqual(ruleThreshold(project('gte', 0.5), good, h), { value: 0.5, source: 'policy' })
  // a stricter profile still wins; on a tie the project's value stays
  assert.deepEqual(ruleThreshold(project('gte', 0.7), good, h), { value: 0.62, source: 'profile' })
  assert.deepEqual(ruleThreshold(project('gte', 0.62), good, h), { value: 0.62, source: 'policy' })
  // with lte a higher value is the stricter one
  assert.deepEqual(ruleThreshold(project('lte', 0.7), good, h), { value: 0.7, source: 'policy' })
  assert.deepEqual(ruleThreshold(project('lte', 0.5), good, h), { value: 0.62, source: 'profile' })

  // The two are compared where they both are, on the calibrated scale: the project's
  // raw 0.9 becomes σ(0.29 · logit(0.9) − 0.4) = 0.56, stricter than 0.62, and the
  // decision stays on the raw value. A raw 0.95 is calibrated to 0.61: the profile's
  // threshold would have let it through.
  const s = withThresholdScales(good, { hardcoded_secret: wire('hardcoded_secret') }, CHECKS)
  const t = ruleThreshold(project('gte', 0.9), s, h)
  assert.equal(t.source, 'policy')
  assert.equal(formatNumber(t.value, 2), '0.56')
  const cal = pNoul(calibrate('hardcoded_secret', wire('hardcoded_secret'), noul(0.95), s).response)
  assert.ok(cal < 0.62, String(cal))
  const values: Record<string, CheckValue> = { hardcoded_secret: { value: cal, raw: 0.95 } }
  assert.deepEqual(pick(evaluateRule(project('gte', 0.9), values, s, h)), { fires: true, source: 'policy', onRaw: true })
  assert.deepEqual(pick(evaluateRule(gte('hardcoded_secret', 0.9), values, s, h)), { fires: false, source: 'profile', onRaw: false })
})

test('profile thresholds only if calibrated', () => {
  const uncalibrated = chooseProfile(withCalibrated({ ...CALIBRATED, calibrated: false }), RIZZO, POLICY.band)
  assert.equal(uncalibrated.profile.calibrated, false)
  assert.deepEqual(profileThreshold('hardcoded_secret', 0.7, uncalibrated, true), { value: 0.7, source: 'policy' })
  const calibrated = chooseProfile(withCalibrated(CALIBRATED), RIZZO, POLICY.band)
  assert.deepEqual(profileThreshold('hardcoded_secret', 0.7, calibrated, true), { value: 0.62, source: 'profile' })
  assert.deepEqual(profileThreshold('hardcoded_secret', 0.7, calibrated, false), { value: 0.7, source: 'policy' })
  // an id that exists on Object's prototype is not a threshold
  assert.deepEqual(profileThreshold('constructor', 0.7, calibrated, true), { value: 0.7, source: 'policy' })
})

// ─── Thresholds on the calibrated scale ───────────────────────────────────────

// A fitted profile like the one scripts/fit-calibration.ts writes: a per-question
// Platt on a noul, on a choice with a value, on an inverted choice, and the type's noul
// block for the nouls without an entry.
function fitted(extra: Partial<Profile> = {}): ProfileSelection {
  const entry = (id: string, a: number, b: number) => ({ sha256: questionHash(wire(id)), a, b })
  const profile: Profile = {
    name: 'fit', match: {}, calibrated: true, noul: { a: 0.7, b: -0.5 },
    per_question: {
      touches_auth: entry('touches_auth', 0.35, -1.04),
      injection_risk: entry('injection_risk', 0.52, -3.58),
      adds_tests: entry('adds_tests', 0.51, 1.1),
      weakens_expected: entry('weakens_expected', 0.6, -1.2),
    },
    ...extra,
  }
  return { profile, mode: 'client', deltaLogit: 0.62, notes: [] }
}

const QUESTIONS: Record<string, WireQuestion> = Object.fromEntries(
  ['hardcoded_secret', 'touches_auth', 'injection_risk', 'adds_tests', 'weakens_expected', 'primary_concern'].map((id) => [id, wire(id)]),
)

// The value the review compares: calibrated in the sent polarity, then flipped back.
function reported(id: string, sent: number, s: ProfileSelection): number {
  const d = CHECKS.defs[id]
  const cal = d.value ? calibrateDerived(id, QUESTIONS[id], sent, s).p : (calibrate(id, QUESTIONS[id], { type: 'noul', noul: sent }, s).response as { noul: number }).noul
  return restorePolarity(cal, d.invert)
}

test('a rule on a calibrated question decides on the raw value, and shows the threshold on the values\' scale', () => {
  const s = withThresholdScales(fitted(), QUESTIONS, CHECKS)
  const hashOk = consistentHashes(QUESTIONS, s)
  const identity: ProfileSelection = { profile: { name: 'none', match: {}, calibrated: false }, mode: 'client', deltaLogit: 0.62, notes: [] }
  // the choice without a value is not a probability: no scale
  assert.deepEqual(Object.keys(s.scales ?? {}).sort(), ['adds_tests', 'hardcoded_secret', 'injection_risk', 'touches_auth', 'weakens_expected'])
  const grid = [0, 1e-9, 0.01, 0.1, 0.25, 0.3, 0.5, 0.62, 0.7, 0.9, 0.99, 0.999999, 1]
  let checked = 0
  for (const id of Object.keys(s.scales ?? {})) {
    const invert = CHECKS.defs[id].invert
    for (const sent of grid) {
      const raw = restorePolarity(sent, invert)
      const cal = reported(id, sent, s)
      for (const t of grid) {
        for (const op of ['gte', 'gt', 'lte', 'lt'] as Op[]) {
          const rule = { check: id, op, value: t }
          const onCal = evaluateRule(rule, { [id]: { value: cal, raw } }, s, hashOk)
          const onRaw = evaluateRule(rule, { [id]: { value: raw, raw } }, identity)
          // ties included: the comparison is the raw one
          assert.equal(onCal?.fires, onRaw?.fires, `${id} ${op} sent ${sent} threshold ${t}`)
          assert.equal(onCal?.onRaw, true)
          assert.equal(onCal?.threshold, scaledThreshold(id, t, s))
          checked++
        }
      }
    }
  }
  assert.ok(checked > 3000)
  // the shown threshold sits where the values do: a value above it on the raw scale is above it on the shown one
  for (const t of [0.1, 0.3, 0.7, 0.9]) {
    for (const sent of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const raw = restorePolarity(sent, false)
      if (Math.abs(raw - t) < 1e-9) continue
      assert.equal(compare(reported('touches_auth', sent, s), 'gte', scaledThreshold('touches_auth', t, s)), raw >= t)
    }
  }
  // the number moves: injection_risk's 0.99 is 0.23 on the calibrated scale
  const sigma = (z: number): number => 1 / (1 + Math.exp(-z))
  assert.ok(Math.abs(scaledThreshold('injection_risk', 0.99, s) - sigma(0.52 * Math.log(99) - 3.58)) < 1e-12)
  assert.equal(formatNumber(scaledThreshold('injection_risk', 0.99, s), 2), '0.23')
  // adds_tests is compared in the reported polarity: ≤ 0.30 is "missing tests" ≥ 0.70 sent
  assert.ok(Math.abs(scaledThreshold('adds_tests', 0.3, s) - (1 - 1 / (1 + Math.exp(-(0.51 * Math.log(0.7 / 0.3) + 1.1))))) < 1e-12)
})

test('a threshold keeps its value where nothing transforms the values: server calibration, a changed question, an identity entry', () => {
  const server = withThresholdScales({ ...fitted(), mode: 'server' }, QUESTIONS, CHECKS)
  assert.deepEqual(server.scales, {})
  assert.equal(scaledThreshold('injection_risk', 0.99, server), 0.99)
  // a changed question drops the entry: the values go through the noul block, and so does the threshold
  const changed = fitted()
  changed.profile.per_question = { touches_auth: { sha256: 'other', a: 0.35, b: -1.04 } }
  const sc = thresholdScales(QUESTIONS, CHECKS, changed)
  assert.equal(sc.touches_auth?.item, undefined)
  // injection_risk's value is derived: without an entry it goes through the noul block too
  assert.ok(sc.injection_risk)
  const identity = fitted({ noul: undefined, per_question: { touches_auth: { sha256: questionHash(wire('touches_auth')), a: 1, b: 0 } } })
  const s = withThresholdScales(identity, QUESTIONS, CHECKS)
  assert.deepEqual(s.scales, {})
  assert.equal(ruleThreshold(gte('touches_auth', 0.7), s).value, 0.7)
})

test('an explicit threshold of a calibrated profile still replaces the value; an unless condition moves with its check', () => {
  const s = withThresholdScales(fitted({ thresholds: { touches_auth: 0.5 } }), QUESTIONS, CHECKS)
  const hashOk = consistentHashes(QUESTIONS, s)
  assert.deepEqual(ruleThreshold(gte('touches_auth', 0.7), s, hashOk), { value: 0.5, source: 'profile' })
  // weakens_tests has no entry here; its condition on weakens_expected (< 0.10 raw) is
  // evaluated on weakens_expected's calibrated value
  const rule = { check: 'weakens_tests', op: 'gte' as Op, value: 0.5, unless: [{ check: 'weakens_expected', op: 'lt' as Op, value: 0.1 }] }
  const identity: ProfileSelection = { profile: { name: 'none', match: {}, calibrated: false }, mode: 'client', deltaLogit: 0.62, notes: [] }
  for (const expected of [0.05, 0.0999, 0.1, 0.1001, 0.3]) {
    const values = (sel: ProfileSelection): Record<string, CheckValue> => ({ weakens_tests: { value: 0.9 }, weakens_expected: { value: reported('weakens_expected', expected, sel) } })
    const raw = evaluateRule(rule, values(identity), identity)
    const cal = evaluateRule(rule, values(s), s, hashOk)
    assert.equal(cal?.fires, raw?.fires, `weakens_expected ${expected}`)
    assert.equal(raw?.fires, expected >= 0.1)
  }
})
