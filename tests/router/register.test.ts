// hooks/register.ts played through whole sessions on a fake Claude Code
// (tests/helpers/fake-dollar.ts). What the router decides is src/core/router.ts's and
// is tested in tests/core/router.test.ts; here is what only the hook does: when a prompt
// is sent and when it is not, which turn a classification reaches, the later steps and
// the subagents, the kill switches, what fails open and what it says, what it reads.
// None of these mistakes would raise an error: a turn would silently get another
// effort, a prompt would reach a backend it must not, or the prompt cache would be
// cleared on every turn. So every case looks at the effort the engine was finally
// asked to use, at the requests that left and at the lines the user sees.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from '../../hooks/register.ts'
import { PROMPT_ORIGIN_KINDS } from '../../src/core/types.ts'
import { fakeClaude, hooksError } from '../helpers/fake-dollar.ts'
import type { Effort, FakeClaude, HttpAnswer, PromptInput, Usage, WorldOptions } from '../helpers/fake-dollar.ts'
import { RE_MARKER, generator, highEntropyValue, phrasesForClaude } from '../helpers/fake-secrets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const ROUTER = json('config/router.json')
const MANIFEST = json('.claude-plugin/plugin.json')

// The options as Claude Code hands them to register(): every userConfig default, then
// the router on and the reviewer's instance on the LAN.
const DEFAULTS: Record<string, unknown> = Object.fromEntries(Object.entries(MANIFEST.userConfig).map(([k, v]) => [k, (v as { default: unknown }).default]))
const LOCAL_URL = 'http://192.168.1.50:8017'
// status_line off: these tests are about the router (the line has its own, at the end)
const OPTIONS: Record<string, unknown> = { ...DEFAULTS, review_url: LOCAL_URL, effort_router: true, status_line: false }

const HOME = '/home/test'
const CONFIG = `${HOME}/.config/jev-hooks`
const REPO = '/work/repo'
const PROJECT = `${REPO}/.jev-hooks/router.json`
const SONNET = 'claude-sonnet-4-5'
// Fake, recognizable keys: nothing that looks like a real secret enters the repo.
const KEY = 'fake-router-key-value'
const FILE_KEY = 'fake-key-file-value'
const ENV_KEY = 'fake-env-key-value'

function world(o: WorldOptions = {}): FakeClaude {
  return fakeClaude(register as never, {
    ...o,
    options: { ...OPTIONS, ...o.options },
    env: { HOME, ...o.env },
    repoRoot: o.repoRoot === undefined ? REPO : o.repoRoot,
  })
}

// ─── Backend answers ──────────────────────────────────────────────────────────

const TASK_OPTIONS = Object.keys(ROUTER.questions.task_kind.criteria)

// A rizzo-like answer to the seven questions from a Jev backend (profile jev: the
// probabilities are used as they come), with the task kind at probability top.
function reply(task: string, o: { top?: number; nouls?: Record<string, number>; omit?: string[] } = {}): HttpAnswer {
  const top = o.top ?? 0.9
  const rest = (1 - top) / (TASK_OPTIONS.length - 1)
  const nouls = { has_error_evidence: 0.02, risky_irreversible: 0.01, underspecified: 0.1, multi_deliverable: 0.05, ...o.nouls }
  const answers: Record<string, unknown> = {
    task_kind: { type: 'choice', choice: task, probabilities: Object.fromEntries(TASK_OPTIONS.map((k) => [k, k === task ? top : rest])), confidence: 0.8 },
    scope: { type: 'score', score: 1, probabilities: { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.1 }, confidence: 0.6 },
    ...Object.fromEntries(Object.entries(nouls).map(([id, p]) => [id, { type: 'noul', noul: p }])),
    explicit_depth: { type: 'choice', choice: 'none', probabilities: { quick: 0.05, thorough: 0.05, none: 0.9 }, confidence: 0.8 },
  }
  for (const id of o.omit ?? []) delete answers[id]
  return { status: 200, text: JSON.stringify({ model: 'jev-1.13.0', answers }) }
}

// A refactor the shipped rules leave at the session's effort: its base step lowers it,
// and the risky_irreversible floor holds it at high.
const leftAlone = (): HttpAnswer => reply('refactor', { nouls: { risky_irreversible: 0.9 } })

const bodyOf = (w: FakeClaude, i: number): { state: string; model: string; questions: Record<string, unknown> } => JSON.parse(w.fetches[i].init.body ?? '')
// The project router.json files read, in order.
const projectReads = (w: FakeClaude): (string | undefined)[] =>
  w.calls.filter((c) => c.call === 'fs.read' && (c.arg ?? '').endsWith('/.jev-hooks/router.json')).map((c) => c.arg)

// One whole turn: the prompt, the turn.start it causes, the step at index 0 on the
// session's effort. Returns the effort the engine was asked to use.
async function turn(w: FakeClaude, text: string, turnId: string, effort: Effort | number | undefined = 'high',
  prompt: Partial<PromptInput> = {}): Promise<Effort | number | undefined> {
  await w.submit({ text, ...prompt }, { start: turnId })
  await w.step({ turnId, index: 0, effort })
  return w.lastEffort()
}

const usage = (input: number, read: number, creation: number): Usage => ({
  input_tokens: input, output_tokens: 100, cache_read_input_tokens: read, cache_creation_input_tokens: creation, model: 'claude-opus-5-5',
})

// ─── Enable gate and kill switches ────────────────────────────────────────────

test('register: with effort_router anything but true nothing is registered, and no prompt reaches a backend', async () => {
  const unset = { ...OPTIONS }
  delete unset.effort_router
  for (const options of [unset, { ...OPTIONS, effort_router: false }, { ...OPTIONS, effort_router: 'true' }]) {
    const w = fakeClaude(register as never, { options, env: { HOME }, repoRoot: REPO })
    assert.deepEqual(w.registered, [], JSON.stringify(options.effort_router))
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
    assert.deepEqual(w.calls, [])
    assert.equal(w.fetches.length, 0)
  }
  assert.deepEqual(world().registered, ['turn.start', 'prompt.submit', 'turn.step'])
})

test('kill switches: JEV_HOOKS_ROUTER=0 and JEV_HOOKS_DISABLE=1 send nothing, and are read again at every prompt', async () => {
  for (const [name, value] of [['JEV_HOOKS_ROUTER', '0'], ['JEV_HOOKS_DISABLE', '1']]) {
    const w = world({ env: { [name]: value } })
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high', name)
    assert.equal(w.fetches.length, 0, name)
    assert.deepEqual(w.transcript(), [], name)
    assert.deepEqual(w.status, [undefined], name)
    // Claude Code's environment, as the hook sees it, can change between two prompts
    delete w.env[name]
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2'), 'low', name)
    assert.equal(w.fetches.length, 1, name)
  }
  // any other value leaves the router on
  const w = world({ env: { JEV_HOOKS_ROUTER: '1', JEV_HOOKS_DISABLE: '0' } })
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
})

test('the key: api_key or the key file, only towards the userConfig URL; JEV_HOOKS_KEY and TYPESAFE_API_KEY are never read', async () => {
  const env = { JEV_HOOKS_KEY: ENV_KEY, TYPESAFE_API_KEY: ENV_KEY }
  const files = { [`${CONFIG}/key`]: `\n  ${FILE_KEY}\nsecond line\n` }
  const w = world({ env, files })
  w.answer(reply('small_edit'))
  await turn(w, 'rename x to y in src/a.ts', 't1')
  assert.equal(w.fetches[0].url, `${LOCAL_URL}/v1/systemone`)
  assert.equal(w.fetches[0].init.headers?.Authorization, `Bearer ${FILE_KEY}`)
  assert.deepEqual(w.calls.filter((c) => c.call === 'fs.read').map((c) => c.arg), [
    `${CONFIG}/router.json`, `${CONFIG}/calibration.json`, PROJECT, `${CONFIG}/key`,
  ])

  // api_key wins over the file; router_api_key over both
  const k = world({ env, files, options: { api_key: KEY } })
  k.answer(reply('small_edit'))
  await turn(k, 'rename x to y in src/a.ts', 't1')
  assert.equal(k.fetches[0].init.headers?.Authorization, `Bearer ${KEY}`)
  const r = world({ env, files, options: { api_key: 'fake-review-key', router_api_key: KEY } })
  r.answer(reply('small_edit'))
  await turn(r, 'rename x to y in src/a.ts', 't1')
  assert.equal(r.fetches[0].init.headers?.Authorization, `Bearer ${KEY}`)

  // a URL from the environment goes without any key, whatever is exported
  const e = world({ env: { ...env, JEV_HOOKS_ROUTER_URL: 'http://127.0.0.1:8019' }, files, options: { review_url: '' } })
  e.answer(reply('small_edit'))
  await turn(e, 'rename x to y in src/a.ts', 't1')
  assert.equal(e.fetches[0].url, 'http://127.0.0.1:8019/v1/systemone')
  assert.equal(e.fetches[0].init.headers?.Authorization, undefined)

  for (const x of [w, k, r, e]) {
    assert.ok(!x.envReads.includes('JEV_HOOKS_KEY'))
    assert.ok(!x.envReads.some((n) => n.startsWith('TYPESAFE')))
    for (const l of x.logs) assert.ok(!l.text.includes(KEY) && !l.text.includes(FILE_KEY), l.text)
  }
})

