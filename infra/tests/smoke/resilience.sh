#!/usr/bin/env bash
# Platform resilience: restarts, memory protection and thin pool limits.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# docs/CAPACITY.md.
# Read-only, so safe on the pilot.  The security suite's heavy tests kill
# Caddy and PostgreSQL and load two workspaces to see these settings work.
echo "--- Platform resilience ---"
echo ""
for unit in caddy postgresql@17-main; do
  check_output "${unit} restarts when it fails" "Restart=on-failure" \
    ssh_cmd "systemctl show ${unit} -p Restart"
  check_output "${unit} restarts after 5 seconds" "RestartUSec=5s" \
    ssh_cmd "systemctl show ${unit} -p RestartUSec"
done
check_output "the platform's slice has CPU weight 1000" "1000" \
  ssh_cmd "cat /sys/fs/cgroup/system.slice/cpu.weight"
# unit_memory_low UNIT -- memory.low of the unit's own cgroup.
unit_memory_low() {
  ssh_cmd "cat /sys/fs/cgroup\$(systemctl show -p ControlGroup --value $1)/memory.low"
}
check_output "the platform's slice has 512M of memory protection" "536870912" unit_memory_low system.slice
check_output "PostgreSQL's slice has 256M of memory protection" "268435456" unit_memory_low system-postgresql.slice
check_output "PostgreSQL has 256M of memory protection" "268435456" unit_memory_low postgresql@17-main
check_output "the API has 256M of memory protection" "268435456" unit_memory_low portikus-api
check_output "the thin pool fails writes when full" "error" \
  ssh_cmd "sudo lvs --noheadings -o lv_when_full ${STORAGE_VG:-none}/thinpool | tr -d ' '"
check "the thin pool status timer is active" ssh_cmd systemctl is-active portikus-thinpool-status.timer
check_output "the thin pool status file is world-readable" "644" \
  ssh_cmd "stat -c %a /run/portikus-thinpool.json"
# shellcheck disable=SC2016  # jq expressions, not shell
check "the thin pool status file is under five minutes old and holds both figures" \
  ssh_cmd 'jq -e "(now - (.observedAt | fromdateiso8601)) < 300 and (.dataPercent | type) == \"number\" and (.metadataPercent | type) == \"number\"" /run/portikus-thinpool.json'
net_limit=$(awk '$1 == "workspace_network_limit:" { gsub(/"/, "", $2); print $2; exit }' "${TESTS_DIR}/../ansible/site.yml")
for dir in ingress egress; do
  check_output "the workspace profile limits eth0 ${dir} to ${net_limit}" "$net_limit" \
    ssh_cmd "incus profile device get workspace eth0 limits.${dir} --project portikus"
done
echo ""
