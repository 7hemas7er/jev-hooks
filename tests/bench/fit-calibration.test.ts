import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateChecks } from '../../src/core/config.ts'
import { questionHash, wireQuestion } from '../../src/core/systemone.ts'
import { applyPlatt, ece, fitPlatt, fitQuestions, logLoss, main, perQuestion, readMeasured, ROOT } from '../../scripts/fit-calibration.ts'
import type { Sample } from '../../scripts/measure-questions.ts'
import { generator } from '../helpers/strings.ts'

const CHECKS = (() => {
  const r = validateChecks(JSON.parse(readFileSync(join(ROOT, 'config', 'checks.json'), 'utf8')), 'checks.json')
  if (!r.ok) throw new Error(r.error.message)
  return r.value
})()
const sigma = (z: number): number => 1 / (1 + Math.exp(-z))
const logit = (p: number): number => Math.log(p / (1 - p))

// Labels drawn from a known Platt of the raw p: the fit must find it back.
function drawn(n: number, a: number, b: number, seed: number): Sample[] {
  const g = generator(seed)
  const out: Sample[] = []
  for (let i = 0; i < n; i++) {
    const p = sigma((g() - 0.5) * 16)
    out.push({ p, y: g() < sigma(a * logit(p) + b) })
  }
  return out
}

test('fitPlatt: finds the Platt the labels were drawn from, and stays finite on a set it separates', () => {
  const f = fitPlatt(drawn(6000, 0.5, -1.5, 7))
  assert.ok(Math.abs(f.a - 0.5) < 0.06 && Math.abs(f.b + 1.5) < 0.15, JSON.stringify(f))
  // already calibrated: close to the identity
  const id = fitPlatt(drawn(6000, 1, 0, 11))
  assert.ok(Math.abs(id.a - 1) < 0.1 && Math.abs(id.b) < 0.15, JSON.stringify(id))
  // perfectly separated: the smoothed targets keep a finite
  const separated: Sample[] = [...Array.from({ length: 50 }, () => ({ p: 0.01, y: false })), ...Array.from({ length: 5 }, () => ({ p: 0.99, y: true }))]
  const s = fitPlatt(separated)
  assert.ok(Number.isFinite(s.a) && s.a > 0 && s.a < 10, JSON.stringify(s))
  assert.throws(() => fitPlatt([{ p: 0.3, y: true }]), /both labels/)
})

test('metrics: log-loss and ECE of an overconfident answer go down once it is calibrated', () => {
  const s = drawn(4000, 0.4, -1, 3)
  const f = fitPlatt(s)
  assert.ok(logLoss(s, (p) => applyPlatt(p, f)) < logLoss(s))
  assert.ok(ece(s, (p) => applyPlatt(p, f)) < ece(s))
  assert.equal(ece([{ p: 0.25, y: false }, { p: 0.25, y: false }, { p: 0.25, y: true }, { p: 0.25, y: false }]), 0)
})

// A measurement directory as measure-questions.ts writes it: report.md with the
// fingerprint and the hashes of the current variant, raw.jsonl with p and label.
function measurement(dir: string, rows: { id: string; q: string; p: number; label: boolean }[], o: { fingerprint?: string; hashes?: Record<string, string> } = {}): string {
  mkdirSync(dir, { recursive: true })
  const ids = [...new Set(rows.map((r) => r.q))]
  const hashes = o.hashes ?? Object.fromEntries(ids.map((q) => [q, questionHash(wireQuestion(CHECKS.defs[q]))]))
  writeFileSync(join(dir, 'report.md'), [
    '# Measurement', '', '- Backend: `<tailnet host>:8443`', '- Declared model: `rizzo-latest`', `- Fingerprint: \`${o.fingerprint ?? 'ab12'}\``, '',
    '## Variant hashes', '', '| question | variant | type | sha256 |', '|---|---|---|---|',
    ...Object.entries(hashes).map(([q, h]) => `| ${q} | attuale (checks.json) | ${CHECKS.defs[q].type} | \`${h}\` |`), '',
  ].join('\n'))
  writeFileSync(join(dir, 'raw.jsonl'), rows.map((r) => JSON.stringify({ id: r.id, repeat: 1, question: r.q, variant: 'attuale', readout: 'p', p: r.p, raw: r.p, label: r.label })).join('\n') + '\n')
  return dir
}

const rowsOf = (q: string, s: readonly Sample[]) => s.map((x, i) => ({ id: `${q}-${i}`, q, p: x.p, label: x.y }))

