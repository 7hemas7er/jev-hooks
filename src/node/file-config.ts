// Finds and reads the configuration files of the three layers and hands them
// to the core, which composes them (composeConfig): here there is only the I/O, and the
// trust rules that depend on the disk.
// - Plugin (config/) and user (${XDG_CONFIG_HOME:-~/.config}/jev-hooks/) are trusted:
//   Claude does not write to ~/.config from the sandbox.
// - The project (.jev-hooks/) is not: a cloned repo writes it, or Claude after an
//   injection. Its files are read only if they are regular files (a link to ~/.ssh
//   would end up in a JSON.parse error message), and if they differ from HEAD, even
//   untracked, the hook and the skill use the HEAD version: a `sed` through Bash does
//   not silently loosen the rules. The user runs the CLI, and it uses the working tree
//   with a note.
// The guardrail mask map and the key file are read here too.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { keyFromFileText } from '../core/backend.ts'
import { composeConfig } from '../core/config.ts'
import { parseMaskMap } from '../core/mask.ts'
import { userConfigDir as configHome } from '../core/router.ts'
import type { ReviewConfig, MaskPair, Failure, Result, ConfigFile, ConfigLayers, Origin, Problem } from '../core/types.ts'
import { errResult } from '../core/types.ts'
import { changedFromHead, localDrivers, fileAtHead, repoRoot } from './git.ts'

export const CONFIG_NAMES = ['checks', 'policy', 'calibration'] as const
type ConfigName = typeof CONFIG_NAMES[number]

export const PROJECT_DIR = '.jev-hooks'

// A configuration JSON larger than this is not a configuration.
const FILE_CAP = 1024 * 1024
const KEY_CAP = 64 * 1024

// Time for the configuration's git commands when the caller gives no deadline.
const GIT_TIME_MS = 20_000

export interface ConfigOptions {
  cwd: string
  pluginRoot: string
  origin: Origin
  projectDir?: string                    // default: root of the git repo, otherwise cwd
  userDir?: string                      // the CLI's --config-dir: it counts as the user layer
  deadline?: number                       // on the performance.now() scale
  env?: NodeJS.ProcessEnv
}

export interface LoadedConfig extends ReviewConfig {
  warnings: string[]
  modifiedRules: string[]              // files of .jev-hooks/ that differ from HEAD (untracked included)
  userProblems: Problem[]              // invalid user files: the CLI exits with 4
}

// ─── Plugin version ───────────────────────────────────────────────────────────

// The version in .claude-plugin/plugin.json, or '?'. It enters the hook's cache key (an
// update invalidates it), the log line and the status: a session keeps the plugin it
// started with, and the configuration hashes alone do not say which one that was.
export function pluginVersion(root: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : '?'
  } catch {
    return '?'
  }
}

// A newer version of this plugin next to the running one in Claude Code's plugin cache
// (<cache>/<marketplace>/<plugin>/<version>/). /plugin update downloads it, but a running
// session keeps the version it loaded until /reload-plugins: on 2026-10-03, 85 of the
// 102 reviews since 2026-10-01 had run a version older than the installed one. Null when the root is not a version directory (a --plugin-dir checkout), when
// nothing newer is there, or on any error: it only adds a notice.
export function newerInstalledVersion(root: string): string | null {
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
  const parse = (v: string): number[] | null => {
    const m = SEMVER.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const newer = (a: number[], b: number[]): boolean => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
  try {
    const dir = root.replace(/[\\/]+$/, '')
    if (!SEMVER.test(basename(dir))) return null
    const current = parse(pluginVersion(dir))
    if (current === null) return null
    let best: { v: string; n: number[] } | null = null
    for (const name of readdirSync(dirname(dir))) {
      const n = parse(name)
      if (n === null || !newer(n, best?.n ?? current)) continue
      // a directory that holds that version's manifest, not a stray folder
      if (pluginVersion(join(dirname(dir), name)) !== name) continue
      best = { v: name, n }
    }
    return best?.v ?? null
  } catch {
    return null
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir()
}

// XDG: a relative variable does not count (XDG Base Directory specification).
function xdg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name]
  return v !== undefined && v !== '' && isAbsolute(v) ? v : join(homeDir(env), fallback)
}

// The router looks up the same directory through $.fs, with the same rule (on the
// platforms the plugin supports, "absolute" is "starts with /").
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env.XDG_CONFIG_HOME, homeDir(env)) ?? '.config', 'jev-hooks')
}

export function xdgStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(xdg(env, 'XDG_STATE_HOME', join('.local', 'state')), 'jev-hooks')
}

// A path for messages and sources: "~/.config/jev-hooks/policy.json".
export function displayPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const h = homeDir(env)
  if (h !== '' && h !== sep && (p === h || p.startsWith(h + sep))) return `~${p.slice(h.length)}`
  return p
}

