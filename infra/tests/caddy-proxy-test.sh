#!/usr/bin/env bash
# Tests Portikus behind a reverse proxy such as a Cloudflare Tunnel
# (docs/SPEC.md sections 24.10, 24.11 and 24.13).
#
# Renders infra/ansible/roles/caddy/templates/Caddyfile.j2 three ways (no
# trusted proxy, loopback trusted, a trusted range loopback is not in) and
# runs each on loopback in front of a stand-in API and a stand-in student
# application, which echo the forwarded headers they were sent.  It checks
# the address the API sees, that a forged X-Forwarded-For is never
# believed, that a WebSocket keeps the real address, and the preview's
# Cache-Control.  It also renders the host firewall with and without a
# trusted proxy.  Needs no VM; the live part needs a caddy binary (on PATH,
# or named by CADDY).
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

caddy_bin="${CADDY:-$(command -v caddy || true)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="${REPO_ROOT}/infra/ansible/roles/caddy/templates/Caddyfile.j2"
PUBLIC_HOST="portikus.192.0.2.10.nip.io"
PREVIEW_SUFFIX="preview.${PUBLIC_HOST}"
# The address the stand-in proxy claims for its client, and the one a client forges.
REAL=203.0.113.7
FORGED=198.51.100.9

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

command -v ansible >/dev/null || {
  echo "error: ansible is needed to render the templates (docs/WORKFLOW.md)" >&2
  exit 1
}

work="$(mktemp -d)"
caddy_pid=""
stubs_pid=""
trap 'kill ${caddy_pid} ${stubs_pid} 2>/dev/null; rm -rf "${work}"' EXIT

mkdir -p "${work}/certificate"
cat >"${work}/certificate/tls.caddy" <<'EOF'
(portikus_tls_global) {
}
(portikus_tls_site) {
	tls internal
}
(portikus_tls_preview) {
	tls internal
}
EOF

# render DEST PUBLIC_PORT API_PORT TRUSTED_JSON
render() {
  ansible localhost -c local -m ansible.builtin.template \
    -a "src=${TEMPLATE} dest=${1} mode=0644" \
    -e "portikus_public_host=${PUBLIC_HOST}" \
    -e "portikus_preview_suffix=${PREVIEW_SUFFIX}" \
    -e "portikus_public_port=${2}" \
    -e "portikus_api_port=${3}" \
    -e "caddy_admin_socket=/var/lib/caddy/admin.sock" \
    -e "dex_port=5556" \
    -e "caddy_certificate_dir=${work}/certificate" \
    -e "caddy_challenge_port=8796" \
    -e "{\"portikus_trusted_proxies\": ${4}}" >"${work}/render.log" 2>&1 || {
    echo "error: rendering ${TEMPLATE} failed" >&2
    cat "${work}/render.log" >&2
    exit 1
  }
}

echo "--- The proxy settings render only when a proxy is trusted ---"

render "${work}/off" 8443 3000 '[]'
render "${work}/on" 8443 3000 '["192.0.2.0/24", "2001:db8::/32"]'
if grep -qE 'trusted_proxies|client_ip_headers' "${work}/off"; then
  bad "with no trusted proxy, Caddy trusts no client address header"
else
  ok "with no trusted proxy, Caddy trusts no client address header"
fi
check "a trusted proxy's ranges are listed" \
  grep -qE '^[[:space:]]+trusted_proxies static 192\.0\.2\.0/24 2001:db8::/32$' "${work}/on"
check "only CF-Connecting-IP is read for the client address" \
  grep -qE '^[[:space:]]+client_ip_headers CF-Connecting-IP$' "${work}/on"
# Every proxy but the ACME challenge's sends the client address and drops
# the proxy's header.  The two student application proxies share one import.
proxies="$(grep -cE '^[[:space:]]*(reverse_proxy|forward_auth) ' "${work}/on")"
imports="$(grep -c 'import portikus_client_address' "${work}/on")"
expect_eq "every proxy but the challenge's sends only the client address" "$((proxies - 2))" "${imports}"

