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
> hooks, and live runs on Claude Code 2.1.283 and 2.1.284, on Opus 5.5, Fable 5.1 and
> Sonnet 5.5, have shown the effort it sets reaching the API request and the prompt
> cache surviving the change (see [Limitations](docs/limitations.md)).
> The GitHub Action is built: a CI job runs it on GitHub's runner on a diff, tests
> against a fake GitHub API cover its two-phase flow, and that flow has run on real
> pull requests in a test repository, a fork's included, with rizzo reached over the
> tailnet and a required check from a dedicated App (see
> [GitHub Action](docs/action.md#github-action)). About 900 offline tests cover all of it. The reviewer's thresholds come from a small synthetic bench ([measured bench](docs/evaluation.md#the-measured-bench))
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
| Question bench and policy simulator | **works** | `bench/`, `scripts/measure-questions.ts`, `scripts/simulate-policy.ts`; see [The measured bench](docs/evaluation.md#the-measured-bench) |
| `/jev-review` and `/jev-status` skills | **works** | Review on demand and a backend check, served by a hook so they run outside the sandbox; see [On demand](docs/how-it-works.md#on-demand-jev-review-and-jev-status) |
| Guard on `.jev-hooks/` edits (`PreToolUse` hook on Edit and Write) | **works** | Asks before Claude edits the project's reviewer rules with its editing tools |
| Effort router (function hook, `hooks/register.ts`) | built, opt-in, early access; checked live on Opus 5.5, Fable 5.1 and Sonnet 5.5 | Lowers the effort of a turn from observable features of your prompt, never above the session's (`config/router.json`); see [Effort router](docs/router.md#effort-router-opt-in) |
| GitHub Action (`action.yml`) | built; run on real pull requests, a fork's included: rizzo over the tailnet, a required check from a dedicated App that a same-named job cannot imitate | Two-phase review of pull requests, safe for forks, with a `jev-review` check run; see [GitHub Action](docs/action.md#github-action) |

## How it works

When Claude runs `git commit`, a `PreToolUse` hook outside Claude's sandbox takes the
diff the commit would contain, runs regex detectors that set floors the model cannot
lower, splits the diff into chunks and asks the backend seven questions per chunk and
five on the title, description and file list. `config/policy.json` turns the
probabilities into a lane; critical findings go back to Claude as files and line
ranges to reread, never as diff lines. If the backend is down the commit proceeds
with a notice, and the floors still apply.

The hook is a safety net, not a barrier: it sees only the commits Claude makes with its
Bash tool, so a required check belongs in the [GitHub Action](docs/action.md).

The diagram, what each step is for, what the hook does per lane, and the on-demand
`/jev-review` and `/jev-status` skills are in [docs/how-it-works.md](docs/how-it-works.md).

## Quick start

```
/plugin marketplace add 7hemas7er/jev-hooks
/plugin install jev-hooks@7hemas7er-jev-hooks
```

Requirements: **Node ≥ 22.18** (no build step, no dependencies). Then open `/plugin`,
pick jev-hooks and set `review_url` to your `/v1/systemone` backend (and `api_key` for
TypeSafe); `api_key` is a sensitive option that Claude Code keeps out of `settings.json`:
do not put the key in the `env` block of your settings, where every Bash command Claude
runs can read it. Check the setup with `/jev-hooks:jev-status` in a new session. Options, where
the key lives, updating and turning it off are in [docs/install.md](docs/install.md);
which backend to run is in [docs/backends.md](docs/backends.md).

## Documentation

| Page | What it covers |
|---|---|
| [How it works](docs/how-it-works.md) | The commit hook step by step, the lanes, the `/jev-review` and `/jev-status` skills |
| [Backends](docs/backends.md) | rizzo-flow (recommended for private code), CLM-8B (measured, not recommended), TypeSafe Jev |
| [Install](docs/install.md) | Installing, the options, where the key lives, updating, turning it off |
| [GitHub Action](docs/action.md) | Two-phase review of pull requests, safe for forks, with a `jev-review` check run |
| [Configuration](docs/configuration.md) | The JSON files, their layers, and what a project can and cannot change |
| [Effort router](docs/router.md) | The opt-in router: what it needs, decides and sends, its switches and its measurements |
| [Evaluation](docs/evaluation.md) | The measured bench, the evaluation protocol and the calibration still to do |
| [Security](docs/security.md) | The security model, the full threat model, reporting a vulnerability |
| [Limitations](docs/limitations.md) | What the model, the bench and the hook cannot do |
| [Development](docs/development.md) | Tests, checks, the demo diffs and the bench commands |
| [rizzo-flow on a DGX Spark](docs/spark.md) | A step-by-step setup of the backend jev-hooks was developed against |

## Development

Everything runs on Node ≥ 22.18 with no build step and no dependencies: the tests, the
checks, the demo and the bench commands are in [docs/development.md](docs/development.md),
and the rules for contributors, human or agent, in [`AGENTS.md`](AGENTS.md).

## Credits and acknowledgements

- **[TypeSafe](https://typesafe.ai/)** designed Jev and the `/v1/systemone` interface
  this project is built around: typed `noul`, `choice` and `score` questions with
  probabilities instead of generated text.
- **[rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)** by Rizzo AI Academy
  (Apache-2.0) is the open-source, Jev-compatible server every number in this README (and in the pages under `docs/`)
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
