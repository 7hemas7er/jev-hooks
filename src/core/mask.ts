// Masking of reserved terms with the same semantics as guardrail (hooks/mask.py, a
// plugin by the same author). guardrail's mask map (GUARDRAIL_MASK_MAP or
// ~/.config/guardrail/mask.tsv) lists names of hosts, people or customers that must
// not leave the machine. guardrail applies it to Claude's tools, but it does not see
// what this plugin sends to a remote backend nor its additionalContext: here we apply
// it again ourselves. Conversely, our PreToolUse receives Claude's command
// with the placeholders, which guardrail replaces only when it runs it: to work out
// in which directory a commit happens we unmask it the way guardrail does.
//
// Two maskings can diverge: that is why every detail of mask.py is reproduced,
// including the ones that look accidental (the order of the replacements, the case
// shape, the Unicode characters that Python counts as ASCII letters). The parity
// vectors are in tests/core/mask.test.ts.
//
// Pure (rule 4): the caller reads the map, what arrives here is the text.

import type { MaskPair, Result } from './types.ts'
import { errResult, okResult } from './types.ts'

export type { MaskPair } from './types.ts'

// ─── Reading the map ──────────────────────────────────────────────────────────

// Python's whitespace (str.isspace), which applies to strip() and split() without
// arguments. It does not match JavaScript's \s: Python counts the separators
// \x1c-\x1f and U+0085, JavaScript counts U+FEFF. A leading BOM therefore stays
// attached to the first term, as in mask.py (which reads with encoding "utf-8", not
// "utf-8-sig").
const SPACES = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const RE_SPACES = new RegExp(`[${SPACES}]+`)
const RE_EDGES = new RegExp(`^[${SPACES}]+|[${SPACES}]+$`, 'g')

// The line endings of str.splitlines(): the line numbers in the error messages must
// be the ones guardrail would give on the same file.
const RE_LINES = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/

// The file name is not known here (the caller reads it) and the messages never quote
// a term, real or placeholder: the message ends up on screen and in the logs.
const MASK_MAP_NAME = 'mask map'

function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

// Same rules as mask.load_pairs: two fields per line, "#" starts a comment, empty
// lines are skipped; the placeholder does not equal the term (case-insensitively);
// no placeholder contains a real term, otherwise the output would reveal it. The
// result is sorted by decreasing length of the real term, ties in file order.
export function parseMaskMap(tsv: string): Result<MaskPair[]> {
  // mask.py reads the file as strict UTF-8 and rejects invalid bytes. Callers here
  // decode with replacement (readFileSync, $.fs.read) and an invalid byte arrives as
  // U+FFFD: it is treated the same way. A U+FFFD really written in the file is
  // rejected even though guardrail would accept it: when in doubt, nothing is sent.
  if (tsv.includes('\ufffd')) return errResult('mask_map', `${MASK_MAP_NAME} unreadable: not valid UTF-8`)
  const lines = tsv.split(RE_LINES)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const pairs: MaskPair[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#', 1)[0].replace(RE_EDGES, '')
    if (line === '') continue
    const fields = line.split(RE_SPACES)
    if (fields.length !== 2) {
      return errResult('mask_map', `${MASK_MAP_NAME}, line ${i + 1}: two fields are needed, real term and placeholder`)
    }
    const [real, placeholder] = fields
    if (real.toLowerCase() === placeholder.toLowerCase()) {
      return errResult('mask_map', `${MASK_MAP_NAME}, line ${i + 1}: the placeholder equals the real term`)
    }
    pairs.push({ real, placeholder })
  }
  for (const { real } of pairs) {
    const re = termRegex(real)
    for (const { placeholder } of pairs) {
      re.lastIndex = 0
      if (re.test(placeholder)) {
        return errResult('mask_map', `${MASK_MAP_NAME}: a placeholder contains a real term, the output would reveal it`)
      }
    }
  }
  // sort is stable: with equal lengths the file order stays, as with sorted()
  return okResult(pairs.sort((a, b) => codePointLength(b.real) - codePointLength(a.real)))
}

// ─── Searching for a term ─────────────────────────────────────────────────────

