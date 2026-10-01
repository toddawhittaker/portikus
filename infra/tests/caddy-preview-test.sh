#!/usr/bin/env bash
# Tests the preview virtual host in the Caddy role's template
# (docs/BROWSER-HANDLING.md sections 7.1, 8, 10, 12, 13, 14, 16.2 and 16.5).
#
# It renders infra/ansible/roles/caddy/templates/Caddyfile.j2 with the
# pilot's variables and asserts the properties the preview edge and the
# sign-in provider routes depend on.
# Needs no VM.  When a caddy binary is found (on PATH, or named by CADDY),
# the rendered file is also run through `caddy validate`, and a live Caddy
# on loopback proxies to stand-in plain and TLS upstreams (#283).
set -uo pipefail

caddy_bin="${CADDY:-$(command -v caddy || true)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="${REPO_ROOT}/infra/ansible/roles/caddy/templates/Caddyfile.j2"
SITE_YML="${REPO_ROOT}/infra/ansible/site.yml"

PUBLIC_HOST="portikus.192.0.2.10.nip.io"
PREVIEW_SUFFIX="preview.${PUBLIC_HOST}"
PUBLIC_PORT=8443
API_PORT=3000
CHALLENGE_PORT=8796
ADMIN_SOCKET=/var/lib/caddy/admin.sock

pass=0
fail=0

ok() {
  printf '\033[1;32mPASS\033[0m  %s\n' "$1"
  pass=$((pass + 1))
}

no() {
  printf '\033[1;31mFAIL\033[0m  %s\n' "$1"
  fail=$((fail + 1))
}

# has LABEL PATTERN FILE — the file contains a line matching PATTERN.
has() {
  if grep -qE -- "$2" "$3"; then ok "$1"; else no "$1"; fi
}

# lacks LABEL PATTERN FILE — no directive of the file matches PATTERN.
# Comments are skipped: they are allowed to name what is deliberately absent.
lacks() {
  if grep -vE '^[[:space:]]*#' "$3" | grep -qE -- "$2"; then no "$1"; else ok "$1"; fi
}

