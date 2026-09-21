#!/usr/bin/env bash
# Tests the preview virtual host in the Caddy role's template
# (docs/BROWSER-HANDLING.md sections 7.1, 8, 10, 12, 13 and 16.5).
#
# It renders infra/ansible/roles/caddy/templates/Caddyfile.j2 with the
# pilot's variables and asserts the properties the preview edge depends on.
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

rendered="${work}/Caddyfile"
ansible localhost -c local -m ansible.builtin.template \
  -a "src=${TEMPLATE} dest=${rendered} mode=0644" \
  -e "portikus_public_host=${PUBLIC_HOST}" \
  -e "portikus_preview_suffix=${PREVIEW_SUFFIX}" \
  -e "portikus_public_port=${PUBLIC_PORT}" \
  -e "portikus_api_port=${API_PORT}" \
  -e '{"portikus_mock_idp": false}' \
  -e "portikus_mock_idp_port=3002" >"${work}/render.log" 2>&1 || {
  echo "error: rendering ${TEMPLATE} failed" >&2
  cat "${work}/render.log" >&2
  exit 1
}

# Split the rendered file into the application block and the preview block,
# so each set of assertions can only see its own virtual host.
awk -v out="${work}" '
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
echo "--- Application virtual host is unchanged ---"

has "the control plane still refuses to be framed" "frame-ancestors 'none'" "${app}"
has "the control plane is still compressed" '^[[:space:]]+encode gzip$' "${app}"
lacks "the control plane has no preview routes" '__portikus' "${app}"

echo ""
echo "--- The API is told which suffix Caddy serves ---"

has "PREVIEW_SUFFIX is written beside PUBLIC_URL" \
  '^PREVIEW_SUFFIX=\{\{ portikus_preview_suffix \}\}$' \
  "${REPO_ROOT}/infra/ansible/roles/portikus/templates/api.env.j2"

if command -v caddy >/dev/null; then
  echo ""
  if caddy validate --adapter caddyfile --config "${rendered}" >"${work}/validate.log" 2>&1; then
    ok "caddy validate accepts the rendered configuration"
  else
    no "caddy validate accepts the rendered configuration"
    cat "${work}/validate.log" >&2
  fi
fi

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
