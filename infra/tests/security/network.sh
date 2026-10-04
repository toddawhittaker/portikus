#!/usr/bin/env bash
# Network isolation (SPEC.md 23.2 to 23.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# A workspace may reach the Internet and nothing else: not the VM's services,
# not the libvirt host on any address, not link-local targets, not the other
# workspace.  That includes the public site through the host's LAN address
# and published port, which the private-range egress rule blocks by design.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Network isolation ---"

net_a_ip=$(sec_ws_ip a)
net_b_ip=$(sec_ws_ip b)
net_bridge=$(sec_ssh "incus network get portikus-ws ipv4.address" | cut -d/ -f1)
net_gateway=$(sec_ssh "ip -4 route show default" | awk '{ print $3; exit }')
net_lan_gateway=$(ip -4 route show default | awk '{ print $3; exit }')
echo "Workspace a ${net_a_ip}, workspace b ${net_b_ip}, bridge ${net_bridge}, VM ${SEC_VM}, libvirt host ${net_gateway}"

# Every probe below dials these addresses; an empty one would dial nothing
# and pass, so the module stops here instead.
if [ -z "$net_a_ip" ] || [ -z "$net_b_ip" ] || [ -z "$net_bridge" ] || [ -z "$net_gateway" ]; then
  bad "network setup: the addresses of a, b, the bridge and the libvirt host are all known"
  return 0
fi

# A probe that can never connect proves nothing, so every context also dials
# the Internet and must see it open.
net_control="1.1.1.1,443"

# The host's LAN address, taken from its default route as the Makefile does.
# The site's name is no help here: this host may map it to the VM directly.
net_lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
echo "Public site through the host's LAN address: ${net_lan_ip:-(unknown)} port ${SEC_PUBLIC_PORT}"

# Every IPv4 address this host holds, with 22, the published port, and each
# port something listens on for that address.  The suite is meant to run on
# the libvirt host; elsewhere only its gateway address is known.
net_host_targets() {
  local addrs listen addr port a
  addrs=$(ip -4 -o addr show | awk '{ split($4, x, "/"); if (x[1] !~ /^127\./) print x[1] }')
  if ! printf '%s\n' "$addrs" | grep -qx "$net_gateway"; then
    echo "WARN: not running on the libvirt host; probing only ${net_gateway}" >&2
    addrs="$net_gateway"
  fi
  listen=$(ss -ltnH | awk '{ print $4 }')
  for a in $addrs; do
    {
      echo 22
      echo "$SEC_PUBLIC_PORT"
      while read -r addr_port; do
        addr="${addr_port%:*}"; port="${addr_port##*:}"
        case "$addr" in
          0.0.0.0 | '*' | '[::]') echo "$port" ;;
          "$a") echo "$port" ;;
        esac
      done <<<"$listen"
    } | sort -un | while read -r port; do echo "${a},${port}"; done
  done
}

net_vm_ports=(22 80 "${SEC_PUBLIC_PORT}" 443 2019 3000 3001 3002 5432 8443)
# With the ghcr.io cache on, 443 on the bridge address is the cache's
# redirect; checks after the probes prove it reaches the cache and nothing else.
net_bridge_ports=("${net_vm_ports[@]}")
net_ghcr=off
if sec_ghcr_cache_on; then
  net_ghcr=on
  mapfile -t net_bridge_ports < <(printf '%s\n' "${net_vm_ports[@]}" | grep -vx 443)
fi
echo "ghcr.io cache: ${net_ghcr}"
net_targets_for() { # ADDRESS PORTS...
  local addr="$1" p; shift
  for p in $(printf '%s\n' "$@" | sort -un); do echo "${addr},${p}"; done
}

# Start a listener on 5173 in each workspace, as the student, answering with
# its own name, so the peer and inbound probes have something real to reach.
# It listens on IPv4 and IPv6, so the link-local probes have a target too.
for key in a b; do
  sec_exec "$key" student "mkdir -p /tmp/sectest-www && echo sectest-${key} > /tmp/sectest-www/index.html && \
    (setsid nohup python3 -m http.server 5173 --bind :: --directory /tmp/sectest-www >/tmp/sectest-www.log 2>&1 &) ; sleep 1" >/dev/null 2>&1
done
check_output "the VM reaches workspace b's own listener (probe control)" "sectest-b" \
  sec_ssh "curl -s --max-time 5 http://${net_b_ip}:5173/"

