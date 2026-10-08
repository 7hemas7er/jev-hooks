# Subagent router: agent_task on labelled task prompts

- Date: 2026-10-09
- Dataset: `bench/agents-dev.jsonl` (sha256 `61a4f582619c…`), 120 rows
- Configuration: config/agents.json (plugin)
- min_top_probability 0.40; route check_claim → claude-haiku-5-5, label → claude-haiku-5-5

Answered 120 of 120.

## agent_task

Accuracy 108/120 (90%); mean p of the chosen option 0.737.

| label \ answer | locate | extract | summarize | check_claim | label | review | implement | debug | design | research |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| locate | 12 | 1 | · | · | · | · | · | · | · | · |
| extract | · | 11 | · | · | 1 | · | · | · | · | · |
| summarize | · | 1 | 7 | · | · | · | · | · | · | · |
| check_claim | · | · | · | 20 | · | · | · | · | · | · |
| label | · | · | · | · | 14 | · | · | · | · | · |
| review | · | · | · | · | · | 16 | · | · | · | · |
| implement | · | 3 | · | · | · | · | 13 | · | · | · |
| debug | · | · | · | 1 | · | · | · | 6 | · | · |
| design | · | · | · | · | · | · | 1 | · | 6 | · |
| research | · | · | · | 2 | · | · | 1 | · | 1 | 3 |

## Routing, end to end

Every row decided as an Agent tool spawn from an Opus 5.5 session whose caller named no model. **Wrongly moved** is a row moved to a route's model whose label says it needs a large model (the risk: a worse answer); **left** is a row labelled small or medium that stays on the parent's model (a missed saving, never a loss of quality).

- Moved 34 of 120; wrongly moved 1: debug-march-totals-doubled (check_claim 0.83).
- Left on the parent's model though labelled small or medium: 54.

## Question hash

| question | sha256 |
|---|---|
| agent_task | `6817b237294fe93e2e0488fb8c6cd497ac1518be658737551ddb3f8a54abc223` |
