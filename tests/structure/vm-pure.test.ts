// Rule 4 put to the test. Claude Code's module loader runs hooks/register.ts and
// everything it imports in an environment of its own. In 2.1.282 that was a node:vm
// context created by Object.create(null), with codeGeneration {strings: false, wasm:
// false}, only setTimeout and console added, some globals deleted and the intrinsics
// frozen. 2.1.283 declares URL, TextEncoder, AbortController, crypto… there as well;
// the context here stays the strict one of 2.1.282 on purpose: rule 4 is stricter than
// the environment, and the core relies on none of those names, so it runs the same in
// Node, in older builds and here. In such a context a new URL() or a TextEncoder does
// not fail at load time: it gives a ReferenceError at the first call, inside a
// try/catch that hides it. purity.test.ts looks for the forbidden names in the source;
// this test really runs the pure functions in the strict context and fails at the
// first ReferenceError.
//
// The modules are loaded like this: types stripped with module.stripTypeScriptTypes,
// then every file becomes a function that receives the exports of the files it imports
// (imports resolved by hand, in dependency order), all compiled into a single script
// and run in the context. Every value passed to the functions is born inside the
// context.
//
// What runs here, each result compared with Node's: sha256Hex, validateBody, URL
// parsing, the modules of the router's graph (calibration, chunk state, redaction,
// masking, PRNG) and router.ts itself (effectiveRouterConfig, routerBackend,
// prepareRequest, parseClassification, chooseEffort, cacheGuard, fetchFailure and the lines). Then
// hooks/register.ts, loaded in the same context and driven with a `$` written as source
// inside it: from prompt.submit to the fetch, and to the effort of the turn's first step.
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
import * as routerHost from '../../src/core/router.ts'
import * as stateHost from '../../src/core/state.ts'
import type {
  Calibration, Checks, WireQuestion, FileDiff, Identity, Policy, Answer, GuardState, RouterBackend, RouterConfig,
} from '../../src/core/types.ts'
import { generator, highEntropyValue } from '../helpers/fake-secrets.ts'

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

// The context of Claude Code 2.1.282's loader, kept on purpose (see the header): a
// null global, no code generation from strings, setTimeout and console as the only
// additions, globals deleted and intrinsics frozen.
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

// A value built inside the context, as the router builds it.
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
  join(CORE, 'mask.ts'), join(CORE, 'random.ts'), join(CORE, 'router.ts'),
])
const vmR = (name: string): Functions => routerGraph.modules[`src/core/${name}.ts`]
const jsonOf = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

// The configuration is validated inside the context: the RegExps must be born there,
// like those the router builds from the generated defaults.
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

