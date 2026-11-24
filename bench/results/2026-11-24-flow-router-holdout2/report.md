# Router measurement

- Date: 2026-11-24
- Backend: local, requested model `jev-latest`, declared model `rizzo-flow-4b-bf16`
- Fingerprint: `bd4686b07f9c1b95c20fc1e7b84ce4f31a009e1279ccd3255ced653bb4f7c5bb`
- Calibration profile: `rizzo-provisional` (uncalibrated)
- Dataset: `bench/router-holdout-2.jsonl`, 120 prompts, sha256 `b6ce8d9a09c4e2811661d792b42ff7ec71f30b0390583ae4953c7e3b4fbb4571`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.36 s, median 0.33 s, p95 0.36 s, max 0.37 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 102/120 (85%); mean p of the chosen option 0.399.

At min_top_probability 0.30: 99/120 (83%) classified, of which 92/99 (93%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 13 | · | 1 | · | · | · | · | · | · |
| small_edit | · | 9 | 1 | · | · | · | 1 | 1 | · |
| bug_with_error | · | · | 16 | · | · | · | · | · | · |
| feature | · | · | · | 14 | · | · | 1 | · | · |
| refactor | · | · | · | 1 | 8 | · | · | 1 | · |
| design | 1 | · | · | · | 1 | 8 | · | · | · |
| review | 2 | · | · | · | · | · | 10 | · | · |
| ops | 1 | 1 | · | · | · | · | 1 | 17 | 1 |
| continue | · | · | · | · | · | · | · | 3 | 7 |

### scope (score)

Accuracy 60/120 (50%); within one level 107/120 (89%).

- Rule level ≥ 2: TPR 56/63 (89%), FPR 19/57 (33%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 12 | 11 | 9 | · |
| 1 | 1 | 14 | 10 | · |
| 2 | 2 | 3 | 26 | 4 |
| 3 | 1 | 1 | 18 | 8 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 1.000 | 0.957 | 0.086 | 0.777 | 1.000 |

- At the configured threshold 0.60: TPR 16/16 (100%), FPR 1/104 (1%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 20 | 100 | 0.921 | 0.634 | 0.165 | 0.267 | 0.915 |

- At the configured threshold 0.50: TPR 12/20 (60%), FPR 4/100 (4%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.746 | 0.654 | 0.515 | 0.569 | 0.719 |

- At the configured threshold 0.60: TPR 8/16 (50%), FPR 35/104 (34%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.940 | 0.771 | 0.205 | 0.362 | 0.897 |

- At the configured threshold 0.60: TPR 12/16 (75%), FPR 6/104 (6%).

### explicit_depth (choice)

Accuracy 111/120 (93%); mean p of the chosen option 0.559.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 9 | · | 3 |
| thorough | · | 11 | 1 |
| none | 1 | 4 | 91 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 110 prompts judged; lowered 46/110 (42%).
- Under 5/110 (5%), exact 31/110 (28%), over 74/110 (67%).
- Steps saved 72 of the 175 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 4 | 9 | 6 | 9 |
| medium | 1 | 2 | 9 | 11 |
| high | 1 | 3 | 11 | 30 |
| xhigh | · | · | · | 14 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h2it-s-prezzo-prod | high | medium | small_edit 0.50: -2 → medium |
| h2it-f-delega-ritiro | high | low | feature 0.54: -1 → high; scope 2: +1 → xhigh; explicit_depth quick 0.53: low → low |
| h2it-rv-diff-resi | medium | low | question 0.41: -2 → medium; explicit_depth quick 0.53: low → low |
| h2it-o-flag-rate | high | medium | ops 0.47: -2 → medium |
| h2en-slow-why | high | medium | question 0.56: -2 → medium; underspecified 0.66: at least medium → medium |

Left at xhigh: rules gave the session effort 44; uncertain classification 20.

### Session at high

- 110 prompts judged; lowered 38/110 (35%).
- Under 11/110 (10%), exact 71/110 (65%), over 28/110 (25%).
- Steps saved 55 of the 79 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 11 | 7 | 10 |
| medium | 3 | 9 | 11 |
| high | 3 | 5 | 51 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h2it-s-prezzo-prod | high | low | small_edit 0.50: -2 → low |
| h2it-f-delega-ritiro | high | low | feature 0.54: -1 → medium; scope 2: +1 → high; explicit_depth quick 0.53: low → low |
| h2it-r-dividi-fatturazione | high | medium | refactor 0.32: -1 → medium |
| h2it-rv-diff-resi | medium | low | question 0.41: -2 → low; explicit_depth quick 0.53: low → low |
| h2it-o-flag-rate | high | low | ops 0.47: -2 → low |
| h2en-deadlock-log | high | medium | question 0.39: -2 → low; scope 2: +1 → medium; underspecified 0.63: at least medium → medium; has_error_evidence 0.99: at least medium → medium |
| h2en-slow-why | high | medium | question 0.56: -2 → low; underspecified 0.66: at least medium → medium |
| h2en-drop-legacy-review | medium | low | question 0.32: -2 → low |
| h2en-video-in-history | high | medium | ops 0.53: -2 → low; scope 2: +1 → medium |
| h2en-redis-flush | high | medium | ops 0.45: -2 → low; scope 2: +1 → medium |
| h2en-tf-plan | medium | low | ops 0.40: -2 → low |

Left at high: rules gave the session effort 52; uncertain classification 20.

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
