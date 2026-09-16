#!/usr/bin/env bash
# Smoke test for the pilot infrastructure (STACK.md section 33).
#
# Run this after `make infra-apply && make configure-vm` to verify
# the acceptance criteria for Epic 1.  It connects to the platform VM
# over SSH and checks each subsystem.
#
# Every probe runs through the `check` helper so that a single failure
# is recorded as FAIL and the script continues to the end.
#
# Usage: ./infra/tests/smoke-test.sh <vm-ip>
set -uo pipefail

VM="${1:?Usage: smoke-test.sh <vm-ip>}"

pass=0
fail=0

ssh_cmd() {
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${VM}" "$@"
}

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s\n' "$label"
    fail=$((fail + 1))
  fi
}

# check_output LABEL EXPECTED CMD [ARGS...]
# Captures stdout from CMD, compares it to EXPECTED.
check_output() {
  local label="$1" expected="$2"; shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  if [ "$actual" = "$expected" ]; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (got: %s)\n' "$label" "$actual"
    fail=$((fail + 1))
  fi
}

# check_gt LABEL THRESHOLD CMD [ARGS...]
# Captures a numeric value from CMD and checks that it is greater than THRESHOLD.
check_gt() {
  local label="$1" threshold="$2"; shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  actual="${actual:-0}"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (got: %s)\n' "$label" "$actual"
    fail=$((fail + 1))
  fi
}

# check_zero_lines LABEL CMD [ARGS...]
# Passes when CMD produces zero lines of output.
check_zero_lines() {
  local label="$1"; shift
  local count
  count=$("$@" 2>/dev/null | wc -l) || true
  if [ "${count:-1}" -eq 0 ] 2>/dev/null; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (%s lines)\n' "$label" "$count"
    fail=$((fail + 1))
  fi
}

echo "--- Portikus pilot smoke test ---"
echo "Target: ${VM}"
echo ""

# 1. SSH reachability
check "SSH to platform VM"                    ssh_cmd true

# 2. Incus is running
check "Incus daemon is active"                ssh_cmd systemctl is-active incus

# 3. LVM volume group exists
check "LVM volume group portikus-data"        ssh_cmd sudo vgs portikus-data

# 4. LVM thin pool exists
check "LVM thin pool thinpool"                ssh_cmd sudo lvs portikus-data/thinpool

# 5. Incus storage pool exists
check "Incus storage pool workspace-data"     ssh_cmd incus storage show workspace-data

# 6. Incus network exists
check "Incus network portikus-ws"             ssh_cmd incus network show portikus-ws

# 7. Incus project exists
check "Incus project portikus"                ssh_cmd incus project show portikus

# 8. Workspace profile exists
check "Incus workspace profile"               ssh_cmd incus profile show workspace --project portikus

# 9. nftables is loaded
check "nftables is active"                    ssh_cmd systemctl is-active nftables

# 10. IP forwarding is enabled
# shellcheck disable=SC2016  # expansion is intentionally remote-side
check "IPv4 forwarding"                       ssh_cmd 'test "$(/usr/sbin/sysctl -n net.ipv4.ip_forward)" = 1'

# 11. Data disk is a PV
check "Data disk is an LVM PV"               ssh_cmd sudo pvs /dev/vdb

echo ""
echo "--- Epic 1 results: ${pass} passed, ${fail} failed ---"
echo ""

