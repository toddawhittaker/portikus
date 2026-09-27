#!/usr/bin/env bash
# Workspace egress in open and allow-list mode (issue #284, ADR 0038).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# Both modes keep the redirect targets on the bridge gateway closed to direct
# use.  Allow-list mode is switched on through the admin API, as an
# administrator would, and switched back at the end; because that cuts every
# workspace off for a minute, it runs only when the run's own workspaces are
# the only ones on the VM.  Its checks follow "Security invariants to test"
# for egress, from the workspace and from a Docker container inside it.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Workspace egress ---"

we_gateway=$(sec_ssh "incus network get portikus-ws ipv4.address" | cut -d/ -f1)
we_a_ip=$(sec_ws_ip a)
we_since=$(sec_ssh "date -u '+%Y-%m-%d %H:%M:%S'")
we_policy=$(sec_psql "SELECT egress_mode || ' ' || array_to_string(egress_presets, ',') FROM settings WHERE id = 1")
we_start_mode=${we_policy%% *}
we_start_presets=${we_policy#* }
[ "$we_start_presets" = "$we_policy" ] && we_start_presets=""
echo "Gateway ${we_gateway}, workspace a ${we_a_ip}, policy: ${we_start_mode} (presets: ${we_start_presets:-none})"
if [ -z "$we_gateway" ] || [ -z "$we_a_ip" ] || [ -z "$we_start_mode" ]; then
  sec_fail "workspace egress setup: the gateway, a's address and the policy are known"
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
    if [ -n "$got" ] && [ "$got" != "${wanted#!}" ]; then sec_pass "${context}: ${label}"; else sec_fail "${context}: ${label} (got: ${got:-nothing})"; fi
  elif [ "$got" = "$wanted" ]; then
    sec_pass "${context}: ${label}"
  else
    sec_fail "${context}: ${label} (got: ${got:-nothing})"
  fi
}

we_run_bash() { sec_exec a student "$(we_probe_bash)" 2>/dev/null; }
we_run_docker() { sec_docker_exec a "$(we_probe_docker)" 2>/dev/null; }

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

  # The refused lookup and the refused TLS name both reach the site-wide
  # counts, which hold no workspace, user or address (ruling 13).
  check "the refused name is counted from DNS and from Squid" we_counted example.com
  check_output "the blocked-name counts have no workspace, user or address column" "" \
    sec_psql "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name = 'egress_blocked_names' AND column_name NOT IN ('day', 'name', 'source', 'count')"
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

# ── Logs ─────────────────────────────────────────────────────────

# No log of the workspace proxy or the egress DNS holds a workspace address
# (ruling 13); only names leave Squid, to the counter.
we_check_logs() {
  local hits
  hits=$(sec_ssh "sudo grep -rlF '${we_a_ip}' /var/log/portikus-workspace-proxy/ 2>/dev/null; \
    sudo journalctl -q --no-pager --since '${we_since}' -u portikus-workspace-proxy -u portikus-egress-dns | grep -cF '${we_a_ip}'; true")
  check_output "no workspace proxy or egress DNS log holds a's address" "0" echo "$hits"
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
    [ "$(sec_psql "SELECT (egress_applied_version = egress_version)::text FROM settings WHERE id = 1")" = "true" ] && return 0
    sleep 2
  done
  return 1
}

we_presets_json() { # comma-separated ids to a JSON array
  local out="" id
  for id in ${1//,/ }; do out="${out}${out:+,}\"${id}\""; done
  printf '[%s]' "$out"
}

we_restore() {
  echo "Restoring the egress policy: ${we_start_mode}, presets ${we_start_presets:-none}"
  we_put /admin/egress/mode "{\"version\":@VERSION@,\"mode\":\"${we_start_mode}\"}" || true
  we_put /admin/egress/presets "{\"version\":@VERSION@,\"presets\":$(we_presets_json "$we_start_presets")}" || true
  if we_wait_applied; then sec_pass "the egress policy is back as it was"; else sec_fail "the egress policy is back as it was (not applied)"; fi
}

we_others=$(sec_psql "SELECT count(*) FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}'")
sec_docker_exec a "true" >/dev/null 2>&1

if [ "$we_start_mode" = "open" ]; then
  we_check_open
  if [ "$we_others" != "0" ]; then
    sec_na "workspace egress in allow-list mode" \
      "switching would cut off ${we_others} other workspace(s); run on a VM with none"
  elif ! we_put /admin/egress/presets '{"version":@VERSION@,"presets":["github","docker-hub"]}' \
    || ! we_put /admin/egress/mode '{"version":@VERSION@,"mode":"allow-list"}'; then
    sec_fail "the administrator switches to allow-list mode through the API"
    we_restore
  elif ! we_wait_applied; then
    sec_fail "the allow-list policy is applied within 90 s ($(sec_psql "SELECT coalesce(egress_apply_error, 'no error') FROM settings WHERE id = 1"))"
    we_restore
  else
    sec_pass "the administrator switches to allow-list mode through the API, and it is applied"
    we_check_allow_list
    we_restore
    we_check_open
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
