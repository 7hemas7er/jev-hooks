// The effort router's pure core: which configuration applies, where a prompt goes and
// with which key, what is sent, how the answer reads, which effort comes out, when
// the cache guard gives up and what the lines say. A mistake here either raises the
// effort (the router's default only lowers it), sends a prompt or a key where it must
// not go, or clears the user's prompt cache on every turn: each rule has its own case.
// hooks/register.ts, which carries these values to and from Claude Code, has its own
// tests in tests/router/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyFromFileText } from '../../src/core/backend.ts'
import { applyTemperature } from '../../src/core/calibration.ts'
import { formatNumber } from '../../src/core/numbers.ts'
import {
  GUARD_START, ROUTER_FILES, cacheGuard, chooseEffort, clipPrompt, decisionLine, effectiveRouterConfig, fetchFailure, guardLine,
  maxEffort, minEffort, modelAllowed, parseClassification, prepareRequest, routerBackend, routerLogLine, shiftEffort, statusLine,
  textRequest, userConfigDir,
} from '../../src/core/router.ts'
import { neutralize } from '../../src/core/state.ts'
import { validateBody } from '../../src/core/systemone.ts'
import { PROMPT_ORIGIN_KINDS } from '../../src/core/types.ts'
import type {
  CacheGuard, Classification, Effort, GuardState, GuardStep, RequestBody, Result, RouterBackend, RouterConfig, RouterContext,
  SessionEffort, StepUsage,
} from '../../src/core/types.ts'
import { highEntropyValue, phrasesForClaude, RE_MARKER, stripeLiveKey } from '../helpers/fake-secrets.ts'
import { generator } from '../helpers/strings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const ROUTER = json('config/router.json')
const CALIBRATION = json('config/calibration.json')

// Fake, recognizable keys: nothing that looks like a real secret enters the repo.
const KEY = 'fake-router-key-value'
const USER_KEY = 'fake-user-key-value'
const FILE_KEY = 'fake-key-file-value'

function valueOf<T>(e: Result<T>): T {
  if (!e.ok) assert.fail(`expected ok, found ${e.error.kind}: ${e.error.message}`)
  return e.value
}

function ko<T>(e: Result<T>): { kind: string; message: string } {
  if (e.ok) assert.fail(`expected an error, found ${JSON.stringify(e.value)}`)
  return e.error
}

const NO_FILES = { user: null, projects: [], userCalibration: null }
// The checkout's own project file, as the hook passes it.
const project1 = (text: string | null): { label: string; text: string | null }[] => [{ label: ROUTER_FILES.project, text }]

// The plugin's router.json with the router turned on, as register.ts gets it when the
// user has no router.json of their own.
function pluginConfig(): RouterConfig {
  const r = effectiveRouterConfig(NO_FILES, { effort_router: true })
  assert.deepEqual(r.notes, [])
  if (!r.cfg) assert.fail('the plugin configuration is invalid')
  return r.cfg
}

const CFG = pluginConfig()
const LOCAL = valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017' }, {}))
const REMOTE = valueOf(routerBackend({ review_url: 'https://rizzo.example.com', api_key: KEY }, {}))

// ─── Files and backend ────────────────────────────────────────────────────────

test('userConfigDir: an absolute XDG_CONFIG_HOME, otherwise ~/.config, otherwise nothing', () => {
  const cases: [string | undefined, string | undefined, string | null][] = [
    ['/cfg', '/h', '/cfg'],
    ['/cfg', undefined, '/cfg'],
    ['relative/cfg', '/h', '/h/.config'],
    ['', '/h', '/h/.config'],
    [undefined, '/h', '/h/.config'],
    ['relative', '', null],
    [undefined, undefined, null],
  ]
  for (const [xdg, home, expected] of cases) assert.equal(userConfigDir(xdg, home), expected, `${xdg} ${home}`)
})

test('keyFromFileText: the first non-empty line, trimmed, with LF or CRLF', () => {
  assert.equal(keyFromFileText(`\n  ${FILE_KEY}  \nsecond-line\n`), FILE_KEY)
  assert.equal(keyFromFileText(`\r\n\t\r\n${FILE_KEY}\r\nsecond-line\r\n`), FILE_KEY)
  assert.equal(keyFromFileText(FILE_KEY), FILE_KEY)
  for (const empty of ['', '  \n\t\n', null, undefined]) assert.equal(keyFromFileText(empty), undefined, JSON.stringify(empty))
})

test('effectiveRouterConfig: without files, the plugin router.json and calibration, on only with effort_router true', () => {
  assert.equal(CFG.enabled, true)
  assert.equal(CFG.file, ROUTER_FILES.plugin)
  assert.equal(CFG.calibration.file, ROUTER_FILES.pluginCalibration)
  assert.equal(CFG.taskQuestion, 'task_kind')
  assert.deepEqual(CFG.only_origins, ['composer'])
  assert.deepEqual(Object.keys(CFG.questions), Object.keys(ROUTER.questions))
  // anything but the boolean true leaves it off, and it is a copy: the next call is on again
  for (const options of [{}, { effort_router: false }, { effort_router: 'true' }, { effort_router: 1 }, null as never]) {
    const r = effectiveRouterConfig(NO_FILES, options)
    assert.equal(r.cfg?.enabled, false, JSON.stringify(options))
    assert.deepEqual(r.notes, [])
  }
  assert.equal(pluginConfig().enabled, true)
})

