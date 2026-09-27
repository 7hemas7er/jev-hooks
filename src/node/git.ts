// "Safe" git. The hook runs outside the sandbox on a repo that Claude can
// modify: a hostile .git/config (fsmonitor, textconv, clean filters, external diff,
// log.showSignature with gpg.program) would run code with the user's permissions,
// that is, a sandbox escape. That is why every invocation goes through git() with:
// - -c options that turn off every external program git knows how to start, and flags
//   that pin the diff format (a/ and b/ prefixes, no relative paths) against
//   diff.noprefix, diff.mnemonicPrefix and diff.relative;
// - a minimal, explicit environment, not inherited: no CLAUDE_PLUGIN_OPTION_*,
//   JEV_HOOKS_* or TYPESAFE_*, because filters configured at the global level start
//   anyway and must not see keys;
// - spawn without a shell, at most 10 s per command and never beyond the review's
//   deadline, output with a cap.
// The working tree diff runs the clean filters: first check that there are no drivers
// in the local and worktree scopes, otherwise fall back to --cached.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, rmSync, statSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sanitize } from '../core/backend.ts'
import { errResult, okResult } from '../core/types.ts'
import type { Result, CommitIntent, AddStep, DiffSource } from '../core/types.ts'

export const GIT_FLAGS: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false',
  '-c', 'diff.external=',
  '-c', 'core.pager=cat',
  '-c', 'color.ui=false',
  '-c', 'core.quotepath=off',
  '-c', 'log.showSignature=false',
  // Second barrier against lazy fetch (below, GIT_NO_LAZY_FETCH) for the gits that do
  // not know the variable: no transport allowed. By name too, because
  // protocol.<name>.allow in .git/config would win over protocol.allow.
  '-c', 'protocol.allow=never',
  ...['file', 'git', 'ssh', 'http', 'https', 'ext', 'fd'].flatMap((p) => ['-c', `protocol.${p}.allow=never`]),
  '--no-pager',
]

// --src-prefix and --dst-prefix: the diff parser recognizes renames and paths from the
// a/ and b/ prefixes, which diff.noprefix or diff.mnemonicPrefix would change.
// Submodules: to know whether a submodule's working tree is dirty git runs
// `git status` inside the submodule, with its config, and its clean filters start
// (localDrivers() looks only at the superproject); diff.submodule=diff does the same
// with an inner `git diff`. --ignore-submodules=dirty looks only at the recorded
// commit (the gitlink), --submodule=short shows it as two shas. Changes inside a
// submodule are not reviewed: the change of commit is.
export const SUBMODULE_FLAGS: readonly string[] = ['--ignore-submodules=dirty']
export const DIFF_FLAGS: readonly string[] = [
  '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative',
  ...SUBMODULE_FLAGS, '--submodule=short',
]

export const MAX_COMMAND_MS = 10_000

// Output of the commands that are not a diff (config, rev-parse, log): small by nature.
const OUTPUT_CAP = 1024 * 1024
// A diff without a cap given by the caller: the same maximum as max_diff_bytes.
const DIFF_CAP = 100_000_000

// Git reference accepted by the CLI and the skill: no spaces, no options.
export const RE_REF = /^[A-Za-z0-9._/@^~-]{1,200}$/

// Drivers that git starts on its own when reading the working tree or showing a diff.
const RE_DRIVER = '^(filter|diff)\\..*\\.(clean|smudge|process|textconv|command)$'

// The environment of the git processes: only what is needed to find git and the
// user's global configuration, plus what the caller asks for (GIT_INDEX_FILE).
// GIT_NO_LAZY_FETCH: in a "partial clone" repo a missing object starts a fetch from
// the promisor remote, that is, the transport .git/config chooses
// (remote.<name>.uploadpack, core.sshCommand…): arbitrary commands outside the
// sandbox. jev-hooks never downloads anything: if an object is missing, the diff fails
// and the review does not happen (visible fail-open).
export function gitEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }
  if (base.PATH) env.PATH = base.PATH
  if (base.HOME) env.HOME = base.HOME
  return { ...env, ...extra }
}

