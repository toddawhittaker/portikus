#!/usr/bin/env bash
# The preview edge in Caddy.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# BROWSER-HANDLING.md 7.1, 10 and 12.
# These checks need only Caddy, not a preview session, so they run whether
# or not the control plane is up.
echo "--- Preview edge ---"

PREVIEW_SUFFIX="${PORTIKUS_PREVIEW_SUFFIX:-preview.${PUBLIC_HOST}}"
PREVIEW_HOST="smoke-5173.${PREVIEW_SUFFIX}"
if [ "${PUBLIC_PORT}" = "443" ]; then
  PREVIEW_AUTHORITY="${PREVIEW_HOST}"
else
  PREVIEW_AUTHORITY="${PREVIEW_HOST}:${PUBLIC_PORT}"
fi
# The VM resolves the application host to loopback but knows nothing about
# preview names, so point curl at loopback by hand.
PREVIEW_RESOLVE="--resolve ${PREVIEW_HOST}:${PUBLIC_PORT}:127.0.0.1"

preview_status() { # PATH [EXTRA_CURL_ARGS]
  ssh_cmd "${CURL} ${PREVIEW_RESOLVE} ${2:-} -o /dev/null -w '%{http_code}' 'https://${PREVIEW_AUTHORITY}$1'"
}

# A wildcard certificate from the internal authority covers every preview
# name, so curl's verification succeeds without -k.
check "wildcard TLS is served for a preview host" \
  ssh_cmd "${CURL} ${PREVIEW_RESOLVE} -o /dev/null 'https://${PREVIEW_AUTHORITY}/__portikus/nothing'"
check_output "an unknown reserved path is 404 from Caddy" "404" \
  preview_status /__portikus/nothing
check "the preview host is not the application site" \
  ssh_cmd "! ${CURL} ${PREVIEW_RESOLVE} -I 'https://${PREVIEW_AUTHORITY}/' | grep -qi frame-ancestors"
unauthorized_preview_is_refused() {
  [ "$(preview_status /)" != "200" ]
}
check "an unauthorized preview request is never served" unauthorized_preview_is_refused
# Caddy's admin interface can load any configuration, so only root and the
# caddy user may reach it: a socket, and no loopback port.
CADDY_ADMIN="--max-time 5 -o /dev/null --unix-socket /var/lib/caddy/admin.sock http://localhost/config/"
check "nothing listens on Caddy's old admin port 2019" \
  ssh_cmd "! ss -Htln 'sport = :2019' | grep -q ."
check "root reaches Caddy's admin socket (control)" \
  ssh_cmd "sudo curl -sf ${CADDY_ADMIN}"
check "the portikus account cannot open Caddy's admin socket" \
  ssh_cmd "! sudo runuser -u portikus -- curl -s ${CADDY_ADMIN}"
check "an unprivileged account cannot open Caddy's admin socket" \
  ssh_cmd "! sudo runuser -u nobody -- curl -s ${CADDY_ADMIN}"
echo ""
