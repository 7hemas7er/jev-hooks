// The GitHub Action as the runner starts it: `node action/entry.mjs` with INPUT_* and
// GITHUB_* in the environment, a fake GitHub API, the fake backend, a temporary checkout
// of the default branch as the workspace, and temporary GITHUB_OUTPUT and
// GITHUB_STEP_SUMMARY files.
//
// What matters: a check run is always published once the event names a head sha; the
// pull request comes from the trusted payload, never from the artifact; the reviewed
// diff is the API's; everything the PR author controls or can break ends in failure,
// only a backend that is down or not configured in neutral; the key is masked.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFake, REFUSED_URL } from '../helpers/fake-systemone.ts'
import type { FakeServer, Scenario } from '../helpers/fake-systemone.ts'
import { createRepo } from '../helpers/git-repo.ts'
import { generator, injectionPhrase, stripeLiveKey } from '../helpers/fake-secrets.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = join(ROOT, 'action', 'entry.mjs')
const KEY = 'fake-key-Wm4pX9bQ2sRt'
const GH_TOKEN = 'fake-gh-token-Qp3rT8'
const APP_TOKEN = 'fake-app-token-Ld6nY2'
const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const REPO = 'acme/app'

const SCENARIO: Scenario = { rules: [{ if_state_contains: 'console.log', answers: { debug_leftovers: 0.96 } }] }
const rnd = generator(20260928)

let base = ''
let backend: FakeServer

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-action-'))
  backend = await startFake({ scenario: SCENARIO })
})

after(async () => {
  await backend?.close()
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

// ─── Fake GitHub ──────────────────────────────────────────────────────────────

interface Seen { method: string; path: string; auth: string; accept: string; body: string }

interface GitHub {
  url: string
  seen: Seen[]
  checkRuns: () => Record<string, unknown>[]
  close: () => Promise<void>
}

interface World {
  pulls?: unknown[]
  diff?: string
  compareStatus?: number
  checkStatus?: number
}

function pull(o: { number?: number; headRepo?: string; baseRepo?: string; head?: string; title?: string; body?: string } = {}): unknown {
  return {
    number: o.number ?? 7, title: o.title ?? 'Add the app', body: o.body ?? 'A small change.',
    head: { sha: o.head ?? HEAD, repo: { full_name: o.headRepo ?? 'contrib/app' } },
    base: { sha: BASE, repo: { full_name: o.baseRepo ?? REPO } },
  }
}

async function startGitHub(w: World): Promise<GitHub> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (s: string) => { body += s })
    req.on('end', () => {
      const path = req.url ?? ''
      seen.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), accept: String(req.headers.accept ?? ''), body })
      if (req.method === 'GET' && path.startsWith(`/repos/${REPO}/pulls?`)) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(w.pulls ?? [pull()]))
      } else if (req.method === 'GET' && path === `/repos/${REPO}/compare/${BASE}...${HEAD}`) {
        const status = w.compareStatus ?? 200
        res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? w.diff ?? '' : '{"message":"too large"}')
      } else if (req.method === 'POST' && path === `/repos/${REPO}/check-runs`) {
        res.writeHead(w.checkStatus ?? 201, { 'content-type': 'application/json' }).end('{"id":1}')
      } else res.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    checkRuns: () => seen.filter((s) => s.method === 'POST').map((s) => JSON.parse(s.body)),
    close: () => new Promise((ok) => server.close(() => ok())),
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function added(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), '',
  ].join('\n')
}

const NITS_DIFF = added('src/app.js', ['function f() {', '  console.log("debug")', '}'])

let counter = 0
interface Trial { dir: string; workspace: string; inputDir: string; output: string; summary: string; close: () => void }

function trial(o: { artifact?: { pr?: unknown; diff?: string } | null } = {}): Trial {
  const dir = join(base, `t-${++counter}`)
  mkdirSync(dir)
  const r = createRepo()
  r.write('README.md', 'project\n')
  r.commit('first')
  const inputDir = join(dir, 'jev-input')
  if (o.artifact !== null) {
    mkdirSync(inputDir)
    const pr = o.artifact?.pr ?? { schema: 1, pr: 7, base_sha: BASE, head_sha: HEAD }
    writeFileSync(join(inputDir, 'pr.json'), `${JSON.stringify(pr)}\n`)
    writeFileSync(join(inputDir, 'diff.patch'), o.artifact?.diff ?? NITS_DIFF)
  }
  return { dir, workspace: r.dir, inputDir, output: join(dir, 'output'), summary: join(dir, 'summary'), close: () => r.close() }
}

