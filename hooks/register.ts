// The effort router: a function hook (Claude Code 2.1.283, early access) that asks the
// /v1/systemone backend what kind of request a prompt is and lowers that turn's effort
// when the answer allows it. Off unless the effort_router option is true.
//
// The same module holds the subagent router (agent_router option, Claude Code 2.1.294):
// agent.spawn asks the backend what kind of task a subagent was given and moves the
// ones config/agents.json routes to a cheaper model, an Agent tool spawn in its input,
// a workflow agent (whose spawn cannot be rewritten) at each of its steps in turn.step.
// Its decisions are in src/core/agents.ts.
//
// What it decides lives in src/core/router.ts; this file only carries data between
// `$` and those pure functions. The plugin scanner (`claude plugin validate`) refuses a
// module that passes `$` to an imported function (it follows `$` only into a function
// declared at the top of the same file), binds a noun of `$` to a value, reads one
// with `?.` or `[...]`, or calls `$.env.get` with anything but a literal name: every
// call is spelled `$.noun.method(...)` at its call site, so the manifest can list what
// the module calls and which variables it reads. It also refuses a .json import (hence
// src/core/defaults.ts) and a top-level await in an imported file. This file is pure
// too (rule 4, purity.test.ts scans it): the timeout is `$.clock.after`, never
// AbortController, setTimeout or Date.
//
// The path of a prompt: prompt.submit classifies it (the prompt waits for the answer,
// timeout_ms at most unless the timer is refused: see the budget), turn.start binds the
// classification to the turn its text started (and reads the clock once, for the cache
// guard), turn.step changes the effort of that turn's main-loop requests.
// Everything fails open: a problem leaves the turn as it is and says so in one
// transcript line (the same line again goes to the debug log, until another line or a
// classification replaces it). A guardrail mask map that cannot be read, parsed or
// even looked for is such a problem: nothing goes to a non-local backend until it is
// fixed. A router.json that exists but cannot be read, the user's or a project's, is
// not a problem but a note, like every note on the configuration files: it may hold
// an "enabled": false, so the router stays off until it can be read, and the note goes
// to the transcript once and again only when the notes change (its repeats go nowhere,
// not even to the debug log). A prompt the router does not send by design (its origin, an empty text, a
// '/' or '!', a busy backend, a model outside only_models, a body outside the
// backend's limits) is noted in the debug log only, and a user interrupt says nothing.
//
// The budget (2.1.283): a hook runs under 10 s of its own time, and its clock stops
// while any `$` call other than a clock wait is in flight, so the race below costs
// nothing while the fetch is out. `$.http.fetch` takes no signal of its own (the engine
// aborts it with the prompt's dispatch, on Esc) and has no timeout but the host's 30 s,
// so the losing request runs to its end: inFlight and busyUntil keep the next prompts
// from piling more on the backend meanwhile. The race's timer is a `$.clock.after`,
// and another hook may refuse that call: the timer then never fires and nothing says
// so, and the prompt waits for the fetch itself, up to the host's 30 s.
//
// turn.step never awaits a `$` call: every model request of the session passes through
// it and would wait. What it needs was prepared by prompt.submit; the only `$` calls
// there are $.ui.log and $.ui.status, which are synchronous.
import type { Register } from 'claude-code'
import { sanitize } from '../src/core/backend.ts'
import { formatNumber } from '../src/core/numbers.ts'
import {
  GUARD_START, ROUTER_FILES, cacheGuard, chooseEffort, decisionLine, effectiveRouterConfig, fetchFailure, guardLine,
  modelAllowed, parseClassification, prepareRequest, routerBackend, routerLogLine, statusLine, userConfigDir,
} from '../src/core/router.ts'
import type { Classification, GuardState, GuardStep, RouterContext, SessionEffort } from '../src/core/router.ts'
import type { AgentSpawn, AgentsConfig, Effort, Result, RouterBackend, RouterConfig } from '../src/core/types.ts'
import { AGENTS_FILES, agentLine, agentRequest, agentsStatus, chooseModel, effectiveAgentsConfig, spawnSkip } from '../src/core/agents.ts'
import { dataFolderOf, joinStatus, lastReview, manifestVersion, mayCommit, newerVersions, statusText, versionFolder } from '../src/core/status-line.ts'
import type { LastReview } from '../src/core/status-line.ts'

type Effective = { cfg: RouterConfig | null; notes: string[] }
// unreadable: the file is there but cannot be read (see readClassified)
type ProjectFile = { label: string; text: string | null; unreadable?: boolean }
// a configuration file's text, or null with error 'unreadable' when it is there but
// cannot be read
type ConfigFile = { text: string | null; error?: string }
// A prompt seen by prompt.submit and, once the backend answered, its classification.
type Pending = { text: string; c?: Classification }

