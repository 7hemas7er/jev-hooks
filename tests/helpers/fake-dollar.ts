// A fake Claude Code for driving hooks/register.ts under Node: the `on` register()
// registers its hooks with, the `$` each hook calls and the `next` beneath it. The
// real engine exists only inside `claude plugin test` (tests-cc/, not run in CI); here
// every noun the router uses is in memory, so a test can play a whole session (a
// prompt, its turn.start, the steps of its turn) and look at every effect.
//
// - env and fs are plain maps. An env name nobody set reads as undefined, and every
//   name read is recorded: a test can assert that JEV_HOOKS_KEY is never read. A read
//   rejects in the engine's words, `jev-hooks: $.fs.read(<path>) failed: <errno>`:
//   ENOENT for a path nobody planted, EACCES for one in `unreadable` (it exists, as a
//   file without permission does), the errno given for one in `failing` (ELOOP,
//   EISDIR…). A path in `denied` is one another hook's fs.read refuses: the read
//   rejects as the engine words a deny, `jev-hooks: $.fs.read: <reason>` (seen in the
//   2.1.283 kit). $.fs.exists is a stat, as the engine's: a path in `failing` does not
//   exist, since its stat fails too.
// - $.session.repo answers repoRoot, $.session.cwd the session's directory (cwd,
//   repoRoot by default). A `.git` planted in files is what a walk up to the checkout's
//   top level finds: a file in a linked worktree, a directory in the main one, which
//   is all the same to exists.
// - $.http.fetch answers from a queue the test fills: a response, a rejection, or a
//   request held until the test settles it. With the queue empty it rejects, like the
//   kit's "no implementation for http.fetch".
// - The clock moves only when the test advances it; $.clock.after timers fire then,
//   in order, unless cancelled.
// - The user's interrupt (the signal a test passes to submit) does what the engine
//   does to the prompt's dispatch: its fetch rejects with an AbortError, one held
//   before or asked after alike, and its clock.after timers never fire.
// - A call in `broken` is refused as the engine refuses it: an async call rejects,
//   and clock.after returns a timer that never fires and never throws.
//   'turn.step:ui.status' refuses the call in that hook only. The test may change the
//   set while the session runs. A refused ui.log or ui.status (synchronous in the host)
//   throws here, which is stricter than 2.1.283: that engine drops the call and logs a
//   warning, the hook never sees it. The tests that break a ui call cover a defensive
//   path, which a later engine that throws would take.
// - Every $ call is recorded with the hook that made it: turn.step runs on every model
//   request of the session, and a test checks that it calls nothing but ui.log and
//   ui.status there.
// - The inputs are frozen, as the engine's are: a hook that mutated one would fail
//   here and not only in Claude Code.

export type Sink = 'transcript' | 'debug'

export interface Call { hook: string; call: string; arg?: string }
export interface HttpAnswer { status: number; text: string }
export interface HttpResponse { status: number; ok: boolean; headers: Record<string, string>; text: string }
export interface Fetch { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }
export interface Held { resolve: (a: HttpAnswer) => void; reject: (err: Error) => void }
// dropped: its dispatch was aborted before it fired, so it never will
export interface Timer { at: number; fn: () => void; cancelled: boolean; fired: boolean; dropped: boolean }

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface Usage {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string
}
export interface StepInput { turnId: string; index: number; model?: string; effort?: Effort | number; messageCount?: number; agentId?: string }
export interface StepSeen { turnId: string; index: number; model: string; effort?: Effort | number; messageCount: number; agentId?: string }
export interface StepResult {
  turnId: string; index: number; answer: string; toolUses: unknown[]; stopReason: string | null; usage: Usage | null
}

export interface PromptInput { text: string; origin?: { kind: string }; turnId?: string; wait?: boolean }
export type PromptResult = { text: string; drop?: undefined } | { drop: string; text?: undefined }

export interface SubmitOptions {
  start?: string           // the turnId of the turn the prompt starts (turn.start runs inside next)
  drop?: string            // beneath refuses the prompt: next resolves { drop }
  signal?: AbortSignal     // next.signal: the test aborts it to play the user's interrupt
}

export interface WorldOptions {
  options?: Record<string, unknown>
  env?: Record<string, string>
  files?: Record<string, string>
  unreadable?: string[]                // exists, its read rejects with EACCES
  failing?: Record<string, string>     // path → the errno its read rejects with; its stat fails too
  denied?: string[]                    // its read is refused by another hook's deny
  repoRoot?: string | null
  cwd?: string
  now?: number
  broken?: string[]        // calls ('env.get', 'ui.log', 'turn.step:ui.status', …) the engine refuses
}

type Hook = (...a: unknown[]) => unknown
type Register = (on: (event: string, hook: Hook) => void, options: Record<string, unknown>) => unknown