# Caddy's `*` in a site address matches exactly one DNS label.  So a host is
# covered by *.<suffix> when dropping its first label leaves the suffix.
# This is the rule site.yml asserts before any role runs.
covered_by_wildcard() { # HOST SUFFIX
  [ "${1#*.}" = "$2" ]
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v ansible >/dev/null || {
  echo "error: ansible is needed to render the template (docs/WORKFLOW.md)" >&2
  exit 1
}

# render IDP DEST [ARGS...] — the template as site.yml would render it for
# that sign-in provider (dex or mock), with any further -e settings.
render() {
  ansible localhost -c local -m ansible.builtin.template \
    -a "src=${TEMPLATE} dest=${2} mode=0644" \
    -e "portikus_public_host=${PUBLIC_HOST}" \
    -e "portikus_preview_suffix=${PREVIEW_SUFFIX}" \
    -e "portikus_public_port=${PUBLIC_PORT}" \
    -e "portikus_api_port=${API_PORT}" \
    -e "portikus_idp=${1}" \
    -e "caddy_admin_socket=${ADMIN_SOCKET}" \
    -e "dex_port=5556" \
    -e "caddy_certificate_dir=${work}/certificate" \
    -e "caddy_challenge_port=${CHALLENGE_PORT}" \
    -e "portikus_mock_idp_port=3002" "${@:3}" >"${work}/render.log" 2>&1 || {
    echo "error: rendering ${TEMPLATE} for ${1} failed" >&2
    cat "${work}/render.log" >&2
    exit 1
  }
}

# The Caddyfile imports the snippet the root job writes, so caddy validate
# needs one: the internal authority's, as packaging/certificate's tests pin it.
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

rendered="${work}/Caddyfile"
render dex "${rendered}"
render mock "${work}/Caddyfile.mock"

# Split the rendered file into the application block and the preview block,
# so each set of assertions can only see its own virtual host.  The snippets
# at the top of the file count as preview: only the preview host imports
# them, which an assertion on the application block below checks.
awk -v out="${work}" '
  /^\(portikus_/ { block = out "/preview" ; inblock = 1 }
  /^https:\/\/\*\./ { block = out "/preview" ; inblock = 1 }
  /^https:\/\/[^*]/ { block = out "/app"     ; inblock = 1 }
  inblock { print > block }
  /^}$/ { inblock = 0 }
' "${rendered}"

app="${work}/app"
preview="${work}/preview"

for f in "${app}" "${preview}"; do
  [ -s "${f}" ] || { echo "error: no $(basename "${f}") virtual host in the rendered file" >&2; exit 1; }
done

echo "--- The wildcard cannot serve the application host ---"

if covered_by_wildcard "${PUBLIC_HOST}" "${PREVIEW_SUFFIX}"; then
  no "the default preview suffix does not cover the application host"
else
  ok "the default preview suffix does not cover the application host"
fi

# The rule itself, over the cases that matter: the parent domain and the
# application host's own name are both rejected, a dedicated child is not.
if covered_by_wildcard "${PUBLIC_HOST}" "192.0.2.10.nip.io"; then
  ok "a parent-domain suffix is recognised as covering the application host"
else
  no "a parent-domain suffix is recognised as covering the application host"
fi

has "site.yml refuses a preview suffix equal to the application host" \
  'portikus_preview_suffix != portikus_public_host' "${SITE_YML}"
has "site.yml refuses a preview suffix whose wildcard covers the application host" \
  "portikus_public_host\.split\('\.', 1\) \| last != portikus_preview_suffix" "${SITE_YML}"

echo "--- The admin interface ---"

# Loopback port 2019 is open to every local account; the socket is not.
has "the admin interface is a socket only its owner may open" \
  "^[[:space:]]+admin unix/${ADMIN_SOCKET}\\|0600$" "${rendered}"
if [ "$(grep -cE '^[[:space:]]*admin ' "${rendered}")" = 1 ]; then
  ok "no other admin address is set"
else
  no "no other admin address is set"
fi

has "the preview virtual host is the wildcard on the public port" \
  "^https://\*\.${PREVIEW_SUFFIX}:${PUBLIC_PORT} \{$" "${rendered}"
has "the application virtual host keeps its own exact name" \
  "^https://${PUBLIC_HOST}:${PUBLIC_PORT} \{$" "${rendered}"

echo ""
echo "--- Preview virtual host ---"

has "the preview host takes its certificate from the preview snippet" \
  '^[[:space:]]+import portikus_tls_preview$' "${preview}"
lacks "the preview host has no certificate of Ansible's own" '^[[:space:]]+tls [^{]' "${preview}"
has "the pre-flight nonce is answered by the API before any authorization" \
  'handle /\.well-known/portikus-preflight/\* \{' "${preview}"
lacks "no compression on preview responses" 'encode gzip' "${preview}"
lacks "no frame-ancestors policy of our own on preview" 'frame-ancestors' "${preview}"
has "Caddy's Server banner is removed" '^[[:space:]]+-Server$' "${preview}"

has "bootstrap is answered by the API" \
  "handle /__portikus/bootstrap \{" "${preview}"
has "reset preview data is answered by the API" \
  "handle /__portikus/reset \{" "${preview}"
has "any other reserved path is a 404 from Caddy" \
  "handle /__portikus/\* \{" "${preview}"
has "the reserved-path 404 needs no API call" '^[[:space:]]+respond 404$' "${preview}"

has "a client-supplied upstream header is deleted" \
  '^[[:space:]]+request_header -X-Portikus-Upstream$' "${preview}"
for h in For Proto Host Method Uri; do
  has "a client-supplied X-Forwarded-${h} is deleted" \
    "^[[:space:]]+request_header -X-Forwarded-${h}\$" "${preview}"
done

# The API decides which preview host a request is for from X-Forwarded-Host,
# so the routes that only talk to the API must throw the client's copy
# away as well.  Each of the four routes imports the same snippet.
has "the forwarded headers are forgotten in one place" \
  '^\(portikus_forget_forwarded\) \{$' "${preview}"
if [ "$(grep -c 'import portikus_forget_forwarded' "${preview}")" = "4" ]; then
  ok "bootstrap, reset, the pre-flight nonce and the application path all forget them"
else
  no "bootstrap, reset, the pre-flight nonce and the application path all forget them"
fi

has "every request is authorized by the API" \
  "forward_auth 127\.0\.0\.1:${API_PORT} \{" "${preview}"
has "the authorization subrequest asks /preview/authorize" '^[[:space:]]+uri /preview/authorize$' "${preview}"
has "the upstream and its scheme are copied off the authorization response" \
  '^[[:space:]]+copy_headers X-Portikus-Upstream X-Portikus-Upstream-Scheme$' "${preview}"
has "a client-supplied upstream scheme header is deleted" \
  '^[[:space:]]+request_header -X-Portikus-Upstream-Scheme$' "${preview}"
has "the application never sees the upstream scheme header" \
  '^[[:space:]]+header_up -X-Portikus-Upstream-Scheme$' "${preview}"
has "only an https answer selects the TLS proxy" \
  '^[[:space:]]+@portikus_tls_upstream header X-Portikus-Upstream-Scheme https$' "${preview}"
has "the TLS proxy dials the same copied upstream" \
  '^[[:space:]]+reverse_proxy @portikus_tls_upstream \{http\.request\.header\.X-Portikus-Upstream\} \{$' "${preview}"
# Certificate checks are off for the student's hop and nowhere else.
if [ "$(grep -cE '^[[:space:]]+tls_insecure_skip_verify$' "${rendered}")" = "1" ] &&
  [ "$(grep -cE '^[[:space:]]+tls_insecure_skip_verify$' "${preview}")" = "1" ]; then
  ok "certificate checks are skipped only on the TLS preview hop"
else
  no "certificate checks are skipped only on the TLS preview hop"
fi
if [ "$(grep -c 'import portikus_preview_proxy_rules' "${preview}")" = "2" ]; then
  ok "both preview proxies share one set of header rules"
else
  no "both preview proxies share one set of header rules"
fi
has "the authorization subrequest is a plain request, not an upgrade" \
  '^[[:space:]]+header_up -Upgrade$' "${preview}"
has "the proxy dials the copied upstream and nothing else" \
  '^[[:space:]]+reverse_proxy \{http\.request\.header\.X-Portikus-Upstream\}' "${preview}"

has "preview access logs drop the query string" \
  'request>uri regexp' "${preview}"
has "preview access logs drop cookies" \
  'request>headers>Cookie delete' "${preview}"

echo ""
echo "--- The preview session cookie never reaches the application (16.2) ---"

has "the preview cookie pair is cut out of the Cookie header" \
  'request_header Cookie "\(\^\|;.s\*\)\(__Host-\)\?portikus-preview=\[\^;\]\*" ""' "${preview}"
has "the cookie name must start the header or follow a separator" \
  'request_header Cookie "\(\^\|;' "${preview}"
has "a leading separator left behind is cleaned up" \
  'request_header Cookie "\^.s\*;.s\*" ""' "${preview}"
has "a trailing separator left behind is cleaned up" \
  'request_header Cookie ";.s\*\$" ""' "${preview}"
has "a Cookie header left with nothing in it is deleted" \
  'request_header @portikus_empty_cookie -Cookie' "${preview}"
has "the empty-Cookie matcher is defined on the preview host" \
  '@portikus_empty_cookie header_regexp Cookie \^\$' "${preview}"

# The cut has to happen after the authorization subrequest, which needs the
# cookie, and before the proxy, which must never see it.
authorize_line="$(grep -n 'forward_auth 127' "${preview}" | head -1 | cut -d: -f1)"
cut_line="$(grep -n 'request_header Cookie' "${preview}" | head -1 | cut -d: -f1)"
proxy_line="$(grep -n 'reverse_proxy .*{http.request.header.X-Portikus-Upstream}' "${preview}" | head -1 | cut -d: -f1)"
if [ -n "${authorize_line}" ] && [ -n "${cut_line}" ] && [ -n "${proxy_line}" ] &&
  [ "${authorize_line}" -lt "${cut_line}" ] && [ "${cut_line}" -lt "${proxy_line}" ]; then
  ok "the cookie is cut after the authorization and before the proxy"
else
  no "the cookie is cut after the authorization and before the proxy"
fi

echo ""
echo "--- The same-origin multi-port bridge (14) ---"

has "the bridge prefix has a route of its own" \
  'handle /__portikus/ports/\* \{' "${preview}"
has "a bridge path the API would refuse is a 404 here first" \
  'respond @portikus_bad_bridge 404' "${preview}"
# Caddy has to accept exactly the shape the API's parser accepts: a port
# with no leading zero, followed by a slash.  A leading zero or a missing
# slash is a 404 at the edge rather than a refusal from the API.
has "only a port with no leading zero, followed by a slash, is a bridge path" \
  'not path_regexp \^/__portikus/ports/\[1-9\]\[0-9\]\*/$' "${preview}"
has "the bridge strips its prefix before the application sees the request" \
  'uri path_regexp \^/__portikus/ports/\[1-9\]\[0-9\]\*/ /' "${preview}"
has "the bridge runs the same authorization step" \
  'import portikus_preview_authorize' "${preview}"
has "a rewritten redirect on the bridge keeps the bridge prefix" \
  'import portikus_preview_proxy "/__portikus/ports/\{portikus_upstream_port\}"' "${preview}"

# The API reads the wanted port out of X-Forwarded-Uri, so the prefix must
# still be on the URI when the authorization subrequest runs.
strip_line="$(grep -n 'uri path_regexp' "${preview}" | head -1 | cut -d: -f1)"
bridge_auth_line="$(grep -n 'import portikus_preview_authorize' "${preview}" | head -1 | cut -d: -f1)"
bridge_proxy_line="$(grep -n 'import portikus_preview_proxy "' "${preview}" | head -1 | cut -d: -f1)"
if [ -n "${strip_line}" ] && [ -n "${bridge_auth_line}" ] && [ -n "${bridge_proxy_line}" ] &&
  [ "${bridge_auth_line}" -lt "${strip_line}" ] && [ "${strip_line}" -lt "${bridge_proxy_line}" ]; then
  ok "the prefix is still on the URI when the API is asked"
else
  no "the prefix is still on the URI when the API is asked"
fi

echo ""
echo "--- Compatibility rewrites, and nothing wider (13) ---"

has "the workspace address and port are taken from the authorization answer" \
  'map \{http.request.header.X-Portikus-Upstream\} \{portikus_upstream_host\} \{portikus_upstream_port\}' "${preview}"
has "only redirect responses are inspected" \
  '@portikus_redirect status 3xx' "${preview}"
has "a redirect to the same port on localhost is rewritten" \
  'portikus_redirect_origin\} == "localhost:" \+ \{portikus_upstream_port\}' "${preview}"
has "a redirect to the same port on 127.0.0.1 is rewritten" \
  'portikus_redirect_origin\} == "127.0.0.1:" \+ \{portikus_upstream_port\}' "${preview}"
has "a redirect to the same port on the workspace address is rewritten" \
  'portikus_redirect_origin\} == \{portikus_upstream_host\} \+ ":" \+ \{portikus_upstream_port\}' "${preview}"
has "the rewrite points at the preview origin and keeps path and query" \
  'Location "https://\{http.request.hostport\}\{args\[0\]\}\{portikus_redirect_tail\}"' "${preview}"
has "a cookie scoped to localhost or a bare address loses its Domain" \
  'header_down Set-Cookie "\(\?i\);.s\*domain=\(localhost' "${preview}"
# Without the attribute boundary, Domain=localhost.evil.example would be
# cut in half and the cookie corrupted.
has "the Domain must end where the attribute ends" \
  'header_down Set-Cookie .*\\s\*\(;\|\$\)" "\$\{2\}"' "${preview}"

lacks "no blanket rewrite of the Location header" 'header_down Location' "${preview}"
lacks "no response body is rewritten" '(^|[[:space:]])replace([[:space:]]|$)' "${preview}"
lacks "no CORS header is added for the application" 'Access-Control-Allow' "${preview}"

echo ""
echo "--- Application virtual host is unchanged ---"

has "the control plane still refuses to be framed" "frame-ancestors 'none'" "${app}"

echo ""
echo "--- LTI launch and the Course page (docs/archive/epics/EPIC-13.md, rulings 17 and 23) ---"

# Everything but /lti/* keeps frame-ancestors 'none'; the API sends the
# platforms' own frame-ancestors on /lti/*, and two policies would conflict.
has "only /lti/* is left out of the frame policy" \
  '^[[:space:]]+@not_lti not path /lti/\*$' "${app}"
has "the frame policy is applied through that matcher" \
  "^[[:space:]]+header @not_lti Content-Security-Policy \"frame-ancestors 'none'\"\$" "${app}"
if [ "$(grep -vE '^[[:space:]]*#' "${app}" | grep -c 'frame-ancestors')" = "$(grep -c 'header @not_lti Content-Security-Policy' "${app}")" ]; then
  ok "no frame policy is set without the /lti/* exception"
else
  no "no frame policy is set without the /lti/* exception"
fi
has "/lti/* reaches the API" '^[[:space:]]+@api path .* /lti/\* ' "${app}"
has "the course list and members reach the API" '^[[:space:]]+@api path .* /courses\* ' "${app}"
# The setup code is gone (ADR 0031); /setup is only a page.
lacks "no /setup route reaches the API" 'handle /setup' "${app}"
lacks "the /course pages are not sent to the API" 'handle /course[^s]' "${app}"
has "the control plane is still compressed" '^[[:space:]]+encode gzip$' "${app}"
lacks "the control plane has no preview routes" '__portikus' "${app}"
lacks "the control plane does not import the preview steps" 'import portikus_preview' "${app}"

echo ""
echo "--- Sign-in provider routes (docs/adr/0023, #398) ---"

has "Dex is served under /dex on the application host" \
  '^[[:space:]]+handle /dex/\* \{$' "${app}"
has "Dex keeps the /dex prefix and listens on loopback" \
  '^[[:space:]]+reverse_proxy 127\.0\.0\.1:5556$' "${app}"
has "only password form posts, local and LDAP, are matched for the throttle" \
  '^[[:space:]]+path /dex/auth/local/login\* /dex/auth/ldap/login\*$' "${app}"
# Caddy matches a path pattern without escapes against the decoded path, so
# POST /dex/auth/loc%61l/login is caught too.  A % in the pattern would switch
# Caddy to matching the raw path and let encoded spellings past.
lacks "the throttle also catches an encoded post such as /dex/auth/loc%61l/login" \
  '^[[:space:]]+path /dex/.*%' "${app}"
has "the throttle matcher is for POST only" '^[[:space:]]+method POST$' "${app}"
has "a password post asks the API's sign-in throttle first" \
  "forward_auth @dex_password_post 127\.0\.0\.1:${API_PORT} \{" "${app}"
# Caddy keeps the client's query when the forward_auth URI has none, so a
# client could add ?scope=start to a password post.  Every ask names its scope.
has "the password post is asked at /edge/signin-throttle?scope=password" \
  '^[[:space:]]+uri /edge/signin-throttle\?scope=password$' "${app}"
lacks "no throttle ask leaves the client's query in place" \
  '^[[:space:]]+uri /edge/signin-throttle$' "${app}"
# Dex stores every /dex/auth request for ten minutes, so each one is counted
# as a sign-in start and what it can store is capped (security review, 12b).
has "a GET under /dex/auth is matched as a sign-in start" \
  '^[[:space:]]+@dex_signin_start \{$' "${app}"
has "a /dex/auth request asks the throttle as a sign-in start" \
  "forward_auth @dex_signin_start 127\.0\.0\.1:${API_PORT} \{" "${app}"
has "the sign-in start is asked at /edge/signin-throttle?scope=start" \
  '^[[:space:]]+uri /edge/signin-throttle\?scope=start$' "${app}"
has "a Dex URI longer than 1024 bytes is refused" \
  '^[[:space:]]+@dex_long_uri expression \{http\.request\.uri\}\.size\(\) > 1024$' "${app}"
has "the long-URI refusal is a 414" '^[[:space:]]+respond @dex_long_uri 414$' "${app}"
has "a Dex request body is capped" '^[[:space:]]+max_size 16KB$' "${app}"
# Dex reads an auth request from a POST body too, so /dex/auth takes only GET,
# apart from the password post.
has "/dex/auth takes other methods only for the password post" \
  '^[[:space:]]+not method GET$' "${app}"
has "any other method on /dex/auth is a 405" \
  '^[[:space:]]+respond @dex_auth_other_method 405$' "${app}"
# Dex serves more than Portikus uses; POST /dex/device/code stores 16 KB for five
# minutes with no throttle.  Only the paths the sign-in flow uses get through.
has "Dex paths Portikus does not use are a 404" \
  '^[[:space:]]+respond @dex_unused 404$' "${app}"
dex_allowed="$(grep -E '^[[:space:]]+@dex_unused not path ' "${app}" | head -1)"
for used in '/dex/auth*' /dex/token /dex/userinfo /dex/keys '/dex/.well-known/*' \
  '/dex/static/*' '/dex/theme/*' '/dex/callback*'; do
  case " ${dex_allowed} " in
    *" ${used} "*) ok "the sign-in flow's ${used} is let through" ;;
    *) no "the sign-in flow's ${used} is let through" ;;
  esac
