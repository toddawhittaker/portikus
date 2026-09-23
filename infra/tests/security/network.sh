#!/usr/bin/env bash
# Network isolation (Epic 12a Done items 15, 16 and 17; SPEC.md 23.2 to 23.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# A workspace may reach the Internet and the public site on its published
# port, and nothing else: not the VM's services, not the libvirt host on any
# address, not link-local targets, not the other workspace.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Network isolation ---"

net_a_ip=$(sec_ws_ip a)
net_b_ip=$(sec_ws_ip b)
net_bridge=$(sec_ssh "incus network get portikus-ws ipv4.address" | cut -d/ -f1)
net_gateway=$(sec_ssh "ip -4 route show default" | awk '{ print $3; exit }')
net_lan_gateway=$(ip -4 route show default | awk '{ print $3; exit }')
# A probe that can never connect proves nothing, so every context also dials
# the Internet and must see it open.
net_control="1.1.1.1,443"
echo "Workspace a ${net_a_ip}, workspace b ${net_b_ip}, bridge ${net_bridge}, VM ${SEC_VM}, libvirt host ${net_gateway}"

# Every IPv4 address this host holds, with 22 and each port something listens
# on for that address, except the published port, which is allowed.  The
# suite is meant to run on the libvirt host; elsewhere only its gateway
# address is known.
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
      while read -r addr_port; do
        addr="${addr_port%:*}"; port="${addr_port##*:}"
        case "$addr" in
          0.0.0.0 | '*' | '[::]') echo "$port" ;;
          "$a") echo "$port" ;;
        esac
      done <<<"$listen"
    } | sort -un | grep -vx "$SEC_PUBLIC_PORT" | while read -r port; do echo "${a},${port}"; done
  done
}

net_vm_ports=(22 80 "${SEC_PUBLIC_PORT}" 443 2019 3000 3001 3002 5432 8443)
net_targets_for() { # ADDRESS PORTS...
  local addr="$1" p; shift
  for p in $(printf '%s\n' "$@" | sort -un); do echo "${addr},${p}"; done
}

# Start a listener on 5173 in each workspace, as the student, answering with
# its own name, so the peer and inbound probes have something real to reach.
for key in a b; do
  sec_exec "$key" student "mkdir -p /tmp/sectest-www && echo sectest-${key} > /tmp/sectest-www/index.html && \
    (setsid nohup python3 -m http.server 5173 --bind 0.0.0.0 --directory /tmp/sectest-www >/tmp/sectest-www.log 2>&1 &) ; sleep 1" >/dev/null 2>&1
done
check_output "the VM reaches workspace b's own listener (probe control)" "sectest-b" \
  sec_ssh "curl -s --max-time 5 http://${net_b_ip}:5173/"

net_b_ll=$(sec_exec b root "ip -6 -o addr show dev eth0 scope link" 2>/dev/null | awk '{ split($4, x, "/"); print x[1]; exit }')
echo "Workspace b link-local address: ${net_b_ll:-(none)}"

net_groups=(vm-bridge vm-management libvirt-host host-addresses lan-gateway link-local peer)
declare -A net_group_targets=(
  [vm-bridge]="$(net_targets_for "$net_bridge" "${net_vm_ports[@]}")"
  [vm-management]="$(net_targets_for "$SEC_VM" "${net_vm_ports[@]}")"
  [libvirt-host]="$(net_targets_for "$net_gateway" 22 53 80 443)"
  [host-addresses]="$(net_host_targets)"
  [lan-gateway]="$(net_targets_for "$net_lan_gateway" 22 53 80 443)"
  [link-local]="$(net_targets_for 169.254.169.254 80 443)"
  [peer]="$(net_targets_for "$net_b_ip" 22 80 3000 5173 7400 8080)
${net_b_ll:+${net_b_ll}%eth0,7400
${net_b_ll}%eth0,5173}"
)
declare -A net_group_names=(
  [vm-bridge]="the VM on its bridge address"
  [vm-management]="the VM on its management address"
  [libvirt-host]="the libvirt host on the management network"
  [host-addresses]="every other address the host holds"
  [lan-gateway]="the host's LAN gateway"
  [link-local]="the metadata address"
  [peer]="the other workspace"
)

net_all_targets() {
  local g
  echo "$net_control"
  for g in "${net_groups[@]}"; do printf '%s\n' "${net_group_targets[$g]}"; done
}

