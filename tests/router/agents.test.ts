// hooks/register.ts's subagent router played on a fake Claude Code
// (tests/helpers/fake-dollar.ts): which spawns reach the backend, what model the
// engine is finally asked to start a subagent on, the steps of a workflow agent, the
// kill switches, what fails open and what it says. What the router decides is
// src/core/agents.ts's and is tested in tests/core/agents.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from '../../hooks/register.ts'
import { fakeClaude } from '../helpers/fake-dollar.ts'
import type { FakeClaude, HttpAnswer, SpawnInput, WorldOptions } from '../helpers/fake-dollar.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const AGENTS = json('config/agents.json')
const MANIFEST = json('.claude-plugin/plugin.json')
const DEFAULTS: Record<string, unknown> = Object.fromEntries(Object.entries(MANIFEST.userConfig).map(([k, v]) => [k, (v as { default: unknown }).default]))
const LOCAL_URL = 'http://192.168.1.50:8017'
// the effort router off, the line off: these tests are about the subagent router
const OPTIONS: Record<string, unknown> = { ...DEFAULTS, review_url: LOCAL_URL, agent_router: true, effort_router: false, status_line: false }
const HOME = '/home/test'
const REPO = '/work/repo'
const HAIKU = 'claude-haiku-5-5'

function world(o: WorldOptions = {}): FakeClaude {
  return fakeClaude(register as never, {
    ...o,
    options: { ...OPTIONS, ...o.options },
    env: { HOME, ...o.env },
    repoRoot: o.repoRoot === undefined ? REPO : o.repoRoot,
  })
}

const OPTS = Object.keys(AGENTS.questions.agent_task.criteria)
// A Jev answer (profile jev: probabilities as they come) with the task at top.
function reply(task: string, top = 0.8): HttpAnswer {
  const rest = (1 - top) / (OPTS.length - 1)
  const probabilities = Object.fromEntries(OPTS.map((k) => [k, k === task ? top : rest]))
  return { status: 200, text: JSON.stringify({ model: 'jev-1.13.0', answers: { agent_task: { type: 'choice', choice: task, probabilities, confidence: 0.8 } } }) }
}
const SKEPTIC = 'You are skeptic #2 checking a review finding. Decide whether it is real and give the evidence.'
const WORKFLOW = { runId: 'wf_test', agentIndex: 1 }

test('registration: agent.spawn only with agent_router; turn.step for either router; prompt.submit only with the effort router', () => {
  assert.equal(world({ options: { agent_router: false } }).registered.includes('agent.spawn'), false)
  const a = world()
  assert.ok(a.registered.includes('agent.spawn'))
  assert.ok(a.registered.includes('turn.step'))
  assert.equal(a.registered.includes('prompt.submit'), false)
  const both = world({ options: { effort_router: true } })
  assert.ok(both.registered.includes('agent.spawn') && both.registered.includes('prompt.submit'))
  const neither = world({ options: { agent_router: false, effort_router: false, status_line: false } })
  assert.deepEqual(neither.registered, [])
})

test('an Agent tool spawn classified as check_claim starts on Haiku; one classified as implement as it was', async () => {
  const w = world()
  w.answer(reply('check_claim', 0.62))
  const r = await w.spawn({ prompt: SKEPTIC })
  assert.equal(w.spawned[0].model, HAIKU)
  assert.deepEqual(r, { model: HAIKU, agentId: 'agent-test' })
  assert.equal(w.fetches.length, 1)
  assert.equal(w.fetches[0].url, `${LOCAL_URL}/v1/systemone`)
  const body = JSON.parse(w.fetches[0].init.body ?? '{}')
  assert.equal(body.state, SKEPTIC)
  assert.deepEqual(Object.keys(body.questions), ['agent_task'])
  assert.deepEqual(w.debug(), ['[jev-hooks] agents: check_claim 0.62 → claude-haiku-5-5 (general-purpose agent, 0.00 s)'])
  assert.deepEqual(w.transcript(), [])

  w.answer(reply('implement', 0.9))
  await w.spawn({ prompt: 'Implement the --json flag in src/cli.ts and its tests.' })
  assert.equal(w.spawned[1].model, undefined)
  assert.match(w.debug()[1], /left as is \(implement 0\.90\)/)
})

test('a workflow agent keeps its spawn input; its steps, from index 0, go to Haiku, and only its own', async () => {
  const w = world()
  w.answer(reply('label', 0.7))
  await w.spawn({ prompt: 'You are labeller A of two. Apply definition.md to every item.', workflow: WORKFLOW }, { agentId: 'agent-wf1' })
  assert.equal(w.spawned[0].model, undefined)
  await w.step({ turnId: 't1', index: 0, agentId: 'agent-wf1' })
  await w.step({ turnId: 't1', index: 1, agentId: 'agent-wf1' })
  await w.step({ turnId: 't2', index: 0, agentId: 'agent-other' })
  await w.step({ turnId: 'main', index: 0 })
  assert.deepEqual(w.beneath.map((b) => b.model), [HAIKU, HAIKU, 'claude-opus-5-5', 'claude-opus-5-5'])
  // turn.step calls nothing on $ for it: every model request of the session passes there
  assert.deepEqual(w.calls.filter((c) => c.hook === 'turn.step'), [])
  // with workflow_agents off in the user's agents.json, the workflow agent is not asked about
  const off = world({ files: { [`${HOME}/.config/jev-hooks/agents.json`]: JSON.stringify({ ...AGENTS, workflow_agents: false }) } })
  await off.spawn({ prompt: SKEPTIC, workflow: WORKFLOW })
  assert.equal(off.fetches.length, 0)
})

