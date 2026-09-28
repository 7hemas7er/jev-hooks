// The effort router: a function hook (Claude Code 2.1.283, early access) that asks the
// /v1/systemone backend what kind of request a prompt is and lowers that turn's effort
// when the answer allows it. Off unless the effort_router option is true.
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
import type { Effort, RouterConfig } from '../src/core/types.ts'

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

export const register: Register = (on, options) => {
  // The enable gate. Options are fixed for an activation (a change reloads the
  // module), so with the router off nothing is registered and no prompt pays for a $
  // call; effectiveRouterConfig checks the option a second time.
  if (options.effort_router !== true) return

  let cfg: RouterConfig | null = null
  // the files of the last prompt and what they gave: unchanged files are not validated
  // again. Whether a user file could be read is part of the key: one that goes from
  // missing to unreadable keeps the same null text.
  let memo: {
    user: string | null; userUnreadable: boolean; projects: ProjectFile[]
    userCalibration: string | null; userCalibrationUnreadable: boolean; result: Effective
  } | null = null
  // the checkout's top level found from a session directory (null: none found). Only a
  // walk that ran to its end is kept: one a refused call cut short is tried again.
  let walked: { cwd: string; top: string | null } | null = null
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

  on('prompt.submit', async ($, e, next) => {
    let key = ''
    // A prompt typed or delivered during a turn (turnId set) leaves that turn's status
    // line alone: the turn still runs at the effort the line shows.
    const clearStatus = (): void => {
      if (e.turnId === undefined) $.ui.status(undefined)
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
        $.ui.status(undefined)
        return
      }
      const home = await $.env.get('HOME')
      const dir = userConfigDir(await $.env.get('XDG_CONFIG_HOME'), home)
      // The configuration files, the user's and the project's, read as the mask map is:
      // only a missing file (RE_NO_FILE) is none. One that is there but cannot be read
      // (EACCES, ELOOP, EISDIR, the size cap, another hook's refusal) is unreadable: a
      // router.json may hold the switch that keeps the router off, so
      // effectiveRouterConfig keeps it off.
      const readClassified = (path: string): Promise<ConfigFile> =>
        $.fs.read(path).then((text) => ({ text }), (err: unknown) =>
          (RE_NO_FILE.test(String(err)) ? { text: null } : { text: null, error: 'unreadable' }))
      const userFile: ConfigFile = dir === null ? { text: null } : await readClassified(`${dir}/jev-hooks/router.json`)
      const calibrationFile: ConfigFile = dir === null ? { text: null } : await readClassified(`${dir}/jev-hooks/calibration.json`)
      const user = userFile.text
      const userUnreadable = userFile.error !== undefined
      const userCalibration = calibrationFile.text
      const userCalibrationUnreadable = calibrationFile.error !== undefined

      // The project files. The reviewer reads .jev-hooks/ at `git rev-parse
      // --show-toplevel`, the checkout's own top level, a linked worktree's included;
      // $.session.repo() answers the main working tree's root even in a worktree. So the
      // top level is looked for as git does, the first directory up from the session's
      // that holds .git (a file in a linked worktree), and when it is not the main
      // working tree's root both files are read: each can only restrict. Outside a
      // repository, the session's directory. When another hook refuses $.session.repo
      // the walk still finds the top level (the session's directory if it finds none);
      // in a linked worktree only the checkout's own file is read then, since the main
      // working tree's root is unknown.
      // undefined: the call was refused, which says nothing of where the session is
      const repo = await $.session.repo().catch(() => undefined)
      const files: { label: string; path: string }[] = []
      if (repo === null) files.push({ label: ROUTER_FILES.project, path: './.jev-hooks/router.json' })
      else {
        const root = repo ? trimSlashes(repo.root) : null
        const cwd = await $.session.cwd().catch(() => null)
        let top: string | null = null
        if (typeof cwd === 'string') {
          if (walked && walked.cwd === cwd) top = walked.top
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
            if (done) walked = { cwd, top }
          }
        }
        const checkout = top ?? root
        files.push({ label: ROUTER_FILES.project, path: checkout === null ? './.jev-hooks/router.json' : `${checkout}/.jev-hooks/router.json` })
        if (root !== null && checkout !== root) files.push({ label: ROUTER_FILES.projectMainTree, path: `${root}/.jev-hooks/router.json` })
      }
      const projects: ProjectFile[] = []
      for (const f of files) {
        const r = await readClassified(f.path)
        projects.push(r.error === undefined ? { label: f.label, text: r.text } : { label: f.label, text: null, unreadable: true })
      }

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
        $.ui.status(undefined)
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

      const keyFile = dir === null ? null : await $.fs.read(`${dir}/jev-hooks/key`).catch(() => null)
      const b = routerBackend(options, { routerUrl: await $.env.get('JEV_HOOKS_ROUTER_URL'), url: await $.env.get('JEV_HOOKS_URL'), keyFile })
      if (!b.ok) {
        problem(`[jev-hooks] router: ${sanitize(b.error.message, '', 300)}`)
        return
      }
      key = b.value.key
      // Guardrail's mask map, looked up as the reviewer does; only a backend that
      // leaves the machine needs it. Read without $.fs.exists, which answers false for
      // any failed stat (EACCES, ELOOP) and would pass an existing map for a missing
      // one. A map that cannot be read, or cannot be looked for (no HOME and no
      // GUARDRAIL_MASK_MAP), stops the request: prepareRequest says so.
      let maskFile: { text: string | null; error?: string } = { text: null }
      if (!b.value.local) {
        const path = (await $.env.get('GUARDRAIL_MASK_MAP')) || (home ? `${home}/.config/guardrail/mask.tsv` : '')
        if (path === '') maskFile = { text: null, error: 'no home' }
        else {
          maskFile = await $.fs.read(path).then((text) => ({ text }), (err: unknown) =>
            (RE_NO_FILE.test(String(err)) ? { text: null } : { text: null, error: 'unreadable' }))
        }
      }
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

  // Binding by text: the classification applies only to the turn its own prompt
  // started. A prompt dropped beneath, one folded into a running turn, a turn started
  // by a notification or a continuation (text "") never pick it up.
  // The start time is read after the binding: a refused clock then costs only the
  // guard's judgement of this turn, never its classification, and the binding is in
  // place even if the engine sends the first step before this hook settles. turn.start
  // is not on the path of every request, so it may await.
  on('turn.start', async ($, e, next) => {
    const p = e.text === '' ? undefined : pending.find((x) => x.text === e.text)
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
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let arg = e
    try {
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
            $.ui.status(statusLine(c, s, ctx))
            if (s.effort) $.ui.log(decisionLine(ctx, s))
            else $.ui.log(decisionLine(ctx, s), { to: 'debug' })
          } else {
            applied = { turnId: e.turnId, before: e.effort, after: level }
            $.ui.status(undefined)
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
            $.ui.status(undefined)
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
          $.ui.status('jev router: off for this session (effort changes cleared the prompt cache)')
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
