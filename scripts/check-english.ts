// Leftover-Italian scanner. The repository is in English, but a translation done by
// hand leaves words behind: a comment nobody reread, an error message in a branch no
// test reaches, a local named after the old vocabulary. This script looks for common
// Italian words and for words ending in an accented vowel in every tracked file, in
// code, comments and strings alike, and prints where they are.
//
// Not scanned, because Italian there is data on purpose:
// - the bench datasets and recorded results (bench/*.jsonl, bench/results/), and the
//   ids of the datasets' rows where another bench file cites them;
// - tests/data/checks-original.json, the Italian question set generated with the
//   upstream code-review prompt (its ids, types and lanes come from that prompt);
// - the texts of the questions sent to the model (instructions, criteria and the
//   question object of a bench variant): they are bound to measured sha256 values,
//   and the it_* variants are Italian to measure Italian.
// Recorded names that stay Italian (variant names, placeholder types, the hard
// negative marker) are listed in ALLOWED_TOKENS. Text that must stay Italian, such as
// a phrase a detector has to catch, is marked in a comment:
// - "check-english: allow" skips its own line;
// - "check-english: allow-next-line" skips its own line and the next one;
// - "check-english: off" … "check-english: on" skips the lines in between.
// Detector patterns (the "regex" key of a JSON file) are skipped too: some match
// Italian injection text on purpose.
//
// Usage: node scripts/check-english.ts [--root <dir>]
// Exit 0 when nothing is found, 1 with the list of findings.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Common Italian words that are not also English words or code keywords ("per",
// "con", "come", "del", "non", "data", "file", "note" are missing on purpose, and so
// are "nel" and "uno", which collide with the NEL character and git's -uno flag).
export const ITALIAN_WORDS: ReadonlySet<string> = new Set([
  // articles, prepositions and their contractions
  'il', 'gli', 'una', 'dei', 'della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'nello',
  'negli', 'sulla', 'sulle', 'sullo', 'sugli', 'alla', 'alle', 'allo', 'agli', 'dalla', 'dalle',
  'dallo', 'dagli', 'sul', 'fra', 'tra',
  // pronouns, conjunctions, adverbs
  'che', 'cui', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle',
  'stesso', 'stessa', 'stessi', 'loro', 'suo', 'sua', 'suoi', 'anche', 'ancora', 'sempre', 'mai',
  'niente', 'nulla', 'nessun', 'nessuno', 'nessuna', 'ogni', 'tutti', 'tutte', 'tutto', 'altro',
  'altra', 'altri', 'altre', 'oppure', 'altrimenti', 'quindi', 'ovvero', 'invece', 'soltanto',
  'senza', 'dopo', 'prima', 'quando', 'mentre', 'sotto', 'sopra', 'dentro', 'fuori',
  'oltre', 'fino', 'molto', 'molti', 'troppo', 'tanto', 'cosa', 'cose', 'quale', 'quali', 'ciascun',
  'ciascuno', 'qualcosa', 'qualsiasi', 'ecco', 'poi', 'ora', 'adesso', 'subito',
  // verbs
  'sono', 'essere', 'avere', 'hanno', 'deve', 'devono', 'puoi', 'possono', 'servono',
  'viene', 'vengono', 'resta', 'restano', 'diventa', 'fatto', 'scatta', 'blocca', 'passa', 'chiede',
  'nega', 'legge', 'scrive', 'manda', 'controlla', 'verifica', 'misura', 'calcola', 'mostra',
  // the reviewer's own old vocabulary
  'valore', 'valori', 'domanda', 'domande', 'risposta', 'risposte', 'soglia', 'soglie', 'corsia',
  'corsie', 'etichetta', 'etichette', 'rilevatore', 'rilevatori', 'segreto', 'segreti', 'pavimento',
  'banco', 'misure', 'prova', 'prove', 'controllo', 'errore', 'errori', 'messaggio', 'messaggi',
  'modello', 'modelli', 'revisore', 'revisione', 'riga', 'righe', 'testo', 'vuoto', 'vuota', 'chiave',
  'chiavi', 'percorso', 'percorsi', 'cartella', 'stringa', 'funzione', 'variabile', 'esempio',
  'esempi', 'caso', 'casi', 'modo', 'numero', 'numeri', 'elenco', 'voce', 'voci', 'blocco', 'finto',
  'finta', 'vero', 'falso', 'nuovo', 'nuova', 'vecchio', 'vecchia', 'primo', 'ultimo', 'ultima',
  'secondo', 'attesa', 'atteso', 'sessione', 'impronta', 'taratura', 'profilo',
  'uscita', 'ingresso', 'dati', 'giorno', 'giorni', 'minuti', 'secondi', 'caratteri', 'segnaposto',
  'rinomina', 'conferma', 'sviluppo', 'difficili', 'positivi', 'negativi',
])

// Words that end in an accented vowel are Italian in this repository (più, già, è,
// perché, così, può): English borrowings such as café or résumé do not occur.
const RE_ACCENTED = /[àèìòù]$|ché$|^[ns]é$/

// Whole tokens (letters, digits and underscores) that are recorded data and stay as
// they are: bench variant names and their pairing suffix, placeholder syntax and
// secret type names, the hard-negative marker of the dataset notes.
export const ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  'attuale', 'a_letterale', 'b_esempi', 'c_scelta', 'c_scelta_none_ultima', 'd_inversa', 'e_firme',
  'e_scomposta', 'e_omissione', 'e_invenzione', 'it_esempi', 'it_letterale', 'c_scelta_due_ordini',
  'e_scomposta_senza_test', 'e_omissione_o_invenzione', '_inversa', 'inversa',
  'SEGRETO', 'aws_segreta', 'alta_entropia', 'iniezione',
  'difficile',
])

