# Measuring the questions

`scripts/measure-questions.ts` tries several texts (variants) for each question of
`config/checks.json` on a set of labelled diffs, and for each variant tells how well
the model's p separates the diffs that have the problem from those that do not.

It exists to choose question texts with numbers. The first probe on the Spark (4B
BF16, six synthetic diffs) found questions that separate well, such as
`hardcoded_secret`. Others said "yes" to almost everything, such as `injection_risk`
and `breaks_api`. Rewriting a question by eye does not tell whether the new text is
better: this script does.

It is the evaluation protocol in miniature. It does not calibrate and it does not
choose thresholds: it measures the ability to separate, which calibration cannot
create.

## Running it

On the Spark, with rizzo-flow listening on port 8017, from the repo root:

```bash
node scripts/measure-questions.ts \
  --dataset bench/dev.jsonl \
  --variants bench/variants.json \
  --url http://127.0.0.1:8017 \
  --model jev-latest \
  --out /tmp/measure-2026-09-26 \
  --date 2026-09-26
```

On today's bench (118 diffs, 44 variants) that is **236 requests per repeat**: for
each diff one on the chunk state, with the 31 variants of the `chunk` questions, and
one on the global state, with the 13 of `adds_tests` and `description_matches`. Each
diff fits in a single chunk, and the longest question with its state stays below
1200 tokens (at 2.9 characters per token), far from `--ctx 8192`.

**Holdout set.** `bench/holdout.jsonl` has new diffs, written without looking at the
variants, and it is not used to choose a text: it tells whether the wordings chosen
on `dev.jsonl` hold, and it gives the p for a calibration fit. That is why it is
measured with `bench/variants-holdout.json`, which for each probability in
`checks.json` has only the `attuale` (current) variant (`from_checks`), read the way
the reviewer reads it: `1-p(none)` for the choices with a `value`, P(yes) for the
nouls.

```bash
node scripts/measure-questions.ts \
  --dataset bench/holdout.jsonl \
  --variants bench/variants-holdout.json \
  --url http://127.0.0.1:8017 \
  --model jev-latest \
  --out /tmp/measure-YYYY-MM-DD-holdout \
  --date YYYY-MM-DD
```

That is 2 requests per diff (one on the chunk state with 7 questions, one on the
global state with `adds_tests` and `description_matches`): 242 for today's 121
diffs. `report.md` and `raw.jsonl` then go into `bench/results/YYYY-MM-DD-holdout/`.
The hashes at the bottom of the report must match the `per_question.sha256` of the
`spark-bf16-2026-09` profile in `config/calibration.json`: if one differs,
`checks.json` changed after the thresholds were chosen.

| Option | Default | Meaning |
|---|---|---|
| `--out DIR` | required | Where to write `raw.jsonl` and `report.md`. If they already exist, the script stops. |
| `--dataset FILE` | `bench/dev.jsonl` | The labelled diffs, one JSON line per diff. |
| `--variants FILE` | `bench/variants.json` | The alternative question texts. |
| `--url URL` | `http://127.0.0.1:8017` | The backend. Normalized as in the CLI (trailing `/`, `/v1` and `/v1/systemone`). |
| `--model NAME` | `jev-latest` | The requested model. |
| `--repeats N` | 1 | How many times to repeat the whole dataset. |
| `--date TEXT` | today | The date written in the report. |
| `--seed N` | 1 | The seed of the placeholders (see below). |
| `--timeout-ms N` | 120000 | The time limit for one request. |
| `--overwrite` | no | Rewrites a measurement already in `DIR`. |

It needs Node ≥ 22.18, no build and no dependencies, like the rest of the repo. On
Node 22 the warning about experimental type stripping shows up: that is normal.

**During the measurement** the script writes one progress line per diff on stderr.
At the end it prints the paths of `report.md` and `raw.jsonl` on stdout. The lines of
`raw.jsonl` are written as they arrive: an interrupted measurement keeps what came
in.

