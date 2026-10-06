# Question measurement

- Date: 2026-10-07
- Backend: `127.0.0.1:18017` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants-weakens-3.json`, 2 questions, 4 variants, sha256 `f2d8440e5f38593f3b84a517f8e445bde56b64f2c811aaa71ece2f2633fce6b2`
- Plugin configuration: checks.json sha256 `5e9143637a0f8f5f23a43074469465e31bd612969470b1cd50af2c013247d3af`, policy.json sha256 `e61f36f2c09e34facc50dfda9a921a6575ba9ee0c89596a65b2cd42dce80d9e5`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 118 (0 failed); median latency 0.48 s, p95 0.57 s; mean input tokens per request (usage) 2069

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
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.999 | 0.948 | 0.995 | 9 | 109 |
| weakens_expected | chunk state | attuale | `1-p(none)` | 1.000 | 0.965 | 1.000 | 9 | 109 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.999** | 0.997 | 0.049 | 0.948 | 0.021 | 0.9532 | 0.995 | 0.986 | 9 | 109 |

## weakens_expected

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **1.000** | 0.997 | 0.033 | 0.965 | 0.014 | 0.9594 | 1.000 | 0.986 | 9 | 109 |
|  | k_parts | `1-p(none)` | 1.000 | 0.997 | 0.043 | 0.954 | 0.019 | 0.9800 | 1.000 | 0.986 | 9 | 109 |
|  | l_no_expected | `1-p(none)` | 0.998 | 0.890 | 0.013 | 0.877 | 0.010 | 0.0671 | 0.991 | 0.944 | 9 | 109 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| weakens_tests | attuale (checks.json) | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_expected | attuale (checks.json) | choice | `24071ad11d105afcf1310ee0f1e0f2421cf78d54a2d0631bf2dc0a2cb93e528a` |
| weakens_expected | k_parts | choice | `4c37a3c9b4ab6c04e799a489ebe9581567c90fc1141ecc051b2dc32d20775779` |
| weakens_expected | l_no_expected | choice | `7ec0c4baa9669b0f012da14f2ab42dfa5695d7185064399e8e7af8d45cb2a054` |
