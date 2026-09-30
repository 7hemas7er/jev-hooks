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
| hardcoded_secret | noul | 0.924 | 0.987 | ≥ 0.10 → escalate | 0.78 (7/9) · 0.028 (3/109) | 0.91 (10/11) · 0.027 (3/110) |
| injection_risk | choice, 1 − P(none) | 1.000 | 0.976 | ≥ 0.99 → escalate | 1.00 (8/8) · 0.036 (4/110) | 0.83 (10/12) · 0.064 (7/109) |
| touches_auth | noul | 0.980 | 0.969 | ≥ 0.70 → escalate | 0.60 (6/10) · 0.028 (3/108) | 0.71 (10/14) · 0.047 (5/107) |
| weakens_tests | choice, 1 − P(none) | 0.999 | 0.995 | ≥ 0.50 → escalate, unless docs only or the second reading < 0.10 | 1.00 (9/9) · 0.028 (3/109) | 1.00 (12/12) · 0.037 (4/109) |
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

**Why `weakens_tests` asks twice.** In live use its wording fired on commits that only
added or tightened tests, bumped CI pins or touched documentation. A second wording,
`weakens_expected`, reads the diff line by line and says "none" unless a line shows the
weakening; the rule escalates only when both see one. On a holdout set written blind
for this check (`bench/results/2026-09-29-holdout-weakens`, 60 diffs, 29 of them hard
negatives of those shapes) the pair keeps 15 of 16 positives, as the first wording
alone, with 4 false alarms in 44 instead of 10. It costs one more question per chunk.
A `checks.json` of yours that predates `weakens_expected` keeps working: that
condition is dropped with a note, and the rule fires as it did before.

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
  0.32. Choosing thresholds on the calibrated scale is a decision of its own, for
  later.
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
| `hardcoded_secret` | 0.10 | 3 of 44 | none in the set |
| `touches_auth` | 0.70 | 3 of 43 | 0 of 1 |
| `adds_tests` (missing tests) | 0.70 | 3 of 43 | 1 of 1 |
| `injection_risk` | 0.99 | 0 of 42 | 0 of 2 |

Those reviews ran before `weakens_expected` existed, so the `weakens_tests` row is the
rule without its second reading. The two `injection_risk` positives are literal ones
(environment variables in a fetched URL and in an executed path), the `touches_auth`
one an example Caddy configuration.

## Planned

- A second labeller on the holdout sets, to know how far the labels themselves agree.
- Measuring TypeSafe's Jev on the public and synthetic rows, to check its claim of
  calibrated probabilities on diffs.
