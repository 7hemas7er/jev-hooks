# Install

The repo is both a plugin and its own marketplace. Claude Code clones it with git from
GitHub (branch `main`).

```
/plugin marketplace add 7hemas7er/jev-hooks
/plugin install jev-hooks@7hemas7er-jev-hooks
```

From a local clone, to try or develop it:

```
/plugin marketplace add /path/to/jev-hooks
/plugin install jev-hooks@7hemas7er-jev-hooks
```

Requirements: **Node ≥ 22.18** (it runs TypeScript by stripping types, with no build
step and no dependencies). Claude Code starts hooks without the PATH of your interactive
shell, so the Node that nvm or fnm add from `~/.bashrc` is often not on it. The hook
launcher looks for a Node ≥ 22.18 with type stripping by itself, in this order:

1. `JEV_HOOKS_NODE`, if set;
2. `node` (then `nodejs`) on the PATH the hooks see;
3. version-manager installs, the highest version first: nvm (`$NVM_DIR`, default
   `~/.nvm`), fnm (`$FNM_DIR`, `~/.local/share/fnm`, `~/.fnm`, and
   `~/Library/Application Support/fnm` on macOS), volta (`$VOLTA_HOME`, default
   `~/.volta`), asdf (`$ASDF_DATA_DIR`, default `~/.asdf`), mise (`$MISE_DATA_DIR`,
   default `~/.local/share/mise`) and n (`$N_PREFIX`, default `/usr/local`);
4. Homebrew and system paths: `/opt/homebrew/bin`, `/home/linuxbrew/.linuxbrew/bin`,
   `/usr/local/bin`, `/usr/bin`.

Each candidate costs one short `node` run to check its version, and the search stops at
the first that passes, so it adds no noticeable time. Set `JEV_HOOKS_NODE` to the full
path of a node binary only when the search picks the wrong one or finds none: a Node
installed somewhere else, or a version manager whose directory variable is set only in
your shell. Without a suitable Node the hook skips the review with a notice that says
so, instead of failing your commit.

The effort router needs neither Node nor bash: it runs inside Claude Code, as a
function hook with requirements of its own (see
[What it needs](router.md#what-it-needs)).

Then open `/plugin`, pick jev-hooks and fill in its options:

| Option | Default | Meaning |
|---|---|---|
| `review_url` | empty (reviewer off) | Base URL of the `/v1/systemone` backend |
| `router_url` | empty (uses `review_url`) | Backend of the effort router, when it should not share the reviewer's |
| `api_key` | empty | Bearer key: required for TypeSafe, optional for rizzo with `RIZZO_API_KEY` |
| `router_api_key` | empty (uses `api_key` or the key file, only when `router_url` is empty or on `review_url`'s host) | Bearer key for `router_url` |
| `model` | `jev-latest` | Requested model, for the reviewer and the router; `jev-latest` also works with rizzo-flow |
| `commit_review` | `true` | Review when Claude runs `git commit` |
| `effort_router` | `false` | Turn the [effort router](router.md#effort-router-opt-in) on; it also needs function hooks |

**Where the key lives, and why.** `api_key` and `router_api_key` are `sensitive`
options: Claude Code keeps them out of `settings.json`. The command hooks receive the
options in their own environment, not in the environment of the commands Claude runs,
and the router gets them from Claude Code in-process, never through an environment.
That matters, because anything in the `env` block of your settings reaches every
Bash command, and a prompt injection in a file Claude reads could send it anywhere.
Fallbacks, in order of preference:

- `~/.config/jev-hooks/key`, one line, `chmod 600` (the commit hook warns when other
  users can read it; the router cannot check, see [Which backend](router.md#which-backend)).
  Hide it from Claude's sandbox:
  `"sandbox": {"credentials": {"files": [{"path": "~/.config/jev-hooks/key", "mode": "deny"}]}}`.
  A build installed from a local clone before this preview used another file name:
  see [Upgrading from an earlier local build](../CHANGELOG.md#upgrading-from-an-earlier-local-build);
- `JEV_HOOKS_URL` / `JEV_HOOKS_KEY` / `JEV_HOOKS_MODEL`, or `TYPESAFE_BASE_URL` /
  `TYPESAFE_API_KEY` / `TYPESAFE_DEFAULT_MODEL`. If they sit in your settings, deny
  them to the sandbox with `"sandbox": {"credentials": {"envVars": [{"name":
  "JEV_HOOKS_KEY", "mode": "deny"}, {"name": "TYPESAFE_API_KEY", "mode": "deny"}]}}`.
  The router reads none of these keys: from the environment it takes only a URL.

Each source is a layer of (URL, key, model), and a key is sent **only to the URL of its
own layer**: a `TYPESAFE_API_KEY` exported for the SDKs never travels in clear to the
rizzo box on your LAN. The key goes only in the `Authorization` header, never in URLs,
output, logs or error messages. The reviewer's client refuses redirects, so the key
cannot follow one to another host. The router's requests go through Claude Code's
`$.http.fetch`, which follows up to five redirects and drops `Authorization` when one
leads to another origin (another scheme, host or port): only a redirect within the
same origin still carries the key. The body is another matter: on a 307 or 308 the
request is sent again with its body, your prompt, to any http or https origin, see
[Which backend](router.md#which-backend).

Check the setup with `/jev-hooks:jev-status` in a new session, or from your own terminal
(Claude's sandbox cannot reach your LAN, which is why the skills run inside a hook):

```bash
bin/jev-review.mjs status --url http://192.168.1.50:8017   # from a clone
```

Without `--url` it uses `JEV_HOOKS_URL` or `TYPESAFE_*`; the key comes from the
environment or the key file, never from a flag.

It lists the backend's models, runs one real decision and prints host, model,
fingerprint, latency, the calibration profile it picked and where each config file came
from.

## Updating

The installed plugin is a copy in `~/.claude/plugins/cache/`, taken at install time,
and Claude Code compares version numbers, not commits: a change arrives with the
release that raises the version, and only when you ask for it:

```
/plugin marketplace update 7hemas7er-jev-hooks
/plugin update jev-hooks@7hemas7er-jev-hooks
```

Then run `/reload-plugins` in every open session, or start a new one: an open session
keeps the old hooks, and from 0.14.0 the first review says so.

## Turning it off

The reviewer: `commit_review: false` in `/plugin`, or `"hook": {"enabled": false}` in
your user `policy.json`. The effort router: `effort_router: false` (its default),
`JEV_HOOKS_ROUTER=0`, or `"enabled": false` in your user or the project's
`router.json` ([more](router.md#switches)). The skills run only when asked, whatever
`commit_review` says. `JEV_HOOKS_DISABLE=1` turns off everything: the reviewer, the
skills (they answer that the plugin is off), the guard and the router. If you also
run Anthropic's security-guidance plugin, it reviews `git commit` too: keep both, or
switch one off.
