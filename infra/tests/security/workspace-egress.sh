#!/usr/bin/env bash
# Workspace egress in open mode, open mode with blocked sites, and
# allow-list mode (ADR 0038, ADR 0043).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# Every mode keeps the redirect targets on the bridge gateway closed to
# direct use.  The blocked sites and allow-list mode are set through the
# admin API, as an administrator would, and put back at the end; because that
# changes every workspace's network, it runs only when the run's own
# workspaces are the only ones on the VM.  Its checks follow "Security invariants to test"
# for egress, from the workspace and from a Docker container inside it.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Workspace egress ---"

we_gateway=$(sec_ssh "incus network get portikus-ws ipv4.address" | cut -d/ -f1)
we_a_ip=$(sec_ws_ip a)
we_b_ip=$(sec_ws_ip b)
we_since=$(sec_ssh "date -u '+%Y-%m-%d %H:%M:%S'")
we_policy=$(sec_psql "SELECT egress_mode || ' ' || array_to_string(egress_presets, ',') FROM settings WHERE id = 1")
we_start_mode=${we_policy%% *}
we_start_presets=${we_policy#* }
[ "$we_start_presets" = "$we_policy" ] && we_start_presets=""
echo "Gateway ${we_gateway}, workspace a ${we_a_ip}, policy: ${we_start_mode} (presets: ${we_start_presets:-none})"
if [ -z "$we_gateway" ] || [ -z "$we_a_ip" ] || [ -z "$we_start_mode" ]; then
  bad "workspace egress setup: the gateway, a's address and the policy are known"
  return 0
fi

# ── Probes ───────────────────────────────────────────────────────

# The probe prints one "name value" line per check.  It resolves one of
# api.github.com's addresses first, which in allow-list mode also puts the
# address in the helper's set, so the hard-coded-address checks below dial
# an address the firewall lets through to Squid.
we_probe_bash() {
  cat <<EOF
gw=${we_gateway}
vm=${SEC_VM}
EOF
  cat <<'EOF'
p() { printf '%s %s\n' "$1" "$2"; }
tcp() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo open || echo closed; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
resolves() { getent ahostsv4 "$1" >/dev/null 2>&1 && echo yes || echo no; }
udp_dns() {
  python3 -c 'import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.sendto(bytes.fromhex("abcd01000001000000000000076578616d706c6503636f6d0000010001"), (sys.argv[1], int(sys.argv[2])))
s.recv(512); print("answered")' "$1" "$2" 2>/dev/null || echo silent
}
gh=$(getent ahostsv4 api.github.com | awk '{ print $1; exit }')
p listed_resolves "$([ -n "$gh" ] && echo yes || echo no)"
gh=${gh:-192.0.2.1}
p listed_https "$(code https://api.github.com/)"
p listed_http "$(code http://github.com/)"
p listed_ssh "$(tcp github.com 22)"
p unlisted_resolves "$(resolves example.com)"
p blocked_subdomain_resolves "$(resolves www.example.com)"
p other_resolves "$(resolves example.org)"
p other_https "$(code https://example.org/)"
p lookalike_resolves "$(resolves githubstatus.com)"
p incus_names "$(getent ahostsv4 _gateway.incus | awk '{ print $1; exit }')"
p unlisted_address "$(code -k https://1.1.1.1/)"
p unlisted_sni_on_listed_address "$(code -k --resolve "example.com:443:${gh}" https://example.com/)"
p no_sni_on_listed_address "$(code -k "https://${gh}/")"
p unlisted_host_on_listed_address "$(curl -s -o /dev/null -D - --max-time 10 -H 'Host: example.com' "http://${gh}/" \
  | awk 'NR == 1 { c = $2 } tolower($1) == "x-squid-error:" { s = "squid" } END { print (c ? c : "000") "/" (s ? s : "origin") }')"
p outside_dns_udp "$(udp_dns 1.1.1.1 53)"
p outside_dns_tcp "$(tcp 1.1.1.1 53)"
p outside_dot "$(tcp 1.1.1.1 853)"
p doh_by_name "$(code https://cloudflare-dns.com/dns-query)"
p doh_by_address "$(code --resolve cloudflare-dns.com:443:1.1.1.1 https://cloudflare-dns.com/dns-query)"
p private_vm "$(tcp "$vm" 22)"
p private_metadata "$(tcp 169.254.169.254 80)"
p direct_proxy_ports "$(tcp "$gw" 3129)/$(tcp "$gw" 3130)/$(tcp "$gw" 5300)/$(udp_dns "$gw" 5300)"
p direct_forward_proxy "$(code --proxy "http://${gw}:3129" http://github.com/)"
# The first public WebSocket echo service on plain HTTP that answers at all.
ws_upgrade() {
  local u c
  for u in http://websocket-echo.com/ http://echo.websocket.in/ http://ws.vi-server.org/mirror; do
    c=$(code -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$u")
    [ "$c" != 000 ] && { echo "$c"; return; }
  done
  echo 000
}
p ws_upgrade "$(ws_upgrade)"
p gateway_other_ports "$(for port in 22 80 443 3000 3001 3128 3199 5398 5399 8443; do tcp "$gw" "$port"; done | sort -u | paste -sd,)"
EOF
}

# The same checks from inside a Docker container on the workspace's default
# bridge, with busybox tools where Alpine has no curl.
we_probe_docker() {
  cat <<EOF
gw=${we_gateway}
EOF
  cat <<'EOF'
p() { printf '%s %s\n' "$1" "$2"; }
tcp() { nc -z -w 4 "$1" "$2" 2>/dev/null && echo open || echo closed; }
fetch() { wget -q -T 10 -O /dev/null "$1" 2>/dev/null && echo ok || echo failed; }
resolves() { nslookup "$1" >/dev/null 2>&1 && echo yes || echo no; }
gh=$(nslookup api.github.com 2>/dev/null | awk '/^Address: [0-9.]+$/ { print $2; exit }')
p listed_resolves "$([ -n "$gh" ] && echo yes || echo no)"
gh=${gh:-192.0.2.1}
p listed_https "$(fetch https://api.github.com/zen)"
p unlisted_resolves "$(resolves example.com)"
p unlisted_address "$(tcp 1.1.1.1 443)"
# Busybox shows no headers on an error, so only the status is compared.
p unlisted_host_on_listed_address "$(wget -S -q -T 10 -O /dev/null --header 'Host: example.com' "http://${gh}/" 2>&1 \
  | awk '/^ *HTTP\// && !c { c = $2 } END { print c ? c : "000" }')"
p outside_dns "$(nslookup -timeout=3 example.com 1.1.1.1 >/dev/null 2>&1 && echo answered || echo silent)"
p outside_dot "$(tcp 1.1.1.1 853)"
p direct_proxy_ports "$(tcp "$gw" 3129)/$(tcp "$gw" 3130)/$(tcp "$gw" 5300)"
EOF
}

