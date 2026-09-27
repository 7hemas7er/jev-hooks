// Where a request goes and with which key. The sources are layers, and every
// layer is a (URL, key, model) triple resolved as a single thing: the first layer with
// a URL wins and the key is taken only from there. Otherwise someone who sets
// review_url to the Spark without api_key, and has TYPESAFE_API_KEY exported for the
// SDKs, would send the TypeSafe key in plain text over the LAN.
//
// The URL parsing is hand-written because URL does not exist in the router's node:vm
// context. It is stricter than the WHATWG parser fetch will use: anything the two
// might read differently (backslashes, IPv4 in octal or hex, credentials, queries,
// non-ASCII hosts) is rejected, so the host the http guard judges "local" is
// necessarily the one fetch will contact.
import type { Backend, Result, BackendSources, ParsedUrl } from './types.ts'
import { errResult, okResult } from './types.ts'

export type { Backend, BackendSources, BackendLayer, ParsedUrl } from './types.ts'

export const TYPESAFE_HOST = 'api.typesafe.ai'
// Default root of the TypeSafe SDKs when there is only TYPESAFE_API_KEY.
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai'
// Default of userConfig "model": rizzo-flow accepts it as an alias.
export const DEFAULT_MODEL = 'jev-latest'
// The aliases rizzo-flow accepts (compat.py) and the messages name: names from the
// code, so they are shown even when the backend is the one listing them (GET /v1/models).
export const MODEL_ALIASES: readonly string[] = [DEFAULT_MODEL, 'rizzo-latest']
export const SYSTEMONE_PATH = '/v1/systemone'

// rizzo-flow rejects a longer model (Field max_length=128).
const MAX_MODEL = 128

const DEFAULT_PORT = { http: 80, https: 443 } as const

// ─── URL parsing ──────────────────────────────────────────────────────────────

function urlError<T>(message: string): Result<T> {
  return errResult('config', `invalid URL: ${message}`)
}

// IPv4 only in canonical form: four decimal numbers 0–255 without leading zeros.
// The WHATWG parser reads "010.0.0.1" as octal (8.0.0.1, a public host): if it meant
// 10.0.0.1 here the http guard would let the Bearer through in plain text.
function parseIpv4(h: string): number[] | null {
  const parts = h.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

// IPv6 in 8 groups of 16 bits, with "::" and a trailing IPv4 allowed. No zone id (%).
function parseIpv6(h: string): number[] | null {
  if (h === '' || !/^[0-9a-f:.]+$/i.test(h)) return null
  const double = h.indexOf('::')
  if (double >= 0 && h.indexOf('::', double + 1) >= 0) return null
  const groups = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    const pieces = s.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]
      if (i === pieces.length - 1 && p.includes('.')) {
        const v4 = parseIpv4(p)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null
      out.push(parseInt(p, 16))
    }
    return out
  }
  if (double < 0) {
    const g = groups(h)
    return g && g.length === 8 ? g : null
  }
  const before = groups(h.slice(0, double))
  const after = groups(h.slice(double + 2))
  if (!before || !after || before.length + after.length > 7) return null
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after]
}

// Canonical form (RFC 5952, as WHATWG serializes it): lowercase hex, the first
// longest run of at least two zero groups compressed into "::".
function formatIpv6(g: number[]): string {
  let start = -1
  let runLength = 0
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue }
    let j = i
    while (j < 8 && g[j] === 0) j++
    if (j - i > runLength && j - i >= 2) { start = i; runLength = j - i }
    i = j
  }
  const hex = g.map((x) => x.toString(16))
  if (start < 0) return hex.join(':')
  return `${hex.slice(0, start).join(':')}::${hex.slice(start + runLength).join(':')}`
}

// Host name: letters, digits, "-" and "_" (WHATWG accepts them, and there are docker
// service names such as rizzo_reviewer), non-empty labels.
function isValidHostName(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false
  return h.split('.').every((e) => /^[a-z0-9_-]{1,63}$/.test(e))
}

