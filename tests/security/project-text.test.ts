// The free text of the project layer does not reach Claude.
//
// A cloned repo with a .jev-hooks/ already committed is equal to HEAD: the "HEAD plus
// ask" rule does not fire, and its rules apply (only stricter, but they apply). Here
// the repo has phrases addressed to Claude in every text that checks.json and
// policy.json allow: labels, instructions, criteria, the options of a choice (keys),
// the levels of a score, the labels of added detectors; and, in a second repo with
// invalid files, in ids, names, unknown keys and values. The names of the added
// detectors, which are valid ids, are text of the repo too: project_detector_N in
// their place (tests/security/bypasses.test.ts tests the valid ids chosen by the repo).
// None of those phrases and none of those names must appear:
// - in the output of the commit hook, for every decision (BLOCK deny, escalation deny,
//   ask, context, systemMessage);
// - in the escalation prompt, in the CLI (--escalate, --json, terminal, explain);
// - in the text for the /jev-review skill (claudeContext and escalationPrompt),
//   with the configuration warnings the status skill could report.
// The labels of the user file instead stay: it is the "open a JSON" demo.
//
// The phrases are composed at runtime: none of them is in the repo in plain text.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { escalationPrompt } from '../../src/core/escalation.ts'
import { claudeContext, compactJson, checkRunMarkdown, hookReason, renderExplanation, renderTerminal } from '../../src/core/render.ts'
import type { ReviewResult } from '../../src/core/types.ts'
import { runReview, backendSources } from '../../src/node/run.ts'
import { loadConfig } from '../../src/node/file-config.ts'
import type { LoadedConfig } from '../../src/node/file-config.ts'
import { nodeClock } from '../../src/node/transport.ts'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer, Scenario } from '../helpers/fake-systemone.ts'
import { createRepo } from '../helpers/git-repo.ts'
import type { TestRepo } from '../helpers/git-repo.ts'
import { phrasesForClaude, generator, RE_MARKER, highEntropyValue } from '../helpers/fake-secrets.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'src', 'hook', 'main.ts')
const BIN = join(ROOT, 'bin', 'jev-review.mjs')
const json = (rel: string): any => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

const SCENARIO: Scenario = {
  rules: [
    { if_state_contains: 'SIGNING_KEY', answers: { hardcoded_secret: 0.874 } },
    // touches_auth 0.78: above the escalation threshold (the provisional profile does
    // not transform nouls). blast_radius at the highest level: a notable score enters
    // the context
    { if_state_contains: 'middleware', answers: { touches_auth: 0.78, blast_radius: 3 } },
  ],
}

let base = ''
let fake: FakeServer
const rnd = generator(20260926)

// ─── Hostile phrases ──────────────────────────────────────────────────────────

const PHRASES = phrasesForClaude(1000)
let next = 0
const used: string[] = []
function phrase(): string {
  const f = PHRASES[next++]
  assert.ok(f !== undefined, 'more phrases are needed')
  used.push(f)
  return f
}

// The names of the detectors added by hostilePolicy: valid ids, but chosen by the repo.
const PROJECT_NAMES = ['project_note', 'project_value']

// No phrase used, not even a piece: the initial marker, the whole phrase, its tail and
// its middle part (a phrase cut short, split by the line break or stripped of the bidi
// characters would leave at least one of these). And no project name.
function clean(where: string, text: string): void {
  assert.doesNotMatch(text, RE_MARKER, `${where}: a text of the project got this far:\n${text}`)
  for (const n of PROJECT_NAMES) assert.ok(!text.includes(n), `${where}: contains the name «${n}»:\n${text}`)
  for (const f of used) {
    const pieces = [f, f.slice(-24), ...f.split(/[\n\u202E]/).map((x) => x.trim()).filter((x) => x.length >= 12)]
    for (const p of pieces) assert.ok(!text.includes(p), `${where}: contains «${p}»:\n${text}`)
  }
}

// ─── The hostile repo ─────────────────────────────────────────────────────────

