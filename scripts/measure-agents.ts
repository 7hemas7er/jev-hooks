// Measures the subagent router's question on labelled task prompts, and replays the
// answers with another agents.json. The request is built by agentRequest and the answer
// read by parseClassification and decided by chooseModel, the functions the function
// hook uses, with the plugin's agents.json (or a trial one given with --config) as the
// user layer.
//
// Measuring asks the backend once per task prompt and writes raw.jsonl (the answers as
// they came) and report.md. Replaying reads raw.jsonl and prints the report computed
// with the configuration given now: route and min_top_probability change without the
// network, as long as the question text stays the one measured.
//
// The report has how well agent_task matches its label and, end to end, what the
// router would move: how many task prompts go to a route's model, and how many of
// those the label says need a large model (the risk). The outputs hold ids, numbers,
// option names and hashes: never a task prompt, never the backend's host, never a key.
//
// Usage:
//   node scripts/measure-agents.ts --out DIR [--dataset FILE] [--url URL] [--model NAME]
//     [--config FILE] [--date TEXT] [--timeout-ms N] [--overwrite]
//   node scripts/measure-agents.ts --replay DIR [--dataset FILE] [--config FILE]
//
// The key is never a flag: JEV_HOOKS_KEY goes to the backend only when JEV_HOOKS_URL
// has the same origin as --url, as in the CLI.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentRequest, chooseModel, effectiveAgentsConfig } from '../src/core/agents.ts'
import { isObject } from '../src/core/json.ts'
import { formatNumber } from '../src/core/numbers.ts'
import { parseClassification } from '../src/core/router.ts'
import { sha256Hex } from '../src/core/sha256.ts'
import { questionHash } from '../src/core/systemone.ts'
import type { AgentSpawn, AgentsConfig, Backend, Classification, RouterBackend, Transport } from '../src/core/types.ts'
import { backendFrom, backendSources } from '../src/node/run.ts'
import { nodeTransport } from '../src/node/transport.ts'
import { InputError, ROOT, readRaw } from './measure-router.ts'
import type { RawRow } from './measure-router.ts'

const EXIT_OK = 0
const EXIT_INTERRUPTED = 1
const EXIT_USAGE = 2
const MAX_CONSECUTIVE_FAILURES = 3
const FATAL_STATUS = new Set([401, 403, 404])
const TIERS = ['small', 'medium', 'large'] as const
// The labels a row may carry: agent_task and tier are scored; the others describe the
// task (bench/README.md) and are kept for later questions.
const LABELS = ['agent_task', 'tier', 'open_judgement', 'writes_files', 'material', 'final_say'] as const
// The spawn every row is decided as: an Agent tool spawn from an Opus 5.5 session
// whose caller named no model, the case the router acts on.
const SPAWN: AgentSpawn = { subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', fork: false }


export interface AgentRow { id: string; text: string; language: string | null; labels: Record<string, string | number | boolean | null> }

const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/

export function parseAgentsDataset(text: string, file: string, cfg: AgentsConfig): AgentRow[] {
  const rows: AgentRow[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  const options = Object.keys(cfg.questions[cfg.taskQuestion].criteria ?? {})
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const where = `${file}:${i + 1}`
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      return void problems.push(`${where}: not JSON`)
    }
    if (!isObject(v)) return void problems.push(`${where}: expected an object`)
    const id = v.id
    if (typeof id !== 'string' || !RE_ID.test(id)) return void problems.push(`${where}: invalid id`)
    if (seen.has(id)) problems.push(`${where}: duplicate id ${id}`)
    seen.add(id)
    if (typeof v.text !== 'string' || v.text.trim() === '') return void problems.push(`${where} (${id}): "text" must be a non-empty string`)
    const raw = isObject(v.labels) ? v.labels : {}
    const labels: AgentRow['labels'] = {}
    for (const [k, x] of Object.entries(raw)) {
      if (!(LABELS as readonly string[]).includes(k)) {
        problems.push(`${where} (${id}): unknown label ${k.slice(0, 40)}`)
        continue
      }
      if (k === 'agent_task' && x !== null && (typeof x !== 'string' || !options.includes(x))) problems.push(`${where} (${id}): agent_task must be one of ${options.join(', ')} or null`)
      else if (k === 'tier' && x !== null && (typeof x !== 'string' || !(TIERS as readonly string[]).includes(x))) problems.push(`${where} (${id}): tier must be one of ${TIERS.join(', ')} or null`)
      else labels[k] = x as string | number | boolean | null
    }
    rows.push({ id, text: v.text, language: typeof v.language === 'string' ? v.language : null, labels })
  })
  if (problems.length > 0) throw new InputError(problems.slice(0, 20).join('\n'))
  if (rows.length === 0) throw new InputError(`${file}: no rows`)
  return rows
}

