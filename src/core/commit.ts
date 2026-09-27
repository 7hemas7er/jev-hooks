// Recognizes `git commit` in a Bash command, without running it: in which
// directory it happens, with which files, with which message. The commit hook
// receives the text Claude wrote for the Bash tool and must review exactly what the
// commit will contain.
//
// This takes a shell reader, not a regex. The message almost always arrives as a
// heredoc inside a substitution, `-m "$(cat <<'EOF' … EOF\n)"`, and its text can
// contain "git commit", ")" or "&&" without them being commands; `cd x && git commit`,
// `git -C x commit` and `git add … && git commit` change directory and content.
//
// The hook is a safety net, not a barrier: whatever is not understood with
// certainty gives 'uncertain', which the hook logs without reviewing. A program taken
// from a variable, a script called "commit", an unknown option, a `git rm` before the
// commit: in all these cases the diff that would be computed is not the commit's, and
// a verdict on a different diff would be worse than none.
//
// The command arrives already unmasked (unmask() with guardrail's mask map) and, if
// guardrail has already rewritten it for its runner (updatedInput, `bash
// …/run-python.sh …/mask.py run <<'__GUARDRAIL_MASK__'`), it is taken out of the
// wrapper first.
//
// Pure (rule 4).
import type { CommitIntent, AddStep } from './types.ts'

export type { CommitIntent, AddStep } from './types.ts'

// ─── Shell lexer ──────────────────────────────────────────────────────────────

interface Word {
  t: 'word'
  v: string                               // value after quote removal
  uncertain: boolean                        // contains unresolved expansions: $VAR, ${…}, generic $(…), `…`
  quoted: boolean                        // quotes or backslashes: a heredoc's "EOF" does not expand
  assignment: boolean                   // NAME=… with the name outside the quotes
  substitutions: Token[][]                 // the commands inside $(…) and `…`, examined separately
}

interface Operator { t: 'op'; v: string }

interface Redirection {
  t: 'redir'
  v: string                               // <, >, >>, <<, <<-, <<<, >&, &>, …
  target: Word | null
  body?: string                          // heredoc
  bodyUncertain?: boolean                  // heredoc with an unquoted delimiter that contains $ or `
}

type Token = Word | Operator | Redirection

interface Lexed { tokens: Token[]; end: number; error?: string }

const METACHARS = ' \t\n;&|()<>'
const MAX_DEPTH = 20

// The value of a substitution when it is just `cat <<'EOF' … EOF`: the body, without
// the trailing newlines (as the shell does). Otherwise the value is unknown.
function substitutionValue(tokens: Token[]): { v: string; uncertain: boolean } | null {
  const useful = tokens.filter((t) => !(t.t === 'op' && t.v === '\n'))
  if (useful.length !== 2) return null
  const cat = useful.find((t): t is Word => t.t === 'word')
  const hd = useful.find((t): t is Redirection => t.t === 'redir')
  if (!cat || !hd || cat.v !== 'cat' || cat.uncertain || (hd.v !== '<<' && hd.v !== '<<-') || hd.body === undefined) return null
  return { v: hd.body.replace(/\n+$/, ''), uncertain: hd.bodyUncertain === true }
}

// Escapes of $'…' (ANSI-C quoting): the ones needed to write a message.
const ANSI_C_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }

function lex(s: string, i0: number, closed: boolean, substitutionDepth: number): Lexed {
  const tokens: Token[] = []
  const heredoc: { r: Redirection; delim: string; stripTabs: boolean; quoted: boolean }[] = []
  let i = i0
  let parens = 0
  let error: string | undefined

  const fail = (m: string): void => {
    error ??= m
  }

  // Heredoc bodies start on the line after the operator's, in the order the operators
  // appear. A delimiter that is never found closes the body at the end of the text, as
  // bash does (with a warning).
  const readBodies = (): void => {
    for (const h of heredoc) {
      const lines: string[] = []
      while (i < s.length) {
        const f = s.indexOf('\n', i)
        const line = s.slice(i, f < 0 ? s.length : f)
        i = f < 0 ? s.length : f + 1
        const comparison = h.stripTabs ? line.replace(/^\t+/, '') : line
        if (comparison === h.delim) break
        lines.push(comparison)
      }
      h.r.body = lines.length > 0 ? `${lines.join('\n')}\n` : ''
      if (!h.quoted && /[$`]/.test(h.r.body)) h.r.bodyUncertain = true
    }
    heredoc.length = 0
  }

  // A $(…) substitution from s[from] (after "$("): the inner commands are read with the
  // same lexer, heredocs included, up to the parenthesis that closes it.
  const substitution = (from: number): { tokens: Token[]; end: number } => {
    if (substitutionDepth >= MAX_DEPTH) {
      fail('substitutions nested too deeply')
      return { tokens: [], end: s.length }
    }
    const sub = lex(s, from, true, substitutionDepth + 1)
    if (sub.error) fail(sub.error)
    return { tokens: sub.tokens, end: sub.end }
  }

  // `…`: the content, with the backslashes before $, ` and \ removed, is read as a
  // separate command.
  const backtick = (): Token[] => {
    let j = i + 1
    let inside = ''
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && j + 1 < s.length && '$`\\'.includes(s[j + 1])) {
        inside += s[j + 1]
        j += 2
        continue
      }
      inside += s[j]
      j++
    }
    if (j >= s.length) fail('unclosed backtick')
    i = Math.min(j + 1, s.length)
    const sub = lex(inside, 0, false, substitutionDepth + 1)
    if (sub.error) fail(sub.error)
    return sub.tokens
  }

  // ${…} and $((…)): skip up to the matching close.
  const skipTo = (open: string, close: string, from: number): number => {
    let level = 0
    for (let j = from; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue }
      if (s.startsWith(open, j)) { level++; j += open.length - 1; continue }
      if (s.startsWith(close, j)) {
        level--
        if (level === 0) return j + close.length
        j += close.length - 1
      }
    }
    fail(`unclosed ${open}`)
    return s.length
  }

  interface Piece { v: string; uncertain: boolean; substitution?: Token[] }

  // A "$" at s[i], outside or inside double quotes.
  const dollar = (inDoubleQuotes: boolean): Piece => {
    const n = s[i + 1]
    if (n === '(' && s[i + 2] === '(') {
      i = skipTo('((', '))', i + 1)
      return { v: '', uncertain: true }
    }
    if (n === '(') {
      const sub = substitution(i + 2)
      i = sub.end
      const val = substitutionValue(sub.tokens)
      return val ? { v: val.v, uncertain: val.uncertain, substitution: sub.tokens } : { v: '', uncertain: true, substitution: sub.tokens }
    }
    if (n === '{') {
      i = skipTo('{', '}', i + 1)
      return { v: '', uncertain: true }
    }
    if (!inDoubleQuotes && n === "'") {
      let j = i + 2
      let v = ''
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) {
          const e = s[j + 1]
          v += Object.hasOwn(ANSI_C_ESCAPES, e) ? ANSI_C_ESCAPES[e] : `\\${e}`
          j += 2
          continue
        }
        v += s[j]
        j++
      }
      if (j >= s.length) fail('unclosed single quote')
      i = Math.min(j + 1, s.length)
      return { v, uncertain: false }
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = i + 1
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      i = j
      return { v: '', uncertain: true }
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
      i += 2
      return { v: '', uncertain: true }
    }
    i++
    return { v: '$', uncertain: false }
  }

  const doubleQuoted = (): Piece & { substitutions: Token[][] } => {
    i++
    let v = ''
    let uncertain = false
    const substitutions: Token[][] = []
    while (i < s.length && s[i] !== '"') {
      const c = s[i]
      if (c === '\\') {
        const n = s[i + 1]
        if (n === '\n') { i += 2; continue }
        if (n !== undefined && '$`"\\'.includes(n)) { v += n; i += 2; continue }
        v += '\\'
        i++
        continue
      }
      if (c === '$') {
        const p = dollar(true)
        v += p.v
        uncertain ||= p.uncertain
        if (p.substitution) substitutions.push(p.substitution)
        continue
      }
      if (c === '`') {
        substitutions.push(backtick())
        uncertain = true
        continue
      }
      v += c
      i++
    }
    if (i >= s.length) fail('unclosed double quote')
    i = Math.min(i + 1, s.length)
    return { v, uncertain, substitutions }
  }

  const readWord = (): Word => {
    let v = ''
    let uncertain = false
    let quoted = false
    let bare = true
    let prefix = ''
    const substitutions: Token[][] = []
    while (i < s.length) {
      const c = s[i]
      if (METACHARS.includes(c)) {
        // <(…) and >(…): process substitution, a file name that is not known
        if ((c === '<' || c === '>') && s[i + 1] === '(' && v === '' && bare) {
          const sub = substitution(i + 2)
          i = sub.end
          substitutions.push(sub.tokens)
          uncertain = true
          bare = false
          continue
        }
        break
      }
      if (c === '\\') {
        if (s[i + 1] === '\n') { i += 2; continue }
        if (i + 1 < s.length) v += s[i + 1]
        i += 2
        quoted = true
        bare = false
        continue
      }
      if (c === "'") {
        const f = s.indexOf("'", i + 1)
        if (f < 0) {
          fail('unclosed single quote')
          v += s.slice(i + 1)
          i = s.length
        } else {
          v += s.slice(i + 1, f)
          i = f + 1
        }
        quoted = true
        bare = false
        continue
      }
      if (c === '"') {
        const d = doubleQuoted()
        v += d.v
        uncertain ||= d.uncertain
        substitutions.push(...d.substitutions)
        quoted = true
        bare = false
        continue
      }
      if (c === '$') {
        if (s[i + 1] === '"') { i++; continue }         // $"…": localized string, like "…"
        const p = dollar(false)
        v += p.v
        uncertain ||= p.uncertain
        if (p.substitution) substitutions.push(p.substitution)
        if (p.uncertain || p.substitution) bare = false
        else quoted = true
        continue
      }
      if (c === '`') {
        substitutions.push(backtick())
        uncertain = true
        bare = false
        continue
      }
      v += c
      if (bare) prefix += c
      i++
    }
    return { t: 'word', v, uncertain, quoted, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix), substitutions }
  }

  const readRedirection = (): void => {
    const three = s.slice(i, i + 3)
    const two = s.slice(i, i + 2)
    let op: string
    if (three === '<<<' || three === '<<-' || three === '&>>') op = three
    else if (['<<', '<>', '<&', '>>', '>|', '>&', '&>'].includes(two)) op = two
    else op = s[i]
    i += op.length
    while (s[i] === ' ' || s[i] === '\t') i++
    const target = i < s.length && !METACHARS.includes(s[i]) ? readWord() : null
    const r: Redirection = { t: 'redir', v: op, target }
    if (op === '<<' || op === '<<-') {
      if (!target) fail('heredoc without a delimiter')
      else heredoc.push({ r, delim: target.v, stripTabs: op === '<<-', quoted: target.quoted })
    }
    tokens.push(r)
  }

  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue }
    if (c === '\n') {
      tokens.push({ t: 'op', v: '\n' })
      i++
      if (heredoc.length > 0) readBodies()
      continue
    }
    if (c === '#') {
      const f = s.indexOf('\n', i)
      i = f < 0 ? s.length : f
      continue
    }
    if (c === ')') {
      i++
      if (closed && parens === 0) {
        if (heredoc.length > 0) readBodies()
        return error !== undefined ? { tokens, end: i, error } : { tokens, end: i }
      }
      parens--
      tokens.push({ t: 'op', v: ')' })
      continue
    }
    if (c === '(') {
      parens++
      tokens.push({ t: 'op', v: '(' })
      i++
      continue
    }
    if (c === ';') {
      const op = s[i + 1] === ';' ? (s[i + 2] === '&' ? ';;&' : ';;') : s[i + 1] === '&' ? ';&' : ';'
      tokens.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if (c === '&') {
      if (s[i + 1] === '>') { readRedirection(); continue }
      const op = s[i + 1] === '&' ? '&&' : '&'
      tokens.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if (c === '|') {
      const op = s[i + 1] === '|' ? '||' : s[i + 1] === '&' ? '|&' : '|'
      tokens.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if ((c === '<' || c === '>') && s[i + 1] !== '(') { readRedirection(); continue }
    const p = readWord()
    // "2>&1": a number attached to < or > is the redirection's descriptor
    if (/^\d+$/.test(p.v) && !p.quoted && (s[i] === '<' || s[i] === '>')) { readRedirection(); continue }
    tokens.push(p)
  }
  if (closed) fail('unclosed $(…) substitution')
  if (heredoc.length > 0) readBodies()
  return error !== undefined ? { tokens, end: i, error } : { tokens, end: i }
}

// ─── Simple commands ──────────────────────────────────────────────────────────

interface SimpleCommand { words: Word[]; redir: Redirection[] }
type CommandEntry = { kind: 'command'; c: SimpleCommand } | { kind: 'open' } | { kind: 'close' }

function commands(tokens: Token[]): CommandEntry[] {
  const out: CommandEntry[] = []
  let cur: SimpleCommand = { words: [], redir: [] }
  const close = (): void => {
    if (cur.words.length > 0 || cur.redir.length > 0) out.push({ kind: 'command', c: cur })
    cur = { words: [], redir: [] }
  }
  for (const t of tokens) {
    if (t.t === 'word') cur.words.push(t)
    else if (t.t === 'redir') cur.redir.push(t)
    else {
      close()
      if (t.v === '(') out.push({ kind: 'open' })
      else if (t.v === ')') out.push({ kind: 'close' })
    }
  }
  close()
  return out
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

export interface CommandAnalysis { outcome: CommitIntent[] | 'none' | 'uncertain'; reason?: string }

interface ParseState {
  dir?: string                       // relative to the hook's cwd, or absolute or with ~
  dirUncertain: boolean
  steps: AddStep[]
  addsDir?: string
  addsUncertain: boolean
  indexChanged: boolean
}

interface ParseOutput { intents: CommitIntent[]; uncertain?: string }

// "commit" as a word of its own (not commit-tree, not --no-commit).
const RE_COMMIT = /(^|[^A-Za-z0-9_-])commit($|[^A-Za-z0-9_-])/
const RE_GIT = /(^|[^A-Za-z0-9_-])git($|[^A-Za-z0-9_-])/

// Variables that move the repo, the tree or the index: the diff computed by the hook
// would no longer be the commit's.
const RE_GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG\w*|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/

const RESERVED_WORDS = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.'])

// git subcommands that change the index or the branch: after them, in the same
// command, the commit's index is not the one the hook sees now.
const INDEX_CHANGING_SUBCOMMANDS = new Set([
  'rm', 'mv', 'reset', 'restore', 'stash', 'apply', 'am', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert',
  'update-index', 'read-tree', 'checkout', 'switch',
])

function baseName(p: string): string {
  const k = p.lastIndexOf('/')
  return k < 0 ? p : p.slice(k + 1)
}

// A directory after `cd` or `git -C`: an absolute one or one with ~ replaces, a
// relative one is appended. Normalization (.., ~) is left to whoever knows the disk.
function joinDir(base: string | undefined, dir: string): string {
  if (base === undefined || dir.startsWith('/') || dir === '~' || dir.startsWith('~/')) return dir
  return `${base.replace(/\/+$/, '')}/${dir}`
}

function mentionsCommit(words: readonly Word[]): boolean {
  return words.some((p) => RE_COMMIT.test(p.v))
}

function markUncertain(u: ParseOutput, reason: string): void {
  u.uncertain ??= reason
}

type CommitParse = { kind: 'intent'; intent: Omit<CommitIntent, 'dir' | 'adds'>; include: string[] } | 'none' | { kind: 'uncertain'; reason: string }

// git commit options (2.4x). An unknown option gives uncertain: it might take a
// value, and the word after it would become a path that is not one.
const COMMIT_FLAGS_WITHOUT_VALUE = new Set([
  '--all', '--amend', '--allow-empty', '--allow-empty-message', '--no-verify', '--verify', '--quiet', '--verbose',
  '--signoff', '--no-signoff', '--edit', '--no-edit', '--reset-author', '--only', '--include', '--status', '--no-status',
  '--no-post-rewrite', '--no-gpg-sign', '--gpg-sign', '--untracked-files', '--pathspec-file-nul', '--branch',
  '--ahead-behind', '--no-ahead-behind', '--renormalize',
])
const COMMIT_FLAGS_WITH_VALUE = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup',
  '--template', '--trailer',
])
const COMMIT_DRY_RUN_FLAGS = new Set(['--dry-run', '--short', '--porcelain', '--long', '--null'])