net_groups=(vm-bridge vm-management libvirt-host host-addresses public-site lan-gateway link-local peer)
declare -A net_group_targets=(
  [vm-bridge]="$(net_targets_for "$net_bridge" "${net_bridge_ports[@]}")"
  [vm-management]="$(net_targets_for "$SEC_VM" "${net_vm_ports[@]}")"
  [libvirt-host]="$(net_targets_for "$net_gateway" 22 53 80 443 "$SEC_PUBLIC_PORT")"
  [host-addresses]="$(net_host_targets)"
  [public-site]="${net_lan_ip:+${net_lan_ip},${SEC_PUBLIC_PORT}}"
  [lan-gateway]="$(net_targets_for "$net_lan_gateway" 22 53 80 443)"
  [link-local]="$(net_targets_for 169.254.169.254 80 443)"
  [peer]="$(net_targets_for "$net_b_ip" 22 80 3000 5173 7400 8080)"
)
declare -A net_group_names=(
  [vm-bridge]="the VM on its bridge address"
  [vm-management]="the VM on its management address"
  [libvirt-host]="the libvirt host on the management network"
  [host-addresses]="every other address the host holds"
  [public-site]="the public site through the host's LAN address and published port (blocked by design)"
  [lan-gateway]="the host's LAN gateway"
  [link-local]="the metadata address"
  [peer]="the other workspace"
)

# The public-site probe counts only if the site really answers there.
if [ -z "$net_lan_ip" ]; then
  bad "the public site's name resolves to the host's LAN address"
else
  check_output "this host reaches the public site at ${net_lan_ip}:${SEC_PUBLIC_PORT} (probe control)" "200" \
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 -k \
    --resolve "${SEC_PUBLIC_HOST}:${SEC_PUBLIC_PORT}:${net_lan_ip}" "${SEC_API}/health"
fi

net_all_targets() {
  local g
  echo "$net_control"
  for g in "${net_groups[@]}"; do printf '%s\n' "${net_group_targets[$g]}"; done
}

# One exec per context; every target is dialled in parallel with a 2 s limit.
# Output lines are "address,port open|closed".
net_probe_bash() { # [TARGETS]
  local targets="${1:-$(net_all_targets | sed '/^$/d' | tr '\n' ' ')}"
  printf 'for t in %s; do ( h=${t%%,*}; p=${t##*,}; if timeout 2 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then echo "$t open"; else echo "$t closed"; fi ) & done; wait' "$targets"
}
net_probe_sh() { # [TARGETS]
  local targets="${1:-$(net_all_targets | sed '/^$/d' | tr '\n' ' ')}"
  printf 'for t in %s; do ( h=${t%%,*}; p=${t##*,}; if nc -z -w 2 "$h" "$p" 2>/dev/null; then echo "$t open"; else echo "$t closed"; fi ) & done; wait' "$targets"
}

# net_report CONTEXT RESULTS -- one check per group of targets.
net_report() {
  local context="$1" results="$2" g open
  if printf '%s\n' "$results" | grep -qx "${net_control} open"; then
    ok "${context}: Internet control target is reachable"
  else
    bad "${context}: Internet control target is reachable (the probe proves nothing)"
  fi
  for g in "${net_groups[@]}"; do
    [ -n "${net_group_targets[$g]}" ] || continue
    open=$(printf '%s\n' "$results" | awk '$2 == "open" { print $1 }' \
      | grep -x -F -f <(printf '%s\n' "${net_group_targets[$g]}") | tr '\n' ' ')
    if [ -z "$open" ]; then
      ok "${context}: ${net_group_names[$g]} is unreachable"
    else
      bad "${context}: ${net_group_names[$g]} is unreachable (open: ${open% })"
    fi
  done
}

echo ""
echo "Probing from workspace a (student, root, inner Docker on the default bridge and on the host network)..."
net_report "a as student" "$(sec_exec a student "$(net_probe_bash)" 2>/dev/null)"
net_report "a as root" "$(sec_exec a root "$(net_probe_bash)" 2>/dev/null)"
net_report "a, inner Docker" "$(sec_docker_exec a "$(net_probe_sh)" 2>/dev/null)"
net_report "a, inner Docker --network host" "$(sec_docker_exec a --network host "$(net_probe_sh)" 2>/dev/null)"
if [ "$net_ghcr" = on ]; then
  net_443_label="the bridge address's port 443 reaches the ghcr.io cache and nothing else"
  check_output "a as student: ${net_443_label}" "$SEC_GATEWAY_443_BASH" \
    sec_exec a student "$(sec_gateway_443_probe bash "$net_bridge"); g443"
  check_output "a as root: ${net_443_label}" "$SEC_GATEWAY_443_BASH" \
    sec_exec a root "$(sec_gateway_443_probe bash "$net_bridge"); g443"
  check_output "a, inner Docker: ${net_443_label}" "$SEC_GATEWAY_443_SH" \
    sec_docker_exec a "$(sec_gateway_443_probe sh "$net_bridge"); g443"
  check_output "a, inner Docker --network host: ${net_443_label}" "$SEC_GATEWAY_443_SH" \
    sec_docker_exec a --network host "$(sec_gateway_443_probe sh "$net_bridge"); g443"
