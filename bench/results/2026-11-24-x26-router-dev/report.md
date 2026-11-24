# Router measurement

- Date: 2026-11-24
- Backend: local, requested model `jev-latest`, declared model `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `26df54b4ac1b55943587178a193f69234a4b6815b2e15287098f0a5887c52661`
- Calibration profile: `rizzo-provisional` (uncalibrated)
- Dataset: `bench/router-dev.jsonl`, 120 prompts, sha256 `325744cbf7baa1faeb53de769abdd3775e3abef8b1a133efb5a818b3f0ca3609`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.60 s, median 0.41 s, p95 0.48 s, max 0.60 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 85/120 (71%); mean p of the chosen option 0.782.

At min_top_probability 0.30: 120/120 (100%) classified, of which 85/120 (71%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 9 | · | 1 | · | · | 1 | · | 3 | 1 |
| small_edit | 2 | 4 | · | · | 1 | · | · | 4 | 3 |
| bug_with_error | 1 | · | 14 | · | · | · | · | · | · |
| feature | · | 1 | 1 | 10 | 1 | 1 | · | 2 | 2 |
| refactor | 1 | · | · | · | 8 | · | · | 1 | 1 |
| design | 1 | · | · | · | · | 8 | · | 1 | · |
| review | 2 | · | · | · | · | · | 9 | · | · |
| ops | · | · | · | · | 1 | · | · | 15 | 2 |
| continue | · | · | · | · | · | · | · | · | 8 |

### scope (score)

Accuracy 41/120 (34%); within one level 88/120 (73%).

- Rule level ≥ 2: TPR 45/48 (94%), FPR 54/72 (75%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 10 | 3 | 26 | 3 |
| 1 | 5 | · | 25 | · |
| 2 | · | · | 26 | 1 |
| 3 | 3 | · | 13 | 5 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 1.000 | 0.996 | 0.004 | 0.714 | 1.000 |

- At the configured threshold 0.60: TPR 13/13 (100%), FPR 0/107 (0%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 11 | 109 | 0.991 | 0.986 | 0.132 | 0.849 | 0.968 |

- At the configured threshold 0.50: TPR 11/11 (100%), FPR 13/109 (12%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.772 | 1.000 | 0.999 | 1.000 | 0.788 |

- At the configured threshold 0.60: TPR 16/16 (100%), FPR 104/104 (100%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 8 | 112 | 0.970 | 0.851 | 0.112 | 0.487 | 0.951 |

- At the configured threshold 0.60: TPR 7/8 (88%), FPR 9/112 (8%).

### explicit_depth (choice)

Accuracy 115/120 (96%); mean p of the chosen option 0.924.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 7 | · | 2 |
| thorough | · | 6 | 2 |
| none | 1 | · | 102 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 112 prompts judged; lowered 50/112 (45%).
- Under 4/112 (4%), exact 29/112 (26%), over 79/112 (71%).
- Steps saved 71 of the 193 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 5 | 4 | 14 | 7 |
| medium | 1 | 1 | 10 | 20 |
| high | 1 | 2 | 12 | 24 |
| xhigh | · | · | · | 11 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| r-it-typescript-strict | high | medium | ops 0.84: -2 → medium; underspecified 1.00: at least medium → medium |
| r-it-quick-rename | medium | low | question 0.37: -2 → medium; scope 2: +1 → high; underspecified 1.00: at least medium → high; explicit_depth quick 0.82: low → low |
| v-it-review-vaga | high | medium | question 0.71: -2 → medium; underspecified 1.00: at least medium → medium |
| x-it-under-meglio | high | low | continue 0.50: previous → xhigh; scope 2: +1 → max; underspecified 1.00: at least medium → max; explicit_depth quick 0.91: low → low |

Left at xhigh: rules gave the session effort 62.

### Session at high

- 112 prompts judged; lowered 37/112 (33%).
- Under 6/112 (5%), exact 60/112 (54%), over 46/112 (41%).
- Steps saved 44 of the 92 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 5 | 16 | 9 |
| medium | 1 | 10 | 21 |
| high | 1 | 4 | 45 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| f-en-webhook | high | medium | ops 0.56: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |
| r-it-typescript-strict | high | medium | ops 0.84: -2 → low; underspecified 1.00: at least medium → medium |
| r-it-quick-rename | medium | low | question 0.37: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium; explicit_depth quick 0.82: low → low |
| d-it-queue-vs-cron | high | medium | ops 0.39: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |
| v-it-review-vaga | high | medium | question 0.71: -2 → low; underspecified 1.00: at least medium → medium |
| x-it-under-meglio | high | low | continue 0.50: previous → high; scope 2: +1 → xhigh; underspecified 1.00: at least medium → xhigh; explicit_depth quick 0.91: low → low |

Left at high: rules gave the session effort 75.

## Question hashes

| question | sha256 |
|---|---|
| task_kind | `847bff28cdeecb3dc7cea68c435540549fdf3c420ff05eb52d324793e71e5229` |
| scope | `4d36106b27a239a95893c7dadd29656b76a7106646e681d0ac8518457290ad13` |
| has_error_evidence | `4ad91934b1ba72ad415db3a727ef58e04e16cc038f5327d19a3b723ad7b8b944` |
| risky_irreversible | `1e60e31f3c81a2b358da8f7064ea26c523a0dc0a05869bcc63a37e029722cdea` |
| underspecified | `3c9a76b7afc055b3c06abd02b229df8856526ef2c6b15008b12e2f217ba023a0` |
| multi_deliverable | `daf14a028debe81a0911657b683893d1cad5fb5fe6114929ad1a2113e0494762` |
| explicit_depth | `91de79a4d8f43a94b1f979c285acece80544709b0b7c0eb7cd7b4315ad35e7be` |
