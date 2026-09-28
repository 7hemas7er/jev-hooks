// Rule 4 of AGENTS.md: src/core/** and hooks/register.ts run in the environment of
// Claude Code's module loader. In 2.1.282 that was a node:vm context created by
// Object.create(null), where URL, TextEncoder, fetch, process… are missing. 2.1.283
// declares URL, TextEncoder, AbortController, crypto… there and 2.1.282 did not; the core
// relies on none of them, so it runs the same in Node, in older builds and in the
// stricter context vm-pure.test.ts builds. A missing name does not show at load time: it
// blows up at runtime with a ReferenceError, inside a try/catch that hides it, and the
// router stays silent on every turn. This test catches the forbidden names in the source.
// It also checks rule 3: relative imports with the .ts extension written out, tests-cc/
// included (only `claude plugin test` runs it, through scripts/test-cc.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importsOf, stripSource, forbiddenIn } from '../helpers/source-code.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const item of readdirSync(dir)) {
    if (item === 'node_modules' || item.startsWith('.')) continue
    const p = join(dir, item)
    if (statSync(p).isDirectory()) found.push(...tsFiles(p))
    else if (p.endsWith('.ts')) found.push(p)
  }
  return found.sort()
}

function pureFiles(): string[] {
  const register = join(root, 'hooks', 'register.ts')
  return [...tsFiles(join(root, 'src', 'core')), ...(existsSync(register) ? [register] : [])]
}

const rel = (p: string): string => relative(root, p).split(sep).join('/')

test('the scanner ignores comments, strings, templates and regexes, but not code', () => {
  const harmless = [
    '// no URL, TextEncoder, fetch or process here',
    '/* console.log(Date.now()) */',
    "const a = 'invalid URL: use https'",
    'const b = "process.env is not read"',
    'const c = `Date and setTimeout in the text`',
    'const d = /performance|crypto/.test(a) ? 1 : 2',
    'const e = x / 2 / 3',
    'const f = $.http.fetch(u, init)',
    'const g = object.process + y?.console',
    'const h = { ...options, ...x.process } && a?.process',
    'type T = { url: string }',
  ].join('\n')
  assert.deepEqual(forbiddenIn(harmless), [])

  const offenders: [string, string][] = [
    ['const u = new URL(s)', 'URL'],
    ['const t = new TextEncoder()', 'TextEncoder'],
    ['const r = await fetch(u)', 'fetch'],
    ['const k = process.env.X', 'process'],
    ['const s = `value ${Date.now()} ms`', 'Date'],
    ['const s = `a ${`b ${console.log(1)}`}`', 'console'],
    ['queueMicrotask(f)', 'queueMicrotask'],
    ['const f = Function("return 1")', 'Function('],
    ["const m = await import('./x.ts')", 'dynamic import()'],
    ['globalThis.x = 1', 'globalThis'],
    ['const c = structuredClone(o)', 'structuredClone'],
    // the spread: three dots before the name are not a property access
    ['const a = { ...process.env }', 'process'],
    ['const v = [...URL]', 'URL'],
    ['f(...globalThis.x)', 'globalThis'],
    ['const k = Object.keys({ ...globalThis })', 'globalThis'],
  ]
  for (const [code, name] of offenders) {
    assert.deepEqual(forbiddenIn(code).map((v) => v.name), [name], code)
  }
})

test('stripping keeps length and line breaks', () => {
  const src = "const a = 'x\\'y' // c\n/* d\ne */ const b = `t${1}u`\n"
  const s = stripSource(src)
  assert.equal(s.length, src.length)
  assert.equal(s.split('\n').length, src.split('\n').length)
})

test('imports are read with their specifier', () => {
  const src = [
    "import type { Register } from 'claude-code'",
    "import { a, b } from '../src/core/router.ts'",
    'const x = 1',
    "export { c } from './c.ts'",
    "import './effect.ts'",
  ].join('\n')
  assert.deepEqual(importsOf(src).map((i) => [i.specifier, i.typeOnly]), [
    ['claude-code', true],
    ['../src/core/router.ts', false],
    ['./c.ts', false],
    ['./effect.ts', false],
  ])
})

test('src/core and hooks/register.ts do not use names missing from the vm context', () => {
  const errors: string[] = []
  for (const f of pureFiles()) {
    for (const v of forbiddenIn(readFileSync(f, 'utf8'))) errors.push(`${rel(f)}:${v.line}: ${v.name}`)
  }
  assert.deepEqual(errors, [])
})

test('src/core imports only src/core files, register.ts only the repo and the claude-code types', () => {
  const core = join(root, 'src', 'core') + sep
  const errors: string[] = []
  for (const f of pureFiles()) {
    const isRegister = f.endsWith(join('hooks', 'register.ts'))
    for (const imp of importsOf(readFileSync(f, 'utf8'))) {
      const where = `${rel(f)}:${imp.line}: "${imp.specifier}"`
      if (isRegister && imp.specifier === 'claude-code') {
        // the type import is erased when stripping; a value import would not resolve in Node
        if (!imp.typeOnly) errors.push(`${where} must be imported with import type`)
        continue
      }
      if (!imp.specifier.startsWith('./') && !imp.specifier.startsWith('../')) {
        errors.push(`${where} is not relative (node:* and packages do not exist in the vm context)`)
        continue
      }
      const target = resolve(dirname(f), imp.specifier)
      if (!isRegister && !target.startsWith(core)) errors.push(`${where} leaves src/core`)
      if (isRegister && !target.startsWith(join(root, 'src', 'core') + sep)) errors.push(`${where} must stay in src/core`)
    }
  }
  assert.deepEqual(errors, [])
})

test('relative imports carry the .ts extension (rule 3)', () => {
  const errors: string[] = []
  const all = ['src', 'hooks', 'scripts', 'tests', 'tests-cc'].flatMap((c) => tsFiles(join(root, c)))
  for (const f of all) {
    for (const imp of importsOf(readFileSync(f, 'utf8'))) {
      const relative = imp.specifier.startsWith('./') || imp.specifier.startsWith('../')
      if (relative && !imp.specifier.endsWith('.ts')) errors.push(`${rel(f)}:${imp.line}: "${imp.specifier}"`)
    }
  }
  assert.deepEqual(errors, [])
})
