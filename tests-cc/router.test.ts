// The effort router inside Claude Code's own test kit (claude-code/testing): the
// engine's host loads hooks/register.ts and the real core in the environment its hooks
// really run in, and the test answers from beneath whatever the plugin asks of `$`.
// tests/router/register.test.ts plays every case on a fake `$` under Node; this file
// checks that the main path holds in the engine too: the project files found from a
// worktree, the request that leaves, the effort the engine is asked to use for the
// turn, the subagent left alone, the timeout on the kit's clock, and a user router.json
// refused beneath keeping the router off.
//
// Run by `node scripts/test-cc.ts`, never by node --test: its glob covers tests/ only,
// and 'claude-code/testing' exists only inside `claude plugin test`. The kit loads the
// plugin with the manifest's defaults and cannot set an option, so the script stages a
// copy with effort_router on; review_url is empty there, and the backend comes from
// JEV_HOOKS_ROUTER_URL through mock.env (a URL, never a key, from the environment).
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DEFAULT_ROUTER } from '../src/core/defaults.ts'

const BACKEND = 'http://127.0.0.1:8017'
const OPUS = 'claude-opus-5-5'
const TEXT = 'rename x to y in src/a.ts'
const TASKS = Object.keys(DEFAULT_ROUTER.questions.task_kind.criteria)

// A rizzo-like answer from a Jev backend (profile jev: probabilities used as they
// come): a small edit at 0.9, nothing risky, no depth asked.
function reply(task: string): string {
  const rest = 0.1 / (TASKS.length - 1)
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      task_kind: { type: 'choice', choice: task, probabilities: Object.fromEntries(TASKS.map((k) => [k, k === task ? 0.9 : rest])), confidence: 0.8 },
      scope: { type: 'score', score: 1, probabilities: { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.1 }, confidence: 0.6 },
      has_error_evidence: { type: 'noul', noul: 0.02 },
      risky_irreversible: { type: 'noul', noul: 0.01 },
      underspecified: { type: 'noul', noul: 0.1 },
      multi_deliverable: { type: 'noul', noul: 0.05 },
      explicit_depth: { type: 'choice', choice: 'none', probabilities: { quick: 0.05, thorough: 0.05, none: 0.9 }, confidence: 0.8 },
    },
  })
}

interface Seen { turnId: string; index: number; effort?: unknown; agentId?: string }

// Everything beneath the plugin: clock and env from the kit's mocks, the rest answered
// here. The backend answers at once, or 5 s later on the kit's clock. The session runs
// in a subdirectory of a linked worktree, whose .git is the only one there is.
const MAIN = '/work/main'
const WT = '/work/wt'
const USER_ROUTER = '/home/kit/.config/jev-hooks/router.json'

