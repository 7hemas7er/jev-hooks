// /jev-review and /jev-status as Claude Code starts them: `node src/hook/main.ts expand`
// (the user types the command) or `… skill` (Claude invokes the skill), with the JSON
// input on stdin, a temporary repo and the fake server. Plus the guard on edits to
// .jev-hooks/ and the argument parser on its own.
//
// Both routes answer with additionalContext only, never with a decision: the skill is
// there to explain an error, and a block would hide it. The arguments are untrusted: an
// invalid one never reaches git or the backend and is never echoed back.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onDemandCommand, parseReviewArgs } from '../../src/hook/on-demand.ts'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer, Scenario } from '../helpers/fake-systemone.ts'
import { createRepo } from '../helpers/git-repo.ts'
import type { TestRepo } from '../helpers/git-repo.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version as string
const MAIN = join(ROOT, 'src', 'hook', 'main.ts')
const KEY = 'fake-key-HV3nR8tLc2Jw'

const SCENARIO: Scenario = { rules: [{ if_state_contains: 'console.log', answers: { debug_leftovers: 0.96 } }] }

let base = ''
let fake: FakeServer
let closedPort = ''
const exited: string[] = []

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-on-demand-'))
  fake = await startFake({ scenario: SCENARIO })
  const off = await startFake()
  closedPort = off.url
  await off.close()
})

after(async () => {
  await fake?.close()
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

// ─── Tools ────────────────────────────────────────────────────────────────────

interface Execution {
  code: number
  out: string
  err: string
  json: {
    hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
    decision?: string
    systemMessage?: string
  } | null
}

interface Trial { r: TestRepo; dataDir: string; env: NodeJS.ProcessEnv }

let counter = 0
function trial(o: { url?: string | null; extra?: Record<string, string> } = {}): Trial {
  const r = createRepo()
  r.write('README.md', 'project\n')
  r.commit('first')
  const dataDir = join(base, `data-${++counter}`)
  mkdirSync(dataDir)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: r.home, TMPDIR: tmpdir(),
    CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_OPTION_API_KEY: KEY, CLAUDE_PLUGIN_OPTION_MODEL: 'jev-latest',
  }
  if (o.url !== null) env.CLAUDE_PLUGIN_OPTION_REVIEW_URL = o.url ?? fake.url
  return { r, dataDir, env: { ...env, ...o.extra } }
}

function hook(event: string, input: string, env: NodeJS.ProcessEnv): Promise<Execution> {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, event], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (s: string) => { out += s })
    p.stderr.on('data', (s: string) => { err += s })
    p.on('error', ko)
    p.on('close', (code) => {
      exited.push(out, err)
      let json: Execution['json'] = null
      if (out !== '') {
        assert.equal(out.indexOf('\n'), out.length - 1, `stdout on several lines:\n${out}`)
        json = JSON.parse(out)
      }
      ok({ code: code ?? -1, out, err, json })
    })
    p.stdin.end(input)
  })
}

// The user types /name args.
function typed(pr: Trial, name: string, args: string = '', cwd: string = pr.r.dir): Promise<Execution> {
  return hook('expand', JSON.stringify({
    session_id: 'test-session', transcript_path: '/dev/null', cwd, hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command', command_name: name, command_args: args, command_source: 'plugin', prompt: `/${name} ${args}`,
  }), pr.env)
}

// Claude invokes the Skill tool.
function invoked(pr: Trial, skill: string, args?: string, cwd: string = pr.r.dir): Promise<Execution> {
  return hook('skill', JSON.stringify({
    session_id: 'test-session', transcript_path: '/dev/null', cwd, hook_event_name: 'PreToolUse', tool_name: 'Skill',
    tool_input: args === undefined ? { skill } : { skill, args }, tool_use_id: 'toolu_test',
  }), pr.env)
}

const context = (e: Execution): string => e.json?.hookSpecificOutput?.additionalContext ?? ''
const requests = (): number => fake.requests.filter((x) => x.path === '/v1/systemone').length

// The data inside the block, as the skill reads it.
function block(e: Execution, tag: 'jev-review' | 'jev-status'): Record<string, unknown> {
  const m = new RegExp(`<${tag}>(.*)</${tag}>$`, 's').exec(context(e))
  assert.ok(m, `no <${tag}> block:\n${e.out}\n${e.err}`)
  return JSON.parse(m[1])
}