test('effectiveRouterConfig: the user router.json applies in full, an invalid one falls back to the plugin with a note', () => {
  const mine = structuredClone(ROUTER)
  mine.only_origins = ['composer', 'bridge']
  mine.max_effort = 'medium'
  const r = effectiveRouterConfig({ ...NO_FILES, user: JSON.stringify(mine) }, { effort_router: true })
  assert.deepEqual(r.notes, [])
  assert.equal(r.cfg?.file, ROUTER_FILES.user)
  assert.deepEqual(r.cfg?.only_origins, ['composer', 'bridge'])
  assert.equal(r.cfg?.max_effort, 'medium')

  // a router.json from an earlier draft, with an origin kind 2.1.283 never sends
  const old = structuredClone(ROUTER)
  old.only_origins = ['human']
  const o = effectiveRouterConfig({ ...NO_FILES, user: JSON.stringify(old) }, { effort_router: true })
  assert.equal(o.cfg?.file, ROUTER_FILES.plugin)
  assert.deepEqual(o.cfg?.only_origins, ['composer'])
  assert.equal(o.notes.length, 1)
  assert.match(o.notes[0], /^~\/\.config\/jev-hooks\/router\.json: invalid, the plugin's router\.json is used \(~\/\.config\/jev-hooks\/router\.json \/only_origins\/0: unknown origin "human"/)

  const broken = effectiveRouterConfig({ ...NO_FILES, user: '{ "version": 1, ' }, { effort_router: true })
  assert.equal(broken.cfg?.file, ROUTER_FILES.plugin)
  assert.match(broken.notes[0], /^~\/\.config\/jev-hooks\/router\.json: invalid, the plugin's router\.json is used \(.*invalid JSON/)
})

test('effectiveRouterConfig: the user calibration is baked into the router, an invalid one falls back with a note', () => {
  const mine = structuredClone(CALIBRATION)
  mine.profiles = [{ name: 'mine', match: {}, calibrated: false }]
  const r = effectiveRouterConfig({ ...NO_FILES, userCalibration: JSON.stringify(mine) }, { effort_router: true })
  assert.deepEqual(r.notes, [])
  assert.equal(r.cfg?.calibration.file, ROUTER_FILES.userCalibration)
  assert.deepEqual(r.cfg?.calibration.profiles.map((p) => p.name), ['mine'])

  const bad = structuredClone(CALIBRATION)
  bad.wide_delta_logit = 'wide'
  const b = effectiveRouterConfig({ ...NO_FILES, userCalibration: JSON.stringify(bad) }, { effort_router: true })
  assert.equal(b.cfg?.calibration.file, ROUTER_FILES.pluginCalibration)
  assert.equal(b.notes.length, 1)
  assert.match(b.notes[0], /^~\/\.config\/jev-hooks\/calibration\.json: invalid, the plugin's calibration is used \(.*\/wide_delta_logit: expected a number/)
  // both user files: the user's router gets the user's calibration
  const both = effectiveRouterConfig({ ...NO_FILES, user: JSON.stringify(ROUTER), userCalibration: JSON.stringify(mine) }, { effort_router: true })
  assert.equal(both.cfg?.file, ROUTER_FILES.user)
  assert.equal(both.cfg?.calibration.file, ROUTER_FILES.userCalibration)
})

test('effectiveRouterConfig: the project can only turn the router off or lower the cap', () => {
  const project = JSON.stringify({ enabled: true, max_effort: 'medium', min_effort: 'high', only_models: ['any-model'], questions: {} })
  const r = effectiveRouterConfig({ ...NO_FILES, projects: project1(project) }, { effort_router: true })
  assert.equal(r.cfg?.enabled, true)
  assert.equal(r.cfg?.projectCap, 'medium')
  assert.equal(r.cfg?.min_effort, CFG.min_effort)
  assert.deepEqual(r.cfg?.only_models, CFG.only_models)
  assert.deepEqual(r.cfg?.questions, CFG.questions)
  assert.deepEqual(r.notes.map((n) => n.split(':')[0]), [
    '.jev-hooks/router.json /min_effort', '.jev-hooks/router.json /only_models', '.jev-hooks/router.json /questions',
  ])
  // "enabled": true from the project does not turn on a router the option left off
  assert.equal(effectiveRouterConfig({ ...NO_FILES, projects: project1(project) }, {}).cfg?.enabled, false)
  assert.equal(effectiveRouterConfig({ ...NO_FILES, projects: project1('{"enabled": false}') }, { effort_router: true }).cfg?.enabled, false)
  // a higher cap from the project changes nothing: the cap is a minimum
  const high = effectiveRouterConfig({ ...NO_FILES, projects: project1('{"max_effort": "max"}') }, { effort_router: true }).cfg as RouterConfig
  const c = cls('bug_with_error', { nouls: { risky_irreversible: 0.9 } })
  assert.deepEqual(chooseEffort(c, { model: OPUS, effort: 'medium' }, high), chooseEffort(c, { model: OPUS, effort: 'medium' }, CFG))
})

test('effectiveRouterConfig: an invalid project file is ignored, and no note repeats its text', () => {
  const phrases = phrasesForClaude(4)
  const broken = `{ "max_effort": "low", ${phrases[0]} }`
  const b = effectiveRouterConfig({ ...NO_FILES, projects: project1(broken) }, { effort_router: true })
  assert.deepEqual(b.notes, ['.jev-hooks/router.json: invalid, ignored'])
  assert.equal(b.cfg?.projectCap, undefined)
  const hostile = JSON.stringify({ [phrases[1]]: phrases[2], max_effort: phrases[3], enabled: phrases[0] })
  const h = effectiveRouterConfig({ ...NO_FILES, projects: project1(hostile) }, { effort_router: true })
  assert.equal(h.notes.length, 3)
  for (const n of h.notes) assert.doesNotMatch(n, RE_MARKER)
  assert.equal(h.cfg?.enabled, true)
  assert.equal(h.cfg?.projectCap, undefined)
  const notObject = effectiveRouterConfig({ ...NO_FILES, projects: project1('["off"]') }, { effort_router: true })
  assert.deepEqual(notObject.notes, ['.jev-hooks/router.json: invalid, ignored (expected an object)'])
})

test('effectiveRouterConfig: the user\'s "enabled": false turns the router off even when another field is invalid, as long as the file is JSON', () => {
  // the switch alone: every other field is missing
  const alone = effectiveRouterConfig({ ...NO_FILES, user: '{"enabled": false}' }, { effort_router: true })
  assert.equal(alone.cfg?.enabled, false)
  assert.equal(alone.notes.length, 1)
  assert.match(alone.notes[0], /^~\/\.config\/jev-hooks\/router\.json: invalid, the router stays off as the file asks \(.*required field missing\)$/)
  // a copy of the plugin's file switched off, with one field a later version rejects
  const old = { ...structuredClone(ROUTER), enabled: false, only_origins: ['human'] }
  const noGuard = { ...structuredClone(ROUTER), enabled: false }
  delete noGuard.cache_guard
  for (const mine of [old, noGuard, { ...structuredClone(ROUTER), enabled: false, timeout_ms: 10 }]) {
    const r = effectiveRouterConfig({ ...NO_FILES, user: JSON.stringify(mine) }, { effort_router: true })
    assert.equal(r.cfg?.enabled, false, JSON.stringify(mine).slice(0, 60))
    assert.equal(r.notes.length, 1)
    assert.match(r.notes[0], /: invalid, the router stays off as the file asks \(/)
  }
  // a valid file switched off: off, and nothing to say
  const valid = effectiveRouterConfig({ ...NO_FILES, user: JSON.stringify({ ...ROUTER, enabled: false }) }, { effort_router: true })
  assert.equal(valid.cfg?.enabled, false)
  assert.deepEqual(valid.notes, [])
  // only the boolean false in an object is the switch; a file that is not JSON says nothing
  const on = [
    '{"enabled": "false"}', '{"enabled": 0}', '[{"enabled": false}]', '{"enabled": false, ',
    JSON.stringify({ ...ROUTER, only_origins: ['human'] }),
  ]
  for (const text of on) {
    const r = effectiveRouterConfig({ ...NO_FILES, user: text }, { effort_router: true })
    assert.equal(r.cfg?.enabled, true, text)
    assert.equal(r.cfg?.file, ROUTER_FILES.plugin, text)
    assert.match(r.notes[0], /^~\/\.config\/jev-hooks\/router\.json: invalid, the plugin's router\.json is used \(/, text)
  }
  // the option still decides first
  assert.equal(effectiveRouterConfig({ ...NO_FILES, user: '{"enabled": false}' }, {}).cfg?.enabled, false)
})

test('effectiveRouterConfig: a user router.json that cannot be read keeps the router off with a note; an unreadable calibration only gets a note', () => {
  const off = effectiveRouterConfig({ ...NO_FILES, userUnreadable: true }, { effort_router: true })
  assert.equal(off.cfg?.enabled, false)
  assert.equal(off.cfg?.file, ROUTER_FILES.plugin)
  assert.deepEqual(off.notes, ['~/.config/jev-hooks/router.json: unreadable, the router stays off until it can be read'])
  // the project's restrictions still apply beneath the switch
  const capped = effectiveRouterConfig({ ...NO_FILES, userUnreadable: true, projects: project1('{"max_effort": "low"}') }, { effort_router: true })
  assert.equal(capped.cfg?.enabled, false)
  assert.equal(capped.cfg?.projectCap, 'low')
  // only the boolean true is the flag, and a text that came wins over it
  for (const f of [{ ...NO_FILES, userUnreadable: false }, { ...NO_FILES, userUnreadable: 'yes' as never }, { ...NO_FILES, user: JSON.stringify(ROUTER), userUnreadable: true }]) {
    const r = effectiveRouterConfig(f, { effort_router: true })
    assert.equal(r.cfg?.enabled, true, JSON.stringify(f).slice(0, 60))
    assert.deepEqual(r.notes, [])
  }

  const cal = effectiveRouterConfig({ ...NO_FILES, userCalibrationUnreadable: true }, { effort_router: true })
  assert.equal(cal.cfg?.enabled, true)
  assert.equal(cal.cfg?.calibration.file, ROUTER_FILES.pluginCalibration)
  assert.deepEqual(cal.notes, ['~/.config/jev-hooks/calibration.json: unreadable, the plugin\'s calibration is used'])
  const mine = JSON.stringify(CALIBRATION)
  const read = effectiveRouterConfig({ ...NO_FILES, userCalibration: mine, userCalibrationUnreadable: true }, { effort_router: true })
  assert.equal(read.cfg?.calibration.file, ROUTER_FILES.userCalibration)
  assert.deepEqual(read.notes, [])
})

test('effectiveRouterConfig: every project file restricts, the same text counts once, the notes carry the label', () => {
  const own = { label: ROUTER_FILES.project, text: '{"max_effort": "medium", "questions": {}}' }
  const main = { label: ROUTER_FILES.projectMainTree, text: '{"max_effort": "low", "min_effort": "max"}' }
  const both = effectiveRouterConfig({ ...NO_FILES, projects: [own, main] }, { effort_router: true })
  assert.equal(both.cfg?.enabled, true)
  assert.equal(both.cfg?.projectCap, 'low')
  assert.deepEqual(both.notes.map((n) => n.split(':')[0]), [
    '.jev-hooks/router.json /questions', '.jev-hooks/router.json (main working tree) /min_effort',
  ])
  // whatever the order, the lowest cap
  assert.equal(effectiveRouterConfig({ ...NO_FILES, projects: [main, own] }, { effort_router: true }).cfg?.projectCap, 'low')
  // "enabled": false from either file sticks, and a later "enabled": true does not undo it
  const off = '{"enabled": false}'
  const on = '{"enabled": true}'
  for (const projects of [
    [{ label: ROUTER_FILES.project, text: off }, { label: ROUTER_FILES.projectMainTree, text: on }],
    [{ label: ROUTER_FILES.project, text: on }, { label: ROUTER_FILES.projectMainTree, text: off }],
    [{ label: ROUTER_FILES.project, text: null }, { label: ROUTER_FILES.projectMainTree, text: off }],
  ]) {
    assert.equal(effectiveRouterConfig({ ...NO_FILES, projects }, { effort_router: true }).cfg?.enabled, false, JSON.stringify(projects))
  }
  // one file read at two paths (a plain repository): its notes once
  const same = effectiveRouterConfig({ ...NO_FILES, projects: [own, { label: ROUTER_FILES.projectMainTree, text: own.text }] }, { effort_router: true })
  assert.equal(same.notes.length, 1)
  assert.match(same.notes[0], /^\.jev-hooks\/router\.json \/questions: field ignored/)
  assert.equal(same.cfg?.projectCap, 'medium')
  // a missing file says nothing, an invalid one says which
  const missing = effectiveRouterConfig({ ...NO_FILES, projects: [{ label: ROUTER_FILES.project, text: null }, { label: ROUTER_FILES.projectMainTree, text: '{ "max_effort": ' }] }, { effort_router: true })
  assert.deepEqual(missing.notes, ['.jev-hooks/router.json (main working tree): invalid, ignored'])
  // a list that is not one, or entries without a text, are no project file
  for (const projects of [null, 'x', {}, [null, 3, { text: 5 }, { label: 'x' }]]) {
    const r = effectiveRouterConfig({ ...NO_FILES, projects: projects as never }, { effort_router: true })
    assert.deepEqual(r.notes, [], JSON.stringify(projects))
    assert.deepEqual(r.cfg, CFG, JSON.stringify(projects))
  }
  // a project file that is there but cannot be read may be the repository's switch: off,
  // with a note that names the file and nothing of it
  const locked = effectiveRouterConfig({ ...NO_FILES, projects: [{ label: ROUTER_FILES.project, text: null }, { label: ROUTER_FILES.projectMainTree, text: null, unreadable: true }] }, { effort_router: true })
  assert.equal(locked.cfg?.enabled, false)
  assert.deepEqual(locked.notes, ['.jev-hooks/router.json (main working tree): unreadable, the router stays off until it can be read'])
  // a text that came wins over the flag, and only a strict true counts
  const came = effectiveRouterConfig({ ...NO_FILES, projects: [{ label: ROUTER_FILES.project, text: '{}', unreadable: true }] }, { effort_router: true })
  assert.equal(came.cfg?.enabled, true)
  assert.deepEqual(came.notes, [])
  const loose = effectiveRouterConfig({ ...NO_FILES, projects: [{ label: ROUTER_FILES.project, text: null, unreadable: 'yes' as never }] }, { effort_router: true })
  assert.deepEqual(loose.cfg, CFG)
})

test('effectiveRouterConfig: a project file with 200k keys gives four notes at most, and never throws', () => {
  for (const key of [(i: number) => `k${i}`, (i: number) => String(i)]) {
    const o: Record<string, unknown> = { enabled: false, max_effort: 'medium' }
    for (let i = 0; i < 200_000; i++) o[key(i)] = 1
    const r = effectiveRouterConfig({ ...NO_FILES, projects: project1(JSON.stringify(o)) }, { effort_router: true })
    if (!r.cfg) assert.fail('no configuration')
    // what the file may restrict, it still restricts
    assert.equal(r.cfg.enabled, false)
    assert.equal(r.cfg.projectCap, 'medium')
    assert.equal(r.notes.length, 4)
    for (const n of r.notes.slice(0, 3)) assert.match(n, /^\.jev-hooks\/router\.json \/(‹key›|[0-9]+): field ignored/)
    assert.equal(r.notes[3], '.jev-hooks/router.json: 199997 more fields ignored')
  }
})

test('routerBackend: router_url first, then review_url; the key of the same layer', () => {
  const both = valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017', router_url: 'http://192.168.1.50:8019', api_key: USER_KEY }, {}))
  assert.deepEqual(both, { url: 'http://192.168.1.50:8019/v1/systemone', key: USER_KEY, model: 'jev-latest', local: true, host: '192.168.1.50:8019' })
  assert.equal('layer' in both, false)
  // an empty or blank router_url means the reviewer's instance
  for (const router_url of ['', '   ', 8019, undefined]) {
    assert.equal(valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017', router_url }, {})).url, 'http://192.168.1.50:8017/v1/systemone', String(router_url))
  }
  // router_api_key, then api_key, then the first line of the key file
  const opts = { review_url: 'http://100.64.0.10:8017' }
  assert.equal(valueOf(routerBackend({ ...opts, router_api_key: KEY, api_key: USER_KEY }, { keyFile: FILE_KEY })).key, KEY)
  assert.equal(valueOf(routerBackend({ ...opts, router_api_key: ' ', api_key: USER_KEY }, { keyFile: FILE_KEY })).key, USER_KEY)
  assert.equal(valueOf(routerBackend(opts, { keyFile: `\n${FILE_KEY}\nsecond-line\n` })).key, FILE_KEY)
  assert.equal(valueOf(routerBackend(opts, { keyFile: null })).key, '')
  assert.equal(valueOf(routerBackend({ ...opts, model: ' rizzo-latest ' }, {})).model, 'rizzo-latest')
})

test('routerBackend: api_key and the key file follow router_url only to review_url\'s scheme and host', () => {
  const elsewhere = [
    // a LAN rizzo next to TypeSafe: the TypeSafe key would cross the LAN in clear
    { review_url: 'https://api.typesafe.ai', router_url: 'http://192.168.1.50:8019' },
    { review_url: 'https://rizzo.example.com', router_url: 'https://rizzo2.example.com' },
    // the same host with another scheme
    { review_url: 'https://192.168.1.50:8017', router_url: 'http://192.168.1.50:8019' },
    // nothing to compare with
    { review_url: '', router_url: 'http://192.168.1.50:8019' },
    { review_url: 'not a url', router_url: 'http://192.168.1.50:8019' },
  ]
  for (const o of elsewhere) {
    const name = JSON.stringify(o)
    assert.equal(valueOf(routerBackend({ ...o, api_key: USER_KEY }, {})).key, '', name)
    assert.equal(valueOf(routerBackend(o, { keyFile: FILE_KEY })).key, '', name)
    // router_api_key is for router_url, wherever it points
    assert.equal(valueOf(routerBackend({ ...o, router_api_key: KEY, api_key: USER_KEY }, { keyFile: FILE_KEY })).key, KEY, name)
  }
  // the same scheme and host, whatever the port (two instances on one box), the path or the case
  for (const router_url of ['http://192.168.1.50:8019', 'http://192.168.1.50', 'HTTP://192.168.1.50:8017/v1/systemone']) {
    assert.equal(valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017', router_url, api_key: USER_KEY }, {})).key, USER_KEY, router_url)
    assert.equal(valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017', router_url }, { keyFile: FILE_KEY })).key, FILE_KEY, router_url)
  }
  assert.equal(valueOf(routerBackend({ review_url: 'https://rizzo.example.com', router_url: 'https://RIZZO.example.com:8443', api_key: USER_KEY }, {})).key, USER_KEY)
})

test('routerBackend: the environment gives only a URL, never a key', () => {
  // no URL in the options: JEV_HOOKS_ROUTER_URL, then JEV_HOOKS_URL, and no key from any source
  const a = valueOf(routerBackend({ api_key: USER_KEY, router_api_key: KEY }, { routerUrl: 'http://192.168.1.50:8019', url: 'http://192.168.1.50:8017', keyFile: FILE_KEY }))
  assert.equal(a.url, 'http://192.168.1.50:8019/v1/systemone')
  assert.equal(a.key, '')
  assert.equal(valueOf(routerBackend({}, { routerUrl: '  ', url: 'http://192.168.1.50:8017' })).url, 'http://192.168.1.50:8017/v1/systemone')
  // the options' URL wins over the environment's
  assert.equal(valueOf(routerBackend({ review_url: 'http://192.168.1.50:8017' }, { routerUrl: 'http://127.0.0.1:1' })).host, '192.168.1.50:8017')
})

test('routerBackend: http only towards local hosts, no TypeSafe fallback, errors without the key', () => {
  const e = ko(routerBackend({ router_url: 'http://rizzo.example.com:8019', api_key: USER_KEY }, {}))
  assert.equal(e.kind, 'config')
  assert.match(e.message, /use https/)
  assert.doesNotMatch(e.message, new RegExp(USER_KEY))
  assert.equal(ko(routerBackend({}, {})).kind, 'not_configured')
  assert.equal(ko(routerBackend({ api_key: USER_KEY, model: 'jev-latest' }, { keyFile: FILE_KEY })).kind, 'not_configured')
  assert.equal(ko(routerBackend(null as never, null as never)).kind, 'not_configured')
  const ts = ko(routerBackend({ router_url: 'https://api.typesafe.ai' }, {}))
  assert.equal(ts.kind, 'not_configured')
  assert.match(ts.message, /requires a key/)
})

// ─── The request ──────────────────────────────────────────────────────────────

const body = (r: ReturnType<typeof prepareRequest>): RequestBody => {
  if ('skip' in r) assert.fail(`skipped: ${r.skip}`)
  return JSON.parse(r.init.body)
}
const skipOf = (r: ReturnType<typeof prepareRequest>): string => {
  if (!('skip' in r)) assert.fail('expected a skip')
  return r.skip
}
const composer = (text: string): { text: string; origin: { kind: string } } => ({ text, origin: { kind: 'composer' } })
const NO_MASK = { text: null }

test('prepareRequest: the skip reasons, in order', () => {
  const cases: [{ text: string; origin?: { kind?: string } | null }, string][] = [
    [{ text: '', origin: { kind: 'sdk' } }, 'origin "sdk" is not classified'],
    [{ text: 'hi', origin: { kind: 'task-notification' } }, 'origin "task-notification" is not classified'],
    [{ text: 'hi', origin: { kind: 'bridge' } }, 'origin "bridge" is not classified'],
    [{ text: 'hi', origin: { kind: 'Composer' } }, 'origin "other" is not classified'],
    [{ text: 'hi', origin: {} }, 'origin "unclassified" is not classified'],
    [{ text: 'hi', origin: null }, 'origin "unclassified" is not classified'],
    [{ text: 'hi' }, 'origin "unclassified" is not classified'],
    [composer(''), 'empty prompt'],
    [composer(' \n\t '), 'empty prompt'],
    [composer('/compact keep the plan'), 'starts with "/"'],
    [composer('  \n!git status'), 'starts with "!"'],
  ]
  for (const [e, reason] of cases) assert.equal(skipOf(prepareRequest(CFG, e, LOCAL, NO_MASK, 1)), reason, JSON.stringify(e))
  // every kind the engine sends is skipped unless listed, and listed ones are sent
  for (const kind of PROMPT_ORIGIN_KINDS) {
    const r = prepareRequest(CFG, { text: 'rename a to b', origin: { kind } }, LOCAL, NO_MASK, 1)
    assert.equal('skip' in r, kind !== 'composer', kind)
  }
  const withBridge = { ...CFG, only_origins: ['composer', 'bridge'] }
  assert.equal(body(prepareRequest(withBridge, { text: 'rename a to b', origin: { kind: 'bridge' } }, LOCAL, NO_MASK, 1)).state, 'rename a to b')
  // a mid-turn prompt is classified like any other
  assert.equal('skip' in prepareRequest(CFG, { ...composer('also add a test'), turnId: 't1' } as never, LOCAL, NO_MASK, 1), false)
})

test('prepareRequest: the body is state, model and the router questions, within the shared limits', () => {
  const r = prepareRequest(CFG, composer('rename the helper in src/a.ts'), LOCAL, NO_MASK, 1)
  if ('skip' in r) assert.fail(r.skip)
  assert.equal(r.url, 'http://192.168.1.50:8017/v1/systemone')
  assert.equal(r.init.method, 'POST')
  assert.deepEqual(r.init.headers, { 'Content-Type': 'application/json', Accept: 'application/json' })
  assert.equal(r.redactions, 0)
  const b = body(r)
  assert.deepEqual(Object.keys(b), ['state', 'model', 'questions'])
  assert.equal(b.state, 'rename the helper in src/a.ts')
  assert.equal(b.model, 'jev-latest')
  assert.deepEqual(b.questions, CFG.questions)
  assert.equal(Object.keys(b.questions).length, 7)
  assert.deepEqual(validateBody(b), [])
  // the Bearer only with a key
  const keyed = prepareRequest(CFG, composer('x'), { ...LOCAL, key: KEY }, NO_MASK, 1)
  if ('skip' in keyed) assert.fail(keyed.skip)
  assert.equal(keyed.init.headers.Authorization, `Bearer ${KEY}`)
})

test('prepareRequest: a request outside the shared limits is not sent', () => {
  const big = { ...CFG, prompt_max_chars: 100_000, prompt_head_chars: 50_000 }
  // 60 000 control characters: 6 bytes each once serialized, beyond the 256 KB of state
  const r = skipOf(prepareRequest(big, composer('\u0001'.repeat(60_000)), LOCAL, NO_MASK, 1))
  assert.match(r, /^request outside the limits shared by Jev and rizzo-flow: state too large/)
  assert.doesNotMatch(r, /\u0001/)
})

test('clipPrompt: head, mark and tail, never half a surrogate pair', () => {
  assert.equal(clipPrompt('short', 10, 6), 'short')
  assert.equal(clipPrompt('abcdefghij', 10, 6), 'abcdefghij')
  assert.equal(clipPrompt('abcdefghijklmnop', 10, 6), 'abcdef\n[…]\nmnop')
  assert.equal(clipPrompt('abcdefghijklmnop', 10, 0), '\n[…]\nghijklmnop')
  assert.equal(clipPrompt('abcdefghijklmnop', 10, 10), 'abcdefghij\n[…]\n')
  // the head's cut would fall inside the emoji: the head gets one unit shorter
  assert.equal(clipPrompt('abcde😀fghij', 8, 6), 'abcde\n[…]\nij')
  // the tail's cut would fall inside the emoji: the tail gets one unit shorter
  assert.equal(clipPrompt('abcdefgh😀ij', 8, 5), 'abcde\n[…]\nij')
  assert.equal(clipPrompt('abcdefg😀ij', 8, 4), 'abcd\n[…]\n😀ij')
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  const rnd = generator(11)
  for (let k = 0; k < 200; k++) {
    let s = ''
    const n = 20 + Math.floor(rnd() * 40)
    for (let i = 0; i < n; i++) s += rnd() < 0.4 ? '😀' : 'x'
    const max = 5 + Math.floor(rnd() * 15)
    const out = clipPrompt(s, max, Math.floor(rnd() * (max + 1)))
    assert.doesNotMatch(out, loneSurrogate, `${s.length} ${max}`)
  }
  // the router clips before sending
  const small = { ...CFG, prompt_max_chars: 10, prompt_head_chars: 6 }
  assert.equal(body(prepareRequest(small, composer('abcdefghijklmnop'), LOCAL, NO_MASK, 1)).state, 'abcdef\n[…]\nmnop')
})

test('prepareRequest: towards a local backend the prompt goes as it is, towards another one redacted and masked', () => {
  const rnd = generator(7)
  const token = highEntropyValue(40, rnd)
  const stripe = stripeLiveKey(rnd)
  const text = `deploy qzrealproject with ${token}\nand the key ${stripe}`
  const map = { text: 'qzrealproject\tplaceholderqz\n' }
  assert.equal(body(prepareRequest(CFG, composer(text), LOCAL, map, 1)).state, text)

  const r = prepareRequest(CFG, composer(text), REMOTE, map, 1)
  if ('skip' in r) assert.fail(r.skip)
  assert.ok(r.redactions >= 2, String(r.redactions))
  assert.equal(r.init.headers.Authorization, `Bearer ${KEY}`)
  for (const secret of [token, stripe, stripe.slice(8), 'qzrealproject']) assert.equal(r.init.body.includes(secret), false, secret)
  const state = body(r).state
  assert.match(state, /^deploy placeholderqz with /)
  assert.equal(state.length, text.length + 'placeholderqz'.length - 'qzrealproject'.length)
  // the same seed gives the same substitutes
  const again = prepareRequest(CFG, composer(text), REMOTE, map, 1)
  if ('skip' in again) assert.fail(again.skip)
  assert.equal(again.init.body, r.init.body)
  // without a map: redacted only
  assert.match(body(prepareRequest(CFG, composer(text), REMOTE, NO_MASK, 1)).state, /^deploy qzrealproject with /)
})

test('textRequest: what prepareRequest sends once its gates pass, with the clip and questions given', () => {
  const rnd = generator(11)
  const text = `deploy qzrealproject with ${highEntropyValue(40, rnd)}\n${pad(6000)}`
  const map = { text: 'qzrealproject\tplaceholderqz\n' }
  const clip = { max: CFG.prompt_max_chars, head: CFG.prompt_head_chars }
  for (const b of [LOCAL, REMOTE]) {
    assert.deepEqual(textRequest(text, b, map, 3, clip, CFG.questions), prepareRequest(CFG, composer(text), b, map, 3))
  }
  // the gates are prepareRequest's: textRequest sends a text prepareRequest would skip
  assert.equal('skip' in prepareRequest(CFG, composer('/clear'), LOCAL, map, 3), true)
  assert.equal(body(textRequest('/clear', LOCAL, map, 3, clip, CFG.questions)).state, '/clear')
  // another clip and another question set reach the body
  const one = { only: CFG.questions[Object.keys(CFG.questions)[0]] }
  const r = textRequest(text, LOCAL, map, 3, { max: 100, head: 60 }, one)
  assert.equal(body(r).state, clipPrompt(text, 100, 60))
  assert.deepEqual(Object.keys(body(r).questions), ['only'])
  // a mask map that cannot be used still stops a non-local request
  assert.deepEqual(textRequest(text, REMOTE, { text: null, error: 'unreadable' }, 3, clip, CFG.questions).problem, true)
})

// Spaces at both ends, words in between: nothing in it can join a token or a term, and
// no 8 characters of a random value can appear in it.
function pad(n: number): string {
  return ` ${'lorem ipsum dolor sit amet\n'.repeat(Math.ceil(n / 27)).slice(0, Math.max(0, n - 2))} `
}
const piecesOf = (s: string, n: number): string[] => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n))

test('prepareRequest: towards a non-local backend the whole prompt is redacted and masked, then clipped', () => {
  const rnd = generator(21)
  const max = CFG.prompt_max_chars
  const head = CFG.prompt_head_chars
  const tail = max - head
  const sent = (text: string, map: { text: string | null } = NO_MASK): { body: string; redactions: number } => {
    assert.ok(text.length > max)
    const r = prepareRequest(CFG, composer(text), REMOTE, map, 1)
    if ('skip' in r) assert.fail(r.skip)
    return { body: r.init.body, redactions: r.redactions }
  }
  const leaks = (out: string, secret: string): string[] => piecesOf(secret, 8).filter((x) => out.includes(x))

  // a 40-character value across the head cut, across the tail cut, and across both
  // (length max + 2): 19 characters on each side of a cut, under the 20 of the token rule
  const cases: [string, (s: string) => string][] = [
    ['head cut', (s) => `${pad(head - 19)}${s}${pad(2000)}`],
    ['tail cut', (s) => `${pad(head + 2000)}${s}${pad(tail - 19)}`],
    ['both cuts', (s) => `${pad(head - 19)}${s}${pad(max + 2 - (head - 19) - 40)}`],
  ]
  for (const [name, compose] of cases) {
    const secret = highEntropyValue(40, rnd)
    const text = compose(secret)
    const out = sent(text)
    assert.deepEqual(leaks(out.body, secret), [], name)
    assert.ok(out.redactions >= 1, name)
    // towards a local backend the same prompt goes as it is: the pieces are there
    assert.notDeepEqual(leaks(body(prepareRequest(CFG, composer(text), LOCAL, NO_MASK, 1)).state, secret), [], name)
  }

  // a mask term across each cut: no piece of it, the placeholder in its place
  const term = 'qzkorvaxtelmund'
  const map = { text: `${term}\tplaceholderqz\n` }
  for (const [name, text] of [
    ['head cut', `${pad(head - 8)}${term}${pad(2000)}`],
    ['tail cut', `${pad(head + 2000)}${term}${pad(tail - 7)}`],
  ]) {
    const out = sent(text, map)
    assert.deepEqual(piecesOf(term, 4).filter((x) => out.body.includes(x)), [], name)
  }

  // a private key whose BEGIN line falls in the dropped middle, and the tail cut inside
  // a line of its body: no piece of any body line
  const begin = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----'
  const end = '-----END ' + 'RSA PRIVATE' + ' KEY-----'
  const lines = Array.from({ length: 30 }, () => highEntropyValue(64, rnd))
  const before = `${pad(head + 500)}\n${begin}\n${lines.join('\n')}\n${end}\n`
  const cut = before.indexOf(lines[20]) + 50
  const pem = `${before}${pad(cut + tail - before.length)}`
  assert.equal(pem.length - tail, cut)
  const out = sent(pem)
  for (const line of lines) assert.deepEqual(leaks(out.body, line), [])
  assert.ok(out.redactions >= 1)

  // redactions counts the whole prompt: a value only in the dropped middle counts too
  assert.equal(sent(`${pad(head + 100)}${highEntropyValue(40, rnd)}${pad(2000)}`).redactions, 1)
})

test('prepareRequest: a mask map that exists but cannot be used stops the request towards a non-local backend', () => {
  const reason = 'guardrail mask map unreadable: nothing is sent to a non-local backend'
  assert.equal(skipOf(prepareRequest(CFG, composer('hi'), REMOTE, { text: null, error: 'unreadable' }, 1)), reason)
  // a problem the user must hear about, unlike the skips the design makes
  for (const m of [{ text: null, error: 'unreadable' }, { text: 'only-one-field\n' }, null as never]) {
    assert.deepEqual(prepareRequest(CFG, composer('hi'), REMOTE, m, 1), { skip: reason, problem: true }, JSON.stringify(m))
  }
  for (const e of [composer(''), composer('/compact'), { text: 'hi', origin: { kind: 'sdk' } }]) {
    assert.equal('problem' in prepareRequest(CFG, e, REMOTE, NO_MASK, 1), false, JSON.stringify(e))
  }
  // no HOME and no GUARDRAIL_MASK_MAP: the map cannot even be looked for, and the line says so
  assert.deepEqual(prepareRequest(CFG, composer('hi'), REMOTE, { text: null, error: 'no home' }, 1), {
    skip: 'guardrail mask map location unknown (no HOME and no GUARDRAIL_MASK_MAP): nothing is sent to a non-local backend', problem: true,
  })
  assert.equal(body(prepareRequest(CFG, composer('hi'), LOCAL, { text: null, error: 'no home' }, 1)).state, 'hi')
  assert.equal(skipOf(prepareRequest(CFG, composer('hi'), REMOTE, { text: 'only-one-field\n' }, 1)), reason)
  assert.equal(skipOf(prepareRequest(CFG, composer('hi'), REMOTE, { text: 'a�\tb\n' }, 1)), reason)
  // a local backend never reads the map
  assert.equal(body(prepareRequest(CFG, composer('hi'), LOCAL, { text: null, error: 'unreadable' }, 1)).state, 'hi')
})

test('fetchFailure: a fixed token or nothing, never the text of the message', () => {
  // what a backend can put in the message: a redirect's Location, the cause's text
  const hostile = `${phrasesForClaude(1)[0]} ${KEY}`
  const href = `https://x.example/${encodeURIComponent(hostile)}`
  const cases: [string, string][] = [
    // the engine's two refusals, before any request
    ['HooksError: jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy', ' (network disabled by policy)'],
    ['jev-hooks: $.http.fetch: refused: nonessential network traffic is disabled for this session', ' (nonessential traffic disabled)'],
    // a failure: its code, never the host's or the backend's text after it
    ['Error: jev-hooks: $.http.fetch(http://192.168.1.50:8017/v1/systemone) failed: ECONNREFUSED: connect ECONNREFUSED 192.168.1.50:8017', ' (ECONNREFUSED)'],
    [`jev-hooks: $.http.fetch(${href}) failed: ConnectionRefused: ${hostile}`, ' (ConnectionRefused)'],
    [`jev-hooks: $.http.fetch(https://x.example/a)b) failed: ERR_INVALID_URL: "${hostile}" cannot be parsed as a URL`, ' (ERR_INVALID_URL)'],
    // a Location that is not http(s) keeps its spaces: it cannot pass for the engine's shape
    [`jev-hooks: $.http.fetch: note:x) failed: Qzword: ${hostile} refused: http or https only`, ''],
    [`jev-hooks: $.http.fetch: note:$.http.fetch(x) failed: Qzword: y refused: http or https only`, ''],
    [`jev-hooks: $.http.fetch: ${href} refused: http or https only`, ''],
    // nor pass for a refusal: only the engine's whole fixed message is one
    ['jev-hooks: $.http.fetch: foo:network access from plugins is disabled by policy refused: http or https only', ''],
    ['jev-hooks: $.http.fetch: foo:nonessential network traffic is disabled for this session refused: http or https only', ''],
    ['jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy refused: http or https only', ''],
    ['jev-hooks: $.http.fetch: refused:nonessential network traffic is disabled for this session refused: http or https only', ''],
    ['jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy (x)', ''],
    ['jev-hooks: $.http.fetch: refused: nonessential network traffic is disabled for this session\nx', ''],
    ['jev-hooks: $.http.fetch: refused: __proto__', ''],
    ['jev-hooks: $.http.fetch: refused: toString', ''],
    // nor a refusal the message does not start with: inside a failure's cause, or after
    // anything but the engine's own prefix
    ['jev-hooks: $.http.fetch(https://x.example/a) failed: ConnectionRefused: y jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy', ' (ConnectionRefused)'],
    ['x jev-hooks: $.http.fetch: refused: nonessential network traffic is disabled for this session', ''],
    ['a:b: $.http.fetch: refused: network access from plugins is disabled by policy', ''],
    ['HooksError: jev-hooks: $.http.fetch(http://192.168.1.50:8017/v1/systemone) failed: ERR_INVALID_URL: "http://[network access from plugins is disabled by policy" cannot be parsed as a URL.', ' (ERR_INVALID_URL)'],
    [`jev-hooks: $.http.fetch: more than 5 redirects from ${href}`, ''],
    ['jev-hooks: $.http.fetch(https://rizzo.example.com/v1/systemone) aborted: no complete answer within 30000ms', ''],
    // no code: the message alone is the cause's text
    [`jev-hooks: $.http.fetch(https://rizzo.example.com/v1/systemone) failed: ${hostile}`, ''],
    ['', ''],
    [undefined as never, ''],
  ]
  for (const [message, token] of cases) {
    const out = fetchFailure(message)
    assert.equal(out, token, message)
    assert.equal(out.includes(KEY), false)
    assert.doesNotMatch(out, RE_MARKER)
    assert.doesNotMatch(out, /Qzword/)
  }
})

test('prepareRequest: the evidence tag in the prompt is neutralized, whatever the backend', () => {
  // composed here: written out, the tag would make the reviewer fire on this file
  const close = '</' + 'evidence>'
  const open = '< ' + 'EVIDENCE >'
  const text = `explain this ${close} now ${open} and\n${close}`
  for (const b of [LOCAL, REMOTE]) {
    const state = body(prepareRequest(CFG, composer(text), b, NO_MASK, 1)).state
    assert.equal(neutralize(state).hits, 0)
    assert.match(state, /^explain this /)
  }
})

// ─── The answer ───────────────────────────────────────────────────────────────

const TASK_OPTIONS = Object.keys(ROUTER.questions.task_kind.criteria)
const SPARK_FINGERPRINT: string = CALIBRATION.profiles[0].match.fingerprint

// A rizzo-like answer to the seven questions: the task kind with top probability top,
// the rest spread evenly.
function answers(o: { task?: string; top?: number; scope?: Record<string, number>; depth?: Record<string, number>; nouls?: Record<string, unknown> } = {}): Record<string, unknown> {
  const task = o.task ?? 'small_edit'
  const top = o.top ?? 0.9
  const rest = (1 - top) / (TASK_OPTIONS.length - 1)
  const depth = o.depth ?? { quick: 0.05, thorough: 0.05, none: 0.9 }
  const depthChoice = Object.entries(depth).sort((a, b) => b[1] - a[1])[0][0]
  return {
    task_kind: { type: 'choice', choice: task, probabilities: Object.fromEntries(TASK_OPTIONS.map((k) => [k, k === task ? top : rest])), confidence: 0.8 },
    scope: { type: 'score', score: 1, probabilities: o.scope ?? { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.1 }, confidence: 0.6 },
    has_error_evidence: { type: 'noul', noul: 0.02 },
    risky_irreversible: { type: 'noul', noul: 0.01 },
    underspecified: { type: 'noul', noul: 0.1 },
    multi_deliverable: { type: 'noul', noul: 0.05 },
    explicit_depth: { type: 'choice', choice: depthChoice, probabilities: depth, confidence: 0.8 },
    ...o.nouls,
  }
}

const reply = (model: string, a: Record<string, unknown>, extra: Record<string, unknown> = {}): string => JSON.stringify({ model, answers: a, ...extra })
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

test('parseClassification: nouls, choices and the argmax level of the scores', () => {
  const c = valueOf(parseClassification(CFG, LOCAL, 200, reply('jev-1.13.0', answers({ scope: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } }))))
  assert.equal(c.profile, 'jev')
  assert.equal(c.calibrated, false)
  assert.equal(c.taskQuestion, 'task_kind')
  assert.equal(c.taskKind, 'small_edit')
  assert.ok(near(c.pTask, 0.9), String(c.pTask))
  assert.deepEqual(c.p, { has_error_evidence: 0.02, risky_irreversible: 0.01, underspecified: 0.1, multi_deliverable: 0.05 })
  assert.deepEqual(c.levels, { scope: 3 })
  assert.deepEqual(Object.keys(c.choices), ['task_kind', 'explicit_depth'])
  assert.equal(c.choices.explicit_depth.option, 'none')
  assert.deepEqual(c.missing, [])
  // a tie between two levels goes to the higher one, with or without temperature
  for (const model of ['jev-1.13.0', 'rizzo-latest']) {
    const t = valueOf(parseClassification(CFG, LOCAL, 200, reply(model, answers({ scope: { 0: 0.1, 1: 0.2, 2: 0.35, 3: 0.35 } }))))
    assert.deepEqual(t.levels, { scope: 3 }, model)
  }
})

test('parseClassification: the option is the argmax of the probabilities, not the choice the backend claims', () => {
  const spread = (top: Record<string, number>): Record<string, number> => {
    const rest = (1 - Object.values(top).reduce((a, b) => a + b, 0)) / (TASK_OPTIONS.length - Object.keys(top).length)
    return Object.fromEntries(TASK_OPTIONS.map((k) => [k, Object.hasOwn(top, k) ? top[k] : rest]))
  }
  const a = answers()
  a.task_kind = { type: 'choice', choice: 'small_edit', probabilities: spread({ design: 0.55, small_edit: 0.35 }), confidence: 0.8 }
  a.explicit_depth = { type: 'choice', choice: 'quick', probabilities: { quick: 0.4, thorough: 0.05, none: 0.55 }, confidence: 0.8 }
  // no temperature on either: the jev profile has no choice block, and a server-calibrated answer is kept as it is
  const server = { x_rizzo: { probability_status: ['temperature_scaled_requires_held_out_validation'] } }
  for (const [model, extra] of [['jev-1.13.0', {}], ['rizzo-latest', server]] as const) {
    const c = valueOf(parseClassification(CFG, LOCAL, 200, reply(model, a, extra)))
    assert.equal(c.taskKind, 'design', model)
    assert.ok(near(c.pTask, 0.55), `${model} ${c.pTask}`)
    assert.deepEqual(c.choices.task_kind, { option: 'design', p: c.pTask }, model)
    assert.equal(c.choices.explicit_depth.option, 'none', model)
    assert.ok(near(c.choices.explicit_depth.p, 0.55), model)
    // the claimed small_edit and quick would have lowered an xhigh turn to low; design takes one step
    assert.match(chooseEffort(c, { model: OPUS, effort: 'xhigh' }, CFG).reason, /^design 0\.55: -1 → high$/, model)
  }
  // on an exact tie the claim stays
  for (const claim of ['design', 'small_edit']) {
    const t = answers()
    t.task_kind = { type: 'choice', choice: claim, probabilities: spread({ design: 0.45, small_edit: 0.45 }), confidence: 0.8 }
    assert.equal(valueOf(parseClassification(CFG, LOCAL, 200, reply('jev-1.13.0', t))).taskKind, claim)
  }
})

test('parseClassification: the profile the identity picks, and what t = 3 does to the task probability', () => {
  const a = answers({ top: 0.9 })
  const raw = (a.task_kind as { probabilities: Record<string, number> }).probabilities
  const flat = applyTemperature(raw, 3).small_edit
  const rizzo = valueOf(parseClassification(CFG, LOCAL, 200, reply('rizzo-latest', a)))
  assert.equal(rizzo.profile, 'rizzo-provisional')
  assert.ok(near(rizzo.pTask, flat), `${rizzo.pTask} ${flat}`)
  assert.equal(formatNumber(rizzo.pTask), '0.34')
  const spark = valueOf(parseClassification(CFG, LOCAL, 200, reply('rizzo-spark-x2.5-4b-bf16', a, { x_rizzo: { fingerprint: SPARK_FINGERPRINT } })))
  assert.equal(spark.profile, 'spark-bf16-2026-09')
  assert.ok(near(spark.pTask, flat))
  // server-side calibration: nothing more is done on the client
  const server = valueOf(parseClassification(CFG, LOCAL, 200, reply('rizzo-latest', a, {
    x_rizzo: { probability_status: ['temperature_scaled_requires_held_out_validation'] },
  })))
  assert.ok(near(server.pTask, 0.9))
  assert.equal(server.calibrated, false)
  // 0.8 raw on nine options is below min_top_probability once tempered: the turn stays as it is
  const low = valueOf(parseClassification(CFG, LOCAL, 200, reply('rizzo-latest', answers({ top: 0.8 }))))
  assert.ok(low.pTask < CFG.min_top_probability, String(low.pTask))
  assert.match(chooseEffort(low, { model: OPUS, effort: 'high' }, CFG).reason, /^uncertain classification \(small_edit 0\.28 < 0\.30\)$/)
})

test('parseClassification: a discarded or absent answer is missing, a missing task kind is an error', () => {
  const a = answers({ nouls: { underspecified: { type: 'noul', noul: 1.5 } } })
  delete a.scope
  const c = valueOf(parseClassification(CFG, LOCAL, 200, reply('jev-1', a)))
  assert.deepEqual(c.missing, ['scope', 'underspecified'])
  assert.equal('scope' in c.levels, false)
  assert.equal('underspecified' in c.p, false)
  const noTask = answers()
  delete noTask.task_kind
  const e = ko(parseClassification(CFG, LOCAL, 200, reply('jev-1', noTask)))
  assert.equal(e.kind, 'response')
  assert.equal(e.message, 'the backend did not answer the task-kind question (task_kind)')
  const wrongType = answers({ nouls: { task_kind: { type: 'noul', noul: 0.9 } } })
  assert.equal(ko(parseClassification(CFG, LOCAL, 200, reply('jev-1', wrongType))).message, 'the backend did not answer the task-kind question (task_kind)')
})

test('parseClassification: HTTP errors and unreadable answers, never with the key or the backend text', () => {
  const echo = JSON.stringify({ detail: `key ${KEY} refused, ${phrasesForClaude(1)[0]}` })
  const cases: [number, string, string, RegExp][] = [
    [401, echo, 'auth', /^key rejected by the backend \(HTTP 401\)$/],
    [422, JSON.stringify({ detail: 'Question task_kind: 9000 tokens exceeds the context limit 8192 (--ctx); no truncation' }), 'overflow', /^question task_kind exceeds the backend context: 9000 tokens, limit 8192/],
    [500, echo, 'server', /^backend error \(HTTP 500\)$/],
    [503, echo, 'overloaded', /^backend overloaded \(HTTP 503\)$/],
    [200, `not json ${KEY}`, 'response', /^unreadable backend response: invalid JSON$/],
    [200, JSON.stringify({ model: KEY, answers: {} }), 'response', /^no valid answer among the 7 expected/],
  ]
  for (const [status, text, kind, message] of cases) {
    const e = ko(parseClassification(CFG, REMOTE, status, text))
    assert.equal(e.kind, kind, `${status}`)
    assert.match(e.message, message, `${status}`)
    assert.equal(e.message.includes(KEY), false, `${status}`)
    assert.doesNotMatch(e.message, RE_MARKER)
  }
  assert.match(ko(parseClassification(CFG, LOCAL, 401, '')).message, /none is configured/)
})

// ─── The effort ───────────────────────────────────────────────────────────────

const OPUS = 'claude-opus-5-5'

// A classification as parseClassification builds it from the shipped questions.
function cls(task: string, o: {
  p?: number; scope?: number; nouls?: Record<string, number>; depth?: [string, number]; missing?: string[]
} = {}): Classification {
  const pTask = o.p ?? 0.9
  const p: Record<string, number> = { has_error_evidence: 0.02, risky_irreversible: 0.01, underspecified: 0.1, multi_deliverable: 0.05, ...o.nouls }
  const levels: Record<string, number> = { scope: o.scope ?? 1 }
  const [option, pDepth] = o.depth ?? ['none', 0.9]
  const choices: Classification['choices'] = { task_kind: { option: task, p: pTask }, explicit_depth: { option, p: pDepth } }
  const missing = [...(o.missing ?? [])].sort()
  for (const id of missing) {
    delete p[id]
    delete levels[id]
    delete choices[id]
  }
  return { taskQuestion: 'task_kind', taskKind: task, pTask, p, levels, choices, missing, profile: 'test', calibrated: false }
}

test('effort arithmetic: steps clamped to the scale, max and min', () => {
  const steps: [Effort, number, Effort][] = [
    ['high', -2, 'low'], ['high', -3, 'low'], ['high', 0, 'high'], ['high', 1, 'xhigh'], ['max', 1, 'max'], ['low', -1, 'low'],
    ['medium', 4, 'max'], ['xhigh', -4, 'low'], ['high', 1.9, 'xhigh'], ['high', Number.NaN, 'high'],
  ]
  for (const [e, n, expected] of steps) assert.equal(shiftEffort(e, n), expected, `${e} ${n}`)
  assert.equal(maxEffort('low', 'high'), 'high')
  assert.equal(maxEffort('max', 'xhigh'), 'max')
  assert.equal(minEffort('low', 'high'), 'low')
  assert.equal(minEffort('max', 'xhigh'), 'xhigh')
  assert.equal(minEffort('medium', 'medium'), 'medium')
})

test('modelAllowed: a case-insensitive substring of only_models', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'CLAUDE-FABLE-5-1', 'fable-5-1-20260901', 'claude-sonnet-5-5']) assert.equal(modelAllowed(CFG, m), true, m)
  for (const m of ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5-1', 'claude-opus-4-5', '', undefined as never]) assert.equal(modelAllowed(CFG, m), false, String(m))
})

type Row = [string, Classification | null, RouterContext, Partial<RouterConfig>, Effort | undefined, RegExp]

// Session effort high unless the row says otherwise; the shipped config caps at the
// session's effort, so every row except respect_session_effort false only lowers.
const rows: Row[] = [
  // every task kind, relative steps from a high session
  ['question', cls('question'), { model: OPUS, effort: 'high' }, {}, 'low', /^question 0\.90: -2 → low$/],
  ['small_edit', cls('small_edit', { p: 0.91 }), { model: OPUS, effort: 'high' }, {}, 'low', /^small_edit 0\.91: -2 → low$/],
  ['bug_with_error', cls('bug_with_error'), { model: OPUS, effort: 'high' }, {}, 'medium', /^bug_with_error 0\.90: -1 → medium$/],
  ['feature', cls('feature'), { model: OPUS, effort: 'high' }, {}, 'medium', /^feature 0\.90: -1 → medium$/],
  ['refactor', cls('refactor'), { model: OPUS, effort: 'high' }, {}, 'medium', /^refactor 0\.90: -1 → medium$/],
  ['design', cls('design'), { model: OPUS, effort: 'high' }, {}, 'medium', /^design 0\.90: -1 → medium$/],
  ['review', cls('review'), { model: OPUS, effort: 'high' }, {}, 'medium', /^review 0\.90: -1 → medium$/],
  ['ops', cls('ops'), { model: OPUS, effort: 'high' }, {}, 'low', /^ops 0\.90: -2 → low$/],
  ['continue without a previous turn', cls('continue'), { model: OPUS, effort: 'high' }, {}, undefined, /^unchanged \(continue 0\.90: previous → high\)$/],
  ['continue after a lowered turn', cls('continue'), { model: OPUS, effort: 'high', previous: 'low' }, {}, 'low', /^continue 0\.90: previous → low$/],
  // adjust, in file order
  ['scope 2 raises one step', cls('small_edit', { scope: 2 }), { model: OPUS, effort: 'high' }, {}, 'medium', /^small_edit 0\.90: -2 → low; scope 2: \+1 → medium$/],
  ['two raises reach the session', cls('small_edit', { scope: 3, nouls: { multi_deliverable: 0.7 } }), { model: OPUS, effort: 'high' }, {}, undefined, /^unchanged \(small_edit .*; scope 3: \+1 → medium; multi_deliverable 0\.70: \+1 → high\)$/],
  ['underspecified: at least medium', cls('question', { nouls: { underspecified: 0.6 } }), { model: OPUS, effort: 'high' }, {}, 'medium', /; underspecified 0\.60: at least medium → medium$/],
  ['error evidence: at least medium', cls('ops', { nouls: { has_error_evidence: 0.95 } }), { model: OPUS, effort: 'high' }, {}, 'medium', /; has_error_evidence 0\.95: at least medium → medium$/],
  ['a noul under its threshold', cls('ops', { nouls: { has_error_evidence: 0.59 } }), { model: OPUS, effort: 'high' }, {}, 'low', /^ops 0\.90: -2 → low$/],
  // explicit_depth replaces what came before
  ['quick replaces the base', cls('feature', { depth: ['quick', 0.6] }), { model: OPUS, effort: 'high' }, {}, 'low', /^feature 0\.90: -1 → medium; explicit_depth quick 0\.60: low → low$/],
  ['thorough goes back to the session', cls('small_edit', { scope: 2, depth: ['thorough', 0.5] }), { model: OPUS, effort: 'high' }, {}, undefined, /; explicit_depth thorough 0\.50: 0 → high\)$/],
  ['explicit depth too uncertain', cls('feature', { depth: ['quick', 0.39] }), { model: OPUS, effort: 'high' }, {}, 'medium', /^feature 0\.90: -1 → medium$/],
  // floors after explicit_depth
  ['quick and risky: the floor wins', cls('feature', { depth: ['quick', 0.6], nouls: { risky_irreversible: 0.73 } }), { model: OPUS, effort: 'xhigh' }, {}, 'high', /^feature 0\.90: -1 → high; explicit_depth quick 0\.60: low → low; floor risky_irreversible 0\.73 → high$/],
  // the cap: the session's effort
  ['the cap is the session', cls('bug_with_error', { nouls: { risky_irreversible: 0.9 } }), { model: OPUS, effort: 'medium' }, {}, undefined, /^unchanged \(bug_with_error 0\.90: -1 → low; floor risky_irreversible 0\.90 → high; cap medium\)$/],
  ['session xhigh and a bug with an error', cls('bug_with_error'), { model: OPUS, effort: 'xhigh' }, {}, 'high', /^bug_with_error 0\.90: -1 → high$/],
  ['session max and a question', cls('question'), { model: OPUS, effort: 'max' }, {}, 'high', /^question 0\.90: -2 → high$/],
  ['min_effort', cls('question'), { model: OPUS, effort: 'high' }, { min_effort: 'medium' }, 'medium', /^question 0\.90: -2 → low; min medium$/],
  ['the cap wins over min_effort', cls('question'), { model: OPUS, effort: 'low' }, { min_effort: 'medium' }, undefined, /; min medium; cap low\)$/],
  // the session's effort
  ['numeric effort', cls('question'), { model: OPUS, effort: 31999 }, {}, undefined, /^session effort is a token budget, not a level$/],
  ['absent effort, nothing assumed', cls('question'), { model: OPUS }, {}, undefined, /^session effort not declared$/],
  ['absent effort, high assumed', cls('question'), { model: OPUS }, { assume_session_effort: 'high' }, 'low', /^question 0\.90: -2 → low$/],
  ['an effort the scale does not know', cls('question'), { model: OPUS, effort: 'turbo' as never }, {}, undefined, /^session effort is not a known level$/],
  // the project's cap always applies
  ['project cap below the session', cls('bug_with_error'), { model: OPUS, effort: 'xhigh' }, { projectCap: 'medium' }, 'medium', /^bug_with_error 0\.90: -1 → high; cap medium$/],
  ['project cap without respect_session_effort', cls('design', { nouls: { risky_irreversible: 0.9 } }), { model: OPUS, effort: 'xhigh' }, { respect_session_effort: false, projectCap: 'low' }, 'low', /; cap low$/],
  // without respect_session_effort the cap is max_effort, and the router may raise
  ['respect off: raise up to max_effort', cls('bug_with_error', { nouls: { risky_irreversible: 0.9 } }), { model: OPUS, effort: 'medium' }, { respect_session_effort: false }, 'high', /^bug_with_error 0\.90: -1 → low; floor risky_irreversible 0\.90 → high$/],
  ['respect off: max_effort caps a max session', cls('bug_with_error'), { model: OPUS, effort: 'max' }, { respect_session_effort: false }, 'high', /; cap high$/],
  // what leaves the turn alone before any rule
  ['router off', cls('question'), { model: OPUS, effort: 'high' }, { enabled: false }, undefined, /^router off$/],
  ['no classification', null, { model: OPUS, effort: 'high' }, {}, undefined, /^no classification$/],
  ['a model outside only_models', cls('question'), { model: 'claude-sonnet-5', effort: 'high' }, {}, undefined, /^model claude-sonnet-5 not allowed: an effort change would clear the prompt cache$/],
  ['a Fable model', cls('question'), { model: 'claude-fable-5-1', effort: 'high' }, {}, 'low', /^question/],
  ['under min_top_probability', cls('question', { p: 0.29 }), { model: OPUS, effort: 'high' }, {}, undefined, /^uncertain classification \(question 0\.29 < 0\.30\)$/],
  ['at min_top_probability', cls('question', { p: 0.3 }), { model: OPUS, effort: 'high' }, {}, 'low', /^question 0\.30: -2 → low$/],
  ['the floor question missing', cls('question', { missing: ['risky_irreversible'] }), { model: OPUS, effort: 'high' }, {}, undefined, /^incomplete classification \(missing: risky_irreversible\)$/],
  ['adjust and explicit questions missing', cls('question', { missing: ['scope', 'explicit_depth'] }), { model: OPUS, effort: 'high' }, {}, undefined, /^incomplete classification \(missing: explicit_depth, scope\)$/],
  ['a task kind outside base', cls('unknown_kind'), { model: OPUS, effort: 'high' }, {}, undefined, /^unchanged \(task kind not in base\)$/],
]

for (const [name, c, ctx, mod, effort, reason] of rows) {
  test(`chooseEffort: ${name}`, () => {
    const s = chooseEffort(c, ctx, { ...CFG, ...mod })
    assert.equal(s.effort, effort, s.reason)
    assert.match(s.reason, reason)
    if (effort === undefined) assert.equal('effort' in s, false)
  })
}

test('chooseEffort: a long model name is cut, and the reason stays one line', () => {
  const s = chooseEffort(cls('question'), { model: `x\n${'m'.repeat(200)}`, effort: 'high' }, CFG)
  assert.match(s.reason, /^model x m+… not allowed: an effort change would clear the prompt cache$/)
  assert.equal(s.reason.slice('model '.length, s.reason.indexOf(' not allowed')).length, 80)
  assert.doesNotMatch(s.reason, /\n/)
})

// ─── Cache guard ──────────────────────────────────────────────────────────────

const G: CacheGuard = CFG.cache_guard as CacheGuard
const usage = (input: number, read: number, creation: number): StepUsage => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation })

