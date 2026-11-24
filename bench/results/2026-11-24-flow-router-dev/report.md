# Router measurement

- Date: 2026-11-24
- Backend: local, requested model `jev-latest`, declared model `rizzo-flow-4b-bf16`
- Fingerprint: `bd4686b07f9c1b95c20fc1e7b84ce4f31a009e1279ccd3255ced653bb4f7c5bb`
- Calibration profile: `rizzo-provisional` (uncalibrated)
- Dataset: `bench/router-dev.jsonl`, 120 prompts, sha256 `325744cbf7baa1faeb53de769abdd3775e3abef8b1a133efb5a818b3f0ca3609`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.63 s, median 0.41 s, p95 0.49 s, max 0.63 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 97/120 (81%); mean p of the chosen option 0.414.

At min_top_probability 0.30: 102/120 (85%) classified, of which 91/102 (89%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 14 | · | · | · | · | 1 | · | · | · |
| small_edit | 3 | 10 | · | · | · | · | · | 1 | · |
| bug_with_error | · | 1 | 14 | · | · | · | · | · | · |
| feature | 1 | · | · | 13 | 1 | · | 1 | 2 | · |
| refactor | 1 | 1 | · | · | 8 | · | · | 1 | · |
| design | 3 | · | · | · | · | 7 | · | · | · |
| review | 1 | · | · | · | · | · | 10 | · | · |
| ops | 1 | · | · | · | 1 | · | · | 14 | 2 |
| continue | · | · | · | · | · | 1 | · | · | 7 |

### scope (score)

Accuracy 67/120 (56%); within one level 105/120 (88%).

- Rule level ≥ 2: TPR 29/48 (60%), FPR 8/72 (11%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 33 | 6 | 3 | · |
| 1 | 11 | 14 | 5 | · |
| 2 | 7 | 7 | 13 | · |
| 3 | 5 | · | 9 | 7 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 1.000 | 0.980 | 0.062 | 0.695 | 1.000 |

- At the configured threshold 0.60: TPR 13/13 (100%), FPR 0/107 (0%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 11 | 109 | 1.000 | 0.825 | 0.116 | 0.472 | 1.000 |

- At the configured threshold 0.50: TPR 9/11 (82%), FPR 0/109 (0%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.869 | 0.777 | 0.517 | 0.606 | 0.844 |

- At the configured threshold 0.60: TPR 15/16 (94%), FPR 29/104 (28%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 8 | 112 | 0.998 | 0.760 | 0.106 | 0.409 | 0.996 |

- At the configured threshold 0.60: TPR 6/8 (75%), FPR 0/112 (0%).

### explicit_depth (choice)

Accuracy 118/120 (98%); mean p of the chosen option 0.599.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 9 | · | · |
| thorough | · | 8 | · |
| none | 1 | 1 | 101 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 112 prompts judged; lowered 67/112 (60%).
- Under 6/112 (5%), exact 36/112 (32%), over 70/112 (63%).
- Steps saved 106 of the 193 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 6 | 16 | 3 | 5 |
| medium | 1 | 5 | 16 | 10 |
| high | · | 4 | 15 | 20 |
| xhigh | · | · | 1 | 10 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| r-it-typescript-strict | high | medium | ops 0.42: -2 → medium |
| r-it-quick-rename | medium | low | small_edit 0.31: -2 → medium; scope 2: +1 → high; explicit_depth quick 0.56: low → low |
| d-en-cache-strategy | xhigh | high | design 0.56: -1 → high |
| d-it-queue-vs-cron | high | medium | question 0.36: -2 → medium |
| x-it-revoke-tokens | high | medium | ops 0.49: -2 → medium |
| x-en-publish-npm | high | medium | ops 0.47: -2 → medium |

Left at xhigh: rules gave the session effort 29; uncertain classification 16.

### Session at high

- 112 prompts judged; lowered 59/112 (53%).
- Under 16/112 (14%), exact 77/112 (69%), over 19/112 (17%).
- Steps saved 88 of the 92 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 21 | 4 | 5 |
| medium | 4 | 18 | 10 |
| high | 4 | 8 | 38 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| q-it-how-cache-works | medium | low | question 0.50: -2 → low |
| q-it-perche-test-lento | medium | low | question 0.52: -2 → low |
| b-en-duplicate-key | high | medium | bug_with_error 0.45: -1 → medium; underspecified 0.70: at least medium → medium; has_error_evidence 0.99: at least medium → medium |
| b-en-flaky-ci | high | medium | bug_with_error 0.42: -1 → medium; has_error_evidence 0.98: at least medium → medium |
| b-it-errore-a-parole | high | medium | bug_with_error 0.37: -1 → medium; underspecified 0.66: at least medium → medium |
| f-en-feature-flag | high | medium | feature 0.45: -1 → medium; underspecified 0.97: at least medium → medium |
| r-it-split-config | high | medium | refactor 0.49: -1 → medium; underspecified 0.60: at least medium → medium |
| r-it-typescript-strict | high | low | ops 0.42: -2 → low |
| r-it-quick-rename | medium | low | small_edit 0.31: -2 → low; scope 2: +1 → medium; explicit_depth quick 0.56: low → low |
| d-en-cache-strategy | high | medium | design 0.56: -1 → medium |
| d-it-queue-vs-cron | high | low | question 0.36: -2 → low |
| d-it-schema-db | high | medium | design 0.49: -1 → medium |
| v-en-test-quality | medium | low | question 0.37: -2 → low |
| v-it-review-vaga | high | medium | review 0.40: -1 → medium; underspecified 0.82: at least medium → medium |
| x-it-revoke-tokens | high | low | ops 0.49: -2 → low |
| x-en-publish-npm | high | low | ops 0.47: -2 → low |

Left at high: rules gave the session effort 37; uncertain classification 16.

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
