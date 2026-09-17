#!/usr/bin/env bash
# Publish the pilot VM's Caddy ports (80, 443) from the host's LAN address.
# Only the gateway ports are forwarded; workspaces stay unreachable (SPEC.md 23.4).
# Usage: publish-vm.sh <vm-ip> | publish-vm.sh --remove
set -euo pipefail

CHAIN=PORTIKUS_PUBLISH
UNIT=portikus-publish-vm.service
UNIT_PATH="/etc/systemd/system/${UNIT}"
STATE_DIR=/etc/portikus-host
STATE_FILE="${STATE_DIR}/vm-ip"
INSTALLED=/usr/local/sbin/portikus-publish-vm

info() { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
ok()   { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }
fail() { printf '\033[1;31m[fail]\033[0m  %s\n' "$1" >&2; exit 1; }

# Both read the host's default route rather than hard-coding the LAN details.
lan_field() {
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk -v key="$1" '{for (i = 1; i < NF; i++) if ($i == key) { print $(i + 1); exit }}'
}

# Remove every copy of the jump, then add one, so reruns cannot stack rules.
reset_jump() {
  local table=$1 parent=$2
  while sudo iptables -t "$table" -D "$parent" -j "$CHAIN" 2>/dev/null; do :; done
  sudo iptables -t "$table" -I "$parent" 1 -j "$CHAIN"
}

reset_chain() {
  local table=$1
  sudo iptables -t "$table" -N "$CHAIN" 2>/dev/null || true
  sudo iptables -t "$table" -F "$CHAIN"
}

drop_chain() {
  local table=$1 parent=$2
  while sudo iptables -t "$table" -D "$parent" -j "$CHAIN" 2>/dev/null; do :; done
  sudo iptables -t "$table" -F "$CHAIN" 2>/dev/null || true
  sudo iptables -t "$table" -X "$CHAIN" 2>/dev/null || true
}

remove_all() {
  drop_chain nat PREROUTING
  drop_chain filter FORWARD
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

  local lan_if
  lan_if=$(lan_field dev)
  [ -n "$lan_if" ] || fail "could not work out the LAN interface from the default route"
  info "publishing ${vm_ip} ports 80 and 443 on interface ${lan_if}"

  reset_chain nat
  sudo iptables -t nat -A "$CHAIN" -i "$lan_if" -p tcp -m multiport --dports 80,443 \
    -j DNAT --to-destination "$vm_ip"
  reset_jump nat PREROUTING

  reset_chain filter
  sudo iptables -t filter -A "$CHAIN" -i "$lan_if" -d "$vm_ip" -p tcp \
    -m multiport --dports 80,443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  sudo iptables -t filter -A "$CHAIN" -o "$lan_if" -s "$vm_ip" \
    -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Ahead of libvirt's FORWARD rules, which reject new traffic into the NAT bridge.
  reset_jump filter FORWARD

  install_unit "$vm_ip" "$source"
  ok "the VM answers on ports 80 and 443 at $(lan_field src)"
}

main "$@"