export interface GitOptions {
  cwd: string
  deadline: number                        // on the performance.now() scale
  maxBytes?: number
  env?: NodeJS.ProcessEnv            // where PATH and HOME come from (the tests change it)
  extraEnv?: Record<string, string>
}

export interface GitOutput { code: number; stdout: string; stderr: string; truncated: boolean }

function commandLine(args: readonly string[]): string {
  return `git ${args.find((a) => !a.startsWith('-')) ?? ''}`.trim()
}

// A git command with the safety flags. An exit code other than 0 is not an error here:
// for --quiet it means "there are differences", for config --get-regexp "no entry".
export function git(args: readonly string[], o: GitOptions): Result<GitOutput> {
  const rest = o.deadline - performance.now()
  if (rest < 50) return errResult('timeout', `review time used up before ${commandLine(args)}`)
  const cap = o.maxBytes ?? OUTPUT_CAP
  const r = spawnSync('git', [...GIT_FLAGS, ...args], {
    cwd: o.cwd,
    env: gitEnv(o.env, o.extraEnv),
    timeout: Math.floor(Math.min(MAX_COMMAND_MS, rest)),
    maxBuffer: cap + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const errorCode = (r.error as NodeJS.ErrnoException | undefined)?.code
  if (errorCode === 'ENOENT') return errResult('git', 'git not found in PATH')
  if (errorCode === 'ETIMEDOUT') {
    return errResult('timeout', `${commandLine(args)} did not answer within ${Math.round(Math.min(MAX_COMMAND_MS, rest) / 100) / 10} s`)
  }
  const out = r.stdout ?? Buffer.alloc(0)
  const truncated = errorCode === 'ENOBUFS' || out.length > cap
  if (r.error && !truncated) return errResult('git', `${commandLine(args)}: ${sanitize(r.error.message, '', 300)}`)
  // Beyond the cap one extra byte is kept: whoever reads the diff sees that it is truncated.
  const stdout = (truncated ? out.subarray(0, cap + 1) : out).toString('utf8')
  const stderr = sanitize((r.stderr ?? Buffer.alloc(0)).toString('utf8'), '', 300)
  return okResult({ code: truncated ? 0 : r.status ?? 1, stdout, stderr, truncated })
}

// git's message is not passed on: it repeats values from the repo's .git/config ("bad
// numeric config value '<any text>'"), branch and file names, and the error ends up
// in the result, in the CLI and in the notes Claude reads. What is left is the
// command with its exit code: whoever has to fix it runs it again in the terminal.
function failed<T>(args: readonly string[], u: GitOutput): Result<T> {
  return errResult('git', `${commandLine(args)} failed (exit ${u.code}): run it again in the terminal to see git's message`)
}

// The output of a command that must succeed.
function succeeded(args: readonly string[], o: GitOptions): Result<GitOutput> {
  const e = git(args, o)
  if (!e.ok) return e
  return e.value.code === 0 ? e : failed(args, e.value)
}

// ─── Questions to the repo ────────────────────────────────────────────────────

export function repoRoot(cwd: string, deadline: number, env?: NodeJS.ProcessEnv): string | null {
  const e = git(['rev-parse', '--show-toplevel'], { cwd, deadline, env })
  if (!e.ok || e.value.code !== 0) return null
  const r = e.value.stdout.replace(/\n$/, '')
  return r === '' ? null : r
}

// Filter and diff drivers in the local and worktree scopes (--local alone does not
// read .git/config.worktree with extensions.worktreeConfig). The global ones were
// written by the user, not by the repo.
export function localDrivers(cwd: string, deadline: number, env?: NodeJS.ProcessEnv): Result<string[]> {
  const args = ['config', '--show-scope', '--includes', '--get-regexp', RE_DRIVER]
  const e = git(args, { cwd, deadline, env })
  if (!e.ok) return e
  if (e.value.code === 1) return okResult([])
  if (e.value.code !== 0) return failed(args, e.value)
  const found: string[] = []
  for (const line of e.value.stdout.split('\n')) {
    const m = /^(\S+)\t(\S+)/.exec(line)
    if (m && (m[1] === 'local' || m[1] === 'worktree') && !found.includes(m[2])) found.push(m[2])
  }
  return okResult(found)
}

function hasCommit(ref: string, o: GitOptions): boolean {
  const e = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], o)
  return e.ok && e.value.code === 0
}

