// File priority and splitting of the diff into chunks. A chunk is the state
// of one request for the chunk questions; the global state is the one of the global
// questions. The budget of every state is tokens_per_state (2000 by default: rizzo's
// quality is measured up to about 2.1k tokens), estimated on the rendered text,
// headers included.
//
// The chunk questions ALWAYS receive a chunk state, even when the diff fits in a
// single chunk (shape "single"): this way the state of the local questions has a
// single shape, whatever the size of the diff, and the description, which is hostile
// in a PR from a fork, never reaches the critical questions.
import { byCodePoint } from './canonical.ts'
import { matchesAny, parseHunkHeader } from './diff.ts'
import { neutralizeLines, tokenWeight, fileLine, globalState, chunkState, estimateTokens, oneLineTitle, truncate } from './state.ts'
import type { Checks, Hit, ParsedDiff, FileDiff, Chunk, Plan, Policy } from './types.ts'

export type { Chunk, Plan } from './types.ts'

export const REASON_OVER_CHUNKS = 'beyond the chunk limit'
export const REASON_OVER_GLOBAL = 'beyond the global state limit'

// A chunk is estimated before knowing how many chunks there will be: the widest
// placeholder makes the estimate a cap for "[part] i of n".
const PLACEHOLDER_PART: [number, number] = [99999, 99999]
const PLACEHOLDER_COUNT = 999999
const EPS = 1e-9

type Hunk = FileDiff['hunks'][number]

// ─── Priority ─────────────────────────────────────────────────────────────────

// First the files that match the escalation_patterns of a critical check asked of the
// model, then those with detector hits, then the rest; within each group in path
// order (by code point, like git's bytes). Beyond max_chunks the chunks at the end are
// lost: they must be the least important ones.
export function prioritize(file: FileDiff[], checks: Checks, hits: Hit[]): FileDiff[] {
  const pattern = checks.order
    .map((id) => checks.defs[id])
    .filter((v) => v.critical && v.source === 'model')
    .flatMap((v) => v.escalation_patterns)
  const withHits = new Set<string>()
  for (const c of hits) if (c.file !== undefined) withHits.add(c.file)
  const level = (f: FileDiff): number => (matchesAny(pattern, f.path) ? 0 : withHits.has(f.path) ? 1 : 2)
  return file
    .map((f) => ({ f, l: level(f) }))
    .sort((x, y) => x.l - y.l || byCodePoint(x.f.path, y.f.path))
    .map((x) => x.f)
}

// ─── Weights ──────────────────────────────────────────────────────────────────

// The weight of a line is its token estimate (not rounded) plus the newline. The state
// is the exact concatenation of the lines (neutralization goes line by line), so the
// sum of the weights is the estimate of the state, with one extra newline: a margin,
// not an error.
function weigher(cpt: number): (line: string) => number {
  return (line) => tokenWeight(neutralizeLines(line), cpt) + 1 / cpt
}

const headerLines = (f: FileDiff): string[] => (f.header === '' ? [] : f.header.split('\n'))
const hunkLines = (h: Hunk): string[] => [h.header, ...h.lines]
const fileLines = (f: FileDiff): string[] => [...headerLines(f), ...f.hunks.flatMap(hunkLines)]
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

// ─── Splitting by hunk and by line ────────────────────────────────────────────

interface Piece { lines: string[]; weight: number }

// A hunk that is too large is split between one line and the next, never in the
// middle of a line. Every piece has its own @@ header with recomputed line numbers;
// from the second one on it says "(continues)".
function splitHunk(h: Hunk, available: number, weight: (r: string) => number): Piece[] {
  const hh = parseHunkHeader(h.header)
  // numbers of the next old and new line (with 0 lines git writes the previous one)
  let old = hh ? (hh.oldCount === 0 ? hh.oldStart + 1 : hh.oldStart) : 1
  let fresh = hh ? (hh.newCount === 0 ? hh.newStart + 1 : hh.newStart) : h.newStart
  const context = hh ? hh.context : ''
  const wide = '@@ -9999999,9999999 +9999999,9999999 @@'
  const space = available - Math.max(weight(wide + context), weight(`${wide} (continues)`))

  const groups: string[][] = []
  let current: string[] = []
  let used = 0
  for (const r of h.lines) {
    const w = weight(r)
    if (current.length > 0 && used + w > space + EPS) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(r)
    used += w
  }
  if (current.length > 0) groups.push(current)

  return groups.map((lines, k) => {
    let nv = 0
    let nn = 0
    for (const r of lines) {
      if (r[0] === ' ') {
        nv++
        nn++
      } else if (r[0] === '-') nv++
      else if (r[0] === '+') nn++
    }
    const numbers = `@@ -${nv === 0 ? old - 1 : old},${nv} +${nn === 0 ? fresh - 1 : fresh},${nn} @@`
    const head = k === 0 ? numbers + context : `${numbers} (continues)`
    old += nv
    fresh += nn
    const all = [head, ...lines]
    return { lines: all, weight: sum(all.map(weight)) }
  })
}

