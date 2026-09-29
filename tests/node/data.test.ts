// State dir: precedence, 0700/0600 permissions, atomic writes, log with
// rotation, a log line without the diff or the title, the last review for `explain`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendLog, dataDir, escalationAlreadyDenied, localIso, readJsonFile, logLine, writeAtomic, markEscalationDenied, lastReview,
} from '../../src/node/data.ts'
import type { ReviewResult } from '../../src/core/types.ts'

function temp(): { dir: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'jev-hooks-data-'))
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) }
}

const RESULT: ReviewResult = {
  outcome: 'ok', lane: 'NITS', exit_code: 1, fired: [], unevaluated: [], merge_ready: false,
  values: { hardcoded_secret: { value: 0.2154, raw: 0.02, source: 'model', worst: ['src/secret-in-the-path.py'] }, docs_only: { value: 0, source: 'computed' } },
  escalation: [{ check: 'touches_auth', reason: 'band', question: 'Touches authentication: …', files: ['src/auth.py'] }, { reason: 'coverage', question: 'Coverage', files: [] }],
  hits: [{ detector: 'secret_assignment', label: 'x', where: 'added_lines', file: 'src/a.py', line: 3 }],
  files: { examined: ['src/a.py', 'src/b.py'], ignored: ['yarn.lock'], unreviewable: [], omitted: [] },
  ci: { conclusion: 'success' },
  backend: { host: '192.168.1.50:8017', model: 'rizzo-spark-x2.5-4b-bf16', fingerprint: 'fp', profile: 'rizzo-provisional', calibrated: false, mode: 'client', notes: [] },
  requests: 3, ms: 4120.4, input_tokens: 5000, shape: 'chunks', redactions: 0,
  config_sources: { policy: '~/.config/jev-hooks/policy.json' },
  config_hashes: { diff: 'd1', checks: 'c1', policy: 'p1', calibration: 'k1', 'question.hardcoded_secret': 'h1' },
}

test('data dir: CLAUDE_PLUGIN_DATA, then XDG_STATE_HOME, then ~/.local/state', () => {
  assert.equal(dataDir({ HOME: '/h', CLAUDE_PLUGIN_DATA: '/data' }), '/data')
  assert.equal(dataDir({ HOME: '/h', XDG_STATE_HOME: '/st' }), '/st/jev-hooks')
  assert.equal(dataDir({ HOME: '/h' }), '/h/.local/state/jev-hooks')
})

test('atomic write: 0600 on the file, 0700 on the directory, no temporary file left behind', () => {
  const t = temp()
  try {
    const f = join(t.dir, 'sub', 'state.json')
    writeAtomic(f, '{"a":1}')
    writeAtomic(f, '{"a":2}')
    assert.deepEqual(readJsonFile(f), { a: 2 })
    assert.equal(statSync(f).mode & 0o777, 0o600)
    assert.equal(statSync(join(t.dir, 'sub')).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(join(t.dir, 'sub')), ['state.json'])
    writeFileSync(join(t.dir, 'broken.json'), '{ no')
    assert.equal(readJsonFile(join(t.dir, 'broken.json')), undefined)
    assert.equal(readJsonFile(join(t.dir, 'missing.json')), undefined)
  } finally {
    t.close()
  }
})

test('log: one JSON line per review, rotation past the cap', () => {
  const t = temp()
  try {
    const f = join(t.dir, 'log.jsonl')
    appendLog(f, { n: 1 }, { maxBytes: 30 })
    appendLog(f, { n: 2, filler: 'x'.repeat(40) }, { maxBytes: 30 })
    appendLog(f, { n: 3 }, { maxBytes: 30 })
    assert.equal(readFileSync(f, 'utf8'), '{"n":3}\n')
    assert.ok(existsSync(join(t.dir, 'log.1.jsonl')))
    assert.equal(statSync(f).mode & 0o777, 0o600)
  } finally {
    t.close()
  }
})