function event(t: Trial, o: { conclusion?: string; event?: string; head?: string } = {}): string {
  const p = join(t.dir, 'event.json')
  writeFileSync(p, JSON.stringify({
    action: 'completed',
    workflow_run: {
      id: 42, event: o.event ?? 'pull_request', conclusion: o.conclusion ?? 'success', head_sha: o.head ?? HEAD, head_branch: 'feature',
      head_repository: { full_name: 'contrib/app', owner: { login: 'contrib' } }, pull_requests: [],
    },
  }))
  return p
}

interface Execution { code: number; out: string; err: string; outputs: Record<string, string>; summary: string }

function action(t: Trial, gh: GitHub | null, inputs: Record<string, string>, o: { nodeFlags?: string[]; eventPath?: string } = {}): Promise<Execution> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(t.dir, 'home'), TMPDIR: tmpdir(),
    GITHUB_EVENT_PATH: o.eventPath ?? event(t), GITHUB_REPOSITORY: REPO, GITHUB_WORKSPACE: t.workspace,
    GITHUB_OUTPUT: t.output, GITHUB_STEP_SUMMARY: t.summary,
    'INPUT_MODE': 'workflow_run', 'INPUT_INPUT-DIR': t.inputDir, 'INPUT_URL': backend.url, 'INPUT_API-KEY': KEY,
    'INPUT_MODEL': 'jev-latest', 'INPUT_GITHUB-TOKEN': GH_TOKEN, 'INPUT_CHECKS-TOKEN': '', 'INPUT_DIFF-FILE': '',
  }
  if (gh) env.GITHUB_API_URL = gh.url
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, [...(o.nodeFlags ?? []), '--disable-warning=ExperimentalWarning', ENTRY], { env, cwd: t.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (s: string) => { out += s })
    p.stderr.on('data', (s: string) => { err += s })
    p.on('error', ko)
    p.on('close', (code) => {
      const outputs: Record<string, string> = {}
      if (existsSync(t.output)) {
        const text = readFileSync(t.output, 'utf8')
        for (const m of text.matchAll(/^([a-z]+)<<(ghadelimiter_[0-9a-f-]+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3]
      }
      ok({ code: code ?? -1, out, err, outputs, summary: existsSync(t.summary) ? readFileSync(t.summary, 'utf8') : '' })
    })
  })
}

const reviews = (): number => backend.requests.filter((x) => x.path === '/v1/systemone').length

// The one check run of a run, on the head sha, completed.
function checkRun(gh: GitHub): { conclusion: string; output: { title: string; summary: string } } {
  const runs = gh.checkRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].name, 'jev-review')
  assert.equal(runs[0].head_sha, HEAD)
  assert.equal(runs[0].status, 'completed')
  return runs[0] as { conclusion: string; output: { title: string; summary: string } }
}

// The key shows only in the ::add-mask:: line, which the runner consumes.
function keyMasked(e: Execution, gh: GitHub | null): void {
  const lines = e.out.split('\n').filter((l) => l.includes(KEY))
  assert.deepEqual(lines, [`::add-mask::${KEY}`])
  assert.ok(!e.err.includes(KEY))
  assert.ok(!JSON.stringify(e.outputs).includes(KEY) && !e.summary.includes(KEY))
  if (gh) for (const s of gh.seen) assert.ok(!s.body.includes(KEY) && !s.auth.includes(KEY))
}

async function withGitHub(w: World, fn: (gh: GitHub) => Promise<void>): Promise<void> {
  const gh = await startGitHub(w)
  try {
    await fn(gh)
  } finally {
    await gh.close()
  }
}

// ─── workflow_run ─────────────────────────────────────────────────────────────

test('NITS: the API diff reviewed, a success check run, outputs and summary written, the key masked', async () => {
  const t = trial()
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const before = reviews()
      const e = await action(t, gh, {})
      assert.equal(e.code, 0, e.out + e.err)
      const c = checkRun(gh)
      assert.equal(c.conclusion, 'success')
      assert.match(c.output.title, /^NITS: debug_leftovers/)
      assert.match(c.output.summary, /^## NITS/)
      assert.match(c.output.summary, /Check conclusion: \*\*success\*\*$/)
      assert.deepEqual(e.outputs, { verdict: 'NITS', conclusion: 'success', escalation: '' })
      assert.match(e.summary, /^## NITS/)
      assert.ok(reviews() > before)
      // the pull request found by owner:branch, the diff asked between the two SHAs
      const list = gh.seen.find((s) => s.path.startsWith(`/repos/${REPO}/pulls?`))
      assert.match(list?.path ?? '', /head=contrib%3Afeature/)
      const cmp = gh.seen.find((s) => s.path.includes('/compare/'))
      assert.equal(cmp?.accept, 'application/vnd.github.diff')
      for (const s of gh.seen) assert.equal(s.auth, `Bearer ${GH_TOKEN}`)
      keyMasked(e, gh)
    })
  } finally {
    t.close()
  }
})

