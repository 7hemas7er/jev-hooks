import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchConfig } from '../../bench/verify.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROWS = readFileSync(join(ROOT, 'bench', 'live-reviews.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const QUESTIONS = [...benchConfig(ROOT).questions].sort()

// The rows hold no diff: the commit is in this repo's history, and the diff the
// reviewer saw is `git diff <DIFF_FLAGS> <commit>^ <commit>`.
test('live-reviews.jsonl: one row per commit, a label for every question the model is asked', () => {
  const ids = new Set<string>()
  const commits = new Set<string>()
  for (const r of ROWS) {
    assert.deepEqual(Object.keys(r), ['id', 'commit', 'title', 'labels', 'note'], r.id)
    assert.match(r.commit, /^[0-9a-f]{40}$/, r.id)
    assert.equal(r.id, `review-${r.commit.slice(0, 7)}`)
    assert.ok(!ids.has(r.id) && !commits.has(r.commit), `duplicate ${r.id}`)
    ids.add(r.id)
    commits.add(r.commit)
    assert.ok(typeof r.title === 'string' && r.title.length > 0 && r.title.length <= 200, r.id)
    assert.deepEqual(Object.keys(r.labels).sort(), QUESTIONS, r.id)
    for (const q of QUESTIONS) assert.equal(typeof r.labels[q], 'boolean', `${r.id} ${q}`)
    // a yes always says which line decides it
    for (const q of QUESTIONS) if (r.labels[q]) assert.ok(r.note.includes(q), `${r.id}: no note for ${q}`)
  }
})

test('live-reviews.jsonl: every commit is in the history, when the checkout has it', (t) => {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' })
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') {
    t.skip('shallow or missing git history')
    return
  }
  for (const r of ROWS) {
    const e = spawnSync('git', ['cat-file', '-e', `${r.commit}^{commit}`], { cwd: ROOT })
    assert.equal(e.status, 0, `${r.id}: commit not found`)
  }
})