function parseCommit(args: readonly Word[], redir: readonly Redirection[]): CommitParse {
  let all = false
  let amend = false
  let allowEmpty = false
  let include = false
  let dryRun = false
  const paths: string[] = []
  const commitMessages: string[] = []
  let messageFile: string | undefined
  let afterDash = false

  const valueFrom = (k: number): Word | undefined => args[k]
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    const v = a.v
    if (afterDash || !v.startsWith('-') || v === '-') {
      if (a.uncertain) return { kind: 'uncertain', reason: 'commit path from a variable or a substitution' }
      paths.push(v)
      continue
    }
    if (a.uncertain) return { kind: 'uncertain', reason: 'commit option from a variable' }
    if (v === '--') { afterDash = true; continue }
    if (v.startsWith('--')) {
      const equal = v.indexOf('=')
      const name = equal < 0 ? v : v.slice(0, equal)
      let value: Word | undefined
      if (COMMIT_FLAGS_WITH_VALUE.has(name)) {
        if (equal >= 0) value = { ...a, v: v.slice(equal + 1) }
        else {
          value = valueFrom(++k)
          if (!value) return { kind: 'uncertain', reason: `missing value for ${name}` }
        }
      } else if (COMMIT_DRY_RUN_FLAGS.has(name)) {
        dryRun = true
        continue
      } else if (!COMMIT_FLAGS_WITHOUT_VALUE.has(name) || (equal >= 0 && name !== '--gpg-sign' && name !== '--untracked-files')) {
        if (name === '--interactive' || name === '--patch') return { kind: 'uncertain', reason: 'interactive commit' }
        if (name === '--pathspec-from-file') return { kind: 'uncertain', reason: 'commit paths from a file' }
        return { kind: 'uncertain', reason: `unrecognized git commit option: ${name.slice(0, 40)}` }
      }
      switch (name) {
        case '--all': all = true; break
        case '--amend': amend = true; break
        case '--allow-empty': allowEmpty = true; break
        case '--include': include = true; break
        case '--message': commitMessages.push((value as Word).v); break
        case '--file': messageFile = (value as Word).v; break
        default: break
      }
      continue
    }
    // group of short options: -am "…", -qsm "…"
    for (let j = 1; j < v.length; j++) {
      const o = v[j]
      if ('mFCct'.includes(o)) {
        let value: string
        if (j + 1 < v.length) value = v.slice(j + 1)
        else {
          const p = valueFrom(++k)
          if (!p) return { kind: 'uncertain', reason: `missing value for -${o}` }
          value = p.v
        }
        if (o === 'm') commitMessages.push(value)
        else if (o === 'F') messageFile = value
        break
      }
      if (o === 'S' || o === 'u') break                 // optional value, attached only
      if (o === 'a') all = true
      else if (o === 'i') include = true
      else if (o === 'z') dryRun = true
      else if (o === 'p') return { kind: 'uncertain', reason: 'interactive commit' }
      else if (!'enoqsv'.includes(o)) return { kind: 'uncertain', reason: `unrecognized git commit option: -${o}` }
    }
  }
  if (dryRun) return 'none'

  const intent: Omit<CommitIntent, 'dir' | 'adds'> = { all, amend, allowEmpty, paths: include ? [] : paths }
  if (commitMessages.length > 0) intent.message = commitMessages.join('\n\n')
  else if (messageFile === '-') {
    // -F -: the message comes from the command's standard input
    const entry = [...redir].reverse().find((r) => r.v === '<<' || r.v === '<<-' || r.v === '<<<' || r.v === '<')
    if (entry?.body !== undefined) intent.message = entry.body
    else if (entry?.v === '<<<' && entry.target) intent.message = entry.target.v
    else if (entry?.v === '<' && entry.target && !entry.target.uncertain) intent.messageFile = entry.target.v
  } else if (messageFile !== undefined) intent.messageFile = messageFile
  return { kind: 'intent', intent, include: include ? paths : [] }
}

