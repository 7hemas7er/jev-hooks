# Question measurement

- Date: 2026-10-07
- Backend: `127.0.0.1:18017` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/live.jsonl`, 27 diffs, sha256 `09f06252fca7ece17f38460cc758eb4c53feecbc8b9020e34c7041a4eb2fadd7`
- Variants: `bench/variants-weakens-3.json`, 2 questions, 4 variants, sha256 `f2d8440e5f38593f3b84a517f8e445bde56b64f2c811aaa71ece2f2633fce6b2`
- Plugin configuration: checks.json sha256 `5e9143637a0f8f5f23a43074469465e31bd612969470b1cd50af2c013247d3af`, policy.json sha256 `e61f36f2c09e34facc50dfda9a921a6575ba9ee0c89596a65b2cd42dce80d9e5`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 44 (0 failed); median latency 0.66 s, p95 0.93 s; mean input tokens per request (usage) 2898

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
| weakens_tests | chunk state | attuale | `1-p(none)` | 0.982 | 0.474 | 0.950 | 10 | 17 |
| weakens_expected | chunk state | attuale | `1-p(none)` | 1.000 | 0.902 | 1.000 | 10 | 17 |

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.982** | 0.988 | 0.514 | 0.474 | 0.243 | 0.9974 | 0.950 | 0.735 | 10 | 17 |

## weakens_expected

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **1.000** | 0.998 | 0.096 | 0.902 | 0.016 | 0.8965 | 1.000 | 0.971 | 10 | 17 |
|  | l_no_expected | `1-p(none)` | 1.000 | 0.998 | 0.111 | 0.887 | 0.023 | 0.9122 | 1.000 | 0.971 | 10 | 17 |
|  | k_parts | `1-p(none)` | 1.000 | 0.999 | 0.113 | 0.886 | 0.022 | 0.9536 | 1.000 | 0.971 | 10 | 17 |

## Notes

- live-commit-7590d3b: split into 3 chunks; for chunk questions the maximum across chunks counts
- live-commit-2f94a74: split into 2 chunks; for chunk questions the maximum across chunks counts
- live-commit-1b041f1: split into 2 chunks; for chunk questions the maximum across chunks counts
- live-commit-2ef62ee: 1 file beyond the chunk limit, not measured
- live-commit-2ef62ee: split into 8 chunks; for chunk questions the maximum across chunks counts
- live-commit-27b286e: split into 3 chunks; for chunk questions the maximum across chunks counts
- live-commit-34ded41: split into 5 chunks; for chunk questions the maximum across chunks counts

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| weakens_tests | attuale (checks.json) | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_expected | attuale (checks.json) | choice | `24071ad11d105afcf1310ee0f1e0f2421cf78d54a2d0631bf2dc0a2cb93e528a` |
| weakens_expected | k_parts | choice | `4c37a3c9b4ab6c04e799a489ebe9581567c90fc1141ecc051b2dc32d20775779` |
| weakens_expected | l_no_expected | choice | `7ec0c4baa9669b0f012da14f2ab42dfa5695d7185064399e8e7af8d45cb2a054` |
