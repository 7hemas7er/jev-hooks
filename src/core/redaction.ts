// Redaction of secrets towards non-local backends. Towards TypeSafe the
// diff leaves the machine: the secrets the regexes recognize are sent replaced by a
// random value with the same shape (known prefix, length, character classes), so the
// model still sees a realistic key in its place and can answer "yes, there is a
// hardcoded secret" without receiving the real one. Towards a local backend (the Spark
// on the LAN) the state stays as it is: nothing leaves there, and every substitution
// changes a little what the model reads anyway.
//
// What it covers:
// - the values hit by the secret detectors of policy.json, counted by shape and not
//   by certainty: min_entropy does not apply (a trivial password is still a
//   password). ignore_values does: a "changeme" or a process.env.X replaced by a
//   random value would look like a real secret and would shift the model's answer
//   (fake values stay as they are);
// - every other occurrence of the same value in the text, even without a secret-like
//   name next to it (`Client("…")` two lines after `API_KEY = "…"`);
// - PEM private keys, whole block: from the BEGIN header to the END line or to the
//   end of the hunk, base64 body included;
// - the files of state.sensitive_files (.env, .pem, credentials…): of their diff the
//   header stays, plus a line that says which detectors hit;
// - for the router, which has no policy: every token of at least 20 characters with
//   an entropy of at least 4 bits per character.
// A secret that no regex recognizes still goes out in plain text: docs/backends.md says so,
// and for private repos it recommends a local rizzo.
//
// Pure (rule 4): randomness comes from outside (rnd, usually prng(seed) from
// random.ts), and the value → substitute map, if it must hold across several texts of
// the same review, is passed by the caller.

import type { Backend, Policy, Detector } from './types.ts'
import { utf8 } from './utf8.ts'

export type { MaskPair } from './types.ts'

// The secrets check. It is the only check id written in the code: the design ties
// redaction to the detectors "with check hardcoded_secret", and
// policy.json has no field yet to say which detectors find secrets. Without a
// detector with this check only PEM blocks and sensitive files are redacted.
const SECRETS_CHECK = 'hardcoded_secret'

// The router's thresholds: without a policy there are no detectors, and a long,
// disordered token in a prompt is almost always a key, a hash or a base64 blob.
const ROUTER_TOKEN = { minChars: 20, minEntropy: 4.0 } as const

// A value found is replaced wherever it appears in the text only from 8 characters
// up: a shorter value (a user detector can find one) would also appear inside
// ordinary words, and replacing it everywhere would ruin the diff.
const MIN_EVERYWHERE = 8

// Prefixes that stay the same in the substitute: they tell the model what kind of key
// it is (live or test, Stripe or GitHub). They must be written out because some have
// no separator to recognize them by (AKIA…, AIza…). The longest wins.
const KNOWN_PREFIXES = [
  'github_pat_', 'sk_live_', 'rk_live_', 'pk_live_', 'sk_test_', 'rk_test_', 'pk_test_', 'whsec_',
  'sk-ant-', 'sk-proj-', 'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-',
  'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-',
  'AKIA', 'ASIA', 'AIza', 'npm_', 'pypi-', 'hf_', 'shpat_', 'SG.', 'eyJ',
].sort((a, b) => b.length - a.length)

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'

// The "hit token" of detectors.ts: the longest run of these characters inside a hit
// is what the entropy is measured on.
const RE_TOKEN = /[A-Za-z0-9+/=_-]+/g

// PEM headers. The private key one is enough on its own to open a block, even without
// a detector in policy.json (the router has none); a secret detector that hits another
// BEGIN header opens a block in the same way.
const RE_PEM_PRIVATE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
const RE_PEM_HEADER = /-----BEGIN [^-\r\n]*-----/
const PEM_END = '-----END '

// An assignment hit ("API_KEY = …") or a URL with credentials: only the value is
// replaced, because the name and the scheme are the context the model must still see.
// Of a URL the password is replaced, not the user nor the host.
const RE_URL_CREDENTIALS = /:\/\/[^\s/:@]*:([^\s@/]+)@/
const RE_OPERATOR = /(?::=|=>|[:=])[ \t]*["'`]?/

// Lines that git writes before the first hunk of a file.
const HEADER_PREFIXES = [
  'old mode ', 'new mode ', 'deleted file mode ', 'new file mode ', 'copy from ', 'copy to ', 'rename from ',
  'rename to ', 'similarity index ', 'dissimilarity index ', 'index ', '--- ', '+++ ',
]

// The section headers of text@1: no diff line starts with "[", so a block or
// a file cannot continue past one.
const RE_SECTION = /^\[[a-z_]+\]$/

const UTF8_REPLACEMENT = String.fromCharCode(0xfffd)

// ─── Utilities ────────────────────────────────────────────────────────────────

// The regexes of policy.json have no g flag (config.ts allows only i, m, s): scanning
// all the hits of a line needs a global copy.
function globalRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
}

