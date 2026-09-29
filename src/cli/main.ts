// The jev-review CLI: review, explain, status. It is meant for the user's
// terminal: run by Claude through Bash it would run in the sandbox, without the LAN and
// (with sandbox.credentials) without keys, and for Claude there is /jev-review.
//
// Exit code: 0 MERGE, 1 NITS, 2 SECURITY REVIEW, 3 BLOCK (from the lanes' exit_code),
// 4 error (configuration, backend not configured, network, key, arguments).
//
// The key is never a flag: it comes from the environment or from the file
// ~/.config/jev-hooks/key, and follows the (URL, key, model) layers of
// src/core/backend.ts.
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatProblem } from '../core/json.ts'
import { formatNumber } from '../core/numbers.ts'
import { escalationPrompt } from '../core/escalation.ts'
import { renderExplanation, renderTerminal } from '../core/render.ts'
import type { ExplainedProfile } from '../core/render.ts'
import type { CalibrationMode, DiffSource } from '../core/types.ts'
import { appendLog, logLine, lastReview } from '../node/data.ts'
import { runReview, backendSources, probeStatus } from '../node/run.ts'
import { loadConfig, pluginVersion, readKeyFile } from '../node/file-config.ts'
import type { LoadedConfig } from '../node/file-config.ts'
import { repoRoot, defaultSource } from '../node/git.ts'
import { nodeClock } from '../node/transport.ts'

export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const EXIT_ERROR = 4

export const USAGE = `usage:
  jev-review [review] [--diff FILE | --git REF | --working | --staged]
                      [--title T] [--description D] [--json] [--escalate]
                      [--config-dir DIR] [--url URL] [--model M] [--no-color]
  jev-review explain <check> [--profile NAME] [--config-dir DIR]
  jev-review status [--config-dir DIR] [--url URL] [--model M] [--json]

Without a source, review takes the staged changes, then the uncommitted ones,
then the branch against the main branch. --diff - reads the diff from standard input.
Exit code: 0 MERGE, 1 NITS, 2 SECURITY REVIEW, 3 BLOCK, 4 error.
The key comes from JEV_HOOKS_KEY, TYPESAFE_API_KEY or ~/.config/jev-hooks/key, never from a flag.
`

export interface CliContext {
  env: NodeJS.ProcessEnv
  cwd: string
  write: (s: string) => void             // stdout
  writeErr: (s: string) => void             // stderr
  tty: boolean
  readStdin: (cap: number) => Promise<string>
}

// ─── Arguments ────────────────────────────────────────────────────────────────

type Command = 'review' | 'explain' | 'status'

const VALUE_FLAGS: Record<Command, readonly string[]> = {
  review: ['--diff', '--git', '--title', '--description', '--config-dir', '--url', '--model'],
  explain: ['--profile', '--config-dir'],
  status: ['--config-dir', '--url', '--model'],
}
const FLAGS: Record<Command, readonly string[]> = {
  review: ['--working', '--staged', '--json', '--escalate', '--no-color'],
  explain: ['--no-color'],
  status: ['--json', '--no-color'],
}