// ─── Packing ──────────────────────────────────────────────────────────────────

interface Segment { f: FileDiff; lines: string[] }
interface ChunkInProgress { segments: Segment[]; weight: number }

function pack(file: FileDiff[], T: number, weight: (r: string) => number): ChunkInProgress[] {
  const skeleton = sum(['[files]', '[part]', `${PLACEHOLDER_PART[0]} of ${PLACEHOLDER_PART[1]}`, '[diff]'].map(weight))
  const fileWeight = (f: FileDiff): number => weight(fileLine(f)) + sum(headerLines(f).map(weight))
  const chunks: ChunkInProgress[] = []
  let cur: ChunkInProgress | null = null

  const fresh = (): ChunkInProgress => {
    const p: ChunkInProgress = { segments: [], weight: skeleton }
    chunks.push(p)
    return p
  }
  const extra = (p: ChunkInProgress, f: FileDiff, w: number): number => {
    const last = p.segments[p.segments.length - 1]
    return (last && last.f === f ? 0 : fileWeight(f)) + w
  }
  const add = (p: ChunkInProgress, f: FileDiff, pc: Piece): void => {
    p.weight += extra(p, f, pc.weight)
    const last = p.segments[p.segments.length - 1]
    if (last && last.f === f) last.lines.push(...pc.lines)
    else p.segments.push({ f, lines: [...pc.lines] })
  }
  const fits = (p: ChunkInProgress, f: FileDiff, w: number): boolean => p.weight + extra(p, f, w) <= T + EPS

  for (const f of file) {
    const hunk = f.hunks.map((h) => ({ h, lines: hunkLines(h), weight: sum(hunkLines(h).map(weight)) }))
    const whole: Piece = { lines: hunk.flatMap((x) => x.lines), weight: sum(hunk.map((x) => x.weight)) }
    // files pile up whole as long as they fit
    if (cur !== null && fits(cur, f, whole.weight)) {
      add(cur, f, whole)
      continue
    }
    if (skeleton + fileWeight(f) + whole.weight <= T + EPS) {
      cur = fresh()
      add(cur, f, whole)
      continue
    }
    // a file larger than T is split by hunk, and a larger hunk by line; every new
    // chunk repeats the file header
    const available = T - skeleton - fileWeight(f)
    for (const x of hunk) {
      const pieces = x.weight <= available + EPS ? [{ lines: x.lines, weight: x.weight }] : splitHunk(x.h, available, weight)
      for (const pc of pieces) {
        if (cur === null || (cur.segments.length > 0 && !fits(cur, f, pc.weight))) cur = fresh()
        add(cur, f, pc)
      }
    }
    // a file without hunks (mode change or rename only) that does not fit on its
    // own: unlikely, but the header must get through anyway
    if (hunk.length === 0) {
      cur = fresh()
      add(cur, f, whole)
    }
  }
  return chunks
}

function renderChunk(p: ChunkInProgress): { file: FileDiff[]; diff: string } {
  const file: FileDiff[] = []
  const lines: string[] = []
  for (const s of p.segments) {
    if (!file.includes(s.f)) file.push(s.f)
    lines.push(...headerLines(s.f), ...s.lines)
  }
  return { file, diff: lines.join('\n') }
}

// ─── Global state ─────────────────────────────────────────────────────────────

interface GlobalState { text: string; shown: FileDiff[] }

// Shortens s to the longest prefix for which fits(s') holds; "" if there is none.
function longestThat(s: string, fits: (x: string) => boolean): string {
  if (fits(s)) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2)
    if (fits(truncate(s, m))) lo = m
    else hi = m - 1
  }
  return lo === 0 ? '' : truncate(s, lo)
}