// The plugin's checks.json with a phrase in every text: the same ids, so the rules of
// the plugin's policy.json still match and the project file applies in full.
function hostileChecks(): Record<string, any> {
  const c = json('config/checks.json')
  for (const [id, d] of Object.entries<any>(c)) {
    if (id.startsWith('_')) continue
    d.label = phrase()
    if (d.source === 'computed') continue
    d.instructions = phrase()
    if (d.type === 'noul') d.criteria = { true: phrase(), false: phrase() }
    else if (d.type === 'score') d.criteria = d.criteria.map(() => phrase())
    // the options of a choice are keys: the fake server picks the first. A choice with
    // a value names the subtracted option, which is text of the repo too
    else {
      d.criteria = Object.fromEntries(Object.keys(d.criteria).map(() => [phrase(), phrase()]))
      if (d.value) d.value = `1-p(${Object.keys(d.criteria)[0]})`
    }
  }
  return c
}

// Two detectors added by the project, valid: one that fires on every diff and always
// asks for escalation, one tied to hardcoded_secret that disagrees with the model.
function hostilePolicy(): Record<string, unknown> {
  return {
    detectors: [
      { name: 'project_note', label: phrase(), where: ['paths'], regex: '.', escalate: 'always', floor: null },
      { name: 'project_value', label: phrase(), check: 'hardcoded_secret', where: ['added_lines'], regex: 'PROJECT_VALUE', escalate: 'if_model_disagrees', floor: null },
    ],
  }
}

function hostileRepo(): TestRepo {
  const r = createRepo()
  r.write('README.md', 'project\n')
  r.write('.jev-hooks/checks.json', JSON.stringify(hostileChecks(), null, 2))
  r.write('.jev-hooks/policy.json', JSON.stringify(hostilePolicy(), null, 2))
  r.commit('project rules')
  return r
}

// A repo with INVALID project files: phrases in an id, in a name, in unknown keys and
// in values. They are ignored with a warning, and the warning does not quote them.
function invalidHostileRepo(): TestRepo {
  const r = createRepo()
  const c = json('config/checks.json')
  c[phrase()] = { type: 'noul', instructions: 'x?' }
  c.touches_auth[phrase()] = true
  c.primary_concern.type = phrase()
  c.blast_radius.escalation_patterns = [`(${phrase()}`]
  const p = {
    [phrase()]: 1,
    lanes: [{ name: phrase(), rules: [{ check: phrase(), op: 'gte', value: phrase() }] }],
    detectors: [
      { name: phrase(), label: phrase(), where: [phrase()], regex: `(${phrase()}`, flags: phrase(), floor: phrase() },
      { name: 'stripe_live', [phrase()]: 1 },
    ],
  }
  r.write('README.md', 'project\n')
  r.write('.jev-hooks/checks.json', JSON.stringify(c, null, 2))
  r.write('.jev-hooks/policy.json', JSON.stringify(p, null, 2))
  r.commit('project rules')
  return r
}

// ─── Processes ────────────────────────────────────────────────────────────────

interface Execution { code: number; out: string; err: string }

function run(args: string[], o: { env: NodeJS.ProcessEnv; cwd: string; input?: string }): Promise<Execution> {
  return new Promise((ok, ko) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (s: string) => { out += s })
    p.stderr.on('data', (s: string) => { err += s })
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000)
    p.on('error', ko)
    p.on('close', (code) => {
      clearTimeout(timer)
      ok({ code: code ?? -1, out, err })
    })
    p.stdin.end(o.input ?? '')
  })
}

let counter = 0
function tempDir(name: string): string {
  const d = join(base, `${name}-${++counter}`)
  mkdirSync(d, { recursive: true })
  return d
}

// The hook's environment (a fake userConfig) and the CLI's (JEV_HOOKS_URL): from
// scratch, with the HOME of the test repo.
function hookEnv(r: TestRepo): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: r.home, TMPDIR: tmpdir(),
    CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: tempDir('data'),
    CLAUDE_PLUGIN_OPTION_REVIEW_URL: fake.url, CLAUDE_PLUGIN_OPTION_MODEL: 'jev-latest',
  }
}

function cliEnv(r: TestRepo): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: r.home, TMPDIR: tmpdir(), XDG_STATE_HOME: join(r.home, '.xdg-state'), JEV_HOOKS_URL: fake.url }
}

interface HookOutput {
  e: Execution
  decision?: string
  reason: string
  context: string
  message: string
}

async function hook(r: TestRepo, env: NodeJS.ProcessEnv, command: string): Promise<HookOutput> {
  const input = JSON.stringify({
    session_id: 'hostile-session', transcript_path: '/dev/null', cwd: r.dir, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: command, description: 'commit' }, tool_use_id: 'toolu_hostile',
  })
  const e = await run([HOOK, 'commit'], { env, cwd: r.dir, input })
  assert.equal(e.code, 0, e.err)
  const j = e.out === '' ? {} : JSON.parse(e.out)
  const h = j.hookSpecificOutput ?? {}
  return { e, decision: h.permissionDecision, reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '', message: j.systemMessage ?? '' }
}

