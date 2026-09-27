// Parity with guardrail/hooks/mask.py. The vectors are written by hand: those of the
// first part repeat the cases of guardrail/tests/test_mask.py (the same test map,
// made-up names), extended to the return trip (unmask); the others pin down the
// details where two implementations most easily diverge: Unicode boundaries, the
// shape of capitals, the order of the replacements, the rules of the map. Every
// expected value was also checked against mask.py (Python 3.12), once, outside the
// suite: Python is not needed here.
//
// The placeholders of guardrail's test map are renamed to artificial words (luogoq7,
// dbone): a common placeholder could coincide with one from a real map, and with
// guardrail active it would be unmasked while Claude writes this very file, putting a
// reserved term into the repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMaskMap, mask, unmask } from '../../src/core/mask.ts'
import type { MaskPair } from '../../src/core/types.ts'

// Characters that look like ASCII letters: by name, not pasted.
const DOTTED_I = String.fromCodePoint(0x130)          // Turkish capital I with dot
const DOTLESS_I = String.fromCodePoint(0x131)    // Turkish small dotless i
const LONG_S = String.fromCodePoint(0x17f)
const KELVIN = String.fromCodePoint(0x212a)          // Kelvin sign, folds to k
const UPPERCASE_ESZETT = String.fromCodePoint(0x1e9e)
const E_ACUTE = String.fromCodePoint(0xe9)
const EMOJI = String.fromCodePoint(0x1f600)
const BOM = String.fromCodePoint(0xfeff)
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000)
const NEL = String.fromCodePoint(0x85)
const LINE_SEPARATOR = String.fromCodePoint(0x2028)
const SUBSTITUTION = String.fromCodePoint(0xfffd)

function maskMap(tsv: string): MaskPair[] {
  const m = parseMaskMap(tsv)
  if (!m.ok) assert.fail(`invalid map: ${m.error.message}`)
  return m.value
}

function error(tsv: string): string {
  const m = parseMaskMap(tsv)
  if (m.ok) assert.fail(`expected an invalid map: ${JSON.stringify(tsv)}`)
  assert.equal(m.error.kind, 'mask_map')
  return m.error.message
}

// ─── vectors ───
// The map of guardrail/tests/fixtures/mask.tsv, with the first placeholder renamed.
const SAMPLE = '# Test map for masking: made-up names, one pair per line.\n'
  + 'warehouse                   luogoq7\n'
  + 'db-production.example.com   dbone\n'