done
case " ${dex_allowed} " in
  "  "|*device*|*" /dex/* "*) no "/dex/device/code is not let through" ;;
  *) ok "/dex/device/code is not let through" ;;
esac
line_of() { grep -n -- "$1" "${app}" | head -1 | cut -d: -f1; }
dex_proxy_line="$(line_of 'reverse_proxy 127.0.0.1:5556')"
for step in 'respond @dex_unused' 'respond @dex_long_uri' 'respond @dex_auth_other_method' \
  'max_size 16KB' 'forward_auth @dex_password_post' 'forward_auth @dex_signin_start'; do
  step_line="$(line_of "${step}")"
  if [ -n "${step_line}" ] && [ -n "${dex_proxy_line}" ] && [ "${step_line}" -lt "${dex_proxy_line}" ]; then
    ok "${step} runs before the request reaches Dex"
  else
    no "${step} runs before the request reaches Dex"
  fi
done
has "with Dex, the mock provider's prefix is a 404" 'handle /mock-idp\* \{' "${app}"
lacks "with Dex, nothing proxies to the mock provider" '127\.0\.0\.1:3002' "${app}"
lacks "the /edge routes are never proxied on the public site" 'handle /edge' "${rendered}"

# The API trusts any /edge request from loopback, and everything Caddy
# proxies arrives from loopback.  So every route that proxies to the API
# must have a path matcher that cannot cover /edge: this lists the handle
# matcher above each API proxy, in all three files, and compares it with
# the known routes.  A bare `handle {` or a broader prefix fails here.
api_routes() {
  awk -v api="reverse_proxy 127.0.0.1:${API_PORT}" '
    /^\t@[a-z_]+ path / { paths[$1] = $0; sub(/^\t@[a-z_]+ path /, "", paths[$1]) }
    /^\thandle / { m = $0; sub(/^\thandle /, "", m); sub(/ \{$/, "", m); if (m in paths) m = paths[m] }
    index($0, api) { n = split(m, p, " "); for (i = 1; i <= n; i++) print p[i] }
  ' "$1" | sort -u
}
edge_open=0
for f in "${rendered}" "${work}/Caddyfile.mock"; do
  [ -n "$(api_routes "${f}")" ] || { no "no API route was found in $(basename "${f}")"; edge_open=1; }
  while IFS= read -r m; do
    case "${m}" in
      /auth/\* | /workspaces\* | /admin\* | /lti/\* | /courses\* | /me/\* | /health | \
        /.well-known/portikus-preflight/\* | /__portikus/bootstrap | /__portikus/reset) ;;
      *)
        no "the route '${m}' in $(basename "${f}") proxies to the API and could cover /edge"
        edge_open=1
        ;;
    esac
  done < <(api_routes "${f}")