# ── Epic 2: Workspace image and nested Docker ────────────────────
# These checks run only when the portikus workspace image is imported.
if ssh_cmd incus image info portikus --project portikus >/dev/null 2>&1; then
  echo "--- Epic 2: workspace image checks ---"
  echo ""

  WS_NAME="smoke-ws"
  PROJECT="portikus"
  WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"

  # Clean up on exit regardless of success or failure.  The cleanup
  # function is extended by the Epic 3 block if it runs, so that a
  # single trap covers both.
  cleanup_all() {
    echo ""
    echo "Destroying ${WS_NAME}..."
    ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
  }
  trap cleanup_all EXIT

  # Provision a workspace.
  echo "Creating workspace ${WS_NAME}..."
  if ! ssh_cmd bash "${WORKSPACE_SCRIPT}" create "${WS_NAME}" >/dev/null 2>&1; then
    printf '\033[1;31mFAIL\033[0m  workspace creation\n'
    fail=$((fail + 1))
    echo ""
    echo "--- Results: ${pass} passed, ${fail} failed ---"
    exit 1
  fi

  # Helper: run a command inside the workspace.
  # The command string is single-quoted for the remote shell so that
  # multi-word commands are passed correctly through ssh.
  ws_exec() {
    local escaped="${*//\'/\'\\\'\'}"
    ssh_cmd "incus exec ${WS_NAME} --project ${PROJECT} -- bash -c '${escaped}'"
  }

  # Helper: run a command as the student user inside the workspace.
  # The command string is single-quoted for the remote shell so that
  # multi-word commands (e.g. "sudo -n true") are passed as one argument
  # to su -c.
  ws_student() {
    local escaped="${*//\'/\'\\\'\'}"
    ssh_cmd "incus exec ${WS_NAME} --project ${PROJECT} -- su -l student -c '${escaped}'"
  }

  # Give the container a moment to finish booting.
  sleep 5

  # 12. systemd is running with no failed units
  check "systemd is-system-running"             ws_exec systemctl is-system-running
  check_zero_lines "no failed systemd units"    ws_exec systemctl --failed --no-legend --no-pager

  # 13. /home/student is owned by student and contains projects/
  check_output "/home/student owned by student" "student" ws_exec stat -c '%U' /home/student
  check "/home/student/projects exists"         ws_exec test -d /home/student/projects

  # 14. Passwordless sudo
  check "student passwordless sudo"             ws_student "sudo -n true"

  # 15. Nested Docker works
  check "docker hello-world"                    ws_student "docker run --rm hello-world"

  # 16. Docker runs with remapped UIDs (not root-mapped)
  uid_map_second_field() {
    ws_student "docker run --rm alpine cat /proc/self/uid_map" 2>/dev/null | awk '{print $2}'
  }
  check_gt "Docker UID base is not 0" 0        uid_map_second_field

  # 17. CLI tools are installed
  check "codex --version"                       ws_student "codex --version"
  check "claude --version"                      ws_student "claude --version"
  check "gh --version"                          ws_student "gh --version"
  check "node --version"                        ws_student "node --version"
  check "python3 --version"                     ws_student "python3 --version"

  # 18. Security: no Incus API socket, no host data disk
  check "/dev/incus absent"                     ws_exec test ! -e /dev/incus
  check "/dev/vdb absent"                       ws_exec test ! -e /dev/vdb

  # 19. Management network is unreachable from workspace
  check "management network blocked"            ws_exec '! ping -c1 -W2 10.100.0.1'

  # 20. SSH to VM bridge address blocked from workspace
  check "SSH to VM bridge blocked"              ws_exec '! timeout 3 bash -c "echo >/dev/tcp/10.200.0.1/22" 2>/dev/null'

  # 21. Persistence across stop/start
  echo ""
  echo "Testing stop/start persistence..."
  if ! ws_student "echo smoke-persistence-marker > ~/projects/.smoke-marker" >/dev/null 2>&1; then
    printf '\033[1;31mFAIL\033[0m  write persistence marker\n'
    fail=$((fail + 1))
  fi
  ssh_cmd "incus stop ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  ssh_cmd "incus start ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  sleep 5

  check "projects marker survives restart"      ws_student "cat ~/projects/.smoke-marker"
  check "Docker images survive restart"         ws_student "docker images -q"

else
  echo "Workspace image not imported; skipping Epic 2 checks."
fi

echo ""

