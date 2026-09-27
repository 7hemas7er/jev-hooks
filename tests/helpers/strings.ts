// Reproducible random strings for the encoding and hash tests: ASCII, accented
// letters, CJK, emoji (surrogate pairs) and lone surrogates, which is where a
// hand-written encoder most easily goes wrong.

// mulberry32: a fixed seed is enough to make failures repeatable.
export function generator(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FAMILIES: ((r: () => number) => string)[] = [
  (r) => String.fromCharCode(0x20 + Math.floor(r() * 0x5f)),              // printable ASCII
  (r) => String.fromCharCode(Math.floor(r() * 0x20)),                     // control, NUL included
  (r) => String.fromCharCode(0xa0 + Math.floor(r() * 0x700)),             // Latin, Greek, Cyrillic: 2 bytes
  (r) => String.fromCharCode(0x4e00 + Math.floor(r() * 0x5000)),          // CJK: 3 bytes
  (r) => String.fromCodePoint(0x1f300 + Math.floor(r() * 0x500)),         // emoji: 4 bytes
  (r) => String.fromCharCode(0xd800 + Math.floor(r() * 0x800)),           // lone surrogate
  (r) => String.fromCharCode(0xe000 + Math.floor(r() * 0x2000)),          // high BMP, up to U+FFFF
]

export function randomString(r: () => number, maxLength: number): string {
  const n = Math.floor(r() * (maxLength + 1))
  let s = ''
  for (let i = 0; i < n; i++) s += FAMILIES[Math.floor(r() * FAMILIES.length)](r)
  return s
}
