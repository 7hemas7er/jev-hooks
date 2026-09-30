// The policy simulator (scripts/simulate-policy.ts), offline: on the two bench sets
// already measured (dev-checks and holdout), on a fake measurement built here, and from
// the command line. No network and no real user file: the user layer is always a
// temporary directory.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../src/core/sha256.ts'
import { wireQuestion, questionHash } from '../../src/core/systemone.ts'
import { effectiveConfig, parseReport, main, summarize, simulate } from '../../scripts/simulate-policy.ts'
import type { Summary, Simulation } from '../../scripts/simulate-policy.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOLDOUT = join(ROOT, 'bench', 'results', '2026-09-26-holdout')
const DEV = join(ROOT, 'bench', 'results', '2026-09-26-dev-checks')

let base = ''
let empty = ''

before(() => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-simulate-'))
  empty = join(base, 'empty-user')
  mkdirSync(empty)
})

after(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

function run(dir: string, configDir: string = empty): { s: Simulation; r: Summary } {
  const c = effectiveConfig({ configDir })
  const s = simulate({ dir, config: c })
  return { s, r: summarize(s, c.policy.lanes.map((x) => x.name)) }
}

const lane = (r: Summary, name: string) => r.lanes.find((x) => x.lane === name)
const item = (r: Summary, name: string) => r.escalation.find((x) => x.item === name)

// The bench's p, read separately: the comparison with the simulator does not go through its code.
function raw(dir: string): Map<string, Map<string, { p: number; y: boolean | null }>> {
  const out = new Map<string, Map<string, { p: number; y: boolean | null }>>()
  for (const line of readFileSync(join(dir, 'raw.jsonl'), 'utf8').trim().split('\n')) {
    const x = JSON.parse(line)
    if (x.variant !== 'attuale' || typeof x.p !== 'number') continue
    const m = out.get(x.id) ?? new Map()
    m.set(x.question, { p: x.p, y: x.label })
    out.set(x.id, m)
  }
  return out
}

// ─── The two bench sets with the plugin's policy ──────────────────────────────

for (const [name, dir, clean, total] of [['holdout', HOLDOUT, 34, 121], ['dev-checks', DEV, 28, 118]] as const) {
  test(`${name}: the model never sends a clean diff to BLOCK or SECURITY REVIEW, and the escalation on the clean ones is the one the thresholds lead to expect`, () => {
    const { s, r } = run(dir)
    assert.deepEqual(s.warnings, [])
    assert.equal(s.config.profile, 'spark-bf16-2026-09', 'the profile of the measured fingerprint')
    assert.equal(s.diffs.length, total)
    assert.equal(r.clean, clean)
    assert.equal(r.clean + r.withProblem, total)
    // policy v2: BLOCK and SECURITY REVIEW only from the floors, and the clean ones have none
    assert.equal(lane(r, 'BLOCK')?.clean.n, 0)
    assert.equal(lane(r, 'SECURITY REVIEW')?.clean.n, 0)
    for (const c of r.lanes.filter((x) => x.lane === 'BLOCK' || x.lane === 'SECURITY REVIEW')) {
      assert.equal(c.fromFloor.n, c.clean.n + c.withProblem.n, `${c.lane}: all from a floor`)
    }
    // rule 5: no band around the rules with escalation, so on the clean ones the
    // model's escalation is exactly the one the thresholds lead to expect
    assert.equal(item(r, 'band'), undefined)
    assert.equal(r.fromModel.clean.n, r.fromModel.expectedClean.n)
    assert.equal(r.fromModel.withProblem.n, r.fromModel.expected.n)
  })

  test(`${name}: TPR and FPR per rule as from the bench's p compared with the policy.json thresholds`, () => {
    const { s, r } = run(dir)
    const p = raw(dir)
    for (const [k, rule] of s.rules.entries()) {
      // the unless of adds_tests looks at the diff's paths: the simulator checks it,
      // here the rules without conditions are compared
      if (rule.rule.unless) continue
      const { check, op, value } = rule.rule
      let tp = 0
      let pos = 0
      let fp = 0
      let neg = 0
      for (const m of p.values()) {
        const x = m.get(check)
        if (!x || x.y === null) continue
        const fires = op === 'gte' ? x.p >= value : op === 'gt' ? x.p > value : op === 'lte' ? x.p <= value : x.p < value
        if (x.y) {
          pos++
          if (fires) tp++
        } else {
          neg++
          if (fires) fp++
        }
      }
      assert.deepEqual([r.rules[k].tp, r.rules[k].positives, r.rules[k].fp, r.rules[k].negatives], [tp, pos, fp, neg], rule.text)
    }
  })
}

test('holdout with the policy from before v2: 10 clean diffs out of 34 in BLOCK, as measured before the decision', () => {
  // the policy of the morning of 2026-09-26: the model's rules in BLOCK and SECURITY REVIEW
  const pj = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  const rules: Record<string, { check: string; op: string; value: number; unless?: unknown }[]> = {
    BLOCK: [{ check: 'hardcoded_secret', op: 'gte', value: 0.7 }, { check: 'injection_risk', op: 'gte', value: 0.7 }, { check: 'weakens_tests', op: 'gte', value: 0.8 }],
    'SECURITY REVIEW': [{ check: 'breaks_api', op: 'gte', value: 0.6 }, { check: 'data_migration', op: 'gte', value: 0.6 }, { check: 'touches_auth', op: 'gte', value: 0.5 }],
    NITS: [{ check: 'debug_leftovers', op: 'gte', value: 0.7 }, { check: 'adds_tests', op: 'lte', value: 0.5, unless: { check: 'docs_only', op: 'gte', value: 0.5 } }],
  }
  for (const c of pj.lanes) c.rules = rules[c.name] ?? []
  const dir = join(base, 'before-v2')
  mkdirSync(dir)
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(pj))
  const { s, r } = run(HOLDOUT, dir)
  assert.match(s.config.sources.policy, /before-v2\/policy\.json$/)
  assert.deepEqual([lane(r, 'BLOCK')?.clean.n, lane(r, 'BLOCK')?.clean.of], [10, 34])
  // without rules with escalation, the band is all extra escalation
  assert.equal(r.fromModel.expectedClean.n, 0)
  assert.ok((item(r, 'band')?.clean.n ?? 0) > 0)
})

