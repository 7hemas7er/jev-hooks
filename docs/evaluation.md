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

## What has been measured

- **The reviewer's questions**, on dev and holdout (`bench/results/2026-09-26-*`): the
  wordings in `config/checks.json` were chosen there, and the escalation thresholds in
  `config/policy.json` carry in their `_why` the numbers they were chosen on.
- **`weakens_tests`** in two further rounds on dev and `live.jsonl`
  (`2026-09-28-weakens*`): a stricter wording won on dev and live but lost two
  positives on the holdout, so the current wording stays, with its threshold at 0.50.
- **The effort router** on its dev and holdout sets (`2026-09-28-router-*`): the
  questions' accuracy and AUROC, the effort each configuration would pick, and a
  frontier between under-routed turns and effort saved. `config/router.json` sits at
  the cautious end; the step to take along the frontier is the user's choice.

All on rizzo-flow serving Spark-X2.5-4B BF16 on a DGX Spark, profile
`spark-bf16-2026-09`, uncalibrated, except one comparison:

- **CLM-8B** on the reviewer's dev set and the router's dev set
  (`2026-09-29-clm-*`), with the same 44 wordings and 7 router questions: it separates
  far worse than rizzo, and two review questions point the wrong way. No text or
  threshold was chosen on it, and the holdout sets were not used.

## Calibration (not done yet)

Every profile in `config/calibration.json` is uncalibrated today: the probabilities are
used as they come, and the thresholds were chosen on them. The fit needs data the
bench does not have in quantity:

- **Source**: the hook's log (`log.jsonl` in the plugin's data directory). Each review
  records raw and calibrated values, the questions' hashes, the backend's fingerprint,
  and later whether the commit happened after an escalation (`commit_done`). It never
  records a diff, a title, a description or a key.
- **Fit**: Platt scaling per yes/no question and temperature for choices and scores,
  with at least 50 to 100 labelled rows and 10 errors per unit; otherwise one fit per
  question type. The result is a profile with `match.fingerprint` and the questions'
  hashes.
- **Band**: the width of the escalation band around a threshold (`delta_logit`) is
  chosen on dev, keeping escalations low under a limit on missed problems for the
  critical checks.
- **Redo** after any change of question text, quantization, llama.cpp release or state
  shape.

## Planned

- A second labeller on the holdout sets, to know how far the labels themselves agree.
- A new holdout for a third round on `weakens_tests`, which still fires on commits that
  only add code or tests.
- Measuring TypeSafe's Jev on the public and synthetic rows, to check its claim of
  calibrated probabilities on diffs.