// The plugin's agents.json, or a trial one as the user layer; an invalid trial file
// stops everything rather than falling back to the plugin's.
export function agentsConfig(configText: string | null, label: string): AgentsConfig {
  const { cfg, notes } = effectiveAgentsConfig({ user: configText, projects: [], userCalibration: null }, { agent_router: true })
  const bad = notes.find((n) => n.includes('invalid') || n.includes('unreadable'))
  if (!cfg || bad !== undefined) throw new InputError(`${label}: ${bad ?? 'invalid agents configuration'}`)
  return cfg
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new InputError(`${file}: cannot be read`)
  }
}

function showFile(f: string): string {
  const r = relative(ROOT, resolve(f))
  return r.startsWith('..') || isAbsolute(r) ? f : r
}

// ─── Measuring ────────────────────────────────────────────────────────────────

export interface MeasureOptions {
  out: string; dataset: string; url?: string; model?: string; config?: string; date: string; timeoutMs: number; overwrite: boolean
  env?: NodeJS.ProcessEnv; transport?: Transport; progress?: (line: string) => void
}

export async function measureAgents(o: MeasureOptions): Promise<{ code: number; report: string; raw: string }> {
  const configText = o.config !== undefined ? readText(o.config) : null
  const cfg = agentsConfig(configText, o.config ?? 'agents.json (plugin)')
  const datasetText = readText(o.dataset)
  const rows = parseAgentsDataset(datasetText, o.dataset, cfg)
  const found = backendFrom(backendSources('cli', o.env ?? process.env, o.url !== undefined ? { explicitUrl: o.url } : {}), o.model, 'cli').backend
  if (Object.hasOwn(found, 'kind')) throw new InputError(`backend: ${(found as { message: string }).message}`)
  const b = found as Backend as RouterBackend

  mkdirSync(o.out, { recursive: true })
  const rawFile = join(o.out, 'raw.jsonl')
  const reportFile = join(o.out, 'report.md')
  if (!o.overwrite && (existsSync(rawFile) || existsSync(reportFile))) {
    throw new InputError(`${o.out} already contains a measurement: choose another directory or use --overwrite`)
  }
  writeFileSync(rawFile, '')
  const transport = o.transport ?? nodeTransport()
  const raw: RawRow[] = []
  let failures = 0
  let stop: string | undefined
  for (const [i, r] of rows.entries()) {
    // towards a local backend nothing is masked; a remote one gets no map here: the
    // dataset is synthetic, and a real prompt is never measured with this script
    const rq = agentRequest(cfg, r.text, b, { text: null }, 1)
    const line: RawRow = { id: r.id, ms: 0, model: b.model, local: b.local }
    if ('skip' in rq) line.error = `not sent: ${rq.skip}`
    else {
      const e = await transport({ url: rq.url, headers: rq.init.headers, body: rq.init.body, timeoutMs: o.timeoutMs })
      line.ms = Math.round(e.ms)
      if (e.kind === 'response') {
        line.status = e.status
        try {
          line.body = JSON.parse(e.text)
        } catch {
          line.error = 'answer is not JSON'
        }
        if (FATAL_STATUS.has(e.status)) stop = `backend answered ${e.status}`
        else if (e.status !== 200) line.error = `status ${e.status}`
      } else line.error = e.kind === 'timeout' ? 'timeout' : `network: ${e.message}`
    }
    failures = line.error !== undefined ? failures + 1 : 0
    raw.push(line)
    appendFileSync(rawFile, JSON.stringify(line) + '\n')
    o.progress?.(`${i + 1}/${rows.length} ${r.id}: ${line.error ?? `${formatNumber(line.ms / 1000, 2)} s`}`)
    if (failures >= MAX_CONSECUTIVE_FAILURES) stop ??= `${MAX_CONSECUTIVE_FAILURES} failed requests in a row`
    if (stop !== undefined) break
  }
  const report = renderAgentsReport({
    rows, raw, cfg, b, date: o.date, interrupted: stop,
    dataset: { file: showFile(o.dataset), sha: sha256Hex(datasetText) },
    config: { file: o.config !== undefined ? showFile(o.config) : 'config/agents.json (plugin)', sha: configText !== null ? sha256Hex(configText) : null },
  })
  writeFileSync(reportFile, report)
  return { code: stop !== undefined ? EXIT_INTERRUPTED : EXIT_OK, report: reportFile, raw: rawFile }
}

