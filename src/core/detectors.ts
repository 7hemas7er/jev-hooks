// Deterministic detectors: the regexes of policy.json run on the diff before
// any call, without the network. They set floors that the model cannot lower (an
// AKIA… in src/ gives BLOCK even with the backend off) and flag what Claude has to
// look at anyway (injection, bidi, reviewer rules).
//
// No detector name is written here: what to look for, where and with which
// consequences is up to the JSON.
import { matchesAny } from './diff.ts'
import { detectorLabel } from './provenance.ts'
import type { Hit, ParsedDiff, DetectorResult, Policy, Detector } from './types.ts'

export type { Hit, DetectorResult } from './types.ts'

type Where = Hit['where']

// Shannon entropy in bits per character (code point). It tells a real key ("Xk9#…")
// apart from a repetitive placeholder ("xxxxxxxx") or from a name.
export function entropy(s: string): number {
  const counts = new Map<string, number>()
  let n = 0
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
    n++
  }
  let h = 0
  for (const k of counts.values()) {
    const p = k / n
    h -= p * Math.log2(p)
  }
  return h === 0 ? 0 : h   // no -0 for a single symbol
}

const RE_TOKEN = /[A-Za-z0-9+/=_-]+/g

// The hit token is the longest run of key characters inside the match: in
// `SECRET_KEY = "…"` it is the value, not the name nor the quotes.
function longestToken(m: string): string {
  let best = ''
  for (const t of m.match(RE_TOKEN) ?? []) if (t.length > best.length) best = t
  return best
}

function validHit(r: Detector, m: string): boolean {
  if (r.ignore_values && r.ignore_values.test(m)) return false
  if (r.min_entropy !== undefined && entropy(longestToken(m)) < r.min_entropy) return false
  return true
}

// A line can hold several matches: the first may be an example value and the second
// a real key, so all of them are scanned up to the first valid one. An empty match is
// not a hit (a project regex such as `a*` would hit every line).
function findValid(g: RegExp, r: Detector, text: string): boolean {
  g.lastIndex = 0
  for (let m = g.exec(text); m !== null; m = g.exec(text)) {
    if (m[0] === '') {
      g.lastIndex++
      continue
    }
    if (validHit(r, m[0])) return true
  }
  return false
}

const globalRegex = (re: RegExp): RegExp => new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'g')

// Floors grouped by lane, most severe first (order of lanes).
function floorsOf(hitSet: Map<string, string[]>, p: Policy): DetectorResult['floors'] {
  const out: DetectorResult['floors'] = []
  for (const lane of p.lanes) {
    const by = hitSet.get(lane.name)
    if (by && by.length > 0) out.push({ lane: lane.name, by })
  }
  return out
}

// "Injection" is the hit of a detector that also looks at the title or the
// description: those are texts written for people, and the only thing worth looking
// for in them is text addressed to the reviewer (imperative sentences, prompt
// delimiters). The criterion lies in the shape of the JSON, not in detector names.
const searchesTexts = (r: Detector): boolean => r.where.includes('title') || r.where.includes('description')

// Detectors run on every text file, including those the model will not see (a token
// in a file under dist/ counts), and each one skips its own exclude_paths. A line
// gives at most one hit per detector.
//
// detect runs every detector of the policy it receives: those added by the project
// (fromProject) must run in the Worker with the time limit of src/node/regex.ts,
// by passing here a policy that holds them only there, and the two results
// are merged with mergeDetectorResults.
export function detect(d: ParsedDiff, meta: { title: string; description: string | null }, p: Policy): DetectorResult {
  const hits: Hit[] = []
  const hitSet = new Map<string, string[]>()
  let injection = false
  for (const r of p.detectors) {
    const g = globalRegex(r.regex)
    const before = hits.length
    const add = (where: Where, file?: string, line?: number): void => {
      // the label of a project detector does not enter the result: the result goes
      // out whole with --json and ends up in the cache
      const c: Hit = { detector: r.name, label: detectorLabel(r), where }
      if (r.check !== undefined) c.check = r.check
      if (file !== undefined) c.file = file
      if (line !== undefined) c.line = line
      hits.push(c)
    }
    for (const where of r.where) {
      if (where === 'added_lines') {
        for (const f of d.files) {
          if (f.addedLines.length === 0 || matchesAny(r.exclude_paths, f.path)) continue
          for (const line of f.addedLines) if (findValid(g, r, line.text)) add(where, f.path, line.number)
        }
      } else if (where === 'paths') {
        // the original name of a rename too: moving a file out of .jev-hooks/ takes
        // it out of the rules
        for (const f of d.files) {
          const names = f.oldPath === undefined ? [f.path] : [f.path, f.oldPath]
          if (names.some((n) => !matchesAny(r.exclude_paths, n) && findValid(g, r, n))) add(where, f.path)
        }
      } else {
        const text = where === 'title' ? meta.title : meta.description
        if (text !== null && findValid(g, r, text)) add(where)
      }
    }
    if (hits.length === before) continue
    if (searchesTexts(r)) injection = true
    if (r.floor !== null) hitSet.set(r.floor, [...(hitSet.get(r.floor) ?? []), r.name])
  }
  return { hits, floors: floorsOf(hitSet, p), injection }
}

// Merges the result of the base detectors with that of the project detectors run
// separately: floors can only add up.
export function mergeDetectorResults(a: DetectorResult, b: DetectorResult, p: Policy): DetectorResult {
  const hitSet = new Map<string, string[]>()
  for (const x of [...a.floors, ...b.floors]) {
    const by = hitSet.get(x.lane) ?? []
    for (const n of x.by) if (!by.includes(n)) by.push(n)
    hitSet.set(x.lane, by)
  }
  return { hits: [...a.hits, ...b.hits], floors: floorsOf(hitSet, p), injection: a.injection || b.injection }
}
