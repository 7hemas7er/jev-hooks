# Question measurement

- Date: 2026-11-24
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout-2.jsonl`, 120 diffs, sha256 `fe8e2ced06f0e49f1785b1c6eda219960296c9022225a633b8198faa0be9480f`
- Variants: `bench/variants-holdout.json`, 10 questions, 10 variants, sha256 `0958a503180cd580a8a18911eaf8829f49b98d6b28be27e9da67951bf41ad911`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 240 (0 failed); median latency 0.47 s, p95 0.71 s; mean input tokens per request (usage) 1936

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
| hardcoded_secret | chunk state | attuale | `p` | 0.942 | 0.351 | 0.912 | 12 | 108 |
| injection_risk | chunk state | attuale | `1-p(none)` | 0.968 | 0.759 | 0.944 | 12 | 108 |
| touches_auth | chunk state | attuale | `p` | 0.960 | 0.841 | 0.952 | 15 | 105 |
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.990 | 0.863 | 0.977 | 12 | 108 |
| weakens_expected | chunk state | attuale | `1-p(none)` | 0.979 | 0.833 | 0.944 | 12 | 108 |
| adds_tests | global state | attuale | `1-p(none)` | 0.917 | 0.687 | 0.891 | 61 | 59 |
| breaks_api | chunk state | attuale | `1-p(none)` | 0.969 | 0.703 | 0.906 | 14 | 106 |
| data_migration | chunk state | attuale | `1-p(none)` | 0.961 | 0.885 | 0.963 | 11 | 109 |
| description_matches | global state | attuale | `p` | 0.426 | -0.003 | 0.532 | 12 | 108 |
| debug_leftovers | chunk state | attuale | `p` | 0.997 | 0.880 | 0.991 | 12 | 108 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.942** | 0.391 | 0.040 | 0.351 | 0.063 | 0.0631 | 0.912 | 0.653 | 12 | 108 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.968** | 0.958 | 0.199 | 0.759 | 0.118 | 0.7172 | 0.944 | 0.926 | 12 | 108 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.960** | 0.947 | 0.106 | 0.841 | 0.082 | 0.5659 | 0.952 | 0.948 | 15 | 105 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.990** | 0.944 | 0.081 | 0.863 | 0.034 | 0.3278 | 0.977 | 0.940 | 12 | 108 |

## weakens_expected

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.979** | 0.882 | 0.049 | 0.833 | 0.036 | 0.6889 | 0.944 | 0.940 | 12 | 108 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.917** | 0.816 | 0.129 | 0.687 | 0.117 | 0.1755 | 0.891 | 0.851 | 61 | 59 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.969** | 0.900 | 0.196 | 0.703 | 0.099 | 0.4248 | 0.906 | 0.889 | 14 | 106 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.961** | 0.977 | 0.091 | 0.885 | 0.070 | 0.6693 | 0.963 | 0.959 | 11 | 109 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.426** | 0.978 | 0.982 | -0.003 | 0.874 | 0.9999 | 0.532 | 0.505 | 12 | 108 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.997** | 0.953 | 0.073 | 0.880 | 0.033 | 0.7241 | 0.991 | 0.972 | 12 | 108 |

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