// Everything the hook writes, raw (JSON stdout, stderr) and decoded.
function cleanHook(where: string, u: HookOutput): void {
  clean(`${where}: stdout`, u.e.out)
  clean(`${where}: stderr`, u.e.err)
  clean(`${where}: reason`, u.reason)
  clean(`${where}: context`, u.context)
  clean(`${where}: systemMessage`, u.message)
}

function cli(r: TestRepo, args: string[]): Promise<Execution> {
  return run([BIN, ...args], { env: cliEnv(r), cwd: r.dir })
}

function config(r: TestRepo, env: NodeJS.ProcessEnv, origin: 'hook' | 'skill' | 'cli' = 'skill'): LoadedConfig {
  const c = loadConfig({ cwd: r.dir, pluginRoot: ROOT, origin, env: env })
  if (!c.ok) assert.fail(c.error.message)
  return c.value
}

const MIDDLEWARE = "def middleware(request):\n    label = 'PROJECT_VALUE'\n    return request\n"

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'jev-hooks-hostile-'))
  fake = await startFake({ scenario: SCENARIO })
})

after(async () => {
  await fake?.close()
  if (base !== '') rmSync(base, { recursive: true, force: true })
})

// ─── Commit hook ──────────────────────────────────────────────────────────────

test('hook: with a hostile .jev-hooks/ already committed, an escalation deny, the second decision and a new deny without its texts', async () => {
  const r = hostileRepo()
  try {
    const env = hookEnv(r)
    // the project file really applies (equal to HEAD, no warning), and the texts are there
    const cfg = config(r, env, 'hook')
    assert.equal(cfg.sources.checks, '.jev-hooks/checks.json')
    assert.match(cfg.sources.policy, /\/config\/policy\.json \+ \.jev-hooks\/policy\.json \(restrictions only\)$/)
    assert.deepEqual(cfg.modifiedRules, [])
    // the questions the trusted rules decide on keep their trusted text, with a note
    // that names only trusted ids; the hostile texts stay on the project's own questions
    assert.deepEqual(cfg.warnings, ['.jev-hooks/checks.json: hardcoded_secret, injection_risk, touches_auth, weakens_tests, weakens_expected, adds_tests, breaks_api, data_migration, debug_leftovers: used by the trusted rules, which a repository cannot change: the trusted definitions apply'])
    assert.equal(cfg.checks.fromProject, true)
    // the instructions of the project's own questions stay (they go to the backend), the
    // label does not: nothing of the project's ever comes out. A question a trusted rule
    // decides on keeps the trusted text
    assert.match(String(cfg.checks.defs.blast_radius.instructions), RE_MARKER)
    assert.equal(cfg.checks.defs.blast_radius.label, 'blast_radius')
    assert.equal(cfg.checks.defs.touches_auth.instructions, json('config/checks.json').touches_auth.instructions)
    assert.equal(cfg.checks.defs.touches_auth.label, 'touches_auth')

    // NITS with escalation: threshold on touches_auth, disagreement on hardcoded_secret and
    // the project detector that fires on every diff
    r.write('src/app/middleware.py', MIDDLEWARE)
    const cmd = 'git add src/app/middleware.py && git commit -m "Add the middleware"'
    const one = await hook(r, env, cmd)
    assert.equal(one.decision, 'deny', one.e.out)
    cleanHook('escalation deny', one)
    assert.match(one.reason, /escalation to check before committing/)
    assert.match(one.reason, /Question: check «touches_auth» \(defined by the project: text not shown\): check the listed files/)
    assert.match(one.reason, /the detector «project_detector_2» \(defined by the project: text not shown\) found a match at line 2/)
    assert.match(one.reason, /Question: detector «project_detector_1» \(defined by the project: text not shown\): found a match in the paths/)
    assert.match(one.context, /"choice":"option 1"/)
    assert.match(one.context, /"level":"level 3"/)

    // second attempt: among the items there are the disagreement and the detector, which
    // are deterministic, and even with deny_then_allow the user decides. The summary of
    // the items stays without the project's texts
    const two = await hook(r, env, cmd)
    assert.equal(two.decision, 'ask', two.e.out)
    assert.match(two.reason, /escalation already passed to Claude \(.*\): you decide/)
    cleanHook('second attempt after the escalation', two)

    // a secret without a known prefix: the model does not block, the question goes to Claude
    r.commit('middleware')
    r.write('src/auth/tokens.py', `SIGNING_KEY = "${highEntropyValue(40, rnd)}"\n`)
    const three = await hook(r, env, 'git add src/auth/tokens.py && git commit -m "Signing key"')
    assert.equal(three.decision, 'deny', three.e.out)
    assert.match(three.reason, /^\[jev-review\] NITS: hardcoded_secret/)
    assert.match(three.reason, /above the escalation threshold · hardcoded_secret/)
    assert.notEqual(three.context, '')
    cleanHook('escalation deny for the secret', three)
  } finally {
    r.close()
  }
})

