// Validation of the four JSON files that decide the behaviour (checks, policy,
// calibration, router) and composition of the project > user > plugin layers.
// "Open a JSON, never touch the code": there is no check id or threshold here, only
// the shape rules. Every error names file, pointer and what was expected, because
// whoever opens the JSON to change a threshold must understand alone what they broke.
import { canonical } from './canonical.ts'
import {
  addKnownWords, readBoolean, fieldsOf, quote, quoteFor, isJson, isObject, readerResult, childPointer, formatProblem, parseJson, reader, readList, readListOf,
  NO_WORDS, readNumber, readObject, safePointer, RE_ID, requiredField, addProblem, addNote, onlyFields, readString, readOneOf,
} from './json.ts'
import type { Reader, PlainObject, NumberConstraints } from './json.ts'
import { LIMITS, HOOK_ESCALATION_MODES, EFFORT_SCALE, PROMPT_ORIGIN_KINDS } from './types.ts'
import type {
  Calibration, CheckDef, Checks, CiConclusion, RouterCondition, ComposedConfig, Lane, WireQuestion, Effort, Result,
  ConfigFile, Json, ConfigLayers, Op, Origin, EffortStep, Policy, Problem, Profile, Rule, Detector,
  RouterConfig, QuestionType, CalibrationEntry, CacheGuard, Condition,
} from './types.ts'

export type {
  Calibration, CheckDef, Checks, CiConclusion, RouterCondition, ComposedConfig, Lane, ConfigFile, ConfigLayers, Op,
  Origin, EffortStep, Policy, Profile, Rule, Detector, RouterConfig, CalibrationEntry, CacheGuard,
} from './types.ts'

// RE_ID (json.ts): check ids, router question ids, detector names.
const MSG_ID = 'invalid id: lowercase letters, digits and _, starting with a letter, at most 64 characters'

// Length cap of the regexes: it is not enough against catastrophic backtracking
// (`(a|aa)+$` has 8 characters), but it limits the cost of every evaluation.
export const MAX_REGEX = 300

// For hook and skill total_ms must stay below the hooks.json timeout (180 s) minus a
// 20 s margin: beyond it, Claude Code cancels the hook and the commit goes ahead
// without even the deterministic floors. validate-manifest.ts checks that the
// hooks.json timeouts do not drop below 180 s.
export const HOOK_TIMEOUT_S = 180
export const HOOK_CAP_MS = (HOOK_TIMEOUT_S - 20) * 1000

const QUESTION_TYPES = ['noul', 'choice', 'score'] as const
const OPS = ['gte', 'gt', 'lte', 'lt'] as const
const ORIGINS = ['hook', 'skill', 'cli', 'action'] as const
const CONCLUSIONS = ['failure', 'neutral', 'success'] as const
const WHERE_VALUES = ['added_lines', 'title', 'description', 'paths'] as const
const ESCALATE_VALUES = ['never', 'if_model_disagrees', 'always'] as const

// ═══ Regex: compilation and static check against catastrophic backtracking ═══
//
// The time of a backtracking regex explodes because of its shape, not its length. The
// two classic shapes are rejected: nested quantifiers (star height > 1, `(a+)+`,
// `(\w*\s?)*`) and alternatives that can start with the same character under a
// repeating quantifier (`(a|aa)+`, `(\w|\d)*`). The check is conservative: it may
// reject some harmless regex, never accept one of the two shapes. Project regexes run
// in a Worker with a time limit anyway.

type CharSet = [number, number][]   // ranges of UTF-16 units, sorted and disjoint

type Node =
  | { k: 'class'; s: CharSet }
  | { k: 'empty' }                        // anchors and \b: zero width
  | { k: 'backref' }                          // backreference: it can match anything
  | { k: 'look'; body: Node }            // lookaround: zero width, but the body backtracks
  | { k: 'seq'; el: Node[] }
  | { k: 'alt'; branches: Node[] }
  | { k: 'repeat'; body: Node; min: number; max: number }

const ALL_CHARS: CharSet = [[0, 0xffff]]
const DIGITS: CharSet = [[0x30, 0x39]]
const WORD_CHARS: CharSet = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]]
const SPACES: CharSet = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029],
  [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
]

function normalize(xs: [number, number][]): CharSet {
  const ord = xs.map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a])).sort((x, y) => x[0] - y[0])
  const out: CharSet = []
  for (const [a, b] of ord) {
    const u = out[out.length - 1]
    if (u && a <= u[1] + 1) u[1] = Math.max(u[1], b)
    else out.push([a, b])
  }
  return out
}

function complement(s: CharSet): CharSet {
  const out: CharSet = []
  let next = 0
  for (const [a, b] of s) {
    if (a > next) out.push([next, a - 1])
    next = b + 1
  }
  if (next <= 0xffff) out.push([next, 0xffff])
  return out
}

const DOT = complement([[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]])

function overlap(x: CharSet, y: CharSet): boolean {
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i][1] < y[j][0]) i++
    else if (y[j][1] < x[i][0]) j++
    else return true
  }
  return false
}

// With the i flag the case variants of ASCII letters are added: it is enough to see an
// overlap such as `(a|A)+`; other letters are neglected.
function withCase(s: CharSet): CharSet {
  const extra: [number, number][] = []
  for (const [a, b] of s) {
    const lo = Math.max(a, 0x41)
    const hi = Math.min(b, 0x5a)
    if (lo <= hi) extra.push([lo + 32, hi + 32])
    const lo2 = Math.max(a, 0x61)
    const hi2 = Math.min(b, 0x7a)
    if (lo2 <= hi2) extra.push([lo2 - 32, hi2 - 32])
  }
  return normalize([...s, ...extra])
}

// Parser of the JavaScript syntax without the u flag. It is called only after new
// RegExp accepted the text: the syntax is already valid and the parser can be lenient.
function parseRegex(src: string, flags: string): Node {
  const ignoreCase = flags.includes('i')
  const dotClass = flags.includes('s') ? ALL_CHARS : DOT
  let i = 0
  const cls = (s: CharSet): Node => ({ k: 'class', s: ignoreCase ? withCase(s) : s })
  const literal = (c: number): Node => cls([[c, c]])

  const hex = (n: number): number | null => {
    const m = new RegExp(`^[0-9a-fA-F]{${n}}`).exec(src.slice(i))
    if (!m) return null
    i += n
    return Number.parseInt(m[0], 16)
  }

  // A character or a predefined class after "\" (inside or outside [...]).
  const escape = (inClass: boolean): number | CharSet | 'empty' | 'backref' => {
    const c = src[i + 1] ?? '\\'
    i += 2
    switch (c) {
      case 'd': return DIGITS
      case 'D': return complement(DIGITS)
      case 'w': return WORD_CHARS
      case 'W': return complement(WORD_CHARS)
      case 's': return SPACES
      case 'S': return complement(SPACES)
      case 'b': return inClass ? 8 : 'empty'
      case 'B': return inClass ? 0x42 : 'empty'
      case 'n': return 10
      case 'r': return 13
      case 't': return 9
      case 'v': return 11
      case 'f': return 12
      case 'x': return hex(2) ?? 0x78
      case 'u': return hex(4) ?? 0x75
      case 'c': {
        const x = src[i]
        if (x !== undefined && /[A-Za-z]/.test(x)) {
          i++
          return x.charCodeAt(0) % 32
        }
        return 0x5c
      }
      case 'k':
        if (!inClass && src[i] === '<') {
          i = src.indexOf('>', i) + 1
          return 'backref'
        }
        return 0x6b
      default:
        if (c >= '1' && c <= '9') {
          while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
          // outside a class it is a backreference (or a legacy octal): treating it as
          // "anything" is the conservative case
          return inClass ? c.charCodeAt(0) - 0x30 : 'backref'
        }
        return c.charCodeAt(0)
    }
  }

  const inClass = (): Node => {
    i++
    let negated = false
    if (src[i] === '^') {
      negated = true
      i++
    }
    const ranges: [number, number][] = []
    const element = (): number | CharSet => {
      if (src[i] !== '\\') return src.charCodeAt(i++)
      const e = escape(true)
      return e === 'empty' || e === 'backref' ? ALL_CHARS : e
    }
    while (i < src.length && src[i] !== ']') {
      const a = element()
      if (typeof a === 'number' && src[i] === '-' && src[i + 1] !== ']' && i + 1 < src.length) {
        i++
        const b = element()
        if (typeof b === 'number') {
          ranges.push([a, b])
          continue
        }
        ranges.push([a, a], [0x2d, 0x2d], ...b)
        continue
      }
      if (typeof a === 'number') ranges.push([a, a])
      else ranges.push(...a)
    }
    i++
    let s = normalize(ranges)
    if (ignoreCase) s = withCase(s)
    return { k: 'class', s: negated ? complement(s) : s }
  }

  const quantifier = (): [number, number] | null => {
    const c = src[i]
    let q: [number, number] | null = null
    if (c === '*') q = [0, Infinity]
    else if (c === '+') q = [1, Infinity]
    else if (c === '?') q = [0, 1]
    if (q) i++
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
      if (m) {
        const min = Number(m[1])
        q = [min, m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])]
        i += m[0].length
      }
    }
    // the lazy variant does the same backtracking in the worst case
    if (q && src[i] === '?') i++
    return q
  }

  const atom = (): Node => {
    const c = src[i]
    if (c === '(') {
      i++
      let look = false
      if (src.startsWith('?:', i)) i += 2
      else if (src.startsWith('?=', i) || src.startsWith('?!', i)) {
        i += 2
        look = true
      } else if (src.startsWith('?<=', i) || src.startsWith('?<!', i)) {
        i += 3
        look = true
      } else if (src.startsWith('?<', i)) i = src.indexOf('>', i) + 1
      const body = alternatives()
      i++
      return look ? { k: 'look', body } : body
    }
    if (c === '[') return inClass()
    if (c === '.') {
      i++
      return { k: 'class', s: dotClass }
    }
    if (c === '^' || c === '$') {
      i++
      return { k: 'empty' }
    }
    if (c === '\\') {
      const e = escape(false)
      if (e === 'empty') return { k: 'empty' }
      if (e === 'backref') return { k: 'backref' }
      return typeof e === 'number' ? literal(e) : cls(e)
    }
    i++
    return literal(c.charCodeAt(0))
  }

  const sequence = (): Node => {
    const el: Node[] = []
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const a = atom()
      const q = quantifier()
      el.push(q ? { k: 'repeat', body: a, min: q[0], max: q[1] } : a)
    }
    return { k: 'seq', el }
  }

  function alternatives(): Node {
    const branches = [sequence()]
    while (src[i] === '|') {
      i++
      branches.push(sequence())
    }
    return branches.length === 1 ? branches[0] : { k: 'alt', branches }
  }

  return alternatives()
}

function nullable(n: Node): boolean {
  switch (n.k) {
    case 'class': return false
    case 'empty': case 'backref': case 'look': return true
    case 'seq': return n.el.every(nullable)
    case 'alt': return n.branches.some(nullable)
    case 'repeat': return n.min === 0 || nullable(n.body)
  }
}

// Characters a match of the node can start with.
function firstChars(n: Node): CharSet {
  switch (n.k) {
    case 'class': return n.s
    case 'empty': case 'look': return []
    case 'backref': return ALL_CHARS
    case 'alt': return normalize(n.branches.flatMap(firstChars))
    case 'repeat': return n.max === 0 ? [] : firstChars(n.body)
    case 'seq': {
      const acc: [number, number][] = []
      for (const e of n.el) {
        acc.push(...firstChars(e))
        if (!nullable(e)) break
      }
      return normalize(acc)
    }
  }
}

// Star height: how many repeating quantifiers (maximum > 1) are nested.
function starHeight(n: Node): number {
  switch (n.k) {
    case 'repeat': return (n.max > 1 ? 1 : 0) + starHeight(n.body)
    case 'seq': return n.el.reduce((m, e) => Math.max(m, starHeight(e)), 0)
    case 'alt': return n.branches.reduce((m, e) => Math.max(m, starHeight(e)), 0)
    case 'look': return starHeight(n.body)
    default: return 0
  }
}

function overlappingBranches(branches: Node[]): boolean {
  const info = branches.map((r) => ({ first: firstChars(r), canBeEmpty: nullable(r) }))
  for (let a = 0; a < info.length; a++) {
    if (info[a].canBeEmpty) return true
    for (let b = a + 1; b < info.length; b++) if (overlap(info[a].first, info[b].first)) return true
  }
  return false
}

function overlappingAlternatives(n: Node, underRepetition: boolean): boolean {
  switch (n.k) {
    case 'repeat': return overlappingAlternatives(n.body, underRepetition || n.max > 1)
    case 'seq': return n.el.some((e) => overlappingAlternatives(e, underRepetition))
    case 'alt': return (underRepetition && overlappingBranches(n.branches)) || n.branches.some((r) => overlappingAlternatives(r, underRepetition))
    case 'look': return overlappingAlternatives(n.body, underRepetition)
    default: return false
  }
}