test('--config-dir: a threshold changed in the user file changes the counts at once, without querying the model', () => {
  const pj = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  for (const c of pj.lanes) for (const x of c.rules) if (x.action === 'escalation') x.value = 1
  const dir = join(base, 'thresholds-at-one')
  mkdirSync(dir)
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(pj))
  const before = run(HOLDOUT).r
  const after = run(HOLDOUT, dir).r
  assert.ok(before.fromModel.clean.n > 0)
  assert.ok(after.fromModel.clean.n < before.fromModel.clean.n, `${after.fromModel.clean.n} < ${before.fromModel.clean.n}`)
  // a broken user file stops the simulation: the numbers would not be those of the file
  const broken = join(base, 'broken')
  mkdirSync(broken)
  writeFileSync(join(broken, 'policy.json'), '{ "lanes": [] }')
  assert.throws(() => effectiveConfig({ configDir: broken }), /invalid user configuration/)
})

// ─── A fake measurement ───────────────────────────────────────────────────────

const DIFF = (path: string, line: string): string => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@', `+${line}`, '',
].join('\n')

function fakeMeasurement(o: { shaDataset?: string; secretSha?: string; withoutReport?: boolean; lines: object[]; dataset: object[] }): string {
  const dir = mkdtempSync(join(base, 'measurement-'))
  const dataset = join(dir, 'dataset.jsonl')
  const text = o.dataset.map((x) => JSON.stringify(x)).join('\n') + '\n'
  writeFileSync(dataset, text)
  const c = effectiveConfig({ configDir: empty })
  const sha = (id: string): string => questionHash(wireQuestion(c.checks.defs[id]))
  if (!o.withoutReport) {
    writeFileSync(join(dir, 'report.md'), [
      '# Question measurement', '',
      '- Backend: `127.0.0.1:8017` (local), requested model `jev-latest`',
      '- Declared model: `rizzo-spark-x2.5-4b-bf16`',
      '- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`',
      '- probability_status: `uncalibrated_conditional_option_scores`',
      `- Dataset: \`${dataset}\`, ${o.dataset.length} diffs, sha256 \`${o.shaDataset ?? sha256Hex(text)}\``,
      '- Placeholder seed: 1; repeats: 1; Node v24',
      '', '## Variant hashes', '', '| question | variant | type | sha256 |', '|---|---|---|---|',
      `| hardcoded_secret | attuale (checks.json) | noul | \`${o.secretSha ?? sha('hardcoded_secret')}\` |`,
      `| touches_auth | attuale (checks.json) | noul | \`${sha('touches_auth')}\` |`,
      '',
    ].join('\n'))
  }
  writeFileSync(join(dir, 'raw.jsonl'), o.lines.map((x) => JSON.stringify({ repeat: 1, variant: 'attuale', readout: 'p', ms: 1, ...x })).join('\n') + '\n')
  return dir
}

