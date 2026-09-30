import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseProfile } from '../../src/core/calibration.ts'
import { validateCalibration, validateChecks, validatePolicy } from '../../src/core/config.ts'
import {
  compare, ciConclusion, partialCoverage, decide, mergeReady, valuesFromVerdict, evaluateRule,
} from '../../src/core/verdict.ts'
import type { CoverageGaps } from '../../src/core/verdict.ts'
import type { Calibration, Result, DetectorResult, Identity, Policy, ProfileSelection, CheckValue, EscalationItem, Rule } from '../../src/core/types.ts'
import { generator } from '../helpers/strings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

function valueOf<T>(e: Result<T>): T {
  if (!e.ok) assert.fail(`expected ok, found: ${e.error.message}`)
  return e.value
}

const CHECKS = valueOf(validateChecks(json('config/checks.json'), 'checks.json'))
const POLICY = valueOf(validatePolicy(json('config/policy.json'), CHECKS, 'policy.json'))
const CALIB = valueOf(validateCalibration(json('config/calibration.json'), 'calibration.json'))
const RIZZO: Identity = { host: '192.168.1.50', model: 'rizzo-spark-x2.5-4b-bf16', fingerprint: 'fake-fp-1', family: 'rizzo' }
const S = chooseProfile(CALIB, RIZZO, POLICY.band)

const COMPLETE: CoverageGaps = { omitted: 0, unreviewable: 0, incomplete: false }
const NO_FLOOR: DetectorResult['floors'] = []
const LANES = POLICY.lanes.map((c) => c.name)
const severity = (name: string): number => LANES.indexOf(name)

function values(o: Record<string, number>): Record<string, CheckValue> {
  const out: Record<string, CheckValue> = {}
  for (const [k, x] of Object.entries(o)) out[k] = { value: x, source: 'model' }
  return out
}

const laneOf = (o: Record<string, number>, floors = NO_FLOOR, z = COMPLETE, s: ProfileSelection = S, hashOk: Record<string, boolean> = {}, p: Policy = POLICY): string =>
  decide(values(o), p, s, floors, z, hashOk).lane.name

// The threshold of a check in the plugin's policy, read from the file: the cases stay
// true when the calibration fit moves the numbers.
function thr(id: string): number {
  const r = POLICY.lanes.flatMap((c) => c.rules).find((x) => x.check === id)
  assert.ok(r, id)
  return r.value
}

// Whoever wants the model to block on its own (policy v2: only in the user file) adds
// a rule in BLOCK: here hardcoded_secret ≥ 0.7.
const BLOCKING: Policy = {
  ...POLICY,
  lanes: POLICY.lanes.map((c) => (c.name === 'BLOCK' ? { ...c, rules: [{ check: 'hardcoded_secret', op: 'gte' as const, value: 0.7 }] } : c)),
}

// ─── Data-driven cases: calibrated probabilities → lane ────────────────────────

const CASES: [string, Record<string, number>, string][] = [
  ['no value', {}, 'MERGE'],
  // policy v2: the critical questions above the threshold go to Claude and the verdict stays NITS
  ['secret above the threshold (the demo\'s 0.874)', { hardcoded_secret: 0.874 }, 'NITS'],
  ['secret at the threshold', { hardcoded_secret: thr('hardcoded_secret') }, 'NITS'],
  ['secret just below the threshold', { hardcoded_secret: thr('hardcoded_secret') - 0.0001 }, 'MERGE'],
  ['injection above', { injection_risk: Math.min(1, thr('injection_risk') + 0.001) }, 'NITS'],
  ['weakens_tests just below', { weakens_tests: thr('weakens_tests') - 0.01 }, 'MERGE'],
  ['weakens_tests at the threshold', { weakens_tests: thr('weakens_tests') }, 'NITS'],
  ['weakens_tests high, docs only: the unless cancels it', { weakens_tests: 1, docs_only: 1 }, 'MERGE'],
  ['touches_auth just below', { touches_auth: thr('touches_auth') - 0.0001 }, 'MERGE'],
  ['touches_auth at the threshold', { touches_auth: thr('touches_auth') }, 'NITS'],
  ['breaks_api at the threshold: a note', { breaks_api: thr('breaks_api') }, 'NITS'],
  ['data_migration just below', { data_migration: thr('data_migration') - 0.01 }, 'MERGE'],
  ['the model never blocks on its own: everything at the maximum stays NITS', {
    hardcoded_secret: 1, injection_risk: 1, touches_auth: 1, weakens_tests: 1, breaks_api: 1, data_migration: 1, debug_leftovers: 1,
    adds_tests: 0, docs_only: 0,
  }, 'NITS'],
  ['debug leftovers', { debug_leftovers: thr('debug_leftovers') }, 'NITS'],
  // description_matches is informative only: no value takes it to a lane
  ['description does not match: informative, outside the rules', { description_matches: 0.01 }, 'MERGE'],
  ['tests missing, not docs only', { adds_tests: 0.01, docs_only: 0 }, 'NITS'],
  ['tests missing at the threshold', { adds_tests: thr('adds_tests'), docs_only: 0 }, 'NITS'],
  ['tests missing, docs only: the unless cancels it', { adds_tests: 0.01, docs_only: 1 }, 'MERGE'],
  ['tests fit', { adds_tests: thr('adds_tests') + 0.01, docs_only: 0 }, 'MERGE'],
  ['everything low (the fake server\'s defaults)', {
    hardcoded_secret: 0.02, injection_risk: 0, touches_auth: 0.02, weakens_tests: 0, breaks_api: 0,
    data_migration: 0, debug_leftovers: 0.02, adds_tests: 1, description_matches: 0.98, docs_only: 0,
  }, 'MERGE'],
]