// [map, text, expected from mask, expected from unmask]
const VECTORS: [string, string, string, string][] = [
  // the cases of test_mask.py
  [SAMPLE, 'nas-warehouse.home.lan NAS-WAREHOUSE Warehouse', 'nas-luogoq7.home.lan NAS-LUOGOQ7 Luogoq7', 'nas-warehouse.home.lan NAS-WAREHOUSE Warehouse'],
  [SAMPLE, "printf '%s\\n' nas-luogoq7.home.lan | tr a-z A-Z", "printf '%s\\n' nas-luogoq7.home.lan | tr a-z A-Z", "printf '%s\\n' nas-warehouse.home.lan | tr a-z A-Z"],
  [SAMPLE, 'NAS-WAREHOUSE.HOME.LAN\n', 'NAS-LUOGOQ7.HOME.LAN\n', 'NAS-WAREHOUSE.HOME.LAN\n'],
  [SAMPLE, 'ls: cannot access /nowhere/dir/warehouse: No such file', 'ls: cannot access /nowhere/dir/luogoq7: No such file', 'ls: cannot access /nowhere/dir/warehouse: No such file'],
  [SAMPLE, 'barn warehouses', 'barn warehouses', 'barn warehouses'],
  [SAMPLE, 'db-production.example.com', 'dbone', 'db-production.example.com'],
  [SAMPLE, 'ping -c1 nas-luogoq7.home.lan', 'ping -c1 nas-luogoq7.home.lan', 'ping -c1 nas-warehouse.home.lan'],
  [SAMPLE, 'please ping nas-Warehouse.home.lan', 'please ping nas-Luogoq7.home.lan', 'please ping nas-Warehouse.home.lan'],
  [SAMPLE, '/x/nas-warehouse.txt', '/x/nas-luogoq7.txt', '/x/nas-warehouse.txt'],
  [SAMPLE, 'Warehouse and WAREHOUSE\n', 'Luogoq7 and LUOGOQ7\n', 'Warehouse and WAREHOUSE\n'],
  [SAMPLE, 'host warehouse up', 'host luogoq7 up', 'host warehouse up'],
  [SAMPLE, 'AAA/warehouse+BBB', 'AAA/luogoq7+BBB', 'AAA/warehouse+BBB'],
  // the return trip with Claude's capitals
  [SAMPLE, 'Luogoq7, LUOGOQ7, luogoq7, lUoGoQ7, DBONE', 'Luogoq7, LUOGOQ7, luogoq7, lUoGoQ7, DBONE', 'Warehouse, WAREHOUSE, warehouse, warehouse, DB-PRODUCTION.EXAMPLE.COM'],
  // boundaries: the underscore separates, digits do not
  [SAMPLE, 'warehouse_2 and 2_warehouse, warehouse2 and 2warehouse', 'luogoq7_2 and 2_luogoq7, warehouse2 and 2warehouse', 'warehouse_2 and 2_warehouse, warehouse2 and 2warehouse'],
  // Unicode boundaries: for Python the long s, the two Turkish i and the Kelvin sign are ASCII letters, é is not
  [SAMPLE, `${LONG_S}warehouse ${DOTLESS_I}warehouse ${DOTTED_I}warehouse ${KELVIN}warehouse ${E_ACUTE}warehouse warehouse${E_ACUTE} warehouse${DOTTED_I}`,
    `${LONG_S}warehouse ${DOTLESS_I}warehouse ${DOTTED_I}warehouse ${KELVIN}warehouse ${E_ACUTE}luogoq7 luogoq7${E_ACUTE} warehouse${DOTTED_I}`,
    `${LONG_S}warehouse ${DOTLESS_I}warehouse ${DOTTED_I}warehouse ${KELVIN}warehouse ${E_ACUTE}warehouse warehouse${E_ACUTE} warehouse${DOTTED_I}`],
  [SAMPLE, `${EMOJI}warehouse${EMOJI}`, `${EMOJI}luogoq7${EMOJI}`, `${EMOJI}warehouse${EMOJI}`],
  // inside a term i, I and the two Turkish i are equivalent; the long s counts as s, the Kelvin sign as k
  ['iron steel\nkappa2 bx\n', `IRON ${DOTTED_I}ron ${DOTLESS_I}ron Iron ${DOTTED_I}RON`, 'STEEL Steel steel Steel STEEL', `IRON ${DOTTED_I}ron ${DOTLESS_I}ron Iron ${DOTTED_I}RON`],
  ['iron steel\nkappa2 bx\n', `${KELVIN}APPA2 ${KELVIN}appa2 BX Bx`, 'BX Bx BX Bx', `${KELVIN}APPA2 ${KELVIN}appa2 KAPPA2 Kappa2`],
  ['sun moon\n', `${LONG_S}un SUN`, 'moon MOON', `${LONG_S}un SUN`],
  // shape: all capitals (at least two characters), initial capital, otherwise the map's
  [SAMPLE, 'WaReHoUsE wAREHOUSE', 'luogoq7 luogoq7', 'WaReHoUsE wAREHOUSE'],
  ['warehouse2 depot\n', 'Warehouse2 WAREHOUSE2 warehouse2', 'Depot DEPOT depot', 'Warehouse2 WAREHOUSE2 warehouse2'],
  ['q zz\n', 'Q q Q-q', 'zz zz zz-zz', 'Q q Q-q'],
  ['warehouse straße\n', 'WAREHOUSE Warehouse', 'STRASSE Straße', 'WAREHOUSE Warehouse'],
  ['warehouse straße\n', `STRASSE STRA${UPPERCASE_ESZETT}E Straße`, `STRASSE STRA${UPPERCASE_ESZETT}E Straße`, 'STRASSE WAREHOUSE Warehouse'],
  // order: the longest real terms first, on the return trip too
  ['warehouse luogoq7\nwarehouse-north depot\n', 'warehouse-north and warehouse', 'depot and luogoq7', 'warehouse-north and warehouse'],
  ['warehouse luogoq7\nwarehouse-north depot\n', 'depot and luogoq7', 'depot and luogoq7', 'warehouse-north and warehouse'],
  // replacements in sequence, like mask.py, even when one creates an occurrence of another
  ['alpha-beta x1\nbeta alpha\n', 'beta alpha-beta', 'alpha x1', 'beta beta-beta'],
  ['alpha-beta x1\nbeta alpha\n', 'x1 alpha', 'x1 alpha', 'beta-beta beta'],
  // regex special characters inside the terms
  ['a.b+c x-1\n(te)st y\n', 'a.b+c axb+c (te)st (TE)ST', 'x-1 axb+c y Y', 'a.b+c axb+c (te)st (TE)ST'],
  // empty map: nothing changes
  ['# comments only\n', 'warehouse', 'warehouse', 'warehouse'],
]
// ─── end of vectors ───