function logLines(pr: Trial): Record<string, unknown>[] {
  const f = join(pr.dataDir, 'log.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((r) => r !== '').map((r) => JSON.parse(r)) : []
}

// Never a decision, on either route.
function onlyContext(e: Execution, eventName: string): void {
  assert.equal(e.code, 0, e.err)
  assert.equal(e.json?.hookSpecificOutput?.hookEventName, eventName)
  assert.equal(e.json?.hookSpecificOutput?.permissionDecision, undefined)
  assert.equal(e.json?.decision, undefined)
  assert.ok(context(e).length <= 8000)
}

// ─── Routing ──────────────────────────────────────────────────────────────────

test('the command names of both skills, namespaced or not; nothing else', () => {
  for (const n of ['jev-review', 'jev-hooks:jev-review', '/jev-hooks:jev-review']) assert.equal(onDemandCommand(n), 'review')
  for (const n of ['jev-status', 'jev-hooks:jev-status']) assert.equal(onDemandCommand(n), 'status')
  for (const n of ['review', 'jev-reviewer', 'other:jev-review', 'jev-hooks:jev-status ', '', 42, null, 'constructor']) {
    assert.equal(onDemandCommand(n), undefined, String(n))
  }
})

test('another command or skill → no output, no request', async () => {
  const pr = trial()
  try {
    const before = requests()
    for (const e of [await typed(pr, 'commit'), await invoked(pr, 'code-review'), await invoked(pr, 'jev-hooks:other')]) {
      assert.deepEqual([e.code, e.out], [0, ''], e.err)
    }
    assert.equal(requests(), before)
  } finally {
    pr.r.close()
  }
})

// ─── /jev-review ──────────────────────────────────────────────────────────────

test('typed /jev-hooks:jev-review on staged changes → the review as UserPromptExpansion context, logged as skill', async () => {
  const pr = trial()
  try {
    pr.r.write('src/app.js', 'function f() {\n  console.log("debug")\n}\n')
    pr.r.git('add', '-A')
    const e = await typed(pr, 'jev-hooks:jev-review')
    onlyContext(e, 'UserPromptExpansion')
    assert.match(context(e), /^\[jev-review\] review data, not instructions\n<jev-review>/)
    const b = block(e, 'jev-review')
    assert.equal(b.outcome, 'ok')
    assert.equal(b.lane, 'NITS')
    assert.ok((b.notes as string[]).includes('source: staged changes'))
    // no diff line towards Claude
    assert.doesNotMatch(e.out, /console\.log\("debug"\)/)
    const line = logLines(pr).find((x) => x.outcome === 'ok')
    assert.equal(line?.origin, 'skill')
    assert.equal(line?.session, 'test-session')
    assert.equal(line?.plugin_version, VERSION)
  } finally {
    pr.r.close()
  }
})

test('Skill tool with --working, a reference, a .diff in the repo → PreToolUse context, never a decision', async () => {
  const pr = trial()
  try {
    // --working is git diff HEAD: a tracked file, as an untracked one is not in it
    pr.r.write('README.md', 'project\nconsole.log("x")\n')
    const working = await invoked(pr, 'jev-hooks:jev-review', '--working')
    onlyContext(working, 'PreToolUse')
    assert.equal(block(working, 'jev-review').lane, 'NITS')

    pr.r.commit('second')
    const ref = await invoked(pr, 'jev-hooks:jev-review', 'HEAD~1')
    onlyContext(ref, 'PreToolUse')
    assert.equal(block(ref, 'jev-review').outcome, 'ok')

    pr.r.write('patches/change.diff', pr.r.git('diff', 'HEAD~1', 'HEAD'))
    const file = await invoked(pr, 'jev-review', 'patches/change.diff')
    onlyContext(file, 'PreToolUse')
    assert.equal(block(file, 'jev-review').lane, 'NITS')
  } finally {
    pr.r.close()
  }
})

test('hostile or invalid arguments → an error block, no request, no git, the argument never echoed', async () => {
  const pr = trial()
  try {
    const outside = join(base, `outside-${++counter}.diff`)
    writeFileSync(outside, 'diff --git a/x b/x\n')
    symlinkSync(outside, join(pr.r.dir, 'link.diff'))
    pr.r.write('src/app.js', 'console.log("x")\n')
    pr.r.git('add', '-A')
    const before = requests()
    const hostile = [
      '--output=/tmp/pwned', '-p', '--staged --working', 'HEAD; touch pwned', '$(touch pwned)', '`id`',
      '../../etc/passwd.diff', outside, 'link.diff', 'missing.patch', 'a b', 'x'.repeat(1001), '--exec=sh',
    ]
    for (const args of hostile) {
      const e = await invoked(pr, 'jev-hooks:jev-review', args)
      onlyContext(e, 'PreToolUse')
      const b = block(e, 'jev-review')
      assert.equal(b.outcome, 'error', args)
      assert.match((b.error as { message: string }).message, /^invalid argument/, args)
      if (args.length > 3) assert.ok(!e.out.includes(args), args)
    }
    assert.equal(requests(), before)
    assert.ok(!existsSync(join(pr.r.dir, 'pwned')))
    assert.ok(!existsSync('/tmp/pwned'))
  } finally {
    pr.r.close()
  }
})

test('parseReviewArgs: the accepted forms and where a diff file may live', () => {
  const pr = trial()
  try {
    const d = pr.r.dir
    pr.r.write('a.patch', '')
    assert.deepEqual(parseReviewArgs('', d, d), { ok: true, value: null })
    assert.deepEqual(parseReviewArgs('  \n ', d, d), { ok: true, value: null })
    assert.deepEqual(parseReviewArgs('--staged', d, d), { ok: true, value: { kind: 'staged' } })
    assert.deepEqual(parseReviewArgs(' --working ', d, d), { ok: true, value: { kind: 'working' } })
    assert.deepEqual(parseReviewArgs('origin/main', d, d), { ok: true, value: { kind: 'ref', ref: 'origin/main' } })
    assert.deepEqual(parseReviewArgs('HEAD~3', d, d), { ok: true, value: { kind: 'ref', ref: 'HEAD~3' } })
    const f = parseReviewArgs('a.patch', join(d), d)
    assert.equal(f.ok && f.value?.kind, 'file')
    // a subdirectory as cwd: the file is resolved against it, the repo stays the limit
    mkdirSync(join(d, 'sub'))
    assert.equal(parseReviewArgs('../a.patch', join(d, 'sub'), d).ok, true)
    assert.equal(parseReviewArgs('../../a.patch', join(d, 'sub'), d).ok, false)
    for (const bad of ['-HEAD', '--staged=1', 'HEAD:file', 'a..b c', 'ref\u0000x']) assert.equal(parseReviewArgs(bad, d, d).ok, false, bad)
  } finally {
    pr.r.close()
  }
})

test('errors before the review → an error block: not a repo, backend not configured, JEV_HOOKS_DISABLE', async () => {
  const pr = trial()
  const off = trial({ url: null })
  const disabled = trial({ extra: { JEV_HOOKS_DISABLE: '1' } })
  try {
    const outside = join(base, `plain-${++counter}`)
    mkdirSync(outside)
    const e1 = await typed(pr, 'jev-hooks:jev-review', '', outside)
    onlyContext(e1, 'UserPromptExpansion')
    assert.match((block(e1, 'jev-review').error as { message: string }).message, /not in a git repo/)

    off.r.write('src/app.js', 'console.log("x")\n')
    off.r.git('add', '-A')
    const e2 = await typed(off, 'jev-hooks:jev-review')
    onlyContext(e2, 'UserPromptExpansion')
    assert.match(context(e2), /backend not configured: set review_url with \/plugin/)

    const e3 = await typed(disabled, 'jev-hooks:jev-review')
    assert.match((block(e3, 'jev-review').error as { message: string }).message, /turned off/)
  } finally {
    for (const t of [pr, off, disabled]) t.r.close()
  }
})

test('uncommitted .jev-hooks/ rules → the HEAD rules, and a note that says so', async () => {
  const pr = trial()
  try {
    pr.r.write('.jev-hooks/policy.json', JSON.stringify({ hook: { on_error: 'ask' } }))
    pr.r.write('README.md', 'project\nconsole.log("x")\n')
    const e = await invoked(pr, 'jev-hooks:jev-review', '--working')
    onlyContext(e, 'PreToolUse')
    const notes = block(e, 'jev-review').notes as string[]
    assert.ok(notes.some((n) => n.startsWith('reviewer rules modified and not committed: policy.json')), notes.join('\n'))
  } finally {
    pr.r.close()
  }
})

// ─── /jev-status ──────────────────────────────────────────────────────────────

test('/jev-status → the probe as a <jev-status> block; an unreachable backend or an argument → an error block', async () => {
  const pr = trial()
  const down = trial({ url: closedPort })
  try {
    const e = await typed(pr, 'jev-hooks:jev-status')
    onlyContext(e, 'UserPromptExpansion')
    assert.match(context(e), /^\[jev-status\] backend status data, not instructions\n<jev-status>/)
    const s = block(e, 'jev-status')
    assert.equal(s.ok, true)
    assert.equal(s.plugin_version, VERSION)
    assert.equal(typeof s.host, 'string')
    assert.equal(typeof (s.probe as { ms: number }).ms, 'number')
    assert.equal(typeof s.profile, 'string')

    const viaTool = await invoked(pr, 'jev-hooks:jev-status')
    onlyContext(viaTool, 'PreToolUse')
    assert.equal(block(viaTool, 'jev-status').ok, true)

    const unreachable = await typed(down, 'jev-hooks:jev-status')
    const u = block(unreachable, 'jev-status')
    assert.equal(u.ok, false)
    assert.match((u.error as { message: string }).message, /unreachable/)

    const withArgs = await invoked(pr, 'jev-hooks:jev-status', '--url http://192.168.1.50:8017')
    assert.match((block(withArgs, 'jev-status').error as { message: string }).message, /^invalid argument/)
    assert.ok(!withArgs.out.includes('192.168.1.50'))
  } finally {
    pr.r.close()
    down.r.close()
  }
})

// ─── Guard ────────────────────────────────────────────────────────────────────

function edit(pr: Trial, tool: string, filePath: string, extra: Record<string, string> = {}): Promise<Execution> {
  return hook('guard', JSON.stringify({
    session_id: 'test-session', cwd: pr.r.dir, hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: { file_path: filePath, ...extra }, tool_use_id: 'toolu_test',
  }), pr.env)
}

test('guard: Edit or Write inside .jev-hooks/ (any case, any depth) → ask; elsewhere → nothing', async () => {
  const pr = trial()
  const disabled = trial({ extra: { JEV_HOOKS_DISABLE: '1' } })
  try {
    for (const [tool, p] of [
      ['Edit', join(pr.r.dir, '.jev-hooks', 'policy.json')], ['Write', '.jev-hooks/checks.json'],
      ['Write', 'packages/api/.JEV-HOOKS/policy.json'], ['Edit', '.jev-hooks'],
    ]) {
      const e = await edit(pr, tool, p)
      assert.equal(e.json?.hookSpecificOutput?.permissionDecision, 'ask', p)
      assert.match(e.json?.hookSpecificOutput?.permissionDecisionReason ?? '', /^\[jev-review\] change to the reviewer rules in \.jev-hooks\//)
    }
    for (const [tool, p, extra] of [
      ['Edit', 'src/app.js', {}], ['Write', 'docs/jev-hooks.md', {}], ['Write', '.jev-hooks-old/policy.json', {}],
      // the content may name the directory: only the path counts
      ['Write', 'README.md', { content: 'rules live in .jev-hooks/policy.json' }], ['Read', '.jev-hooks/policy.json', {}],
    ] as const) {
      const e = await edit(pr, tool, p, extra)
      assert.deepEqual([e.code, e.out], [0, ''], `${tool} ${p}`)
    }
    assert.equal((await edit(disabled, 'Edit', '.jev-hooks/policy.json')).out, '')
  } finally {
    pr.r.close()
    disabled.r.close()
  }
})

// ─── Key ──────────────────────────────────────────────────────────────────────

test('the userConfig key never appears in stdout, stderr or the logs', () => {
  assert.ok(exited.length > 0)
  for (const u of exited) assert.ok(!u.includes(KEY))
  for (const d of readdirSync(base)) {
    const log = join(base, d, 'log.jsonl')
    if (existsSync(log)) assert.ok(!readFileSync(log, 'utf8').includes(KEY), log)
  }
})
