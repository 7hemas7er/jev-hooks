// Redaction towards non-local backends. The secrets are composed at runtime
// from pieces: no value that makes the detectors fire (the reviewer's own or GitHub
// push protection's) enters the repo, as AGENTS.md asks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prng } from '../../src/core/random.ts'
import { validateChecks, validatePolicy } from '../../src/core/config.ts'
import { redact, redactForBackend } from '../../src/core/redaction.ts'
import type { Policy, Detector } from '../../src/core/types.ts'
import { generator } from '../helpers/strings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

function defaultPolicy(): Policy {
  const c = validateChecks(json('config/checks.json'), 'checks.json')
  if (!c.ok) assert.fail(c.error.message)
  const p = validatePolicy(json('config/policy.json'), c.value, 'policy.json')
  if (!p.ok) assert.fail(p.error.message)
  return p.value
}
const POLICY = defaultPolicy()

// ─── Fake secrets composed at runtime ─────────────────────────────────────────

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const ALNUM_CHARS = UPPERCASE + LOWERCASE + DIGITS
const BASE64 = `${ALNUM_CHARS}+/`

const r = generator(20260925)
function random(n: number, alphabet: string = ALNUM_CHARS): string {
  let s = ''
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)]
  return s
}

const secret = {
  stripe: (): string => 'sk_' + 'live_' + random(24),
  aws: (): string => 'AK' + 'IA' + random(16, UPPERCASE + '234567'),
  github: (): string => 'gh' + 'p_' + random(36),
  slack: (): string => 'xo' + 'xb-' + random(12, DIGITS) + '-' + random(24),
}
const PEM_START = '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----'
const PEM_END = '-----END ' + 'RSA PRIVATE' + ' KEY-----'

// The diff of a file: every content line is added.
function file(path: string, lines: readonly string[], isNew: boolean = false): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((x) => `+${x}`),
  ]
}

const redacted = (text: string, seed: number = 1): { text: string; redactions: number } => redact(text, POLICY, prng(seed))

// The shape of a value: A for a capital, a for a small letter, 0 for a digit.
const shape = (s: string): string => s.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '0')

// No long piece of the real value survives in the text that is sent.
function absent(text: string, value: string, window: number = 12): void {
  for (let i = 0; i + window <= value.length; i++) {
    const piece = value.slice(i, i + window)
    assert.ok(!text.includes(piece), `a piece of the secret remains in the sent text: position ${i}`)
  }
}

// ─── Shape preserved and consistency ──────────────────────────────────────────

test('shape preserved: same known prefix, same length, same character classes', () => {
  const cases: [string, string][] = [
    [secret.stripe(), 'sk_' + 'live_'], [secret.aws(), 'AK' + 'IA'], [secret.github(), 'gh' + 'p_'], [secret.slack(), 'xo' + 'xb-'],
  ]
  for (const [value, prefix] of cases) {
    const line = `+client.configure("${value}")`
    const out = redacted(file('src/payments.py', [line.slice(1)]).join('\n'))
    const lines = out.text.split('\n')
    const last = lines[lines.length - 1]
    assert.equal(last.length, line.length)
    const substitute = last.slice('+client.configure("'.length, -2)
    assert.notEqual(substitute, value)
    assert.ok(substitute.startsWith(prefix), `${prefix}: prefix lost`)
    assert.equal(shape(substitute), shape(value))
    absent(out.text, value.slice(prefix.length))
    assert.equal(out.redactions, 1)
  }
})

test('consistency: a value has a single substitute, even with no name beside it and across texts of the same review', () => {
  const signature = random(40)
  const other = random(40)
  const text = file('src/auth/tokens.py', [
    `SIGNING_KEY = "${signature}"`,
    `verify(data, "${signature}")`,
    `OTHER_SECRET = "${other}"`,
  ]).join('\n')
  const out = redacted(text)
  absent(out.text, signature)
  absent(out.text, other)
  const lines = out.text.split('\n')
  const first = lines[lines.length - 3].match(/"(.+)"/)?.[1]
  const second = lines[lines.length - 2].match(/"(.+)"/)?.[1]
  const third = lines[lines.length - 1].match(/"(.+)"/)?.[1]
  assert.equal(first, second, 'the same key must have the same substitute')
  assert.notEqual(first, third, 'different keys, different substitutes')
  assert.equal(out.redactions, 3)

  // two texts of the same review (a chunk and the global state) with the same memory
  const memo = new Map<string, string>()
  const rnd = prng(7)
  const chunk = redact(`+SIGNING_KEY = "${signature}"`, POLICY, rnd, memo).text
  const global = redact(`[diff]\n+SIGNING_KEY = "${signature}"\n+x = 1`, POLICY, rnd, memo).text
  assert.equal(global.split('\n')[1], chunk)
})

