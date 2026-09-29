// Minimal typed validator for the configuration JSON files. No schema and no
// dependencies: functions that read an `unknown` value, return the typed value or
// undefined, and meanwhile record every problem with file, JSON pointer (RFC 6901)
// and a message that says what was expected and what was there. All the problems of
// a file are collected in one go: whoever opens the JSON to fix it sees them all,
// not one per attempt.
import type { Failure, Result, Json, Problem } from './types.ts'

export type PlainObject = { [k: string]: unknown }

// Check ids, router question ids, detector names: the same constraints everywhere. It
// is the shape of an id, not a guarantee about its content: an order for Claude
// written in snake_case fits it. That is why an id from an untrusted file is quoted
// only when it is a known word (below), never because it has the right shape.
export const RE_ID = /^[a-z][a-z0-9_]{0,63}$/

// An untrusted file (the project layer) is written by a cloned repo, and its
// problems end up in the warnings: in the systemMessage, on the stderr of the CLI that
// Claude can run, tomorrow in the context of a skill. For that file the messages quote
// only known words, numbers and fixed phrases: never a value or a key chosen by the file.
//
// Known words come in two kinds, both written by someone trusted: the vocabulary of
// the trusted layers (check ids, detector names, lanes, choice options of the user
// file and of the plugin), which the caller passes to reader(), and the field names
// the validator itself asks for or allows, which onlyFields and requiredField record
// while they read. A word chosen by the file never gets in: a placeholder takes its place.
export interface Reader { file: string; problems: Problem[]; untrusted?: boolean; words?: Set<string>; notes?: string[] }

export function reader(file: string, untrusted: boolean = false, vocabulary: Iterable<string> = []): Reader {
  return untrusted ? { file, problems: [], untrusted: true, words: new Set(vocabulary) } : { file, problems: [] }
}

// No known words: for a text that comes from an untrusted file and must never be
// quoted (the flags of a regex, a lane in a project checks.json).
export const NO_WORDS: ReadonlySet<string> = new Set()

// For a field name the validator knows but does not ask for with requiredField or
// onlyFields (the "true" and "false" criteria of a noul).
export function addKnownWords(l: Reader, words: readonly string[]): void {
  if (l.words) for (const p of words) l.words.add(p)
}

// The placeholder for a text not shown and for a pointer segment that is not known.
const HIDDEN_TEXT = '(text not shown)'
const HIDDEN_KEY = '‹key›'

// A JSON pointer into an untrusted file: the file chooses the keys, and a pointer to
// "/detectors/0/<a sentence>" would carry the sentence into the message. Indexes and
// known words stay; every other segment becomes a fixed placeholder.
export function safePointer(p: string, words: ReadonlySet<string> = NO_WORDS): string {
  if (p === '') return p
  return p.split('/').map((s, i) => (i === 0 || words.has(s) || /^(0|[1-9][0-9]{0,5})$/.test(s) ? s : HIDDEN_KEY)).join('/')
}

// A text chosen by the file, quoted in a message. words is null for a trusted file
// (everything is quoted, in double quotes); for an untrusted one only a known word is.
export function quote(s: string, words: ReadonlySet<string> | null): string {
  return words === null || words.has(s) ? `"${s}"` : HIDDEN_TEXT
}

// quote for the file being read.
export function quoteFor(l: Reader, s: string): string {
  return quote(s, l.untrusted ? l.words ?? NO_WORDS : null)
}

// Not a problem: something the reader set aside on the safe side, which the user
// should still hear about (it ends up among the warnings).
export function addNote(l: Reader, pointer: string, message: string): void {
  (l.notes ??= []).push(`${l.file} ${l.untrusted ? safePointer(pointer, l.words) : pointer}: ${message}`)
}

export function addProblem(l: Reader, pointer: string, message: string, file: string = l.file): void {
  l.problems.push({ file, pointer: l.untrusted ? safePointer(pointer, l.words) : pointer, message })
}

