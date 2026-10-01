#!/usr/bin/env bash
# alice's workspace: presence, the grace period, start and stop, persistence.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

created_workspace_ids+=("$ws_id")
ok "POST /workspaces returned id=${ws_id}"

# Poll until the workspace reaches "stopped" (provisioned).
echo "Waiting for workspace to reach stopped state..."
ws_state=""
for _ in $(seq 1 60); do
  ws_state=$(workspace_state)
  if [ "$ws_state" = "stopped" ]; then break; fi
  sleep 2
done
check_output "workspace reaches stopped after provision" "stopped" echo "$ws_state"

ws_instance=$(vm_get alice "${API}/workspaces/${ws_id}" | json_field incusInstanceName)
if [ -n "$ws_instance" ]; then
  created_instance_names+=("$ws_instance")
  check "Incus instance exists and is Stopped" \
    ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
fi

# 7. Install the presence WebSocket client on the VM.  It sends one
#    heartbeat, waits for the first server message, and stays open until
#    the stop file appears, which is how the test controls the session.
ssh_cmd_stdin "cat > ${WS_PROBE}" <<'PROBE'
import fs from "node:fs";
const [url, origin, stopFile] = process.argv.slice(2);
// The session cookie arrives on standard input so that it never appears
// in a command line or a process list.
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
let sawMessage = false;
ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "heartbeat" })));
ws.addEventListener("message", () => {
	if (!sawMessage) {
		sawMessage = true;
		console.log("message");
	}
});
ws.addEventListener("error", (event) => {
	console.error("socket error", event.message ?? "");
	process.exit(1);
});
ws.addEventListener("close", () => process.exit(sawMessage ? 0 : 1));
const poll = setInterval(() => {
	if (fs.existsSync(stopFile)) {
		clearInterval(poll);
		ws.close();
	}
}, 500);
// Safety net: never leave the probe running if the test dies.
setTimeout(() => ws.close(), 300000);
PROBE

alice_cookie=$(session_cookie alice)
probe_log=$(mktemp)

open_socket() {
  ssh_cmd "rm -f ${WS_STOP}"
  printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
    | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt ${VM_NODE} ${WS_PROBE} \
        'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/ws' '${API}' '${WS_STOP}'" >"$probe_log" 2>&1 &
  probe_pid=$!
  sleep 3
}

close_socket() {
  ssh_cmd "touch ${WS_STOP}"
  wait "$probe_pid" || true
  sleep 2
}

# 8. Starts on connect: opening the socket makes the workspace run.
echo ""
echo "Opening the presence WebSocket..."
open_socket
check "socket received a workspace message"   grep -q message "$probe_log"
check_output "one connection row while open" "1" connection_count

echo "Waiting for workspace to reach running state..."
ws_state=$(wait_for_state running 60)
check_output "workspace reaches running after connect" "running" echo "$ws_state"

if [ -n "$ws_instance" ]; then
  check "Incus instance is Running" \
    ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: RUNNING'"
fi

# 9. Stays up during grace: close the socket, wait 10 s, still running.
echo ""
echo "Closing the socket to test the grace period..."
close_socket
check_output "no connection rows after close" "0" connection_count
sleep 10
check_output "still running 10s after disconnect" "running" echo "$(workspace_state)"
check_output "shutdown deadline is set" "set" echo "$(workspace_deadline)"

# 10. Reconnect cancels the deadline.
echo ""
echo "Reconnecting to cancel the shutdown deadline..."
open_socket
ws_deadline=""
for _ in $(seq 1 6); do
  ws_deadline=$(workspace_deadline)
  if [ "$ws_deadline" = "null" ]; then break; fi
  sleep 1
done
check_output "reconnect clears deadline" "null" echo "$ws_deadline"

# Still running after 25 s (grace was 20 s — it would have stopped).
sleep 25
check_output "still running 25s after reconnect" "running" echo "$(workspace_state)"

# 10b. Zero means indefinite: a disconnected workspace keeps running and
#      no deadline is ever armed.
echo ""
echo "Setting the platform grace period to 0 (never stop)..."
check_output "admin sets the grace period to 0" "0" set_global_grace 0
close_socket
sleep 25
check_output "still running 25s after disconnect at grace 0" "running" \
  echo "$(workspace_state)"
check_output "no shutdown deadline at grace 0" "null" echo "$(workspace_deadline)"

# 10c. A per-user override beats the global value and applies at once, even
#      though alice disconnected before it was set.  60 s first, so the
#      deadline is visible in the future; 10 s then puts it in the past and
#      the workspace stops on that sweep.
echo ""
echo "Giving alice an override while the platform value stays 0..."
check_output "admin sets alice's override to 60" "60" set_user_grace "$alice_id" 60
ws_deadline=""
for _ in $(seq 1 10); do
  ws_deadline=$(workspace_deadline)
  if [ "$ws_deadline" = "set" ]; then break; fi
  sleep 1
done
check_output "alice's override arms a deadline" "set" echo "$ws_deadline"
check_output "still running on the 60s override" "running" echo "$(workspace_state)"

check_output "admin shortens alice's override to 10" "10" set_user_grace "$alice_id" 10
check_output "workspace stops once the override expires" "stopped" \
  echo "$(wait_for_state stopped 60)"

# Back to where this test started: no override, platform value 20 s.
check_output "admin clears alice's override" "200" \
  http_status carol "${API}/admin/users/${alice_id}/settings" \
  "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":null}'"
check_output "admin sets the grace period back to 20s" "20" set_global_grace 20

echo ""
echo "Reconnecting before the grace expiry check..."
open_socket
check_output "workspace runs again after reconnect" "running" \
  echo "$(wait_for_state running 60)"

# 11. Stops after grace: close the socket and wait.
echo ""
echo "Closing the socket to let the grace period expire..."
close_socket
ws_state=$(wait_for_state stopped 60)
check_output "workspace stops after grace expires" "stopped" echo "$ws_state"

if [ -n "$ws_instance" ]; then
  check "Incus instance is Stopped after grace" \
    ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
fi

check "audit_events has workspace.stop" \
  ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE action = 'workspace.stop'\" | grep -qv '^0$'"

# 12. Explicit start then stop through the API.
echo ""
echo "Testing explicit start/stop..."
http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
check_output "explicit start reaches running" "running" echo "$(wait_for_state running 60)"

http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
check_output "explicit stop reaches stopped" "stopped" echo "$(wait_for_state stopped 60)"

# 13. Persistence across an API-driven stop and start.
if [ -n "$ws_instance" ]; then
  echo ""
  echo "Re-running persistence check on ${ws_instance}..."
  http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
  ws_state=$(wait_for_state running 60)

  if [ "$ws_state" = "running" ]; then
    sleep 5
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'echo epic3-persist > ~/projects/.epic3-marker'" 2>/dev/null || true
    http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
    wait_for_state stopped 60 >/dev/null
    http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
    wait_for_state running 60 >/dev/null
    sleep 5
    check "persistence marker survives restart (Epic 2 re-check)" \
      ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'cat ~/projects/.epic3-marker'" 2>/dev/null
  fi
fi
