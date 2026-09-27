// Nothing written outside the temporary directories. It is guardrail's
// lesson, whose tests wrote into the user's real log: here the CLI and the hooks run as
// subprocesses with temporary HOME, XDG_*, CLAUDE_PLUGIN_DATA and JEV_HOOKS_LOG, and
// with the repo directory as cwd, so that even a write to a relative path would show.
// Before and after, the user's real directories (those of the passwd HOME, which a
// wrong os.homedir() would reach) and the repo are snapshotted: names, sizes and
// dates, never the content, because ~/.config/jev-hooks may hold the key.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer } from '../helpers/fake-systemone.ts'
import { createRepo } from '../helpers/git-repo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The real user's directories that jev-hooks would write into if it went astray.
function realDirs(): string[] {
  const homes = new Set<string>([userInfo().homedir])
  if (process.env.HOME) homes.add(process.env.HOME)
  const out: string[] = []
  for (const h of homes) {
    out.push(join(h, '.local', 'state', 'jev-hooks'), join(h, '.config', 'jev-hooks'), join(h, '.cache', 'jev-hooks'))
  }
  return out
}

// Snapshot of a directory: relative path, type, size and date of every entry.
// Without following links and without reading the files. null if the directory is missing.
function snapshot(dir: string, skip: readonly string[] = []): string[] | null {
  if (!existsSync(dir)) return null
  const items: string[] = []
  const visit = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = relative(dir, p)
      if (skip.includes(rel)) continue
      const st = lstatSync(p)
      items.push(`${rel}\t${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'}\t${st.isDirectory() ? '' : st.size}\t${st.mtimeMs}`)
      if (st.isDirectory()) visit(p)
    }
  }
  visit(dir)
  return items.sort()
}

function snapshots(): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {}
  for (const d of realDirs()) out[d] = snapshot(d)
  // .git changes for reasons of its own (gc, index stat): the working tree is what counts
  out[ROOT] = snapshot(ROOT, ['.git'])
  return out
}

let base = ''
let fake: FakeServer
let snapshotBefore: Record<string, string[] | null> = {}

before(async () => {
  snapshotBefore = snapshots()
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-writes-'))
  fake = await startFake({ scenario: { rules: [{ if_state_contains: 'SIGNING_KEY', answers: { hardcoded_secret: 0.997 } }] } })
})

after(async () => {
  await fake?.close()
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

function runProcess(args: string[], env: NodeJS.ProcessEnv, input: string = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok, ko) => {
    // cwd: the repo, so a write to a relative path would end up there
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (s: string) => { out += s })
    p.stderr.on('data', (s: string) => { err += s })
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000)
    p.on('error', ko)
    p.on('close', (code) => {
      clearTimeout(timer)
      ok({ code: code ?? -1, out, err })
    })
    p.stdin.end(input)
  })
}

test('CLI and hooks write only into the temporary directories they are given', async () => {
  const home = join(base, 'home')
  const dataDir = join(base, 'plugin-data')
  const log = join(base, 'log-cli.jsonl')
  mkdirSync(home)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
  }

  // CLI: a review without a log, one with JEV_HOOKS_LOG, explain
  const diff = join(base, 'secret.diff')
  writeFileSync(diff, [
    'diff --git a/src/auth/tokens.py b/src/auth/tokens.py', 'new file mode 100644', '--- /dev/null', '+++ b/src/auth/tokens.py',
    '@@ -0,0 +1 @@', '+SIGNING_KEY = load()', '',
  ].join('\n'))
  const cli = join(ROOT, 'bin', 'jev-review.mjs')
  // the demo's secret goes to Claude (policy v2): NITS, exit 1
  const withoutLog = await runProcess([cli, '--diff', diff, '--json'], { ...env, JEV_HOOKS_URL: fake.url })
  assert.equal(withoutLog.code, 1, withoutLog.err)
  const withLog = await runProcess([cli, '--diff', diff, '--json'], { ...env, JEV_HOOKS_URL: fake.url, JEV_HOOKS_LOG: log })
  assert.equal(withLog.code, 1, withLog.err)
  const explainCommand = await runProcess([cli, 'explain', 'hardcoded_secret'], { ...env, JEV_HOOKS_LOG: log })
  assert.equal(explainCommand.code, 0, explainCommand.err)
  // the CLI without JEV_HOOKS_LOG does not even write into the temporary state dir
  assert.equal(existsSync(join(home, '.local', 'state', 'jev-hooks')), false)
  assert.ok(existsSync(log), 'the CLI log was not written: the test proves nothing')

  // Hook: commit (log, cache, pending file, temporary index) and post-commit
  const r = createRepo()
  try {
    r.write('README.md', 'project\n')
    r.commit('first')
    r.write('src/sum.py', 'def add(a, b):\n    return a + b\n')
    const envHook: NodeJS.ProcessEnv = {
      ...env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PLUGIN_OPTION_REVIEW_URL: fake.url, CLAUDE_PLUGIN_OPTION_MODEL: 'jev-latest',
    }
    const main = join(ROOT, 'src', 'hook', 'main.ts')
    const command = 'git add src/sum.py && git commit -m "Sum"'
    const pre = await runProcess([main, 'commit'], envHook, JSON.stringify({
      session_id: 'writes-session', transcript_path: '/dev/null', cwd: r.dir, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: command },
    }))
    assert.equal(pre.code, 0, pre.err)
    assert.match(pre.out, /MERGE/)
    r.git('add', 'src/sum.py')
    r.git('commit', '-q', '-m', 'Sum')
    const post = await runProcess([main, 'post-commit'], envHook, JSON.stringify({
      session_id: 'writes-session', cwd: r.dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: command },
    }))
    assert.equal(post.code, 0, post.err)
  } finally {
    r.close()
  }
  assert.ok(existsSync(join(dataDir, 'log.jsonl')), 'the hook log was not written: the test proves nothing')

  assert.deepEqual(snapshots(), snapshotBefore, 'writes outside the temporary directories')
})
