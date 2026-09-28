// scripts/generate-demo.ts from the command line. The old parser took any first
// argument as the directory, so --help, -h or --seed=7 became a directory full of demo
// diffs in the cwd. Here every usage error exits 2 before anything is written, --help
// writes nothing, and every run happens inside a temporary directory: relative DIRs are
// resolved against one, and the subprocess gets a temporary cwd and TMPDIR.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP, InputError, main, parseArgs, TEMPLATES_DIR } from '../../scripts/generate-demo.ts'
import type { DemoOptions } from '../../scripts/generate-demo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'generate-demo.ts')
// The order main prints them in (templates sorted, then empty.diff), and the sorted names.
const LISTED = [...readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.diff')).sort(), 'empty.diff']
const EXPECTED = [...LISTED].sort()

let base = ''
let count = 0

before(() => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-generate-demo-'))
})

after(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

// A new empty directory per case: after --help or a usage error it must still be empty.
function fresh(): string {
  const d = join(base, `case-${++count}`)
  mkdirSync(d)
  return d
}

interface Execution { code: number; out: string; err: string }

function run(argv: readonly string[], cwd: string): Execution {
  let out = ''
  let err = ''
  const code = main(argv, cwd, (s) => { out += s }, (s) => { err += s })
  return { code, out, err }
}

// The script as the user runs it, with an environment from scratch.
function spawn(argv: readonly string[], cwd: string, tmp: string): Execution {
  const p = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd, env: { PATH: process.env.PATH ?? '', TMPDIR: tmp }, encoding: 'utf8', timeout: 60_000,
  })
  return { code: p.status ?? -1, out: p.stdout, err: p.stderr }
}

const contents = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]))

// ─── parseArgs ────────────────────────────────────────────────────────────────

// parseArgs only resolves paths: this directory is never touched.
const CWD = '/work'

const ACCEPTED: { argv: string[]; expected: DemoOptions | 'help' }[] = [
  { argv: [], expected: {} },
  { argv: ['--help'], expected: 'help' },
  { argv: ['-h'], expected: 'help' },
  { argv: ['demo', '--seed', '1', '--help'], expected: 'help' },
  { argv: ['demo'], expected: { dir: join(CWD, 'demo') } },
  { argv: ['/elsewhere/demo'], expected: { dir: '/elsewhere/demo' } },
  { argv: ['--seed=5', 'demo'], expected: { seed: 5, dir: join(CWD, 'demo') } },
  { argv: ['demo', '--seed', '5'], expected: { seed: 5, dir: join(CWD, 'demo') } },
  { argv: ['--seed', '-3'], expected: { seed: -3 } },
  { argv: ['--seed=0'], expected: { seed: 0 } },
  { argv: ['--seed', String(Number.MAX_SAFE_INTEGER)], expected: { seed: Number.MAX_SAFE_INTEGER } },
  { argv: ['--', '-x'], expected: { dir: join(CWD, '-x') } },
  { argv: ['--seed', '2', '--', '--help'], expected: { seed: 2, dir: join(CWD, '--help') } },
]

for (const c of ACCEPTED) {
  test(`parseArgs ${JSON.stringify(c.argv)} → ${JSON.stringify(c.expected)}`, () => {
    assert.deepEqual(parseArgs(c.argv, CWD), c.expected)
  })
}

const REJECTED: { argv: string[]; message: string }[] = [
  { argv: ['--seed'], message: 'missing value for --seed' },
  { argv: ['demo', '--seed'], message: 'missing value for --seed' },
  { argv: ['--seed', 'x'], message: '--seed wants an integer, found "x"' },
  { argv: ['--seed='], message: '--seed wants an integer, found ""' },
  { argv: ['--seed', ''], message: '--seed wants an integer, found ""' },
  { argv: ['--seed', '0x10'], message: '--seed wants an integer, found "0x10"' },
  { argv: ['--seed', '1e3'], message: '--seed wants an integer, found "1e3"' },
  { argv: ['--seed', '1.5'], message: '--seed wants an integer, found "1.5"' },
  { argv: ['--seed', ' 7'], message: '--seed wants an integer, found " 7"' },
  { argv: ['--seed', '--help'], message: '--seed wants an integer, found "--help"' },
  { argv: ['--seed', '9007199254740993'], message: '--seed wants an integer, found "9007199254740993"' },
  { argv: ['--seed', '1', '--seed', '2'], message: 'repeated option: --seed' },
  { argv: ['--seed=1', '--seed', '1'], message: 'repeated option: --seed' },
  { argv: ['--bogus'], message: 'unknown option: --bogus' },
  { argv: ['--out', 'demo'], message: 'unknown option: --out' },
  { argv: ['--seeds=1'], message: 'unknown option: --seeds=1' },
  { argv: ['-'], message: 'unknown option: -' },
  { argv: ['a', 'b'], message: 'unexpected argument: b' },
  { argv: ['--', 'a', 'b'], message: 'unexpected argument: b' },
]