// test() on a global regex restarts from lastIndex: it is reset, but only there, so as
// not to write to a policy regex that someone might have frozen.
function test(re: RegExp, s: string): boolean {
  if (re.global || re.sticky) re.lastIndex = 0
  return re.test(s)
}

function matchesAny(re: readonly RegExp[], s: string): boolean {
  return re.some((r) => test(r, s))
}

// Shannon entropy in bits per character, as detectors.ts measures it.
function entropy(s: string): number {
  const counts = new Map<string, number>()
  let n = 0
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
    n++
  }
  let h = 0
  for (const k of counts.values()) h -= (k / n) * Math.log2(k / n)
  return h
}

function hitToken(hit: string): string {
  let best = ''
  for (const m of hit.matchAll(RE_TOKEN)) if (m[0].length > best.length) best = m[0]
  return best
}

// A valid hit as in detectors.ts: the regex, then min_entropy on the hit token and
// ignore_values on the hit. It only serves to say which detectors hit a sensitive
// file, whose content is not sent.
function hits(r: Detector, text: string): boolean {
  for (const m of text.matchAll(globalRegex(r.regex))) {
    if (m[0] === '') continue
    if (r.ignore_values && test(r.ignore_values, m[0])) continue
    if (r.min_entropy !== undefined && entropy(hitToken(m[0])) < r.min_entropy) continue
    return true
  }
  return false
}

// ─── Paths in git headers ─────────────────────────────────────────────────────

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

function fromUtf8(b: readonly number[]): string {
  let s = ''
  for (let i = 0; i < b.length;) {
    const x = b[i]
    const n = x < 0x80 ? 0 : x >= 0xc2 && x < 0xe0 ? 1 : x >= 0xe0 && x < 0xf0 ? 2 : x >= 0xf0 && x < 0xf5 ? 3 : -1
    if (n < 0) {
      s += UTF8_REPLACEMENT
      i++
      continue
    }
    let cp = n === 0 ? x : x & (0x3f >> n)
    let valid = i + n < b.length
    for (let k = 1; valid && k <= n; k++) {
      const y = b[i + k]
      if ((y & 0xc0) !== 0x80) valid = false
      else cp = (cp << 6) | (y & 0x3f)
    }
    if (!valid || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (n === 2 && cp < 0x800) || (n === 3 && cp < 0x10000)) {
      s += UTF8_REPLACEMENT
      i++
      continue
    }
    s += String.fromCodePoint(cp)
    i += n + 1
  }
  return s
}

// A C-style quoted path, as git writes it for names with non-ASCII or special
// characters ("a/caf\303\251/.env"): the octals are UTF-8 bytes. Without decoding, a
// sensitive file with an odd name would slip past sensitive_files.
function unquote(s: string): string {
  if (!s.startsWith('"')) return s
  const c = [...s]
  const bytes: number[] = []
  for (let i = 1; i < c.length; i++) {
    if (c[i] === '"') break
    if (c[i] === '\\' && i + 1 < c.length) {
      let octal = ''
      while (octal.length < 3 && i + 1 + octal.length < c.length && /[0-7]/.test(c[i + 1 + octal.length])) {
        octal += c[i + 1 + octal.length]
      }
      if (octal) {
        bytes.push(parseInt(octal, 8) & 0xff)
        i += octal.length
        continue
      }
      const e = C_ESCAPES[c[i + 1]]
      if (e !== undefined) bytes.push(e)
      else bytes.push(...utf8(c[i + 1]))
      i++
      continue
    }
    bytes.push(...utf8(c[i]))
  }
  return fromUtf8(bytes)
}

function quoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '"') return i + 1
  }
  return s.length
}

// The two paths of "diff --git a/X b/Y". Without quotes the split is ambiguous when
// the names contain spaces: the form without a rename (X equal to Y) is tried first,
// then the last " b/". Renames have the "rename from/to" lines anyway.
function twoPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const f = quoteEnd(rest)
    return [rest.slice(0, f), rest.slice(f).replace(/^ /, '')]
  }
  const meta = (rest.length - 1) / 2
  if (Number.isInteger(meta) && rest[meta] === ' ' && rest.slice(2, meta) === rest.slice(meta + 3)) {
    return [rest.slice(0, meta), rest.slice(meta + 1)]
  }
  const q = rest.indexOf(' "')
  if (q > 0) return [rest.slice(0, q), rest.slice(q + 1)]
  const b = rest.lastIndexOf(' b/')
  if (b > 0) return [rest.slice(0, b), rest.slice(b + 1)]
  return [rest]
}