// A term counts only if it is not part of a longer word: `nas-warehouse` and
// `warehouse.lan` yes, `warehouses` no; the underscore separates. mask.py writes the
// boundary as [A-Za-z0-9] with re.IGNORECASE, and in Python that class also takes
// İ (U+0130) and ı (U+0131), which JavaScript's u flag does not fold onto i: they
// have to be written out. ſ (U+017F) and the Kelvin sign (U+212A), on the other hand,
// are folded onto s and k by both.
const BOUNDARY = '[A-Za-z0-9\\u0130\\u0131]'

// With re.IGNORECASE Python makes i, I, İ and ı equivalent; JavaScript with i and u
// only folds I onto i. It is the only difference between the two tables on characters
// with upper and lower case (exhaustive comparison done with Python 3.12 and Node 24):
// writing the class out in full fixes it.
const I_VARIANTS = new Set(['i', 'I', '\u0130', '\u0131'])
const I_CLASS = '[iI\\u0130\\u0131]'

// In u mode only syntax characters (and "/") can be escaped: a "\-" would be a
// syntax error.
const RE_SYNTAX = /[\\^$.*+?()[\]{}|/]/

// The counterpart of the term search in mask.py: re.escape(term) between the two
// boundaries.
function termRegex(term: string): RegExp {
  let body = ''
  for (const c of term) {
    if (I_VARIANTS.has(c)) body += I_CLASS
    else body += RE_SYNTAX.test(c) ? `\\${c}` : c
  }
  return new RegExp(`(?<!${BOUNDARY})${body}(?!${BOUNDARY})`, 'giu')
}

// ─── Case shape ───────────────────────────────────────────────────────────────

// Python's str.isupper() and str.islower(): true if no character is of the opposite
// case or titlecase and at least one is cased. The Unicode properties are the same
// ones Python uses for its tables (Uppercase, Lowercase, category Lt).
const RE_UPPER = /\p{Uppercase}/u
const RE_LOWER = /\p{Lowercase}/u
const RE_TITLECASE = /\p{Lt}/u

function isAllUpper(s: string): boolean {
  let cased = false
  for (const c of s) {
    if (RE_LOWER.test(c) || RE_TITLECASE.test(c)) return false
    if (RE_UPPER.test(c)) cased = true
  }
  return cased
}

function isAllLower(s: string): boolean {
  let cased = false
  for (const c of s) {
    if (RE_UPPER.test(c) || RE_TITLECASE.test(c)) return false
    if (RE_LOWER.test(c)) cased = true
  }
  return cased
}

function firstCodePoint(s: string): string {
  const cp = s.codePointAt(0)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

// The case-shape rule of mask.py: a term found in all capitals gives the
// substitute in all capitals, one with only the initial capitalized gives the
// substitute with a capital initial, anything else the substitute as in the map. It
// serves the way back: Claude rewrites the placeholder with the capitals it saw, and
// unmasking it must give back the file's shape. A single capital character is not
// "all capitals" (len > 1) and not "capital initial" (''.islower() is false): it stays
// as in the map, as in Python.
function sameCase(found: string, substitute: string): string {
  if (isAllUpper(found) && codePointLength(found) > 1) return substitute.toUpperCase()
  const initial = firstCodePoint(found)
  if (isAllUpper(initial) && isAllLower(found.slice(initial.length))) {
    const p = firstCodePoint(substitute)
    return p.toUpperCase() + substitute.slice(p.length)
  }
  return substitute
}

function replaceTerm(text: string, from: string, to: string): string {
  return text.replace(termRegex(from), (found) => sameCase(found, to))
}

// ─── The two directions ───────────────────────────────────────────────────────

// Real terms → placeholders, one pair after the other in map order (longest terms
// first): like mask.mask, even when a replacement creates an occurrence of a term that
// comes later.
export function mask(text: string, c: readonly MaskPair[]): string {
  for (const { real, placeholder } of c) text = replaceTerm(text, real, placeholder)
  return text
}

// Placeholders → real terms, in the same order (by length of the real term, not of
// the placeholder) and with the same boundaries: like mask.unmask.
export function unmask(text: string, c: readonly MaskPair[]): string {
  for (const { real, placeholder } of c) text = replaceTerm(text, placeholder, real)
  return text
}