test('fake measurement: report read, clean and with a problem, a missing p makes the review incomplete', () => {
  const dir = fakeMeasurement({
    dataset: [
      { id: 'clean', diff: DIFF('src/sum.py', 'def add(a, b): return a + b'), title: 'Sum', description: null, labels: { hardcoded_secret: false, touches_auth: false } },
      { id: 'auth', diff: DIFF('src/auth/session.py', 'EXPIRY = 0'), title: 'Sessions', description: null, labels: { hardcoded_secret: false, touches_auth: true } },
      { id: 'missing', diff: DIFF('src/other.py', 'x = 1'), title: 'Other', description: null, labels: { hardcoded_secret: false, touches_auth: false } },
    ],
    lines: [
      { id: 'clean', question: 'hardcoded_secret', p: 0.01, raw: 0.01, label: false },
      { id: 'clean', question: 'touches_auth', p: 0.02, raw: 0.02, label: false },
      { id: 'auth', question: 'hardcoded_secret', p: 0.01, raw: 0.01, label: false },
      { id: 'auth', question: 'touches_auth', p: 0.99, raw: 0.99, label: true },
      { id: 'missing', question: 'hardcoded_secret', p: null, raw: null, label: false, error: 'missing answers' },
      { id: 'missing', question: 'touches_auth', p: 0.02, raw: 0.02, label: false },
    ],
  })
  const { s, r } = run(dir)
  assert.deepEqual(s.warnings, [])
  assert.equal(s.config.profile, 'spark-bf16-2026-09')
  assert.deepEqual(s.diffs.map((d) => [d.id, d.clean, d.lane]), [['clean', true, 'MERGE'], ['auth', false, 'NITS'], ['missing', true, 'NITS']])
  // touches_auth above the threshold: a threshold item with the diff's file
  const auth = s.diffs[1].items
  assert.deepEqual(auth.map((v) => [v.reason, v.check, v.files]), [['threshold', 'touches_auth', ['src/auth/session.py']]])
  // a missing answer: partial coverage, as in review()
  assert.ok(s.diffs[2].items.some((v) => v.reason === 'coverage'))
  assert.deepEqual([r.clean, r.withProblem], [2, 1])
  assert.deepEqual([item(r, 'threshold')?.clean.n, item(r, 'threshold')?.withProblem.n], [0, 1])
})

test('fake measurement: dataset or question changed after the measurement → warnings; without a report, no profile', () => {
  const dataset = [{ id: 'a', diff: DIFF('src/a.py', 'x = 1'), title: 'A', description: null, labels: { hardcoded_secret: false } }]
  const lines = [{ id: 'a', question: 'hardcoded_secret', p: 0.01, raw: 0.01, label: false }]
  const changed = run(fakeMeasurement({ dataset, lines, shaDataset: '0'.repeat(64), secretSha: '1'.repeat(64) })).s
  assert.ok(changed.warnings.some((a) => a.includes('changed after the measurement')), changed.warnings.join('\n'))
  assert.ok(changed.warnings.some((a) => a.startsWith('hardcoded_secret: the checks.json question is not the measured one')), changed.warnings.join('\n'))
  const dir = fakeMeasurement({ dataset, lines, withoutReport: true })
  assert.throws(() => run(dir), /the report does not name the dataset/)
  const c = effectiveConfig({ configDir: empty })
  const s = simulate({ dir: dir, config: c, dataset: join(dir, 'dataset.jsonl') })
  assert.equal(s.config.profile, 'none')
  assert.ok(s.warnings.some((a) => a.startsWith('report.md missing')))
})

test('parseReport: identity, dataset, seed and hashes as the measurement writes them', () => {
  const m = parseReport(readFileSync(join(HOLDOUT, 'report.md'), 'utf8'), HOLDOUT)
  assert.deepEqual(m.identity, {
    host: '127.0.0.1:8017', model: 'rizzo-spark-x2.5-4b-bf16', family: 'rizzo',
    fingerprint: '64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a',
    probabilityStatus: ['uncalibrated_conditional_option_scores'],
  })
  assert.equal(m.dataset?.path, 'bench/holdout.jsonl')
  assert.equal(m.seed, 1)
  assert.equal(Object.keys(m.questionHashes).length, 9)
})

// ─── Command line ─────────────────────────────────────────────────────────────

