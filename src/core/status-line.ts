// The status line under the prompt (hooks/register.ts, the status_line option): the
// version of jev-hooks the session runs, a newer one installed beside it, and the
// outcome of the session's last commit review. A running Claude Code keeps the plugin
// version it loaded until /reload-plugins: between 2026-10-01 and 2026-10-03, 85 of 102
// reviews ran a version older than the installed one, and nothing on screen said so.
// Pure: register.ts reads the plugin cache and the review log through `$` and hands
// names and text here.

export type LastReview = { lane: string; escalation: string[] }
type Version = [number, number, number]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function parse(v: string): Version | null {
  const m = SEMVER.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

const segments = (root: string): string[] => root.replace(/\/+$/, '').split('/')

// The running plugin's folder in Claude Code's plugin cache,
// <cache>/<marketplace>/<plugin>/<x.y.z>: its parent and its version. Null for a folder
// that is not a version, as a --plugin-dir checkout.
export function versionFolder(root: string): { parent: string; version: string } | null {
  const parts = segments(root)
  const version = parts[parts.length - 1] ?? ''
  if (parts.length < 2 || parse(version) === null) return null
  return { parent: parts.slice(0, -1).join('/'), version }
}

// The names beside the running version that are newer versions, newest first, compared
// as numbers (0.100.0 after 0.13.0). register.ts takes the first one that holds a
// manifest: a folder without one is not an installed version.
export function newerVersions(version: string, names: readonly string[]): string[] {
  const current = parse(version)
  if (current === null) return []
  return names
    .map((name) => ({ name, v: parse(name) }))
    .filter((x): x is { name: string; v: Version } => x.v !== null && compare(x.v, current) > 0)
    .sort((a, b) => compare(b.v, a.v))
    .map((x) => x.name)
}

// The plugin's data folder as Claude Code names it, <plugins>/data/<plugin>-<marketplace>,
// from the cache path <plugins>/cache/<marketplace>/<plugin>/<version>. Null for any
// other layout: register.ts first asks for CLAUDE_PLUGIN_DATA.
export function dataFolderOf(root: string): string | null {
  const parts = segments(root)
  const n = parts.length
  if (n < 5 || parts[n - 4] !== 'cache' || parse(parts[n - 1] ?? '') === null) return null
  return [...parts.slice(0, n - 4), 'data', `${parts[n - 2]}-${parts[n - 3]}`].join('/')
}

// The version a plugin.json declares, or null.
export function manifestVersion(text: string): string | null {
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === 'string' && v !== '' ? v : null
  } catch {
    return null
  }
}

// The session's last completed review in the hook's log (log.jsonl: one JSON object per
// line, newest last). Lines of other sessions and other outcomes are skipped, and so is
// a line that does not parse: the log is the plugin's own, but a line cut by a crash
// must not hide the ones before it.
export function lastReview(log: string, session: string): LastReview | null {
  if (session === '') return null
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes(session)) continue
    try {
      const o = JSON.parse(line) as { session?: unknown; outcome?: unknown; lane?: unknown; escalation?: unknown }
      if (o.session !== session || o.outcome !== 'ok' || typeof o.lane !== 'string') continue
      const escalation = Array.isArray(o.escalation) ? o.escalation.filter((x): x is string => typeof x === 'string') : []
      return { lane: o.lane, escalation }
    } catch {
      continue
    }
  }
  return null
}

// A Bash command that may hold a commit: after it the log may have a new review. The
// same first filter as the commit hook's (src/hook/main.ts).
export const mayCommit = (command: string): boolean => command.includes('commit')

export function statusText(o: { running: string; newer?: string | null; last?: LastReview | null }): string {
  const parts = [`jev ${o.running}`]
  if (o.newer) parts.push(`${o.newer} installed: /reload-plugins`)
  if (o.last) {
    parts.push(`last commit ${o.last.lane}${o.last.escalation.length > 0 ? `, escalated ${o.last.escalation.join(', ')}` : ''}`)
  } else {
    parts.push('no commit reviewed yet')
  }
  return parts.join(' · ')
}

// One status line per plugin: the router's text, during a routed turn, goes after this
// one.
export function joinStatus(line: string | undefined, router: string | undefined): string | undefined {
  const parts = [line, router].filter((x): x is string => x !== undefined && x !== '')
  return parts.length > 0 ? parts.join(' · ') : undefined
}
