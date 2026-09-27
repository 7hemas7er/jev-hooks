// The core's Transport and Clock ports, implemented with Node. The core decides
// when and how much to retry; here the only decision is how to make a request without
// getting hurt:
// - redirect: "error": a redirect would carry the Bearer to another host;
// - AbortSignal.timeout: no wait beyond what the core allows;
// - a 4 MiB cap on the response body, read in pieces: a broken or hostile backend
//   does not fill the hook's memory;
// - the distinction between a network failure "before sending" (connection refused,
//   a name that does not resolve: it can be retried) and "after" (reset, redirect,
//   body too large: the request may already be in progress, and rizzo would compute
//   it twice).
//
// Never imported by hooks/register.ts: the router uses $.http.fetch.
import type { HttpOutcome, Clock, HttpRequest, Transport } from '../core/types.ts'

export const BODY_CAP = 4 * 1024 * 1024

const BEFORE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

// A fractional clock (performance.now) gives fractional timeouts, and AbortSignal
// rejects a non-integer delay: round up, never below 1 ms.
function milliseconds(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) ? Math.max(1, Math.ceil(timeoutMs)) : 1
}

// Retry-After in seconds or as an HTTP date (RFC 9110). A date in the past counts as 0.
export function parseRetryAfter(v: string | null, now: number = Date.now()): number | undefined {
  if (v === null) return undefined
  const t = v.trim()
  if (/^\d+$/.test(t)) return Number(t) * 1000
  const d = Date.parse(t)
  return Number.isFinite(d) ? Math.max(0, d - now) : undefined
}

// The system code inside fetch's chain of causes (undici): TypeError "fetch failed"
// → a cause with a code, or an AggregateError with one error per address.
function codeOf(err: unknown): string | undefined {
  let e: unknown = err
  for (let i = 0; i < 5 && e !== null && typeof e === 'object'; i++) {
    const x = e as { code?: unknown; errors?: unknown[]; cause?: unknown }
    if (typeof x.code === 'string') return x.code
    if (Array.isArray(x.errors) && x.errors.length > 0) {
      const c = codeOf(x.errors[0])
      if (c !== undefined) return c
    }
    e = x.cause
  }
  return undefined
}

// A system code (ECONNRESET, UND_ERR_SOCKET, ERR_TLS_CERT_ALTNAME_INVALID): Node
// writes it, not the server. The error message instead never leaves this file,
// because it can quote the server's text (the names in a TLS certificate) and would
// end up in the outputs addressed to Claude (HttpOutcome in core/types.ts). Without a
// code, what is left is the name of the innermost error class (HTTPParserError): the
// library picks it, and it still says what broke.
function safeCode(err: unknown): string {
  const c = codeOf(err)
  if (c !== undefined && /^[A-Z][A-Z0-9_]{1,63}$/.test(c)) return c
  let name: string | undefined
  let e: unknown = err
  for (let i = 0; i < 5 && e instanceof Error; i++) {
    if (e.name !== 'Error' && e.name !== 'TypeError' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(e.name)) name = e.name
    e = (e as { cause?: unknown }).cause
  }
  return name !== undefined ? `network error without a code (${name})` : 'network error without a code'
}

function messageOf(err: unknown): string {
  let e: unknown = err
  const pieces: string[] = []
  for (let i = 0; i < 5 && e instanceof Error; i++) {
    if (e.message && !pieces.includes(e.message)) pieces.push(e.message)
    e = (e as { cause?: unknown }).cause
  }
  return pieces.join(': ') || String(err)
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

// The body, in pieces, up to the cap; null if it goes over (and reading stops).
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const pieces: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    pieces.push(value)
  }
  return Buffer.concat(pieces).toString('utf8')
}

async function request(method: 'GET' | 'POST', r: HttpRequest, cap: number): Promise<HttpOutcome> {
  const t0 = performance.now()
  const ms = (): number => performance.now() - t0
  let res: Response
  try {
    res = await fetch(r.url, {
      method: method,
      headers: r.headers,
      body: method === 'POST' ? r.body : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(milliseconds(r.timeoutMs)),
    })
  } catch (err) {
    if (isTimeout(err)) return { kind: 'timeout', ms: ms() }
    const code = codeOf(err)
    if (code !== undefined && BEFORE_SEND_CODES.has(code)) return { kind: 'network', beforeSend: true, message: code, ms: ms() }
    // undici refuses the redirect after receiving the response: the request has left.
    // The message is looked at only to recognize it, and is not passed on
    const message = /redirect/i.test(messageOf(err)) ? 'redirect refused: the client does not follow redirects (the key stays with this host)' : safeCode(err)
    return { kind: 'network', beforeSend: false, message, ms: ms() }
  }
  try {
    const text = await readCapped(res, cap)
    if (text === null) {
      return { kind: 'network', beforeSend: false, message: `response over the ${Math.round(cap / 1024 / 1024)} MiB cap: reading stopped`, ms: ms() }
    }
    const outcome: HttpOutcome = { kind: 'response', status: res.status, text, ms: ms() }
    const ra = parseRetryAfter(res.headers.get('retry-after'))
    if (ra !== undefined) outcome.retryAfterMs = ra
    return outcome
  } catch (err) {
    if (isTimeout(err)) return { kind: 'timeout', ms: ms() }
    return { kind: 'network', beforeSend: false, message: safeCode(err), ms: ms() }
  }
}

export function nodeTransport(o: { cap?: number } = {}): Transport {
  const cap = o.cap ?? BODY_CAP
  return (r) => request('POST', r, cap)
}

// GET with the same guarantees, for GET /v1/models of the status probe. The
// core does not need it: the Transport port stays POST only.
export function nodeGet(r: Omit<HttpRequest, 'body'>, o: { cap?: number } = {}): Promise<HttpOutcome> {
  return request('GET', { ...r, body: '' }, o.cap ?? BODY_CAP)
}

// Milliseconds since the process started: a review's deadline counts from the start
// of the entry point, and performance.now does not jump with the system time.
export const nodeClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms))),
}