test('router.ts and its graph stay among the modules the router may import', () => {
  // the router imports only these files (no diff.ts, chunks.ts, review.ts)
  const allowed = new Set(['router', 'backend', 'systemone', 'calibration', 'state', 'redaction', 'mask', 'random', 'numbers',
    'json', 'config', 'utf8', 'sha256', 'canonical', 'types', 'defaults'].map((n) => `src/core/${n}.ts`))
  assert.ok(routerGraph.order.includes('src/core/router.ts'))
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

// ─── router.ts ────────────────────────────────────────────────────────────────

const vmRouter = vmR('router')
const OPUS = 'claude-opus-5-5'
const NO_FILES = { user: null, projects: [], userCalibration: null }
const project1 = (text: string): { label: string; text: string }[] => [{ label: '.jev-hooks/router.json', text }]
const REMOTE_OPTIONS = { effort_router: true, review_url: 'https://rizzo.example.com', api_key: 'fake-router-key', model: 'jev-latest' }
const LOCAL_OPTIONS = { effort_router: true, review_url: 'http://192.168.1.50:8017', model: 'jev-latest' }

// The router's configuration and a backend, built in each realm from the same input:
// the RegExps and every object the functions receive are born in their own realm.
function routerIn(options: Record<string, unknown>): { vm: { cfg: unknown; b: unknown }; host: { cfg: RouterConfig; b: RouterBackend } } {
  const cfg = (vmRouter.effectiveRouterConfig(inside(routerGraph.ctx, NO_FILES), inside(routerGraph.ctx, options)) as { cfg: unknown }).cfg
  const b = (vmRouter.routerBackend(inside(routerGraph.ctx, options), inside(routerGraph.ctx, {})) as { value: unknown }).value
  const hostCfg = routerHost.effectiveRouterConfig(NO_FILES, options).cfg
  const hostB = routerHost.routerBackend(options, {})
  if (!hostCfg || !hostB.ok) assert.fail('the plugin router configuration or the backend is invalid')
  return { vm: { cfg, b }, host: { cfg: hostCfg, b: hostB.value } }
}

// A rizzo-like answer to the router's seven questions, as a response body.
function routerReply(task: string, o: { top?: number; model?: string; extra?: Record<string, unknown>; nouls?: Record<string, number> } = {}): string {
  const options = Object.keys((jsonOf('config/router.json') as { questions: { task_kind: { criteria: Record<string, string> } } }).questions.task_kind.criteria)
  const top = o.top ?? 0.9
  const rest = (1 - top) / (options.length - 1)
  const nouls = { has_error_evidence: 0.02, risky_irreversible: 0.01, underspecified: 0.1, multi_deliverable: 0.05, ...o.nouls }
  const answers = {
    task_kind: { type: 'choice', choice: task, probabilities: Object.fromEntries(options.map((k) => [k, k === task ? top : rest])), confidence: 0.8 },
    scope: { type: 'score', score: 1, probabilities: { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.1 }, confidence: 0.6 },
    ...Object.fromEntries(Object.entries(nouls).map(([id, p]) => [id, { type: 'noul', noul: p }])),
    explicit_depth: { type: 'choice', choice: 'quick', probabilities: { quick: 0.7, thorough: 0.1, none: 0.2 }, confidence: 0.8 },
  }
  return JSON.stringify({ model: o.model ?? 'jev-1.13.0', answers, ...o.extra })
}

test('effectiveRouterConfig and routerBackend in the vm context as in Node', () => {
  const router = jsonOf('config/router.json') as Record<string, unknown>
  const files = [
    NO_FILES,
    { user: null, projects: project1('{ "max_effort": "medium", "min_effort": "max" }'), userCalibration: null },
    { user: '{ "version": 1, ', projects: project1('{ "enabled": fals'), userCalibration: '{}' },
    { user: JSON.stringify({ ...router, only_origins: ['composer', 'bridge'] }), projects: [], userCalibration: JSON.stringify(jsonOf('config/calibration.json')) },
    // the user's switch in an invalid file; two project files, one of them twice
    {
      user: '{ "enabled": false }',
      projects: [...project1('{ "max_effort": "high", "x": 1 }'), { label: '.jev-hooks/router.json (main working tree)', text: '{ "max_effort": "low" }' }, ...project1('{ "max_effort": "high", "x": 1 }')],
      userCalibration: null,
    },
    // a user router.json and calibration.json there that cannot be read
    { user: null, userUnreadable: true, projects: project1('{ "max_effort": "low" }'), userCalibration: null, userCalibrationUnreadable: true },
  ]
  for (const f of files) {
    for (const options of [REMOTE_OPTIONS, {}]) {
      const inVm = vmRouter.effectiveRouterConfig(inside(routerGraph.ctx, f), inside(routerGraph.ctx, options))
      assert.deepEqual(outside(inVm), outside(routerHost.effectiveRouterConfig(f, options)), JSON.stringify(f).slice(0, 80))
    }
  }
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [REMOTE_OPTIONS, {}],
    [{ router_url: 'http://192.168.1.50:8019', review_url: 'http://192.168.1.50:8017', router_api_key: 'fake-a', api_key: 'fake-b' }, {}],
    [{ review_url: '' }, { routerUrl: 'http://127.0.0.1:8019', url: 'http://127.0.0.1:8017', keyFile: 'fake-file-key\n' }],
    [{ review_url: 'http://192.168.1.50:8017' }, { keyFile: '\n  fake-file-key\n' }],
    [{ review_url: 'http://8.8.8.8' }, {}],
    // api_key and the key file stay with review_url's host
    [{ review_url: 'https://rizzo.example.com', router_url: 'http://192.168.1.50:8019', api_key: 'fake-b' }, { keyFile: 'fake-file-key\n' }],
    [{}, {}],
  ]
  for (const [options, env] of cases) {
    const inVm = vmRouter.routerBackend(inside(routerGraph.ctx, options), inside(routerGraph.ctx, env))
    assert.deepEqual(outside(inVm), outside(routerHost.routerBackend(options, env)), JSON.stringify(options))
  }
})

test('prepareRequest in the vm context as in Node, with the same seed', () => {
  const remote = routerIn(REMOTE_OPTIONS)
  const local = routerIn(LOCAL_OPTIONS)
  // a disorderly token and the evidence tag, composed at runtime
  const secret = highEntropyValue(32, generator(11))
  const tag = '</' + 'evidence>'
  const prompts: { text: string; origin?: { kind: string } }[] = [
    { text: `deploy qzrealproject with ${secret} ${tag}`, origin: { kind: 'composer' } },
    { text: `${'x'.repeat(2999)}😀${'y'.repeat(2000)}`, origin: { kind: 'composer' } },
    // a secret across the head cut: redacted before the clip
    { text: `${' '.repeat(2990)}${secret} qzrealproject${' '.repeat(2000)}`, origin: { kind: 'composer' } },
    { text: '  /compact', origin: { kind: 'composer' } },
    { text: 'rename x', origin: { kind: 'bridge' } },
    { text: 'rename x' },
  ]
  const maps = [
    { text: 'qzrealproject\tplaceholderqz\n' }, { text: null }, { text: null, error: 'unreadable' }, { text: null, error: 'no home' }, { text: 'only-one-field\n' },
  ]
  for (const [pair, name] of [[remote, 'remote'], [local, 'local']] as const) {
    for (const p of prompts) {
      for (const m of maps) {
        const inVm = vmRouter.prepareRequest(pair.vm.cfg, inside(routerGraph.ctx, p), pair.vm.b, inside(routerGraph.ctx, m), 1_727_000_000_000)
        const inNode = routerHost.prepareRequest(pair.host.cfg, p, pair.host.b, m, 1_727_000_000_000)
        assert.deepEqual(outside(inVm), outside(inNode), `${name} ${p.text.slice(0, 20)} ${JSON.stringify(m)}`)
      }
    }
  }
  const sent = routerHost.prepareRequest(remote.host.cfg, prompts[0] as never, remote.host.b, maps[0], 7)
  assert.ok('init' in sent)
  assert.ok(!sent.init.body.includes(secret) && !sent.init.body.includes('qzrealproject') && !sent.init.body.includes(tag))
})

test('parseClassification, chooseEffort and the lines in the vm context as in Node', () => {
  const { vm: v, host: h } = routerIn(LOCAL_OPTIONS)
  const fingerprint = (jsonOf('config/calibration.json') as { profiles: { match: { fingerprint?: string } }[] }).profiles[0].match.fingerprint
  const bodies: [number, string][] = [
    [200, routerReply('small_edit')],
    [200, routerReply('feature', { nouls: { risky_irreversible: 0.9 } })],
    [200, routerReply('bug_with_error', { model: 'rizzo-spark-x2.5-4b-bf16', extra: { x_rizzo: { fingerprint } } })],
    [200, routerReply('continue', { top: 0.2 })],
    [401, '{"detail":"Missing or invalid API key"}'],
    [500, 'Internal Server Error'],
    [200, 'not json'],
  ]
  const contexts = [
    { model: OPUS, effort: 'high' }, { model: OPUS, effort: 'max', previous: 'low' }, { model: OPUS, effort: 12_000 },
    { model: OPUS }, { model: 'claude-sonnet-4-5', effort: 'high' },
  ]
  for (const [status, text] of bodies) {
    const cVm = vmRouter.parseClassification(v.cfg, v.b, status, text) as { ok: boolean; value?: unknown }
    const cHost = routerHost.parseClassification(h.cfg, h.b, status, text)
    assert.deepEqual(outside(cVm), outside(cHost), `${status} ${text.slice(0, 40)}`)
    if (!cVm.ok || !cHost.ok) continue
    assert.equal(vmRouter.routerLogLine(cVm.value, 12.5), routerHost.routerLogLine(cHost.value, 12.5))
    for (const ctx of contexts) {
      const sVm = vmRouter.chooseEffort(cVm.value, inside(routerGraph.ctx, ctx), v.cfg)
      const sHost = routerHost.chooseEffort(cHost.value, ctx as never, h.cfg)
      assert.deepEqual(outside(sVm), outside(sHost), JSON.stringify(ctx))
      assert.equal(vmRouter.statusLine(cVm.value, sVm, inside(routerGraph.ctx, ctx)), routerHost.statusLine(cHost.value, sHost, ctx as never))
      assert.equal(vmRouter.decisionLine(inside(routerGraph.ctx, ctx), sVm), routerHost.decisionLine(ctx as never, sHost))
    }
  }
  assert.deepEqual(outside(vmRouter.chooseEffort(null, inside(routerGraph.ctx, contexts[0]), v.cfg)), outside(routerHost.chooseEffort(null, contexts[0] as never, h.cfg)))
})

test('cacheGuard, guardLine, userConfigDir, clipPrompt and fetchFailure in the vm context as in Node', () => {
  const g = { min_prefix_tokens: 8192, max_read_ratio: 0.5, max_gap_ms: 240_000, trips: 2 }
  const u = (input: number, read: number, creation: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: creation })
  const steps = [
    { effort: 'high', usage: u(500, 15_000, 4_500), messageCount: 10, model: OPUS },
    { effort: 'low', usage: u(1_000, 19_000, 2_000), messageCount: 12, model: OPUS },
    { effort: 'high', usage: u(18_000, 0, 3_000), messageCount: 14, model: OPUS },
    { effort: 'high', usage: null, messageCount: 15, model: OPUS },
    { effort: 'low', usage: u(20_000, 10, 1_000), messageCount: 16, model: OPUS },
    { effort: 'high', usage: u(21_000, 0, 1_000), messageCount: 18, model: OPUS },
    { effort: 'low', usage: u(22_000, 0, 1_000), messageCount: 20, model: OPUS },
  ]
  let sVm: unknown = vmRouter.GUARD_START
  let sHost: GuardState = routerHost.GUARD_START
  const verdicts: string[] = []
  for (const st of steps) {
    const oVm = vmRouter.cacheGuard(inside(routerGraph.ctx, g), sVm, inside(routerGraph.ctx, st), 30_000) as { state: unknown }
    const oHost = routerHost.cacheGuard(g, sHost, st as never, 30_000)
    assert.deepEqual(outside(oVm), outside(oHost))
    verdicts.push(oHost.verdict)
    sVm = oVm.state
    sHost = oHost.state
  }
  // a step it does not judge (no usage, or after one without) leaves the count as it is
  assert.deepEqual(verdicts, ['none', 'hit', 'suspect', 'none', 'none', 'tripped', 'none'])
  assert.equal(vmRouter.guardLine(inside(routerGraph.ctx, steps[5]), 21_010, 2), routerHost.guardLine(steps[5] as never, 21_010, 2))
  for (const [xdg, home] of [['/x', '/h'], ['relative', '/h'], [undefined, undefined]] as const) {
    assert.equal(vmRouter.userConfigDir(xdg, home), routerHost.userConfigDir(xdg, home))
  }
  for (const [t, max, head] of [['abcde😀fghij', 8, 6], ['abcde😀fghij', 8, 5], ['a\ud800bc', 2, 1], ['short', 10, 5]] as const) {
    assert.equal(vmRouter.clipPrompt(t, max, head), routerHost.clipPrompt(t, max, head), t)
  }
  for (const m of [
    'jev-hooks: $.http.fetch: refused: network access from plugins is disabled by policy',
    'Error: jev-hooks: $.http.fetch(https://rizzo.example.com/v1/systemone) failed: ECONNREFUSED: connect ECONNREFUSED',
    'jev-hooks: $.http.fetch: note:x) failed: Word: y refused: http or https only',
    'jev-hooks: $.http.fetch: foo:network access from plugins is disabled by policy refused: http or https only',
    'jev-hooks: $.http.fetch: refused: __proto__',
  ]) {
    assert.equal(vmRouter.fetchFailure(m), routerHost.fetchFailure(m), m)
  }
})

