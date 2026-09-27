# Changelog

All notable changes to jev-hooks. Versions follow [Semantic Versioning](https://semver.org/);
a release is a separate `chore(release): X.Y.Z` commit.

## 0.1.0-dev — first public preview

Not released yet: `plugin.json` and `marketplace.json` say `0.1.0`, and the tag comes
with the release commit.

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
