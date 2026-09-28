# Changelog

All notable changes to jev-hooks. Versions follow [Semantic Versioning](https://semver.org/);
a release is a separate `chore(release): X.Y.Z` commit.

## Unreleased

### Added

- `/jev-review` and `/jev-status`: a review on demand and a check of the backend, as
  skills. A command hook runs them outside Claude's sandbox, both when you type the
  command (`UserPromptExpansion`) and when Claude invokes the skill (`PreToolUse` on
  Skill), and hands the result to the skill as a data block. The arguments (`--staged`,
  `--working`, a git reference, a `.diff` or `.patch` file inside the repo) are
  validated and never echoed back; neither skill ever blocks.
- A guard on `.jev-hooks/`: an Edit or Write by Claude inside the project's reviewer
  rules asks you first, in any letter case and at any depth.

## 0.2.2 — 2026-09-28

One more false alarm of the commit reviewer, found while committing its own fix.

### Fixed

- `secret_assignment` also skips a member access quoted as code in a commit message or
  in Markdown: ``` `cache_read_input_tokens: u.cache_read_input_tokens` ``` fired
  because of the closing backtick. A dotted value with digits between backticks is
  still a hit.

## 0.2.1 — 2026-09-28

The commit reviewer after its first day of live use on this repo: fewer questions sent
to Claude for nothing, and clearer instructions when it stops a commit.

### Changed

- The escalation threshold of `weakens_tests` goes from 0.20 to 0.50. In live use the
  question fired on every commit that added or tightened tests, at 0.25 to 0.86. On
  the bench it still catches every positive, and its false alarms on the holdout set
  drop from 9 to 4 of 109; diffs without a problem that send a question to Claude go
  from 12 to 11 of 34.

### Fixed

- A deny of the commit hook on `git add … && git commit` says that nothing in the
  command ran, `git add` included, and asks to repeat the whole command. Claude Code
  blocks the whole Bash command: `git commit` repeated alone committed the old index,
  or nothing.
- `secret_assignment` no longer fires on a member access or a call:
  `cache_read_input_tokens: u.cache_read_input_tokens` and
  `const accessToken = issueAccessTokenFor(user)` are code, not a literal. A quoted
  value and a dotted value with digits (a JWT) are still hits, and still redacted.
- `weakens_tests` no longer sends a commit of documentation files only to Claude: its
  rule has the `unless docs_only ≥ 0.50` that `adds_tests` already had. Two such
  commits scored 0.25 and 0.28 in live use; the bench numbers are the same with and
  without it.
- The coverage item for files beyond the review limits says how many of them it lists,
  and suggests smaller commits, which the reviewer covers in full.

## 0.2.0 — 2026-09-28

The per-turn effort router, planned since the preview, is built. It is off unless you
turn it on: a change of effort keeps the prompt cache only on Opus 5.5 or Fable 5.1
with the per-turn-control beta on the account, and the plugin cannot see the beta. It
has run in Claude Code's own test kit, on a fake engine and in one live headless session,
where the effort it set reached the API request and the prompt cache survived the change
(README → Limitations).

### Added

- The effort router (`hooks/register.ts`, a function hook, early access), with its
  decisions as pure functions in `src/core/router.ts`. Before each prompt you type, it
  asks the `/v1/systemone` backend the seven questions of `config/router.json` and
  lowers that turn's effort from the session's, never above it: only for prompts
  typed in the composer and only on the models of `only_models`; it never touches
  subagents or the model. The classification applies only to the turn whose text is
  the prompt's, so a prompt blocked beneath or folded into a running turn changes
  nothing. The prompt waits for the answer, `timeout_ms` (1.5 s) at most unless
  another hook refuses Claude Code's timer (then up to Claude Code's 30 s for the
  fetch). A failure leaves the turn as it is with one transcript line, and the
  same line again goes to the debug log; a prompt the router does not send by design
  (its origin, a `/` or `!`, a busy backend, a model outside `only_models`) is noted
  in the debug log only. A failed request's line gives a fixed reason or an error
  code, never the error's text, which after a redirect quotes an address the backend
  chose. See README → Effort router.