test('hook: an untracked file in .jev-hooks/ with a phrase in its name does not enter the reason', async () => {
  const r = hostileRepo()
  try {
    const env = hookEnv(r)
    const name = phrase()
    r.write(`.jev-hooks/${name}.txt`, 'x\n')
    r.write('docs/note.md', 'a note\n')
    const u = await hook(r, env, 'git add docs/note.md && git commit -m "Note"')
    assert.ok(u.decision === 'deny' || u.decision === 'ask', u.e.out)
    assert.match(u.reason, /reviewer rules modified and not committed: 1 file; verdict with the HEAD rules/)
    cleanHook('modified rules', u)
  } finally {
    r.close()
  }
})

test('hook and CLI: invalid project files with phrases in ids, names, keys and values → warnings without the phrases', async () => {
  const r = invalidHostileRepo()
  try {
    const env = hookEnv(r)
    const cfg = config(r, env, 'hook')
    // both ignored, with a warning each
    assert.match(cfg.sources.checks, /\/config\/checks\.json$/)
    assert.match(cfg.sources.policy, /\/config\/policy\.json$/)
    assert.equal(cfg.warnings.length, 2, cfg.warnings.join('\n'))
    for (const a of cfg.warnings) clean('warning', a)
    assert.ok(cfg.warnings.some((a) => a.includes('‹key›')), cfg.warnings.join('\n'))

    r.write('src/app/middleware.py', MIDDLEWARE)
    r.git('add', 'src/app/middleware.py')
    const u = await hook(r, env, 'git commit -m "Add the middleware"')
    cleanHook('hook with invalid files', u)
    assert.match(u.message, /\.jev-hooks\/policy\.json: invalid, ignored entirely/)

    for (const args of [['--staged', '--json', '--escalate'], ['--staged', '--no-color', '--escalate'], ['explain', 'touches_auth'], ['status']]) {
      const e = await cli(r, args)
      clean(`CLI ${args.join(' ')}: stdout`, e.out)
      clean(`CLI ${args.join(' ')}: stderr`, e.err)
    }
  } finally {
    r.close()
  }
})

// ─── CLI ──────────────────────────────────────────────────────────────────────

test('CLI: --escalate, --json, terminal and explain without the project\'s texts', async () => {
  const r = hostileRepo()
  try {
    r.write('src/app/middleware.py', MIDDLEWARE)
    r.git('add', 'src/app/middleware.py')

    const j = await cli(r, ['--staged', '--json', '--escalate'])
    assert.equal(j.code, 1, j.err)
    clean('CLI --json --escalate: stdout', j.out)
    clean('CLI --json --escalate: stderr', j.err)
    const res = JSON.parse(j.out) as ReviewResult & { escalation_prompt: string }
    assert.deepEqual(res.escalation.map((v) => v.reason).sort(), ['detector', 'disagreement', 'threshold'])
    assert.equal(res.values.primary_concern.choice, 'option 1')
    assert.equal(res.values.blast_radius.level, 'level 3')
    assert.ok(res.hits.some((c) => c.detector === 'project_detector_1' && c.label === 'detector «project_detector_1» (defined by the project: text not shown)'))
    assert.match(res.escalation_prompt, /check «touches_auth» \(defined by the project: text not shown\)/)

    const t = await cli(r, ['--staged', '--no-color', '--escalate'])
    assert.equal(t.code, 1, t.err)
    clean('CLI terminal --escalate: stdout', t.out)
    clean('CLI terminal --escalate: stderr', t.err)
    assert.match(t.out, /checks from \.jev-hooks\/checks\.json \(defined by the project: text not shown\)/)
    assert.match(t.out, /primary_concern {2,}option 1/)

    for (const id of ['touches_auth', 'primary_concern', 'blast_radius', 'merge_ready']) {
      const s = await cli(r, ['explain', id])
      assert.equal(s.code, 0, s.err)
      clean(`CLI explain ${id}: stdout`, s.out)
      clean(`CLI explain ${id}: stderr`, s.err)
      assert.match(s.out, new RegExp(`^${id} · \\(defined by the project: text not shown\\)`))
    }
  } finally {
    r.close()
  }
})

