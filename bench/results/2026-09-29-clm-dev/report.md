# Question measurement

- Date: 2026-09-29
- Backend: `127.0.0.1:18700` (local), requested model `clm-latest`
- Declared model: `clm-latest`
- Fingerprint: — (the backend does not declare it)
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants.json`, 9 questions, 44 variants, sha256 `544e6ee4f6f6379e77892730d6c58b408bc78628b50b44f988d1b74020ad23bb`
- Plugin configuration: checks.json sha256 `4dafe5336c605f94659a5843a913b6f3cb966347563895041f4c2236d6c4d1cf`, policy.json sha256 `65ecc95e817d7014e3345de179eb3aa90ada6d71883308ff7c0d0028d50ec609`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 236 (0 failed); median latency 0.57 s, p95 0.72 s; mean input tokens per request (usage) 6034

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
| injection_risk | chunk state | d_inversa | `inverse` | 0.843 | 0.013 | 0.800 | 8 | 110 |
| breaks_api | chunk state | a_letterale | `p` | 0.737 | 0.053 | 0.741 | 12 | 106 |
| debug_leftovers | chunk state | it_letterale | `p` | 0.819 | 0.001 | 0.793 | 8 | 110 |
| data_migration | chunk state | b_esempi | `p` | 0.837 | 0.082 | 0.852 | 7 | 111 |
| adds_tests | global state | paths only (no model) | `no test` | 0.786 | 0.572 | 0.786 | 77 | 41 |
| description_matches | global state | attuale | `p` | 0.624 | 0.033 | 0.633 | 9 | 109 |
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.851 | 0.174 | 0.807 | 9 | 109 |
| hardcoded_secret | chunk state | attuale | `p` | 0.372 | -0.047 | 0.550 | 9 | 109 |
| touches_auth | chunk state | attuale | `p` | 0.434 | -0.043 | 0.567 | 10 | 108 |

## injection_risk

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **d_inversa** | `inverse` | **0.843** | 0.996 | 0.983 | 0.013 | 0.900 | 0.9914 | 0.800 | 0.500 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.822 | 0.972 | 0.933 | 0.039 | 0.813 | 0.9701 | 0.784 | 0.500 | 8 | 110 |
|  | it_esempi | `p` | 0.789 | 0.086 | 0.051 | 0.035 | 0.060 | 0.0571 | 0.783 | 0.500 | 8 | 110 |
|  | a_letterale | `p` | 0.722 | 0.843 | 0.749 | 0.094 | 0.542 | 0.9039 | 0.700 | 0.527 | 8 | 110 |
|  | attuale | `1-p(none)` | 0.666 | 0.410 | 0.288 | 0.122 | 0.140 | 0.3535 | 0.716 | 0.588 | 8 | 110 |
|  | c_scelta | `1-p(none)` | 0.666 | 0.410 | 0.288 | 0.122 | 0.140 | 0.3535 | 0.716 | 0.588 | 8 | 110 |
|  | c_scelta_none_ultima | `1-p(none)` | 0.666 | 0.410 | 0.288 | 0.122 | 0.140 | 0.3535 | 0.716 | 0.588 | 8 | 110 |
|  | c_scelta_due_ordini | `mean` | 0.666 | 0.410 | 0.288 | 0.122 | 0.140 | 0.3535 | 0.716 | 0.588 | 8 | 110 |
|  | b_esempi | `p` | 0.665 | 0.666 | 0.581 | 0.086 | 0.354 | 0.6259 | 0.728 | 0.601 | 8 | 110 |

## breaks_api

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **a_letterale** | `p` | **0.737** | 0.938 | 0.885 | 0.053 | 0.708 | 0.9075 | 0.741 | 0.500 | 12 | 106 |
|  | a_letterale + d_inversa | `mean` | 0.699 | 0.936 | 0.909 | 0.027 | 0.744 | 0.9160 | 0.686 | 0.500 | 12 | 106 |
|  | attuale | `1-p(none)` | 0.622 | 0.940 | 0.912 | 0.029 | 0.755 | 0.9879 | 0.619 | 0.500 | 12 | 106 |
|  | c_scelta | `1-p(none)` | 0.622 | 0.940 | 0.912 | 0.029 | 0.755 | 0.9879 | 0.619 | 0.500 | 12 | 106 |
|  | d_inversa | `inverse` | 0.557 | 0.929 | 0.913 | 0.015 | 0.754 | 0.9464 | 0.604 | 0.500 | 12 | 106 |
|  | b_esempi | `p` | 0.477 | 0.054 | 0.053 | 0.001 | 0.095 | 0.1780 | 0.542 | 0.500 | 12 | 106 |
|  | e_firme | `p` | 0.406 | 0.219 | 0.245 | -0.026 | 0.123 | 0.1820 | 0.544 | 0.500 | 12 | 106 |

## debug_leftovers

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **it_letterale** | `p` | **0.819** | 0.001 | 0.001 | 0.001 | 0.068 | 0.0010 | 0.793 | 0.500 | 8 | 110 |
|  | c_scelta | `1-p(none)` | 0.784 | 0.860 | 0.717 | 0.143 | 0.507 | 0.8694 | 0.780 | 0.545 | 8 | 110 |
|  | a_letterale | `p` | 0.745 | 0.898 | 0.815 | 0.083 | 0.631 | 0.8920 | 0.748 | 0.500 | 8 | 110 |
|  | attuale | `p` | 0.745 | 0.898 | 0.815 | 0.083 | 0.631 | 0.8920 | 0.748 | 0.500 | 8 | 110 |
|  | a_letterale + d_inversa | `mean` | 0.720 | 0.727 | 0.635 | 0.092 | 0.395 | 0.7381 | 0.757 | 0.582 | 8 | 110 |
|  | d_inversa | `inverse` | 0.628 | 0.446 | 0.399 | 0.047 | 0.197 | 0.4199 | 0.689 | 0.444 | 8 | 110 |
|  | b_esempi | `p` | 0.355 | 0.761 | 0.802 | -0.041 | 0.609 | 0.7517 | 0.516 | 0.500 | 8 | 110 |

## data_migration

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **b_esempi** | `p` | **0.837** | 0.941 | 0.859 | 0.082 | 0.704 | 0.9390 | 0.852 | 0.505 | 7 | 111 |
|  | a_letterale | `p` | 0.658 | 0.781 | 0.716 | 0.065 | 0.502 | 0.7376 | 0.703 | 0.536 | 7 | 111 |
|  | a_letterale + d_inversa | `mean` | 0.559 | 0.756 | 0.741 | 0.016 | 0.529 | 0.7954 | 0.651 | 0.523 | 7 | 111 |
|  | attuale | `1-p(none)` | 0.525 | 0.116 | 0.121 | -0.005 | 0.065 | 0.0805 | 0.662 | 0.500 | 7 | 111 |
|  | c_scelta | `1-p(none)` | 0.525 | 0.116 | 0.121 | -0.005 | 0.065 | 0.0805 | 0.662 | 0.500 | 7 | 111 |
|  | d_inversa | `inverse` | 0.404 | 0.722 | 0.751 | -0.029 | 0.551 | 0.5369 | 0.536 | 0.527 | 7 | 111 |

## adds_tests

Question asked on the global state (scope `global` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **paths only (no model)** | `no test` | **0.786** | 0.987 | 0.415 | 0.572 | 0.153 | 0.5000 | 0.786 | 0.786 | 77 | 41 |
|  | e_scomposta_senza_test | `p × no test` | 0.694 | 0.052 | 0.032 | 0.020 | 0.589 | 0.0000 | 0.786 | 0.500 | 77 | 41 |
|  | d_inversa | `inverse` | 0.689 | 0.109 | 0.063 | 0.046 | 0.524 | 0.0663 | 0.672 | 0.500 | 77 | 41 |
|  | a_letterale + d_inversa | `mean` | 0.551 | 0.289 | 0.262 | 0.027 | 0.367 | 0.2297 | 0.556 | 0.533 | 77 | 41 |
|  | attuale | `1-p(none)` | 0.452 | 0.030 | 0.037 | -0.008 | 0.615 | 0.0153 | 0.547 | 0.500 | 77 | 41 |
|  | c_scelta | `1-p(none)` | 0.452 | 0.030 | 0.037 | -0.008 | 0.615 | 0.0153 | 0.547 | 0.500 | 77 | 41 |
|  | a_letterale | `p` | 0.389 | 0.596 | 0.648 | -0.051 | 0.268 | 0.3595 | 0.518 | 0.481 | 77 | 41 |
|  | e_scomposta | `p` | 0.352 | 0.052 | 0.066 | -0.014 | 0.589 | 0.1513 | 0.513 | 0.500 | 77 | 41 |
|  | b_esempi | `p` | 0.271 | 0.033 | 0.061 | -0.027 | 0.612 | — | 0.500 | 0.500 | 77 | 41 |

## description_matches

Question asked on the global state (scope `global` as in checks.json); asked only of diffs with a description.

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.624** | 0.156 | 0.123 | 0.033 | 0.075 | 0.0850 | 0.633 | 0.500 | 9 | 109 |
|  | d_inversa | `inverse` | 0.610 | 0.066 | 0.053 | 0.014 | 0.070 | 0.0560 | 0.664 | 0.500 | 9 | 109 |
|  | e_omissione | `p` | 0.527 | 0.599 | 0.609 | -0.010 | 0.377 | 0.6755 | 0.603 | 0.527 | 9 | 109 |
|  | b_esempi | `p` | 0.491 | 0.748 | 0.763 | -0.015 | 0.565 | 0.8817 | 0.570 | 0.467 | 9 | 109 |
|  | e_invenzione | `p` | 0.451 | 0.801 | 0.806 | -0.005 | 0.607 | 0.9066 | 0.556 | 0.500 | 9 | 109 |
|  | e_omissione_o_invenzione | `max` | 0.449 | 0.809 | 0.812 | -0.004 | 0.616 | 0.7419 | 0.560 | 0.500 | 9 | 109 |
|  | a_letterale + d_inversa | `mean` | 0.425 | 0.131 | 0.141 | -0.010 | 0.081 | 0.0722 | 0.573 | 0.500 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.371 | 0.525 | 0.577 | -0.052 | 0.340 | 0.4056 | 0.555 | 0.536 | 9 | 109 |
|  | a_letterale | `p` | 0.364 | 0.265 | 0.339 | -0.074 | 0.172 | 0.0758 | 0.518 | 0.482 | 9 | 109 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.851** | 0.495 | 0.321 | 0.174 | 0.129 | 0.3515 | 0.807 | 0.681 | 9 | 109 |
|  | c_scelta | `1-p(none)` | 0.851 | 0.495 | 0.321 | 0.174 | 0.129 | 0.3515 | 0.807 | 0.681 | 9 | 109 |
|  | d_inversa | `inverse` | 0.819 | 0.079 | 0.056 | 0.023 | 0.068 | 0.0667 | 0.816 | 0.500 | 9 | 109 |
|  | a_letterale + d_inversa | `mean` | 0.645 | 0.182 | 0.146 | 0.036 | 0.073 | 0.2384 | 0.648 | 0.500 | 9 | 109 |
|  | a_letterale | `p` | 0.484 | 0.359 | 0.347 | 0.011 | 0.160 | 0.5130 | 0.621 | 0.602 | 9 | 109 |
|  | b_esempi | `p` | 0.460 | 0.016 | 0.015 | 0.000 | 0.074 | 0.0239 | 0.589 | 0.500 | 9 | 109 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.372** | 0.172 | 0.219 | -0.047 | 0.106 | 0.0977 | 0.550 | 0.495 | 9 | 109 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `p` | **0.434** | 0.309 | 0.352 | -0.043 | 0.190 | 0.2328 | 0.567 | 0.475 | 10 | 108 |

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
