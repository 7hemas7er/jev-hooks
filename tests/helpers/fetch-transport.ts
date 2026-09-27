// Minimal transport and clock for the tests against the fake server: fetch with a
// timeout and redirects refused, real time. The plugin's own transport
// (src/node/transport.ts, with the 4 MiB cap on the body) belongs to another step;
// this one is enough to send requests over real HTTP, with real refused connections,
// timeouts and Retry-After.
import type { HttpOutcome, Clock, HttpRequest, Transport } from '../../src/core/types.ts'

export interface RecordingTransport extends Transport {
  calls: HttpRequest[]
}

// rewrite changes the URL fetch connects to, not the request's own URL: this way a
// (non-local) backend "https://reviewer.example.org" reaches the fake on 127.0.0.1.
export function fetchTransport(rewrite?: (url: string) => string): RecordingTransport {
  const calls: HttpRequest[] = []
  const t = async (r: HttpRequest): Promise<HttpOutcome> => {
    calls.push(r)
    const t0 = performance.now()
    try {
      const res = await fetch(rewrite ? rewrite(r.url) : r.url, {
        method: 'POST', headers: r.headers, body: r.body, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.ceil(r.timeoutMs))),
      })
      const text = await res.text()
      const ra = res.headers.get('retry-after')
      const outcome: HttpOutcome = { kind: 'response', status: res.status, text, ms: performance.now() - t0 }
      if (ra !== null && /^\d+$/.test(ra)) outcome.retryAfterMs = Number(ra) * 1000
      return outcome
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { kind: 'timeout', ms: performance.now() - t0 }
      const code = e.cause?.code ?? e.message
      return { kind: 'network', beforeSend: ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code), message: code, ms: performance.now() - t0 }
    }
  }
  return Object.assign(t, { calls })
}

export const realClock: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)) }
