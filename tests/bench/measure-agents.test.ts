// scripts/measure-agents.ts against the fake server: the repo's dataset reads with the
// plugin's agents.json, a measurement writes answers and a report with no task prompt
// and no key in them, a replay with another agents.json changes what moves without the
// network, and the command line refuses what it should.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFake } from '../helpers/fake-systemone.ts'
import type { FakeServer } from '../helpers/fake-systemone.ts'
import { agentsConfig, main, measureAgents, parseAgentsDataset } from '../../scripts/measure-agents.ts'
import { InputError } from '../../scripts/measure-router.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEY = 'fake-agents-key'
const PROMPT_MARK = 'MARKER_TASK_PROMPT_MUST_NOT_LEAK'

let dir = ''
let fake: FakeServer

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jev-hooks-measure-agents-'))
  fake = await startFake({
    mode: 'rizzo', key: KEY,
    scenario: {
      defaults: { choice: 'implement' },
      rules: [
        { if_state_contains: 'skeptic', answers: { agent_task: 'check_claim' } },
        { if_state_contains: 'labeller', answers: { agent_task: 'label' } },
        { if_state_contains: 'design', answers: { agent_task: 'design' } },
      ],
    },
  })
})

after(async () => {
  await fake?.close()
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

const row = (id: string, text: string, labels: Record<string, unknown>): string => JSON.stringify({ id, text, labels })
const DATASET = [
  row('skeptic', `You are skeptic #1: is this finding real? ${PROMPT_MARK}`, { agent_task: 'check_claim', tier: 'small' }),
  row('labeller', 'You are labeller A: apply definition.md to each item.', { agent_task: 'label', tier: 'medium' }),
  row('writer', 'You are labeller B writing a blind dataset of 60 diffs with its labels.', { agent_task: 'implement', tier: 'large' }),
  row('design', 'Write a design for the cache layer.', { agent_task: 'design', tier: 'large' }),
  row('impl', 'Add the --json flag to src/cli.ts.', { agent_task: 'implement', tier: 'medium' }),
].join('\n') + '\n'

function datasetFile(name: string, text: string = DATASET): string {
  const f = join(dir, name)
  writeFileSync(f, text)
  return f
}

test("the repo's agents dataset reads with the plugin's agents.json, every option labelled", () => {
  const cfg = agentsConfig(null, 'plugin')
  const rows = parseAgentsDataset(readFileSync(join(ROOT, 'bench', 'agents-dev.jsonl'), 'utf8'), 'bench/agents-dev.jsonl', cfg)
  assert.equal(rows.length, 120)
  const kinds = new Set(rows.map((r) => r.labels.agent_task))
  for (const k of Object.keys(cfg.questions.agent_task.criteria as Record<string, string>)) assert.ok(kinds.has(k), `no task labelled ${k}`)
})

test('labels are checked: an unknown option, an unknown tier, an unknown label', () => {
  const cfg = agentsConfig(null, 'plugin')
  const bad = [row('a', 'x', { agent_task: 'chat' }), row('b', 'x', { tier: 'huge' }), row('c', 'x', { effort: 'low' })].join('\n')
  assert.throws(() => parseAgentsDataset(bad, 'bad.jsonl', cfg), (e: Error) => {
    assert.ok(e instanceof InputError)
    for (const s of ['agent_task must be one of', 'tier must be one of', 'unknown label effort']) assert.ok(e.message.includes(s), s)
    return true
  })
})

test('a measurement: one request per task prompt with the one question, a report without prompts, host or key', async () => {
  const out = join(dir, 'm1')
  const start = fake.requests.length
  const r = await measureAgents({ out, dataset: datasetFile('d1.jsonl'), url: fake.url, date: '2026-10-09', timeoutMs: 10_000, overwrite: false, env: { JEV_HOOKS_URL: fake.url, JEV_HOOKS_KEY: KEY } })
  assert.equal(r.code, 0)
  const sent = fake.requests.slice(start)
  assert.equal(sent.length, 5)
  assert.deepEqual(Object.keys((sent[0].json as { questions: Record<string, unknown> }).questions), ['agent_task'])
  assert.equal(sent[0].headers.authorization, `Bearer ${KEY}`)
  const report = readFileSync(join(out, 'report.md'), 'utf8')
  const raw = readFileSync(join(out, 'raw.jsonl'), 'utf8')
  for (const text of [report, raw]) {
    assert.ok(!text.includes(KEY), 'key in the output')
    assert.ok(!text.includes(PROMPT_MARK), 'task prompt in the output')
    assert.ok(!text.includes('127.0.0.1'), 'host in the output')
  }
  assert.match(report, /Answered 5 of 5\./)
  // the writer is a labeller to the fake: moved although it needs a large model
  assert.match(report, /Accuracy 4\/5 \(80%\)/)
  assert.match(report, /- Moved 3 of 5; wrongly moved 1: writer \(label /)
  assert.match(report, /- Left on the parent's model though labelled small or medium: 1\./)
  assert.match(report, /\| agent_task \| `6817b237294fe93e2e0488fb8c6cd497ac1518be658737551ddb3f8a54abc223` \|/)
  // a second measurement into the same directory needs --overwrite
  await assert.rejects(measureAgents({ out, dataset: datasetFile('d1.jsonl'), url: fake.url, date: 'x', timeoutMs: 10_000, overwrite: false, env: { JEV_HOOKS_URL: fake.url, JEV_HOOKS_KEY: KEY } }), InputError)
})

test('a replay with another agents.json changes what moves, without the network', async () => {
  const out = join(dir, 'm2')
  await measureAgents({ out, dataset: datasetFile('d2.jsonl'), url: fake.url, date: '2026-10-09', timeoutMs: 10_000, overwrite: false, env: { JEV_HOOKS_URL: fake.url, JEV_HOOKS_KEY: KEY } })
  const requests = fake.requests.length
  const run = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    let o = ''
    let e = ''
    const code = await main(['--replay', out, '--dataset', join(dir, 'd2.jsonl'), ...args], { out: (s) => { o += s }, err: (s) => { e += s } })
    return { code, out: o, err: e }
  }
  const plain = await run([])
  assert.equal(plain.code, 0, plain.err)
  assert.match(plain.out, /- Moved 3 of 5/)
  const trial = JSON.parse(readFileSync(join(ROOT, 'config', 'agents.json'), 'utf8'))
  trial.route = { check_claim: 'claude-haiku-5-5' }
  const f = join(dir, 'trial-agents.json')
  writeFileSync(f, JSON.stringify(trial))
  const only = await run(['--config', f])
  assert.equal(only.code, 0, only.err)
  assert.match(only.out, /- Moved 1 of 5; wrongly moved 0\./)
  assert.equal(fake.requests.length, requests)
})

test('the command line: help, a missing mode, an unknown option, an invalid trial file', async () => {
  const io = (): { out: string; err: string; w: { out: (s: string) => void; err: (s: string) => void } } => {
    const r = { out: '', err: '', w: { out: (s: string) => { r.out += s }, err: (s: string) => { r.err += s } } }
    return r
  }
  const h = io()
  assert.equal(await main(['--help'], h.w), 0)
  assert.match(h.out, /^usage: node scripts\/measure-agents\.ts/)
  assert.equal(await main([], io().w), 2)
  assert.equal(await main(['--out', dir, '--sessions', 'high'], io().w), 2)
  const f = join(dir, 'bad-agents.json')
  writeFileSync(f, '{"enabled": true}')
  const b = io()
  assert.equal(await main(['--replay', join(dir, 'm2'), '--config', f], b.w), 2)
  assert.match(b.err, /invalid/)
})