echo ""
echo "--- The host firewall exempts only a trusted proxy from the per-source cap ---"

# firewall TRUSTED_JSON — the rendered firewall's rules for the web ports.
firewall() {
  cat >"${work}/firewall.yml" <<EOF
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    site_vars: "{{ (lookup('ansible.builtin.file', '${REPO_ROOT}/infra/ansible/site.yml') | from_yaml)[0].vars }}"
    workspace_egress_http_port: "{{ site_vars.workspace_egress_http_port }}"
    workspace_egress_https_port: "{{ site_vars.workspace_egress_https_port }}"
    workspace_egress_dns_port: "{{ site_vars.workspace_egress_dns_port }}"
    workspace_egress_denied_ranges: "{{ site_vars.workspace_egress_denied_ranges }}"
    portikus_outbound_proxy_url: "{{ site_vars.portikus_outbound_proxy_url }}"
    portikus_preview_port_min: 1024
    portikus_preview_port_max: 65535
    incus_network_name: "{{ site_vars.incus_network_name }}"
    incus_network_cidr: "{{ site_vars.incus_network_cidr }}"
    portikus_controller_port: "{{ site_vars.portikus_controller_port }}"
    caddy_challenge_port: "{{ site_vars.caddy_challenge_port }}"
    registry_cache_hub_port: "{{ site_vars.registry_cache_hub_port }}"
    registry_cache_ghcr_port: "{{ site_vars.registry_cache_ghcr_port }}"
    registry_cache_connections_per_source: "{{ site_vars.registry_cache_connections_per_source }}"
    management_cidr: 10.100.0.0/24
    portikus_agent_port: 7400
    portikus_public_port: 8443
    ansible_default_ipv4: {interface: enp1s0}
    firewall_ssh_ports: [22]
    portikus_trusted_proxies: ${1}
  tasks:
    - ansible.builtin.copy:
        dest: ${work}/nft
        content: "{{ lookup('ansible.builtin.template', '${REPO_ROOT}/infra/ansible/roles/firewall/templates/nftables.conf.j2') }}"
        mode: "0644"
EOF
  ansible-playbook "${work}/firewall.yml" >"${work}/firewall.log" 2>&1 || {
    echo "error: rendering the firewall failed" >&2
    cat "${work}/firewall.log" >&2
    return 1
  }
  grep -E 'tcp dport \{ 80, 8443 \}' "${work}/nft" | grep -v iifname | sed 's/^[[:space:]]*//'
}

expect_eq "with no trusted proxy, every source is capped as before" \
  "tcp dport { 80, 8443 } ct state new add @web_conns4 { ip saddr ct count over 8192 } reject with tcp reset
tcp dport { 80, 8443 } ct state new add @web_conns6 { ip6 saddr & ffff:ffff:ffff:ffff:: ct count over 8192 } reject with tcp reset
tcp dport { 80, 8443 } accept" "$(firewall '[]')"
expect_eq "a trusted proxy is accepted before the cap, by address family" \
  "tcp dport { 80, 8443 } ip saddr { 192.0.2.0/24, 10.20.30.1/32 } accept
tcp dport { 80, 8443 } ip6 saddr { 2001:db8::/32 } accept
tcp dport { 80, 8443 } ct state new add @web_conns4 { ip saddr ct count over 8192 } reject with tcp reset
tcp dport { 80, 8443 } ct state new add @web_conns6 { ip6 saddr & ffff:ffff:ffff:ffff:: ct count over 8192 } reject with tcp reset
tcp dport { 80, 8443 } accept" "$(firewall '["192.0.2.0/24", "2001:db8::/32", "10.20.30.1/32"]')"
expect_eq "an IPv4-only list adds no IPv6 rule" \
  "tcp dport { 80, 8443 } ip saddr { 127.0.0.1/32 } accept" \
  "$(firewall '["127.0.0.1/32"]' | grep saddr | grep -v 'ct count')"

echo ""
echo "--- site.yml refuses a trusted list that would trust everyone ---"

