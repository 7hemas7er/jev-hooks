// The subagent router's pure decisions (src/core/agents.ts) and agents.json's
// validation: which configuration wins, which spawns are looked at, what is sent,
// which model, what the lines say.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS_FILES, agentLine, agentRequest, agentsStatus, chooseModel, effectiveAgentsConfig, spawnSkip } from '../../src/core/agents.ts'
import { agentsRestrictions, validateAgents, validateCalibration } from '../../src/core/config.ts'
import { parseClassification, routerBackend } from '../../src/core/router.ts'
import { questionHash } from '../../src/core/systemone.ts'
import type { AgentSpawn, AgentsConfig, Calibration, Classification, Result } from '../../src/core/types.ts'
import { highEntropyValue } from '../helpers/fake-secrets.ts'
import { generator } from '../helpers/strings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const AGENTS = json('config/agents.json')
const KEY = 'fake-agents-key-value'

function valueOf<T>(e: Result<T>): T {
  if (!e.ok) assert.fail(`expected ok, found ${e.error.kind}: ${e.error.message}`)
  return e.value
}
const CALIBRATION: Calibration = valueOf(validateCalibration(json('config/calibration.json'), 'calibration.json'))
const NO_FILES = { user: null, projects: [], userCalibration: null }
const ON = { agent_router: true }