test('probability → lane (data-driven cases)', () => {
  for (const [name, v, expected] of CASES) assert.equal(laneOf(v), expected, name)
  // a model rule in BLOCK, added by whoever wants it, still blocks
  assert.equal(laneOf({ hardcoded_secret: 0.874 }, NO_FLOOR, COMPLETE, S, {}, BLOCKING), 'BLOCK')
})

test('the fired rules can be checked: check, value, op, threshold, source and action', () => {
  const r = decide(values({ hardcoded_secret: 0.874, debug_leftovers: 0.9 }), POLICY, S, NO_FLOOR, COMPLETE, {})
  assert.equal(r.lane.name, 'NITS')
  assert.deepEqual(r.fired, [
    { lane: 'NITS', check: 'hardcoded_secret', value: 0.874, op: 'gte', threshold: thr('hardcoded_secret'), source: 'policy', action: 'escalation' },
    { lane: 'NITS', check: 'debug_leftovers', value: 0.9, op: 'gte', threshold: thr('debug_leftovers'), source: 'policy' },
  ])
})

test('evaluateRule: effective threshold, unless and a missing value as in the verdict', () => {
  const rule = POLICY.lanes.flatMap((c) => c.rules).find((x) => x.check === 'adds_tests')
  assert.ok(rule?.unless)
  assert.equal(evaluateRule(rule, {}, S), undefined)
  assert.deepEqual(evaluateRule(rule, values({ adds_tests: 0.01, docs_only: 0 }), S), { fires: true, value: 0.01, threshold: rule.value, source: 'policy', onRaw: false })
  assert.equal(evaluateRule(rule, values({ adds_tests: 0.01, docs_only: 1 }), S)?.fires, false)
  assert.deepEqual(evaluateRule(rule, values({ adds_tests: 0.01 }), S), { fires: true, value: 0.01, threshold: rule.value, source: 'policy', onRaw: false, unlessWithoutValue: 'docs_only' })
  assert.equal(evaluateRule(rule, values({ adds_tests: 0.99 }), S)?.fires, false)
})

test('unevaluated rules: no value → the rule does not fire and appears among the unevaluated', () => {
  const r = decide({}, POLICY, S, NO_FLOOR, COMPLETE, {})
  assert.equal(r.lane.name, 'MERGE')
  assert.deepEqual(r.fired, [])
  assert.deepEqual(r.unevaluated, [
    'hardcoded_secret', 'injection_risk', 'weakens_tests', 'touches_auth', 'breaks_api', 'data_migration',
    'debug_leftovers', 'adds_tests',
  ])
  // a non-finite value counts as a missing value
  const nan = decide(values({ hardcoded_secret: Number.NaN }), POLICY, S, NO_FLOOR, COMPLETE, {})
  assert.equal(nan.lane.name, 'MERGE')
  assert.ok(nan.unevaluated.includes('hardcoded_secret'))
  // an id that exists on Object's prototype is not a value
  const proto = decide(Object.create({ hardcoded_secret: { value: 1, source: 'model' } }), POLICY, S, NO_FLOOR, COMPLETE, {})
  assert.equal(proto.lane.name, 'MERGE')
})

