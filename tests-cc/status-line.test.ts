// The status line inside Claude Code's own test kit: the engine's host loads
// hooks/register.ts and the test answers from beneath what the line asks of `$`. The
// kit loads the staged copy as a folder that is not a version, as a --plugin-dir
// checkout: the running version comes from its plugin.json, the log from
// CLAUDE_PLUGIN_DATA. tests/router/register.test.ts covers the cache layout, the newer
// version and the failures on a fake `$`; this file checks that the line reaches the
// engine's ui.status from turn.start and after a Bash commit.
//
// Run by `node scripts/test-cc.ts`, never by node --test (see router.test.ts).
import { test, expect, mock } from 'claude-code/testing'

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'
const LOG = '/data/jev-hooks/log.jsonl'
const review = (lane: string, escalation: string[] = []): string =>
  JSON.stringify({ ts: '2026-10-03T15:00:00+02:00', origin: 'hook', session: SESSION, outcome: 'ok', lane, escalation })

test('the line: version from plugin.json, the session\'s last review, again after a Bash commit', async ($, on) => {
  mock.env(on, { HOME: '/home/kit', CLAUDE_PLUGIN_DATA: '/data/jev-hooks' })
  let log = [review('MERGE'), ''].join('\n')
  const shown: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: SESSION }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'jev-hooks', version: '9.9.9' }) }
    if (e.path === LOG) return { value: log }
    return { deny: `${e.path}: ENOENT` }
  })
  on('fs.exists', () => ({ value: false }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.turn.start({ text: '', turnId: 't1' })
  expect(shown.at(-1)).toBe('jev 9.9.9 · last commit MERGE')

  log = [review('MERGE'), review('NITS', ['hardcoded_secret']), ''].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Add sum"' })
  expect(shown.at(-1)).toBe('jev 9.9.9 · last commit NITS, escalated hardcoded_secret')
})