function step(effort: SessionEffort | undefined, u: StepUsage | null, o: { messageCount?: number; model?: string } = {}): GuardStep {
  const s: GuardStep = { usage: u, messageCount: o.messageCount ?? 12, model: o.model ?? OPUS }
  if (effort !== undefined) s.effort = effort
  return s
}

// The last step of a turn at high, with a prefix of 20 000 tokens.
const PREV = step('high', usage(500, 15_000, 4_500), { messageCount: 10 })
const WARM = step('low', usage(1_000, 19_000, 2_000))
const COLD = step('low', usage(18_000, 0, 3_000))
const GAP = 30_000

test('cacheGuard: the default thresholds', () => {
  assert.deepEqual(G, { min_prefix_tokens: 8192, max_read_ratio: 0.5, max_gap_ms: 240_000, trips: 2 })
  assert.deepEqual(GUARD_START, { last: null, suspects: 0, tripped: false })
  assert.ok(Object.isFrozen(GUARD_START))
})

test('cacheGuard: after an effort change, a warm cache is a hit and a cold one a suspect', () => {
  const hit = cacheGuard(G, { last: PREV, suspects: 1, tripped: false }, WARM, GAP)
  assert.equal(hit.verdict, 'hit')
  assert.deepEqual(hit.state, { last: WARM, suspects: 0, tripped: false })
  assert.deepEqual([hit.read, hit.prefix], [19_000, 20_000])
  const suspect = cacheGuard(G, { last: PREV, suspects: 0, tripped: false }, COLD, GAP)
  assert.equal(suspect.verdict, 'suspect')
  assert.deepEqual(suspect.state, { last: COLD, suspects: 1, tripped: false })
  assert.deepEqual([suspect.read, suspect.prefix], [0, 20_000])
  // exactly at the ratio and at the gap: judged, and a hit
  const edge = step('low', usage(1_000, 10_000, 9_000))
  assert.equal(cacheGuard(G, { last: PREV, suspects: 0, tripped: false }, edge, G.max_gap_ms).verdict, 'hit')
})