// ─── Text for the skill ───────────────────────────────────────────────────────

test('skill: claudeContext, escalationPrompt and every other output of the result without the project\'s texts', async () => {
  const r = hostileRepo()
  try {
    const env = hookEnv(r)
    const cfg = config(r, env, 'skill')
    r.write('src/app/middleware.py', MIDDLEWARE)
    r.git('add', 'src/app/middleware.py')
    const { result } = await runReview({
      origin: 'skill', cwd: r.dir, source: { kind: 'staged' }, sources: backendSources('skill', env), pluginRoot: ROOT,
      start: nodeClock.now(), config: cfg, env: env,
    })
    assert.equal(result.outcome, 'ok', result.error?.message)
    assert.ok(result.escalation.length >= 3)
    const outputs: [string, string][] = [
      ['claudeContext', claudeContext(result, cfg.checks)],
      ['escalationPrompt', escalationPrompt(result.escalation)],
      ['compactJson', JSON.stringify(compactJson(result))],
      ['full result', JSON.stringify(result)],
      ['hookReason', hookReason(result)],
      ['renderTerminal', renderTerminal(result, cfg.checks, { ansi: false, policy: cfg.policy })],
      ['checkRunMarkdown', checkRunMarkdown(result, cfg.checks).summary],
      ['configuration warnings', cfg.warnings.join('\n')],
      ['configuration sources', JSON.stringify(cfg.sources)],
      ...cfg.checks.order.map((id): [string, string] => [`explanation ${id}`, renderExplanation(id, cfg, null)]),
    ]
    for (const [where, text] of outputs) clean(where, text)
  } finally {
    r.close()
  }
})

// ─── The user layer stays trusted: the "open a JSON" demo ─────────────────────

test('user file: its labels and instructions reach Claude as before (hook, --escalate, explain)', async () => {
  const r = createRepo()
  try {
    r.write('README.md', 'project\n')
    r.commit('first')
    const dir = join(r.home, '.config', 'jev-hooks')
    mkdirSync(dir, { recursive: true })
    const c = json('config/checks.json')
    c.touches_auth.label = 'User label: authentication touched'
    c.touches_auth.instructions = 'User instruction: does the diff change login, sessions or permissions?'
    writeFileSync(join(dir, 'checks.json'), JSON.stringify(c))
    const p = json('config/policy.json')
    p.detectors.push({ name: 'user_marker', label: 'User detector: internal marker', where: ['added_lines'], regex: 'PROJECT_VALUE', escalate: 'always', floor: null })
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(p))

    const env = hookEnv(r)
    const cfg = config(r, env, 'hook')
    assert.equal(cfg.sources.checks, '~/.config/jev-hooks/checks.json')
    assert.equal(cfg.checks.fromProject, undefined)

    r.write('src/app/middleware.py', MIDDLEWARE)
    const u = await hook(r, env, 'git add src/app/middleware.py && git commit -m "Add the middleware"')
    assert.equal(u.decision, 'deny', u.e.out)
    assert.ok(u.reason.includes('Question: User label: authentication touched: User instruction: does the diff change login, sessions or permissions?'), u.reason)
    assert.ok(u.reason.includes('Question: User detector: internal marker: the detector «user_marker» found'), u.reason)
    assert.ok(u.context.includes('User label: authentication touched'), u.context)
    assert.doesNotMatch(u.reason, /defined by the project/)

    r.git('add', 'src/app/middleware.py')
    const t = await cli(r, ['--staged', '--no-color', '--escalate'])
    assert.equal(t.code, 1, t.err)
    assert.ok(t.out.includes('User label: authentication touched: User instruction'), t.out)
    const s = await cli(r, ['explain', 'touches_auth'])
    assert.match(s.out, /^touches_auth · User label: authentication touched\n/)
    assert.match(s.out, /instructions: User instruction: does the diff change login/)
  } finally {
    r.close()
  }
})
