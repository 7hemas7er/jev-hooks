# Router measurement

- Date: 2026-11-24
- Backend: local, requested model `jev-latest`, declared model `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- Calibration profile: `spark-bf16-2026-09` (uncalibrated)
- Dataset: `bench/router-holdout-2.jsonl`, 120 prompts, sha256 `b6ce8d9a09c4e2811661d792b42ff7ec71f30b0390583ae4953c7e3b4fbb4571`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.36 s, median 0.33 s, p95 0.36 s, max 0.38 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 96/120 (80%); mean p of the chosen option 0.781.

At min_top_probability 0.30: 120/120 (100%) classified, of which 96/120 (80%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 13 | · | 1 | · | · | · | · | · | · |
| small_edit | 1 | 9 | · | · | · | · | · | 2 | · |
| bug_with_error | 2 | · | 14 | · | · | · | · | · | · |
| feature | · | · | 1 | 14 | · | · | · | · | · |
| refactor | · | · | · | 1 | 7 | 1 | · | 1 | · |
| design | 2 | · | · | · | · | 8 | · | · | · |
| review | 2 | · | · | · | · | 1 | 8 | 1 | · |
| ops | · | 3 | · | · | · | · | · | 15 | 3 |
| continue | 1 | · | · | · | · | · | · | 1 | 8 |

### scope (score)

Accuracy 61/120 (51%); within one level 104/120 (87%).

- Rule level ≥ 2: TPR 60/63 (95%), FPR 27/57 (47%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 13 | 5 | 14 | · |
| 1 | 2 | 10 | 12 | 1 |
| 2 | 1 | 2 | 31 | 1 |
| 3 | · | · | 21 | 7 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 1.000 | 0.827 | 0.000 | 0.048 | 1.000 |

- At the configured threshold 0.60: TPR 12/16 (75%), FPR 0/104 (0%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 20 | 100 | 0.957 | 0.904 | 0.196 | 0.533 | 0.885 |

- At the configured threshold 0.50: TPR 19/20 (95%), FPR 19/100 (19%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.557 | 0.989 | 0.950 | 0.990 | 0.599 |

- At the configured threshold 0.60: TPR 16/16 (100%), FPR 101/104 (97%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.931 | 0.808 | 0.101 | 0.461 | 0.894 |

- At the configured threshold 0.60: TPR 12/16 (75%), FPR 6/104 (6%).

### explicit_depth (choice)

Accuracy 107/120 (89%); mean p of the chosen option 0.905.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 3 | · | 9 |
| thorough | · | 11 | 1 |
| none | · | 3 | 93 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 110 prompts judged; lowered 49/110 (45%).
- Under 2/110 (2%), exact 33/110 (30%), over 75/110 (68%).
- Steps saved 65 of the 175 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 1 | 9 | 10 | 8 |
| medium | 1 | 2 | 9 | 11 |
| high | · | 1 | 16 | 28 |
| xhigh | · | · | · | 14 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h2it-s-prezzo-prod | high | medium | small_edit 0.93: -2 → medium; underspecified 0.81: at least medium → medium |
| h2it-rv-diff-resi | medium | low | question 0.84: -2 → medium; scope 2: +1 → high; underspecified 0.99: at least medium → high; explicit_depth quick 0.79: low → low |

Left at xhigh: rules gave the session effort 61.

### Session at high

- 110 prompts judged; lowered 32/110 (29%).
- Under 5/110 (5%), exact 66/110 (60%), over 39/110 (35%).
- Steps saved 34 of the 79 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 1 | 16 | 11 |
| medium | 1 | 10 | 12 |
| high | · | 4 | 55 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h2it-s-prezzo-prod | high | medium | small_edit 0.93: -2 → low; underspecified 0.81: at least medium → medium |
| h2it-b-esportazione-rotta | high | medium | question 0.92: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |
| h2it-r-dividi-fatturazione | high | medium | refactor 0.86: -1 → medium; underspecified 1.00: at least medium → medium |
| h2it-rv-diff-resi | medium | low | question 0.84: -2 → low; scope 2: +1 → medium; underspecified 0.99: at least medium → medium; explicit_depth quick 0.79: low → low |
| h2en-slow-why | high | medium | question 0.95: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |

Left at high: rules gave the session effort 78.

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