// A host whose last label is a number (0x… too) is read as IPv4 by the WHATWG parser:
// "1.2.3.4.5" or "foo.123" are not names, and "0x7f.1" is 127.0.0.1.
function looksNumeric(h: string): boolean {
  const last = h.slice(h.lastIndexOf('.') + 1)
  return /^([0-9]+|0x[0-9a-f]*)$/i.test(last)
}

function parseHost(raw: string): { host: string } | { error: string } {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) return { error: 'IPv6 without a closing "]"' }
    const g = parseIpv6(raw.slice(1, -1))
    return g ? { host: formatIpv6(g) } : { error: 'invalid IPv6 address ("%…" zones are not allowed)' }
  }
  let h = raw.toLowerCase()
  // a single trailing dot is the FQDN form of the same name
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h === '') return { error: 'missing host' }
  if (looksNumeric(h)) {
    return parseIpv4(h) ? { host: h } : { error: 'IPv4 address not in canonical form: write it as a.b.c.d, in decimal and without leading zeros' }
  }
  if (!isValidHostName(h)) return { error: 'invalid host: ASCII letters, digits, ".", "-" and "_" are allowed (use the punycode form for international names)' }
  return { host: h }
}

// Path characters that fetch sends as they are (RFC 3986 pchar and "/"). The WHATWG
// parser would %-encode the others: they are rejected so as not to send a path other
// than the one checked.
const RE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/

export function parseUrl(s: string): Result<ParsedUrl> {
  if (typeof s !== 'string') return urlError('expected a string')
  const t = s.trim()
  if (t === '') return urlError('empty')
  // inner spaces and control characters, backslash (WHATWG treats it as "/") and non-ASCII
  if (/[\u0000-\u0020\u007f-\uffff\\]/.test(t)) return urlError('contains spaces, control characters, "\\" or non-ASCII characters')
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(t)
  if (!m) return urlError('must start with http:// or https://')
  const writtenScheme = m[1].toLowerCase()
  if (writtenScheme !== 'http' && writtenScheme !== 'https') return urlError(`scheme "${writtenScheme}" not allowed: use http:// or https://`)
  const scheme: 'http' | 'https' = writtenScheme === 'http' ? 'http' : 'https'
  const rest = t.slice(m[0].length)
  if (rest.includes('?')) return urlError('a query (?…) is not allowed')
  if (rest.includes('#')) return urlError('a fragment (#…) is not allowed')
  const slash = rest.indexOf('/')
  const authority = slash < 0 ? rest : rest.slice(0, slash)
  const path = slash < 0 ? '/' : rest.slice(slash)
  // The message does not repeat the URL: it would contain the very credentials.
  if (authority.includes('@')) return urlError('contains credentials (user:password@): configure the key separately, never in the URL')
  if (authority === '') return urlError('missing host')

  let rawHost = authority
  let portText: string | undefined
  if (authority.startsWith('[')) {
    const closed = authority.indexOf(']')
    if (closed < 0) return urlError('IPv6 without a closing "]"')
    rawHost = authority.slice(0, closed + 1)
    const after = authority.slice(closed + 1)
    if (after !== '' && !after.startsWith(':')) return urlError('only ":port" can follow the IPv6 address')
    if (after !== '') portText = after.slice(1)
  } else {
    const colon = authority.indexOf(':')
    if (colon >= 0) {
      rawHost = authority.slice(0, colon)
      portText = authority.slice(colon + 1)
    }
  }
  const parsed = parseHost(rawHost)
  if ('error' in parsed) return urlError(parsed.error)

  let port: number = DEFAULT_PORT[scheme]
  // "host:" without a number means the default port, as in WHATWG
  if (portText !== undefined && portText !== '') {
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
      return urlError('invalid port: expected between 1 and 65535')
    }
    port = Number(portText)
  }
  if (!RE_PATH.test(path)) return urlError('the path contains characters that are not allowed')
  return okResult({ scheme, host: parsed.host, port, path })
}