type Queued = { kind: 'answer'; a: HttpAnswer } | { kind: 'fail'; err: Error } | { kind: 'hold'; p: Promise<HttpResponse> }

export const DEFAULT_MODEL = 'claude-opus-5-5'

const response = (a: HttpAnswer): HttpResponse => ({ status: a.status, ok: a.status >= 200 && a.status < 300, headers: {}, text: a.text })

// The engine's own rejections carry its error class's name.
export function hooksError(message: string): Error {
  const err = new Error(message)
  err.name = 'HooksError'
  return err
}

// Lets every promise chain started so far run to its next real wait: the fakes answer
// with already settled promises, so one turn of the event loop is enough.
export const settle = (): Promise<void> => new Promise((ok) => setImmediate(ok))

export function fakeClaude(register: Register, o: WorldOptions = {}) {
  const hooks: Record<string, Hook> = Object.create(null)
  const env: Record<string, string> = { ...o.env }
  const files = new Map<string, string>(Object.entries(o.files ?? {}))
  const unreadable = new Set<string>(o.unreadable ?? [])
  const failing = new Map<string, string>(Object.entries(o.failing ?? {}))
  const denied = new Set<string>(o.denied ?? [])
  const calls: Call[] = []
  const envReads: string[] = []
  const fetches: Fetch[] = []
  const logs: { text: string; to: Sink }[] = []
  const status: (string | undefined)[] = []
  const beneath: StepSeen[] = []
  const entered: string[] = []
  const timers: Timer[] = []
  const queue: Queued[] = []
  // what the test may change while the session runs
  const repoRoot = o.repoRoot === undefined ? null : o.repoRoot
  const w: { repoRoot: string | null; cwd: string; clock: number } = {
    repoRoot,
    cwd: o.cwd ?? repoRoot ?? '/work',
    clock: o.now ?? 1_000_000,
  }

  const broken = new Set(o.broken ?? [])

  // The $ of one hook invocation: the calls it makes are recorded under that hook, and
  // signal is its dispatch's (the prompt's, for prompt.submit).
  const dollar = (hook: string, signal?: AbortSignal) => {
    const refused = (call: string): boolean => broken.has(call) || broken.has(`${hook}:${call}`)
    const record = (call: string, arg?: string): void => {
      calls.push(arg === undefined ? { hook, call } : { hook, call, arg })
    }
    // A refused call throws after being recorded: inside an async method that is a
    // rejection, as the engine's refusal of an operation is.
    const rec = (call: string, arg?: string): void => {
      record(call, arg)
      if (refused(call)) throw hooksError(`no implementation for ${call}`)
    }
    return {
      env: {
        get: async (name: string): Promise<string | undefined> => {
          rec('env.get', name)
          envReads.push(name)
          return Object.hasOwn(env, name) ? env[name] : undefined
        },
      },
      fs: {
        read: async (path: string): Promise<string> => {
          rec('fs.read', path)
          if (denied.has(path)) throw hooksError(`jev-hooks: $.fs.read: refused by a hook: ${path}`)
          const errno = failing.get(path) ?? (unreadable.has(path) ? 'EACCES' : undefined)
          const text = files.get(path)
          if (errno !== undefined || text === undefined) throw hooksError(`jev-hooks: $.fs.read(${path}) failed: ${errno ?? 'ENOENT'}`)
          return text
        },
        exists: async (path: string): Promise<boolean> => {
          rec('fs.exists', path)
          return !failing.has(path) && (files.has(path) || unreadable.has(path))
        },
      },
      session: {
        repo: async (): Promise<{ root: string; remote: string | null } | null> => {
          rec('session.repo')
          return w.repoRoot === null ? null : { root: w.repoRoot, remote: null }
        },
        cwd: async (): Promise<string> => {
          rec('session.cwd')
          return w.cwd
        },
      },
      clock: {
        now: async (): Promise<number> => {
          rec('clock.now')
          return w.clock
        },
        // a refusal is silent: the engine hands back a timer that never fires
        after: (ms: number, fn: () => void): { cancel: () => void } => {
          record('clock.after', String(ms))
          if (refused('clock.after')) return { cancel: () => {} }
          const t: Timer = { at: w.clock + ms, fn, cancelled: false, fired: false, dropped: false }
          timers.push(t)
          signal?.addEventListener('abort', () => {
            if (!t.fired) t.dropped = true
          }, { once: true })
          return { cancel: () => { t.cancelled = true } }
        },
      },
      http: {
        fetch: (url: string, init?: Fetch['init']): Promise<HttpResponse> => {
          try {
            rec('http.fetch', url)
          } catch (err) {
            return Promise.reject(err)
          }
          fetches.push({ url, init: init ?? {} })
          const aborted = (): Error => hooksError(`jev-hooks: $.http.fetch(${url}) failed: AbortError: This operation was aborted`)
          if (signal?.aborted) return Promise.reject(aborted())
          const q = queue.shift()
          let p: Promise<HttpResponse>
          if (!q) p = Promise.reject(hooksError('no implementation for http.fetch'))
          else if (q.kind === 'answer') p = Promise.resolve(response(q.a))
          else if (q.kind === 'fail') p = Promise.reject(q.err)
          else p = q.p
          if (!signal) return p
          return new Promise<HttpResponse>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(aborted()), { once: true })
            p.then(resolve, reject)
          })
        },
      },
      ui: {
        log: (text: string, options?: { to?: Sink }): void => {
          rec('ui.log')
          logs.push({ text, to: options?.to === 'debug' ? 'debug' : 'transcript' })
        },
        status: (text: string | undefined): void => {
          rec('ui.status')
          status.push(text)
        },
      },
    }
  }

  const registered: string[] = []
  register((event, hook) => {
    registered.push(event)
    hooks[event] = hook
  }, Object.freeze({ ...o.options }))

  const signalOf = (s?: AbortSignal): AbortSignal => s ?? new AbortController().signal

  async function start(text: string, turnId: string): Promise<void> {
    const e = Object.freeze({ text, turnId })
    const next = Object.assign(async (x: { turnId: string }) => ({ turnId: x.turnId }), { signal: signalOf() })
    if (hooks['turn.start']) await hooks['turn.start'](dollar('turn.start'), e, next)
  }

  return {
    hooks, env, files, unreadable, denied, broken, calls, envReads, fetches, logs, status, beneath, entered, timers, registered,
    get now(): number { return w.clock },
    setRepo(root: string | null): void { w.repoRoot = root },
    setCwd(cwd: string): void { w.cwd = cwd },

    // The next $.http.fetch resolves with a, rejects with err, or waits for the test.
    answer(a: HttpAnswer): void { queue.push({ kind: 'answer', a }) },
    fail(err: Error): void { queue.push({ kind: 'fail', err }) },
    hold(): Held {
      let held: Held = { resolve: () => {}, reject: () => {} }
      const p = new Promise<HttpResponse>((resolve, reject) => {
        held = { resolve: (a) => resolve(response(a)), reject }
      })
      queue.push({ kind: 'hold', p })
      return held
    },

    // Moves the clock by ms, firing the timers that fall due on the way, each at its time.
    async advance(ms: number): Promise<void> {
      await settle()
      const target = w.clock + ms
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && !t.fired && !t.dropped && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        w.clock = due.at
        due.fired = true
        due.fn()
        await settle()
      }
      w.clock = target
      await settle()
    },

    // prompt.submit, with a next that plays the engine: it refuses the prompt (drop) or
    // lets it in, starting its turn first when the test names one, as the engine's
    // next resolves only after the turn started.
    async submit(e: PromptInput, s: SubmitOptions = {}): Promise<PromptResult> {
      const input = Object.freeze({ wait: false, origin: { kind: 'composer' }, ...e })
      const signal = signalOf(s.signal)
      const next = Object.assign(async (x: PromptInput): Promise<PromptResult> => {
        if (s.drop !== undefined) return { drop: s.drop }
        entered.push(x.text)
        if (s.start !== undefined) await start(x.text, s.start)
        return { text: x.text }
      }, { signal })
      const hook = hooks['prompt.submit']
      return (hook ? hook(dollar('prompt.submit', signal), input, next) : next(input)) as Promise<PromptResult>
    },

    start,

    // turn.step, drained as the engine drains it; beneath records the request it was
    // asked to send and answers with the given usage.
    async step(e: StepInput, usage: Usage | null = null): Promise<StepResult> {
      const input = Object.freeze({ model: DEFAULT_MODEL, messageCount: 1, ...e }) as StepSeen
      const below = Object.assign((x: StepSeen) => (async function* () {
        beneath.push({ ...x })
        yield { kind: 'text', index: 0, text: 'done' }
        return { turnId: x.turnId, index: x.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage }
      })(), { signal: signalOf() })
      const hook = hooks['turn.step']
      const stream = (hook ? hook(dollar('turn.step'), input, below) : below(input)) as AsyncGenerator<unknown, StepResult>
      let r = await stream.next()
      while (!r.done) r = await stream.next()
      return r.value
    },

    // The effort the engine received for the last step it was asked to send.
    lastEffort(): Effort | number | undefined {
      return beneath.length === 0 ? undefined : beneath[beneath.length - 1].effort
    },
    transcript(): string[] { return logs.filter((l) => l.to === 'transcript').map((l) => l.text) },
    debug(): string[] { return logs.filter((l) => l.to === 'debug').map((l) => l.text) },
  }
}

export type FakeClaude = ReturnType<typeof fakeClaude>
