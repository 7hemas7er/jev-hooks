// Writes the demo diffs into a directory, replacing the placeholders of the
// templates in examples/demo/ with values composed at runtime: high-entropy secrets,
// keys with a production prefix, phrases addressed to the reviewer. Only the templates
// with the placeholders stay in the repo (in angle brackets, which the detectors'
// ignore_values recognizes as fake), so the reviewer does not fire on the repo itself
// and GitHub's push protection does not stop the push.
//
// Usage: node scripts/generate-demo.ts [DIR] [--seed N]   (--help for the details)
//        without a directory it creates a temporary one and prints it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripeLiveKey, stripeTestKey, injectionPhrase, generator, highEntropyValue } from '../tests/helpers/fake-secrets.ts'

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo')

export function generateDemo(dir: string, o: { seed?: number } = {}): Record<string, string> {
  const rnd = generator(o.seed ?? (Date.now() >>> 0))
  const values: Record<string, () => string> = {
    '<HIGH_ENTROPY_SECRET>': () => highEntropyValue(40, rnd),
    '<STRIPE_LIVE>': () => stripeLiveKey(rnd),
    '<STRIPE_TEST>': () => stripeTestKey(rnd),
    '<INJECTION_PHRASE>': () => injectionPhrase(),
  }
  mkdirSync(dir, { recursive: true })
  const written: Record<string, string> = {}
  for (const name of readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.diff')).sort()) {
    let text = readFileSync(join(TEMPLATES_DIR, name), 'utf8')
    for (const [placeholder, value] of Object.entries(values)) {
      while (text.includes(placeholder)) text = text.replace(placeholder, value())
    }
    const target = join(dir, name)
    writeFileSync(target, text)
    written[name] = target
  }
  // the table's empty diff: no request, exit 0
  const empty = join(dir, 'empty.diff')
  writeFileSync(empty, '')
  written['empty.diff'] = empty
  return written
}

// ─── Command line ─────────────────────────────────────────────────────────────

const EXIT_OK = 0
const EXIT_USAGE = 2

export class InputError extends Error {}

export const HELP = `Usage: node scripts/generate-demo.ts [DIR] [--seed N]

  DIR           where to write the demo diffs, created if missing; without it a
                temporary directory is created and its path is printed
  --seed N      seed of the composed values, a decimal integer (also --seed=N): the
                same seed writes the same diffs (default: taken from the clock)
  -h, --help    this text, and nothing is written
  --            ends the options: a DIR that starts with "-" goes after it

Writes the templates of examples/demo/ with their placeholders replaced by values
composed at run time, plus empty.diff. Try them with bin/jev-review.mjs --diff FILE.`

export interface DemoOptions { dir?: string; seed?: number }

// Every usage mistake is an InputError, raised before anything is written: the old
// parser took any first argument as the directory, so --help or --seed=7 became a
// directory full of demo diffs in the cwd.
export function parseArgs(argv: readonly string[], cwd: string): DemoOptions | 'help' {
  const o: DemoOptions = {}
  let seeded = false
  let options = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (options && a === '--') {
      options = false
      continue
    }
    if (options && (a === '--help' || a === '-h')) return 'help'
    if (options && (a === '--seed' || a.startsWith('--seed='))) {
      if (seeded) throw new InputError('repeated option: --seed')
      seeded = true
      const v = a === '--seed' ? argv[++i] : a.slice('--seed='.length)
      if (v === undefined) throw new InputError('missing value for --seed')
      // Number() alone would take "", "0x10" and "1e3" as 0, 16 and 1000
      const n = Number(v)
      if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) throw new InputError(`--seed wants an integer, found "${v}"`)
      o.seed = n
      continue
    }
    if (options && a.startsWith('-')) throw new InputError(`unknown option: ${a}`)
    if (o.dir !== undefined) throw new InputError(`unexpected argument: ${a}`)
    o.dir = resolve(cwd, a)
  }
  return o
}

// cwd is a parameter so that the tests resolve a relative DIR inside a temporary
// directory, never inside the repo they run from.
export function main(
  argv: readonly string[], cwd: string = process.cwd(),
  write: (s: string) => void = (s) => process.stdout.write(s), error: (s: string) => void = (s) => process.stderr.write(s),
): number {
  try {
    const o = parseArgs(argv, cwd)
    if (o === 'help') {
      write(`${HELP}\n`)
      return EXIT_OK
    }
    const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'jev-hooks-demo-'))
    const written = generateDemo(dir, o.seed !== undefined ? { seed: o.seed } : {})
    write(`${dir}\n${Object.keys(written).map((n) => `  ${n}`).join('\n')}\n`)
    return EXIT_OK
  } catch (err) {
    if (err instanceof InputError) {
      error(`generate-demo: ${err.message}\n`)
      return EXIT_USAGE
    }
    throw err
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = main(process.argv.slice(2))