interface ParsedArgs { command: Command; options: Map<string, string | true>; positionals: string[] }

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ParsedArgs | 'help' {
  if (argv.includes('-h') || argv.includes('--help') || argv[0] === 'help') return 'help'
  let rest = [...argv]
  let command: Command = 'review'
  if (rest.length > 0 && !rest[0].startsWith('-')) {
    if (rest[0] !== 'review' && rest[0] !== 'explain' && rest[0] !== 'status') throw new UsageError(`unknown command: ${rest[0]}`)
    command = rest[0]
    rest = rest.slice(1)
  }
  const options = new Map<string, string | true>()
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--') || a === '--') {
      if (a === '--') {
        positionals.push(...rest.slice(i + 1))
        break
      }
      positionals.push(a)
      continue
    }
    const equal = a.indexOf('=')
    const name = equal > 0 ? a.slice(0, equal) : a
    if (options.has(name)) throw new UsageError(`repeated option: ${name}`)
    if (VALUE_FLAGS[command].includes(name)) {
      const v = equal > 0 ? a.slice(equal + 1) : rest[++i]
      if (v === undefined) throw new UsageError(`missing value for ${name}`)
      options.set(name, v)
    } else if (FLAGS[command].includes(name) && equal < 0) {
      options.set(name, true)
    } else {
      // "chiave" is Italian for key: --chiave gets the same hint (check-english: allow-next-line)
      const key = /key|chiave|token/i.test(name) ? ' (the key is never passed as a flag: use JEV_HOOKS_KEY or ~/.config/jev-hooks/key)' : ''
      throw new UsageError(`unknown option for ${command}: ${name}${key}`)
    }
  }
  const expected = command === 'explain' ? 1 : 0
  if (positionals.length > expected) throw new UsageError(`unexpected argument: ${positionals[expected]}`)
  if (command === 'explain' && positionals.length === 0) throw new UsageError('missing the check to explain: jev-review explain <check>')
  if (command === 'review') {
    const sources = ['--diff', '--git', '--working', '--staged'].filter((k) => options.has(k))
    if (sources.length > 1) throw new UsageError(`one source at a time: ${sources.join(', ')}`)
  }
  return { command, options, positionals }
}