// "host" or "[ipv6]", plus ":port" if it is not the scheme's default. It is the form of
// the host in the logs and in calibration.json (match.host), for example "192.168.1.50:8017".
export function authority(u: ParsedUrl): string {
  const h = u.host.includes(':') ? `[${u.host}]` : u.host
  return u.port === DEFAULT_PORT[u.scheme] ? h : `${h}:${u.port}`
}

// Removes a trailing "/", "/v1" and "/v1/systemone" and appends "/v1/systemone":
// whoever pastes the full URL does not get a 404 on /v1/v1/systemone.
export function normalizeUrl(base: string): Result<string> {
  const parsed = parseUrl(base)
  if (!parsed.ok) return parsed
  const u = parsed.value
  let p = u.path.replace(/\/+$/, '')
  if (p.endsWith(SYSTEMONE_PATH)) p = p.slice(0, -SYSTEMONE_PATH.length)
  else if (p.endsWith('/v1')) p = p.slice(0, -3)
  p = p.replace(/\/+$/, '')
  return okResult(`${u.scheme}://${authority(u)}${p}${SYSTEMONE_PATH}`)
}

// Same scheme, host and port. An unreadable URL has no origin: never equal.
export function sameOrigin(a: string, b: string): boolean {
  const x = parseUrl(a)
  const y = parseUrl(b)
  return x.ok && y.ok && x.value.scheme === y.value.scheme && x.value.host === y.value.host && x.value.port === y.value.port
}

// ─── Local hosts: the http guard ──────────────────────────────────────────────

function isLocalIpv4(o: number[]): boolean {
  return o[0] === 127                                   // loopback
    || o[0] === 10                                      // 10/8
    || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)       // 172.16/12
    || (o[0] === 192 && o[1] === 168)                   // 192.168/16
    || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)      // 100.64/10: Tailscale (CGNAT)
}

// True for loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, *.ts.net, *.local and
// localhost: the only hosts towards which http (Bearer in plain text) is allowed. It
// accepts an IPv6 with or without square brackets. When in doubt it answers no: the
// cost is a "use https", never a key in plain text on the internet.
export function isLocalHost(host: string): boolean {
  if (typeof host !== 'string') return false
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.includes(':')) {
    const g = parseIpv6(h)
    if (!g) return false
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true   // ::1
    // ::ffff:a.b.c.d is the embedded IPv4: that is the one that counts
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isLocalIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])
    }
    return false
  }
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (looksNumeric(h)) {
    const v4 = parseIpv4(h)
    return v4 !== null && isLocalIpv4(v4)
  }
  if (!isValidHostName(h)) return false
  if (h === 'localhost') return true
  return (h.endsWith('.ts.net') && h.length > '.ts.net'.length) || (h.endsWith('.local') && h.length > '.local'.length)
}

// ─── Backend resolution ───────────────────────────────────────────────────────

function trimmed(s: string | undefined): string {
  return typeof s === 'string' ? s.trim() : ''
}

interface BackendChoice { layer: string; url: string; key: string; model: string }

// Hosts TYPESAFE_API_KEY may go to: api.typesafe.ai and the host of
// TYPESAFE_BASE_URL, if readable.
function typesafeHosts(baseUrl: string): string[] {
  const hosts = [TYPESAFE_HOST]
  if (baseUrl !== '') {
    const u = parseUrl(baseUrl)
    if (u.ok) hosts.push(u.value.host)
  }
  return hosts
}