// The empty tree, for the diff of a repo without commits (sha1 or sha256 depending on the repo).
function emptyTree(o: GitOptions): Result<string> {
  const e = succeeded(['hash-object', '-t', 'tree', '/dev/null'], o)
  return e.ok ? okResult(e.value.stdout.trim()) : e
}

// Title and description from the commit messages: with one commit, first line
// and rest; with several commits, the title of the most recent and the list of titles.
export function titleFromMessages(commitMessages: string[]): { title: string; description: string | null } {
  const full = commitMessages.map((m) => m.replace(/\r\n/g, '\n').trim()).filter((m) => m !== '')
  if (full.length === 0) return { title: '', description: null }
  const firstLine = (m: string): string => m.split('\n')[0].trim()
  if (full.length === 1) {
    const rest = full[0].split('\n').slice(1).join('\n').trim()
    return { title: firstLine(full[0]), description: rest === '' ? null : rest }
  }
  return { title: firstLine(full[0]), description: full.map((m) => `- ${firstLine(m)}`).join('\n') }
}

function commitMessages(range: string, o: GitOptions): Result<string[]> {
  const e = succeeded(['log', '--no-show-signature', '--no-color', '--format=%B%x00', '--end-of-options', range, '--'], o)
  if (!e.ok) return e
  return okResult(e.value.stdout.split('\0').map((m) => m.trim()).filter((m) => m !== ''))
}

// ─── Diff sources ─────────────────────────────────────────────────────────────

export interface SourcedDiff { diff: string; title: string; description: string | null; approximate: boolean; note?: string }

export interface SourceOptions {
  maxBytes?: number
  env?: NodeJS.ProcessEnv
  tmpDir?: string                    // where to copy the index for "git add … && git commit" (hook: <data>/tmp)
}

function gitDiff(args: string[], cwd: string, deadline: number, o: SourceOptions): Result<string> {
  const all = ['diff', ...DIFF_FLAGS, ...args]
  const e = succeeded(all, { cwd, deadline, maxBytes: o.maxBytes ?? DIFF_CAP, env: o.env })
  return e.ok ? okResult(e.value.stdout) : e
}