type AddParse = { kind: 'step'; step: AddStep } | 'none' | { kind: 'uncertain'; reason: string }

const ADD_FLAGS_WITHOUT_VALUE = new Set([
  '--all', '--no-ignore-removal', '--update', '--force', '--verbose', '--ignore-errors', '--ignore-missing',
  '--no-warn-embedded-repo', '--sparse', '--renormalize', '--no-all', '--ignore-removal', '--refresh',
])

function parseAdd(args: readonly Word[]): AddParse {
  const step: AddStep = { paths: [], all: false, update: false, force: false }
  let afterDash = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    const v = a.v
    if (afterDash || !v.startsWith('-') || v === '-') {
      if (a.uncertain) return { kind: 'uncertain', reason: 'git add path from a variable or a substitution' }
      step.paths.push(v)
      continue
    }
    if (a.uncertain) return { kind: 'uncertain', reason: 'git add option from a variable' }
    if (v === '--') { afterDash = true; continue }
    if (v.startsWith('--')) {
      const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v
      if (name === '--chmod') continue                  // it only changes the mode, the content stays
      if (name === '--dry-run') return 'none'
      // -N is not a dry run: it records the file in the index, and a commit -a or one
      // with those paths takes its whole content. It is replayed on the index copy.
      if (name === '--intent-to-add') { step.intentToAdd = true; continue }
      if (['--patch', '--interactive', '--edit'].includes(name)) return { kind: 'uncertain', reason: 'interactive git add' }
      if (name === '--pathspec-from-file') return { kind: 'uncertain', reason: 'git add paths from a file' }
      if (!ADD_FLAGS_WITHOUT_VALUE.has(name) || v.includes('=')) return { kind: 'uncertain', reason: `unrecognized git add option: ${name.slice(0, 40)}` }
      if (name === '--all' || name === '--no-ignore-removal') step.all = true
      else if (name === '--update') step.update = true
      else if (name === '--force') step.force = true
      else if (name === '--refresh') return 'none'
      continue
    }
    for (const o of v.slice(1)) {
      if (o === 'A') step.all = true
      else if (o === 'u') step.update = true
      else if (o === 'f') step.force = true
      else if (o === 'N') step.intentToAdd = true
      else if (o === 'n') return 'none'
      else if (o === 'p' || o === 'i' || o === 'e') return { kind: 'uncertain', reason: 'interactive git add' }
      else if (o !== 'v') return { kind: 'uncertain', reason: `unrecognized git add option: -${o}` }
    }
  }
  return { kind: 'step', step }
}

