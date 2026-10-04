#!/usr/bin/env bash
# Proves from outside that only SSH, HTTP and HTTPS answer on a Portikus
# server (docs/SPEC.md section 24.1).  Run it from another machine on the
# internet, never on the server itself, where loopback services answer.
#
#   scripts/external-port-check.sh [--ports RANGE] [--no-nmap] HOST
#
# Scans every TCP port, and with nmap run as root a set of UDP ports, and
# fails when anything answers that is not in ALLOWED_PORTS (default
# "22 80 443"; add the SSH or site port if the server uses another one).
# HOST is a name or one address; run it once per address family.
# Uses nmap when installed, otherwise bash's /dev/tcp for TCP only.
#
# Exit status: 0 only allowed ports answer, 1 another port answers,
# 2 bad usage, 3 nothing answered at all, so nothing was proved.
set -euo pipefail

usage() { echo "usage: $0 [--ports RANGE] [--no-nmap] HOST" >&2; exit 2; }

ports="1-65535"
use_nmap=1
host=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ports) [ $# -ge 2 ] || usage; ports="$2"; shift 2 ;;
    --no-nmap) use_nmap=0; shift ;;
    -*) usage ;;
    *) [ -z "${host}" ] || usage; host="$1"; shift ;;
  esac
done
[ -n "${host}" ] || usage
[[ "${ports}" =~ ^[0-9]+-[0-9]+$ ]] || { echo "--ports takes a range such as 1-65535" >&2; exit 2; }
read -r -a allowed <<<"${ALLOWED_PORTS:-22 80 443}"
command -v nmap >/dev/null || use_nmap=0

# Services a misconfigured server most often exposes over UDP: DNS, DHCP,
# NTP, SNMP, IPsec, mDNS, SSDP, memcached, WireGuard, HTTP/3, and the
# workspace egress resolver.
udp_ports="53,67,68,69,111,123,137,161,443,500,1900,4500,5300,5353,11211,51820"

open_tcp=()
open_udp=()

if [ "${use_nmap}" = 1 ]; then
  family=()
  [[ "${host}" == *:* ]] && family=(-6)
  # A connect scan needs no root; -Pn scans even a host that ignores nmap's discovery probes.
  while read -r port; do open_tcp+=("${port}"); done < <(
    nmap "${family[@]}" -Pn -sT -T4 --open -p "${ports}" -oG - "${host}" \
      | grep -oE '[0-9]+/open/tcp' | cut -d/ -f1)
  if [ "$(id -u)" = 0 ]; then
    # Only "open" counts: a dropped UDP probe shows as open|filtered.
    while read -r port; do open_udp+=("${port}"); done < <(
      nmap "${family[@]}" -Pn -sU -T4 -p "${udp_ports}" -oG - "${host}" \
        | grep -oE '[0-9]+/open/udp' | cut -d/ -f1)
    udp_checked=1
  else
    udp_checked=0
  fi
else
  udp_checked=0
  first="${ports%-*}"
  last="${ports#*-}"
  # Parallel probes: a dropped port costs the whole timeout.  The inner
  # script expands $0 itself.
  # shellcheck disable=SC2016
  while read -r port; do open_tcp+=("${port}"); done < <(
    seq "${first}" "${last}" | xargs -P 512 -I{} bash -c \
      'timeout 3 bash -c "exec 3<>/dev/tcp/$0/{}" 2>/dev/null && echo {}' "${host}" | sort -n)
fi

is_allowed() {
  local p
  for p in "${allowed[@]}"; do [ "$p" = "$1" ] && return 0; done
  return 1
}

status=0
for port in "${open_tcp[@]}"; do
  if is_allowed "${port}"; then echo "ok    tcp/${port} answers (allowed)"
  else echo "FAIL  tcp/${port} answers and is not allowed"; status=1; fi
done
for port in "${open_udp[@]}"; do
  if is_allowed "${port}"; then echo "ok    udp/${port} answers (allowed)"
  else echo "FAIL  udp/${port} answers and is not allowed"; status=1; fi
done

if [ "${udp_checked}" = 0 ]; then
  echo "note  UDP was not checked: it needs nmap, run as root."
fi
if [ $(( ${#open_tcp[@]} + ${#open_udp[@]} )) -eq 0 ]; then
  echo "FAIL  nothing answered on ${host}; check the address and that this machine can reach it."
  exit 3
fi
if [ "${status}" = 0 ]; then
  echo "PASS  only ${allowed[*]} answer on ${host} (TCP ${ports})."
fi
exit "${status}"
