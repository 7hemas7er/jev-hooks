# Router measurement

- Date: 2026-09-28
- Backend: local, requested model `jev-latest`, declared model `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- Calibration profile: `spark-bf16-2026-09` (uncalibrated)
- Dataset: `bench/router-holdout.jsonl`, 120 prompts, sha256 `6367ba44c71f5ed126e9ef78f3676f78d9d23fd43f733e21af92e9ea81033ec3`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.57 s, median 0.37 s, p95 0.46 s, max 0.57 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 101/120 (84%); mean p of the chosen option 0.797.

At min_top_probability 0.30: 119/120 (99%) classified, of which 101/119 (85%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 12 | · | · | · | · | · | · | 2 | · |
| small_edit | 2 | 9 | · | · | 1 | · | · | · | · |
| bug_with_error | 1 | · | 15 | · | · | · | · | · | · |
| feature | · | 1 | · | 13 | · | · | · | 3 | · |
| refactor | 1 | 1 | · | · | 8 | · | · | · | · |
| design | · | · | · | · | 1 | 10 | · | · | · |
| review | 1 | · | · | · | · | · | 9 | 1 | · |
| ops | · | 1 | · | · | 1 | · | · | 16 | 1 |
| continue | 1 | · | · | · | · | · | · | · | 9 |

### scope (score)

Accuracy 63/120 (53%); within one level 96/120 (80%).

- Rule level ≥ 2: TPR 47/59 (80%), FPR 24/61 (39%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 23 | 2 | 12 | 2 |
| 1 | 5 | 7 | 10 | · |
| 2 | 7 | 2 | 20 | 1 |
| 3 | 2 | 1 | 13 | 13 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 15 | 105 | 0.998 | 0.933 | 0.010 | 0.002 | 0.986 |

- At the configured threshold 0.60: TPR 14/15 (93%), FPR 1/105 (1%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.982 | 0.979 | 0.144 | 0.755 | 0.966 |

- At the configured threshold 0.50: TPR 16/16 (100%), FPR 13/104 (13%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 0.536 | 0.966 | 0.932 | 0.999 | 0.598 |

- At the configured threshold 0.60: TPR 13/13 (100%), FPR 101/107 (94%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 0.851 | 0.562 | 0.067 | 0.064 | 0.819 |

- At the configured threshold 0.60: TPR 7/13 (54%), FPR 7/107 (7%).

### explicit_depth (choice)

Accuracy 116/120 (97%); mean p of the chosen option 0.927.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 11 | · | 2 |
| thorough | · | 10 | 1 |
| none | · | 1 | 95 |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 110 prompts judged; lowered 59/110 (54%).
- Under 1/110 (1%), exact 44/110 (40%), over 65/110 (59%).
- Steps saved 90 of the 177 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | 8 | 9 | 8 | 3 |
| medium | 1 | 4 | 10 | 9 |
| high | · | · | 19 | 26 |
| xhigh | · | · | · | 13 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h-en-rename-customer-quick | medium | low | refactor 0.57: 0 → xhigh; scope 3: +1 → max; underspecified 0.99: at least medium → max; explicit_depth quick 0.95: low → low |

Left at xhigh: rules gave the session effort 50; uncertain classification 1.

### Session at high

- 110 prompts judged; lowered 43/110 (39%).
- Under 8/110 (7%), exact 72/110 (65%), over 30/110 (27%).
- Steps saved 52 of the 80 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | 8 | 14 | 6 |
| medium | 1 | 13 | 10 |
| high | · | 7 | 51 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| h-it-grafico-non-aggiorna | high | medium | question 0.55: -2 → low; scope 2: +1 → medium; underspecified 1.00: at least medium → medium |
| h-en-dark-mode | high | medium | feature 0.90: -1 → medium; underspecified 1.00: at least medium → medium |
| h-it-costanti-config | high | medium | small_edit 0.47: -2 → low; scope 2: +1 → medium; underspecified 0.94: at least medium → medium |
| h-en-rename-customer-quick | medium | low | refactor 0.57: 0 → high; scope 3: +1 → xhigh; underspecified 0.99: at least medium → xhigh; explicit_depth quick 0.95: low → low |
| h-it-login-sicurezza | high | medium | review 0.93: -1 → medium; underspecified 0.99: at least medium → medium |
| h-it-idee-performance | high | medium | question 0.83: -2 → low; scope 2: +1 → medium; underspecified 0.99: at least medium → medium |
| h-en-dependency-audit | high | medium | ops 0.69: -2 → low; scope 3: +1 → medium; underspecified 1.00: at least medium → medium |
| h-en-staging-deploy-slow | high | medium | ops 0.95: -2 → low; scope 3: +1 → medium; underspecified 1.00: at least medium → medium |

Left at high: rules gave the session effort 66; uncertain classification 1.

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
