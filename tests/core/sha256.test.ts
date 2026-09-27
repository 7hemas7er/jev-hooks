import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sha256Hex, sha256HexBytes } from '../../src/core/sha256.ts'
import { generator, randomString } from '../helpers/strings.ts'

const fromNode = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex')

test('known FIPS 180-4 vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
})

test('padding boundaries: 55, 56, 63, 64 and 65 bytes', () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
    const s = 'x'.repeat(n)
    assert.equal(sha256Hex(s), fromNode(s), `length ${n}`)
  }
})

test('1000 random strings, including non-ASCII and lone surrogates, against node:crypto', () => {
  const r = generator(7)
  for (let i = 0; i < 1000; i++) {
    const s = randomString(r, 200)
    // Buffer.from replaces lone surrogates with U+FFFD like utf8(): same bytes, same hash
    assert.equal(sha256Hex(s), fromNode(Buffer.from(s, 'utf8')), JSON.stringify(s))
  }
})

test('arbitrary bytes and a text of a few megabytes', () => {
  const r = generator(42)
  const bytes = new Uint8Array(10_000).map(() => Math.floor(r() * 256))
  assert.equal(sha256HexBytes(bytes), fromNode(bytes))
  const large = 'diff --git a/x b/x\n+added line\n'.repeat(60_000)
  assert.equal(sha256Hex(large), fromNode(large))
})
