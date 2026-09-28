// The CLI as the user runs it: `node bin/jev-review.mjs` in a subprocess, against the
// fake server with the demo scenario. One test for each demo diff,
// plus --json, --escalate, explain, status, the key that never comes out and the
// exit 4 cases.
//
// The demo diffs are generated here from examples/demo/ (scripts/generate-demo.ts): the
// repo holds only templates with placeholders. Every process has an environment built
// from scratch (temporary HOME, XDG_* and JEV_HOOKS_*): no real keys or configurations.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDemo } from '../../scripts/generate-demo.ts'
import { validateChecks, validatePolicy } from '../../src/core/config.ts'
import { parseDiff } from '../../src/core/diff.ts'
import { formatNumber } from '../../src/core/numbers.ts'
import { detect } from '../../src/core/detectors.ts'
import type { ReviewResult } from '../../src/core/types.ts'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer } from '../helpers/fake-systemone.ts'
import { createRepo } from '../helpers/git-repo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(ROOT, 'bin', 'jev-review.mjs')

let base = ''
let demo: Record<string, string> = {}
let fake: FakeServer
let closedPort = ''

interface Execution { code: number; out: string; err: string }

function makeDir(name: string): string {
  const h = join(base, name)
  mkdirSync(h, { recursive: true })
  return h
}

// An environment from scratch: no variables of the test process besides PATH.
function makeEnv(o: { home?: string; url?: string | null; extra?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const home = o.home ?? makeDir('home')
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), XDG_STATE_HOME: join(home, '.xdg-state') }
  if (o.url !== null) env.JEV_HOOKS_URL = o.url ?? fake.url
  return { ...env, ...o.extra }
}

function jev(args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string; nodeArgs?: string[] } = {}): Promise<Execution> {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, [...(o.nodeArgs ?? []), BIN, ...args], { cwd: o.cwd ?? base, env: o.env ?? makeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
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
    p.stdin.end(o.input ?? '')
  })
}

async function json(args: string[], o: Parameters<typeof jev>[1] = {}): Promise<{ code: number; r: ReviewResult & { escalation_prompt?: string }; err: string }> {
  const e = await jev([...args, '--json'], o)
  try {
    return { code: e.code, r: JSON.parse(e.out), err: e.err }
  } catch {
    assert.fail(`stdout is not JSON (exit ${e.code}):\n${e.out}\n${e.err}`)
  }
}

const verdict = (out: string): string | undefined => /━━━━ {2}(.+?) {2}━━━━/.exec(out)?.[1]
const systemone = (): number => fake.requests.filter((x) => x.path === '/v1/systemone').length

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-cli-'))
  demo = generateDemo(join(base, 'demo'), { seed: 20260925 })
  fake = await startFake({ scenario: 'demo' })
  const off = await startFake()
  closedPort = off.url
  await off.close()
})