# ── Epic 3 and 4: authenticated control-plane lifecycle ──────────
# These checks run only when the portikus-api service is active (i.e.
# code has been deployed).  Everything goes through Caddy on the public
# host name, with a session cookie obtained from the mock identity
# provider, so the block also covers Epic 4: login, roles, ownership,
# CSRF, and the authenticated presence WebSocket.
if ssh_cmd systemctl is-active portikus-api >/dev/null 2>&1; then
  echo "--- Epic 3 and 4: authenticated lifecycle checks ---"
  echo ""

  epic3_pass_start=$pass
  epic3_fail_start=$fail

  PUBLIC_HOST="${PORTIKUS_PUBLIC_HOST:-portikus.${VM}.nip.io}"
  API="https://${PUBLIC_HOST}"
  # Caddy signs with its own internal authority, so every request has to
  # trust the root certificate the Ansible caddy role copied here.
  CURL="curl -s --cacert /etc/portikus/caddy-root.crt"
  PROJECT="portikus"
  WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
  WS_PROBE="/tmp/portikus-ws-probe.mjs"
  WS_STOP="/tmp/portikus-ws-stop"

  # http_status USER URL [EXTRA_CURL_ARGS]
  # USER is a mock user whose cookie jar is sent, or "-" for anonymous.
  # EXTRA_CURL_ARGS is one string, quoted for the remote shell.
  http_status() {
    local user="$1" url="$2" extra="${3:-}" jar=""
    [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
    ssh_cmd "${CURL} ${jar} ${extra} -o /dev/null -w '%{http_code}' '${url}'"
  }

  # vm_get USER URL [EXTRA_CURL_ARGS] — prints the response body.
  vm_get() {
    local user="$1" url="$2" extra="${3:-}" jar=""
    [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
    ssh_cmd "${CURL} ${jar} ${extra} '${url}'"
  }

  # Log a mock user in: follow /auth/login to the provider's account list,
  # then request the same page with the chosen account, which redirects
  # back through the callback and sets the session cookie.
  login_as() {
    local user="$1"
    local jar="/tmp/portikus-smoke-${user}.jar" page
    ssh_cmd "rm -f ${jar}"
    page=$(ssh_cmd "${CURL} -c ${jar} -b ${jar} -L -o /dev/null -w '%{url_effective}' '${API}/auth/login'")
    ssh_cmd "${CURL} -c ${jar} -b ${jar} -L -o /dev/null -w '%{http_code}' '${page}&user=${user}'"
  }

  # The session cookie value, read from the Netscape jar curl wrote.
  session_cookie() {
    ssh_cmd "awk '\$6 == \"portikus_session\" {print \$7}' /tmp/portikus-smoke-$1.jar"
  }

  # A field of a workspace JSON document, or "" when it is missing.
  json_field() {
    python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true
  }

  workspace_state() {
    vm_get alice "${API}/workspaces/${ws_id}" | json_field state
  }

  # "set" or "null" for the shutdown deadline.
  workspace_deadline() {
    vm_get alice "${API}/workspaces/${ws_id}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin).get('shutdownDeadline'); print('set' if d else 'null')" 2>/dev/null || true
  }

  # Rows in workspace_connections for this workspace.
  connection_count() {
    ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM workspace_connections WHERE workspace_id = '${ws_id}'\"" 2>/dev/null || true
  }

  wait_for_state() {
    local want="$1" tries="$2" state=""
    for _ in $(seq 1 "$tries"); do
      state=$(workspace_state)
      if [ "$state" = "$want" ]; then break; fi
      sleep 1
    done
    echo "$state"
  }

  # Shorten the grace period for testing.
  ssh_cmd 'echo "SHUTDOWN_GRACE_SECONDS=20" | sudo tee /etc/portikus/worker.override.env >/dev/null'
  ssh_cmd sudo systemctl restart portikus-worker

  # Extend the shared cleanup function to also clean Epic 3 and 4
  # resources.  Reading the instance names before deleting the rows keeps
  # the destroy targeted: only the mock users' instances are touched.
  cleanup_epic34() {
    echo ""
    echo "Cleaning up Epic 3 and 4 smoke resources..."
    ssh_cmd sudo rm -f /etc/portikus/worker.override.env
    ssh_cmd sudo systemctl restart portikus-worker 2>/dev/null || true
    local owners="SELECT id FROM users WHERE oidc_subject IN ('alice','bob','carol')"
    local smoke_instances
    smoke_instances=$(ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT incus_instance_name FROM workspaces WHERE owner_user_id IN (${owners})\"" 2>/dev/null || true)
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspace_connections WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id IN (${owners}))\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM audit_events WHERE target IN (SELECT id::text FROM workspaces WHERE owner_user_id IN (${owners}))\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspaces WHERE owner_user_id IN (${owners})\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM sessions WHERE user_id IN (${owners})\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM users WHERE oidc_subject IN ('alice','bob','carol')\"" 2>/dev/null || true
    for instance in $smoke_instances; do
      ssh_cmd "bash ${WORKSPACE_SCRIPT} destroy ${instance}" 2>/dev/null || true
    done
    ssh_cmd "rm -f /tmp/portikus-smoke-*.jar ${WS_PROBE} ${WS_STOP}" 2>/dev/null || true
  }
  # Wrap both cleanups so a single trap covers Epic 2 and Epic 3 and 4.
  cleanup_all() {
    cleanup_epic34
    echo ""
    echo "Destroying ${WS_NAME}..."
    ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
  }

  # Give the worker a moment to start with the short grace period.
  sleep 3

  # 0. The control plane came from the Debian package, not a build on the VM.
  check "portikus package is installed"  ssh_cmd dpkg -s portikus
  check "no pnpm on the VM"              ssh_cmd "! command -v pnpm"
  check "no built app tree on the VM"    ssh_cmd test ! -e /var/lib/portikus/app

  # 1. Units are active and the controller stays private.
  check "portikus-api is active"        ssh_cmd systemctl is-active portikus-api
  check "portikus-worker is active"     ssh_cmd systemctl is-active portikus-worker
  check "portikus-controller is active" ssh_cmd systemctl is-active portikus-controller
  check "controller /health returns 200" \
    ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health) = 200"
  check "controller rejects unauthenticated requests" \
    ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/instances) = 401"

  # 2. Caddy serves the site over TLS and the API through it.
  check "caddy is active"                       ssh_cmd systemctl is-active caddy
  check_output "https / returns 200"      "200" http_status - "${API}/"
  check_output "/health through Caddy"    "200" http_status - "${API}/health"
  redirects_to_https() {
    local status
    status=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' 'http://${PUBLIC_HOST}/'")
    case "$status" in 30*) return 0 ;; *) return 1 ;; esac
  }
  check "http redirects to https"               redirects_to_https

  # 3. The mock identity provider answers through Caddy with the right issuer.
  check "portikus-mock-idp is active"           ssh_cmd systemctl is-active portikus-mock-idp
  mock_issuer() {
    vm_get - "${API}/mock-idp/.well-known/openid-configuration" | json_field issuer
  }
  check_output "mock discovery reports the public issuer" "${API}/mock-idp" mock_issuer

  # 4. Nothing works without a session.
  check_output "/auth/me is 401 anonymously"    "401" http_status - "${API}/auth/me"
  check_output "POST /workspaces is 401 anonymously" "401" \
    http_status - "${API}/workspaces" "-X POST -H 'Origin: ${API}'"

  # 5. Log the mock users in.
  echo ""
  echo "Logging in as alice, bob, and carol..."
  for mock_user in alice bob carol; do
    login_as "$mock_user" >/dev/null 2>&1 || true
  done
  alice_me=$(vm_get alice "${API}/auth/me")
  check_output "alice is signed in" "Alice" echo "$(echo "$alice_me" | json_field displayName)"
  check "/auth/me carries alice's user id"      test -n "$(echo "$alice_me" | json_field id)"

  # 6. Provision alice's workspace.  The request carries no body: the owner
  #    comes from the session, and the Origin header satisfies the CSRF check.
  echo ""
  echo "Provisioning a workspace for alice..."
  ws_response=$(vm_get alice "${API}/workspaces" "-X POST -H 'Origin: ${API}'")
  ws_id=$(echo "$ws_response" | json_field id)

  if [ -z "$ws_id" ]; then
    printf '\033[1;31mFAIL\033[0m  POST /workspaces returned no id: %s\n' "$ws_response"
    fail=$((fail + 1))
  else
    printf '\033[1;32mPASS\033[0m  POST /workspaces returned id=%s\n' "$ws_id"
    pass=$((pass + 1))

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
      check "Incus instance exists and is Stopped" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
    fi

    # 7. Install the presence WebSocket client on the VM.  It sends one
    #    heartbeat, waits for the first server message, and stays open until
    #    the stop file appears, which is how the test controls the session.
    ssh_cmd "cat > ${WS_PROBE}" <<'PROBE'
