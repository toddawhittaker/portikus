#!/usr/bin/env bash
# Stop hook for agents that edit TypeScript: refuse to finish while
# typecheck or lint fails in the agent's working directory. It always runs
# both checks; a few minutes is cheaper than a red CI run.
set -u
input="$(cat)"
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
else
  cwd="$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))')"
fi
[ -n "$cwd" ] || exit 0
cd "$cwd" 2>/dev/null || exit 0

# Only a pnpm checkout with dependencies installed can be checked.
if [ ! -f package.json ] || [ ! -f pnpm-workspace.yaml ] || [ ! -d node_modules ]; then
  exit 0
fi

# shellcheck source-path=SCRIPTDIR source=node-path.sh
. "$(dirname "$0")/node-path.sh"
bin="$(node_bin_for "$PWD")"
[ -n "$bin" ] && export PATH="$bin:$PATH"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
for check in typecheck lint; do
  if ! corepack pnpm --silent "$check" >"$log" 2>&1; then
    {
      echo "pnpm $check failed in $PWD. Fix it before you finish. Last lines:"
      tail -n 40 "$log"
    } >&2
    exit 2
  fi
done
exit 0
