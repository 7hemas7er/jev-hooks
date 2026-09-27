import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonical, canonicalInOrder, byCodePoint } from '../../src/core/canonical.ts'
import type { Json } from '../../src/core/types.ts'
import { generator, randomString } from '../helpers/strings.ts'

test('keys sorted at every level, no spaces, lists in their order', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, 1, { z: null, y: true }], c: 'x' } }), '{"a":{"c":"x","d":[3,1,{"y":true,"z":null}]},"b":1}')
  assert.equal(canonical([]), '[]')
  assert.equal(canonical({}), '{}')
  assert.equal(canonical('a "b"\n'), '"a \\"b\\"\\n"')
})

test('the same object with keys in a different order gives the same string', () => {
  const a: Json = { question: 'Which team?', ticket: 7, options: { y: 1, x: 2 } }
  const b: Json = { options: { x: 2, y: 1 }, ticket: 7, question: 'Which team?' }
  assert.equal(canonical(a), canonical(b))
  // the same example as rizzo-flow's compat tests
  assert.equal(canonical({ ticket: 7, question: 'Which team should handle `ticket`?' }), '{"question":"Which team should handle `ticket`?","ticket":7}')
})

test('ordered by code point, like Python\'s sort_keys, not by UTF-16 unit', () => {
  // U+FFFF comes before U+1F600 by code point; by UTF-16 unit (0xD83D) it would be the other way round
  assert.equal(canonical({ '\u{1F600}': 1, '￿': 2 }), '{"￿":2,"\u{1F600}":1}')
  assert.ok(byCodePoint('a', 'ab') < 0)
  assert.ok(byCodePoint('ab', 'a') > 0)
  assert.equal(byCodePoint('é', 'é'), 0)
})

test('the result goes back to the original object with JSON.parse', () => {
  const r = generator(3)
  for (let i = 0; i < 200; i++) {
    const o: { [k: string]: Json } = {}
    for (let k = 0; k < 5; k++) o[randomString(r, 6)] = [randomString(r, 10), k, k % 2 === 0, null]
    const s = canonical(o)
    assert.ok(!/[:,]\s/.test(s.replace(/"(?:[^"\\]|\\.)*"/g, '""')), 'no space outside strings')
    assert.deepEqual(JSON.parse(s), JSON.parse(JSON.stringify(o)))
  }
})

test('numbers as in JSON.stringify, non-finite ones as null', () => {
  assert.equal(canonical([1, 0.5, -0, 1e21, Number.NaN as unknown as Json]), '[1,0.5,0,1e+21,null]')
})

test('canonicalInOrder: the object\'s keys in insertion order, the values canonical', () => {
  assert.equal(canonicalInOrder({ z: 1, a: { d: 1, c: [2, 1] }, m: null }), '{"z":1,"a":{"c":[2,1],"d":1},"m":null}')
  assert.notEqual(canonicalInOrder({ none: 'x', sql: 'y' }), canonicalInOrder({ sql: 'y', none: 'x' }))
  assert.equal(canonicalInOrder({}), '{}')
  // same string as canonical when the keys are already in order
  assert.equal(canonicalInOrder({ a: 1, b: [true] }), canonical({ b: [true], a: 1 }))
})
