# Question measurement

- Date: 2026-11-25
- Backend: `127.0.0.1:18019` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants-auth.json`, 1 questions, 5 variants, sha256 `53cf55a7ad4645659512f3bac628882df99c15fd227a14ad8fafc1c1284326d6`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `e3e8c4087c8d70d335e7117b55eeb0f2ce5b35be75fa67010cb983e29e8339d8`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 118 (0 failed); median latency 0.47 s, p95 0.55 s; mean input tokens per request (usage) 1673

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
| touches_auth | chunk state | d_choice | `1-p(none)` | 1.000 | 0.924 | 1.000 | 10 | 108 |

## touches_auth

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **d_choice** | `1-p(none)` | **1.000** | 0.943 | 0.019 | 0.924 | 0.006 | 0.6420 | 1.000 | 0.995 | 10 | 108 |
|  | b_false | `p` | 0.996 | 0.807 | 0.013 | 0.794 | 0.014 | 0.1774 | 0.995 | 0.895 | 10 | 108 |
|  | e_who | `p` | 0.994 | 0.653 | 0.005 | 0.648 | 0.023 | 0.0221 | 0.977 | 0.800 | 10 | 108 |
|  | c_lists | `p` | 0.980 | 0.703 | 0.013 | 0.691 | 0.029 | 0.0555 | 0.936 | 0.845 | 10 | 108 |
|  | attuale | `p` | 0.980 | 0.702 | 0.035 | 0.667 | 0.045 | 0.0278 | 0.977 | 0.781 | 10 | 108 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| touches_auth | attuale (checks.json) | noul | `47bcb633948180f4f5e13da51dc1125d0c83c7e705f8c0bea84efcabd6ec1b7a` |
| touches_auth | b_false | noul | `3aad65ab7b90e1053cc61300fc04b2da7693ccbac6bf5795e38f27e877946fc1` |
| touches_auth | c_lists | noul | `8b08d3565c8052929eaaf1b9ff08074416538eb20d331a013bac1401a0b081da` |
| touches_auth | d_choice | choice | `e30994da7aad8b2377065f218be91d7989239ef4f7c2b56cbacffe35c280a4f2` |
| touches_auth | e_who | noul | `7722ec9a85020f0c4efbaa1ec38a097cfd32ea68898d4f2b7adc39d3ef57e554` |
