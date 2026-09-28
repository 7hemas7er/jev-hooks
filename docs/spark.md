# rizzo-flow on a DGX Spark

A step-by-step setup of the backend jev-hooks was developed against: rizzo-flow serving
Spark-X2.5-4B as GGUF BF16 on an NVIDIA DGX Spark, reachable from your LAN or tailnet
through a proxy that lets through only what jev-hooks needs. The timings measured on
that machine are in the README ([rizzo-flow, self-hosted](../README.md#rizzo-flow-self-hosted-recommended-for-private-code)).

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
whose `:8017` site answers whatever `Host` the request carries. In the tailnet's ACL,
let `tag:ci` reach only that port of the Spark. In the repository, set the variables
`JEV_TAILSCALE=true` and `JEV_URL` (`https://<spark>.<tailnet>.ts.net:8443`), and the
secrets `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` and `JEV_API_KEY` (the proxy's token).