fi

# ── The other workspace over IPv6 link-local ─────────────────────

# A scoped link-local address needs no route, so the IPv4 rules alone do not
# cover it.  Each context in a first dials its own link-local listener, which
# proves the probe can reach a scoped address at all, and b's listener must
# answer on b's own link-local address; only then does "closed" count.  The
# inner Docker default bridge is left out: its eth0 is Docker's, not the
# workspace network.
net_ll() { sec_exec "$1" root "ip -6 -o addr show dev eth0 scope link" 2>/dev/null | awk '{ split($4, x, "/"); print x[1]; exit }'; }
net_a_ll=$(net_ll a)
net_b_ll=$(net_ll b)
net_bridge_v6=$(sec_ssh "incus network get portikus-ws ipv6.address")
echo "Link-local addresses: a ${net_a_ll:-(none)}, b ${net_b_ll:-(none)}; bridge ipv6.address ${net_bridge_v6:-(unset)}"
if [ -z "$net_a_ll" ] || [ -z "$net_b_ll" ]; then
  sec_na "the other workspace is unreachable over IPv6 link-local" \
    "a workspace has no IPv6 link-local address on eth0, so there is no such path"
else
  net_ll_own="${net_a_ll}%eth0,5173"
  net_ll_peer="${net_b_ll}%eth0,5173 ${net_b_ll}%eth0,7400"
  check_output "b's listener answers on b's own link-local address (probe control)" "${net_b_ll}%eth0,5173 open" \
    sec_exec b student "$(net_probe_bash "${net_b_ll}%eth0,5173")"
  net_ll_report() { # CONTEXT RESULTS
    local open
    if ! printf '%s\n' "$2" | grep -qxF "${net_ll_own} open"; then
      bad "$1: reaches its own link-local listener (control; the peer probe proves nothing)"
      return
    fi
    ok "$1: reaches its own link-local listener (control)"
    open=$(printf '%s\n' "$2" | awk '$2 == "open" { print $1 }' | grep -vxF "$net_ll_own" | tr '\n' ' ')
    if [ -z "$open" ]; then
      ok "$1: the other workspace is unreachable over IPv6 link-local"
    else
      bad "$1: the other workspace is unreachable over IPv6 link-local (open: ${open% })"
    fi
  }
  net_ll_report "a as student" "$(sec_exec a student "$(net_probe_bash "${net_ll_own} ${net_ll_peer}")" 2>/dev/null)"
  net_ll_report "a as root" "$(sec_exec a root "$(net_probe_bash "${net_ll_own} ${net_ll_peer}")" 2>/dev/null)"
  net_ll_report "a, inner Docker --network host" \
    "$(sec_docker_exec a --network host "$(net_probe_sh "${net_ll_own} ${net_ll_peer}")" 2>/dev/null)"
fi

# Done item 15: A's agent port and application port from B and its containers,
# with the Internet control in the same exec.
net_peer_a="${net_control} ${net_a_ip},7400 ${net_a_ip},5173"
net_peer_probe() { # bash|sh
  local tool='timeout 2 bash -c "exec 3<>/dev/tcp/${t%,*}/${t#*,}"'
  [ "$1" = "sh" ] && tool='nc -z -w 2 "${t%,*}" "${t#*,}"'
  printf 'for t in %s; do if %s 2>/dev/null; then echo "$t open"; fi; done; true' "$net_peer_a" "$tool"
}
check_output "b as student cannot reach a's agent or application port (Internet control open)" "${net_control} open" \
  sec_exec b student "$(net_peer_probe bash)"
check_output "b as root cannot reach a's agent or application port (Internet control open)" "${net_control} open" \
  sec_exec b root "$(net_peer_probe bash)"
check_output "b, inner Docker, cannot reach a's agent or application port (Internet control open)" "${net_control} open" \
  sec_docker_exec b "$(net_peer_probe sh)"
check_output "b, inner Docker --network host, cannot reach a's agent or application port (Internet control open)" \
  "${net_control} open" sec_docker_exec b --network host "$(net_peer_probe sh)"
