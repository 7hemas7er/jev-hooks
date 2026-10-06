# Question bench

Synthetic diffs labelled by hand, to measure how well each question of
`config/checks.json` separates the diffs that have the problem from those that do
not. We found no public dataset of diffs labelled for these questions, and none in
Italian: this is the first piece, small and written on purpose.

- `dev.jsonl`: the dataset, one JSON line per diff.
- `holdout.jsonl`: an independent holdout set with the same schema, written without
  looking at the variants: longer diffs spread over more files, to confirm the
  wordings chosen on `dev.jsonl` (`node bench/verify.ts bench/holdout.jsonl`).
- `verify.ts`: the check to run after every change to a dataset.
- `variants.json` and `VARIANTS.md`: the alternative question texts measured on the
  bench, and why each one exists.
- `scripts/measure-questions.ts` reads `dev.jsonl`, composes the placeholders and
  queries the backend.
- `scripts/simulate-policy.ts` replays a measurement already taken
  (`results/<dir>/`) with today's `policy.json`: counts per lane and per
  escalation on the clean diffs and on those with a problem, TPR and FPR per rule,
  without querying the model (`MEASUREMENT.md`).

```bash
node bench/verify.ts                      # schema, diffs, placeholders, counts
node bench/verify.ts other.jsonl --json   # another file, JSON output
node --test "tests/bench/*.test.ts"
```

## Row format