test('mask and unmask: parity vectors with mask.py', () => {
  for (const [tsv, text, masked, unmasked] of VECTORS) {
    const c = maskMap(tsv)
    assert.equal(mask(text, c), masked, `mask(${JSON.stringify(text)})`)
    assert.equal(unmask(text, c), unmasked, `unmask(${JSON.stringify(text)})`)
  }
})

test('the left and right boundary, on every code point', () => {
  // mask.py: (?<![A-Za-z0-9]) and (?![A-Za-z0-9]) with re.IGNORECASE. In Python the
  // class takes 66 characters: the 62 ASCII letters and digits plus the two Turkish i,
  // the long s and the Kelvin sign.
  const boundary = new Set<number>([0x130, 0x131, 0x17f, 0x212a])
  for (let c = 0x30; c <= 0x7a; c++) if (/[A-Za-z0-9]/.test(String.fromCharCode(c))) boundary.add(c)
  assert.equal(boundary.size, 66)
  const c = maskMap('warehouse luogoq7\n')
  const points: number[] = []
  // the space separates the pieces, which is why it is not among the characters tried
  for (let cp = 0; cp <= 0x10ffff; cp++) if ((cp < 0xd800 || cp > 0xdfff) && cp !== 0x20) points.push(cp)
  const left = mask(points.map((cp) => `${String.fromCodePoint(cp)}warehouse`).join(' '), c).split(' ')
  const right = mask(points.map((cp) => `warehouse${String.fromCodePoint(cp)}`).join(' '), c).split(' ')
  assert.equal(left.length, points.length)
  // a piece is not masked if it still ends (or starts) with the real term
  const wrong: string[] = []
  points.forEach((cp, k) => {
    const blocks = boundary.has(cp)
    if (left[k].endsWith('warehouse') !== blocks) wrong.push(`left U+${cp.toString(16)}`)
    if (right[k].startsWith('warehouse') !== blocks) wrong.push(`right U+${cp.toString(16)}`)
  })
  assert.deepEqual(wrong, [])
})

test('round trip: with the three canonical shapes unmask(mask(x)) = x', () => {
  const c = maskMap(`${SAMPLE}warehouse-north depot\n`)
  let s = 1
  const r = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 }
  const terms = ['warehouse', 'db-production.example.com', 'warehouse-north', 'other', 'nas', 'home.lan']
  const shapes = [(t: string) => t, (t: string) => t.toUpperCase(), (t: string) => t[0].toUpperCase() + t.slice(1)]
  const separators = [' ', '-', '.', '/', '_', '\n', ': ', '(', ')']
  for (let k = 0; k < 500; k++) {
    let x = ''
    for (let j = 0; j < 8; j++) x += shapes[Math.floor(r() * 3)](terms[Math.floor(r() * terms.length)]) + separators[Math.floor(r() * separators.length)]
    assert.equal(unmask(mask(x, c), c), x)
  }
})

