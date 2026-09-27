// Rule 4 put to the test. Claude Code's module loader runs register.ts and
// everything it imports in a node:vm context created by Object.create(null), with
// codeGeneration {strings: false, wasm: false}, only setTimeout and console added, some
// globals deleted and the intrinsics frozen. There a new URL() or a TextEncoder does not
// fail at load time: it gives a ReferenceError at the first call, inside a try/catch
// that hides it. purity.test.ts looks for the forbidden names in the source; this test
// really runs the pure functions in an identical context and fails at the first
// ReferenceError.
//
// The modules are loaded like this: types stripped with module.stripTypeScriptTypes,
// then every file becomes a function that receives the exports of the files it imports
// (imports resolved by hand, in dependency order), all compiled into a single script
// and run in the context. Every value passed to the functions is born inside the
// context.
//
// For now there are sha256Hex, validateBody, URL parsing and the other
// modules of the router graph that already exist: calibration, chunk state, redaction,
// masking and PRNG. The router's functions (effectiveConfig, backendRouter,
// prepareRequest, parseResponse, chooseEffort) are added when router.ts exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { stripSource } from '../helpers/source-code.ts'
import * as backendHost from '../../src/core/backend.ts'
import * as systemoneHost from '../../src/core/systemone.ts'
import * as calibrationHost from '../../src/core/calibration.ts'
import * as randomHost from '../../src/core/random.ts'
import { validateCalibration, validateChecks, validatePolicy } from '../../src/core/config.ts'
import * as maskHost from '../../src/core/mask.ts'
import * as redactionHost from '../../src/core/redaction.ts'
import * as stateHost from '../../src/core/state.ts'
import type { Calibration, Checks, WireQuestion, FileDiff, Identity, Policy, Answer } from '../../src/core/types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rel = (p: string): string => relative(root, p).split(sep).join('/')

// ─── Loader ───────────────────────────────────────────────────────────────────

interface Module { id: string; code: string; dependencies: string[] }
interface Change { by: number; a: number; text: string }

type Reader = (file: string) => string

const readFromDisk: Reader = (file) => readFileSync(file, 'utf8')

function names(fileList: string): [string, string][] {
  return fileList.split(',').map((s) => s.trim()).filter((s) => s !== '').map((s) => {
    const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s)
    if (!m) throw new Error(`unhandled specifier: ${s}`)
    return [m[1], m[2] ?? m[1]]
  })
}