test('evaluateRule: a list of unless conditions, any of which cancels the rule', () => {
  const rule: Rule = {
    check: 'weakens_tests', op: 'gte', value: 0.5, action: 'escalation',
    unless: [{ check: 'docs_only', op: 'gte', value: 0.5 }, { check: 'debug_leftovers', op: 'lt', value: 0.1 }],
  }
  assert.equal(evaluateRule(rule, values({ weakens_tests: 0.9, docs_only: 0, debug_leftovers: 0.5 }), S)?.fires, true)
  assert.equal(evaluateRule(rule, values({ weakens_tests: 0.9, docs_only: 1, debug_leftovers: 0.5 }), S)?.fires, false)
  assert.equal(evaluateRule(rule, values({ weakens_tests: 0.9, docs_only: 0, debug_leftovers: 0.05 }), S)?.fires, false)
  // a condition without a value does not hold: the rule fires, and says why
  assert.deepEqual(evaluateRule(rule, values({ weakens_tests: 0.9, docs_only: 0 }), S),
    { fires: true, value: 0.9, threshold: 0.5, source: 'policy', onRaw: false, unlessWithoutValue: 'debug_leftovers' })
  // another condition cancels it: no note about the missing one, since it changed nothing
  assert.deepEqual(evaluateRule(rule, values({ weakens_tests: 0.9, docs_only: 1 }), S),
    { fires: false, value: 0.9, threshold: 0.5, source: 'policy', onRaw: false })
})

test('an unless on a missing value is false: the rule fires and the output notes it', () => {
  const r = decide(values({ adds_tests: 0.1 }), POLICY, S, NO_FLOOR, COMPLETE, {})
  assert.equal(r.lane.name, 'NITS')
  assert.ok(r.unevaluated.includes('docs_only'))
  assert.ok(r.notes.some((n) => n.includes('unless') && n.includes('docs_only')), r.notes.join(' | '))
})

test('thresholds of the calibrated profile: they replace the value, with the source "profile", only with a matching sha', () => {
  const calibrated: Calibration = {
    ...CALIB,
    profiles: [{ name: 'spark', match: { fingerprint: 'fake-fp-1' }, calibrated: true, thresholds: { hardcoded_secret: 0.95, touches_auth: 0.99 } }, ...CALIB.profiles],
  }
  const s = chooseProfile(calibrated, RIZZO, POLICY.band)
  // 0.96 passes the profile's threshold (0.95), 0.9 does not: source "profile", and the action stays
  const r = decide(values({ hardcoded_secret: 0.96 }), POLICY, s, NO_FLOOR, COMPLETE, { hardcoded_secret: true })
  assert.equal(r.lane.name, 'NITS')
  assert.deepEqual(r.fired[0], { lane: 'NITS', check: 'hardcoded_secret', value: 0.96, op: 'gte', threshold: 0.95, source: 'profile', action: 'escalation' })
  assert.equal(laneOf({ hardcoded_secret: 0.9 }, NO_FLOOR, COMPLETE, s, { hardcoded_secret: true }), 'MERGE')
  // question changed after the calibration fit: the policy applies
  assert.equal(laneOf({ hardcoded_secret: 0.9 }, NO_FLOOR, COMPLETE, s, { hardcoded_secret: false }), 'NITS')
  // a calibrated threshold can also go up: 0.98 is no longer enough for touches_auth
  assert.equal(laneOf({ touches_auth: 0.98 }, NO_FLOOR, COMPLETE, s), 'MERGE')
  assert.equal(laneOf({ touches_auth: 0.98 }), 'NITS')
  // the default profile is not calibrated: the policy thresholds stay
  assert.equal(laneOf({ hardcoded_secret: 0.9 }), 'NITS')
})