// `git checkout -b name` and `git switch -c name` create a branch without touching the
// index: it is the most common way to prepare a commit on a new branch.
function onlyNewBranch(sub: string, args: readonly Word[]): boolean {
  if (args.length !== 2 || args.some((a) => a.uncertain)) return false
  const f = args[0].v
  const ok = sub === 'checkout' ? f === '-b' || f === '-B' : f === '-c' || f === '-C' || f === '--create'
  return ok && !args[1].v.startsWith('-')
}

// git's global options before the subcommand.
const GIT_FLAGS_WITHOUT_VALUE = new Set([
  '--no-pager', '-p', '--paginate', '-P', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--no-lazy-fetch',
])
const GIT_OTHER_REPO_FLAGS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--bare'])

function gitCommand(args: readonly Word[], redir: readonly Redirection[], st: ParseState, u: ParseOutput, o: { riskyEnv: boolean; dir?: string }): void {
  let dir = o.dir
  let dirUncertain = st.dirUncertain
  let otherRepo = o.riskyEnv
  let k = 0
  for (; k < args.length; k++) {
    const a = args[k]
    const v = a.v
    if (a.uncertain) {
      if (mentionsCommit(args)) markUncertain(u, 'git options from a variable or a substitution')
      return
    }
    if (!v.startsWith('-')) break
    if (v === '-C') {
      const d = args[++k]
      if (!d) return
      if (d.uncertain) dirUncertain = true
      else if (d.v !== '') dir = joinDir(dir, d.v)
      continue
    }
    if (v === '-c' || v === '--config-env') { k++; continue }
    const name = v.includes('=') ? v.slice(0, v.indexOf('=')) : v
    if (GIT_OTHER_REPO_FLAGS.has(name)) {
      otherRepo = true
      if (!v.includes('=') && name !== '--bare') k++
      continue
    }
    if (GIT_FLAGS_WITHOUT_VALUE.has(v) || name === '--config-env' || name === '--exec-path') continue
    if (['--version', '--help', '-h', '-v', '--html-path', '--man-path', '--info-path'].includes(v)) return
    if (mentionsCommit(args)) markUncertain(u, `unrecognized global git option: ${name.slice(0, 40)}`)
    return
  }
  const sub = args[k]
  if (!sub) return
  const rest = args.slice(k + 1)
  if (sub.uncertain) {
    if (mentionsCommit(rest)) markUncertain(u, 'git subcommand from a variable')
    return
  }
  // `git stage` is the built-in synonym of `git add`: read as any other command, the
  // added file would stay out of the diff and the hook would stay silent
  if (sub.v === 'add' || sub.v === 'stage') {
    const r = parseAdd(rest)
    if (r === 'none') return
    if (r.kind === 'uncertain' || otherRepo || dirUncertain) {
      st.addsUncertain = true
      return
    }
    if (st.steps.length > 0 && st.addsDir !== dir) st.addsUncertain = true
    st.steps.push(r.step)
    st.addsDir = dir
    return
  }
  if (sub.v === 'commit') {
    const r = parseCommit(rest, redir)
    if (r === 'none') return
    if (r.kind === 'uncertain') return markUncertain(u, r.reason)
    if (otherRepo) return markUncertain(u, 'git with --git-dir, --work-tree or GIT_* variables that move the repo or the index')
    if (dirUncertain) return markUncertain(u, 'commit directory cannot be determined (cd or -C with a variable)')
    if (st.addsUncertain) return markUncertain(u, 'git add with paths or options that cannot be determined before the commit')
    if (st.indexChanged) return markUncertain(u, 'a git command before the commit changes the index (rm, mv, reset, stash…)')
    const steps = [...st.steps]
    if (r.include.length > 0) steps.push({ paths: r.include, all: false, update: false, force: false })
    if (steps.length > 0 && st.steps.length > 0 && st.addsDir !== dir) {
      return markUncertain(u, 'git add and git commit in different directories')
    }
    const intent: CommitIntent = { ...r.intent, adds: null }
    if (dir !== undefined) intent.dir = dir
    if (steps.length > 0) {
      const paths: string[] = []
      for (const p of steps) for (const x of p.paths) if (!paths.includes(x)) paths.push(x)
      intent.adds = { paths, all: steps.some((p) => p.all), steps }
    }
    u.intents.push(intent)
    // A second commit in the same command starts from the index this one leaves: its
    // adds, applied to the current index, give a diff that also contains the first.
    // Wider than the truth, never narrower.
    st.steps = []
    st.addsDir = undefined
    return
  }
  if ((sub.v === 'checkout' || sub.v === 'switch') && onlyNewBranch(sub.v, rest)) return
  if (INDEX_CHANGING_SUBCOMMANDS.has(sub.v)) st.indexChanged = true
}

