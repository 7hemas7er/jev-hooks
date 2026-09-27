// Parsing of git's unified diff: files, hunks and added lines with their number.
// The diff is hostile input (in a PR from a fork the author picks every byte), so
// parsing has fixed caps (total bytes, characters per line) and keeps only the lines
// it recognizes: a stray line between two files never reaches the state, where it
// could imitate a section header.
//
// The sources are git (hook, CLI, with the flags of src/node/git.ts), GitHub's compare
// API (Action) and a file or a text given to the CLI, which can be a diff -u without
// git headers: all three go through here.
import { utf8ByteLength } from './utf8.ts'
import type { ParsedDiff, FileDiff, AddedLine } from './types.ts'

export type { ParsedDiff, FileDiff, AddedLine } from './types.ts'

// safePath lives in state.ts, which uses it for the [files] list: the router imports
// state.ts, and this way the diff parser stays out of the router's module graph.
export { safePath } from './state.ts'

export interface HunkHeader { oldStart: number; oldCount: number; newStart: number; newCount: number; context: string }

type Hunk = FileDiff['hunks'][number]

// "@@ -a[,b] +c[,d] @@ context". Combined merge diffs (@@@) are not parsed: git does
// not produce them for a diff between two trees.
const RE_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseHunkHeader(line: string): HunkHeader | null {
  const m = RE_HUNK.exec(line)
  if (!m) return null
  return {
    oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    context: m[5],
  }
}

// git header lines between "diff --git" and the first hunk. Everything else outside
// a hunk is discarded.
const HEADER_PREFIXES = [
  'old mode ', 'new mode ', 'deleted file mode ', 'new file mode ', 'copy from ', 'copy to ', 'rename from ',
  'rename to ', 'similarity index ', 'dissimilarity index ', 'index ', 'Binary files ',
]

// ─── Quoted paths (git's quote_c_style) ───────────────────────────────────────

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// Hand-written UTF-8 decoding (no TextDecoder in the vm context): the bytes come from
// git's octal escapes, which with core.quotepath on (GitHub's API) writes
// "caf\303\251.txt". An invalid sequence becomes U+FFFD.
function fromUtf8(b: number[]): string {
  let s = ''
  for (let i = 0; i < b.length;) {
    const c = b[i]
    const n = c < 0x80 ? 0 : c >= 0xc2 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : -1
    if (n < 0) { s += '\ufffd'; i++; continue }
    let cp = n === 0 ? c : c & (0x3f >> n)
    let k = 1
    for (; k <= n; k++) {
      const d = b[i + k]
      if (d === undefined || (d & 0xc0) !== 0x80) break
      cp = (cp << 6) | (d & 0x3f)
    }
    const min = [0, 0x80, 0x800, 0x10000][n]
    if (k <= n || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      s += '\ufffd'
      i += Math.max(1, k)
      continue
    }
    s += String.fromCodePoint(cp)
    i += n + 1
  }
  return s
}

// Reads a quoted string that starts at s[from]. Returns the text and the position
// after the closing quote, or null if the closing quote is missing.
function readQuoted(s: string, from: number): [string, number] | null {
  let out = ''
  let bytes: number[] = []
  const flush = (): void => {
    if (bytes.length > 0) out += fromUtf8(bytes)
    bytes = []
  }
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      flush()
      return [out, i + 1]
    }
    if (c !== '\\') {
      flush()
      out += c
      continue
    }
    const e = s[i + 1]
    if (e !== undefined && /[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4)) as RegExpExecArray
      bytes.push(parseInt(m[0], 8) & 0xff)
      i += m[0].length
      continue
    }
    flush()
    if (e !== undefined && C_ESCAPES[e] !== undefined) out += String.fromCharCode(C_ESCAPES[e])
    else if (e !== undefined) out += e
    i++
  }
  return null
}

// Path of a "--- x", "+++ x", "rename from x" line: quoted if git quoted it,
// otherwise up to the first tab (git adds one after names with spaces, diff -u puts
// the date there).
function pathOfLine(s: string): string {
  if (s.startsWith('"')) {
    const q = readQuoted(s, 0)
    if (q) return q[0]
  }
  const tab = s.indexOf('\t')
  return tab < 0 ? s : s.slice(0, tab)
}

