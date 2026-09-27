// runReview() and probeStatus() against the fake server, and the backend's
// (URL, key, model) layers per entry point: the key from the file goes only to
// the URL of its layer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBackend } from '../../src/core/backend.ts'
import { shortHash } from '../../src/core/provenance.ts'
import type { Backend, Failure, BackendSources } from '../../src/core/types.ts'
import { backendFrom, runReview, backendSources, probeStatus } from '../../src/node/run.ts'
import { loadConfig } from '../../src/node/file-config.ts'
import type { LoadedConfig } from '../../src/node/file-config.ts'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer, FakeOptions } from '../helpers/fake-systemone.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function withFake(o: FakeOptions, f: (fake: FakeServer) => Promise<void>): Promise<void> {
  const fake = await startFake(o)
  try {
    await f(fake)
  } finally {
    await fake.close()
  }
}

function tempDir(): { dir: string; env: NodeJS.ProcessEnv; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'jev-hooks-run-'))
  mkdirSync(join(dir, 'home'))
  return { dir, env: { PATH: process.env.PATH, HOME: join(dir, 'home') }, close: () => rmSync(dir, { recursive: true, force: true }) }
}

function config(cwd: string, env: NodeJS.ProcessEnv): LoadedConfig {
  const c = loadConfig({ cwd, pluginRoot: ROOT, origin: 'cli', env: env })
  if (!c.ok) assert.fail(c.error.message)
  return c.value
}

function key(f: BackendSources): string {
  const r = resolveBackend(f)
  if (!r.ok) assert.fail(r.error.message)
  return r.value.key
}

const DIFF = [
  'diff --git a/src/compute.py b/src/compute.py', 'new file mode 100644', '--- /dev/null', '+++ b/src/compute.py',
  '@@ -0,0 +1,2 @@', '+def double(x):', '+    return 2 * x  # project-bad-word',
].join('\n') + '\n'

test('CLI: JEV_HOOKS_* with the key file as a fallback, TYPESAFE_* the last layer', () => {
  const lan = 'http://192.168.1.50:8017'
  assert.equal(key(backendSources('cli', { JEV_HOOKS_URL: lan }, { keyFile: 'from-file' })), 'from-file')
  assert.equal(key(backendSources('cli', { JEV_HOOKS_URL: lan, JEV_HOOKS_KEY: 'from-env' }, { keyFile: 'from-file' })), 'from-env')
  // the TypeSafe key does not go to the Spark in clear text
  assert.equal(key(backendSources('cli', { JEV_HOOKS_URL: lan, TYPESAFE_API_KEY: 'ts' })), '')
  const tsOnly = resolveBackend(backendSources('cli', { TYPESAFE_API_KEY: 'ts' }))
  assert.ok(tsOnly.ok && tsOnly.value.url === 'https://api.typesafe.ai/v1/systemone' && tsOnly.value.key === 'ts')
  // explicit --url: the key only from a layer with the same origin
  assert.equal(key(backendSources('cli', { JEV_HOOKS_URL: lan, JEV_HOOKS_KEY: 'k' }, { explicitUrl: 'http://127.0.0.1:9' })), '')
  assert.equal(key(backendSources('cli', { JEV_HOOKS_URL: lan, JEV_HOOKS_KEY: 'k' }, { explicitUrl: `${lan}/v1` })), 'k')
})

test('hook and skill: userConfig with the key file, JEV_HOOKS_KEY only for JEV_HOOKS_URL', () => {
  const env = { CLAUDE_PLUGIN_OPTION_REVIEW_URL: 'http://192.168.1.50:8017', JEV_HOOKS_URL: 'http://10.0.0.5:8017', JEV_HOOKS_KEY: 'k-env' }
  assert.equal(key(backendSources('hook', env, { keyFile: 'from-file' })), 'from-file')
  assert.equal(key(backendSources('skill', env)), '', 'the JEV_HOOKS_* key does not go to the userConfig URL')
  assert.equal(key(backendSources('hook', { ...env, CLAUDE_PLUGIN_OPTION_API_KEY: 'k-opt' }, { keyFile: 'from-file' })), 'k-opt')
})

test('backendFrom: explicit --model, CLI messages without /plugin', () => {
  const b = backendFrom(backendSources('cli', { JEV_HOOKS_URL: 'http://127.0.0.1:9' }), 'rizzo-latest').backend as Backend
  assert.equal(b.model, 'rizzo-latest')
  const long = backendFrom(backendSources('cli', { JEV_HOOKS_URL: 'http://127.0.0.1:9' }), 'm'.repeat(129)).backend as Failure
  assert.equal(long.kind, 'config')
  const empty = backendFrom(backendSources('cli', {}), undefined, 'cli').backend as Failure
  assert.equal(empty.kind, 'not_configured')
  assert.match(empty.message, /JEV_HOOKS_URL/)
  assert.doesNotMatch(empty.message, /\/plugin/)
  const ts = backendFrom(backendSources('cli', {}, { explicitUrl: 'https://api.typesafe.ai' }), undefined, 'cli').backend as Failure
  assert.match(ts.message, /TYPESAFE_API_KEY/)
  assert.match((backendFrom(backendSources('hook', {}), undefined, 'hook').backend as Failure).message, /\/plugin/)
})