// All the paths named by a file's header, with and without the a/ or b/ prefix
// (git.ts sets the prefixes, but a diff passed to the CLI can have others or none): a
// file is sensitive if any of them is. When in doubt, more is removed. main is the
// new path, the one detect() applies exclude_paths to.
function headerPaths(header: readonly string[]): { all: string[]; main: string } {
  const all: string[] = []
  let main = ''
  let priority = 0
  const add = (raw: string, withPrefix: boolean, p: number): void => {
    const x = unquote(raw)
    if (x === '' || x === '/dev/null') return
    const without = withPrefix ? x.replace(/^[a-z]\//, '') : x
    all.push(x)
    if (without !== x) all.push(without)
    if (p > priority) {
      main = without
      priority = p
    }
  }
  for (const r of header) {
    if (r.startsWith('diff --git ')) {
      const [a, b] = twoPaths(r.slice('diff --git '.length))
      add(a, true, 1)
      if (b !== undefined) add(b, true, 2)
    } else if (r.startsWith('--- ')) {
      add(r.slice(4).replace(/\t.*$/, ''), true, 3)
    } else if (r.startsWith('+++ ')) {
      add(r.slice(4).replace(/\t.*$/, ''), true, 5)
    } else {
      for (const [pref, p] of [['rename from ', 0], ['copy from ', 0], ['rename to ', 4], ['copy to ', 4]] as const) {
        if (r.startsWith(pref)) add(r.slice(pref.length), false, p)
      }
    }
  }
  return { all, main }
}

function isBoundary(line: string): boolean {
  return line.startsWith('diff --git ') || RE_SECTION.test(line)
}

// ─── Sensitive files ──────────────────────────────────────────────────────────

// Of a sensitive file's diff the header lines stay (paths, modes, renames): hunks,
// "@@" lines (which carry a line of the file as context), "Binary files" and "GIT
// binary patch" (a .p12 in base85) are not sent. In their place a line with the
// detectors that hit, so that the model knows something was there. It applies both to
// a raw diff and to a text@1 state, where every chunk repeats the file header.
function dropSensitive(lines: readonly string[], p: Policy): { lines: string[]; warnings: Set<number>; file: number } {
  const out: string[] = []
  const warnings = new Set<number>()
  let file = 0
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      out.push(lines[i++])
      continue
    }
    let j = i + 1
    while (j < lines.length && HEADER_PREFIXES.some((x) => lines[j].startsWith(x))) j++
    let k = j
    while (k < lines.length && !isBoundary(lines[k])) k++
    const header = lines.slice(i, j)
    out.push(...header)
    const paths = headerPaths(header)
    if (k > j && paths.all.some((x) => matchesAny(p.state.sensitive_files, x))) {
      const content = lines.slice(j, k)
      const names: string[] = []
      for (const r of p.detectors) {
        // project regexes run only in the Worker with a time limit
        if (r.fromProject || matchesAny(r.exclude_paths, paths.main)) continue
        const onLines = r.where.includes('added_lines')
          && content.some((x) => x.startsWith('+') && hits(r, x.slice(1)))
        const onPath = r.where.includes('paths') && hits(r, paths.main)
        if (onLines || onPath) names.push(r.name)
      }
      warnings.add(out.length)
      out.push(`(content not sent: sensitive file; detectors: ${names.length > 0 ? names.join(', ') : 'none'})`)
      file++
    } else {
      out.push(...lines.slice(j, k))
    }
    i = k
  }
  return { lines: out, warnings, file }
}

// ─── Shape-preserving substitute ──────────────────────────────────────────────

function pick(alphabet: string, rnd: () => number): string {
  const x = rnd()
  const k = x >= 0 && x < 1 ? Math.floor(x * alphabet.length) : 0
  return alphabet[k]
}

function knownPrefix(piece: string): string {
  for (const p of KNOWN_PREFIXES) if (piece.length > p.length && piece.startsWith(p)) return p
  return ''
}

