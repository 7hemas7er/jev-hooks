// Temporary git repos for the tests of the adapters, the CLI and the commit hook.
// Everything lives under one temporary directory: the repo, a fake HOME (none of the
// user's ~/.gitconfig) and the canaries.
//
// hostileConfig() writes a .git/config the way a hostile repo would: every external
// program that git knows how to start (fsmonitor, external diff, textconv, clean
// filter also in the worktree scope, gpg for log.showSignature) touches a canary
// file. The "safe" git must touch none of them.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TestRepo {
  base: string                            // temporary directory that holds everything
  dir: string                             // the repo
  home: string                            // HOME of the test processes
  canaries: string                        // directory of the canaries
  env: NodeJS.ProcessEnv                  // environment for the tests' "normal" git
  git(...args: string[]): string
  write(rel: string, text: string): void
  commit(message: string): string       // git add -A and commit; returns the sha
  touched(): string[]                     // canaries touched so far
  reset(): void                          // forget the canaries (after the setup commands)
  close(): void
}

export function createRepo(o: { branch?: string } = {}): TestRepo {
  const base = mkdtempSync(join(tmpdir(), 'jev-hooks-repo-'))
  const home = join(base, 'home')
  const dir = join(base, 'repo')
  const canaries = join(base, 'canaries')
  for (const d of [home, dir, canaries]) mkdirSync(d)
  const env: NodeJS.ProcessEnv = {
    // TMPDIR: the external diff of the checks writes temporary files, and /tmp may
    // not be writable (sandbox)
    PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', o.branch ?? 'main')
  const r: TestRepo = {
    base, dir, home, canaries, env, git,
    write(rel, text) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    },
    commit(message) {
      git('add', '-A')
      git('commit', '-q', '--allow-empty', '-m', message)
      return git('rev-parse', 'HEAD').trim()
    },
    touched: () => (existsSync(canaries) ? readdirSync(canaries).sort() : []),
    reset() {
      for (const f of readdirSync(canaries)) rmSync(join(canaries, f), { force: true })
    },
    close: () => rmSync(base, { recursive: true, force: true }),
  }
  return r
}

// A script that touches the canary and then acts as `cat`, so git does not complain.
function canary(r: TestRepo, name: string): string {
  const script = join(r.base, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\ntouch "${join(r.canaries, name)}"\ncat\n`)
  chmodSync(script, 0o755)
  return script
}

// A hostile .git/config, plus a commit with a fake signature (to make log.showSignature
// start gpg.program) and a modified .txt file (for filters, textconv and the external
// diff). Call it after at least one commit.
export function hostileConfig(r: TestRepo): void {
  r.write('.gitattributes', '*.txt filter=canary diff=canary\n')
  r.write('data.txt', 'one\n')
  r.commit('attributes and data')
  r.git('config', 'core.fsmonitor', canary(r, 'fsmonitor'))
  r.git('config', 'diff.external', canary(r, 'external'))
  r.git('config', 'diff.canary.textconv', canary(r, 'textconv'))
  r.git('config', 'filter.canary.clean', canary(r, 'clean'))
  r.git('config', 'log.showSignature', 'true')
  r.git('config', 'gpg.program', canary(r, 'gpg'))
  r.git('config', 'extensions.worktreeConfig', 'true')
  r.git('config', '--worktree', 'filter.wt.clean', canary(r, 'wtclean'))
  r.git('config', 'diff.noprefix', 'true')
  r.git('config', 'diff.mnemonicPrefix', 'true')
  // a commit with a fake signature: git log with showSignature calls gpg.program
  const tree = r.git('write-tree').trim()
  const parent = r.git('rev-parse', 'HEAD').trim()
  const body = [
    `tree ${tree}`, `parent ${parent}`, 'author Test <test@example.invalid> 0 +0000', 'committer Test <test@example.invalid> 0 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' iQ', ' -----END PGP SIGNATURE-----', '', 'commit with a fake signature', '',
  ].join('\n')
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: r.dir, env: r.env, input: body, encoding: 'utf8' }).trim()
  r.git('update-ref', 'HEAD', sha)
  r.write('data.txt', 'one\ntwo\n')
}

// A nested repo (gitlink) at `rel` with a clean filter and a canary textconv in ITS
// config, and its working tree dirty with the same length (git has to re-read the
// file, and so go through the filter). The superproject has diff.submodule=diff and no
// local driver: localDrivers() sees nothing. Call it after at least one commit.
export function hostileSubmodule(r: TestRepo, rel: string): void {
  const sd = join(r.dir, rel)
  mkdirSync(sd, { recursive: true })
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: sd, env: r.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q')
  writeFileSync(join(sd, '.gitattributes'), '*.txt filter=sub diff=sub\n')
  writeFileSync(join(sd, 'a.txt'), 'one\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'sub 1')
  g('config', 'filter.sub.clean', canary(r, 'sub-clean'))
  g('config', 'diff.sub.textconv', canary(r, 'sub-textconv'))
  r.git('add', rel)
  r.git('commit', '-q', '-m', 'submodule')
  writeFileSync(join(sd, 'a.txt'), 'one\ntwo\n')
  g('-c', 'filter.sub.clean=cat', 'commit', '-q', '-am', 'sub 2')
  writeFileSync(join(sd, 'a.txt'), 'one\nten\n')
  r.git('config', 'diff.submodule', 'diff')
  r.reset()
}