// A diff file named by the user: at most maxBytes + 1 bytes (the rest would not be read
// anyway, and the extra byte says that the diff is truncated).
function readDiffFile(path: string, maxBytes: number): Result<string> {
  let fd: number | undefined
  try {
    if (!statSync(path).isFile()) return errResult('config', `${path}: not a file`)
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024 * 1024))
    let filled = 0
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, null)
      if (n === 0) break
      filled += n
    }
    return okResult(buf.subarray(0, filled).toString('utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return errResult('config', `${path}: file not readable${code ? ` (${code})` : ''}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function readSource(s: DiffSource, cwd: string, deadline: number, o: SourceOptions = {}): Result<SourcedDiff> {
  const go: GitOptions = { cwd, deadline, env: o.env }
  switch (s.kind) {
    case 'text':
      return okResult({ diff: s.diff, title: s.title, description: s.description, approximate: false })
    case 'file': {
      const e = readDiffFile(s.path, o.maxBytes ?? DIFF_CAP)
      return e.ok ? okResult({ diff: e.value, title: '', description: null, approximate: false }) : e
    }
    case 'staged': {
      const e = gitDiff(['--cached'], cwd, deadline, o)
      return e.ok ? okResult({ diff: e.value, title: '', description: null, approximate: false }) : e
    }
    case 'working': {
      const drv = localDrivers(cwd, deadline, o.env)
      if (!drv.ok) return drv
      if (drv.value.length > 0) {
        // the repo's filters would run on the working tree: look only at the index
        const e = gitDiff(['--cached'], cwd, deadline, o)
        if (!e.ok) return e
        // the repo's .git/config picks the driver names: they are only counted
        return okResult({
          diff: e.value, title: '', description: null, approximate: true,
          note: `approximate: local git drivers present (${drv.value.length}), only the index content was reviewed`,
        })
      }
      let base = 'HEAD'
      if (!hasCommit('HEAD', go)) {
        const empty = emptyTree(go)
        if (!empty.ok) return empty
        base = empty.value
      }
      const e = gitDiff([base, '--'], cwd, deadline, o)
      return e.ok ? okResult({ diff: e.value, title: '', description: null, approximate: false }) : e
    }
    case 'ref': {
      if (!RE_REF.test(s.ref) || s.ref.startsWith('-')) return errResult('config', 'invalid git reference')
      const e = gitDiff([`${s.ref}...HEAD`, '--'], cwd, deadline, o)
      if (!e.ok) return e
      const m = commitMessages(`${s.ref}..HEAD`, go)
      if (!m.ok) return m
      return okResult({ diff: e.value, ...titleFromMessages(m.value), approximate: false })
    }
    case 'commit':
      return commitSource(s.intent, cwd, deadline, o)
  }
}

// ─── "commit" source: what the commit will contain ────────────────────────────
//
// The hook runs before the commit: nothing has happened yet, not even the `git add`s of
// the same command. The diff is rebuilt from what git will do:
// - plain commit: the index against HEAD;
// - -a: the working tree of the tracked files against HEAD;
// - paths (git commit -- p): the working tree of those paths, the index of the others
//   stays out of the commit;
// - git add … && git commit (also git stage, also -N): the adds repeated on a copy of
//   the index, then the copy against HEAD, narrowed to the commit's paths if there are
//   any. It is exactly what the commit would contain: a symlink stays a link (new file
//   mode 120000 with the link's text), .gitignore applies, binaries are recognized;
// - --amend: against HEAD's parent.
// Everything that reads the working tree runs the repo's clean filters: with local
// drivers only the index is looked at and the review is "approximate".

const MAX_UNTRACKED = 50
const MAX_UNTRACKED_BYTES = 200 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024

function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

// Reads a repo file without following links: lstat for the type, realpath for the
// directory (a parent can be a link to the outside), O_NOFOLLOW and fstat for the open
// file (a link swapped in after the check does not get through).
function readRepoFile(p: string, realRoot: string, cap: number): Result<Buffer> {
  let fd: number | undefined
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return errResult('config', 'is a symbolic link')
    if (!st.isFile()) return errResult('config', 'not a regular file')
    if (st.size > cap) return errResult('config', `too large (${st.size} bytes, at most ${cap})`)
    if (!isInside(realpathSync(p), realRoot)) return errResult('config', 'is outside the repo')
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)
    const f = fstatSync(fd)
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) return errResult('config', 'changed while being read')
    const buf = Buffer.alloc(Math.min(f.size, cap))
    let filled = 0
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, null)
      if (n === 0) break
      filled += n
    }
    return okResult(buf.subarray(0, filled))
  } catch (err) {
    return errResult('config', `not readable (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// A path as git writes it (quote_c_style with core.quotepath=off).
const GIT_ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v',
}

function gitQuote(p: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return p
  let out = '"'
  for (const c of p) {
    if (Object.hasOwn(GIT_ESCAPES, c)) out += GIT_ESCAPES[c]
    else if (c < ' ' || c === '\x7f') out += `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`
    else out += c
  }
  return `${out}"`
}

// The diff of a new file, in the same format as git diff. null content: binary.
export function newFileDiff(rel: string, mode: string, content: string | null): string {
  const b = gitQuote(`b/${rel}`)
  const lines = [`diff --git ${gitQuote(`a/${rel}`)} ${b}`, `new file mode ${mode}`]
  if (content === null) lines.push(`Binary files /dev/null and ${b} differ`)
  else if (content !== '') {
    const final = content.endsWith('\n')
    const body = (final ? content.slice(0, -1) : content).split('\n')
    lines.push('--- /dev/null', `+++ ${b}${rel.includes(' ') ? '\t' : ''}`, `@@ -0,0 +1${body.length === 1 ? '' : `,${body.length}`} @@`)
    for (const r of body) lines.push(`+${r}`)
    if (!final) lines.push('\\ No newline at end of file')
  }
  return `${lines.join('\n')}\n`
}

// An untracked file read with lstat: a link becomes the link's text, never the file it
// points to (a link to ~/.ssh/id_ed25519 must not get the key read).
function untrackedFile(root: string, realRoot: string, rel: string): string | null {
  const p = join(root, rel)
  let st: Stats
  try {
    st = lstatSync(p)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) {
    try {
      return newFileDiff(rel, '120000', readlinkSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  const parsed = readRepoFile(p, realRoot, MAX_UNTRACKED_BYTES)
  if (!parsed.ok) return null
  const binary = parsed.value.includes(0)
  return newFileDiff(rel, (st.mode & 0o111) !== 0 ? '100755' : '100644', binary ? null : parsed.value.toString('utf8'))
}

function stepsOf(it: CommitIntent): AddStep[] {
  const a = it.adds
  if (!a) return []
  return a.steps ?? [{ paths: a.paths, all: a.all, update: false, force: false }]
}

// The command's adds repeated on a copy of the index (GIT_INDEX_FILE), then the copy
// against the base. The real index is not touched.
function tempIndexDiff(it: CommitIntent, base: string, cwd: string, deadline: number, o: SourceOptions): Result<string> {
  const go: GitOptions = { cwd, deadline, env: o.env }
  const gp = succeeded(['rev-parse', '--git-path', 'index'], go)
  if (!gp.ok) return gp
  const index = resolve(cwd, gp.value.stdout.replace(/\n$/, ''))
  const dir = o.tmpDir ?? tmpdir()
  const indexCopy = join(dir, `index-${process.pid}-${randomBytes(6).toString('hex')}`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let st: Stats | null = null
    try {
      st = lstatSync(index)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    // an index that is a link would be copied by following it: better the fallback
    if (st && !st.isFile()) return errResult('git', 'the repo index is not a regular file')
    if (st) copyFileSync(index, indexCopy, constants.COPYFILE_EXCL)
    const withCopy: GitOptions = { ...go, extraEnv: { GIT_INDEX_FILE: indexCopy } }
    const add = (options: string[], paths: string[]): Result<GitOutput> =>
      succeeded(['-c', 'core.splitIndex=false', 'add', ...options, '--', ...paths], withCopy)
    for (const p of stepsOf(it)) {
      const options: string[] = []
      if (p.force) options.push('--force')
      if (p.all) options.push('--all')
      if (p.update) options.push('--update')
      if (p.intentToAdd) options.push('--intent-to-add')
      const e = add(options, p.paths)
      if (!e.ok) return e
    }
    // -a together with git add: the commit also takes the changes to tracked files,
    // including those just registered with -N. With paths (git commit -- p) the commit
    // takes the working tree of those paths, known to the index after the adds, and
    // nothing else of what is staged.
    if (it.all || it.paths.length > 0) {
      const e = add(['--update'], it.paths)
      if (!e.ok) return e
    }
    const d = succeeded(['diff', ...DIFF_FLAGS, '--cached', base, '--', ...it.paths], { ...withCopy, maxBytes: o.maxBytes ?? DIFF_CAP })
    return d.ok ? okResult(d.value.stdout) : d
  } catch (err) {
    return errResult('git', `temporary index not available (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  } finally {
    rmSync(indexCopy, { force: true })
    rmSync(`${indexCopy}.lock`, { force: true })
  }
}

// Fallback if the index copy or an add fails: the diff of the tracked files among those
// paths, plus the untracked ones (at most 50 of 200 KB) read with lstat.
function fallbackDiff(it: CommitIntent, base: string, cwd: string, root: string, deadline: number, o: SourceOptions):
  Result<{ diff: string; skipped: number }> {
  const go: GitOptions = { cwd, deadline, env: o.env }
  const steps = stepsOf(it)
  // an add without paths (-A, -u) covers the whole tree; a commit with paths takes only
  // those
  const paths = it.paths.length > 0 ? it.paths
    : steps.some((p) => p.paths.length === 0) ? [] : (it.adds?.paths ?? [])
  const tracked = gitDiff([base, '--', ...paths], cwd, deadline, o)
  if (!tracked.ok) return tracked
  const ignored = steps.some((p) => p.force) ? [] : ['--exclude-standard']
  const ls = succeeded(['ls-files', '--others', ...ignored, '--full-name', '-z', '--', ...paths], go)
  if (!ls.ok) return ls
  const names = ls.value.stdout.split('\0').filter((x) => x !== '')
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return errResult('git', 'repo root not readable')
  }
  let diff = tracked.value
  let skipped = Math.max(0, names.length - MAX_UNTRACKED)
  for (const rel of names.slice(0, MAX_UNTRACKED)) {
    const d = untrackedFile(root, realRoot, rel)
    if (d === null) skipped++
    else diff += d
  }
  return okResult({ diff, skipped })
}

// The file of -F: inside the repo, read without following links.
function messageFromFile(path: string, cwd: string, root: string): Result<string> {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return errResult('config', 'repo root not readable')
  }
  const r = readRepoFile(resolve(cwd, path), realRoot, MAX_MESSAGE_BYTES)
  return r.ok ? okResult(r.value.toString('utf8')) : errResult('config', `message file ${r.error.message}`)
}

function commitSource(it: CommitIntent, cwd: string, deadline: number, o: SourceOptions): Result<SourcedDiff> {
  const go: GitOptions = { cwd, deadline, env: o.env }
  const root = repoRoot(cwd, deadline, o.env)
  if (root === null) return errResult('git', 'the commit directory is not in a git repo')
  const notes: string[] = []
  let approximate = false

  const ref = it.amend ? 'HEAD~1' : 'HEAD'
  let base = ref
  if (!hasCommit(ref, go)) {
    const v = emptyTree(go)
    if (!v.ok) return v
    base = v.value
  }

  let drivers: string[] = []
  if (it.paths.length > 0 || it.all || it.adds !== null) {
    const d = localDrivers(cwd, deadline, o.env)
    if (!d.ok) return d
    drivers = d.value
  }
  let diff: Result<string>
  if (drivers.length > 0) {
    diff = gitDiff(['--cached', base, '--', ...it.paths], cwd, deadline, o)
    approximate = true
    notes.push(`approximate: local git drivers present (${drivers.length}), only the index content was reviewed`)
  } else if (it.paths.length > 0 && it.adds === null) {
    diff = gitDiff([base, '--', ...it.paths], cwd, deadline, o)
  } else if (it.adds !== null) {
    // with paths too: a new file added (or registered with -N) in the same command is
    // not in the index yet, and git diff HEAD -- p would not show it
    diff = tempIndexDiff(it, base, cwd, deadline, o)
    if (!diff.ok && diff.error.kind !== 'timeout') {
      const reason = diff.error.message
      const r = fallbackDiff(it, base, cwd, root, deadline, o)
      if (!r.ok) return r
      diff = okResult(r.value.diff)
      approximate = true
      notes.push(`approximate: temporary index not available (${reason}); tracked files from the diff, new files read with lstat`)
      if (r.value.skipped > 0) notes.push(`${r.value.skipped} untracked files not read (beyond ${MAX_UNTRACKED}, over 200 KB or outside the repo)`)
    }
  } else if (it.all) {
    diff = gitDiff([base, '--'], cwd, deadline, o)
  } else {
    diff = gitDiff(['--cached', base, '--'], cwd, deadline, o)
  }
  if (!diff.ok) return diff

  // Title and description from the message: -m, -F inside the repo, or HEAD's for an
  // --amend that reuses it. Without a message, description_matches is not asked.
  let message = it.message
  if (message === undefined && it.messageFile !== undefined) {
    const m = messageFromFile(it.messageFile, cwd, root)
    if (m.ok) message = m.value
    else notes.push(`commit message not read: ${m.error.message}`)
  }
  if (message === undefined && it.amend) {
    const m = git(['log', '-1', '--no-show-signature', '--no-color', '--format=%B', '--end-of-options', 'HEAD', '--'], go)
    if (m.ok && m.value.code === 0) message = m.value.stdout
  }
  const { title, description } = message !== undefined ? titleFromMessages([message]) : { title: '', description: null }
  const out: SourcedDiff = { diff: diff.value, title, description, approximate }
  if (notes.length > 0) out.note = notes.join('; ')
  return okResult(out)
}

// Source without arguments: the staged changes; otherwise the uncommitted
// ones; otherwise the branch against the main branch (merge-base), or the last commit
// if already on the main branch.
export function defaultSource(cwd: string, deadline: number, env?: NodeJS.ProcessEnv): Result<{ source: DiffSource; note: string }> {
  const o: GitOptions = { cwd, deadline, env }
  const staged = git(['diff', ...DIFF_FLAGS, '--cached', '--quiet'], o)
  if (!staged.ok) return staged
  if (staged.value.code === 1) return okResult({ source: { kind: 'staged' }, note: 'source: staged changes' })
  if (staged.value.code !== 0) return failed(['diff'], staged.value)

  const withHead = hasCommit('HEAD', o)
  const drv = localDrivers(cwd, deadline, env)
  if (!drv.ok) return drv
  if (withHead && drv.value.length === 0) {
    const working = git(['diff', ...DIFF_FLAGS, 'HEAD', '--quiet', '--'], o)
    if (!working.ok) return working
    if (working.value.code === 1) return okResult({ source: { kind: 'working' }, note: 'source: uncommitted changes' })
  }
  if (!withHead) return errResult('git', 'nothing to review: no staged changes and no commits')

  const main = mainBranch(o)
  const current = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], o)
  const currentName = current.ok && current.value.code === 0 ? current.value.stdout.trim() : ''
  if (main !== null && currentName !== main.replace(/^origin\//, '') && !sameCommit(main, 'HEAD', o)) {
    // the cloned repo's remote picks the branch of origin/HEAD: it is named only if it
    // is one of the two the code knows
    const name = /^(origin\/)?(main|master)$/.test(main) ? main : "origin's main branch"
    return okResult({ source: { kind: 'ref', ref: main }, note: `source: ${name}...HEAD` })
  }
  if (hasCommit('HEAD~1', o)) return okResult({ source: { kind: 'ref', ref: 'HEAD~1' }, note: 'source: last commit (HEAD~1...HEAD)' })
  return errResult('git', 'nothing to review: no changes and a single commit')
}

function mainBranch(o: GitOptions): string | null {
  const remote = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], o)
  if (remote.ok && remote.value.code === 0 && RE_REF.test(remote.value.stdout.trim())) return remote.value.stdout.trim()
  for (const name of ['main', 'master']) if (hasCommit(`refs/heads/${name}`, o)) return name
  return null
}

function sameCommit(a: string, b: string, o: GitOptions): boolean {
  const x = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${a}^{commit}`], o)
  const y = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${b}^{commit}`], o)
  return x.ok && y.ok && x.value.code === 0 && x.value.stdout.trim() === y.value.stdout.trim()
}

// Content of a file as it is in HEAD, or null if it is not in HEAD.
export function fileAtHead(path: string, cwd: string, deadline: number, env?: NodeJS.ProcessEnv): Result<string | null> {
  const args = ['show', '--no-show-signature', '--no-textconv', '--end-of-options', `HEAD:${path}`]
  const e = git(args, { cwd, deadline, env })
  if (!e.ok) return e
  if (e.value.code !== 0) return okResult(null)
  return okResult(e.value.stdout)
}

// Files under a directory that differ from HEAD: staged, modified, deleted or
// untracked. The paths are relative to the repo root.
export function changedFromHead(dir: string, cwd: string, deadline: number, env?: NodeJS.ProcessEnv): Result<string[]> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no', '--no-renames', ...SUBMODULE_FLAGS, '--', dir]
  const e = succeeded(args, { cwd, deadline, env })
  if (!e.ok) return e
  const out: string[] = []
  for (const item of e.value.stdout.split('\0')) {
    if (item.length < 4) continue
    const p = item.slice(3)
    if (!out.includes(p)) out.push(p)
  }
  return okResult(out)
}
