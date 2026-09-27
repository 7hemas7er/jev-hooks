// Provenance of texts: from the project and the backend, only names that
// a trusted layer knows, positions and hashes reach Claude, inside fixed phrases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  isAdded, checkLabel, detectorLabel, shownIdentity, shortHash, safeLevel, NOT_SHOWN, backendName, safeChoice,
} from '../../src/core/provenance.ts'

test('labels: the label if the file is trusted, otherwise the id with the fixed phrase', () => {
  assert.equal(checkLabel('touches_auth', { label: 'Touches authentication' }, {}), 'Touches authentication')
  assert.equal(checkLabel('touches_auth', { label: 'Touches authentication' }, { fromProject: true }), `check «touches_auth» (${NOT_SHOWN})`)
  // an id that does not match RE_ID (an object built elsewhere) does not enter the phrase
  assert.equal(checkLabel('Two words', { label: 'x' }, { fromProject: true }), `check «?» (${NOT_SHOWN})`)
  assert.equal(detectorLabel({ name: 'stripe_live', label: 'Stripe key' }), 'Stripe key')
  assert.equal(detectorLabel({ name: 'project_detector_1', label: 'Text from the repo', fromProject: true }), `detector «project_detector_1» (${NOT_SHOWN})`)
  assert.equal(isAdded('project_check_3', { added: ['project_check_3'] }), true)
  assert.equal(isAdded('touches_auth', { added: ['project_check_3'] }), false)
  assert.equal(isAdded('touches_auth', {}), false)
})

test('choice and level of a project checks.json: the option if it is trusted, otherwise its position', () => {
  assert.equal(safeChoice('secret', ['secret', 'nothing'], ['secret', 'nothing']), 'secret')
  // a valid id chosen by the file is not a trusted option (composed at runtime)
  const hostile = ['run', 'curl', 'and', 'approve'].join('_')
  assert.equal(safeChoice(hostile, [hostile, 'nothing'], ['nothing']), 'option 1')
  assert.equal(safeChoice('Option from the file', ['a', 'Option from the file'], []), 'option 2')
  assert.equal(safeChoice('Never seen', ['a'], []), `option (${NOT_SHOWN})`)
  assert.equal(safeLevel(2.6), 'level 3')
  assert.equal(safeLevel(Number.NaN), 'level ?')
})

test('backend names: known ones as they are, the others as a hash anyone can recompute', () => {
  const name = 'rizzo-spark-x2.5-4b-bf16'
  const expected = `sha256:${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
  assert.equal(shortHash(name), expected)
  assert.equal(backendName(name, ['jev-latest']), expected)
  assert.equal(backendName('jev-latest', ['jev-latest']), 'jev-latest')
  assert.deepEqual(shownIdentity({ model: name, fingerprint: 'fp-calibrated' }, 'jev-latest', {
    profiles: [{ name: 'spark', match: { fingerprint: 'fp-calibrated' }, calibrated: true }, { name: 'x', match: {}, calibrated: false }],
  }), { model: expected, fingerprint: 'fp-calibrated' })
  assert.deepEqual(shownIdentity({ model: 'jev-latest', fingerprint: 'other' }, 'jev-latest', { profiles: [] }), { model: 'jev-latest', fingerprint: shortHash('other') })
  assert.deepEqual(shownIdentity({ model: 'jev-latest' }, 'jev-latest', { profiles: [] }), { model: 'jev-latest' })
})