check_output "the VM without a token gets 401 from a's agent" "401" \
  sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${net_a_ip}:7400/health"

# Done item 17: nothing reaches a workspace directly from outside the VM.  The
# probe only means something if this host would send the packets to the VM;
# with no route to the workspace bridge they go to the LAN gateway instead.
net_from_host() {
  local t
  for t in "${net_a_ip}/7400" "${net_a_ip}/5173" "${net_b_ip}/7400" "${net_b_ip}/5173"; do
    if timeout 3 bash -c "exec 3<>/dev/tcp/${t}" 2>/dev/null; then echo "${t} open"; fi
  done
}
net_route=$(ip -4 route get "$net_a_ip" 2>/dev/null | head -1)
echo "This host's route to workspace a: ${net_route:-(none)}"
if [[ "$net_route" == *" via ${SEC_VM} "* ]]; then
  check_output "the host reaches no workspace agent or application port" "" net_from_host
else
  sec_na "the host reaches no workspace agent or application port" \
    "this host has no route to the workspace bridge through the VM, so its packets never reach the VM"
fi

# Egress stays open for real work (SPEC.md 23.1).
check "a as student reaches the npm registry" \
  sec_exec a student "curl -sS -o /dev/null --max-time 20 https://registry.npmjs.org/"
check "a as student reaches GitHub" \
  sec_exec a student "curl -sS -o /dev/null --max-time 20 https://github.com/"
check "a, inner Docker, reaches the npm registry" \
  sec_docker_exec a "wget -q -T 20 -O /dev/null https://registry.npmjs.org/"
check "a, inner Docker, reaches GitHub" \
  sec_docker_exec a "wget -q -T 20 -O /dev/null https://github.com/"

# ── Outbound abuse limits (SPEC.md 24.2) ─────────────────────────

# The limits table counts what it drops, so each check reads its counter or
# meter on the VM: a refusal the table never saw proves nothing.  The floods
# go to a private address the firewall drops after this table has counted
# them, so nothing leaves the VM.
echo ""
echo "Outbound abuse limits..."
net_flood_dst=10.255.255.1
net_limits_since=$(sec_ssh "date -u '+%Y-%m-%d %H:%M:%S'")
net_limits() { sec_ssh "sudo nft list table inet portikus_workspace_limits" 2>/dev/null; }
net_mail_count() {
  sec_ssh "sudo nft list counter inet portikus_workspace_limits mail_blocked" 2>/dev/null \
    | awk '$1 == "packets" { print $2; exit }'
}
# net_meter SET -- the packets a's address has in the meter set, 0 when absent.
net_meter() {
  sec_ssh "sudo nft list set inet portikus_workspace_limits $1" 2>/dev/null \
    | grep -o "${net_a_ip//./\\.} counter packets [0-9]*" | awk '{ print $4 }' | grep . || echo 0
}
# net_logged PREFIX -- kernel log lines with PREFIX for a's address since the limits checks began.
net_logged() {
  sec_ssh "sudo journalctl -k -q --no-pager --since '${net_limits_since}' --grep '$1: .*SRC=${net_a_ip//./\\.} '" 2>/dev/null \
    | grep -c "$1: " || true
}

net_limits_table=$(net_limits)
if [ -z "$net_limits_table" ]; then
  bad "the workspace outbound limits table is loaded"
else
  ok "the workspace outbound limits table is loaded"

  # Mail: dialled by address, so the probe does not depend on the egress mode's DNS.
  if printf '%s\n' "$net_limits_table" | grep -q 'tcp dport { 25, 465, 587 } goto mail'; then
    net_smtp=$(sec_ssh "getent ahostsv4 smtp.gmail.com" | awk '{ print $1; exit }')
    net_mx=$(sec_ssh "getent ahostsv4 gmail-smtp-in.l.google.com" | awk '{ print $1; exit }')
    net_smtp=${net_smtp:-192.0.2.25}
    net_mx=${net_mx:-192.0.2.25}
    net_mail_targets="${net_mx},25 ${net_smtp},465 ${net_smtp},587"
    net_mail_before=$(net_mail_count)
    check_output "a as student cannot open outbound mail ports 25, 465 or 587" "" \
      sec_exec a student "{ $(net_probe_bash "$net_mail_targets"); } | grep ' open$'"
    check_output "a as root cannot open outbound mail ports 25, 465 or 587" "" \
      sec_exec a root "{ $(net_probe_bash "$net_mail_targets"); } | grep ' open$'"
    check_output "a, inner Docker, cannot open outbound mail ports 25, 465 or 587" "" \
      sec_docker_exec a "{ $(net_probe_sh "$net_mail_targets"); } | grep ' open$'"
    net_mail_after=$(net_mail_count)
    # Nine probes, each at least one SYN through the mail rule.
    if [ -n "$net_mail_before" ] && [ -n "$net_mail_after" ] && [ $((net_mail_after - net_mail_before)) -ge 9 ]; then
      ok "the mail block, not something else, refused every mail probe (counter ${net_mail_before} to ${net_mail_after})"
    else
      bad "the mail block, not something else, refused every mail probe (counter ${net_mail_before:-?} to ${net_mail_after:-?})"
    fi
    check "the mail block logs the workspace's address" test "$(net_logged portikus-ws-mail-blocked)" -ge 1
  else
    sec_warn "outbound mail from workspaces is allowed on this VM (portikus_workspace_mail_allowed)"
  fi

  # Packets first: a flow whose first packet is over the connection limit is
  # never set up, so after the connection flood every packet would count there.
  # One UDP flow, 50,000 packets as fast as Python sends them.
  net_packet_before=$(net_meter packet_over)
  sec_exec a student "python3 -c '