// ─── Reading files ────────────────────────────────────────────────────────────

// null = the file is not there. trusted = links are followed (user and plugin layers);
// for the project the file is opened with O_NOFOLLOW and checked through the
// descriptor, so a link swapped in for the file between the check and the read does
// not get through.
function readFile(path: string, trusted: boolean, cap: number = FILE_CAP): Result<string | null> {
  let fd: number | undefined
  try {
    fd = openSync(path, trusted ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile()) return errResult('config', 'not a regular file')
    if (st.size > cap) return errResult('config', `too large (${st.size} bytes, at most ${cap})`)
    return { ok: true, value: readFileSync(fd, 'utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: null }
    if (code === 'ELOOP') return errResult('config', 'is a symbolic link: only regular files are read from the project')
    return errResult('config', `not readable (${code ?? 'error'})`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// A project directory that is a link would lead to reading rules from outside the repo.
function isSymlinkDir(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// ─── Guardrail mask map and key ───────────────────────────────────────────────

// Same lookup as guardrail (mask.map_path): GUARDRAIL_MASK_MAP, otherwise
// ~/.config/guardrail/mask.tsv. A map that exists but cannot be read stops sending to
// non-local backends: better to send nothing than to send in clear text.
export function loadMaskMap(env: NodeJS.ProcessEnv = process.env): { maskMap: MaskPair[] | null; error?: Failure } {
  const path = env.GUARDRAIL_MASK_MAP !== undefined && env.GUARDRAIL_MASK_MAP !== ''
    ? env.GUARDRAIL_MASK_MAP
    : join(homeDir(env), '.config', 'guardrail', 'mask.tsv')
  const parsed = readFile(path, true, 4 * FILE_CAP)
  const where = displayPath(path, env)
  if (!parsed.ok) return { maskMap: null, error: { kind: 'mask_map', message: `guardrail mask map ${where} ${parsed.error.message}` } }
  if (parsed.value === null) return { maskMap: null }
  const m = parseMaskMap(parsed.value)
  if (!m.ok) return { maskMap: null, error: { kind: 'mask_map', message: `${m.error.message} (${where})` } }
  return { maskMap: m.value.length > 0 ? m.value : null }
}

// The key file: one line, 0600, fallback for api_key and JEV_HOOKS_KEY. A file
// readable by others is used anyway, with a warning.
export function readKeyFile(env: NodeJS.ProcessEnv = process.env): { key?: string; warning?: string } {
  const path = join(userConfigDir(env), 'key')
  let mode = 0
  try {
    mode = statSync(path).mode
  } catch {
    return {}
  }
  const parsed = readFile(path, true, KEY_CAP)
  const where = displayPath(path, env)
  if (!parsed.ok) return { warning: `key file ${where} ${parsed.error.message}` }
  const line = keyFromFileText(parsed.value)
  const out: { key?: string; warning?: string } = {}
  if (line !== undefined) out.key = line
  if ((mode & 0o077) !== 0) out.warning = `key file ${where} readable by other users: chmod 600`
  return out
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function fileName(n: ConfigName): string {
  return `${n}.json`
}

// The files of .jev-hooks/ that differ from HEAD, for a message. Whoever writes to the
// repo picks the names (even an untracked file, with newlines or bidi characters in
// its name), and the message ends up in the reason of a deny, which Claude reads: only
// the names of the configuration files are quoted, the others are counted.
const KNOWN_NAMES: readonly string[] = [...CONFIG_NAMES.map(fileName), 'router.json']

export function describeModifiedRules(files: readonly string[]): string {
  const known = KNOWN_NAMES.filter((n) => files.includes(n))
  const others = files.filter((f) => !KNOWN_NAMES.includes(f)).length
  if (others === 0) return known.join(', ')
  if (known.length === 0) return `${others} ${others === 1 ? 'file' : 'files'}`
  return `${known.join(', ')} and ${others === 1 ? 'one more file' : `${others} more files`}`
}

export function loadConfig(o: ConfigOptions): Result<LoadedConfig> {
  const env = o.env ?? process.env
  const deadline = o.deadline ?? performance.now() + GIT_TIME_MS
  const warnings: string[] = []
  const userProblems: Problem[] = []
  const show = (p: string): string => displayPath(p, env)

  // Plugin: all the defaults must be there; without them, the plugin is broken.
  const plugin: Partial<Record<ConfigName, ConfigFile>> = {}
  for (const n of CONFIG_NAMES) {
    const path = join(o.pluginRoot, 'config', fileName(n))
    const parsed = readFile(path, true)
    if (!parsed.ok || parsed.value === null) {
      return errResult('config', `plugin configuration missing or unreadable: ${show(path)}${parsed.ok ? '' : ` (${parsed.error.message})`}`)
    }
    plugin[n] = { path: show(path), text: parsed.value }
  }

  // User (or --config-dir): trusted, in full.
  const userDir = o.userDir ?? userConfigDir(env)
  const user: ConfigLayers['user'] = {}
  for (const n of CONFIG_NAMES) {
    const path = join(userDir, fileName(n))
    const parsed = readFile(path, true)
    if (!parsed.ok) {
      const message = `${show(path)}: ${parsed.error.message}`
      warnings.push(`${message}: using the plugin defaults`)
      userProblems.push({ file: show(path), pointer: '', message: parsed.error.message })
    } else if (parsed.value !== null) user[n] = { path: show(path), text: parsed.value }
  }

  // Project: .jev-hooks/ in the repo root, compared with HEAD.
  const root = repoRoot(o.cwd, deadline, env)
  const projectDir = o.projectDir ?? root ?? o.cwd
  const dir = join(projectDir, PROJECT_DIR)
  const project: ConfigLayers['project'] = {}
  let modifiedRules: string[] = []
  // the files to take from HEAD: the modified ones, or all of them if the comparison
  // cannot be made (local drivers), without saying that they differ
  let toReadAtHead: string[] = []
  let fromHead = false
  const relFromRoot = root !== null ? relative(root, dir).split(sep).join('/') : null
  const inRepo = relFromRoot !== null && relFromRoot !== '' && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)
  if (root !== null && inRepo) {
    const drv = localDrivers(root, deadline, env)
    if (!drv.ok || drv.value.length > 0) {
      // git status would read the working tree through the repo's filters: no
      // comparison, and where it matters (hook and skill) HEAD is taken anyway
      warnings.push(`${PROJECT_DIR}/ not compared with HEAD (${drv.ok ? 'local git drivers present' : drv.error.message})`)
      fromHead = o.origin !== 'cli'
      if (fromHead) toReadAtHead = CONFIG_NAMES.map(fileName)
    } else {
      const different = changedFromHead(relFromRoot, root, deadline, env)
      if (!different.ok) warnings.push(`${PROJECT_DIR}/ not compared with HEAD: ${different.error.message}`)
      else {
        modifiedRules = different.value.map((p) => p.slice(relFromRoot.length + 1)).filter((p) => p !== '').sort()
        fromHead = modifiedRules.length > 0 && o.origin !== 'cli'
        if (fromHead) toReadAtHead = modifiedRules
        if (modifiedRules.length > 0) {
          warnings.push(o.origin === 'cli'
            ? `rules in ${PROJECT_DIR}/ differ from HEAD (${describeModifiedRules(modifiedRules)}): the CLI uses the working tree ones`
            : `reviewer rules modified and not committed: ${describeModifiedRules(modifiedRules)}; verdict computed with the HEAD rules`)
        }
      }
    }
  }
  const link = isSymlinkDir(dir)
  if (link) warnings.push(`${PROJECT_DIR}/ is a symbolic link: project rules ignored`)
  for (const n of CONFIG_NAMES) {
    const rel = `${PROJECT_DIR}/${fileName(n)}`
    // the HEAD version is read from git, whatever is in the working tree
    if (fromHead && relFromRoot !== null && root !== null && toReadAtHead.includes(fileName(n))) {
      const h = fileAtHead(`${relFromRoot}/${fileName(n)}`, root, deadline, env)
      if (!h.ok) warnings.push(`${rel} (HEAD): ${h.error.message}: using the base`)
      else if (h.value !== null) project[n] = { path: `${rel} (HEAD)`, text: h.value }
      continue
    }
    if (link) continue
    const parsed = readFile(join(dir, fileName(n)), false)
    if (!parsed.ok) warnings.push(`${rel}: ignored, ${parsed.error.message}`)
    else if (parsed.value !== null) project[n] = { path: rel, text: parsed.value }
  }

  const composed = composeConfig({
    plugin: { checks: plugin.checks as ConfigFile, policy: plugin.policy as ConfigFile, calibration: plugin.calibration as ConfigFile },
    user,
    project,
  })
  if (!composed.ok) return composed
  const c = composed.value
  for (const a of c.warnings) if (!warnings.includes(a)) warnings.push(a)
  for (const p of c.userProblems) userProblems.push(p)

  const m = loadMaskMap(env)
  if (m.error) warnings.push(`${m.error.message}: nothing is sent to non-local backends`)
  const out: LoadedConfig = {
    checks: c.checks,
    policy: c.policy,
    calibration: c.calibration,
    maskMap: m.maskMap,
    sources: c.sources,
    warnings,
    modifiedRules,
    userProblems,
  }
  if (m.error) out.maskMapError = m.error
  return { ok: true, value: out }
}
