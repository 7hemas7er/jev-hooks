# Calibration fit (2026-09-30)

- Fit set: `bench/results/2026-09-26-dev-checks`
- Check set: `bench/results/2026-09-26-holdout` (never used by the fit)
- Backend fingerprint: `64219e54c725bb176157e0d2905bd3133401ee592ac4504660e5a8bf7310737a`
- Method: Platt scaling per question, p' = σ(a · logit(p) + b), on the p of the sent question, with Platt's smoothed targets; adopted when a > 0 and the check set's log-loss goes down

Values are raw → calibrated. Lower is better for log-loss, Brier and ECE; AUROC does not change with calibration.

| question | a | b | fit n (pos.) | check n (pos.) | log-loss fit | log-loss check | Brier check | ECE check | AUROC check | decision |
|---|--:|--:|--:|--:|---|---|---|---|--:|---|
| hardcoded_secret | 0.7304 | -0.5675 | 118 (9) | 121 (11) | 0.099 → 0.103 | 0.115 → 0.131 | 0.035 → 0.041 | 0.044 → 0.057 | 0.987 | kept as it comes: the log-loss does not go down on the check set |
| injection_risk | 0.5244 | -3.6716 | 118 (8) | 121 (12) | 0.357 → 0.045 | 0.657 → 0.124 | 0.142 → 0.040 | 0.215 → 0.052 | 0.976 | adopted |
| touches_auth | 0.3489 | -1.0507 | 118 (10) | 121 (14) | 0.191 → 0.125 | 0.237 → 0.160 | 0.056 → 0.047 | 0.058 → 0.050 | 0.969 | adopted |
| weakens_tests | 0.5187 | -2.5736 | 118 (9) | 121 (12) | 0.101 → 0.039 | 0.144 → 0.096 | 0.030 → 0.027 | 0.074 → 0.048 | 0.995 | adopted |
| adds_tests | 0.5094 | 1.0923 | 118 (77) | 121 (60) | 0.318 → 0.230 | 0.429 → 0.328 | 0.097 → 0.097 | 0.083 → 0.054 | 0.937 | adopted |
| breaks_api | 0.6017 | -1.9886 | 118 (12) | 121 (16) | 0.319 → 0.168 | 0.410 → 0.221 | 0.101 → 0.059 | 0.124 → 0.061 | 0.901 | adopted |
| data_migration | 0.5217 | -1.9818 | 118 (7) | 121 (10) | 0.026 → 0.023 | 0.152 → 0.066 | 0.033 → 0.017 | 0.052 → 0.036 | 0.992 | adopted |
| description_matches | -0.0138 | -2.3948 | 118 (9) | 121 (11) | 5.695 → 0.269 | 5.623 → 0.307 | 0.852 → 0.083 | 0.865 → 0.014 | 0.608 | kept as it comes: a = -0.0138: the answers do not order the labels |
| debug_leftovers | 0.6546 | -1.5530 | 118 (8) | 121 (11) | 0.083 → 0.063 | 0.132 → 0.104 | 0.033 → 0.026 | 0.052 → 0.041 | 0.966 | adopted |

## Thresholds on the calibrated scale

On a calibrated question the reviewer still decides on the raw value against the policy's threshold, so every verdict stays as on the raw scale; it shows the threshold moved through the fit, next to the calibrated value.

| lane | rule | raw | calibrated |
|---|---|--:|--:|
| NITS | injection_risk ≥ | 0.99 | 0.221 |
| NITS | weakens_tests ≥ | 0.50 | 0.071 |
| NITS | touches_auth ≥ | 0.70 | 0.320 |
| NITS | breaks_api ≥ | 0.90 | 0.339 |
| NITS | data_migration ≥ | 0.20 | 0.063 |
| NITS | debug_leftovers ≥ | 0.40 | 0.140 |
| NITS | adds_tests ≤ | 0.30 | 0.179 |

## Reading it

The fit set has 149 positives in 1062 answers (14.0%). The calibrated p is right for a mix of problems like the bench's; real commits have fewer, so on them it reads high.
