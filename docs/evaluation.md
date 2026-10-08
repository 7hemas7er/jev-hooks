# Evaluation protocol

How the questions, the thresholds and the calibration of jev-hooks are measured, what
has been measured so far and what is still missing. The mechanics of each tool are in
[`bench/README.md`](../bench/README.md) (datasets, labels, the router bench) and
[`bench/MEASUREMENT.md`](../bench/MEASUREMENT.md) (running a measurement, the metrics,
the policy simulator); this page is the method they follow.

## What a number is tied to

A probability means something only for one question text, one model and one way of
building the state:

- **The question.** The text sent to the model (`instructions`, `criteria`, the order of
  a choice's options) is hashed with sha256. `config/calibration.json` and every bench
  report record the hashes they were measured with; changing one byte invalidates the
  measurement and the calibration of that question.
- **The model.** A calibration profile matches the backend's fingerprint (rizzo's
  `x_rizzo.fingerprint`), otherwise its model or host. A different quantization, a new
  llama.cpp release or a different KV cache changes the fingerprint.
- **The state.** Chunk size, line caps and the global state's fields shape what the
  model reads. Measurements use the plugin's own configuration and the production
  functions that build the state, never a copy.

## Datasets and splits

| File | Rows | Labels | Use |
|---|---|---|---|
| `bench/dev.jsonl` | 118 | every reviewer question | choose texts and thresholds |
| `bench/holdout.jsonl` | 121 | every reviewer question | confirm, once |
| `bench/live.jsonl` | 27 | `weakens_tests` only | commits of this repo, plus mutations |
| `bench/router-dev.jsonl` | 120 | the router's 7 questions, ideal effort | choose the router's rules |
| `bench/router-holdout.jsonl` | 120 | the same | confirm, once |

The rows are synthetic or come from this repository, written by hand and labelled
against the operational definitions in `bench/README.md`. The router's holdout was
written by an agent that saw only the questions' criteria and the effort definitions.

Rules:

1. **Choose on dev, confirm on holdout.** A threshold chosen on the same rows it is
   judged on is optimistic.
2. **A holdout is measured once.** Its result is recorded in `bench/results/` with the
   date, and its failing rows are not opened: once a row has been looked at by id, the
   set is no longer blind, and the next round needs a new one.
3. **Split by group.** Variants of a diff (option order, language, injection, length)
   stay in the group of their base diff, never across splits.
4. **Jev's answers never become labels.** TypeSafe's terms rule out distillation;
   comparisons with Jev use public or synthetic diffs and publish only aggregate
   numbers.

## Metrics

Per question: AUROC (what calibration cannot add), mean p on positives and negatives,
Brier, balanced accuracy at the chosen threshold and at 0.5, and for the escalation
thresholds TPR and FPR on the holdout. Per diff, through `scripts/simulate-policy.ts`
on recorded answers: the count of diffs per lane and per escalation, split into clean
diffs and diffs with a problem, and the **silent misses**: a diff that should reach
BLOCK or SECURITY REVIEW ending lower without an escalation. For the router: under,
exact and over against the ideal effort, and the steps of effort saved, per session
effort.

With about a hundred rows, an AUROC moves in visible jumps: differences of a few
hundredths between two texts are noise.

## The measured bench