test('log line: numbers, sha and backend; never paths, titles or questions', () => {
  const line = logLine(RESULT, { origin: 'cli', repo: 'jev-hooks', ts: new Date(2026, 9, 2, 10, 0, 0) })
  assert.equal(line.outcome, 'ok')
  assert.equal(line.lane, 'NITS')
  assert.deepEqual(line.files, { examined: 2, ignored: 1, omitted: 0 })
  assert.deepEqual((line.values as Record<string, unknown>).hardcoded_secret, { raw: 0.02, cal: 0.2154 })
  assert.deepEqual(line.escalation, ['touches_auth', 'coverage'])
  assert.deepEqual(line.detectors, ['secret_assignment'])
  assert.deepEqual(line.sha, { diff: 'd1', checks: 'c1', policy: 'p1', calibration: 'k1', questions: { hardcoded_secret: 'h1' } })
  assert.equal(line.ms, 4120)
  assert.match(String(line.ts), /^2026-10-02T10:00:00[+-]\d\d:\d\d$/)
  assert.equal('plugin_version' in line, false)
  assert.equal(logLine(RESULT, { origin: 'hook', version: '0.8.0' }).plugin_version, '0.8.0')
  const text = JSON.stringify(line)
  for (const forbidden of ['src/', 'yarn.lock', 'Touches authentication']) assert.ok(!text.includes(forbidden), forbidden)
})

// The result carries model and fingerprint as they are shown to Claude (a hash if the
// trusted configuration does not know them); the log, material for the calibration fit,
// carries the real names.
test('log line: the real model and fingerprint from the identity, if the caller passes it', () => {
  const shown = { ...RESULT, backend: { ...RESULT.backend, model: 'sha256:111111111111', fingerprint: 'sha256:222222222222' } }
  const real = logLine(shown, { origin: 'hook', identity: { model: 'rizzo-spark-x2.5-4b-bf16', fingerprint: 'fp-real' } })
  assert.deepEqual([(real.backend as any).model, (real.backend as any).fingerprint], ['rizzo-spark-x2.5-4b-bf16', 'fp-real'])
  // without a fingerprint in the identity the result's hash does not stay
  assert.equal('fingerprint' in (logLine(shown, { origin: 'hook', identity: { model: 'm' } }).backend as object), false)
  // from a cache entry there is no identity: what the result shows stays
  assert.equal((logLine(shown, { origin: 'hook' }).backend as any).model, 'sha256:111111111111')
})

test('last review: the most recent valid line with a profile', () => {
  const t = temp()
  try {
    const f = join(t.dir, 'log.jsonl')
    assert.equal(lastReview(f), undefined)
    appendLog(f, logLine(RESULT, { origin: 'hook' }))
    appendLog(f, { outcome: 'commit_done', review_id: 'x' })
    writeFileSync(f, `${readFileSync(f, 'utf8')}{ broken line\n`)
    assert.deepEqual(Object.keys(lastReview(f) ?? {}).sort(), ['mode', 'profile', 'ts'])
    assert.equal(lastReview(f)?.profile, 'rizzo-provisional')
  } finally {
    t.close()
  }
})

// An escalation already denied lasts ttl_min: afterwards, the same diff with the same
// items goes back to Claude. Without an expiry, yesterday's deny would let today's
// commit through.
test('escalation already denied: true within ttl_min, false after; expired keys are pruned', () => {
  const t = temp()
  try {
    const now = Date.now()
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 60, now), false)
    markEscalationDenied(t.dir, 'k1', 60)
    assert.equal(statSync(join(t.dir, 'escalation', 'k1.json')).mode & 0o777, 0o600)
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 60, now), true)
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 60, now + 59 * 60_000), true)
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 60, now + 61 * 60_000), false)
    // the expiry is the ttl passed in, not a fixed one
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 1, now + 30_000), true)
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 1, now + 2 * 60_000), false)
    // another key was not denied
    assert.equal(escalationAlreadyDenied(t.dir, 'k2', 60, now), false)

    // a key aged by two minutes, with ttl 1: expired, and the next write prunes it
    const before = (now - 2 * 60_000) / 1000
    utimesSync(join(t.dir, 'escalation', 'k1.json'), before, before)
    assert.equal(escalationAlreadyDenied(t.dir, 'k1', 1), false)
    markEscalationDenied(t.dir, 'k2', 1)
    assert.deepEqual(readdirSync(join(t.dir, 'escalation')), ['k2.json'])
  } finally {
    t.close()
  }
})

test('local date with time zone', () => {
  assert.match(localIso(new Date(0)), /^19(69|70)-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
})