test('choice with a value: its 1 − p(none) goes through the rules and the calibrated thresholds like a noul', () => {
  const c = structuredClone(json('config/checks.json')) as Record<string, any>
  c.data_migration = {
    label: 'Data migration', type: 'choice', scope: 'chunk', critical: true, higher_is_better: false, value: '1-p(none)',
    instructions: 'Which change to stored data appears in an added line of the [diff] section?',
    criteria: { none: 'Only reads or additions.', drop_or_rename: 'A table or column is dropped or renamed.' },
  }
  const ch = valueOf(validateChecks(c, 'checks.json'))
  const pol = valueOf(validatePolicy(json('config/policy.json'), ch, 'policy.json'))
  const rule = pol.lanes.flatMap((l) => l.rules.map((r) => ({ lane: l.name, ...r }))).find((r) => r.check === 'data_migration')
  assert.ok(rule)
  const v = (x: number): Record<string, CheckValue> => ({ data_migration: { value: x, source: 'model', option: 'drop_or_rename' } })
  assert.equal(decide(v(rule.value), pol, S, NO_FLOOR, COMPLETE, {}).lane.name, rule.lane)
  assert.equal(decide(v(rule.value - 0.01), pol, S, NO_FLOOR, COMPLETE, {}).lane.name, 'MERGE')
  // the profile's calibrated threshold, with a matching sha
  const calibrated: Calibration = { ...CALIB, profiles: [{ name: 'spark', match: { fingerprint: 'fake-fp-1' }, calibrated: true, thresholds: { data_migration: 0.3 } }, ...CALIB.profiles] }
  const s = chooseProfile(calibrated, RIZZO, pol.band)
  const r = decide(v(0.35), pol, s, NO_FLOOR, COMPLETE, { data_migration: true })
  assert.equal(r.lane.name, rule.lane)
  assert.deepEqual(r.fired[0], { lane: rule.lane, check: 'data_migration', value: 0.35, op: 'gte', threshold: 0.3, source: 'profile', ...(rule.action ? { action: rule.action } : {}) })
})

// ─── Floors and coverage ─────────────────────────────────────────────────────

test('floors: the detector raises the verdict even without the model, never lowers it', () => {
  const block = decide({}, POLICY, S, [{ lane: 'BLOCK', by: ['stripe_live'] }], COMPLETE, {})
  assert.equal(block.lane.name, 'BLOCK')
  assert.deepEqual(block.fired, [{ lane: 'BLOCK', check: 'stripe_live', value: 1, op: 'gte', threshold: 1, source: 'floor' }])
  // model BLOCK (rule added by the user), floor SECURITY REVIEW: it stays BLOCK
  assert.equal(laneOf({ hardcoded_secret: 0.9 }, [{ lane: 'SECURITY REVIEW', by: ['reviewer_instructions'] }], COMPLETE, S, {}, BLOCKING), 'BLOCK')
  // model NITS, floor SECURITY REVIEW: it goes up
  assert.equal(laneOf({ hardcoded_secret: 0.9 }, [{ lane: 'SECURITY REVIEW', by: ['reviewer_instructions'] }]), 'SECURITY REVIEW')
  // model MERGE, floor BLOCK: it goes up to the top
  assert.equal(laneOf({ hardcoded_secret: 0.01 }, [{ lane: 'BLOCK', by: ['aws_access_key'] }]), 'BLOCK')
  // unknown lane: ignored with a note, no exception
  const odd = decide({}, POLICY, S, [{ lane: 'NONEXISTENT', by: ['x'] }], COMPLETE, {})
  assert.equal(odd.lane.name, 'MERGE')
  assert.equal(odd.notes.length, 1)
})

test('partial coverage: at least partial_coverage.min_lane, also from unreviewable files', () => {
  const omitted = decide({}, POLICY, S, NO_FLOOR, { omitted: 2, unreviewable: 0, incomplete: false }, {})
  assert.equal(omitted.lane.name, 'NITS')
  assert.ok(omitted.notes.includes('partial coverage: 2 files not examined'), omitted.notes.join(' | '))
  assert.deepEqual(omitted.fired, [{ lane: 'NITS', check: 'coverage', value: 2, op: 'gte', threshold: 0, source: 'coverage' }])
  assert.equal(laneOf({}, NO_FLOOR, { omitted: 0, unreviewable: 1, incomplete: false }), 'NITS')
  assert.equal(laneOf({}, NO_FLOOR, { omitted: 0, unreviewable: 0, incomplete: true }), 'NITS')
  assert.equal(laneOf({}, NO_FLOOR, { ...COMPLETE, truncated: true }), 'NITS')
  assert.equal(laneOf({}, NO_FLOOR, { ...COMPLETE, projectDetectorsTimedOut: 1 }), 'NITS')
  // it can only raise: a problem that was found stays
  assert.equal(laneOf({ hardcoded_secret: 0.9 }, NO_FLOOR, { omitted: 3, unreviewable: 1, incomplete: true }, S, {}, BLOCKING), 'BLOCK')
  assert.equal(partialCoverage(COMPLETE), null)
  assert.equal(
    partialCoverage({ omitted: 1, unreviewable: 2, incomplete: true, truncated: true }),
    'partial coverage: 3 files not examined, truncated diff, incomplete review',
  )
})

