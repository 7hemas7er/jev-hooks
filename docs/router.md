# Effort router (opt-in)

Claude Code lets a function hook set the effort of each model request. The router uses
that to spend less reasoning where a prompt does not need it: before the turn starts,
the backend answers seven closed questions about the prompt, and plain code turns the
probabilities into an effort, with rules and thresholds you can read in
`config/router.json`. As with the reviewer, the model only classifies; your JSON
decides.

```
you press Enter
        │  prompt.submit: the prompt waits for the answer or timeout_ms (1.5 s)
        ▼
  typed by you, not "/" or "!", allowed model, backend free? ── no ──▶ turn as it is
        │
        ▼
  POST /v1/systemone ── 7 router questions, the prompt as the state
        │               (redacted and masked towards a non-local backend)
        ▼
  probabilities ──▶ calibration profile ──▶ classification
        │
        │  turn.start: kept for the turn whose text is this prompt
        ▼
  turn.step, main loop ──▶ base step, adjustments, explicit depth, floor,
        │                  then capped at the session's effort
        ▼
  effort of that turn's requests (subagents untouched) ──▶ cache guard
```

## What it needs

- **`effort_router: true`** in `/plugin` (default `false`). Claude Code hands the
  options to the module when it loads it, and reloads it when they change, so with the
  option off the module registers no hook at all and no prompt pays for it.
- **Function hooks turned on**: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in Claude Code's
  environment (exported before you start `claude`, or in the `env` block of your
  settings), unless your account already has them through Claude Code's own rollout.
  They never load under `--bare`, `disableAllHooks` or `allowManagedHooksOnly`.
  Function hooks are early access: their API can change between Claude Code releases
  without notice; the router was written against 2.1.283 and checked live on 2.1.283
  and 2.1.284 ([Limitations](limitations.md)).