// Unbounded quantifiers in sequence competing for the same characters, separated at
// most by elements that can stay empty: \w*\w*, .*-?.*, \w*a+. On a text that does
// not match in the end the engine tries every way of splitting it among them: with k
// quantifiers the cost is n^k, and six .* on a 150-character path take tens of
// seconds. A bounded quantifier ({2,4}) moves the boundary by a few characters and
// does not count. With a required element in between (.*a.*) the case is not
// recognized here: the static check is a list of known shapes, not a proof, and
// project regexes run in a Worker with a time limit anyway.
function isUnbounded(n: Node): boolean {
  return n.k === 'repeat' && n.max === Infinity
}

function overlappingInSequence(n: Node): boolean {
  switch (n.k) {
    case 'seq': {
      // a group without a quantifier is part of the same sequence: (?:.*)(?:.*)
      const flatten = (el: Node[]): Node[] => el.flatMap((e) => (e.k === 'seq' ? flatten(e.el) : [e]))
      const el = flatten(n.el)
      for (let a = 0; a < el.length; a++) {
        if (!isUnbounded(el[a])) continue
        const consumed = firstChars(el[a])
        for (let b = a + 1; b < el.length; b++) {
          if (isUnbounded(el[b]) && overlap(consumed, firstChars(el[b]))) return true
          if (!nullable(el[b])) break
        }
      }
      return n.el.some(overlappingInSequence)
    }
    case 'alt': return n.branches.some(overlappingInSequence)
    case 'repeat': case 'look': return overlappingInSequence(n.body)
    default: return false
  }
}

// null if the regex is fine, otherwise the reason. For an untrusted file the reason
// quotes neither the regex (V8's message repeats it in full) nor the flags.
export function regexProblem(source: string, flags: string = '', untrusted: boolean = false): string | null {
  if (!/^(?!.*(.).*\1)[ims]*$/.test(flags)) return `flags not allowed ${quote(flags, untrusted ? NO_WORDS : null)}: only i, m, s`
  if (source.length > MAX_REGEX) return `regex of ${source.length} characters, at most ${MAX_REGEX}`
  try {
    new RegExp(source, flags)
  } catch (err) {
    if (untrusted) return 'invalid regex: it does not compile in JavaScript'
    return `invalid regex (${err instanceof Error ? err.message : String(err)})`
  }
  const tree = parseRegex(source, flags)
  if (starHeight(tree) > 1) return 'nested quantifiers (as in (a+)+): risk of catastrophic backtracking'
  if (overlappingAlternatives(tree, false)) return 'overlapping alternatives under a quantifier (as in (a|aa)+): risk of catastrophic backtracking'
  if (overlappingInSequence(tree)) return 'consecutive quantifiers over the same characters (as in \\w*\\w*): risk of polynomial backtracking'
  return null
}

function readRegex(l: Reader, v: unknown, p: string, flags: string): RegExp | undefined {
  const s = readString(l, v, p, { nonEmpty: true })
  if (s === undefined) return undefined
  const problem = regexProblem(s, flags, l.untrusted === true)
  if (problem) {
    addProblem(l, p, problem)
    return undefined
  }
  return new RegExp(s, flags)
}

function readRegexList(l: Reader, v: unknown, p: string, flags: string): RegExp[] | undefined {
  return readListOf(l, v, p, (x, px) => readRegex(l, x, px, flags))
}

// ═══ Questions: the limits shared by Jev and rizzo-flow ═══

// rizzo measures the 8000-character limit on the text it builds (compat.text): strip()
// for strings, canonical JSON for objects and lists. We do not know whether that
// json.dumps uses ensure_ascii: every non-ASCII character of a structured text counts
// as its \uXXXX sequence (6 characters per UTF-16 unit), the worst case, so a text
// that passes here does not get a 422 from rizzo.
export function nativeLength(v: Json): number {
  if (typeof v === 'string') return v.trim().length
  const s = canonical(v)
  let n = 0
  for (let k = 0; k < s.length; k++) n += s.charCodeAt(k) < 0x80 ? 1 : 6
  return n
}

// Text for the model: a string that is non-empty after strip, or a non-empty object or
// list. null, numbers and booleans are errors (rizzo: instructions Structured, strict).
function readModelText(l: Reader, v: unknown, p: string): Json | undefined {
  if (v === undefined) {
    addProblem(l, p, 'required field missing')
    return undefined
  }
  if (v === null) {
    addProblem(l, p, 'cannot be null: rizzo-flow answers 422 (Jev would accept it)')
    return undefined
  }
  if (typeof v === 'string') {
    if (v.trim() === '') {
      addProblem(l, p, 'empty string')
      return undefined
    }
    return v
  }
  if (Array.isArray(v) || isObject(v)) {
    if ((Array.isArray(v) ? v.length : Object.keys(v).length) === 0) {
      addProblem(l, p, `empty: expected a string or ${Array.isArray(v) ? 'a list' : 'an object'} with some content`)
      return undefined
    }
    if (!isJson(v)) {
      addProblem(l, p, 'contains values that are not JSON')
      return undefined
    }
    return v
  }
  addProblem(l, p, `expected a string, an object or a list, found ${typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v}`)
  return undefined
}

function checkTextLimit(l: Reader, p: string, length: number, as: string): void {
  if (length > LIMITS.maxText) {
    addProblem(l, p, `text too long for rizzo-flow: ${length} characters ${as}, at most ${LIMITS.maxText}`)
  }
}

// Validates instructions and criteria of a question asked of the model. Same rules for
// checks.json, router.json and the request body (validateBody).
function readQuestion(l: Reader, type: QuestionType, o: PlainObject, p: string): { instructions: Json; criteria?: Json } | undefined {
  const before = l.problems.length
  const pi = childPointer(p, 'instructions')
  const pc = childPointer(p, 'criteria')
  const instructions = readModelText(l, o.instructions, pi)
  if (instructions !== undefined) checkTextLimit(l, pi, nativeLength(instructions), 'as rizzo measures them')
  const criteria = o.criteria

  if (type === 'noul') {
    if (criteria !== undefined) {
      const c = readObject(l, criteria, pc)
      addKnownWords(l, ['true', 'false'])
      if (c) {
        for (const k of Object.keys(c)) {
          const pk = childPointer(pc, k)
          if (k !== 'true' && k !== 'false') {
            addProblem(l, pk, 'a noul only allows the criteria "true" and "false"')
            continue
          }
          const t = readModelText(l, c[k], pk)
          // rizzo presents the criteria as "Yes. …" and "No. …": the limit applies to that text
          if (t !== undefined) checkTextLimit(l, pk, (k === 'true' ? 5 : 4) + nativeLength(t), `with "${k === 'true' ? 'Yes. ' : 'No. '}" in front`)
        }
      }
    }
  } else if (type === 'choice') {
    const c = criteria === undefined ? (addProblem(l, pc, 'a choice needs its options in criteria'), undefined) : readObject(l, criteria, pc)
    if (c) {
      const keys = Object.keys(c)
      if (keys.length < LIMITS.minOptions || keys.length > LIMITS.maxOptions) {
        addProblem(l, pc, `a choice has between ${LIMITS.minOptions} and ${LIMITS.maxOptions} options (rizzo-flow limit), found ${keys.length}`)
      }
      for (const k of keys) {
        const pk = childPointer(pc, k)
        if (k.trim() === '') {
          addProblem(l, pk, 'empty option name')
          continue
        }
        const d = c[k]
        if (d === null) {
          checkTextLimit(l, pk, k.length, 'as "name"')
          continue
        }
        if (typeof d === 'string' || ((Array.isArray(d) || isObject(d)) && isJson(d))) {
          // rizzo presents every option as "name: detail"
          checkTextLimit(l, pk, k.length + 2 + nativeLength(d), 'as "name: detail"')
          continue
        }
        addProblem(l, pk, `expected a string, an object, a list or null, found ${typeof d === 'number' || typeof d === 'boolean' ? String(d) : typeof d}`)
      }
    }
  } else {
    if (criteria === undefined) addProblem(l, pc, 'a score needs its levels in criteria, lowest first')
    else {
      const xs = readList(l, criteria, pc)
      if (xs) {
        if (xs.length < LIMITS.minLevels || xs.length > LIMITS.maxLevels) {
          addProblem(l, pc, `a score has between ${LIMITS.minLevels} and ${LIMITS.maxLevels} levels, found ${xs.length}`)
        }
        const seen = new Map<string, number>()
        xs.forEach((x, k) => {
          const pk = childPointer(pc, k)
          const t = readModelText(l, x, pk)
          if (t === undefined) return
          checkTextLimit(l, pk, nativeLength(t), 'as rizzo measures them')
          const key = typeof t === 'string' ? t.trim() : canonical(t)
          const already = seen.get(key)
          if (already !== undefined) addProblem(l, pk, `duplicate level: same as level ${already}`)
          else seen.set(key, k)
        })
      }
    }
  }
  if (l.problems.length > before || instructions === undefined) return undefined
  return criteria === undefined ? { instructions } : { instructions, criteria: criteria as Json }
}

// Validates a question object {type, instructions, criteria} as it goes to the
// backend: no other field (rizzo answers 422 to an extra field). For validateBody.
export function questionProblems(v: unknown, file: string, pointer: string): Problem[] {
  const l = reader(file)
  const o = readObject(l, v, pointer)
  if (o) {
    for (const k of Object.keys(o)) {
      if (k !== 'type' && k !== 'instructions' && k !== 'criteria') addProblem(l, childPointer(pointer, k), 'field not allowed in a question: rizzo-flow answers 422')
    }
    const type = readOneOf(l, requiredField(l, o, pointer, 'type'), childPointer(pointer, 'type'), QUESTION_TYPES)
    if (type) readQuestion(l, type, o, pointer)
  }
  return l.problems
}

// ═══ checks.json ═══

const CHECK_FIELDS = [
  'label', 'type', 'instructions', 'criteria', 'source', 'scope', 'critical', 'higher_is_better', 'invert',
  'escalation_patterns', 'requires', 'compute', 'value', 'bench_labels',
] as const

// A check whose value is a model probability: a noul, or a choice with a value
// (1 − p(option)). Only on these do policy.json rules, critical and the band (in
// logit), calibrated thresholds, disagreement with a detector, invert and scope
// "chunk" (the maximum across chunks is a maximum of probabilities) make sense.
export function isModelProbability(def: Pick<CheckDef, 'type' | 'source' | 'value'>): boolean {
  return def.source === 'model' && (def.type === 'noul' || (def.type === 'choice' && def.value !== undefined))
}

const MSG_PROBABILITY = 'the nouls asked of the model and the choices with a "value"'

// "value" of a choice: "1-p(<option>)", with an option from criteria. A noul is already
// a probability, and a score has its own levels: there the field is an error.
function readDerivedValue(l: Reader, v: unknown, p: string, type: QuestionType | undefined, source: CheckDef['source'] | undefined,
  question: { criteria?: Json } | undefined): CheckDef['value'] {
  const s = readString(l, v, p, { nonEmpty: true })
  if (s === undefined) return undefined
  if (type !== 'choice' || source !== 'model') {
    addProblem(l, p, '"value" only applies to choices asked of the model: a noul is already a probability, a score has its own levels')
    return undefined
  }
  // an option name is any non-empty text, even over several lines
  const m = /^1-p\(([\s\S]+)\)$/.exec(s)
  if (!m) {
    addProblem(l, p, `expected "1-p(<option>)", for example "1-p(none)", found ${quoteFor(l, s)}`)
    return undefined
  }
  // without valid criteria readQuestion has already reported the problem
  const criteria = question?.criteria
  if (!isObject(criteria)) return undefined
  if (!Object.hasOwn(criteria, m[1])) {
    addProblem(l, p, `option ${quoteFor(l, m[1])} is not among those in criteria`)
    return undefined
  }
  return { kind: 'one_minus', option: m[1] }
}

function optional<T>(o: PlainObject, key: string, fallback: T, read: (v: unknown) => T | undefined): T | undefined {
  return o[key] === undefined ? fallback : read(o[key])
}

