// The GitHub Action (action.yml, started by action/entry.mjs).
//
// Mode workflow_run: the second phase of a two-phase review (examples/workflows/). The
// first phase runs on pull_request without secrets and uploads the PR number and the
// diff as an artifact; on a pull request from a fork its author can rewrite that
// workflow, so whatever it produces is hostile and serves only as a cross-check. This
// phase runs from the default branch with the secrets. It takes the head sha, branch and
// repository from the workflow_run payload (trusted), finds the one open PR they match,
// reviews the diff GitHub's API gives for base...head (tied to the SHAs: a push in
// between changes nothing) and always publishes a completed check run.
//
// Mode file: reviews diff-file with no GitHub API, for a smoke test.
//
// Conclusions follow policy.ci: backend_unavailable (neutral by default) only for a
// backend that is down, unreachable or not configured; untrusted_input (failure by
// default) for everything the PR author controls or can cause, an internal error
// included: a diff crafted to crash the action must not earn a neutral.
//
// Exit 0 whatever the verdict, since the check run carries it and branch protection can
// require it; exit 1 only when no check run could be created.
import { randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRunMarkdown, escapeMarkdown, safeText } from '../core/render.ts'
import type { BackendSources, CiConclusion, Policy, ReviewResult, Transport } from '../core/types.ts'
import { loadConfig } from '../node/file-config.ts'
import type { LoadedConfig } from '../node/file-config.ts'
import { runReview } from '../node/run.ts'
import { nodeClock } from '../node/transport.ts'

export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const CHECK_NAME = 'jev-review'
const RE_SHA = /^[0-9a-f]{40}$/
const RE_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const PR_JSON_CAP = 1024
const API_TIMEOUT_MS = 30_000
const LIST_CAP = 8 * 1024 * 1024

export interface ActionContext {
  env: NodeJS.ProcessEnv
  write: (s: string) => void             // stdout: the log and the workflow commands
  fetch?: typeof fetch                   // GitHub's API
  transport?: Transport                  // the review backend
}

type CiClass = 'backend_unavailable' | 'untrusted_input'

// An outcome decided before the review: a class of policy.ci and a reason of ours,
// never a text from the PR.
class Stop extends Error {
  cls: CiClass
  constructor(cls: CiClass, message: string) {
    super(message)
    this.cls = cls
  }
}

// Inputs arrive as INPUT_<NAME>, upper case, hyphens kept (INPUT_API-KEY).
function input(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.toUpperCase()}`] ?? '').trim()
}

// ─── GitHub's API ─────────────────────────────────────────────────────────────

interface Api { base: string; repo: string; token: string; fetch: typeof fetch }

// No redirects: a redirect could carry the token, or the diff request, elsewhere.
async function call(api: Api, method: string, path: string, o: { accept?: string; body?: unknown; token?: string; cap?: number } = {}):
  Promise<{ status: number; text: string; truncated: boolean }> {
  const headers: Record<string, string> = {
    Accept: o.accept ?? 'application/vnd.github+json',
    Authorization: `Bearer ${o.token ?? api.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jev-hooks',
  }
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await api.fetch(`${api.base}${path}`, {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS),
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  })
  const cap = o.cap ?? LIST_CAP
  const pieces: Uint8Array[] = []
  let n = 0
  let truncated = false
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pieces.push(value)
      n += value.length
      if (n > cap) {
        truncated = true
        await reader.cancel()
        break
      }
    }
  }
  const text = Buffer.concat(pieces).subarray(0, cap).toString('utf8')
  return { status: res.status, text, truncated }
}

// ─── The pull request ─────────────────────────────────────────────────────────

interface Run { headSha: string; headBranch: string; headRepo: string; headOwner: string; conclusion: string }