after(async () => {
  await fake?.close()
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

// ─── The demo diffs ───────────────────────────────────────────────────────────

// The hardcoded_secret threshold in the plugin's policy, in the output's format.
function secretThreshold(): string {
  const p = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  const r = p.lanes.flatMap((c: { rules: { check: string; value: number }[] }) => c.rules).find((x: { check: string }) => x.check === 'hardcoded_secret')
  return formatNumber(r.value, 2)
}

test('secret.diff: hardcoded_secret 0.874 above the escalation threshold: NITS and the question goes to Claude, the model does not block (exit 1)', async () => {
  const before = systemone()
  const e = await jev(['--diff', demo['secret.diff'], '--no-color'])
  assert.equal(e.code, 1, e.err)
  assert.equal(verdict(e.out), 'NITS')
  assert.match(e.out, new RegExp(`NITS {2}hardcoded_secret 0\\.87 ≥ ${secretThreshold()} \\(policy\\) → escalation`))
  assert.match(e.out, new RegExp(`1\\. above the escalation threshold · hardcoded_secret · p = 0\\.87 · threshold ${secretThreshold()}\n {5}files: src/auth/tokens\\.py \\(lines 1–8\\)`))
  assert.doesNotMatch(e.out, /floor:|BLOCK/)
  assert.equal(systemone() - before, 2, 'single shape: the chunk and the global one')
})

test('the same diff with the threshold at 0.95 in the user file: MERGE (exit 0), and explain shows the source', async () => {
  const home = makeDir('home-user-095')
  mkdirSync(join(home, '.config', 'jev-hooks'), { recursive: true })
  copyFileSync(join(ROOT, 'examples', 'user', 'policy.json'), join(home, '.config', 'jev-hooks', 'policy.json'))
  const env = makeEnv({ home })
  const e = await jev(['--diff', demo['secret.diff'], '--no-color'], { env })
  assert.equal(e.code, 0, e.err)
  assert.equal(verdict(e.out), 'MERGE')
  assert.match(e.out, /policy\.json = ~\/\.config\/jev-hooks\/policy\.json/)
  // 0.874 is below 0.95 and the rule with escalation has no band: no item.
  // secret_assignment hits SIGNING_KEY, but the model does not deny it (0.87 says yes):
  // no disagreement. MERGE without escalation, so the commit hook with the same user
  // policy also lets the commit through at the first attempt.
  const { r } = await json(['--diff', demo['secret.diff']], { env })
  assert.deepEqual(r.escalation, [])
  assert.equal(r.merge_ready, true)
  const s = await jev(['explain', 'hardcoded_secret', '--profile', 'rizzo-provisional'], { env })
  assert.equal(s.code, 0, s.err)
  assert.match(s.out, /effective threshold 0\.95 · source: policy \(~\/\.config\/jev-hooks\/policy\.json\)/)
})

test('whoever wants the model to block: a rule in BLOCK in the user file, and secret.diff gives BLOCK (exit 3)', async () => {
  const home = makeDir('home-user-block')
  mkdirSync(join(home, '.config', 'jev-hooks'), { recursive: true })
  const p = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  p.lanes[0].rules.push({ check: 'hardcoded_secret', op: 'gte', value: 0.8 })
  writeFileSync(join(home, '.config', 'jev-hooks', 'policy.json'), JSON.stringify(p))
  const e = await jev(['--diff', demo['secret.diff'], '--no-color'], { env: makeEnv({ home }) })
  assert.equal(e.code, 3, e.err)
  assert.equal(verdict(e.out), 'BLOCK')
  assert.match(e.out, /BLOCK {2}hardcoded_secret 0\.87 ≥ 0\.80 \(policy\)\n/)
  // the plugin's escalation rule stays: Claude gets the question anyway
  assert.match(e.out, /above the escalation threshold · hardcoded_secret/)
})

test('the same diff with the threshold at 0.95 in an uncommitted .jev-hooks/: the project does not loosen, NITS, and the note says so', async () => {
  const repo = createRepo()
  try {
    repo.write('README.md', 'project\n')
    repo.commit('first')
    repo.write('.jev-hooks/policy.json', JSON.stringify({ lanes: [{ name: 'NITS', rules: [{ check: 'hardcoded_secret', op: 'gte', value: 0.95 }] }] }))
    const e = await jev(['--diff', demo['secret.diff'], '--no-color'], { cwd: repo.dir, env: makeEnv({ home: repo.home }) })
    assert.equal(e.code, 1, e.err)
    assert.equal(verdict(e.out), 'NITS')
    assert.match(e.out, /above the escalation threshold · hardcoded_secret/)
    assert.match(e.err, /\.jev-hooks\/policy\.json \/lanes\/0\/rules\/0: field ignored: looser threshold from the project/)
    assert.match(e.err, /rules in \.jev-hooks\/ differ from HEAD \(policy\.json\): the CLI uses the working tree ones/)
  } finally {
    repo.close()
  }
})

test('known-secret.diff with the server off: BLOCK from the stripe_live floor (exit 3)', async () => {
  const e = await jev(['--diff', demo['known-secret.diff'], '--no-color'], { env: makeEnv({ url: closedPort }) })
  assert.equal(e.code, 3, e.err)
  assert.equal(verdict(e.out), 'BLOCK')
  assert.match(e.out, /floor: stripe_live in src\/payments\.py:3/)
  assert.match(e.out, /backend unreachable: deterministic block/)
})

test('fixture-test.diff: a test key and hunter2 in tests/, MERGE (exit 0)', async () => {
  const e = await jev(['--diff', demo['fixture-test.diff'], '--no-color'])
  assert.equal(e.code, 0, e.err)
  assert.equal(verdict(e.out), 'MERGE')
  assert.doesNotMatch(e.out, /fired rules/)
})

test('fixture-live.diff: sk_live_ in tests/fixtures.py, BLOCK from the floor and a disagreement escalation on the file of the hit', async () => {
  const { code, r } = await json(['--diff', demo['fixture-live.diff']])
  assert.equal(code, 3)
  assert.equal(r.lane, 'BLOCK')
  assert.ok(r.fired.some((s) => s.source === 'floor' && s.check === 'stripe_live'))
  const d = r.escalation.find((v) => v.reason === 'disagreement')
  assert.ok(d, JSON.stringify(r.escalation))
  assert.equal(d.check, 'hardcoded_secret')
  assert.deepEqual(d.files, ['tests/fixtures.py'])
})

test('readme-typos.diff: tests missing 0.99, adds_tests 0.01 ≤ 0.30, but the unless on docs_only = 1 cancels it: MERGE', async () => {
  // the threshold in the name is the one in config/policy.json: if it changes, update the name
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  const rule = policy.lanes.flatMap((l: { rules: { check: string }[] }) => l.rules).find((x: { check: string }) => x.check === 'adds_tests')
  assert.deepEqual([rule.op, rule.value], ['lte', 0.3])
  assert.deepEqual(rule.unless, { check: 'docs_only', op: 'gte', value: 0.5 })
  const { code, r } = await json(['--diff', demo['readme-typos.diff']])
  assert.equal(code, 0)
  assert.equal(r.lane, 'MERGE')
  // a choice with a value and invert: 1 − P(none) = 0.99 is "tests missing", the reported value is 1 − 0.99
  assert.ok(Math.abs(r.values.adds_tests.value - 0.01) < 1e-9, String(r.values.adds_tests.value))
  // without the unless the rule would fire
  assert.ok(r.values.adds_tests.value <= rule.value)
  assert.equal(r.values.adds_tests.option, 'code_without_test_file')
  assert.equal(r.values.docs_only.value, 1)
  assert.equal(r.fired.length, 0)
})

test('injection.diff: SECURITY REVIEW from the floor, detector escalation (exit 2)', async () => {
  const { code, r } = await json(['--diff', demo['injection.diff']])
  assert.equal(code, 2)
  assert.equal(r.lane, 'SECURITY REVIEW')
  assert.ok(r.fired.some((s) => s.source === 'floor' && s.check === 'reviewer_instructions'))
  assert.ok(r.escalation.some((v) => v.reason === 'detector' && v.files.includes('src/util.py')))
})

test('uncertain.diff: touches_auth 0.78 above the escalation threshold, NITS with the question to Claude; --escalate gives the prompt', async () => {
  const { code, r } = await json(['--diff', demo['uncertain.diff'], '--escalate'])
  assert.equal(code, 1)
  assert.equal(r.lane, 'NITS')
  assert.equal(r.merge_ready, false)
  const v = r.escalation.find((x) => x.reason === 'threshold')
  assert.ok(v, JSON.stringify(r.escalation))
  assert.equal(v.check, 'touches_auth')
  assert.ok(Math.abs((v.p ?? 0) - 0.78) < 0.001)
  assert.ok((v.threshold ?? 1) <= 0.78)
  assert.equal(v.band, undefined)
  assert.deepEqual(v.files, ['src/middleware/session.py'])
  assert.match(r.escalation_prompt ?? '', /touches_auth/)
  assert.match(r.escalation_prompt ?? '', /Read only these files/)
  const t = await jev(['--diff', demo['uncertain.diff'], '--escalate', '--no-color'])
  assert.match(t.out, /escalation \(1\):[\s\S]*\[jev-review\] escalation: 1 point to check\.[\s\S]*src\/middleware\/session\.py \(lines 10–14\)/)
})

test('minified.diff: NITS for partial coverage, a coverage escalation, failure in CI (exit 1)', async () => {
  const { code, r } = await json(['--diff', demo['minified.diff']])
  assert.equal(code, 1)
  assert.equal(r.lane, 'NITS')
  assert.deepEqual(r.files.unreviewable, ['static/app.min.js'])
  assert.ok(r.escalation.some((v) => v.reason === 'coverage'))
  assert.equal(r.ci.conclusion, 'failure')
  assert.equal(r.ci.class, 'untrusted_input')
})

test('empty diff: exit 0, no request', async () => {
  const before = systemone()
  const e = await jev(['--diff', demo['empty.diff'], '--no-color'])
  assert.equal(e.code, 0, e.err)
  assert.match(e.out, /empty diff: nothing to review/)
  assert.equal(systemone(), before)
})

test('URL https://api.typesafe.ai without a key: exit 4, no request', async () => {
  const e = await jev(['--diff', demo['secret.diff'], '--url', 'https://api.typesafe.ai', '--no-color'], { env: makeEnv({ url: null }) })
  assert.equal(e.code, 4)
  assert.match(e.out, /api\.typesafe\.ai requires a key: set TYPESAFE_API_KEY/)
})

// ─── The rest of the CLI ──────────────────────────────────────────────────────

test('no backend configured: exit 4 and what to set', async () => {
  const e = await jev(['--diff', demo['uncertain.diff'], '--no-color'], { env: makeEnv({ url: null }) })
  assert.equal(e.code, 4)
  assert.match(e.out, /backend not configured: set JEV_HOOKS_URL/)
})

test('--json: the full ReviewResult, with raw and calibrated values', async () => {
  const { r } = await json(['--diff', demo['secret.diff']])
  // rizzo-provisional does not transform nouls: raw and calibrated coincide
  assert.equal(r.values.hardcoded_secret.raw, 0.874)
  assert.equal(r.values.hardcoded_secret.value, 0.874)
  assert.equal(r.backend.profile, 'rizzo-provisional')
  assert.equal(typeof r.config_hashes.diff, 'string')
})

test('--diff - reads the diff from standard input; --title ends up in the global state', async () => {
  const before = fake.requests.length
  const e = await jev(['--diff', '-', '--title', 'Sign the tokens', '--no-color'], { input: readFileSync(demo['secret.diff'], 'utf8') })
  assert.equal(e.code, 1, e.err)
  assert.match(e.out, /^jev-review · Sign the tokens$/m)
  const states = fake.requests.slice(before).map((x) => String((x.json as { state?: string }).state))
  assert.ok(states.some((s) => s.startsWith('[title]\n  Sign the tokens')))
})

test('explain: the profile of the last review recorded with JEV_HOOKS_LOG, and the log line', async () => {
  const home = makeDir('home-log')
  const log = join(home, 'reviews.jsonl')
  const env = makeEnv({ home, extra: { JEV_HOOKS_LOG: log } })
  const e = await jev(['--diff', demo['secret.diff'], '--no-color'], { env })
  assert.equal(e.code, 1)
  const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop() as string)
  assert.equal(line.origin, 'cli')
  assert.equal(line.lane, 'NITS')
  assert.deepEqual(line.escalation, ['hardcoded_secret'])
  assert.equal(line.backend.profile, 'rizzo-provisional')
  assert.ok(!JSON.stringify(line).includes('SIGNING_KEY'), 'the diff does not enter the log')
  const s = await jev(['explain', 'hardcoded_secret'], { env })
  assert.equal(s.code, 0, s.err)
  assert.match(s.out, /profile rizzo-provisional \(uncalibrated; last recorded review/)
  assert.match(s.out, /calibrator: identity · profile rizzo-provisional/)
  // without JEV_HOOKS_LOG the CLI does not write into the state dir
  assert.equal(existsSync(join(makeDir('home'), '.xdg-state')), false)
})

test('explain without JEV_HOOKS_LOG: no fallback to a directory the hooks do not use, and it says so', async () => {
  // The hooks write the log to CLAUDE_PLUGIN_DATA, which Claude Code gives only to them. A
  // line in the XDG state dir was written by neither of the two: it does not count.
  const home = makeDir('home-without-log')
  const env = makeEnv({ home })
  const xdg = join(home, '.xdg-state', 'jev-hooks')
  mkdirSync(xdg, { recursive: true })
  writeFileSync(join(xdg, 'log.jsonl'), `${JSON.stringify({ ts: '2026-09-25T10:00:00+02:00', backend: { profile: 'jev', mode: 'client' } })}\n`)
  const s = await jev(['explain', 'hardcoded_secret'], { env })
  assert.equal(s.code, 0, s.err)
  assert.doesNotMatch(s.out, /last recorded review/)
  assert.match(s.out, /calibrator: no profile/)
  assert.match(s.out, /the CLI looks for it only in the JEV_HOOKS_LOG log \(the hooks' log is in the plugin data dir, CLAUDE_PLUGIN_DATA\)/)
  assert.match(s.out, /jev-review explain hardcoded_secret --profile NAME/)
})

test('explain: unknown check or profile → exit 4 with the list', async () => {
  const a = await jev(['explain', 'does_not_exist'])
  assert.equal(a.code, 4)
  assert.match(a.err, /hardcoded_secret, injection_risk/)
  const b = await jev(['explain', 'hardcoded_secret', '--profile', 'dunno'])
  assert.equal(b.code, 4)
  assert.match(b.err, /rizzo-provisional, jev, clm-provisional, unknown/)
})

test('status: GET /v1/models plus a real decision', async () => {
  const e = await jev(['status'])
  assert.equal(e.code, 0, e.err)
  // the names the backend gives itself as a hash: Claude reads the output too
  assert.match(e.out, /model: requested jev-latest, served sha256:[0-9a-f]{12} · family rizzo/)
  assert.match(e.out, /models: rizzo-latest, sha256:[0-9a-f]{12}/)
  assert.match(e.out, /fingerprint: sha256:[0-9a-f]{12}\n/)
  assert.doesNotMatch(e.out, /fake-fp-1|rizzo-spark|uncalibrated_/)
  assert.match(e.out, /profile: rizzo-provisional \(uncalibrated\) · calibration client/)
  assert.match(e.out, /probe decision: hardcoded_secret in \d+\.\d\d s/)
  const off = await jev(['status'], { env: makeEnv({ url: closedPort }) })
  assert.equal(off.code, 4)
  assert.match(off.err, /unreachable/)
})

test('the key never comes out: not with the right one, not with the wrong one, not from the file', async () => {
  const key = ['test', 'key', 'not', 'to', 'be', 'printed'].join('-')
  const withKey = await startFake({ scenario: 'demo', key })
  try {
    const right = await jev(['--diff', demo['secret.diff'], '--json'], { env: makeEnv({ url: withKey.url, extra: { JEV_HOOKS_KEY: key } }) })
    assert.equal(right.code, 1, right.err)
    const wrong = await jev(['--diff', demo['uncertain.diff']], { env: makeEnv({ url: withKey.url, extra: { JEV_HOOKS_KEY: `${key}-no` } }) })
    assert.equal(wrong.code, 4)
    assert.match(wrong.out, /key rejected by the backend \(HTTP 401\).* \(source: JEV_HOOKS_\*\)/)
    const home = makeDir('home-key')
    mkdirSync(join(home, '.config', 'jev-hooks'), { recursive: true })
    writeFileSync(join(home, '.config', 'jev-hooks', 'key'), `${key}\n`, { mode: 0o600 })
    const fromFile = await jev(['status'], { env: makeEnv({ home, url: withKey.url }) })
    assert.equal(fromFile.code, 0, fromFile.err)
    for (const e of [right, wrong, fromFile]) {
      assert.ok(!e.out.includes(key) && !e.err.includes(key), 'the key in the output')
      assert.ok(!e.out.includes('Bearer') && !e.err.includes('Bearer'))
    }
    assert.ok(withKey.requests.some((x) => x.headers.authorization === `Bearer ${key}`))
  } finally {
    await withKey.close()
  }
})

test('invalid user configuration: exit 4 with file and pointer', async () => {
  const home = makeDir('home-broken')
  mkdirSync(join(home, '.config', 'jev-hooks'), { recursive: true })
  writeFileSync(join(home, '.config', 'jev-hooks', 'policy.json'), JSON.stringify({ version: 1, lanes: [] }))
  const e = await jev(['--diff', demo['secret.diff']], { env: makeEnv({ home }) })
  assert.equal(e.code, 4)
  assert.match(e.err, /invalid user configuration:\n {2}~\/\.config\/jev-hooks\/policy\.json/)
})

test('invalid arguments: exit 4 with the usage; the key is never a flag', async () => {
  const a = await jev(['--api-key', 'x'])
  assert.equal(a.code, 4)
  assert.match(a.err, /the key is never passed as a flag/)
  assert.match(a.err, /^usage:/m)
  const b = await jev(['--diff', 'a', '--staged'])
  assert.equal(b.code, 4)
  assert.match(b.err, /one source at a time/)
  const c = await jev(['--help'])
  assert.equal(c.code, 0)
  assert.match(c.out, /Exit code: 0 MERGE, 1 NITS, 2 SECURITY REVIEW, 3 BLOCK, 4 error/)
})

test('Node without type stripping: the launcher says so, exit 4', async () => {
  const e = await jev(['--help'], { nodeArgs: ['--no-experimental-strip-types'] })
  assert.equal(e.code, 4)
  assert.match(e.err, /Node >= 22\.18 with type stripping enabled is needed/)
})

test('the demo templates in the repo do not make the default detectors fire', () => {
  const read = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  const checks = validateChecks(read('config/checks.json'), 'checks.json')
  assert.ok(checks.ok)
  const policy = validatePolicy(read('config/policy.json'), checks.value, 'policy.json')
  assert.ok(policy.ok)
  for (const name of Object.keys(demo).filter((n) => n !== 'empty.diff')) {
    const model = readFileSync(join(ROOT, 'examples', 'demo', name), 'utf8')
    const d = parseDiff(model, { maxBytes: 1_000_000, maxLineChars: 2000 })
    assert.ok(d.files.length > 0, name)
    assert.deepEqual(detect(d, { title: '', description: null }, policy.value).hits, [], name)
  }
})

test('examples/user/policy.json is config/policy.json with only the hardcoded_secret escalation threshold at 0.95', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, 'config', 'policy.json'), 'utf8'))
  const user = JSON.parse(readFileSync(join(ROOT, 'examples', 'user', 'policy.json'), 'utf8'))
  const rule = (p: { lanes: { name: string; rules: Record<string, unknown>[] }[] }): Record<string, unknown> => {
    const nits = p.lanes.find((c) => c.name === 'NITS')
    const r = nits?.rules.find((x) => x.check === 'hardcoded_secret')
    assert.ok(r)
    return r
  }
  const u = rule(user)
  const k = rule(plugin)
  assert.equal(u.value, 0.95)
  assert.equal(u.action, 'escalation')
  assert.ok((k.value as number) < 0.874, 'in the plugin the demo\'s secret goes to Claude')
  // the reason for the demo's threshold is its own: it points to the plugin's, it does not copy it
  assert.match(u._why as string, /^Demo threshold: the plugin's is lower/)
  u.value = k.value
  u._why = k._why
  delete user._comment
  delete plugin._comment
  assert.deepEqual(user, plugin)
})
