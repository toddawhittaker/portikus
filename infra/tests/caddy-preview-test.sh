#!/usr/bin/env bash
# Tests the preview virtual host in the Caddy role's template
# (docs/BROWSER-HANDLING.md sections 7.1, 8, 10, 12, 13, 14, 16.2 and 16.5).
#
# It renders infra/ansible/roles/caddy/templates/Caddyfile.j2 with the
# pilot's variables and asserts the properties the preview edge and the
# sign-in provider routes depend on.
# Needs no VM.  When the caddy binary happens to be installed, the rendered
# file is also run through `caddy validate`.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="${REPO_ROOT}/infra/ansible/roles/caddy/templates/Caddyfile.j2"
SITE_YML="${REPO_ROOT}/infra/ansible/site.yml"

PUBLIC_HOST="portikus.192.0.2.10.nip.io"
PREVIEW_SUFFIX="preview.${PUBLIC_HOST}"
PUBLIC_PORT=8443
API_PORT=3000

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

# render IDP DEST — the template as site.yml would render it for that
# sign-in provider (dex, mock or external).
render() {
  ansible localhost -c local -m ansible.builtin.template \
    -a "src=${TEMPLATE} dest=${2} mode=0644" \
    -e "portikus_public_host=${PUBLIC_HOST}" \
    -e "portikus_preview_suffix=${PREVIEW_SUFFIX}" \
    -e "portikus_public_port=${PUBLIC_PORT}" \
    -e "portikus_api_port=${API_PORT}" \
    -e "portikus_idp=${1}" \
    -e "dex_port=5556" \
    -e "portikus_mock_idp_port=3002" >"${work}/render.log" 2>&1 || {
    echo "error: rendering ${TEMPLATE} for ${1} failed" >&2
    cat "${work}/render.log" >&2
    exit 1
  }
}

rendered="${work}/Caddyfile"
render dex "${rendered}"
render mock "${work}/Caddyfile.mock"
render external "${work}/Caddyfile.external"

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

has "the preview virtual host is the wildcard on the public port" \
  "^https://\*\.${PREVIEW_SUFFIX}:${PUBLIC_PORT} \{$" "${rendered}"
has "the application virtual host keeps its own exact name" \
  "^https://${PUBLIC_HOST}:${PUBLIC_PORT} \{$" "${rendered}"

echo ""
echo "--- Preview virtual host ---"

has "a wildcard certificate is issued by the internal authority" '^[[:space:]]+tls internal$' "${preview}"
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
# so the two routes that only talk to the API must throw the client's copy
# away as well.  Each of the three routes imports the same snippet.
has "the forwarded headers are forgotten in one place" \
  '^\(portikus_forget_forwarded\) \{$' "${preview}"
if [ "$(grep -c 'import portikus_forget_forwarded' "${preview}")" = "3" ]; then
  ok "bootstrap, reset and the application path all forget them"
else
  no "bootstrap, reset and the application path all forget them"
fi

has "every request is authorized by the API" \
  "forward_auth 127\.0\.0\.1:${API_PORT} \{" "${preview}"
has "the authorization subrequest asks /preview/authorize" '^[[:space:]]+uri /preview/authorize$' "${preview}"
has "the upstream is copied off the authorization response" \
  '^[[:space:]]+copy_headers X-Portikus-Upstream$' "${preview}"
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
proxy_line="$(grep -n 'reverse_proxy {http.request.header.X-Portikus-Upstream}' "${preview}" | head -1 | cut -d: -f1)"
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
bridge_proxy_line="$(grep -n 'import portikus_preview_proxy' "${preview}" | head -1 | cut -d: -f1)"
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
echo "--- LTI launch and the Course page (docs/EPIC-13.md, rulings 17 and 23) ---"

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
has "/lti/* reaches the API" '^[[:space:]]+handle /lti/\* \{$' "${app}"
has "the course list and members reach the API" '^[[:space:]]+handle /courses\* \{$' "${app}"
has "the setup-code routes reach the API" '^[[:space:]]+handle /setup/\* \{$' "${app}"
lacks "the /setup page is not sent to the API" 'handle /setup[^/]' "${app}"
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

has "with the mock, /dex is a 404" 'handle /dex\* \{' "${work}/Caddyfile.mock"
lacks "with the mock, nothing proxies to Dex" '127\.0\.0\.1:5556' "${work}/Caddyfile.mock"
has "with the mock, the mock provider is served" \
  'reverse_proxy 127\.0\.0\.1:3002' "${work}/Caddyfile.mock"
has "with an external provider, /dex is a 404" 'handle /dex\* \{' "${work}/Caddyfile.external"
has "with an external provider, /mock-idp is a 404" 'handle /mock-idp\* \{' "${work}/Caddyfile.external"
lacks "with an external provider, nothing proxies to Dex" '127\.0\.0\.1:5556' "${work}/Caddyfile.external"
lacks "with an external provider, nothing proxies to the mock" '127\.0\.0\.1:3002' "${work}/Caddyfile.external"

echo ""
echo "--- The API is told which suffix Caddy serves ---"

has "PREVIEW_SUFFIX is written beside PUBLIC_URL" \
  '^PREVIEW_SUFFIX=\{\{ portikus_preview_suffix \}\}$' \
  "${REPO_ROOT}/infra/ansible/roles/portikus/templates/api.env.j2"

if command -v caddy >/dev/null; then
  echo ""
  for idp in dex mock external; do
    config="${rendered}"
    [ "${idp}" = dex ] || config="${rendered}.${idp}"
    if caddy validate --adapter caddyfile --config "${config}" >"${work}/validate.log" 2>&1; then
      ok "caddy validate accepts the configuration for ${idp}"
    else
      no "caddy validate accepts the configuration for ${idp}"
      cat "${work}/validate.log" >&2
    fi
  done
fi

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