// The trusted payload. Without a head sha there is nothing to attach a check run to.
function readEvent(env: NodeJS.ProcessEnv): Run {
  const path = env.GITHUB_EVENT_PATH ?? ''
  let e: { workflow_run?: Record<string, unknown> }
  try {
    e = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('GITHUB_EVENT_PATH is not a readable JSON event')
  }
  const w = e?.workflow_run
  const repo = w?.head_repository as { full_name?: unknown; owner?: { login?: unknown } } | undefined
  if (!w || w.event !== 'pull_request' || typeof w.head_sha !== 'string' || !RE_SHA.test(w.head_sha)
    || typeof w.head_branch !== 'string' || typeof repo?.full_name !== 'string' || typeof repo.owner?.login !== 'string') {
    throw new Error('the event is not a workflow_run of a pull_request workflow: run this mode from examples/workflows/jev-review.yml')
  }
  return {
    headSha: w.head_sha, headBranch: w.head_branch, headRepo: repo.full_name, headOwner: repo.owner.login,
    conclusion: typeof w.conclusion === 'string' ? w.conclusion : '',
  }
}

interface Pull { number: number; baseSha: string; title: string; body: string | null }

// workflow_run.pull_requests is empty for forks: the PR is looked up by owner:branch and
// kept only if head sha, head repository and base repository all match.
async function findPull(api: Api, run: Run): Promise<Pull> {
  const head = encodeURIComponent(`${run.headOwner}:${run.headBranch}`)
  const r = await call(api, 'GET', `/repos/${api.repo}/pulls?state=open&head=${head}&per_page=100`)
  if (r.status !== 200 || r.truncated) throw new Stop('untrusted_input', `pull requests not readable (HTTP ${r.status})`)
  let list: unknown
  try {
    list = JSON.parse(r.text)
  } catch {
    throw new Stop('untrusted_input', 'pull requests not readable (not JSON)')
  }
  const found = (Array.isArray(list) ? list : []).filter((p) => p?.head?.sha === run.headSha
    && p?.head?.repo?.full_name === run.headRepo && p?.base?.repo?.full_name === api.repo)
  if (found.length !== 1) throw new Stop('untrusted_input', `pull request not identifiable (${found.length} match the head sha)`)
  const p = found[0]
  if (!Number.isSafeInteger(p.number) || p.number <= 0 || typeof p.base?.sha !== 'string' || !RE_SHA.test(p.base.sha)) {
    throw new Stop('untrusted_input', 'pull request not identifiable (unexpected fields)')
  }
  return { number: p.number, baseSha: p.base.sha, title: typeof p.title === 'string' ? p.title : '', body: typeof p.body === 'string' ? p.body : null }
}

// The first phase's artifact: hostile, only a cross-check. Regular files only, exactly
// pr.json and diff.patch, a strict schema, and the same PR and head sha as verified.
function readArtifact(dir: string, pull: Pull, run: Run, maxDiff: number): string {
  const bad = (why: string): Stop => new Stop('untrusted_input', `first-phase artifact ${why}`)
  let entries: string[]
  try {
    if (!lstatSync(dir).isDirectory()) throw bad('is not a directory')
    entries = readdirSync(dir).sort()
  } catch (err) {
    if (err instanceof Stop) throw err
    throw bad('missing: the first phase did not upload it, or the download failed')
  }
  if (entries.join(',') !== 'diff.patch,pr.json') throw bad('with unexpected files')
  for (const [name, cap] of [['pr.json', PR_JSON_CAP], ['diff.patch', maxDiff]] as const) {
    const st = lstatSync(join(dir, name))
    if (!st.isFile()) throw bad(`with ${name} not a regular file`)
    if (st.size > cap) throw bad(`with ${name} too large`)
  }
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(readFileSync(join(dir, 'pr.json'), 'utf8'))
  } catch {
    throw bad('with pr.json not JSON')
  }
  const keys = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? Object.keys(meta).sort().join(',') : ''
  if (keys !== 'base_sha,head_sha,pr,schema' || meta.schema !== 1 || !Number.isSafeInteger(meta.pr) || (meta.pr as number) <= 0
    || typeof meta.base_sha !== 'string' || !RE_SHA.test(meta.base_sha) || typeof meta.head_sha !== 'string' || !RE_SHA.test(meta.head_sha)) {
    throw bad('with pr.json outside its schema')
  }
  if (meta.pr !== pull.number || meta.head_sha !== run.headSha) throw bad('of another pull request or head sha')
  return readFileSync(join(dir, 'diff.patch'), 'utf8')
}

