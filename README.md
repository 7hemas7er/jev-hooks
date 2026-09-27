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

> **Status: 0.1.0-dev, first public preview.** The commit reviewer and the
> `jev-review` CLI work and are covered by about 650 offline tests. The effort router,
> the GitHub Action and the `/jev-review` and `/jev-status` skills are designed but not
> built yet. The thresholds come from a small synthetic bench (below): treat verdicts
> as a second opinion, not as a gate.

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
| `/jev-review` and `/jev-status` skills | planned | Review on demand, served by a hook so it runs outside the sandbox |
| Guard on `.jev-hooks/` edits | planned | Asks before Claude edits the project's reviewer rules |
| Effort router (function hook) | planned, off by default | Lowers the per-turn effort from observable features of your prompt (`config/router.json`) |
| GitHub Action | planned | Two-phase review of pull requests, safe for forks |

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
script or an alias. The planned GitHub Action is where a required check belongs.

## Backends

Both backends speak the same contract, `POST /v1/systemone` with `{state, model,
questions}`, and jev-hooks treats them the same way. They differ in where your diff
goes.

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
  running. jev-hooks never retries a timeout, and the planned router gets its own
  instance (for example review on port 8017, router on 8019).
- **`--ctx` is per question** (state plus question). Chunks of about 2000 tokens stay
  far below the default 8192; an overflow comes back as a 422 that jev-hooks recognizes
  and answers by re-splitting.
- **rizzo's own auth is thin.** `RIZZO_API_KEY` protects only `/v1/systemone` and
  `/v1/models`; `/v1/decisions`, `/health`, `/docs` and `/playground` stay open, and
  there is no TLS. Bind it to `127.0.0.1` and put a reverse proxy in front that lets
  through only `POST /v1/systemone` and `GET /v1/models`, reachable over your LAN or
  Tailscale.
- jev-hooks accepts `http://` **only towards local hosts** (loopback, private ranges,
  `100.64.0.0/10` for Tailscale, `*.ts.net`, `*.local`). Anything else must be
  `https://`, checked before a byte is sent.

```bash
rizzo serve --host 127.0.0.1 --port 8017 --quant bf16 --device cuda
```

Then set `review_url` to your proxy, for example `http://192.168.1.50:8017` on the LAN
or `http://100.64.0.10:8017` over Tailscale. A step-by-step Spark guide (systemd units
and a proxy configuration) is planned as `docs/spark.md`.

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

Requirements: **Node ≥ 22.18** on the PATH the hooks see (it runs TypeScript by
stripping types, with no build step and no dependencies). If your Node comes from nvm
and the hooks cannot find it, set `JEV_HOOKS_NODE` to its full path. Without a suitable
Node the hook skips the review with a notice instead of failing your commit.

Then open `/plugin`, pick jev-hooks and fill in its options:

| Option | Default | Meaning |
|---|---|---|
| `review_url` | empty (reviewer off) | Base URL of the `/v1/systemone` backend |
| `api_key` | empty | Bearer key: required for TypeSafe, optional for rizzo with `RIZZO_API_KEY` |
| `model` | `jev-latest` | Requested model; `jev-latest` also works with rizzo-flow |
| `commit_review` | `true` | Review when Claude runs `git commit` |

The planned effort router will add its own options when it ships.

**Where the key lives, and why.** `api_key` is a `sensitive` option: Claude Code keeps
it out of `settings.json`, and plugin options are set in the hooks' environment, not in
the environment of the commands Claude runs. That matters, because anything in the
`env` block of your settings reaches every Bash command, and a prompt injection in a
file Claude reads could send it anywhere. Fallbacks, in order of preference:

- `~/.config/jev-hooks/key`, one line, `chmod 600` (jev-hooks warns when other users
  can read it). Hide it from Claude's sandbox:
  `"sandbox": {"credentials": {"files": [{"path": "~/.config/jev-hooks/key", "mode": "deny"}]}}`.
  A build installed from a local clone before this preview used another file name:
  see [Upgrading from an earlier local build](CHANGELOG.md#upgrading-from-an-earlier-local-build);
- `JEV_HOOKS_URL` / `JEV_HOOKS_KEY` / `JEV_HOOKS_MODEL`, or `TYPESAFE_BASE_URL` /
  `TYPESAFE_API_KEY` / `TYPESAFE_DEFAULT_MODEL`. If they sit in your settings, deny
  them to the sandbox with `"sandbox": {"credentials": {"envVars": [{"name":
  "JEV_HOOKS_KEY", "mode": "deny"}, {"name": "TYPESAFE_API_KEY", "mode": "deny"}]}}`.

Each source is a layer of (URL, key, model), and a key is sent **only to the URL of its
own layer**: a `TYPESAFE_API_KEY` exported for the SDKs never travels in clear to the
rizzo box on your LAN. The key goes only in the `Authorization` header, never in URLs,
output, logs or error messages, and redirects are refused so it cannot follow one to
another host.

Check the setup from your own terminal (Claude's sandbox cannot reach your LAN, which is
why the planned skills run inside a hook):

```bash
bin/jev-review.mjs status --url http://192.168.1.50:8017   # from a clone
```

Without `--url` it uses `JEV_HOOKS_URL` or `TYPESAFE_*`; the key comes from the
environment or the key file, never from a flag.

It lists the backend's models, runs one real decision and prints host, model,
fingerprint, latency, the calibration profile it picked and where each config file came
from.

### Updating

The installed plugin is a copy in `~/.claude/plugins/cache/`, taken at install time. A
new commit on GitHub does not arrive on its own:

```
/plugin marketplace update 7hemas7er-jev-hooks
/plugin update jev-hooks@7hemas7er-jev-hooks
```

Then start a new session: the open one keeps the old hooks.

### Turning it off

`commit_review: false` in `/plugin`, or `JEV_HOOKS_DISABLE=1`, or `"hook": {"enabled":
false}` in your user `policy.json`. If you also run Anthropic's security-guidance
plugin, it reviews `git commit` too: keep both, or switch one off.

## Configuration: open a JSON, never touch the code

| File | What it decides |
|---|---|
| `checks.json` | The questions: id, label, type, the exact text sent to the model, which state it sees, whether it is critical |
| `policy.json` | Lanes and their order, rules and thresholds, detectors and floors, escalation behaviour, chunk and time limits |
| `calibration.json` | Per-backend profiles (matched by fingerprint, model or host): temperatures, per-question thresholds, the uncertainty band |
| `router.json` | The planned effort router's questions and effort mapping |

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
  parallelism. Anything else is ignored with a note naming the file and the JSON
  pointer;
- a project `calibration.json` is ignored: a steep calibration could squash every
  probability to zero;
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

## The measured bench

Before choosing a threshold you need to know whether a question separates at all.
`bench/` holds hand-labelled synthetic diffs and the scripts that measure them
(`bench/README.md`, `bench/MEASUREMENT.md`):

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
| weakens_tests | choice, 1 − P(none) | 0.999 | 0.995 | ≥ 0.20 → escalate | 1.00 (9/9) · 0.028 (3/109) | 1.00 (12/12) · 0.083 (9/109) |
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
reached BLOCK or SECURITY REVIEW and 12 (35%) sent at least one question to Claude; on
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
some of that text is hostile.

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

**What never leaves.** The log (`log.jsonl` in the plugin's data directory) records
outcomes, probabilities, hashes and the backend's fingerprint, never the diff, the title,
the description, a prompt or a key. The repo itself contains no realistic secret and no
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
  second client on the same instance, makes you wait.
- **Platforms.** Developed on Linux; CI runs Node 22.18 and 24 on Ubuntu. Windows is
  untested (the hook launcher is a bash script).

## Development

Everything runs on Node ≥ 22.18 with no build step and no dependencies. The rules for
contributors, human or agent, are in [`AGENTS.md`](AGENTS.md).

```bash
node --test "tests/**/*.test.ts"       # offline: a fake /v1/systemone server, temporary dirs only
node scripts/validate-manifest.ts      # manifests, hooks.json, config/*.json
node scripts/generate-defaults.ts --check
node scripts/check-english.ts          # leftover Italian outside the data
```

Always pass the glob: without it, `node --test` runs every `.ts` file as a program,
helpers included.

Try the reviewer on the demo diffs (secrets and injection phrases are composed at run
time, so none of them sits in the repo):

```bash
node scripts/generate-demo.ts /tmp/jev-demo
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
  prior art for the planned effort router's hook pattern.
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
