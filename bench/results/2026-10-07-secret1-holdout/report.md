# Question measurement

- Date: 2026-10-07
- Backend: `127.0.0.1:18017` (local), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/holdout.jsonl`, 121 diffs, sha256 `3709183ce65aa67bda6ffae80cb5d14d7cc56a10c28f58968e44bcd2b40d7435`
- Variants: `bench/variants-secret-1.json`, 1 questions, 3 variants, sha256 `ee4a734c6fb1b237a8462bf84d5f378780415e65c9babe1ca4c64450a87c5f8b`
- Plugin configuration: checks.json sha256 `6a16b08b69cc62897651fae8af10600585fc7e52976dad15a8ead49137378a11`, policy.json sha256 `95fc1c5ef997da0e400c6a751374cfc9e3a7a678eb9ce6622427d1c129dfb075`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 121 (0 failed); median latency 1.03 s, p95 1.11 s; mean input tokens per request (usage) 1661

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
| hardcoded_secret | chunk state | s_literal | `1-p(none)` | 0.992 | 0.403 | 0.991 | 11 | 110 |

## hardcoded_secret

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **s_literal** | `1-p(none)` | **0.992** | 0.411 | 0.008 | 0.403 | 0.044 | 0.0168 | 0.991 | 0.723 | 11 | 110 |
|  | attuale | `p` | 0.988 | 0.549 | 0.026 | 0.523 | 0.034 | 0.0610 | 0.973 | 0.768 | 11 | 110 |
|  | s_quote | `p` | 0.973 | 0.353 | 0.007 | 0.347 | 0.048 | 0.0195 | 0.936 | 0.682 | 11 | 110 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| hardcoded_secret | attuale (checks.json) | noul | `8fcf8b054f63808c454c265895289150720668f8095d443c65fd3ee9999154a1` |
| hardcoded_secret | s_literal | choice | `b07950a6179df36ad35270779121662e316dac60147557cf9f2b0927dea7b46b` |
| hardcoded_secret | s_quote | noul | `ef7ed97b60ca5b1cb19ae54ef3c842c5651a5bf186db63d5fa562b66ee352c51` |
