#!/usr/bin/env bash
# A stand-in for a Cloudflare Tunnel connector (cloudflared) in front of the
# rehearsal VM, on this host, in Docker with the Caddy image (docs/SPEC.md
# section 21.12).  Like cloudflared it ends the browser's TLS, then connects
# to the VM's port 443 over HTTPS with the request's host name as SNI,
# verifies the VM's certificate, passes Host unchanged and sets
# CF-Connecting-IP to the address the browser connected from.
#
# It has its own Docker network so it can listen on 443 whatever else this
# host serves there.  Browsers on this host reach it at STANDIN_IP; Docker
# masquerades its connections to the VM, so the VM sees this host's address
# on the rehearsal network, which is what trusted_proxies must list.
#
# Usage:
#   standin-proxy.sh up VM_IP VM_ROOT_CRT NAME...  NAME is a host name or *.<suffix>
#   standin-proxy.sh root OUT    the stand-in's own root certificate, for clients
#   standin-proxy.sh down
set -euo pipefail

NET=portikus-standin
SUBNET=172.31.76.0/24
STANDIN_IP=172.31.76.10
CONTAINER=portikus-standin
# An exact tag, like every other pinned version here.
IMAGE=caddy:2.11.4

up() {
  local vm_ip="$1" root="$2" dir names
  shift 2
  names=$(printf 'https://%s, ' "$@")
  dir="${XDG_RUNTIME_DIR:-/tmp}/portikus-standin"
  mkdir -p "$dir"
  cp "$root" "${dir}/vm-root.crt"
  cat >"${dir}/Caddyfile" <<EOF
{
	admin off
	local_certs
	skip_install_trust
	auto_https disable_redirects
}
${names%, } {
	tls internal
	reverse_proxy https://${vm_ip}:443 {
		header_up Host {http.request.host}
		header_up CF-Connecting-IP {http.request.remote.host}
		transport http {
			tls_server_name {http.request.host}
			tls_trust_pool file /etc/standin/vm-root.crt
		}
		flush_interval -1
		stream_close_delay 1h
	}
	log
}
EOF
  docker network inspect "$NET" >/dev/null 2>&1 \
    || docker network create --subnet "$SUBNET" \
      -o com.docker.network.bridge.gateway_mode_ipv4=nat-unprotected "$NET" >/dev/null
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --network "$NET" --ip "$STANDIN_IP" \
    -v "${dir}:/etc/standin:ro" "$IMAGE" caddy run --config /etc/standin/Caddyfile >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$CONTAINER" test -s /data/caddy/pki/authorities/local/root.crt 2>/dev/null && return 0
    sleep 1
  done
  docker logs "$CONTAINER" | tail -20
  return 1
}

case "${1:-}" in
  up) shift; up "$@" ;;
  root) docker exec "$CONTAINER" cat /data/caddy/pki/authorities/local/root.crt >"$2" ;;
  down) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up VM_IP VM_ROOT_CRT NAME... | root OUT | down" >&2; exit 2 ;;
esac