// A letter becomes a letter of the same case, a digit a digit; the rest (separators,
// base64's "+/=", quotes, the leading "+" of a diff line) stays where it is. An
// all-hex value stays hex. The \n, \r and \t sequences stay intact: a PEM key on a
// single line ("…KEY-----\nMIIE…") must stay a PEM key on a single line.
function shapePreserving(piece: string, rnd: () => number): string {
  const prefix = knownPrefix(piece)
  const rest = piece.slice(prefix.length)
  const lower = /^[0-9a-f]+$/.test(rest) && /[a-f]/.test(rest) ? 'abcdef' : LOWERCASE
  const upper = /^[0-9A-F]+$/.test(rest) && /[A-F]/.test(rest) ? 'ABCDEF' : UPPERCASE
  let out = prefix
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '\\' && i + 1 < rest.length && 'nrt'.includes(rest[i + 1])) {
      out += c + rest[++i]
      continue
    }
    if (c >= 'A' && c <= 'Z') out += pick(upper, rnd)
    else if (c >= 'a' && c <= 'z') out += pick(lower, rnd)
    else if (c >= '0' && c <= '9') out += pick(DIGITS, rnd)
    else out += c
  }
  return out
}

// Last fallback, if randomness keeps giving back the original value (a degenerate
// rnd, a single-letter value): every letter and digit moves up by one within its
// class, so the substitute is sure to differ.
function rotate(piece: string): string {
  const advance = (c: string): string => {
    for (const a of [UPPERCASE, LOWERCASE, DIGITS]) {
      const k = a.indexOf(c)
      if (k >= 0) return a[(k + 1) % a.length]
    }
    return c
  }
  const prefix = knownPrefix(piece)
  const rest = [...piece.slice(prefix.length)].map(advance).join('')
  const fresh = prefix + rest
  return fresh !== piece ? fresh : [...piece].map(advance).join('')
}

function substitute(piece: string, rnd: () => number, memo: Map<string, string>, fakes: readonly RegExp[]): string {
  const known = memo.get(piece)
  if (known !== undefined) return known
  let fresh = piece
  // a substitute equal to the original hides nothing; one that looks fake
  // ("…example…") would make the model believe the key is a test one
  for (let t = 0; t < 8 && (fresh === piece || matchesAny(fakes, fresh)); t++) fresh = shapePreserving(piece, rnd)
  if (fresh === piece) fresh = rotate(piece)
  memo.set(piece, fresh)
  return fresh
}

// ─── Candidates ───────────────────────────────────────────────────────────────

