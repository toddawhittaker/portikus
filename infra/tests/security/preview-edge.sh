#!/usr/bin/env bash
# The preview edge through the real Caddy (Epic 12a Done item 14, the Gate C
# preview part; BROWSER-HANDLING.md 8 to 16, SPEC.md 24.7).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# Each workspace serves a page naming itself on one port.  a's preview host
# must refuse anonymous callers and b, for pages and WebSocket upgrades alike.
# Forged forwarding headers must not choose the upstream, the edge-only paths
# must not answer on the main site, and denied ports never get an upstream.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- Preview edge ---"

pe_port=5180
pe_b_ip=$(sec_ws_ip b)

# The page server also accepts WebSocket upgrades, so an upgrade through the
# preview host has a positive control.
pe_server_py='import base64, functools, hashlib, http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() != "websocket":
            return super().do_GET()
        key = self.headers.get("Sec-WebSocket-Key", "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
        self.end_headers()
        self.close_connection = True
handler = functools.partial(H, directory=sys.argv[2])
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), handler).serve_forever()'
pe_server_b64=$(printf '%s\n' "$pe_server_py" | base64 -w0)
for key in a b; do
  sec_exec "$key" student "mkdir -p /tmp/sectest-pe && echo sectest-pe-${key} > /tmp/sectest-pe/index.html && \
    echo ${pe_server_b64} | base64 -d > /tmp/sectest-pe-server.py && \
    (setsid nohup python3 /tmp/sectest-pe-server.py ${pe_port} /tmp/sectest-pe >/dev/null 2>&1 &) ; sleep 1" >/dev/null 2>&1
done

