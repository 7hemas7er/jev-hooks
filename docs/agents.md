# Subagent router (opt-in)

Claude Code lets a function hook choose the model a subagent starts on. The subagent
router uses that to run on a cheaper model the subagents whose work does not need the
parent's: before a subagent starts, the backend answers one closed question about its
task prompt, and plain code decides from `config/agents.json`. By default a subagent
that checks a stated claim or labels items against a written definition runs on
Claude Haiku 5.5; every other subagent runs as its caller decided.

```
a subagent is about to start (Agent tool, a workflow's agent(), a plugin)
        │  agent.spawn: the spawn waits for the answer or timeout_ms (1.5 s)
        ▼
  not a fork or a teammate, no model named by the caller,
  parent model in from_models, backend free? ── no ──▶ starts as it is
        │
        ▼
  POST /v1/systemone ── agent_task, the task prompt as the state
        │               (redacted and masked towards a non-local backend)
        ▼
  probabilities ──▶ calibration profile ──▶ the most probable option, its p
        │
        ▼
  option in route and p ≥ min_top_probability? ── no ──▶ starts as it is
        │
        ▼
  Agent tool spawn: started on the route's model
  workflow agent:   every one of its model requests, from the first, on that model
```

## What it needs

- **`agent_router: true`** in `/plugin` (default `false`). It is independent of
  `effort_router`: either can be on alone.
- **Function hooks turned on** (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, as for the
  effort router) and **Claude Code 2.1.294 or later**: the first release whose
  `agent.spawn` hook can set a subagent's model and that knows `claude-haiku-5-5`.
  Function hooks are early access: the API can change between releases
  ([Limitations](limitations.md)).
- **A backend**: the effort router's (`router_url`, or `review_url` when it is empty;
  [Which backend](router.md#which-backend)), with the same key rules.

## What it decides

One question, in English, saying that the task prompt is data to classify:

| Option of `agent_task` | The subagent must hand back |
|---|---|
| `locate` | where something is: files, symbols, call sites, occurrences |
| `extract` | named facts pulled out of given material into a given shape |
| `summarize` | what some material says or does, condensed |
| `check_claim` | whether one stated claim holds, with the evidence |
| `label` | one label per item, by a written definition or rubric |
| `review` | problems not named in advance |
| `implement` | files written or changed |
| `debug` | the cause of an observed failure |
| `design` | a plan, an architecture, a comparison or a decision |
| `research` | facts from outside the repository |

`route` maps options to models; the shipped one is
`{"check_claim": "claude-haiku-5-5", "label": "claude-haiku-5-5"}`. An option outside
`route`, or a most probable option under `min_top_probability` (0.4), leaves the
subagent alone. The router never names a model above the parent's: `route` is meant
for cheaper models, and a parent already on the route's model is left as it is.

Never looked at:

- **forks**, which inherit the parent's context and model: another model would lose
  the prompt cache they share;
- **teammates**, which keep the model their team gave them;
- a spawn whose caller **named a model** (`respect_explicit_model`, true by default):
  a script or a session that chose one had a reason;
- a parent outside `from_models` (`opus-5-5`, `fable-5-1`, `sonnet-5-5`), and any type
  in `skip_types`.

## Workflow agents

A workflow script's `agent()` raises `agent.spawn` too, but its content cannot be
rewritten there. The router asks the backend all the same, and when the agent is to
move it keeps the `agentId` the spawn answers; `turn.step` then sends every request of
that agent, from the first, to the route's model. The `agentId` arrives before the
first request (checked live on 2.1.294, one agent and eight in parallel), so no request
of a moved agent runs on the parent's model. One side effect: the agent's system prompt
was built for the parent's model, so it may say it is Opus while Haiku answers; the
API response's model is what counts. `workflow_agents: false` leaves workflow agents
alone.

A workflow starts many agents at once: `max_in_flight` (4) caps the questions in
flight, and a spawn beyond it starts as it is rather than wait.

## What you see

- Each decision goes to the debug log (`claude --debug`):
  `[jev-hooks] agents: check_claim 0.62 → claude-haiku-5-5 (workflow agent, 0.41 s)` or
  `… left as is (implement 0.91)`. Subagents come by the dozen, so none of this goes
  to the transcript.
- A problem (backend unreachable, no answer in time, a mask map that cannot be read)
  goes to the transcript once, `[jev-hooks] agents: no answer in 1500 ms, subagent left
  as is`, and to the debug log only while it repeats.
- With `status_line` on, the line ends with the session's count:
  `jev agents: 9 of 23 on haiku-5-5` (spawns looked at, and how many moved).

## Privacy

The task prompt is sent like a prompt of the effort router: towards a backend that
leaves the machine it is redacted and masked with guardrail's map first, then clipped
to `prompt_max_chars` (4000) and neutralized; towards a local backend, clipped and
neutralized. A mask map that exists but cannot be read stops the request. Nothing of
the prompt reaches a log line ([Privacy](router.md#privacy)).

## Configuration

`config/agents.json`, with the layers of `router.json`:

- yours, `~/.config/jev-hooks/agents.json`: a whole file that replaces the plugin's
  when it is valid; an invalid one is ignored with a note, unless it says
  `"enabled": false`, which keeps the router off;
- the project's, `.jev-hooks/agents.json`: only `"enabled": false` is read. A cloned
  repository cannot send your subagents to a cheaper model, nor to a model of its
  choice; every other field is ignored with a note.

The question text is bound to the measurement by its sha256: change it only with a
new measurement ([bench](../bench/README.md#agents-devjsonl-task-prompts-for-the-subagent-router)).

## Switches

- `agent_router: false` in `/plugin`.
- `JEV_HOOKS_AGENTS=0` turns off the subagent router alone, `JEV_HOOKS_DISABLE=1` the
  whole plugin; both read at every spawn from Claude Code's own environment.
- `"enabled": false` in your `agents.json` or in the project's.

## Measured, not fitted

On 2026-10-08 the same tasks with known answers ran on Opus 5.5, Sonnet 5.5 and
Haiku 5.5: 52 claims about this repository's code whose truth was computed by running
it, and 4 × 26 bench rows labelled against written definitions. Haiku matched Opus on
51 of 52 claims and 201 of 208 labels, at about a twentieth of the cost; Sonnet costs
half of Opus on input and output but the same on cache reads, which dominate a
subagent's tokens, so it saves little. On 120 synthetic task prompts the question is
right 90% of the time; on 31 real task kinds from this repository's own sessions, 77%,
and the route moves 15 of them, about 28% of their subagents' cache-read tokens, one
wrongly (a dataset writer read as `label`). The threshold is not fitted, the sample is
small and from one repository: details in the
[bench](../bench/README.md#agents-devjsonl-task-prompts-for-the-subagent-router).
