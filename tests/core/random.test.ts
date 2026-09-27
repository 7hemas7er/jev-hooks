import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prng } from '../../src/core/random.ts'

const firstValues = (seed: number, n: number): number[] => {
  const r = prng(seed)
  return Array.from({ length: n }, () => r())
}

// Reference written separately: the xorshift32 step (13, 17, 5) on 32 bits.
function xorshiftStep(x: number): number {
  x = (x ^ (x << 13)) >>> 0
  x = (x ^ (x >>> 17)) >>> 0
  x = (x ^ (x << 5)) >>> 0
  return x
}

test('same seed, same sequence; different seeds, different sequences', () => {
  assert.deepEqual(firstValues(42, 50), firstValues(42, 50))
  assert.notDeepEqual(firstValues(42, 50), firstValues(43, 50))
  // two consecutive milliseconds from the clock: the real seed of the redaction
  const ms = 1_790_000_000_000
  const a = firstValues(ms, 20)
  const b = firstValues(ms + 1, 20)
  assert.equal(a.filter((x, i) => x === b[i]).length, 0)
  assert.ok(Math.abs(a[0] - b[0]) > 1e-6, 'close seeds must not give close first values')
})

test('it is xorshift32: every value follows from the previous one', () => {
  for (const seed of [1, 7, 20260925, 1_790_000_000_000]) {
    const v = firstValues(seed, 1000).map((x) => x * 4294967296)
    for (let i = 1; i < v.length; i++) assert.equal(v[i], xorshiftStep(v[i - 1]), `seed ${seed}, step ${i}`)
  }
})

test('values in [0, 1), never NaN, and no short-range repeats', () => {
  const r = prng(20260925)
  const seen = new Set<number>()
  for (let i = 0; i < 100_000; i++) {
    const x = r()
    assert.ok(x >= 0 && x < 1, `value outside [0, 1): ${x}`)
    seen.add(x)
  }
  assert.equal(seen.size, 100_000)
})

test('extreme seeds still give a generator that moves', () => {
  for (const seed of [0, -1, -1_790_000_000_000, 2 ** 53, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 4294967295]) {
    const v = firstValues(seed, 100)
    assert.ok(v.every((x) => x >= 0 && x < 1), `seed ${seed}`)
    assert.ok(new Set(v).size > 90, `seed ${seed}: generator stuck`)
  }
})

test('roughly uniform distribution', () => {
  const r = prng(99)
  const buckets = new Array<number>(10).fill(0)
  const n = 200_000
  for (let i = 0; i < n; i++) buckets[Math.floor(r() * 10)]++
  for (const k of buckets) assert.ok(Math.abs(k - n / 10) < n / 100, `unbalanced buckets: ${buckets.join(', ')}`)
})