test('same seed, same redaction; a different seed, different substitutes', () => {
  const text = file('src/payments.py', [`STRIPE_KEY = "${secret.stripe()}"`]).join('\n')
  assert.equal(redacted(text, 3).text, redacted(text, 3).text)
  assert.notEqual(redacted(text, 3).text, redacted(text, 4).text)
})

// ─── What is redacted and what is not ─────────────────────────────────────────

test('fake values (ignore_values): they stay as they are', () => {
  const text = file('src/settings.py', [
    `AWS_KEY_ID = "${'AK' + 'IA'}${random(9, UPPERCASE)}EXAMPLE"`,
    'PASSWORD = "changeme-changeme-please"',
    'api_key: ${API_KEY_FROM_THE_ENVIRONMENT}',
    'token = process.env.GITHUB_TOKEN_PRODUCTION',
    'db_password = settings.DATABASE_PASSWORD_VALUE',
    'DATABASE_URL = "postgres://user:password@localhost/app"',
  ]).join('\n')
  const out = redacted(text)
  assert.equal(out.text, text)
  assert.equal(out.redactions, 0)
})

test('min_entropy does not count: a trivial password is redacted anyway', () => {
  const trivial = 'a'.repeat(24)
  const out = redacted(file('src/db.py', [`DB_PASSWORD = "${trivial}"`]).join('\n'))
  const substitute = out.text.split('\n').pop()?.match(/"(.+)"/)?.[1] ?? ''
  assert.equal(substitute.length, 24)
  assert.match(substitute, /^[a-z]+$/)
  assert.notEqual(substitute, trivial)
})

test('.env, YAML, INI and URLs with credentials: the value is replaced, the name stays', () => {
  const v = { env: random(32), yaml: random(20), ini: random(40, BASE64), jwt: random(30), prod: random(24), pw: random(14) }
  const text = [
    ...file('deploy/app.env', [`SECRET_KEY=${v.env}`, 'DEBUG=false']),
    ...file('config/app.yaml', ['database:', `  password: ${v.yaml}`]),
    ...file('config/aws.ini', ['[default]', `aws_secret_access_key = ${v.ini}`]),
    ...file('src/config.py', [`JWT_SECRET_KEY: "${v.jwt}"`, `db_password_prod = '${v.prod}'`]),
    ...file('src/db.py', [`DATABASE_URL = "postgres://app:${v.pw}@db.internal:5432/app"`]),
  ].join('\n')
  const out = redacted(text)
  for (const value of Object.values(v)) absent(out.text, value, 8)
  for (const remains of ['+SECRET_KEY=', '+  password: ', '+aws_secret_access_key = ', '+JWT_SECRET_KEY: "', "+db_password_prod = '",
    '+DATABASE_URL = "postgres://app:', '@db.internal:5432/app"', '+DEBUG=false', '+database:', '+[default]']) {
    assert.ok(out.text.includes(remains), `lost: ${remains}`)
  }
  assert.equal(out.text.length, text.length)
  assert.equal(out.redactions, 6)
})

test('nothing to redact: the text stays identical', () => {
  const text = [
    '[title]', '  Adds pagination', '[description]', '  (none)', '[files]', 'M src/list.py +2 -1', '[files_not_shown]', '0', '[diff]',
    ...file('src/list.py', ['def page(n):', '    return items[n * 20:(n + 1) * 20]']),
  ].join('\n')
  const out = redacted(text)
  assert.equal(out.text, text)
  assert.equal(out.redactions, 0)
})

test('text@1 state: the secret in the description is redacted, the sections stay', () => {
  const key = secret.stripe()
  const text = [
    '[title]', '  Adds the payment', '[description]', `  To try it, use ${key} locally.`, '[files]', 'M src/payments.py +1 -0',
    '[files_not_shown]', '0', '[diff]', ...file('src/payments.py', [`STRIPE_KEY = "${key}"`]),
  ].join('\n')
  const out = redacted(text)
  absent(out.text, key.slice(8))
  const lines = out.text.split('\n')
  assert.deepEqual(lines.filter((x) => x.startsWith('[')), ['[title]', '[description]', '[files]', '[files_not_shown]', '[diff]'])
  assert.equal(out.redactions, 2)
})

// ─── PEM keys ─────────────────────────────────────────────────────────────────