test('without a backend: one line in the transcript, the turn as it is, repeats to the debug log', async () => {
  const w = world({ options: { review_url: '' } })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2'), 'high')
  assert.equal(w.fetches.length, 0)
  assert.deepEqual(w.transcript(), ['[jev-hooks] router: backend not configured: set review_url with /plugin'])
  assert.ok(w.debug().includes('[jev-hooks] router: backend not configured: set review_url with /plugin'))
})

// ─── The effort of a turn ─────────────────────────────────────────────────────

test('a classified prompt lowers its turn at index 0 and again at every later step', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  const r = await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  assert.deepEqual(r, { text: 'rename x to y in src/a.ts' })
  assert.deepEqual(w.entered, ['rename x to y in src/a.ts'])

  // the request: POST, the prompt as the state (a local backend), the router's questions
  assert.equal(w.fetches.length, 1)
  assert.equal(w.fetches[0].init.method, 'POST')
  const body = bodyOf(w, 0)
  assert.equal(body.state, 'rename x to y in src/a.ts')
  assert.equal(body.model, 'jev-latest')
  assert.deepEqual(Object.keys(body.questions), Object.keys(ROUTER.questions))
  // the answer came before the timeout: the timer was cancelled, never fired
  assert.equal(w.timers.length, 1)
  assert.equal(w.timers[0].at, 1_000_000 + ROUTER.timeout_ms)
  assert.deepEqual([w.timers[0].cancelled, w.timers[0].fired], [true, false])
  assert.match(w.debug()[0], /^\[jev-hooks\] router: small_edit 0\.90, scope 1, has_error_evidence 0\.02, .* in 0 ms \(profile jev\)$/)

  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  // every step's input is rebuilt from the session's effort: the change is made again
  await w.step({ turnId: 't1', index: 1, effort: 'high' })
  await w.step({ turnId: 't1', index: 2, effort: 'high' })
  assert.deepEqual(w.beneath.map((s) => s.effort), ['low', 'low', 'low'])
  assert.deepEqual(w.transcript(), ['[jev-hooks] effort high → low: small_edit 0.90: -2 → low'])
  assert.equal(w.status.at(-1), 'jev router: small_edit 0.90 → low')

  // the next turn starts from the session again
  w.answer(leftAlone())
  assert.equal(await turn(w, 'move the parser into its own module', 't2'), 'high')
  await w.step({ turnId: 't2', index: 1, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
  assert.equal(w.status.at(-1), 'jev router: refactor 0.90, effort unchanged (high)')
  assert.match(w.debug().at(-1) ?? '', /^\[jev-hooks\] effort high: unchanged \(refactor 0\.90: -1 → medium; floor risky_irreversible 0\.90 → high\)$/)
})

test('an effort someone else changed during the turn is not overwritten', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  // a skill raised the effort after index 0: the router leaves its choice alone
  await w.step({ turnId: 't1', index: 1, effort: 'max' })
  assert.equal(w.lastEffort(), 'max')
  await w.step({ turnId: 't1', index: 2, effort: 'medium' })
  assert.equal(w.lastEffort(), 'medium')
  // the session's effort again: the router's change is made again
  await w.step({ turnId: 't1', index: 3, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
})

test('a later step on a model outside only_models (a fallback) keeps the session\'s effort', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  await w.step({ turnId: 't1', index: 1, effort: 'high', model: SONNET })
  assert.equal(w.lastEffort(), 'high')
  // back on an allowed model: the turn's change is made again
  await w.step({ turnId: 't1', index: 2, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
})

test('a failure at index 0 after the decision leaves the whole turn at the session\'s effort, with no line claiming a change', async () => {
  const w = world({ broken: ['turn.step:ui.status'] })
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  await w.step({ turnId: 't1', index: 1, effort: 'high' })
  assert.deepEqual(w.beneath.map((s) => s.effort), ['high', 'high'])
  assert.deepEqual(w.transcript(), [])
  // the next turn's `previous` is the effort really used: a continuation from max goes to high
  w.broken.delete('turn.step:ui.status')
  w.answer(reply('continue'))
  assert.equal(await turn(w, 'go on', 't2', 'max'), 'high')

  // The status went through and the line did not: the status is taken back as well.
  // (2.1.283 drops a refused ui call instead of throwing: a defensive path.)
  const log = world({ broken: ['turn.step:ui.log'] })
  log.answer(reply('small_edit'))
  await log.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  await log.step({ turnId: 't1', index: 0, effort: 'high' })
  await log.step({ turnId: 't1', index: 1, effort: 'high' })
  assert.deepEqual(log.beneath.map((s) => s.effort), ['high', 'high'])
  assert.deepEqual(log.transcript(), [])
  assert.equal(log.status.at(-1), undefined)
  // no change was made: a status saying so is still true, and stays
  log.answer(leftAlone())
  assert.equal(await turn(log, 'move the parser into its own module', 't2'), 'high')
  assert.equal(log.status.at(-1), 'jev router: refactor 0.90, effort unchanged (high)')
})

test('prompts submitted during a turn leave its status line: the turn still runs at the effort it shows', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  const routed = 'jev router: small_edit 0.90 → low'
  assert.equal(w.status.at(-1), routed)
  // skipped (origin), skipped ('/'), a backend error: all during t1
  await w.submit({ text: 'background task finished', origin: { kind: 'task-notification' }, turnId: 't1' })
  await w.submit({ text: '/cost', turnId: 't1' })
  w.answer({ status: 500, text: 'Internal Server Error' })
  await w.submit({ text: 'and what does y do?', turnId: 't1' })
  assert.equal(w.transcript().at(-1), '[jev-hooks] router: backend error (HTTP 500)')
  // no answer in time, then a prompt while the backend is still busy
  const held = w.hold()
  const late = w.submit({ text: 'and where is z?', turnId: 't1' })
  await w.advance(ROUTER.timeout_ms)
  await late
  await w.submit({ text: 'and w?', turnId: 't1' })
  assert.ok(w.debug().includes('[jev-hooks] router: backend still busy, turn left as is'))
  held.resolve(reply('question'))
  assert.equal(w.status.at(-1), routed)
  await w.step({ turnId: 't1', index: 1, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  // a fallback step on a model outside only_models: the next prompt takes the model
  // check, and t1, back on Opus, still runs at the effort the line shows
  await w.step({ turnId: 't1', index: 2, effort: 'high', model: SONNET })
  assert.equal(w.lastEffort(), 'high')
  const sent = w.fetches.length
  await w.submit({ text: 'and v?', turnId: 't1' })
  assert.equal(w.fetches.length, sent)
  assert.equal(w.debug().at(-1), '[jev-hooks] router: skipped (model claude-sonnet-4-5 is not in only_models)')
  assert.equal(w.status.at(-1), routed)
  await w.step({ turnId: 't1', index: 3, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  // the kill switch clears it even mid-turn: the turn stops being changed
  w.env.JEV_HOOKS_ROUTER = '0'
  await w.submit({ text: '/cost', turnId: 't1' })
  assert.equal(w.status.at(-1), undefined)
  await w.step({ turnId: 't1', index: 4, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')

  // between turns a skipped prompt clears it
  const v = world()
  v.answer(reply('small_edit'))
  assert.equal(await turn(v, 'rename x to y in src/a.ts', 't1'), 'low')
  await v.submit({ text: '/cost' })
  assert.equal(v.status.at(-1), undefined)
  // and so does one the model check skips
  const m = world()
  m.answer(reply('small_edit'))
  assert.equal(await turn(m, 'rename x to y in src/a.ts', 't1'), 'low')
  await m.step({ turnId: 't1', index: 1, effort: 'high', model: SONNET })
  await m.submit({ text: 'rename y to z in src/a.ts' })
  assert.equal(m.fetches.length, 1)
  assert.equal(m.debug().at(-1), '[jev-hooks] router: skipped (model claude-sonnet-4-5 is not in only_models)')
  assert.equal(m.status.at(-1), undefined)
})

test('a turn no classification reached clears the status line at its first step', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.equal(w.status.at(-1), 'jev router: small_edit 0.90 → low')
  // a continuation: no text, no classification
  await w.start('', 't2')
  await w.step({ turnId: 't2', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
  assert.equal(w.status.at(-1), undefined)
})

test('subagent steps are never touched, and their model is not the session\'s', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  // a subagent's first step, on another model, before the main loop's
  await w.step({ turnId: 't1', index: 0, effort: 'high', agentId: 'a1', model: SONNET })
  assert.equal(w.lastEffort(), 'high')
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  await w.step({ turnId: 't1', index: 1, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  await w.step({ turnId: 't1', index: 1, effort: 'high', agentId: 'a1', model: SONNET })
  assert.equal(w.lastEffort(), 'high')
  // the subagent's model, the last one seen, did not stop the next prompt
  w.answer(reply('small_edit'))
  await turn(w, 'rename y to z in src/a.ts', 't2')
  assert.equal(w.fetches.length, 2)
})

test('a numeric session effort (a token budget) is passed through untouched', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1', 12_000), 12_000)
  await w.step({ turnId: 't1', index: 1, effort: 12_000 })
  assert.equal(w.lastEffort(), 12_000)
  assert.deepEqual(w.transcript(), [])
  assert.ok(w.debug().includes('[jev-hooks] effort 12000: session effort is a token budget, not a level'))
})

test('the session effort is the cap: the project can lower it, never raise it', async () => {
  // a feature from high: medium; the project caps the router at low
  const low = world({ files: { [PROJECT]: '{ "max_effort": "low" }' } })
  low.answer(reply('feature'))
  assert.equal(await turn(low, 'add a --verbose option to the CLI', 't1'), 'low')
  assert.deepEqual(low.transcript(), ['[jev-hooks] effort high → low: feature 0.90: -1 → medium; cap low'])

  // a risky small edit from medium: the floor asks high, the session caps it at medium,
  // and a project max_effort of max does not lift the cap
  const max = world({ files: { [PROJECT]: '{ "max_effort": "max" }' } })
  max.answer(reply('small_edit', { nouls: { risky_irreversible: 0.9 } }))
  assert.equal(await turn(max, 'drop the users table in production', 't1', 'medium'), 'medium')
  assert.match(max.debug().at(-1) ?? '', /^\[jev-hooks\] effort medium: unchanged \(.*floor risky_irreversible 0\.90 → high; cap medium\)$/)

  // the project can turn the router off; its other fields are ignored with a note, once
  const off = world({ files: { [PROJECT]: '{ "enabled": false, "min_effort": "max" }' } })
  off.answer(reply('small_edit'))
  assert.equal(await turn(off, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(await turn(off, 'rename x to y in src/a.ts', 't2'), 'high')
  assert.equal(off.fetches.length, 0)
  assert.equal(off.transcript().length, 1)
  assert.match(off.transcript()[0], /^\[jev-hooks\] router: \.jev-hooks\/router\.json \/min_effort: field ignored/)
})

test('the project file is read at the checkout\'s top level, found from a subdirectory, and at the session\'s directory outside a repository', async () => {
  const w = world({ repoRoot: null, files: { './.jev-hooks/router.json': '{ "enabled": false }' } })
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(w.fetches.length, 0)
  assert.deepEqual(projectReads(w), ['./.jev-hooks/router.json'])
  assert.ok(!w.calls.some((c) => c.call === 'session.cwd' || c.call === 'fs.exists'))
  // a malformed project file: ignored with a note that does not quote it
  const bad = world({ files: { [PROJECT]: '{ "enabled": fals' } })
  bad.answer(reply('small_edit'))
  assert.equal(await turn(bad, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.deepEqual(bad.transcript()[0], '[jev-hooks] router: .jev-hooks/router.json: invalid, ignored')

  // A plain repository, the session two levels down: the walk up finds .git at the
  // root, which is also $.session.repo()'s, so the file is read once and its note
  // comes once. The walk is made once for that directory.
  const sub = world({ cwd: `${REPO}/src/deep`, files: { [`${REPO}/.git`]: '', [PROJECT]: '{ "max_effort": "low", "min_effort": "max" }' } })
  sub.answer(reply('feature'))
  sub.answer(reply('feature'))
  assert.equal(await turn(sub, 'add a --verbose option to the CLI', 't1'), 'low')
  assert.equal(await turn(sub, 'add a --quiet option to the CLI', 't2'), 'low')
  assert.deepEqual(projectReads(sub), [PROJECT, PROJECT])
  assert.deepEqual(sub.calls.filter((c) => c.call === 'fs.exists').map((c) => c.arg), [`${REPO}/src/deep/.git`, `${REPO}/src/.git`, `${REPO}/.git`])
  assert.equal(sub.transcript().filter((l) => l.includes('field ignored')).length, 1)
  assert.match(sub.transcript()[0], /^\[jev-hooks\] router: \.jev-hooks\/router\.json \S+: field ignored/)
})

test('in a linked worktree both the checkout\'s .jev-hooks/router.json and the main working tree\'s are read, and each only restricts', async () => {
  // $.session.repo() answers the main working tree's root; the session is in a
  // worktree made by `claude -w`, under the main tree: the walk stops at the first .git
  const MAIN = '/work/main'
  const WT = `${MAIN}/.claude/worktrees/wt`
  const layout = (files: Record<string, string>): WorldOptions => ({
    repoRoot: MAIN, cwd: `${WT}/sub`, files: { [`${WT}/.git`]: `gitdir: ${MAIN}/.git/worktrees/wt\n`, [`${MAIN}/.git`]: '', ...files },
  })

  // the worktree's branch switches the router off, the main tree has no file: nothing is sent
  const off = world(layout({ [`${WT}/.jev-hooks/router.json`]: '{ "enabled": false }' }))
  off.answer(reply('small_edit'))
  assert.equal(await turn(off, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(off.fetches.length, 0)
  assert.deepEqual(projectReads(off), [`${WT}/.jev-hooks/router.json`, `${MAIN}/.jev-hooks/router.json`])

  // only the main tree caps the router: the cap still applies, and its note names the file
  const cap = world(layout({ [`${MAIN}/.jev-hooks/router.json`]: '{ "max_effort": "low", "x": 1 }' }))
  cap.answer(reply('feature'))
  assert.equal(await turn(cap, 'add a --verbose option to the CLI', 't1'), 'low')
  assert.equal(cap.transcript().length, 2)
  assert.match(cap.transcript()[0], /^\[jev-hooks\] router: \.jev-hooks\/router\.json \(main working tree\) \S+: field ignored/)
  assert.equal(cap.transcript()[1], '[jev-hooks] effort high → low: feature 0.90: -1 → medium; cap low')
  // a change to either file counts at the next prompt
  cap.files.set(`${MAIN}/.jev-hooks/router.json`, '{ "enabled": false }')
  cap.answer(reply('small_edit'))
  assert.equal(await turn(cap, 'rename x to y in src/a.ts', 't2'), 'high')
  assert.equal(cap.fetches.length, 1)

  // the lower cap of the two wins, whichever file holds it
  for (const [wt, main] of [['low', 'medium'], ['medium', 'low']]) {
    const both = world(layout({ [`${WT}/.jev-hooks/router.json`]: `{ "max_effort": "${wt}" }`, [`${MAIN}/.jev-hooks/router.json`]: `{ "max_effort": "${main}" }` }))
    both.answer(reply('feature'))
    assert.equal(await turn(both, 'add a --verbose option to the CLI', 't1'), 'low', `${wt} ${main}`)
  }

  // the same file on both branches: one set of notes
  const same = world(layout({ [`${WT}/.jev-hooks/router.json`]: '{ "min_effort": "max" }', [`${MAIN}/.jev-hooks/router.json`]: '{ "min_effort": "max" }' }))
  same.answer(reply('small_edit'))
  assert.equal(await turn(same, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.equal(same.transcript().filter((l) => l.includes('field ignored')).length, 1)
})

test('the walk to the checkout\'s top level fails (a refused call): the repository\'s root, as before', async () => {
  for (const broken of [['session.cwd'], ['fs.exists']]) {
    const w = world({ broken, cwd: `${REPO}/src`, files: { [`${REPO}/src/.git`]: '', [PROJECT]: '{ "max_effort": "low" }' } })
    w.answer(reply('feature'))
    assert.equal(await turn(w, 'add a --verbose option to the CLI', 't1'), 'low', broken.join())
    assert.deepEqual(projectReads(w), [PROJECT], broken.join())
    assert.equal(w.fetches.length, 1, broken.join())
  }
})

test('a walk a refused call cut short is not kept: the next prompt walks again', async () => {
  // a linked worktree whose own file switches the router off; the first prompt's walk is
  // refused, so that prompt falls back to the main working tree's root
  const MAIN = '/work/main'
  const WT = `${MAIN}/.claude/worktrees/wt`
  const w = world({
    repoRoot: MAIN, cwd: `${WT}/sub`, broken: ['fs.exists'],
    files: { [`${WT}/.git`]: `gitdir: ${MAIN}/.git/worktrees/wt\n`, [`${MAIN}/.git`]: '', [`${WT}/.jev-hooks/router.json`]: '{ "enabled": false }' },
  })
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  w.broken.delete('fs.exists')
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high')
  assert.equal(w.fetches.length, 1)
  assert.ok(projectReads(w).includes(`${WT}/.jev-hooks/router.json`))

  // $.session.repo refused as well: the repository's switch is found once the walk can run
  const r = world({ broken: ['session.repo', 'fs.exists'], cwd: `${REPO}/sub`, files: { [`${REPO}/.git`]: '', [PROJECT]: '{ "enabled": false }' } })
  r.answer(reply('small_edit'))
  assert.equal(await turn(r, 'rename x to y in src/a.ts', 't1'), 'low')
  r.broken.delete('fs.exists')
  assert.equal(await turn(r, 'rename y to z in src/a.ts', 't2'), 'high')
  assert.equal(r.fetches.length, 1)
  assert.ok(projectReads(r).includes(PROJECT))
})

test('$.session.repo refused: the walk still finds the checkout\'s top level, and without one the session\'s directory is read', async () => {
  // A refusal says nothing of where the session is: a session in a subdirectory still
  // finds the repository's switch
  const sub = world({ broken: ['session.repo'], cwd: `${REPO}/sub`, files: { [`${REPO}/.git`]: '', [PROJECT]: '{ "enabled": false }' } })
  sub.answer(reply('small_edit'))
  assert.equal(await turn(sub, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.deepEqual(projectReads(sub), [PROJECT])
  assert.equal(sub.fetches.length, 0)

  // no .git up from the session's directory, or no directory at all: the session's
  // directory, and the prompt is still classified
  for (const broken of [['session.repo'], ['session.repo', 'session.cwd']]) {
    const w = world({ broken, files: { './.jev-hooks/router.json': '{ "max_effort": "low" }' } })
    w.answer(reply('feature'))
    assert.equal(await turn(w, 'add a --verbose option to the CLI', 't1'), 'low', broken.join())
    assert.deepEqual(projectReads(w), ['./.jev-hooks/router.json'], broken.join())
    assert.equal(w.fetches.length, 1, broken.join())
    assert.deepEqual(w.transcript(), ['[jev-hooks] effort high → low: feature 0.90: -1 → medium; cap low'], broken.join())
  }
})

test('an invalid user router.json: one note, the plugin\'s router applies', async () => {
  const mine = structuredClone(ROUTER)
  mine.only_origins = ['human']
  const w = world({ files: { [`${CONFIG}/router.json`]: JSON.stringify(mine) } })
  w.answer(reply('small_edit'))
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'low')
  const notes = w.transcript().filter((l) => l.includes('router.json'))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^\[jev-hooks\] router: ~\/\.config\/jev-hooks\/router\.json: invalid, the plugin's router\.json is used \(.*unknown origin "human"/)
})

test('a user router.json that is there but cannot be read keeps the router off, with one note, until it can be read', async () => {
  // it may hold the user's "enabled": false, and nothing can tell
  const USER = `${CONFIG}/router.json`
  const note = '[jev-hooks] router: ~/.config/jev-hooks/router.json: unreadable, the router stays off until it can be read'
  const calibrationNote = '[jev-hooks] router: ~/.config/jev-hooks/calibration.json: unreadable, the plugin\'s calibration is used'
  const projectNote = '[jev-hooks] router: .jev-hooks/router.json: unreadable, the router stays off until it can be read'
  // no permission, a loop of links, a directory, another hook's refusal; with every read
  // refused, the calibration.json and the project's router.json cannot be read either
  const cases: [WorldOptions, string[]][] = [
    [{ unreadable: [USER] }, [note]],
    [{ failing: { [USER]: 'ELOOP' } }, [note]],
    [{ failing: { [USER]: 'EISDIR' } }, [note]],
    [{ denied: [USER] }, [note]],
    [{ broken: ['fs.read'] }, [calibrationNote, note, projectNote]],
  ]
  for (const [o, lines] of cases) {
    const w = world({ ...o, files: { [USER]: '{ "enabled": false }' } })
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high', JSON.stringify(o))
    assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high', JSON.stringify(o))
    assert.equal(w.fetches.length, 0, JSON.stringify(o))
    assert.deepEqual(w.transcript(), lines, JSON.stringify(o))
    assert.equal(w.status.at(-1), undefined, JSON.stringify(o))
  }

  // a file where a directory should be: no file there, the plugin's router applies
  const none = world({ failing: { [USER]: 'ENOTDIR' } })
  none.answer(reply('small_edit'))
  assert.equal(await turn(none, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.deepEqual(none.transcript(), ['[jev-hooks] effort high → low: small_edit 0.90: -2 → low'])

  // missing at the first prompt, unreadable at the next two, readable again at the last:
  // one activation, so what could be read is part of what the last result is kept for
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  w.files.set(USER, JSON.stringify(ROUTER))
  w.unreadable.add(USER)
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high')
  assert.equal(await turn(w, 'rename z to w in src/a.ts', 't3'), 'high')
  assert.equal(w.fetches.length, 1)
  assert.equal(w.transcript().filter((l) => l === note).length, 1)
  w.unreadable.delete(USER)
  assert.equal(await turn(w, 'rename w to v in src/a.ts', 't4'), 'low')
  assert.equal(w.fetches.length, 2)

  // an unreadable calibration.json holds no switch: the plugin's calibration, one note
  const cal = world({ unreadable: [`${CONFIG}/calibration.json`] })
  cal.answer(reply('small_edit'))
  cal.answer(reply('small_edit'))
  assert.equal(await turn(cal, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.equal(await turn(cal, 'rename y to z in src/a.ts', 't2'), 'low')
  assert.deepEqual(cal.transcript().filter((l) => l.includes('calibration')), [calibrationNote])

  // missing at the first prompt, unreadable at the next: whether the calibration could be
  // read is part of what the last result is kept for, as for the router.json
  const late = world()
  late.answer(reply('small_edit'))
  late.answer(reply('small_edit'))
  assert.equal(await turn(late, 'rename x to y in src/a.ts', 't1'), 'low')
  late.files.set(`${CONFIG}/calibration.json`, '{}')
  late.unreadable.add(`${CONFIG}/calibration.json`)
  assert.equal(await turn(late, 'rename y to z in src/a.ts', 't2'), 'low')
  assert.deepEqual(late.transcript().filter((l) => l.includes('calibration')), [calibrationNote])
})

test('a project router.json that is there but cannot be read keeps the router off, with one note, until it can be read', async () => {
  // it may be the repository's "enabled": false, and nothing can tell
  const note = '[jev-hooks] router: .jev-hooks/router.json: unreadable, the router stays off until it can be read'
  for (const o of [{ unreadable: [PROJECT] }, { failing: { [PROJECT]: 'ELOOP' } }, { failing: { [PROJECT]: 'EISDIR' } }, { denied: [PROJECT] }] as WorldOptions[]) {
    const w = world({ ...o, files: { [PROJECT]: '{ "enabled": false }' } })
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high', JSON.stringify(o))
    assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high', JSON.stringify(o))
    assert.equal(w.fetches.length, 0, JSON.stringify(o))
    assert.deepEqual(w.transcript(), [note], JSON.stringify(o))
    assert.equal(w.status.at(-1), undefined, JSON.stringify(o))
  }

  // a file where a directory should be: no project file, the prompt is classified
  const none = world({ failing: { [PROJECT]: 'ENOTDIR' } })
  none.answer(reply('small_edit'))
  assert.equal(await turn(none, 'rename x to y in src/a.ts', 't1'), 'low')

  // missing, then unreadable, then readable again, in one activation
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  w.files.set(PROJECT, '{}')
  w.unreadable.add(PROJECT)
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high')
  assert.equal(await turn(w, 'rename z to w in src/a.ts', 't3'), 'high')
  assert.equal(w.fetches.length, 1)
  assert.equal(w.transcript().filter((l) => l === note).length, 1)
  w.unreadable.delete(PROJECT)
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename w to v in src/a.ts', 't4'), 'low')
  assert.equal(w.fetches.length, 2)

  // in a linked worktree the main working tree's file counts too, under its own label
  const MAIN = '/work/main'
  const WT = `${MAIN}/.claude/worktrees/wt`
  const wt = world({
    repoRoot: MAIN, cwd: `${WT}/sub`, unreadable: [`${MAIN}/.jev-hooks/router.json`],
    files: { [`${WT}/.git`]: `gitdir: ${MAIN}/.git/worktrees/wt\n`, [`${MAIN}/.git`]: '' },
  })
  wt.answer(reply('small_edit'))
  assert.equal(await turn(wt, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(wt.fetches.length, 0)
  assert.deepEqual(wt.transcript(), ['[jev-hooks] router: .jev-hooks/router.json (main working tree): unreadable, the router stays off until it can be read'])
})

test('the model: outside only_models the turn is left alone, and the next prompt is not even sent', async () => {
  const w = world()
  // the first prompt of a session is sent: no step has named a model yet
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  await w.step({ turnId: 't1', index: 0, effort: 'high', model: SONNET })
  assert.equal(w.lastEffort(), 'high')
  assert.match(w.debug().at(-1) ?? '', /^\[jev-hooks\] effort high: model claude-sonnet-4-5 not allowed: an effort change would clear the prompt cache$/)
  // the next prompt does not wait for a classification it could not use
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2', 'high'), 'high')
  assert.equal(w.fetches.length, 1)
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (model claude-sonnet-4-5 is not in only_models)'))
  // back on Opus (the /model command): the prompt after that step is sent again
  await w.step({ turnId: 't2', index: 1, effort: 'high' })
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename z to w in src/a.ts', 't3'), 'low')
  assert.equal(w.fetches.length, 2)
})

// ─── Which prompts are sent ───────────────────────────────────────────────────

test('prompts that start with / or !, and empty ones, are not sent', async () => {
  const w = world()
  for (const [i, text] of ['/compact', '  !git status', '/model opus', '   ', ''].entries()) {
    assert.equal(await turn(w, text, `t${i}`), 'high', JSON.stringify(text))
  }
  assert.equal(w.fetches.length, 0)
  assert.deepEqual(w.transcript(), [])
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (starts with "/")'))
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (starts with "!")'))
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (empty prompt)'))
})

test('every origin outside only_origins is not sent and its turn keeps its effort; composer is sent', async () => {
  const w = world()
  const others: (string | null)[] = [...PROMPT_ORIGIN_KINDS.filter((k) => k !== 'composer'), 'human', null]
  for (const [i, kind] of others.entries()) {
    const prompt: Partial<PromptInput> = kind === null ? { origin: undefined } : { origin: { kind } }
    assert.equal(await turn(w, 'rename x to y in src/a.ts', `t${i}`, 'high', prompt), 'high', String(kind))
  }
  assert.equal(w.fetches.length, 0)
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (origin "bridge" is not classified)'))
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (origin "other" is not classified)'))
  assert.ok(w.debug().includes('[jev-hooks] router: skipped (origin "unclassified" is not classified)'))
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 'tc', 'high', { origin: { kind: 'composer' } }), 'low')
  assert.equal(w.fetches.length, 1)
})

test('bridge (Remote Control) is sent once the user router.json lists it', async () => {
  const mine = structuredClone(ROUTER)
  mine.only_origins = ['composer', 'bridge']
  const w = world({ files: { [`${CONFIG}/router.json`]: JSON.stringify(mine) } })
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1', 'high', { origin: { kind: 'bridge' } }), 'low')
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2', 'high', { origin: { kind: 'peer' } }), 'high')
  assert.equal(w.fetches.length, 1)
  assert.deepEqual(w.transcript(), ['[jev-hooks] effort high → low: small_edit 0.90: -2 → low'])
})

// ─── Which turn a classification reaches ──────────────────────────────────────

test('a prompt typed during a turn is classified, reaches no turn its text did not start, and leaves the running one alone', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  // typed while t1 runs, folded into it: no turn.start carries its text
  w.answer(reply('question'))
  await w.submit({ text: 'and what does y do?', turnId: 't1' })
  assert.equal(w.fetches.length, 2)
  // t1 keeps its own change
  await w.step({ turnId: 't1', index: 1, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  // neither a continuation (no text) nor a turn with another text picks it up
  await w.start('', 't2')
  await w.step({ turnId: 't2', index: 0, effort: 'medium' })
  assert.equal(w.lastEffort(), 'medium')
  await w.start('something else', 't3')
  await w.step({ turnId: 't3', index: 0, effort: 'medium' })
  assert.equal(w.lastEffort(), 'medium')
})

test('a prompt dropped beneath (guardrail\'s block) reaches no turn, even one with the same text', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  const r = await w.submit({ text: 'rename x to y in src/a.ts' }, { drop: 'blocked by a UserPromptSubmit hook' })
  assert.deepEqual(r, { drop: 'blocked by a UserPromptSubmit hook' })
  assert.equal(w.fetches.length, 1)
  await w.start('rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
})

test('the classification waits for the turn its text starts, even after another turn started first', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename x to y in src/a.ts' })
  // a task notification's turn starts first, without a typed prompt
  await w.start('', 't0')
  await w.step({ turnId: 't0', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
  await w.start('rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  // bound once: the same text starting another turn does not bring it back
  await w.start('rename x to y in src/a.ts', 't2')
  await w.step({ turnId: 't2', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
})

test('a queued prompt keeps its classification while other prompts come and go before its turn', async () => {
  const text = 'rename x to y in src/a.ts'
  // what comes in between, and whether it is sent itself
  const others: [string, PromptInput, { drop?: string }, number][] = [
    ['a task notification', { text: 'background task finished', origin: { kind: 'task-notification' }, turnId: 't0' }, {}, 1],
    ['a ! command', { text: '!ls', turnId: 't0' }, {}, 1],
    ['a notification dropped beneath', { text: 'background task finished', origin: { kind: 'task-notification' }, turnId: 't0' }, { drop: 'refused by a hook' }, 1],
    ['another prompt, classified and dropped beneath', { text: 'deploy it', turnId: 't0' }, { drop: 'refused by a hook' }, 2],
  ]
  for (const [name, other, s, sent] of others) {
    const w = world()
    w.answer(reply('small_edit'))
    w.answer(reply('ops'))
    // typed while t0 runs, waiting for its own turn
    await w.submit({ text, turnId: 't0', wait: true })
    await w.submit(other, s)
    await w.start(text, 't1')
    await w.step({ turnId: 't1', index: 0, effort: 'high' })
    assert.equal(w.lastEffort(), 'low', name)
    assert.equal(w.fetches.length, sent, name)
  }
  // the other prompt failing is its own problem, not the queued prompt's: a backend
  // error, or an error its hook caught (here a refused call)
  for (const fails of ['backend', 'call']) {
    const w = world()
    w.answer(reply('small_edit'))
    await w.submit({ text, turnId: 't0', wait: true })
    if (fails === 'backend') w.answer({ status: 500, text: 'Internal Server Error' })
    else w.broken.add('clock.now')
    await w.submit({ text: 'and what does y do?', turnId: 't0' })
    w.broken.clear()
    await w.start(text, 't1')
    await w.step({ turnId: 't1', index: 0, effort: 'high' })
    assert.equal(w.lastEffort(), 'low', fails)
  }
})

// ─── Failing open ─────────────────────────────────────────────────────────────

test('timeout: the turn keeps its effort, a busy window follows, and a request still in flight blocks the next one', async () => {
  const w = world()
  const held = w.hold()
  const p = w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  await w.advance(ROUTER.timeout_ms - 1)
  assert.deepEqual(w.entered, [], 'the prompt waits for the classification')
  await w.advance(1)
  await p
  assert.deepEqual(w.entered, ['rename x to y in src/a.ts'])
  assert.equal(w.timers[0].fired, true)
  assert.deepEqual(w.transcript(), ['[jev-hooks] router: no answer in 1500 ms, turn left as is'])
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')

  // the late answer arrives (unused); within busy_after_timeout_ms nothing is sent anyway
  held.resolve(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'high')
  assert.equal(w.fetches.length, 1)
  assert.ok(w.debug().includes('[jev-hooks] router: backend still busy, turn left as is'))

  // past the window: sent, and it times out again (the same line: to the debug log)
  await w.advance(ROUTER.busy_after_timeout_ms)
  const again = w.hold()
  const p3 = w.submit({ text: 'rename y to z in src/a.ts' }, { start: 't3' })
  await w.advance(ROUTER.timeout_ms)
  await p3
  assert.equal(w.fetches.length, 2)
  assert.equal(w.transcript().length, 1)
  // past the new window, but that request has not come back: still not sent
  await w.advance(ROUTER.busy_after_timeout_ms)
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't4'), 'high')
  assert.equal(w.fetches.length, 2)
  // it comes back: the next prompt is sent again
  again.resolve(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't5'), 'low')
  assert.equal(w.fetches.length, 3)
})

test('backend errors fail open: one transcript line, repeats to the debug log, a success re-arms it', async () => {
  const w = world()
  const server = '[jev-hooks] router: backend error (HTTP 500)'
  const broken = '[jev-hooks] router: unreadable backend response: invalid JSON'
  w.answer({ status: 500, text: 'Internal Server Error' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  w.answer({ status: 500, text: 'Internal Server Error' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2'), 'high')
  assert.deepEqual(w.transcript(), [server])
  w.answer({ status: 200, text: '{"model": "jev-1", "answers": ' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't3'), 'high')
  w.answer({ status: 200, text: '{"model": "jev-1", "answers": ' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't4'), 'high')
  assert.deepEqual(w.transcript(), [server, broken])
  assert.equal(w.debug().filter((l) => l === server || l === broken).length, 2)
  // the same failure after a success is news again
  w.answer({ status: 500, text: 'Internal Server Error' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't5'), 'high')
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't6'), 'low')
  w.answer({ status: 500, text: 'Internal Server Error' })
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't7'), 'high')
  assert.deepEqual(w.transcript().filter((l) => l.startsWith('[jev-hooks] router:')), [server, broken, server, server])
  assert.equal(w.status.at(-1), undefined)
})

test('$.http.fetch refused (policy, essential-traffic-only): one fixed line, the turn as it is', async () => {
  const w = world({ options: { review_url: 'https://rizzo.example.com', api_key: KEY } })
  w.fail(hooksError('jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  w.fail(hooksError('jev-hooks: $.http.fetch: refused: nonessential network traffic is disabled for this session'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2'), 'high')
  // the engine's refusal ends with its reason: anything after it is not that refusal
  w.fail(hooksError(`jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy (Bearer ${KEY})`))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't3'), 'high')
  assert.equal(w.fetches.length, 3)
  assert.deepEqual(w.transcript(), [
    '[jev-hooks] router: request failed (network disabled by policy), turn left as is',
    '[jev-hooks] router: request failed (nonessential traffic disabled), turn left as is',
    '[jev-hooks] router: request failed, turn left as is',
  ])
  for (const l of w.logs) assert.ok(!l.text.includes(KEY), l.text)
  // the timer of the race does not outlive it
  assert.equal(w.timers[0].cancelled, true)
})

test('a failed request gives only a fixed token, never the engine\'s message, which can quote a Location the backend chose', async () => {
  const secret = highEntropyValue(24, generator(5))
  const planted = `${phrasesForClaude(1)[0]} ${secret}`
  const w = world()
  // redirected to a URL of the backend's choosing that does not answer: the engine
  // quotes the href (percent-encoded by the URL parser) and the cause's own message
  w.fail(hooksError(`jev-hooks: $.http.fetch(https://x.example/${encodeURIComponent(planted)}) failed: ConnectionRefused: Unable to connect. ${planted}`))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  // a Location of another scheme is quoted as written, spaces and all: it cannot fake the failure's shape
  w.fail(hooksError(`jev-hooks: $.http.fetch: note:${planted}) failed: Word: ${planted} refused: http or https only`))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't2'), 'high')
  // nor pass for one of the engine's own refusals, and point the user at a policy
  const policy = new URL('foo:network access from plugins is disabled by policy', 'https://rizzo.example.com/').href
  w.fail(hooksError(`jev-hooks: $.http.fetch: ${policy} refused: http or https only`))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't3'), 'high')
  assert.deepEqual(w.transcript(), [
    '[jev-hooks] router: request failed (ConnectionRefused), turn left as is',
    '[jev-hooks] router: request failed, turn left as is',
  ])
  // the same line as the one before: it went to the debug log
  assert.equal(w.debug().at(-1), '[jev-hooks] router: request failed, turn left as is')
  for (const l of w.logs) {
    assert.doesNotMatch(l.text, RE_MARKER)
    assert.ok(!l.text.includes(secret) && !l.text.includes('x.example') && !l.text.includes('Word'), l.text)
  }
})

test('a $ call that fails never stops the prompt: it enters once, the turn keeps its effort', async () => {
  // the kit without mock.env: "no implementation for env.get"
  const env = world({ broken: ['env.get'] })
  assert.deepEqual(await env.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' }), { text: 'rename x to y in src/a.ts' })
  assert.deepEqual(env.entered, ['rename x to y in src/a.ts'])
  assert.deepEqual(env.transcript(), ['[jev-hooks] router: error, turn left as is (HooksError: no implementation for env.get)'])
  await env.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(env.lastEffort(), 'high')
  // not even the error line can be written
  for (const broken of [['env.get', 'ui.log'], ['http.fetch', 'ui.log', 'ui.status'], ['clock.after', 'ui.log']]) {
    const w = world({ broken })
    w.answer(reply('small_edit'))
    assert.deepEqual(await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' }), { text: 'rename x to y in src/a.ts' }, broken.join())
    assert.deepEqual(w.entered, ['rename x to y in src/a.ts'], broken.join())
    await w.step({ turnId: 't1', index: 0, effort: 'high' })
    assert.equal(w.lastEffort(), 'high', broken.join())
  }
})

test('a refused $.clock.after: no timer fires, so the prompt waits for the fetch itself, then goes on once', async () => {
  const w = world({ broken: ['clock.after'] })
  const held = w.hold()
  const p = w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1' })
  await w.advance(ROUTER.timeout_ms * 4)
  assert.deepEqual(w.entered, [], 'nothing but the fetch ends the wait')
  assert.deepEqual(w.timers, [])
  assert.ok(w.calls.some((c) => c.call === 'clock.after'))
  held.resolve(reply('small_edit'))
  assert.deepEqual(await p, { text: 'rename x to y in src/a.ts' })
  assert.deepEqual(w.entered, ['rename x to y in src/a.ts'])
  // the answer came before the turn started: it is still that turn's
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'low')
  // the request is no longer in flight: the next prompt is sent
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'low')
  assert.equal(w.fetches.length, 2)
  // the host gives up on the fetch at 30 s: the prompt goes on with one line
  const late = w.hold()
  const p3 = w.submit({ text: 'rename z to w in src/a.ts' }, { start: 't3' })
  await w.advance(30_000)
  assert.deepEqual(w.entered.length, 2)
  late.reject(hooksError('jev-hooks: $.http.fetch(http://192.168.1.50:8017/v1/systemone) aborted: no complete answer within 30000ms'))
  await p3
  assert.deepEqual(w.entered.length, 3)
  assert.equal(w.transcript().at(-1), '[jev-hooks] router: request failed, turn left as is')
})

test('the user interrupts during the race: the engine aborts the fetch, nothing is said and the turn keeps its effort', async () => {
  const w = world()
  w.hold()
  const interrupt = new AbortController()
  const p = w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1', signal: interrupt.signal })
  await w.advance(100)
  interrupt.abort()
  await p
  // the race's timer went with the prompt's dispatch
  await w.advance(ROUTER.timeout_ms)
  assert.equal(w.timers[0].fired, false)
  assert.deepEqual(w.logs, [])
  await w.step({ turnId: 't1', index: 0, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
  assert.deepEqual(w.logs, [])
  // the aborted request is not in flight any more
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't2'), 'low')

  // interrupted before the hook ran: the engine refuses the prompt's calls, and the
  // failure is not the router's to report either
  const early = world({ broken: ['env.get'] })
  const gone = new AbortController()
  gone.abort()
  await early.submit({ text: 'rename x to y in src/a.ts' }, { start: 't1', signal: gone.signal })
  assert.deepEqual(early.logs, [])
})

test('towards a non-local backend: masked with guardrail\'s map, and nothing is sent when the map cannot be read or looked for', async () => {
  const options = { review_url: 'https://rizzo.example.com', api_key: KEY }
  const map = `${HOME}/.config/guardrail/mask.tsv`
  const text = 'rename qzrealproject to y in src/a.ts'
  const unreadable = '[jev-hooks] router: guardrail mask map unreadable: nothing is sent to a non-local backend'
  const masked = world({ options, files: { [map]: 'qzrealproject\tplaceholderqz\n' } })
  masked.answer(reply('small_edit'))
  assert.equal(await turn(masked, text, 't1'), 'low')
  assert.equal(bodyOf(masked, 0).state, 'rename placeholderqz to y in src/a.ts')

  // GUARDRAIL_MASK_MAP moves it; one that exists but cannot be read stops the request,
  // with one transcript line, then the debug log
  const locked = world({ options, env: { GUARDRAIL_MASK_MAP: '/srv/masks/mask.tsv' }, unreadable: ['/srv/masks/mask.tsv'] })
  locked.answer(reply('small_edit'))
  assert.equal(await turn(locked, text, 't1'), 'high')
  assert.equal(await turn(locked, text, 't2'), 'high')
  assert.equal(locked.fetches.length, 0)
  assert.deepEqual(locked.transcript(), [unreadable])
  assert.ok(locked.debug().includes(unreadable))
  // A stat that fails as well (a loop of links, a directory without search
  // permission): $.fs.exists would call the map missing, the read says it is not.
  // A read refused by another hook, the same.
  for (const o of [{ failing: { [map]: 'ELOOP' } }, { failing: { [map]: 'EACCES' } }, { failing: { [map]: 'EISDIR' } }, { denied: [map] }]) {
    const w = world({ options, ...o })
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, text, 't1'), 'high', JSON.stringify(o))
    assert.equal(w.fetches.length, 0, JSON.stringify(o))
    assert.deepEqual(w.transcript(), [unreadable], JSON.stringify(o))
  }
  // one that does not parse, the same
  const garbled = world({ options, files: { [map]: 'only-one-field\n' } })
  assert.equal(await turn(garbled, text, 't1'), 'high')
  assert.equal(garbled.fetches.length, 0)
  assert.deepEqual(garbled.transcript(), [unreadable])
  // no map at all (nothing there, or a file where a directory should be): sent as it is
  for (const o of [{}, { failing: { [map]: 'ENOTDIR' } }]) {
    const none = world({ options, ...o })
    none.answer(reply('small_edit'))
    assert.equal(await turn(none, text, 't1'), 'low', JSON.stringify(o))
    assert.equal(bodyOf(none, 0).state, text)
  }

  // Neither HOME nor GUARDRAIL_MASK_MAP: where the map is cannot be known, so nothing
  // is sent; with GUARDRAIL_MASK_MAP the map is found without HOME.
  const whole = { ...OPTIONS, ...options }
  for (const env of [{}, { HOME: '' }]) {
    const homeless = fakeClaude(register as never, { options: whole, env, repoRoot: REPO })
    homeless.answer(reply('small_edit'))
    assert.equal(await turn(homeless, text, 't1'), 'high', JSON.stringify(env))
    assert.equal(homeless.fetches.length, 0)
    assert.deepEqual(homeless.transcript(), [
      '[jev-hooks] router: guardrail mask map location unknown (no HOME and no GUARDRAIL_MASK_MAP): nothing is sent to a non-local backend',
    ])
  }
  const named = fakeClaude(register as never, {
    options: whole, env: { GUARDRAIL_MASK_MAP: '/srv/masks/mask.tsv' }, files: { '/srv/masks/mask.tsv': 'qzrealproject\tplaceholderqz\n' }, repoRoot: REPO,
  })
  named.answer(reply('small_edit'))
  assert.equal(await turn(named, text, 't1'), 'low')
  assert.equal(bodyOf(named, 0).state, 'rename placeholderqz to y in src/a.ts')

  // a local backend never looks for the map, with or without HOME
  for (const env of [{ HOME }, {}]) {
    const local = fakeClaude(register as never, { options: OPTIONS, env, repoRoot: REPO, unreadable: [map] })
    local.answer(reply('small_edit'))
    assert.equal(await turn(local, text, 't1'), 'low')
    assert.ok(!local.calls.some((c) => c.arg === map))
    assert.ok(!local.envReads.includes('GUARDRAIL_MASK_MAP'))
  }
})

// ─── Cache guard ──────────────────────────────────────────────────────────────

test('cache guard: two cold steps after an effort change turn the router off for the session', async () => {
  const w = world()
  // turn 1: lowered to low; a warm 20k-token prefix
  w.answer(reply('small_edit'))
  await turn(w, 'rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
  assert.equal(w.lastEffort(), 'low')
  // turn 2, 20 s later: left at high, and the cache served nothing of the prefix
  await w.advance(20_000)
  w.answer(leftAlone())
  await w.submit({ text: 'move the parser into its own module' }, { start: 't2' })
  await w.step({ turnId: 't2', index: 0, effort: 'high' }, usage(18_000, 0, 3_000))
  assert.equal(w.lastEffort(), 'high')
  assert.ok(w.debug().includes('[jev-hooks] router: after an effort change the prompt cache served 0 of 20000 tokens (1 of 2 before the router turns off)'))
  // turn 3: lowered again, cold again
  await w.advance(20_000)
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename y to z in src/a.ts' }, { start: 't3' })
  await w.step({ turnId: 't3', index: 0, effort: 'high' }, usage(20_000, 100, 1_000))
  assert.equal(w.lastEffort(), 'low')
  assert.equal(w.transcript().at(-1), '[jev-hooks] router off for this session: after an effort change the prompt cache served 100 of 21000 tokens, 2 times in a row. The per-turn-control beta is probably not active (or was dropped until /clear or /compact); set effort_router to false if this repeats.')
  assert.equal(w.status.at(-1), 'jev router: off for this session (effort changes cleared the prompt cache)')

  // from here on: no request, no change, not even at the later steps of turn 3
  await w.step({ turnId: 't3', index: 1, effort: 'high' })
  assert.equal(w.lastEffort(), 'high')
  const sent = w.fetches.length
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename z to w in src/a.ts', 't4'), 'high')
  assert.equal(w.fetches.length, sent)
  assert.equal(w.status.at(-1), 'jev router: off for this session (effort changes cleared the prompt cache)')
})

test('cache guard: a warm cache after the change, or a long pause, is not held against the router', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  await turn(w, 'rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
  for (let i = 2; i < 6; i++) {
    // alternately high and low, every time with most of the prefix from the cache
    await w.advance(10_000)
    w.answer(i % 2 === 0 ? leftAlone() : reply('small_edit'))
    await w.submit({ text: `task ${i}` }, { start: `t${i}` })
    await w.step({ turnId: `t${i}`, index: 0, effort: 'high' }, usage(1_000, 19_000, 1_000))
  }
  // a pause longer than the cache lives: a cold step says nothing
  await w.advance(ROUTER.cache_guard.max_gap_ms + 1)
  w.answer(leftAlone())
  await w.submit({ text: 'task 6' }, { start: 't6' })
  await w.step({ turnId: 't6', index: 0, effort: 'high' }, usage(20_000, 0, 1_000))
  assert.ok(!w.logs.some((l) => l.text.includes('prompt cache')), JSON.stringify(w.logs))
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't7'), 'low')
})

// After a lowered turn the session idles past the cache's life, then something that
// sends no main-loop request happens, and 20 s later a turn at another effort finds
// the cache cold. Its gap must run from the last request's turn, not from the prompt in
// between: counted from there, it would be a suspect, and twice would turn the router
// off with a line blaming the beta.
async function coldAfterIdle(between: (w: FakeClaude, round: number) => Promise<void>): Promise<FakeClaude> {
  const w = world()
  w.answer(reply('small_edit'))
  await turn(w, 'rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
  for (const round of [1, 2]) {
    await w.advance(ROUTER.cache_guard.max_gap_ms + 1)
    await between(w, round)
    await w.advance(20_000)
    // round 1 left at high after the low turn, round 2 lowered after the high one
    w.answer(round === 1 ? leftAlone() : reply('small_edit'))
    await w.submit({ text: `task ${round}` }, { start: `t${round + 1}` })
    await w.step({ turnId: `t${round + 1}`, index: 0, effort: 'high' }, usage(18_000, 0, 3_000))
    assert.equal(w.lastEffort(), round === 1 ? 'high' : 'low')
  }
  return w
}

const noGuardLine = (w: FakeClaude): void => {
  assert.ok(!w.logs.some((l) => l.text.includes('prompt cache')), JSON.stringify(w.logs))
}

test('cache guard: a prompt dropped beneath or a ! command after a long pause does not shorten the gap', async () => {
  const w = await coldAfterIdle(async (x, round) => {
    x.answer(leftAlone())
    await x.submit({ text: `deploy it ${round}` }, { drop: 'blocked by a UserPromptSubmit hook' })
    await x.submit({ text: '!git status' })
  })
  noGuardLine(w)
  // still on
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't9'), 'low')
})

test('cache guard: a turn that sends no request after a long pause does not shorten the gap', async () => {
  const w = await coldAfterIdle(async (x, round) => {
    // started, then interrupted before its first request
    x.answer(reply('small_edit'))
    await x.submit({ text: `rename a${round} to b in src/a.ts` }, { start: `stopped${round}` })
  })
  noGuardLine(w)
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename y to z in src/a.ts', 't9'), 'low')
})

// The gap runs between turn starts: a prompt can come long before its turn starts, and
// the cache can expire meanwhile with no request in between.
test('cache guard: a prompt whose turn starts long after it came is timed from that start', async () => {
  const text = 'move the parser into its own module'
  const cases: [string, PromptInput][] = [
    // typed 10 s into t1 and queued; t1 ends slowly (a Stop hook that runs the tests)
    ['queued behind the running turn', { text, turnId: 't1', wait: true }],
    // typed after t1's last request and held before its turn (a slow UserPromptSubmit hook)
    ['held before its turn starts', { text }],
  ]
  for (const [name, prompt] of cases) {
    const w = world()
    w.answer(reply('small_edit'))
    assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low', name)
    w.answer(leftAlone())
    await w.advance(10_000)
    if (prompt.turnId) await w.submit(prompt)
    // t1's last request, warm
    await w.advance(20_000)
    await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
    await w.advance(10_000)
    if (!prompt.turnId) await w.submit(prompt)
    // its turn starts 6 minutes later, at high, and the cache has expired on its own
    await w.advance(6 * 60_000)
    await w.start(text, 't2')
    await w.step({ turnId: 't2', index: 0, effort: 'high' }, usage(18_000, 0, 3_000))
    assert.equal(w.lastEffort(), 'high', name)
    noGuardLine(w)
  }
})

test('cache guard: a turn whose start time cannot be read keeps its classification, and its first step is not judged', async () => {
  const w = world()
  w.answer(leftAlone())
  assert.equal(await turn(w, 'move the parser into its own module', 't1'), 'high')
  await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
  // 30 s later: lowered, and cold; the gap is not known, so no suspect
  await w.advance(30_000)
  w.broken.add('turn.start:clock.now')
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename x to y in src/a.ts' }, { start: 't2' })
  await w.step({ turnId: 't2', index: 0, effort: 'high' }, usage(18_000, 0, 3_000))
  assert.equal(w.lastEffort(), 'low')
  assert.ok(w.calls.some((c) => c.hook === 'turn.start' && c.call === 'clock.now'))
  noGuardLine(w)
})

// ─── What the hooks call ──────────────────────────────────────────────────────

test('turn.step calls nothing on $ but ui.log and ui.status, and turn.start only clock.now', async () => {
  const w = world()
  w.answer(reply('small_edit'))
  await turn(w, 'rename x to y in src/a.ts', 't1')
  await w.step({ turnId: 't1', index: 1, effort: 'high' }, usage(500, 15_000, 4_500))
  await w.step({ turnId: 't1', index: 0, effort: 'high', agentId: 'a1' })
  await w.advance(1_000)
  w.answer(leftAlone())
  await w.submit({ text: 'move the parser' }, { start: 't2' })
  await w.step({ turnId: 't2', index: 0, effort: 'high' }, usage(18_000, 0, 3_000))
  await w.advance(1_000)
  w.answer(reply('small_edit'))
  await w.submit({ text: 'rename y' }, { start: 't3' })
  await w.step({ turnId: 't3', index: 0, effort: 'high' }, usage(20_000, 0, 1_000))
  assert.ok(w.transcript().some((l) => l.startsWith('[jev-hooks] router off for this session')))
  const step = w.calls.filter((c) => c.hook === 'turn.step')
  assert.ok(step.length > 0)
  assert.deepEqual([...new Set(step.map((c) => c.call))].sort(), ['ui.log', 'ui.status'])
  // one clock read per bound turn, for the cache guard
  assert.deepEqual(w.calls.filter((c) => c.hook === 'turn.start'), [
    { hook: 'turn.start', call: 'clock.now' }, { hook: 'turn.start', call: 'clock.now' }, { hook: 'turn.start', call: 'clock.now' },
  ])
})

// ─── The status line (status_line option, on by default) ──────────────────────

const PLUGINS = `${HOME}/.claude/plugins`
const CACHE = `${PLUGINS}/cache/7hemas7er-jev-hooks/jev-hooks`
const DATA = `${PLUGINS}/data/jev-hooks-7hemas7er-jev-hooks`
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'
const review = (lane: string, escalation: string[] = [], session = SESSION): string =>
  JSON.stringify({ ts: '2026-10-03T15:00:00+02:00', origin: 'hook', session, outcome: 'ok', lane, escalation })
const manifest = (v: string): Record<string, string> => ({ [`${CACHE}/${v}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'jev-hooks', version: v }) })

function lineWorld(o: WorldOptions & { router?: boolean } = {}): FakeClaude {
  return world({
    pluginRoot: `${CACHE}/0.15.0`, sessionId: SESSION, dirs: { [CACHE]: ['0.13.0', '0.14.0', '0.15.0'] },
    ...o,
    options: { status_line: true, effort_router: o.router === true, ...o.options },
    files: { ...manifest('0.13.0'), ...manifest('0.14.0'), ...manifest('0.15.0'), ...o.files },
  })
}

test('status line: on by default, alone it hooks only session.start, Bash calls and turn.start, and never a backend', async () => {
  const w = lineWorld({ options: { status_line: DEFAULTS.status_line } })
  assert.equal(DEFAULTS.status_line, true)
  assert.deepEqual(w.registered, ['session.start', 'tool.call', 'turn.start'])
  await w.sessionStart()
  assert.equal(w.status.at(-1), 'jev 0.15.0 · no commit reviewed yet')
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'high')
  assert.equal(w.fetches.length, 0)
  assert.equal(w.envReads.includes('JEV_HOOKS_KEY'), false)
})

test('status line: the session\'s last review from the log, read again only after a Bash call that may commit', async () => {
  const w = lineWorld({ files: { [`${DATA}/log.jsonl`]: [review('MERGE'), review('BLOCK', [], 'another-session'), ''].join('\n') } })
  await w.sessionStart()
  assert.equal(w.status.at(-1), 'jev 0.15.0 · last commit MERGE')
  // the commit hook logged its review beneath the Bash call
  w.files.set(`${DATA}/log.jsonl`, [review('MERGE'), review('NITS', ['hardcoded_secret', 'weakens_tests']), ''].join('\n'))
  const reads = (): number => w.calls.filter((c) => c.call === 'fs.read' && c.arg === `${DATA}/log.jsonl`).length
  const before = reads()
  await w.bash('ls -la')
  assert.equal(reads(), before)
  await w.bash('git commit -m "Add sum"')
  assert.equal(reads(), before + 1)
  assert.equal(w.status.at(-1), 'jev 0.15.0 · last commit NITS, escalated hardcoded_secret, weakens_tests')
})

test('status line: a newer version with its manifest beside the running one, checked at every turn start', async () => {
  const w = lineWorld()
  await w.sessionStart()
  await w.start('first prompt', 't1')
  assert.equal(w.status.at(-1), 'jev 0.15.0 · no commit reviewed yet')
  // /plugin update downloads 0.16.0; a folder without a manifest is not a version
  w.files.set(`${CACHE}/0.16.0/.claude-plugin/plugin.json`, JSON.stringify({ version: '0.16.0' }))
  w.setDir(CACHE, ['0.13.0', '0.14.0', '0.15.0', '0.16.0', '0.17.0', 'notes'])
  await w.start('second prompt', 't2')
  assert.equal(w.status.at(-1), 'jev 0.15.0 · 0.16.0 installed: /reload-plugins · no commit reviewed yet')
  // nothing changed: no new status call
  const shown = w.status.length
  await w.start('third prompt', 't3')
  assert.equal(w.status.length, shown)
})

test('status line: CLAUDE_PLUGIN_DATA first; a --plugin-dir checkout reads its plugin.json and looks for no newer version', async () => {
  const fromEnv = lineWorld({ env: { CLAUDE_PLUGIN_DATA: '/data/jev-hooks' }, files: { '/data/jev-hooks/log.jsonl': review('NITS') } })
  await fromEnv.sessionStart()
  assert.equal(fromEnv.status.at(-1), 'jev 0.15.0 · last commit NITS')

  const checkout = lineWorld({
    pluginRoot: '/work/jev-hooks/',
    files: { '/work/jev-hooks/.claude-plugin/plugin.json': JSON.stringify({ name: 'jev-hooks', version: '0.15.0' }) },
  })
  await checkout.sessionStart()
  await checkout.start('a prompt', 't1')
  assert.equal(checkout.status.at(-1), 'jev 0.15.0 · no commit reviewed yet')
  assert.equal(checkout.calls.some((c) => c.call === 'fs.list'), false)
})

test('status line: with the router on, the router\'s text follows the line, and clearing it leaves the line', async () => {
  const w = lineWorld({ router: true, options: { review_url: LOCAL_URL } })
  assert.deepEqual(w.registered, ['session.start', 'tool.call', 'turn.start', 'prompt.submit', 'turn.step'])
  await w.sessionStart()
  w.answer(reply('small_edit'))
  assert.equal(await turn(w, 'rename x to y in src/a.ts', 't1'), 'low')
  assert.equal(w.status.at(-1), 'jev 0.15.0 · no commit reviewed yet · jev router: small_edit 0.90 → low')
  await w.submit({ text: '/compact' })
  assert.equal(w.status.at(-1), 'jev 0.15.0 · no commit reviewed yet')
})

test('status line: a refused call leaves the line as it was, and never breaks a turn or a Bash call', async () => {
  const noId = lineWorld({ broken: ['session.id'] })
  await noId.sessionStart()
  assert.deepEqual(noId.status, [])
  const noList = lineWorld({ broken: ['fs.list'] })
  await noList.sessionStart()
  await noList.start('a prompt', 't1')
  assert.equal(noList.status.at(-1), 'jev 0.15.0 · no commit reviewed yet')
  const noRead = lineWorld({ files: { [`${DATA}/log.jsonl`]: review('MERGE') } })
  await noRead.sessionStart()
  noRead.broken.add('fs.read')
  assert.deepEqual(await noRead.bash('git commit -m "x"'), { result: { stdout: '', stderr: '', interrupted: false } })
  assert.equal(noRead.status.at(-1), 'jev 0.15.0 · last commit MERGE')
})

test('status line: JEV_HOOKS_DISABLE=1 clears it at the next update and keeps it off', async () => {
  const w = lineWorld({ files: { [`${DATA}/log.jsonl`]: review('MERGE') } })
  await w.sessionStart()
  assert.equal(w.status.at(-1), 'jev 0.15.0 · last commit MERGE')
  w.env.JEV_HOOKS_DISABLE = '1'
  await w.start('a prompt', 't1')
  assert.equal(w.status.at(-1), undefined)
  const shown = w.status.length
  await w.bash('git commit -m "x"')
  await w.start('another prompt', 't2')
  assert.equal(w.status.length, shown)
  const off = lineWorld({ env: { JEV_HOOKS_DISABLE: '1' } })
  await off.sessionStart()
  assert.deepEqual(off.status, [])
})
