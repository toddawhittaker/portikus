#!/usr/bin/env bash
# Publish the pilot VM's Caddy port from the host's LAN address.  The host
# keeps 80 and 443 for another service, so the gateway lives on 8443.
# Only that one port is forwarded; workspaces stay unreachable (SPEC.md 23.4).
# Usage: publish-vm.sh <vm-ip> | publish-vm.sh --remove
set -euo pipefail

CHAIN=PORTIKUS_PUBLISH
# Traffic the host itself generates never passes the prerouting hook, so the
# local forward needs its own chain on the output hook.
LOCAL_CHAIN=PORTIKUS_PUBLISH_LOCAL
# The gateway port, on the host and inside the VM alike: Caddy serves it
# there, so the URLs the API builds work from inside the VM too.
PORT=8443
UNIT=portikus-publish-vm.service
UNIT_PATH="/etc/systemd/system/${UNIT}"
STATE_DIR=/etc/portikus-host
STATE_FILE="${STATE_DIR}/vm-ip"
INSTALLED=/usr/local/sbin/portikus-publish-vm
CADDY_ROOT=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

info() { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
ok()   { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }
fail() { printf '\033[1;31m[fail]\033[0m  %s\n' "$1" >&2; exit 1; }

# Both read the host's default route rather than hard-coding the LAN details.
lan_field() {
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk -v key="$1" '{for (i = 1; i < NF; i++) if ($i == key) { print $(i + 1); exit }}'
}

# First global address on an interface, for routes that carry no src.
lan_addr() {
  ip -4 -o addr show dev "$1" scope global 2>/dev/null \
    | awk 'NR == 1 {split($4, a, "/"); print a[1]}'
}

# Remove every copy of the jump, then add one, so reruns cannot stack rules.
reset_jump() {
  local table=$1 parent=$2 chain=$3
  while sudo iptables -t "$table" -D "$parent" -j "$chain" 2>/dev/null; do :; done
  sudo iptables -t "$table" -I "$parent" 1 -j "$chain"
}

reset_chain() {
  local table=$1 chain=$2
  sudo iptables -t "$table" -N "$chain" 2>/dev/null || true
  sudo iptables -t "$table" -F "$chain"
}

drop_chain() {
  local table=$1 parent=$2 chain=$3
  while sudo iptables -t "$table" -D "$parent" -j "$chain" 2>/dev/null; do :; done
  sudo iptables -t "$table" -F "$chain" 2>/dev/null || true
  sudo iptables -t "$table" -X "$chain" 2>/dev/null || true
}

remove_all() {
  drop_chain nat PREROUTING "$CHAIN"
  drop_chain nat OUTPUT "$LOCAL_CHAIN"
  drop_chain filter FORWARD "$CHAIN"
  if [ -f "$UNIT_PATH" ]; then
    sudo systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    sudo rm -f "$UNIT_PATH"
    sudo systemctl daemon-reload
  fi
  sudo rm -f "$STATE_FILE" "$INSTALLED"
  sudo rmdir "$STATE_DIR" 2>/dev/null || true
  ok "the pilot VM is no longer published on the LAN"
}

install_unit() {
  local vm_ip=$1 source=$2
  sudo install -d -m 0755 "$STATE_DIR"
  printf '%s\n' "$vm_ip" | sudo tee "$STATE_FILE" >/dev/null
  # Boot must not depend on the repository checkout being present.
  sudo install -m 0755 "$source" "$INSTALLED"
  sudo tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=Publish the Portikus pilot VM on the host LAN address
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'exec ${INSTALLED} "\$(cat ${STATE_FILE})"'

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable "$UNIT" >/dev/null
  ok "installed ${UNIT} so the rules come back after a reboot"
}

# An embedded preview cannot show a certificate warning, so the browser has to
# trust Caddy's internal root before any Preview tab works.
cert_hint() {
  local vm_ip=$1
  info "trust the VM's certificate authority in the browser (repeat after a VM rebuild):"
  cat <<EOF
    ssh deploy@${vm_ip} sudo cat ${CADDY_ROOT} > /tmp/portikus-caddy-root.crt
    certutil -d sql:\$HOME/.pki/nssdb -D -n portikus-caddy-root 2>/dev/null
    certutil -d sql:\$HOME/.pki/nssdb -A -t C,, -n portikus-caddy-root -i /tmp/portikus-caddy-root.crt
EOF
  info "that trusts the pilot's authority for every site in that browser profile, and its private key lives on the VM that runs student workspaces, so use a throwaway browser profile for the pilot rather than your everyday one"
}

main() {
  local source
  source=$(readlink -f "$0")

  if [ "${1:-}" = "--remove" ]; then
    remove_all
    return
  fi

  local vm_ip=${1:-}
  [ -n "$vm_ip" ] || fail "usage: $(basename "$0") <vm-ip> | --remove"
  [[ $vm_ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "not an IPv4 address: ${vm_ip}"

  local lan_if lan_ip
  lan_if=$(lan_field dev)
  [ -n "$lan_if" ] || fail "could not work out the LAN interface from the default route"
  lan_ip=$(lan_field src)
  # Some VPN and bonded setups leave no src on the default route.
  [ -n "$lan_ip" ] || lan_ip=$(lan_addr "$lan_if")
  [ -n "$lan_ip" ] || fail "could not work out the LAN address from the default route or from ${lan_if}"
  info "publishing ${vm_ip} port ${PORT} on interface ${lan_if}"

  reset_chain nat "$CHAIN"
  sudo iptables -t nat -A "$CHAIN" -i "$lan_if" -p tcp --dport "$PORT" \
    -j DNAT --to-destination "$vm_ip"
  reset_jump nat PREROUTING "$CHAIN"

  # The same forward for connections the host itself makes, so preview names
  # that resolve through nip.io to the LAN address work here with no
  # /etc/hosts lines.
  reset_chain nat "$LOCAL_CHAIN"
  sudo iptables -t nat -A "$LOCAL_CHAIN" -d "$lan_ip" -p tcp --dport "$PORT" \
    -j DNAT --to-destination "$vm_ip"
  reset_jump nat OUTPUT "$LOCAL_CHAIN"

  reset_chain filter "$CHAIN"
  sudo iptables -t filter -A "$CHAIN" -i "$lan_if" -d "$vm_ip" -p tcp \
    --dport "$PORT" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  sudo iptables -t filter -A "$CHAIN" -o "$lan_if" -s "$vm_ip" \
    -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Ahead of libvirt's FORWARD rules, which reject new traffic into the NAT bridge.
  reset_jump filter FORWARD "$CHAIN"

  install_unit "$vm_ip" "$source"
  ok "the VM answers on port ${PORT} at ${lan_ip}, from the LAN and from this host"
  cert_hint "$vm_ip"
}

main "$@"
