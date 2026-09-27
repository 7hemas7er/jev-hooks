#!/usr/bin/env bash
# Finds a Node with type stripping (>= 22.18) and runs src/hook/main.ts <event>.
# Same pattern as guardrail's run-python.sh: fail open when the interpreter is missing.
set -u
event="${1:-}"
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Prefilters in bash: no Node for git commands that are not a commit.
input=""
case "$event" in
  commit)
    input="$(cat)"
    case "$input" in *commit*) ;; *) exit 0 ;; esac ;;
  post-commit)
    # one file per session: if the directory is empty there is nothing to record
    [ -n "$(ls -A "${CLAUDE_PLUGIN_DATA:-/nonexistent}/pending" 2>/dev/null)" ] || exit 0
    input="$(cat)" ;;
  *)
    input="$(cat)" ;;
esac

for cand in "${JEV_HOOKS_NODE:-}" node nodejs; do
  [ -n "$cand" ] && command -v "$cand" >/dev/null 2>&1 || continue
  if "$cand" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(((a===22&&b>=18)||a>=23)&&process.features&&process.features.typescript?0:1)' 2>/dev/null; then
    # a here-string, not a pipe: with "printf | exec" the exec would happen in a subshell and the script would carry on
    exec "$cand" --disable-warning=ExperimentalWarning "$root/src/hook/main.ts" "$event" <<<"$input"
  fi
done

case "$event" in
  commit|skill|expand)
    printf '{"systemMessage":"[jev-hooks] Node >= 22.18 is needed (or JEV_HOOKS_NODE): review skipped"}\n' ;;
esac
echo "[jev-hooks] Node >= 22.18 with type stripping not found: hook not run" >&2
exit 0