# we_expect CONTEXT RESULTS NAME WANTED LABEL -- WANTED is a value, or !VALUE
# for "anything but VALUE".
we_expect() {
  local context="$1" results="$2" name="$3" wanted="$4" label="$5" got
  got=$(printf '%s\n' "$results" | awk -v n="$name" '$1 == n { print $2; exit }')
  if [ "${wanted#!}" != "$wanted" ]; then
    if [ -n "$got" ] && [ "$got" != "${wanted#!}" ]; then ok "${context}: ${label}"; else bad "${context}: ${label} (got: ${got:-nothing})"; fi
  elif [ "$got" = "$wanted" ]; then
    ok "${context}: ${label}"
  else
    bad "${context}: ${label} (got: ${got:-nothing})"
  fi
}

we_run_bash() { sec_exec a student "$(we_probe_bash)" 2>/dev/null; }
we_run_docker() { sec_docker_exec a "$(we_probe_docker)" 2>/dev/null; }

# we_quic_leaks -- how many UDP 443 (QUIC) packets from a to a listed
# address left the VM.  A counter in a table of the test's own, hooked after
# every filter and before Incus's masquerade, sees only what got through;
# the probe needs no answer from the other end.
we_quic_leaks() {
  local out
  sec_ssh "sudo nft -f - <<'NFT'
table inet portikus_sectest {
  chain post { type filter hook postrouting priority srcnat - 10; ip saddr ${we_a_ip} oifname != \"portikus-ws\" udp dport 443 counter; }
}
NFT" >/dev/null 2>&1
  sec_exec a student 'ip=$(getent ahostsv4 api.github.com | awk "{ print \$1; exit }")
    for i in 1 2 3; do printf quic > "/dev/udp/${ip:-192.0.2.1}/443"; sleep 0.2; done' >/dev/null 2>&1
  out=$(sec_ssh "sudo nft list table inet portikus_sectest; sudo nft delete table inet portikus_sectest" 2>/dev/null)
  printf '%s\n' "$out" | awk '/counter packets/ { for (i = 1; i < NF; i++) if ($i == "packets") { print $(i + 1); exit } }'
}

# The probe from a to b's listener and agent ports; it prints only what is open.
we_peer_probe() {
  printf 'for t in %s,5173 %s,7400; do timeout 3 bash -c "exec 3<>/dev/tcp/${t%%,*}/${t#*,}" 2>/dev/null && echo "$t open"; done; true' \
    "$we_b_ip" "$we_b_ip"
}

# ── Open mode ────────────────────────────────────────────────────

we_check_open() {
  local r
  check "open mode: the egress DNS is stopped" sec_ssh "! systemctl is-active --quiet portikus-egress-dns"
  r=$(we_run_bash)
  we_expect "open, a" "$r" listed_https '!000' "a listed host is reached over HTTPS"
  we_expect "open, a" "$r" unlisted_resolves yes "any name resolves"
  we_expect "open, a" "$r" unlisted_address '!000' "any public address is reached"
  we_expect "open, a" "$r" unlisted_host_on_listed_address '!403/squid' "plain HTTP is not intercepted"
  we_expect "open, a" "$r" outside_dns_udp answered "an outside resolver answers"
  we_expect "open, a" "$r" private_vm closed "the VM stays unreachable"
  we_expect "open, a" "$r" direct_proxy_ports "closed/closed/closed/silent" "the redirect targets cannot be used directly"
  we_expect "open, a" "$r" gateway_other_ports closed "the gateway is closed on every other port probed"
  r=$(we_run_docker)
  we_expect "open, a's Docker" "$r" unlisted_resolves yes "any name resolves"
  we_expect "open, a's Docker" "$r" unlisted_host_on_listed_address '!403' "plain HTTP is not intercepted (control)"
  we_expect "open, a's Docker" "$r" direct_proxy_ports "closed/closed/closed" "the redirect targets cannot be used directly"
  r=$(we_quic_leaks)
  if [ "${r:-0}" -gt 0 ]; then ok "open, a: UDP 443 (QUIC) leaves the VM (control for the allow-list check)"; else bad "open, a: UDP 443 (QUIC) leaves the VM (control; counted ${r:-nothing})"; fi
}

# ── Open mode with blocked sites ─────────────────────────────────

# The list the run sets: example.com, and two DNS over HTTPS services.
WE_BLOCKED=(example.com cloudflare-dns.com dns.google)

we_check_open_blocked() {
  local r before ws
  check "open mode with blocked sites: the egress DNS runs" sec_ssh "systemctl is-active --quiet portikus-egress-dns"
  check "open mode with blocked sites: the workspace proxy runs" sec_ssh "systemctl is-active --quiet portikus-workspace-proxy"
  check "open mode with blocked sites: Squid's open switch is on" sec_ssh "grep -qx '[.]' /var/lib/portikus/egress-state/open.txt"
  sec_exec a root "resolvectl flush-caches" >/dev/null 2>&1
  before=$(we_unblocked_count)
  r=$(we_run_bash)
  printf '%s\n' "$r" | sed 's/^/    /'
  we_expect "blocked, a" "$r" unlisted_resolves no "a blocked name gets no address"
  we_expect "blocked, a" "$r" blocked_subdomain_resolves no "a blocked name's subdomain gets no address"
  we_expect "blocked, a" "$r" other_resolves yes "an unblocked name resolves"
  we_expect "blocked, a" "$r" other_https '!000' "an unblocked site is reached over HTTPS (spliced)"
  we_expect "blocked, a" "$r" listed_https '!000' "another unblocked site is reached over HTTPS"
  we_expect "blocked, a" "$r" listed_http 301 "an unblocked site is reached over plain HTTP"
  we_expect "blocked, a" "$r" listed_ssh open "port 22 is not intercepted"
  we_expect "blocked, a" "$r" lookalike_resolves yes "a name merely like a blocked one resolves"
  we_expect "blocked, a" "$r" incus_names "$we_gateway" "Incus's .incus names still resolve"
  we_expect "blocked, a" "$r" unlisted_sni_on_listed_address 000 "a blocked TLS name on a hard-coded address is refused"
  we_expect "blocked, a" "$r" no_sni_on_listed_address '!000' "TLS with no name is spliced"
  we_expect "blocked, a" "$r" unlisted_address '!000' "a public address is reached"
  we_expect "blocked, a" "$r" unlisted_host_on_listed_address "403/squid" "a blocked Host on another address is refused"
  we_expect "blocked, a" "$r" outside_dns_udp silent "an outside resolver on UDP 53 is unreachable"
  we_expect "blocked, a" "$r" outside_dns_tcp closed "an outside resolver on TCP 53 is unreachable"
  we_expect "blocked, a" "$r" outside_dot closed "DNS over TLS (853) is unreachable"
  we_expect "blocked, a" "$r" doh_by_name 000 "a blocked DNS over HTTPS service fails by name"
  we_expect "blocked, a" "$r" doh_by_address 000 "a blocked DNS over HTTPS service fails on its own address"
  we_expect "blocked, a" "$r" private_vm closed "the VM stays unreachable"
  we_expect "blocked, a" "$r" private_metadata closed "the metadata address stays unreachable"
  we_expect "blocked, a" "$r" direct_proxy_ports "closed/closed/closed/silent" "the redirect targets cannot be used directly"
  we_expect "blocked, a" "$r" direct_forward_proxy 000 "the proxy cannot be used as a forward proxy"
  we_expect "blocked, a" "$r" gateway_other_ports closed "the gateway is closed on every other port probed"
  # Public echo services come and go: none answering is not a failure of ours.
  ws=$(printf '%s\n' "$r" | awk '$1 == "ws_upgrade" { print $2; exit }')
  if [ "$ws" = 000 ]; then
    sec_na "blocked, a: a WebSocket upgrade on port 80 gets 101" "no public WebSocket echo service answered"
  else
    we_expect "blocked, a" "$r" ws_upgrade 101 "a WebSocket upgrade on port 80 gets 101"
  fi
  we_expect "blocked, a" "$(we_squid_cap)" squid_cap "256/44" "one workspace holds at most 256 connections to the proxy; the rest are reset"

  r=$(we_run_docker)
  printf '%s\n' "$r" | sed 's/^/    /'
  we_expect "blocked, a's Docker" "$r" unlisted_resolves no "a blocked name gets no address"
  we_expect "blocked, a's Docker" "$r" listed_https ok "an unblocked site is reached over HTTPS"
  we_expect "blocked, a's Docker" "$r" unlisted_host_on_listed_address 403 "a blocked Host is refused"
  we_expect "blocked, a's Docker" "$r" outside_dns silent "an outside resolver is unreachable"
  we_expect "blocked, a's Docker" "$r" outside_dot closed "DNS over TLS is unreachable"
  we_expect "blocked, a's Docker" "$r" direct_proxy_ports "closed/closed/closed" "the redirect targets cannot be used directly"
  check "blocked, a's Docker: an unblocked registry serves a pull" \
    sec_exec a student "docker pull -q alpine:3.22"

  check_output "blocked, a: UDP 443 (QUIC) never leaves the VM, so it cannot pass Squid" "0" we_quic_leaks
  check "the blocked name is counted from DNS and from Squid" we_counted example.com
  # Only refusals are counted: an unblocked site that was reached is not.
  check_output "an unblocked site that was reached is not counted" "$before" we_unblocked_count
}

# we_squid_cap -- opens 300 connections from a to port 80 and holds them;
# prints how many connected and how many were refused.
we_squid_cap() {
  sec_exec a student 'python3 -c "
import socket
ip = socket.gethostbyname(\"example.org\")
held, refused = [], 0
for _ in range(300):
    s = socket.socket()
    s.settimeout(5)
    try:
        s.connect((ip, 80))
        held.append(s)
    except OSError:
        refused += 1
print(\"squid_cap %s/%s\" % (len(held), refused))
"' 2>/dev/null
}

# A connection opened before a block must not outlive it: the helper forgets
# the subnet's connections, so NAT is decided again (ADR 0043).
we_held_ip=""
we_hold_connection() {
  we_held_ip=$(sec_exec a student "getent ahostsv4 example.com | awk '{ print \$1; exit }'" 2>/dev/null)
  [ -n "$we_held_ip" ] || return 1
  sec_exec a student "setsid -f bash -c 'exec 3<>/dev/tcp/${we_held_ip}/80; sleep 300' >/dev/null 2>&1" >/dev/null 2>&1
  sleep 1
}
we_held_tracked() {
  sec_ssh "sudo conntrack -L -p tcp -s ${we_a_ip} -d ${we_held_ip} --dport 80 2>/dev/null | grep -c ESTABLISHED; true"
}
we_release_connection() {
  [ -n "$we_held_ip" ] && sec_exec a student "pkill -f '/dev/tcp/${we_held_ip}/80'; true" >/dev/null 2>&1
  we_held_ip=""
}

# Today's counts for the unblocked names the probes reach; an earlier run may have refused them.
we_unblocked_count() {
  sec_psql "SELECT coalesce(sum(count), 0) FROM egress_blocked_names WHERE day = (now() AT TIME ZONE 'UTC')::date AND name IN ('example.org', 'api.github.com', 'github.com')"
}

# ── Allow-list mode ──────────────────────────────────────────────

we_check_allow_list() {
  local r
  check "allow-list mode: the egress DNS runs" sec_ssh "systemctl is-active --quiet portikus-egress-dns"
  check "allow-list mode: the workspace proxy runs" sec_ssh "systemctl is-active --quiet portikus-workspace-proxy"
  # The workspace's own resolver may still hold answers from open mode.
  sec_exec a root "resolvectl flush-caches" >/dev/null 2>&1
  r=$(we_run_bash)
  printf '%s\n' "$r" | sed 's/^/    /'
  we_expect "allow-list, a" "$r" listed_resolves yes "a listed name's subdomain resolves"
  we_expect "allow-list, a" "$r" listed_https '!000' "a listed name's subdomain is reached over HTTPS (spliced)"
  we_expect "allow-list, a" "$r" listed_http 301 "a listed name is reached over plain HTTP"
  we_expect "allow-list, a" "$r" listed_ssh open "a listed name is reached on port 22"
  we_expect "allow-list, a" "$r" unlisted_resolves no "an unlisted name gets no address"
  we_expect "allow-list, a" "$r" lookalike_resolves no "a lookalike name gets no address"
  we_expect "allow-list, a" "$r" incus_names "$we_gateway" "Incus's .incus names still resolve"
  we_expect "allow-list, a" "$r" unlisted_address 000 "a hard-coded unlisted address is dropped"
  we_expect "allow-list, a" "$r" unlisted_sni_on_listed_address 000 "an unlisted TLS name on a listed address is refused"
  we_expect "allow-list, a" "$r" no_sni_on_listed_address 000 "TLS with no name on a listed address is refused"
  we_expect "allow-list, a" "$r" unlisted_host_on_listed_address "403/squid" "an unlisted Host on a listed address is refused"
  we_expect "allow-list, a" "$r" outside_dns_udp silent "an outside resolver on UDP 53 is unreachable"
  we_expect "allow-list, a" "$r" outside_dns_tcp closed "an outside resolver on TCP 53 is unreachable"
  we_expect "allow-list, a" "$r" outside_dot closed "DNS over TLS (853) is unreachable"
  we_expect "allow-list, a" "$r" doh_by_name 000 "DNS over HTTPS by name fails"
  we_expect "allow-list, a" "$r" doh_by_address 000 "DNS over HTTPS by address fails"
  we_expect "allow-list, a" "$r" private_vm closed "the VM stays unreachable"
  we_expect "allow-list, a" "$r" private_metadata closed "the metadata address stays unreachable"
  we_expect "allow-list, a" "$r" direct_proxy_ports "closed/closed/closed/silent" "the redirect targets cannot be used directly"
  we_expect "allow-list, a" "$r" direct_forward_proxy 000 "the proxy cannot be used as a forward proxy"
  we_expect "allow-list, a" "$r" gateway_other_ports closed "the gateway is closed on every other port probed"
  check_output "allow-list, a: UDP 443 (QUIC) to a listed address never leaves the VM" "0" we_quic_leaks

  # The peers stay apart in allow-list mode too.  b's listener answers the VM (control).
  sec_exec b student "mkdir -p /tmp/sectest-www && echo sectest-b > /tmp/sectest-www/index.html && \
    (setsid nohup python3 -m http.server 5173 --bind :: --directory /tmp/sectest-www >/tmp/sectest-www.log 2>&1 &) ; sleep 1" >/dev/null 2>&1
  check_output "allow-list: the VM reaches b's listener (control)" "sectest-b" \
    sec_ssh "curl -s --max-time 5 http://${we_b_ip}:5173/"
  check_output "allow-list, a: b's listener and agent ports are unreachable" "" \
    sec_exec a student "$(we_peer_probe)"

  # Squid looks up an intercepted Host itself.  Through Incus's resolver any
  # name would reach the internet, a channel out for data; the helper's table
  # sends Squid's lookups to our dnsmasq, which gives an unlisted name only to
  # the counter.  So the counter hears a fresh name the workspace never looked up.
  we_label="sectest-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n').example.com"
  # The second request is a forged Host: listed, but not at that address.
  sec_exec a student "gh=\$(getent ahostsv4 api.github.com | awk '{ print \$1; exit }'); \
    curl -s -o /dev/null --max-time 10 -H 'Host: ${we_label}' \"http://\${gh:-192.0.2.1}/\"; \
    curl -s -o /dev/null --max-time 10 -H 'Host: github.com' \"http://\${gh:-192.0.2.1}/\"" >/dev/null 2>&1
  check "the workspace proxy's lookup of an unlisted Host goes to the counter, not the internet" \
    we_counted_from "$we_label" dns

  r=$(we_run_docker)
  printf '%s\n' "$r" | sed 's/^/    /'
  we_expect "allow-list, a's Docker" "$r" listed_resolves yes "a listed name resolves"
  we_expect "allow-list, a's Docker" "$r" listed_https ok "a listed name is reached over HTTPS"
  we_expect "allow-list, a's Docker" "$r" unlisted_resolves no "an unlisted name gets no address"
  we_expect "allow-list, a's Docker" "$r" unlisted_address closed "a hard-coded unlisted address is dropped"
  we_expect "allow-list, a's Docker" "$r" unlisted_host_on_listed_address 403 "an unlisted Host on a listed address is refused"
  we_expect "allow-list, a's Docker" "$r" outside_dns silent "an outside resolver is unreachable"
  we_expect "allow-list, a's Docker" "$r" outside_dot closed "DNS over TLS is unreachable"
  we_expect "allow-list, a's Docker" "$r" direct_proxy_ports "closed/closed/closed" "the redirect targets cannot be used directly"
  # Docker Hub is listed, so a pull goes through the allow-list.
  check "allow-list, a's Docker: a listed registry serves a pull" \
    sec_exec a student "docker pull -q busybox:1.37"
  check_output "allow-list, a's Docker: b's listener and agent ports are unreachable" "" \
    sec_docker_exec a "for t in ${we_b_ip}:5173 ${we_b_ip}:7400; do nc -z -w 3 \${t%:*} \${t#*:} && echo \"\$t open\"; done; true"

  # The refused lookup and the refused TLS name both reach the site-wide
  # counts, which hold no workspace, user or address (ADR 0043).
  check "the refused name is counted from DNS and from Squid" we_counted example.com
  check_output "the blocked-name counts have no workspace, user or address column" "" \
    sec_psql "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name = 'egress_blocked_names' AND column_name NOT IN ('day', 'name', 'source', 'count')"
}

# After the restore, the site's own blocked sites apply; check what holds for any list.
we_check_open_blocked_restored() {
  local r
  check "open mode with the site's blocked sites: the egress DNS runs" sec_ssh "systemctl is-active --quiet portikus-egress-dns"
  sec_exec a root "resolvectl flush-caches" >/dev/null 2>&1
  r=$(we_run_bash)
  we_expect "restored, a" "$r" listed_https '!000' "an unblocked site is reached"
  we_expect "restored, a" "$r" outside_dns_udp silent "an outside resolver is unreachable"
  we_expect "restored, a" "$r" private_vm closed "the VM stays unreachable"
  we_expect "restored, a" "$r" direct_proxy_ports "closed/closed/closed/silent" "the redirect targets cannot be used directly"
}

# we_counted_from NAME SOURCE -- today's counts hold NAME from SOURCE, within a minute.
we_counted_from() {
  local i
  for ((i = 0; i < 60; i += 3)); do
    [ "$(sec_psql "SELECT count(*) FROM egress_blocked_names WHERE day = (now() AT TIME ZONE 'UTC')::date AND name = '$1' AND source = '$2'")" = "1" ] && return 0
    sleep 3
  done
  return 1
}

# we_counted NAME -- today's counts hold NAME from both sources, within a minute.
we_counted() {
  local i
  for ((i = 0; i < 60; i += 3)); do
    [ "$(sec_psql "SELECT count(DISTINCT source) FROM egress_blocked_names WHERE day = (now() AT TIME ZONE 'UTC')::date AND name = '$1'")" = "2" ] && return 0
    sleep 3
  done
  return 1
}

# ── The table survives the firewall ──────────────────────────────

# Restarting nftables reloads only the firewall's own tables; the helper's
# table, and so allow-list mode, stays in force.
we_check_nftables_restart() {
  local before after
  check "nftables' stop removes only the firewall's own tables" \
    sec_ssh "stop=\$(systemctl show nftables -p ExecStop --value); [[ \$stop == *'destroy table inet filter; destroy table inet nat'* && \$stop != *'flush ruleset'* ]]"
  check "the firewall's ruleset file never flushes the whole ruleset" \
    sec_ssh "! grep -v '^[[:space:]]*#' /etc/nftables.conf | grep -q 'flush ruleset'"
  before=$(sec_ssh "sudo nft list table inet portikus_egress | grep -c redirect")
  sec_ssh "sudo systemctl restart nftables" >/dev/null 2>&1
  after=$(sec_ssh "sudo nft list table inet portikus_egress | grep -c redirect")
  if [ -n "$before" ] && [ "$before" -gt 0 ] && [ "$after" = "$before" ]; then
    ok "restarting nftables keeps the egress table's ${after} redirect rule(s)"
  else
    bad "restarting nftables keeps the egress table's redirect rules (before ${before:-none}, after ${after:-none})"
  fi
}

# ── Reboots (PORTIKUS_SECURITY_HEAVY=1) ──────────────────────────

# Reboots the VM, waits for the platform, and puts back what the run keeps
# in the VM's /tmp, which a reboot empties; then holds both workspaces again.
we_reboot() {
  local i key
  echo "Rebooting the VM..."
  sec_ssh "sudo systemctl reboot" >/dev/null 2>&1 || true
  sleep 15
  for ((i = 0; i < 300; i += 5)); do
    sec_ssh "systemctl is-active --quiet portikus-api portikus-worker portikus-controller" >/dev/null 2>&1 && break
    sleep 5
  done
  sec_ssh "install -d -m 0700 ${SEC_REMOTE_DIR}"
  for key in a b admin; do
    printf 'Cookie: %s\n' "$(cat "${SEC_LOCAL_DIR}/${key}.cookie")" \
      | sec_ssh_stdin "umask 077; cat > ${SEC_REMOTE_DIR}/${key}.cookie"
  done
  sec_hold_presence a && sec_hold_presence b
}

# we_forwarding CMD-CONTEXT -- "open" when a reaches anything outside, "dropped" otherwise.
we_forwarding() {
  sec_exec a student 'for u in https://1.1.1.1/ https://api.github.com/; do
    [ "$(curl -sk -o /dev/null -w "%{http_code}" --max-time 8 "$u")" != 000 ] && { echo open; exit; }
  done; echo dropped' 2>/dev/null
}

we_check_reboots() {
  local r i
  # A request left pending across the reboot is applied by the boot run.  If
  # that run waited for our DNS, which starts after Incus, which waits for
  # the helper, it would hang until its start timeout.
  echo "Leaving an egress request pending, then rebooting..."
  sec_ssh "sudo systemctl stop portikus-egress-apply.path"
  printf '%s\n' 'import json' \
    'a = json.load(open("/var/lib/portikus/egress-state/applied.json"))' \
    'json.dump({"requestId": "sectest-boot", **a["policy"]}, open("/var/lib/portikus/egress-request/request.json", "w"))' \
    | sec_ssh_stdin "sudo python3 -"
  we_reboot || { bad "the workspaces run again after a reboot in allow-list mode"; return; }
  for ((i = 0; i < 60; i += 3)); do
    sec_ssh "systemctl is-active --quiet portikus-egress-dns" >/dev/null 2>&1 && break
    sleep 3
  done
  check "after a reboot, the egress helper's boot run succeeded" \
    sec_ssh "[ \"\$(systemctl show portikus-egress-apply.service -p Result --value)\" = success ]"
  check_output "after a reboot, the boot run applied the pending request" '"requestId":"sectest-boot"' \
    sec_ssh "grep -o '\"requestId\":\"sectest-boot\"' /var/lib/portikus/egress-state/status.json"
  check "after a reboot, no request is left pending" \
    sec_ssh "! test -e /var/lib/portikus/egress-request/request.json"
  check "after a reboot, the egress DNS runs" sec_ssh "systemctl is-active --quiet portikus-egress-dns"
  sec_exec a root "resolvectl flush-caches" >/dev/null 2>&1
  r=$(we_run_bash)
  we_expect "allow-list after a reboot, a" "$r" listed_https '!000' "a listed name is reached"
  we_expect "allow-list after a reboot, a" "$r" unlisted_resolves no "an unlisted name gets no address"
  we_expect "allow-list after a reboot, a" "$r" unlisted_address 000 "a hard-coded unlisted address is dropped"
  we_expect "allow-list after a reboot, a" "$r" unlisted_sni_on_listed_address 000 "an unlisted TLS name on a listed address is refused"

  # The helper cannot trust settings others could write, so at boot it
  # applies nothing from them and drops workspace forwarding instead.
  echo "Making /etc/portikus/egress.env group-writable, then rebooting..."
  sec_ssh "sudo chmod 0664 /etc/portikus/egress.env"
  we_reboot
  check_output "with unusable settings after a reboot, workspace forwarding is dropped, not open" "dropped" we_forwarding
  sec_ssh "sudo chmod 0644 /etc/portikus/egress.env"

  # If the helper itself cannot run (a crash, a failed import, the memory
  # cap), its Node-free guard loads the drop-all table.
  echo "Making the egress helper fail at once, then rebooting..."
  sec_ssh "sudo install -d /etc/systemd/system/portikus-egress-apply.service.d && \
    printf '[Service]\nExecStart=\nExecStart=/bin/false\n' | sudo tee /etc/systemd/system/portikus-egress-apply.service.d/sectest-broken.conf >/dev/null && \
    sudo systemctl daemon-reload"
  we_reboot
  check_output "with the helper failing at boot, workspace forwarding is dropped, not open" "dropped" we_forwarding
  check "with the helper failing at boot, the guard loaded the drop-all table" \
    sec_ssh "sudo nft list chain inet portikus_egress forward | grep -q 'iifname \"portikus-ws\" drop'"
  sec_ssh "sudo rm -f /etc/systemd/system/portikus-egress-apply.service.d/sectest-broken.conf; \
    sudo rmdir --ignore-fail-on-non-empty /etc/systemd/system/portikus-egress-apply.service.d; \
    sudo systemctl daemon-reload"
}

# ── Logs ─────────────────────────────────────────────────────────

# No Squid log and no egress DNS log holds a workspace address (ADR 0043);
# only names leave the workspace proxy, to the counter.
we_cache_log_lines() { sec_ssh "sudo cat /var/log/portikus-workspace-proxy/cache.log 2>/dev/null | wc -l"; }
we_cache_log_start=$(we_cache_log_lines)

we_check_logs() {
  local hits
  # A reload in open mode makes Squid write its empty-list warnings, so the
  # search below runs on a log Squid really writes, after the run's refusals
  # and a forged Host, which Squid reports with the client's address at a
  # level this log does not keep.
  sec_ssh "sudo systemctl reload portikus-workspace-proxy" >/dev/null 2>&1
  sleep 2
  if [ "$(sec_psql "SELECT egress_mode FROM settings WHERE id = 1")" = "open" ]; then
    check "Squid wrote to its cache.log during the run" \
      test "$(we_cache_log_lines)" -gt "${we_cache_log_start:-0}"
  else
    sec_na "Squid wrote to its cache.log during the run" "in allow-list mode a reload writes nothing"
  fi
  hits=$(sec_ssh "sudo grep -rlF '${we_a_ip}' /var/log/portikus-workspace-proxy/ /var/log/squid/ 2>/dev/null; \
    sudo journalctl -q --no-pager --since '${we_since}' -u portikus-workspace-proxy -u portikus-egress-dns -u squid | grep -cF '${we_a_ip}'; true")
  check_output "no Squid or egress DNS log holds a's address" "0" echo "$hits"
  check_output "the workspace proxy writes no access log file" "cache.log" \
    sec_ssh "sudo ls /var/log/portikus-workspace-proxy/ | paste -sd' '"
}

# ── Switching, through the admin API ─────────────────────────────

we_version() { sec_psql "SELECT egress_version FROM settings WHERE id = 1"; }

# we_put PATH JSON -- one policy write at the current version.
we_put() {
  local status
  status=$(sec_http admin PUT "$1" -H 'Content-Type: application/json' \
    --data "$(printf '%s' "$2" | sed "s/@VERSION@/$(we_version)/")")
  [ "$status" = "200" ]
}

# Waits until the worker has applied the current version.
we_wait_applied() {
  local i
  for ((i = 0; i < 90; i += 2)); do
    [ "$(sec_psql "SELECT (coalesce(egress_applied_version, 0) = egress_version)::text FROM settings WHERE id = 1")" = "true" ] && return 0
    sleep 2
  done
  return 1
}

we_presets_json() { # comma-separated ids to a JSON array
  local out="" id
  for id in ${1//,/ }; do out="${out}${out:+,}\"${id}\""; done
  printf '[%s]' "$out"
}

# we_send METHOD PATH [JSON] -- one policy write at the current version.
we_send() {
  local status
  if [ -n "${3:-}" ]; then
    status=$(sec_http admin "$1" "$2" -H 'Content-Type: application/json' \
      --data "$(printf '%s' "$3" | sed "s/@VERSION@/$(we_version)/")")
  else
    status=$(sec_http admin "$1" "${2//@VERSION@/$(we_version)}")
  fi
  [ "$status" = "200" ]
}

# The blocked sites as they were, one JSON request body per line.
we_start_blocked=$(sec_psql "SELECT '{\"version\":@VERSION@,\"value\":' || to_json(value) || ',\"label\":' || to_json(label) || '}' FROM egress_blocked_entries ORDER BY value")

we_clear_blocked() {
  local id
  for id in $(sec_psql "SELECT id FROM egress_blocked_entries"); do
    we_send DELETE "/admin/egress/blocked-sites/${id}?version=@VERSION@" || return 1
  done
}

# we_set_blocked NAME... -- replaces the blocked sites with NAMEs.
we_set_blocked() {
  local name
  we_clear_blocked || return 1
  for name in "$@"; do
    we_send POST /admin/egress/blocked-sites "{\"version\":@VERSION@,\"value\":\"${name}\",\"label\":\"security test\"}" || return 1
  done
}

we_restore() {
  local body
  echo "Restoring the egress policy: ${we_start_mode}, presets ${we_start_presets:-none}, and the blocked sites"
  we_put /admin/egress/mode "{\"version\":@VERSION@,\"mode\":\"${we_start_mode}\"}" || true
  we_put /admin/egress/presets "{\"version\":@VERSION@,\"presets\":$(we_presets_json "$we_start_presets")}" || true
  we_clear_blocked || true
  while IFS= read -r body; do
    [ -n "$body" ] && { we_send POST /admin/egress/blocked-sites "$body" || true; }
  done <<<"$we_start_blocked"
  if we_wait_applied; then ok "the egress policy is back as it was"; else bad "the egress policy is back as it was (not applied)"; fi
  check_output "the blocked sites are exactly as they were" "$we_start_blocked" \
    sec_psql "SELECT '{\"version\":@VERSION@,\"value\":' || to_json(value) || ',\"label\":' || to_json(label) || '}' FROM egress_blocked_entries ORDER BY value"
  # A VM that had never applied a policy now has one applied: the same open
  # mode, which the helper loads as the empty table a fresh site runs with.
}

# The applied policy blocks sites in open mode when Squid's switch is on.
we_blocks_applied() { sec_ssh "test -s /var/lib/portikus/egress-state/open.txt"; }

we_others=$(sec_psql "SELECT count(*) FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}'")
sec_docker_exec a "true" >/dev/null 2>&1

if [ "$we_start_mode" = "open" ] && [ "$we_others" != "0" ]; then
  # Another site's policy is left alone: checked as it is.
  if we_blocks_applied; then
    sec_na "workspace egress in open mode with no blocked site" "the site blocks sites; its list is left alone"
  else
    we_check_open
  fi
  sec_na "workspace egress with the run's blocked sites and in allow-list mode" \
    "changing the policy would change ${we_others} other workspace(s)' network; run on a VM with none"
elif [ "$we_start_mode" = "open" ]; then
  # Open mode with no blocked site is exactly the open mode before blocked sites existed.
  if ! we_clear_blocked || ! we_wait_applied; then
    bad "the administrator empties the blocked sites through the API, and it is applied"
  else
    we_check_open
  fi
  if we_hold_connection; then
    check_output "open mode: a's long-lived connection to example.com is tracked (control)" "1" we_held_tracked
  else
    bad "open mode: a opens a long-lived connection to example.com"
  fi
  if ! we_set_blocked "${WE_BLOCKED[@]}" || ! we_wait_applied; then
    bad "the administrator blocks sites through the API, and it is applied ($(sec_psql "SELECT coalesce(egress_apply_error, 'no error') FROM settings WHERE id = 1"))"
  else
    ok "the administrator blocks sites through the API, and it is applied"
    [ -n "$we_held_ip" ] && check_output "the connection opened before the block is forgotten" "0" we_held_tracked
    we_check_open_blocked
    # The blocked checks are long; renew presence so a and b outlast the allow-list checks.
    sec_hold_presence a && sec_hold_presence b
  fi
  we_release_connection
  if ! we_clear_blocked; then
    bad "the administrator empties the blocked sites before allow-list mode"
    we_restore
  elif ! we_put /admin/egress/presets '{"version":@VERSION@,"presets":["github","docker-hub"]}' \
    || ! we_put /admin/egress/mode '{"version":@VERSION@,"mode":"allow-list"}'; then
    bad "the administrator switches to allow-list mode through the API"
    we_restore
  elif ! we_wait_applied; then
    bad "the allow-list policy is applied within 90 s ($(sec_psql "SELECT coalesce(egress_apply_error, 'no error') FROM settings WHERE id = 1"))"
    we_restore
  else
    ok "the administrator switches to allow-list mode through the API, and it is applied"
    we_check_allow_list
    we_check_nftables_restart
    if [ "$SEC_HEAVY" = "1" ]; then
      we_check_reboots
    else
      sec_na "allow-list mode after a reboot" "set PORTIKUS_SECURITY_HEAVY=1 to reboot the VM"
    fi
    we_restore
    if we_blocks_applied; then we_check_open_blocked_restored; else we_check_open; fi
  fi
else
  # A site already in allow-list mode is checked as it is, when its own list
  # has the names the checks use.
  sec_na "workspace egress in open mode" "the site is in allow-list mode; its policy is left alone"
  if sec_ssh "grep -qx '.github.com' /var/lib/portikus/egress-state/names.txt && grep -qx '.docker.io' /var/lib/portikus/egress-state/names.txt"; then
    we_check_allow_list
  else
    sec_na "workspace egress in allow-list mode" "the site's list lacks GitHub or Docker Hub, which the checks use"
  fi
fi
we_check_logs
# This section takes several minutes; renew presence so the shutdown grace
# period cannot stop a or b during the sections after it.
sec_hold_presence a && sec_hold_presence b