// The authoritative diff: compare between the two SHAs, not the PR's diff (a mutable
// resource). Too large means untrusted: a diff inflated on purpose must not fall back to
// the artifact or earn a neutral.
async function compareDiff(api: Api, pull: Pull, run: Run, maxDiff: number): Promise<string> {
  const r = await call(api, 'GET', `/repos/${api.repo}/compare/${pull.baseSha}...${run.headSha}`, { accept: 'application/vnd.github.diff', cap: maxDiff })
  if (r.status === 406 || r.status === 422 || r.truncated) throw new Stop('untrusted_input', 'diff too large for a complete review')
  if (r.status !== 200) throw new Stop('untrusted_input', `diff not readable (HTTP ${r.status})`)
  return r.text
}

// ─── Output ───────────────────────────────────────────────────────────────────

interface Outcome { conclusion: CiConclusion; title: string; summary: string; verdict: string; escalation: string }

function stopped(policy: Policy | undefined, cls: CiClass, reason: string): Outcome {
  const conclusion: CiConclusion = policy ? policy.ci[cls] : cls === 'backend_unavailable' ? 'neutral' : 'failure'
  const text = safeText(reason, 300)
  return {
    conclusion,
    title: `review not run: ${text}`,
    summary: `## review not run\n\n${escapeMarkdown(text)}\n\nCheck conclusion: **${conclusion}** (${cls})`,
    verdict: 'ERROR',
    escalation: '',
  }
}

function reviewed(r: ReviewResult, cfg: LoadedConfig, title: string): Outcome {
  const md = checkRunMarkdown(r, cfg.checks, { title })
  const c = r.ci
  const why = c.class !== undefined ? ` (${c.class}${c.reason !== undefined ? `: ${escapeMarkdown(safeText(c.reason, 300))}` : ''})` : ''
  return {
    conclusion: c.conclusion,
    title: md.title,
    summary: `${md.summary}\n\nCheck conclusion: **${c.conclusion}**${why}`,
    verdict: r.lane ?? 'ERROR',
    escalation: [...new Set(r.escalation.flatMap((v) => (v.check !== undefined ? [v.check] : [])))].join(','),
  }
}

// $GITHUB_OUTPUT with a random delimiter: no value can end the block early.
function writeOutputs(env: NodeJS.ProcessEnv, o: Outcome): void {
  const file = env.GITHUB_OUTPUT
  if (file === undefined || file === '') return
  const d = `ghadelimiter_${randomUUID()}`
  const lines = Object.entries({ verdict: o.verdict, conclusion: o.conclusion, escalation: o.escalation })
    .map(([k, v]) => `${k}<<${d}\n${v}\n${d}\n`)
  appendFileSync(file, lines.join(''))
}

function writeSummary(env: NodeJS.ProcessEnv, o: Outcome): void {
  const file = env.GITHUB_STEP_SUMMARY
  if (file !== undefined && file !== '') appendFileSync(file, `${o.summary}\n`)
}

// ─── Review ───────────────────────────────────────────────────────────────────

function sourcesFrom(env: NodeJS.ProcessEnv): BackendSources {
  const layer = { name: 'action inputs (url, api-key, model)', url: input(env, 'url'), key: input(env, 'api-key'), model: input(env, 'model') }
  return { layers: [layer] }
}

function loadActionConfig(env: NodeJS.ProcessEnv): LoadedConfig {
  // the rules come from .jev-hooks/ in the default branch's checkout, and can only tighten
  const c = loadConfig({ cwd: env.GITHUB_WORKSPACE || process.cwd(), pluginRoot: PLUGIN_ROOT, origin: 'action', env })
  if (!c.ok) throw new Error(c.error.message)
  return c.value
}

