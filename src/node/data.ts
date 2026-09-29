// The plugin's state dir: log, cache, escalation, pending commit files, notices
// already given. Everything with 0700 permissions on the directory and 0600 on the
// files, because the logs contain repo names and fingerprints, and atomic writes
// (temporary file + rename): two hooks in parallel must not leave a half-written JSON.
//
// Diff, title, description, prompt, key or headers never enter the logs: only numbers,
// ids, shas and the backend's identity, that is, the material for the calibration fit.
import { createHash } from 'node:crypto'
import {
  appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Identity, ReviewResult } from '../core/types.ts'
import { xdgStateDir } from './file-config.ts'

export const LOG_FILE = 'log.jsonl'
export const MAX_LOG_BYTES = 2 * 1024 * 1024

// CLAUDE_PLUGIN_DATA in the hooks (persistent, per plugin), otherwise
// ${XDG_STATE_HOME:-~/.local/state}/jev-hooks.
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.CLAUDE_PLUGIN_DATA
  return d !== undefined && d !== '' ? d : xdgStateDir(env)
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

let counter = 0

// Atomic write: the temporary file is in the same directory (rename does not cross
// filesystems) and already has its final permissions before it receives the content.
export function writeAtomic(file: string, content: string): void {
  const dir = dirname(file)
  ensureDir(dir)
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${++counter}.tmp`)
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

// A JSON state file, or undefined if it is missing or broken: state is a convenience,
// never a reason to fail.
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileCapped(file, 1024 * 1024))
  } catch {
    return undefined
  }
}

function readFileCapped(file: string, cap: number): string {
  const fd = openSync(file, 'r')
  try {
    const n = Math.min(fstatSync(fd).size, cap)
    const buf = Buffer.alloc(n)
    let filled = 0
    while (filled < n) {
      const k = readSync(fd, buf, filled, n - filled, null)
      if (k === 0) break
      filled += k
    }
    return buf.subarray(0, filled).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// One line at the end of the log. Appending a short line is a single write with
// O_APPEND: two processes do not mix their lines, and a rename would not help (it would
// have to reread and rewrite the whole file). Beyond MAX_LOG_BYTES the file moves to
// log.1.jsonl and a new one is started.
export function appendLog(file: string, line: unknown, o: { maxBytes?: number } = {}): void {
  ensureDir(dirname(file))
  try {
    if (statSync(file).size >= (o.maxBytes ?? MAX_LOG_BYTES)) {
      const oldPath = file.endsWith('.jsonl') ? `${file.slice(0, -'.jsonl'.length)}.1.jsonl` : `${file}.1`
      renameSync(file, oldPath)
    }
  } catch {
    // the log does not exist yet
  }
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // a file that is not ours stays as it is: the line is written
  }
}

// Local date with the time zone: "2026-10-02T10:00:00+02:00", as in the log line.
export function localIso(d: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
    + `${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`
}

// The log keeps four decimals; render.ts rounds what people read to three.
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

// The log line of a review. No file paths: only the counts.
// identity: model and fingerprint as the backend declared them, when the caller has
// them (runReview). The result carries them as a hash if the trusted configuration
// does not know them, because it goes out to Claude; the log is the material for the
// calibration fit, and a profile is bound to the real fingerprint.
export function logLine(
  r: ReviewResult,
  o: { origin: string; session?: string; repo?: string; version?: string; ts?: Date; identity?: Pick<Identity, 'model' | 'fingerprint'> },
): Record<string, unknown> {
  const values: Record<string, { raw?: number; cal: number }> = {}
  for (const [id, v] of Object.entries(r.values)) {
    values[id] = v.raw !== undefined ? { raw: round4(v.raw), cal: round4(v.value) } : { cal: round4(v.value) }
  }
  const questions: Record<string, string> = {}
  const sha: Record<string, unknown> = {}
  for (const [k, h] of Object.entries(r.config_hashes)) {
    if (k.startsWith('question.')) questions[k.slice('question.'.length)] = h
    else sha[k] = h
  }
  sha.questions = questions
  const backend: Record<string, unknown> = { host: r.backend.host, calibrated: r.backend.calibrated }
  const model = o.identity?.model ?? r.backend.model
  const fingerprint = o.identity ? o.identity.fingerprint : r.backend.fingerprint
  if (model !== undefined) backend.model = model
  if (fingerprint !== undefined) backend.fingerprint = fingerprint
  if (r.backend.profile !== undefined) backend.profile = r.backend.profile
  if (r.backend.mode !== undefined) backend.mode = r.backend.mode
  const line: Record<string, unknown> = { ts: localIso(o.ts), origin: o.origin }
  if (o.session !== undefined) line.session = o.session
  if (o.repo !== undefined) line.repo = o.repo
  if (o.version !== undefined) line.plugin_version = o.version
  Object.assign(line, {
    outcome: r.outcome,
    lane: r.lane ?? null,
    backend,
    shape: r.shape,
    requests: r.requests,
    ms: Math.round(r.ms),
    files: { examined: r.files.examined.length, ignored: r.files.ignored.length, omitted: r.files.omitted.length },
    redactions: r.redactions,
    values,
    detectors: [...new Set(r.hits.map((c) => c.detector))],
    escalation: r.escalation.map((v) => v.check ?? v.reason),
    sha,
  })
  if (r.error) line.error = r.error.kind
  return line
}

// The last review recorded in a log (the most recent valid line with a backend), for
// `explain`. Only the tail of the file is read.
export function lastReview(file: string): { profile?: string; mode?: string; ts?: string } | undefined {
  let text: string
  try {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const n = Math.min(size, 256 * 1024)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, size - n)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const lines = text.split('\n').filter((r) => r.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: unknown
    try {
      v = JSON.parse(lines[i])
    } catch {
      continue
    }
    const b = (v as { backend?: { profile?: unknown; mode?: unknown } } | null)?.backend
    if (b && typeof b.profile === 'string') {
      const out: { profile?: string; mode?: string; ts?: string } = { profile: b.profile }
      if (typeof b.mode === 'string') out.mode = b.mode
      const ts = (v as { ts?: unknown }).ts
      if (typeof ts === 'string') out.ts = ts
      return out
    }
  }
  return undefined
}

// ─── Directories of entries with a deadline ──────────────────────────────────

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Removes the expired entries and, beyond the maximum, the oldest ones. The entries are
// the directory's .json files, dated by their mtime; keep excludes one of them (the
// cache's fingerprint index).
export function prune(dir: string, o: { max: number; deadlineMs: number; now?: number; keep?: string }): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = o.now ?? Date.now()
  const items: { file: string; t: number }[] = []
  for (const n of names) {
    if (!n.endsWith('.json') || n === o.keep) continue
    const file = join(dir, n)
    try {
      const t = statSync(file).mtimeMs
      if (now - t > o.deadlineMs) rmSync(file, { force: true })
      else items.push({ file, t })
    } catch {
      // gone in the meantime: another hook pruned first
    }
  }
  if (items.length <= o.max) return
  items.sort((a, b) => a.t - b.t)
  for (const v of items.slice(0, items.length - o.max)) rmSync(v.file, { force: true })
}

function isFresh(file: string, deadlineMs: number, now: number): boolean {
  try {
    return now - statSync(file).mtimeMs <= deadlineMs
  } catch {
    return false
  }
}

// ─── Cache of the hook's reviews ──────────────────────────────────────────────

export const MAX_CACHE_ENTRIES = 200
const FINGERPRINT_FILE = 'fingerprint.json'

// A review already done on the same diff, with the same configuration and the same
// backend: a new commit attempt gets an answer right away.
export function readCache(dataDir: string, key: string, deadlineMin: number, now: number = Date.now()): ReviewResult | undefined {
  if (deadlineMin <= 0) return undefined
  const file = join(dataDir, 'cache', `${key}.json`)
  if (!isFresh(file, deadlineMin * 60_000, now)) return undefined
  const v = readJsonFile(file) as { result?: ReviewResult } | undefined
  return v?.result?.outcome === 'ok' ? v.result : undefined
}

// Only ok outcomes: an error, an incomplete or approximate review is not reused (the
// caller decides for the approximate ones, which the result does not tell apart).
export function writeCache(dataDir: string, key: string, r: ReviewResult, deadlineMin: number): void {
  if (r.outcome !== 'ok' || deadlineMin <= 0) return
  const dir = join(dataDir, 'cache')
  writeAtomic(join(dir, `${key}.json`), JSON.stringify({ result: r }))
  prune(dir, { max: MAX_CACHE_ENTRIES, deadlineMs: deadlineMin * 60_000, keep: FINGERPRINT_FILE })
}

// The fingerprint seen in the last response of each URL (or the model, without a
// fingerprint): it enters the cache key, so a different quantization behind the same
// URL invalidates the entries from the first review that sees it.
export function seenFingerprint(dataDir: string, url: string): string {
  const v = readJsonFile(join(dataDir, 'cache', FINGERPRINT_FILE)) as Record<string, unknown> | undefined
  const x = v !== undefined && typeof v === 'object' && v !== null && Object.hasOwn(v, url) ? v[url] : undefined
  return typeof x === 'string' ? x : ''
}

export function recordFingerprint(dataDir: string, url: string, hash: string): void {
  const file = join(dataDir, 'cache', FINGERPRINT_FILE)
  const v = readJsonFile(file)
  const byUrl: Record<string, string> = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, string>) } : {}
  if (byUrl[url] === hash) return
  byUrl[url] = hash
  // few URLs per user; the cap only keeps the file from growing without end
  const keys = Object.keys(byUrl)
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete byUrl[k]
  writeAtomic(file, JSON.stringify(byUrl))
}

// ─── Escalations already denied (deny_then_allow, deny_then_ask) ──────────────

export const MAX_ESCALATION_ENTRIES = 100

// true if this escalation already had its deny within ttl_min: then the lane decides
// (deny_then_allow) or the user does (deny_then_ask). Never two escalation denies for
// the same key, no loops.
export function escalationAlreadyDenied(dataDir: string, key: string, ttlMin: number, now: number = Date.now()): boolean {
  return isFresh(join(dataDir, 'escalation', `${key}.json`), ttlMin * 60_000, now)
}

export function markEscalationDenied(dataDir: string, key: string, ttlMin: number): void {
  const dir = join(dataDir, 'escalation')
  writeAtomic(join(dir, `${key}.json`), JSON.stringify({ ts: localIso() }))
  prune(dir, { max: MAX_ESCALATION_ENTRIES, deadlineMs: ttlMin * 60_000 })
}

// ─── Once-per-session notices ─────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000

// true the first time (session, kind) is seen: the notice must be given. Entries older
// than a day are forgotten.
export function firstNotice(dataDir: string, session: string, kind: string, now: number = Date.now()): boolean {
  const file = join(dataDir, 'notices.json')
  const v = readJsonFile(file)
  const seen: Record<string, number> = {}
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === 'number' && now - t < DAY_MS) seen[k] = t
  }
  const key = `${session}|${kind}`
  if (Object.hasOwn(seen, key)) return false
  seen[key] = now
  try {
    writeAtomic(file, JSON.stringify(seen))
  } catch {
    // without state the notice will be repeated: better than keeping quiet
  }
  return true
}

// ─── Commits pending their outcome ────────────────────────────────────────────

export interface PendingCommit {
  session: string
  head_before: string | null
  review_id: string
  diff_sha: string
  escalation: string[]
  ts: string
  dir: string                        // where to reread HEAD: the commit can be in another repo (git -C, cd)
}

// A file name from the session: the id comes from the hook's input, and must not be
// able to leave the directory.
export function sessionFile(s: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : sha256(s).slice(0, 32)
}

export function writePending(dataDir: string, a: PendingCommit): void {
  writeAtomic(join(dataDir, 'pending', `${sessionFile(a.session)}.json`), JSON.stringify(a))
}

export function readPending(dataDir: string, session: string): PendingCommit | undefined {
  const v = readJsonFile(join(dataDir, 'pending', `${sessionFile(session)}.json`)) as Partial<PendingCommit> | undefined
  if (!v || typeof v !== 'object' || typeof v.review_id !== 'string' || typeof v.dir !== 'string') return undefined
  return {
    session: typeof v.session === 'string' ? v.session : session,
    head_before: typeof v.head_before === 'string' ? v.head_before : null,
    review_id: v.review_id,
    diff_sha: typeof v.diff_sha === 'string' ? v.diff_sha : '',
    escalation: Array.isArray(v.escalation) ? v.escalation.filter((x): x is string => typeof x === 'string') : [],
    ts: typeof v.ts === 'string' ? v.ts : '',
    dir: v.dir,
  }
}

export function removePending(dataDir: string, session: string): void {
  rmSync(join(dataDir, 'pending', `${sessionFile(session)}.json`), { force: true })
}

// The files of closed sessions, or of commits whose PostToolUse never arrived.
export function prunePending(dataDir: string, now: number = Date.now()): void {
  prune(join(dataDir, 'pending'), { max: 10_000, deadlineMs: DAY_MS, now })
}
