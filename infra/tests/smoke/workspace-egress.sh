#!/usr/bin/env bash
# Workspace egress: the workspace proxy and the egress helper.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# ADR 0038.
# Read-only.  The workspace proxy runs in both modes; the helper applies the
# policy.  The security suite's workspace-egress module checks enforcement.
echo "--- Workspace egress ---"
echo ""
check "the workspace proxy is active" ssh_cmd systemctl is-active portikus-workspace-proxy
check_output "the workspace proxy restarts when it fails" "Restart=on-failure" \
  ssh_cmd "systemctl show portikus-workspace-proxy -p Restart"
check_output "the workspace proxy runs as its own user" "portikus-wsproxy" \
  ssh_cmd "ps -o user:32= -p \$(systemctl show -p MainPID --value portikus-workspace-proxy)"
check "the egress helper's settings name that user" \
  ssh_cmd "grep -qx \"EGRESS_PROXY_UID=\$(id -u portikus-wsproxy)\" /etc/portikus/egress.env"
check "the egress guard and its drop-all table are in place" \
  ssh_cmd "test -x /usr/lib/portikus/egress-guard.sh && sudo nft -c -f /etc/portikus/egress-drop-all.nft"
workspace_proxy_listeners() {
  ssh_cmd "ss -Hltn '( sport = :3129 or sport = :3130 or sport = :3199 )'" | awk '{ print $4 }' | sort -u | paste -sd' '
}
check_output "the workspace proxy listens on the gateway and loopback only" \
  "10.200.0.1:3129 10.200.0.1:3130 127.0.0.1:3199" workspace_proxy_listeners
check_output "the API's proxy stays on the GnuTLS build" "/usr/sbin/squid-gnutls" \
  ssh_cmd "update-alternatives --query squid | sed -n 's/^Value: //p'"
check "the egress helper watches for requests" ssh_cmd systemctl is-active portikus-egress-apply.path
check "the egress helper runs at boot" ssh_cmd systemctl is-enabled portikus-egress-apply.service
# One unit at a time: is-enabled passes when any one of several is enabled.
# shellcheck disable=SC2016 # expanded on the VM
check "the API, controller and worker start at boot" \
  ssh_cmd 'for u in portikus-api portikus-controller portikus-worker; do systemctl is-enabled --quiet "$u" || exit 1; done'
check_output "the egress helper's last run did not fail" "no" \
  ssh_cmd "systemctl is-failed --quiet portikus-egress-apply.service && echo yes || echo no"
egress_mode() {
  ssh_cmd "sudo -u postgres psql -X -q -t -A -d portikus -c 'SELECT egress_mode FROM settings WHERE id = 1'"
}
if [ "$(egress_mode)" = "allow-list" ]; then
  check "allow-list mode: the egress DNS is active" ssh_cmd systemctl is-active portikus-egress-dns
else
  check "open mode: the egress DNS is stopped" ssh_cmd "! systemctl is-active --quiet portikus-egress-dns"
fi
echo ""