// Paths that are not scanned at all (relative to the root, with forward slashes).
export const EXCLUDED: readonly RegExp[] = [
  /^bench\/[^/]+\.jsonl$/,
  /^bench\/results\//,
  /^tests\/data\/checks-original\.json$/,
  /^scripts\/check-english\.ts$/,     // the word list itself
  /^LICENSE$/,
  /(^|\/)\.piano\//,
]

// JSON keys whose whole value is (part of) a question sent to the model.
const QUESTION_KEYS: ReadonlySet<string> = new Set(['instructions', 'criteria', 'question'])
const SKIPPED_KEYS: ReadonlySet<string> = new Set([...QUESTION_KEYS, 'regex'])

const TEXT_EXTENSIONS = /\.(ts|mjs|js|json|md|sh|yml|yaml|diff|txt)$|(^|\/)\.gitignore$/

const ALLOW_LINE = 'check-english: allow'          // also a prefix of allow-next-line
const ALLOW_NEXT_LINE = 'check-english: allow-next-line'
const OFF = 'check-english: off'
const ON = 'check-english: on'

export interface Finding { file: string; where: string; word: string }

// The Italian words of a piece of text. Tokens are split on anything that is not a
// letter, a digit or an underscore; a token that is not allowed as a whole is then
// split at underscores, digits and camelCase humps, so that sogliaMinima and
// SOGLIA_MINIMA are caught as well as prose.
export function italianWords(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = m[0]
    if (ALLOWED_TOKENS.has(token)) continue
    const parts = token.split(/[_\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u)
    for (const part of parts) {
      const w = part.toLowerCase()
      if (w === '') continue
      if (ITALIAN_WORDS.has(w) || RE_ACCENTED.test(w)) out.push(part)
    }
  }
  return out
}

function scanLines(file: string, text: string): Finding[] {
  const out: Finding[] = []
  const lines = text.split('\n')
  let off = false
  lines.forEach((line, i) => {
    if (line.includes(OFF)) off = true
    else if (line.includes(ON)) off = false
    if (off || line.includes(ALLOW_LINE) || (i > 0 && lines[i - 1].includes(ALLOW_NEXT_LINE))) return
    for (const word of italianWords(line)) out.push({ file, where: String(i + 1), word })
  })
  return out
}

// JSON is walked instead of read line by line, so that question texts can be left
// out by key and every finding says which key holds it.
function scanJson(file: string, text: string): Finding[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return scanLines(file, text)
  }
  const out: Finding[] = []
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      for (const word of italianWords(v)) out.push({ file, where: path || '(root)', word })
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`))
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        const at = path === '' ? k : `${path}.${k}`
        for (const word of italianWords(k)) out.push({ file, where: at, word })
        if (!SKIPPED_KEYS.has(k)) walk(x, at)
      }
    }
  }
  walk(doc, '')
  return out
}

export function scanText(file: string, text: string, rowIds: ReadonlySet<string> = new Set()): Finding[] {
  // A bench file that names dataset rows (the comment of a variants file citing the
  // row a variant was written for) quotes recorded data: the ids are removed first.
  const t = rowIds.size > 0 && /^bench\//.test(file) ? withoutRowIds(text, rowIds) : text
  return file.endsWith('.json') ? scanJson(file, t) : scanLines(file, t)
}

const RE_ROW_ID = /[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]/g

function withoutRowIds(text: string, ids: ReadonlySet<string>): string {
  return text.replace(RE_ROW_ID, (m) => (ids.has(m) ? '' : m))
}

// The ids of the bench datasets' rows (bench/*.jsonl), which are recorded data.
export function datasetRowIds(root: string, files: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const file of files) {
    if (!/^bench\/[^/]+\.jsonl$/.test(file)) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      try {
        const v: unknown = JSON.parse(line)
        if (typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string') ids.add((v as { id: string }).id)
      } catch {
        // an empty or broken line has no id
      }
    }
  }
  return ids
}

// The tracked files, or every file under the root when it is not a git checkout.
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter((f) => f !== '')
  } catch {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) files.push(relative(root, p).split('\\').join('/'))
      }
    }
    walk(root)
    return files
  }
}

export function checkEnglish(root: string = ROOT): Finding[] {
  const out: Finding[] = []
  const files = listFiles(root)
  const rowIds = datasetRowIds(root, files)
  for (const file of files) {
    if (!TEXT_EXTENSIONS.test(file) || EXCLUDED.some((re) => re.test(file))) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue                            // deleted in the working tree, or unreadable
    }
    out.push(...scanText(file, text, rowIds))
  }
  return out
}

export function renderFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'no Italian words found\n'
  const lines = findings.map((f) => `${f.file}:${f.where}: ${f.word}`)
  return `${lines.join('\n')}\n${findings.length} Italian words found\n`
}

export function main(argv: readonly string[]): number {
  let root = ROOT
  if (argv[0] === '--root' && argv[1] !== undefined && argv.length === 2) root = resolve(argv[1])
  else if (argv.length > 0) {
    process.stderr.write('usage: node scripts/check-english.ts [--root <dir>]\n')
    return 2
  }
  const findings = checkEnglish(root)
  process.stdout.write(renderFindings(findings))
  return findings.length === 0 ? 0 : 1
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
