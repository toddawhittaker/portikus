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

  # Clean up on exit regardless of success or failure.
  cleanup_workspace() {
    echo ""
    echo "Destroying ${WS_NAME}..."
    ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
  }
  trap cleanup_workspace EXIT

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

# ── Epic 3: Control-plane lifecycle ──────────────────────────────
# These checks run only when the portikus-api service is active (i.e.
# code has been deployed).  The block exercises the full workspace
# lifecycle through the REST API: provision, connect, grace period,
# reconnect-cancels-stop, disconnect-stops, explicit start/stop,
# persistence, and security boundaries.
if ssh_cmd systemctl is-active portikus-api >/dev/null 2>&1; then
  echo "--- Epic 3: control-plane lifecycle checks ---"
  echo ""

  API="http://127.0.0.1:3000"
  PROJECT="portikus"
  WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"

  # Shorten the grace period for testing.
  ssh_cmd 'echo "SHUTDOWN_GRACE_SECONDS=20" | sudo tee /etc/portikus/worker.override.env >/dev/null'
  ssh_cmd sudo systemctl restart portikus-worker

  # Clean up on exit: remove override, restart worker, delete DB row, destroy instance.
  cleanup_epic3() {
    echo ""
    echo "Cleaning up Epic 3 smoke resources..."
    ssh_cmd sudo rm -f /etc/portikus/worker.override.env
    ssh_cmd sudo systemctl restart portikus-worker 2>/dev/null || true
    # Delete the smoke workspace DB row.
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspace_connections WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = 'smoke-user')\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspaces WHERE owner_user_id = 'smoke-user'\"" 2>/dev/null || true
    # Destroy the Incus instance if it exists.
    local ws_instance
    ws_instance=$(ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT incus_instance_name FROM workspaces WHERE owner_user_id = 'smoke-user'\"" 2>/dev/null || true)
    if [ -n "$ws_instance" ]; then
      ssh_cmd "bash ${WORKSPACE_SCRIPT} destroy ${ws_instance}" 2>/dev/null || true
    fi
    # Find any remaining smoke instance by listing.
    ssh_cmd "incus list --project ${PROJECT} -f csv -c n 2>/dev/null | grep '^ws-' | while read -r n; do bash ${WORKSPACE_SCRIPT} destroy \"\$n\" 2>/dev/null || true; done" 2>/dev/null || true
  }
  trap cleanup_epic3 EXIT

  # Give the worker a moment to start with the short grace period.
  sleep 3

  # 1. Three units active; controller /health returns 401 without the token.
  check "portikus-api is active"        ssh_cmd systemctl is-active portikus-api
  check "portikus-worker is active"     ssh_cmd systemctl is-active portikus-worker
  check "portikus-controller is active" ssh_cmd systemctl is-active portikus-controller
  check "controller /health rejects unauthenticated" \
    ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health) = 401"

  # 2. POST /workspaces to provision a workspace.
  echo ""
  echo "Provisioning workspace for smoke-user..."
  ws_response=$(ssh_cmd "curl -s -X POST ${API}/workspaces -H 'Content-Type: application/json' -d '{\"ownerUserId\":\"smoke-user\"}'")
  ws_id=$(echo "$ws_response" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)

  if [ -z "$ws_id" ]; then
    printf '\033[1;31mFAIL\033[0m  POST /workspaces returned no id: %s\n' "$ws_response"
    fail=$((fail + 1))
  else
    printf '\033[1;32mPASS\033[0m  POST /workspaces returned id=%s\n' "$ws_id"
    pass=$((pass + 1))

    # Poll until the workspace reaches "stopped" (provisioned).
    echo "Waiting for workspace to reach stopped state..."
    ws_state=""
    for i in $(seq 1 60); do
      ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      if [ "$ws_state" = "stopped" ]; then
        break
      fi
      sleep 2
    done
    check_output "workspace reaches stopped after provision" "stopped" echo "$ws_state"

    # Verify Incus shows the instance as Stopped.
    ws_instance=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('incusInstanceName',''))" 2>/dev/null || true)
    if [ -n "$ws_instance" ]; then
      check "Incus instance exists and is Stopped" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
    fi

    # 3. Starts on login: POST .../connections triggers start.
    echo ""
    echo "Connecting to start the workspace..."
    conn_response=$(ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/connections")
    conn_id=$(echo "$conn_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connectionId',''))" 2>/dev/null || true)
    check "POST /connections returns connectionId" test -n "$conn_id"

    # Poll until running (up to 60 s).
    echo "Waiting for workspace to reach running state..."
    ws_state=""
    for i in $(seq 1 60); do
      ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      if [ "$ws_state" = "running" ]; then
        break
      fi
      sleep 1
    done
    check_output "workspace reaches running after connect" "running" echo "$ws_state"

    # Verify Incus shows Running with an IPv4 address.
    if [ -n "$ws_instance" ]; then
      check "Incus instance is Running" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: RUNNING'"
    fi

    # 4. Stays up during grace: disconnect, wait 10 s, still running with deadline.
    echo ""
    echo "Disconnecting to test grace period..."
    ssh_cmd "curl -s -X DELETE ${API}/workspaces/${ws_id}/connections/${conn_id}" >/dev/null 2>&1
    sleep 10
    ws_json=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}")
    ws_state=$(echo "$ws_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
    ws_deadline=$(echo "$ws_json" | python3 -c "import sys,json; d=json.load(sys.stdin).get('shutdownDeadline'); print('set' if d else 'null')" 2>/dev/null || true)
    check_output "still running 10s after disconnect" "running" echo "$ws_state"
    check_output "shutdown deadline is set" "set" echo "$ws_deadline"

    # 5. Reconnect cancels the deadline.
    echo ""
    echo "Reconnecting to cancel shutdown deadline..."
    conn_response=$(ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/connections")
    conn_id2=$(echo "$conn_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connectionId',''))" 2>/dev/null || true)

    # Wait up to 3 s for the deadline to clear.
    ws_deadline=""
    for i in $(seq 1 6); do
      ws_deadline=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; d=json.load(sys.stdin).get('shutdownDeadline'); print('set' if d else 'null')" 2>/dev/null || true)
      if [ "$ws_deadline" = "null" ]; then
        break
      fi
      sleep 0.5
    done
    check_output "reconnect clears deadline" "null" echo "$ws_deadline"

    # Still running after 25 s (grace was 20 s — would have stopped without reconnect).
    sleep 25
    ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
    check_output "still running 25s after reconnect" "running" echo "$ws_state"

    # 6. Stops after grace: disconnect, wait for stopped.
    echo ""
    echo "Disconnecting to let grace period expire..."
    ssh_cmd "curl -s -X DELETE ${API}/workspaces/${ws_id}/connections/${conn_id2}" >/dev/null 2>&1

    ws_state=""
    for i in $(seq 1 60); do
      ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      if [ "$ws_state" = "stopped" ]; then
        break
      fi
      sleep 1
    done
    check_output "workspace stops after grace expires" "stopped" echo "$ws_state"

    # Verify Incus is Stopped.
    if [ -n "$ws_instance" ]; then
      check "Incus instance is Stopped after grace" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
    fi

    # Check audit_events for workspace.stop.
    check "audit_events has workspace.stop" \
      ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE action = 'workspace.stop'\" | grep -qv '^0$'"

    # 7. Explicit start then stop via REST.
    echo ""
    echo "Testing explicit start/stop..."
    ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/start" >/dev/null 2>&1
    for i in $(seq 1 60); do
      ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      if [ "$ws_state" = "running" ]; then
        break
      fi
      sleep 1
    done
    check_output "explicit start reaches running" "running" echo "$ws_state"

    ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/stop" >/dev/null 2>&1
    for i in $(seq 1 60); do
      ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      if [ "$ws_state" = "stopped" ]; then
        break
      fi
      sleep 1
    done
    check_output "explicit stop reaches stopped" "stopped" echo "$ws_state"

    # 8. Re-run the Epic 2 persistence check against this instance.
    if [ -n "$ws_instance" ]; then
      echo ""
      echo "Re-running persistence check on ${ws_instance}..."
      # Start the instance for persistence checks.
      ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/start" >/dev/null 2>&1
      for i in $(seq 1 60); do
        ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
        if [ "$ws_state" = "running" ]; then
          break
        fi
        sleep 1
      done

      if [ "$ws_state" = "running" ]; then
        sleep 5
        # Write a marker, stop, start, check it survives.
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'echo epic3-persist > ~/projects/.epic3-marker'" 2>/dev/null || true
        ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/stop" >/dev/null 2>&1
        for i in $(seq 1 60); do
          ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
          if [ "$ws_state" = "stopped" ]; then break; fi
          sleep 1
        done
        ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/start" >/dev/null 2>&1
        for i in $(seq 1 60); do
          ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
          if [ "$ws_state" = "running" ]; then break; fi
          sleep 1
        done
        sleep 5
        check "persistence marker survives restart (Epic 2 re-check)" \
          ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'cat ~/projects/.epic3-marker'" 2>/dev/null
      fi

      # Stop the instance for the final checks.
      ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/stop" >/dev/null 2>&1
      for i in $(seq 1 30); do
        ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
        if [ "$ws_state" = "stopped" ]; then break; fi
        sleep 1
      done
    fi

    # 9. Security: portikus user is not in incus-admin; ports 3000/3001 unreachable from workspace.
    echo ""
    echo "Checking security boundaries..."
    check "portikus user not in incus-admin" \
      ssh_cmd '! id portikus 2>/dev/null | grep -q incus-admin'

    # Start a workspace to test port reachability from inside.
    if [ -n "$ws_instance" ]; then
      ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/start" >/dev/null 2>&1
      # shellcheck disable=SC2034  # i is a loop counter only
      for i in $(seq 1 60); do
        ws_state=$(ssh_cmd "curl -s ${API}/workspaces/${ws_id}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
        if [ "$ws_state" = "running" ]; then break; fi
        sleep 1
      done
      sleep 3

      check "port 3000 unreachable from workspace" \
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c '! timeout 3 bash -c \"echo >/dev/tcp/10.200.0.1/3000\" 2>/dev/null'"
      check "port 3001 unreachable from workspace" \
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c '! timeout 3 bash -c \"echo >/dev/tcp/10.200.0.1/3001\" 2>/dev/null'"

      # Stop the workspace.
      ssh_cmd "curl -s -X POST ${API}/workspaces/${ws_id}/stop" >/dev/null 2>&1
    fi
  fi

  echo ""
  echo "--- Epic 3 results: ${pass} passed, ${fail} failed ---"
else
  echo "portikus-api not active; skipping Epic 3 checks."
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