function simpleCommand(c: SimpleCommand, st: ParseState, u: ParseOutput): void {
  const words = c.words
  // A git commit inside a substitution runs in a subprocess: we do not follow it.
  for (const p of [...words, ...c.redir.flatMap((r) => (r.target ? [r.target] : []))]) {
    for (const sub of p.substitutions) {
      const a = analyzeTokens(sub)
      if (a.outcome !== 'none') markUncertain(u, 'git commit inside a command substitution')
    }
  }

  let k = 0
  let riskyEnv = false
  let localDir = st.dir
  const assignments = (): void => {
    while (k < words.length && words[k].assignment) {
      const name = words[k].v.slice(0, words[k].v.indexOf('='))
      if (RE_GIT_ENV.test(name)) riskyEnv = true
      k++
    }
  }
  assignments()
  // reserved words and programs that run the rest of the line as it is
  for (;;) {
    const w = words[k]
    if (!w || w.uncertain) break
    if (RESERVED_WORDS.has(w.v) || w.v === 'builtin' || w.v === 'nohup') { k++; continue }
    if (w.v === 'time') {
      k++
      if (words[k]?.v === '-p') k++
      continue
    }
    if (w.v === 'command') {
      k++
      while (words[k]?.v.startsWith('-')) {
        if (words[k].v.includes('v') || words[k].v.includes('V')) return   // command -v: looks up, does not run
        k++
      }
      continue
    }
    if (w.v === 'exec') {
      k++
      while (words[k]?.v.startsWith('-')) k += words[k].v === '-a' ? 2 : 1
      continue
    }
    if (w.v === 'env') {
      k++
      for (;;) {
        const x = words[k]
        if (!x || x.uncertain) break
        if (x.v === '-i' || x.v === '-' || x.v === '--ignore-environment' || x.v === '-0' || x.v === '--null' || x.v.startsWith('--unset=')) { k++; continue }
        if (x.v === '-u') { k += 2; continue }
        if (x.v === '-C' || x.v.startsWith('--chdir=')) {
          const d = x.v === '-C' ? words[k + 1] : { ...x, v: x.v.slice('--chdir='.length) }
          if (!d || d.uncertain) {
            if (mentionsCommit(words)) markUncertain(u, 'env -C with a directory that cannot be determined')
            return
          }
          localDir = joinDir(localDir, d.v)
          k += x.v === '-C' ? 2 : 1
          continue
        }
        if (x.v.startsWith('-')) {
          if (mentionsCommit(words)) markUncertain(u, `unrecognized env option: ${x.v.slice(0, 40)}`)
          return
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.v)) {
          if (RE_GIT_ENV.test(x.v.slice(0, x.v.indexOf('=')))) riskyEnv = true
          k++
          continue
        }
        break
      }
      continue
    }
    break
  }
  const prog = words[k]
  if (!prog) return
  const args = words.slice(k + 1)
  if (prog.uncertain) {
    if (mentionsCommit(words)) markUncertain(u, 'program from a variable or a substitution ($CMD commit)')
    return
  }
  const name = baseName(prog.v)
  if (name === 'git') return gitCommand(args, c.redir, st, u, { riskyEnv, dir: localDir })
  if (name === 'cd' || name === 'pushd') {
    const dest = args.filter((a) => !/^-[LPe@]+$/.test(a.v) && a.v !== '--')
    const d = dest[0]
    if (!d) {
      st.dir = '~'
      st.dirUncertain = false
    } else if (d.uncertain || d.v === '-' || (d.v.startsWith('~') && d.v !== '~' && !d.v.startsWith('~/'))) {
      st.dirUncertain = true
    } else {
      st.dir = joinDir(st.dir, d.v)
      if (d.v.startsWith('/') || d.v.startsWith('~')) st.dirUncertain = false
    }
    return
  }
  if (name === 'popd') {
    st.dirUncertain = true
    return
  }
  // a script or an alias with "commit" in its name
  if (/commit/i.test(name)) return markUncertain(u, 'script or command that names commit')
  // sudo, xargs, timeout, sh -c, eval…: git commit as an argument of another program
  const texts = words.map((p) => p.v)
  if (SHELLS.has(name)) for (const r of c.redir) if (r.body !== undefined) texts.push(r.body)
  const all = texts.join(' ')
  if (RE_GIT.test(all) && RE_COMMIT.test(all)) markUncertain(u, 'git commit run by another program (sudo, xargs, sh -c, eval…)')
}