test('cacheGuard: two suspects in a row trip it, and it stays tripped', () => {
  let s: GuardState = GUARD_START
  const verdicts: string[] = []
  const feed = (x: GuardStep, gap: number | null): void => {
    const out = cacheGuard(G, s, x, gap)
    s = out.state
    verdicts.push(out.verdict)
  }
  feed(PREV, null)
  feed(COLD, GAP)
  feed(step('high', usage(20_000, 100, 2_000)), GAP)
  assert.deepEqual(verdicts, ['none', 'suspect', 'tripped'])
  assert.equal(s.tripped, true)
  assert.equal(s.suspects, 2)
  feed(WARM, GAP)
  feed(COLD, GAP)
  assert.deepEqual(verdicts.slice(3), ['none', 'none'])
  assert.equal(s.tripped, true)
  assert.deepEqual(s.last, COLD)
  // a hit in between starts the count again
  let t: GuardState = { last: PREV, suspects: 0, tripped: false }
  for (const [x, v] of [[COLD, 'suspect'], [step('high', usage(1_000, 20_000, 500)), 'hit'], [step('low', usage(20_000, 0, 500)), 'suspect']] as const) {
    const out = cacheGuard(G, t, x, GAP)
    assert.equal(out.verdict, v)
    t = out.state
  }
  assert.equal(t.suspects, 1)
})