test('a live key in the diff → BLOCK from the floor, failure', async () => {
  const t = trial()
  const diff = added('src/pay.py', [`STRIPE = "${stripeLiveKey(rnd)}"`])
  try {
    await withGitHub({ diff }, async (gh) => {
      const e = await action(t, gh, {})
      assert.equal(e.code, 0)
      assert.equal(checkRun(gh).conclusion, 'failure')
      assert.equal(e.outputs.verdict, 'BLOCK')
    })
  } finally {
    t.close()
  }
})

test('backend not configured or unreachable → neutral, with the reason; not configured sends nothing', async () => {
  const t1 = trial()
  const t2 = trial()
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const before = reviews()
      const e = await action(t1, gh, { url: '' })
      assert.equal(e.code, 0)
      const c = checkRun(gh)
      assert.equal(c.conclusion, 'neutral')
      assert.match(c.output.summary, /backend not configured: set the url input/)
      assert.match(c.output.summary, /Check conclusion: \*\*neutral\*\* \(backend_unavailable/)
      assert.equal(reviews(), before)
    })
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const e = await action(t2, gh, { url: REFUSED_URL })
      assert.equal(e.code, 0)
      assert.equal(checkRun(gh).conclusion, 'neutral')
    })
  } finally {
    t1.close()
    t2.close()
  }
})

test('the first phase failed, or the pull request cannot be identified → failure, no diff read, no review', async () => {
  const cases: { name: string; world: World; event?: { conclusion?: string } }[] = [
    { name: 'first phase failed', world: {}, event: { conclusion: 'failure' } },
    { name: 'no pull request', world: { pulls: [] } },
    { name: 'two pull requests', world: { pulls: [pull(), pull({ number: 8 })] } },
    { name: 'head sha of another push', world: { pulls: [pull({ head: 'c'.repeat(40) })] } },
    { name: 'same branch name in another fork', world: { pulls: [pull({ headRepo: 'mallory/app' })] } },
    { name: 'a pull request towards another repository', world: { pulls: [pull({ baseRepo: 'other/app' })] } },
  ]
  for (const c of cases) {
    const t = trial()
    try {
      await withGitHub({ diff: NITS_DIFF, ...c.world }, async (gh) => {
        const before = reviews()
        const e = await action(t, gh, {}, c.event ? { eventPath: event(t, c.event) } : {})
        assert.equal(e.code, 0, c.name)
        const r = checkRun(gh)
        assert.equal(r.conclusion, 'failure', c.name)
        assert.match(r.output.summary, /untrusted_input/, c.name)
        assert.equal(e.outputs.verdict, 'ERROR', c.name)
        assert.ok(!gh.seen.some((s) => s.path.includes('/compare/')), c.name)
        assert.equal(reviews(), before, c.name)
      })
    } finally {
      t.close()
    }
  }
})

test('a missing, malformed or foreign artifact → failure without a review', async () => {
  const good = { schema: 1, pr: 7, base_sha: BASE, head_sha: HEAD }
  const cases: { name: string; artifact?: { pr?: unknown; diff?: string } | null; prepare?: (t: Trial) => void }[] = [
    { name: 'missing', artifact: null },
    { name: 'another pull request', artifact: { pr: { ...good, pr: 8 } } },
    { name: 'another head sha', artifact: { pr: { ...good, head_sha: 'c'.repeat(40) } } },
    { name: 'an extra field', artifact: { pr: { ...good, url: 'https://example.invalid' } } },
    { name: 'pr as a string', artifact: { pr: { ...good, pr: '7' } } },
    { name: 'an extra file', prepare: (t) => writeFileSync(join(t.inputDir, 'run.sh'), 'id\n') },
    { name: 'a link', prepare: (t) => { rmSync(join(t.inputDir, 'diff.patch')); symlinkSync('/etc/hostname', join(t.inputDir, 'diff.patch')) } },
    { name: 'a large pr.json', prepare: (t) => writeFileSync(join(t.inputDir, 'pr.json'), JSON.stringify({ ...good, x: 'y'.repeat(2000) })) },
  ]
  for (const c of cases) {
    const t = trial(c.artifact !== undefined ? { artifact: c.artifact } : {})
    try {
      c.prepare?.(t)
      await withGitHub({ diff: NITS_DIFF }, async (gh) => {
        const before = reviews()
        const e = await action(t, gh, {})
        assert.equal(e.code, 0, c.name)
        const r = checkRun(gh)
        assert.equal(r.conclusion, 'failure', c.name)
        assert.match(r.output.title, /first-phase artifact/, c.name)
        assert.equal(reviews(), before, c.name)
      })
    } finally {
      t.close()
    }
  }
})

