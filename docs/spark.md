# rizzo-flow on a DGX Spark

A step-by-step setup of the backend jev-hooks was developed against: rizzo-flow serving
Spark-X2.5-4B as GGUF BF16 on an NVIDIA DGX Spark, reachable from your LAN or tailnet
through a proxy that lets through only what jev-hooks needs. The timings measured on
that machine are in [rizzo-flow, self-hosted](backends.md#rizzo-flow-self-hosted-recommended-for-private-code).

Addresses here are examples: `192.168.1.50` stands for the Spark's LAN address and
`100.64.0.10` for its Tailscale address.

## 1. rizzo-flow

Install [rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow) as its README
says, with the llama.cpp runtime for linux-arm64 with CUDA and the model file. Then
start it by hand once:

```bash
rizzo serve --host 127.0.0.1 --port 8017 --quant bf16 --device cuda --ctx 8192
```

- **`--quant bf16` always.** The default is q8_0, which flips answers far more often
  (13 in 777 against 1 in 777 on rizzo-flow's own check), and the calibration profiles
  in `config/calibration.json` match the BF16 model's fingerprint.
- **`127.0.0.1` only.** rizzo's `RIZZO_API_KEY` protects `/v1/systemone` and
  `/v1/models` only: `/v1/decisions`, `/health`, `/docs` and `/playground` stay open,
  and there is no TLS. The proxy of step 3 is what faces the network.
- **Requests are serialized**, and a request the client abandons keeps running.

## 2. A systemd unit

`/etc/systemd/system/rizzo-reviewer.service`, with the user, paths and executable
adapted to your installation:

```ini
[Unit]
Description=rizzo-flow /v1/systemone for jev-hooks
After=network-online.target

[Service]
User=rizzo
WorkingDirectory=/opt/rizzo-flow
# 0600, owned by root: RIZZO_API_KEY=… (optional behind the proxy, defence in depth)
EnvironmentFile=/etc/rizzo/rizzo.env
ExecStart=/opt/rizzo-flow/.venv/bin/rizzo serve --host 127.0.0.1 --port 8017 --quant bf16 --device cuda --ctx 8192
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rizzo-reviewer
journalctl -u rizzo-reviewer -f     # model load: about 17 s
```

**One instance or two.** The effort router shares the reviewer's instance unless you
give it another: while a review is running its request waits, times out
(`timeout_ms` in `router.json`) and the turn keeps its effort. A second unit on port
8019 (same flags, so the same fingerprint and the same calibration profile) removes
that wait at the cost of about 10 GB more memory; set `router_url` to it.

## 3. The proxy

[`examples/spark/Caddyfile`](../examples/spark/Caddyfile) puts Caddy on the Spark's LAN
address, on the same port, in front of rizzo on loopback. It lets through
`POST /v1/systemone` and `GET /v1/models` with the right Bearer token and answers 403
to everything else; bodies over 512 KB get 413. It never redirects: the effort router's
requests go through Claude Code, which follows redirects with the request body.

It has been checked with `caddy validate` and `caddy fmt` (Caddy 2.11.4), and run on
loopback in front of a fake backend: the two routes with the token pass; without it,
with a wrong one, with another method or on any other path the answer is 403.

```bash
# the token Caddy checks, in the service's environment (0600)
sudo install -m 600 /dev/null /etc/caddy/caddy.env
echo "RIZZO_TOKEN=$(openssl rand -hex 32)" | sudo tee /etc/caddy/caddy.env >/dev/null
sudo systemctl edit caddy          # [Service] EnvironmentFile=/etc/caddy/caddy.env
sudo cp examples/spark/Caddyfile /etc/caddy/Caddyfile   # set the bind address first
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl restart caddy
```

Limit the port to your LAN (and the tailnet, if you use it):

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8017 proto tcp
sudo ufw allow in on tailscale0 to any port 8017 proto tcp
```

## 4. Check it with a real decision

Not with `rizzo devices`: a decision proves the model, the runtime and the proxy at
once. From another machine on the LAN, with the token in `$TOKEN`:

```bash
curl -s http://192.168.1.50:8017/v1/systemone \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"jev-latest","state":"The build failed with a stack trace.","questions":{"q":{"type":"noul","instructions":"Is there an error?"}}}'
```

The answer names the model `rizzo-spark-x2.5-4b-bf16`, carries an `x_rizzo.fingerprint`
and `probability_status: ["uncalibrated_conditional_option_scores"]`. The same request
without the header, or to `/v1/decisions`, must get 403.

## 5. The plugin

In `/plugin` → jev-hooks:

- `review_url`: `http://192.168.1.50:8017` (or `http://100.64.0.10:8017` over
  Tailscale); `router_url` only with a second instance;
- `api_key`: the proxy's token. It is a `sensitive` option: Claude Code keeps it out of
  `settings.json` and gives it only to the hooks. Never put it in the `env` block of
  your settings, which reaches every Bash command.

Then, in a new session, `/jev-hooks:jev-status`: it runs one real decision through the
hook and shows host, model, fingerprint, latency and the calibration profile it picked.
From a terminal, `bin/jev-review.mjs status --url http://192.168.1.50:8017` does the
same, with the key from `JEV_HOOKS_KEY` or `~/.config/jev-hooks/key`.

jev-hooks accepts `http://` only towards local hosts (loopback, private ranges,
`100.64.0.0/10`, `*.ts.net`, `*.local`); anything else must be `https://`.

## 6. From GitHub Actions

The review phase of [`examples/workflows/jev-review.yml`](../examples/workflows/jev-review.yml)
reaches the Spark through an ephemeral Tailscale node tagged `tag:ci`. On the Spark,
expose **Caddy**, not rizzo (forwarding to `127.0.0.1:8017` would skip the allowlist):

```bash
sudo tailscale serve --bg --https=8443 http://192.168.1.50:8017
```

Tailscale terminates TLS with the machine's tailnet certificate and forwards to Caddy,
whose `:8017` site answers whatever `Host` the request carries.

In the tailnet policy, let `tag:ci` reach only that port of the Spark, and let the
policy's own tests hold it there (the console refuses a change that breaks them):

```json
"tagOwners": { "tag:ci": ["autogroup:admin"] },
"grants": [
    { "src": ["tag:ci"], "dst": ["100.64.0.10"], "ip": ["tcp:8443"] },
],
"tests": [
    { "src": "tag:ci", "accept": ["100.64.0.10:8443"], "deny": ["100.64.0.10:22", "100.64.0.10:8017"] },
],
```

A rule that lets `*` reach `*:*` would let the CI node reach every machine: narrow its
source to `autogroup:member` first. Then create an OAuth client (Settings → Trust
credentials) with the writable `auth_keys` scope and the tag `tag:ci`.

In the repository, set the variables `JEV_TAILSCALE=true`, `JEV_URL`
(`https://<spark>.<tailnet>.ts.net:8443`) and `JEV_TAILSCALE_PING` (`<spark>.<tailnet>.ts.net`),
and the secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` and `JEV_API_KEY` (the proxy's
token). The ping matters: a new node reaches its peers only once they have heard of it,
and without the wait the review's first request failed to resolve the Spark's name.

## 7. CLM-8B instead of rizzo (measured, not recommended)

[CLM](https://github.com/Contrastive-LM/CLM) (Apache-2.0, by Contrastive-LM) serves the
same `POST /v1/systemone` contract with another kind of model: a frozen Qwen3-8B encoder
served by vLLM, and two small projection heads that score each option of a question
against the state. jev-hooks talks to it unchanged: its answers have Jev's shape, the
key is `CLM_API_KEY` (401 when wrong), and it counts as a backend of family `other`, so
up to four requests go in parallel. That was checked against CLM's own server app
(commit `bb42c6c`), with its mock encoder, for the 14 review questions and the 7 router
questions. On the Spark it runs next to rizzo with the commands below (vLLM 0.21.0,
torch 2.11 for CUDA 13, on the GB10), and it was measured there: on this bench it
separates far worse than rizzo, two review questions point the wrong way, and the
router's `risky_irreversible` fires on almost every prompt ([CLM-8B, self-hosted](backends.md#clm-8b-self-hosted-measured-not-recommended) has the
numbers, `bench/results/2026-09-29-clm-dev` and `…-clm-router-dev` the reports). Keep rizzo
for jev-hooks; this step stays for whoever wants to repeat the measurement.

Four things differ from rizzo, and each one matters here:

- **CLM truncates, rizzo refuses.** A state longer than `--max-tokens` (2048 by default)
  is cut with no error, and vLLM keeps the **last** tokens: the question survives, the
  head of the chunk (title, file names, the first lines of the diff) is dropped, and
  nothing tells jev-hooks. Chunks are about 2000 estimated tokens plus up to about 100
  of question, so 2048 is too tight. Raise both limits together to 4096.
- **The model is `clm-latest`.** `jev-latest`, the plugin's default, gets a 422 that
  `jev-review status` reports as a model the backend does not serve.
- **The probabilities are not rizzo's.** Each answer is a softmax over the question's
  own options, which CLM does not present as calibrated. `config/calibration.json` gives
  it the `clm-provisional` profile, with an unknown backend's wide band, and the
  thresholds of `policy.json` and `router.json` still come from rizzo; no threshold
  would fix a question whose answers do not separate. The deterministic detectors work
  the same on every backend.
- **Two processes, both on loopback.** `clm-serve` binds `0.0.0.0` unless told
  otherwise, and serves a playground at `/` and FastAPI's `/docs` without a key.

```bash
# the encoder: last-token pooling, as the reference head was trained
vllm serve Qwen/Qwen3-8B --served-model-name qwen3-8b --runner pooling \
  --enable-prefix-caching --max-model-len 4096 --gpu-memory-utilization 0.25 \
  --host 127.0.0.1 --port 8090
# the API: the heads are about 20M parameters and run on the CPU as well
clm-serve --host 127.0.0.1 --port 8700 --max-tokens 4096 --no-ui \
  --emb-url http://127.0.0.1:8090/v1/embeddings
```

On the Spark's unified memory, `--gpu-memory-utilization` is a share of the whole
128 GB: about 16 GB of BF16 weights plus the cache, next to rizzo's 10 GB. vLLM 0.21.0
with torch 2.11 for CUDA 13 runs on the GB10. `clm-serve` does not import vLLM, so it
lives in its own venv (`pip install --no-deps contrastive-lm` plus numpy, requests,
torch, fastapi and uvicorn) and reaches the encoder over HTTP; `clm-download` fetches
the head once, and `--no-download` then keeps the service from reaching the network.

In front of it, the same proxy: in the Caddyfile, a site `:8700` that imports the
snippet with `127.0.0.1:8700` (commented out at the end of the file), and the same
`ufw` rules for port 8700. The check of step 4 becomes:

```bash
curl -s http://192.168.1.50:8700/v1/systemone \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"clm-latest","state":"The build failed with a stack trace.","questions":{"q":{"type":"noul","instructions":"Is there an error?"}}}'
```

The answer names the model `clm-latest` and carries no `x_rizzo`. In the plugin, set
`review_url` to `http://192.168.1.50:8700` and `model` to `clm-latest` (the router uses
the same option); `/jev-hooks:jev-status` should then show the `clm-provisional`
profile.