for (const c of REJECTED) {
  test(`parseArgs ${JSON.stringify(c.argv)} → InputError "${c.message}"`, () => {
    assert.throws(() => parseArgs(c.argv, CWD), (e: unknown) => e instanceof InputError && e.message === c.message)
  })
}

// ─── main ─────────────────────────────────────────────────────────────────────

test('main: --help and -h print the usage, exit 0 and create nothing', () => {
  assert.match(HELP, /^Usage: node scripts\/generate-demo\.ts \[DIR\] \[--seed N\]\n/)
  for (const flag of ['--help', '-h']) {
    const cwd = fresh()
    assert.deepEqual(run([flag], cwd), { code: 0, out: `${HELP}\n`, err: '' })
    assert.deepEqual(readdirSync(cwd), [], flag)
  }
})

test('main: usage errors exit 2 with one line on stderr and create nothing', () => {
  const cases: { argv: string[]; message: string }[] = [
    { argv: ['--seed', 'x'], message: '--seed wants an integer, found "x"' },
    { argv: ['demo', '--seed=7x'], message: '--seed wants an integer, found "7x"' },
    { argv: ['--bogus'], message: 'unknown option: --bogus' },
    { argv: ['a', 'b'], message: 'unexpected argument: b' },
  ]
  for (const c of cases) {
    const cwd = fresh()
    assert.deepEqual(run(c.argv, cwd), { code: 2, out: '', err: `generate-demo: ${c.message}\n` }, JSON.stringify(c.argv))
    assert.deepEqual(readdirSync(cwd), [], JSON.stringify(c.argv))
  }
})

test('main: a relative DIR and --seed=N / --seed N write the same diffs; another seed does not', () => {
  const cwd = fresh()
  const a = run(['--seed=5', 'a'], cwd)
  const b = run(['b', '--seed', '5'], cwd)
  const c = run(['c', '--seed', '6'], cwd)
  for (const [x, name] of [[a, 'a'], [b, 'b'], [c, 'c']] as const) {
    assert.equal(x.code, 0, x.err)
    assert.equal(x.err, '')
    assert.deepEqual(x.out.split('\n'), [join(cwd, name), ...LISTED.map((n) => `  ${n}`), ''])
    assert.deepEqual(readdirSync(join(cwd, name)).sort(), EXPECTED)
  }
  assert.deepEqual(readdirSync(cwd).sort(), ['a', 'b', 'c'])
  assert.deepEqual(contents(join(cwd, 'a')), contents(join(cwd, 'b')))
  assert.notDeepEqual(contents(join(cwd, 'a')), contents(join(cwd, 'c')))
})

// ─── The script as a program ──────────────────────────────────────────────────

test('program: --help exits 0 and writes nothing; a bad option exits 2', () => {
  const cwd = fresh()
  const tmp = fresh()
  assert.deepEqual(spawn(['--help'], cwd, tmp), { code: 0, out: `${HELP}\n`, err: '' })
  assert.deepEqual(spawn(['--seed=7', '--bogus'], cwd, tmp), { code: 2, out: '', err: 'generate-demo: unknown option: --bogus\n' })
  assert.deepEqual(readdirSync(cwd), [])
  assert.deepEqual(readdirSync(tmp), [])
})

test('program: without DIR it creates a temporary directory and prints it', () => {
  const cwd = fresh()
  const tmp = fresh()
  const x = spawn(['--seed', '3'], cwd, tmp)
  assert.equal(x.code, 0, x.err)
  const [dir, ...names] = x.out.split('\n')
  assert.equal(dirname(dir), tmp)
  assert.match(dir, /\/jev-hooks-demo-[^/]+$/)
  assert.deepEqual(names, [...LISTED.map((n) => `  ${n}`), ''])
  assert.deepEqual(readdirSync(dir).sort(), EXPECTED)
  assert.deepEqual(readdirSync(cwd), [])
})