// The part to replace inside a hit: the password of a URL with credentials, the value
// after the operator of an assignment ("password: …", "SECRET_KEY=…",
// "api_key => '…'"), otherwise the whole hit (sk_live_…, AKIA…, ghp_…).
function valueInHit(hit: string): [number, number] {
  const u = RE_URL_CREDENTIALS.exec(hit)
  if (u) {
    const end = u.index + u[0].length - 1
    return [end - u[1].length, end]
  }
  const o = RE_OPERATOR.exec(hit)
  if (o && o.index > 0) {
    const start = o.index + o[0].length
    let end = hit.length
    if (end > start && /["'`]$/.test(hit)) end--
    if (end > start) return [start, end]
  }
  return [0, hit.length]
}

// End of the PEM header that opens a block in this line, or -1.
function pemStart(line: string, secrets: readonly RegExp[]): number {
  const privateKey = RE_PEM_PRIVATE.exec(line)
  if (privateKey) return privateKey.index + privateKey[0].length
  if (!line.includes('-----BEGIN ')) return -1
  for (const re of secrets) {
    for (const m of line.matchAll(re)) {
      if (!m[0].includes('-----BEGIN ')) continue
      const h = RE_PEM_HEADER.exec(line)
      if (h) return h.index + h[0].length
    }
  }
  return -1
}

interface Range { start: number; end: number; counts: boolean }

// ─── Redaction ────────────────────────────────────────────────────────────────

// p null: the router, which has no policy and uses the token rule. memo is the
// value → substitute map: a caller that redacts several texts of the same review (the
// chunks and the global state) always passes the same one, so a secret has a single
// substitute across the whole review. redactions counts the replaced values,
// the PEM blocks and the sensitive files removed.
export function redact(text: string, p: Policy | null, rnd: () => number, memo: Map<string, string> = new Map()):
  { text: string; redactions: number } {
  const detectors = p ? p.detectors.filter((r) => r.check === SECRETS_CHECK && !r.fromProject) : []
  const secrets = detectors.map((r) => ({ re: globalRegex(r.regex), fakes: r.ignore_values }))
  const fakes = detectors.flatMap((r) => (r.ignore_values ? [r.ignore_values] : []))
  let redactions = 0

  let lines = text.split('\n')
  let warnings = new Set<number>()
  if (p) {
    const s = dropSensitive(lines, p)
    lines = s.lines
    warnings = s.warnings
    redactions += s.file
  }

  const ranges: Range[][] = lines.map(() => [])
  const add = (i: number, start: number, end: number, count: boolean): void => {
    if (end > start && !warnings.has(i)) ranges[i].push({ start, end, counts: count })
  }

  // PEM blocks: the body does not go through a detector (a base64 line has nothing
  // recognizable), so it is replaced line by line up to the END line, a new file or
  // hunk header, or the end of the text.
  const secretRegexes = secrets.map((s) => s.re)
  for (let i = 0; i < lines.length; i++) {
    if (warnings.has(i)) continue
    const body = pemStart(lines[i], secretRegexes)
    if (body < 0) continue
    redactions++
    const closed = lines[i].indexOf(PEM_END, body)
    add(i, body, closed < 0 ? lines[i].length : closed, false)
    if (closed >= 0) continue
    let j = i + 1
    let end = false
    for (; j < lines.length && !warnings.has(j); j++) {
      const r = lines[j]
      if (isBoundary(r) || r.startsWith('@@')) break
      if (r.startsWith('\\')) continue   // "\ No newline at end of file" belongs to git, not to the key
      const f = r.indexOf(PEM_END)
      add(j, 0, f < 0 ? r.length : f, false)
      if (f >= 0) {
        end = true
        break
      }
    }
    // the line that closed the block without END (a new file or hunk) must be examined again
    i = end ? j : j - 1
  }

  const values = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    if (warnings.has(i)) continue
    const line = lines[i]
    if (p) {
      for (const s of secrets) {
        for (const m of line.matchAll(s.re)) {
          const hit = m[0]
          if (hit === '' || hit.includes('-----BEGIN ')) continue
          if (s.fakes && test(s.fakes, hit)) continue
          const [a, b] = valueInHit(hit)
          const start = (m.index ?? 0) + a
          const end = (m.index ?? 0) + b
          if (end <= start) continue
          add(i, start, end, true)
          values.add(line.slice(start, end))
        }
      }
    } else {
      for (const m of line.matchAll(RE_TOKEN)) {
        if (m[0].length < ROUTER_TOKEN.minChars || entropy(m[0]) < ROUTER_TOKEN.minEntropy) continue
        add(i, m.index ?? 0, (m.index ?? 0) + m[0].length, true)
        values.add(m[0])
      }
    }
  }

  // Every other occurrence of the values found. Searching them one by one would cost
  // values × lines, and a hostile diff with a hundred thousand assignments would stall
  // the hook for minutes: the values are indexed by their first MIN_EVERYWHERE
  // characters and the text is scanned only once.
  const byStart = new Map<string, string[]>()
  for (const v of values) {
    if (v.length < MIN_EVERYWHERE) continue
    const k = v.slice(0, MIN_EVERYWHERE)
    const list = byStart.get(k)
    if (list) list.push(v)
    else byStart.set(k, [v])
  }
  if (byStart.size > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (let k = 0; k + MIN_EVERYWHERE <= line.length; k++) {
        const candidates = byStart.get(line.slice(k, k + MIN_EVERYWHERE))
        if (!candidates) continue
        for (const v of candidates) if (line.startsWith(v, k)) add(i, k, k + v.length, true)
      }
    }
  }

  const out = lines.map((line, i) => {
    const list = ranges[i]
    if (list.length === 0) return line
    list.sort((x, y) => x.start - y.start || y.end - x.end)
    // overlapping ranges merge: when in doubt, more is replaced
    const merged: Range[] = []
    for (const t of list) {
      const last = merged[merged.length - 1]
      if (last && t.start < last.end) {
        last.end = Math.max(last.end, t.end)
        last.counts = last.counts || t.counts
      } else {
        merged.push({ ...t })
      }
    }
    let s = ''
    let pos = 0
    for (const t of merged) {
      const piece = line.slice(t.start, t.end)
      const fresh = substitute(piece, rnd, memo, fakes)
      if (t.counts && fresh !== piece) redactions++
      s += line.slice(pos, t.start) + fresh
      pos = t.end
    }
    return s + line.slice(pos)
  })
  return { text: out.join('\n'), redactions }
}

// Where the state may go unredacted, in a single place: towards a local backend the
// state stays as it is, towards a non-local one it always goes through redaction.
export function redactForBackend(b: Pick<Backend, 'local'>, text: string, p: Policy | null, rnd: () => number,
  memo?: Map<string, string>): { text: string; redactions: number } {
  if (b.local) return { text, redactions: 0 }
  return redact(text, p, rnd, memo)
}
