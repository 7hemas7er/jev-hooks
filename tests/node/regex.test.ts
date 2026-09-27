// Project detectors in the Worker: they give the same hits as the core, and a
// regex with catastrophic backtracking stops at the time limit instead of blocking the
// hook.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateChecks, validatePolicy } from '../../src/core/config.ts'
import { parseDiff } from '../../src/core/diff.ts'
import { detect } from '../../src/core/detectors.ts'
import type { Policy, Detector } from '../../src/core/types.ts'
import { matchPathsInWorker, detectInWorker } from '../../src/node/regex.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECKS = (() => {
  const e = validateChecks(JSON.parse(readFileSync(join(root, 'config/checks.json'), 'utf8')), 'checks.json')
  if (!e.ok) throw new Error(e.error.message)
  return e.value
})()
const POLICY = (() => {
  const e = validatePolicy(JSON.parse(readFileSync(join(root, 'config/policy.json'), 'utf8')), CHECKS, 'policy.json')
  if (!e.ok) throw new Error(e.error.message)
  return e.value
})()

function fromProject(name: string, regex: RegExp): Detector {
  return { name: name, label: name, where: ['added_lines'], regex, exclude_paths: [], floor: 'SECURITY REVIEW', escalate: 'always', fromProject: true }
}

function diff(lines: string[]): ReturnType<typeof parseDiff> {
  const text = ['diff --git a/src/x.py b/src/x.py', 'new file mode 100644', '--- /dev/null', '+++ b/src/x.py',
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((r) => `+${r}`)].join('\n') + '\n'
  return parseDiff(text, { maxBytes: 1_000_000, maxLineChars: 2000 })
}

const META = { title: 't', description: null }

test('in the Worker: the same hits and floors as the core, with cloned RegExps', async () => {
  const p: Policy = { ...POLICY, detectors: [fromProject('forbidden_word', /\bstrictlyforbidden\b/i)] }
  const d = diff(['x = 1', 'y = "STRICTLYFORBIDDEN"'])
  const inWorker = await detectInWorker(p, d, META)
  assert.deepEqual(inWorker, detect(d, META, p))
  assert.equal(inWorker?.hits[0].line, 2)
  assert.deepEqual(inWorker?.floors, [{ lane: 'SECURITY REVIEW', by: ['forbidden_word'] }])
})

test('regex with catastrophic backtracking: null within the time limit', async () => {
  const p: Policy = { ...POLICY, detectors: [fromProject('hanging', /^(a+)+$/)] }
  const d = diff([`${'a'.repeat(40)}!`])
  const t0 = performance.now()
  const e = await detectInWorker(p, d, META, { timeMs: 300 })
  const ms = performance.now() - t0
  assert.equal(e, null)
  assert.ok(ms < 3000, `duration ${ms}`)
})

test('path regexes of a project checks.json in the Worker: the same results as the regex on the main thread', async () => {
  const regex = [{ source: '(^|/)docs/', flags: 'i' }, { source: '\\.md$', flags: '' }, { source: 'nothing', flags: '' }]
  const paths = ['docs/a.md', 'DOCS/b.txt', 'src/c.md', 'src/d.py']
  const e = await matchPathsInWorker(regex, paths)
  assert.deepEqual(e, regex.map(({ source, flags }) => paths.flatMap((x, j) => (new RegExp(source, flags).test(x) ? [j] : []))))
  assert.deepEqual(e, [[0, 1], [0, 2], []])
})

test('path regexes with polynomial backtracking (they pass the static check): null within the time limit', async () => {
  // eight ".*a" separated by a required letter: on 90 characters of "a" it would take hours
  const regex = [{ source: '.*a'.repeat(8) + '!', flags: 'i' }]
  const t0 = performance.now()
  const e = await matchPathsInWorker(regex, [`docs/${'a'.repeat(80)}/readme.md`], { timeMs: 300 })
  const ms = performance.now() - t0
  assert.equal(e, null)
  assert.ok(ms < 3000, `duration ${ms}`)
})