# site.yml's own check, copied out as a task file once.
cat >"${work}/extract.yml" <<EOF
- hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - ansible.builtin.copy:
        dest: ${work}/trusted-check.yml
        content: "{{ [(lookup('ansible.builtin.file', '${REPO_ROOT}/infra/ansible/site.yml') | from_yaml)[0].pre_tasks
                      | selectattr('name', 'defined') | selectattr('name', 'search', 'trusted proxies') | first] | to_nice_yaml }}"
        mode: "0644"
EOF
ansible-playbook "${work}/extract.yml" >"${work}/extract.log" 2>&1 || { cat "${work}/extract.log" >&2; exit 1; }

# accepts TRUSTED_JSON — whether site.yml's trusted proxies check passes.
accepts() {
  cat >"${work}/accepts.yml" <<EOF
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    portikus_trusted_proxies: ${1}
  tasks:
    - ansible.builtin.include_tasks: ${work}/trusted-check.yml
EOF
  ansible-playbook "${work}/accepts.yml" >"${work}/accepts.log" 2>&1 && echo yes || echo no
}
expect_eq "a /32 and a /64 are accepted" yes "$(accepts '["10.20.20.10/32", "2001:db8::/64"]')"
expect_eq "an empty list is accepted" yes "$(accepts '[]')"
expect_eq "0.0.0.0/0 is refused" no "$(accepts '["10.20.20.10/32", "0.0.0.0/0"]')"
expect_eq "::/0 is refused" no "$(accepts '["::/0"]')"
expect_eq "a bare address is refused" no "$(accepts '["10.20.20.10"]')"

if [ -z "${caddy_bin}" ]; then
  echo ""
  echo "SKIP  the live proxy checks: no caddy binary (set CADDY to one)"
  echo ""
  echo "${pass} passed, ${fail} failed"
  [ "${fail}" = 0 ]
  exit
fi

# The stand-in API echoes the forwarded headers it was sent, on any path and
# over a WebSocket, and authorizes every preview to the stand-in
# application.  The application echoes the same headers and sends the
# Cache-Control its path names.
cat >"${work}/stubs.py" <<'PY'
import base64, hashlib, http.server, sys, threading

api_port, app_port = sys.argv[1:3]
CACHE = {"/cc/public": "public, max-age=60", "/cc/Public": "Public", "/cc/nostore": "no-store",
         "/cc/private": "private, max-age=5", "/cc/vite": "max-age=31536000,immutable",
         "/cc/shared": "public, s-maxage=600, max-age=60", "/cc/onlyshared": "s-maxage=600",
         "/cc/fields": 'private="Set-Cookie", max-age=5', "/me/cached": "max-age=5"}
# Cache directions meant for a CDN, which no preview response may carry.
CDN = ("CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control")

def seen(h):
    return "xff=%s cf=%s xfh=%s xfp=%s" % (h.get("X-Forwarded-For"), h.get("CF-Connecting-IP"),
                                           h.get("X-Forwarded-Host"), h.get("X-Forwarded-Proto"))

def handler(name):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_GET(self):
            if self.headers.get("Upgrade", "").lower() == "websocket":
                return self.websocket()
            if name == "api" and self.path.startswith("/preview/authorize"):
                with open(sys.argv[3], "w") as f:
                    f.write(seen(self.headers))
                self.send_response(200)
                self.send_header("X-Portikus-Upstream", "127.0.0.1:" + app_port)
                self.send_header("Content-Length", "0"); self.end_headers(); return
            body = ("%s %s" % (name, seen(self.headers))).encode()
            self.send_response(200)
            if self.path in CACHE:
                self.send_header("Cache-Control", CACHE[self.path])
            if self.path == "/cc/cdn":
                for h in CDN:
                    self.send_header(h, "max-age=600")
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
        def websocket(self):
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] +
                "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept); self.end_headers()
            reply = ("%s %s" % (name, seen(self.headers))).encode()
            self.wfile.write(bytes([0x81, len(reply)]) + reply); self.wfile.flush()
            self.close_connection = True
        def log_message(self, *a): pass
    return H