# One exec per context; every target is dialled in parallel with a 2 s limit.
# Output lines are "address,port open|closed".
net_probe_bash() {
  local targets
  targets=$(net_all_targets | sed '/^$/d' | tr '\n' ' ')
  printf 'for t in %s; do ( h=${t%%,*}; p=${t##*,}; if timeout 2 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then echo "$t open"; else echo "$t closed"; fi ) & done; wait' "$targets"
}
net_probe_sh() {
  local targets
  targets=$(net_all_targets | sed '/^$/d' | tr '\n' ' ')
  printf 'for t in %s; do ( h=${t%%,*}; p=${t##*,}; if nc -z -w 2 "$h" "$p" 2>/dev/null; then echo "$t open"; else echo "$t closed"; fi ) & done; wait' "$targets"
}

# net_report CONTEXT RESULTS -- one check per group of targets.
net_report() {
  local context="$1" results="$2" g open
  if printf '%s\n' "$results" | grep -qx "${net_control} open"; then
    sec_pass "${context}: Internet control target is reachable"
  else
    sec_fail "${context}: Internet control target is reachable (the probe proves nothing)"
  fi
  for g in "${net_groups[@]}"; do
    [ -n "${net_group_targets[$g]}" ] || continue
    open=$(printf '%s\n' "$results" | awk '$2 == "open" { print $1 }' \
      | grep -x -F -f <(printf '%s\n' "${net_group_targets[$g]}") | tr '\n' ' ')
    if [ -z "$open" ]; then
      sec_pass "${context}: ${net_group_names[$g]} is unreachable"
    else
      sec_fail "${context}: ${net_group_names[$g]} is unreachable (open: ${open% })"
    fi
  done
}

echo ""
echo "Probing from workspace a (student, root, inner Docker on the default bridge and on the host network)..."
net_report "a as student" "$(sec_exec a student "$(net_probe_bash)" 2>/dev/null)"
net_report "a as root" "$(sec_exec a root "$(net_probe_bash)" 2>/dev/null)"
net_report "a, inner Docker" "$(sec_docker_exec a "$(net_probe_sh)" 2>/dev/null)"
net_report "a, inner Docker --network host" "$(sec_docker_exec a --network host "$(net_probe_sh)" 2>/dev/null)"

# Done item 15: A's agent port and application port from B and its containers.
net_peer_a="${net_a_ip},7400 ${net_a_ip},5173"
net_peer_probe() { # bash|sh
  local tool='timeout 2 bash -c "exec 3<>/dev/tcp/${t%,*}/${t#*,}"'
  [ "$1" = "sh" ] && tool='nc -z -w 2 "${t%,*}" "${t#*,}"'
  printf 'for t in %s; do if %s 2>/dev/null; then echo "$t open"; fi; done; true' "$net_peer_a" "$tool"
}
check_output "b as student cannot reach a's agent or application port" "" \
  sec_exec b student "$(net_peer_probe bash)"
check_output "b as root cannot reach a's agent or application port" "" \
  sec_exec b root "$(net_peer_probe bash)"
check_output "b, inner Docker, cannot reach a's agent or application port" "" \
  sec_docker_exec b "$(net_peer_probe sh)"
check_output "b, inner Docker --network host, cannot reach a's agent or application port" "" \
  sec_docker_exec b --network host "$(net_peer_probe sh)"
check_output "the VM without a token gets 401 from a's agent" "401" \
  sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${net_a_ip}:7400/health"

# Done item 17: nothing reaches a workspace directly from outside the VM.
net_from_host() {
  local t
  for t in "${net_a_ip}/7400" "${net_a_ip}/5173" "${net_b_ip}/7400" "${net_b_ip}/5173"; do
    if timeout 3 bash -c "exec 3<>/dev/tcp/${t}" 2>/dev/null; then echo "${t} open"; fi
  done
}
check_output "the host reaches no workspace agent or application port" "" net_from_host

# Egress stays open for real work (SPEC.md 23.1).
check "a as student reaches the npm registry" \
  sec_exec a student "curl -sS -o /dev/null --max-time 20 https://registry.npmjs.org/"
check "a as student reaches GitHub" \
  sec_exec a student "curl -sS -o /dev/null --max-time 20 https://github.com/"
check "a, inner Docker, reaches the npm registry" \
  sec_docker_exec a "wget -q -T 20 -O /dev/null https://registry.npmjs.org/"
check "a, inner Docker, reaches GitHub" \
  sec_docker_exec a "wget -q -T 20 -O /dev/null https://github.com/"

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