test('command line: text and --json on the two sets, exit 2 for a usage error', () => {
  let out = ''
  const env = { ...process.env, XDG_CONFIG_HOME: empty, HOME: base }
  assert.equal(main([HOLDOUT, DEV], env, (x) => { out += x }), 0)
  assert.match(out, /^simulate-policy · bench\/results\/2026-09-26-holdout$/m)
  assert.match(out, /^BLOCK +0\/34 +0\.0%/m)
  assert.match(out, /^simulate-policy · bench\/results\/2026-09-26-dev-checks$/m)
  assert.match(out, /from the model \(threshold or band\): clean (\d+)\/34, expected from the thresholds \1\/34/)
  let json = ''
  assert.equal(main([HOLDOUT, '--json'], env, (x) => { json += x }), 0)
  const [r] = JSON.parse(json)
  assert.equal(r.dir, 'bench/results/2026-09-26-holdout')
  assert.equal(r.clean, 34)
  let errors = ''
  const error = (x: string): void => { errors += x }
  assert.equal(main([], env, () => {}, error), 2)
  assert.equal(main([join(base, 'does-not-exist')], env, () => {}, error), 2)
  assert.equal(main([HOLDOUT, '--dunno'], env, () => {}, error), 2)
  assert.match(errors, /missing the directory[\s\S]*raw\.jsonl is missing[\s\S]*unknown option: --dunno/)
})

// ─── The calibration changes no decision ──────────────────────────────────────

// The Spark's profile as it was before its fit: the same entries without a and b.
function uncalibrated(dir: string, policy?: unknown): string {
  mkdirSync(dir, { recursive: true })
  const c = JSON.parse(readFileSync(join(ROOT, 'config', 'calibration.json'), 'utf8'))
  for (const p of c.profiles) {
    if (p.name !== 'spark-bf16-2026-09') continue
    p.calibrated = false
    for (const e of Object.values(p.per_question as Record<string, Record<string, unknown>>)) for (const k of ['a', 'b', 'n', 'errors']) delete e[k]
  }
  writeFileSync(join(dir, 'calibration.json'), JSON.stringify(c))
  if (policy !== undefined) writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy))
  return dir
}

// A user policy that uses what the plugin's does not: every critical rule without its
// action, so the band applies around it, and detectors that escalate when the model
// disagrees, on two fitted questions.
function bandsAndDisagreement(): unknown {
  const p = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  for (const lane of p.lanes) for (const r of lane.rules) delete r.action
  p.detectors.push(
    { name: 'user_sql', label: 'SQL text', check: 'injection_risk', where: ['added_lines'], regex: '\\b(select|insert|update|delete|query|exec)\\b', flags: 'i', floor: null, escalate: 'if_model_disagrees' },
    { name: 'user_auth', label: 'Auth text', check: 'touches_auth', where: ['added_lines'], regex: '\\b(auth|login|token|session|role|permission)', flags: 'i', floor: null, escalate: 'if_model_disagrees' },
  )
  return p
}

const decisions = (s: Simulation) => s.diffs.map((d) => ({
  id: d.id, lane: d.lane, fromFloor: d.fromFloor, fires: d.fires, items: d.items.map((v) => [v.reason, v.check ?? v.detector, v.files]),
}))

for (const [name, dir] of [['holdout', HOLDOUT], ['dev-checks', DEV]] as const) {
  test(`${name}: the calibrated profile decides every diff as the raw one, with the plugin's policy and with bands and disagreement`, () => {
    for (const [label, policy] of [['plugin policy', undefined], ['bands and disagreement', bandsAndDisagreement()]] as const) {
      const cal = policy === undefined ? run(dir) : run(dir, (() => {
        const d = join(base, `cal-${name}-${label.replace(/\W/g, '')}`)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'policy.json'), JSON.stringify(policy))
        return d
      })())
      const rawRun = run(dir, uncalibrated(join(base, `raw-${name}-${label.replace(/\W/g, '')}`), policy))
      assert.equal(cal.s.config.calibrated, true, label)
      assert.equal(rawRun.s.config.calibrated, false, label)
      assert.deepEqual(decisions(cal.s), decisions(rawRun.s), label)
      if (policy !== undefined) {
        // the case is not empty: the band and the detectors do produce items here
        const reasons = new Set(cal.s.diffs.flatMap((d) => d.items.map((v) => v.reason)))
        assert.ok(reasons.has('band') && reasons.has('disagreement'), [...reasons].join(', '))
      }
      // what is shown does move: some thresholds in the items are on the calibrated scale
      const shown = (s: Simulation) => s.diffs.flatMap((d) => d.items.map((v) => v.threshold)).filter((t) => t !== undefined)
      assert.notDeepEqual(shown(cal.s), shown(rawRun.s), label)
    }
  })
}