// ─── Monotonicity ────────────────────────────────────────────────────────────

// The "worse" direction of every check according to the policy: up for gte/gt, down
// for lte/lt; the other way round for an unless, because when true it cancels the rule.
function directions(): Map<string, 1 | -1> {
  const dir = new Map<string, 1 | -1>()
  const conflicts = new Set<string>()
  const mark = (id: string, d: 1 | -1): void => {
    if (dir.has(id) && dir.get(id) !== d) conflicts.add(id)
    dir.set(id, d)
  }
  for (const c of POLICY.lanes) {
    for (const r of c.rules) {
      mark(r.check, r.op === 'gte' || r.op === 'gt' ? 1 : -1)
      for (const u of r.unless ?? []) mark(u.check, u.op === 'gte' || u.op === 'gt' ? -1 : 1)
    }
  }
  for (const id of conflicts) dir.delete(id)
  return dir
}

test('monotonicity over 10,000 random combinations: floors, coverage and values never lower the verdict', () => {
  const r = generator(20260925)
  const dir = directions()
  const ids = [...dir.keys()]
  assert.ok(ids.length >= 9)
  const conditions = [...new Set(POLICY.lanes.flatMap((c) => c.rules.flatMap((x) => (x.unless ?? []).map((u) => u.check))))]
  assert.ok(conditions.length >= 1)
  const thresholds = POLICY.lanes.flatMap((c) => c.rules.map((x) => x.value))
  const random = (): number => {
    // half of the values close to a threshold, where a comparison error shows
    if (r() < 0.5) return Math.min(1, Math.max(0, thresholds[Math.floor(r() * thresholds.length)] + (r() - 0.5) * 0.02))
    return r()
  }
  for (let k = 0; k < 10_000; k++) {
    const v: Record<string, number> = {}
    for (const id of ids) if (r() < 0.8) v[id] = random()
    const floors: DetectorResult['floors'] = LANES.filter(() => r() < 0.15).map((c) => ({ lane: c, by: ['r'] }))
    const z: CoverageGaps = { omitted: r() < 0.1 ? 1 : 0, unreviewable: r() < 0.1 ? 1 : 0, incomplete: r() < 0.1 }

    const modelOnly = severity(laneOf(v))
    const final = severity(laneOf(v, floors, z))
    const ctx = `case ${k}: ${JSON.stringify({ v, floors, z })}`
    assert.ok(final <= modelOnly, `floors or coverage lowered the verdict (${ctx})`)
    for (const f of floors) assert.ok(final <= severity(f.lane), `below the floor ${f.lane} (${ctx})`)
    if (partialCoverage(z)) assert.ok(final <= severity(POLICY.partial_coverage.min_lane), `below min_lane (${ctx})`)

    // moving a present value towards "worse" never improves the verdict
    const present = ids.filter((x) => x in v)
    if (present.length) {
      const id = present[Math.floor(r() * present.length)]
      const after = { ...v, [id]: Math.min(1, Math.max(0, v[id] + (dir.get(id) as number) * r() * 0.5)) }
      assert.ok(severity(laneOf(after, floors, z)) <= final, `${id} ${v[id]} → ${after[id]} lowered the verdict (${ctx})`)
    }
    // an unless without a value is false, that is the worst case: removing it never lowers
    for (const u of conditions) {
      if (!(u in v)) continue
      const without = { ...v }
      delete without[u]
      assert.ok(severity(laneOf(without, floors, z)) <= final, `removing ${u} lowered the verdict (${ctx})`)
    }
  }
})

test('compare: the four operators, edges included', () => {
  assert.equal(compare(0.7, 'gte', 0.7), true)
  assert.equal(compare(0.7, 'gt', 0.7), false)
  assert.equal(compare(0.2, 'lte', 0.2), true)
  assert.equal(compare(0.2, 'lt', 0.2), false)
  assert.equal(compare(0.69, 'gte', 0.7), false)
  assert.equal(compare(0.21, 'lte', 0.2), false)
})

