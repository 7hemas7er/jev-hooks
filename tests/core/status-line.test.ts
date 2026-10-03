// The status line's pure parts: where the running version and its data folder are in
// Claude Code's plugin cache, which names beside it are newer versions, the session's
// last review in the log, and the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dataFolderOf, joinStatus, lastReview, manifestVersion, mayCommit, newerVersions, statusText, versionFolder,
} from '../../src/core/status-line.ts'

const CACHE = '/home/u/.claude/plugins/cache/7hemas7er-jev-hooks/jev-hooks'

test('versionFolder: a version folder of the plugin cache, not a checkout', () => {
  assert.deepEqual(versionFolder(`${CACHE}/0.14.0`), { parent: CACHE, version: '0.14.0' })
  assert.deepEqual(versionFolder(`${CACHE}/0.14.0/`), { parent: CACHE, version: '0.14.0' })
  assert.equal(versionFolder('/home/u/repos/jev-hooks'), null)
  assert.equal(versionFolder(`${CACHE}/0.15.0-beta.1`), null)
  assert.equal(versionFolder('0.14.0'), null)
})

test('newerVersions: newer names only, newest first, compared as numbers', () => {
  const names = ['0.9.0', '0.13.0', '0.100.0', '0.14.0', '0.14.1', 'notes', '1.0.0-rc.1', '0.15.0']
  assert.deepEqual(newerVersions('0.14.0', names), ['0.100.0', '0.15.0', '0.14.1'])
  assert.deepEqual(newerVersions('0.100.0', names), [])
  assert.deepEqual(newerVersions('dev', names), [])
})

test('dataFolderOf: <plugins>/data/<plugin>-<marketplace> from the cache path, null otherwise', () => {
  assert.equal(dataFolderOf(`${CACHE}/0.14.0`), '/home/u/.claude/plugins/data/jev-hooks-7hemas7er-jev-hooks')
  assert.equal(dataFolderOf('/home/u/repos/jev-hooks'), null)
  assert.equal(dataFolderOf('/home/u/.claude/plugins/other/m/jev-hooks/0.14.0'), null)
})

test('manifestVersion: the version a plugin.json declares, or null', () => {
  assert.equal(manifestVersion('{"name":"jev-hooks","version":"0.15.0"}'), '0.15.0')
  assert.equal(manifestVersion('{"name":"jev-hooks"}'), null)
  assert.equal(manifestVersion('not json'), null)
})

test('lastReview: the session\'s last completed review, other sessions and outcomes skipped', () => {
  const s = 'a1b2c3d4-0000-4000-8000-000000000001'
  const log = [
    JSON.stringify({ session: s, outcome: 'ok', lane: 'MERGE', escalation: [] }),
    JSON.stringify({ session: s, outcome: 'ok', lane: 'NITS', escalation: ['hardcoded_secret', 7] }),
    JSON.stringify({ session: 'another', outcome: 'ok', lane: 'BLOCK', escalation: [] }),
    JSON.stringify({ session: s, outcome: 'commit_done' }),
    JSON.stringify({ session: s, outcome: 'uncertain', reason: 'command not recognized' }),
    `{"session":"${s}","outcome":"ok","lane":"ME`,
    '',
  ].join('\n')
  assert.deepEqual(lastReview(log, s), { lane: 'NITS', escalation: ['hardcoded_secret'] })
  assert.equal(lastReview(log, 'nobody'), null)
  assert.equal(lastReview(log, ''), null)
  assert.equal(lastReview('', s), null)
})

test('mayCommit: the commit hook\'s first filter', () => {
  assert.equal(mayCommit('git commit -m "x"'), true)
  assert.equal(mayCommit('git -C repo commit --amend'), true)
  assert.equal(mayCommit('ls -la'), false)
})

test('statusText and joinStatus: the line, and the router\'s text after it', () => {
  assert.equal(statusText({ running: '0.15.0' }), 'jev 0.15.0 · no commit reviewed yet')
  assert.equal(statusText({ running: '0.15.0', last: { lane: 'MERGE', escalation: [] } }), 'jev 0.15.0 · last commit MERGE')
  assert.equal(
    statusText({ running: '0.15.0', newer: '0.16.0', last: { lane: 'NITS', escalation: ['hardcoded_secret', 'weakens_tests'] } }),
    'jev 0.15.0 · 0.16.0 installed: /reload-plugins · last commit NITS, escalated hardcoded_secret, weakens_tests',
  )
  assert.equal(joinStatus('jev 0.15.0', 'jev router: high → medium'), 'jev 0.15.0 · jev router: high → medium')
  assert.equal(joinStatus('jev 0.15.0', undefined), 'jev 0.15.0')
  assert.equal(joinStatus(undefined, 'jev router: off'), 'jev router: off')
  assert.equal(joinStatus(undefined, undefined), undefined)
  assert.equal(joinStatus('', ''), undefined)
})
