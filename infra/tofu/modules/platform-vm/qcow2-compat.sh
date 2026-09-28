#!/usr/bin/env bash
# Upgrades the VM's qcow2 disks to compat 1.1 before the domain uses them.
# Called by OpenTofu (terraform_data.disk_compat) with LIBVIRT_URI, DOMAIN and
# DISKS (space-separated file paths) set. libvirt creates volumes as compat
# 0.10, where a guest discard frees nothing on the host when the image has a
# backing file, so the disk-as-file.xslt discard setting would do nothing.
set -euo pipefail

compat() {
  qemu-img info -U --output=json "$1" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["format-specific"]["data"]["compat"])'
}

old=()
for disk in $DISKS; do
  c=$(compat "$disk")
  if [ "$c" = 1.1 ]; then
    echo "qcow2-compat: ${disk} is already compat 1.1"
  else
    old+=("$disk")
  fi
done
[ "${#old[@]}" -eq 0 ] && exit 0

state=$(virsh -q -c "$LIBVIRT_URI" domstate "$DOMAIN" 2>/dev/null || echo absent)
if [ "$state" != absent ] && [ "$state" != "shut off" ]; then
  echo "qcow2-compat: ${old[*]} must be upgraded to compat 1.1, but ${DOMAIN} is ${state}." >&2
  echo "qcow2-compat: one-time fix: shut it down, apply again, then start it:" >&2
  echo "  virsh -c ${LIBVIRT_URI} shutdown ${DOMAIN}   # wait until 'virsh domstate ${DOMAIN}' says shut off" >&2
  echo "  make infra-apply   # with the same TOFU_ENV" >&2
  echo "  virsh -c ${LIBVIRT_URI} start ${DOMAIN}" >&2
  exit 1
fi

for disk in "${old[@]}"; do
  echo "qcow2-compat: upgrading ${disk} to compat 1.1"
  # The pool files belong to root or libvirt-qemu; only root can rewrite them.
  sudo -n qemu-img amend -f qcow2 -o compat=1.1 "$disk"
  c=$(compat "$disk")
  [ "$c" = 1.1 ] || { echo "qcow2-compat: ${disk} is still compat ${c}" >&2; exit 1; }
done
