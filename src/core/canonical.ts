// Canonical JSON: sorted keys, no whitespace. It is the form the sha256 of a
// question is computed on (a calibration fit is valid only for the exact text it
// was made on) and the same form rizzo-flow builds for instructions and structured
// criteria (json.dumps with sort_keys and compact separators), so it also serves
// to measure their length.
import type { Json } from './types.ts'

// Python's sort_keys orders by code point, JavaScript by UTF-16 unit: the two only
// diverge on characters outside the basic plane, but there must be a single
// canonical key.
export function byCodePoint(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number
    const cb = b.codePointAt(j) as number
    if (ca !== cb) return ca - cb
    i += ca > 0xffff ? 2 : 1
    j += cb > 0xffff ? 2 : 1
  }
  return (i < a.length ? 1 : 0) - (j < b.length ? 1 : 0)
}

export function canonical(v: Json): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
    // non-finite numbers become null, as in JSON.stringify
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(',')}]`
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(byCodePoint)
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}

// Like canonical, but the keys of this object stay in insertion order
// (Object.keys, the same as JSON.stringify and therefore as the body sent); the
// values are canonical. It is used where the model sees the order: rizzo assigns
// the letters A, B, C… to the options of a choice in key order, and the same choice
// with none first or last answers the opposite way (bench, 2026-09-26).
export function canonicalInOrder(o: { [k: string]: Json }): string {
  const keys = Object.keys(o).filter((k) => o[k] !== undefined)
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
