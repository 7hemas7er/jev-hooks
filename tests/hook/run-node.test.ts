// hooks/run-node.sh as Claude Code starts it: without the PATH of an interactive shell.
// Every run gets an environment built from scratch, as env -i would: a PATH that holds
// only the commands the script needs (cat, ls, dirname), a fake HOME, and a fake system
// root (JEV_HOOKS_TEST_SYSROOT) so that the Node of the machine running the tests is
// never found. The candidates are fake node executables, small sh scripts placed where
// the version managers install Node: each answers the probe with the version and the
// type-stripping flag it was given, logs every probe and run, and when run as the hook
// prints which node it is, its arguments and its stdin. One test uses the real Node.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'hooks', 'run-node.sh')
const COMMIT_INPUT = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } })

function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, cmd)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${cmd} not found on PATH`)
}

let base = ''
let bin = ''
let bash = ''
let worlds = 0

before(() => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-run-node-'))
  bin = join(base, 'bin')
  mkdirSync(bin)
  for (const c of ['cat', 'ls', 'dirname']) symlinkSync(which(c), join(bin, c))
  bash = which('bash')
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

interface World {
  dir: string
  home: string
  sysroot: string
  data: string
  log: string
  plugin: string
  env: Record<string, string>
}

function world(): World {
  const dir = join(base, `w${++worlds}`)
  const w: World = {
    dir,
    home: join(dir, 'home'),
    sysroot: join(dir, 'sysroot'),
    data: join(dir, 'data'),
    log: join(dir, 'node.log'),
    plugin: join(dir, 'plugin'),
    env: {},
  }
  for (const d of [w.home, w.sysroot, w.data, w.plugin]) mkdirSync(d, { recursive: true })
  w.env = { PATH: bin, HOME: w.home, CLAUDE_PLUGIN_ROOT: w.plugin, CLAUDE_PLUGIN_DATA: w.data, JEV_HOOKS_TEST_SYSROOT: w.sysroot }
  return w
}

// A fake node at an absolute path. Asked the probe (-p), it answers "<version>
// <true|false>", the line run-node.sh expects from a real node.
function fakeNode(w: World, path: string, version: string, typescript = true): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    '#!/bin/sh',
    `if [ "$1" = -p ]; then echo "probe ${path}" >> "${w.log}"; echo "${version} ${typescript}"; exit 0; fi`,
    `echo "run ${path}" >> "${w.log}"`,
    `echo "ran ${path}"`,
    'echo "args $*"',
    'cat',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

const nvm = (w: World, v: string): string => join(w.home, '.nvm', 'versions', 'node', v, 'bin', 'node')

interface Run {
  status: number | null
  out: string
  err: string
  ran: string
  probes: string[]
  log: string[]
}

function run(w: World, event: string, stdin: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(bash, [SCRIPT, event], { env: { ...w.env, ...env }, input: stdin, encoding: 'utf8', timeout: 30_000 })
  const log = existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter(Boolean) : []
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    ran: /^ran (.*)$/m.exec(r.stdout)?.[1] ?? '',
    probes: log.filter((l) => l.startsWith('probe ')).map((l) => l.slice('probe '.length)),
    log,
  }
}

test('a real Node found only under ~/.nvm runs the hook, with type stripping and the input on stdin', () => {
  const w = world()
  writeFileSync(join(w.plugin, 'package.json'), '{ "type": "module" }\n')
  mkdirSync(join(w.plugin, 'src', 'hook'), { recursive: true })
  writeFileSync(join(w.plugin, 'src', 'hook', 'main.ts'), [
    "import { readFileSync } from 'node:fs'",
    "const input: string = readFileSync(0, 'utf8')",
    'console.log(JSON.stringify({ event: process.argv[2], input: input.trim() }))',
    '',
  ].join('\n'))
  const node = nvm(w, `v${process.versions.node}`)
  mkdirSync(dirname(node), { recursive: true })
  symlinkSync(process.execPath, node)

  const r = run(w, 'commit', COMMIT_INPUT)
  assert.equal(r.status, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { event: 'commit', input: COMMIT_INPUT })
  assert.doesNotMatch(r.err, /ExperimentalWarning|not found/)
})

test('nvm: the highest version is picked by number, with a single probe, and gets the input', () => {
  const w = world()
  for (const v of ['v22.18.0', 'v24.9.0', 'v23.11.0', 'v18.20.4']) fakeNode(w, nvm(w, v), v.slice(1))
  const top = fakeNode(w, nvm(w, 'v24.10.0'), '24.10.0')

  const r = run(w, 'commit', COMMIT_INPUT)
  assert.equal(r.status, 0, r.err)
  assert.equal(r.ran, top)
  assert.deepEqual(r.probes, [top])
  assert.match(r.out, new RegExp(`^args --disable-warning=ExperimentalWarning ${w.plugin}/src/hook/main\\.ts commit$`, 'm'))
  assert.ok(r.out.includes(COMMIT_INPUT), r.out)
})

test('a version that is too old, or has no type stripping, is skipped', () => {
  const w = world()
  const noStripping = fakeNode(w, nvm(w, 'v25.0.0'), '25.0.0', false)
  const lies = fakeNode(w, nvm(w, 'v24.0.0'), '22.17.0')          // the directory says 24, the binary 22.17
  const good = fakeNode(w, nvm(w, 'v22.18.0'), '22.18.0')
  fakeNode(w, nvm(w, 'v22.17.1'), '22.17.1')                     // too old by its name: never probed
  fakeNode(w, nvm(w, 'v20.19.0'), '20.19.0')

  const r = run(w, 'commit', COMMIT_INPUT)
  assert.equal(r.status, 0, r.err)
  assert.equal(r.ran, good)
  assert.deepEqual(r.probes, [noStripping, lies, good])
})

test('JEV_HOOKS_NODE comes first, even over a valid PATH node and a newer nvm install', () => {
  const w = world()
  const custom = fakeNode(w, join(w.dir, 'custom', 'node'), '22.18.0')
  const pathNode = fakeNode(w, join(w.dir, 'path', 'node'), '24.0.0')
  fakeNode(w, nvm(w, 'v25.0.0'), '25.0.0')

  const r = run(w, 'commit', COMMIT_INPUT, { JEV_HOOKS_NODE: custom, PATH: `${bin}:${dirname(pathNode)}` })
  assert.equal(r.status, 0, r.err)
  assert.equal(r.ran, custom)
  assert.deepEqual(r.probes, [custom])
})

test('an unusable JEV_HOOKS_NODE is reported on stderr and the search goes on', () => {
  for (const setting of ['old', 'missing']) {
    const w = world()
    const old = fakeNode(w, join(w.dir, 'custom', 'node'), '22.17.0')
    const custom = setting === 'old' ? old : join(w.dir, 'nowhere', 'node')
    const found = fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')

    const r = run(w, 'commit', COMMIT_INPUT, { JEV_HOOKS_NODE: custom })
    assert.equal(r.status, 0, r.err)
    assert.equal(r.ran, found, setting)
    assert.match(r.err, new RegExp(`JEV_HOOKS_NODE=${custom} is not a Node >= 22\\.18`), setting)
  }
})

test('a valid node on PATH is preferred to a newer nvm install; a too-old one is skipped', () => {
  const w = world()
  const pathNode = fakeNode(w, join(w.dir, 'path', 'node'), '22.18.0')
  fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')
  const r = run(w, 'commit', COMMIT_INPUT, { PATH: `${bin}:${dirname(pathNode)}` })
  assert.equal(r.ran, pathNode)
  assert.deepEqual(r.probes, [pathNode])

  const w2 = world()
  const oldPath = fakeNode(w2, join(w2.dir, 'path', 'node'), '20.11.1')
  const found = fakeNode(w2, nvm(w2, 'v24.0.0'), '24.0.0')
  const r2 = run(w2, 'commit', COMMIT_INPUT, { PATH: `${bin}:${dirname(oldPath)}` })
  assert.equal(r2.ran, found)
  assert.deepEqual(r2.probes, [oldPath, found])
})

test('every version manager and system location is searched', () => {
  const layouts: Array<[string, (w: World) => string, Record<string, (w: World) => string>]> = [
    ['NVM_DIR', (w) => join(w.dir, 'nvm', 'versions', 'node', 'v24.0.0', 'bin', 'node'), { NVM_DIR: (w) => join(w.dir, 'nvm') }],
    ['fnm', (w) => join(w.home, '.local', 'share', 'fnm', 'node-versions', 'v24.0.0', 'installation', 'bin', 'node'), {}],
    ['FNM_DIR', (w) => join(w.dir, 'fnm', 'node-versions', 'v24.0.0', 'installation', 'bin', 'node'), { FNM_DIR: (w) => join(w.dir, 'fnm') }],
    ['~/.fnm', (w) => join(w.home, '.fnm', 'node-versions', 'v24.0.0', 'installation', 'bin', 'node'), {}],
    ['fnm on macOS', (w) => join(w.home, 'Library', 'Application Support', 'fnm', 'node-versions', 'v24.0.0', 'installation', 'bin', 'node'), {}],
    ['volta', (w) => join(w.home, '.volta', 'tools', 'image', 'node', '24.0.0', 'bin', 'node'), {}],
    ['asdf', (w) => join(w.home, '.asdf', 'installs', 'nodejs', '24.0.0', 'bin', 'node'), {}],
    ['ASDF_DATA_DIR', (w) => join(w.dir, 'asdf', 'installs', 'nodejs', '24.0.0', 'bin', 'node'), { ASDF_DATA_DIR: (w) => join(w.dir, 'asdf') }],
    ['mise', (w) => join(w.home, '.local', 'share', 'mise', 'installs', 'node', '24.0.0', 'bin', 'node'), {}],
    ['n', (w) => join(w.sysroot, 'usr', 'local', 'n', 'versions', 'node', '24.0.0', 'bin', 'node'), {}],
    ['N_PREFIX', (w) => join(w.dir, 'n', 'n', 'versions', 'node', '24.0.0', 'bin', 'node'), { N_PREFIX: (w) => join(w.dir, 'n') }],
    ['Homebrew', (w) => join(w.sysroot, 'opt', 'homebrew', 'bin', 'node'), {}],
    ['Linuxbrew', (w) => join(w.sysroot, 'home', 'linuxbrew', '.linuxbrew', 'bin', 'node'), {}],
    ['/usr/local/bin', (w) => join(w.sysroot, 'usr', 'local', 'bin', 'node'), {}],
    ['/usr/bin', (w) => join(w.sysroot, 'usr', 'bin', 'node'), {}],
  ]
  for (const [name, where, vars] of layouts) {
    const w = world()
    const node = fakeNode(w, where(w), '24.0.0')
    const env = Object.fromEntries(Object.entries(vars).map(([k, f]) => [k, f(w)]))
    const r = run(w, 'commit', COMMIT_INPUT, env)
    assert.equal(r.status, 0, `${name}: ${r.err}`)
    assert.equal(r.ran, node, name)
    assert.deepEqual(r.probes, [node], name)
  }
})

test('across version managers the highest version wins, a tie goes to the earlier one, and all beat Homebrew', () => {
  const w = world()
  fakeNode(w, nvm(w, 'v22.18.0'), '22.18.0')
  const volta = fakeNode(w, join(w.home, '.volta', 'tools', 'image', 'node', '24.1.0', 'bin', 'node'), '24.1.0')
  fakeNode(w, join(w.home, '.asdf', 'installs', 'nodejs', '23.0.0', 'bin', 'node'), '23.0.0')
  fakeNode(w, join(w.sysroot, 'opt', 'homebrew', 'bin', 'node'), '25.0.0')
  assert.equal(run(w, 'commit', COMMIT_INPUT).ran, volta)

  const w2 = world()
  const first = fakeNode(w2, nvm(w2, 'v24.0.0'), '24.0.0')
  fakeNode(w2, join(w2.home, '.local', 'share', 'mise', 'installs', 'node', '24.0.0', 'bin', 'node'), '24.0.0')
  assert.equal(run(w2, 'commit', COMMIT_INPUT).ran, first)

  // a name that is not a version (mise's aliases) is probed after every versioned one
  const w3 = world()
  const mise = join(w3.home, '.local', 'share', 'mise', 'installs', 'node')
  const alias = fakeNode(w3, join(mise, 'lts', 'bin', 'node'), '24.0.0')
  const broken = fakeNode(w3, join(mise, '24.0.0', 'bin', 'node'), '24.0.0', false)
  const r3 = run(w3, 'commit', COMMIT_INPUT)
  assert.equal(r3.ran, alias)
  assert.deepEqual(r3.probes, [broken, alias])
})

test('nothing usable: fail open, with a notice that says where it looked and how to fix it', () => {
  const w = world()
  const oldPath = fakeNode(w, join(w.dir, 'path', 'node'), '18.19.1')
  fakeNode(w, nvm(w, 'v20.19.0'), '20.19.0')
  const oldSystem = fakeNode(w, join(w.sysroot, 'usr', 'bin', 'node'), '16.20.2')
  const env = { PATH: `${bin}:${dirname(oldPath)}` }

  const r = run(w, 'commit', COMMIT_INPUT, env)
  assert.equal(r.status, 0)
  assert.equal(r.ran, '')
  assert.deepEqual(r.probes, [oldPath, oldSystem])
  const message: string = JSON.parse(r.out).systemMessage
  assert.match(message, /Node >= 22\.18 was not found on PATH nor in nvm, fnm, volta, asdf, mise, n or Homebrew/)
  assert.match(message, /JEV_HOOKS_NODE/)
  assert.match(r.err, /not found on PATH.*Set JEV_HOOKS_NODE/)

  // the post-commit record has no message for the user: stderr only
  mkdirSync(join(w.data, 'pending'))
  writeFileSync(join(w.data, 'pending', 'session'), '{}\n')
  const p = run(w, 'post-commit', '{}', env)
  assert.equal(p.status, 0)
  assert.equal(p.out, '')
  assert.match(p.err, /Set JEV_HOOKS_NODE/)
})

test('post-commit with nothing pending exits before any Node search', () => {
  const w = world()
  const pathNode = fakeNode(w, join(w.dir, 'path', 'node'), '24.0.0')
  const found = fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } })

  // no pending directory, then an empty one: no probe, no run, no output
  for (const env of [{}, { PATH: `${bin}:${dirname(pathNode)}` }]) {
    const r = run(w, 'post-commit', input, env)
    assert.deepEqual([r.status, r.out, r.err, r.log], [0, '', '', []])
    mkdirSync(join(w.data, 'pending'), { recursive: true })
  }

  writeFileSync(join(w.data, 'pending', 'session'), '{}\n')
  const r = run(w, 'post-commit', input)
  assert.equal(r.ran, found)
})

test('commit: a git command that is not a commit starts no Node', () => {
  const w = world()
  fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')
  const r = run(w, 'commit', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }))
  assert.deepEqual([r.status, r.out, r.err, r.log], [0, '', '', []])
})

test('skill: another skill starts no Node; ours does', () => {
  const w = world()
  const found = fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')
  const other = run(w, 'skill', JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'code-review' } }))
  assert.deepEqual([other.status, other.out, other.err, other.log], [0, '', '', []])
  const ours = run(w, 'skill', JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'jev-hooks:jev-review' } }))
  assert.equal(ours.ran, found)
})

test('guard: an edit that does not name .jev-hooks starts no Node; one that does, in any case, does', () => {
  const w = world()
  const found = fakeNode(w, nvm(w, 'v24.0.0'), '24.0.0')
  const other = run(w, 'guard', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } }))
  assert.deepEqual([other.status, other.out, other.err, other.log], [0, '', '', []])
  for (const p of ['.jev-hooks/policy.json', 'sub/.JEV-Hooks/checks.json']) {
    const r = run(w, 'guard', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: p } }))
    assert.equal(r.ran, found, p)
  }
})