done
[ "${edge_open}" = 1 ] || ok "every route that proxies to the API has a path that cannot cover /edge"
# /__portikus/ports/* reaches the API only through forward_auth, whose fixed
# uri replaces the client's path; so does every other forward_auth.
if [ "$(grep -cE '^[[:space:]]+forward_auth .*127\.0\.0\.1:'"${API_PORT}"' \{$' "${rendered}")" = \
  "$(grep -cE '^[[:space:]]+uri /(preview/authorize|edge/signin-throttle\?scope=(password|start))$' "${rendered}")" ]; then
  ok "every authorization subrequest to the API names its own fixed path"
else
  no "every authorization subrequest to the API names its own fixed path"
fi

has "with the mock, /dex is a 404" 'handle /dex\* \{' "${work}/Caddyfile.mock"
lacks "with the mock, nothing proxies to Dex" '127\.0\.0\.1:5556' "${work}/Caddyfile.mock"
has "with the mock, the mock provider is served" \
  'reverse_proxy 127\.0\.0\.1:3002' "${work}/Caddyfile.mock"

echo ""
echo "--- The API is told which suffix Caddy serves ---"

has "PREVIEW_SUFFIX is written beside PUBLIC_URL" \
  '^PREVIEW_SUFFIX=\{\{ portikus_preview_suffix \}\}$' \
  "${REPO_ROOT}/infra/ansible/roles/portikus/templates/api.env.j2"