test('whole PEM block: no line of the base64 body in the text that is sent', () => {
  const body = [random(64, BASE64), random(64, BASE64), random(64, BASE64), `${random(22, BASE64)}==`]
  const text = file('config/cert.txt', [PEM_START, ...body, PEM_END, 'after = 1']).join('\n')
  const out = redacted(text)
  const before = text.split('\n')
  const after = out.text.split('\n')
  assert.equal(after.length, before.length)
  for (const line of body) absent(out.text, line)
  assert.ok(after.includes(`+${PEM_START}`) && after.includes(`+${PEM_END}`), 'the BEGIN and END lines stay')
  const start = after.indexOf(`+${PEM_START}`)
  for (let i = 1; i <= body.length; i++) {
    assert.equal(after[start + i].length, before[start + i].length)
    assert.ok(after[start + i].startsWith('+'))
    assert.equal(shape(after[start + i]), shape(before[start + i]))
  }
  assert.equal(after[after.length - 1], '+after = 1')
  assert.equal(out.redactions, 1)
})

test('PEM block without END: it stops at the end of the hunk', () => {
  const body = [random(64, BASE64), random(64, BASE64)]
  const text = [
    ...file('config/cert.txt', [PEM_START, ...body]),
    '@@ -40,2 +42,2 @@ def load():',
    ' unchanged context',
    '+new line = 2',
  ].join('\n')
  const out = redacted(text)
  for (const line of body) absent(out.text, line)
  assert.deepEqual(out.text.split('\n').slice(-3), ['@@ -40,2 +42,2 @@ def load():', ' unchanged context', '+new line = 2'])
})

test('PEM key on a single line, with the \\n written in the string', () => {
  const pieces = [random(64, BASE64), random(64, BASE64), random(30, BASE64)]
  const value = [PEM_START, ...pieces, PEM_END].join('\\n')
  const text = file('src/sign.js', [`const PRIVATE_KEY = "${value}"`]).join('\n')
  const out = redacted(text)
  const line = out.text.split('\n').pop() ?? ''
  for (const piece of pieces) absent(out.text, piece)
  assert.ok(line.includes(`"${PEM_START}\\n`) && line.includes(`\\n${PEM_END}"`))
  assert.equal(line.split('\\n').length, 5)
  assert.equal(line.length, `+const PRIVATE_KEY = "${value}"`.length)
})

// ─── Sensitive files ──────────────────────────────────────────────────────────

test('sensitive_files: only the path and the detectors that hit are sent', () => {
  const key = secret.stripe()
  const binary = random(60, BASE64)
  const text = [
    ...file('.env', [`STRIPE=${key}`, 'DEBUG=1'], true),
    ...file('certs/server.pem', [PEM_START, random(64, BASE64), PEM_END], true),
    ...file('config/credentials.json', ['{"user": "app"}'], true),
    'diff --git a/keystore.p12 b/keystore.p12', 'new file mode 100644', 'index 0000000..3b18e51', 'GIT binary patch', 'literal 1234',
    `z${binary}`, '',
    ...file('src/app.py', ['print("hello")']),
  ].join('\n')
  const out = redacted(text)
  assert.deepEqual(out.text.split('\n'), [
    'diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env',
    '(content not sent: sensitive file; detectors: stripe_live)',
    'diff --git a/certs/server.pem b/certs/server.pem', 'new file mode 100644', '--- /dev/null', '+++ b/certs/server.pem',
    '(content not sent: sensitive file; detectors: private_key)',
    'diff --git a/config/credentials.json b/config/credentials.json', 'new file mode 100644', '--- /dev/null', '+++ b/config/credentials.json',
    '(content not sent: sensitive file; detectors: none)',
    'diff --git a/keystore.p12 b/keystore.p12', 'new file mode 100644', 'index 0000000..3b18e51',
    '(content not sent: sensitive file; detectors: none)',
    ...file('src/app.py', ['print("hello")']),
  ])
  assert.equal(out.redactions, 4)
})

