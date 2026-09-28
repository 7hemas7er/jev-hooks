# Question measurement

- Date: 2026-09-28
- Backend: `<tailnet host>:8443` (local; the Spark through Tailscale, host name removed), requested model `jev-latest`
- Declared model: `rizzo-spark-x2.5-4b-bf16`
- Fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- probability_status: `uncalibrated_conditional_option_scores`
- Dataset: `bench/dev.jsonl`, 118 diffs, sha256 `bc9e6d40ad995119358a2a2a76f0f6ac7603975ba19213d2d7a8f317da3c4b03`
- Variants: `bench/variants-weakens.json`, 1 questions, 5 variants, sha256 `29d90f7ca4a494b625267375177b9f58574ca71abbc3bb74d40ff9d2023dcddd`
- Plugin configuration: checks.json sha256 `4dafe5336c605f94659a5843a913b6f3cb966347563895041f4c2236d6c4d1cf`, policy.json sha256 `536d9c8126c4978a05774c1029076fe6a2e5b84b1e042be4b8ef09248a5b2986`; 2000 tokens per state, chunks planned with the hook limits
- Placeholder seed: 1; repeats: 1; Node v24.21.0
- Requests: 118 (0 failed); median latency 0.54 s, p95 0.62 s; mean input tokens per request (usage) 2198

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

## weakens_tests

Question asked on the chunk state (scope `chunk` as in checks.json).

|  | variant | readout | AUROC | mean + | mean − | separation | Brier | best threshold | bal. acc. | bal. acc. at 0.5 | n+ | n− |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ★ | **attuale** | `1-p(none)` | **0.999** | 0.997 | 0.049 | 0.948 | 0.021 | 0.9532 | 0.995 | 0.986 | 9 | 109 |
|  | g_strict_order | `1-p(none)` | 0.998 | 0.896 | 0.016 | 0.880 | 0.012 | 0.0694 | 0.991 | 0.940 | 9 | 109 |
|  | h_noul | `p` | 0.998 | 0.859 | 0.081 | 0.778 | 0.019 | 0.4218 | 0.995 | 0.884 | 9 | 109 |
|  | e_strict | `1-p(none)` | 0.983 | 0.860 | 0.031 | 0.830 | 0.018 | 0.6055 | 0.940 | 0.940 | 9 | 109 |
|  | f_strict_files | `1-p(none)` | 0.967 | 0.948 | 0.481 | 0.467 | 0.256 | 0.9475 | 0.944 | 0.734 | 9 | 109 |

## Variant hashes

| question | variant | type | sha256 |
|---|---|---|---|
| weakens_tests | attuale (checks.json) | choice | `1feb3ec470b86f0ec13998002f90ba4736dae11ba8b7b9d01e63a7f6bfb0af12` |
| weakens_tests | e_strict | choice | `cf18bae2be5de01af299ae1085b9e13094b41dbf7fb078c4d6889201382cfdec` |
| weakens_tests | f_strict_files | choice | `cc14487aca0e59a983bd57f8198fe99f2f9484082fc5d6eca68ce95094fedd08` |
| weakens_tests | g_strict_order | choice | `c90aceb308c437b85365c24c883aea48cbd985558719ae9075082a3d1de96695` |
| weakens_tests | h_noul | noul | `2cdbd88df6336012659467cdbac086acea6f5871d9940178ce077923ec41f24c` |
