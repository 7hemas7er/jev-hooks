# How it works

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
script or an alias. The [GitHub Action](action.md#github-action) is where a required check belongs.

## On demand: `/jev-review` and `/jev-status`

```
/jev-hooks:jev-review                   staged changes, else uncommitted ones, else the branch against main
/jev-hooks:jev-review --staged          or --working, a git reference (origin/main, HEAD~3),
                                        or a .diff or .patch file inside the repo
/jev-hooks:jev-status                   the plugin version, the backend, the model, one real decision, the profile
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

A running Claude Code keeps the plugin version it loaded until `/reload-plugins` or a
restart, also after `/plugin update` and `/clear`: the
review log records it in each line (`plugin_version`), and `/jev-status` and
`jev-review status` show it first.