// The two paths of "diff --git A B" and the prefixes git put in front of them: a/ and
// b/ by default, c/ i/ w/ o/ with diff.mnemonicPrefix, none with diff.noprefix.
// Without quotes the line is ambiguous if the names contain spaces; for a file that
// was not renamed the two names are equal up to the prefix, and that is enough to
// split it. For renames the "rename from/to" lines apply, which are not ambiguous.
function gitPaths(rest: string): { a: string; b: string; pref: [string, string] } | null {
  let a: string | undefined
  let b: string | undefined
  if (rest.startsWith('"')) {
    const q = readQuoted(rest, 0)
    if (!q) return null
    a = q[0]
    const after = rest.slice(q[1]).replace(/^ /, '')
    b = after.startsWith('"') ? readQuoted(after, 0)?.[0] : after
  } else if (rest.endsWith('"') && rest.lastIndexOf(' "') > 0) {
    const k = rest.lastIndexOf(' "')
    a = rest.slice(0, k)
    b = readQuoted(rest, k + 1)?.[0]
  } else {
    const meta = (rest.length - 1) / 2
    if (Number.isInteger(meta) && rest[meta] === ' ') {
      const x = rest.slice(0, meta)
      const y = rest.slice(meta + 1)
      if (x === y || (x[1] === '/' && y[1] === '/' && x.slice(2) === y.slice(2))) {
        a = x
        b = y
      }
    }
    if (a === undefined) {
      const k = rest.search(/ [a-z]\//)
      if (k > 0) {
        a = rest.slice(0, k)
        b = rest.slice(k + 1)
      }
    }
  }
  if (a === undefined || b === undefined) return null
  if (a === b) return { a, b, pref: ['', ''] }
  if (a[1] === '/' && b[1] === '/' && /^[abciow]$/.test(a[0]) && /^[abciow]$/.test(b[0])) {
    return { a, b, pref: [a.slice(0, 2), b.slice(0, 2)] }
  }
  return { a, b, pref: ['', ''] }
}

const withoutPrefix = (p: string, pref: string): string => (pref !== '' && p.startsWith(pref) ? p.slice(pref.length) : p)

// ─── Caps ─────────────────────────────────────────────────────────────────────

// Cuts the text at the last line end within maxBytes UTF-8 bytes, without measuring
// the rest: a diff of hundreds of MB costs only its first maxBytes.
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let i = 0
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i)
    let n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) n = 4
    }
    if (bytes + n > maxBytes) break
    bytes += n
    if (n === 4) i++
  }
  const end = text.lastIndexOf('\n', i - 1)
  return end < 0 ? '' : text.slice(0, end + 1)
}

