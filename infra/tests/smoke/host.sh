#!/usr/bin/env bash
# The platform VM: SSH, Incus, LVM thin storage, the firewall, and the
# VM's copy of the workspace script.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 1. SSH reachability
check "SSH to platform VM"                    ssh_cmd true

# 2. Incus is running
check "Incus daemon is active"                ssh_cmd systemctl is-active incus

# The volume group is whichever the play was given (docs/SPEC.md section
# 21.12), so it is read from the Incus pool, and its disk from LVM.
STORAGE_VG=$(ssh_cmd incus storage get workspace-data source 2>/dev/null || true)
STORAGE_PVS=$(ssh_cmd sudo pvs --noheadings -o pv_name --select "vg_name=${STORAGE_VG:-none}" 2>/dev/null | tr -d ' ' || true)

# 3. LVM volume group exists
check "LVM volume group ${STORAGE_VG:-(none)}"  ssh_cmd sudo vgs "${STORAGE_VG:-none}"

# 4. LVM thin pool exists
check "LVM thin pool thinpool"                ssh_cmd sudo lvs "${STORAGE_VG:-none}/thinpool"

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

# 11. The storage volume group sits on a disk or a loop-backed file
check "the storage volume group has a physical volume" test -n "${STORAGE_PVS}"

# 12. configure-vm keeps the VM's Incus script in step with the repository.
#     A host set up from the package has no copy, so this run brings its
#     own and removes it at exit.
WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
repo_script_sum=$(sha256sum "${TESTS_DIR}/../incus/workspace.sh" | cut -d' ' -f1)
if ssh_cmd test -d /var/lib/portikus/incus; then
  vm_script_sum=$(ssh_cmd "sha256sum ${WORKSPACE_SCRIPT}" 2>/dev/null | cut -d' ' -f1)
  if [ -n "$repo_script_sum" ] && [ "$vm_script_sum" = "$repo_script_sum" ]; then
    ok "the VM's workspace.sh matches this checkout's"
  else
    bad "the VM's workspace.sh (${vm_script_sum:-missing}) differs from this checkout's; run make configure-vm from this checkout"
  fi
else
  WORKSPACE_SCRIPT="/tmp/portikus-smoke-workspace.sh"
  ssh_cmd_stdin "cat >${WORKSPACE_SCRIPT}" <"${TESTS_DIR}/../incus/workspace.sh"
  echo "SKIP  the VM's workspace.sh (a packaged host has none; this run uses ${WORKSPACE_SCRIPT})"
fi

echo ""
echo "--- Host results: ${pass} passed, ${fail} failed ---"
echo ""
