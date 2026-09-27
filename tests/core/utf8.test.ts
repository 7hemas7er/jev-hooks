import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utf8ByteLength, utf8 } from '../../src/core/utf8.ts'
import { generator, randomString } from '../helpers/strings.ts'

const withBuffer = (s: string): void => {
  const expected = Buffer.from(s, 'utf8')
  assert.deepEqual(Buffer.from(utf8(s)), expected, JSON.stringify(s))
  assert.equal(utf8ByteLength(s), expected.length, JSON.stringify(s))
}

test('known cases: ASCII, 2, 3 and 4 bytes, class boundaries', () => {
  for (const s of ['', 'a', 'é', '€', '😀', '\u007f', '\u0080', '߿', 'ࠀ', '￿', '\u{10000}', '\u{10ffff}', 'aé€😀']) withBuffer(s)
  assert.deepEqual([...utf8('é€😀')], [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80])
})

test('lone surrogates → EF BF BD, like TextEncoder and Buffer', () => {
  for (const s of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800', '\udc00\ud800', '😀\ud83d', '\ud83d']) withBuffer(s)
  assert.deepEqual([...utf8('\ud800')], [0xef, 0xbf, 0xbd])
  assert.deepEqual([...utf8('x\udfffy')], [0x78, 0xef, 0xbf, 0xbd, 0x79])
})

test('1000 random strings against Buffer.from', () => {
  const r = generator(20260925)
  for (let i = 0; i < 1000; i++) withBuffer(randomString(r, 64))
})

test('utf8ByteLength on a long text, without allocating the result', () => {
  const s = 'diff line with é and 😀\n'.repeat(20_000)
  assert.equal(utf8ByteLength(s), Buffer.byteLength(s, 'utf8'))
})