import fs from "node:fs";
const [url, origin, cookie, stopFile] = process.argv.slice(2);
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
      ssh_cmd "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt node ${WS_PROBE} \
        'wss://${PUBLIC_HOST}/workspaces/${ws_id}/ws' '${API}' \
        'portikus_session=${alice_cookie}' '${WS_STOP}'" >"$probe_log" 2>&1 &
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

    # 14. Authorization: one student cannot see another's workspace, and
    #     only an administrator can list them all.
    echo ""
    echo "Checking authorization boundaries..."
    check_output "bob gets 404 on alice's workspace" "404" \
      http_status bob "${API}/workspaces/${ws_id}"
    admin_list_has_workspace() {
      vm_get carol "${API}/admin/workspaces" | grep -q "${ws_id}"
    }
    check "carol lists alice's workspace"         admin_list_has_workspace
    check_output "alice is refused the admin list" "403" \
      http_status alice "${API}/admin/workspaces"

    # 15. Security: portikus is not an Incus admin, and the control-plane
    #     ports are unreachable from inside a workspace.
    echo ""
    echo "Checking security boundaries..."
    check "portikus user not in incus-admin" \
      ssh_cmd '! id portikus 2>/dev/null | grep -q incus-admin'

    if [ -n "$ws_instance" ]; then
      http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
      ws_state=$(wait_for_state running 60)
      sleep 3

      for port in 3000 3001 3002; do
        check "port ${port} unreachable from workspace" \
          ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c '! timeout 3 bash -c \"echo >/dev/tcp/10.200.0.1/${port}\" 2>/dev/null'"
      done

      http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
    fi

    rm -f "$probe_log"
  fi

  # 16. Logging out ends the session.
  echo ""
  echo "Logging alice out..."
  http_status alice "${API}/auth/logout" "-X POST -H 'Origin: ${API}'" >/dev/null
  check_output "/auth/me is 401 after logout" "401" http_status alice "${API}/auth/me"

  echo ""
  echo "--- Epic 3 and 4 results: $((pass - epic3_pass_start)) passed, $((fail - epic3_fail_start)) failed ---"
else
  echo "portikus-api not active; skipping Epic 3 and 4 checks."
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