async function workflowRun(ctx: ActionContext, start: number): Promise<number> {
  const env = ctx.env
  const run = readEvent(env)
  const repo = env.GITHUB_REPOSITORY ?? ''
  if (!RE_REPO.test(repo)) throw new Error('GITHUB_REPOSITORY is missing or malformed')
  const api: Api = {
    base: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    repo, token: input(env, 'github-token'), fetch: ctx.fetch ?? fetch,
  }
  if (api.token === '') throw new Error('github-token is empty: the pull request cannot be looked up')
  const checksToken = input(env, 'checks-token') || api.token

  let cfg: LoadedConfig | undefined
  let outcome: Outcome
  try {
    cfg = loadActionConfig(env)
    const p = cfg.policy
    // the first phase can be rewritten by the PR author: a failure there is theirs
    if (run.conclusion !== 'success') throw new Stop('untrusted_input', `first phase did not succeed (${safeText(run.conclusion || 'no conclusion', 40)})`)
    const pull = await findPull(api, run)
    const artifact = readArtifact(input(env, 'input-dir'), pull, run, p.state.max_diff_bytes)
    const diff = await compareDiff(api, pull, run, p.state.max_diff_bytes)
    const { result } = await runReview({
      origin: 'action', cwd: env.GITHUB_WORKSPACE || process.cwd(), source: { kind: 'text', diff, title: pull.title, description: pull.body },
      sources: sourcesFrom(env), pluginRoot: PLUGIN_ROOT, start, config: cfg, env,
      ...(ctx.transport ? { transport: ctx.transport } : {}),
    })
    if (artifact !== diff) result.notes = [...(result.notes ?? []), "the first phase's diff differs from the real one: the real one was reviewed"]
    outcome = reviewed(result, cfg, pull.title)
  } catch (err) {
    // an unexpected message could quote the PR's input: it goes to the log only
    if (!(err instanceof Stop)) ctx.write(`::error::jev-review: ${safeText(err instanceof Error ? err.message : String(err), 300)}\n`)
    outcome = err instanceof Stop
      ? stopped(cfg?.policy, err.cls, err.message)
      : stopped(cfg?.policy, 'untrusted_input', 'internal error while reviewing the pull request')
  }

  writeOutputs(env, outcome)
  writeSummary(env, outcome)
  ctx.write(`jev-review: ${outcome.verdict} · check conclusion ${outcome.conclusion}\n`)
  let created = false
  try {
    const r = await call(api, 'POST', `/repos/${api.repo}/check-runs`, {
      token: checksToken,
      body: { name: CHECK_NAME, head_sha: run.headSha, status: 'completed', conclusion: outcome.conclusion, output: { title: outcome.title, summary: outcome.summary } },
      cap: 64 * 1024,
    })
    created = r.status === 201
    if (!created) ctx.write(`::error::jev-review: the check run was not created (HTTP ${r.status}): the token needs checks: write\n`)
  } catch (err) {
    ctx.write(`::error::jev-review: the check run was not created (${safeText(err instanceof Error ? err.message : String(err), 200)})\n`)
  }
  return created ? 0 : 1
}

async function fileMode(ctx: ActionContext, start: number): Promise<number> {
  const env = ctx.env
  const cfg = loadActionConfig(env)
  const path = input(env, 'diff-file')
  if (path === '') throw new Error('mode file needs diff-file')
  const { result } = await runReview({
    origin: 'action', cwd: env.GITHUB_WORKSPACE || process.cwd(), source: { kind: 'file', path: resolve(env.GITHUB_WORKSPACE || process.cwd(), path) },
    sources: sourcesFrom(env), pluginRoot: PLUGIN_ROOT, start, config: cfg, env,
    ...(ctx.transport ? { transport: ctx.transport } : {}),
  })
  const outcome = reviewed(result, cfg, '')
  writeOutputs(env, outcome)
  writeSummary(env, outcome)
  ctx.write(`jev-review: ${outcome.verdict} · check conclusion ${outcome.conclusion}\n`)
  return 0
}

export async function main(ctx: ActionContext): Promise<number> {
  const start = nodeClock.now()
  // the key never shows in the log, one line at a time as the runner masks them
  for (const line of input(ctx.env, 'api-key').split(/\r?\n/)) if (line.trim() !== '') ctx.write(`::add-mask::${line.trim()}\n`)
  const mode = input(ctx.env, 'mode') || 'workflow_run'
  try {
    if (mode === 'workflow_run') return await workflowRun(ctx, start)
    if (mode === 'file') return await fileMode(ctx, start)
    ctx.write(`::error::jev-review: unknown mode (workflow_run or file)\n`)
    return 1
  } catch (err) {
    ctx.write(`::error::jev-review: ${safeText(err instanceof Error ? err.message : String(err), 300)}\n`)
    return 1
  }
}
