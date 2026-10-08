// src/core/defaults.ts is a generated copy of config/router.json, config/agents.json
// and config/calibration.json (the module loader does not import .json). The source of
// truth stays the JSON: this test fails if someone changes one without the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_AGENTS, DEFAULT_CALIBRATION, DEFAULT_ROUTER } from '../../src/core/defaults.ts'
import { validateAgents, validateCalibration, validateRouter } from '../../src/core/config.ts'
import { expectedDefaults, main, TARGET, USAGE } from '../../scripts/generate-defaults.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

test('the defaults match the JSON files in config/', () => {
  assert.deepEqual(DEFAULT_ROUTER, json('config/router.json'))
  assert.deepEqual(DEFAULT_CALIBRATION, json('config/calibration.json'))
  assert.deepEqual(DEFAULT_AGENTS, json('config/agents.json'))
})

test('the generated file is identical to what the script would write', () => {
  assert.equal(readFileSync(TARGET, 'utf8'), expectedDefaults(), 'run node scripts/generate-defaults.ts again')
})

test('the defaults pass validation, as the router reads them', () => {
  const k = validateCalibration(DEFAULT_CALIBRATION, 'calibration.json (default)')
  assert.ok(k.ok, k.ok ? '' : k.error.message)
  if (!k.ok) return
  const r = validateRouter(DEFAULT_ROUTER, k.value, 'router.json (default)')
  assert.ok(r.ok, r.ok ? '' : r.error.message)
  const a = validateAgents(DEFAULT_AGENTS, k.value, 'agents.json (default)')
  assert.ok(a.ok, a.ok ? '' : a.error.message)
})

test('generate-defaults: --help prints the usage, an unknown argument is refused without writing', () => {
  const before = statSync(TARGET).mtimeMs
  const out: string[] = []
  const err: string[] = []
  assert.equal(main(['--help'], (s) => out.push(s), (s) => err.push(s)), 0)
  assert.deepEqual(out, [USAGE])
  // a typo of --check must not fall through to rewriting the file
  assert.equal(main(['--chek'], (s) => out.push(s), (s) => err.push(s)), 2)
  assert.match(err.join('\n'), /unknown argument "--chek"/)
  assert.equal(statSync(TARGET).mtimeMs, before)
})

test('validate-manifest: --help exits 0, an option or a second root exits 2', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'validate-manifest.ts'), ...args], { encoding: 'utf8' })
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^usage: node scripts\/validate-manifest\.ts \[root\]/)
  assert.equal(run('--strict').status, 2)
  assert.equal(run(root, root).status, 2)
  assert.equal(run(root).status, 0)
})