function readCheck(l: Reader, v: unknown, p: string, id: string): CheckDef | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  const before = l.problems.length
  onlyFields(l, o, p, CHECK_FIELDS)
  const f = (k: string): string => childPointer(p, k)
  const type = readOneOf(l, requiredField(l, o, p, 'type'), f('type'), QUESTION_TYPES)
  const label = optional(o, 'label', id, (x) => readString(l, x, f('label'), { nonEmpty: true, max: 120 }))
  const source = optional<CheckDef['source']>(o, 'source', 'model', (x) => readOneOf(l, x, f('source'), ['model', 'computed'] as const))
  const scope = optional<CheckDef['scope']>(o, 'scope', 'global', (x) => readOneOf(l, x, f('scope'), ['chunk', 'global'] as const))
  const critical = optional(o, 'critical', false, (x) => readBoolean(l, x, f('critical')))
  const higher = optional(o, 'higher_is_better', false, (x) => readBoolean(l, x, f('higher_is_better')))
  const invert = optional(o, 'invert', false, (x) => readBoolean(l, x, f('invert')))
  const patterns = optional(o, 'escalation_patterns', [] as RegExp[], (x) => readRegexList(l, x, f('escalation_patterns'), 'i'))
  const requires = optional<CheckDef['requires']>(o, 'requires', [], (x) => readListOf(l, x, f('requires'), (r, pr) => readOneOf(l, r, pr, ['description'] as const)))
  let benchLabels: string | undefined
  if (o.bench_labels !== undefined) {
    benchLabels = readString(l, o.bench_labels, f('bench_labels'), { nonEmpty: true })
    if (benchLabels !== undefined && !RE_ID.test(benchLabels)) {
      addProblem(l, f('bench_labels'), MSG_ID)
      benchLabels = undefined
    }
  }

  let question: { instructions: Json; criteria?: Json } | undefined
  let compute: CheckDef['compute']
  if (type && source === 'model') {
    question = readQuestion(l, type, o, p)
    if (o.compute !== undefined) addProblem(l, f('compute'), 'compute only applies with source "computed"')
  }
  if (type && source === 'computed') {
    if (type !== 'noul') addProblem(l, f('source'), 'source "computed" only applies to nouls: the code computes 0 or 1')
    if (o.compute === undefined) addProblem(l, f('compute'), 'source "computed" needs compute (all_files_match or from_verdict)')
    else {
      const c = readObject(l, o.compute, f('compute'))
      if (c) {
        onlyFields(l, c, f('compute'), ['all_files_match', 'from_verdict'])
        const howMany = (c.all_files_match !== undefined ? 1 : 0) + (c.from_verdict !== undefined ? 1 : 0)
        if (howMany !== 1) addProblem(l, f('compute'), 'exactly one of all_files_match and from_verdict is needed')
        else if (c.all_files_match !== undefined) {
          const re = readListOf(l, c.all_files_match, childPointer(f('compute'), 'all_files_match'), (x, px) => readRegex(l, x, px, ''), { min: 1 })
          if (re) compute = { all_files_match: re }
        } else {
          const lane = readString(l, c.from_verdict, childPointer(f('compute'), 'from_verdict'), { nonEmpty: true })
          if (lane !== undefined) compute = { from_verdict: lane }
        }
      }
    }
  }
  const value = o.value === undefined ? undefined : readDerivedValue(l, o.value, f('value'), type, source, question)
  // With a missing or wrong type the error is already on the type. A choice that
  // declares a value counts as a probability even if the value is invalid: the error
  // is there, and it is not repeated on scope, invert and critical.
  const isProbability = type === undefined || source === undefined
    || (source === 'model' && (type === 'noul' || (type === 'choice' && o.value !== undefined)))
  if (scope === 'chunk' && source === 'computed') addProblem(l, f('scope'), 'scope "chunk" only applies to questions asked of the model')
  else if (scope === 'chunk' && !isProbability) addProblem(l, f('scope'), `scope "chunk" only applies to ${MSG_PROBABILITY}: the value across chunks is the maximum of a probability`)
  if (invert && !isProbability) addProblem(l, f('invert'), `invert only applies to ${MSG_PROBABILITY}`)
  // The uncertainty band is in logit, on a probability: a critical score,
  // choice without a value or computed question would be left without a band, with the
  // dead zone around the threshold that the band is there to remove, and nobody would
  // say so.
  if (critical && !isProbability) {
    addProblem(l, f('critical'), `critical only applies to ${MSG_PROBABILITY}: the uncertainty band is in logit, on a probability`)
  }

  if (l.problems.length > before || !type || !source || !scope || label === undefined || critical === undefined
    || higher === undefined || invert === undefined || !patterns || !requires) return undefined
  const def: CheckDef = {
    label, type, source, scope, critical, higher_is_better: higher, invert, escalation_patterns: patterns, requires,
  }
  if (question) {
    def.instructions = question.instructions
    if (question.criteria !== undefined) def.criteria = question.criteria
  }
  if (compute) def.compute = compute
  if (value) def.value = value
  if (benchLabels !== undefined) def.bench_labels = benchLabels
  return def
}

// fromProject: the file comes from .jev-hooks/. The problems do not quote its
// texts (an id only if it is in the vocabulary of the trusted layers), and the result
// carries the mark: label, instructions and criteria never go to Claude.
export function validateChecks(json: unknown, file: string, o: { fromProject?: boolean; vocabulary?: Iterable<string> } = {}): Result<Checks> {
  const l = reader(file, o.fromProject === true, o.vocabulary)
  const items: Record<string, CheckDef> = {}
  const order: string[] = []
  const root = readObject(l, json, '')
  if (root) {
    for (const id of fieldsOf(root)) {
      const p = childPointer('', id)
      if (!RE_ID.test(id)) {
        addProblem(l, p, MSG_ID)
        continue
      }
      const d = readCheck(l, root[id], p, id)
      if (d) {
        items[id] = d
        order.push(id)
      }
    }
    // bench_labels: a second reading of another question shares its labels on the
    // bench, so both must be probabilities, and the chain stops at one step
    for (const id of order) {
      const b = items[id].bench_labels
      if (b === undefined) continue
      const target = Object.hasOwn(items, b) ? items[b] : undefined
      const p = childPointer(childPointer('', id), 'bench_labels')
      if (!isModelProbability(items[id])) addProblem(l, p, `bench_labels only applies to ${MSG_PROBABILITY}`)
      else if (b === id || !target || !isModelProbability(target) || target.bench_labels !== undefined) {
        addProblem(l, p, `bench_labels must name another check of this file that is one of ${MSG_PROBABILITY}, without bench_labels of its own`)
      }
    }
    if (fieldsOf(root).length === 0) addProblem(l, '', 'no check defined')
    const toModel = order.filter((id) => items[id].source === 'model').length
    if (toModel > LIMITS.maxQuestions) addProblem(l, '', `${toModel} questions for the model: at most ${LIMITS.maxQuestions} per request`)
  }
  return readerResult(l, o.fromProject ? { order, defs: items, file, fromProject: true } : { order, defs: items, file })
}

// ═══ policy.json ═══

const POLICY_FIELDS = [
  'version', 'lanes', 'band', 'escalation', 'ci', 'partial_coverage', 'state', 'test_paths', 'limits', 'network',
  'detectors', 'hook', 'colors',
] as const
const LANE_FIELDS = ['name', 'exit_code', 'color', 'hook', 'ci', 'rules'] as const
const RULE_FIELDS = ['check', 'op', 'value', 'unless', 'action'] as const
const MAX_UNLESS = 4
// "lane" is the default (the rule only decides the lane) and can be written for
// clarity; "escalation" also sends the question to Claude.
const ACTIONS = ['lane', 'escalation'] as const
const DETECTOR_FIELDS = [
  'name', 'label', 'check', 'where', 'regex', 'flags', 'min_entropy', 'ignore_values', 'exclude_paths', 'floor', 'escalate',
] as const
const STATE_FIELDS = [
  'chars_per_token', 'tokens_per_state', 'max_line_chars', 'max_diff_bytes', 'max_description_chars', 'ignore',
  'ignore_without_escalation', 'sensitive_files',
] as const

// Constraints of the numeric fields: the same for the full file and for the project
// overlay, which must be valid before it can tighten anything.
const LIMITS_CONSTRAINTS: Record<'max_chunks' | 'total_ms', NumberConstraints> = {
  max_chunks: { integer: true, min: 1, max: 500 },
  total_ms: { integer: true, min: 1000, max: 3_600_000 },
}
const NETWORK_CONSTRAINTS: Record<keyof Policy['network'], NumberConstraints> = {
  timeout_ms: { integer: true, min: 1000, max: 600_000 },
  connect_attempts: { integer: true, min: 1, max: 10 },
  overload_attempts: { integer: true, min: 0, max: 10 },
  backoff_ms: { integer: true, min: 0, max: 60_000 },
  max_retry_after_ms: { integer: true, min: 0, max: 60_000 },
  overflow_resplits: { integer: true, min: 0, max: 5 },
  parallel_rizzo: { integer: true, min: 1, max: 16 },
  parallel_other: { integer: true, min: 1, max: 16 },
}
const BAND_LIMITS: NumberConstraints = { above: 0, max: 3 }

function direction(op: Op): 'up' | 'down' {
  return op === 'gte' || op === 'gt' ? 'up' : 'down'
}

// Reads check/op/value of a rule or of an unless. The value is checked on the check's
// scale: [0, 1] for nouls and choices with a value, [0, levels − 1] for scores.
function readCondition(l: Reader, o: PlainObject, p: string, checks: Checks): Condition | undefined {
  const f = (k: string): string => childPointer(p, k)
  const check = readString(l, requiredField(l, o, p, 'check'), f('check'), { nonEmpty: true })
  const op = readOneOf(l, requiredField(l, o, p, 'op'), f('op'), OPS)
  const raw = requiredField(l, o, p, 'value')
  if (check === undefined) return undefined
  const def = Object.hasOwn(checks.defs, check) ? checks.defs[check] : undefined
  if (!def) {
    addProblem(l, f('check'), `unknown check ${quoteFor(l, check)}: not defined in ${checks.file}`)
    return undefined
  }
  if (def.compute?.from_verdict !== undefined) {
    addProblem(l, f('check'), `${quoteFor(l, check)} is computed from the verdict: it cannot appear in a rule`)
    return undefined
  }
  if (def.type === 'choice' && def.value === undefined) {
    addProblem(l, f('check'), `${quoteFor(l, check)} is a choice: its value is an option, not a number to compare (with "value": "1-p(<option>)" it becomes a probability)`)
    return undefined
  }
  const levels = def.type === 'score' && Array.isArray(def.criteria) ? def.criteria.length : 2
  const value = raw === undefined ? undefined : readNumber(l, raw, f('value'), { min: 0, max: levels - 1 })
  if (op === undefined || value === undefined) return undefined
  return { check, op, value }
}

function readRule(l: Reader, v: unknown, p: string, checks: Checks): Rule | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  onlyFields(l, o, p, RULE_FIELDS)
  const base = readCondition(l, o, p, checks)
  // one condition, or a list of them: the rule does not fire when any holds
  let unless: Rule['unless']
  if (o.unless !== undefined) {
    const up = childPointer(p, 'unless')
    const list = Array.isArray(o.unless) ? o.unless : [o.unless]
    if (list.length < 1 || list.length > MAX_UNLESS) {
      addProblem(l, up, `expected one condition or a list of 1 to ${MAX_UNLESS}`)
      return undefined
    }
    unless = []
    for (const [i, item] of list.entries()) {
      const ip = Array.isArray(o.unless) ? childPointer(up, String(i)) : up
      const u = readObject(l, item, ip)
      if (!u) return undefined
      onlyFields(l, u, ip, ['check', 'op', 'value'])
      // A condition on a check the active checks.json does not define is dropped, not
      // an error: a checks.json written before the plugin added that check keeps
      // working, and one condition fewer can only make the rule fire more often.
      if (typeof u.check === 'string' && u.check !== '' && !Object.hasOwn(checks.defs, u.check)) {
        addNote(l, childPointer(ip, 'check'), `unless condition dropped: ${quoteFor(l, u.check)} is not defined in ${checks.file}, so the rule fires without it`)
        continue
      }
      const c = readCondition(l, u, ip, checks)
      if (!c) return undefined
      unless.push(c)
    }
    if (unless.length === 0) unless = undefined
  }
  const action = o.action === undefined ? 'lane' : readOneOf(l, o.action, childPointer(p, 'action'), ACTIONS)
  if (action === undefined) return undefined
  if (!base) return undefined
  // The escalation names the chunks above the threshold and compares a detector's hit
  // with the p of its chunk: it needs a model probability, per chunk or global.
  if (action === 'escalation' && !isModelProbability(checks.defs[base.check])) {
    addProblem(l, childPointer(p, 'action'), `"escalation" only applies to ${MSG_PROBABILITY}: ${quoteFor(l, base.check)} is not one`)
    return undefined
  }
  const r: Rule = unless ? { ...base, unless } : base
  return action === 'escalation' ? { ...r, action } : r
}

function readLane(l: Reader, v: unknown, p: string, checks: Checks): Lane | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  const f = (k: string): string => childPointer(p, k)
  onlyFields(l, o, p, LANE_FIELDS)
  const name = readString(l, requiredField(l, o, p, 'name'), f('name'), { nonEmpty: true, max: 40 })
  const exitCode = readNumber(l, requiredField(l, o, p, 'exit_code'), f('exit_code'), { integer: true, min: 0, max: 125 })
  // 4 is the exit code of errors (CLI, prompt 03): a lane with 4 could not be told apart
  if (exitCode === 4) addProblem(l, f('exit_code'), '4 is reserved for errors (configuration, backend, network)')
  const color = readString(l, requiredField(l, o, p, 'color'), f('color'), { nonEmpty: true, max: 40 })
  const hook = readOneOf(l, requiredField(l, o, p, 'hook'), f('hook'), ['deny', 'ask', 'warn', 'none'] as const)
  const ci = readOneOf(l, requiredField(l, o, p, 'ci'), f('ci'), CONCLUSIONS)
  const rules = readListOf(l, requiredField(l, o, p, 'rules'), f('rules'), (x, px) => readRule(l, x, px, checks))
  if (name === undefined || exitCode === undefined || exitCode === 4 || color === undefined || !hook || !ci || !rules) return undefined
  return { name, exit_code: exitCode, color, hook, ci, rules }
}

