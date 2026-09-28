# Router measurement

- Date: 2026-09-28
- Backend: local, requested model `jev-latest`, declared model `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- Calibration profile: `spark-bf16-2026-09` (uncalibrated)
- Dataset: `bench/router-dev.jsonl`, 120 prompts, sha256 `325744cbf7baa1faeb53de769abdd3775e3abef8b1a133efb5a818b3f0ca3609`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.65 s, median 0.37 s, p95 0.44 s, max 0.65 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 88/120 (73%); mean p of the chosen option 0.777.

At min_top_probability 0.30: 118/120 (98%) classified, of which 86/118 (73%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 14 | · | · | · | · | 1 | · | · | · |
| small_edit | 3 | 8 | · | · | 1 | · | · | 2 | · |
| bug_with_error | 1 | · | 14 | · | · | · | · | · | · |
| feature | 2 | 2 | · | 10 | 1 | 2 | · | 1 | · |
| refactor | · | 1 | · | · | 8 | · | · | 1 | 1 |
| design | 2 | · | · | · | · | 7 | · | 1 | · |
| review | 4 | · | · | · | · | · | 7 | · | · |
| ops | 1 | · | · | · | 1 | · | · | 13 | 3 |
| continue | 1 | · | · | · | · | · | · | · | 7 |

### scope (score)

Accuracy 53/120 (44%); within one level 99/120 (83%).

- Rule level ≥ 2: TPR 38/48 (79%), FPR 25/72 (35%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 24 | 5 | 11 | 2 |
| 1 | 14 | 4 | 12 | · |
| 2 | 4 | 2 | 19 | 2 |
| 3 | 4 | · | 11 | 6 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 1.000 | 0.988 | 0.000 | 0.093 | 1.000 |

- At the configured threshold 0.60: TPR 13/13 (100%), FPR 0/107 (0%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 11 | 109 | 1.000 | 0.998 | 0.151 | 0.991 | 1.000 |

- At the configured threshold 0.50: TPR 11/11 (100%), FPR 12/109 (11%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.770 | 0.989 | 0.945 | 0.997 | 0.803 |

- At the configured threshold 0.60: TPR 16/16 (100%), FPR 100/104 (96%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 8 | 112 | 0.989 | 0.735 | 0.032 | 0.206 | 0.978 |

- At the configured threshold 0.60: TPR 6/8 (75%), FPR 2/112 (2%).

### explicit_depth (choice)

Accuracy 115/120 (96%); mean p of the chosen option 0.942.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 8 | · | 1 |
| thorough | · | 6 | 2 |
| none | 1 | 1 | 101 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 112 prompts judged; lowered 56/112 (50%).
- Under 3/112 (3%), exact 37/112 (33%), over 72/112 (64%).
- Steps saved 91 of the 193 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 6 | 12 | 8 | 4 |
| medium | 1 | 7 | 7 | 17 |
| high | · | 2 | 13 | 24 |
| xhigh | · | · | · | 11 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| f-it-skill-status | high | medium | question 0.53: -2 → medium; underspecified 0.99: at least medium → medium |
| r-it-quick-rename | medium | low | small_edit 0.64: -2 → medium; underspecified 0.94: at least medium → medium; explicit_depth quick 0.88: low → low |
| v-it-review-vaga | high | medium | question 0.89: -2 → medium; underspecified 1.00: at least medium → medium |

Left at xhigh: rules gave the session effort 54; uncertain classification 2.

### Session at high

- 112 prompts judged; lowered 46/112 (41%).
- Under 6/112 (5%), exact 65/112 (58%), over 41/112 (37%).
- Steps saved 53 of the 92 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 6 | 20 | 4 |
| medium | 1 | 14 | 17 |
| high | · | 5 | 45 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| f-it-skill-status | high | medium | question 0.53: -2 → low; underspecified 0.99: at least medium → medium |
| f-en-webhook | high | medium | small_edit 0.36: -2 → low; scope 2: +1 → medium; underspecified 0.99: at least medium → medium |
| r-it-quick-rename | medium | low | small_edit 0.64: -2 → low; underspecified 0.94: at least medium → medium; explicit_depth quick 0.88: low → low |
| d-it-queue-vs-cron | high | medium | ops 0.40: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |
| v-it-pr-42 | high | medium | question 0.62: -2 → low; scope 2: +1 → medium; underspecified 0.97: at least medium → medium |
| v-it-review-vaga | high | medium | question 0.89: -2 → low; underspecified 1.00: at least medium → medium |

Left at high: rules gave the session effort 64; uncertain classification 2.

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
