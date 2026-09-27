// Shape of the "text@1" state: a string with fixed sections, not an object.
// rizzo-flow puts a string state as it is inside its evidence tag, while an object
// would become indented JSON with the whole diff on one line; a string reaches Jev
// and rizzo unchanged. For the same reason the closing evidence tag must never
// appear in the text: if rizzo finds it, it falls back to JSON.
//
// Nothing in this text can imitate a section header: the title and description lines
// are indented by two spaces, the diff lines always start with " ", "+", "-", "@",
// "\" or a git header, and the paths of the file list go through safePath (here, and
// re-exported by diff.ts).
import type { FileDiff } from './types.ts'

export const STATE_FORMAT = 'text@1'

// The title is a single line: the author of a PR writes it, and a newline
// would only serve to break the indentation.
export const MAX_TITLE = 200

const RE_EVIDENCE = /<\/?\s*evidence\s*>/gi
const REPLACEMENT = '</evidence-in-diff>'

// Unicode line separators besides \n: for a model, U+2028 or a lone \r also starts a
// new line, and that line would not be indented.
const RE_NEWLINE = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

export function neutralize(text: string): { text: string; hits: number } {
  let hits = 0
  const out = text.replace(RE_EVIDENCE, () => {
    hits++
    return REPLACEMENT
  })
  return { text: out, hits }
}

// Neutralization goes line by line: a tag split across two lines is not a tag, and
// replacing it would merge the two lines and change the diff. This way the state stays
// the exact concatenation of its pieces, and chunks.ts knows its size before
// composing it.
export function neutralizeLines(text: string): string {
  if (!/evidence/i.test(text)) return text
  return text.split('\n').map((r) => neutralize(r).text).join('\n')
}

// Conservative token estimate: ceil(characters / chars_per_token), where every
// non-ASCII UTF-16 unit counts as a whole token. Diffs tokenize at about 2.9
// characters per token (measured on the Spark), but accents, ideograms and emoji cost
// one token or more each: counting them as ordinary characters would underestimate
// exactly the states the model knows least.
export function tokenWeight(text: string, charsPerToken: number): number {
  let ascii = 0
  let others = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) ascii++
    else others++
  }
  return ascii / charsPerToken + others
}

export function estimateTokens(text: string, charsPerToken: number): number {
  // the margin absorbs the floating point error of the division (5800 / 2.9);
  // max avoids -0 on the empty text
  return Math.max(0, Math.ceil(tokenWeight(text, charsPerToken) - 1e-9))
}

// Shortens to max UTF-16 units without splitting a surrogate pair; "…" marks the cut.
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 0) return ''
  let k = max - 1
  const c = s.charCodeAt(k - 1)
  if (k > 0 && c >= 0xd800 && c <= 0xdbff) k--
  return s.slice(0, k) + '…'
}

export function oneLineTitle(title: string): string {
  return truncate(title.split(RE_NEWLINE).map((r) => r.trim()).filter((r) => r !== '').join(' '), MAX_TITLE)
}

// Lines of a free text (title, description) indented by two spaces, or "(none)".
function indented(text: string | null): string[] {
  const lines = text === null ? [] : text.split(RE_NEWLINE).map((r) => r.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  while (lines.length > 0 && lines[0] === '') lines.shift()
  if (lines.length === 0) return ['  (none)']
  return lines.map((r) => `  ${neutralize(r).text}`)
}

// A path that goes out to Claude, GitHub or the state: only [\w./@+-], anything else
// becomes "?". This way a file name carries no markup, workflow command, newline or
// section header. Beyond 120 characters the tail, which holds the file name, stays
// behind a "…" (the only character outside the set, and an inert one).
const MAX_PATH = 120

export function safePath(p: string): string {
  let out = ''
  for (const c of p) out += /^[\w./@+-]$/.test(c) ? c : '?'
  return out.length > MAX_PATH ? '…' + out.slice(out.length - (MAX_PATH - 1)) : out
}

// A line of the [files] list: status, filtered path and counts.
export function fileLine(f: FileDiff): string {
  const p = safePath(f.path)
  if (f.status === 'B') return `B ${p} (binary)`
  if (f.status === 'R' && f.oldPath !== undefined) return `R ${safePath(f.oldPath)} -> ${p} +${f.added} -${f.removed}`
  return `${f.status} ${p} +${f.added} -${f.removed}`
}

function diffSection(diff: string): string {
  return diff === '' ? '(none)' : neutralizeLines(diff)
}

function fileList(file: FileDiff[], notListed: number): string[] {
  const lines = file.map(fileLine)
  if (notListed > 0) lines.push(`(${notListed} more files not listed)`)
  return lines.length === 0 ? ['(none)'] : lines
}

// State for the global questions. notListed (optional) counts the files dropped from
// the list so that the state stays within the budget: chunks.ts uses it on diffs with
// hundreds of files.
export function globalState(m: {
  title: string; description: string | null; file: FileDiff[]; notShown: number; diff: string; notListed?: number
}): string {
  return [
    '[title]', ...indented(oneLineTitle(m.title)),
    '[description]', ...indented(m.description),
    '[files]', ...fileList(m.file, m.notListed ?? 0),
    '[files_not_shown]', String(m.notShown),
    '[diff]', diffSection(m.diff),
  ].join('\n')
}

// State of a chunk, for the chunk questions: never the title nor the description,
// which in a PR from a fork are hostile and must not reach the critical local
// questions.
export function chunkState(m: { file: FileDiff[]; chunk: [number, number]; diff: string }): string {
  return [
    '[files]', ...fileList(m.file, 0),
    '[part]', `${m.chunk[0]} of ${m.chunk[1]}`,
    '[diff]', diffSection(m.diff),
  ].join('\n')
}
