// src/core/defaults.ts is a generated copy of config/router.json and
// config/calibration.json (the module loader does not import .json). The source of
// truth stays the JSON: this test fails if someone changes one without the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CALIBRATION, DEFAULT_ROUTER } from '../../src/core/defaults.ts'
import { validateCalibration, validateRouter } from '../../src/core/config.ts'
import { expectedDefaults, TARGET } from '../../scripts/generate-defaults.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

test('the defaults match the JSON files in config/', () => {
  assert.deepEqual(DEFAULT_ROUTER, json('config/router.json'))
  assert.deepEqual(DEFAULT_CALIBRATION, json('config/calibration.json'))
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
})
