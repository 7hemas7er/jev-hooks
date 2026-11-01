// The subagent router's decisions, pure (rule 4), like router.ts for the effort
// router. hooks/register.ts carries data between `$` and these functions: which
// configuration, whether a spawn is looked at, what is sent, which model, what the
// lines say. Every exported function is total on what the engine, the backend and the
// files hand it: bad input gives a skip, an error Result or a reason, never an
// exception. The lines never carry the task prompt, a key or text the backend wrote.
//
// The router only lowers, and only where it was measured: an option of the task
// question that route maps (by default, checking a stated claim and labelling against
// a written definition), with the backend's calibrated p at min_top_probability or
// more. Every other spawn runs as its caller decided.
import { agentsRestrictions, validateAgents } from './config.ts'
import { DEFAULT_AGENTS } from './defaults.ts'
import { formatProblem, isObject, parseJson } from './json.ts'
import { formatNumber } from './numbers.ts'
import { routerCalibration, textRequest } from './router.ts'
import type { AgentSpawn, AgentsConfig, Classification, Failure, ModelChoice, RouterBackend, RouterRequest } from './types.ts'

export type { AgentSpawn, AgentsConfig, ModelChoice } from './types.ts'

export const AGENTS_FILES = {
  user: '~/.config/jev-hooks/agents.json',
  project: '.jev-hooks/agents.json',
  projectMainTree: '.jev-hooks/agents.json (main working tree)',
  plugin: 'agents.json (plugin)',
} as const

function firstProblem(e: Failure): string {
  return e.problems && e.problems.length > 0 ? formatProblem(e.problems[0]) : e.message
}

function textOf(o: unknown, k: string): string | null {
  if (!isObject(o)) return null
  const v = o[k]
  return typeof v === 'string' ? v : null
}

// The plugin's agents.json, unless the user's is valid (a whole file: it replaces the
// plugin's); a user file that cannot be read, or an invalid one that asks for
// "enabled": false, keeps the router off. Each project file can only turn it off
// (agentsRestrictions); one that cannot be read turns it off too, since it may hold
// that switch. The calibration is the routers' (routerCalibration). Off unless the
// agent_router option is true.
export function effectiveAgentsConfig(
  f: {
    user: string | null; userUnreadable?: boolean; projects: readonly { label: string; text: string | null; unreadable?: boolean }[]
    userCalibration: string | null; userCalibrationUnreadable?: boolean
  },
  options: Readonly<Record<string, unknown>>,
): { cfg: AgentsConfig | null; notes: string[] } {
  const notes: string[] = []
  const calibration = routerCalibration(f, notes)
  if (!calibration) return { cfg: null, notes }
  const user = textOf(f, 'user')
  const userUnreadable = user === null && isObject(f) && f.userUnreadable === true

  let cfg: AgentsConfig | undefined
  let userOff = userUnreadable
  if (userUnreadable) notes.push(`${AGENTS_FILES.user}: unreadable, the subagent router stays off until it can be read`)
  if (user !== null) {
    const parsed = parseJson(user, AGENTS_FILES.user)
    userOff = parsed.ok && isObject(parsed.value) && parsed.value.enabled === false
    const v = parsed.ok ? validateAgents(parsed.value, calibration, AGENTS_FILES.user) : parsed
    if (v.ok) cfg = v.value
    else notes.push(`${AGENTS_FILES.user}: invalid, ${userOff ? 'the subagent router stays off as the file asks' : "the plugin's agents.json is used"} (${firstProblem(v.error)})`)
  }
  if (!cfg) {
    const d = validateAgents(DEFAULT_AGENTS, calibration, AGENTS_FILES.plugin)
    if (!d.ok) return { cfg: null, notes: [...notes, `${AGENTS_FILES.plugin}: invalid (${firstProblem(d.error)})`] }
    cfg = d.value
  }
  if (userOff) cfg = { ...cfg, enabled: false }

  const projects = isObject(f) && Array.isArray(f.projects) ? f.projects : []
  const seen = new Set<string>()
  for (const project of projects) {
    const label = isObject(project) && typeof project.label === 'string' ? project.label : AGENTS_FILES.project
    const text = textOf(project, 'text')
    if (text === null) {
      if (isObject(project) && project.unreadable === true) {
        cfg = { ...cfg, enabled: false }
        notes.push(`${label}: unreadable, the subagent router stays off until it can be read`)
      }
      continue
    }
    if (seen.has(text)) continue
    seen.add(text)
    // untrusted: a parse error names a position, never a piece of the file
    const parsed = parseJson(text, label, true)
    if (!parsed.ok) {
      notes.push(`${label}: invalid, ignored`)
      continue
    }
    const r = agentsRestrictions(cfg, parsed.value, label)
    cfg = r.agents
    for (const n of r.notes) notes.push(n)
  }

  if (!(isObject(options) && options.agent_router === true)) cfg = { ...cfg, enabled: false }
  return { cfg, notes }
}

