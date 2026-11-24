# Question measurement

- Date: 2026-11-24
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-flow-4b-bf16`
- Fingerprint: `bd4686b07f9c1b95c20fc1e7b84ce4f31a009e1279ccd3255ced653bb4f7c5bb`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout-2.jsonl`, 120 diffs, sha256 `fe8e2ced06f0e49f1785b1c6eda219960296c9022225a633b8198faa0be9480f`
- Variants: `bench/variants-holdout.json`, 10 questions, 10 variants, sha256 `0958a503180cd580a8a18911eaf8829f49b98d6b28be27e9da67951bf41ad911`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 240 (0 failed); median latency 0.59 s, p95 0.73 s; mean input tokens per request (usage) 1936

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
| hardcoded_secret | chunk state | attuale | `p` | 0.984 | 0.675 | 0.986 | 12 | 108 |
| injection_risk | chunk state | attuale | `1-p(none)` | 0.977 | 0.704 | 0.968 | 12 | 108 |
| touches_auth | chunk state | attuale | `p` | 0.949 | 0.724 | 0.924 | 15 | 105 |
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.990 | 0.789 | 0.968 | 12 | 108 |
| weakens_expected | chunk state | attuale | `1-p(none)` | 0.985 | 0.806 | 0.958 | 12 | 108 |
| adds_tests | global state | attuale | `1-p(none)` | 0.941 | 0.630 | 0.890 | 61 | 59 |
| breaks_api | chunk state | attuale | `1-p(none)` | 0.975 | 0.734 | 0.958 | 14 | 106 |
| data_migration | chunk state | attuale | `1-p(none)` | 0.949 | 0.811 | 0.968 | 11 | 109 |
| description_matches | global state | attuale | `p` | 0.687 | 0.152 | 0.718 | 12 | 108 |
| debug_leftovers | chunk state | attuale | `p` | 0.998 | 0.860 | 0.995 | 12 | 108 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.984** | 0.736 | 0.061 | 0.675 | 0.033 | 0.2053 | 0.986 | 0.903 | 12 | 108 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.977** | 0.973 | 0.269 | 0.704 | 0.145 | 0.9090 | 0.968 | 0.884 | 12 | 108 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.949** | 0.968 | 0.244 | 0.724 | 0.162 | 0.8162 | 0.924 | 0.886 | 15 | 105 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.990** | 0.948 | 0.159 | 0.789 | 0.070 | 0.6723 | 0.968 | 0.949 | 12 | 108 |

## weakens_expected

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.985** | 0.936 | 0.130 | 0.806 | 0.073 | 0.6619 | 0.958 | 0.935 | 12 | 108 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.941** | 0.925 | 0.295 | 0.630 | 0.108 | 0.4139 | 0.890 | 0.882 | 61 | 59 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.975** | 0.955 | 0.221 | 0.734 | 0.118 | 0.8064 | 0.958 | 0.915 | 14 | 106 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.949** | 0.935 | 0.124 | 0.811 | 0.072 | 0.8418 | 0.968 | 0.959 | 11 | 109 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.687** | 0.532 | 0.380 | 0.152 | 0.176 | 0.4673 | 0.718 | 0.657 | 12 | 108 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.998** | 0.982 | 0.122 | 0.860 | 0.066 | 0.9217 | 0.995 | 0.949 | 12 | 108 |

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
