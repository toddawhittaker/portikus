#!/usr/bin/env bash
# Authorization and network boundaries around alice's workspace.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 16. Authorization: one student cannot see another's workspace, and
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

# 17. Security: portikus is not an Incus admin, and the control-plane
#     ports are unreachable from inside a workspace.
echo ""
echo "Checking security boundaries..."
check "portikus user not in incus-admin" \
  ssh_cmd '! id portikus 2>/dev/null | grep -q incus-admin'

if [ -n "$ws_instance" ]; then
  http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
  ws_state=$(wait_for_state running 60)
  sleep 3

  # 80 and the public port are the Caddy edge: a workspace must not be
  # able to reach the sign-in page from inside the bridge.  The
  # gateway's 443 is the ghcr.io cache's redirect (issue #840), so it
  # is not probed.  One exec covers every port, because the shortened
  # grace period would stop the workspace part-way through the probes.
  edge_ports="80 3000 3001 3002"
  [ "${PUBLIC_PORT}" = 443 ] || edge_ports="80 ${PUBLIC_PORT} 3000 3001 3002"
  port_probe=$(ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c 'for p in ${edge_ports}; do if timeout 1 bash -c \"echo >/dev/tcp/10.200.0.1/\$p\" 2>/dev/null; then echo \"\$p open\"; else echo \"\$p blocked\"; fi; done'" 2>/dev/null)
  port_result() { echo "$port_probe" | awk -v p="$1" '$1 == p { print $2 }'; }
  for port in ${edge_ports}; do
    check_output "port ${port} unreachable from workspace" "blocked" port_result "${port}"
  done

  http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
fi

rm -f "$probe_log"