test('cacheGuard: the steps it does not judge leave the count as it is', () => {
  const primed: GuardState = { last: PREV, suspects: 1, tripped: false }
  const cases: [string, CacheGuard | null, GuardState, GuardStep, number | null][] = [
    ['no guard', null, primed, COLD, GAP],
    ['already tripped', G, { ...primed, tripped: true }, COLD, GAP],
    ['no previous step', G, { last: null, suspects: 1, tripped: false }, COLD, GAP],
    ['no usage on this step', G, primed, step('low', null), GAP],
    ['no usage on the previous step', G, { ...primed, last: step('high', null) }, COLD, GAP],
    ['same effort', G, primed, step('high', usage(18_000, 0, 3_000)), GAP],
    ['same absent effort', G, { ...primed, last: step(undefined, usage(500, 15_000, 4_500)) }, step(undefined, usage(18_000, 0, 3_000)), GAP],
    ['another model', G, primed, step('low', usage(18_000, 0, 3_000), { model: 'claude-fable-5-1' }), GAP],
    ['after a compaction', G, primed, step('low', usage(18_000, 0, 3_000), { messageCount: 3 }), GAP],
    ['gap unknown', G, primed, COLD, null],
    ['gap beyond the cache TTL', G, primed, COLD, G.max_gap_ms + 1],
    ['short prefix', G, { ...primed, last: step('high', usage(100, 4_000, 1_000)) }, COLD, GAP],
    ['usage that is not a number', G, primed, step('low', usage(18_000, Number.NaN, 3_000)), GAP],
  ]
  for (const [name, g, s, x, gap] of cases) {
    const before = JSON.stringify(s)
    const out = cacheGuard(g, s, x, gap)
    assert.equal(out.verdict, 'none', name)
    assert.equal(out.state.suspects, 1, name)
    assert.equal(out.state.tripped, s.tripped, name)
    assert.deepEqual(out.state.last, x, name)
    assert.equal(JSON.stringify(s), before, `${name}: the state passed in is not touched`)
  }
})

