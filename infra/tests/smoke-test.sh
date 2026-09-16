#!/usr/bin/env bash
# Smoke test for the pilot infrastructure (STACK.md section 33).
#
# Run this after `make infra-apply && make configure-vm` to verify
# the acceptance criteria for Epic 1.  It connects to the platform VM
# over SSH and checks each subsystem.
#
# Usage: ./infra/tests/smoke-test.sh <vm-ip>
set -euo pipefail

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
check "IPv4 forwarding"                       ssh_cmd test "$(sysctl -n net.ipv4.ip_forward)" = 1

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
  ssh_cmd bash "${WORKSPACE_SCRIPT}" create "${WS_NAME}" >/dev/null 2>&1

  # Helper: run a command inside the workspace.
  ws_exec() {
    ssh_cmd "incus exec ${WS_NAME} --project ${PROJECT} -- $*"
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
  check "no failed systemd units"               test "$(ws_exec systemctl --failed --no-legend --no-pager 2>/dev/null | wc -l)" -eq 0

  # 13. /home/student is owned by student and contains projects/
  check "/home/student owned by student"        test "$(ws_exec stat -c '%U' /home/student 2>/dev/null)" = "student"
  check "/home/student/projects exists"         ws_exec test -d /home/student/projects

  # 14. Passwordless sudo
  check "student passwordless sudo"             ws_student "sudo -n true"

  # 15. Nested Docker works
  check "docker hello-world"                    ws_student "docker run --rm hello-world"

  # 16. Docker runs with remapped UIDs (not root-mapped)
  uid_base=$(ws_student "docker run --rm alpine cat /proc/self/uid_map" 2>/dev/null | awk '{print $2}')
  check "Docker UID base is not 0"             test "${uid_base:-0}" -gt 0

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
  check "management network blocked"            ws_exec "bash -c '! ping -c1 -W2 10.100.0.1'"

  # 20. SSH to VM bridge address blocked from workspace
  check "SSH to VM bridge blocked"              ws_exec "bash -c '! timeout 3 bash -c \"echo >/dev/tcp/10.200.0.1/22\" 2>/dev/null'"

  # 21. Persistence across stop/start
  echo ""
  echo "Testing stop/start persistence..."
  ws_student "echo smoke-persistence-marker > ~/projects/.smoke-marker"
  ssh_cmd "incus stop ${WS_NAME} --project ${PROJECT}"
  ssh_cmd "incus start ${WS_NAME} --project ${PROJECT}"
  sleep 5

  check "projects marker survives restart"      ws_student "cat ~/projects/.smoke-marker"
  check "Docker images survive restart"         ws_student "docker images -q"

else
  echo "Workspace image not imported; skipping Epic 2 checks."
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