// ─── merge_ready and CI class ────────────────────────────────────────────────

const BAND: EscalationItem = { check: 'touches_auth', reason: 'band', p: 0.785, threshold: 0.8, question: 'x', files: [] }
const COVERAGE: EscalationItem = { reason: 'coverage', question: 'y', files: ['static/app.min.js'] }
const lane = (name: string) => POLICY.lanes[severity(name)]

test('merge_ready: last lane, no escalation, full coverage', () => {
  assert.equal(mergeReady(lane('MERGE'), POLICY, [], COMPLETE), true)
  assert.equal(mergeReady(lane('MERGE'), POLICY, [BAND], COMPLETE), false)
  assert.equal(mergeReady(lane('MERGE'), POLICY, [], { ...COMPLETE, incomplete: true }), false)
  assert.equal(mergeReady(lane('NITS'), POLICY, [], COMPLETE), false)
  assert.deepEqual(valuesFromVerdict(CHECKS, lane('MERGE'), [], COMPLETE), { merge_ready: { value: 1, source: 'computed' } })
  assert.deepEqual(valuesFromVerdict(CHECKS, lane('MERGE'), [BAND], COMPLETE), { merge_ready: { value: 0, source: 'computed' } })
  assert.deepEqual(valuesFromVerdict(CHECKS, lane('BLOCK'), [], COMPLETE), { merge_ready: { value: 0, source: 'computed' } })
})

test('CI class: untrusted_input for partial and incomplete coverage, even with NITS', () => {
  const base = { escalation: [] as EscalationItem[], partial: COMPLETE, outcome: 'ok' as const }
  assert.deepEqual(ciConclusion({ ...base, lane: lane('MERGE') }, POLICY), { conclusion: 'success' })
  assert.deepEqual(ciConclusion({ ...base, lane: lane('BLOCK') }, POLICY), { conclusion: 'failure' })
  assert.deepEqual(ciConclusion({ ...base, lane: lane('SECURITY REVIEW') }, POLICY), { conclusion: 'neutral' })
  // an escalation on the merits with a success lane → escalation.ci
  assert.deepEqual(ciConclusion({ ...base, lane: lane('MERGE'), escalation: [BAND] }, POLICY), { conclusion: 'neutral' })
  // partial coverage: NITS would give success, the class gives failure
  const partial = ciConclusion({ ...base, lane: lane('NITS'), partial: { omitted: 0, unreviewable: 1, incomplete: false }, escalation: [COVERAGE] }, POLICY)
  assert.deepEqual(partial, { conclusion: 'failure', class: 'untrusted_input', reason: 'partial coverage: 1 file not examined' })
  // incomplete outcome
  const inc = ciConclusion({ ...base, lane: lane('NITS'), outcome: 'incomplete' }, POLICY)
  assert.deepEqual(inc, { conclusion: 'failure', class: 'untrusted_input', reason: 'incomplete review' })
  // backend off: neutral, unless the lane (a floor, for example) is more severe
  const off = ciConclusion({ ...base, lane: lane('MERGE'), outcome: 'error', backendUnavailable: true }, POLICY)
  assert.deepEqual(off, { conclusion: 'neutral', class: 'backend_unavailable', reason: 'backend unavailable' })
  const fromFloor = ciConclusion({ ...base, lane: lane('BLOCK'), outcome: 'error', backendUnavailable: true }, POLICY)
  assert.equal(fromFloor.conclusion, 'failure')
  // backend off with omitted files: the more severe class wins
  const both = ciConclusion({
    ...base, lane: lane('NITS'), outcome: 'error', backendUnavailable: true, partial: { omitted: 2, unreviewable: 0, incomplete: false },
  }, POLICY)
  assert.equal(both.conclusion, 'failure')
  assert.equal(both.class, 'untrusted_input')
  // whoever wants a hard gate sets failure on an unavailable backend too
  const hard = { ...POLICY, ci: { backend_unavailable: 'failure' as const, untrusted_input: 'failure' as const } }
  assert.equal(ciConclusion({ ...base, lane: lane('MERGE'), outcome: 'error', backendUnavailable: true }, hard).conclusion, 'failure')
})