// How many prompts wait for their turn at most: a queued one, and what the engine
// submits meanwhile (a notification, a command). An older one has lost its turn.
const KEPT_PROMPTS = 4
// How far up from the session's directory the checkout's top level is looked for:
// every level is a call, and a deeper session falls back to $.session.repo()'s root,
// or to the session's directory when that call is refused.
const MAX_WALK = 32
// The engine rejects a read with `<plugin>: $.fs.read(<path>) failed: <errno>`. These
// two mean there is no file there; any other failure means one that cannot be read.
const RE_NO_FILE = /: (?:ENOENT|ENOTDIR)$/

const trimSlashes = (p: string): string => p.replace(/\/+$/, '')

function sameFiles(a: readonly ProjectFile[], b: readonly ProjectFile[]): boolean {
  return a.length === b.length
    && a.every((f, i) => f.label === b[i].label && f.text === b[i].text && f.unreadable === b[i].unreadable)
}

// ─── The status line (status_line option) ─────────────────────────────────────
//
// One line per plugin: what src/core/status-line.ts writes, and after it the router's
// text during a routed turn. These functions take `$` at the top level of this file,
// where the scanner follows it; what $ they need is spelled out here, so that this file
// names no engine type beyond Register. Each one fails quietly: a line that cannot be
// computed stays as it was.
type LineIo = {
  plugin: { root: string }
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    list(path?: string): Promise<readonly { name: string }[]>
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
  }
  session: { id(): Promise<string> }
  ui: { status(text: string | undefined): void }
}
type Line = { running: string; session: string; log: string | null; newer: string | null; last: LastReview | null }
// router: the effort router's part during a routed turn; agents: the subagent router's
// count for the session
type StatusUi = { line: Line | null; router: string | undefined; agents: string | undefined }

// The text for $.ui.status, with the router's part (undefined clears it) after the line,
// and the subagent router's count last.
function shown(ui: StatusUi, router: string | undefined): string | undefined {
  ui.router = router
  return joinStatus(joinStatus(ui.line ? statusText(ui.line) : undefined, router), ui.agents)
}

// JEV_HOOKS_DISABLE=1 turns off the whole plugin, the line too: read at every update,
// as the router reads it at every prompt. True when the line is off; it clears it then.
async function lineOff($: LineIo, ui: StatusUi): Promise<boolean> {
  if ((await $.env.get('JEV_HOOKS_DISABLE')) !== '1') return false
  if (ui.line !== null) {
    ui.line = null
    $.ui.status(shown(ui, ui.router))
  }
  return true
}

// The running version from the cache folder's name (from plugin.json for a
// --plugin-dir checkout), the session, and the log: CLAUDE_PLUGIN_DATA when the module
// sees it, otherwise the data folder Claude Code names after the cache path.
async function lineStart($: LineIo, ui: StatusUi): Promise<void> {
  try {
    if (await lineOff($, ui)) return
    const root = $.plugin.root
    let running = versionFolder(root)?.version ?? null
    if (running === null) running = manifestVersion(await $.fs.read(`${trimSlashes(root)}/.claude-plugin/plugin.json`))
    if (running === null) return
    const session = await $.session.id()
    const data = (await $.env.get('CLAUDE_PLUGIN_DATA')) || dataFolderOf(root)
    const log = data ? `${trimSlashes(data)}/log.jsonl` : null
    let last: LastReview | null = null
    if (log !== null) {
      try {
        last = lastReview(await $.fs.read(log), session)
      } catch {
        // no log yet: no commit reviewed
      }
    }
    ui.line = { running, session, log, newer: ui.line?.newer ?? null, last }
    $.ui.status(shown(ui, ui.router))
  } catch {
    // the line stays as it was
  }
}

// A newer version beside the running one: /plugin update downloads it, the session
// keeps what it loaded. Started here too when session.start never reached the module.
async function lineVersions($: LineIo, ui: StatusUi): Promise<void> {
  try {
    if (await lineOff($, ui)) return
    if (ui.line === null) await lineStart($, ui)
    const line = ui.line
    const folder = versionFolder($.plugin.root)
    if (line === null || folder === null) return
    let newer: string | null = null
    for (const v of newerVersions(folder.version, (await $.fs.list(folder.parent)).map((x) => x.name))) {
      if (await $.fs.exists(`${folder.parent}/${v}/.claude-plugin/plugin.json`)) {
        newer = v
        break
      }
    }
    if (newer === line.newer) return
    line.newer = newer
    $.ui.status(shown(ui, ui.router))
  } catch {
    // the line stays as it was
  }
}

