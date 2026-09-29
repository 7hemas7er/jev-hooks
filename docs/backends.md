# Backends

The backends speak the same contract, `POST /v1/systemone` with `{state, model,
questions}`, and jev-hooks treats them the same way. They differ in where your diff
goes, and in how far their answers have been measured.

## rizzo-flow, self-hosted (recommended for private code)

[rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow) (Apache-2.0, by Rizzo AI
Academy) is an open-source server compatible with Jev's endpoint. It runs the
Spark-X2.5-4B model through llama.cpp, computes each answer from the logits of the
option letters, and keeps the whole diff on your own hardware.

It was developed and measured against rizzo-flow (commit `f363583`) serving the 4B
model as **GGUF BF16 on an NVIDIA DGX Spark** (GB10, aarch64, CUDA). BF16 because
rizzo-flow's own check found 1 answer flip in 777 between its shared and direct modes,
against 13 for Q8_0. Measured on that machine:

| What | Result |
|---|---|
| Model load | 17 s; memory peak about 10 GB with `--ctx 8192` |
| 14 questions on an 8000-character diff state (3754 tokens) | **1.00 s** warm, 1.16 s on the first call |
| Tokenization of diffs | about 2.9 characters per token |
| Holdout bench: 242 requests, about 1.8k input tokens each | median **0.28 s**, p95 0.59 s |
| Dev bench: 236 requests carrying 44 question variants, about 5.9k input tokens each | median 0.82 s, p95 1.94 s |
| 7 router questions on a short prompt (663 tokens) | 0.22 s warm |

Things to know before you expose it:

- **Requests are serialized** (one lock), and a request the client abandons keeps
  running. jev-hooks never retries a timeout. The effort router shares the reviewer's
  instance unless you give it another one: during a review it times out and leaves the
  turn's effort alone (see [Which backend](router.md#which-backend)).
- **`--ctx` is per question** (state plus question). Chunks of about 2000 tokens stay
  far below the default 8192; an overflow comes back as a 422 that jev-hooks recognizes
  and answers by re-splitting.
- **rizzo's own auth is thin.** `RIZZO_API_KEY` protects only `/v1/systemone` and
  `/v1/models`; `/v1/decisions`, `/health`, `/docs` and `/playground` stay open, and
  there is no TLS. Bind it to `127.0.0.1` and put a reverse proxy in front that lets
  through only `POST /v1/systemone` and `GET /v1/models`, reachable over your LAN or
  Tailscale. The proxy must answer them itself, never with a redirect (no
  http-to-https or canonical-host 301/308 on those paths): the effort router's requests
  go through Claude Code, which follows redirects (see [Which backend](router.md#which-backend)).
- jev-hooks accepts `http://` **only towards local hosts** (loopback, private ranges,
  `100.64.0.0/10` for Tailscale, `*.ts.net`, `*.local`). Anything else must be
  `https://`, checked before a byte is sent. The check covers the URL you configure,
  not the target of a redirect.

```bash
rizzo serve --host 127.0.0.1 --port 8017 --quant bf16 --device cuda
```

Then set `review_url` to your proxy, for example `http://192.168.1.50:8017` on the LAN
or `http://100.64.0.10:8017` over Tailscale. [docs/spark.md](spark.md) is a
step-by-step guide for a DGX Spark: a systemd unit, a checked proxy configuration
([`examples/spark/Caddyfile`](../examples/spark/Caddyfile)), a real-decision test and the
tailnet setup for GitHub Actions.

## CLM-8B, self-hosted (measured: not recommended)

[CLM](https://github.com/Contrastive-LM/CLM) (Apache-2.0, by Contrastive-LM) answers the
same contract with a Qwen3-8B encoder served by vLLM and small projection heads that
score each option against the state. jev-hooks works with it unchanged; set the model
to `clm-latest`. On a DGX Spark, next to rizzo, it was measured on the same dev bench
and router prompts (`bench/results/2026-09-29-clm-dev`, `…-clm-router-dev`):

| AUROC of the current wording | rizzo | CLM |
|---|--:|--:|
| `hardcoded_secret` | 0.925 | 0.372 |
| `touches_auth` | 0.980 | 0.434 |
| `injection_risk` | 0.994 | 0.666 |
| `weakens_tests` | 0.994 | 0.851 |
| `data_migration` | 1.000 | 0.525 |
| router `has_error_evidence` | 1.000 | 0.522 |
| router `risky_irreversible` | 1.000 | 0.672 |

Below 0.5 a question points the wrong way. Across the 44 wordings of the bench, CLM's
best reaches 0.85, where rizzo's best reach 0.94 to 1.00 on every question but
`description_matches` (0.66 for rizzo, 0.62 for CLM). With CLM the router answers
"risky" to almost every prompt, so a session at high never goes lower. It is faster (median 0.57 s against 0.82 s on the
dev bench, 0.26 s against 0.37 s on the router's prompts), but its heads were trained
to score agent actions, not to read diffs. Keep rizzo; CLM gets the `clm-provisional`
calibration profile, with an unknown backend's wide band, for whoever tries it anyway.
It also truncates instead of refusing: past `--max-tokens` (2048 by default) the head
of the state is cut with no error, so serve it with 4096 on both vLLM and `clm-serve`.
[docs/spark.md](spark.md#7-clm-8b-instead-of-rizzo-measured-not-recommended) has
the commands.

## TypeSafe Jev, with your own key

Point `review_url` at `https://api.typesafe.ai` and set your own API key. Keys are
personal: TypeSafe's terms rule out shared proxies and distillation, so jev-hooks never
proxies a key and never turns Jev's answers into training labels.

With Jev, the diff leaves your machine. Before sending, jev-hooks replaces every secret
its detectors recognize with a random value of the same shape, sends sensitive files
(`.env`, `.pem`, `credentials`…) as a path only, and applies guardrail's mask map if you
have one. A secret no regex recognizes still goes out: for private repositories, prefer
a local rizzo.

The thresholds were measured on rizzo, not on Jev. The `jev` calibration profile
trusts TypeSafe's statement that its probabilities are calibrated (identity), which has
not been verified on diffs.
