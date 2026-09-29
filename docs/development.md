# Development

Everything runs on Node ≥ 22.18 with no build step and no dependencies. The rules for
contributors, human or agent, are in [`AGENTS.md`](../AGENTS.md).

```bash
node --test "tests/**/*.test.ts"       # offline: a fake /v1/systemone server, a fake engine, temporary dirs only
node scripts/validate-manifest.ts      # manifests, hooks.json, config/*.json
node scripts/generate-defaults.ts --check
node scripts/check-english.ts          # leftover Italian outside the data
claude plugin validate .claude-plugin/plugin.json   # what hooks/register.ts hooks, calls and reads
node scripts/test-cc.ts                # tests-cc/ in Claude Code's own test kit
```

Always pass the glob: without it, `node --test` runs every `.ts` file as a program,
helpers included. The router's decisions are pure functions in `src/core/router.ts`,
tested under Node and in a `node:vm` context as strict as the one Claude Code 2.1.282
gave function hooks; `hooks/register.ts` only carries data between Claude Code and
them. The last two commands need the `claude` CLI, so CI does not run them.
`claude plugin test` takes a plugin root and cannot set options, so
`scripts/test-cc.ts` runs it on a temporary copy of the plugin with the router on;
without the CLI it says so and exits 0.

Try the reviewer on the demo diffs (secrets and injection phrases are composed at run
time, so none of them sits in the repo):

```bash
node scripts/generate-demo.ts /tmp/jev-demo                   # --seed N: the same values every run
bin/jev-review.mjs --diff /tmp/jev-demo/known-secret.diff     # BLOCK from a floor, even with no backend
bin/jev-review.mjs --diff /tmp/jev-demo/uncertain.diff --escalate
bin/jev-review.mjs explain hardcoded_secret
```

The bench, when you change a question or a threshold:

```bash
node bench/verify.ts                                        # dataset schema, diffs, placeholders, counts
node scripts/simulate-policy.ts bench/results/2026-09-26-holdout bench/results/2026-09-26-dev-checks
node scripts/measure-questions.ts --dataset bench/holdout.jsonl \
  --variants bench/variants-holdout.json --url http://127.0.0.1:8017 --out /tmp/measure
```

`simulate-policy` replays recorded answers against today's `policy.json` without
querying the model: counts per lane and per escalation, TPR and FPR per rule.
`measure-questions` asks the model again and is needed only when a question's text
changes.