interface DetectorContext { checks: Checks; lanes: string[]; testPaths: RegExp[] }

function readFloor(l: Reader, v: unknown, p: string, lanes: string[]): string | null | undefined {
  if (v === null) return null
  const s = readString(l, v, p, { nonEmpty: true })
  if (s === undefined) return undefined
  if (!lanes.includes(s)) {
    addProblem(l, p, `unknown lane ${quoteFor(l, s)} (lanes: ${lanes.join(', ')}; null for no floor)`)
    return undefined
  }
  return s
}

function readDetector(l: Reader, v: unknown, p: string, ctx: DetectorContext): Detector | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  const before = l.problems.length
  const f = (k: string): string => childPointer(p, k)
  onlyFields(l, o, p, DETECTOR_FIELDS)
  const name = readString(l, requiredField(l, o, p, 'name'), f('name'))
  if (name !== undefined && !RE_ID.test(name)) addProblem(l, f('name'), MSG_ID)
  const label = readString(l, requiredField(l, o, p, 'label'), f('label'), { nonEmpty: true, max: 120 })
  const flags = optional(o, 'flags', '', (x) => readString(l, x, f('flags')))
  const where = readListOf(l, requiredField(l, o, p, 'where'), f('where'), (x, px) => readOneOf(l, x, px, WHERE_VALUES), { min: 1 })
  if (where && new Set(where).size !== where.length) addProblem(l, f('where'), 'repeated values')
  let re: RegExp | undefined
  let ignore: RegExp | undefined
  if (flags !== undefined) {
    const problem = /^(?!.*(.).*\1)[ims]*$/.test(flags) ? null : `flags not allowed ${quoteFor(l, flags)}: only i, m, s`
    if (problem) addProblem(l, f('flags'), problem)
    else {
      re = readRegex(l, requiredField(l, o, p, 'regex'), f('regex'), flags)
      if (o.ignore_values !== undefined) ignore = readRegex(l, o.ignore_values, f('ignore_values'), flags)
    }
  }
  const minEntropy = o.min_entropy === undefined ? undefined : readNumber(l, o.min_entropy, f('min_entropy'), { min: 0, max: 8 })
  let exclude: RegExp[] | undefined = []
  if (o.exclude_paths === 'test_paths') exclude = ctx.testPaths
  else if (o.exclude_paths !== undefined) exclude = readRegexList(l, o.exclude_paths, f('exclude_paths'), '')
  const floor = o.floor === undefined ? null : readFloor(l, o.floor, f('floor'), ctx.lanes)
  const escalate = optional<Detector['escalate']>(o, 'escalate', 'never', (x) => readOneOf(l, x, f('escalate'), ESCALATE_VALUES))
  let check: string | undefined
  if (o.check !== undefined) {
    check = readString(l, o.check, f('check'), { nonEmpty: true })
    if (check !== undefined && !Object.hasOwn(ctx.checks.defs, check)) {
      addProblem(l, f('check'), `unknown check ${quoteFor(l, check)}: not defined in ${ctx.checks.file}`)
    }
  }
  if (escalate === 'if_model_disagrees') {
    const def = check === undefined || !Object.hasOwn(ctx.checks.defs, check) ? undefined : ctx.checks.defs[check]
    if (!def || !isModelProbability(def)) {
      addProblem(l, f('escalate'), `"if_model_disagrees" needs a check among ${MSG_PROBABILITY} to compare the hit with`)
    }
  }
  if (l.problems.length > before || name === undefined || label === undefined || !where || !re || !exclude
    || floor === undefined || !escalate) return undefined
  const r: Detector = { name, label, where, regex: re, exclude_paths: exclude, floor, escalate }
  if (check !== undefined) r.check = check
  if (minEntropy !== undefined) r.min_entropy = minEntropy
  if (ignore) r.ignore_values = ignore
  return r
}

function readNumbers<K extends string>(l: Reader, v: unknown, p: string, constraints: Record<K, NumberConstraints>): Record<K, number> | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  const keys = Object.keys(constraints) as K[]
  onlyFields(l, o, p, keys)
  const before = l.problems.length
  const out = {} as Record<K, number>
  for (const k of keys) {
    const n = readNumber(l, requiredField(l, o, p, k), childPointer(p, k), constraints[k])
    if (n !== undefined) out[k] = n
  }
  return l.problems.length === before ? out : undefined
}

function readPolicy(l: Reader, json: unknown, checks: Checks): Policy | undefined {
  const o = readObject(l, json, '')
  if (!o) return undefined
  onlyFields(l, o, '', POLICY_FIELDS)
  if (o.version !== undefined) readNumber(l, o.version, '/version', { integer: true, min: 1, max: 1 })
  const before = l.problems.length

  const lanes = readListOf(l, requiredField(l, o, '', 'lanes'), '/lanes', (x, px) => readLane(l, x, px, checks), { min: 1 })
  const laneNames = lanes ? lanes.map((c) => c.name) : []
  if (lanes) {
    const seen = new Set<string>()
    lanes.forEach((c, k) => {
      if (seen.has(c.name)) addProblem(l, childPointer(childPointer('/lanes', k), 'name'), `lane "${c.name}" repeated`)
      seen.add(c.name)
      // The other lanes may have no rules: in policy v2 BLOCK and SECURITY REVIEW are
      // reached only through the detectors' floors (the model does not block on its
      // own), and whoever wants a model rule adds it in the user file.
      if (k === lanes.length - 1 && c.rules.length > 0) {
        addProblem(l, childPointer(childPointer('/lanes', k), 'rules'), 'the last lane must have no rules: it is the verdict when no rule fires')
      }
    })
  }
  const lane = (v: unknown, p: string): string | undefined => {
    const s = readString(l, v, p, { nonEmpty: true })
    if (s !== undefined && lanes && !laneNames.includes(s)) {
      addProblem(l, p, `unknown lane "${s}" (lanes: ${laneNames.join(', ')})`)
      return undefined
    }
    return s
  }

  // a noul computed from the verdict must name a lane that exists
  if (lanes) {
    for (const id of checks.order) {
      const v = checks.defs[id].compute?.from_verdict
      if (v !== undefined && !laneNames.includes(v)) {
        // checks.json writes the lane, and it can come from the project: unknown means
        // that no trusted layer wrote it, and it is not quoted
        addProblem(l, `/${id}/compute/from_verdict`, `unknown lane ${quote(v, checks.fromProject ? NO_WORDS : null)} (lanes of ${l.file}: ${laneNames.join(', ')})`, checks.file)
      }
    }
  }

  let band: Policy['band'] | undefined
  const b = readObject(l, requiredField(l, o, '', 'band'), '/band')
  if (b) {
    onlyFields(l, b, '/band', ['delta_logit'])
    const d = readNumber(l, requiredField(l, b, '/band', 'delta_logit'), '/band/delta_logit', BAND_LIMITS)
    if (d !== undefined) band = { delta_logit: d }
  }

  let escalation: Policy['escalation'] | undefined
  const e = readObject(l, requiredField(l, o, '', 'escalation'), '/escalation')
  if (e) {
    onlyFields(l, e, '/escalation', ['hook', 'ci', 'max_files', 'ttl_min'])
    const hook = readOneOf(l, requiredField(l, e, '/escalation', 'hook'), '/escalation/hook', HOOK_ESCALATION_MODES)
    const ci = readOneOf(l, requiredField(l, e, '/escalation', 'ci'), '/escalation/ci', CONCLUSIONS)
    const maxFiles = readNumber(l, requiredField(l, e, '/escalation', 'max_files'), '/escalation/max_files', { integer: true, min: 1, max: 50 })
    const ttl = readNumber(l, requiredField(l, e, '/escalation', 'ttl_min'), '/escalation/ttl_min', { integer: true, min: 1, max: 10_080 })
    if (hook && ci && maxFiles !== undefined && ttl !== undefined) escalation = { hook, ci, max_files: maxFiles, ttl_min: ttl }
  }

  let ci: Policy['ci'] | undefined
  const c = readObject(l, requiredField(l, o, '', 'ci'), '/ci')
  if (c) {
    onlyFields(l, c, '/ci', ['backend_unavailable', 'untrusted_input'])
    const unavailable = readOneOf(l, requiredField(l, c, '/ci', 'backend_unavailable'), '/ci/backend_unavailable', CONCLUSIONS)
    const untrusted = readOneOf(l, requiredField(l, c, '/ci', 'untrusted_input'), '/ci/untrusted_input', CONCLUSIONS)
    if (unavailable && untrusted) ci = { backend_unavailable: unavailable, untrusted_input: untrusted }
  }

  let partial: Policy['partial_coverage'] | undefined
  const pc = readObject(l, requiredField(l, o, '', 'partial_coverage'), '/partial_coverage')
  if (pc) {
    onlyFields(l, pc, '/partial_coverage', ['min_lane'])
    const m = lane(requiredField(l, pc, '/partial_coverage', 'min_lane'), '/partial_coverage/min_lane')
    if (m !== undefined) partial = { min_lane: m }
  }

  let state: Policy['state'] | undefined
  const s = readObject(l, requiredField(l, o, '', 'state'), '/state')
  if (s) {
    onlyFields(l, s, '/state', STATE_FIELDS)
    const n = (k: string, v: NumberConstraints): number | undefined => readNumber(l, requiredField(l, s, '/state', k), childPointer('/state', k), v)
    const cpt = n('chars_per_token', { above: 0, max: 20 })
    const tps = n('tokens_per_state', { integer: true, min: 100, max: 32_000 })
    const mlc = n('max_line_chars', { integer: true, min: 80, max: 100_000 })
    const mdb = n('max_diff_bytes', { integer: true, min: 1000, max: 100_000_000 })
    const mdc = n('max_description_chars', { integer: true, min: 0, max: 100_000 })
    const ig = readRegexList(l, requiredField(l, s, '/state', 'ignore'), '/state/ignore', '')
    const igw = readRegexList(l, requiredField(l, s, '/state', 'ignore_without_escalation'), '/state/ignore_without_escalation', '')
    // sensitive files are case-insensitive: when in doubt a .ENV stays on the disk
    const sens = readRegexList(l, requiredField(l, s, '/state', 'sensitive_files'), '/state/sensitive_files', 'i')
    if (cpt !== undefined && tps !== undefined && mlc !== undefined && mdb !== undefined && mdc !== undefined && ig && igw && sens) {
      state = {
        chars_per_token: cpt, tokens_per_state: tps, max_line_chars: mlc, max_diff_bytes: mdb, max_description_chars: mdc,
        ignore: ig, ignore_without_escalation: igw, sensitive_files: sens,
      }
    }
  }

  const testPaths = readRegexList(l, requiredField(l, o, '', 'test_paths'), '/test_paths', '')

  let limits: Policy['limits'] | undefined
  const li = readObject(l, requiredField(l, o, '', 'limits'), '/limits')
  if (li) {
    onlyFields(l, li, '/limits', ORIGINS)
    const out = {} as Policy['limits']
    let complete = true
    for (const origin of ORIGINS) {
      const po = childPointer('/limits', origin)
      const x = readNumbers(l, requiredField(l, li, '/limits', origin), po, LIMITS_CONSTRAINTS)
      if (!x) {
        complete = false
        continue
      }
      if ((origin === 'hook' || origin === 'skill') && x.total_ms > HOOK_CAP_MS) {
        addProblem(l, childPointer(po, 'total_ms'), `at most ${HOOK_CAP_MS}: the hooks.json timeout is ${HOOK_TIMEOUT_S} s, and beyond it Claude Code cancels the hook and the commit goes through without even the floors`)
        complete = false
        continue
      }
      out[origin] = x
    }
    if (complete) limits = out
  }

  const network = readNumbers(l, requiredField(l, o, '', 'network'), '/network', NETWORK_CONSTRAINTS)

  let detectors: Detector[] | undefined
  if (lanes && testPaths) {
    const ctx: DetectorContext = { checks, lanes: laneNames, testPaths }
    detectors = readListOf(l, requiredField(l, o, '', 'detectors'), '/detectors', (x, px) => readDetector(l, x, px, ctx))
    if (detectors) {
      const seen = new Set<string>()
      detectors.forEach((r, k) => {
        if (seen.has(r.name)) addProblem(l, childPointer(childPointer('/detectors', k), 'name'), `detector "${r.name}" repeated`)
        seen.add(r.name)
      })
    }
  }

  let hook: Policy['hook'] | undefined
  const h = readObject(l, requiredField(l, o, '', 'hook'), '/hook')
  if (h) {
    onlyFields(l, h, '/hook', ['enabled', 'on_error', 'cache_ttl_min'])
    const en = readBoolean(l, requiredField(l, h, '/hook', 'enabled'), '/hook/enabled')
    const oe = readOneOf(l, requiredField(l, h, '/hook', 'on_error'), '/hook/on_error', ['warn', 'ask'] as const)
    const ttl = readNumber(l, requiredField(l, h, '/hook', 'cache_ttl_min'), '/hook/cache_ttl_min', { integer: true, min: 0, max: 100_000 })
    if (en !== undefined && oe && ttl !== undefined) hook = { enabled: en, on_error: oe, cache_ttl_min: ttl }
  }

  let colors: Policy['colors'] | undefined
  const co = readObject(l, requiredField(l, o, '', 'colors'), '/colors')
  if (co) {
    onlyFields(l, co, '/colors', ['high', 'mid'])
    const hi = readNumber(l, requiredField(l, co, '/colors', 'high'), '/colors/high', { min: 0, max: 1 })
    const mid = readNumber(l, requiredField(l, co, '/colors', 'mid'), '/colors/mid', { min: 0, max: 1 })
    if (hi !== undefined && mid !== undefined && mid > hi) addProblem(l, '/colors/mid', `mid (${mid}) must be ≤ high (${hi})`)
    else if (hi !== undefined && mid !== undefined) colors = { high: hi, mid }
  }

  if (l.problems.length > before || !lanes || !band || !escalation || !ci || !partial || !state || !testPaths || !limits
    || !network || !detectors || !hook || !colors) return undefined
  return {
    lanes, band, escalation, ci, partial_coverage: partial, state, test_paths: testPaths, limits, network, detectors, hook,
    colors, file: l.file,
  }
}