test('parseMaskMap: comments, empty lines, Python whitespace, order by length', () => {
  const one = [{ real: 'warehouse', placeholder: 'luogoq7' }]
  assert.deepEqual(maskMap(''), [])
  assert.deepEqual(maskMap('# comments only\n\n   \n\t\n'), [])
  assert.deepEqual(maskMap('warehouse luogoq7 # trailing comment'), one)
  assert.deepEqual(maskMap('warehouse\t luogoq7'), one)
  // separators that are whitespace for Python and not for JavaScript's \s, and vice versa
  assert.deepEqual(maskMap(`warehouse${IDEOGRAPHIC_SPACE}luogoq7`), one)
  assert.deepEqual(maskMap(`warehouse\x1f luogoq7${NEL}`), one)
  assert.deepEqual(maskMap('warehouse\xa0 luogoq7'), one)
  // a BOM stays attached to the first term, as in mask.py (utf-8, not utf-8-sig)
  assert.deepEqual(maskMap(`${BOM}warehouse luogoq7`), [{ real: `${BOM}warehouse`, placeholder: 'luogoq7' }])
  // by decreasing length of the real term in code points; on a tie, the file's order
  assert.deepEqual(maskMap(`ab x1\nabcd x2\nabc x3\nefgh x4\n${EMOJI}${EMOJI} x5`).map((c) => c.real),
    ['abcd', 'efgh', 'abc', 'ab', `${EMOJI}${EMOJI}`])
  assert.deepEqual(maskMap(`a.b x\r\nc y\rd z\x0be w\x0cf v${LINE_SEPARATOR}g u`).map((c) => c.real), ['a.b', 'c', 'd', 'e', 'f', 'g'])
})

test('parseMaskMap: invalid maps, with the line number of splitlines()', () => {
  const twoFields = 'two fields are needed, real term and placeholder'
  // guardrail/tests/fixtures/mask-rotta.tsv
  assert.equal(error('only-one-field\n'), `mask map, line 1: ${twoFields}`)
  assert.equal(error('one two three'), `mask map, line 1: ${twoFields}`)
  assert.equal(error('# c\n\nwarehouse WAREHOUSE'), 'mask map, line 3: the placeholder equals the real term')
  // \r\n is a single line end; \x0b and \x1c are line ends too (\x1c is also whitespace)
  assert.equal(error('x y\r\nwarehouse\x0bluogoq7'), `mask map, line 2: ${twoFields}`)
  assert.equal(error('x y\nwarehouse\x1cluogoq7'), `mask map, line 2: ${twoFields}`)
  // a placeholder that contains a real term, of the same pair or of another one
  const contains = 'mask map: a placeholder contains a real term, the output would reveal it'
  assert.equal(error('bank bank-two'), contains)
  assert.equal(error('smith s-jones\njones j1'), contains)
  assert.equal(error('Smith placeholder-SMITH'), contains)
  // bank7 does not contain "bank": a digit follows, not a boundary
  assert.equal(maskMap('bank bank7').length, 1)
  // non-UTF-8 bytes, decoded with replacement by whoever reads the file
  assert.equal(error(`warehouse luogoq7\nx${SUBSTITUTION}y z`), 'mask map unreadable: not valid UTF-8')
})

test('the error messages never quote the terms', () => {
  for (const tsv of ['confidential', 'confidential CONFIDENTIAL', 'confidential c-confidential', 'confidential a b']) {
    const m = error(tsv)
    assert.ok(!/confidential/i.test(m), m)
  }
})
