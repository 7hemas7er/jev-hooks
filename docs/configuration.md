# Configuration: open a JSON, never touch the code

| File | What it decides |
|---|---|
| `checks.json` | The questions: id, label, type, the exact text sent to the model, which state it sees, whether it is critical |
| `policy.json` | Lanes and their order, rules and thresholds, detectors and floors, escalation behaviour, chunk and time limits |
| `calibration.json` | Per-backend profiles (matched by fingerprint, model or host): a Platt scaling per question, temperatures, the uncertainty band. On a fitted question the decision stays on the raw value against the policy's threshold, and the threshold is shown moved through the fit, so a fit changes no verdict; an explicit threshold in a calibrated profile replaces the policy's value, except where a project's rule is stricter |
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
  rules, raise floors, use a stricter threshold on the same check, drop some of a
  rule's `unless` conditions, lower limits and parallelism, make a CI conclusion more
  severe (a lane's `ci`, `escalation.ci`, the two classes of `ci`). Anything else,
  a new `unless` condition included, is ignored with a note naming the file and the
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