# The listening registry polls every two seconds; a grant needs it to know the port.
pe_wait_listening() { # KEY
  local i
  for ((i = 0; i < 30; i += 2)); do
    sec_http "$1" GET "/workspaces/$(sec_ws_id "$1")/listening" >/dev/null
    jq -e --argjson p "$pe_port" '[.. | objects | select(.port? == $p)] | length > 0' "$SEC_LAST_BODY" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
check "a's listener shows in a's listening list (control)" pe_wait_listening a
check "b's listener shows in b's listening list (control)" pe_wait_listening b

# pe_grant KEY PORT -- prints the status; the body stays in $SEC_LAST_BODY.
pe_grant() {
  sec_http "$1" POST "/workspaces/$(sec_ws_id "$1")/preview-grants" \
    -H 'Content-Type: application/json' --data "{\"port\":$2,\"presentation\":\"top-level\"}"
}
pe_host_of() { sed -E 's#^https://([^:/]+).*#\1#'; }

# pe_bootstrap URL COOKIE-FILE -- open a bootstrap URL as a top-level page and
# keep the preview cookie it sets, on the VM only.  Prints the status.
pe_bootstrap() {
  local url="$1" out="$2" host status
  host=$(printf '%s' "$url" | pe_host_of)
  status=$(sec_http - GET "$url" --resolve "${host}:${SEC_PUBLIC_PORT}:127.0.0.1" \
    -H 'Sec-Fetch-Dest: document' -D "${SEC_REMOTE_DIR}/pe-headers")
  sec_ssh "grep -i '^set-cookie: __Host-portikus-preview=' ${SEC_REMOTE_DIR}/pe-headers \
    | sed -E 's/^[^:]*: *([^;]*).*/Cookie: \\1/' | tr -d '\\r' > ${SEC_REMOTE_DIR}/${out}; rm -f ${SEC_REMOTE_DIR}/pe-headers"
  printf '%s' "$status"
}

# pe_get COOKIE-FILE|- URL [curl args] -- a request on a preview host.
pe_get() {
  local file="$1" url="$2" host args=()
  shift 2
  host=$(printf '%s' "$url" | pe_host_of)
  args=(--resolve "${host}:${SEC_PUBLIC_PORT}:127.0.0.1")
  [ "$file" != "-" ] && args+=(-H "@${SEC_REMOTE_DIR}/${file}")
  sec_http - GET "$url" "${args[@]}" "$@"
}
pe_leaks() { grep -q -e sectest-pe-a -e sectest-pe-b "$SEC_LAST_BODY" 2>/dev/null; }
# pe_refused LABEL STATUS COOKIE-FILE|- URL [curl args] -- the status matches
# and no workspace page came back.
pe_refused() {
  local label="$1" want="$2" got; shift 2
  got=$(pe_get "$@")
  if [ "$got" = "$want" ] && ! pe_leaks; then
    sec_pass "$label"
  else
    sec_fail "$label (got: ${got}$(pe_leaks && echo ', a workspace page came back'))"
  fi
}
# pe_serves COOKIE-FILE URL [curl args] -- "status page" for a control.
pe_serves() {
  local got; got=$(pe_get "$@"); echo "${got} $(head -c 64 "$SEC_LAST_BODY")"
}

check_output "a gets a preview grant for its own port (control)" "201" pe_grant a "$pe_port"
pe_a_origin=$(jq -r '.previewOrigin // empty' "$SEC_LAST_BODY" 2>/dev/null)
pe_a_boot=$(jq -r '.bootstrapUrl // empty' "$SEC_LAST_BODY" 2>/dev/null)
check_output "b gets a preview grant for its own port (control)" "201" pe_grant b "$pe_port"
pe_b_origin=$(jq -r '.previewOrigin // empty' "$SEC_LAST_BODY" 2>/dev/null)
pe_b_boot=$(jq -r '.bootstrapUrl // empty' "$SEC_LAST_BODY" 2>/dev/null)
pe_a_host=$(printf '%s' "$pe_a_origin" | pe_host_of)
pe_b_host=$(printf '%s' "$pe_b_origin" | pe_host_of)
pe_suffix="${pe_a_host#*.}"
pe_a_first="${pe_a_host%%.*}"
pe_a_label="${pe_a_first%-*}"
echo "Preview hosts: a ${pe_a_host:-?}, b ${pe_b_host:-?}"

if [ -z "$pe_a_boot" ] || [ -z "$pe_b_boot" ]; then
  sec_fail "preview setup: both workspaces got a bootstrap URL"
else
  check_output "a's bootstrap sets a preview session (control)" "303" pe_bootstrap "$pe_a_boot" pe-a.cookie
  check_output "b's bootstrap sets a preview session (control)" "303" pe_bootstrap "$pe_b_boot" pe-b.cookie
  check_output "a sees its own page through its preview host (control)" "200 sectest-pe-a" \
    pe_serves pe-a.cookie "${pe_a_origin}/"
  check_output "b sees its own page through its preview host (control)" "200 sectest-pe-b" \
    pe_serves pe-b.cookie "${pe_b_origin}/"

  # Other callers on a's preview host.
  pe_refused "anonymous is refused on a's preview host" 401 - "${pe_a_origin}/"
  pe_refused "b's main session is refused on a's preview host" 401 - "${pe_a_origin}/" \
    -H "@${SEC_REMOTE_DIR}/b.cookie"
  pe_refused "b's own preview session is refused on a's preview host" 403 pe-b.cookie "${pe_a_origin}/"

  # The same callers asking for a WebSocket upgrade on a's preview host.
  pe_upgrade() { # COOKIE-KEY|- ORIGIN
    sec_ws_upgrade "$1" "${pe_a_origin}/" "$2" --resolve "${pe_a_host}:${SEC_PUBLIC_PORT}:127.0.0.1"
  }
  check_output "a opens a WebSocket through its own preview host (control)" "101" \
    pe_upgrade pe-a "$pe_a_origin"
  check_output "anonymous gets 401 upgrading on a's preview host" "401" pe_upgrade - "$pe_a_origin"
  check_output "b's main session gets 401 upgrading on a's preview host" "401" pe_upgrade b "$pe_a_origin"
  check_output "b's own preview session gets 403 upgrading on a's preview host" "403" \
    pe_upgrade pe-b "$pe_a_origin"
  check_output "b's own preview session with b's origin gets 403 upgrading on a's preview host" "403" \
    pe_upgrade pe-b "$pe_b_origin"
  check_output "b gets a second grant (control)" "201" pe_grant b "$pe_port"
  pe_b_boot2=$(jq -r '.bootstrapUrl // empty' "$SEC_LAST_BODY" 2>/dev/null)
  pe_b_ticket="${pe_b_boot2#*/__portikus/bootstrap}"
  pe_ticket_elsewhere() {
    local status
    status=$(pe_bootstrap "${pe_a_origin}/__portikus/bootstrap${pe_b_ticket}" pe-stolen.cookie)
    echo "${status} $(sec_ssh "cat ${SEC_REMOTE_DIR}/pe-stolen.cookie")"
  }
  check_output "b's ticket opened on a's preview host sets no session" "403 " pe_ticket_elsewhere

  # Forged forwarding headers never choose the upstream: Caddy drops them and
  # the API answers from the preview session alone.
  pe_refused "anonymous with a forged upstream header is refused" 401 - "${pe_a_origin}/" \
    -H "X-Portikus-Upstream: ${pe_b_ip}:${pe_port}"
  check_output "a forged upstream header does not move a's preview to b" "200 sectest-pe-a" \
    pe_serves pe-a.cookie "${pe_a_origin}/" -H "X-Portikus-Upstream: ${pe_b_ip}:${pe_port}"
  pe_refused "b's session with X-Forwarded-Host naming b's host is refused on a's host" 403 \
    pe-b.cookie "${pe_a_origin}/" -H "X-Forwarded-Host: ${pe_b_host}:${SEC_PUBLIC_PORT}" \
    -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 127.0.0.1'
  pe_refused "b's session with a forged Host naming a's host is refused" 403 \
    pe-b.cookie "${pe_b_origin}/" -H "Host: ${pe_a_host}:${SEC_PUBLIC_PORT}"
  pe_refused "a's session on a made-up label is refused" 403 \
    pe-a.cookie "${pe_a_origin}/" -H "Host: sectest-nope-${pe_port}.${pe_suffix}:${SEC_PUBLIC_PORT}"
  pe_refused "a's session on its own label with another port is refused" 403 \
    pe-a.cookie "${pe_a_origin}/" -H "Host: ${pe_a_label}-$((pe_port + 1)).${pe_suffix}:${SEC_PUBLIC_PORT}"

  # The edge-only paths do not reach the API through the main site: the main
  # site answers them exactly as it answers its own front page.
  sec_http - GET "${SEC_API}/" >/dev/null
  pe_front=$(sha256sum <"$SEC_LAST_BODY" | cut -d' ' -f1)
  pe_main_site() { # PATH [curl args] -- "same" when the main site served its front page
    local path="$1" sum up; shift
    sec_http - GET "${SEC_API}${path}" -D "${SEC_REMOTE_DIR}/pe-main-headers" "$@" >/dev/null
    sum=$(sha256sum <"$SEC_LAST_BODY" | cut -d' ' -f1)
    up=$(sec_ssh "grep -ci -e '^x-portikus-upstream' -e '^set-cookie: __Host-portikus-preview' ${SEC_REMOTE_DIR}/pe-main-headers; rm -f ${SEC_REMOTE_DIR}/pe-main-headers")
    if [ "$sum" = "$pe_front" ] && [ "$up" = "0" ]; then echo same; else echo "different (edge headers: ${up})"; fi
  }
  check_output "/preview/authorize on the main site is only the front page" "same" \
    pe_main_site /preview/authorize -H "@${SEC_REMOTE_DIR}/pe-a.cookie" \
    -H "X-Forwarded-Host: ${pe_a_host}:${SEC_PUBLIC_PORT}"
  check_output "a grant for the next check (control)" "201" pe_grant a "$pe_port"
  pe_a_boot2=$(jq -r '.bootstrapUrl // empty' "$SEC_LAST_BODY" 2>/dev/null)
  check_output "/__portikus/bootstrap on the main site is only the front page" "same" \
    pe_main_site "/__portikus/bootstrap${pe_a_boot2#*/__portikus/bootstrap}" -H 'Sec-Fetch-Dest: document'
  check_output "the ticket offered to the main site is still unused on a's host" "303" \
    pe_bootstrap "$pe_a_boot2" pe-a2.cookie
  check_output "/__portikus/reset on the main site is only the front page" "same" \
    pe_main_site /__portikus/reset -H "@${SEC_REMOTE_DIR}/pe-a.cookie"

  # Denied ports (BROWSER-HANDLING.md 8): no grant, no bridge, no host.
  for pe_denied in 22 2375 2376 5432 7400; do
    check_output "a gets no grant for denied port ${pe_denied}" "403" pe_grant a "$pe_denied"
    pe_refused "a's session gets no bridge to denied port ${pe_denied}" 403 \
      pe-a.cookie "${pe_a_origin}/__portikus/ports/${pe_denied}/health"
    pe_refused "a's session gets nothing on the preview host for denied port ${pe_denied}" 403 \
      pe-a.cookie "${pe_a_origin}/" -H "Host: ${pe_a_label}-${pe_denied}.${pe_suffix}:${SEC_PUBLIC_PORT}"
  done
fi

for key in a b; do
  sec_exec "$key" student "pkill -f 'sectest-pe-server.py ${pe_port}'; rm -rf /tmp/sectest-pe /tmp/sectest-pe-server.py" >/dev/null 2>&1
done
sec_ssh "rm -f ${SEC_REMOTE_DIR}/pe-*.cookie" 2>/dev/null