// A reader that returns undefined has always reported a problem; if a bug in this file
// broke that, a generic error is better than an empty ok.
function readResult<T>(l: Reader, value: T | undefined, what: string): Result<T> {
  if (value === undefined && l.problems.length === 0) addProblem(l, '', `invalid ${what}`)
  return readerResult(l, value as T)
}

export function validatePolicy(json: unknown, checks: Checks, file: string): Result<Policy> {
  const l = reader(file)
  const r = readResult(l, readPolicy(l, json, checks), 'policy.json')
  return r.ok && l.notes?.length ? { ok: true, value: { ...r.value, notes: l.notes } } : r
}

// ═══ calibration.json ═══

const PROFILE_FIELDS = [
  'name', 'match', 'calibrated', 'noul', 'choice', 'score', 'per_question', 'thresholds', 'band_delta_logit', 'note',
] as const

function readTemperature(l: Reader, v: unknown, p: string): { t: number } | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  onlyFields(l, o, p, ['t'])
  const t = readNumber(l, requiredField(l, o, p, 't'), childPointer(p, 't'), { above: 0, max: 100 })
  return t === undefined ? undefined : { t }
}

function readProfile(l: Reader, v: unknown, p: string): Profile | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  const before = l.problems.length
  const f = (k: string): string => childPointer(p, k)
  onlyFields(l, o, p, PROFILE_FIELDS)
  const name = readString(l, requiredField(l, o, p, 'name'), f('name'), { nonEmpty: true, max: 80 })
  const match: Profile['match'] = {}
  const m = readObject(l, requiredField(l, o, p, 'match'), f('match'))
  if (m) {
    onlyFields(l, m, f('match'), ['fingerprint', 'model_prefix', 'host'])
    for (const k of ['fingerprint', 'model_prefix', 'host'] as const) {
      if (m[k] === undefined) continue
      const s = readString(l, m[k], childPointer(f('match'), k), { nonEmpty: true, max: 256 })
      if (s !== undefined) match[k] = s
    }
  }
  const calibrated = optional(o, 'calibrated', false, (x) => readBoolean(l, x, f('calibrated')))
  const profile: Profile = { name: name ?? '', match, calibrated: calibrated ?? false }
  if (o.noul !== undefined) {
    const n = readObject(l, o.noul, f('noul'))
    if (n) {
      onlyFields(l, n, f('noul'), ['a', 'b'])
      // a ≤ 0 would flip or flatten the probabilities: it is not a calibration fit
      const a = readNumber(l, requiredField(l, n, f('noul'), 'a'), childPointer(f('noul'), 'a'), { above: 0, max: 100 })
      const b = readNumber(l, requiredField(l, n, f('noul'), 'b'), childPointer(f('noul'), 'b'), { min: -36, max: 36 })
      if (a !== undefined && b !== undefined) profile.noul = { a, b }
    }
  }
  if (o.choice !== undefined) profile.choice = readTemperature(l, o.choice, f('choice'))
  if (o.score !== undefined) profile.score = readTemperature(l, o.score, f('score'))
  if (o.per_question !== undefined) {
    const pq = readObject(l, o.per_question, f('per_question'))
    if (pq) {
      const out: Record<string, CalibrationEntry> = {}
      for (const id of fieldsOf(pq)) {
        const pv = childPointer(f('per_question'), id)
        if (!RE_ID.test(id)) {
          addProblem(l, pv, MSG_ID)
          continue
        }
        const x = readObject(l, pq[id], pv)
        if (!x) continue
        onlyFields(l, x, pv, ['sha256', 'a', 'b', 't', 'n', 'errors'])
        const sha = readString(l, requiredField(l, x, pv, 'sha256'), childPointer(pv, 'sha256'))
        if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) addProblem(l, childPointer(pv, 'sha256'), 'expected the sha256 of the sent question: 64 lowercase hex digits')
        const item: CalibrationEntry = { sha256: sha ?? '' }
        const constraints: Record<'a' | 'b' | 't' | 'n' | 'errors', NumberConstraints> = {
          a: { above: 0, max: 100 }, b: { min: -36, max: 36 }, t: { above: 0, max: 100 },
          n: { integer: true, min: 0 }, errors: { integer: true, min: 0 },
        }
        for (const k of ['a', 'b', 't', 'n', 'errors'] as const) {
          if (x[k] === undefined) continue
          const val = readNumber(l, x[k], childPointer(pv, k), constraints[k])
          if (val !== undefined) item[k] = val
        }
        out[id] = item
      }
      profile.per_question = out
    }
  }
  if (o.thresholds !== undefined) {
    const th = readObject(l, o.thresholds, f('thresholds'))
    if (th) {
      const out: Record<string, number> = {}
      for (const id of fieldsOf(th)) {
        const pv = childPointer(f('thresholds'), id)
        if (!RE_ID.test(id)) {
          addProblem(l, pv, MSG_ID)
          continue
        }
        const val = readNumber(l, th[id], pv, { min: 0, max: 1 })
        if (val !== undefined) out[id] = val
      }
      profile.thresholds = out
    }
  }
  if (o.band_delta_logit !== undefined) {
    const d = readNumber(l, o.band_delta_logit, f('band_delta_logit'), BAND_LIMITS)
    if (d !== undefined) profile.band_delta_logit = d
  }
  if (o.note !== undefined) {
    const n = readString(l, o.note, f('note'))
    if (n !== undefined) profile.note = n
  }
  return l.problems.length > before ? undefined : profile
}

export function validateCalibration(json: unknown, file: string): Result<Calibration> {
  const l = reader(file)
  const o = readObject(l, json, '')
  let result: Calibration | undefined
  if (o) {
    onlyFields(l, o, '', ['version', 'wide_delta_logit', 'profiles'])
    if (o.version !== undefined) readNumber(l, o.version, '/version', { integer: true, min: 1, max: 1 })
    const wide = readNumber(l, requiredField(l, o, '', 'wide_delta_logit'), '/wide_delta_logit', BAND_LIMITS)
    const profiles = readListOf(l, requiredField(l, o, '', 'profiles'), '/profiles', (x, px) => readProfile(l, x, px), { min: 1 })
    if (profiles) {
      const seen = new Set<string>()
      profiles.forEach((pr, k) => {
        if (seen.has(pr.name)) addProblem(l, childPointer(childPointer('/profiles', k), 'name'), `profile "${pr.name}" repeated`)
        seen.add(pr.name)
      })
    }
    if (wide !== undefined && profiles) result = { wide_delta_logit: wide, profiles, file }
  }
  return readResult(l, result, 'calibration.json')
}

// ═══ router.json ═══

const ROUTER_FIELDS = [
  'version', 'enabled', 'timeout_ms', 'busy_after_timeout_ms', 'prompt_max_chars', 'prompt_head_chars', 'skip_prefixes',
  'only_origins', 'only_models', 'min_effort', 'max_effort', 'respect_session_effort', 'assume_session_effort',
  'min_top_probability', 'cache_guard', 'base', 'adjust', 'explicit_depth', 'floors', 'questions',
] as const
const CACHE_GUARD_FIELDS = ['min_prefix_tokens', 'max_read_ratio', 'max_gap_ms', 'trips'] as const
const MSG_STEP = `expected an integer step between -4 and 4 or a level among ${EFFORT_SCALE.map((x) => `"${x}"`).join(', ')}`

function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORT_SCALE as readonly string[]).includes(v)
}

function readStep(l: Reader, v: unknown, p: string, extra: readonly string[] = []): EffortStep | 'previous' | null | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= -4 && v <= 4) return v
  if (isEffort(v)) return v
  if (v === null && extra.includes('null')) return null
  if (v === 'previous' && extra.includes('previous')) return 'previous'
  const others = extra.map((x) => (x === 'null' ? 'null' : `"${x}"`))
  addProblem(l, p, `${MSG_STEP}${others.length ? `, or ${others.join(' or ')}` : ''}; found ${JSON.stringify(v) ?? 'nothing'}`)
  return undefined
}

function optionsOf(w: WireQuestion): string[] {
  return w.type === 'choice' && isObject(w.criteria) ? Object.keys(w.criteria) : []
}

function levelsOf(w: WireQuestion): number {
  return w.type === 'score' && Array.isArray(w.criteria) ? w.criteria.length : 0
}

function readRouterCondition(l: Reader, v: unknown, p: string, questions: Record<string, WireQuestion>): RouterCondition | undefined {
  const o = readObject(l, v, p)
  if (!o) return undefined
  onlyFields(l, o, p, ['question', 'p_gte', 'level_gte'])
  const q = readString(l, requiredField(l, o, p, 'question'), childPointer(p, 'question'), { nonEmpty: true })
  if (q === undefined) return undefined
  const w = questions[q]
  if (!w) {
    addProblem(l, childPointer(p, 'question'), `unknown question "${q}" (questions: ${Object.keys(questions).join(', ')})`)
    return undefined
  }
  const howMany = (o.p_gte !== undefined ? 1 : 0) + (o.level_gte !== undefined ? 1 : 0)
  if (howMany !== 1) {
    addProblem(l, p, 'exactly one of p_gte (noul) and level_gte (score) is needed')
    return undefined
  }
  if (o.p_gte !== undefined) {
    if (w.type !== 'noul') {
      addProblem(l, childPointer(p, 'p_gte'), `p_gte applies to nouls, "${q}" is a ${w.type}`)
      return undefined
    }
    const x = readNumber(l, o.p_gte, childPointer(p, 'p_gte'), { min: 0, max: 1 })
    return x === undefined ? undefined : { question: q, p_gte: x }
  }
  if (w.type !== 'score') {
    addProblem(l, childPointer(p, 'level_gte'), `level_gte applies to scores, "${q}" is a ${w.type}`)
    return undefined
  }
  const x = readNumber(l, o.level_gte, childPointer(p, 'level_gte'), { integer: true, min: 0, max: levelsOf(w) - 1 })
  return x === undefined ? undefined : { question: q, level_gte: x }
}

// null turns the guard off; an object has all four fields, none of them defaulted,
// because each one decides when the router switches itself off.
function readCacheGuard(l: Reader, v: unknown, p: string): CacheGuard | null | undefined {
  if (v === null) return null
  const o = readObject(l, v, p)
  if (!o) return undefined
  onlyFields(l, o, p, CACHE_GUARD_FIELDS)
  const n = (k: typeof CACHE_GUARD_FIELDS[number], c: NumberConstraints): number | undefined => readNumber(l, requiredField(l, o, p, k), childPointer(p, k), c)
  const minPrefix = n('min_prefix_tokens', { integer: true, min: 0, max: 10_000_000 })
  const ratio = n('max_read_ratio', { min: 0, max: 1 })
  const gap = n('max_gap_ms', { integer: true, min: 0, max: 3_600_000 })
  const trips = n('trips', { integer: true, min: 1, max: 100 })
  if (minPrefix === undefined || ratio === undefined || gap === undefined || trips === undefined) return undefined
  return { min_prefix_tokens: minPrefix, max_read_ratio: ratio, max_gap_ms: gap, trips }
}