Before choosing a threshold you need to know whether a question separates at all.
`bench/` holds hand-labelled synthetic diffs and the scripts that measure them
(`bench/README.md`, `bench/MEASUREMENT.md`; the method, and the calibration still to
do, in [docs/evaluation.md](#evaluation-protocol)):

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
| hardcoded_secret | noul | 0.924 | 0.987 | ≥ 0.30 → escalate | 0.78 (7/9) · 0.009 (1/109) | 0.73 (8/11) · 0.009 (1/110) |
| injection_risk | choice, 1 − P(none) | 1.000 | 0.976 | ≥ 0.99 → escalate, unless docs only | 1.00 (8/8) · 0.036 (4/110) | 0.83 (10/12) · 0.064 (7/109) |
| touches_auth | noul | 0.980 | 0.969 | ≥ 0.70 → escalate, unless docs only | 0.60 (6/10) · 0.028 (3/108) | 0.71 (10/14) · 0.047 (5/107) |
| weakens_tests | choice, 1 − P(none) | 0.999 | 0.995 | ≥ 0.50 → escalate, unless docs only or the second reading < 0.30 | 1.00 (9/9) · 0.018 (2/109) | 0.92 (11/12) · 0.009 (1/109) |
| breaks_api | choice, 1 − P(none) | 0.930 | 0.901 | ≥ 0.90 unless docs only, note | 0.67 (8/12) · 0.019 (2/106) | 0.81 (13/16) · 0.048 (5/105) |
| data_migration | choice, 1 − P(none) | 1.000 | 0.992 | ≥ 0.76, note | 1.00 (7/7) · 0 (0/111) | 1.00 (10/10) · 0.027 (3/111) |
| debug_leftovers | noul | 0.994 | 0.966 | ≥ 0.40 unless docs only, note | 0.88 (7/8) · 0.027 (3/110) | 0.91 (10/11) · 0.036 (4/110) |
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

**Why `weakens_tests` asks twice.** In live use its wording fired on commits that only
added or tightened tests, bumped CI pins or touched documentation. A second wording,
`weakens_expected`, reads the diff line by line and says "none" unless a line shows the
weakening; the rule escalates only when both see one. On a holdout set written blind
for this check (`bench/results/2026-09-29-holdout-weakens`, 60 diffs, 29 of them hard
negatives of those shapes) the pair keeps 15 of 16 positives, as the first wording
alone, with 4 false alarms in 44 instead of 10. It costs one more question per chunk.
A `checks.json` of yours that predates `weakens_expected` keeps working: that
condition is dropped with a note, and the rule fires as it did before.

**Why `weakens_tests` looks only at chunks with tests.** A chunk question's value is its
highest p across the chunks, and a chunk state lists only that chunk's files. In live use
the rule escalated on 29 of 220 diffs split into several chunks and on 1 of 67
single-chunk diffs: a chunk of application code alone scored up to 0.3 on the second
reading, enough to pass its threshold of then, 0.10, while every bench diff fit in one
chunk, so the bench never showed it. Both readings now count only the chunks that hold a test, CI or
test-tool file, by the paths of `touches_tests` (`chunks_matching` in `checks.json`); a
diff with such a file in no chunk, past the chunk limit or as the old name of a rename,
counts every chunk as before. On 126 real multi-chunk commits that touch tests,
labelled by two agents each with no weakening (252 of 252 labels agreeing), false
escalations go from 28 to 17. On the dev and `live.jsonl` diffs split into chunks by an
added file of application code (19 positives, 126 negatives) they go from 63 to 4, with
every positive kept; single-chunk diffs do not change. Rewording the second reading
instead did not help: two variants that left the changed-expected-value case to the
other chunks gave 29 and 34 false escalations on the same commits.

**Why the second reading's threshold is 0.30.** With the option each chunk picks
recorded, 12 of the 14 real false escalations left had the second reading pick "none",
at 0.12 to 0.30 on `1 − p(none)`, enough to pass the old 0.10. At 0.30 false
escalations go from 16 to 4 of 126 on the real commits, from 4 to 1 on the split bench
diffs, from 3 to 2 of 109 on dev and from 3 to 0 of 17 on `live.jsonl`, with every
positive of those sets kept; the blind holdout stays at 15 of 16 positives and 4 false
alarms in 44. The cost is on the old holdout, where the second reading was measured
under the `weakens_tests` name (`bench/results/2026-09-28-holdout-i_expected`): a
positive that marks a test as an expected failure scores 0.179, so the rule keeps 11 of
12 positives instead of 12, with 1 false alarm in 109 instead of 4. At 0.50 a second
positive, loosened assertions at 0.420, would go too.

**Why `hardcoded_secret` has no second reading.** It shows the same pattern as
`weakens_tests` did: in live use 52 of its 54 escalations came from diffs split into
several chunks, and none of 93 single-chunk diffs reached its 0.15. About one chunk in
thirty of real code, configuration or notes scores 0.15 with no credential in it (23 of
675 chunks of 126 real commits), and those chunks hold any kind of file, so no path
separates them from a real secret, which can sit in any file. A higher threshold would
cost the holdout's positives at 0.199 and 0.245. Two second readings that ask for the
credential's value written out on an added line (`bench/variants-secret-1.json`)
removed all 17 false escalations on those commits but kept only 8 of the holdout's 10
caught positives at best, missing a GitHub token in a CI workflow and a webhook
secret, and missed the one real positive. A missed secret has to be revoked; a false
escalation costs one look by Claude. The question stays as it is.

**Why `hardcoded_secret` escalates at 0.30.** The question's TPR in the table counts
the model alone, but every positive it misses is caught by a deterministic detector:
on the bench as the measurement composes it, the detectors catch 19 of the 20 positives
and hit none of the 219 negatives, since `env_default` (a credential written as the
default of an environment read, which `secret_assignment` leaves out because it ignores
`getenv` and `process.env`) joined them on 2026-10-09. The one positive left to the
model scores 0.88. Below 0.30 the question only added noise where a diff is split into
chunks: on 126 real multi-chunk commits it escalated 19 at 0.15 and 3 at 0.30. The cost
is one borderline real case, a development client secret written as such a default in
a live test file (every secret detector skips test paths, as it does fixtures), which
scored 0.228.

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

## What has been measured

- **The reviewer's questions**, on dev and holdout (`bench/results/2026-09-26-*`): the
  wordings in `config/checks.json` were chosen there, and the escalation thresholds in
  `config/policy.json` carry in their `_why` the numbers they were chosen on.
- **`weakens_tests`** in two further rounds on dev and `live.jsonl`
  (`2026-09-28-weakens*`): a stricter wording won on dev and live but lost two
  positives on the holdout, so the current wording stays, with its threshold at 0.50.
  A third round (2026-09-29) combined the two: escalate only when both wordings see a
  weakening. Chosen on the measurements already taken, it was then checked once on a
  fresh holdout written blind (`2026-09-29-holdout-weakens`): 15 of 16 positives, as
  before, and 4 false alarms in 44 instead of 10. The second wording is
  `weakens_expected` in `checks.json`, asked as an `unless` condition of the rule.
  A fourth round (2026-10-07, `2026-10-07-weakens3-*` and `variants-weakens-3.json`)
  measured diffs split into several chunks, which the bench had none of: the fix was not
  a wording but which chunks count (above).
- **The effort router** on its dev and holdout sets (`2026-09-28-router-*`): the
  questions' accuracy and AUROC, the effort each configuration would pick, and a
  frontier between under-routed turns and effort saved. `config/router.json` sits one
  step from the cautious end: bug reports, refactors and design requests lower the
  effort one step instead of none (on the holdout, 11 of 220 turns below the label
  instead of 9, 151 of 257 steps saved instead of 142).

All on rizzo-flow serving Spark-X2.5-4B BF16 on a DGX Spark, profile
`spark-bf16-2026-09`, on the raw p (the calibration below came later), except one
comparison:

- **CLM-8B** on the reviewer's dev set and the router's dev set
  (`2026-09-29-clm-*`), with the same 44 wordings and 7 router questions: it separates
  far worse than rizzo, and two review questions point the wrong way. No text or
  threshold was chosen on it, and the holdout sets were not used.

## Calibration

The Spark's profile (`spark-bf16-2026-09`) is calibrated since 2026-09-30:
`scripts/fit-calibration.ts` fitted a Platt scaling per question,
p′ = σ(a · logit(p) + b), on the dev measurement (`2026-09-26-dev-checks`, 118 diffs)
and adopted it where it lowers the log-loss of the holdout measurement
(`2026-09-26-holdout`, 121 diffs the fit never saw). Report and entries:
`bench/results/2026-09-30-calibration`.

| Question | a | b | Log-loss on the holdout, raw → calibrated | |
|---|--:|--:|---|---|
| `injection_risk` | 0.52 | −3.67 | 0.657 → 0.124 | adopted |
| `breaks_api` | 0.60 | −1.99 | 0.410 → 0.221 | adopted |
| `adds_tests` (missing tests) | 0.51 | 1.09 | 0.429 → 0.328 | adopted |
| `touches_auth` | 0.35 | −1.05 | 0.237 → 0.160 | adopted |
| `data_migration` | 0.52 | −1.98 | 0.152 → 0.066 | adopted |
| `weakens_tests` | 0.52 | −2.57 | 0.144 → 0.096 | adopted |
| `debug_leftovers` | 0.65 | −1.55 | 0.132 → 0.104 | adopted |
| `hardcoded_secret` | | | 0.115 → 0.131 | kept raw: worse on the holdout |
| `description_matches` | | | | kept raw: a ≤ 0, it does not order its labels |

`weakens_expected` keeps its raw p too: the dev measurement has no answers of its own for
it. Every slope is below 1: rizzo is overconfident, and the fit pulls its 0.99s down.

- **The verdicts do not change.** The thresholds in `policy.json` stay those chosen on
  the raw p, and on a calibrated question every decision is still taken on the raw
  value: the rules, the `unless` conditions, the band and the disagreement with a
  detector (`decidesOnRaw` in `src/core/calibration.ts`). This holds for the plugin's
  rules, a user's and a project's: a band of δ in raw logit would be δ·a on the
  calibrated scale, and the 0.5 of the disagreement test would move, so comparing the
  calibrated values would not do. A test replays both sets diff by diff, with the
  plugin's policy and with one that has bands and disagreement on the fitted questions
  (`tests/bench/simulate.test.ts`): same lane, rules and escalation items. What changes
  is what is shown: the calibrated value, next to the threshold and band moved through
  the same fit. `injection_risk`'s 0.99 is shown as 0.22, `touches_auth`'s 0.70 as
  0.32. Choosing thresholds on the calibrated scale is a decision of its own, taken
  rule by rule (2026-10-01): a uniform calibrated 0.5 would lose positives on
  `injection_risk` (holdout 10/12 → 7/12), `weakens_tests` (12/12 → 9/12) and
  `debug_leftovers` (10/11 → 7/11). Only `data_migration` moved, from 0.20 raw to 0.76
  raw, which is 0.20 calibrated: every positive kept on both sets, dev FPR 0.027 → 0,
  holdout 0.072 → 0.027. The policy still holds raw values, and decides on them.
- **A bench-like mix.** 14% of the dev answers are positives; real commits have far
  fewer problems, so on them a calibrated p reads high.
- **Only this backend.** The other profiles keep the raw p. A new quantization or
  llama.cpp build changes the fingerprint and falls back to `rizzo-provisional`.
- **Redo** after any change of question text, quantization, llama.cpp release or state
  shape: measure dev and holdout again, then
  `node scripts/fit-calibration.ts --fit <dev dir> --check <holdout dir> --out <dir>`
  and copy the entries of its `profile.json` into the profile.

The hook's log (`log.jsonl` in the plugin's data directory) records raw and calibrated
values, the questions' hashes, the backend's fingerprint and the plugin version, never a
diff, a title, a description or a key: labelled, it is the other source a fit can use.
A first attempt (2026-09-29) joined it with this repo's history: 44 commits the reviewer
saw in full, labelled for the nine questions in `bench/live-reviews.jsonl`. It holds at
most two positives per question, too few for a fit. What it does show is how often the current thresholds raise a false alarm on real
commits of this repo, with the model's raw answers from the log (question texts
unchanged since):