function optionValue(a: ParsedArgs, name: string): string | undefined {
  const v = a.options.get(name)
  return typeof v === 'string' ? v : undefined
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Configuration for the CLI: an invalid user file is an error (exit 4), not a silent
// fallback to the defaults as in the hooks.
function loadCliConfig(a: ParsedArgs, ctx: CliContext): LoadedConfig | number {
  const dir = optionValue(a, '--config-dir')
  const c = loadConfig({
    cwd: ctx.cwd, pluginRoot: PLUGIN_ROOT, origin: 'cli', env: ctx.env,
    ...(dir !== undefined ? { userDir: resolve(ctx.cwd, dir) } : {}),
  })
  if (!c.ok) {
    ctx.writeErr(`jev-review: ${c.error.message}\n`)
    return EXIT_ERROR
  }
  if (c.value.userProblems.length > 0) {
    ctx.writeErr('jev-review: invalid user configuration:\n')
    for (const p of c.value.userProblems) ctx.writeErr(`  ${formatProblem(p)}\n`)
    return EXIT_ERROR
  }
  return c.value
}

function warn(ctx: CliContext, warnings: readonly string[]): void {
  for (const w of warnings) ctx.writeErr(`[jev-review] ${w}\n`)
}

function keyFromFile(ctx: CliContext): string | undefined {
  const k = readKeyFile(ctx.env)
  if (k.warning) ctx.writeErr(`[jev-review] ${k.warning}\n`)
  return k.key
}

// ─── review ───────────────────────────────────────────────────────────────────

async function reviewCommand(a: ParsedArgs, ctx: CliContext): Promise<number> {
  const start = nodeClock.now()
  const cfg = loadCliConfig(a, ctx)
  if (typeof cfg === 'number') return cfg
  const p = cfg.policy

  let source: DiffSource
  const diff = optionValue(a, '--diff')
  const ref = optionValue(a, '--git')
  if (diff === '-') {
    source = { kind: 'text', diff: await ctx.readStdin(p.state.max_diff_bytes + 1), title: '', description: null }
  } else if (diff !== undefined) source = { kind: 'file', path: resolve(ctx.cwd, diff) }
  else if (ref !== undefined) source = { kind: 'ref', ref }
  else if (a.options.has('--working')) source = { kind: 'working' }
  else if (a.options.has('--staged')) source = { kind: 'staged' }
  else {
    const s = defaultSource(ctx.cwd, start + p.limits.cli.total_ms, ctx.env)
    if (!s.ok) {
      warn(ctx, cfg.warnings)
      ctx.writeErr(`jev-review: ${s.error.message}\n`)
      return EXIT_ERROR
    }
    source = s.value.source
    ctx.writeErr(`[jev-review] ${s.value.note}\n`)
  }

  const sources = backendSources('cli', ctx.env, { explicitUrl: optionValue(a, '--url'), keyFile: keyFromFile(ctx) })
  const title = optionValue(a, '--title')
  const description = optionValue(a, '--description')
  const { result: r, warnings, title: effectiveTitle, identity } = await runReview({
    origin: 'cli', cwd: ctx.cwd, source, sources, pluginRoot: PLUGIN_ROOT, start, config: cfg, env: ctx.env,
    ...(optionValue(a, '--model') !== undefined ? { model: optionValue(a, '--model') } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  })
  warn(ctx, warnings)

  const escalate = a.options.has('--escalate')
  if (a.options.has('--json')) {
    const out = escalate ? { ...r, escalation_prompt: escalationPrompt(r.escalation) } : r
    ctx.write(`${JSON.stringify(out, null, 2)}\n`)
  } else {
    const ansi = ctx.tty && !a.options.has('--no-color') && (ctx.env.NO_COLOR ?? '') === ''
    ctx.write(renderTerminal(r, cfg.checks, { ansi, policy: p, title: effectiveTitle }))
    if (escalate) {
      ctx.write('\n')
      ctx.write(r.escalation.length > 0 ? `${escalationPrompt(r.escalation)}\n` : 'no escalation: nothing to pass to Claude\n')
    }
  }

  // The CLI log only on request: this is the user's terminal, not a hook.
  const log = ctx.env.JEV_HOOKS_LOG
  if (log !== undefined && log !== '') {
    try {
      const root = repoRoot(ctx.cwd, nodeClock.now() + 5000, ctx.env)
      appendLog(resolve(ctx.cwd, log), logLine(r, {
        origin: 'cli', repo: basename(root ?? ctx.cwd), version: pluginVersion(PLUGIN_ROOT), ...(identity ? { identity } : {}),
      }))
    } catch (err) {
      ctx.writeErr(`[jev-review] log not written (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`)
    }
  }
  return r.exit_code
}

// ─── explain ──────────────────────────────────────────────────────────────────

function explainCommand(a: ParsedArgs, ctx: CliContext): number {
  const cfg = loadCliConfig(a, ctx)
  if (typeof cfg === 'number') return cfg
  warn(ctx, cfg.warnings)
  const id = a.positionals[0]
  if (!Object.hasOwn(cfg.checks.defs, id)) {
    ctx.writeErr(`jev-review: unknown check "${id}". Checks in ${cfg.sources.checks}: ${cfg.checks.order.join(', ')}\n`)
    return EXIT_ERROR
  }
  const names = cfg.calibration.profiles.map((x) => x.name)
  const withLog = ctx.env.JEV_HOOKS_LOG !== undefined && ctx.env.JEV_HOOKS_LOG !== ''
  let ps: ExplainedProfile | null = null
  const requested = optionValue(a, '--profile')
  if (requested !== undefined) {
    const pr = cfg.calibration.profiles.find((x) => x.name === requested)
    if (!pr) {
      ctx.writeErr(`jev-review: unknown profile "${requested}". Profiles in ${cfg.sources.calibration}: ${names.join(', ')}\n`)
      return EXIT_ERROR
    }
    ps = { profile: pr, mode: 'client', origin: '--profile' }
  } else if (withLog) {
    // The profile of the last recorded review, only from the JEV_HOOKS_LOG log. The
    // hooks' log is in CLAUDE_PLUGIN_DATA, which Claude Code sets only for the hooks: it
    // cannot be seen from the user's terminal, and dataDir() would lead to the XDG state
    // dir, where nobody writes.
    const last = lastReview(resolve(ctx.cwd, ctx.env.JEV_HOOKS_LOG as string))
    if (last?.profile !== undefined) {
      const pr = cfg.calibration.profiles.find((x) => x.name === last.profile)
      if (pr) ps = { profile: pr, mode: (last.mode === 'server' ? 'server' : 'client') as CalibrationMode, origin: `last recorded review${last.ts ? `, ${last.ts}` : ''}` }
      else ctx.writeErr(`[jev-review] profile ${last.profile} of the last review is no longer in ${cfg.sources.calibration}\n`)
    }
  }
  ctx.write(renderExplanation(id, cfg, ps))
  if (!ps) {
    if (!withLog) ctx.write("last review: the CLI looks for it only in the JEV_HOOKS_LOG log (the hooks' log is in the plugin data dir, CLAUDE_PLUGIN_DATA)\n")
    ctx.write(`available profiles: ${names.join(', ')} (jev-review explain ${id} --profile NAME)\n`)
  }
  return 0
}

// ─── status ───────────────────────────────────────────────────────────────────

async function statusCommand(a: ParsedArgs, ctx: CliContext): Promise<number> {
  const cfg = loadCliConfig(a, ctx)
  if (typeof cfg === 'number') return cfg
  warn(ctx, cfg.warnings)
  const sources = backendSources('cli', ctx.env, { explicitUrl: optionValue(a, '--url'), keyFile: keyFromFile(ctx) })
  const model = optionValue(a, '--model')
  const s = await probeStatus({ config: cfg, sources, origin: 'cli', ...(model !== undefined ? { model } : {}) })
  if (!s.ok) {
    ctx.writeErr(`jev-review status: ${s.error.message}\n`)
    return EXIT_ERROR
  }
  const v = s.value
  const version = pluginVersion(PLUGIN_ROOT)
  if (a.options.has('--json')) {
    ctx.write(`${JSON.stringify({ pluginVersion: version, ...v }, null, 2)}\n`)
    return 0
  }
  const lines = [
    `plugin: jev-hooks ${version}`,
    `backend: ${v.host}${v.local ? ' (local)' : ''} · source: ${v.layer}`,
    `model: requested ${v.requestedModel}, served ${v.model} · family ${v.family}`,
  ]
  if (v.models) lines.push(`models: ${v.models.join(', ') || '(none)'}`)
  if (v.modelsNote) lines.push(v.modelsNote)
  lines.push(`fingerprint: ${v.fingerprint ?? '(none)'}`)
  lines.push(`probability_status: ${v.probabilityStatus?.join(', ') ?? '(none)'}`)
  lines.push(`probe decision: ${v.question} in ${formatNumber(v.ms / 1000, 2)} s`)
  lines.push(`profile: ${v.profile} (${v.calibrated ? 'calibrated' : 'uncalibrated'}) · calibration ${v.mode} · δ = ${formatNumber(v.deltaLogit, 2)}`)
  for (const n of v.notes) lines.push(`note: ${n}`)
  lines.push(`config: ${Object.entries(v.sources).map(([k, f]) => `${k}.json = ${f}`).join('; ')}`)
  ctx.write(`${lines.join('\n')}\n`)
  return 0
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main(argv: readonly string[], ctx: CliContext): Promise<number> {
  let a: ParsedArgs | 'help'
  try {
    a = parseArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    ctx.writeErr(`jev-review: ${err.message}\n\n${USAGE}`)
    return EXIT_ERROR
  }
  if (a === 'help') {
    ctx.write(USAGE)
    return 0
  }
  try {
    if (a.command === 'explain') return explainCommand(a, ctx)
    if (a.command === 'status') return await statusCommand(a, ctx)
    return await reviewCommand(a, ctx)
  } catch (err) {
    ctx.writeErr(`jev-review: internal error: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_ERROR
  }
}

// Standard input up to the cap: a longer diff would be truncated anyway.
export async function readStdinNode(cap: number): Promise<string> {
  const pieces: Buffer[] = []
  let n = 0
  for await (const piece of process.stdin) {
    const b = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece))
    pieces.push(b)
    n += b.length
    if (n >= cap) break
  }
  return Buffer.concat(pieces).subarray(0, cap).toString('utf8')
}

export function nodeContext(): CliContext {
  return {
    env: process.env,
    cwd: process.cwd(),
    write: (s) => { process.stdout.write(s) },
    writeErr: (s) => { process.stderr.write(s) },
    tty: process.stdout.isTTY === true,
    readStdin: readStdinNode,
  }
}
