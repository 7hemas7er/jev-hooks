# Router measurement

- Date: 2026-09-29
- Backend: local, requested model `clm-latest`, declared model `clm-latest`
- Fingerprint: `?`
- Calibration profile: `clm-provisional` (uncalibrated)
- Dataset: `bench/router-dev.jsonl`, 120 prompts, sha256 `325744cbf7baa1faeb53de769abdd3775e3abef8b1a133efb5a818b3f0ca3609`
- Router configuration: `config/router.json (plugin)`
- Answers: 120 of 120 requests (0 failed or discarded)
- Latency: first request 0.49 s, median 0.26 s, p95 0.34 s, max 0.49 s; 0/120 (0%) above timeout_ms (1500 ms), which the hook would drop

## Questions

### task_kind (choice)

Accuracy 24/120 (20%); mean p of the chosen option 0.627.

At min_top_probability 0.30: 119/120 (99%) classified, of which 24/119 (20%) right.

| label \ answer | question | small_edit | bug_with_error | feature | refactor | design | review | ops | continue |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| question | 1 | · | 5 | · | · | 9 | · | · | · |
| small_edit | 3 | · | 10 | · | · | 1 | · | · | · |
| bug_with_error | · | · | 15 | · | · | · | · | · | · |
| feature | 1 | · | 13 | · | · | 4 | · | · | · |
| refactor | 1 | · | 7 | · | · | 3 | · | · | · |
| design | · | · | 5 | · | · | 4 | · | · | 1 |
| review | 3 | · | 5 | · | · | 3 | · | · | · |
| ops | 2 | · | 11 | · | · | 4 | · | · | 1 |
| continue | · | · | 3 | · | · | 1 | · | · | 4 |

### scope (score)

Accuracy 45/120 (38%); within one level 75/120 (63%).

- Rule level ≥ 2: TPR 5/48 (10%), FPR 3/72 (4%).

| label \ answer | 0 | 1 | 2 | 3 |
|---|--:|--:|--:|--:|
| 0 | 41 | · | · | 1 |
| 1 | 28 | · | 1 | 1 |
| 2 | 24 | · | 2 | 1 |
| 3 | 19 | · | · | 2 |

### has_error_evidence (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 13 | 107 | 0.522 | 0.916 | 0.957 | 0.986 | 0.616 |

- At the configured threshold 0.60: TPR 13/13 (100%), FPR 107/107 (100%).

### risky_irreversible (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 11 | 109 | 0.672 | 0.994 | 0.994 | 0.998 | 0.671 |

- At the configured threshold 0.50: TPR 11/11 (100%), FPR 109/109 (100%).

### underspecified (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 16 | 104 | 0.635 | 0.016 | 0.018 | 0.011 | 0.671 |

- At the configured threshold 0.60: TPR 0/16 (0%), FPR 0/104 (0%).

### multi_deliverable (noul)

| n+ | n− | AUROC | mean + | mean − | best threshold | bal. acc. at best |
|--:|--:|--:|--:|--:|--:|--:|
| 8 | 112 | 0.877 | 0.913 | 0.659 | 0.869 | 0.844 |

- At the configured threshold 0.60: TPR 8/8 (100%), FPR 67/112 (60%).

### explicit_depth (choice)

Accuracy 11/120 (9%); mean p of the chosen option 0.804.

| label \ answer | quick | thorough | none |
|---|--:|--:|--:|
| quick | 9 | · | · |
| thorough | 6 | 2 | · |
| none | 91 | 12 | · |

## Effort, end to end

The labelled effort is the lowest one that still does the job well; with a session at a lower effort the ideal is capped there, because the router only lowers. **Under** means the router went below the ideal (the risk: a worse answer); **over** means it stayed above (a missed saving, never a loss of quality). Confirmations have no labelled effort and are left out.

### Session at xhigh

- 112 prompts judged; lowered 97/112 (87%).
- Under 9/112 (8%), exact 36/112 (32%), over 67/112 (60%).
- Steps saved 97 of the 193 the labels allow.

| ideal \ chosen | low | medium | high | xhigh |
|---|--:|--:|--:|--:|
| low | · | · | 28 | 2 |
| medium | · | · | 26 | 6 |
| high | · | · | 34 | 5 |
| xhigh | · | · | 9 | 2 |

Under the ideal:

| prompt | ideal | chosen | trace |
|---|---|---|---|
| b-en-dead-letter | xhigh | high | bug_with_error 0.87: 0 → xhigh; has_error_evidence 1.00: at least medium → xhigh; explicit_depth quick 0.94: low → low; floor risky_irreversible 0.99 → high |
| b-it-memory-leak | xhigh | high | bug_with_error 0.83: 0 → xhigh; has_error_evidence 0.96: at least medium → xhigh; explicit_depth quick 0.63: low → low; floor risky_irreversible 0.98 → high |
| r-it-migrazione-esm | xhigh | high | design 0.55: 0 → xhigh; has_error_evidence 0.90: at least medium → xhigh; explicit_depth quick 0.91: low → low; floor risky_irreversible 0.98 → high |
| r-en-db-layer | xhigh | high | bug_with_error 0.56: 0 → xhigh; scope 3: +1 → max; multi_deliverable 0.91: +1 → max; has_error_evidence 0.95: at least medium → max; explicit_depth quick 0.80: low → low; floor risky_irreversible 1.00 → high |
| d-it-architettura-router | xhigh | high | design 0.90: 0 → xhigh; multi_deliverable 0.78: +1 → max; has_error_evidence 0.94: at least medium → max; explicit_depth quick 0.81: low → low; floor risky_irreversible 0.99 → high |
| d-en-cache-strategy | xhigh | high | design 0.92: 0 → xhigh; multi_deliverable 0.81: +1 → max; has_error_evidence 0.98: at least medium → max; explicit_depth quick 0.48: low → low; floor risky_irreversible 0.98 → high |
| d-it-multi-tenant | xhigh | high | design 0.89: 0 → xhigh; multi_deliverable 0.84: +1 → max; has_error_evidence 0.86: at least medium → max; explicit_depth quick 0.80: low → low; floor risky_irreversible 0.89 → high |
| d-it-security-model | xhigh | high | bug_with_error 0.38: 0 → xhigh; multi_deliverable 0.64: +1 → max; has_error_evidence 0.99: at least medium → max; explicit_depth quick 0.83: low → low; floor risky_irreversible 1.00 → high |
| v-it-audit-sicurezza | xhigh | high | bug_with_error 0.38: 0 → xhigh; multi_deliverable 0.66: +1 → max; has_error_evidence 0.93: at least medium → max; explicit_depth quick 0.85: low → low; floor risky_irreversible 0.99 → high |

Left at xhigh: rules gave the session effort 14; uncertain classification 1.

### Session at high

- 112 prompts judged; lowered 0/112 (0%).
- Under 0/112 (0%), exact 50/112 (45%), over 62/112 (55%).
- Steps saved 0 of the 92 the labels allow.

| ideal \ chosen | low | medium | high |
|---|--:|--:|--:|
| low | · | · | 30 |
| medium | · | · | 32 |
| high | · | · | 50 |

Left at high: rules gave the session effort 111; uncertain classification 1.

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