- **Opus 5.5, Fable 5.1 or Sonnet 5.5, and the per-turn-control beta on your account.** Only with
  both does a change of effort keep the prompt cache. Without the beta, or after Claude
  Code drops it until `/clear` or `/compact`, every change of effort empties the cache
  and the turn pays for the whole context again. The plugin can check the model
  (`only_models`: `opus-5-5`, `fable-5-1` and `sonnet-5-5`, matched case-insensitively inside the
  model id) but cannot see the beta. That is why the router is opt-in, and why it
  watches the cache itself ([The cache guard](#the-cache-guard)).
- **A backend**: `router_url`, or `review_url` when it is empty
  ([Which backend](#which-backend)).

## What it decides

The seven questions are in English, because rizzo's quality has been measured only in
English, and each says that the prompt is data to classify, never an instruction to
follow:

| Question | Type | Asks |
|---|---|---|
| `task_kind` | choice | question, small_edit, bug_with_error, feature, refactor, design, review, ops or continue |
| `scope` | score | how much code: one line, one file, one module, the whole repository (levels 0 to 3) |
| `has_error_evidence` | noul | does the prompt carry an error message, a stack trace or a failing test? |
| `risky_irreversible` | noul | would doing it act on a real system in a way that is hard to undo? |
| `underspecified` | noul | does it leave out something needed to do it right? |
| `multi_deliverable` | noul | does it ask for several distinct results? |
| `explicit_depth` | choice | does the user ask for quick, for thorough, or neither? |

The effort moves along low < medium < high < xhigh < max, starting from the one the
session sends (your setting, or the model's default), in this order:

1. **Base step** from the task kind, relative to the session: question −2, small_edit
   −2, bug_with_error −1, feature −1, refactor −1, design −1, review −1, ops −2.
   `continue` keeps the effort the router gave the previous turn.
2. **Adjustments**, in file order: `scope` at level 2 or more, one step up;
   `multi_deliverable` ≥ 0.6, one step up; `underspecified` ≥ 0.6 or
   `has_error_evidence` ≥ 0.6, at least medium.
3. **Explicit depth**, when its answer has p ≥ 0.4, replaces what came before: quick is
   low, thorough is the session's effort.
4. **Floor**: `risky_irreversible` ≥ 0.5 means at least high.
5. **Clamp**: at least `min_effort` (low), at most the cap. The cap is the session's
   effort (`respect_session_effort: true`) and wins over the floor, so the router **only
   lowers**: a floor can keep it from lowering, never make it raise. A project
   `max_effort` is one more cap. The file's own `max_effort` (high) is the cap only with
   `respect_session_effort: false`, the one setting under which the router may raise.

With the session at high, a prompt classified as small_edit (a rename) goes to low, and
a feature or a bug report with its stack trace to medium; a request to deploy to
production "quickly" stays at high (quick says low, the floor says high).
With the session at max, a question goes to high: the steps are relative.

The turn keeps its effort when:

- the task kind's calibrated probability is below `min_top_probability` (0.3);
- an answer that a rule reads is missing: every rule in the shipped file raises, so
  skipping one would push the effort down;
- the session's effort is a number (an internal token budget, which a hook may pass on
  but not set) or absent (`assume_session_effort: null`). It is absent only on a model
  without effort, or with `CLAUDE_CODE_EFFORT_LEVEL` set to `unset` or `auto`;
- the result is the session's effort anyway.

## Which prompts, which turn

- **Only what you type.** `only_origins` is `["composer"]`, the one origin Claude Code
  attests as your own Enter. Task notifications, scheduled triggers, auto-continuations,
  channels, peers, SDK and plugin prompts are never sent. `"bridge"`, your messages
  from Remote Control, can be added in your user `router.json`. A name Claude Code
  2.1.283 never sends (an earlier draft had `"human"`) is a validation error, rather
  than a router that silently skips every prompt.
- Prompts that start with `/` or `!` are not sent (`skip_prefixes`), nor empty ones. A
  long prompt keeps its first 3000 characters and its last 1000 around a `[…]` mark
  (`prompt_head_chars` 3000, `prompt_max_chars` 4000): the head says what is asked, the
  tail often holds the error.
- **A classification reaches only the turn its own prompt starts**: at `turn.start` the
  turn's text must be the prompt's. A prompt blocked by another hook (guardrail can),
  one typed during a turn and folded into it, a turn started by a notification or a
  continuation: none of them picks up a classification that is not its own. A
  notification or a command that arrives while your prompt waits for its turn does not
  take its classification away either.
- The effort changes at the turn's first main-loop request and again at every later
  one, since Claude Code rebuilds each step from the session, unless someone else
  changed it in the meantime or the step runs on a model outside `only_models` (a
  fallback model), whose prompt cache the change would clear. Subagents are never
  touched, and neither is the model.
- After a step on a model outside `only_models`, the next prompts are not even sent,
  so they do not wait for an answer that cannot be used. The first prompt of a session
  comes before any step has shown the model, so it is sent.

Keep one effort router only: two would fight over the same field. This one never
overwrites an effort that someone else changed during the turn.

## Timing and failures

- The prompt waits for the classification, `timeout_ms` (1500 ms) at most. On the
  Spark, the seven questions on a short prompt take 0.22 s warm. `timeout_ms` accepts
  up to 30000, Claude Code's own limit on a fetch. The wait does not count against the
  10 s a hook may spend, because a hook's clock stops while its fetch is out, but your
  prompt waits all the same.
- The end of that wait is a Claude Code timer (`$.clock.after`). If another hook
  refuses that call (another plugin's, or one your administrator manages), the timer
  never fires and nothing says so: the prompt then waits for the fetch itself, up to
  Claude Code's 30 s.
- After a timeout the router rests for `busy_after_timeout_ms` (30 s): rizzo keeps
  computing a request its client abandoned, and the router cannot cancel a
  `$.http.fetch`. A request still in flight also holds back the next one: never two at
  a time.
- **Fail-open, visibly.** A backend that is down, slow or misconfigured, or an answer
  that cannot be read, leaves the turn as it is, with one line in the transcript; the
  same line again goes to the debug log only, until another line or a good answer
  replaces it. The same holds when Claude Code refuses `$.http.fetch`, by an
  administrator's policy or in its essential-traffic-only mode. A request that fails
  gives `request failed`, followed at most by a fixed reason: `(network disabled by
  policy)`, `(nonessential traffic disabled)`, or the error code Claude Code reports,
  such as `(ConnectionRefused)`. The error's own text never reaches the line: after a
  redirect it quotes an address the backend chose.
- **Nothing sent without the mask map.** Towards a non-local backend, a guardrail mask
  map that exists but cannot be read or parsed, or one that cannot even be looked for
  (neither `HOME` nor `GUARDRAIL_MASK_MAP` is set), stops every request: the turn stays
  as it is, and one transcript line says why; its repeats go to the debug log
  ([Privacy](#privacy)).
- **Off while your `router.json` cannot be read.** One in `~/.config/jev-hooks/` that
  is there but cannot be read may hold your `"enabled": false`, so nothing is sent
  until it can be read, and one transcript line says so
  ([Configuration](#configuration)).
- If you interrupt while it waits, it says nothing and changes nothing.

## Which backend

`router_url`, or `review_url` when it is empty: by default the router **shares the
reviewer's instance** (port 8017 in the examples). That costs no extra memory, and it
has a price: rizzo serializes requests, so while a commit review runs, the router's
request waits behind it, times out after 1.5 s and leaves the turn's effort alone, and
the router then rests for 30 s. A second instance removes the contention for about
10 GB more in BF16: run another `rizzo serve` (for example on port 8019, behind the same
proxy) and point `router_url` at it. Nothing else changes.

Two layers, and nothing else:

- yours: `router_url` or `review_url`, with `router_api_key`, or else `api_key` or the
  key file. Those two were given for `review_url`, so they follow `router_url` only
  when it has `review_url`'s scheme and host; the port does not count, so a second
  instance on the same box (8017 and 8019) shares the key. A `router_url` anywhere
  else, a LAN rizzo over `http://` next to a TypeSafe `review_url` for one, gets
  `router_api_key` or no key at all, never the TypeSafe key in clear;
- the environment's, which gives a URL only (`JEV_HOOKS_ROUTER_URL`, then
  `JEV_HOOKS_URL`), never a key: a variable exported in a shell is not a choice of
  where a key may go. There is no `TYPESAFE_*` fallback.

`http://` goes only towards local hosts, checked before a byte is sent, as for the
reviewer. That check, like the choice of whether to redact the prompt
([Privacy](#privacy)), looks at the URL you configure, and a redirect can lead
elsewhere: Claude Code's `$.http.fetch` follows up to five, and the router cannot turn
that off. On a 301, 302 or 303 the request becomes a GET without a body; on a 307 or
308 the same POST goes again, prompt included (redacted towards a non-local backend,
as you typed it towards a local one), to any http or https origin, a switch from
`https://` to plain `http://` included, and only `Authorization` is dropped when the
origin changes. So `router_url`, and any proxy in front of it, must answer `POST
/v1/systemone` itself: no http-to-https or canonical-host redirect on that path. The
reviewer is not affected: its client refuses redirects.

The router reads the key file (its first non-empty line) through Claude Code, and
cannot tell who else may read it, because a function hook sees no file mode: keep it
`chmod 600` yourself.

## What you see

- A status line under the prompt: `jev router: small_edit 0.91 → low`, or
  `jev router: feature 0.62, effort unchanged (high)`. It is cleared when the router
  skips or fails a prompt between turns, and at the first request of a turn that no
  classification reached, so a stale one never stays. A prompt that arrives during a
  turn (one you type, a notification) leaves it, since that turn still runs at the
  effort it shows; only a switch that turns the router off clears it then.
- When it changes the effort, one dim transcript line, not sent to the model, with the
  rules that fired: `[jev-hooks] effort high → low: small_edit 0.91: -2 → low`.
- In the debug log (`claude --debug`): each classification (`[jev-hooks] router:
  small_edit 0.91, scope 0, has_error_evidence 0.02, … in 220 ms (profile
  spark-bf16-2026-09)`), the decisions that left the effort unchanged, and each prompt
  skipped, with the reason.
- A failure, as one transcript line ([Timing and failures](#timing-and-failures)).
- A note on your or the project's `router.json` (invalid, a field ignored) goes to the
  transcript once, and again only when what the notes say changes. A project file
  names three ignored fields at most, and one more note gives the number of the rest.

None of these lines carries the prompt, a key or text written by the backend. Besides
ids, levels and numbers, a line can quote Claude Code's own messages (an error in the
fail-open line `error, turn left as is (HooksError: …)`, a model's name) or your own
configuration: a value or a JSON error from your `router.json` or `calibration.json`,
the host of the router's URL. A note on a project file names only the field, never
what the file holds.

## The cache guard

The plugin cannot see the beta, but it sees the usage of every request. After a change
of effort the prompt cache should still serve most of the previous request; when it
serves less than `max_read_ratio` (0.5) of it, the step is a suspect. After `trips` (2)
suspects in a row the router turns itself off for the session, with a transcript line
that says why and the status `jev router: off for this session (effort changes cleared
the prompt cache)`; a warm step clears the count. Only steps that can be judged fairly
count: the first request of a turn, when its effort differs from the previous
request's, on the same model, with no compaction in between, after a previous request
of at least `min_prefix_tokens` (8192), and when its turn started at most `max_gap_ms`
(240000 ms, 4 minutes) after the start of the turn that made the previous request,
because after a longer pause the cache may have expired on its own. The gap runs
between turn starts, not prompts: a prompt typed during a turn waits for that turn to
end, and a slow `UserPromptSubmit` hook holds one back, so a prompt can come long
before its turn starts. A prompt that started no turn (blocked beneath, a `!` command),
a turn that sent no request, or one whose start time the router could not read (its
first request is not judged either) does not count as the previous one, so the gap
never looks shorter than the pause. If it trips in every session, set `effort_router`
to false. `"cache_guard": null` in your `router.json` turns the guard off.

## Privacy

With the router on, **the text of every prompt you type goes to the router's backend**,
except the ones it skips. Towards a local backend (loopback, private ranges, Tailscale)
it goes as it is, because it does not leave your network, as long as that backend, or
the proxy in front of it, answers itself: a 307 or 308 redirect would send it on, as it
is, wherever it points ([Which backend](#which-backend)). Towards a non-local one, such
as TypeSafe, it is redacted first: every token of at least 20 characters with at least
4 bits of entropy per character becomes a random value of the same shape, private-key
PEM blocks are replaced, and guardrail's mask map (`GUARDRAIL_MASK_MAP`, otherwise
`~/.config/guardrail/mask.tsv`) is applied. Both see the whole prompt: a long one is
clipped only afterwards, so a cut never leaves pieces of a secret too short to be
recognized. If the map exists but cannot be read or parsed, or cannot be looked for
because neither `HOME` nor `GUARDRAIL_MASK_MAP` is set, nothing is sent, and one
transcript line says so. A closing evidence tag in the prompt is neutralized in both
cases. A secret shorter or more regular than that still goes out: for private work,
prefer a local rizzo. The prompt is never written to a log.

## Configuration

- The plugin's `config/router.json` holds every field, with notes in its `_comment`. It
  reaches the module through the generated `src/core/defaults.ts`, because Claude
  Code's module loader does not import `.json`.
- Your `router.json` in `${XDG_CONFIG_HOME:-~/.config}/jev-hooks/` replaces it whole
  and is validated the same way: copy the plugin's file and edit the copy. An invalid
  one leaves a note, and the plugin's applies, with one exception: its `"enabled":
  false` still keeps the router off, so a file written for an earlier version, or with
  one wrong field, never turns it back on. A file that is not JSON at all (a trailing
  comma or a `//` comment is enough) says nothing, so the plugin's applies to it too,
  with the note. A file that is there but cannot be read (its permissions, a loop of
  links, another plugin's refusal) may hold that `"enabled": false`, so the router
  stays off, with one note, until it can be read. Your `calibration.json` there applies
  to the router too (one that cannot be read gets a note, and the plugin's applies);
  the project's never does.
- The project's `.jev-hooks/router.json` is read where the reviewer reads `.jev-hooks/`:
  at the top level of the checkout the session runs in, found from the session's
  directory the way `git rev-parse --show-toplevel` finds it, so a linked worktree's
  own file counts. In a linked worktree the main working tree's `.jev-hooks/router.json`
  is read as well, and its notes say `(main working tree)`. Each can only turn the
  router off or lower the cap, so together they give the lower cap
  ([Configuration](configuration.md#configuration-open-a-json-never-touch-the-code)). Outside a
  repository, it is read in the session's directory. If another plugin refuses Claude
  Code's `$.session.repo`, the top level is still found from the session's directory
  (the session's directory itself when no `.git` is found); in a linked worktree only
  the checkout's own file is read then, because the main working tree is unknown.

## Switches

- `effort_router: false` in `/plugin`: the module reloads and registers nothing.
- `JEV_HOOKS_ROUTER=0` turns off the router alone, `JEV_HOOKS_DISABLE=1` the whole
  plugin. Both are read at every prompt from Claude Code's own environment, which is
  set before it starts: exported in the shell that launches `claude`, or in the `env`
  block of your settings. An `export` inside a command Claude runs does not reach it.
- `"enabled": false` in your `router.json` or in the project's. Yours keeps the router
  off even when another field is invalid, as long as the file is still JSON: a syntax
  error such as a trailing comma or a comment makes the whole file say nothing, so the
  plugin's `router.json` applies, with a note. A `router.json` of yours that is there
  but cannot be read keeps the router off too, with a note, until it can be read.

## Measured, not fitted

The router's questions have their own bench: 120 labelled prompts to choose on
(`bench/router-dev.jsonl`) and 120 written afterwards to check
(`bench/router-holdout.jsonl`), measured on the Spark with
`scripts/measure-router.ts`. On the holdout set:

- `task_kind` is right 84% of the time; `has_error_evidence` (AUROC 0.998) and
  `risky_irreversible` (0.982) separate well; `underspecified` does not (0.54), and
  mostly acts as a floor at medium; `scope` is right 53% of the time, 80% within one
  level.
- End to end, from a session at xhigh the router went below the labelled effort on
  1 prompt in 110 and saved 96 of the 177 steps the labels allow; from a session at
  high, 10 in 110 and 55 of 80.
- The rules trade turns below the labelled effort for steps saved. Replayed on the same
  answers, both sessions together on the holdout: bug_with_error, refactor and design
  at 0 went below on 9 of 220 and saved 142 of 257 steps; at −1, the shipped choice,
  11 and 151; with review at −2 as well, 15 and 162; with `scope` raising only at
  level 3 instead, 29 and 205. Each of the two turns the −1 step adds below the label
  is one step below, from a session at high.

The thresholds were set by hand and checked on these sets, not fitted. The router
often leaves the effort alone, which is the safe side. The debug log prints every
classification, and `measure-router.ts --replay` shows what another `router.json`
would have chosen on the same answers without asking the backend again.