echo ""
echo "--- The certificate is the admin page's (docs/SPEC.md section 21.12) ---"

# count_is LABEL N PATTERN FILE — exactly N lines of the file match PATTERN.
count_is() {
  if [ "$(grep -cE -- "$3" "$4")" = "$2" ]; then ok "$1"; else no "$1"; fi
}

has "the certificate snippet file is imported before the global options" \
  "^import ${work}/certificate/tls\.caddy$" "${rendered}"
if [ "$(grep -nE '^import .*/tls\.caddy$' "${rendered}" | cut -d: -f1)" -lt "$(grep -nE '^\{$' "${rendered}" | head -1 | cut -d: -f1)" ]; then
  ok "the import comes first, so its snippets exist when used"
else
  no "the import comes first, so its snippets exist when used"
fi
has "the global options take on-demand TLS from the snippet, asking the API on loopback" \
  "^[[:space:]]+import portikus_tls_global http://127\.0\.0\.1:${API_PORT}/edge/certificate-ask$" "${rendered}"
has "the application host takes its certificate from the site snippet" \
  '^[[:space:]]+import portikus_tls_site$' "${app}"
lacks "Ansible renders no tls directive of its own" '^[[:space:]]+tls [^{]' "${rendered}"
lacks "no secret reaches Caddy through its environment" '\{env\.' "${rendered}"
awk '/^\{$/ { on = 1 } on { print } on && /^\}$/ { exit }' "${rendered}" >"${work}/global-block"
has "the global options keep Caddy's internal authority, so its root exists whatever the source" \
  '^[[:space:]]+ca local$' "${work}/global-block"

