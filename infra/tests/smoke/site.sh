#!/usr/bin/env bash
# The site's public address and the HTTP helpers every later file uses.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

PUBLIC_HOST="${PORTIKUS_PUBLIC_HOST:-portikus.${VM}.nip.io}"
# The default name only works where Caddy was told to serve it, so say so
# rather than letting every HTTPS check fail for a reason nobody can see.
if [ -z "${PORTIKUS_PUBLIC_HOST:-}" ]; then
  printf '\033[1;33mWARN\033[0m  PORTIKUS_PUBLIC_HOST is unset: the HTTPS checks will use %s. If Caddy on this VM serves a different name, set PORTIKUS_PUBLIC_HOST and run again.\n' "${PUBLIC_HOST}"
fi
# The port Caddy serves the site on. It is 8443 on the pilot host, because
# another service there owns 443.
PUBLIC_PORT="${PORTIKUS_PUBLIC_PORT:-443}"
if [ "${PUBLIC_PORT}" = "443" ]; then
  PUBLIC_AUTHORITY="${PUBLIC_HOST}"
else
  PUBLIC_AUTHORITY="${PUBLIC_HOST}:${PUBLIC_PORT}"
fi
API="https://${PUBLIC_AUTHORITY}"
# The API's loopback port, used where a request has to reach the API itself
# rather than whatever Caddy decides to serve for that path.
API_PORT="${PORTIKUS_API_PORT:-3000}"
# Caddy signs with its own internal authority, so every request has to
# trust the root certificate the Ansible caddy role copied here.
CURL="curl -s --cacert /etc/portikus/caddy-root.crt"
# The session cookie is named for the __Host- prefix, which browsers only
# accept on a secure, host-scoped, path-/ cookie.
SESSION_COOKIE_NAME="__Host-portikus_session"

# http_status USER URL [EXTRA_CURL_ARGS]
# USER is a user whose cookie jar is sent, or "-" for anonymous.
# EXTRA_CURL_ARGS is one string, quoted for the remote shell.
http_status() {
  local user="$1" url="$2" extra="${3:-}" jar=""
  [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
  ssh_cmd "${CURL} ${jar} ${extra} -o /dev/null -w '%{http_code}' '${url}'"
}

# vm_get USER URL [EXTRA_CURL_ARGS] — prints the response body.
vm_get() {
  local user="$1" url="$2" extra="${3:-}" jar=""
  [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
  ssh_cmd "${CURL} ${jar} ${extra} '${url}'"
}

# A response header of the site root matches the given grep pattern.
site_header_matches() {
  ssh_cmd "${CURL} -I '${API}/'" | grep -qi -- "$1"
}
