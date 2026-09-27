// Writes the demo diffs into a directory, replacing the placeholders of the
// templates in examples/demo/ with values composed at runtime: high-entropy secrets,
// keys with a production prefix, phrases addressed to the reviewer. Only the templates
// with the placeholders stay in the repo (in angle brackets, which the detectors'
// ignore_values recognizes as fake), so the reviewer does not fire on the repo itself
// and GitHub's push protection does not stop the push.
//
// Usage: node scripts/generate-demo.ts [dir] [--seed N]
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

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const k = argv.indexOf('--seed')
  const seed = k >= 0 ? Number(argv[k + 1]) : undefined
  if (k >= 0) argv.splice(k, 2)
  if (seed !== undefined && !Number.isInteger(seed)) {
    process.stderr.write('generate-demo: --seed wants an integer\n')
    process.exit(2)
  }
  const dir = argv[0] !== undefined ? resolve(argv[0]) : mkdtempSync(join(tmpdir(), 'jev-hooks-demo-'))
  const written = generateDemo(dir, seed !== undefined ? { seed } : {})
  process.stdout.write(`${dir}\n${Object.keys(written).map((n) => `  ${n}`).join('\n')}\n`)
}
