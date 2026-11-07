#!/usr/bin/env bash
# Tests the smoke test's chat probe (smoke/chat-probe.mjs) against a stand-in
# chat socket: it must pass a socket that sends the snapshot first and
# answers set {mode: "plan"} with a settings event, and fail a socket that
# does neither, closes early, or stays silent. Needs Node 22 or newer for its
# built-in WebSocket client, and no VM.
# Usage: ./infra/tests/chat-probe-test.sh
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${here}/lib.sh"

work="$(mktemp -d)"
server_pid=""
trap '[ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null; rm -rf "${work}"' EXIT

if ! node -e 'process.exit(typeof WebSocket === "function" ? 0 : 1)' 2>/dev/null; then
  echo "chat-probe-test: this Node has no built-in WebSocket (needs 22 or newer)" >&2
  exit 1
fi

# run_probe SCENARIO TIMEOUT_MS -- the probe's output and exit code, in
# probe_out and probe_rc.
run_probe() {
  node "${here}/fixtures/fake-chat-server.mjs" "$1" >"${work}/port" &
  server_pid=$!
  local i
  for ((i = 0; i < 50; i++)); do
    [ -s "${work}/port" ] && break
    sleep 0.1
  done
  probe_rc=0
  probe_out=$(echo "portikus_session=x" \
    | node "${here}/smoke/chat-probe.mjs" "ws://127.0.0.1:$(cat "${work}/port")/chat" http://localhost "$2" 2>&1) || probe_rc=$?
  kill "$server_pid" 2>/dev/null
  wait "$server_pid" 2>/dev/null
  server_pid=""
  rm -f "${work}/port"
}

run_probe good 5000
expect_eq "a good socket: the probe exits 0" 0 "$probe_rc"
expect_eq "a good socket: the snapshot comes first" snapshot "$(head -n 1 <<<"$probe_out")"
expect_eq "a good socket: the plan settings event is seen" settings-plan "$(grep -x settings-plan <<<"$probe_out")"

run_probe no-snapshot 1500
expect_eq "settings before any snapshot: the probe fails" 1 "$probe_rc"
expect_eq "settings before any snapshot: the first frame is named" first-frame-settings "$(head -n 1 <<<"$probe_out")"

run_probe ignores-set 1500
expect_eq "a socket that ignores set: the probe times out" 1 "$probe_rc"
expect_eq "a socket that ignores set: it says so" timeout "$(tail -n 1 <<<"$probe_out")"

run_probe refuses 5000
expect_eq "a socket closed with 4404: the probe fails" 1 "$probe_rc"
expect_eq "a socket closed with 4404: the code is named" closed-4404 "$(grep -x closed-4404 <<<"$probe_out")"

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
