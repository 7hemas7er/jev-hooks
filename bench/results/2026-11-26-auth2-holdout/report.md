# Question measurement

- Date: 2026-11-26
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout.jsonl`, 121 diffs, sha256 `3709183ce65aa67bda6ffae80cb5d14d7cc56a10c28f58968e44bcd2b40d7435`
- Variants: `bench/variants-auth-2.json`, 1 questions, 5 variants, sha256 `ff735cc9c7a4a1068e43b99c0a2b3d047d8999bb7d05c9e346892ca019c15200`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 121 (0 failed); median latency 0.99 s, p95 1.08 s; mean input tokens per request (usage) 2192

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
| touches_auth | chunk state | h_option | `1-p(none)` | 0.995 | 0.834 | 0.981 | 14 | 107 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **h_option** | `1-p(none)` | **0.995** | 0.885 | 0.051 | 0.834 | 0.025 | 0.4164 | 0.981 | 0.950 | 14 | 107 |
|  | f_both | `1-p(none)` | 0.991 | 0.768 | 0.019 | 0.749 | 0.027 | 0.0358 | 0.972 | 0.852 | 14 | 107 |
|  | g_none | `1-p(none)` | 0.991 | 0.737 | 0.021 | 0.716 | 0.037 | 0.0183 | 0.977 | 0.843 | 14 | 107 |
|  | d_choice | `1-p(none)` | 0.985 | 0.804 | 0.032 | 0.772 | 0.029 | 0.2666 | 0.950 | 0.919 | 14 | 107 |
|  | attuale | `p` | 0.969 | 0.794 | 0.055 | 0.739 | 0.056 | 0.2160 | 0.936 | 0.869 | 14 | 107 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
| touches_auth | d_choice | choice | `e30994da7aad8b2377065f218be91d7989239ef4f7c2b56cbacffe35c280a4f2` |
| touches_auth | f_both | choice | `6397f3abf97117ea81eb2dfe49b51497387cbe6af45cf0779d1881124452287e` |
| touches_auth | g_none | choice | `d788820b924c58694787aad39cdbe74619b9ec2bdfc3fd7bf44a68fdbfc24972` |
| touches_auth | h_option | choice | `c9e3f951ef34ad9ca29c4326c6b6e152102f517b59eaae61e5e6ba002d343345` |