api = http.server.ThreadingHTTPServer(("127.0.0.1", int(api_port)), handler("api"))
app = http.server.ThreadingHTTPServer(("127.0.0.1", int(app_port)), handler("app"))
threading.Thread(target=app.serve_forever, daemon=True).start()
api.serve_forever()
PY

# ws.py HOST PORT PATH [HEADER...] — upgrade through Caddy, print the first frame's text.
cat >"${work}/ws.py" <<'PY'
import socket, ssl, sys
host, port, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
extra = "".join(h + "\r\n" for h in sys.argv[4:])
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", port), timeout=5), server_hostname=host)
s.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n%s\r\n"
           % (path, host, port, extra)).encode())
head = b""
while b"\r\n\r\n" not in head:
    chunk = s.recv(1)
    if not chunk: sys.exit("closed before the upgrade answer")
    head += chunk
if not head.startswith(b"HTTP/1.1 101"): sys.exit(head.split(b"\r\n")[0].decode())
frame = s.recv(2); print(s.recv(frame[1] & 0x7F).decode())
PY

read -r public http api_port app_port < <(python3 -c '
import socket
held = [socket.socket() for _ in range(4)]
for s in held:
    s.bind(("127.0.0.1", 0))
print(*(s.getsockname()[1] for s in held))')
python3 "${work}/stubs.py" "${api_port}" "${app_port}" "${work}/authorize-seen" >"${work}/stubs.log" 2>&1 &
stubs_pid=$!

# start TRUSTED_JSON — a live Caddy on loopback with that trusted list.
start() {
  [ -n "${caddy_pid}" ] && { kill "${caddy_pid}" 2>/dev/null; wait "${caddy_pid}" 2>/dev/null; }
  render "${work}/Caddyfile.live" "${public}" "${api_port}" "$1"
  awk -v data="${work}/caddy-data" -v port="${http}" '
    /^[[:space:]]*admin unix\// {
      printf "\tadmin off\n\tskip_install_trust\n\tstorage file_system %s\n\thttp_port %s\n", data, port
      next
    }
    { print }
  ' "${work}/Caddyfile.live" >"${work}/Caddyfile.run"
  "${caddy_bin}" run --adapter caddyfile --config "${work}/Caddyfile.run" >"${work}/caddy.log" 2>&1 &
  caddy_pid=$!
  for _ in $(seq 50); do
    [ "$(app /health -o /dev/null -w '%{http_code}')" = 200 ] && return
    sleep 0.2
  done
  echo "error: the test Caddy did not start" >&2
  cat "${work}/caddy.log" >&2
  exit 1
}

# app PATH [CURL ARGS...] and preview PATH [CURL ARGS...] — a request to that host.
app() {
  local p="$1"; shift
  curl -sk --max-time 5 --resolve "${PUBLIC_HOST}:${public}:127.0.0.1" "$@" "https://${PUBLIC_HOST}:${public}${p}"
}
preview() {
  local h="web-5173.${PREVIEW_SUFFIX}" p="$1"; shift
  curl -sk --max-time 5 --resolve "${h}:${public}:127.0.0.1" "$@" "https://${h}:${public}${p}"
}
# xff TEXT — the X-Forwarded-For a stand-in reported.
xff() { sed -E 's/.*xff=([^ ]*).*/\1/' <<<"$1"; }

forged=(-H "CF-Connecting-IP: ${REAL}" -H "X-Forwarded-For: ${FORGED}" -H "X-Forwarded-Host: evil.example" -H "X-Forwarded-Proto: http")