echo ""
echo "--- Reloads keep WebSockets open (Epic 27 R19) ---"

count_is "the API's WebSocket proxy and the preview proxies delay closing streams on a reload" 2 \
  '^[[:space:]]+stream_close_delay 1h$' "${rendered}"
awk '/^\thandle \/workspaces\* \{$/ { on = 1 } on { print } on && /^\t\}$/ { exit }' "${app}" >"${work}/workspaces-block"
has "the /workspaces proxy, which carries every API WebSocket, has the delay" \
  '^[[:space:]]+stream_close_delay 1h$' "${work}/workspaces-block"
has "the preview proxies' shared rules have the delay" \
  '^[[:space:]]+stream_close_delay 1h$' "${preview}"

echo ""
echo "--- Plain HTTP on port 80 ---"

has "the site and the preview names have a plain HTTP block" \
  "^http://${PUBLIC_HOST}, http://\*\.${PREVIEW_SUFFIX} \{$" "${rendered}"
has "plain HTTP redirects to the public HTTPS port" \
  "^[[:space:]]+redir https://\{host\}:${PUBLIC_PORT}\{uri\} 308$" "${rendered}"
count_is "the pre-flight nonce is answered on the preview names and plain HTTP" 2 \
  'handle /\.well-known/portikus-preflight/\* \{' "${rendered}"
has "the site answers the pre-flight nonce" '^[[:space:]]+@api path .* /\.well-known/portikus-preflight/\*$' "${app}"
awk '/^http:\/\// { on = 1 } on { print } on && /^\}$/ { exit }' "${rendered}" >"${work}/plain-block"
count_is "only plain HTTP passes ACME challenges on" 1 'handle /\.well-known/acme-challenge/\* \{' "${rendered}"
awk '/handle \/\.well-known\/acme-challenge\/\* \{/ { on = 1; next } on && /^\t\}$/ { exit } on { print }' \
  "${work}/plain-block" >"${work}/challenge-block"
has "challenges Caddy did not start go to the certificate job's throwaway Caddy" \
  "^[[:space:]]+reverse_proxy 127\.0\.0\.1:${CHALLENGE_PORT}$" "${work}/challenge-block"
count_is "the challenge route proxies nowhere else" 1 'reverse_proxy' "${work}/challenge-block"
lacks "plain HTTP sends nothing to the API's /edge routes" '/edge' "${work}/plain-block"

if [ -z "${caddy_bin}" ]; then
  echo ""
  echo "SKIP  caddy validate and the live proxy checks: no caddy binary (set CADDY to one)"
else
  echo ""
  for idp in dex mock; do
    config="${rendered}"
    [ "${idp}" = dex ] || config="${rendered}.${idp}"
    if "${caddy_bin}" validate --adapter caddyfile --config "${config}" >"${work}/validate.log" 2>&1; then
      ok "caddy validate accepts the configuration for ${idp}"
    else
      no "caddy validate accepts the configuration for ${idp}"
      cat "${work}/validate.log" >&2
    fi
  done

  echo ""
  echo "--- Live: TLS and plain upstreams behind the preview host (#283) ---"

  # A stand-in API answers /preview/authorize by the first label of the
  # preview host, as the real API answers from its registry: "tls" names a
  # self-signed HTTPS upstream, "plain" a plain one, "old" a plain one with
  # no scheme header at all.  Each upstream echoes what it was sent.
  cat >"${work}/stubs.py" <<'PY'
import base64, hashlib, http.server, ssl, sys, threading

api_port, plain_port, tls_port, cert, key, seen, challenge_port = sys.argv[1:8]
UPSTREAMS = {"tls": (tls_port, "https"), "plain": (plain_port, "http"), "old": (plain_port, None)}