**Exit codes:**
- **0**: measurement complete. Failed requests, if any, are in the report's notes.
- **1**: measurement interrupted. It happens on a backend error (key rejected, wrong
  URL or model, backend unreachable, fingerprint changed halfway) or after 3 failed
  requests in a row. The report is written anyway and says so at the top.
- **2**: invalid usage or input. No request is sent.

**The key** is never passed as an option. Towards rizzo on the LAN without
`RIZZO_API_KEY` none is needed. For a backend with a key the CLI's rule applies:
- `JEV_HOOKS_KEY` goes to the backend only if `JEV_HOOKS_URL` has the same origin as
  `--url`;
- `TYPESAFE_API_KEY` goes only to `api.typesafe.ai` or to the host of
  `TYPESAFE_BASE_URL`.

The file `~/.config/jev-hooks/key` is not read.

**With TypeSafe's Jev** the answers never become labels, and only aggregate metrics
are published (TypeSafe's terms forbid distillation).

## The dataset: `bench/dev.jsonl`

One JSON line per diff:

```json
{"id": "secret-s3", "title": "feat: S3 client", "description": "Adds the S3 client for attachments.", "labels": {"hardcoded_secret": true, "touches_auth": false, "debug_leftovers": false}, "diff": "diff --git a/src/s3.py b/src/s3.py\n--- a/src/s3.py\n+++ b/src/s3.py\n@@ -1 +1,2 @@\n import boto3\n+KEY = \"{{SEGRETO:aws}}\"\n"}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique, at most 200 characters, no backticks and no `\|`. It appears in the report and in `raw.jsonl`. |
| `diff` | yes | A git unified diff, as `git diff` prints it. |
| `title` | no | Default `""`. |
| `description` | no | Default `null`. Without a description the questions that require one (`description_matches`) are not asked, as in the reviewer. |
| `labels` | no | An object `{"<question>": true \| false \| null}`. 1 and 0 are accepted too. A question with no label is measured, but that diff does not enter the metrics. |

Other fields (`commit_language`, `language`, `note`…) are ignored here;
`bench/verify.ts` checks them.

**Label polarity.** `true` means that the right answer to the question, asked in
"yes = problem" polarity, is yes. It is the constant polarity of `checks.json`, and it
also holds for the two questions with `invert`:
- `adds_tests: true` means the diff changes behaviour **without** tests that
  exercise it, i.e. tests are missing;
- `description_matches: true` means title and description **leave something out or
  make something up**.

The reviewer reports `1 − p` under those ids, but the measurement stays on the sent
question.

### Placeholders

Realistic-looking secrets and phrases addressed to the reviewer do not enter the
repo. The dataset holds a placeholder, and the script replaces it at run time,
before building the states, in `diff`, `title` and `description` (`SEGRETO` is
Italian for secret; the name stays because the dataset uses it):

| Placeholder | Composed value |
|---|---|
| `{{SEGRETO:aws}}` | AWS access key: production prefix + 16 characters |
| `{{SEGRETO:aws_segreta}}` | 40 high-entropy characters |
| `{{SEGRETO:stripe_live}}` | Stripe live key + 24 characters |
| `{{SEGRETO:stripe_test}}` | Stripe test key + 24 characters |
| `{{SEGRETO:github}}` | GitHub personal token + 36 characters |
| `{{SEGRETO:slack}}` | Slack bot token |
| `{{SEGRETO:alta_entropia}}` | 40 high-entropy characters, no prefix |
| `{{SEGRETO:iniezione}}` | a phrase asking the reviewer to ignore its rules |

- **Same placeholder, same value.** Within a row, the same placeholder gives the same
  value, even across title and diff: a key defined and then used stays the same.
- **Different values.** For two different values of the same type, add a
  discriminator: `{{SEGRETO:aws:2}}`.
- **Reproducibility.** Each row's seed comes from `--seed` and from the `id`: two
  runs send the same states, and reordering the rows does not change the values.
- **Errors.** An unknown type or a malformed placeholder stops the measurement before
  any request.
- **PEM private keys.** There are none: they are multi-line blocks, and every line of a
  diff must start with `+`.

The composed values never appear in the report or in `raw.jsonl`.

## The variants: `bench/variants.json`

An object with one entry per question. Keys starting with `_` are comments, at every
level.

```json
{
  "_comment": "Variants of hardcoded_secret: the current text, a concrete form and its inverse.",
  "hardcoded_secret": {
    "variants": {
      "attuale": { "from_checks": true },
      "concrete": {
        "readout": "p",
        "question": {
          "type": "noul",
          "instructions": "Does an added line in the [diff] section contain a literal credential value?",
          "criteria": { "true": "…", "false": "…" }
        }
      },
      "concrete_inversa": {
        "readout": "inverse",
        "question": {
          "type": "noul",
          "instructions": "Are all added lines in the [diff] section free of literal credential values?",
          "criteria": { "true": "…", "false": "…" }
        }
      },
      "kind": {
        "readout": "1-p(none)",
        "question": {
          "type": "choice",
          "instructions": "Which kind of literal credential does an added line in the [diff] section contain?",
          "criteria": { "cloud": "…", "payment": "…", "token": "…", "none": "No added line contains a credential." }
        }
      }
    }
  },
  "breaks_api": {
    "scope": "global",
    "variants": { "removal": { "question": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } } } }
  }
}
```

**Fields of a question:**
- `variants` (required): name → variant. Names use letters, digits, `_`, `.` and `-`,
  at most 60 characters.
- `scope` (optional): `"chunk"` or `"global"`, i.e. which state the question goes
  to. The default is the scope in `config/checks.json`, and it is required for a
  question that is not there. A scope different from `checks.json` is an experiment:
  the report flags it, because the plugin would not ask the question that way.
- `requires` (optional): `["description"]` or `[]`. The default is the one in
  `checks.json`.

**Fields of a variant:**
- `question`: the question as it leaves for the backend, i.e. only `type`,
  `instructions` and `criteria`. It goes through the same rules as `checks.json`:
  - no extra fields;
  - non-empty `instructions`;
  - choices with 2 to 26 options, scores with 2 to 10 levels;
  - texts up to 8000 characters.
  A variant rizzo would reject is caught before anything is sent.
- `from_checks: true`, instead of `question`: uses the current text of
  `config/checks.json`. It is the reference to beat, and its hash is the one a
  calibration fit would use. For a choice with a `value` (`"1-p(none)"`) the readout is
  that value, as in the reviewer: a different `readout` is an error.
- `readout`: how p is derived from the answer (table below). The default is `p` for a
  noul; for choices and scores it is required, except for the `from_checks` variant of
  a choice with a `value`.
- `pair`: only for an `inverse` variant, the name of its direct variant. When it is
  missing, the pair is found by name: `x_inversa` goes with `x` (the suffix stays
  Italian, like the variant names recorded in the results).

**Combinations** (optional, the question's `combinations` field): p computed by the
code from variants already asked, as the reviewer would do if that form entered
`checks.json`. They add no requests.

```json
"combinations": {
  "e_omissione_o_invenzione": { "max": ["e_omissione", "e_invenzione"] },
  "c_scelta_due_ordini": { "mean": ["c_scelta", "c_scelta_none_ultima"] },
  "e_scomposta_senza_test": { "variant": "e_scomposta", "zero_if_test_file": true }
}
```

| Form | p |
|---|---|
| `max: [a, b, …]` | the maximum of the variants' p (each read with its own readout) |
| `mean: [a, b, …]` | the logit mean, as for pairs |
| `variant: x, zero_if_test_file: true` | the p of x, or 0 if a path of the diff (including the old name of a rename) matches `test_paths` in `policy.json` |

- A combination's name follows the rules for variant names and cannot be the same as
  a variant's.
- A combined p exists for a diff only if every variant it cites has a p.
- With `zero_if_test_file` the report adds the row **paths only (no model)**: 1 on
  diffs without a test file, 0 on the others. It is the path rule on its own, and it
  already separates a good deal: on the bench, with a model that always answers the
  same, it scores AUROC 0.786 for `adds_tests`. A combined variant is worth something
  only if it beats it.

### Readouts

A readout brings every answer to the same scale: p = probability that the label is
true.

| Readout | Type | p |
|---|---|---|
| `p` | noul | P(yes) |
| `inverse` | noul written the other way round ("is it clean?") | 1 − P(yes) |
| `1-p(<option>)` | choice or score | 1 − p of the option, for example `1-p(none)`: "there is something, of any kind" |
| `p(<option>)` | choice or score | p of the option |
| `p(>=<k>)` | score | P(level ≥ k), for example `p(>=3)` for `blast_radius` |

The options of a score are the levels `0`, `1`… from the lowest, as Jev and rizzo
index them. In `raw.jsonl`, `raw` is the number read from the answer: P(yes), the
option's p, or the expected score for `p(>=k)`. Measurements taken before the rename
record the inverse readout as `inversa`.

**Direct + inverse pairs.** For each pair the report adds a `mean` row, with the
logit mean of the two p: σ((logit p₁ + logit p₂) / 2), with the logits clipped at ±36
as in the reviewer. A model that tends to say "yes" regardless of the diff pushes the
direct question's logit up and the inverse's (read as 1 − P(yes)) down by the same
amount: in the mean that tendency cancels out, and what depends on the diff remains.
The mean of the p would not cancel it, and with rizzo's peaked p it would squash
almost everything onto 0.5. The first probe showed exactly this bias:
`injection_risk` above 0.88 on five diffs out of six.

**Writing variants.** Jev and rizzo read literally: concrete, observable questions
("does an added line concatenate a request parameter into an SQL string?") work
better than judgement questions ("is the code vulnerable?"). The variants are there
to check that, question by question.

## What gets sent

The state is built with the same functions as the reviewer (`review()` in
`src/core/review.ts`) and with the plugin configuration (`config/*.json`), with no
user or project layers:
1. title and description as in the reviewer: an empty description counts as absent,
   and both are cut at `max_description_chars`;
2. `parseDiff` with the limits of `policy.json`;
3. `detect`, because detector hits decide the priority of files;
4. `planChunks` with the limits of the commit hook, the entry point that matters most
   (`limits.hook.max_chunks`), and `tokens_per_state`.

`chunk` questions go to the state of each chunk: only `[files]`, `[part]` and
`[diff]`, never title or description. `global` questions go to the global state.
Today, from `checks.json`:
- **chunk**: `hardcoded_secret`, `injection_risk`, `touches_auth`, `weakens_tests`,
  `breaks_api`, `data_migration`, `debug_leftovers`;
- **global**: `adds_tests`, `description_matches`, `blast_radius`,
  `reviewer_effort`, `primary_concern`.

A test (`tests/bench/measure.test.ts`) compares the measurement's states with those
`review()` sends for the same diff, also when the diff is split into several chunks.

**The requests:**
- **One request per state**, with all the variants as questions. rizzo computes the
  state prefix once, and each question is a prompt of its own that the id does not
  enter. So the variants do not influence each other and cost little.
- **More than 64 variants** for one state, the limit shared by Jev and rizzo, become
  several requests on the same state.
- **The id in the request** is `<question>__<variant>`.
- **Several chunks.** For a diff split into chunks, the p of a `chunk` question is the
  maximum across chunks, as in the reviewer. The readout already brings every p to
  "yes = problem" polarity, so the maximum stays right for the `inverse` and `1-p(…)`
  readouts too.
- **Order.** Requests go one at a time: rizzo serializes them anyway, and the measured
  latency stays that of a single request.
- **Non-local backend.** Towards a non-local backend (TypeSafe) the states go through
  the same redaction as in the reviewer. The guardrail mask map, however, is not
  applied.
- **Fingerprint.** It must stay the same for the whole measurement: if it changes, the
  measurement stops.

## Outputs

### `raw.jsonl`

One line per diff, variant and repeat:

```json
{"id":"secret-s3","repeat":1,"question":"hardcoded_secret","variant":"concrete","readout":"p","p":0.937,"raw":0.937,"label":true,"ms":1012}
```

- `p` is the p read, and the maximum across chunks for `chunk` questions.
- `raw` is the value of the answer that `p` comes from.
- `ms` is the time of the requests that held the variant. Variants sent together
  share the same time.
- `chunks` appears only with several chunks: the p of each one.
- If the variant got no answer, `p` is `null` and `error` says why: failed request,
  discarded answer or interrupted measurement.

Questions that require a description do not appear for diffs without one: they were
not asked.

### `report.md`

**At the top** is the metadata needed to compare two measurements:
- the date;
- the backend, the requested model and the declared one;
- rizzo's fingerprint and `probability_status`;
- the sha256 of the dataset, of the variants, of `checks.json` and of `policy.json`;
- `tokens_per_state`, the seed, the repeats and the Node version;
- the number of requests and the median and 95th-percentile latency.

**Then**:
- a summary with the best variant per question;
- one table per question, sorted by AUROC, with the best one marked ★; the `mean`,
  `max`, `p × no test` and **paths only** rows are computed, not asked;
- the notes (failed requests, questions not asked, diffs split into chunks);
- the sha256 hash of every variant, i.e. the one a calibration fit cites in
  `per_question`.

### Metrics

They are computed only on labelled diffs. With several repeats, the mean p per diff is
used.

| Metric | Definition |
|---|---|
| AUROC | Mann-Whitney statistic: the probability that a random positive has a higher p than a random negative; ties count half. 1 separates everything, 0.5 is chance, below 0.5 the question is reversed. It does not change with calibration: it is what a calibration fit cannot add. |
| mean + / mean − | Mean p on positives and on negatives. |
| separation | mean + minus mean −. |
| Brier | Mean of (p − label)²: 0 is perfect, and always saying 0.5 scores 0.25. |
| best threshold | The threshold (yes from there up) with the highest balanced accuracy. Between two consecutive p of the sample every threshold classifies the same way: the logit midpoint is reported, because rizzo's p are very peaked. On a tie, the threshold closest to 0.5 wins. "—" if no threshold beats chance. |
| bal. acc. | Balanced accuracy at the best threshold: the mean of sensitivity and specificity. |
| bal. acc. at 0.5 | The same, with the threshold at 0.5. |
| n+ / n− | Positive and negative diffs with a p. |
| Δ rep. | Only with several repeats: the largest spread of p across repeats. |

Rows are sorted by AUROC, then by wider separation, then by lower Brier.

## Caveats

- **Few diffs, unstable AUROC.** With few diffs the AUROC moves in jumps: with 3
  positives and 3 negatives each pair is worth 0.11. Before changing `checks.json` you
  need tens of diffs per question, split by group.
- **A threshold chosen on the same diffs is optimistic.** Choose on the dev set and
  check on the holdout set, never on the same set.
- **The raw p is measured.** Calibration for the reviewer comes afterwards, on the
  chosen text: changing a question's text invalidates its calibration fit (a different
  sha256).
- **Plugin only.** The measurement uses only the plugin configuration: a user
  `policy.json` with another `tokens_per_state` would give different states.

## Simulating a policy: `scripts/simulate-policy.ts`

A measurement queries the model; changing a threshold in `policy.json` does not. To
see the effect of a change right away, the simulator replays a measurement already
taken:

```bash
node scripts/simulate-policy.ts bench/results/2026-09-26-holdout bench/results/2026-09-26-dev-checks
node scripts/simulate-policy.ts bench/results/2026-09-26-holdout --config-dir /tmp/trial   # a trial policy.json
node scripts/simulate-policy.ts bench/results/2026-09-26-holdout --json
```

- **What it replays.** The `raw.jsonl` rows of the `attuale` variant (the questions of
  `checks.json`), first repeat. Every p is already in "yes = problem" polarity and
  already the maximum across chunks.
- **With which code.** The reviewer's: the `calibration.json` profile chosen from the
  backend identity written in `report.md` (model, fingerprint,
  `probability_status`), and the core's `aggregateNoul`, `decide` and `escalation`,
  with the effective configuration: plugin plus user layer
  (`${XDG_CONFIG_HOME:-~/.config}/jev-hooks/`) or `--config-dir`, never the project.
  An invalid user file stops the simulation (exit 2).
- **Detectors count.** The dataset diff (from the report, or `--dataset`) is composed
  with the measurement's seed, and the detectors run on it: a BLOCK floor on an AKIA…
  key holds here too. If `raw.jsonl` has the p of every chunk and the plan gives the
  same chunks, each chunk keeps its p; otherwise one chunk with all the files, which
  changes only the files an item cites.
- **What it prints.** Per lane and per escalation (each reason, and per question for
  `threshold` and `band` items), the counts on the **clean** diffs (no true label among
  the questions that have a rule: there, anything that is not MERGE is a false alarm)
  and on those **with at least one problem**; then TPR and FPR of every rule. The
  "from the model" line compares the threshold and band escalations with those
  expected from the escalation rules alone: with the band off on those rules they
  match.
- **Warnings.** A dataset changed after the measurement (sha256 different from the
  report) or a `checks.json` question different from the measured one: in that case
  the answers do not hold for today's text, and the measurement must be taken again.

No network, no key, no writes.

## Fitting the calibration: `scripts/fit-calibration.ts`

```bash
node scripts/fit-calibration.ts --fit bench/results/2026-09-26-dev-checks \
  --check bench/results/2026-09-26-holdout --out bench/results/2026-09-30-calibration --date 2026-09-30
```

It fits a Platt scaling per question on the `attuale` answers of `--fit` and checks it
on those of `--check`, with no request to the backend. A question is fitted only if
both reports list today's sha256 for it, and adopted only if a > 0 and the log-loss of
the check set goes down; the others keep only their sha256. It writes `report.md`
(log-loss, Brier and ECE before and after on both sets, AUROC, and where each policy
threshold lands on the calibrated scale) and `profile.json`, whose `per_question` block
goes into the backend's profile in `config/calibration.json`, with
`"calibrated": true`. The two measurements must come from the same fingerprint.

The fit does not choose thresholds: on a calibrated question the reviewer keeps deciding
on the raw value against the policy's threshold, and shows the threshold moved through
the fit, so the verdicts stay those of the raw scale. `tests/bench/simulate.test.ts`
checks it on both bench sets, diff by diff, against the same profile without its fit,
with the plugin's policy and with one that has bands and disagreement on the fitted
questions; `simulate-policy.ts --json` with and without a `--config-dir` holding the new
`calibration.json` shows the same counts.

## Tests

```bash
node --test "tests/**/*.test.ts"
```

`tests/bench/simulate.test.ts` checks the simulator on the two bench sets (no clean
diff in BLOCK or SECURITY REVIEW with the plugin policy, escalations on clean diffs
equal to those expected from the thresholds, TPR and FPR per rule equal to those
computed separately from the p; with the policy from before v2, 10 clean diffs out of
34 in BLOCK on the holdout set), on a fake measurement and from the command line.

`tests/bench/measure.test.ts` runs offline against the fake server
(`tests/helpers/fake-systemone.ts`) and checks:
- the metrics on known cases (AUROC 1, 0.5 and 0, ties, a single class);
- the readouts `p`, `inverse`, `1-p(none)`, `p(x)` and `p(>=k)`;
- pairs and combinations (`max`, logit `mean`, `zero_if_test_file` with the "paths
  only" row), and their errors;
- that the repo's `bench/variants.json` and `bench/dev.jsonl` read together: every
  question with its `attuale` from `checks.json` and its labels in every row;
- dataset and variant errors;
- the placeholders;
- one request per state, with the split beyond 64 questions;
- the equality of the states with those of `review()`;
- the stop on a backend error;
- the command line.
