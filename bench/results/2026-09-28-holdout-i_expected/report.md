# Question measurement

- Date: 2026-09-28
- Backend: `<tailnet host>:8443` (local; the Spark through Tailscale, host name removed), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout.jsonl`, 121 diffs, sha256 `3709183ce65aa67bda6ffae80cb5d14d7cc56a10c28f58968e44bcd2b40d7435`
- Variants: `bench/variants-holdout.json`, 9 questions, 9 variants, sha256 `6c2f405b16703458a681d3d3d4a8aa8af4947a39c99c5e44a83d635b6ef05914`
- Plugin configuration: checks.json sha256 `ea6dfbfba6cbe08a572da486cf8a2970908d545405b4f1aa384cdcaeeb2b5546`, policy.json sha256 `536d9c8126c4978a05774c1029076fe6a2e5b84b1e042be4b8ef09248a5b2986`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 242 (0 failed); median latency 0.43 s, p95 0.74 s; mean input tokens per request (usage) 1914

## How to read

- **p** is the probability that the label is true, that is, that the right answer to the question in "yes = problem" polarity is yes. The readout derives it from the answer: `p` = P(yes), `inverse` = 1 − P(yes) of a question written the other way round, `1-p(x)` = 1 − p of option x of a choice (or of level x of a score), `p(x)` = p of option x, `p(>=k)` = P(level ≥ k) of a score.
- Computed rows, not asked: `mean` = logit mean of a direct variant and its inverse (or of the variants of a combination), `max` = the maximum of the combined variants, `p × no test` = the variant's p, set to zero on diffs that contain a test file (`test_paths` in policy.json); `no test` = 1 on diffs without a test file and 0 on the others, i.e. the path rule without the model: it is the baseline to beat for `p × no test`.
- Raw values, no calibration. For questions on the chunk state, with several chunks the maximum counts, as in the reviewer.
- **AUROC**: probability that a positive diff has a higher p than a negative one (1 separates everything, 0.5 is chance, below 0.5 the question is reversed). It does not change with calibration.
- **Separation**: mean p on positives minus mean on negatives. **Brier**: mean squared error of p against the label (0 is perfect; always answering 0.5 scores 0.25).
- **Best threshold**: the threshold (yes from there up) with the highest balanced accuracy, at the logit midpoint between two p of the sample; "—" if no threshold beats chance. **Bal. acc.** is the mean of sensitivity and specificity.
- ★ marks the question's best variant (AUROC, then separation, then Brier).

## Summary

| question | state | best | readout | AUROC | separation | bal. acc. | n+ | n− |
|---|---|---|---|--:|--:|--:|--:|--:|
| hardcoded_secret | chunk state | attuale | `p` | 0.989 | 0.531 | 0.977 | 11 | 110 |
| injection_risk | chunk state | attuale | `1-p(none)` | 0.977 | 0.755 | 0.963 | 12 | 109 |
| touches_auth | chunk state | attuale | `p` | 0.969 | 0.739 | 0.936 | 14 | 107 |
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.992 | 0.794 | 0.977 | 12 | 109 |
| adds_tests | global state | attuale | `1-p(none)` | 0.937 | 0.731 | 0.892 | 60 | 61 |
| breaks_api | chunk state | attuale | `1-p(none)` | 0.901 | 0.649 | 0.878 | 16 | 105 |
| data_migration | chunk state | attuale | `1-p(none)` | 0.992 | 0.934 | 0.991 | 10 | 111 |
| description_matches | global state | attuale | `p` | 0.608 | 0.032 | 0.673 | 11 | 110 |
| debug_leftovers | chunk state | attuale | `p` | 0.966 | 0.777 | 0.941 | 11 | 110 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.989** | 0.557 | 0.026 | 0.531 | 0.034 | 0.0689 | 0.977 | 0.814 | 11 | 110 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.977** | 0.995 | 0.240 | 0.755 | 0.142 | 0.9613 | 0.963 | 0.899 | 12 | 109 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.969** | 0.794 | 0.055 | 0.739 | 0.056 | 0.2160 | 0.936 | 0.869 | 14 | 107 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.992** | 0.824 | 0.029 | 0.794 | 0.021 | 0.1708 | 0.977 | 0.912 | 12 | 109 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.937** | 0.823 | 0.091 | 0.731 | 0.097 | 0.1998 | 0.892 | 0.876 | 60 | 61 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.901** | 0.819 | 0.171 | 0.649 | 0.101 | 0.8372 | 0.878 | 0.849 | 16 | 105 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.992** | 0.993 | 0.060 | 0.934 | 0.036 | 0.9131 | 0.991 | 0.977 | 10 | 111 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.608** | 0.982 | 0.950 | 0.032 | 0.852 | 0.9990 | 0.673 | 0.527 | 11 | 110 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.966** | 0.849 | 0.072 | 0.777 | 0.033 | 0.5650 | 0.941 | 0.936 | 11 | 110 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| hardcoded_secret | attuale (checks.json) | noul | `8fcf8b054f63808c454c265895289150720668f8095d443c65fd3ee9999154a1` |
| injection_risk | attuale (checks.json) | choice | `f183376890c7c4e48a161454d6d7aa177f55af5a0aa6615a73889f208c0295fa` |
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
| weakens_tests | attuale (checks.json) | choice | `24071ad11d105afcf1310ee0f1e0f2421cf78d54a2d0631bf2dc0a2cb93e528a` |
| adds_tests | attuale (checks.json) | choice | `e637c7a92d249a84aa22fdc41f70e0039e4ccd7af7e658b5c54e6392389f4f63` |
| breaks_api | attuale (checks.json) | choice | `424250f372401bb7afe2851eac8c499cea5f610a993469b9381427e98e678c84` |
| data_migration | attuale (checks.json) | choice | `b6ce1888d300422fcce9d8432a3bf698d330dfb7892df3a30d621258584ecbbe` |
| description_matches | attuale (checks.json) | noul | `4948e612bee17e695a57e085b2f4f1205c470d1764a058eb92c023a076f8e445` |
| debug_leftovers | attuale (checks.json) | noul | `ffde6e476c0ecee5896c8acc96b4efb6a47b3a607b3539c3d2f3d9121b866b26` |
