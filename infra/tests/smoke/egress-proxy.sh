#!/usr/bin/env bash
# The platform's egress proxy.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# Every SSO sign-in and LMS launch depends on it (ADR 0027).
echo "--- Egress proxy ---"
echo ""
check "squid is active"  ssh_cmd systemctl is-active squid
check "squid is enabled" ssh_cmd systemctl is-enabled squid
check_output "squid restarts when it fails" "Restart=on-failure" \
  ssh_cmd "systemctl show squid -p Restart"
proxy_listeners() {
  ssh_cmd "ss -Hltn 'sport = :3128'" | awk '{ print $4 }' | sort -u | paste -sd' '
}
check_output "the proxy listens on loopback only" "127.0.0.1:3128" proxy_listeners
check_output "api.env sends the API's outbound requests through the proxy" "http://127.0.0.1:3128" \
  ssh_cmd "sudo sed -n 's/^OUTBOUND_PROXY_URL=//p' /etc/portikus/api.env"
# systemd prints the ranges in no fixed order, so compare them sorted.
api_ip_allow() {
  ssh_cmd "systemctl show portikus-api -p IPAddressAllow --value" | tr ' ' '\n' | sed '/^$/d' | LC_ALL=C sort | paste -sd' '
}
check_output "the API unit may reach loopback and the workspace bridge only" \
  "10.200.0.0/24 127.0.0.0/8" api_ip_allow
worker_ip_allow() {
  ssh_cmd "systemctl show portikus-worker -p IPAddressAllow --value" | tr ' ' '\n' | sed -e '/^$/d' -e 's|/32$||' | LC_ALL=C sort | paste -sd' '
}
check_output "the worker unit may reach 127.0.0.1 and the workspace bridge only" \
  "10.200.0.0/24 127.0.0.1" worker_ip_allow
# The firewall lets the worker's account open local connections only to the
# controller and the egress proxy its alerts leave through, so it cannot reach
# the API or Dex (SPEC.md 24.9) on 127.0.0.1, ::1 or any of the VM's own
# addresses.  The answers are those of infra/tests/reach-probe.py.
reach_probe() { # USER PORT...
  local user="$1"
  shift
  ssh_cmd_stdin "sudo runuser -u ${user} -- python3 - $*" <"${TESTS_DIR}/reach-probe.py" | paste -sd' '
}
check_output "the worker's account reaches only the controller and the proxy, on 127.0.0.1 alone" \
  "none none none 127.0.0.1 127.0.0.1" reach_probe portikus-worker 3000 5556 own 3001 3128
check_output "the API's account reaches the probe's own listener everywhere, so those refusals are the firewall's" \
  "127.0.0.1 127.0.0.1 all" reach_probe portikus 3000 5556 own
check_output "worker.env sends the worker's alerts through the proxy" "http://127.0.0.1:3128" \
  ssh_cmd "sudo sed -n 's/^OUTBOUND_PROXY_URL=//p' /etc/portikus/worker.env"
# proxy_connect URL -- the status of the proxy's answer to CONNECT for URL.
proxy_connect() {
  ssh_cmd "${CURL} -o /dev/null -w '%{http_connect}' -x http://127.0.0.1:3128 '$1'"
}
# Dex is the API's issuer on the site's own name.
check_output "the proxy reaches the site's own issuer" "200" proxy_connect "${API}/"
check_output "the proxy refuses a host that is not listed" "403" proxy_connect "https://example.com/"
echo ""