// ─── hooks/register.ts in the empty context ───────────────────────────────────

test('hooks/register.ts in the vm context: prompt.submit reaches the fetch, turn.step lowers the effort', async () => {
  const g = load([join(root, 'hooks', 'register.ts')])
  // the hook adds only itself to the router's graph
  assert.equal(g.order.at(-1), 'hooks/register.ts')
  for (const id of g.order.slice(0, -1)) assert.match(id, /^src\/core\/[\w-]+\.ts$/)
  // $, on and every next are written as source: all the hook touches is born in the context
  const drive = vm.runInContext(`(async function (register, options, answer) {
    const hooks = Object.create(null)
    const seen = { fetches: [], logs: [], status: [], timers: [], steps: [], reads: [], exists: [] }
    const env = { HOME: '/home/test' }
    // a linked worktree: the walk up from the session's directory finds its .git
    const $ = {
      env: { get: async (name) => (Object.hasOwn(env, name) ? env[name] : undefined) },
      fs: {
        read: async (path) => { seen.reads.push(path); throw new Error('jev-hooks: $.fs.read(' + path + ') failed: ENOENT') },
        exists: async (path) => { seen.exists.push(path); return path === '/work/wt/.git' },
      },
      session: { repo: async () => ({ root: '/work/main', remote: null }), cwd: async () => '/work/wt/sub/' },
      clock: {
        now: async () => 1000,
        after: (ms, fn) => { const t = { ms, cancelled: false }; seen.timers.push(t); return { cancel: () => { t.cancelled = true } } },
      },
      http: { fetch: async (url, init) => { seen.fetches.push({ url, init }); return { status: 200, ok: true, headers: {}, text: answer } } },
      ui: {
        log: (text, o) => { seen.logs.push({ text, to: o && o.to === 'debug' ? 'debug' : 'transcript' }) },
        status: (text) => { seen.status.push(text) },
      },
    }
    const signal = { aborted: false }
    register((event, hook) => { hooks[event] = hook }, options)
    const startNext = Object.assign(async (e) => ({ turnId: e.turnId }), { signal })
    const submitNext = Object.assign(async (e) => {
      await hooks['turn.start']($, Object.freeze({ text: e.text, turnId: 't1' }), startNext)
      return { text: e.text }
    }, { signal })
    const prompt = Object.freeze({ text: 'rename x to y in src/a.ts', wait: false, origin: { kind: 'composer' } })
    const entered = await hooks['prompt.submit']($, prompt, submitNext)
    const below = Object.assign((e) => (async function* () {
      seen.steps.push({ index: e.index, effort: e.effort })
      yield { kind: 'text', index: 0, text: 'done' }
      return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: null }
    })(), { signal })
    for (const index of [0, 1]) {
      const stream = hooks['turn.step']($, Object.freeze({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }), below)
      let r = await stream.next()
      while (!r.done) r = await stream.next()
    }
    return JSON.stringify({ registered: Object.keys(hooks), entered, seen })
  })`, g.ctx) as (register: unknown, options: unknown, answer: string) => Promise<string>

  const options = inside(g.ctx, { ...LOCAL_OPTIONS, router_url: '', api_key: '', router_api_key: '', commit_review: true })
  const out = JSON.parse(await drive(g.modules['hooks/register.ts'].register, options, routerReply('small_edit', { extra: {} })))
  assert.deepEqual(out.registered, ['prompt.submit', 'turn.start', 'turn.step'])
  assert.deepEqual(out.entered, { text: 'rename x to y in src/a.ts' })
  // a ReferenceError inside the hook would be caught and logged as an error line: none is
  assert.deepEqual(out.seen.logs.filter((l: { to: string }) => l.to === 'transcript').map((l: { text: string }) => l.text), [
    '[jev-hooks] effort high → low: small_edit 0.90: -2 → low; explicit_depth quick 0.70: low → low',
  ])
  assert.equal(out.seen.fetches.length, 1)
  const f = out.seen.fetches[0]
  assert.equal(f.url, 'http://192.168.1.50:8017/v1/systemone')
  assert.equal(f.init.method, 'POST')
  const body = JSON.parse(f.init.body)
  assert.equal(body.state, 'rename x to y in src/a.ts')
  assert.deepEqual(Object.keys(body.questions), Object.keys((jsonOf('config/router.json') as { questions: object }).questions))
  assert.deepEqual(out.seen.timers, [{ ms: 1500, cancelled: true }])
  assert.deepEqual(out.seen.steps, [{ index: 0, effort: 'low' }, { index: 1, effort: 'low' }])
  assert.deepEqual(out.seen.status, ['jev router: small_edit 0.90 → low'])
  // the walk's string work ran in the context: both project files were looked for
  assert.deepEqual(out.seen.exists, ['/work/wt/sub/.git', '/work/wt/.git'])
  assert.deepEqual(out.seen.reads.filter((p: string) => p.endsWith('/.jev-hooks/router.json')), [
    '/work/wt/.jev-hooks/router.json', '/work/main/.jev-hooks/router.json',
  ])
})