test('cacheGuard: the state keeps a copy of the step, not the engine object', () => {
  const u = { ...usage(1, 2, 3), output_tokens: 9, model: OPUS }
  const out = cacheGuard(G, GUARD_START, step('high', u), null)
  assert.deepEqual(out.state.last?.usage, usage(1, 2, 3))
  u.cache_read_input_tokens = 99
  assert.equal(out.state.last?.usage?.cache_read_input_tokens, 2)
})

// ─── Lines ────────────────────────────────────────────────────────────────────

test('statusLine: the task kind, its probability and the effort', () => {
  const c = cls('small_edit', { p: 0.91 })
  assert.equal(statusLine(c, { effort: 'low', reason: 'r' }, { model: OPUS, effort: 'high' }), 'jev router: small_edit 0.91 → low')
  const f = cls('feature', { p: 0.62 })
  assert.equal(statusLine(f, { reason: 'r' }, { model: OPUS, effort: 'xhigh' }), 'jev router: feature 0.62, effort unchanged (xhigh)')
  assert.equal(statusLine(f, { reason: 'r' }, { model: OPUS, effort: 31999 }), 'jev router: feature 0.62, effort unchanged')
  assert.equal(statusLine(f, { reason: 'r' }, { model: OPUS }), 'jev router: feature 0.62, effort unchanged')
})