class Api(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Every path the API is sent, for the /edge checks.
        with open(seen, "a") as f:
            f.write(self.path + "\n")
        label = self.headers.get("X-Forwarded-Host", "").split("-")[0]
        port, scheme = UPSTREAMS.get(label, (None, None))
        if not self.path.startswith("/preview/authorize") or port is None:
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers(); return
        self.send_response(200)
        self.send_header("X-Portikus-Upstream", "127.0.0.1:" + port)
        if scheme:
            self.send_header("x-portikus-upstream-scheme", scheme)
        self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass

def upstream(name, port):
    class Up(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_GET(self):
            if self.headers.get("Upgrade", "").lower() == "websocket":
                return self.websocket()
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "http://localhost:%s/landed" % port)
                self.send_header("Content-Length", "0"); self.end_headers(); return
            body = ("upstream=%s path=%s scheme-header=%s upstream-header=%s\n" % (
                name, self.path,
                self.headers.get("X-Portikus-Upstream-Scheme", "none"),
                self.headers.get("X-Portikus-Upstream", "none"))).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
        def websocket(self):
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] +
                "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket"); self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept); self.end_headers(); self.wfile.flush()
            head = self.rfile.read(2); length = head[1] & 0x7F
            mask = self.rfile.read(4)
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(self.rfile.read(length)))
            reply = (name + ":").encode() + data
            self.wfile.write(bytes([0x81, len(reply)]) + reply); self.wfile.flush()
            self.close_connection = True
        def log_message(self, *a): pass
    return Up

servers = [http.server.ThreadingHTTPServer(("127.0.0.1", int(api_port)), Api),
           http.server.ThreadingHTTPServer(("127.0.0.1", int(plain_port)), upstream("plain", plain_port)),
           http.server.ThreadingHTTPServer(("127.0.0.1", int(tls_port)), upstream("tls", tls_port)),
           http.server.ThreadingHTTPServer(("127.0.0.1", int(challenge_port)), upstream("challenge", challenge_port))]
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
servers[2].socket = ctx.wrap_socket(servers[2].socket, server_side=True)
for s in servers[:-1]:
    threading.Thread(target=s.serve_forever, daemon=True).start()
servers[-1].serve_forever()
PY

  # A WebSocket client: upgrade through Caddy, send one masked text frame,
  # print the echoed frame's text.
  cat >"${work}/ws.py" <<'PY'
import os, socket, ssl, sys
host, port = sys.argv[1], int(sys.argv[2])
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", port), timeout=5), server_hostname=host)
s.sendall(("GET /socket HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" % (host, port)).encode())
head = b""
while b"\r\n\r\n" not in head:
    chunk = s.recv(1)
    if not chunk: sys.exit("closed before the upgrade answer")
    head += chunk