# A client's own headers are never believed, whatever the list says.
for mode in off untrusted trusted; do
  case "${mode}" in
    off) start '[]'; want=127.0.0.1 ;;
    untrusted) start '["192.0.2.0/24"]'; want=127.0.0.1 ;;
    trusted) start '["127.0.0.1/32"]'; want="${REAL}" ;;
  esac
  echo ""
  echo "--- Live: ${mode} (the API should see ${want}) ---"

  out="$(app /health "${forged[@]}")"
  expect_eq "${mode}: the API sees the one client address" "${want}" "$(xff "${out}")"
  case "${out}" in
    *"cf=None"*) ok "${mode}: CF-Connecting-IP does not reach the API" ;;
    *) bad "${mode}: CF-Connecting-IP does not reach the API (${out})" ;;
  esac
  case "${out}" in
    *"xfh=${PUBLIC_HOST}:${public} xfp=https"*) ok "${mode}: a forged X-Forwarded-Host and -Proto are replaced" ;;
    *) bad "${mode}: a forged X-Forwarded-Host and -Proto are replaced (${out})" ;;
  esac
  expect_eq "${mode}: a request without the header is the peer's" "127.0.0.1" "$(xff "$(app /health -H "X-Forwarded-For: ${FORGED}")")"

  out="$(python3 "${work}/ws.py" "${PUBLIC_HOST}" "${public}" /workspaces/w1/ws \
    "CF-Connecting-IP: ${REAL}" "X-Forwarded-For: ${FORGED}" 2>&1)"
  expect_eq "${mode}: a WebSocket upgrade keeps the client address" "${want}" "$(xff "${out}")"

  rm -f "${work}/authorize-seen"
  out="$(preview /plain "${forged[@]}")"
  expect_eq "${mode}: the student application sees the one client address" "${want}" "$(xff "${out}")"
  case "${out}" in
    *"cf=None"*) ok "${mode}: CF-Connecting-IP does not reach the student application" ;;
    *) bad "${mode}: CF-Connecting-IP does not reach the student application (${out})" ;;
  esac
  expect_eq "${mode}: the preview authorization sees the one client address" "${want}" \
    "$(xff "$(cat "${work}/authorize-seen" 2>/dev/null)")"
  out="$(python3 "${work}/ws.py" "web-5173.${PREVIEW_SUFFIX}" "${public}" /socket \
    "CF-Connecting-IP: ${REAL}" "X-Forwarded-For: ${FORGED}" 2>&1)"
  expect_eq "${mode}: a preview WebSocket keeps the client address" "${want}" "$(xff "${out}")"
done

echo ""
echo "--- Live: preview responses are cacheable only by the browser ---"

# cc PATH — the Cache-Control a preview response arrived with.
cc() { preview "$1" -D - -o /dev/null | tr -d '\r' | sed -n 's/^cache-control: //Ip'; }
expect_eq "no Cache-Control from the application becomes private" "private" "$(cc /plain)"
expect_eq "public becomes private, the rest kept" "private, max-age=60" "$(cc /cc/public)"
expect_eq "public in any case becomes private" "private" "$(cc /cc/Public)"
expect_eq "no-store is kept, private added" "private, no-store" "$(cc /cc/nostore)"
expect_eq "private is kept" "private, max-age=5" "$(cc /cc/private)"
expect_eq "a Vite asset is cached by the browser alone" "private, max-age=31536000, immutable" "$(cc /cc/vite)"
expect_eq "s-maxage is dropped" "private, max-age=60" "$(cc /cc/shared)"
expect_eq "s-maxage alone leaves private" "private" "$(cc /cc/onlyshared)"
expect_eq "private naming fields becomes plain private" "private, max-age=5" "$(cc /cc/fields)"
cdn="$(preview /cc/cdn -D - -o /dev/null | tr -d '\r' | grep -ci -E '^(cdn-cache-control|cloudflare-cdn-cache-control|surrogate-control):' || true)"
expect_eq "no CDN cache direction reaches the browser" "0" "${cdn}"

echo ""
echo "--- Live: API responses are never stored by a shared cache ---"
# acc PATH — the Cache-Control an application-host response arrived with.
acc() { app "$1" -D - -o /dev/null | tr -d '\r' | sed -n 's/^cache-control: //Ip'; }
for p in /health /me/settings /workspaces/w1/files/a.txt /admin/settings /courses; do
  expect_eq "an API response to ${p} without Cache-Control is private, no-store" "private, no-store" "$(acc "${p}")"
done
expect_eq "an API response's own Cache-Control is kept" "max-age=5" "$(acc /me/cached)"

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" = 0 ]
