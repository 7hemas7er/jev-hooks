// A minimal "lexical" reading of a TypeScript source, for the structure tests. It is
// not a parser: it is enough to blank out comments, strings, templates and regexes, so
// a forbidden word inside an error message ("invalid URL") or a comment ("no URL
// here") does not fail the purity test, while the same word in code (even inside the
// `${…}` of a template) does.

export interface Import {
  specifier: string
  typeOnly: boolean           // import type … / export type …
  line: number
}

const WORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
])

// After a value (name, number, closing bracket, string) a "/" is a division; after an
// operator or at the start it opens a regex.
function regexAllowed(last: string): boolean {
  if (last === '') return true
  if (/^[A-Za-z0-9_$]/.test(last)) return WORDS_BEFORE_REGEX.has(last)
  return !(last === ')' || last === ']' || last === '}' || last === '"' || last === '`')
}

// Returns the source with comments and the contents of strings, templates and regexes
// replaced by spaces. Length and line breaks stay identical: positions and line
// numbers hold for the original text too.
export function stripSource(src: string): string {
  const out = src.split('')
  const n = src.length
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  let braces = 0
  const stack: number[] = []   // brace depth when each ${ was opened
  let last = ''

  const template = (): void => {
    const start = i
    while (i < n) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { blank(start, i); i++; last = '`'; return }
      if (c === '$' && src[i + 1] === '{') {
        blank(start, i)
        i += 2
        stack.push(braces)
        braces++
        last = '{'
        return
      }
      i++
    }
    blank(start, n)
  }

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const f = src.indexOf('\n', i)
      const e = f < 0 ? n : f
      blank(i, e)
      i = e
      continue
    }
    if (c === '/' && d === '*') {
      const f = src.indexOf('*/', i + 2)
      const e = f < 0 ? n : f + 2
      blank(i, e)
      i = e
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      last = '"'
      continue
    }
    if (c === '`') { i++; template(); continue }
    if (c === '{') { braces++; last = '{'; i++; continue }
    if (c === '}') {
      braces--
      i++
      if (stack.length > 0 && stack[stack.length - 1] === braces) {
        stack.pop()
        template()
        continue
      }
      last = '}'
      continue
    }
    if (c === '/') {
      if (regexAllowed(last)) {
        let j = i + 1
        let cls = false
        while (j < n && src[j] !== '\n') {
          const x = src[j]
          if (x === '\\') { j += 2; continue }
          if (x === '[') cls = true
          else if (x === ']') cls = false
          else if (x === '/' && !cls) break
          j++
        }
        blank(i + 1, j)
        j++
        while (j < n && /[a-z]/i.test(src[j])) j++
        i = j
        last = '"'
        continue
      }
      last = '/'
      i++
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++
      last = src.slice(i, j)
      i = j
      continue
    }
    last = c
    i++
  }
  return out.join('')
}

function line(text: string, pos: number): number {
  let r = 1
  for (let k = 0; k < pos; k++) if (text.charCodeAt(k) === 10) r++
  return r
}

// Specifiers of the imports and of the export … from, read from the original text at
// the positions of the quotes left in the stripped source.
export function importsOf(src: string): Import[] {
  const code = stripSource(src)
  const found: Import[] = []
  const read = (q: number): string => {
    const closed = code.indexOf(code[q], q + 1)
    return src.slice(q + 1, closed)
  }
  // without semicolons a declaration can precede the import: the body must not
  // run past another import or export
  for (const m of code.matchAll(/\b(import|export)\b((?:(?!\b(?:import|export)\b)[^;'"`])*?)\bfrom\s*(['"])/g)) {
    const q = (m.index ?? 0) + m[0].length - 1
    found.push({ specifier: read(q), typeOnly: /^\s*type\b/.test(m[2]), line: line(src, m.index ?? 0) })
  }
  for (const m of code.matchAll(/\bimport\s*(['"])/g)) {
    const q = (m.index ?? 0) + m[0].length - 1
    found.push({ specifier: read(q), typeOnly: false, line: line(src, m.index ?? 0) })
  }
  return found
}

// Names missing from the node:vm context of Claude Code's module loader, plus Node's
// globals (AGENTS.md, rule 4). A property access (`$.http.fetch`, `x.process`,
// `a?.process`) does not count: only the free name counts. A single dot in front is an
// access; three dots are a spread (`{ ...process.env }`) and the name after it is free.
const FREE = '(?<![\\w$])(?<!(?:^|[^.])\\.)'
export const FORBIDDEN: readonly { name: string; re: RegExp }[] = [
  ...[
    'process', 'Buffer', 'require', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'setImmediate', 'Date', 'crypto', 'console', 'globalThis', 'URL', 'URLSearchParams', 'TextEncoder',
    'TextDecoder', 'structuredClone', 'atob', 'btoa', 'AbortController', 'AbortSignal', 'performance',
    'queueMicrotask', 'WeakRef', 'FinalizationRegistry', 'Atomics', 'SharedArrayBuffer', 'WebAssembly', 'eval',
  ].map((name) => ({ name, re: new RegExp(`${FREE}${name}(?![\\w$])`, 'g') })),
  { name: 'Function(', re: new RegExp(`${FREE}Function\\s*\\(`, 'g') },
  { name: 'dynamic import()', re: new RegExp(`${FREE}import\\s*\\(`, 'g') },
]

export interface Violation { name: string; line: number }

export function forbiddenIn(src: string): Violation[] {
  const code = stripSource(src)
  const found: Violation[] = []
  for (const { name, re } of FORBIDDEN) {
    for (const m of code.matchAll(re)) found.push({ name, line: line(src, m.index ?? 0) })
  }
  return found.sort((a, b) => a.line - b.line)
}