| Question | Threshold | False alarms | Positives caught |
|---|---:|---:|---:|
| `weakens_tests` | 0.50 | 11 of 44 | none in the set |
| `hardcoded_secret` | 0.15 | 2 of 44 | none in the set |
| `touches_auth` | 0.70 | 3 of 43 | 0 of 1 |
| `adds_tests` (missing tests) | 0.70 | 3 of 43 | 1 of 1 |
| `injection_risk` | 0.99 | 0 of 42 | 0 of 2 |

Those reviews ran before `weakens_expected` existed, so the `weakens_tests` row is the
rule without its second reading. The two `injection_risk` positives are literal ones
(environment variables in a fetched URL and in an executed path), the `touches_auth`
one an example Caddy configuration.

A second set (2026-10-01, extended 2026-10-04): 88 commits of three other repositories
of the maintainer, two in PHP and one in TypeScript, reviewed by 0.6.0 to 0.16.0 with
the same question texts. They were joined with the log in the same way and labelled by
two agents with the definitions above, who agreed on 788 of the 792 labels; a third
agent decided the four they did not (two `breaks_api`, two `adds_tests`). One label
moved when the definition of application code was settled for stylesheets. The labelled
rows stay out of this repository: those repositories are private. With the rules of this
version:

| Question | Threshold | False alarms | Positives caught |
|---|---:|---:|---:|
| `hardcoded_secret` | 0.15 | 7 of 88 | none in the set |
| `weakens_tests` | 0.50, second reading, tests touched | 3 of 88 | none in the set |
| `touches_auth` | 0.70 | 3 of 84 | 3 of 4 |
| `injection_risk` | 0.99 | 1 of 86 | 0 of 2 |
| `adds_tests` (missing tests) | 0.70 | 8 of 46 | 25 of 42 |
| `breaks_api` | 0.90, unless docs only | 2 of 85 | 1 of 3 |
| `data_migration` | 0.76, unless docs only | 0 of 86 | 1 of 2 |
| `debug_leftovers` | 0.40 | 3 of 88 | none in the set |