// The kit has no file system: every read is answered here, and a deny is how a hook
// refuses one. The engine words a deny `<plugin>: $.fs.read: <reason>`, so a reason that
// ends as its own missing-file rejection (`: ENOENT`) is a file that is not there, which
// is all this world holds; the paths in `refused` get another reason, as a file that is
// there and cannot be read.
function world(on: On, answerAfterMs: number, refused: readonly string[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/kit', JEV_HOOKS_ROUTER_URL: BACKEND })
  const logs: string[] = []
  const reads: string[] = []
  const fetches: { url: string; method?: string; body?: string }[] = []
  const steps: Seen[] = []
  on('ui.log', ($, e) => {
    logs.push(`${e.to}|${e.text}`)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return { deny: refused.includes(e.path) ? 'refused by the test' : `${e.path}: ENOENT` }
  })
  on('fs.exists', ($, e) => ({ value: e.path === `${WT}/.git` }))
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: `${WT}/sub` }))
  on('http.fetch', async ($, e) => {
    fetches.push({ url: e.url, method: e.init?.method, body: e.init?.body })
    if (answerAfterMs > 0) await clock.sleep(answerAfterMs)
    return { value: { status: 200, ok: true, headers: {}, text: reply('small_edit') } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const s: Seen = { turnId: e.turnId, index: e.index, effort: e.effort }
    if (e.agentId !== undefined) s.agentId = e.agentId
    steps.push(s)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { clock, logs, reads, fetches, steps }
}

// The kit's stream: its .result reads undefined, the generator's last value is the result.
async function drain(s: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

const step = (turnId: string, index: number, extra: Record<string, unknown> = {}) =>
  ({ turnId, index, model: OPUS, effort: 'high', messageCount: 1 + 2 * index, ...extra }) as never

test('a composer prompt reaches the backend and lowers its turn; a subagent step is untouched', async ($, on) => {
  const w = world(on, 0)
  const entered = await $.prompt.submit({ text: TEXT, wait: false, origin: { kind: 'composer' } } as never)
  expect(entered).toMatchObject({ text: TEXT })

  expect(w.fetches).toHaveLength(1)
  expect(w.fetches[0].url).toBe(`${BACKEND}/v1/systemone`)
  expect(w.fetches[0].method).toBe('POST')
  const body = JSON.parse(w.fetches[0].body ?? '')
  expect(body.state).toBe(TEXT)
  expect(body.model).toBe('jev-latest')
  expect(Object.keys(body.questions)).toEqual(Object.keys(DEFAULT_ROUTER.questions))
  // the project file of the worktree, found by the walk up, and the main working tree's
  expect(w.reads.filter((p) => p.endsWith('/.jev-hooks/router.json'))).toEqual([
    `${WT}/.jev-hooks/router.json`, `${MAIN}/.jev-hooks/router.json`,
  ])

  await $.turn.start({ text: TEXT, turnId: 't1' })
  await drain($.turn.step(step('t1', 0)))
  await drain($.turn.step(step('t1', 0, { agentId: 'a1' })))
  await drain($.turn.step(step('t1', 1)))
  expect(w.steps).toEqual([
    { turnId: 't1', index: 0, effort: 'low' },
    { turnId: 't1', index: 0, effort: 'high', agentId: 'a1' },
    { turnId: 't1', index: 1, effort: 'low' },
  ])
  expect(w.logs).toContain('transcript|[jev-hooks] effort high → low: small_edit 0.90: -2 → low')
})

test('a prompt without a composer origin is not sent, and its turn keeps its effort', async ($, on) => {
  const w = world(on, 0)
  await $.prompt.submit({ text: TEXT, wait: false } as never)
  expect(w.fetches).toHaveLength(0)
  await $.turn.start({ text: TEXT, turnId: 't1' })
  await drain($.turn.step(step('t1', 0)))
  expect(w.steps).toEqual([{ turnId: 't1', index: 0, effort: 'high' }])
})

test('a user router.json that cannot be read keeps the router off, with one note', async ($, on) => {
  // it may hold the user's "enabled": false
  const w = world(on, 0, [USER_ROUTER])
  await $.prompt.submit({ text: TEXT, wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: TEXT, wait: false, origin: { kind: 'composer' } } as never)
  expect(w.reads).toContain(USER_ROUTER)
  expect(w.fetches).toHaveLength(0)
  expect(w.logs.filter((l) => l.startsWith('transcript|'))).toEqual([
    'transcript|[jev-hooks] router: ~/.config/jev-hooks/router.json: unreadable, the router stays off until it can be read',
  ])
  await $.turn.start({ text: TEXT, turnId: 't1' })
  await drain($.turn.step(step('t1', 0)))
  expect(w.steps).toEqual([{ turnId: 't1', index: 0, effort: 'high' }])
})

test('no answer within timeout_ms: the prompt goes on at that time and the turn keeps its effort', async ($, on) => {
  const w = world(on, 5_000)
  let settled = false
  const p = $.prompt.submit({ text: TEXT, wait: false, origin: { kind: 'composer' } } as never).then((r) => {
    settled = true
    return r
  })
  await w.clock.settle()
  await w.clock.advance(DEFAULT_ROUTER.timeout_ms - 1)
  expect(settled).toBe(false)
  await w.clock.advance(1)
  await p
  expect(settled).toBe(true)
  expect(w.fetches).toHaveLength(1)
  expect(w.logs).toContain(`transcript|[jev-hooks] router: no answer in ${DEFAULT_ROUTER.timeout_ms} ms, turn left as is`)

  await $.turn.start({ text: TEXT, turnId: 't1' })
  await drain($.turn.step(step('t1', 0)))
  expect(w.steps).toEqual([{ turnId: 't1', index: 0, effort: 'high' }])
  // the late answer lands and changes nothing: not the running turn, not a later turn
  // with the same text, not the log
  const logsBefore = [...w.logs]
  await w.clock.advance(5_000)
  await drain($.turn.step(step('t1', 1)))
  await $.turn.start({ text: TEXT, turnId: 't2' })
  await drain($.turn.step(step('t2', 0)))
  expect(w.steps).toEqual([
    { turnId: 't1', index: 0, effort: 'high' },
    { turnId: 't1', index: 1, effort: 'high' },
    { turnId: 't2', index: 0, effort: 'high' },
  ])
  expect(w.logs).toEqual(logsBefore)
})