- Towards a non-local backend the prompt is redacted and masked on its whole text,
  then clipped. A guardrail mask map that cannot be read or parsed, or cannot be
  looked for (neither `HOME` nor `GUARDRAIL_MASK_MAP` set), stops every request with
  one transcript line. Claude Code follows redirects for the router, and a 307 or 308
  sends the prompt again wherever it points: the backend, or its proxy, must answer
  `POST /v1/systemone` itself.
- Options `effort_router` (default `false`), `router_url` (empty: `review_url`, so the
  router shares the reviewer's instance) and `router_api_key` (sensitive; empty:
  `api_key` or the key file, only when `router_url` is empty or has `review_url`'s
  scheme and host, whatever the port, so a key given for TypeSafe never goes to a LAN
  router over plain http). The router reads no key from the environment, and has no
  `TYPESAFE_*` fallback.
- A cache guard (`cache_guard` in `router.json`): after two effort changes in a row
  that the prompt cache did not survive, the router turns itself off for the session
  and says why, since without the beta each change empties the cache. A turn is judged
  only when it started soon enough after the previous request's turn for the cache to
  be alive, measured between turn starts: a queued prompt can wait long for its turn.
- Router configuration layers: `~/.config/jev-hooks/router.json` replaces the plugin's
  whole, and the user's `calibration.json` applies to it; its `"enabled": false` keeps
  the router off even when another field is invalid, as long as the file is still JSON
  (one that does not parse says nothing, and the plugin's applies). A user
  `router.json` that is there but cannot be read keeps the router off, with one note,
  until it can be read, since it may hold that switch. A project
  `.jev-hooks/router.json` can only turn the router off or lower its cap; it is read at
  the checkout's top level, where the reviewer reads `.jev-hooks/`, found from the
  session's directory even when another plugin refuses `$.session.repo`, and in a
  linked worktree the main working tree's is read too. Kill switches `JEV_HOOKS_ROUTER=0` (the
  router alone) and `JEV_HOOKS_DISABLE=1` (the whole plugin), read at every prompt.
- Tests for the router: its decisions under Node and in the strict `node:vm` context,
  `hooks/register.ts` driven through whole sessions on a fake engine, and `tests-cc/`
  in Claude Code's own test kit, run by `node scripts/test-cc.ts` (a local check: it
  needs the `claude` CLI).
- `scripts/validate-manifest.ts` checks the `modules` entry of `hooks/hooks.json`: a
  `.ts` file that exists, named relative to `hooks/` and inside the plugin's folder.

### Changed

- `router.json`: `only_origins` is `["composer"]`, and every entry must be one of the
  16 prompt origins of Claude Code 2.1.283. The earlier `"human"` is now a validation
  error: no prompt carries it, so it would have skipped every prompt. `cache_guard` is
  a new required field. A user `router.json` written for 0.1.1 is therefore invalid:
  the router says so once and uses the plugin's file until you copy the new one, or
  stays off if your file says `"enabled": false`. No hook read that file before, so
  nothing that worked stops working.
- CI: `actions/checkout` v7.0.1 and `actions/setup-node` v7.0.0, pinned by SHA. Both
  run on Node 24; the v4 pins ran on the deprecated Node 20 runtime. The Node versions
  the tests run on are unchanged (22.18.0 and 24).

### Fixed

- `scripts/generate-demo.ts` reads its arguments strictly. `--help` and `-h` print the
  usage and write nothing (they used to create a directory named `--help` and write
  the demo into it); `--seed=N` works like `--seed N` (it used to become a directory
  name, with a random seed); the seed must be a decimal integer (`0x10`, `1e3` and an
  empty value were accepted); an unknown option or a second directory exits 2 with one
  line.

## 0.1.1 — 2026-09-27

A version bump so that `/plugin update` picks up the Node fix below: Claude Code
compares version numbers, not commits, so an installed 0.1.0 stayed on the first
snapshot.

### Fixed

- The hooks find Node installed with nvm, fnm, volta, asdf, mise, n or Homebrew.
  Claude Code runs hook commands without the interactive shell's PATH, so with Node
  only under a version manager the review was skipped with a notice the model never
  sees. Details under 0.1.0-dev → Fixed.

## 0.1.0-dev — first public preview

The first public snapshot, published as 0.1.0 in `plugin.json` and
`marketplace.json`.

### Added