test('routerLogLine: every answer in the config order, decimal points, milliseconds and profile', () => {
  const c = { ...cls('small_edit', { p: 0.905, scope: 2, depth: ['none', 0.8] }), profile: 'rizzo-provisional' }
  assert.equal(routerLogLine(c, 412.4),
    '[jev-hooks] router: small_edit 0.91, scope 2, has_error_evidence 0.02, risky_irreversible 0.01, underspecified 0.10, multi_deliverable 0.05, explicit_depth none 0.80 in 412 ms (profile rizzo-provisional)')
  const m = cls('question', { missing: ['scope', 'multi_deliverable'] })
  assert.match(routerLogLine(m, 1500), /, missing multi_deliverable scope in 1500 ms \(profile test\)$/)
  assert.doesNotMatch(routerLogLine(m, 1500), /\d,\d/)
})

test('decisionLine: from the session effort (or the default) to the new one, with the reason', () => {
  const ctx: RouterContext = { model: OPUS, effort: 'high' }
  assert.equal(decisionLine(ctx, { effort: 'low', reason: 'small_edit 0.91: -2 → low' }), '[jev-hooks] effort high → low: small_edit 0.91: -2 → low')
  assert.equal(decisionLine({ model: OPUS, effort: 'xhigh' }, { reason: 'unchanged (bug_with_error 0.88: 0 → xhigh)' }), '[jev-hooks] effort xhigh: unchanged (bug_with_error 0.88: 0 → xhigh)')
  assert.equal(decisionLine({ model: OPUS }, { effort: 'low', reason: 'r' }), '[jev-hooks] effort default → low: r')
  assert.equal(decisionLine({ model: OPUS, effort: 31999 }, { reason: 'session effort is a token budget, not a level' }), '[jev-hooks] effort 31999: session effort is a token budget, not a level')
  // with chooseEffort's own reasons
  const s = chooseEffort(cls('question', { p: 0.87 }), ctx, CFG)
  assert.equal(decisionLine(ctx, s), '[jev-hooks] effort high → low: question 0.87: -2 → low')
})

