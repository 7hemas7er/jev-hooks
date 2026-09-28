// Pure SHA-256 (FIPS 180-4). The core uses no crypto (rule 4): Claude Code 2.1.283
// declares crypto in the hooks' environment and 2.1.282 did not, so without it the core
// runs the same in Node, in older builds and in the stricter context the tests build.
// The sha is needed in the router too: it identifies the exact text of a question, and
// a calibration fit is valid only for that text. The test compares it with node:crypto.
import { utf8 } from './utf8.ts'

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

// Initial state: fractional parts of the square roots of the first 8 primes.
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

function rotate(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

export function sha256HexBytes(data: Uint8Array): string {
  // padding: 0x80, zeros, length in bits as a 64-bit big-endian; total a multiple of 64 bytes
  const byteLength = data.length
  const total = Math.ceil((byteLength + 9) / 64) * 64
  const m = new Uint8Array(total)
  m.set(data)
  m[byteLength] = 0x80
  const bits = byteLength * 8
  const high = Math.floor(bits / 0x100000000)
  const low = bits >>> 0
  m[total - 8] = high >>> 24
  m[total - 7] = (high >>> 16) & 0xff
  m[total - 6] = (high >>> 8) & 0xff
  m[total - 5] = high & 0xff
  m[total - 4] = low >>> 24
  m[total - 3] = (low >>> 16) & 0xff
  m[total - 2] = (low >>> 8) & 0xff
  m[total - 1] = low & 0xff

  const h = H0.slice()
  const w = new Uint32Array(64)
  for (let block = 0; block < total; block += 64) {
    for (let t = 0; t < 16; t++) {
      const o = block + t * 4
      w[t] = ((m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3]) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let t = 0; t < 64; t++) {
      const S1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('')
}

// sha256 of the text's UTF-8 bytes, in lowercase hex.
export function sha256Hex(text: string): string {
  return sha256HexBytes(utf8(text))
}