- Commit reviewer: a `PreToolUse` hook on Claude's `git commit` that splits the diff
  into chunks, asks the questions of `config/checks.json` to a `/v1/systemone` backend
  (TypeSafe's Jev or a self-hosted rizzo-flow) and computes BLOCK, SECURITY REVIEW,
  NITS or MERGE from `config/policy.json`. A `PostToolUse` hook records whether the
  reviewed commit happened.
- Policy v2: the model never blocks on its own. BLOCK and SECURITY REVIEW come only
  from deterministic detector floors; critical questions above their threshold escalate
  to Claude once, with the files and lines to reread.
- Three configuration layers (plugin, user, project), with the project layer limited to
  tightening, calibration read only from trusted layers, and the committed rules used
  when `.jev-hooks/` differs from `HEAD`.
- Redaction of secrets and sensitive files towards non-local backends, and support for
  guardrail's mask map.
- Hardened git calls for a hook that runs outside Claude's sandbox.
- `jev-review` CLI with `review`, `explain` and `status`.
- Question bench: 118 dev diffs and 121 holdout diffs, labelled by hand, with
  `scripts/measure-questions.ts` to measure question wordings and
  `scripts/simulate-policy.ts` to replay a policy on recorded answers.
- Thresholds for the Spark-X2.5-4B BF16 profile chosen on the dev set and checked on the
  holdout set; every number is in the rule's `_why`.
- The whole repository in English: code, messages, configuration notes and
  documentation, and commit messages from here on. Question texts, bench data and
  recorded results are unchanged.
- A deliberate, unmeasured change to what the model reads: four strings that can
  appear inside the state sent to the backend are English now too. They are the text
  that replaces a closing evidence tag found in a diff, the marker of a truncated long
  line (two characters longer, so two fewer characters of the line are kept), the line
  that stands for a sensitive file towards a remote backend, and the one-line state of
  the status probe. None of them occurs in a bench state, so no recorded number
  changes, but on a diff that triggers them the model reads different text than
  before, and that has not been measured.
- The published measurements still describe this code. Two independent offline checks
  compared the requests the pre-translation and the translated code send for both
  measurements: one recorded the raw HTTP bodies from a mock backend, the other rebuilt
  every request through the scripts' own functions. The bodies are byte-identical,
  236 of 236 on the dev set and 242 of 242 on the holdout set, with the same state,
  question texts, option order and key order. A control diff that does trigger the
  translated markers produced different bytes, so the check can detect a change.

### Fixed

- The hook launcher `hooks/run-node.sh` finds Node by itself. Claude Code starts hooks
  without the PATH of the interactive shell, so a Node installed with nvm was not found
  and the review was skipped on every commit. After `JEV_HOOKS_NODE` and the PATH, the
  launcher now looks in the installs of nvm, fnm, volta, asdf, mise and n (the highest
  version first), then in Homebrew and system paths, and keeps a candidate only if it is
  Node ≥ 22.18 with type stripping. The search stops at the first that works, and the
  `post-commit` hook still exits before any search when nothing is pending. When no
  Node is found the notice now says where it looked and that `JEV_HOOKS_NODE` can point
  to one.

### Upgrading from an earlier local build

Nothing was released before this preview, but a build installed from a local clone
before the translation keeps its key under a name that no longer exists:

<!-- check-english: off -->
- The key file `~/.config/jev-hooks/chiave` is now `~/.config/jev-hooks/key`, and the
  old name is neither read nor reported. Rename it with
  `mv ~/.config/jev-hooks/chiave ~/.config/jev-hooks/key`, and move any sandbox
  `deny` rule for the old path to the new one. Until then no key is sent: TypeSafe
  stops the review with a configuration error, and rizzo behind `RIZZO_API_KEY`
  answers 401, so the commit goes through with a one-line notice and only the
  detector floors apply.
<!-- check-english: on -->
- Files the hook keeps in its data directory were renamed too; the old ones are
  ignored and can be deleted.

### Planned

- `/jev-review` and `/jev-status` skills, served by a hook outside the sandbox.
- A guard hook on edits to `.jev-hooks/`.
- The per-turn effort router (function hook, off by default).
- A two-phase GitHub Action for pull requests.
- A calibration fit per backend, once the bench has enough labelled errors.