export function validateRouter(json: unknown, calibration: Calibration, file: string): Result<RouterConfig> {
  const l = reader(file)
  const o = readObject(l, json, '')
  if (!o) return readResult<RouterConfig>(l, undefined, 'router.json')
  onlyFields(l, o, '', ROUTER_FIELDS)
  if (o.version !== undefined) readNumber(l, o.version, '/version', { integer: true, min: 1, max: 1 })
  const before = l.problems.length
  const r = (k: string): unknown => requiredField(l, o, '', k)
  const p = (k: string): string => childPointer('', k)

  const enabled = readBoolean(l, r('enabled'), p('enabled'))
  // $.http.fetch has its own 30 s timeout: beyond it, the race makes no sense
  const timeout = readNumber(l, r('timeout_ms'), p('timeout_ms'), { integer: true, min: 50, max: 30_000 })
  const busyAfter = readNumber(l, r('busy_after_timeout_ms'), p('busy_after_timeout_ms'), { integer: true, min: 0, max: 3_600_000 })
  const maxChars = readNumber(l, r('prompt_max_chars'), p('prompt_max_chars'), { integer: true, min: 1, max: 100_000 })
  const headChars = readNumber(l, r('prompt_head_chars'), p('prompt_head_chars'), { integer: true, min: 0, max: 100_000 })
  if (maxChars !== undefined && headChars !== undefined && headChars > maxChars) addProblem(l, p('prompt_head_chars'), `must be ≤ prompt_max_chars (${maxChars})`)
  const texts = (k: string, min: number): string[] | undefined => readListOf(l, r(k), p(k), (x, px) => readString(l, x, px, { nonEmpty: true }), { min })
  const skip = texts('skip_prefixes', 0)
  // A kind the engine never sends would skip every prompt without a word: only the
  // kinds of the Claude Code version the router was checked against.
  const origins = readListOf(l, r('only_origins'), p('only_origins'), (x, px) => {
    const kind = readString(l, x, px, { nonEmpty: true })
    if (kind === undefined) return undefined
    if (!(PROMPT_ORIGIN_KINDS as readonly string[]).includes(kind)) {
      addProblem(l, px, `unknown origin "${kind}": expected one of ${PROMPT_ORIGIN_KINDS.join(', ')} (Claude Code 2.1.283)`)
      return undefined
    }
    return kind
  }, { min: 1 })
  const models = texts('only_models', 1)
  const minE = readOneOf(l, r('min_effort'), p('min_effort'), EFFORT_SCALE)
  const maxE = readOneOf(l, r('max_effort'), p('max_effort'), EFFORT_SCALE)
  if (minE && maxE && EFFORT_SCALE.indexOf(minE) > EFFORT_SCALE.indexOf(maxE)) addProblem(l, p('min_effort'), `min_effort ("${minE}") above max_effort ("${maxE}")`)
  const respect = readBoolean(l, r('respect_session_effort'), p('respect_session_effort'))
  const assume = o.assume_session_effort === undefined || o.assume_session_effort === null
    ? null
    : readOneOf(l, o.assume_session_effort, p('assume_session_effort'), EFFORT_SCALE)
  const minTop = readNumber(l, r('min_top_probability'), p('min_top_probability'), { min: 0, max: 1 })
  const guard = readCacheGuard(l, r('cache_guard'), p('cache_guard'))

  // questions: the same validation as checks.json, and only type/instructions/criteria go to the backend
  const questions: Record<string, WireQuestion> = {}
  const qo = readObject(l, r('questions'), p('questions'))
  if (qo) {
    const ids = fieldsOf(qo)
    if (ids.length === 0) addProblem(l, p('questions'), 'no questions')
    if (ids.length > LIMITS.maxQuestions) addProblem(l, p('questions'), `${ids.length} questions: at most ${LIMITS.maxQuestions} per request`)
    for (const id of ids) {
      const pq = childPointer(p('questions'), id)
      if (!RE_ID.test(id)) {
        addProblem(l, pq, MSG_ID)
        continue
      }
      const d = readObject(l, qo[id], pq)
      if (!d) continue
      onlyFields(l, d, pq, ['type', 'instructions', 'criteria'])
      const type = readOneOf(l, requiredField(l, d, pq, 'type'), childPointer(pq, 'type'), QUESTION_TYPES)
      if (!type) continue
      const parsed = readQuestion(l, type, d, pq)
      if (!parsed) continue
      const w: WireQuestion = { type, instructions: parsed.instructions as WireQuestion['instructions'] }
      if (parsed.criteria !== undefined) w.criteria = parsed.criteria
      questions[id] = w
    }
  }

  // The task-kind question has no fixed id in the code: it is the choice whose options
  // match the keys of base.
  let taskQuestion: string | undefined
  const base: RouterConfig['base'] = {}
  const bo = readObject(l, r('base'), p('base'))
  if (bo && qo) {
    const keys = fieldsOf(bo).sort()
    const candidate = Object.keys(questions).filter((id) => {
      const opts = optionsOf(questions[id]).sort()
      return opts.length === keys.length && opts.every((x, k) => x === keys[k])
    })
    if (candidate.length === 1) taskQuestion = candidate[0]
    else if (candidate.length === 0) addProblem(l, p('base'), 'the keys of base must match the options of a choice question (the task kind)')
    else addProblem(l, p('base'), `ambiguous: several choice questions have these options (${candidate.join(', ')})`)
    for (const k of fieldsOf(bo)) {
      const x = readStep(l, bo[k], childPointer(p('base'), k), ['previous'])
      if (x !== undefined && x !== null) base[k] = x
    }
  }

  const adjust = readListOf(l, r('adjust'), p('adjust'), (x, px) => {
    const a = readObject(l, x, px)
    if (!a) return undefined
    onlyFields(l, a, px, ['if', 'raise', 'at_least'])
    const cond = readRouterCondition(l, requiredField(l, a, px, 'if'), childPointer(px, 'if'), questions)
    const howMany = (a.raise !== undefined ? 1 : 0) + (a.at_least !== undefined ? 1 : 0)
    if (howMany !== 1) {
      addProblem(l, px, 'exactly one of raise (steps) and at_least (level) is needed')
      return undefined
    }
    if (a.raise !== undefined) {
      const n = readNumber(l, a.raise, childPointer(px, 'raise'), { integer: true, min: -4, max: 4 })
      return cond && n !== undefined ? { if: cond, raise: n } : undefined
    }
    const atLeast = readOneOf(l, a.at_least, childPointer(px, 'at_least'), EFFORT_SCALE)
    return cond && atLeast ? { if: cond, at_least: atLeast } : undefined
  })

  let explicit: RouterConfig['explicit_depth'] = null
  if (o.explicit_depth !== undefined && o.explicit_depth !== null) {
    const pe = p('explicit_depth')
    const e = readObject(l, o.explicit_depth, pe)
    if (e) {
      onlyFields(l, e, pe, ['question', 'min_probability', 'map'])
      const q = readString(l, requiredField(l, e, pe, 'question'), childPointer(pe, 'question'), { nonEmpty: true })
      const minP = readNumber(l, requiredField(l, e, pe, 'min_probability'), childPointer(pe, 'min_probability'), { min: 0, max: 1 })
      const w = q === undefined ? undefined : questions[q]
      if (q !== undefined && qo && (!w || w.type !== 'choice')) addProblem(l, childPointer(pe, 'question'), `expected a choice question from questions, found "${q}"`)
      const mo = readObject(l, requiredField(l, e, pe, 'map'), childPointer(pe, 'map'))
      const map: Record<string, EffortStep | null> = {}
      if (mo && w && w.type === 'choice') {
        const opts = optionsOf(w)
        for (const k of fieldsOf(mo)) {
          if (!opts.includes(k)) addProblem(l, childPointer(childPointer(pe, 'map'), k), `unknown option: "${q}" has ${opts.join(', ')}`)
        }
        for (const k of opts) {
          if (!(k in mo)) {
            addProblem(l, childPointer(childPointer(pe, 'map'), k), 'option without a value: a step, a level or null is needed')
            continue
          }
          const x = readStep(l, mo[k], childPointer(childPointer(pe, 'map'), k), ['null'])
          if (x !== undefined && x !== 'previous') map[k] = x
        }
      }
      if (q !== undefined && minP !== undefined) explicit = { question: q, min_probability: minP, map }
    }
  }

  const floors = readListOf(l, r('floors'), p('floors'), (x, px) => {
    const a = readObject(l, x, px)
    if (!a) return undefined
    onlyFields(l, a, px, ['if', 'at_least'])
    const cond = readRouterCondition(l, requiredField(l, a, px, 'if'), childPointer(px, 'if'), questions)
    const atLeast = readOneOf(l, requiredField(l, a, px, 'at_least'), childPointer(px, 'at_least'), EFFORT_SCALE)
    return cond && atLeast ? { if: cond, at_least: atLeast } : undefined
  })

  if (l.problems.length > before || enabled === undefined || timeout === undefined || busyAfter === undefined
    || maxChars === undefined || headChars === undefined || !skip || !origins || !models || !minE || !maxE
    || respect === undefined || assume === undefined || minTop === undefined || guard === undefined || !adjust || !floors || !taskQuestion) {
    return readResult<RouterConfig>(l, undefined, 'router.json')
  }
  return readResult<RouterConfig>(l, {
    enabled, timeout_ms: timeout, busy_after_timeout_ms: busyAfter, prompt_max_chars: maxChars, prompt_head_chars: headChars,
    skip_prefixes: skip, only_origins: origins, only_models: models, min_effort: minE, max_effort: maxE,
    respect_session_effort: respect, assume_session_effort: assume, min_top_probability: minTop, cache_guard: guard, base, adjust,
    explicit_depth: explicit, floors, questions, taskQuestion, calibration, file,
  }, 'router.json')
}

// .jev-hooks/router.json: from the project the router accepts only two
// restrictions, `enabled: false` and a `max_effort` that acts as an extra cap. The
// rest of the file (questions, texts, mappings) is not read: the base stays the
// trusted one, and what reaches the effective RouterConfig from the project is a
// boolean and a level, never a text. The notes quote only the filtered pointer: a
// router.json field by name, every other key of the file as a placeholder.
const ROUTER_WORDS: ReadonlySet<string> = new Set(ROUTER_FIELDS)

// Each note is a transcript line, and a cloned repo writes the file: past the first
// few ignored fields only their number is said, so a file with a hundred thousand
// keys still gives a handful of lines.
const SHOWN_IGNORED_FIELDS = 3

export function routerRestrictions(base: RouterConfig, json: unknown, file: string): { router: RouterConfig; notes: string[] } {
  const notes: string[] = []
  let ignored = 0
  const ignore = (p: string, reason: string): void => {
    ignored++
    if (ignored <= SHOWN_IGNORED_FIELDS) notes.push(`${file} ${safePointer(p, ROUTER_WORDS)}: field ignored: ${reason}`)
  }
  if (!isObject(json)) return { router: base, notes: [`${file}: invalid, ignored (expected an object)`] }
  const router: RouterConfig = { ...base }
  for (const k of fieldsOf(json)) {
    const p = childPointer('', k)
    const v = json[k]
    if (k === 'version') continue
    if (k === 'enabled') {
      if (v === false) router.enabled = false
      else if (v !== true) ignore(p, 'expected true or false')
      continue
    }
    if (k === 'max_effort') {
      if (!isEffort(v)) ignore(p, `expected a level among ${EFFORT_SCALE.map((x) => `"${x}"`).join(', ')}`)
      else if (base.projectCap === undefined || EFFORT_SCALE.indexOf(v) < EFFORT_SCALE.indexOf(base.projectCap)) router.projectCap = v
      continue
    }
    ignore(p, 'from the project the router only accepts "enabled": false and a lower "max_effort"')
  }
  const more = ignored - SHOWN_IGNORED_FIELDS
  if (more > 0) notes.push(`${file}: ${more} more ${more === 1 ? 'field' : 'fields'} ignored`)
  return { router, notes }
}

// ═══ Project names ═══
//
// A project id is text chosen by the repo even when it fits RE_ID: an order for Claude
// written in snake_case is a valid id, and a check with that id would appear in the
// escalation question, in the context for Claude and in the CLI. So a name from the
// project goes out only if a trusted layer has already written it; the others are
// replaced here, before the configuration reaches the core, so by construction they
// reach no output (backend, result, cache, log, Claude).

// The names given to a project check or detector that no trusted layer knows: prefix
// plus the position in the file, so the user can find it again. They live here and
// not in provenance.ts because config.ts is in the router's graph.
export const PROJECT_CHECK_PREFIX = 'project_check_'
export const PROJECT_DETECTOR_PREFIX = 'project_detector_'

// prefix + position, and a suffix only if the name is already taken (a trusted id that
// happens to be called exactly that). The result fits RE_ID: it passes the policy
// validation and rizzo's limits on question ids.
export function replacementName(prefix: string, position: number, taken: ReadonlySet<string>): string {
  let name = `${prefix}${position}`
  for (let k = 2; taken.has(name); k++) name = `${prefix}${position}_${k}`
  return name
}

interface Vocabulary {
  words: Set<string>                     // every name written by the trusted layers
  options: Map<string, Set<string>>       // id of a trusted choice → its options
}

