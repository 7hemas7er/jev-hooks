#!/usr/bin/env bash
# Finds a Node with type stripping (>= 22.18) and runs src/hook/main.ts <event>.
# Same pattern as guardrail's run-python.sh: fail open when the interpreter is missing.
#
# Claude Code starts hooks without the PATH of your interactive shell, so the Node that
# nvm or fnm put on PATH from ~/.bashrc is not there. Candidates, in order:
#   1. JEV_HOOKS_NODE;
#   2. node, then nodejs, on PATH;
#   3. version-manager installs (nvm, fnm, volta, asdf, mise, n), highest version first;
#   4. Homebrew and system paths.
# Each candidate costs one node run (the probe) and the search stops at the first that
# passes it: when JEV_HOOKS_NODE or the PATH node works, nothing is globbed or probed.
# Portable to macOS's bash 3.2: no mapfile, no associative arrays, and no "${a[@]}" on
# an array that may be empty (an unbound variable under set -u before bash 4.4).
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

nl='
'
home="${HOME:-}"
# For the tests only: a prefix for the fixed system paths, so that they do not find the
# Node of the machine they run on.
sys="${JEV_HOOKS_TEST_SYSROOT:-}"
tried="$nl"

# usable <path>: an executable file whose probe says ">= 22.18, type stripping on".
# The probe prints "<version> <true|false>", e.g. "24.3.0 true"; the comparison is done
# here, so a path is never probed twice.
usable() {
  local out ver maj min
  [ -f "$1" ] && [ -x "$1" ] || return 1
  case "$tried" in *"$nl$1$nl"*) return 1 ;; esac
  tried="$tried$1$nl"
  out="$("$1" -p 'process.versions.node+" "+!!(process.features&&process.features.typescript)' </dev/null 2>/dev/null)" || return 1
  out="${out##*$nl}"
  case "$out" in *" true") ;; *) return 1 ;; esac
  ver="${out%% *}"
  maj="${ver%%.*}"
  min="${ver#*.}"
  min="${min%%.*}"
  case "$maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$min" in ''|*[!0-9]*) return 1 ;; esac
  [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 18 ]; }
}

# run_with <path>: replaces this shell with the hook when the path is usable, else returns.
run_with() {
  usable "$1" || return 1
  # a here-string, not a pipe: with "printf | exec" the exec would happen in a subshell and the script would carry on
  exec "$1" --disable-warning=ExperimentalWarning "$root/src/hook/main.ts" "$event" <<<"$input"
}

if [ -n "${JEV_HOOKS_NODE:-}" ]; then
  p="$(command -v "$JEV_HOOKS_NODE" 2>/dev/null)" && run_with "$p"
  echo "[jev-hooks] JEV_HOOKS_NODE=$JEV_HOOKS_NODE is not a Node >= 22.18 with type stripping: looking elsewhere" >&2
fi

for name in node nodejs; do
  p="$(command -v "$name" 2>/dev/null)" && run_with "$p"
done

# Version managers: one directory per installed version. The version is read from the
# directory name (v24.3.0 or 24.3.0) to probe the highest first; the probe still has the
# last word. A name below 22.18 is skipped without a probe; a name that is not a version
# (mise's "lts" alias, say) is probed last.
shopt -s nullglob
count=0
# add <directory with one subdirectory per version> <node inside a version directory>
add() {
  local d v a b c key
  for d in "$1"/*; do
    [ -f "$d/$2" ] && [ -x "$d/$2" ] || continue
    v="${d##*/}"
    v="${v#v}"
    key=0
    case "$v" in
      *.*.*)
        a="${v%%.*}"
        v="${v#*.}"
        b="${v%%.*}"
        c="${v#*.}"
        c="${c%%[!0-9]*}"
        case "$a:$b:$c" in
          *[!0-9:]*|:*|*::*|*:) ;;
          *) key=$((10#$a * 1000000 + 10#$b * 1000 + 10#$c)) ;;
        esac ;;
    esac
    [ "$key" -eq 0 ] || [ "$key" -ge 22018000 ] || continue
    paths[$count]="$d/$2"
    keys[$count]=$key
    count=$((count + 1))
  done
}
add "${NVM_DIR:-$home/.nvm}/versions/node" bin/node
add "${FNM_DIR:-$home/.local/share/fnm}/node-versions" installation/bin/node
add "$home/.fnm/node-versions" installation/bin/node
add "$home/Library/Application Support/fnm/node-versions" installation/bin/node
add "${VOLTA_HOME:-$home/.volta}/tools/image/node" bin/node
add "${ASDF_DATA_DIR:-$home/.asdf}/installs/nodejs" bin/node
add "${MISE_DATA_DIR:-$home/.local/share/mise}/installs/node" bin/node
add "${N_PREFIX:-$sys/usr/local}/n/versions/node" bin/node

# Highest key first; on a tie the earlier manager in the list above wins. A probed
# candidate gets key -1, so each one is probed at most once.
while :; do
  best=-1
  top=-1
  i=0
  while [ "$i" -lt "$count" ]; do
    if [ "${keys[$i]}" -gt "$top" ]; then
      best=$i
      top=${keys[$i]}
    fi
    i=$((i + 1))
  done
  [ "$best" -ge 0 ] || break
  keys[$best]=-1
  run_with "${paths[$best]}"
done

for p in /opt/homebrew/bin/node /home/linuxbrew/.linuxbrew/bin/node /usr/local/bin/node /usr/bin/node; do
  run_with "$sys$p"
done

case "$event" in
  commit|skill|expand)
    printf '{"systemMessage":"[jev-hooks] review skipped: Node >= 22.18 was not found on PATH nor in nvm, fnm, volta, asdf, mise, n or Homebrew. Set JEV_HOOKS_NODE to the full path of a node >= 22.18."}\n' ;;
esac
echo "[jev-hooks] Node >= 22.18 with type stripping not found on PATH nor in nvm, fnm, volta, asdf, mise, n, Homebrew, /usr/local/bin or /usr/bin: hook not run. Set JEV_HOOKS_NODE to its full path." >&2
exit 0