function analyzeTokens(tokens: Token[]): CommandAnalysis {
  const u: ParseOutput = { intents: [] }
  const st: ParseState = { dirUncertain: false, steps: [], addsUncertain: false, indexChanged: false }
  const stack: { dir?: string; dirUncertain: boolean }[] = []
  for (const v of commands(tokens)) {
    if (v.kind === 'open') stack.push({ dir: st.dir, dirUncertain: st.dirUncertain })
    else if (v.kind === 'close') {
      // a cd inside a subshell does not hold outside it
      const saved = stack.pop()
      if (saved) {
        st.dir = saved.dir
        st.dirUncertain = saved.dirUncertain
      }
    } else simpleCommand(v.c, st, u)
  }
  if (u.uncertain !== undefined) return { outcome: 'uncertain', reason: u.uncertain }
  return u.intents.length > 0 ? { outcome: u.intents } : { outcome: 'none' }
}

// ─── guardrail's wrapper ──────────────────────────────────────────────────────

// guardrail (mask.wrap_command) rewrites every Bash command so that it goes through
// its runner, with the model's text intact in a heredoc:
//   bash "<…>/run-python.sh" "<…>/mask.py" run <<'__GUARDRAIL_MASK__'
//   <command>
//   __GUARDRAIL_MASK__
// The delimiter grows with "_" until no line of the command equals it.
const RE_GUARDRAIL = /^bash "[^"\n]*\/run-python\.sh" "[^"\n]*\/mask\.py" run <<'(__GUARDRAIL_MASK__+)'\n([\s\S]*)\n\1\n?$/

// The command inside guardrail's wrapper, or null if there is no wrapper.
export function unwrapGuardrail(command: string): string | null {
  const m = RE_GUARDRAIL.exec(command)
  return m ? m[2] : null
}

// ─── Entry point ──────────────────────────────────────────────────────────────

// Like findCommits, with the reason of an 'uncertain' for the hook's log.
export function analyzeCommand(command: string): CommandAnalysis {
  const inner = unwrapGuardrail(command) ?? command
  // without "commit" anywhere (not even in git-commit or commit.sh) there is nothing to read
  if (!inner.includes('commit')) return { outcome: 'none' }
  const l = lex(inner, 0, false, 0)
  if (l.error !== undefined) return { outcome: 'uncertain', reason: `unreadable command: ${l.error}` }
  return analyzeTokens(l.tokens)
}

// 'uncertain': $CMD, aliases, scripts, unknown options → no review, log only. The
// caller passes the command already unmasked with unmask() if guardrail's mask map
// exists.
export function findCommits(command: string): CommitIntent[] | 'none' | 'uncertain' {
  return analyzeCommand(command).outcome
}