// The words of the trusted checks, policy and calibration (user and plugin): check ids
// and choice options, lanes, detector names, ids of the per-question entries.
function trustedVocabulary(checks: readonly Checks[], policy: readonly Policy[], cal: Calibration): Vocabulary {
  const words = new Set<string>()
  const options = new Map<string, Set<string>>()
  for (const c of checks) {
    for (const id of c.order) {
      words.add(id)
      const criteria = c.defs[id].criteria
      if (c.defs[id].type !== 'choice' || !isObject(criteria)) continue
      const o = options.get(id) ?? new Set<string>()
      for (const k of Object.keys(criteria)) {
        o.add(k)
        words.add(k)
      }
      options.set(id, o)
    }
  }
  for (const p of policy) {
    for (const c of p.lanes) words.add(c.name)
    for (const d of p.detectors) words.add(d.name)
  }
  for (const pr of cal.profiles) {
    for (const k of Object.keys(pr.per_question ?? {})) words.add(k)
    for (const k of Object.keys(pr.thresholds ?? {})) words.add(k)
  }
  return { words, options }
}

// A project checks.json with the ids unknown to the trusted layers replaced by
// project_check_N (N = position in the file). The label gives way to the id too: the
// project's never goes out, and so the effective configuration keeps only the text the
// backend needs (instructions and criteria). names: file id → new name, to translate
// the references in .jev-hooks/policy.json.
function replaceNames(c: Checks, vocab: Vocabulary): { checks: Checks; names: Map<string, string> } {
  const taken = new Set<string>(vocab.words)
  const names = new Map<string, string>()
  const order: string[] = []
  const items: Record<string, CheckDef> = {}
  const added: string[] = []
  const trustedOptions: Record<string, string[]> = {}
  c.order.forEach((id, i) => {
    const def = c.defs[id]
    let name = id
    if (!vocab.words.has(id)) {
      name = replacementName(PROJECT_CHECK_PREFIX, i + 1, taken)
      taken.add(name)
      names.set(id, name)
      added.push(name)
    }
    order.push(name)
    items[name] = { ...def, label: name }
    const trusted = vocab.options.get(id)
    if (trusted && def.type === 'choice' && isObject(def.criteria)) {
      const keys = Object.keys(def.criteria).filter((k) => trusted.has(k))
      if (keys.length > 0) trustedOptions[name] = keys
    }
  })
  const checks: Checks = { order, defs: items, file: c.file, fromProject: true }
  if (added.length > 0) checks.added = added
  if (Object.keys(trustedOptions).length > 0) checks.trustedOptions = trustedOptions
  return { checks, names }
}

// .jev-hooks/policy.json names the checks by the ids of its checks.json: the replaced
// ones are translated before reading it. Only the fields that name a check (the check
// of a rule and of its unless, the check of a detector); the rest stays as it is, and
// if it is invalid overlayPolicy will say so.
function translateReferences(json: unknown, names: ReadonlyMap<string, string>): unknown {
  if (names.size === 0 || !isObject(json)) return json
  const translate = (v: unknown): unknown => {
    if (!isObject(v)) return v
    const out: PlainObject = { ...v }
    if (typeof v.check === 'string' && names.has(v.check)) out.check = names.get(v.check)
    if (isObject(v.unless)) out.unless = translate(v.unless)
    else if (Array.isArray(v.unless)) out.unless = v.unless.map(translate)
    return out
  }
  const out: PlainObject = { ...json }
  if (Array.isArray(json.lanes)) {
    out.lanes = json.lanes.map((c) => (isObject(c) && Array.isArray(c.rules) ? { ...c, rules: c.rules.map(translate) } : c))
  }
  if (Array.isArray(json.detectors)) out.detectors = json.detectors.map(translate)
  return out
}

// ═══ Project overlay: it can only tighten ═══
//
// .jev-hooks/policy.json can be written by a cloned repo, or by Claude after an
// injection. That is why it does not replace the base: it can only make it stricter.
// Every field that would loosen something is ignored with a note naming file and
// pointer. An invalid project file is ignored entirely, never fail-open: otherwise
// breaking it would be enough to remove the floors.

function atLeastAsStrict(fresh: Rule, old: Rule): boolean {
  if (direction(fresh.op) !== direction(old.op)) return false
  const strict = fresh.op === 'gte' || fresh.op === 'lte'
  const oldStrict = old.op === 'gte' || old.op === 'lte'
  const valueOk = direction(fresh.op) === 'up'
    ? fresh.value < old.value || (fresh.value === old.value && (strict || !oldStrict))
    : fresh.value > old.value || (fresh.value === old.value && (strict || !oldStrict))
  // a new (or different) unless condition opens a case in which the rule no longer
  // fires; dropping one of the base's conditions only makes the rule fire more often
  const key = (c: Condition): string => canonical({ check: c.check, op: c.op, value: c.value })
  const base = new Set((old.unless ?? []).map(key))
  const unlessOk = (fresh.unless ?? []).every((c) => base.has(key(c)))
  // removing the escalation would mean a question that no longer reaches Claude
  const actionOk = old.action === undefined || fresh.action === old.action
  return valueOk && unlessOk && actionOk
}

const CI_SEVERITY: readonly CiConclusion[] = ['success', 'neutral', 'failure']

// vocabulary: the words of the trusted layers (ids, detector names, lanes). The file
// always belongs to the project: problems and notes quote only those, field names,
// indexes and fixed phrases. A new detector keeps its name only if it is among them.
export function overlayPolicy(
  base: Policy, json: unknown, checks: Checks, file: string, vocabulary: ReadonlySet<string> = NO_WORDS,
): { policy: Policy; notes: string[]; valid: boolean } {
  const l = reader(file, true, vocabulary)
  const notes: string[] = []
  // the pointer is filtered when the note is written, with the words recorded so far:
  // the section's field names have already been through onlyFields
  const ignore = (p: string, reason: string): void => {
    notes.push(`${file} ${safePointer(p, l.words)}: field ignored: ${reason}`)
  }
  const lanes = base.lanes.map((c) => ({ ...c, rules: [...c.rules] }))
  const laneNames = lanes.map((c) => c.name)
  const severity = (name: string | null): number => (name === null ? lanes.length : laneNames.indexOf(name))
  const band = { ...base.band }
  const limits = { ...base.limits }
  const network = { ...base.network }
  const detectors = base.detectors.map((d) => ({ ...d }))
  const hook = { ...base.hook }
  const partial = { ...base.partial_coverage }
  const ci = { ...base.ci }
  const escalation = { ...base.escalation }

  const o = readObject(l, json, '')
  if (o) {
    onlyFields(l, o, '', POLICY_FIELDS)
    if (o.version !== undefined) readNumber(l, o.version, '/version', { integer: true, min: 1, max: 1 })

    if (o.lanes !== undefined) {
      readList(l, o.lanes, '/lanes')?.forEach((x, i) => {
        const p = childPointer('/lanes', i)
        const c = readObject(l, x, p)
        if (!c) return
        onlyFields(l, c, p, LANE_FIELDS)
        const name = readString(l, requiredField(l, c, p, 'name'), childPointer(p, 'name'), { nonEmpty: true })
        if (name === undefined) return
        const k = laneNames.indexOf(name)
        if (k < 0) {
          addProblem(l, childPointer(p, 'name'), `unknown lane ${quoteFor(l, name)} (lanes: ${laneNames.join(', ')}): the project cannot add lanes`)
          return
        }
        for (const field of ['exit_code', 'color', 'hook']) {
          if (c[field] !== undefined) ignore(childPointer(p, field), 'from the project a lane can only change its rules and make its CI conclusion more severe')
        }
        // a stricter conclusion in CI (SECURITY REVIEW as failure) only tightens
        if (c.ci !== undefined) {
          const v = readOneOf(l, c.ci, childPointer(p, 'ci'), CONCLUSIONS)
          if (v && CI_SEVERITY.indexOf(v) > CI_SEVERITY.indexOf(lanes[k].ci)) lanes[k] = { ...lanes[k], ci: v }
          else if (v && v !== lanes[k].ci) ignore(childPointer(p, 'ci'), 'from the project a CI conclusion can only be made more severe')
        }
        if (c.rules === undefined) return
        const pr = childPointer(p, 'rules')
        const raw = Array.isArray(c.rules) ? c.rules : []
        const rules = readListOf(l, c.rules, pr, (r, px) => readRule(l, r, px, checks))
        rules?.forEach((parsed, j) => {
          const lane = lanes[k]
          const same = lane.rules
            .map((b, idx) => ({ b, idx }))
            .filter(({ b }) => b.check === parsed.check && direction(b.op) === direction(parsed.op))
          if (same.length === 0) {
            // a new rule only adds a way to fire
            lane.rules.push(parsed)
            return
          }
          // A rule that does not write "action" tightens the threshold and keeps the base's
          // escalation: whoever lowers the hardcoded_secret threshold does not want to
          // stop asking Claude. An explicit "lane" on a rule with escalation, instead,
          // would remove it: atLeastAsStrict rejects it.
          const g = raw[j]
          const explicit = isObject(g) && g.action !== undefined
          let applied = false
          for (const { b, idx } of same) {
            const r = !explicit && b.action !== undefined ? { ...parsed, action: b.action } : parsed
            if (canonical(b as unknown as Json) === canonical(r as unknown as Json)) applied = true
            else if (atLeastAsStrict(r, b)) {
              lane.rules[idx] = r
              applied = true
            }
          }
          if (!applied) ignore(childPointer(pr, j), 'looser threshold from the project: a rule can only be tightened')
        })
      })
    }

    if (o.band !== undefined) {
      const b = readObject(l, o.band, '/band')
      if (b) {
        onlyFields(l, b, '/band', ['delta_logit'])
        const d = b.delta_logit === undefined ? undefined : readNumber(l, b.delta_logit, '/band/delta_logit', BAND_LIMITS)
        if (d !== undefined && d > band.delta_logit) band.delta_logit = d
        else if (d !== undefined && d < band.delta_logit) ignore('/band/delta_logit', 'from the project the band can only be widened')
      }
    }

    if (o.limits !== undefined) {
      const li = readObject(l, o.limits, '/limits')
      if (li) {
        onlyFields(l, li, '/limits', ORIGINS)
        for (const origin of ORIGINS) {
          if (li[origin] === undefined) continue
          const po = childPointer('/limits', origin)
          const x = readObject(l, li[origin], po)
          if (!x) continue
          onlyFields(l, x, po, ['max_chunks', 'total_ms'])
          const updated = { ...limits[origin] }
          for (const k of ['max_chunks', 'total_ms'] as const) {
            if (x[k] === undefined) continue
            const n = readNumber(l, x[k], childPointer(po, k), LIMITS_CONSTRAINTS[k])
            if (n === undefined) continue
            if (n < updated[k]) updated[k] = n
            else if (n > updated[k]) ignore(childPointer(po, k), 'from the project the limits can only be lowered: a cloned repo must not make you spend more')
          }
          limits[origin] = updated
        }
      }
    }

    if (o.network !== undefined) {
      const nw = readObject(l, o.network, '/network')
      if (nw) {
        const keys = Object.keys(NETWORK_CONSTRAINTS) as (keyof Policy['network'])[]
        onlyFields(l, nw, '/network', keys)
        for (const k of keys) {
          if (nw[k] === undefined) continue
          const n = readNumber(l, nw[k], childPointer('/network', k), NETWORK_CONSTRAINTS[k])
          if (n === undefined) continue
          if (n < network[k]) network[k] = n
          else if (n > network[k]) ignore(childPointer('/network', k), 'from the project the network settings can only be tightened (less time, fewer attempts, less parallelism)')
        }
      }
    }

    if (o.detectors !== undefined) {
      const fresh = new Set<string>()
      const testPaths = base.test_paths
      const taken = new Set<string>([...vocabulary, ...detectors.map((r) => r.name)])
      readList(l, o.detectors, '/detectors')?.forEach((x, i) => {
        const p = childPointer('/detectors', i)
        const d = readObject(l, x, p)
        if (!d) return
        const name = typeof d.name === 'string' ? d.name : undefined
        const k = name === undefined ? -1 : detectors.findIndex((r) => r.name === name)
        if (k < 0) {
          // a new detector only adds hits and floors
          const r = readDetector(l, d, p, { checks, lanes: laneNames, testPaths })
          if (!r) return
          if (fresh.has(r.name)) addProblem(l, childPointer(p, 'name'), `detector ${quoteFor(l, r.name)} repeated`)
          fresh.add(r.name)
          // the repo chooses the name, and it would reach Claude in the hits, the floors
          // and the escalation questions: if no trusted layer knows it, the name with the
          // position in the list takes its place (1 = the first)
          const name = vocabulary.has(r.name) ? r.name : replacementName(PROJECT_DETECTOR_PREFIX, i + 1, taken)
          taken.add(name)
          detectors.push({ ...r, name, fromProject: true })
          return
        }
        onlyFields(l, d, p, DETECTOR_FIELDS)
        const existing = detectors[k]
        for (const field of fieldsOf(d)) {
          if (field !== 'name' && field !== 'floor' && field !== 'escalate') {
            ignore(childPointer(p, field), 'from the project an existing detector can only be strengthened (floor, escalate): regex and exclusions stay those of the base')
          }
        }
        if (d.floor !== undefined) {
          const fl = readFloor(l, d.floor, childPointer(p, 'floor'), laneNames)
          if (fl !== undefined && severity(fl) < severity(existing.floor)) existing.floor = fl
          else if (fl !== undefined && fl !== existing.floor) ignore(childPointer(p, 'floor'), 'from the project a floor can only be raised')
        }
        if (d.escalate !== undefined) {
          const es = readOneOf(l, d.escalate, childPointer(p, 'escalate'), ESCALATE_VALUES)
          if (es && ESCALATE_VALUES.indexOf(es) > ESCALATE_VALUES.indexOf(existing.escalate)) {
            const def = existing.check === undefined ? undefined : checks.defs[existing.check]
            if (es === 'if_model_disagrees' && (!def || !isModelProbability(def))) {
              ignore(childPointer(p, 'escalate'), `"if_model_disagrees" needs a check among ${MSG_PROBABILITY}`)
            } else existing.escalate = es
          } else if (es && es !== existing.escalate) ignore(childPointer(p, 'escalate'), 'from the project escalation can only be strengthened')
        }
      })
    }

    if (o.hook !== undefined) {
      const h = readObject(l, o.hook, '/hook')
      if (h) {
        onlyFields(l, h, '/hook', ['enabled', 'on_error', 'cache_ttl_min'])
        if (h.enabled !== undefined) {
          const en = readBoolean(l, h.enabled, '/hook/enabled')
          if (en === false) ignore('/hook/enabled', 'the hook is turned off with the commit_review option or JEV_HOOKS_DISABLE, not from the project')
        }
        if (h.on_error !== undefined) {
          const oe = readOneOf(l, h.on_error, '/hook/on_error', ['warn', 'ask'] as const)
          if (oe === 'ask') hook.on_error = 'ask'
          else if (oe && oe !== hook.on_error) ignore('/hook/on_error', 'from the project on_error can only go from "warn" to "ask"')
        }
        if (h.cache_ttl_min !== undefined) {
          const t = readNumber(l, h.cache_ttl_min, '/hook/cache_ttl_min', { integer: true, min: 0, max: 100_000 })
          if (t !== undefined && t < hook.cache_ttl_min) hook.cache_ttl_min = t
          else if (t !== undefined && t > hook.cache_ttl_min) ignore('/hook/cache_ttl_min', 'from the project the cache can only be shortened')
        }
      }
    }

    if (o.partial_coverage !== undefined) {
      const pc = readObject(l, o.partial_coverage, '/partial_coverage')
      if (pc) {
        onlyFields(l, pc, '/partial_coverage', ['min_lane'])
        if (pc.min_lane !== undefined) {
          const m = readFloor(l, pc.min_lane, '/partial_coverage/min_lane', laneNames)
          if (typeof m === 'string' && severity(m) < severity(partial.min_lane)) partial.min_lane = m
          else if (m !== undefined && m !== partial.min_lane) ignore('/partial_coverage/min_lane', 'from the project the minimum lane can only be raised')
        }
      }
    }

    const mostSevere = (section: PlainObject, p: string, k: string, current: CiConclusion): CiConclusion => {
      if (section[k] === undefined) return current
      const v = readOneOf(l, section[k], childPointer(p, k), CONCLUSIONS)
      if (v && CI_SEVERITY.indexOf(v) > CI_SEVERITY.indexOf(current)) return v
      if (v && v !== current) ignore(childPointer(p, k), 'from the project a CI conclusion can only be made more severe')
      return current
    }
    if (o.ci !== undefined) {
      const c = readObject(l, o.ci, '/ci')
      if (c) {
        onlyFields(l, c, '/ci', ['backend_unavailable', 'untrusted_input'])
        ci.backend_unavailable = mostSevere(c, '/ci', 'backend_unavailable', ci.backend_unavailable)
        ci.untrusted_input = mostSevere(c, '/ci', 'untrusted_input', ci.untrusted_input)
      }
    }
    if (o.escalation !== undefined) {
      const e = readObject(l, o.escalation, '/escalation')
      if (e) {
        onlyFields(l, e, '/escalation', ['hook', 'ci', 'max_files', 'ttl_min'])
        if (e.hook !== undefined) {
          // context < deny_then_allow < deny_then_ask: from the project only rightwards.
          // A cloned repo must not be able to remove the deny that sends the prompt to
          // Claude, nor the user confirmation the base asks for
          const h = readOneOf(l, e.hook, '/escalation/hook', HOOK_ESCALATION_MODES)
          if (h && HOOK_ESCALATION_MODES.indexOf(h) > HOOK_ESCALATION_MODES.indexOf(escalation.hook)) escalation.hook = h
          else if (h && h !== escalation.hook) ignore('/escalation/hook', `from the project escalation can only be tightened (${HOOK_ESCALATION_MODES.join(' < ')})`)
        }
        escalation.ci = mostSevere(e, '/escalation', 'ci', escalation.ci)
        for (const k of ['max_files', 'ttl_min']) {
          if (e[k] !== undefined) ignore(childPointer('/escalation', k), 'change it in the user file, not from the project')
        }
      }
    }

    const reasons: Record<string, string> = {
      state: 'it would change what reaches the model and what stays excluded',
      test_paths: "it would widen the detectors' exclusions",
      colors: 'presentation only: change it in the user file',
    }
    for (const k of Object.keys(reasons)) if (o[k] !== undefined) ignore(`/${k}`, reasons[k])
  }

  if (l.problems.length > 0) {
    const first = formatProblem(l.problems[0])
    const others = l.problems.length > 1 ? ` (and ${l.problems.length - 1} more problems)` : ''
    return { policy: base, notes: [`${file}: invalid, ignored entirely (the base rules stay): ${first}${others}`], valid: false }
  }
  return {
    policy: { ...base, lanes, band, limits, network, detectors, hook, partial_coverage: partial, ci, escalation },
    notes: [...(l.notes ?? []), ...notes],
    valid: true,
  }
}