// Title, description, file list, [files_not_shown] and a [diff] with whole files in
// priority order, all within T. The list comes before the diff (the global questions
// look at [files]); if it does not fit, it is shortened and states how many files are
// missing. A file that does not fit whole is skipped, and the next one is tried.
function planGlobal(
  meta: { title: string; description: string | null }, sorted: FileDiff[], toSend: Set<FileDiff>,
  maxDescription: number, T: number, cpt: number, weight: (r: string) => number,
): GlobalState {
  let title = oneLineTitle(meta.title)
  let description = meta.description === null ? null : truncate(meta.description, maxDescription)
  // The skeleton already has the "(N more files not listed)" line: if not even one
  // file fits in the list, that line must still fit.
  const others = sorted.length > 0 ? PLACEHOLDER_COUNT : 0
  const emptyWeight = (t: string, d: string | null): number =>
    tokenWeight(globalState({ title: t, description: d, file: [], notShown: PLACEHOLDER_COUNT, diff: '', notListed: others }), cpt)
  if (emptyWeight(title, description) > T + EPS && description !== null) {
    const d = longestThat(description, (x) => emptyWeight(title, x) <= T + EPS)
    description = d === '' ? null : d
  }
  if (emptyWeight(title, description) > T + EPS) title = longestThat(title, (x) => emptyWeight(x, description) <= T + EPS)

  let used = emptyWeight(title, description)
  const reserve = weight(`(${PLACEHOLDER_COUNT} more files not listed)`)
  const listed: FileDiff[] = []
  for (let k = 0; k < sorted.length; k++) {
    // with the last file the "more files" line disappears and frees its space
    const w = weight(fileLine(sorted[k])) - (k === sorted.length - 1 ? reserve : 0)
    if (used + w > T + EPS) break
    listed.push(sorted[k])
    used += w
  }
  const notListed = sorted.length - listed.length

  const shown: FileDiff[] = []
  for (const f of sorted) {
    if (!toSend.has(f)) continue
    const w = sum(fileLines(f).map(weight))
    if (used + w > T + EPS) continue
    shown.push(f)
    used += w
  }
  const text = globalState({
    title, description, file: listed, notShown: sorted.length - shown.length,
    diff: shown.flatMap(fileLines).join('\n'), notListed,
  })
  return { text, shown }
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

// o.maxChunks is limits[origin].max_chunks; o.tokensPerState is the budget T, usually
// state.tokens_per_state, lower when replanning after an overflow.
// Chunk.index starts from 1: it is the number the model reads in "[part] i of n".
export function planChunks(
  d: ParsedDiff, meta: { title: string; description: string | null }, checks: Checks, p: Policy,
  o: { maxChunks: number; tokensPerState: number }, hits: Hit[],
): Plan {
  const cpt = p.state.chars_per_token
  const T = o.tokensPerState
  const weight = weigher(cpt)

  // Ignored: binaries and state.ignore (regexes anchored to the root or to the name).
  // They never reach the model; outside ignore_without_escalation (lockfiles, .map,
  // images) they are also unreviewable, that is partial coverage: minified code,
  // dist/ and binaries are classic supply-chain vectors.
  const sorted = prioritize(d.files, checks, hits)
  const ignored: string[] = []
  const unreviewable: string[] = []
  const toSend = new Set<FileDiff>()
  for (const f of sorted) {
    if (f.status === 'B' || matchesAny(p.state.ignore, f.path)) {
      ignored.push(f.path)
      if (!matchesAny(p.state.ignore_without_escalation, f.path)) unreviewable.push(f.path)
    } else toSend.add(f)
  }
  const sendable = sorted.filter((f) => toSend.has(f))
  const global = planGlobal(meta, sorted, toSend, p.state.max_description_chars, T, cpt, weight)

  // Without chunk questions (the user's original checks.json) only the global
  // request goes out: a file that does not fit in it is seen by no question, so it is
  // omitted and coverage is partial.
  const hasChunk = checks.order.some((id) => checks.defs[id].scope === 'chunk' && checks.defs[id].source === 'model')
  if (!hasChunk) {
    const shown = new Set(global.shown)
    return {
      shape: 'single', chunks: [], global: global.text,
      examined: sendable.filter((f) => shown.has(f)).map((f) => f.path), ignored, unreviewable,
      omitted: sendable.filter((f) => !shown.has(f)).map((f) => ({ path: f.path, reason: REASON_OVER_GLOBAL })),
    }
  }

  // Chunks are created in priority order: beyond maxChunks the last ones are lost,
  // and a file covered only in part counts as omitted.
  const all = pack(sendable, T, weight)
  const kept = all.slice(0, Math.max(0, o.maxChunks))
  const lost = new Set<FileDiff>(all.slice(kept.length).flatMap((x) => x.segments.map((s) => s.f)))
  const chunks: Chunk[] = kept.map((x, k) => {
    const r = renderChunk(x)
    const text = chunkState({ file: r.file, chunk: [k + 1, kept.length], diff: r.diff })
    return { index: k + 1, files: r.file.map((f) => f.path), text, tokens: estimateTokens(text, cpt) }
  })
  return {
    shape: all.length <= 1 ? 'single' : 'chunks', chunks, global: global.text,
    examined: sendable.filter((f) => !lost.has(f)).map((f) => f.path), ignored, unreviewable,
    omitted: sendable.filter((f) => lost.has(f)).map((f) => ({ path: f.path, reason: REASON_OVER_CHUNKS })),
  }
}
