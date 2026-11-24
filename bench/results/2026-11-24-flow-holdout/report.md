# Question measurement

- Date: 2026-11-24
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-flow-4b-bf16`
- Fingerprint: `bd4686b07f9c1b95c20fc1e7b84ce4f31a009e1279ccd3255ced653bb4f7c5bb`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout.jsonl`, 121 diffs, sha256 `3709183ce65aa67bda6ffae80cb5d14d7cc56a10c28f58968e44bcd2b40d7435`
- Variants: `bench/variants-holdout.json`, 10 questions, 10 variants, sha256 `0958a503180cd580a8a18911eaf8829f49b98d6b28be27e9da67951bf41ad911`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 242 (0 failed); median latency 0.62 s, p95 0.86 s; mean input tokens per request (usage) 2055

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
| hardcoded_secret | chunk state | attuale | `p` | 0.993 | 0.793 | 0.991 | 11 | 110 |
| injection_risk | chunk state | attuale | `1-p(none)` | 0.968 | 0.670 | 0.935 | 12 | 109 |
| touches_auth | chunk state | attuale | `p` | 0.959 | 0.740 | 0.921 | 14 | 107 |
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.995 | 0.787 | 0.991 | 12 | 109 |
| weakens_expected | chunk state | attuale | `1-p(none)` | 0.994 | 0.860 | 0.991 | 12 | 109 |
| adds_tests | global state | attuale | `1-p(none)` | 0.949 | 0.589 | 0.901 | 60 | 61 |
| breaks_api | chunk state | attuale | `1-p(none)` | 0.924 | 0.627 | 0.899 | 16 | 105 |
| data_migration | chunk state | attuale | `1-p(none)` | 0.981 | 0.853 | 0.982 | 10 | 111 |
| description_matches | global state | attuale | `p` | 0.847 | 0.265 | 0.782 | 11 | 110 |
| debug_leftovers | chunk state | attuale | `p` | 0.981 | 0.771 | 0.950 | 11 | 110 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.993** | 0.839 | 0.046 | 0.793 | 0.018 | 0.1985 | 0.991 | 0.905 | 11 | 110 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.968** | 0.956 | 0.286 | 0.670 | 0.161 | 0.9436 | 0.935 | 0.881 | 12 | 109 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.959** | 0.925 | 0.186 | 0.740 | 0.112 | 0.4603 | 0.921 | 0.890 | 14 | 107 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.995** | 0.943 | 0.156 | 0.787 | 0.059 | 0.7855 | 0.991 | 0.954 | 12 | 109 |

## weakens_expected

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.994** | 0.963 | 0.103 | 0.860 | 0.043 | 0.7536 | 0.991 | 0.968 | 12 | 109 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.949** | 0.909 | 0.320 | 0.589 | 0.122 | 0.9367 | 0.901 | 0.852 | 60 | 61 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.924** | 0.881 | 0.254 | 0.627 | 0.151 | 0.8668 | 0.899 | 0.828 | 16 | 105 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.981** | 0.941 | 0.087 | 0.853 | 0.045 | 0.8285 | 0.982 | 0.968 | 10 | 111 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.847** | 0.593 | 0.328 | 0.265 | 0.134 | 0.5259 | 0.782 | 0.745 | 11 | 110 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.981** | 0.916 | 0.145 | 0.771 | 0.050 | 0.8509 | 0.950 | 0.927 | 11 | 110 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| hardcoded_secret | attuale (checks.json) | noul | `8fcf8b054f63808c454c265895289150720668f8095d443c65fd3ee9999154a1` |
| injection_risk | attuale (checks.json) | choice | `f183376890c7c4e48a161454d6d7aa177f55af5a0aa6615a73889f208c0295fa` |
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
| weakens_tests | attuale (checks.json) | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_expected | attuale (checks.json) | choice | `24071ad11d105afcf1310ee0f1e0f2421cf78d54a2d0631bf2dc0a2cb93e528a` |
| adds_tests | attuale (checks.json) | choice | `e637c7a92d249a84aa22fdc41f70e0039e4ccd7af7e658b5c54e6392389f4f63` |
| breaks_api | attuale (checks.json) | choice | `424250f372401bb7afe2851eac8c499cea5f610a993469b9381427e98e678c84` |
| data_migration | attuale (checks.json) | choice | `b6ce1888d300422fcce9d8432a3bf698d330dfb7892df3a30d621258584ecbbe` |
| description_matches | attuale (checks.json) | noul | `4948e612bee17e695a57e085b2f4f1205c470d1764a058eb92c023a076f8e445` |
| debug_leftovers | attuale (checks.json) | noul | `ffde6e476c0ecee5896c8acc96b4efb6a47b3a607b3539c3d2f3d9121b866b26` |