// ─── The report ───────────────────────────────────────────────────────────────

export interface ReportData {
  rows: readonly AgentRow[]; raw: readonly RawRow[]; cfg: AgentsConfig; b?: RouterBackend; date?: string; interrupted?: string
  dataset: { file: string; sha: string }; config: { file: string; sha: string | null }
}

// The classification of one measured row, as the hook reads it, or why there is none.
export function classifyRow(r: RawRow, cfg: AgentsConfig): Classification | string {
  if (r.error !== undefined) return r.error
  if (r.status !== 200 || r.body === undefined) return 'no answer'
  const b: RouterBackend = { url: '', key: '', model: r.model, local: r.local, host: '' }
  const parsed = parseClassification(cfg, b, 200, JSON.stringify(r.body))
  return parsed.ok ? parsed.value : `answer discarded: ${parsed.error.kind}`
}

export function renderAgentsReport(d: ReportData): string {
  const byId = new Map(d.raw.map((r) => [r.id, r]))
  const out: string[] = ['# Subagent router: agent_task on labelled task prompts', '']
  if (d.date) out.push(`- Date: ${d.date}`)
  out.push(`- Dataset: \`${d.dataset.file}\` (sha256 \`${d.dataset.sha.slice(0, 12)}…\`), ${d.rows.length} rows`)
  out.push(`- Configuration: ${d.config.file}${d.config.sha ? ` (sha256 \`${d.config.sha.slice(0, 12)}…\`)` : ''}`)
  out.push(`- min_top_probability ${formatNumber(d.cfg.min_top_probability)}; route ${Object.entries(d.cfg.route).map(([k, v]) => `${k} → ${v}`).join(', ') || 'empty'}`)
  if (d.interrupted) out.push(`- **Interrupted**: ${d.interrupted}`)
  out.push('')

  const opts = Object.keys(d.cfg.questions[d.cfg.taskQuestion].criteria ?? {})
  const pairs: { r: AgentRow; c: Classification }[] = []
  let failed = 0
  for (const r of d.rows) {
    const m = byId.get(r.id)
    if (!m) continue
    const c = classifyRow(m, d.cfg)
    if (typeof c === 'string') failed++
    else pairs.push({ r, c })
  }
  out.push(`Answered ${pairs.length} of ${d.rows.length}${failed ? `; ${failed} failed` : ''}.`, '')

  out.push('## agent_task', '')
  const labelled = pairs.filter((x) => typeof x.r.labels.agent_task === 'string')
  const right = labelled.filter((x) => x.c.taskKind === x.r.labels.agent_task).length
  out.push(`Accuracy ${right}/${labelled.length} (${labelled.length ? Math.round((100 * right) / labelled.length) : 0}%); mean p of the chosen option ${formatNumber(labelled.reduce((a, x) => a + x.c.pTask, 0) / Math.max(1, labelled.length), 3)}.`, '')
  out.push(`| label \\ answer | ${opts.join(' | ')} |`, `|---|${opts.map(() => '--:').join('|')}|`)
  for (const l of opts) {
    const row = opts.map((a) => labelled.filter((x) => x.r.labels.agent_task === l && x.c.taskKind === a).length)
    if (row.some((n) => n > 0)) out.push(`| ${l} | ${row.map((n) => (n ? String(n) : '·')).join(' | ')} |`)
  }
  out.push('')

  out.push('## Routing, end to end', '')
  out.push('Every row decided as an Agent tool spawn from an Opus 5.5 session whose caller named no model. **Wrongly moved** is a row moved to a route\'s model whose label says it needs a large model (the risk: a worse answer); **left** is a row labelled small or medium that stays on the parent\'s model (a missed saving, never a loss of quality).', '')
  let moved = 0
  let wrong = 0
  let left = 0
  const wrongIds: string[] = []
  for (const { r, c } of pairs) {
    const choice = chooseModel(c, SPAWN, d.cfg)
    const tier = r.labels.tier
    if (choice.model !== undefined) {
      moved++
      if (tier === 'large') {
        wrong++
        wrongIds.push(`${r.id} (${c.taskKind} ${formatNumber(c.pTask)})`)
      }
    } else if (tier === 'small' || tier === 'medium') left++
  }
  out.push(`- Moved ${moved} of ${pairs.length}; wrongly moved ${wrong}${wrongIds.length ? `: ${wrongIds.join(', ')}` : ''}.`)
  out.push(`- Left on the parent's model though labelled small or medium: ${left}.`, '')

  out.push('## Question hash', '', '| question | sha256 |', '|---|---|')
  for (const [id, w] of Object.entries(d.cfg.questions)) out.push(`| ${id} | \`${questionHash(w)}\` |`)
  out.push('')
  return out.join('\n')
}

// ─── Command line ─────────────────────────────────────────────────────────────

const HELP = `usage: node scripts/measure-agents.ts --out DIR [--dataset FILE] [--url URL] [--model NAME]
         [--config FILE] [--date TEXT] [--timeout-ms N] [--overwrite]
       node scripts/measure-agents.ts --replay DIR [--dataset FILE] [--config FILE]

  --out DIR        measure: one request per task prompt, raw.jsonl and report.md in DIR
  --replay DIR     recompute DIR's report with today's configuration, without the network
  --dataset FILE   labelled task prompts (default bench/agents-dev.jsonl)
  --config FILE    a trial agents.json, applied as the user layer
  --url URL        the backend (default JEV_HOOKS_URL); JEV_HOOKS_KEY only for its origin
  --model NAME     the model to request (default jev-latest)
  --date TEXT      the date written in the report (default today)
  --timeout-ms N   per request (default 30000)
  --overwrite      replace a measurement already in DIR
`

interface Args { mode?: 'measure' | 'replay'; dir?: string; dataset: string; url?: string; model?: string; config?: string; date: string; timeoutMs: number; overwrite: boolean }

export function parseArgs(argv: readonly string[], cwd: string, today: string): Args | 'help' {
  const a: Args = { dataset: join(ROOT, 'bench', 'agents-dev.jsonl'), date: today, timeoutMs: 30_000, overwrite: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return 'help'
    if (flag === '--overwrite') {
      a.overwrite = true
      continue
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new InputError(`${flag}: missing value`)
    i++
    switch (flag) {
      case '--out': a.mode = 'measure'; a.dir = resolve(cwd, v); break
      case '--replay': a.mode = 'replay'; a.dir = resolve(cwd, v); break
      case '--dataset': a.dataset = resolve(cwd, v); break
      case '--config': a.config = resolve(cwd, v); break
      case '--url': a.url = v; break
      case '--model': a.model = v; break
      case '--date': a.date = v; break
      case '--timeout-ms': {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 100 || n > 600000) throw new InputError('--timeout-ms: an integer from 100 to 600000')
        a.timeoutMs = n
        break
      }
      default: throw new InputError(`unknown option: ${flag.slice(0, 40)}`)
    }
  }
  if (a.mode === undefined || a.dir === undefined) throw new InputError('--out DIR or --replay DIR is required')
  return a
}

export async function main(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = {
  out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s),
}): Promise<number> {
  let args: Args | 'help'
  try {
    args = parseArgs(argv, process.cwd(), new Date().toISOString().slice(0, 10))
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`)
    return EXIT_USAGE
  }
  if (args === 'help') {
    io.out(HELP)
    return EXIT_OK
  }
  try {
    if (args.mode === 'replay') {
      const configText = args.config !== undefined ? readText(args.config) : null
      const cfg = agentsConfig(configText, args.config ?? 'agents.json (plugin)')
      const datasetText = readText(args.dataset)
      const rows = parseAgentsDataset(datasetText, args.dataset, cfg)
      const rawFile = join(args.dir as string, 'raw.jsonl')
      const raw = readRaw(readText(rawFile), rawFile)
      io.out(renderAgentsReport({
        rows, raw, cfg,
        dataset: { file: showFile(args.dataset), sha: sha256Hex(datasetText) },
        config: { file: args.config !== undefined ? showFile(args.config) : 'config/agents.json (plugin)', sha: configText !== null ? sha256Hex(configText) : null },
      }))
      return EXIT_OK
    }
    const r = await measureAgents({
      out: args.dir as string, dataset: args.dataset, url: args.url, model: args.model, config: args.config, date: args.date,
      timeoutMs: args.timeoutMs, overwrite: args.overwrite, progress: (l) => io.err(`${l}\n`),
    })
    io.out(`${r.report}\n${r.raw}\n`)
    return r.code
  } catch (e) {
    if (e instanceof InputError) {
      io.err(`${e.message}\n`)
      return EXIT_USAGE
    }
    throw e
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
if (isMain) process.exitCode = await main(process.argv.slice(2))
