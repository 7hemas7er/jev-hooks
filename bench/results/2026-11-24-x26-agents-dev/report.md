# Subagent router: agent_task on labelled task prompts

- Date: 2026-11-24
- Dataset: `bench/agents-dev.jsonl` (sha256 `61a4f582619c…`), 120 rows
- Configuration: config/agents.json (plugin)
- min_top_probability 0.40; route check_claim → claude-haiku-5-5, label → claude-haiku-5-5

Answered 120 of 120.

## agent_task

Accuracy 110/120 (92%); mean p of the chosen option 0.703.

| label \ answer | locate | extract | summarize | check_claim | label | review | implement | debug | design | research |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| locate | 11 | 2 | · | · | · | · | · | · | · | · |
| extract | · | 11 | · | · | 1 | · | · | · | · | · |
| summarize | · | 1 | 7 | · | · | · | · | · | · | · |
| check_claim | · | · | · | 19 | · | · | 1 | · | · | · |
| label | · | · | · | · | 13 | · | 1 | · | · | · |
| review | · | · | · | · | · | 15 | 1 | · | · | · |
| implement | · | 1 | · | · | · | · | 15 | · | · | · |
| debug | · | · | · | · | · | · | · | 7 | · | · |
| design | · | · | · | · | · | · | · | · | 7 | · |
| research | · | · | · | 1 | · | · | · | · | 1 | 5 |

## Routing, end to end

Every row decided as an Agent tool spawn from an Opus 5.5 session whose caller named no model. **Wrongly moved** is a row moved to a route's model whose label says it needs a large model (the risk: a worse answer); **left** is a row labelled small or medium that stays on the parent's model (a missed saving, never a loss of quality).

- Moved 31 of 120; wrongly moved 0.
- Left on the parent's model though labelled small or medium: 56.

## Question hash

| question | sha256 |
|---|---|
| agent_task | `6817b237294fe93e2e0488fb8c6cd497ac1518be658737551ddb3f8a54abc223` |