`touches_auth` met real authentication work here, an OpenID Connect login with Keycloak:
the production realm (login policy, redirect addresses, the role claim the application
reads) at 0.74 and a route table with a minimum access level per route at 0.96, both
caught. Its three false alarms, at 0.87 to 0.98, are file permissions on disk, a
development Keycloak and a container's configuration: above the threshold and among the
positives, so no threshold removes them. The one it missed, at 0.14, is a development
script that clones the production database and blanks every user's password and
session: it changes who can log in to the copy, which the definition counts. The
`hardcoded_secret` escalations are six of one PHP repository, at 0.16 to 0.54, one of
them on planning notes in Markdown, one on three deleted logo components and one on a
script that prints a weak development password, and the development Keycloak at 0.22,
whose login probe falls back to a literal client secret and whose realm holds trivial
passwords: both labellers took them for test values of a throwaway container, a close
call the definition's "real fallback" leaves open. Across the 132 commits of the two
sets, 9 escalations on that question and no secret; at 0.10 there would be 15. The move
to 0.15 removed the escalations between 0.107 and 0.14, with
the bench's positives unchanged. That move looked at both bench sets, so the holdout no
longer measures that threshold blind. Going higher would cost the holdout's positives at
0.199 and 0.245. The `weakens_tests` escalations are an expected value changed together
with the code that computes it (second reading at 0.15, just above its 0.10 of then,
which stayed because one of the holdout's positives has it at 0.179; it is 0.30 since
2026-10-07), a CI workflow that runs the tests on more branches, and an assertion replaced together with the script it checks
(second reading 0.26). A fourth, three components deleted with no test in the diff
(0.55, second reading 0.57), is why the rule now needs a test, CI or test-tool file in
the diff (`touches_tests`): every weakening the definitions list needs one, the bench
keeps all 47 of its positives, and its numbers do not change. The `injection_risk` escalation, at 0.997, is a front-end script
that fills `innerHTML` with numbers and escaped text; 0.998 would remove it and keep
every dev positive, but lose the holdout's positive at 0.994, so 0.99 stays.
`breaks_api` noted two documentation-only commits at 0.94 and 0.999, which is why it now
skips them; the two left are a page's script and a dashboard whose label and total
changed (0.90). The `adds_tests` note misses 17 of its 42
positives, mostly early commits that add whole pages of a new application without a
test. Both `injection_risk` positives are literal ones: a file name joined into a path
on an in-memory file system, and a command-line output folder joined into a path by a
script that generates test data. Of the three `breaks_api` positives, three exported
components deleted scored 0.97, while an exported interface changed and a global
function of a browser script removed scored 0.34 and 0.83. Of the two `data_migration`
ones, the database clone script that rewrites and deletes rows in bulk scored 0.96, and
stored data converted with no way back 0.37. There are still too
few positives on the questions that escalate for a fit from real commits.

## Planned

- A second labeller on the holdout sets, to know how far the labels themselves agree.
- Measuring TypeSafe's Jev on the public and synthetic rows, to check its claim of
  calibrated probabilities on diffs.
