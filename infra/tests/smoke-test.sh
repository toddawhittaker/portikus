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
    ((pass++))
  else
    printf '\033[1;31mFAIL\033[0m  %s\n' "$label"
    ((fail++))
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
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