if not head.startswith(b"HTTP/1.1 101"): sys.exit(head.split(b"\r\n")[0].decode())
mask = os.urandom(4); payload = b"ping"
s.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
frame = s.recv(2); print(s.recv(frame[1] & 0x7F).decode())
PY

  free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
  live_public="$(free_port)"
  live_http="$(free_port)"
  live_api="$(free_port)"
  live_plain="$(free_port)"
  live_tls="$(free_port)"
  live_challenge="$(free_port)"

  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -keyout "${work}/up.key" -out "${work}/up.crt" >/dev/null 2>&1
  python3 "${work}/stubs.py" "${live_api}" "${live_plain}" "${live_tls}" \
    "${work}/up.crt" "${work}/up.key" "${work}/api-paths" "${live_challenge}" >"${work}/stubs.log" 2>&1 &
  stubs_pid=$!

  ansible localhost -c local -m ansible.builtin.template \
    -a "src=${TEMPLATE} dest=${work}/Caddyfile.live mode=0644" \
    -e "portikus_public_host=${PUBLIC_HOST}" \
    -e "portikus_preview_suffix=${PREVIEW_SUFFIX}" \
    -e "portikus_public_port=${live_public}" \
    -e "portikus_api_port=${live_api}" \
    -e "portikus_idp=mock" \
    -e "caddy_admin_socket=${ADMIN_SOCKET}" \
    -e "caddy_certificate_dir=${work}/certificate" \
    -e "caddy_challenge_port=${live_challenge}" \
    -e "portikus_mock_idp_port=3002" >"${work}/render.log" 2>&1
  # Keep the test Caddy's admin, certificates and ports out of the host's
  # own, in the template's one global block.
  awk -v data="${work}/caddy-data" -v port="${live_http}" '
    /^[[:space:]]*admin unix\// {
      printf "\tadmin off\n\tskip_install_trust\n\tstorage file_system %s\n\thttp_port %s\n", data, port
      next
    }
    { print }
  ' "${work}/Caddyfile.live" >"${work}/Caddyfile.run"
  "${caddy_bin}" run --adapter caddyfile --config "${work}/Caddyfile.run" >"${work}/caddy.log" 2>&1 &
  caddy_pid=$!
  trap 'kill "${caddy_pid}" "${stubs_pid}" 2>/dev/null; rm -rf "${work}"' EXIT

  # get LABEL PATH [CURL ARGS...] — a request to a preview host of that label.
  get() {
    local h="$1-5173.${PREVIEW_SUFFIX}" p="$2"
    shift 2
    curl -sk --max-time 5 --resolve "${h}:${live_public}:127.0.0.1" "$@" "https://${h}:${live_public}${p}"
  }
  for _ in $(seq 50); do
    [ "$(get plain / -o /dev/null -w '%{http_code}')" = 200 ] && break
    sleep 0.2
  done

  expect() { # LABEL EXPECTED ACTUAL
    case "$3" in
      *"$2"*) ok "$1" ;;
      *) no "$1 (got: $3)" ;;
    esac
  }

  expect "an HTTPS upstream with a self-signed certificate is proxied" \
    "upstream=tls path=/page" "$(get tls /page)"
  expect "a plain upstream is still proxied" \
    "upstream=plain path=/page" "$(get plain /page)"
  expect "an answer with no scheme header still goes to the plain upstream" \
    "upstream=plain" "$(get old /)"
  expect "neither the scheme nor the upstream header reaches the application" \
    "scheme-header=none upstream-header=none" "$(get tls /)"
  expect "the bridge path reaches an HTTPS upstream with its prefix stripped" \
    "upstream=tls path=/inner" "$(get tls /__portikus/ports/5174/inner)"
  expect "a redirect over the TLS hop is rewritten to the preview origin" \
    "location: https://tls-5173.${PREVIEW_SUFFIX}:${live_public}/landed" \
    "$(get tls /redirect -D - -o /dev/null | tr -d '\r' | tr '[:upper:]' '[:lower:]')"

  # A forged header changes nothing: the plain upstream would fail a TLS
  # handshake and the TLS upstream a plain request, so either leak would
  # show up as a 502 instead of the page.
  expect "a client-sent https scheme header does not turn TLS on" \
    "upstream=plain path=/ scheme-header=none" "$(get plain / -H 'X-Portikus-Upstream-Scheme: https')"
  expect "a client-sent https scheme header is ignored when the API sends none" \
    "upstream=plain path=/ scheme-header=none" "$(get old / -H 'X-Portikus-Upstream-Scheme: https')"
  expect "a client-sent http scheme header does not turn TLS off" \
    "upstream=tls path=/ scheme-header=none" "$(get tls / -H 'X-Portikus-Upstream-Scheme: http')"
  expect "a client-sent upstream header does not move the target" \
    "upstream=tls" "$(get tls / -H "X-Portikus-Upstream: 127.0.0.1:${live_plain}")"

  expect "a WebSocket works over the TLS hop" \
    "tls:ping" "$(python3 "${work}/ws.py" "tls-5173.${PREVIEW_SUFFIX}" "${live_public}" 2>&1)"
  expect "a WebSocket still works over the plain hop" \
    "plain:ping" "$(python3 "${work}/ws.py" "plain-5173.${PREVIEW_SUFFIX}" "${live_public}" 2>&1)"

  # The API trusts any /edge request from loopback, and everything Caddy
  # proxies comes from loopback, so no outside request may reach /edge.
  site() {
    local p="$1"
    shift
    curl -sk --max-time 5 --resolve "${PUBLIC_HOST}:${live_public}:127.0.0.1" "$@" \
      "https://${PUBLIC_HOST}:${live_public}${p}" -o /dev/null
  }
  get plain /edge/certificate-ask?domain=evil.example -o /dev/null
  get plain /workspaces/../edge/certificate-ask?domain=evil.example --path-as-is -o /dev/null
  site /edge/certificate-ask?domain=evil.example
  site /workspaces/../edge/certificate-ask?domain=evil.example --path-as-is
  site /edge/signin-throttle?scope=start
  get plain /.well-known/portikus-preflight/0123abcd -o /dev/null
  if grep -q '/edge' "${work}/api-paths"; then
    no "no request from outside reaches the API's /edge routes (got: $(grep '/edge' "${work}/api-paths" | head -3 | tr '\n' ' '))"
  else
    ok "no request from outside reaches the API's /edge routes"
  fi
  expect "a preview host sends the pre-flight nonce to the API as it is" \
    "/.well-known/portikus-preflight/0123abcd" "$(cat "${work}/api-paths")"

  # plain URL [CURL ARGS...] — a plain HTTP request to the port-80 block.
  plain() {
    local url="$1"
    shift
    curl -s --max-time 5 --path-as-is "$@" "http://127.0.0.1:${live_http}${url}"
  }
  expect "a site challenge Caddy did not start reaches the throwaway Caddy's port" \
    "upstream=challenge path=/.well-known/acme-challenge/tok-site" \
    "$(plain /.well-known/acme-challenge/tok-site -H "Host: ${PUBLIC_HOST}")"
  expect "a preview challenge reaches the throwaway Caddy's port" \
    "upstream=challenge path=/.well-known/acme-challenge/tok-preview" \
    "$(plain /.well-known/acme-challenge/tok-preview -H "Host: plain-5173.${PREVIEW_SUFFIX}")"
  expect "the /edge routes on plain HTTP only redirect" "308" \
    "$(plain /edge/certificate-ask?domain=evil.example -H "Host: ${PUBLIC_HOST}" -o /dev/null -w '%{http_code}')"
  expect "a path that climbs out of the challenge prefix only redirects" "308" \
    "$(plain /.well-known/acme-challenge/../../edge/certificate-ask -H "Host: ${PUBLIC_HOST}" -o /dev/null -w '%{http_code}')"
  if grep -q '/edge' "${work}/api-paths"; then
    no "no plain HTTP request reaches the API's /edge routes"
  else
    ok "no plain HTTP request reaches the API's /edge routes"
  fi

  if [ "${fail}" -gt 0 ]; then
    echo "--- caddy log ---" >&2
    tail -n 30 "${work}/caddy.log" >&2
  fi
fi

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