// ═══ Layer composition ═══

function fromFile<T>(f: ConfigFile, valid: (json: unknown, file: string) => Result<T>, untrusted: boolean = false): Result<T> {
  const j = parseJson(f.text, f.path, untrusted)
  return j.ok ? valid(j.value, f.path) : { ok: false, error: j.error }
}

export function readChecks(f: ConfigFile, o: { fromProject?: boolean; vocabulary?: Iterable<string> } = {}): Result<Checks> {
  return fromFile(f, (j, file) => validateChecks(j, file, o), o.fromProject === true)
}

export function readCalibration(f: ConfigFile): Result<Calibration> {
  return fromFile(f, validateCalibration)
}

function onlyProbabilityThresholds(c: Calibration, checks: Checks, source: string, warn: (text: string) => void): Calibration {
  let changed = false
  const profiles = c.profiles.map((pr, i) => {
    if (!pr.thresholds) return pr
    const kept: Record<string, number> = {}
    for (const [id, v] of Object.entries(pr.thresholds)) {
      const def = Object.hasOwn(checks.defs, id) ? checks.defs[id] : undefined
      if (def && !isModelProbability(def)) {
        warn(`${source} /profiles/${i}/thresholds/${id}: threshold ignored: calibrated thresholds are probabilities and ${id} is not among ${MSG_PROBABILITY}`)
        changed = true
      } else kept[id] = v
    }
    return Object.keys(kept).length === Object.keys(pr.thresholds).length ? pr : { ...pr, thresholds: kept }
  })
  return changed ? { ...c, profiles } : c
}

// checks and router: the first layer found wins, in full. policy: the base is the
// user's or the plugin's, the project can only tighten it. calibration: only user or
// plugin. It returns an error only if the plugin defaults are invalid: then the plugin
// itself is broken, and no fallback makes sense.
export function composeConfig(layers: ConfigLayers): Result<ComposedConfig> {
  const warnings: string[] = []
  const userProblems: Problem[] = []
  const seen = new Set<string>()
  const warn = (text: string, problems?: Problem[]): void => {
    if (!seen.has(text)) {
      seen.add(text)
      warnings.push(text)
    }
    for (const p of problems ?? []) {
      if (!userProblems.some((q) => formatProblem(q) === formatProblem(p))) userProblems.push(p)
    }
  }

  const pc = readChecks(layers.plugin.checks)
  if (!pc.ok) return pc
  const pj = parseJson(layers.plugin.policy.text, layers.plugin.policy.path)
  if (!pj.ok) return pj
  const pp = validatePolicy(pj.value, pc.value, layers.plugin.policy.path)
  if (!pp.ok) return pp
  const pk = readCalibration(layers.plugin.calibration)
  if (!pk.ok) return pk

  let calibration = pk.value
  let calibrationSource = layers.plugin.calibration.path
  if (layers.user.calibration) {
    const r = readCalibration(layers.user.calibration)
    if (r.ok) {
      calibration = r.value
      calibrationSource = layers.user.calibration.path
    } else warn(`${r.error.message}: using ${calibrationSource}`, r.error.problems)
  }
  if (layers.project.calibration) {
    warn(`${layers.project.calibration.path}: ignored: calibration.json is read only from the user layer or the plugin (a project calibration could squash every probability)`)
  }

  // Base: trusted checks and policy (user, otherwise plugin), in a combination that
  // holds together: the policy.json rules must name checks that exist.
  interface Candidate<T> { value: T; path: string; fromUser: boolean }
  const trustedChecks: Candidate<Checks>[] = []
  if (layers.user.checks) {
    const r = readChecks(layers.user.checks)
    if (r.ok) trustedChecks.push({ value: r.value, path: layers.user.checks.path, fromUser: true })
    else warn(`${r.error.message}: using the plugin's checks`, r.error.problems)
  }
  trustedChecks.push({ value: pc.value, path: layers.plugin.checks.path, fromUser: false })
  const trustedPolicies: Candidate<unknown>[] = []
  if (layers.user.policy) {
    const j = parseJson(layers.user.policy.text, layers.user.policy.path)
    if (j.ok) trustedPolicies.push({ value: j.value, path: layers.user.policy.path, fromUser: true })
    else warn(`${j.error.message}: using the plugin's policy`, j.error.problems)
  }
  trustedPolicies.push({ value: pj.value, path: layers.plugin.policy.path, fromUser: false })

  let selection: { checks: Candidate<Checks>; policyJson: Candidate<unknown>; policy: Policy } | null = null
  for (const c of trustedChecks) {
    for (const p of trustedPolicies) {
      const r = validatePolicy(p.value, c.value, p.path)
      if (r.ok) {
        selection = { checks: c, policyJson: p, policy: r.value }
        break
      }
      if (p.fromUser) warn(`${r.error.message}: ${p.path} ignored`, r.error.problems)
      else if (c.fromUser) warn(`${c.path}: incompatible with ${p.path} (${r.error.message}): using the plugin's checks`, r.error.problems)
    }
    if (selection) break
  }
  // the plugin pair has already been validated above: this is never reached without a selection
  if (!selection) return { ok: false, error: { kind: 'internal', message: 'no valid configuration' } }

  for (const n of selection.policy.notes ?? []) warn(n)
  let checks = selection.checks.value
  let policy = selection.policy
  let checksSource = selection.checks.path
  const policySource = selection.policyJson.path
  const vocab = trustedVocabulary(trustedChecks.map((c) => c.value), [pp.value, selection.policy], calibration)
  let names = new Map<string, string>()

  if (layers.project.checks) {
    // marked fromProject: its labels and instructions do not go out to Claude, its ids
    // unknown to the trusted layers are replaced before any other use, and its path
    // regexes run outside the core with a time limit (review.ts)
    const r = readChecks(layers.project.checks, { fromProject: true, vocabulary: vocab.words })
    if (!r.ok) warn(`${r.error.message}: using ${checksSource}`)
    else {
      const replaced = replaceNames(r.value, vocab)
      const withProject = validatePolicy(selection.policyJson.value, replaced.checks, policySource)
      if (withProject.ok) {
        for (const n of withProject.value.notes ?? []) warn(n)
        checks = replaced.checks
        names = replaced.names
        policy = withProject.value
        checksSource = layers.project.checks.path
      } else {
        warn(`${layers.project.checks.path}: ignored, the rules in ${policySource} name checks it does not define or that do not fit (${withProject.error.message}): using ${checksSource}`)
      }
    }
  }

  // A profile's calibrated thresholds are probabilities (validated in [0, 1]) and they
  // replace the value of every rule on the check: on a score (0 to n − 1) or a choice
  // without a value they would silently change scale. They are ignored with a warning;
  // an id that is not a check can be a router question, and it stays.
  calibration = onlyProbabilityThresholds(calibration, checks, calibrationSource, warn)

  let policyDescription = policySource
  if (layers.project.policy) {
    const j = parseJson(layers.project.policy.text, layers.project.policy.path, true)
    if (!j.ok) warn(`${j.error.message}: ignored, the rules of ${policySource} stay`)
    else {
      const s = overlayPolicy(policy, translateReferences(j.value, names), checks, layers.project.policy.path, vocab.words)
      for (const n of s.notes) warn(n)
      if (s.valid) {
        policy = s.policy
        policyDescription = `${policySource} + ${layers.project.policy.path} (restrictions only)`
      }
    }
  }

  return {
    ok: true,
    value: {
      checks,
      policy,
      calibration,
      sources: { checks: checksSource, policy: policyDescription, calibration: calibrationSource },
      warnings,
      userProblems,
    },
  }
}