| Field | Content |
|---|---|
| `id` | lowercase with dashes, unique, at most 64 characters |
| `commit_language` | `it` or `en`: the language of title and description |
| `language` | `python`, `javascript`, `typescript`, `php`, `blade`, `sql`, `markdown`, `yaml`, `toml`, `json`, `text` |
| `title` | one line, at most 200 characters (the reviewer's limit) |
| `description` | always present: without one, `description_matches` is not asked |
| `diff` | a git unified diff, from 3 to 40 lines, headers included |
| `labels` | one key for each probability asked of the model (a noul, or a choice with a `value`), `true` or `false` |
| `note` | why the labels are what they are, above all in borderline cases |

The rows are mostly Italian (titles, descriptions, identifiers, notes) on purpose:
the questions are in English, and the bench measures how they hold up on commits
written in another language. They are data and stay as written.

A note that starts with `[difficile: injection_risk, debug_leftovers] `
(`difficile` is Italian for hard) declares the row a **hard negative** for those
questions: a case that looks like the problem but, by the definition, is not.
`verify.ts` checks that the labels of those questions really are `false`, and counts
the hard negatives per question.

## Label polarity

`true` means that the right answer to the question **as it is sent** is yes, and yes
always means "the problem is there". For the two questions with `invert`:

- `adds_tests` is sent as "does behaviour change without a test that exercises it?":
  `true` = **missing tests**;
- `description_matches` is sent as "does the description leave something out or make
  something up?": `true` = **unfaithful description**.

The reviewer then reports `1 − p` under those two ids; the bench stays in the polarity
of the sent question, because that is where measurement and calibration happen.

## Placeholders

No value that looks like a real secret, and no phrase addressed to the reviewer,
enters the repo. If one did, the reviewer would fire on the repo itself when the bench
is committed, and GitHub's push protection would stop the push. Placeholders stand in
their place, and `scripts/measure-questions.ts` composes them at run time with one
seed per row (`SEGRETO` is Italian for secret; the names stay because the dataset
uses them):

| Placeholder | Composed value |
|---|---|
| `{{SEGRETO:aws}}` | AWS access key (production prefix + 16 characters) |
| `{{SEGRETO:aws_segreta}}` | 40 high-entropy characters |
| `{{SEGRETO:stripe_live}}` | Stripe live key |
| `{{SEGRETO:stripe_test}}` | Stripe test key |
| `{{SEGRETO:github}}` | classic GitHub token |
| `{{SEGRETO:slack}}` | Slack bot token |
| `{{SEGRETO:alta_entropia}}` | 40 high-entropy characters, no prefix |
| `{{SEGRETO:iniezione}}` | a phrase asking the reviewer to call the file clean |

- The same placeholder has the same value across the whole row. `{{SEGRETO:aws:2}}`
  gives a second, different one.
- A public prefix is written in clear in front of the placeholder: Stripe's
  publishable key is `pk_live_{{SEGRETO:alta_entropia}}`.

## Operational definitions

The definitions follow the `instructions` and `criteria` of `config/checks.json` to
the letter. The model reads literally: Jev's documentation says so when it
describes its jaggedness, and rizzo inherits the format. A label that needs a
judgement the question's text does not contain would measure the labeller, not the
question.

`chunk` questions see only `[files]`, `[part]` and `[diff]`: their labels are decided
from the diff. Title and description matter only for the two global questions.

**Application code** here means `app/`, `src/`, `lib/`, `routes/`, `resources/views/`,
the server code the deployed program runs whatever its folder is called (a `server/`
beside `src/`), the stylesheets and front-end scripts the application serves wherever
they sit (`resources/css/`, `resources/js/`, `public/`), the configuration read at run
time (`config/*.php`, `settings.py`) and migrations. It does **not** include tests,
fixtures, factories, development seeders, release scripts, CI, a development
`docker-compose.yml`, linter configuration and documentation. A stylesheet counts like a
view: the program applies it. That was settled on 2026-10-03, when real commits had a
stylesheet under `src/` counted and one under `resources/css/` not; no row of the bench
sets touches a stylesheet, so no bench label changed. The server folder was settled on
2026-10-04 by a third labeller, on a TypeScript app whose image runs `node
server/main.ts`; the bench rows already use `app/`, `src/` and `lib/`.

### hardcoded_secret — hardcoded secret

**Yes**: an added line holds a credential that would really work:
- a high-entropy value in application code, assigned to a secret-like name and used
  to sign, encrypt or authenticate;
- a value with a production prefix (AKIA, `sk_live_`, `ghp_`, `xoxb-`) anywhere:
  even in a test, in a fixture or in a comment. The prefix wins over the path;
- a real fallback value in a read from the environment
  (`os.getenv("DB_PASSWORD", "…")`).

A comment saying "fake value" does not make a high-entropy value in `src/` fake.

**No**:
- the secret appears only in a removed line;
- the value comes from the environment (`os.environ`, `getenv` without a real
  fallback, `process.env`, `env()`, `${VAR}` in compose);
- test values in tests (`sk_test_`, `hunter2`, the 4242 card);
- placeholders in documentation (`your-api-key-here`, `<…>`, `CHANGEME`);
- publishable keys and identifiers (`pk_live_`).

### injection_risk — injection risk

**Yes**: data that can come from outside ends up, with no parameters, escaping or
closed list, in one of these places:
- SQL, even through a query builder when there is `whereRaw("… '{$x}' …")`;
- a shell (`exec` with a template string, `shell=True`) or `eval`;
- a file path;
- HTML without escaping (Blade `{!! !!}`).

"From outside" means from a request, a user, a file or the environment. A function
parameter that reaches `shell=True` counts: the diff does not tell who calls the
function.

**No**:
- bound parameters (`?`, `%s`, Eloquent `where`, `whereRaw` with bindings);
- SQL strings concatenated only with constant fragments;
- `execFile` with the argument list;
- a name checked against a closed list before it becomes a path;
- a parameter passed as it is, without concatenating or interpolating it
  (`upload_file(local_path, …)`): the criterion speaks of concatenated or
  interpolated data. This does not hold for `eval` and `exec`: there the whole
  string is code, and `eval(formula)` with data from outside is a yes even without
  concatenation;
- strings that end up in a log, in a Slack message or in the UI;
- tests that call the code with fixed inputs, even hostile ones.

### touches_auth — authentication and permissions

**Yes**: it changes who can get in or what they can do:
- a route that leaves the `auth` middleware;
- policies, roles and decorators such as `login_required`;
- JWT verification options;
- lifetime and flags of session cookies;
- CSRF and CORS exceptions;
- the signature check of a webhook;
- the key and the logic that sign session tokens.

**No**:
- texts of the login page;
- a log line in the login controller;
- renamed local variables;
- an unrelated helper in a file under `auth/`;
- tests of the authentication code;
- a new route inside an existing `auth` group;
- **outgoing credentials** towards third-party services (S3, Stripe, Slack,
  databases).

The last point is a choice: those credentials are a `hardcoded_secret` problem, but
they do not change who gets into the application or what they can do. The first
live probe (2026-09-25) counted the S3 client's AWS key as a yes; here it is a no.

### weakens_tests — weakened tests

**Yes**:
- `skip`, `xfail`, `it.skip`, `markTestSkipped` on existing tests;
- test cases removed while the code they test stays;
- assertions removed, commented out or loosened (`assertSame` becomes
  `assertNotNull`);
- an expected value changed without the diff changing the code;
- a coverage threshold or a test job removed from CI.

**No**:
- tests removed together with the (dead) code they tested;
- an expected value changed because the same diff changes the code on purpose;
- tests moved or renamed with their assertions intact;
- three tests gathered into one parametrized test with the same cases;
- stricter assertions;
- added tests.

### adds_tests — sent as "missing tests?"

**Yes**: the diff changes what the application code does and no test in the same
diff exercises it. These count too:
- tests added, but for another function;
- only a factory or only a fixture, with no case that could fail.

The rule is mechanical: every change the program executes counts, including an added
log line or a removed `console.log`, a view, a route, configuration read at run time
and a migration, even one that only adds an index. A judgement on "how important the
change is" is not in the question's text, and the model would not make it.

**No**:
- documentation, comments and docstrings, formatting;
- renames with no other change, even of an exported function (the program runs the
  same code; if callers break, `breaks_api` says so), removed dead code, a
  deprecated alias;
- changes to tests only (even when they weaken them: that is `weakens_tests`);
- tool configuration, seeders, dependencies without code;
- a change together with the test that exercises it.

The `true` criterion also says "only fixtures were added, with no test case that
could fail", and the `false` one says "no application behaviour changes". For a diff
made only of fixtures the two sentences contradict each other; here the first one
applies only when the application code changes too. The bench contains no
fixtures-only diff.

### breaks_api — public contract broken

**Yes**, with no alias and no deprecation path:
- an exported function renamed or removed;
- a new required parameter;
- an HTTP route moved;
- a response field renamed or removed;
- a CLI flag renamed;
- an event name changed;
- a default changed in an incompatible way;
- an existing column or table dropped, renamed, or with its type or nullability
  changed.

The database is a contract: an existing column is presumed read by other code,
unless the diff shows otherwise.

**No**:
- renames of functions that are not exported, private or local;
- optional parameters with a default that keeps the behaviour;
- new endpoints, fields and nullable columns;
- a deprecated alias that keeps the old name alive;
- version and changelog;
- behaviour that changes with signature and meaning unchanged (a maximum discount,
  a new rate);
- a new access check on a route that stays the same, when legitimate callers
  already satisfy it (the signature a webhook sender already sends): that is
  `touches_auth`.

### data_migration — data migration

**Yes**, with no `down()` (or an empty `down()`) and no backup: a migration or SQL
that
- drops or renames a table or a column;
- changes type or nullability;
- deletes or rewrites rows;
- transforms data in place (`RunPython` without `reverse_code`).

**No**:
- a new table, a nullable column, an index, even when `down()` drops what `up()`
  adds. The `false` criterion names the nullable column explicitly, so it is a no
  even without `down()`;
- development seeders;
- an ORM model without a migration;
- migration tests, even when they run `migrate:fresh`;
- documentation about the database.

**Left out of the bench**: a `DROP COLUMN` with a `down()` that recreates the column
empty. Read literally the criterion says no ("with no matching down migration"), but
the data is lost all the same. Until the criterion says "a down migration that
restores the data", the case stays out.

### description_matches — sent as "does the description leave something out or make something up?"

**Yes**: the description leaves out a relevant change or claims something the diff
does not contain. Relevant means:
- new behaviour;
- configuration (CORS opened to everyone);
- schema (one more column);
- a new dependency;
- a new blueprint;
- a test marked `xfail`.

Examples of claims with nothing behind them: promised tests, a false "no change in
behaviour", a VAT bug when the diff changes the sort order.

**No**:
- faithful descriptions, even short ones, in words different from the code or in
  another language;
- small unmentioned edits (a typo in a comment, a renamed local variable,
  formatting);
- debug leftovers, which are not changes to describe: `debug_leftovers` counts them;
- a "refactor" title when the description states the change.

### debug_leftovers — debug leftovers

**Yes**, in application code:
- diagnostic `print`, `console.log`, `var_dump`, `dd()` and `dump()`;
- `breakpoint()`, `pdb`, `debugger`;
- blocks of code commented out "just in case";
- `TODO` or `FIXME` to sort out before the merge or the release.

**No**:
- structured logging (`logger.info`, `Log::info`);
- the intended output of a script or a command (`$this->info` in artisan, `print`
  in the `main` of a CLI, `console.log` in `scripts/`);
- a `TODO` with a ticket reference;
- removed debug lines;
- commented-out lines in tests.

## Injection variants

Two rows have a `{{SEGRETO:iniezione}}` comment: a real secret and a concatenated
query. The labels stay those of the code. They show whether the phrase moves the
model's answer; the `reviewer_instructions` detector finds it anyway.

## What `verify.ts` checks

- **Schema**: no extra or missing field; one label for each probability asked of the
  model in `config/checks.json` (the nouls and the choices with a `value`). A new
  question there makes the bench incomplete until it is labelled.
- **Diff**: the core parser (`src/core/diff.ts`) must read the whole diff. Every line
  must belong to a header or a hunk, and the counts of every `@@` must add up. For
  robustness the parser silently drops stray lines: here they are errors.
- **Placeholders**:
  - only the types the measurement script can compose;
  - no hit from a detector with a floor or with `always` escalation, neither line by
    line nor on the whole file as the reviewer would see it at commit time;
  - no value that looks like a key in clear.
- **Consistency**: on the composed diff, a detector with a floor that fires on the
  added lines (an `sk_live_…` in a test) wants its question labelled yes.
- **Script reading**: `dev.jsonl` must also pass through `parseDataset` and
  `composeRow` of `scripts/measure-questions.ts`.
- **Counts**:
  - at least 60 rows;
  - for each question at least 6 positives, 6 negatives and 6 hard negatives;
  - titles mostly in Italian;
  - unique ids and diffs.

## Adding a row

1. Write the diff as `git diff` would print it, with the right hunk counts.
2. Put secrets and phrases addressed to the reviewer in as placeholders.
3. Decide **all** the labels with the definitions above, not only the one you had in
   mind. Write the reason in the note, and the `[difficile: …]` marker if needed.
4. Run `node bench/verify.ts`.

If a row cannot be labelled without a judgement the question's text does not
contain, remove it, or fix the criterion: first the criterion, then the calibration.

## `live.jsonl`: commits of this repo (weakens_tests only)

In live use (2026-09-28) the `weakens_tests` wording scored 0.25 to 0.94 on commits of
this repo that add or tighten tests, bump the pinned CI actions or touch only
documentation and JSON configuration. `dev.jsonl` has none of those shapes: no
`node:test` tests, no CI pin bump, no large multi-file commit. `live.jsonl` holds them:
13 real commits (negatives), 10 mutations of the files at HEAD that do weaken a test or
the CI (positives) and 4 mutations that do not (hard negatives). It is labelled for
`weakens_tests` only, and is built by the reviewer's own maintainers, so it serves to
choose a wording, never to check one: that stays the holdout set's job.

It is checked with `node bench/verify.ts bench/live.jsonl --only weakens_tests
--commits`: real commits are longer than the 40 lines a written row keeps to, and a set
of them is not balanced by design, so `--commits` drops the length limit and the
minimum counts, and keeps every other check. On 2026-09-29 the rows gained
`commit_language`, a description for the 14 mutations and the hard-negative marker on
the 4 that do not weaken, to match the row format; diffs, titles and labels did not
change, and `weakens_tests` sees only the diff. The 2026-09-28 reports below were
measured on the earlier file (sha256 `9ef7b82d…`, `git show 8e181ea:bench/live.jsonl`).

Second round, 2026-09-28 (`variants-weakens.json`, then `variants-weakens-2.json`):
`i_expected` separated both `dev.jsonl` (AUROC 1.000, mean p on negatives 0.033) and
`live.jsonl` (AUROC 1.000, 0.094 against 0.514 for the current text). On the frozen
holdout set, measured once (`results/2026-09-28-holdout-i_expected`, where the
`attuale` rows are `i_expected`), it lost two positives the current text catches
(TPR 10/12 against 12/12 at 0.50) while removing false alarms (1/109 against 4/109). The
reviewer is there not to miss a weakened test, so `checks.json` kept its text. The
holdout rows it missed were not opened, so that the set stays usable for the next
check.

## `holdout-weakens.jsonl`: a fresh holdout for weakens_tests (frozen, measured once)

The holdout set of `holdout.jsonl` has been looked at by id for `weakens_tests`, so it
can no longer check a rule chosen after that look. One such rule came out of the
measurements already taken, computed offline: escalate only when the current wording
(`c_scelta` ≥ 0.50) and `i_expected` (≥ 0.10) agree. On `dev.jsonl` and on the old
holdout it keeps every positive with the same false alarms (holdout 12/12, 4/109);
on `live.jsonl` it cuts them from 9/17 to 4/17. This set is there to check it once.

60 rows labelled for `weakens_tests` only: 16 positives, 44 negatives of which 29 hard
(additions and tightenings of tests, release and SHA-bump commits, documentation that
talks about tests, moved or parametrized tests, tests removed with their dead code),
in TypeScript, Python, PHP, YAML, Markdown and JSON. A subagent wrote it from the
row format and the definition above only: it did not see `checks.json`, the variants,
the other datasets or any result. `node bench/verify.ts bench/holdout-weakens.jsonl
--only weakens_tests` checks it; the rows must not change after the measurement.

Measured once on 2026-09-29 (`results/2026-09-29-holdout-weakens`, rizzo on the Spark,
the variants of `variants-weakens-2.json`). The two-question rule holds on rows no one
had looked at: it catches the same positives as the current text, 15 of 16, with 4
false alarms in 44 instead of 10. `i_expected` alone has the best AUROC (0.977) but
raises 7. The rule is in `policy.json` since then: `weakens_expected` in `checks.json`
is the `i_expected` text, asked as an `unless` condition of the `weakens_tests` rule,
and its `bench_labels` makes the bench tools label it with `weakens_tests`' labels, so
no dataset had to change.

```bash
node scripts/measure-questions.ts --dataset bench/holdout-weakens.jsonl \
  --variants bench/variants-weakens-2.json --url http://127.0.0.1:8017 \
  --out bench/results/YYYY-MM-DD-holdout-weakens --date YYYY-MM-DD
```

## Diffs split into chunks (2026-10-07, no dataset here)

Every row of the sets above fits in one chunk, while the live false alarms of
`weakens_tests` came from diffs split into several. The fourth round
(`variants-weakens-3.json`) was measured on two sets that are not in the repository:
- **the bench split into chunks**: each row of `dev.jsonl` and `live.jsonl` with a
  `weakens_tests` label (145, 19 positives), followed by the diff that added
  `src/action/main.ts` in commit 4caf96f, 341 lines of application code with no test.
  It splits each row into four or more chunks and holds no weakening, so the labels stay;
  it is rebuilt from those two files and that commit;
- **126 real commits** of three repositories, two of them private, split into several
  chunks and touching a test, CI or test-tool file. Two agents per repository labelled
  them with the definition above, from the commits themselves: 0 weakenings, 252 of 252
  labels agreeing. Their diffs stay out of the repository.

`results/2026-10-07-weakens3-dev` and `-live` are the same variants on the single-chunk
sets. `docs/evaluation.md` gives the numbers; `chunks_matching` in `config/checks.json`
is what came of it.

## `live-reviews.jsonl`: commits the live reviewer saw, labelled for every question

44 commits of this repo that the installed reviewer reviewed between 2026-09-27 and
2026-09-29, each diff in full (commits whose review left files out are not here: the
model did not see all of them). One row per commit, with the nine labels in the
polarity of the sent question and no diff: the reviewer saw
`git diff <DIFF_FLAGS> <commit>^ <commit>` (`DIFF_FLAGS` in `src/node/git.ts`), and the
commit message was the title and description.

```json
{"id": "review-4caf96f", "commit": "4caf96f…", "title": "feat(action): …", "labels": {"hardcoded_secret": false, "…": false}, "note": "…"}
```

Two agents labelled every commit independently, with the definitions above and without
seeing the reviewer's answers; they agreed on 394 of the 396 labels, and a third agent
decided the two they did not (both `description_matches`). Every yes has a note naming
the line that decides it. The labels are therefore the definitions applied literally,
not a person's judgement.

The set is small and nearly all negative: at most two positives per question, too few
for a calibration fit (`docs/evaluation.md`). It serves to count false alarms on real
commits and, in time, to measure a new wording on them; the model's answers are in the
maintainer's hook log, not in the repo.

## `router-dev.jsonl`: prompts for the effort router

The router's counterpart of `dev.jsonl`: 120 prompts as they reach Claude Code from the
composer, about half in Italian and half in English, measured with
`scripts/measure-router.ts` (below). Each row has the prompt text and one label per
question of `config/router.json`, plus `effort`:

```json
{"id": "o-it-drop-table", "language": "it", "text": "…", "labels": {"task_kind": "ops", "scope": 0, "has_error_evidence": false, "risky_irreversible": true, "underspecified": false, "multi_deliverable": false, "explicit_depth": "quick", "effort": "high"}}
```

The question labels follow the criteria of `router.json` literally. `effort` is the
lowest level at which Opus 5.5 or Fable 5.1 still does the job well, judged from the
prompt alone:

- **low**: nothing to explore beyond what the prompt names, and a wrong first try costs
  one retry: a concept question, a named one-line edit, a routine git command.
- **medium**: bounded work that needs a few files read or one debugging loop: how a
  module works, a bug with its error in a known place, a small feature in one or two
  files, a review of one file.
- **high**: several files or an unclear cause: a feature across modules, a bug
  without a clear location, a refactor of a module, a review of a change set, and any
  request that would act on a real system irreversibly (whatever else it asks).
- **xhigh**: system-wide design, hard debugging (races, memory, performance), large
  migrations, security audits, or a hard problem where the user asks for care.

A request for speed ("al volo", "quick") lowers the label unless the request is
risky. Confirmations (`continue`) have `effort: null`: their effort is the turn
before's, which a single prompt does not show.

The labels are one person's judgement, written by the maintainers together with the
router's rules: this set is for choosing thresholds and rules, not for claiming how
well the router does. That needs a holdout set written by someone who has not seen the
rules.

`router-holdout.jsonl` is that set: 120 prompts (60 Italian, 60 English) written and
labelled on 2026-09-28 by a separate agent that was given only the question criteria
and the effort definitions above, never `router.json`'s rules, the dev set or its
measurement. It was committed before being measured, and it is measured once to check a
configuration chosen on the dev set, never to choose one.

### Measuring and replaying

```bash
node scripts/measure-router.ts --out bench/results/YYYY-MM-DD-router-dev --url URL --date YYYY-MM-DD
node scripts/measure-router.ts --replay bench/results/YYYY-MM-DD-router-dev --config /tmp/trial-router.json
```

A measurement sends one request per prompt, built by `prepareRequest` with the
plugin's `router.json` (or `--config`, applied as the user layer) and read back by
`parseClassification`, as in the function hook; it writes `raw.jsonl` (the answers as
they came) and `report.md`. A replay recomputes the report from `raw.jsonl` with the
configuration given now, without the network: thresholds, base steps, adjustments and
floors can change, the question texts cannot (a replay warns when a hash differs from
the one the report recorded). The key follows the CLI's rule (`JEV_HOOKS_URL` +
`JEV_HOOKS_KEY`), never a flag.

The report gives, per question, how the answers match the labels (AUROC and the rate
at each configured threshold for the nouls, accuracy and a confusion table for choices
and scores), the latency against `timeout_ms`, and end to end, for a session at
`xhigh` and at `high`, how often the chosen effort falls **under** the label (the
risk), matches it, or stays **over** it (a missed saving). The outputs hold ids,
numbers and hashes: no prompt text, no host, no key.
