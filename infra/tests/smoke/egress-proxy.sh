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
check "the old API address allow drop-in is gone" \
  ssh_cmd "test ! -e /etc/systemd/system/portikus-api.service.d/10-idp-egress.conf"
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
# The firewall lets the worker's account open loopback connections only to
# the controller, so it cannot reach the API or Dex (SPEC.md 24.9).
worker_loopback() { # USER -- "open" or "refused" for the API, then the controller.
  ssh_cmd "sudo runuser -u $1 -- python3 -c 'import socket
for port in (3000, 3001):
    try:
        socket.create_connection((\"127.0.0.1\", port), timeout=5).close()
        print(\"open\")
    except ConnectionRefusedError:
        print(\"refused\")'" | paste -sd' '
}
check_output "the worker's account reaches the controller on loopback but not the API" \
  "refused open" worker_loopback portikus-worker
check_output "the API's account reaches both, so that refusal is the firewall's" \
  "open open" worker_loopback portikus
# proxy_connect URL -- the status of the proxy's answer to CONNECT for URL.
proxy_connect() {
  ssh_cmd "${CURL} -o /dev/null -w '%{http_connect}' -x http://127.0.0.1:3128 '$1'"
}
if [ "$IDP" = dex ] || [ "$IDP" = mock ]; then
  # Dex and the mock are the API's issuer on the site's own name.
  check_output "the proxy reaches the site's own issuer" "200" proxy_connect "${API}/"
fi
check_output "the proxy refuses a host that is not listed" "403" proxy_connect "https://example.com/"
echo ""