function pluginConfig(): AgentsConfig {
  const r = effectiveAgentsConfig(NO_FILES, ON)
  assert.deepEqual(r.notes, [])
  if (!r.cfg) assert.fail('the plugin agents.json is invalid')
  return r.cfg
}
const CFG = pluginConfig()
const LOCAL = valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017' }, {}))
const REMOTE = valueOf(routerBackend({ review_url: 'https://rizzo.example.com', api_key: KEY }, {}))
const spawn = (o: Partial<AgentSpawn> = {}): AgentSpawn => ({ subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', fork: false, ...o })
const classification = (taskKind: string, pTask: number): Classification => ({
  taskQuestion: 'agent_task', taskKind, pTask, p: {}, levels: {}, choices: { agent_task: { option: taskKind, p: pTask } }, missing: [],
  profile: 'jev', calibrated: false,
})

// ─── agents.json ──────────────────────────────────────────────────────────────

test('agents.json: the plugin file is valid, one choice question, route over its options', () => {
  assert.equal(CFG.enabled, true)
  assert.equal(CFG.taskQuestion, 'agent_task')
  assert.deepEqual(CFG.route, { check_claim: 'claude-haiku-5-5', label: 'claude-haiku-5-5' })
  assert.deepEqual(Object.keys(CFG.questions), ['agent_task'])
  assert.equal(CFG.file, AGENTS_FILES.plugin)
  // the text measured on 2026-10-08 (bench/README.md): one byte changed invalidates it
  assert.equal(questionHash(CFG.questions.agent_task), '6817b237294fe93e2e0488fb8c6cd497ac1518be658737551ddb3f8a54abc223')
})

test('agents.json: shape errors name the field', () => {
  const bad = (patch: Record<string, unknown>, pointer: RegExp): void => {
    const r = validateAgents({ ...AGENTS, ...patch }, CALIBRATION, 'agents.json')
    if (r.ok) assert.fail(`accepted ${JSON.stringify(patch)}`)
    assert.ok((r.error.problems ?? []).some((p) => pointer.test(p.pointer)), JSON.stringify(r.error.problems))
  }
  const q = AGENTS.questions.agent_task
  bad({ questions: { agent_task: q, other: q } }, /^\/questions$/)
  bad({ questions: { agent_task: { type: 'noul', instructions: 'x?', criteria: { true: 'a', false: 'b' } } } }, /^\/questions\/agent_task$/)
  bad({ route: { implement_more: 'claude-haiku-5-5' } }, /^\/route\/implement_more$/)
  bad({ route: { check_claim: 'Haiku 5.5' } }, /^\/route\/check_claim$/)
  bad({ route: { check_claim: '' } }, /^\/route\/check_claim$/)
  bad({ max_in_flight: 0 }, /^\/max_in_flight$/)
  bad({ max_in_flight: 17 }, /^\/max_in_flight$/)
  bad({ timeout_ms: 31_000 }, /^\/timeout_ms$/)
  bad({ prompt_head_chars: 5000, prompt_max_chars: 4000 }, /^\/prompt_head_chars$/)
  bad({ from_models: [] }, /^\/from_models$/)
  bad({ min_top_probability: 1.5 }, /^\/min_top_probability$/)
  bad({ surprise: true }, /^\/surprise$/)
  const { route: _route, ...noRoute } = AGENTS
  const r = validateAgents(noRoute, CALIBRATION, 'agents.json')
  assert.equal(r.ok, false)
  // an empty route is valid: the router then asks and never moves a subagent
  assert.deepEqual(valueOf(validateAgents({ ...AGENTS, route: {} }, CALIBRATION, 'agents.json')).route, {})
})

test('agentsRestrictions: from the project only "enabled": false, every other field ignored with a note', () => {
  assert.equal(agentsRestrictions(CFG, { enabled: false }, 'p').agents.enabled, false)
  assert.equal(agentsRestrictions(CFG, { enabled: true }, 'p').agents.enabled, true)
  const r = agentsRestrictions(CFG, { route: { implement: 'claude-haiku-5-5' }, min_top_probability: 0, enabled: 'no', a: 1, b: 2 }, 'p')
  assert.deepEqual(r.agents.route, CFG.route)
  assert.equal(r.agents.min_top_probability, CFG.min_top_probability)
  assert.equal(r.agents.enabled, true)
  assert.equal(r.notes.length, 4)
  assert.match(r.notes[0], /^p \/route: field ignored: from the project the subagent router only accepts "enabled": false$/)
  assert.match(r.notes[3], /^p: 2 more fields ignored$/)
  // a field name the file chose is never quoted
  assert.doesNotMatch(agentsRestrictions(CFG, { zz_name_the_file_chose: 1 }, 'p').notes[0], /zz_name/)
  assert.deepEqual(agentsRestrictions(CFG, [], 'p').notes, ['p: invalid, ignored (expected an object)'])
})

test('effectiveAgentsConfig: off without the option; the user file replaces the plugin one; projects only turn it off', () => {
  assert.equal(effectiveAgentsConfig(NO_FILES, {}).cfg?.enabled, false)
  assert.equal(effectiveAgentsConfig(NO_FILES, { agent_router: 'true' }).cfg?.enabled, false)
  assert.equal(effectiveAgentsConfig(NO_FILES, { effort_router: true }).cfg?.enabled, false)

  const user = JSON.stringify({ ...AGENTS, min_top_probability: 0.7, route: { check_claim: 'claude-sonnet-5-5' } })
  const u = effectiveAgentsConfig({ ...NO_FILES, user }, ON)
  assert.deepEqual(u.notes, [])
  assert.equal(u.cfg?.min_top_probability, 0.7)
  assert.deepEqual(u.cfg?.route, { check_claim: 'claude-sonnet-5-5' })
  assert.equal(u.cfg?.file, AGENTS_FILES.user)

  // invalid: the plugin's, with a note; invalid but asking to be off: off
  const inv = effectiveAgentsConfig({ ...NO_FILES, user: '{"enabled": true}' }, ON)
  assert.equal(inv.cfg?.file, AGENTS_FILES.plugin)
  assert.match(inv.notes[0], /^~\/\.config\/jev-hooks\/agents\.json: invalid, the plugin's agents\.json is used/)
  const off = effectiveAgentsConfig({ ...NO_FILES, user: '{"enabled": false}' }, ON)
  assert.equal(off.cfg?.enabled, false)
  assert.match(off.notes[0], /stays off as the file asks/)
  const unreadable = effectiveAgentsConfig({ ...NO_FILES, userUnreadable: true }, ON)
  assert.equal(unreadable.cfg?.enabled, false)

  const project = (text: string | null, unreadable?: boolean) => ({ ...NO_FILES, projects: [{ label: AGENTS_FILES.project, text, ...(unreadable ? { unreadable } : {}) }] })
  assert.equal(effectiveAgentsConfig(project('{"enabled": false}'), ON).cfg?.enabled, false)
  const cheap = effectiveAgentsConfig(project(JSON.stringify({ route: { implement: 'claude-haiku-5-5' } })), ON)
  assert.deepEqual(cheap.cfg?.route, CFG.route)
  assert.equal(cheap.cfg?.enabled, true)
  assert.equal(effectiveAgentsConfig(project(null, true), ON).cfg?.enabled, false)
  assert.deepEqual(effectiveAgentsConfig(project('{not json'), ON).notes, [`${AGENTS_FILES.project}: invalid, ignored`])
  assert.equal(effectiveAgentsConfig(project(null), ON).cfg?.enabled, true)
})

// ─── Spawns ───────────────────────────────────────────────────────────────────

test('spawnSkip: forks, teammates, a named model, skipped types and other parents are left alone', () => {
  assert.equal(spawnSkip(spawn(), CFG), null)
  assert.equal(spawnSkip(spawn({ workflow: true }), CFG), null)
  assert.equal(spawnSkip(spawn({ parentModel: 'claude-opus-5-5[1m]' }), CFG), null)
  assert.match(spawnSkip(spawn({ fork: true }), CFG) ?? '', /fork/)
  assert.match(spawnSkip(spawn({ isTeammate: true }), CFG) ?? '', /teammate/)
  assert.match(spawnSkip(spawn({ model: 'sonnet' }), CFG) ?? '', /named a model/)
  assert.equal(spawnSkip(spawn({ model: 'sonnet' }), { ...CFG, respect_explicit_model: false }), null)
  assert.equal(spawnSkip(spawn({ model: '' }), CFG), null)
  assert.match(spawnSkip(spawn({ parentModel: 'claude-haiku-5-5' }), CFG) ?? '', /from_models/)
  assert.match(spawnSkip(spawn({ subagentType: 'Plan' }), { ...CFG, skip_types: ['Plan'] }) ?? '', /skip_types/)
  assert.match(spawnSkip(spawn({ workflow: true }), { ...CFG, workflow_agents: false }) ?? '', /workflow_agents/)
  assert.match(spawnSkip(spawn(), { ...CFG, enabled: false }) ?? '', /off/)
  assert.equal(typeof spawnSkip(null as never, CFG), 'string')
})

test('agentRequest: the task prompt redacted and clipped like a prompt, with the one question', () => {
  const rnd = generator(5)
  const token = highEntropyValue(40, rnd)
  const prompt = `You are skeptic #1. Check this finding, the token is ${token}.\n${'context line\n'.repeat(600)}`
  const r = agentRequest(CFG, prompt, REMOTE, { text: null }, 1)
  if ('skip' in r) assert.fail(r.skip)
  assert.equal(r.init.body.includes(token), false)
  const body = JSON.parse(r.init.body)
  assert.deepEqual(Object.keys(body.questions), ['agent_task'])
  assert.ok(body.state.length <= CFG.prompt_max_chars + 5, String(body.state.length))
  assert.equal(r.init.headers.Authorization, `Bearer ${KEY}`)
  const local = agentRequest(CFG, 'Find every call site of parseDiff.', LOCAL, { text: null }, 1)
  if ('skip' in local) assert.fail(local.skip)
  assert.equal(JSON.parse(local.init.body).state, 'Find every call site of parseDiff.')
  assert.deepEqual(agentRequest(CFG, '   ', LOCAL, { text: null }, 1), { skip: 'empty task prompt' })
  assert.equal('problem' in agentRequest(CFG, prompt, REMOTE, { text: null, error: 'unreadable' }, 1), true)
})

test('parseClassification reads the subagent question with the routers calibration', () => {
  const opts = Object.keys(AGENTS.questions.agent_task.criteria)
  const probs = Object.fromEntries(opts.map((k) => [k, k === 'check_claim' ? 0.73 : 0.27 / (opts.length - 1)]))
  const text = JSON.stringify({ model: 'jev-1.13.0', answers: { agent_task: { type: 'choice', choice: 'check_claim', probabilities: probs, confidence: 0.8 } } })
  const c = valueOf(parseClassification(CFG, LOCAL, 200, text))
  assert.equal(c.taskQuestion, 'agent_task')
  assert.equal(c.taskKind, 'check_claim')
  assert.ok(Math.abs(c.pTask - 0.73) < 1e-9)
  assert.equal(parseClassification(CFG, LOCAL, 200, JSON.stringify({ model: 'jev-1.13.0', answers: {} })).ok, false)
})

test('chooseModel: only a routed option at the threshold moves the subagent', () => {
  assert.deepEqual(chooseModel(classification('check_claim', 0.62), spawn(), CFG), { model: 'claude-haiku-5-5', reason: 'check_claim 0.62 → claude-haiku-5-5' })
  assert.deepEqual(chooseModel(classification('label', 0.4), spawn(), CFG).model, 'claude-haiku-5-5')
  assert.deepEqual(chooseModel(classification('label', 0.39), spawn(), CFG), { reason: 'left as is (label 0.39 < 0.40)' })
  assert.deepEqual(chooseModel(classification('implement', 0.91), spawn(), CFG), { reason: 'left as is (implement 0.91)' })
  assert.deepEqual(chooseModel(classification('check_claim', 0.9), spawn({ parentModel: 'claude-haiku-5-5' }), CFG).model, undefined)
  assert.deepEqual(chooseModel(classification('check_claim', 0.9), spawn(), { ...CFG, enabled: false }), { reason: 'subagent router off' })
  assert.deepEqual(chooseModel(null, spawn(), CFG), { reason: 'no classification' })
  // an option named like an Object property is not a route
  assert.deepEqual(chooseModel(classification('constructor', 0.9), spawn(), CFG), { reason: 'left as is (constructor 0.90)' })
})

test('lines: the decision with the spawn kind, never the prompt; the status counts the moved spawns', () => {
  const c = chooseModel(classification('check_claim', 0.62), spawn(), CFG)
  assert.equal(agentLine(c, spawn({ workflow: true }), 412), '[jev-hooks] agents: check_claim 0.62 → claude-haiku-5-5 (workflow agent, 0.41 s)')
  assert.equal(agentLine(c, spawn()), '[jev-hooks] agents: check_claim 0.62 → claude-haiku-5-5 (general-purpose agent)')
  assert.equal(agentsStatus(0, {}), undefined)
  assert.equal(agentsStatus(23, { 'claude-haiku-5-5': 9 }), 'jev agents: 9 of 23 on haiku-5-5')
  assert.equal(agentsStatus(5, {}), 'jev agents: 0 of 5 moved')
  assert.equal(agentsStatus(5, { 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 2 }), 'jev agents: 3 of 5 moved')
})