// After a Bash call that may hold a commit: the session's last review, again.
async function lineAfterCommit($: LineIo, ui: StatusUi): Promise<void> {
  try {
    if (await lineOff($, ui)) return
    const line = ui.line
    if (line === null || line.log === null) return
    const last = lastReview(await $.fs.read(line.log), line.session)
    if (last === null) return
    line.last = last
    $.ui.status(shown(ui, ui.router))
  } catch {
    // the line stays as it was
  }
}

// ─── The routers' files and backend ───────────────────────────────────────────
//
// What both routers read before asking the backend: their configuration files, the
// backend and its key, guardrail's mask map. Each takes `$` at the top level of this
// file, where the scanner follows it.
type FilesIo = {
  env: { get(name: string): Promise<string | undefined> }
  fs: { read(path: string): Promise<string>; exists(path: string): Promise<boolean> }
  session: { repo(): Promise<{ root: string } | null>; cwd(): Promise<string> }
}
// the checkout's top level found from a session directory (null: none found). Only a
// walk that ran to its end is kept: one a refused call cut short is tried again.
type Walk = { last: { cwd: string; top: string | null } | null }
type RouterFiles = {
  home: string | undefined; dir: string | null
  user: string | null; userUnreadable: boolean; userCalibration: string | null; userCalibrationUnreadable: boolean
  projects: ProjectFile[]
}

// A configuration file read as the mask map is: only a missing file (RE_NO_FILE) is
// none. One that is there but cannot be read (EACCES, ELOOP, EISDIR, the size cap,
// another hook's refusal) is unreadable: a router file may hold the switch that keeps
// the router off, so the router stays off.
function readClassified($: FilesIo, path: string): Promise<ConfigFile> {
  return $.fs.read(path).then((text) => ({ text }), (err: unknown) =>
    (RE_NO_FILE.test(String(err)) ? { text: null } : { text: null, error: 'unreadable' }))
}

// The user's <name> and calibration.json, and the project's <name>. The reviewer reads
// .jev-hooks/ at `git rev-parse --show-toplevel`, the checkout's own top level, a
// linked worktree's included; $.session.repo() answers the main working tree's root
// even in a worktree. So the top level is looked for as git does, the first directory
// up from the session's that holds .git (a file in a linked worktree), and when it is
// not the main working tree's root both files are read: each can only restrict.
// Outside a repository, the session's directory. When another hook refuses
// $.session.repo the walk still finds the top level (the session's directory if it
// finds none); in a linked worktree only the checkout's own file is read then, since
// the main working tree's root is unknown.
async function routerFiles($: FilesIo, name: string, labels: { project: string; projectMainTree: string }, walk: Walk): Promise<RouterFiles> {
  const home = await $.env.get('HOME')
  const dir = userConfigDir(await $.env.get('XDG_CONFIG_HOME'), home)
  const userFile: ConfigFile = dir === null ? { text: null } : await readClassified($, `${dir}/jev-hooks/${name}`)
  const calibrationFile: ConfigFile = dir === null ? { text: null } : await readClassified($, `${dir}/jev-hooks/calibration.json`)

  // undefined: the call was refused, which says nothing of where the session is
  const repo = await $.session.repo().catch(() => undefined)
  const files: { label: string; path: string }[] = []
  if (repo === null) files.push({ label: labels.project, path: `./.jev-hooks/${name}` })
  else {
    const root = repo ? trimSlashes(repo.root) : null
    const cwd = await $.session.cwd().catch(() => null)
    let top: string | null = null
    if (typeof cwd === 'string') {
      if (walk.last && walk.last.cwd === cwd) top = walk.last.top
      else {
        let done = true
        if (cwd.startsWith('/')) {
          try {
            // d without its trailing slash: '' is the file system's root
            let d = trimSlashes(cwd)
            for (let i = 0; i < MAX_WALK; i++) {
              if (await $.fs.exists(`${d}/.git`)) {
                top = d
                break
              }
              if (d === '') break
              d = d.slice(0, d.lastIndexOf('/'))
            }
          } catch {
            // a refused call: for this prompt, as without the walk, the repository's
            // root, or the session's directory when that is unknown too; the next
            // prompt walks again
            done = false
          }
        }
        if (done) walk.last = { cwd, top }
      }
    }
    const checkout = top ?? root
    files.push({ label: labels.project, path: checkout === null ? `./.jev-hooks/${name}` : `${checkout}/.jev-hooks/${name}` })
    if (root !== null && checkout !== root) files.push({ label: labels.projectMainTree, path: `${root}/.jev-hooks/${name}` })
  }
  const projects: ProjectFile[] = []
  for (const f of files) {
    const r = await readClassified($, f.path)
    projects.push(r.error === undefined ? { label: f.label, text: r.text } : { label: f.label, text: null, unreadable: true })
  }
  return {
    home, dir, user: userFile.text, userUnreadable: userFile.error !== undefined, userCalibration: calibrationFile.text,
    userCalibrationUnreadable: calibrationFile.error !== undefined, projects,
  }
}