import socket
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for _ in range(50000):
    u.sendto(b\"x\", (\"${net_flood_dst}\", 9))
'" >/dev/null 2>&1
  net_packet_after=$(net_meter packet_over)
  if [ $((net_packet_after - net_packet_before)) -ge 10000 ]; then
    ok "a flood of 50,000 UDP packets from a is cut at the per-workspace limit (meter ${net_packet_before} to ${net_packet_after})"
  else
    bad "a flood of 50,000 UDP packets from a is cut at the per-workspace limit (meter ${net_packet_before} to ${net_packet_after})"
  fi
  check "the packet limit logs the workspace's address" test "$(net_logged portikus-ws-packet-limit)" -ge 1

  # New connections: 600 at once to distinct ports, three times the burst.
  net_conn_before=$(net_meter conn_over)
  sec_exec a student "python3 -c '
import socket
for port in range(20000, 20600):
    s = socket.socket(); s.setblocking(False)
    try: s.connect((\"${net_flood_dst}\", port))
    except BlockingIOError: pass
    s.close()
'" >/dev/null 2>&1
  net_conn_after=$(net_meter conn_over)
  if [ $((net_conn_after - net_conn_before)) -ge 300 ]; then
    ok "a burst of 600 new connections from a is cut at the per-workspace limit (meter ${net_conn_before} to ${net_conn_after})"
  else
    bad "a burst of 600 new connections from a is cut at the per-workspace limit (meter ${net_conn_before} to ${net_conn_after})"
  fi
  check "the connection limit logs the workspace's address" test "$(net_logged portikus-ws-conn-limit)" -ge 1

  # The limits hold per workspace and refill: b was never limited, and a recovers.
  check "b still reaches the npm registry while a is limited" \
    sec_exec b student "curl -sS -o /dev/null --max-time 20 https://registry.npmjs.org/"
  sleep 12
  check "a reaches the npm registry again once its allowance refills" \
    sec_exec a student "curl -sS -o /dev/null --max-time 20 https://registry.npmjs.org/"
  check "the meter counts a's new connections" test "$(net_meter new_conns)" -gt 0
fi

# Done item 16, last part: a claims b's address.  The bridge filters a's
# frames by address, so the VM keeps talking to b, and a's listener never sees
# the request.  This runs last because it may disturb b's address briefly.
echo ""
echo "Adding b's address to a's interface..."
sec_exec a root "ip addr add ${net_b_ip}/32 dev eth0 && ping -c 2 -W 1 -I ${net_b_ip} ${net_bridge} >/dev/null 2>&1; : > /tmp/sectest-www.log" >/dev/null 2>&1
net_spoof_answers() {
  local out=""
  for _ in 1 2 3; do
    out="${out}$(sec_ssh "curl -s --max-time 5 http://${net_b_ip}:5173/") "
    sleep 1
  done
  printf '%s' "${out% }"
}
check_output "the VM still reaches b, not a, at b's address" "sectest-b sectest-b sectest-b" net_spoof_answers
check_output "b's agent still answers at b's address with b's token" "200" \
  sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H @${SEC_REMOTE_DIR}/b.agent http://${net_b_ip}:7400/health"
check_output "a's listener received none of b's traffic" "0" \
  sec_exec a root "grep -c GET /tmp/sectest-www.log"
sec_exec a root "ip addr del ${net_b_ip}/32 dev eth0" >/dev/null 2>&1 || true