export function isObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Child pointer: "~" and "/" inside a key are written "~0" and "~1".
export function childPointer(pointer: string, key: string | number): string {
  return `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
}

// Short description of a value found, for the messages: strings quoted and
// truncated, so a "0,7" written instead of 0.7 shows at once.
export function describe(v: unknown): string {
  if (v === undefined) return 'nothing'
  if (v === null) return 'null'
  if (typeof v === 'string') {
    const s = JSON.stringify(v)
    return s.length > 60 ? `${s.slice(0, 57)}…"` : s
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.length === 0 ? 'an empty list' : 'a list'
  if (isObject(v)) return Object.keys(v).length === 0 ? 'an empty object' : 'an object'
  return typeof v
}

// describe for the file being read: from an untrusted file a string is quoted only
// when it is a known word, numbers and shapes always. A typo ("nou" instead of
// "noul") does not show, but the message says which values are allowed.
function describeFor(l: Reader, v: unknown): string {
  if (l.untrusted && typeof v === 'string' && !(l.words?.has(v) ?? false)) return `a string ${HIDDEN_TEXT}`
  return describe(v)
}

export function formatProblem(p: Problem): string {
  return p.pointer === '' ? `${p.file}: ${p.message}` : `${p.file} ${p.pointer}: ${p.message}`
}

// Configuration failure with all the problems: the message gives the first one in
// full, and how many more there are.
export function configFailure(problems: Problem[]): Failure {
  const first = problems.length > 0 ? formatProblem(problems[0]) : 'invalid configuration'
  const others = problems.length > 1 ? ` (and ${problems.length - 1} more problems)` : ''
  return { kind: 'config', message: `${first}${others}`, problems }
}

export function readerResult<T>(l: Reader, value: T): Result<T> {
  return l.problems.length === 0 ? { ok: true, value } : { ok: false, error: configFailure(l.problems) }
}

// The detail of a JSON.parse error for an untrusted file: V8 quotes a piece of the
// source (Unexpected token 'x', "{"a": xyz"... is not valid JSON), so only the
// position stays, if there is one.
function untrustedDetail(message: string): string {
  const pos = /at position (\d+)/.exec(message)
  const line = /\(line (\d+) column (\d+)\)/.exec(message)
  if (line) return `line ${line[1]}, column ${line[2]}`
  if (pos) return `position ${pos[1]}`
  return /Unexpected end of JSON input/.test(message) ? 'the file ends too early' : 'syntax'
}

// JSON.parse with the BOM removed and an error that names the file.
export function parseJson(text: string, file: string, untrusted: boolean = false): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const errorDetail = untrusted ? untrustedDetail(raw) : raw
    return {
      ok: false,
      error: { kind: 'config', message: `${file}: invalid JSON (${errorDetail})`, problems: [{ file, pointer: '', message: `invalid JSON (${errorDetail})` }] },
    }
  }
}

// True if v is a JSON value: no undefined, functions, NaN or infinities. It is used
// for the fields that are sent as they are (instructions, criteria).
export function isJson(v: unknown): v is Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(isJson)
  if (isObject(v)) return Object.values(v).every(isJson)
  return false
}

// Keys of an object without the comments: every key starting with "_" is for people
// (_comment, _why) and the validator skips it at every level.
export function fieldsOf(o: PlainObject): string[] {
  return Object.keys(o).filter((k) => !k.startsWith('_'))
}

// ─── Readers ──────────────────────────────────────────────────────────────────

export function readObject(l: Reader, v: unknown, p: string): PlainObject | undefined {
  if (isObject(v)) return v
  addProblem(l, p, `expected an object, found ${describeFor(l, v)}`)
  return undefined
}

// An unknown field is almost always a typo ("treshold", "unles"): ignoring it
// silently would mean a rule that does not do what its author believes.
export function onlyFields(l: Reader, o: PlainObject, p: string, allowed: readonly string[]): void {
  addKnownWords(l, allowed)
  for (const k of fieldsOf(o)) {
    if (!allowed.includes(k)) addProblem(l, childPointer(p, k), `unknown field (allowed: ${allowed.join(', ')})`)
  }
}

