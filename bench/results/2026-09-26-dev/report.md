# Question measurement

- Date: 2026-09-26
- Backend: `127.0.0.1:8017` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants.json`, 9 questions, 44 variants, sha256 `544e6ee4f6f6379e77892730d6c58b408bc78628b50b44f988d1b74020ad23bb`
- Plugin configuration: checks.json sha256 `b2458cdaf7b55d9232ed6491a246ddb849e17469a4d0c10186ea1dd550950331`, policy.json sha256 `6bdcf0defdc84f910032551de184dabfeddfa12ca1dc9d828c86b6580dcbe4e8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v22.23.2
- Requests: 236 (0 failed); median latency 0.82 s, p95 1.94 s; mean input tokens per request (usage) 5871

## How to read

- **p** is the probability that the label is true, that is, that the right answer to the question in "yes = problem" polarity is yes. The readout derives it from the answer: `p` = P(yes), `inversa` = 1 − P(yes) of a question written the other way round (the readout is called `inverse` in today's variants.json), `1-p(x)` = 1 − p of option x of a choice (or of level x of a score), `p(x)` = p of option x, `p(>=k)` = P(level ≥ k) of a score.
- Computed rows, not asked: `mean` = logit mean of a direct variant and its inverse (or of the variants of a combination), `max` = the maximum of the combined variants, `p × no test` = the variant's p, set to zero on diffs that contain a test file (`test_paths` in policy.json); `no test` = 1 on diffs without a test file and 0 on the others, i.e. the path rule without the model: it is the baseline to beat for `p × no test`.
- Raw values, no calibration. For questions on the chunk state, with several chunks the maximum counts, as in the reviewer.
- **AUROC**: probability that a positive diff has a higher p than a negative one (1 separates everything, 0.5 is chance, below 0.5 the question is reversed). It does not change with calibration.
- **Separation**: mean p on positives minus mean on negatives. **Brier**: mean squared error of p against the label (0 is perfect; always answering 0.5 scores 0.25).
- **Best threshold**: the threshold (yes from there up) with the highest balanced accuracy, at the logit midpoint between two p of the sample; "—" if no threshold beats chance. **Bal. acc.** is the mean of sensitivity and specificity.
- ★ marks the question's best variant (AUROC, then separation, then Brier).

## Summary

| question | state | best | readout | AUROC | separation | bal. acc. | n+ | n− |
|---|---|---|---|--:|--:|--:|--:|--:|
| injection_risk | chunk state | c_scelta | `1-p(none)` | 1.000 | 0.864 | 1.000 | 8 | 110 |
| breaks_api | chunk state | a_letterale + d_inversa | `mean` | 0.938 | 0.554 | 0.879 | 12 | 106 |
| debug_leftovers | chunk state | attuale | `p` | 1.000 | 0.275 | 1.000 | 8 | 110 |
| data_migration | chunk state | c_scelta | `1-p(none)` | 1.000 | 0.975 | 1.000 | 7 | 111 |
| adds_tests | global state | c_scelta | `1-p(none)` | 0.964 | 0.715 | 0.895 | 77 | 41 |
| description_matches | global state | a_letterale + d_inversa | `mean` | 0.662 | 0.169 | 0.668 | 9 | 109 |
| weakens_tests | chunk state | a_letterale + d_inversa | `mean` | 1.000 | 0.095 | 1.000 | 9 | 109 |
| hardcoded_secret | chunk state | attuale | `p` | 0.925 | 0.702 | 0.903 | 9 | 109 |
| touches_auth | chunk state | attuale | `p` | 0.980 | 0.660 | 0.977 | 10 | 108 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **c_scelta** | `1-p(none)` | **1.000** | 1.000 | 0.135 | 0.864 | 0.077 | 0.9977 | 1.000 | 0.959 | 8 | 110 |
|  | attuale | `p` | 0.994 | 0.999 | 0.468 | 0.531 | 0.337 | 0.9963 | 0.986 | 0.755 | 8 | 110 |
|  | c_scelta_due_ordini | `mean` | 0.989 | 0.901 | 0.042 | 0.859 | 0.026 | 0.6129 | 0.986 | 0.982 | 8 | 110 |
|  | c_scelta_none_ultima | `1-p(none)` | 0.965 | 0.314 | 0.012 | 0.302 | 0.048 | 0.0014 | 0.955 | 0.620 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.963 | 0.648 | 0.059 | 0.589 | 0.028 | 0.0804 | 0.905 | 0.870 | 8 | 110 |
|  | d_inversa | `inversa` | 0.944 | 0.904 | 0.408 | 0.496 | 0.226 | 0.8212 | 0.892 | 0.827 | 8 | 110 |
|  | a_letterale | `p` | 0.931 | 0.508 | 0.011 | 0.497 | 0.038 | 0.0147 | 0.919 | 0.745 | 8 | 110 |
|  | b_esempi | `p` | 0.920 | 0.783 | 0.206 | 0.577 | 0.100 | 0.8816 | 0.861 | 0.825 | 8 | 110 |
|  | it_esempi | `p` | 0.752 | 0.334 | 0.173 | 0.161 | 0.077 | 0.2686 | 0.717 | 0.607 | 8 | 110 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale + d_inversa** | `mean` | **0.938** | 0.901 | 0.347 | 0.554 | 0.183 | 0.8294 | 0.879 | 0.812 | 12 | 106 |
|  | a_letterale | `p` | 0.934 | 0.901 | 0.291 | 0.610 | 0.172 | 0.6410 | 0.873 | 0.836 | 12 | 106 |
|  | c_scelta | `1-p(none)` | 0.929 | 0.775 | 0.180 | 0.596 | 0.107 | 0.3015 | 0.845 | 0.804 | 12 | 106 |
|  | attuale | `p` | 0.897 | 0.998 | 0.943 | 0.055 | 0.814 | 0.9980 | 0.851 | 0.514 | 12 | 106 |
|  | d_inversa | `inversa` | 0.873 | 0.850 | 0.444 | 0.406 | 0.261 | 0.8471 | 0.814 | 0.765 | 12 | 106 |
|  | b_esempi | `p` | 0.811 | 0.289 | 0.036 | 0.253 | 0.066 | 0.0514 | 0.781 | 0.625 | 12 | 106 |
|  | e_firme | `p` | 0.683 | 0.560 | 0.363 | 0.197 | 0.205 | 0.6788 | 0.679 | 0.641 | 12 | 106 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **1.000** | 0.999 | 0.724 | 0.275 | 0.533 | 0.9961 | 1.000 | 0.586 | 8 | 110 |
|  | b_esempi | `p` | 0.995 | 0.994 | 0.530 | 0.464 | 0.314 | 0.9635 | 0.991 | 0.723 | 8 | 110 |
|  | a_letterale | `p` | 0.994 | 0.892 | 0.044 | 0.849 | 0.023 | 0.2850 | 0.982 | 0.928 | 8 | 110 |
|  | c_scelta | `1-p(none)` | 0.983 | 0.999 | 0.163 | 0.836 | 0.111 | 0.9909 | 0.973 | 0.927 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.983 | 0.969 | 0.452 | 0.518 | 0.241 | 0.9908 | 0.938 | 0.841 | 8 | 110 |
|  | it_letterale | `p` | 0.982 | 0.661 | 0.092 | 0.568 | 0.036 | 0.3323 | 0.977 | 0.803 | 8 | 110 |
|  | d_inversa | `inversa` | 0.884 | 0.995 | 0.959 | 0.036 | 0.865 | 0.9975 | 0.883 | 0.505 | 8 | 110 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **c_scelta** | `1-p(none)` | **1.000** | 0.996 | 0.021 | 0.975 | 0.007 | 0.8904 | 1.000 | 0.995 | 7 | 111 |
|  | attuale | `p` | 1.000 | 1.000 | 0.565 | 0.434 | 0.391 | 0.9982 | 1.000 | 0.689 | 7 | 111 |
|  | a_letterale | `p` | 0.988 | 0.883 | 0.063 | 0.820 | 0.038 | 0.2073 | 0.959 | 0.902 | 7 | 111 |
|  | a_letterale + d_inversa | `mean` | 0.988 | 0.987 | 0.560 | 0.427 | 0.334 | 0.9162 | 0.959 | 0.689 | 7 | 111 |
|  | b_esempi | `p` | 0.976 | 0.754 | 0.049 | 0.705 | 0.028 | 0.0671 | 0.928 | 0.915 | 7 | 111 |
|  | d_inversa | `inversa` | 0.869 | 0.999 | 0.991 | 0.008 | 0.924 | 0.9992 | 0.821 | 0.500 | 7 | 111 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **c_scelta** | `1-p(none)` | **0.964** | 0.814 | 0.098 | 0.715 | 0.093 | 0.1044 | 0.895 | 0.873 | 77 | 41 |
|  | e_scomposta_senza_test | `p × no test` | 0.960 | 0.771 | 0.062 | 0.709 | 0.114 | 0.0984 | 0.912 | 0.865 | 77 | 41 |
|  | attuale | `p` | 0.959 | 0.998 | 0.723 | 0.275 | 0.223 | 0.9982 | 0.891 | 0.634 | 77 | 41 |
|  | d_inversa | `inversa` | 0.949 | 0.750 | 0.092 | 0.658 | 0.138 | 0.1207 | 0.900 | 0.827 | 77 | 41 |
|  | a_letterale + d_inversa | `mean` | 0.942 | 0.697 | 0.097 | 0.600 | 0.156 | 0.1044 | 0.882 | 0.789 | 77 | 41 |
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
|  | d_inversa | `inversa` | 0.632 | 0.233 | 0.093 | 0.139 | 0.080 | 0.0261 | 0.665 | 0.588 | 9 | 109 |
|  | e_omissione | `p` | 0.585 | 0.535 | 0.446 | 0.090 | 0.284 | 0.1510 | 0.615 | 0.599 | 9 | 109 |
|  | e_omissione_o_invenzione | `max` | 0.582 | 0.535 | 0.451 | 0.085 | 0.285 | 0.5475 | 0.613 | 0.595 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.547 | 0.029 | 0.011 | 0.017 | 0.074 | 0.0012 | 0.605 | 0.500 | 9 | 109 |
|  | e_invenzione | `p` | 0.511 | 0.103 | 0.071 | 0.032 | 0.079 | 0.1794 | 0.565 | 0.542 | 9 | 109 |
|  | attuale | `p` | 0.426 | 0.978 | 0.930 | 0.048 | 0.846 | 0.8986 | 0.555 | 0.532 | 9 | 109 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale + d_inversa** | `mean` | **1.000** | 0.998 | 0.903 | 0.095 | 0.758 | 0.9942 | 1.000 | 0.500 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.999 | 0.997 | 0.049 | 0.947 | 0.021 | 0.9535 | 0.995 | 0.986 | 9 | 109 |
|  | a_letterale | `p` | 0.997 | 0.997 | 0.520 | 0.477 | 0.315 | 0.9946 | 0.986 | 0.761 | 9 | 109 |
|  | attuale | `p` | 0.994 | 0.970 | 0.171 | 0.799 | 0.082 | 0.7300 | 0.972 | 0.936 | 9 | 109 |
|  | b_esempi | `p` | 0.991 | 0.521 | 0.048 | 0.473 | 0.027 | 0.1259 | 0.959 | 0.778 | 9 | 109 |
|  | d_inversa | `inversa` | 0.873 | 0.997 | 0.985 | 0.012 | 0.897 | 0.9990 | 0.833 | 0.500 | 9 | 109 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.925** | 0.727 | 0.025 | 0.702 | 0.022 | 0.0548 | 0.903 | 0.884 | 9 | 109 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.980** | 0.695 | 0.035 | 0.660 | 0.046 | 0.0281 | 0.977 | 0.781 | 10 | 108 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| injection_risk | attuale (checks.json) | noul | `d04f61334fb10505b34ab036993d0fc8dc30044ce036671a474860ef9c6b1060` |
| injection_risk | a_letterale | noul | `62c1c54aca142bf194e19151926b349be5da34811fb2b1e4a84a6c8ffe86f8f9` |
| injection_risk | b_esempi | noul | `ce08128a1068af09385282d3f7c985202732b963aa139a73ef5ace9c3e86db1d` |
| injection_risk | c_scelta | choice | `a811784377aee7b85df3cc7acf662e904d26a4ef4191c2ccc55e2527af131b19` |
| injection_risk | c_scelta_none_ultima | choice | `a811784377aee7b85df3cc7acf662e904d26a4ef4191c2ccc55e2527af131b19` |
| injection_risk | d_inversa | noul | `61af56fe463622dae429210cfc6adedef0c69b6c66e1be60c4997774358efbc5` |
| injection_risk | it_esempi | noul | `48493e85c0626249f6030fb1f230be5b7766e744ae08520fcb115cbce51c8dae` |
| breaks_api | attuale (checks.json) | noul | `ee4a92b6e0db02300cc4453a27d17abd38db5d393133253c0a9e79fed7cc8555` |
| breaks_api | a_letterale | noul | `16b373e0fec58cd90f5eeaec13ed715c519576add4169c7f97ab9055e89774d5` |
| breaks_api | b_esempi | noul | `dd36058eb2e1f7369cf6124299fce20fb73df050e82fa416c845acc5916006e5` |
| breaks_api | c_scelta | choice | `86714c98e715c905f3b8028c2c8e6b4b649d4177a65a99271d00f29c4b9547bd` |
| breaks_api | d_inversa | noul | `0e84b3192002d6d0d4393aa158393baf9b030a4dabbf78ddf6b7e2809db9bfec` |
| breaks_api | e_firme | noul | `86d4f21885f31d96ad5b0cc92bde761599cfdc9cf1969ff5ed4c76dcf8dd1efb` |
| debug_leftovers | attuale (checks.json) | noul | `51fb479c49752710359cff0ca14f91ef5e76b71ba7b324217bf2684e0ecd6eac` |
| debug_leftovers | a_letterale | noul | `ffde6e476c0ecee5896c8acc96b4efb6a47b3a607b3539c3d2f3d9121b866b26` |
| debug_leftovers | b_esempi | noul | `8b5b122e0e34958cfa9ce8d268ab429a817e5ef37047e90ce7767314e9ad4d6d` |
| debug_leftovers | c_scelta | choice | `69287211fe0b1e534bcad48c00a1ed8f186839c8164c7abf96323eb49a651a19` |
| debug_leftovers | d_inversa | noul | `5f4b739631535f844e8c0ef56433df54ef208ad3535cb36e67df855e150375d6` |
| debug_leftovers | it_letterale | noul | `f9325b3046d9108dfde8ab17f75d6a978d866a5412d6f7fad5c20e8b77eee816` |
| data_migration | attuale (checks.json) | noul | `18571510e79680bbc4b667bdbad29d25141f2a7282eb0816a71ae817b3cdc724` |
| data_migration | a_letterale | noul | `7b5f7f40e6575ca237802a4baedc0aecaf1bd6352c345885ec23c4ce5455f85c` |
| data_migration | b_esempi | noul | `32872eb54bf25c8b84229c3864b6da930dbdec4f95810b4eb1227ebaa4247252` |
| data_migration | c_scelta | choice | `f31975440d1e974e15c1201d66b6f5615631e54df2e757b7a79a0c4a3e1eadbb` |
| data_migration | d_inversa | noul | `69b4013a37b30affc5b0463422f82cc8f153d13f1299691a15f5b58d297d34bc` |
| adds_tests | attuale (checks.json) | noul | `4c430c08fb51bd2c722580b66e7918e4e189d0f3ad2b8eedb655b18202a58c6e` |
| adds_tests | a_letterale | noul | `a56070e2f5a8b0cb4e0936e1e26939b5a839c6ae1455726e0cacb9061853b88b` |
| adds_tests | b_esempi | noul | `337b26d471f02a648b43f0f7fcf806af67aec8a7953b99c6aab038b68bf7d83e` |
| adds_tests | c_scelta | choice | `11f32ba28e72f3bfc811d4a2191414c95d1097386cf0914b11536069ad8471dc` |
| adds_tests | d_inversa | noul | `2380b2a1f2c6729ec8a2fdddf06be643fefccebe4982831702f85c8291e019a8` |
| adds_tests | e_scomposta | noul | `d8294eba25b00496294b3bdcb5225efc2aef1520e8c0bc567aab3aed8ea5b600` |
| description_matches | attuale (checks.json) | noul | `4948e612bee17e695a57e085b2f4f1205c470d1764a058eb92c023a076f8e445` |
| description_matches | a_letterale | noul | `7dfb7254b182165655619414bff619c19592e0d944317c8267504219c04a00c5` |
| description_matches | b_esempi | noul | `151a21871ab3ba9c5b69a19220b7411cd9e34d108f3c8b1026bda2b5de56345c` |
| description_matches | c_scelta | choice | `c199afd519e03986e78e45f5acbe44c82552530f4e6bbb6fb7aef36f14c7c6dc` |
| description_matches | d_inversa | noul | `38dfbf52677e04134a0b9dfc197338fcd1e293625c69eee5a26ba3709fed087c` |
| description_matches | e_omissione | noul | `29a4417d24a8f6e0c1009624901b4455954c7cba9c7f3f6116a742be31d477cf` |
| description_matches | e_invenzione | noul | `ef65718d67db95514d7b13f582bf8fa4a5b7f98f5fd7468fb2b2a69a095d15c5` |
| weakens_tests | attuale (checks.json) | noul | `8a501ff46eccd2cfbc18ab8960d315c7259fc6b534f7c35f92b1310eb50052de` |
| weakens_tests | a_letterale | noul | `a6ce184d88c502123fc04026997b5961e9d3a3e5cd5a5778c9080ba0be56501c` |
| weakens_tests | b_esempi | noul | `54cce8c850d6549289247d6874c13cbff0e682b40054352b9fe0a5564280f456` |
| weakens_tests | c_scelta | choice | `a9bfeb2cfb5361e22a12d63c44aab7b017fda197e94531bc2cb182e236620370` |
| weakens_tests | d_inversa | noul | `8b8941eba4a24d351ecf2257b16b36b716dd13ebb4cbebc9fb6efc81e3d32239` |
| hardcoded_secret | attuale (checks.json) | noul | `8fcf8b054f63808c454c265895289150720668f8095d443c65fd3ee9999154a1` |
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