test('forks, teammates, a model the caller named and other parents are not sent to the backend', async () => {
  const cases: SpawnInput[] = [
    { prompt: SKEPTIC, fork: true },
    { prompt: SKEPTIC, isTeammate: true },
    { prompt: SKEPTIC, model: 'sonnet' },
    { prompt: SKEPTIC, parentModel: 'claude-haiku-5-5' },
  ]
  for (const c of cases) {
    const w = world()
    w.answer(reply('check_claim'))
    await w.spawn(c)
    assert.equal(w.fetches.length, 0, JSON.stringify(c))
    assert.equal(w.spawned[0].model, c.model, JSON.stringify(c))
    assert.match(w.debug()[0], /^\[jev-hooks\] agents: left as is \(/)
  }
})

test('kill switches: JEV_HOOKS_AGENTS=0, JEV_HOOKS_DISABLE=1, a project agents.json with enabled false', async () => {
  for (const o of [{ env: { JEV_HOOKS_AGENTS: '0' } }, { env: { JEV_HOOKS_DISABLE: '1' } }, { files: { [`${REPO}/.jev-hooks/agents.json`]: '{"enabled": false}' } }]) {
    const w = world(o)
    w.answer(reply('check_claim'))
    await w.spawn({ prompt: SKEPTIC })
    assert.equal(w.fetches.length, 0, JSON.stringify(o))
    assert.equal(w.spawned[0].model, undefined)
  }
  // a project file cannot pick a cheaper model: its route is ignored, with a note
  const p = world({ files: { [`${REPO}/.jev-hooks/agents.json`]: JSON.stringify({ route: { implement: HAIKU } }) } })
  p.answer(reply('implement'))
  await p.spawn({ prompt: 'Implement it.' })
  assert.equal(p.spawned[0].model, undefined)
  assert.match(p.transcript()[0], /^\[jev-hooks\] agents: \.jev-hooks\/agents\.json \/route: field ignored/)
})

test('fails open: no answer in time, an error status, a backend that rejects; one transcript line, then debug', async () => {
  const w = world()
  w.hold()
  const pending = w.spawn({ prompt: SKEPTIC })
  await w.advance(AGENTS.timeout_ms)
  await pending
  assert.equal(w.spawned[0].model, undefined)
  assert.deepEqual(w.transcript(), [`[jev-hooks] agents: no answer in ${AGENTS.timeout_ms} ms, subagent left as is`])

  w.answer({ status: 500, text: 'boom' })
  await w.spawn({ prompt: SKEPTIC })
  assert.equal(w.spawned[1].model, undefined)
  assert.equal(w.transcript().length, 2)

  w.answer({ status: 500, text: 'boom' })
  await w.spawn({ prompt: SKEPTIC })
  // the same problem again: debug only
  assert.equal(w.transcript().length, 2)

  const r = world()
  r.fail(new Error('connect ECONNREFUSED'))
  await r.spawn({ prompt: SKEPTIC })
  assert.equal(r.spawned[0].model, undefined)
  assert.match(r.transcript()[0], /^\[jev-hooks\] agents: error, subagent left as is/)
})

test('a non-local backend without a usable mask map is not asked; a refusal beneath passes through', async () => {
  const w = world({ options: { review_url: 'https://rizzo.example.com', api_key: 'fake-agents-key' }, unreadable: [`${HOME}/.config/guardrail/mask.tsv`] })
  await w.spawn({ prompt: SKEPTIC })
  assert.equal(w.fetches.length, 0)
  assert.match(w.transcript()[0], /mask map unreadable/)

  const d = world()
  d.answer(reply('check_claim'))
  const r = await d.spawn({ prompt: SKEPTIC }, { deny: 'refused by another plugin' })
  assert.deepEqual(r, { deny: 'refused by another plugin' })
})

test('max_in_flight: a burst beyond it is left as is without waiting', async () => {
  const w = world()
  const n = AGENTS.max_in_flight
  for (let i = 0; i < n; i++) w.hold()
  const all = Array.from({ length: n + 1 }, (_, i) => w.spawn({ prompt: `${SKEPTIC} #${i}`, workflow: WORKFLOW }, { agentId: `a${i}` }))
  await w.advance(0)
  assert.equal(w.fetches.length, n)
  assert.ok(w.debug().includes('[jev-hooks] agents: backend busy, left as is'))
  await w.advance(AGENTS.timeout_ms)
  await Promise.all(all)
})

test('the status line counts the spawns looked at and the ones moved', async () => {
  const w = world({ options: { status_line: true } })
  w.answer(reply('check_claim'))
  await w.spawn({ prompt: SKEPTIC })
  w.answer(reply('design'))
  await w.spawn({ prompt: 'Design the cache layer and compare two approaches.' })
  await w.spawn({ prompt: SKEPTIC, fork: true })
  assert.equal(w.status.at(-1), 'jev agents: 1 of 2 on haiku-5-5')
})
