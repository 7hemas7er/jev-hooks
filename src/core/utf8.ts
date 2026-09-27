// Hand-written UTF-8 encoding. In the node:vm context of Claude Code's module loader
// TextEncoder does not exist, and the real bytes are needed: sha256Hex works on
// bytes, and the 256 KB limit of the state is measured in bytes on the serialized JSON.
// A lone surrogate becomes U+FFFD (EF BF BD), as TextEncoder and Buffer.from do: the
// same text must give the same hash in Node and in the router.

// Code point of the character at position i, with lone surrogates replaced by U+FFFD.
// Also returns how many UTF-16 units it consumed.
function codePoint(text: string, i: number): [number, number] {
  const c = text.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
    if (d >= 0xdc00 && d <= 0xdfff) return [0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00), 2]
    return [0xfffd, 1]
  }
  if (c >= 0xdc00 && c <= 0xdfff) return [0xfffd, 1]
  return [c, 1]
}

export function utf8ByteLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length;) {
    const [cp, step] = codePoint(text, i)
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    i += step
  }
  return n
}

export function utf8(text: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(text))
  let k = 0
  for (let i = 0; i < text.length;) {
    const [cp, step] = codePoint(text, i)
    i += step
    if (cp < 0x80) {
      out[k++] = cp
    } else if (cp < 0x800) {
      out[k++] = 0xc0 | (cp >> 6)
      out[k++] = 0x80 | (cp & 0x3f)
    } else if (cp < 0x10000) {
      out[k++] = 0xe0 | (cp >> 12)
      out[k++] = 0x80 | ((cp >> 6) & 0x3f)
      out[k++] = 0x80 | (cp & 0x3f)
    } else {
      out[k++] = 0xf0 | (cp >> 18)
      out[k++] = 0x80 | ((cp >> 12) & 0x3f)
      out[k++] = 0x80 | ((cp >> 6) & 0x3f)
      out[k++] = 0x80 | (cp & 0x3f)
    }
  }
  return out
}