test('guardLine: integers, the number of trips and what to do', () => {
  const s = step('low', usage(18_000, 1234.4, 3_000))
  assert.equal(guardLine(s, 20_000, 2),
    '[jev-hooks] router off for this session: after an effort change the prompt cache served 1234 of 20000 tokens, 2 times in a row. The per-turn-control beta is probably not active (or was dropped until /clear or /compact); set effort_router to false if this repeats.')
  assert.match(guardLine(step('low', null), 9000, 3), /served 0 of 9000 tokens, 3 times in a row/)
})

// The line builders never receive the prompt (their signatures take a Classification,
// a choice, a context and a number): what could still carry it, or the key, is a
// backend that echoes them in every free-text place of an answer it gets accepted.
test('the lines carry no prompt text and no key, even from a backend that echoes them', () => {
  const rnd = generator(3)
  const secret = highEntropyValue(32, rnd)
  const text = `please ${secret} ${phrasesForClaude(1)[0]}`
  const r = prepareRequest(CFG, composer(text), REMOTE, NO_MASK, 1)
  if ('skip' in r) assert.fail(r.skip)
  // the raw prompt, not the redacted state: the worst a backend could have seen
  const echo = `${text} ${KEY}`
  const a = answers({ top: 0.99 })
  Object.assign(a.task_kind as object, { rationale: echo })
  a.explicit_depth = { type: 'choice', choice: echo, probabilities: { [echo]: 1 }, confidence: 1 }
  a[echo] = { type: 'noul', noul: 0.5 }
  const c = valueOf(parseClassification(CFG, REMOTE, 200, reply(`rizzo-${echo}`.slice(0, 200), a, { detail: echo, x_note: echo, x_rizzo: { fingerprint: echo, probability_status: [echo] } })))
  const ctx: RouterContext = { model: OPUS, effort: 'high' }
  const s = chooseEffort(c, ctx, CFG)
  for (const line of [statusLine(c, s, ctx), routerLogLine(c, 10), decisionLine(ctx, s), s.reason, JSON.stringify(c)]) {
    assert.equal(line.includes(secret), false, line)
    assert.equal(line.includes(KEY), false, line)
    assert.doesNotMatch(line, RE_MARKER)
    assert.doesNotMatch(line, /please/)
  }
})
