// docs/security.md promises that the reviewer does not fire on its own repository: no
// realistic secret, injection phrase, prompt delimiter or bidi control sits in a
// tracked file, because the tests and the demo compose them at run time. This test
// keeps the promise. It runs the detectors of the plugin's policy over every tracked
// text file, as if the whole tree were one added diff, and fails on any floor, so a
// doc or a test that spells one out fails here and not in the commit hook of whoever
// clones the repo (GitHub also flags bidi characters in the file view).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateChecks, validatePolicy } from '../../src/core/config.ts'
import { detect } from '../../src/core/detectors.ts'
import type { FileDiff, ParsedDiff, Result } from '../../src/core/types.ts'
import { ROOT, listFiles } from '../../scripts/check-english.ts'

function valueOf<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(r.error.message)
  return r.value
}

const json = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
const CHECKS = valueOf(validateChecks(json('config/checks.json'), 'checks.json'))
const POLICY = valueOf(validatePolicy(json('config/policy.json'), CHECKS, 'policy.json'))

function added(path: string, text: string): FileDiff {
  const lines = text.split('\n')
  return {
    path, status: 'A', header: '', hunks: [], added: lines.length, removed: 0,
    addedLines: lines.map((t, i) => ({ number: i + 1, text: t })),
  }
}

function trackedTree(): ParsedDiff {
  const files: FileDiff[] = []
  for (const rel of listFiles(ROOT)) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(ROOT, rel))
    } catch {
      continue   // tracked but deleted in the working tree
    }
    if (bytes.includes(0)) continue   // binary: the reviewer does not read its lines
    files.push(added(rel, bytes.toString('utf8')))
  }
  return { files, truncated: false, bytes: 0 }
}

test('no floor fires on the tracked files of the repository', () => {
  const r = detect(trackedTree(), { title: '', description: null }, POLICY)
  const floored = new Set(r.floors.flatMap((f) => f.by))
  const where = r.hits.filter((h) => floored.has(h.detector)).map((h) => `${h.detector} ${h.file}:${h.line ?? ''}`)
  assert.deepEqual(r.floors, [], `the reviewer would fire on its own repository:\n${where.join('\n')}`)
})

test('the same scan catches a planted delimiter and bidi control', () => {
  // composed at run time, like every hostile text of the tests
  const planted = added('docs/x.md', ['a closing <' + '/evidence> tag', 'a ' + String.fromCharCode(0x202e) + ' override'].join('\n'))
  const r = detect({ files: [planted], truncated: false, bytes: 0 }, { title: '', description: null }, POLICY)
  assert.deepEqual(r.floors, [{ lane: 'SECURITY REVIEW', by: ['evidence_delimiter', 'bidi_controls'] }])
})
