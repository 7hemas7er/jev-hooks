# Question measurement

- Date: 2026-11-24
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants.json`, 9 questions, 44 variants, sha256 `544e6ee4f6f6379e77892730d6c58b408bc78628b50b44f988d1b74020ad23bb`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 236 (0 failed); median latency 1.35 s, p95 2.33 s; mean input tokens per request (usage) 6078

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
| injection_risk | chunk state | c_scelta | `1-p(none)` | 1.000 | 0.865 | 1.000 | 8 | 110 |
| breaks_api | chunk state | a_letterale + d_inversa | `mean` | 0.940 | 0.557 | 0.879 | 12 | 106 |
| debug_leftovers | chunk state | b_esempi | `p` | 0.995 | 0.465 | 0.991 | 8 | 110 |
| data_migration | chunk state | c_scelta | `1-p(none)` | 1.000 | 0.975 | 1.000 | 7 | 111 |
| adds_tests | global state | attuale | `1-p(none)` | 0.964 | 0.716 | 0.906 | 77 | 41 |
| description_matches | global state | a_letterale + d_inversa | `mean` | 0.662 | 0.169 | 0.668 | 9 | 109 |
| weakens_tests | chunk state | a_letterale + d_inversa | `mean` | 1.000 | 0.094 | 1.000 | 9 | 109 |
| hardcoded_secret | chunk state | attuale | `p` | 0.925 | 0.702 | 0.903 | 9 | 109 |
| touches_auth | chunk state | attuale | `p` | 0.980 | 0.667 | 0.977 | 10 | 108 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **c_scelta** | `1-p(none)` | **1.000** | 1.000 | 0.134 | 0.865 | 0.076 | 0.9978 | 1.000 | 0.959 | 8 | 110 |
|  | attuale | `1-p(none)` | 1.000 | 1.000 | 0.135 | 0.864 | 0.077 | 0.9978 | 1.000 | 0.959 | 8 | 110 |
|  | c_scelta_due_ordini | `mean` | 0.989 | 0.900 | 0.042 | 0.858 | 0.026 | 0.6180 | 0.986 | 0.982 | 8 | 110 |
|  | c_scelta_none_ultima | `1-p(none)` | 0.964 | 0.315 | 0.012 | 0.304 | 0.048 | 0.0014 | 0.955 | 0.620 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.963 | 0.646 | 0.058 | 0.587 | 0.028 | 0.0833 | 0.905 | 0.808 | 8 | 110 |
|  | d_inversa | `inverse` | 0.940 | 0.906 | 0.409 | 0.496 | 0.228 | 0.8247 | 0.887 | 0.832 | 8 | 110 |
|  | a_letterale | `p` | 0.928 | 0.508 | 0.010 | 0.497 | 0.038 | 0.0154 | 0.924 | 0.745 | 8 | 110 |
|  | b_esempi | `p` | 0.918 | 0.782 | 0.206 | 0.576 | 0.100 | 0.8798 | 0.861 | 0.816 | 8 | 110 |
|  | it_esempi | `p` | 0.752 | 0.334 | 0.173 | 0.161 | 0.077 | 0.2686 | 0.717 | 0.607 | 8 | 110 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale + d_inversa** | `mean` | **0.940** | 0.903 | 0.346 | 0.557 | 0.182 | 0.8236 | 0.879 | 0.817 | 12 | 106 |
|  | a_letterale | `p` | 0.938 | 0.903 | 0.288 | 0.614 | 0.170 | 0.6237 | 0.873 | 0.836 | 12 | 106 |
|  | c_scelta | `1-p(none)` | 0.929 | 0.779 | 0.179 | 0.600 | 0.107 | 0.1225 | 0.840 | 0.809 | 12 | 106 |
|  | attuale | `1-p(none)` | 0.926 | 0.775 | 0.181 | 0.595 | 0.108 | 0.1246 | 0.840 | 0.809 | 12 | 106 |
|  | d_inversa | `inverse` | 0.873 | 0.852 | 0.445 | 0.407 | 0.261 | 0.8462 | 0.818 | 0.765 | 12 | 106 |
|  | b_esempi | `p` | 0.813 | 0.290 | 0.036 | 0.254 | 0.066 | 0.0533 | 0.790 | 0.625 | 12 | 106 |
|  | e_firme | `p` | 0.683 | 0.563 | 0.364 | 0.199 | 0.205 | 0.7716 | 0.680 | 0.636 | 12 | 106 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **b_esempi** | `p` | **0.995** | 0.994 | 0.528 | 0.465 | 0.312 | 0.9634 | 0.991 | 0.732 | 8 | 110 |
|  | attuale | `p` | 0.994 | 0.889 | 0.043 | 0.846 | 0.023 | 0.2714 | 0.982 | 0.928 | 8 | 110 |
|  | a_letterale | `p` | 0.994 | 0.889 | 0.044 | 0.845 | 0.024 | 0.2743 | 0.982 | 0.928 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.984 | 0.969 | 0.451 | 0.519 | 0.241 | 0.9901 | 0.938 | 0.841 | 8 | 110 |
|  | c_scelta | `1-p(none)` | 0.983 | 0.999 | 0.163 | 0.836 | 0.110 | 0.9906 | 0.973 | 0.927 | 8 | 110 |
|  | it_letterale | `p` | 0.982 | 0.661 | 0.092 | 0.568 | 0.036 | 0.3323 | 0.977 | 0.803 | 8 | 110 |
|  | d_inversa | `inverse` | 0.887 | 0.996 | 0.959 | 0.036 | 0.864 | 0.9970 | 0.878 | 0.505 | 8 | 110 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **c_scelta** | `1-p(none)` | **1.000** | 0.996 | 0.021 | 0.975 | 0.007 | 0.8916 | 1.000 | 0.995 | 7 | 111 |
|  | attuale | `1-p(none)` | 1.000 | 0.995 | 0.021 | 0.974 | 0.007 | 0.8924 | 1.000 | 0.995 | 7 | 111 |
|  | a_letterale + d_inversa | `mean` | 0.988 | 0.987 | 0.561 | 0.426 | 0.335 | 0.9154 | 0.959 | 0.694 | 7 | 111 |
|  | a_letterale | `p` | 0.986 | 0.882 | 0.065 | 0.817 | 0.039 | 0.1851 | 0.950 | 0.902 | 7 | 111 |
|  | b_esempi | `p` | 0.978 | 0.762 | 0.049 | 0.712 | 0.028 | 0.0894 | 0.937 | 0.915 | 7 | 111 |
|  | d_inversa | `inverse` | 0.869 | 0.999 | 0.991 | 0.008 | 0.924 | 0.9993 | 0.830 | 0.500 | 7 | 111 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.964** | 0.813 | 0.097 | 0.716 | 0.093 | 0.3533 | 0.906 | 0.873 | 77 | 41 |
|  | c_scelta | `1-p(none)` | 0.963 | 0.811 | 0.098 | 0.713 | 0.094 | 0.3643 | 0.899 | 0.873 | 77 | 41 |
|  | e_scomposta_senza_test | `p × no test` | 0.960 | 0.771 | 0.062 | 0.709 | 0.114 | 0.0984 | 0.912 | 0.865 | 77 | 41 |
|  | d_inversa | `inverse` | 0.950 | 0.750 | 0.092 | 0.658 | 0.138 | 0.1202 | 0.900 | 0.827 | 77 | 41 |
|  | a_letterale + d_inversa | `mean` | 0.942 | 0.698 | 0.097 | 0.601 | 0.156 | 0.1045 | 0.882 | 0.789 | 77 | 41 |
|  | b_esempi | `p` | 0.901 | 0.914 | 0.637 | 0.277 | 0.182 | 0.8850 | 0.879 | 0.603 | 77 | 41 |
|  | a_letterale | `p` | 0.887 | 0.603 | 0.132 | 0.471 | 0.216 | 0.1105 | 0.832 | 0.756 | 77 | 41 |
|  | e_scomposta | `p` | 0.792 | 0.784 | 0.338 | 0.446 | 0.182 | 0.3552 | 0.771 | 0.738 | 77 | 41 |
|  | paths only (no model) | `no test` | 0.786 | 0.987 | 0.415 | 0.572 | 0.153 | 0.5000 | 0.786 | 0.786 | 77 | 41 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale + d_inversa** | `mean` | **0.662** | 0.385 | 0.217 | 0.169 | 0.119 | 0.2156 | 0.668 | 0.589 | 9 | 109 |
|  | b_esempi | `p` | 0.648 | 0.072 | 0.067 | 0.005 | 0.086 | 0.0593 | 0.719 | 0.486 | 9 | 109 |
|  | a_letterale | `p` | 0.641 | 0.597 | 0.457 | 0.140 | 0.279 | 0.7954 | 0.649 | 0.562 | 9 | 109 |
|  | d_inversa | `inverse` | 0.632 | 0.233 | 0.093 | 0.139 | 0.080 | 0.0261 | 0.665 | 0.588 | 9 | 109 |
|  | e_omissione | `p` | 0.599 | 0.537 | 0.443 | 0.094 | 0.280 | 0.1514 | 0.619 | 0.595 | 9 | 109 |
|  | e_omissione_o_invenzione | `max` | 0.594 | 0.537 | 0.448 | 0.089 | 0.282 | 0.5487 | 0.613 | 0.590 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.547 | 0.029 | 0.011 | 0.017 | 0.074 | 0.0012 | 0.605 | 0.500 | 9 | 109 |
|  | e_invenzione | `p` | 0.513 | 0.105 | 0.071 | 0.034 | 0.079 | 0.1814 | 0.561 | 0.542 | 9 | 109 |
|  | attuale | `p` | 0.426 | 0.978 | 0.931 | 0.048 | 0.846 | 0.9116 | 0.560 | 0.532 | 9 | 109 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale + d_inversa** | `mean` | **1.000** | 0.998 | 0.904 | 0.094 | 0.760 | 0.9945 | 1.000 | 0.500 | 9 | 109 |
|  | attuale | `1-p(none)` | 0.999 | 0.997 | 0.049 | 0.948 | 0.021 | 0.9532 | 0.995 | 0.986 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.999 | 0.997 | 0.049 | 0.948 | 0.021 | 0.9513 | 0.995 | 0.986 | 9 | 109 |
|  | a_letterale | `p` | 0.995 | 0.997 | 0.523 | 0.474 | 0.319 | 0.9945 | 0.986 | 0.752 | 9 | 109 |
|  | b_esempi | `p` | 0.989 | 0.517 | 0.049 | 0.468 | 0.027 | 0.1234 | 0.959 | 0.778 | 9 | 109 |
|  | d_inversa | `inverse` | 0.880 | 0.998 | 0.985 | 0.012 | 0.897 | 0.9990 | 0.833 | 0.500 | 9 | 109 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.925** | 0.727 | 0.025 | 0.702 | 0.022 | 0.0548 | 0.903 | 0.884 | 9 | 109 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.980** | 0.701 | 0.035 | 0.667 | 0.045 | 0.0291 | 0.977 | 0.781 | 10 | 108 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| injection_risk | attuale (checks.json) | choice | `f183376890c7c4e48a161454d6d7aa177f55af5a0aa6615a73889f208c0295fa` |
| injection_risk | a_letterale | noul | `62c1c54aca142bf194e19151926b349be5da34811fb2b1e4a84a6c8ffe86f8f9` |
| injection_risk | b_esempi | noul | `ce08128a1068af09385282d3f7c985202732b963aa139a73ef5ace9c3e86db1d` |
| injection_risk | c_scelta | choice | `f183376890c7c4e48a161454d6d7aa177f55af5a0aa6615a73889f208c0295fa` |
| injection_risk | c_scelta_none_ultima | choice | `ad31ddd544daec9b34f19fd82c5d5f55d07b6ca1f8259cca6eddae23f4b61b40` |
| injection_risk | d_inversa | noul | `61af56fe463622dae429210cfc6adedef0c69b6c66e1be60c4997774358efbc5` |
| injection_risk | it_esempi | noul | `48493e85c0626249f6030fb1f230be5b7766e744ae08520fcb115cbce51c8dae` |
| breaks_api | attuale (checks.json) | choice | `424250f372401bb7afe2851eac8c499cea5f610a993469b9381427e98e678c84` |
| breaks_api | a_letterale | noul | `16b373e0fec58cd90f5eeaec13ed715c519576add4169c7f97ab9055e89774d5` |
| breaks_api | b_esempi | noul | `dd36058eb2e1f7369cf6124299fce20fb73df050e82fa416c845acc5916006e5` |
| breaks_api | c_scelta | choice | `424250f372401bb7afe2851eac8c499cea5f610a993469b9381427e98e678c84` |
| breaks_api | d_inversa | noul | `0e84b3192002d6d0d4393aa158393baf9b030a4dabbf78ddf6b7e2809db9bfec` |
| breaks_api | e_firme | noul | `86d4f21885f31d96ad5b0cc92bde761599cfdc9cf1969ff5ed4c76dcf8dd1efb` |
| debug_leftovers | attuale (checks.json) | noul | `ffde6e476c0ecee5896c8acc96b4efb6a47b3a607b3539c3d2f3d9121b866b26` |
| debug_leftovers | a_letterale | noul | `ffde6e476c0ecee5896c8acc96b4efb6a47b3a607b3539c3d2f3d9121b866b26` |
| debug_leftovers | b_esempi | noul | `8b5b122e0e34958cfa9ce8d268ab429a817e5ef37047e90ce7767314e9ad4d6d` |
| debug_leftovers | c_scelta | choice | `db8fbea32d335f6ea1cce3396bd06264a2df3277f22c7645a587ec98d5d777f7` |
| debug_leftovers | d_inversa | noul | `5f4b739631535f844e8c0ef56433df54ef208ad3535cb36e67df855e150375d6` |
| debug_leftovers | it_letterale | noul | `f9325b3046d9108dfde8ab17f75d6a978d866a5412d6f7fad5c20e8b77eee816` |
| data_migration | attuale (checks.json) | choice | `b6ce1888d300422fcce9d8432a3bf698d330dfb7892df3a30d621258584ecbbe` |
| data_migration | a_letterale | noul | `7b5f7f40e6575ca237802a4baedc0aecaf1bd6352c345885ec23c4ce5455f85c` |
| data_migration | b_esempi | noul | `32872eb54bf25c8b84229c3864b6da930dbdec4f95810b4eb1227ebaa4247252` |
| data_migration | c_scelta | choice | `b6ce1888d300422fcce9d8432a3bf698d330dfb7892df3a30d621258584ecbbe` |
| data_migration | d_inversa | noul | `69b4013a37b30affc5b0463422f82cc8f153d13f1299691a15f5b58d297d34bc` |
| adds_tests | attuale (checks.json) | choice | `e637c7a92d249a84aa22fdc41f70e0039e4ccd7af7e658b5c54e6392389f4f63` |
| adds_tests | a_letterale | noul | `a56070e2f5a8b0cb4e0936e1e26939b5a839c6ae1455726e0cacb9061853b88b` |
| adds_tests | b_esempi | noul | `337b26d471f02a648b43f0f7fcf806af67aec8a7953b99c6aab038b68bf7d83e` |
| adds_tests | c_scelta | choice | `e637c7a92d249a84aa22fdc41f70e0039e4ccd7af7e658b5c54e6392389f4f63` |
| adds_tests | d_inversa | noul | `2380b2a1f2c6729ec8a2fdddf06be643fefccebe4982831702f85c8291e019a8` |
| adds_tests | e_scomposta | noul | `d8294eba25b00496294b3bdcb5225efc2aef1520e8c0bc567aab3aed8ea5b600` |
| description_matches | attuale (checks.json) | noul | `4948e612bee17e695a57e085b2f4f1205c470d1764a058eb92c023a076f8e445` |
| description_matches | a_letterale | noul | `7dfb7254b182165655619414bff619c19592e0d944317c8267504219c04a00c5` |
| description_matches | b_esempi | noul | `151a21871ab3ba9c5b69a19220b7411cd9e34d108f3c8b1026bda2b5de56345c` |
| description_matches | c_scelta | choice | `2d215eecf8ccd493154af10fdeae3b2b483f0825b53a4789790bdd90da25735f` |
| description_matches | d_inversa | noul | `38dfbf52677e04134a0b9dfc197338fcd1e293625c69eee5a26ba3709fed087c` |
| description_matches | e_omissione | noul | `29a4417d24a8f6e0c1009624901b4455954c7cba9c7f3f6116a742be31d477cf` |
| description_matches | e_invenzione | noul | `ef65718d67db95514d7b13f582bf8fa4a5b7f98f5fd7468fb2b2a69a095d15c5` |
| weakens_tests | attuale (checks.json) | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_tests | a_letterale | noul | `a6ce184d88c502123fc04026997b5961e9d3a3e5cd5a5778c9080ba0be56501c` |
| weakens_tests | b_esempi | noul | `54cce8c850d6549289247d6874c13cbff0e682b40054352b9fe0a5564280f456` |
| weakens_tests | c_scelta | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_tests | d_inversa | noul | `8b8941eba4a24d351ecf2257b16b36b716dd13ebb4cbebc9fb6efc81e3d32239` |
| hardcoded_secret | attuale (checks.json) | noul | `8fcf8b054f63808c454c265895289150720668f8095d443c65fd3ee9999154a1` |
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