// An ES module stripped of its types → a function body. Positions are looked up in the
// source emptied of comments, strings and regexes (stripSource), so an "import" inside
// a string does not count; the replacements are applied to the real source.
function transform(file: string, read: Reader): Module {
  const js = stripTypeScriptTypes(read(file))
  const blank = stripSource(js)
  const changes: Change[] = []
  const dependencies: string[] = []
  const exported: [string, string][] = []          // [exported name, expression]
  const all: string[] = []                         // export * from

  const specifier = (quote: number): { deps: string; end: number } => {
    const closed = blank.indexOf(blank[quote], quote + 1)
    const spec = js.slice(quote + 1, closed)
    if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`${rel(file)}: non-relative import "${spec}"`)
    const deps = resolve(dirname(file), spec)
    dependencies.push(deps)
    let end = closed + 1
    const pv = /^\s*;/.exec(blank.slice(end))
    if (pv) end += pv[0].length
    return { deps, end }
  }
  const ref = (deps: string): string => `__modules[${JSON.stringify(rel(deps))}]`

  for (const m of blank.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])/g)) {
    const { deps, end } = specifier((m.index ?? 0) + m[0].length - 1)
    const fields = names(m[1]).map(([a, b]) => (a === b ? a : `${a}: ${b}`))
    changes.push({ by: m.index ?? 0, a: end, text: fields.length === 0 ? '' : `const { ${fields.join(', ')} } = ${ref(deps)};` })
  }
  for (const m of blank.matchAll(/\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])/g)) {
    const { deps, end } = specifier((m.index ?? 0) + m[0].length - 1)
    changes.push({ by: m.index ?? 0, a: end, text: `const ${m[1]} = ${ref(deps)};` })
  }
  for (const m of blank.matchAll(/\bimport\s*(['"])/g)) {
    const { end } = specifier((m.index ?? 0) + m[0].length - 1)
    changes.push({ by: m.index ?? 0, a: end, text: '' })
  }
  for (const m of blank.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*(['"])/g)) {
    const { deps, end } = specifier((m.index ?? 0) + m[0].length - 1)
    for (const [a, b] of names(m[1])) exported.push([b, `${ref(deps)}.${a}`])
    changes.push({ by: m.index ?? 0, a: end, text: '' })
  }
  for (const m of blank.matchAll(/\bexport\s*\*\s*from\s*(['"])/g)) {
    const { deps, end } = specifier((m.index ?? 0) + m[0].length - 1)
    all.push(ref(deps))
    changes.push({ by: m.index ?? 0, a: end, text: '' })
  }
  for (const m of blank.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)\s*;?/g)) {
    for (const [a, b] of names(m[1])) exported.push([b, a])
    changes.push({ by: m.index ?? 0, a: (m.index ?? 0) + m[0].length, text: '' })
  }
  for (const m of blank.matchAll(/\bexport(\s+)(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s*([\w$]+)/g)) {
    exported.push([m[2], m[2]])
    changes.push({ by: m.index ?? 0, a: (m.index ?? 0) + 'export'.length, text: '' })
  }

  changes.sort((x, y) => x.by - y.by)
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].by < changes[i - 1].a) throw new Error(`${rel(file)}: overlapping import or export`)
  }
  let code = js
  for (const md of [...changes].reverse()) code = code.slice(0, md.by) + md.text + code.slice(md.a)
  // what is left (export default, import.meta, import()) does not exist in the loader: better to stop
  const rest = stripSource(code)
  const leftover = /\b(export|import)\b/.exec(rest)
  if (leftover) throw new Error(`${rel(file)}: unhandled ${leftover[1]} form near "${code.slice(leftover.index, leftover.index + 40)}"`)

  const obj = `{ ${exported.map(([n, e]) => `${JSON.stringify(n)}: ${e}`).join(', ')} }`
  const returned = all.length === 0 ? obj : `Object.assign({}, ${all.join(', ')}, ${obj})`
  return { id: rel(file), code: `(function () {\n"use strict";\n${code}\nreturn ${returned};\n})()`, dependencies: dependencies.map(rel) }
}

// Modules reachable from the entries, each after its dependencies.
function graph(entries: string[], read: Reader): Module[] {
  const seen = new Map<string, Module>()
  const order: Module[] = []
  const inProgress = new Set<string>()
  const visit = (file: string): void => {
    const id = rel(file)
    if (seen.has(id)) return
    if (inProgress.has(id)) throw new Error(`circular dependency: ${id}`)
    inProgress.add(id)
    const m = transform(file, read)
    for (const d of m.dependencies) visit(join(root, d))
    inProgress.delete(id)
    seen.set(id, m)
    order.push(m)
  }
  for (const e of entries) visit(e)
  return order
}

// The context of Claude Code's loader: a null global, no code generation from
// strings, setTimeout and console as the only additions, globals deleted and intrinsics
// frozen.
function emptyContext(): vm.Context {
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(`
    for (const n of ['WeakRef', 'FinalizationRegistry', 'Atomics', 'SharedArrayBuffer', 'WebAssembly', 'queueMicrotask']) delete globalThis[n];
    for (const n of Object.getOwnPropertyNames(globalThis)) {
      const v = globalThis[n];
      if (v === globalThis) continue;
      if (typeof v === 'function' && v.prototype) Object.freeze(v.prototype);
      if (v !== null && (typeof v === 'object' || typeof v === 'function')) Object.freeze(v);
    }
  `, ctx)
  ctx.setTimeout = setTimeout
  ctx.clearTimeout = clearTimeout
  ctx.console = console
  return ctx
}

type Functions = Record<string, (...a: unknown[]) => unknown>

function load(entries: string[], read: Reader = readFromDisk): { ctx: vm.Context; modules: Record<string, Functions>; order: string[] } {
  const modules = graph(entries, read)
  const ctx = emptyContext()
  const script = `var __modules = Object.create(null);\n${modules.map((m) => `__modules[${JSON.stringify(m.id)}] = ${m.code};`).join('\n')}\n__modules;`
  const registry = vm.runInContext(script, ctx, { filename: 'plugin-modules.js' }) as Record<string, Functions>
  return { ctx, modules: registry, order: modules.map((m) => m.id) }
}

// A value built inside the context, as the router would build it.
const inside = (ctx: vm.Context, v: unknown): unknown => vm.runInContext(`(${JSON.stringify(v)})`, ctx)
// A result of the context brought back into Node's realm, to compare it.
const outside = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

const CORE = join(root, 'src', 'core')
const loaded = load([join(CORE, 'sha256.ts'), join(CORE, 'backend.ts'), join(CORE, 'systemone.ts')])
const vmSha = loaded.modules['src/core/sha256.ts']
const vmBackend = loaded.modules['src/core/backend.ts']
const vmSystemone = loaded.modules['src/core/systemone.ts']

// ─── The loader itself ────────────────────────────────────────────────────────

test('the context is really empty and the loader notices', () => {
  const ctx = emptyContext()
  for (const name of ['URL', 'TextEncoder', 'TextDecoder', 'fetch', 'process', 'Buffer', 'queueMicrotask', 'structuredClone', 'atob', 'AbortController', 'performance', 'WeakRef', 'WebAssembly']) {
    assert.equal(vm.runInContext(`typeof ${name}`, ctx), 'undefined', name)
  }
  // counter-test: a module that uses a name missing from the context blows up, and new Function is forbidden
  const virtual: Record<string, string> = {
    [join(CORE, '__test_url.ts')]: "export function host(s: string): string { return new URL(s).host }",
    [join(CORE, '__test_text.ts')]: "import { host } from './__test_url.ts'\nexport const byte = (s: string): number => new TextEncoder().encode(s).length\nexport { host }",
    [join(CORE, '__test_eval.ts')]: "export function f(): number { return new Function('return 1')() }",
  }
  const read: Reader = (f) => virtual[f] ?? readFileSync(f, 'utf8')
  const p = load([join(CORE, '__test_text.ts'), join(CORE, '__test_eval.ts')], read)
  assert.throws(() => p.modules['src/core/__test_url.ts'].host('http://x'), (e: Error) => e.name === 'ReferenceError' && /URL/.test(e.message))
  assert.throws(() => p.modules['src/core/__test_text.ts'].byte('x'), (e: Error) => e.name === 'ReferenceError' && /TextEncoder/.test(e.message))
  assert.throws(() => p.modules['src/core/__test_text.ts'].host('http://x'), (e: Error) => e.name === 'ReferenceError')
  assert.throws(() => p.modules['src/core/__test_eval.ts'].f(), (e: Error) => e.name === 'EvalError')
})

test('the graph of sha256, backend and systemone stays in src/core and loads without errors', () => {
  for (const id of ['src/core/types.ts', 'src/core/utf8.ts', 'src/core/sha256.ts', 'src/core/canonical.ts', 'src/core/json.ts', 'src/core/config.ts', 'src/core/backend.ts', 'src/core/systemone.ts']) {
    assert.ok(loaded.order.includes(id), id)
  }
  for (const id of loaded.order) assert.match(id, /^src\/core\/[\w-]+\.ts$/)
  // every file after its dependencies
  assert.ok(loaded.order.indexOf('src/core/utf8.ts') < loaded.order.indexOf('src/core/sha256.ts'))
  assert.ok(loaded.order.indexOf('src/core/config.ts') < loaded.order.indexOf('src/core/systemone.ts'))
  assert.deepEqual(outside(vmSystemone.LIMITS), outside(systemoneHost.LIMITS))
})

// ─── The pure functions in the empty context ──────────────────────────────────

test('sha256Hex in the vm context matches node:crypto', () => {
  const cases = ['', 'abc', 'é€😀', 'a\ud800b', 'diff --git a/x b/x\n+line\n'.repeat(500), '{"criteria":{"false":"No","true":"Yes ✓"},"instructions":"x","type":"noul"}']
  for (const s of cases) {
    assert.equal(vmSha.sha256Hex(s), createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'), JSON.stringify(s.slice(0, 40)))
  }
  const w = { type: 'noul', instructions: 'Is it so?', criteria: { true: 'Yes.', false: 'No.' } }
  assert.equal(vmSystemone.questionHash(inside(loaded.ctx, w)), systemoneHost.questionHash(w as WireQuestion))
})

function realQuestions(): Record<string, WireQuestion> {
  const e = validateChecks(JSON.parse(readFileSync(join(root, 'config', 'checks.json'), 'utf8')), 'checks.json')
  if (!e.ok) assert.fail(e.error.message)
  const out: Record<string, WireQuestion> = {}
  for (const id of e.value.order) if (e.value.defs[id].source === 'model') out[id] = systemoneHost.wireQuestion(e.value.defs[id])
  return out
}

test('validateBody in the vm context gives the same problems as in Node', () => {
  const questions = realQuestions()
  const bodies: unknown[] = [
    { state: '[diff]\n+x\n', model: 'jev-latest', questions: questions },
    { state: 'a'.repeat(256_000), model: 'jev-latest', questions: questions },
    { state: '  ', model: '', questions: {} },
    { state: 'é😀\ud800', model: 'jev-latest', questions: { a: { type: 'noul', instructions: null }, b: { type: 'choice', instructions: 'x', criteria: { a: 'y', ' ': null } } } },
    { state: 'x', model: 'jev-latest', questions: { s: { type: 'score', instructions: 'x', criteria: ['a', 'a', ''] , label: 'no' }, t: { type: 'noul', instructions: { k: ['v'] }, criteria: { true: 'y'.repeat(7996) } } } },
  ]
  for (const c of bodies) {
    const inVm = outside(vmSystemone.validateBody(inside(loaded.ctx, c)))
    assert.deepEqual(inVm, outside(systemoneHost.validateBody(c as never)))
  }
  assert.deepEqual(outside(vmSystemone.validateBody(inside(loaded.ctx, bodies[0]))), [])
})

test('parseUrl, normalizeUrl, isLocalHost and resolveBackend in the vm context as in Node', () => {
  const url = [
    'http://192.168.1.50:8017', 'https://api.typesafe.ai/v1/systemone/', 'http://[::1]:8017/v1', 'http://[::ffff:10.0.0.1]',
    'HTTP://Rizzo.Local:8017/', 'http://user:x@host', 'http://host/?q', 'http://010.0.0.1', 'ftp://x', 'http://hòst', '',
  ]
  for (const u of url) {
    assert.deepEqual(outside(vmBackend.parseUrl(u)), outside(backendHost.parseUrl(u)), u)
    assert.deepEqual(outside(vmBackend.normalizeUrl(u)), outside(backendHost.normalizeUrl(u)), u)
  }
  for (const h of ['127.0.0.1', '100.64.0.1', '8.8.8.8', '::1', '[::ffff:192.168.1.1]', 'spark.tail1234.ts.net', 'evil.com', 'localhost']) {
    assert.equal(vmBackend.isLocalHost(h), backendHost.isLocalHost(h), h)
  }
  assert.equal(vmBackend.sameOrigin('http://a:1/x', 'http://A:1/y'), true)
  const sources = [
    { layers: [{ name: 'userConfig', url: 'http://192.168.1.50:8017', key: '' }], typesafe: { key: 'fake-key' } },
    { layers: [], typesafe: { key: 'fake-key' } },
    { explicitUrl: 'http://127.0.0.1:8765', layers: [{ name: 'JEV_HOOKS_*', url: 'http://127.0.0.1:8765/v1', key: 'fake-key' }] },
    { layers: [{ name: 'userConfig', url: 'http://8.8.8.8' }] },
    { layers: [] },
  ]
  for (const f of sources) assert.deepEqual(outside(vmBackend.resolveBackend(inside(loaded.ctx, f))), outside(backendHost.resolveBackend(f as never)))
  const b = { url: 'http://127.0.0.1:1/v1/systemone', key: 'fake-key', model: 'jev-latest', local: true, host: '127.0.0.1:1' }
  assert.deepEqual(outside(vmBackend.requestHeaders(inside(loaded.ctx, b))), backendHost.requestHeaders(b))
  assert.equal(vmBackend.sanitize('x fake-key \u001b[1m y', 'fake-key'), backendHost.sanitize('x fake-key \u001b[1m y', 'fake-key'))
})

test('classifyStatus and parseResponse in the vm context as in Node', () => {
  const states: [number, string][] = [
    [401, '{"detail":"Missing or invalid API key"}'],
    [422, '{"detail":"Question hardcoded_secret: 8385 tokens exceeds the context limit 8192 (--ctx); no truncation"}'],
    [422, '{"detail":[{"type":"extra_forbidden","loc":["body","questions","a","noul","label"],"msg":"Extra inputs are not permitted","input":"x"}]}'],
    [504, 'Gateway Timeout'],
  ]
  for (const [s, t] of states) assert.deepEqual(outside(vmSystemone.classifyStatus(s, t, 'k')), outside(systemoneHost.classifyStatus(s, t, 'k')))
  const expected = { a: { type: 'noul', instructions: 'x' }, c: { type: 'choice', instructions: 'x', criteria: { p: null, q: null } } }
  const texts = [
    '{"model":"m","answers":{"a":{"type":"noul","noul":NaN},"c":{"type":"choice","choice":"p","probabilities":{"p":0.6,"q":0.39},"confidence":0.2}},"x_rizzo":{"fingerprint":"f"}}',
    'not json',
  ]
  for (const t of texts) {
    assert.deepEqual(outside(vmSystemone.parseResponse(t, inside(loaded.ctx, expected))), outside(systemoneHost.parseResponse(t, expected as never)))
  }
})

// ─── The other modules of the router graph ────────────────────────────────────

const routerGraph = load([
  join(CORE, 'config.ts'), join(CORE, 'calibration.ts'), join(CORE, 'state.ts'), join(CORE, 'redaction.ts'),
  join(CORE, 'mask.ts'), join(CORE, 'random.ts'),
])
const vmR = (name: string): Functions => routerGraph.modules[`src/core/${name}.ts`]
const jsonOf = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

// The configuration is validated inside the context: the RegExps must be born there,
// like those the router will build from the generated defaults.
function vmConfig(): { checks: unknown; policy: unknown; calibration: unknown } {
  const ok = (e: unknown): unknown => {
    const x = e as { ok: boolean; value?: unknown; error?: { message: string } }
    if (!x.ok) assert.fail(x.error?.message)
    return x.value
  }
  const checks = ok(vmR('config').validateChecks(inside(routerGraph.ctx, jsonOf('config/checks.json')), 'checks.json'))
  const policy = ok(vmR('config').validatePolicy(inside(routerGraph.ctx, jsonOf('config/policy.json')), checks, 'policy.json'))
  const calibration = ok(vmR('config').validateCalibration(inside(routerGraph.ctx, jsonOf('config/calibration.json')), 'calibration.json'))
  return { checks, policy, calibration }
}

function hostConfig(): { checks: Checks; policy: Policy; calibration: Calibration } {
  const c = validateChecks(jsonOf('config/checks.json'), 'checks.json')
  if (!c.ok) assert.fail(c.error.message)
  const p = validatePolicy(jsonOf('config/policy.json'), c.value, 'policy.json')
  if (!p.ok) assert.fail(p.error.message)
  const k = validateCalibration(jsonOf('config/calibration.json'), 'calibration.json')
  if (!k.ok) assert.fail(k.error.message)
  return { checks: c.value, policy: p.value, calibration: k.value }
}

test('the graph of calibration, state, redaction, mask and random stays among the modules the router may import', () => {
  // the router imports only these files (no diff.ts, chunks.ts, review.ts)
  const allowed = new Set(['router', 'backend', 'systemone', 'calibration', 'state', 'redaction', 'mask', 'random', 'numbers',
    'json', 'config', 'utf8', 'sha256', 'canonical', 'types', 'defaults'].map((n) => `src/core/${n}.ts`))
  for (const id of routerGraph.order) assert.ok(allowed.has(id), `${id} is not among the modules the router may import`)
})

test('prng, mask and unmask in the vm context as in Node', () => {
  const a = vmR('random').prng(123456789) as () => number
  const b = randomHost.prng(123456789)
  for (let k = 0; k < 20; k++) assert.equal(a(), b())
  const tsv = 'qzrealproject\tplaceholderqz\nQzOtherName\tplaceholderqy\n'
  const inVm = outside(vmR('mask').parseMaskMap(tsv)) as { ok: boolean; value: { real: string; placeholder: string }[] }
  assert.deepEqual(inVm, outside(maskHost.parseMaskMap(tsv)))
  const text = 'cd qzrealproject && echo QZREALPROJECT qzothername xqzrealproject'
  const pairs = inside(routerGraph.ctx, inVm.value)
  const host = maskHost.parseMaskMap(tsv)
  if (!host.ok) assert.fail(host.error.message)
  const m = vmR('mask').mask(text, pairs) as string
  assert.equal(m, maskHost.mask(text, host.value))
  assert.equal(vmR('mask').unmask(m, pairs), maskHost.unmask(m, host.value))
  assert.deepEqual(outside(vmR('mask').parseMaskMap('only-one-field\n')), outside(maskHost.parseMaskMap('only-one-field\n')))
})

test('redact in the vm context gives the same redaction as in Node, with the same seed', () => {
  const cfg = vmConfig()
  const host = hostConfig()
  // an AWS key and a PEM block composed at runtime: no realistic secret in the source
  const key = ['AK', 'IA'].join('') + 'Q7W3E9R2T5Y8U1I4'
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  const diff = [
    'diff --git a/src/config.py b/src/config.py', '--- a/src/config.py', '+++ b/src/config.py', '@@ -1,2 +1,5 @@',
    ` AWS_ACCESS_KEY_ID = "${key}"`, `+OTHER = "${key}"`, `+${pem}`, '+QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', '+-----END PRIVATE KEY-----',
  ].join('\n')
  const inVm = outside(vmR('redaction').redact(diff, cfg.policy, vmR('random').prng(7))) as { text: string; redactions: number }
  const inNode = redactionHost.redact(diff, host.policy, randomHost.prng(7))
  assert.deepEqual(inVm, inNode)
  assert.ok(!inVm.text.includes(key))
  // the router, without a policy: every long and disorderly token
  assert.deepEqual(outside(vmR('redaction').redact(`use ${key}xYz9 now`, null, vmR('random').prng(3))), redactionHost.redact(`use ${key}xYz9 now`, null, randomHost.prng(3)))
})

test('chunkState, globalState, chooseProfile and calibrate in the vm context as in Node', () => {
  const file: FileDiff[] = [{
    path: 'src/a.py', status: 'M', header: 'diff --git a/src/a.py b/src/a.py', hunks: [{ header: '@@ -1 +1 @@', lines: ['-x', '+y'], newStart: 1 }],
    added: 1, removed: 1, addedLines: [{ number: 1, text: 'y' }],
  }]
  const chunk = { file, chunk: [1, 2] as [number, number], diff: 'diff --git a/src/a.py b/src/a.py\n@@ -1 +1 @@\n-x\n+y' }
  assert.equal(vmR('state').chunkState(inside(routerGraph.ctx, chunk)), stateHost.chunkState(chunk))
  const global = { title: 'Title\u2028on two lines', description: `Closes the tag ${'</' + 'EVIDENCE >'} here`, file, notShown: 0, diff: chunk.diff }
  assert.equal(vmR('state').globalState(inside(routerGraph.ctx, global)), stateHost.globalState(global))
  assert.equal(vmR('state').estimateTokens('abc é', 3), stateHost.estimateTokens('abc é', 3))

  const cfg = vmConfig()
  const host = hostConfig()
  const id: Identity = { host: '192.168.1.50:8017', model: 'rizzo-spark-x2.5-4b-bf16', fingerprint: 'fake-fp-1', family: 'rizzo', probabilityStatus: ['uncalibrated_conditional_option_scores'] }
  const band = { delta_logit: 0.62 }
  const sVm = vmR('calibration').chooseProfile(cfg.calibration, inside(routerGraph.ctx, id), inside(routerGraph.ctx, band))
  const sHost = calibrationHost.chooseProfile(host.calibration, id, band)
  assert.deepEqual(outside(sVm), outside(sHost))
  const w: WireQuestion = { type: 'noul', instructions: 'Is it so?', criteria: { true: 'Yes.', false: 'No.' } }
  const answers: Answer[] = [
    { type: 'noul', noul: 0.997 },
    { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
    { type: 'score', score: 1.8, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 }, confidence: 0.7 },
  ]
  const questions: WireQuestion[] = [w, { type: 'choice', instructions: 'x', criteria: { a: null, b: null } }, { type: 'score', instructions: 'x', criteria: ['low', 'medium', 'high'] }]
  answers.forEach((r, k) => {
    const inVm = vmR('calibration').calibrate('test', inside(routerGraph.ctx, questions[k]), inside(routerGraph.ctx, r), sVm)
    assert.deepEqual(outside(inVm), outside(calibrationHost.calibrate('test', questions[k], r, sHost)))
  })
})
