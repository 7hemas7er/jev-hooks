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
  const task = `${c.taskKind} ${formatNumber(c.pTask)}`
  if (!(c.pTask >= cfg.min_top_probability)) return { reason: `left as is (${task} < ${formatNumber(cfg.min_top_probability)})` }
  const target = Object.hasOwn(cfg.route, c.taskKind) ? cfg.route[c.taskKind] : undefined
  if (target === undefined) return { reason: `left as is (${task})` }
  if (isObject(s) && typeof s.parentModel === 'string' && s.parentModel.toLowerCase().includes(target.toLowerCase())) {
    return { reason: `left as is (${task}: already ${target})` }
  }
  return { model: target, reason: `${task} → ${target}` }
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