test('fitQuestions: adopts a question the fit improves on the check set, keeps the others with the reason', () => {
  const base = mkdtempSync(join(tmpdir(), 'fit-'))
  const over = (seed: number) => drawn(400, 0.5, -2, seed)
  // touches_auth: overconfident, as rizzo is; weakens_tests: already calibrated; data_migration: labels at random
  const g = generator(5)
  const noise = (n: number): Sample[] => Array.from({ length: n }, () => ({ p: sigma((g() - 0.5) * 12), y: g() < 0.2 }))
  const fitDir = measurement(join(base, 'fit'), [...rowsOf('touches_auth', over(1)), ...rowsOf('weakens_tests', drawn(400, 1, 0, 2)), ...rowsOf('data_migration', noise(400))])
  const checkDir = measurement(join(base, 'check'), [...rowsOf('touches_auth', over(21)), ...rowsOf('weakens_tests', drawn(400, 1, 0, 22)), ...rowsOf('data_migration', noise(400))])
  const fits = fitQuestions(CHECKS, readMeasured(fitDir), readMeasured(checkDir))
  const by = Object.fromEntries(fits.map((q) => [q.id, q]))
  assert.equal(by.touches_auth.adopted, true, by.touches_auth.reason)
  assert.ok(by.touches_auth.check && by.touches_auth.check.logLoss[1] < by.touches_auth.check.logLoss[0])
  assert.equal(by.hardcoded_secret.adopted, false)
  assert.match(by.hardcoded_secret.reason, /not measured in the fit set/)
  // a second reading shares its labels with another question: not fitted on its own
  assert.equal(by.weakens_expected, undefined)
  // primary_concern is a choice without a value: not a probability
  assert.equal(by.primary_concern, undefined)
  const entries = perQuestion(fits)
  assert.deepEqual(Object.keys(entries.touches_auth).sort(), ['a', 'b', 'errors', 'n', 'sha256'])
  assert.equal(entries.touches_auth.n, 400)
  assert.equal(entries.touches_auth.sha256, questionHash(wireQuestion(CHECKS.defs.touches_auth)))
  // four decimals, as written
  assert.equal(entries.touches_auth.a, Number((entries.touches_auth.a ?? 0).toFixed(4)))
  for (const q of fits.filter((x) => !x.adopted)) assert.deepEqual(Object.keys(entries[q.id]), ['sha256'], q.id)
})

test('readMeasured: one answer per diff, the first repeat', () => {
  const base = mkdtempSync(join(tmpdir(), 'fit-'))
  const dir = measurement(join(base, 'm'), rowsOf('touches_auth', drawn(10, 1, 0, 4)))
  const lines = readFileSync(join(dir, 'raw.jsonl'), 'utf8').trim().split('\n')
  const again = lines.map((l) => JSON.stringify({ ...JSON.parse(l), repeat: 2, p: 0.5 }))
  writeFileSync(join(dir, 'raw.jsonl'), [...lines, ...again].join('\n') + '\n')
  assert.equal(readMeasured(dir).samples.get('touches_auth')?.length, 10)
})

test('fitQuestions: a text measured with another sha256 is not fitted', () => {
  const base = mkdtempSync(join(tmpdir(), 'fit-'))
  const rows = rowsOf('touches_auth', drawn(200, 0.5, -1, 9))
  const fit = readMeasured(measurement(join(base, 'fit'), rows, { hashes: { touches_auth: '0'.repeat(64) } }))
  const check = readMeasured(measurement(join(base, 'check'), rows))
  const q = fitQuestions(CHECKS, fit, check).find((x) => x.id === 'touches_auth')
  assert.equal(q?.adopted, false)
  assert.match(q?.reason ?? '', /the fit set measured another text/)
})

test('fit-calibration CLI: writes report.md and profile.json, refuses mixed backends and an existing report, --help', () => {
  const base = mkdtempSync(join(tmpdir(), 'fit-'))
  const fitDir = measurement(join(base, 'fit'), rowsOf('touches_auth', drawn(300, 0.5, -1.5, 31)))
  const checkDir = measurement(join(base, 'check'), rowsOf('touches_auth', drawn(300, 0.5, -1.5, 32)))
  const out: string[] = []
  const err: string[] = []
  const run = (...a: string[]) => main(a, (s) => out.push(s), (s) => err.push(s))
  assert.equal(run('--fit', fitDir, '--check', checkDir, '--out', join(base, 'out'), '--date', '2026-09-30'), 0, err.join(''))
  const report = readFileSync(join(base, 'out', 'report.md'), 'utf8')
  assert.match(report, /^# Calibration fit \(2026-09-30\)/)
  assert.match(report, /\| touches_auth \| 0\.\d{4} \| -\d\.\d{4} \| 300 \(\d+\) \| 300 \(\d+\) \|.*\| adopted \|/)
  assert.match(report, /\| NITS \| touches_auth ≥ \| 0\.70 \| 0\.\d{3} \|/)
  const profile = JSON.parse(readFileSync(join(base, 'out', 'profile.json'), 'utf8'))
  assert.ok(profile.per_question.touches_auth.a > 0)
  assert.equal(run('--fit', fitDir, '--check', checkDir, '--out', join(base, 'out')), 2)
  assert.match(err.join(''), /already exists/)
  const other = measurement(join(base, 'other'), rowsOf('touches_auth', drawn(50, 0.5, -1.5, 33)), { fingerprint: 'cd34' })
  assert.equal(run('--fit', fitDir, '--check', other, '--out', join(base, 'out2')), 2)
  assert.match(err.join(''), /different backends/)
  assert.equal(run('--fit', fitDir, '--check', fitDir, '--out', join(base, 'out3')), 2)
  assert.match(err.join(''), /the check set is the fit set/)
  assert.equal(run('--fit', fitDir), 2)
  assert.equal(run('--chek', fitDir), 2)
  assert.equal(run('--help'), 0)
  assert.match(out.join(''), /^usage: node scripts\/fit-calibration\.ts/m)
})