// The backend both routers ask, and its key: the options' router_url (or review_url),
// otherwise the environment's URL, never its key (routerBackend).
async function backendFor($: FilesIo, options: Readonly<Record<string, unknown>>, dir: string | null): Promise<Result<RouterBackend>> {
  const keyFile = dir === null ? null : await $.fs.read(`${dir}/jev-hooks/key`).catch(() => null)
  return routerBackend(options, { routerUrl: await $.env.get('JEV_HOOKS_ROUTER_URL'), url: await $.env.get('JEV_HOOKS_URL'), keyFile })
}

// Guardrail's mask map, looked up as the reviewer does; only a backend that leaves the
// machine needs it. Read without $.fs.exists, which answers false for any failed stat
// (EACCES, ELOOP) and would pass an existing map for a missing one. A map that cannot
// be read, or cannot be looked for (no HOME and no GUARDRAIL_MASK_MAP), stops the
// request: textRequest says so.
async function maskFileFor($: FilesIo, home: string | undefined, local: boolean): Promise<{ text: string | null; error?: string }> {
  if (local) return { text: null }
  const path = (await $.env.get('GUARDRAIL_MASK_MAP')) || (home ? `${home}/.config/guardrail/mask.tsv` : '')
  if (path === '') return { text: null, error: 'no home' }
  return $.fs.read(path).then((text) => ({ text }), (err: unknown) =>
    (RE_NO_FILE.test(String(err)) ? { text: null } : { text: null, error: 'unreadable' }))
}

