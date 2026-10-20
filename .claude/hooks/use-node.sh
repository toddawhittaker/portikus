#!/usr/bin/env bash
# SessionStart hook: put the .nvmrc Node first on PATH for every Bash call.
# settings.json "env" is literal and would replace PATH, so this goes
# through CLAUDE_ENV_FILE instead. Never fails the session.
set -u
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
# shellcheck source-path=SCRIPTDIR source=node-path.sh
. "$(dirname "$0")/node-path.sh"
bin="$(node_bin_for "${CLAUDE_PROJECT_DIR:-$PWD}")"
[ -n "$bin" ] || exit 0
# $PATH stays literal here so it expands when the env file runs.
# shellcheck disable=SC2016
printf 'export PATH="%s:$PATH"\n' "$bin" >>"$CLAUDE_ENV_FILE" || true
exit 0
