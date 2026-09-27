// Seeded pseudorandom generator, for redaction. The core cannot use
// Math.random on its own: randomness comes from outside like time and the network,
// so a test with a fixed seed reproduces the same redaction, and the real seed is
// chosen by the caller (usually the clock). A cryptographic generator is not needed:
// the substitutes only have to look realistic and differ from the real value, which
// never enters the generator.

// Mixes the seed into 32 bits. A seed from the clock is a number of milliseconds
// above 2^32, and consecutive milliseconds would give xorshift nearby states with
// correlated first values: the high part is combined with the low part and the
// result goes through murmur3's fmix32, which is bijective and spreads every bit.
function mix(seed: number): number {
  const n = Number.isFinite(seed) ? Math.trunc(seed) : 0
  const low = n >>> 0
  const high = Math.floor(n / 4294967296) >>> 0
  let h = (low ^ Math.imul(high, 0x9e3779b9)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  h >>>= 0
  // xorshift gets stuck on zero: the only seed that lands there gets a constant
  return h === 0 ? 0x9e3779b9 : h
}

// Marsaglia's xorshift32 (13, 17, 5): the state never returns to zero, so the
// values are in (0, 1), inside the [0, 1) the signature promises.
export function prng(seed: number): () => number {
  let x = mix(seed)
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 4294967296
  }
}