export function resolveBackend(f: BackendSources): Result<Backend & { layer: string }> {
  const tsKey = trimmed(f.typesafe?.key)
  const baseTs = trimmed(f.typesafe?.baseUrl)
  const tsModel = trimmed(f.typesafe?.model)
  const explicit = trimmed(f.explicitUrl)
  let selection: BackendChoice | null = null

  if (explicit !== '') {
    // explicit --url: it gets a layer's key only if that layer points to the same
    // origin; TYPESAFE_API_KEY only if the host is TypeSafe's.
    selection = { layer: 'explicit url', url: explicit, key: '', model: '' }
    const parsed = parseUrl(explicit)
    for (const l of f.layers) {
      if (trimmed(l.url) !== '' && trimmed(l.key) !== '' && sameOrigin(trimmed(l.url), explicit)) {
        selection = { layer: `explicit url, key from ${l.name}`, url: explicit, key: trimmed(l.key), model: trimmed(l.model) }
        break
      }
    }
    if (selection.key === '' && tsKey !== '' && parsed.ok && typesafeHosts(baseTs).includes(parsed.value.host)) {
      selection = { layer: 'explicit url, key from TYPESAFE_API_KEY', url: explicit, key: tsKey, model: tsModel }
    }
  } else {
    const l = f.layers.find((x) => trimmed(x.url) !== '')
    if (l) {
      selection = { layer: l.name, url: trimmed(l.url), key: trimmed(l.key), model: trimmed(l.model) }
    } else if (baseTs !== '' || tsKey !== '') {
      // last layer, as in the SDKs: without TYPESAFE_BASE_URL the root is api.typesafe.ai
      const url = baseTs !== '' ? baseTs : TYPESAFE_BASE_URL
      const u = parseUrl(url)
      const key = u.ok && typesafeHosts(baseTs).includes(u.value.host) ? tsKey : ''
      selection = { layer: 'TYPESAFE_*', url, key, model: tsModel }
    }
  }
  if (!selection) {
    return errResult('not_configured', 'backend not configured: set review_url with /plugin')
  }

  const normalized = normalizeUrl(selection.url)
  if (!normalized.ok) return errResult('config', `${normalized.error.message} (source: ${selection.layer})`)
  const u = parseUrl(normalized.value)
  if (!u.ok) return u
  const local = isLocalHost(u.value.host)
  if (u.value.scheme === 'http' && !local) {
    return errResult('config', `use https: http:// is allowed only towards local hosts (LAN, Tailscale, localhost), not towards ${authority(u.value)} (source: ${selection.layer})`)
  }
  // A header value cannot contain spaces, newlines or non-ASCII characters: fetch would
  // fail with an error that might quote the key.
  if (selection.key !== '' && !/^[\x21-\x7e]+$/.test(selection.key)) {
    return errResult('config', `the key from ${selection.layer} contains spaces, newlines or non-ASCII characters: it is not a valid Bearer`)
  }
  if (selection.key === '' && u.value.host === TYPESAFE_HOST) {
    return errResult('not_configured', `${TYPESAFE_HOST} requires a key: set api_key with /plugin (URL source: ${selection.layer})`)
  }
  const model = selection.model !== '' ? selection.model : DEFAULT_MODEL
  if (model.length > MAX_MODEL) {
    return errResult('config', `model name too long: ${model.length} characters, at most ${MAX_MODEL} (source: ${selection.layer})`)
  }
  return okResult({
    url: normalized.value,
    key: selection.key,
    model,
    local,
    host: authority(u.value),
    layer: selection.layer,
  })
}

// The key goes only here, never in the URL, the logs or the messages.
export function requestHeaders(b: Backend): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (b.key !== '') h.Authorization = `Bearer ${b.key}`
  return h
}

// A text that might contain the key or control characters (the names the backend
// gives itself, before comparing them with the calibration and writing them to the
// log; an error message before it leaves ask): the key replaced wherever it appears
// (also JSON-escaped or URL-encoded), control and bidirectional characters removed (a
// hostile backend could write ANSI sequences to the terminal) and a cut at max
// characters. Replacing comes before cutting: a cut in the middle of the key would
// leave a piece of it. It is not enough to make a backend text fit for Claude: that
// never goes out (systemone.ts, provenance.ts).
export function sanitize(text: string, key: string, max: number = 300): string {
  let t = String(text)
  const k = typeof key === 'string' ? key.trim() : ''
  if (k !== '') {
    const variants = [k, JSON.stringify(k).slice(1, -1), encodeURIComponent(k)]
    for (const v of variants) if (v !== '') t = t.split(v).join('[key]')
  }
  t = t.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
  if (t.length > max) {
    let end = Math.max(0, max - 1)
    const c = t.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end--
    t = `${t.slice(0, end)}…`
  }
  return t
}