export function requiredField(l: Reader, o: PlainObject, p: string, key: string): unknown {
  addKnownWords(l, [key])
  if (!(key in o) || o[key] === undefined) {
    addProblem(l, childPointer(p, key), 'required field missing')
    return undefined
  }
  return o[key]
}

export function readString(l: Reader, v: unknown, p: string, o: { nonEmpty?: boolean; max?: number } = {}): string | undefined {
  if (typeof v !== 'string') {
    addProblem(l, p, `expected a string, found ${describeFor(l, v)}`)
    return undefined
  }
  if (o.nonEmpty && v.trim() === '') {
    addProblem(l, p, 'expected a non-empty string')
    return undefined
  }
  if (o.max !== undefined && v.length > o.max) {
    addProblem(l, p, `string too long: ${v.length} characters, at most ${o.max}`)
    return undefined
  }
  return v
}

export interface NumberConstraints {
  min?: number        // inclusive
  max?: number        // inclusive
  above?: number      // exclusive: the value must be > above
  integer?: boolean
}

function describeConstraints(o: NumberConstraints): string {
  const what = o.integer ? 'an integer' : 'a number'
  const low = o.above !== undefined ? `> ${o.above}` : o.min !== undefined ? `≥ ${o.min}` : ''
  if (o.min !== undefined && o.max !== undefined) return `${what} between ${o.min} and ${o.max}`
  if (low && o.max !== undefined) return `${what} ${low} and ≤ ${o.max}`
  if (low) return `${what} ${low}`
  if (o.max !== undefined) return `${what} ≤ ${o.max}`
  return what
}

export function readNumber(l: Reader, v: unknown, p: string, o: NumberConstraints = {}): number | undefined {
  const outside = typeof v !== 'number' || !Number.isFinite(v)
    || (o.integer === true && !Number.isInteger(v))
    || (o.min !== undefined && v < o.min)
    || (o.max !== undefined && v > o.max)
    || (o.above !== undefined && v <= o.above)
  if (outside) {
    addProblem(l, p, `expected ${describeConstraints(o)}, found ${describeFor(l, v)}`)
    return undefined
  }
  return v as number
}

export function readBoolean(l: Reader, v: unknown, p: string): boolean | undefined {
  if (typeof v === 'boolean') return v
  addProblem(l, p, `expected true or false, found ${describeFor(l, v)}`)
  return undefined
}

export function readOneOf<T extends string>(l: Reader, v: unknown, p: string, values: readonly T[]): T | undefined {
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T
  addProblem(l, p, `expected one of ${values.map((x) => `"${x}"`).join(', ')}, found ${describeFor(l, v)}`)
  return undefined
}

export function readList(l: Reader, v: unknown, p: string, o: { min?: number; max?: number } = {}): unknown[] | undefined {
  if (!Array.isArray(v)) {
    addProblem(l, p, `expected a list, found ${describeFor(l, v)}`)
    return undefined
  }
  if (o.min !== undefined && v.length < o.min) {
    addProblem(l, p, o.min === 1 ? 'expected a non-empty list' : `expected at least ${o.min} items, found ${v.length}`)
    return undefined
  }
  if (o.max !== undefined && v.length > o.max) {
    addProblem(l, p, `expected at most ${o.max} items, found ${v.length}`)
    return undefined
  }
  return v
}

// Reads every item with `el`; returns undefined if even one of them is wrong.
export function readListOf<T>(l: Reader, v: unknown, p: string, el: (x: unknown, p: string) => T | undefined, o: { min?: number; max?: number } = {}): T[] | undefined {
  const xs = readList(l, v, p, o)
  if (!xs) return undefined
  const before = l.problems.length
  const parsed: T[] = []
  xs.forEach((x, i) => {
    const r = el(x, childPointer(p, i))
    if (r !== undefined) parsed.push(r)
  })
  return l.problems.length === before ? parsed : undefined
}