// A line over maxLineChars characters is shortened and states its real length. The
// result does not exceed maxLineChars, and the first character (+, -, space) stays.
function cutLine(r: string, maxLineChars: number): string {
  if (r.length <= maxLineChars) return r
  const tail = `…[line truncated: ${r.length} characters]`
  let k = Math.max(1, maxLineChars - tail.length)
  const c = r.charCodeAt(k - 1)
  if (k > 1 && c >= 0xd800 && c <= 0xdbff) k--
  return r.slice(0, k) + tail
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

interface FileInProgress {
  git: boolean
  prefixes: [string, string]
  fromGit: { a: string; b: string } | null
  rawHeader?: string                            // rest of the "diff --git" line, if it could not be split
  minusPath: string | null | undefined     // path of "---" (null = /dev/null)
  plusPath: string | null | undefined        // path of "+++"
  renameFrom?: string
  renameTo?: string
  copy: boolean
  isNew: boolean
  deleted: boolean
  binary: boolean
  binaryPatch: boolean                      // "GIT binary patch": the base85 lines are skipped
  header: string[]
  hunks: Hunk[]
  added: number
  removed: number
  addedLines: AddedLine[]
}

function newFile(git: boolean): FileInProgress {
  return {
    git, prefixes: ['a/', 'b/'], fromGit: null, minusPath: undefined, plusPath: undefined, copy: false, isNew: false,
    deleted: false, binary: false, binaryPatch: false, header: [], hunks: [], added: 0, removed: 0,
    addedLines: [],
  }
}

// The path of a file whose name cannot be read at all. bench/verify.ts rejects it.
export const NO_NAME = '(no name)'

function finishFile(f: FileInProgress): FileDiff {
  // names in order of reliability: rename/copy, ---/+++, then the diff --git line
  const oldPath = f.renameFrom ?? f.minusPath ?? (f.fromGit && withoutPrefix(f.fromGit.a, f.prefixes[0]))
  const newPath = f.renameTo ?? f.plusPath ?? (f.fromGit && withoutPrefix(f.fromGit.b, f.prefixes[1]))
  const deleted = f.deleted || (f.plusPath === null && !f.isNew)
  const added = f.isNew || (f.minusPath === null && !deleted)
  // A file is never dropped silently: its content would disappear for the detectors
  // too. Without a readable name it keeps the raw one.
  const path = (deleted ? oldPath ?? newPath : newPath ?? oldPath) || f.rawHeader || NO_NAME
  const state: FileDiff['status'] = f.binary ? 'B'
    : f.renameFrom !== undefined && !f.copy ? 'R'
      : added || f.copy ? 'A'
        : deleted ? 'D' : 'M'
  const out: FileDiff = {
    path, status: state, header: f.header.join('\n'), hunks: f.hunks,
    added: f.added, removed: f.removed, addedLines: f.addedLines,
  }
  if (f.renameFrom !== undefined && f.renameFrom !== path) out.oldPath = f.renameFrom
  return out
}

export function parseDiff(text: string, l: { maxBytes: number; maxLineChars: number }): ParsedDiff {
  const bytes = utf8ByteLength(text)
  const truncated = bytes > l.maxBytes
  const parsed = (truncated ? cutToBytes(text, l.maxBytes) : text).replace(/\r\n/g, '\n').replace(/\0/g, '')
  const lines = parsed.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const file: FileDiff[] = []
  // with "as" tsc does not narrow to null the variables that the closeFile closure reassigns
  let f = null as FileInProgress | null
  let hunk = null as Hunk | null
  let restOld = 0
  let restNew = 0
  let number = 0

  const closeFile = (): void => {
    hunk = null
    if (f) file.push(finishFile(f))
    f = null
  }

  for (let i = 0; i < lines.length; i++) {
    const r = lines[i]

    // Inside a hunk the header's numbers count, not what the line looks like: a
    // removed line that started with "-- " shows up as "--- ", and it is not a new
    // file.
    if (hunk && f) {
      const h: Hunk = hunk
      const cf: FileInProgress = f
      const c = r[0]
      if (restOld > 0 || restNew > 0) {
        if (c === '+' && restNew > 0) {
          const t = cutLine(r, l.maxLineChars)
          h.lines.push(t)
          cf.addedLines.push({ number, text: t.slice(1) })
          cf.added++
          number++
          restNew--
          continue
        }
        if (c === '-' && restOld > 0) {
          h.lines.push(cutLine(r, l.maxLineChars))
          cf.removed++
          restOld--
          continue
        }
        // an empty context line: some tools strip the trailing space
        if ((c === ' ' || r === '') && restOld > 0 && restNew > 0) {
          h.lines.push(r === '' ? ' ' : cutLine(r, l.maxLineChars))
          number++
          restOld--
          restNew--
          continue
        }
      }
      if (c === '\\') {
        h.lines.push(cutLine(r, l.maxLineChars))
        continue
      }
      // hunk finished (or shorter than declared): the line is parsed again from scratch
      hunk = null
    }

    if (r.startsWith('diff --git ')) {
      closeFile()
      const nf = newFile(true)
      const p = gitPaths(r.slice('diff --git '.length))
      if (p) {
        nf.fromGit = { a: p.a, b: p.b }
        nf.prefixes = p.pref
      } else nf.rawHeader = r.slice('diff --git '.length)
      nf.header.push(cutLine(r, l.maxLineChars))
      f = nf
      continue
    }
    const cf = f
    if (cf?.binaryPatch) continue

    const hh = r.startsWith('@@ ') && cf ? parseHunkHeader(r) : null
    if (hh && cf) {
      const nh: Hunk = { header: cutLine(r, l.maxLineChars), lines: [], newStart: hh.newStart }
      cf.hunks.push(nh)
      hunk = nh
      restOld = hh.oldCount
      restNew = hh.newCount
      number = hh.newStart
      continue
    }

    if (r.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      // In a git file the ---/+++ pair follows the header; otherwise it opens a file
      // of a diff -u without git headers.
      let dest = cf
      if (!dest || !dest.git || dest.hunks.length > 0 || dest.minusPath !== undefined) {
        closeFile()
        dest = newFile(false)
        f = dest
      }
      const minus = pathOfLine(r.slice(4))
      const plus = pathOfLine(lines[i + 1].slice(4))
      dest.minusPath = minus === '/dev/null' ? null : withoutPrefix(minus, dest.prefixes[0])
      dest.plusPath = plus === '/dev/null' ? null : withoutPrefix(plus, dest.prefixes[1])
      dest.header.push(cutLine(r, l.maxLineChars), cutLine(lines[i + 1], l.maxLineChars))
      i++
      continue
    }

    if (!cf || !cf.git || cf.hunks.length > 0) continue
    if (r === 'GIT binary patch') {
      cf.binary = true
      cf.binaryPatch = true
      cf.header.push(r)
      continue
    }
    const kind = HEADER_PREFIXES.find((x) => r.startsWith(x))
    if (kind === undefined) continue
    cf.header.push(cutLine(r, l.maxLineChars))
    const value = r.slice(kind.length)
    if (kind === 'new file mode ') cf.isNew = true
    else if (kind === 'deleted file mode ') cf.deleted = true
    else if (kind === 'Binary files ') cf.binary = true
    else if (kind === 'rename from ' || kind === 'copy from ') {
      cf.renameFrom = pathOfLine(value)
      cf.copy = kind === 'copy from '
    } else if (kind === 'rename to ' || kind === 'copy to ') cf.renameTo = pathOfLine(value)
  }
  closeFile()
  return { files: file, truncated, bytes }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function matchesAny(re: RegExp[], path: string): boolean {
  // the configuration regexes have neither g nor y (config.ts): test() does not depend
  // on lastIndex; a regex with those flags is copied without them, instead of mutating it
  return re.some((r) => (r.global || r.sticky ? new RegExp(r.source, r.flags.replace(/[gy]/g, '')) : r).test(path))
}