test('runReview: diff as text, explicit title, project detectors in the Worker', () => withFake({}, async (f) => {
  const t = tempDir()
  try {
    mkdirSync(join(t.dir, '.jev-hooks'))
    writeFileSync(join(t.dir, '.jev-hooks', 'policy.json'), JSON.stringify({
      detectors: [{ name: 'project_word', label: 'Word forbidden by the project', where: ['added_lines'], regex: 'project-bad-word', floor: 'NITS', escalate: 'never' }],
    }))
    const r = await runReview({
      origin: 'cli', cwd: t.dir, source: { kind: 'text', diff: DIFF, title: 'from the source', description: null },
      sources: backendSources('cli', { JEV_HOOKS_URL: f.url }), pluginRoot: ROOT, start: performance.now(), env: t.env,
      title: 'Double the values',
    })
    assert.equal(r.title, 'Double the values')
    assert.equal(r.result.outcome, 'ok')
    assert.equal(r.result.lane, 'NITS')
    // no trusted layer knows the project's name: the result holds the position in the
    // file's detectors list
    assert.ok(r.result.hits.some((c) => c.detector === 'project_detector_1' && c.line === 2))
    assert.ok(r.result.fired.some((s) => s.source === 'floor' && s.check === 'project_detector_1'))
    assert.ok(!JSON.stringify(r.result).includes('project_word'))
    assert.equal(r.result.requests, 2)
    const global = f.requests.map((x) => String((x.json as { state?: string }).state)).find((s) => s.startsWith('[title]'))
    assert.match(global ?? '', /Double the values/)
    // who answered: in the result as a hash, for the log with the real names
    assert.equal(r.result.backend.model, shortHash('rizzo-spark-x2.5-4b-bf16'))
    assert.equal(r.result.backend.fingerprint, shortHash('fake-fp-1'))
    assert.equal(r.identity?.model, 'rizzo-spark-x2.5-4b-bf16')
    assert.equal(r.identity?.fingerprint, 'fake-fp-1')
  } finally {
    t.close()
  }
}))

test('runReview: an unreadable diff gives an error outcome and exit 4, without requests', () => withFake({}, async (f) => {
  const t = tempDir()
  try {
    const r = await runReview({
      origin: 'cli', cwd: t.dir, source: { kind: 'ref', ref: 'main' }, sources: backendSources('cli', { JEV_HOOKS_URL: f.url }),
      pluginRoot: ROOT, start: performance.now(), env: t.env,
    })
    assert.equal(r.result.outcome, 'error')
    assert.equal(r.result.exit_code, 4)
    assert.equal(r.result.error?.kind, 'git')
    assert.equal(f.requests.length, 0)
  } finally {
    t.close()
  }
}))

test('status probe: models, fingerprint, profile; wrong key; missing backend', () => withFake({ key: 'right' }, async (f) => {
  const t = tempDir()
  try {
    const cfg = config(t.dir, t.env)
    const ok = await probeStatus({ config: cfg, sources: backendSources('cli', { JEV_HOOKS_URL: f.url, JEV_HOOKS_KEY: 'right' }) })
    if (!ok.ok) assert.fail(ok.error.message)
    // the names the backend gives itself: known ones as they are (the requested model,
    // the rizzo-flow aliases), the others as a hash (the real name is in the log)
    assert.equal(ok.value.requestedModel, 'jev-latest')
    assert.equal(ok.value.model, shortHash('rizzo-spark-x2.5-4b-bf16'))
    assert.equal(ok.value.fingerprint, shortHash('fake-fp-1'))
    assert.deepEqual(ok.value.probabilityStatus, [shortHash('uncalibrated_conditional_option_scores')])
    assert.equal(ok.value.profile, 'rizzo-provisional')
    assert.equal(ok.value.family, 'rizzo')
    assert.deepEqual(ok.value.models, ['rizzo-latest', shortHash('rizzo-spark-x2.5-4b-bf16')])
    assert.equal(ok.value.question, 'hardcoded_secret')
    const state = f.requests.find((x) => x.path === '/v1/systemone')
    assert.equal((state?.json as { state?: string }).state, 'jev-status: backend probe decision, no diff')

    const ko = await probeStatus({ config: cfg, sources: backendSources('cli', { JEV_HOOKS_URL: f.url, JEV_HOOKS_KEY: 'wrong' }) })
    assert.equal(ko.ok, false)
    if (!ko.ok) {
      assert.equal(ko.error.kind, 'auth')
      assert.ok(!ko.error.message.includes('wrong'))
    }
    const none = await probeStatus({ config: cfg, sources: backendSources('cli', {}), origin: 'cli' })
    assert.equal(none.ok, false)
    if (!none.ok) assert.equal(none.error.kind, 'not_configured')
  } finally {
    t.close()
  }
}))

// An OpenAI-style backend lists its models as { object: "list", data: [{ id }] }. The
// rename of the identifiers once turned the wire field "data" into "date", and the
// status then said "response not recognized" for every such backend.
test('status probe: the OpenAI-style model list is read from its data field', () => withFake({}, async (f) => {
  const t = tempDir()
  try {
    const list = JSON.stringify({ object: 'list', data: [{ id: 'jev-latest', object: 'model' }] })
    const s = await probeStatus({
      config: config(t.dir, t.env),
      sources: backendSources('cli', { JEV_HOOKS_URL: f.url }),
      read: async () => ({ kind: 'response', status: 200, text: list, ms: 1 }),
    })
    if (!s.ok) assert.fail(s.error.message)
    assert.deepEqual(s.value.models, ['jev-latest'])
    assert.equal(s.value.modelsNote, undefined)
  } finally {
    t.close()
  }
}))
