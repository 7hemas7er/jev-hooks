// "Safe" git: fixed flags and environment, no external program started by a
// hostile .git/config, a stable diff format, the diff sources for the CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  gitEnv, changedFromHead, localDrivers, fileAtHead, git, readSource, repoRoot, defaultSource, titleFromMessages,
} from '../../src/node/git.ts'
import { hostileConfig, createRepo, hostileSubmodule } from '../helpers/git-repo.ts'
import type { TestRepo } from '../helpers/git-repo.ts'

const early = (): number => performance.now() + 20_000

function withRepo(f: (r: TestRepo) => void): void {
  const r = createRepo()
  try {
    f(r)
  } finally {
    r.close()
  }
}

function valueOf<T>(e: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!e.ok) assert.fail(e.error.message)
  return e.value
}

test('environment of the git processes: only PATH, HOME and the fixed variables, never keys', () => {
  const env = gitEnv({
    PATH: '/usr/bin', HOME: '/home/test', CLAUDE_PLUGIN_OPTION_API_KEY: 'k1', JEV_HOOKS_KEY: 'k2', TYPESAFE_API_KEY: 'k3',
    GIT_DIR: '/elsewhere', GIT_CONFIG_GLOBAL: '/elsewhere/cfg',
  }, { GIT_INDEX_FILE: '/tmp/index' })
  assert.deepEqual(Object.keys(env).sort(), ['GIT_INDEX_FILE', 'GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH'])
  assert.equal(env.LC_ALL, 'C')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  // never a fetch from the promisor remote of a partial clone
  assert.equal(env.GIT_NO_LAZY_FETCH, '1')
})

