# jev-hooks

Claude Code plugins driven by **typed decisions**, in the style of TypeSafe's Jev: a
decision model answers narrow, closed questions about your change ("does an
added line hold a real credential?"), each answer is a probability, and plain code
turns those probabilities into an action with thresholds you can read and edit. The
model never decides the verdict; your JSON does.

The first plugin is a **commit reviewer**: when Claude runs `git commit`, the diff is
split into chunks, a `/v1/systemone` backend answers the questions in
`config/checks.json`, and `config/policy.json` computes one of four lanes: **BLOCK**,
**SECURITY REVIEW**, **NITS** or **MERGE**. Critical findings go back to Claude as
precise points to check, never as a verdict to obey.

The same plugin holds an **effort router**, off unless you turn it on: the same
backend answers seven questions about each prompt you type, and `config/router.json`
turns the answers into the effort of that turn, never above the one your session asks
for. A rename does not need the reasoning a design question needs.

> **Status: public preview.** The commit reviewer, the `/jev-review` and `/jev-status`
> skills and the `jev-review` CLI work. The
> effort router is built, opt-in and early access: it runs on Claude Code's function
> hooks, and one live run on Claude Code 2.1.283 has shown the effort it sets reaching
> the API request and the prompt cache surviving the change (README → Limitations).
> The GitHub Action is built: a CI job runs it on GitHub's runner on a diff, and tests
> against a fake GitHub API cover its two-phase flow, which has not yet reviewed a real
> pull request. About 890 offline tests cover all of it. The reviewer's thresholds come from a small synthetic bench (below)
> and the router's are not fitted: treat verdicts as a second opinion, not as a gate.

## Why typed decisions

A general LLM asked "review this diff" writes paragraphs you cannot threshold, test or
diff between versions. A decision model asked "which of these string-building patterns
appears in an added line: none, sql_concat, shell_concat, eval_or_template,
other_sink?" returns a probability for each option, in a fraction of a second, and the
same question gives comparable numbers tomorrow. That buys three things:

- **The verdict is code.** Lanes, thresholds and floors live in `policy.json`. Every
  BLOCK comes with the rule that fired (`floor: stripe_live in src/payments.py:3`),
  never with "the model felt uneasy".
- **Behaviour changes by opening a JSON, never by touching the code.** No check id,
  threshold or question text is written in the source.
- **Questions can be measured.** A question is a fixed text with a sha256; a bench
  tells how well it separates good diffs from bad ones, and a better wording is chosen
  with numbers, not taste.

Three question types, as in Jev:

| Type | Asks | Returns |
|---|---|---|
| `noul` | yes or no | P(yes) |
| `choice` | one of named options | a probability per option |
| `score` | a level on an ordered scale | a probability per level |

## What is in the box

| Component | State | What it does |
|---|---|---|
| Commit reviewer (`PreToolUse` hook on Bash) | **works** | Reviews the diff when Claude runs `git commit`; denies, asks, or adds context |
| Commit log (`PostToolUse` hook) | **works** | Records whether a reviewed commit actually happened, for later calibration |
| `jev-review` CLI | **works** | `review`, `explain <check>`, `status`, from your own terminal |
| Question bench and policy simulator | **works** | `bench/`, `scripts/measure-questions.ts`, `scripts/simulate-policy.ts` |
| `/jev-review` and `/jev-status` skills | **works** | Review on demand and a backend check, served by a hook so they run outside the sandbox; see [On demand](#on-demand-jev-review-and-jev-status) |
| Guard on `.jev-hooks/` edits (`PreToolUse` hook on Edit and Write) | **works** | Asks before Claude edits the project's reviewer rules with its editing tools |
| Effort router (function hook, `hooks/register.ts`) | built, opt-in, early access; one live run so far | Lowers the effort of a turn from observable features of your prompt, never above the session's (`config/router.json`); see [Effort router](#effort-router-opt-in) |
| GitHub Action (`action.yml`) | built; not yet run on a real pull request | Two-phase review of pull requests, safe for forks, with a `jev-review` check run; see [GitHub Action](#github-action) |

## How it works

```
Claude runs `git commit …`
        │  PreToolUse hook, outside Claude's sandbox (it can reach your LAN)
        ▼
  diff that the commit would contain   (hardened git, temporary index)
        │
        ├──▶ detectors: regexes, no network ─────────────────────┐
        │     live keys, private keys, text addressed to the      │ floors
        │     reviewer, bidi and zero-width characters, CI files  │ (hold even with
        │                                                         │  the backend down)
        ├──▶ redaction (only towards non-local backends)          │
        ├──▶ chunks of about 2000 tokens, risky files first       │
        ▼                                                         │
  POST /v1/systemone  ── 7 chunk questions per chunk              │
        │              ── 5 global questions on title,            │
        │                 description and file list               │
        ▼                                                         │
  probabilities ──▶ calibration profile (matched by the           │
                    backend's fingerprint, model or host)         │
        ▼                                                         ▼
  policy.json: lanes in order, first fired rule wins ──▶ BLOCK · SECURITY REVIEW · NITS · MERGE
        │
        └──▶ escalation items: question, p, threshold, files and line ranges
                 └──▶ Claude rereads only those files (never receives diff lines)
```

What each step is for:

- **Two kinds of state.** The seven chunk questions (secrets, injection, auth,
  weakened tests, API breaks, data migrations, debug leftovers) see only the file list
  and the diff of their chunk, never the title or the description: a description is
  written by whoever made the change, and on a pull request from a fork it can be hostile.
  The five global questions see title, description and the full file list. Two more
  checks (`docs_only`, `merge_ready`) are computed by code, because a 4B model applies
  rules poorly and a path regex does not.
- **Floors.** A deterministic detector sets a minimum lane the model cannot lower: an
  `sk_live_…` key in `src/` is BLOCK even with the backend switched off. When the floor
  is already BLOCK, the backend is not even called.
- **Escalation instead of blocking.** Above a critical question's threshold, the hook
  denies the commit once with a short prompt for Claude: which question, which p,
  which files and lines to reread. Claude checks, fixes or explains, and repeating the
  same commit goes through without asking you. Items from a regex (a CI workflow, an
  invisible character) or from a file the model never saw (minified, binary, omitted)
  are different: on the second attempt, you decide.
- **Fail-open, visibly.** If the backend is down, slow or misconfigured, the commit
  proceeds with a one-line notice (once per session and error kind). Floors still
  apply. A reviewer that blocks your work because a box on your LAN is asleep gets
  uninstalled.

What the hook does per lane:

| Lane | Exit code (CLI) | Commit hook | Reached by (default policy) |
|---|---|---|---|
| BLOCK | 3 | `deny`, with the rule and the fix to make | detector floors only: private keys, live AWS, Stripe, GitHub and Slack tokens |
| SECURITY REVIEW | 2 | `ask`: you confirm, also in auto mode | detector floors: text addressed to the reviewer, prompt delimiters, bidi controls, changes to `.jev-hooks/` |
| NITS | 1 | notes in Claude's context; critical questions above threshold escalate to Claude | model rules |
| MERGE | 0 | one status line | nothing fired |

The hook is a safety net, not a barrier: it sees commits that Claude makes with its
Bash tool, not the ones you make in your own terminal, not commits hidden behind a
script or an alias. The [GitHub Action](#github-action) is where a required check belongs.

### On demand: `/jev-review` and `/jev-status`

```
/jev-hooks:jev-review                   staged changes, else uncommitted ones, else the branch against main
/jev-hooks:jev-review --staged          or --working, a git reference (origin/main, HEAD~3),
                                        or a .diff or .patch file inside the repo
/jev-hooks:jev-status                   the backend, the model, one real decision, the profile
```

Claude's sandbox cannot reach your LAN and does not hold the key, so neither skill runs
anything through Bash. A command hook does the work outside the sandbox, on both routes:
when you type the command (`UserPromptExpansion`) and when Claude invokes the skill by
itself (`PreToolUse` on the Skill tool). The skill receives the same data block the
commit hook gives Claude, and its instructions say to report the verdict as computed,
to look deeper only at the escalation items, and to change nothing without asking you.
Arguments are validated on both routes, since Claude writes them in the second:
anything else is refused as an invalid argument, and never echoed back. The review
uses the same configuration as the commit hook, including the HEAD version of
`.jev-hooks/` rules you have modified and not committed, and it is logged with origin
`skill`. Neither skill ever blocks: an error (backend not configured, not a git repo)
comes back as data for Claude to explain.

## Backends

The backends speak the same contract, `POST /v1/systemone` with `{state, model,
questions}`, and jev-hooks treats them the same way. They differ in where your diff
goes, and in how far their answers have been measured.

### rizzo-flow, self-hosted (recommended for private code)

[rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow) (Apache-2.0, by Rizzo AI
Academy) is an open-source server compatible with Jev's endpoint. It runs the
Spark-X2.5-4B model through llama.cpp, computes each answer from the logits of the
option letters, and keeps the whole diff on your own hardware.

It was developed and measured against rizzo-flow (commit `f363583`) serving the 4B
model as **GGUF BF16 on an NVIDIA DGX Spark** (GB10, aarch64, CUDA). BF16 because
rizzo-flow's own check found 1 answer flip in 777 between its shared and direct modes,
against 13 for Q8_0. Measured on that machine:

| What | Result |
|---|---|
| Model load | 17 s; memory peak about 10 GB with `--ctx 8192` |
| 14 questions on an 8000-character diff state (3754 tokens) | **1.00 s** warm, 1.16 s on the first call |
| Tokenization of diffs | about 2.9 characters per token |
| Holdout bench: 242 requests, about 1.8k input tokens each | median **0.28 s**, p95 0.59 s |
| Dev bench: 236 requests carrying 44 question variants, about 5.9k input tokens each | median 0.82 s, p95 1.94 s |
| 7 router questions on a short prompt (663 tokens) | 0.22 s warm |

Things to know before you expose it:

- **Requests are serialized** (one lock), and a request the client abandons keeps
  running. jev-hooks never retries a timeout. The effort router shares the reviewer's
  instance unless you give it another one: during a review it times out and leaves the
  turn's effort alone (see [Which backend](#which-backend)).
- **`--ctx` is per question** (state plus question). Chunks of about 2000 tokens stay
  far below the default 8192; an overflow comes back as a 422 that jev-hooks recognizes
  and answers by re-splitting.
- **rizzo's own auth is thin.** `RIZZO_API_KEY` protects only `/v1/systemone` and
  `/v1/models`; `/v1/decisions`, `/health`, `/docs` and `/playground` stay open, and
  there is no TLS. Bind it to `127.0.0.1` and put a reverse proxy in front that lets
  through only `POST /v1/systemone` and `GET /v1/models`, reachable over your LAN or
  Tailscale. The proxy must answer them itself, never with a redirect (no
  http-to-https or canonical-host 301/308 on those paths): the effort router's requests
  go through Claude Code, which follows redirects (see [Which backend](#which-backend)).
- jev-hooks accepts `http://` **only towards local hosts** (loopback, private ranges,
  `100.64.0.0/10` for Tailscale, `*.ts.net`, `*.local`). Anything else must be
  `https://`, checked before a byte is sent. The check covers the URL you configure,
  not the target of a redirect.

```bash
rizzo serve --host 127.0.0.1 --port 8017 --quant bf16 --device cuda
```

Then set `review_url` to your proxy, for example `http://192.168.1.50:8017` on the LAN
or `http://100.64.0.10:8017` over Tailscale. [docs/spark.md](docs/spark.md) is a
step-by-step guide for a DGX Spark: a systemd unit, a checked proxy configuration
([`examples/spark/Caddyfile`](examples/spark/Caddyfile)), a real-decision test and the
tailnet setup for GitHub Actions.

### CLM-8B, self-hosted (measured: not recommended)

[CLM](https://github.com/Contrastive-LM/CLM) (Apache-2.0, by Contrastive-LM) answers the
same contract with a Qwen3-8B encoder served by vLLM and small projection heads that
score each option against the state. jev-hooks works with it unchanged; set the model
to `clm-latest`. On a DGX Spark, next to rizzo, it was measured on the same dev bench
and router prompts (`bench/results/2026-09-29-clm-dev`, `…-clm-router-dev`):

| AUROC of the current wording | rizzo | CLM |
|---|--:|--:|
| `hardcoded_secret` | 0.925 | 0.372 |
| `touches_auth` | 0.980 | 0.434 |
| `injection_risk` | 0.994 | 0.666 |
| `weakens_tests` | 0.994 | 0.851 |
| `data_migration` | 1.000 | 0.525 |
| router `has_error_evidence` | 1.000 | 0.522 |
| router `risky_irreversible` | 1.000 | 0.672 |

Below 0.5 a question points the wrong way. Across the 44 wordings of the bench, CLM's
best reaches 0.85, where rizzo's best reach 0.94 to 1.00 on every question but
`description_matches` (0.66 for rizzo, 0.62 for CLM). With CLM the router answers
"risky" to almost every prompt, so a session at high never goes lower. It is faster (median 0.57 s against 0.82 s on the
dev bench, 0.26 s against 0.37 s on the router's prompts), but its heads were trained
to score agent actions, not to read diffs. Keep rizzo; CLM gets the `clm-provisional`
calibration profile, with an unknown backend's wide band, for whoever tries it anyway.
It also truncates instead of refusing: past `--max-tokens` (2048 by default) the head
of the state is cut with no error, so serve it with 4096 on both vLLM and `clm-serve`.
[docs/spark.md](docs/spark.md#7-clm-8b-instead-of-rizzo-measured-not-recommended) has
the commands.

### TypeSafe Jev, with your own key

Point `review_url` at `https://api.typesafe.ai` and set your own API key. Keys are
personal: TypeSafe's terms rule out shared proxies and distillation, so jev-hooks never
proxies a key and never turns Jev's answers into training labels.

With Jev, the diff leaves your machine. Before sending, jev-hooks replaces every secret
its detectors recognize with a random value of the same shape, sends sensitive files
(`.env`, `.pem`, `credentials`…) as a path only, and applies guardrail's mask map if you
have one. A secret no regex recognizes still goes out: for private repositories, prefer
a local rizzo.

The thresholds were measured on rizzo, not on Jev. The `jev` calibration profile
trusts TypeSafe's statement that its probabilities are calibrated (identity), which has
not been verified on diffs.

## Install

The repo is both a plugin and its own marketplace. Claude Code clones it with git from
GitHub (branch `main`).

```
/plugin marketplace add 7hemas7er/jev-hooks
/plugin install jev-hooks@7hemas7er-jev-hooks
```

From a local clone, to try or develop it:

```
/plugin marketplace add /path/to/jev-hooks
/plugin install jev-hooks@7hemas7er-jev-hooks
```

Requirements: **Node ≥ 22.18** (it runs TypeScript by stripping types, with no build
step and no dependencies). Claude Code starts hooks without the PATH of your interactive
shell, so the Node that nvm or fnm add from `~/.bashrc` is often not on it. The hook
launcher looks for a Node ≥ 22.18 with type stripping by itself, in this order:

1. `JEV_HOOKS_NODE`, if set;
2. `node` (then `nodejs`) on the PATH the hooks see;
3. version-manager installs, the highest version first: nvm (`$NVM_DIR`, default
   `~/.nvm`), fnm (`$FNM_DIR`, `~/.local/share/fnm`, `~/.fnm`, and
   `~/Library/Application Support/fnm` on macOS), volta (`$VOLTA_HOME`, default
   `~/.volta`), asdf (`$ASDF_DATA_DIR`, default `~/.asdf`), mise (`$MISE_DATA_DIR`,
   default `~/.local/share/mise`) and n (`$N_PREFIX`, default `/usr/local`);
4. Homebrew and system paths: `/opt/homebrew/bin`, `/home/linuxbrew/.linuxbrew/bin`,
   `/usr/local/bin`, `/usr/bin`.

Each candidate costs one short `node` run to check its version, and the search stops at
the first that passes, so it adds no noticeable time. Set `JEV_HOOKS_NODE` to the full
path of a node binary only when the search picks the wrong one or finds none: a Node
installed somewhere else, or a version manager whose directory variable is set only in
your shell. Without a suitable Node the hook skips the review with a notice that says
so, instead of failing your commit.

The effort router needs neither Node nor bash: it runs inside Claude Code, as a
function hook with requirements of its own (see
[What it needs](#what-it-needs)).

Then open `/plugin`, pick jev-hooks and fill in its options:

| Option | Default | Meaning |
|---|---|---|
| `review_url` | empty (reviewer off) | Base URL of the `/v1/systemone` backend |
| `router_url` | empty (uses `review_url`) | Backend of the effort router, when it should not share the reviewer's |
| `api_key` | empty | Bearer key: required for TypeSafe, optional for rizzo with `RIZZO_API_KEY` |
| `router_api_key` | empty (uses `api_key` or the key file, only when `router_url` is empty or on `review_url`'s host) | Bearer key for `router_url` |
| `model` | `jev-latest` | Requested model, for the reviewer and the router; `jev-latest` also works with rizzo-flow |
| `commit_review` | `true` | Review when Claude runs `git commit` |
| `effort_router` | `false` | Turn the [effort router](#effort-router-opt-in) on; it also needs function hooks |

**Where the key lives, and why.** `api_key` and `router_api_key` are `sensitive`
options: Claude Code keeps them out of `settings.json`. The command hooks receive the
options in their own environment, not in the environment of the commands Claude runs,
and the router gets them from Claude Code in-process, never through an environment.
That matters, because anything in the `env` block of your settings reaches every
Bash command, and a prompt injection in a file Claude reads could send it anywhere.
Fallbacks, in order of preference:

- `~/.config/jev-hooks/key`, one line, `chmod 600` (the commit hook warns when other
  users can read it; the router cannot check, see [Which backend](#which-backend)).
  Hide it from Claude's sandbox:
  `"sandbox": {"credentials": {"files": [{"path": "~/.config/jev-hooks/key", "mode": "deny"}]}}`.
  A build installed from a local clone before this preview used another file name:
  see [Upgrading from an earlier local build](CHANGELOG.md#upgrading-from-an-earlier-local-build);
- `JEV_HOOKS_URL` / `JEV_HOOKS_KEY` / `JEV_HOOKS_MODEL`, or `TYPESAFE_BASE_URL` /
  `TYPESAFE_API_KEY` / `TYPESAFE_DEFAULT_MODEL`. If they sit in your settings, deny
  them to the sandbox with `"sandbox": {"credentials": {"envVars": [{"name":
  "JEV_HOOKS_KEY", "mode": "deny"}, {"name": "TYPESAFE_API_KEY", "mode": "deny"}]}}`.
  The router reads none of these keys: from the environment it takes only a URL.

Each source is a layer of (URL, key, model), and a key is sent **only to the URL of its
own layer**: a `TYPESAFE_API_KEY` exported for the SDKs never travels in clear to the
rizzo box on your LAN. The key goes only in the `Authorization` header, never in URLs,
output, logs or error messages. The reviewer's client refuses redirects, so the key
cannot follow one to another host. The router's requests go through Claude Code's
`$.http.fetch`, which follows up to five redirects and drops `Authorization` when one
leads to another origin (another scheme, host or port): only a redirect within the
same origin still carries the key. The body is another matter: on a 307 or 308 the
request is sent again with its body, your prompt, to any http or https origin, see
[Which backend](#which-backend).

Check the setup with `/jev-hooks:jev-status` in a new session, or from your own terminal
(Claude's sandbox cannot reach your LAN, which is why the skills run inside a hook):

```bash
bin/jev-review.mjs status --url http://192.168.1.50:8017   # from a clone
```

Without `--url` it uses `JEV_HOOKS_URL` or `TYPESAFE_*`; the key comes from the
environment or the key file, never from a flag.

It lists the backend's models, runs one real decision and prints host, model,
fingerprint, latency, the calibration profile it picked and where each config file came
from.

### Updating

The installed plugin is a copy in `~/.claude/plugins/cache/`, taken at install time,
and Claude Code compares version numbers, not commits: a change arrives with the
release that raises the version, and only when you ask for it:

```
/plugin marketplace update 7hemas7er-jev-hooks
/plugin update jev-hooks@7hemas7er-jev-hooks
```

Then start a new session: the open one keeps the old hooks.

### Turning it off

The reviewer: `commit_review: false` in `/plugin`, or `"hook": {"enabled": false}` in
your user `policy.json`. The effort router: `effort_router: false` (its default),
`JEV_HOOKS_ROUTER=0`, or `"enabled": false` in your user or the project's
`router.json` ([more](#switches)). The skills run only when asked, whatever
`commit_review` says. `JEV_HOOKS_DISABLE=1` turns off everything: the reviewer, the
skills (they answer that the plugin is off), the guard and the router. If you also
run Anthropic's security-guidance plugin, it reviews `git commit` too: keep both, or
switch one off.

## GitHub Action

The Action reviews pull requests in two phases, so that a pull request from a fork
never runs next to your secrets. Copy the two files of
[`examples/workflows/`](examples/workflows/) into `.github/workflows/`:

- **`jev-review-collect.yml`**, on `pull_request`, with no secret and no code of the
  pull request run: it uploads the PR number, the two SHAs and the diff as an artifact.
  On a fork its author can rewrite this workflow, so its output is treated as hostile.
- **`jev-review.yml`**, on `workflow_run`, from your default branch, with the secrets.
  It takes the head sha, branch and repository from the event (trusted), finds the one
  open pull request they match, reviews the diff GitHub's API gives for the two SHAs
  (the artifact is only a cross-check) and always publishes a completed `jev-review`
  check run, with the verdict, the values and the escalation prompt ready for a review
  with Claude. The rules come from `.jev-hooks/` on the default branch.

Set the variable `JEV_URL` (and optionally `JEV_MODEL`) and, if the backend needs one,
the secret `JEV_API_KEY`. A backend on your tailnet takes an ephemeral node:
`JEV_TAILSCALE=true` and the `TS_OAUTH_*` secrets, with an ACL that reaches only the
backend's port. Pin the action to the SHA of a release you have read.

| Outcome | Check conclusion (default) |
|---|---|
| BLOCK | `failure` |
| SECURITY REVIEW, or an escalation | `neutral`: visible, does not block the merge |
| NITS, MERGE | `success` |
| Backend down, unreachable or not configured | `neutral` (`ci.backend_unavailable`) |
| Anything the PR author controls or can break: first phase failed, artifact missing or foreign, pull request not identifiable, diff too large, partial coverage, an internal error | `failure` (`ci.untrusted_input`) |

To stop merges on a SECURITY REVIEW, put `{"lanes": [{"name": "SECURITY REVIEW", "ci":
"failure"}]}` in `.jev-hooks/policy.json` and make the check required. A required check
has a catch: created with `GITHUB_TOKEN`, it belongs to the GitHub Actions app, and a
fork can add a workflow with a job named `jev-review` that succeeds on the same head
sha. Create the check run with a dedicated GitHub App instead (`checks-token`, from
`actions/create-github-app-token`) and set that app as the check's expected source in
branch protection.

Nothing runs an agent on a fork's code: the escalation stays text in the check run, for
a maintainer to hand to Claude. `mode: file` reviews a diff file with no GitHub API;
this repository's CI uses it as a smoke test.

## Configuration: open a JSON, never touch the code

| File | What it decides |
|---|---|
| `checks.json` | The questions: id, label, type, the exact text sent to the model, which state it sees, whether it is critical |
| `policy.json` | Lanes and their order, rules and thresholds, detectors and floors, escalation behaviour, chunk and time limits |
| `calibration.json` | Per-backend profiles (matched by fingerprint, model or host): temperatures, per-question thresholds, the uncertainty band |
| `router.json` | The effort router's questions, the effort each answer leads to, its timing and its cache guard |

Every key starting with `_` is a note for humans: the defaults explain each threshold
in its `_why`, with the numbers it was chosen on. `jev-review explain <check>` prints
the question, the rule that uses it, where its threshold comes from and the band.

Files are read from three layers:

| Layer | Where | Trusted | How it combines |
|---|---|---|---|
| Plugin defaults | `config/` in the plugin | yes | the base |
| User | `${XDG_CONFIG_HOME:-~/.config}/jev-hooks/` | yes | replaces the defaults, file by file |
| Project | `.jev-hooks/` in the repo | **no** | can only tighten |

**Why the project layer is untrusted.** A repository you clone, or Claude after reading
a prompt injection, can write `.jev-hooks/`. If a project file could loosen the rules,
removing a floor would take one line. So:

- a project `policy.json` is an overlay that can only **tighten**: add detectors and
  rules, raise floors, use a stricter threshold on the same check, lower limits and
  parallelism, make a CI conclusion more severe (a lane's `ci`, `escalation.ci`, the
  two classes of `ci`). Anything else is ignored with a note naming the file and the
  JSON pointer;
- a project `calibration.json` is ignored: a steep calibration could squash every
  probability to zero;
- a project `router.json` can only turn the effort router off (`"enabled": false`) or
  lower its cap (`"max_effort"`); every other field is ignored with a note that names
  it (the first three; past them one note gives how many more), and no note quotes the
  file;
- a project `checks.json` can ask different questions, but the trusted rules must still
  resolve against it, its texts are never shown to Claude, and its regexes run in a
  worker with a time limit;
- an invalid project file never switches anything off: the trusted base applies, with a
  warning;
- if `.jev-hooks/` differs from `HEAD` (untracked files included), the commit hook uses
  the committed rules and asks you, so a `sed` run through Bash cannot loosen them
  silently. Committing a change to `.jev-hooks/` itself is a SECURITY REVIEW.

To loosen something, use your **user** file. The demo in `examples/user/policy.json` is
the plugin policy with one threshold raised; copy it to `~/.config/jev-hooks/policy.json`
and the demo's `secret.diff` goes from "escalate to Claude" to MERGE, with no code
change. `scripts/simulate-policy.ts` shows what any policy change does to the bench
before you trust it.

## Effort router (opt-in)

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

### What it needs

- **`effort_router: true`** in `/plugin` (default `false`). Claude Code hands the
  options to the module when it loads it, and reloads it when they change, so with the
  option off the module registers no hook at all and no prompt pays for it.
- **Function hooks turned on**: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in Claude Code's
  environment (exported before you start `claude`, or in the `env` block of your
  settings), unless your account already has them through Claude Code's own rollout.
  They never load under `--bare`, `disableAllHooks` or `allowManagedHooksOnly`.
  Function hooks are early access: their API can change between Claude Code releases
  without notice, and the router was written and tested against 2.1.283.
- **Opus 5.5 or Fable 5.1, and the per-turn-control beta on your account.** Only with
  both does a change of effort keep the prompt cache. Without the beta, or after Claude
  Code drops it until `/clear` or `/compact`, every change of effort empties the cache
  and the turn pays for the whole context again. The plugin can check the model
  (`only_models`: `opus-5-5` and `fable-5-1`, matched case-insensitively inside the
  model id) but cannot see the beta. That is why the router is opt-in, and why it
  watches the cache itself ([The cache guard](#the-cache-guard)).
- **A backend**: `router_url`, or `review_url` when it is empty
  ([Which backend](#which-backend)).

### What it decides

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
   −2, bug_with_error 0, feature −1, refactor 0, design 0, review −1, ops −2.
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

With the session at high, a prompt classified as small_edit (a rename) goes to low and
a feature to medium; a bug report with its stack trace stays at high; a request to
deploy to production "quickly" stays at high too (quick says low, the floor says high).
With the session at max, a question goes to high: the steps are relative.

The turn keeps its effort when:

- the task kind's calibrated probability is below `min_top_probability` (0.3);
- an answer that a rule reads is missing: every rule in the shipped file raises, so
  skipping one would push the effort down;
- the session's effort is a number (an internal token budget, which a hook may pass on
  but not set) or absent (`assume_session_effort: null`). It is absent only on a model
  without effort, or with `CLAUDE_CODE_EFFORT_LEVEL` set to `unset` or `auto`;
- the result is the session's effort anyway.

### Which prompts, which turn

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

### Timing and failures

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

### Which backend

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

### What you see

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

### The cache guard

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

### Privacy

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

### Configuration

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
  ([Configuration](#configuration-open-a-json-never-touch-the-code)). Outside a
  repository, it is read in the session's directory. If another plugin refuses Claude
  Code's `$.session.repo`, the top level is still found from the session's directory
  (the session's directory itself when no `.git` is found); in a linked worktree only
  the checkout's own file is read then, because the main working tree is unknown.

### Switches

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

### Measured, not fitted

The router's questions have their own bench: 120 labelled prompts to choose on
(`bench/router-dev.jsonl`) and 120 written afterwards to check
(`bench/router-holdout.jsonl`), measured on the Spark with
`scripts/measure-router.ts`. On the holdout set:

- `task_kind` is right 84% of the time; `has_error_evidence` (AUROC 0.998) and
  `risky_irreversible` (0.982) separate well; `underspecified` does not (0.54), and
  mostly acts as a floor at medium; `scope` is right 53% of the time, 80% within one
  level.
- End to end, from a session at xhigh the router went below the labelled effort on
  1 prompt in 110 and saved 90 of the 177 steps the labels allow; from a session at
  high, 8 in 110 and 52 of 80.

The thresholds were set by hand and checked on these sets, not fitted. The router
often leaves the effort alone, which is the safe side. The debug log prints every
classification, and `measure-router.ts --replay` shows what another `router.json`
would have chosen on the same answers without asking the backend again.

## The measured bench

Before choosing a threshold you need to know whether a question separates at all.
`bench/` holds hand-labelled synthetic diffs and the scripts that measure them
(`bench/README.md`, `bench/MEASUREMENT.md`; the method, and the calibration still to
do, in [docs/evaluation.md](docs/evaluation.md)):

- **dev set**: 118 diffs, used to compare 44 wordings of the questions and to choose
  thresholds;
- **holdout set**: 121 new diffs, longer and spread over more files, written without
  looking at the variants and frozen before being measured once, with the exact texts
  of `checks.json`.

Both were measured on 2026-09-26 against rizzo-flow with Spark-X2.5-4B BF16 on the DGX
Spark (fingerprint `64219e54c725…`). The reports, raw answers and per-question hashes
are in `bench/results/`.

| Question | Form sent | AUROC dev | AUROC holdout | Rule in `policy.json` | dev TPR · FPR | holdout TPR · FPR |
|---|---|--:|--:|---|---|---|
| hardcoded_secret | noul | 0.924 | 0.987 | ≥ 0.10 → escalate | 0.78 (7/9) · 0.028 (3/109) | 0.91 (10/11) · 0.027 (3/110) |
| injection_risk | choice, 1 − P(none) | 1.000 | 0.976 | ≥ 0.99 → escalate | 1.00 (8/8) · 0.036 (4/110) | 0.83 (10/12) · 0.064 (7/109) |
| touches_auth | noul | 0.980 | 0.969 | ≥ 0.70 → escalate | 0.60 (6/10) · 0.028 (3/108) | 0.71 (10/14) · 0.047 (5/107) |
| weakens_tests | choice, 1 − P(none) | 0.999 | 0.995 | ≥ 0.50 → escalate | 1.00 (9/9) · 0.028 (3/109) | 1.00 (12/12) · 0.037 (4/109) |
| breaks_api | choice, 1 − P(none) | 0.930 | 0.901 | ≥ 0.90, note | 0.67 (8/12) · 0.019 (2/106) | 0.81 (13/16) · 0.057 (6/105) |
| data_migration | choice, 1 − P(none) | 1.000 | 0.992 | ≥ 0.20, note | 1.00 (7/7) · 0.027 (3/111) | 1.00 (10/10) · 0.072 (8/111) |
| debug_leftovers | noul | 0.994 | 0.966 | ≥ 0.40, note | 0.88 (7/8) · 0.027 (3/110) | 0.91 (10/11) · 0.036 (4/110) |
| adds_tests (sent as "missing tests?") | choice, 1 − P(none) | 0.963 | 0.937 | ≤ 0.30 unless docs only, note | 0.74 (57/77) · 0.024 (1/41) | 0.83 (50/60) · 0.066 (4/61) |
| description_matches | noul | 0.425 | 0.608 | none (informational) | — | — |

AUROC is the probability that a diff with the problem gets a higher p than one without
(1 separates perfectly, 0.5 is chance). TPR is the share of problems the rule catches;
FPR is its false-alarm rate on diffs without that problem. Thresholds were chosen on the
dev set to stay near 3% false alarms, then checked on the holdout set, where false
alarms rose to 3–8% per question: that gap is the honest cost of choosing on a small
set. Seen per commit, on the holdout set's 34 diffs with no labelled problem, none
reached BLOCK or SECURITY REVIEW and 11 (32%) sent at least one question to Claude; on
the dev set, 4 of 28 (14%).

**Why the model never blocks on its own (policy v2).** With the first policy, where
model rules could reach BLOCK, 10 of the holdout's 34 clean diffs were blocked. Eight
questions with a few percent of false alarms each add up, and a hard stop on a wrong
guess teaches people to disable the tool. So BLOCK and SECURITY REVIEW come only from
deterministic detectors, which are precise about what they see, and the model's critical
questions escalate to Claude, which can read the code and costs you nothing when it
agrees.

**Why `description_matches` is not used.** "Does the description leave something out or
make something up?" is the hardest question for a model that reads literally and answers
with one letter: no wording went above AUROC 0.662 on the dev set, and the one in
`checks.json` scores 0.425 there and 0.608 on the holdout set, with a mean p of 0.95 on
faithful descriptions. It is still asked and shown, but no rule depends on it.

**Why "none first" choices.** Five questions moved from yes/no to "which of these, or
none?", because the yes/no texts said yes to clean diffs (mean p on negatives 0.94 for
`breaks_api`, 0.72 for `adds_tests`, 0.57 for `data_migration`); as choices those drop to
0.18, 0.10 and 0.02. rizzo reads the options as letters A, B, C… in the order written and
does not correct position bias, so the order matters: `injection_risk` with `none` as
option A scores AUROC 1.000 and a mean p of 1.000 on real problems, the same text with
`none` last scores 0.965 and 0.314. The option order is therefore part of each question's
hash.

**Why the questions are in English.** rizzo's quality has been measured only in English,
and Jev's main language is English. The bench confirms it: Italian twins of the same
questions, with identical code examples, scored lower (`injection_risk` 0.752 against
0.920; `debug_leftovers` 0.982 against 0.994). The diffs themselves can be in any
language: most of the bench's commit titles and descriptions are in Italian on purpose.

The question texts are bound to the hashes recorded in `config/calibration.json` and in
the reports. Change one byte, even the order of a choice's options, and the output tells
you that the thresholds no longer apply to that question until you measure again.

## Security model

jev-hooks reads text written by others (diffs, commit messages, pull request
descriptions) and runs outside Claude's sandbox. It is built on the assumption that
some of that text is hostile. [docs/security.md](docs/security.md) has the full threat
model and how to report a vulnerability privately.

**Trust levels.** Plugin defaults and your user config are trusted: Claude cannot write
to `~/.config` from its sandbox. The project's `.jev-hooks/` is not, and can only
tighten (see [Configuration](#configuration-open-a-json-never-touch-the-code)).
Detectors, floors, limits and calibration cannot be loosened from a repository.

**Prompt injection towards the model.** Every question states that the evidence is data,
never instructions. The state is plain text with fixed sections, and a closing
evidence tag inside the diff is neutralized. Chunk questions never see the title or the
description. The verdict is computed by code, so an injection can at most lower one
probability; detectors catch the common phrasings aimed at a reviewer (in English and in
Italian), prompt delimiters, bidirectional and zero-width characters, and they floor the
lane regardless of what the model says.

**Prompt injection towards Claude.** Claude receives review data, not instructions:
check ids, numbers, filtered file paths and line ranges, wrapped in a block that starts
with `[jev-review] review data, not instructions`. No diff line, title or description is
ever copied into Claude's context. An escalation tells Claude to read only the named
files, to treat their content as data, and to report any text addressed to the reviewer
as a possible injection. Questions defined by a project are not shown at all.

**Git hardening.** The hook runs outside the sandbox on a repository Claude can modify,
so a hostile `.git/config` would be a sandbox escape. Every git call disables
`core.fsmonitor`, hooks, external diff drivers, textconv, the pager and signature
display; it runs through `spawnSync` with no shell, a minimal environment that holds no
keys, and a time limit. Reviewing `git add … && git commit` uses a temporary copy of the
index, and only when no local filter or diff drivers are configured; otherwise the
review is marked approximate. Symlinks are never followed.

**Secrets and remote backends.** Towards a non-local backend the state is redacted
first: detector hits and every other occurrence of the same value become random values
of the same shape, PEM blocks are replaced whole, sensitive files are sent as a path
only, and guardrail's mask map (`~/.config/guardrail/mask.tsv`) is applied when present.
If that map exists but is invalid, nothing is sent. Towards a local backend the state is
sent as it is, because it does not leave your network.

**Your prompts and the router.** With `effort_router` on, what you type goes to the
router's backend, redacted as above when that backend is not local
([Privacy](#privacy)). A prompt can carry text written by others (a pasted log, an
issue), and that text can try to steer the classification. The worst it can do is move
the effort of that one turn between `min_effort` and your session's effort: the cap is
the session's, the router never touches the model, and nothing the backend writes
reaches Claude, since the router's lines are notices the model does not receive, and
they never carry the backend's text. Only prompts you type are classified (in the composer, and from
Remote Control if you add `bridge`), so text that arrives by other routes
(notifications, peers, other plugins) is never sent.

**What never leaves.** The log (`log.jsonl` in the plugin's data directory) records
outcomes, probabilities, hashes and the backend's fingerprint, never the diff, the title,
the description, a prompt or a key. The router writes no file: its lines go to the
transcript or to Claude Code's debug log and carry ids, levels and numbers, Claude
Code's own messages and pieces of your own configuration (a wrong value in your
`router.json`, the backend's host), never the prompt, a key or the backend's text. The repo itself contains no realistic secret and no
injection phrase: the tests and the demo compose them at run time, so the reviewer does
not fire on its own repository and GitHub's push protection stays quiet.

## Limitations

- **A 4B model.** Spark-X2.5-4B answers with a single letter and no reasoning, reads
  literally, handles negations poorly, and scores 0.50 on rizzo-flow's own
  rule-application test. The questions are written around that, and it still misses
  things a human reviewer would not.
- **A small, synthetic, single-author bench.** 239 diffs in total, with 7 to 16
  positives per question (`adds_tests` aside), written and labelled by one person.
  Labels were not double-annotated, and the holdout set was written by the same author
  who wrote the dev set. The AUROCs above can move by several points on real code.
- **No calibration fit yet.** `calibrated` is `false` in every profile: thresholds sit on
  raw probabilities of one backend identity. Another quantization or llama.cpp build
  changes the fingerprint and falls back to a provisional profile; Jev has not been
  measured on the bench at all.
- **Injection resistance is partial.** Floors catch what a regex can see. A well-crafted
  injection can still lower a probability below a threshold.
- **A safety net, not a barrier.** Commits made outside Claude's Bash tool, through
  scripts or aliases, are not reviewed, and some `git add && git commit` combinations
  get an approximate diff.
- **Latency.** rizzo serializes requests: a large diff split into many chunks, or a
  second client on the same instance, makes you wait. The router is such a client when
  it shares the reviewer's instance: a review in progress makes it time out and leave
  the effort alone, and its own request can hold a review back by a fraction of a
  second.
- **The router rests on early-access APIs.** Function hooks can change between Claude
  Code releases without notice; the router was written and tested against 2.1.283, in
  Claude Code's own test kit and on a fake engine under Node.
- **One live run so far** (2026-09-28, Claude Code 2.1.283, headless `claude -p` on Opus
  5.5 with the session at `high`, a copy of the plugin that also classifies the `sdk`
  origin, rizzo through Tailscale). A logging proxy in front of the API showed
  `output_config.effort` at `low` on both requests of a routed turn, and at `high`
  with `JEV_HOOKS_ROUTER=0`. After a turn at `low`, the next turn at `high` read
  90,727 tokens from the prompt cache, the whole previous request, with the
  per-turn-control beta on. The module loaded next to the command hooks, `e.effort`
  was there with the session's setting, the `claude-opus-5-5` id matched
  `only_models`, and `turn.start` carried the prompt's text. The classification took
  about 0.7 s through Tailscale; the first request of the session took longer than
  `timeout_ms` and left that turn as it was. `CLAUDE_EFFORT` in a Bash command shows
  the session's effort, not the one the router sets for a request. Later sessions
  checked the `claude-fable-5-1` id and a prompt typed in the interactive composer.
  On 2.1.284 a copy with a broken module (`on('turn.stepX', …)`) was refused at load
  ("hooks module … failed to load" in the debug log) while the commit hook of the same
  plugin still fired and denied a commit. Not verified yet: a stored sensitive key
  reaching `options`, and Esc during the wait.
- **The beta is invisible.** The plugin cannot tell whether the per-turn-control beta
  is active. The cache guard notices a cleared cache only after the fact: two turns
  that each paid for the whole context again.
- **The router's thresholds are not fitted.** Its questions are measured on 240
  labelled prompts, but the thresholds were set by hand, and `underspecified` does not
  separate ([Measured, not fitted](#measured-not-fitted)).
- **Platforms.** Developed on Linux; CI runs Node 22.18 and 24 on Ubuntu. Windows is
  untested (the hook launcher is a bash script; the router needs no bash, but it has
  not been tested there either).

## Development

Everything runs on Node ≥ 22.18 with no build step and no dependencies. The rules for
contributors, human or agent, are in [`AGENTS.md`](AGENTS.md).

```bash
node --test "tests/**/*.test.ts"       # offline: a fake /v1/systemone server, a fake engine, temporary dirs only
node scripts/validate-manifest.ts      # manifests, hooks.json, config/*.json
node scripts/generate-defaults.ts --check
node scripts/check-english.ts          # leftover Italian outside the data
claude plugin validate .claude-plugin/plugin.json   # what hooks/register.ts hooks, calls and reads
node scripts/test-cc.ts                # tests-cc/ in Claude Code's own test kit
```

Always pass the glob: without it, `node --test` runs every `.ts` file as a program,
helpers included. The router's decisions are pure functions in `src/core/router.ts`,
tested under Node and in a `node:vm` context as strict as the one Claude Code 2.1.282
gave function hooks; `hooks/register.ts` only carries data between Claude Code and
them. The last two commands need the `claude` CLI, so CI does not run them.
`claude plugin test` takes a plugin root and cannot set options, so
`scripts/test-cc.ts` runs it on a temporary copy of the plugin with the router on;
without the CLI it says so and exits 0.

Try the reviewer on the demo diffs (secrets and injection phrases are composed at run
time, so none of them sits in the repo):

```bash
node scripts/generate-demo.ts /tmp/jev-demo                   # --seed N: the same values every run
bin/jev-review.mjs --diff /tmp/jev-demo/known-secret.diff     # BLOCK from a floor, even with no backend
bin/jev-review.mjs --diff /tmp/jev-demo/uncertain.diff --escalate
bin/jev-review.mjs explain hardcoded_secret
```

The bench, when you change a question or a threshold:

```bash
node bench/verify.ts                                        # dataset schema, diffs, placeholders, counts
node scripts/simulate-policy.ts bench/results/2026-09-26-holdout bench/results/2026-09-26-dev-checks
node scripts/measure-questions.ts --dataset bench/holdout.jsonl \
  --variants bench/variants-holdout.json --url http://127.0.0.1:8017 --out /tmp/measure
```

`simulate-policy` replays recorded answers against today's `policy.json` without
querying the model: counts per lane and per escalation, TPR and FPR per rule.
`measure-questions` asks the model again and is needed only when a question's text
changes.

## Credits and acknowledgements

- **[TypeSafe](https://typesafe.ai/)** designed Jev and the `/v1/systemone` interface
  this project is built around: typed `noul`, `choice` and `score` questions with
  probabilities instead of generated text.
- **[rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)** by Rizzo AI Academy
  (Apache-2.0) is the open-source, Jev-compatible server every number in this README
  was measured on.
- **[DarioFontanel/jev-claude-code](https://github.com/DarioFontanel/jev-claude-code)**
  (MIT) is where this started. Its code-review prompt defines a `checks.json` of 14
  questions (11 noul, 2 score, 1 choice), the four lanes BLOCK, SECURITY REVIEW, NITS
  and MERGE, the rule that Jev answers while code applies the thresholds, and the idea
  of a `/jev-review` skill. The reviewer's question ids and structure come from it; the
  wordings were then rewritten and measured on the bench. The Italian question set this
  project started from, generated with that prompt, is kept as test data in
  `tests/data/checks-original.json`: its question ids, types and lanes come from the
  prompt, and some of its texts are the prompt's own. Its license notice is in
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- **jev-model-router** (MIT, in
  [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates)) is
  prior art for the effort router's hook pattern.
- **[Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code)** provides
  the plugin, hook and function-hook system this runs on.
- **guardrail**, a sibling plugin by the same author, provides the mask map format that
  jev-hooks honours towards remote backends.

jev-hooks is an independent project. It is **not affiliated with, endorsed by or
sponsored by TypeSafe**, Rizzo AI Academy or Anthropic. "Jev" is used only to describe
compatibility with TypeSafe's interface.

## License

[MIT](LICENSE). Material derived from other projects keeps its own license:
see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