test('sensitive files with quoted paths, renamed, or in a chunked state', () => {
  const key = secret.stripe()
  const quotes = [
    'diff --git "a/dir/caf\\303\\251/.env" "b/dir/caf\\303\\251/.env"', 'new file mode 100644', '--- /dev/null', '+++ "b/dir/caf\\303\\251/.env"',
    '@@ -0,0 +1 @@', `+STRIPE=${key}`,
  ]
  const rename = [
    'diff --git a/note.txt b/secrets.yaml', 'similarity index 90%', 'rename from note.txt', 'rename to secrets.yaml',
    '--- a/note.txt', '+++ b/secrets.yaml', '@@ -1 +1,2 @@', ' db: main', `+token: ${random(30)}`,
  ]
  const chunk = ['[files]', 'A .env.production +1 -0', '[part]', '2 of 3', '[diff]', ...file('.env.production', [`STRIPE=${key}`], true)]
  for (const text of [quotes, rename, chunk]) {
    const out = redacted(text.join('\n'))
    assert.ok(out.text.includes('(content not sent: sensitive file;'), text[0])
    const content = out.text.split('\n').filter((x) => /^[+ -]/.test(x) && !x.startsWith('+++ ') && !x.startsWith('--- '))
    assert.deepEqual(content, [], 'no content line, context included')
    absent(out.text, key.slice(8))
  }
  // the state's file list stays: the path is sent
  assert.ok(redacted(chunk.join('\n')).text.includes('A .env.production +1 -0'))
})

// ─── Router, backend, edge cases ──────────────────────────────────────────────

test('router (no policy): tokens of at least 20 characters with an entropy of at least 4 bits', () => {
  const key = random(32)
  const short = random(19)
  const hashOk = random(40, '0123456789abcdef')
  const prompt = `rename effective_configuration in src/core/router.ts; the key is ${key}, `
    + `the commit ${hashOk}, the code ${short}, the line ${'a'.repeat(30)}`
  const out = redact(prompt, null, prng(1))
  absent(out.text, key)
  assert.equal(out.redactions, 1)
  for (const remains of ['effective_configuration', 'src/core/router.ts', hashOk, short, 'a'.repeat(30)]) {
    assert.ok(out.text.includes(remains), `should not have changed: ${remains.slice(0, 12)}…`)
  }
  // a PEM block is recognized even without a policy
  const pem = redact([PEM_START, random(64, BASE64), PEM_END].join('\n'), null, prng(1))
  assert.equal(pem.text.split('\n')[0], PEM_START)
  assert.equal(pem.text.split('\n')[2], PEM_END)
})

test('redactForBackend: towards a local backend the state stays as it is', () => {
  const text = file('src/payments.py', [`STRIPE_KEY = "${secret.stripe()}"`]).join('\n')
  assert.deepEqual(redactForBackend({ local: true }, text, POLICY, prng(1)), { text, redactions: 0 })
  const remote = redactForBackend({ local: false }, text, POLICY, prng(1))
  assert.notEqual(remote.text, text)
  assert.equal(remote.redactions, 1)
})

test('a degenerate case does not let the value through', () => {
  const value = 'a'.repeat(24)
  const text = file('src/db.py', [`DB_PASSWORD = "${value}"`]).join('\n')
  for (const rnd of [(): number => 0, (): number => 0.9999999, (): number => 1, (): number => Number.NaN, (): number => -3]) {
    const out = redact(text, POLICY, rnd)
    const substitute = out.text.split('\n').pop()?.match(/"(.+)"/)?.[1] ?? ''
    assert.notEqual(substitute, value)
    assert.match(substitute, /^[a-z]{24}$/)
  }
})

test('project detectors do not run in the redaction (only in the Worker)', () => {
  const base: Detector = {
    name: 'internal_code', label: 'Internal code', check: 'hardcoded_secret', where: ['added_lines'],
    regex: /\bQZ[0-9]{12}\b/, exclude_paths: [], floor: null, escalate: 'never',
  }
  const code = `QZ${random(12, DIGITS)}`
  const text = file('src/x.py', [`reference(${code})`]).join('\n')
  const withProject = { ...POLICY, detectors: [...POLICY.detectors, { ...base, fromProject: true }] }
  const withUser = { ...POLICY, detectors: [...POLICY.detectors, base] }
  assert.equal(redact(text, withProject, prng(1)).text, text)
  absent(redact(text, withUser, prng(1)).text, code.slice(2), 8)
})

test('a hostile diff with many secret-like values stays linear', () => {
  // before the index by start, twenty thousand values cost twenty thousand scans of the text
  const lines = ['diff --git a/src/x.py b/src/x.py', '--- a/src/x.py', '+++ b/src/x.py', '@@ -1 +1,20000 @@']
  for (let i = 0; i < 20_000; i++) lines.push(`+password_${i} = "${random(20)}"`)
  const start = performance.now()
  const out = redacted(lines.join('\n'))
  const ms = performance.now() - start
  assert.ok(out.redactions > 19_900, `redactions: ${out.redactions}`)
  assert.ok(ms < 3000, `redaction too slow: ${Math.round(ms)} ms`)
})