export const register: Register = (on, options) => {
  // The enable gates. Options are fixed for an activation (a change reloads the
  // module): with all three off nothing is registered, and with the router off no prompt pays
  // for a $ call (the status line only listens to session.start, turn.start and Bash
  // calls); effectiveRouterConfig checks the router's option a second time.
  const lineOn = options.status_line !== false
  const routerOn = options.effort_router === true
  const agentsOn = options.agent_router === true
  if (!lineOn && !routerOn && !agentsOn) return

  const ui: StatusUi = { line: null, router: undefined, agents: undefined }
  if (lineOn) {
    on('session.start', async ($, e, next) => {
      const r = await next(e)
      await lineStart($, ui)
      return r
    })
    // After the call: the commit hook has written its review to the log by then.
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const ran = await next(e)
      if (mayCommit(e.command)) await lineAfterCommit($, ui)
      return ran
    })
  }
  // One turn.start for both (the scanner takes one registration per event). The router:
  // binding by text, the classification applies only to the turn its own prompt
  // started. A prompt dropped beneath, one folded into a running turn, a turn started
  // by a notification or a continuation (text "") never pick it up.
  // The start time is read after the binding: a refused clock then costs only the
  // guard's judgement of this turn, never its classification, and the binding is in
  // place even if the engine sends the first step before this hook settles. turn.start
  // is not on the path of every request, so it may await. The status line looks for a
  // newer version after the turn started, so the turn never waits for it. The router's
  // state below is declared only when the router is on: it is read only then.
  on('turn.start', async ($, e, next) => {
    const p = !routerOn || e.text === '' ? undefined : pending.find((x) => x.text === e.text)
    if (p) {
      pending = without(e.text)
      const bound: { turnId: string; startedAt?: number; c?: Classification } = p.c ? { turnId: e.turnId, c: p.c } : { turnId: e.turnId }
      turn = bound
      try {
        bound.startedAt = await $.clock.now()
      } catch {
        // no start time: this turn's first step is not judged, the reference stays
      }
    }
    const r = await next(e)
    if (lineOn) await lineVersions($, ui)
    return r
  })

  // Shared by both routers: where the checkout's top level was found, and the model each
  // routed workflow agent runs on (agent.spawn writes it, turn.step reads it).
  const walk: Walk = { last: null }
  const routed = new Map<string, string>()

  // The subagent router. Before a subagent starts, one question about its task prompt;
  // an Agent tool spawn gets the chosen model in its input, a workflow agent (whose
  // spawn cannot be rewritten) gets it at every one of its steps, from index 0: the
  // spawn's answer carries the agentId before the first step is sent. Every problem
  // leaves the subagent as its caller decided, and one transcript line says so.
  if (agentsOn) {
    let agentsMemo: {
      user: string | null; userUnreadable: boolean; projects: ProjectFile[]
      userCalibration: string | null; userCalibrationUnreadable: boolean; result: { cfg: AgentsConfig | null; notes: string[] }
    } | null = null
    let agentsNotes = ''
    let agentsProblem = ''
    let agentsInFlight = 0
    // spawns the router looked at (not skipped) and how many moved, per model
    let seen = 0
    const moved: Record<string, number> = {}
    // a workflow of hundreds of agents keeps only the newest
    const KEPT_AGENTS = 512
    const remember = (agentId: string, model: string): void => {
      routed.delete(agentId)
      routed.set(agentId, model)
      if (routed.size > KEPT_AGENTS) {
        const oldest = routed.keys().next()
        if (!oldest.done) routed.delete(oldest.value)
      }
    }
    const agentsSink = (line: string): 'transcript' | 'debug' => {
      if (line === agentsProblem) return 'debug'
      agentsProblem = line
      return 'transcript'
    }

    on('agent.spawn', async ($, e, next) => {
      let arg = e
      // the model a workflow agent's steps get, once its agentId is known
      let later: string | undefined
      let counted = false
      const s: AgentSpawn = {
        subagentType: e.subagentType, parentModel: e.parentModel, fork: e.fork === true,
        ...(typeof e.model === 'string' ? { model: e.model } : {}),
        ...(e.isTeammate === true ? { isTeammate: true } : {}),
        ...(e.workflow !== undefined ? { workflow: true } : {}),
      }
      let key = ''
      // Every return leaves the spawn as it is: the single next(arg) is below.
      const decide = async (): Promise<void> => {
        if ((await $.env.get('JEV_HOOKS_AGENTS')) === '0' || (await $.env.get('JEV_HOOKS_DISABLE')) === '1') return
        const f = await routerFiles($, 'agents.json', AGENTS_FILES, walk)
        if (!agentsMemo || agentsMemo.user !== f.user || agentsMemo.userUnreadable !== f.userUnreadable
          || agentsMemo.userCalibration !== f.userCalibration || agentsMemo.userCalibrationUnreadable !== f.userCalibrationUnreadable
          || !sameFiles(agentsMemo.projects, f.projects)) {
          const read = {
            user: f.user, userUnreadable: f.userUnreadable, projects: f.projects, userCalibration: f.userCalibration,
            userCalibrationUnreadable: f.userCalibrationUnreadable,
          }
          agentsMemo = { ...read, result: effectiveAgentsConfig(read, options) }
        }
        const notes = agentsMemo.result.notes.join('\n')
        if (notes !== agentsNotes) {
          for (const n of agentsMemo.result.notes) $.ui.log(`[jev-hooks] agents: ${n}`)
          agentsNotes = notes
        }
        const c = agentsMemo.result.cfg
        if (!c || !c.enabled) return
        const skip = spawnSkip(s, c)
        if (skip !== null) {
          $.ui.log(`[jev-hooks] agents: left as is (${skip})`, { to: 'debug' })
          return
        }
        seen++
        counted = true
        if (agentsInFlight >= c.max_in_flight) {
          $.ui.log('[jev-hooks] agents: backend busy, left as is', { to: 'debug' })
          return
        }
        // The slot is taken here, before the awaits below, or a burst of spawns would all
        // pass the check; it is given back when the request settles (a late one keeps it
        // to its end, so a slow backend gets no more) or at once if none is made.
        agentsInFlight++
        let sent = false
        const release = (): void => {
          agentsInFlight--
        }
        try {
          const b = await backendFor($, options, f.dir)
          if (!b.ok) {
            const line = sanitize(b.error.message, '', 300)
            $.ui.log(`[jev-hooks] agents: ${line}`, { to: agentsSink(line) })
            return
          }
          key = b.value.key
          const maskFile = await maskFileFor($, f.home, b.value.local)
          const t0 = await $.clock.now()
          const prep = agentRequest(c, e.prompt, b.value, maskFile, t0)
          if ('skip' in prep) {
            if (prep.problem) $.ui.log(`[jev-hooks] agents: ${prep.skip}`, { to: agentsSink(prep.skip) })
            else $.ui.log(`[jev-hooks] agents: left as is (${prep.skip})`, { to: 'debug' })
          } else {
            // the race, as the effort router's: the answer, or null after timeout_ms
            const timer: { h?: { cancel(): void } } = {}
            const timeout = new Promise<null>((resolve) => {
              timer.h = $.clock.after(c.timeout_ms, () => resolve(null))
            })
            const request = $.http.fetch(prep.url, prep.init).finally(release)
            sent = true
            let res: { status: number; text: string } | null
            try {
              res = await Promise.race([request, timeout])
            } finally {
              timer.h?.cancel()
            }
            const ms = (await $.clock.now()) - t0
            if (res === null) {
              const line = `no answer in ${formatNumber(c.timeout_ms, 0)} ms, subagent left as is`
              $.ui.log(`[jev-hooks] agents: ${line}`, { to: agentsSink(line) })
            } else {
              const parsed = parseClassification(c, b.value, res.status, res.text)
              if (!parsed.ok) {
                const line = sanitize(parsed.error.message, key, 300)
                $.ui.log(`[jev-hooks] agents: ${line}`, { to: agentsSink(line) })
              } else {
                agentsProblem = ''
                const choice = chooseModel(parsed.value, s, c)
                $.ui.log(agentLine(choice, s, ms), { to: 'debug' })
                if (choice.model !== undefined) {
                  if (s.workflow === true) later = choice.model
                  else arg = { ...e, model: choice.model }
                }
              }
            }
          }
        } finally {
          if (!sent) release()
        }
      }
      try {
        await decide()
      } catch (err) {
        arg = e
        later = undefined
        // after an interrupt the engine rejects the spawn's calls: nothing to say then
        if (!next.signal.aborted) {
          try {
            const line = `error, subagent left as is (${sanitize(String(err), key, 200)})`
            $.ui.log(`[jev-hooks] agents: ${line}`, { to: agentsSink(line) })
          } catch {
            // not even the line could be written: the spawn goes on all the same
          }
        }
      }
      // outside any try: a refusal beneath is the engine's to report
      const r = await next(arg)
      try {
        if (r.deny === undefined) {
          const to = later ?? (arg !== e ? arg.model : undefined)
          if (later !== undefined && r.agentId !== undefined) remember(r.agentId, later)
          if (to !== undefined && (later === undefined || r.agentId !== undefined)) moved[to] = (moved[to] ?? 0) + 1
        }
        if (counted && lineOn) {
          ui.agents = agentsStatus(seen, moved)
          $.ui.status(shown(ui, ui.router))
        }
      } catch {
        // the count is the only thing lost
      }
      return r
    })
  }

  if (!routerOn && !agentsOn) return

  // The effort router's state. With the router off cfg stays null, and turn.step (which
  // the subagent router needs too) leaves every effort alone.
  let cfg: RouterConfig | null = null
  // the files of the last prompt and what they gave: unchanged files are not validated
  // again. Whether a user file could be read is part of the key: one that goes from
  // missing to unreadable keeps the same null text.
  let memo: {
    user: string | null; userUnreadable: boolean; projects: ProjectFile[]
    userCalibration: string | null; userCalibrationUnreadable: boolean; result: Effective
  } | null = null
  let lastNotes = ''
  // The prompts waiting for their turn, oldest first, one per text. A list, not a single
  // slot: a notification or a '/' command submitted while a queued prompt waits would
  // otherwise take the queued prompt's classification away. Every write touches only
  // the entry of the prompt that makes it.
  let pending: Pending[] = []
  // bound at turn.start, from the entry whose text the turn's is; startedAt is the
  // clock at that moment, absent when the clock could not be read
  let turn: { turnId: string; startedAt?: number; c?: Classification } | null = null
  let inFlight = false
  let busyUntil = 0
  // The start time of the bound turn whose step the cache guard saw last: its gap runs
  // from there to the start of the next bound turn. From turn starts, not prompts: a
  // prompt queued behind a running turn, or held by a slow UserPromptSubmit hook, comes
  // long before its turn starts. A prompt that starts no turn (dropped beneath, a '!'
  // command, abandoned), a turn that sends no request or one whose start time is unknown
  // leaves it where it is: the gap only grows, and stays an upper bound of the idle time.
  let guardRefAt: number | null = null
  // the model of the last main-loop step: the prompt's check before asking the backend
  let lastModel: string | null = null
  // what the current turn's index 0 decided, to apply again at the later steps
  let applied: { turnId: string; before?: SessionEffort; after?: Effort } | null = null
  let guard: GuardState = GUARD_START
  let lastProblem = ''

  const put = (p: Pending): void => {
    pending = [...pending.filter((x) => x.text !== p.text), p].slice(-KEPT_PROMPTS)
  }
  const without = (text: string): Pending[] => pending.filter((x) => x.text !== text)

  // A problem goes to the transcript once; the same line again goes to the debug log
  // only, until another line or a classification replaces it.
  const sink = (line: string): 'transcript' | 'debug' => {
    if (line === lastProblem) return 'debug'
    lastProblem = line
    return 'transcript'
  }

  if (routerOn) on('prompt.submit', async ($, e, next) => {
    let key = ''
    // A prompt typed or delivered during a turn (turnId set) leaves that turn's status
    // line alone: the turn still runs at the effort the line shows.
    const clearStatus = (): void => {
      if (e.turnId === undefined) $.ui.status(shown(ui, undefined))
    }
    const problem = (line: string): void => {
      $.ui.log(line, { to: sink(line) })
      clearStatus()
    }
    // Every return leaves the prompt as it is: the single next(e) is below.
    const classify = async (): Promise<void> => {
      if ((await $.env.get('JEV_HOOKS_ROUTER')) === '0' || (await $.env.get('JEV_HOOKS_DISABLE')) === '1') {
        cfg = null
        pending = []
        $.ui.status(shown(ui, undefined))
        return
      }
      const f = await routerFiles($, 'router.json', ROUTER_FILES, walk)
      const { home, dir, user, userUnreadable, userCalibration, userCalibrationUnreadable, projects } = f

      if (!memo || memo.user !== user || memo.userUnreadable !== userUnreadable || memo.userCalibration !== userCalibration
        || memo.userCalibrationUnreadable !== userCalibrationUnreadable || !sameFiles(memo.projects, projects)) {
        const read = { user, userUnreadable, projects, userCalibration, userCalibrationUnreadable }
        memo = { ...read, result: effectiveRouterConfig(read, options) }
      }
      const notes = memo.result.notes.join('\n')
      if (notes !== lastNotes) {
        for (const n of memo.result.notes) $.ui.log(`[jev-hooks] router: ${n}`)
        lastNotes = notes
      }
      const c = memo.result.cfg
      cfg = c
      if (!c || !c.enabled) {
        pending = []
        $.ui.status(shown(ui, undefined))
        return
      }

      const t0 = await $.clock.now()
      // no classification yet: the turn this prompt starts is still bound, so the cache
      // guard times it
      put({ text: e.text })
      // the cache guard turned the router off for this session
      if (guard.tripped) return
      // No effort changes on a model outside only_models, so its prompts do not wait for
      // a classification; the first prompt of a session, with no step seen yet, is sent.
      if (lastModel !== null && !modelAllowed(c, lastModel)) {
        $.ui.log(`[jev-hooks] router: skipped (model ${sanitize(lastModel, '', 80)} is not in only_models)`, { to: 'debug' })
        clearStatus()
        return
      }

      const b = await backendFor($, options, dir)
      if (!b.ok) {
        problem(`[jev-hooks] router: ${sanitize(b.error.message, '', 300)}`)
        return
      }
      key = b.value.key
      // Guardrail's mask map, only for a backend that leaves the machine (maskFileFor).
      const maskFile = await maskFileFor($, home, b.value.local)
      if (inFlight || t0 < busyUntil) {
        $.ui.log('[jev-hooks] router: backend still busy, turn left as is', { to: 'debug' })
        clearStatus()
        return
      }
      const prep = prepareRequest(c, e, b.value, maskFile, t0)
      if ('skip' in prep) {
        if (prep.problem) problem(`[jev-hooks] router: ${prep.skip}`)
        else {
          $.ui.log(`[jev-hooks] router: skipped (${prep.skip})`, { to: 'debug' })
          clearStatus()
        }
        return
      }

      // The race: the answer, or null after timeout_ms. A holder object for the timer,
      // because a plain let assigned inside the executor narrows to never under tsc.
      const timer: { h?: { cancel(): void } } = {}
      const timeout = new Promise<null>((resolve) => {
        timer.h = $.clock.after(c.timeout_ms, () => resolve(null))
      })
      const request = $.http.fetch(prep.url, prep.init).finally(() => {
        inFlight = false
      })
      inFlight = true
      let res: { status: number; text: string } | null
      try {
        res = await Promise.race([request, timeout])
      } catch (err) {
        // the user interrupted: the engine aborted the fetch with the prompt, which was
        // abandoned; there is nothing to say
        if (next.signal.aborted) return
        // After a redirect the engine's message quotes the Location, which the backend
        // chose: only a fixed token of it reaches the line.
        problem(`[jev-hooks] router: request failed${fetchFailure(String(err))}, turn left as is`)
        return
      } finally {
        timer.h?.cancel()
      }
      // the user interrupted: the prompt was abandoned, there is nothing to say
      if (next.signal.aborted) return
      const ms = (await $.clock.now()) - t0
      if (res === null) {
        busyUntil = t0 + c.busy_after_timeout_ms
        problem(`[jev-hooks] router: no answer in ${formatNumber(c.timeout_ms, 0)} ms, turn left as is`)
        return
      }
      const parsed = parseClassification(c, b.value, res.status, res.text)
      if (!parsed.ok) {
        problem(`[jev-hooks] router: ${parsed.error.message}`)
        return
      }
      lastProblem = ''
      put({ text: e.text, c: parsed.value })
      $.ui.log(routerLogLine(parsed.value, ms), { to: 'debug' })
    }

    try {
      await classify()
    } catch (err) {
      // the classification goes, the entry stays: its turn is still bound for the guard
      pending = pending.map((x) => (x.text === e.text ? { text: x.text } : x))
      // after an interrupt the engine rejects the prompt's calls: nothing to say then
      if (!next.signal.aborted) {
        try {
          problem(`[jev-hooks] router: error, turn left as is (${sanitize(String(err), key, 200)})`)
        } catch {
          // not even the line could be written: the prompt goes on all the same
        }
      }
    }
    const r = await next(e)
    // dropped beneath (guardrail's block, another plugin's refusal): no turn will start
    if (r.drop !== undefined) pending = without(e.text)
    return r
  })

  on('turn.step', async function* ($, e, next) {
    let arg = e
    try {
      // a workflow agent the subagent router moved: every step, from index 0
      const to = e.agentId === undefined ? undefined : routed.get(e.agentId)
      if (to !== undefined && to !== e.model) arg = { ...e, model: to }
      if (e.agentId === undefined) lastModel = e.model
      if (cfg && cfg.enabled && !guard.tripped && e.agentId === undefined) {
        if (e.index === 0) {
          const c = turn && turn.turnId === e.turnId ? turn.c : undefined
          const level = typeof e.effort === 'string' ? e.effort : undefined
          if (c) {
            const ctx: RouterContext = { model: e.model, effort: e.effort, previous: applied ? applied.after : undefined }
            const s = chooseEffort(c, ctx, cfg)
            applied = { turnId: e.turnId, before: e.effort, after: s.effort ?? level }
            if (s.effort) arg = { ...e, effort: s.effort }
            // the status before the line: if either fails the catch undoes the change,
            // and no transcript line may be left saying it was made; if only the line
            // fails, the catch takes the status back too
            $.ui.status(shown(ui, statusLine(c, s, ctx)))
            if (s.effort) $.ui.log(decisionLine(ctx, s))
            else $.ui.log(decisionLine(ctx, s), { to: 'debug' })
          } else {
            applied = { turnId: e.turnId, before: e.effort, after: level }
            $.ui.status(shown(ui, undefined))
          }
        } else if (applied && applied.turnId === e.turnId && applied.after !== undefined
          && applied.after !== applied.before && e.effort === applied.before && modelAllowed(cfg, e.model)) {
          // Each step's input is rebuilt from the session: the change of index 0 is
          // made again, unless someone else (a skill) changed the effort meanwhile or
          // the step runs on a model outside only_models (a fallback), whose prompt
          // cache the change would clear.
          arg = { ...e, effort: applied.after }
        }
      }
    } catch {
      const changed = arg !== e
      arg = e
      // index 0 failed: the turn keeps the session's effort at its later steps too, and
      // the next turn's `previous` reads the effort really used
      if (e.index === 0 && e.agentId === undefined) {
        applied = { turnId: e.turnId, before: e.effort, after: typeof e.effort === 'string' ? e.effort : undefined }
        // The status may already claim the change the line could not report: take it
        // back. Only then: a status saying "effort unchanged" is still true. (2.1.283
        // drops a refused ui call instead of throwing, so this path is defensive.)
        if (changed) {
          try {
            $.ui.status(shown(ui, undefined))
          } catch {
            // refused as well: nothing more can be undone
          }
        }
      }
    }
    // outside any try: what fails beneath is the engine's to report
    const r = yield* next(arg)
    try {
      const g = cfg && cfg.enabled && !guard.tripped && e.agentId === undefined ? cfg.cache_guard : null
      if (g) {
        const own = turn && turn.turnId === e.turnId ? turn : null
        const gapMs = e.index === 0 && own && own.startedAt !== undefined && guardRefAt !== null ? own.startedAt - guardRefAt : null
        const step: GuardStep = { effort: arg.effort, usage: r.usage, messageCount: e.messageCount, model: e.model }
        const out = cacheGuard(g, guard, step, gapMs)
        guard = out.state
        // a step of a turn no prompt bound (a continuation), or of one whose start time
        // is unknown, keeps the older reference
        if (own && own.startedAt !== undefined) guardRefAt = own.startedAt
        if (out.verdict === 'tripped') {
          $.ui.log(guardLine(step, out.prefix ?? 0, g.trips))
          $.ui.status(shown(ui, 'jev router: off for this session (effort changes cleared the prompt cache)'))
        } else if (out.verdict === 'suspect') {
          $.ui.log(`[jev-hooks] router: after an effort change the prompt cache served ${formatNumber(out.read ?? 0, 0)} of ${formatNumber(out.prefix ?? 0, 0)} tokens (${formatNumber(out.state.suspects, 0)} of ${formatNumber(g.trips, 0)} before the router turns off)`, { to: 'debug' })
        }
      }
    } catch {
      // the guard never breaks a step
    }
    return r
  })
}
