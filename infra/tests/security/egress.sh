#!/usr/bin/env bash
# API egress (ADR 0027; docs/EPIC-14.md, "Security invariants to test").
#
# Sourced by infra/tests/security-test.sh.  The API may reach no internet
# address directly; through the egress proxy it reaches only listed hosts,
# and never a listed name that resolves to a private address.  Each probe
# runs on the VM as the API's user under the API unit's own address rules,
# so it sees what the API would.  It changes nothing.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- API egress ---"

eg_allow=$(sec_ssh "systemctl show portikus-api -p IPAddressAllow --value")
eg_deny=$(sec_ssh "systemctl show portikus-api -p IPAddressDeny --value")
eg_proxy="http://127.0.0.1:3128"

# eg_as_api CMD -- runs CMD on the VM as the API's user with its address rules.
eg_as_api() {
  sec_ssh "sudo systemd-run --quiet --wait --pipe --collect -p User=portikus \
    -p 'IPAddressAllow=${eg_allow}' -p 'IPAddressDeny=${eg_deny}' $1"
}

# The HTTP status curl sees, 000 when it cannot connect.
eg_direct() { sec_ssh "curl -s -o /dev/null -m 8 -w '%{http_code}' '$1'"; }
eg_direct_as_api() { eg_as_api "curl -s -o /dev/null -m 8 -w '%{http_code}' '$1'"; }
# The proxy's answer to CONNECT, or to a plain request for an http:// URL.
eg_proxied_as_api() {
  eg_as_api "curl -s -o /dev/null -m 15 -x ${eg_proxy} -w '%{http_connect} %{http_code}' '$1'"
}
eg_refused_as_api() {
  local got
  got=$(eg_proxied_as_api "$1")
  [ "${got%% *}" = 403 ] || [ "${got##* }" = 403 ]
}
eg_connected_as_api() {
  local got
  got=$(eg_proxied_as_api "$1")
  [ "${got%% *}" = 200 ]
}

check_output "squid listens on loopback only" "127.0.0.1:3128" \
  sec_ssh "ss -Hltn 'sport = :3128' | awk '{ print \$4 }' | sort -u | paste -sd' '"

# A probe that could never connect proves nothing, so the VM itself must.
if [ "$(eg_direct https://1.1.1.1/)" = 000 ]; then
  sec_na "the API cannot reach the internet directly" "the VM itself cannot reach 1.1.1.1"
else
  check_output "the API cannot reach the internet directly" "000" eg_direct_as_api https://1.1.1.1/
fi
check "through the proxy, the API is refused an unlisted host" eg_refused_as_api https://example.com/
check "through the proxy, the API is refused a private address" eg_refused_as_api https://10.0.0.1/
check "through the proxy, the API is refused the metadata address" eg_refused_as_api http://169.254.169.254/

# Every listed host name: reached when all its addresses are public,
# refused when any is private (ADR 0027).
eg_private() {
  python3 -c '
import ipaddress, sys
shared = ipaddress.ip_network("100.64.0.0/10")
for a in sys.argv[1:]:
    ip = ipaddress.ip_address(a)
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip in shared:
        sys.exit(0)
sys.exit(1)
' "$@"
}
# One line per port: the port, then its host names.
eg_listed=$(sec_ssh "sudo sed -n 's/^acl portikus_hosts_\([0-9]*\) dstdomain \(.*\)$/\1 \2/p' /etc/squid/squid.conf" 2>/dev/null)
eg_count=0
while read -r eg_port eg_hosts; do
  [ -n "$eg_port" ] || continue
  for eg_host in $eg_hosts; do
    eg_count=$((eg_count + 1))
    eg_addresses=$(sec_ssh "getent ahosts ${eg_host} | awk '{ print \$1 }' | sort -u | paste -sd' '")
    # shellcheck disable=SC2086  # one address per word
    if [ -z "$eg_addresses" ]; then
      sec_na "listed host ${eg_host}" "it does not resolve"
    elif eg_private $eg_addresses; then
      check "a listed name at a private address (${eg_host}: ${eg_addresses}) is refused" \
        eg_refused_as_api "https://${eg_host}:${eg_port}/"
    else
      check "through the proxy, the API reaches listed host ${eg_host}:${eg_port}" \
        eg_connected_as_api "https://${eg_host}:${eg_port}/"
    fi
  done
done <<<"$eg_listed"
[ "$eg_count" -gt 0 ] || sec_na "listed hosts through the proxy" "the allow list names no host"
