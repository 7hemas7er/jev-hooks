# Router measurement

- Date: 2026-11-24
- Backend: local, requested model `jev-latest`, declared model `rizzo-flow-4b-bf16`
- Fingerprint: `bd4686b07f9c1b95c20fc1e7b84ce4f31a009e1279ccd3255ced653bb4f7c5bb`
- Calibration profile: `rizzo-flow-bf16-2026-11` (uncalibrated)
- Dataset: `bench/router-holdout.jsonl`, 120 prompts, sha256 `6367ba44c71f5ed126e9ef78f3676f78d9d23fd43f733e21af92e9ea81033ec3`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.49 s, median 0.42 s, p95 0.55 s, max 0.57 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 102/120 (85%); mean p of the chosen option 0.826.

At min_top_probability 0.30: 119/120 (99%) classified, of which 102/119 (86%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 13 | · | · | · | · | · | · | 1 | · |
| small_edit | 2 | 9 | · | · | 1 | · | · | · | · |
| bug_with_error | · | 2 | 13 | · | · | · | 1 | · | · |
| feature | 1 | 1 | · | 14 | · | · | · | 1 | · |
| refactor | 1 | · | · | · | 9 | · | · | · | · |
| design | 1 | · | · | · | · | 10 | · | · | · |
| review | · | · | · | · | · | 1 | 9 | 1 | · |
| ops | · | · | 1 | · | · | · | · | 16 | 2 |
| continue | 1 | · | · | · | · | · | · | · | 9 |

### scope (score)

Accuracy 76/120 (63%); within one level 109/120 (91%).

- Rule level ≥ 2: TPR 48/59 (81%), FPR 11/61 (18%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 27 | 6 | 6 | · |
| 1 | 2 | 15 | 5 | · |
| 2 | 1 | 6 | 22 | 1 |
| 3 | 3 | 1 | 13 | 12 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 15 | 105 | 1.000 | 0.976 | 0.067 | 0.942 | 1.000 |

- At the configured threshold 0.60: TPR 15/15 (100%), FPR 2/105 (2%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.975 | 0.686 | 0.138 | 0.231 | 0.947 |

- At the configured threshold 0.50: TPR 10/16 (63%), FPR 3/104 (3%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 0.812 | 0.735 | 0.504 | 0.566 | 0.760 |

- At the configured threshold 0.60: TPR 9/13 (69%), FPR 29/107 (27%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 0.947 | 0.640 | 0.130 | 0.225 | 0.901 |

- At the configured threshold 0.60: TPR 7/13 (54%), FPR 2/107 (2%).

### explicit_depth (choice)

Accuracy 117/120 (98%); mean p of the chosen option 0.888.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 12 | · | 1 |
| thorough | · | 11 | · |
| none | 1 | 1 | 94 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 110 prompts judged; lowered 67/110 (61%).
- Under 4/110 (4%), exact 46/110 (42%), over 60/110 (55%).
- Steps saved 110 of the 177 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 10 | 13 | 5 | · |
| medium | 1 | 4 | 12 | 7 |
| high | 1 | 2 | 19 | 23 |
| xhigh | · | · | · | 13 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h-it-prod-traceback-deploy | high | low | bug_with_error 0.49: -1 → high; has_error_evidence 0.99: at least medium → high; explicit_depth quick 0.77: low → low |
| h-en-rename-customer-quick | medium | low | refactor 0.82: -1 → high; scope 3: +1 → xhigh; explicit_depth quick 0.95: low → low |
| h-en-dependency-audit | high | medium | ops 0.75: -2 → medium; underspecified 0.81: at least medium → medium |
| h-it-pubblica-npm | high | medium | ops 0.82: -2 → medium |

Left at xhigh: rules gave the session effort 42; uncertain classification 1.

### Session at high

- 110 prompts judged; lowered 57/110 (52%).
- Under 16/110 (15%), exact 79/110 (72%), over 15/110 (14%).
- Steps saved 82 of the 80 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 21 | 6 | 1 |
| medium | 2 | 14 | 8 |
| high | 2 | 12 | 44 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h-it-duplicate-key-import | high | medium | bug_with_error 0.50: -1 → medium; has_error_evidence 0.99: at least medium → medium |
| h-it-prod-traceback-deploy | high | low | bug_with_error 0.49: -1 → medium; has_error_evidence 0.99: at least medium → medium; explicit_depth quick 0.77: low → low |
| h-it-autosave-gioco | high | medium | feature 0.99: -1 → medium |
| h-en-deploy-confirm-prompt | medium | low | small_edit 0.53: -2 → low |
| h-it-split-utenti | high | medium | refactor 0.99: -1 → medium |
| h-en-rename-customer-quick | medium | low | refactor 0.82: -1 → medium; scope 3: +1 → high; explicit_depth quick 0.95: low → low |
| h-en-last-3-commits | high | medium | review 0.92: -1 → medium; underspecified 0.71: at least medium → medium |
| h-it-login-sicurezza | high | medium | review 0.83: -1 → medium |
| h-it-idee-performance | high | medium | design 0.51: -1 → medium; underspecified 0.92: at least medium → medium |
| h-en-dependency-audit | high | medium | ops 0.75: -2 → low; underspecified 0.81: at least medium → medium |
| h-it-ruota-chiave-pagamenti | high | medium | ops 0.43: -2 → low; scope 2: +1 → medium |
| h-en-restart-prod-workers | high | medium | ops 0.98: -2 → low; scope 2: +1 → medium |
| h-it-cancella-branch-remoti | high | medium | ops 0.90: -2 → low; scope 2: +1 → medium |
| h-it-pubblica-npm | high | low | ops 0.82: -2 → low |
| h-en-staging-deploy-slow | high | medium | ops 0.82: -2 → low; scope 2: +1 → medium |
| h-en-deps-release-branch | high | medium | ops 0.98: -2 → low; scope 2: +1 → medium |

Left at high: rules gave the session effort 52; uncertain classification 1.

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