test('partial clone with a hostile uploadpack: the diff fails without downloading, no canary', () => withRepo((r) => {
  r.write('src/a.py', 'x = 1\n')
  r.commit('first')
  const blob = r.git('rev-parse', 'HEAD:src/a.py').trim()
  r.write('src/a.py', 'x = 2\n')
  r.git('add', 'src/a.py')
  rmSync(join(r.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
  r.git('config', 'core.repositoryformatversion', '1')
  r.git('config', 'extensions.partialClone', 'origin')
  r.git('config', 'remote.origin.promisor', 'true')
  r.git('config', 'remote.origin.url', r.base)
  r.git('config', 'remote.origin.uploadpack', `touch "${join(r.canaries, 'uploadpack')}"; git-upload-pack`)
  for (const s of [{ kind: 'staged' }, { kind: 'working' }] as const) {
    const e = readSource(s, r.dir, early(), { env: r.env })
    assert.equal(e.ok, false, s.kind)
    assert.deepEqual(r.touched(), [], s.kind)
  }
  // even without the variable (a git that does not know it): no transport allowed
  const e = git(['diff', '--cached', 'HEAD'], { cwd: r.dir, deadline: early(), env: r.env, extraEnv: { GIT_NO_LAZY_FETCH: '0' } })
  assert.equal(e.ok && e.value.code !== 0, true)
  assert.deepEqual(r.touched(), [])
}))

test('staged, working and ref: diff with a/ and b/ prefixes, title and description from the commits', () => withRepo((r) => {
  r.write('src/a.py', 'x = 1\n')
  r.commit('first')
  r.git('checkout', '-q', '-b', 'work')
  r.write('src/a.py', 'x = 2\n')
  r.commit('Change x\n\nBecause 2 is needed.')
  r.git('config', 'diff.noprefix', 'true')
  r.git('config', 'diff.relative', 'true')

  const one = valueOf(readSource({ kind: 'ref', ref: 'main' }, r.dir, early(), { env: r.env }))
  assert.match(one.diff, /^diff --git a\/src\/a\.py b\/src\/a\.py$/m)
  assert.match(one.diff, /^\+x = 2$/m)
  assert.equal(one.title, 'Change x')
  assert.equal(one.description, 'Because 2 is needed.')

  r.write('src/b.py', 'y = 1\n')
  r.commit('Add y')
  const two = valueOf(readSource({ kind: 'ref', ref: 'main' }, r.dir, early(), { env: r.env }))
  assert.equal(two.title, 'Add y')
  assert.equal(two.description, '- Add y\n- Change x')

  r.write('src/c.py', 'z = 1\n')
  r.git('add', 'src/c.py')
  r.write('src/a.py', 'x = 3\n')
  // from a subdirectory, with diff.relative: the paths stay relative to the root
  const sub = join(r.dir, 'src')
  const staged = valueOf(readSource({ kind: 'staged' }, sub, early(), { env: r.env }))
  assert.match(staged.diff, /b\/src\/c\.py/)
  assert.doesNotMatch(staged.diff, /x = 3/)
  const working = valueOf(readSource({ kind: 'working' }, sub, early(), { env: r.env }))
  assert.match(working.diff, /^\+x = 3$/m)
  assert.match(working.diff, /b\/src\/c\.py/)
  assert.equal(working.approximate, false)
}))

test('submodule with filters and textconv in its config: no canary, the commit change shows', () => withRepo((r) => {
  r.write('README.md', 'x\n')
  r.commit('first')
  hostileSubmodule(r, '.jev-hooks/sub')
  const intent = { all: false, amend: false, allowEmpty: false, paths: [] as string[], adds: null }
  const all = valueOf(readSource({ kind: 'commit', intent: { ...intent, all: true } }, r.dir, early(), { env: r.env }))
  assert.match(all.diff, /^\+Subproject commit [0-9a-f]{40}$/m)
  assert.deepEqual(r.touched(), [], 'commit -a')
  valueOf(readSource({ kind: 'working' }, r.dir, early(), { env: r.env }))
  valueOf(readSource({ kind: 'commit', intent: { ...intent, paths: ['.jev-hooks/sub'] } }, r.dir, early(), { env: r.env }))
  assert.deepEqual(r.touched(), [], 'working and paths')
  assert.deepEqual(valueOf(changedFromHead('.jev-hooks', r.dir, early(), r.env)), ['.jev-hooks/sub'])
  assert.deepEqual(r.touched(), [], 'status')
  r.git('add', '.jev-hooks/sub')
  valueOf(readSource({ kind: 'staged' }, r.dir, early(), { env: r.env }))
  assert.deepEqual(r.touched(), [], 'staged with diff.submodule=diff')
}))

test('invalid refs rejected before git', () => withRepo((r) => {
  r.commit('first')
  for (const ref of ['--output=/tmp/x', '-p', 'a b', 'HEAD;ls', '']) {
    const e = readSource({ kind: 'ref', ref }, r.dir, early(), { env: r.env })
    assert.equal(e.ok, false, ref)
  }
}))

test('hostile .git/config: no canary, and the working tree falls back to the index', () => withRepo((r) => {
  r.write('README.md', 'hello\n')
  r.commit('first')
  hostileConfig(r)
  // control: everyday git really starts every program in the config
  r.reset()
  r.git('status')
  r.git('diff')
  r.git('diff', '--no-ext-diff')
  r.git('log', '-1')
  assert.deepEqual(r.touched(), ['clean', 'external', 'fsmonitor', 'gpg', 'textconv'])
  r.reset()

  const s = early()
  const o = { env: r.env }
  assert.equal(repoRoot(r.dir, s, r.env), r.dir)
  assert.deepEqual(valueOf(localDrivers(r.dir, s, r.env)).sort(), ['diff.canary.textconv', 'filter.canary.clean', 'filter.wt.clean'])
  const staged = valueOf(readSource({ kind: 'staged' }, r.dir, s, o))
  assert.equal(staged.diff, '')
  const working = valueOf(readSource({ kind: 'working' }, r.dir, s, o))
  assert.equal(working.approximate, true)
  assert.match(working.note ?? '', /local git drivers/)
  assert.doesNotMatch(working.diff, /two/)
  const ref = valueOf(readSource({ kind: 'ref', ref: 'HEAD~1' }, r.dir, s, o))
  assert.equal(ref.title, 'commit with a fake signature')
  valueOf(defaultSource(r.dir, s, r.env))
  valueOf(changedFromHead('.jev-hooks', r.dir, s, r.env))
  valueOf(fileAtHead('data.txt', r.dir, s, r.env))
  assert.deepEqual(r.touched(), [], 'the safe git must not start programs of the repo')
  // with diff.noprefix and diff.mnemonicPrefix in the config the prefixes stay a/ and b/
  r.git('add', 'data.txt')
  r.reset()
  const after = valueOf(readSource({ kind: 'staged' }, r.dir, s, o))
  assert.match(after.diff, /^diff --git a\/data\.txt b\/data\.txt$/m)
  assert.deepEqual(r.touched(), [])
}))

test('a global (user) filter runs, but does not see the hook\'s keys', () => withRepo((r) => {
  const dump = join(r.base, 'filter-environment.txt')
  const script = join(r.base, 'filter.sh')
  writeFileSync(script, `#!/bin/sh\nenv > "${dump}"\ncat\n`)
  chmodSync(script, 0o755)
  writeFileSync(join(r.home, '.gitconfig'), `[filter "global"]\n\tclean = ${script}\n`)
  r.write('.gitattributes', '*.cfg filter=global\n')
  r.write('app.cfg', 'a\n')
  r.commit('first')
  r.write('app.cfg', 'a\nb\n')
  const env = { ...r.env, CLAUDE_PLUGIN_OPTION_API_KEY: 'key-not-to-be-seen', JEV_HOOKS_KEY: 'another-key', TYPESAFE_API_KEY: 'third' }
  const w = valueOf(readSource({ kind: 'working' }, r.dir, early(), { env }))
  assert.equal(w.approximate, false, 'global drivers do not cause a fallback')
  const seen = readFileSync(dump, 'utf8')
  assert.match(seen, /^PATH=/m)
  for (const k of ['key-not-to-be-seen', 'another-key', 'third', 'CLAUDE_PLUGIN_OPTION', 'JEV_HOOKS', 'TYPESAFE']) {
    assert.ok(!seen.includes(k), `${k} in the filter's environment`)
  }
}))

test('default source: staged, then uncommitted, then branch against the main one, then HEAD~1', () => withRepo((r) => {
  const s = (): { kind: string; ref?: string } => valueOf(defaultSource(r.dir, early(), r.env)).source as { kind: string; ref?: string }
  r.write('a.txt', '1\n')
  r.commit('first')
  assert.equal(defaultSource(r.dir, early(), r.env).ok, false, 'a single commit and no change: nothing to review')
  r.write('a.txt', '2\n')
  assert.equal(s().kind, 'working')
  r.git('add', 'a.txt')
  assert.equal(s().kind, 'staged')
  r.commit('second')
  assert.deepEqual(s(), { kind: 'ref', ref: 'HEAD~1' })
  r.git('checkout', '-q', '-b', 'feature')
  r.write('b.txt', '1\n')
  r.commit('third')
  assert.deepEqual(s(), { kind: 'ref', ref: 'main' })
}))

test('files that differ from HEAD: modified, staged, deleted and untracked', () => withRepo((r) => {
  r.write('.jev-hooks/policy.json', '{}\n')
  r.write('.jev-hooks/checks.json', '{}\n')
  r.write('other.txt', 'x\n')
  r.commit('rules')
  assert.deepEqual(valueOf(changedFromHead('.jev-hooks', r.dir, early(), r.env)), [])
  r.write('.jev-hooks/policy.json', '{"x": 1}\n')
  r.write('.jev-hooks/calibration.json', '{}\n')
  r.git('rm', '-q', '.jev-hooks/checks.json')
  r.write('other.txt', 'y\n')
  assert.deepEqual(valueOf(changedFromHead('.jev-hooks', r.dir, early(), r.env)).sort(),
    ['.jev-hooks/calibration.json', '.jev-hooks/checks.json', '.jev-hooks/policy.json'])
  assert.equal(valueOf(fileAtHead('.jev-hooks/policy.json', r.dir, early(), r.env)), '{}\n')
  assert.equal(valueOf(fileAtHead('.jev-hooks/calibration.json', r.dir, early(), r.env)), null)
}))

test('deadline passed: no git, a timeout error; output past the cap truncated', () => withRepo((r) => {
  r.write('large.txt', `${'a fairly long line of text\n'.repeat(2000)}`)
  r.git('add', 'large.txt')
  const e = git(['status'], { cwd: r.dir, deadline: performance.now() - 1, env: r.env })
  assert.equal(e.ok, false)
  if (!e.ok) assert.equal(e.error.kind, 'timeout')
  const t = valueOf(readSource({ kind: 'staged' }, r.dir, early(), { env: r.env, maxBytes: 1000 }))
  assert.equal(Buffer.byteLength(t.diff), 1001, 'one byte past the cap: the diff reader sees it as truncated')
}))

test('title from the messages: empty ones ignored, Windows line breaks', () => {
  assert.deepEqual(titleFromMessages([]), { title: '', description: null })
  assert.deepEqual(titleFromMessages(['Title\r\n\r\nBody\r\non two lines']), { title: 'Title', description: 'Body\non two lines' })
  assert.deepEqual(titleFromMessages(['Title only']), { title: 'Title only', description: null })
})

test('a diff file is read up to the cap', () => withRepo((r) => {
  const f = join(r.base, 'x.diff')
  writeFileSync(f, 'a'.repeat(5000))
  const d = valueOf(readSource({ kind: 'file', path: f }, r.base, early(), { maxBytes: 100 }))
  assert.equal(d.diff.length, 101)
  assert.equal(readSource({ kind: 'file', path: join(r.base, 'missing.diff') }, r.base, early()).ok, false)
  assert.equal(readSource({ kind: 'file', path: r.base }, r.base, early()).ok, false)
}))