test("the artifact's diff differs from the API's: the API's is reviewed, with a note", async () => {
  const t = trial({ artifact: { diff: added('README.md', ['harmless']) } })
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const e = await action(t, gh, {})
      assert.equal(e.code, 0)
      const r = checkRun(gh)
      assert.match(r.output.title, /^NITS/)
      assert.match(r.output.summary, /the first phase's diff differs from the real one/)
    })
  } finally {
    t.close()
  }
})

test('a diff too large for the API or for max_diff_bytes → failure, never the artifact', async () => {
  const t1 = trial()
  const t2 = trial()
  try {
    await withGitHub({ compareStatus: 406 }, async (gh) => {
      await action(t1, gh, {})
      assert.equal(checkRun(gh).conclusion, 'failure')
    })
    // just over the default max_diff_bytes (4,000,000): the cap is not the project's to change
    const big = NITS_DIFF + added('src/data.js', Array.from({ length: 2100 }, () => `// ${'x'.repeat(1990)}`))
    await withGitHub({ diff: big }, async (gh) => {
      const before = reviews()
      await action(t2, gh, {})
      const r = checkRun(gh)
      assert.equal(r.conclusion, 'failure')
      assert.match(r.output.title, /diff too large/)
      assert.equal(reviews(), before)
    })
  } finally {
    t1.close()
    t2.close()
  }
})

test('a hostile title and description reach neither the check run nor the log, except the title in a code span', async () => {
  const t = trial()
  const title = 'Fix `x` <img src=x onerror=alert(1)> [link](https://example.invalid)'
  try {
    await withGitHub({ diff: NITS_DIFF, pulls: [pull({ title, body: injectionPhrase() })] }, async (gh) => {
      const e = await action(t, gh, {})
      assert.equal(e.code, 0)
      const r = checkRun(gh)
      assert.ok(!r.output.summary.includes(injectionPhrase()))
      assert.ok(!e.out.includes(injectionPhrase()))
      // the title only inside a code span, its own backticks removed so it cannot close it
      const line = r.output.summary.split('\n').find((l) => l.startsWith('PR: ')) ?? ''
      assert.match(line, /^PR: `[^`]*`$/)
    })
  } finally {
    t.close()
  }
})

test('checks-token creates the check run; a failed creation exits 1', async () => {
  const t1 = trial()
  const t2 = trial()
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const e = await action(t1, gh, { 'checks-token': APP_TOKEN })
      assert.equal(e.code, 0)
      assert.equal(gh.seen.find((s) => s.method === 'POST')?.auth, `Bearer ${APP_TOKEN}`)
      for (const s of gh.seen.filter((x) => x.method === 'GET')) assert.equal(s.auth, `Bearer ${GH_TOKEN}`)
    })
    await withGitHub({ diff: NITS_DIFF, checkStatus: 403 }, async (gh) => {
      const e = await action(t2, gh, {})
      assert.equal(e.code, 1)
      assert.match(e.out, /::error::jev-review: the check run was not created \(HTTP 403\)/)
    })
  } finally {
    t1.close()
    t2.close()
  }
})

test('an event that is not a workflow_run of a pull request, or no token → exit 1 without a check run', async () => {
  const t = trial()
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const e1 = await action(t, gh, {}, { eventPath: event(t, { event: 'push' }) })
      assert.equal(e1.code, 1)
      assert.match(e1.out, /::error::jev-review: the event is not a workflow_run/)
      const e2 = await action(t, gh, { 'github-token': '' })
      assert.equal(e2.code, 1)
      assert.equal(gh.checkRuns().length, 0)
    })
  } finally {
    t.close()
  }
})

test('a runtime without type stripping → a neutral check run that says why, exit 0', async () => {
  const t = trial()
  try {
    await withGitHub({ diff: NITS_DIFF }, async (gh) => {
      const e = await action(t, gh, {}, { nodeFlags: ['--no-experimental-strip-types'] })
      assert.equal(e.code, 0, e.out + e.err)
      const r = checkRun(gh)
      assert.equal(r.conclusion, 'neutral')
      assert.match(r.output.summary, /runtime without TypeScript support/)
    })
  } finally {
    t.close()
  }
})

// ─── file mode ────────────────────────────────────────────────────────────────

test('mode file: the diff reviewed without the GitHub API; a floor gives BLOCK with no backend', async () => {
  const t = trial()
  try {
    writeFileSync(join(t.dir, 'secret.diff'), added('src/pay.py', [`STRIPE = "${stripeLiveKey(rnd)}"`]))
    const e = await action(t, null, { mode: 'file', 'diff-file': join(t.dir, 'secret.diff'), url: '' })
    assert.equal(e.code, 0, e.out + e.err)
    assert.deepEqual([e.outputs.verdict, e.outputs.conclusion], ['BLOCK', 'failure'])
    assert.match(e.summary, /^## BLOCK/)
    keyMasked(e, null)
  } finally {
    t.close()
  }
})