// A substring of the model id, case-insensitive, as the effort router's only_models.
function modelIn(list: readonly string[], model: string): boolean {
  if (typeof model !== 'string' || model === '') return false
  const m = model.toLowerCase()
  return list.some((x) => m.includes(x.toLowerCase()))
}

// Why a spawn is not looked at, or null. Checked before any request: a fork inherits
// the parent's context and model (another model would lose its prompt cache), a
// teammate keeps the model its team gave it, a caller that named a model had a reason.
export function spawnSkip(s: AgentSpawn, cfg: AgentsConfig): string | null {
  if (!cfg.enabled) return 'subagent router off'
  if (!isObject(s)) return 'no spawn'
  if (s.fork === true) return 'a fork keeps the parent model'
  if (s.isTeammate === true) return 'a teammate keeps its model'
  if (s.workflow === true && !cfg.workflow_agents) return 'workflow agents are not routed (workflow_agents)'
  if (cfg.respect_explicit_model && typeof s.model === 'string' && s.model !== '') return 'the caller named a model'
  if (cfg.skip_types.includes(s.subagentType)) return `type ${String(s.subagentType).slice(0, 64)} is in skip_types`
  if (!modelIn(cfg.from_models, s.parentModel)) return 'parent model not in from_models'
  return null
}

// What goes to the backend for one task prompt: the effort router's textRequest, with
// this router's clip and its one question. An empty prompt sends nothing.
export function agentRequest(cfg: AgentsConfig, prompt: string, b: RouterBackend, maskFile: { text: string | null; error?: string },
  seed: number): RouterRequest {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.trim() === '') return { skip: 'empty task prompt' }
  return textRequest(text, b, maskFile, seed, { max: cfg.prompt_max_chars, head: cfg.prompt_head_chars }, cfg.questions)
}

// The model for the subagent, or why it stays where its caller put it.
export function chooseModel(c: Classification | null, s: AgentSpawn, cfg: AgentsConfig): ModelChoice {
  if (!cfg.enabled) return { reason: 'subagent router off' }
  if (!isObject(c) || typeof c.taskKind !== 'string' || typeof c.pTask !== 'number') return { reason: 'no classification' }
  const kind = c.taskKind
  const task = `${kind} ${formatNumber(c.pTask)}`
  if (!(c.pTask >= cfg.min_top_probability)) return { reason: `left as is (${task} < ${formatNumber(cfg.min_top_probability)})`, task: kind }
  const target = Object.hasOwn(cfg.route, kind) ? cfg.route[kind] : undefined
  if (target === undefined) return { reason: `left as is (${task})`, task: kind }
  if (isObject(s) && typeof s.parentModel === 'string' && s.parentModel.toLowerCase().includes(target.toLowerCase())) {
    return { reason: `left as is (${task}: already ${target})`, task: kind }
  }
  return { model: target, reason: `${task} → ${target}`, task: kind }
}

// How long a spawn waits for its answer: a workflow agent runs for minutes and was
// started by a script, nobody watches it start, so it may wait longer.
export function agentTimeoutMs(cfg: AgentsConfig, s: AgentSpawn): number {
  return isObject(s) && s.workflow === true && typeof cfg.workflow_timeout_ms === 'number' ? cfg.workflow_timeout_ms : cfg.timeout_ms
}

// The run a workflow agent belongs to ('' for any other spawn). Read from the event's
// own field, typed unknown: the declarations before 2.1.294 lack it.
export function workflowRunId(workflow: unknown): string {
  if (!isObject(workflow) || typeof workflow.runId !== 'string') return ''
  return workflow.runId.slice(0, 200)
}

// The part of a workflow agent's task prompt that is its own. Scripts often open every
// agent's prompt with the same context block (the repository, its rules, the plan);
// clipped to prompt_max_chars, such a prompt shows the backend that block and its
// tail, and every agent of the run looks the same (measured 2026-11-01 on 88 real
// workflow prompts: almost all read as implement). The longest head shared with an
// earlier prompt of the same run is dropped, from a line start, when it is at least
// minChars long and something is left after it; otherwise the prompt is unchanged.
export function ownTask(text: string, earlier: readonly string[], minChars: number | undefined): { text: string; shared: number } {
  if (typeof text !== 'string') return { text: '', shared: 0 }
  if (typeof minChars !== 'number' || !(minChars > 0) || !Array.isArray(earlier)) return { text, shared: 0 }
  let longest = 0
  for (const e of earlier) {
    if (typeof e !== 'string') continue
    const n = Math.min(e.length, text.length)
    let i = 0
    while (i < n && e.charCodeAt(i) === text.charCodeAt(i)) i++
    if (i > longest) longest = i
  }
  if (longest < minChars) return { text, shared: 0 }
  // back to the start of the line the shared head ends in: a line half shared is the
  // agent's own
  const cut = text.lastIndexOf('\n', longest - 1) + 1
  if (cut < minChars) return { text, shared: 0 }
  const rest = text.slice(cut)
  if (rest.trim() === '') return { text, shared: 0 }
  return { text: rest, shared: cut }
}

// What the router did since the last summary line: spawns looked at, moved per model,
// left as is per task kind, and those without an answer (timeout, busy, error).
export interface AgentsTally { looked: number; moved: Record<string, number>; left: Record<string, number>; unanswered: number }

// Null-prototype records: an option or a model named like an Object property
// (constructor, __proto__) is counted as any other.
export function emptyTally(): AgentsTally {
  return { looked: 0, moved: Object.create(null) as Record<string, number>, left: Object.create(null) as Record<string, number>, unanswered: 0 }
}

function bump(r: Record<string, number>, k: string): void {
  r[k] = (Object.hasOwn(r, k) ? r[k] : 0) + 1
}

export function tallyChoice(t: AgentsTally, choice: ModelChoice | null): void {
  if (!isObject(t)) return
  t.looked++
  if (!isObject(choice) || typeof choice.task !== 'string') {
    t.unanswered++
    return
  }
  if (typeof choice.model === 'string') bump(t.moved, choice.model)
  else bump(t.left, choice.task)
}

// One transcript line for a tally, or null when no spawn was looked at. Successful
// decisions go to the debug log one by one (spawns come by the dozen): without this
// line a router that works and one that never answers look the same.
export function tallyLine(t: AgentsTally): string | null {
  if (!isObject(t) || !(t.looked > 0)) return null
  const n = (x: number): string => formatNumber(x, 0)
  const sorted = (r: Record<string, number>): [string, number][] => Object.entries(r).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const moved = sorted(t.moved)
  const total = moved.reduce((a, [, v]) => a + v, 0)
  const parts = [moved.length === 0
    ? `0 of ${n(t.looked)} subagents moved`
    : `${n(total)} of ${n(t.looked)} subagents moved (${moved.map(([k, v]) => `${n(v)} to ${k.replace(/^claude-/, '')}`).join(', ')})`]
  const left = sorted(t.left)
  if (left.length > 0) parts.push(`left as is: ${left.map(([k, v]) => `${k} ${n(v)}`).join(', ')}`)
  if (t.unanswered > 0) parts.push(`no answer ${n(t.unanswered)}`)
  return `[jev-hooks] agents: ${parts.join('; ')}`
}

// The debug line of a decision: the reason and what kind of spawn it was.
export function agentLine(choice: ModelChoice, s: AgentSpawn, ms?: number): string {
  const kind = isObject(s) && s.workflow === true ? 'workflow agent' : `${isObject(s) ? String(s.subagentType).slice(0, 64) : '?'} agent`
  const took = typeof ms === 'number' && Number.isFinite(ms) ? `, ${formatNumber(ms / 1000, 2)} s` : ''
  return `[jev-hooks] agents: ${choice.reason} (${kind}${took})`
}

// The status-line part: how many of the session's routed-or-not spawns moved, and to
// what. "claude-" is dropped from a single target to keep the line short.
export function agentsStatus(seen: number, moved: Readonly<Record<string, number>>): string | undefined {
  if (!(seen > 0)) return undefined
  const targets = Object.keys(moved).filter((k) => moved[k] > 0)
  const total = targets.reduce((a, k) => a + moved[k], 0)
  const where = targets.length === 1 ? ` on ${targets[0].replace(/^claude-/, '')}` : ' moved'
  return `jev agents: ${formatNumber(total, 0)} of ${formatNumber(seen, 0)}${where}`
}

