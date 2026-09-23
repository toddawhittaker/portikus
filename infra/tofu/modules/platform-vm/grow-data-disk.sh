#!/usr/bin/env bash
# Grows the platform VM's data disk in place to SIZE_BYTES; never shrinks it.
# Called by OpenTofu (terraform_data.data_disk_size) with LIBVIRT_URI, DOMAIN,
# POOL, VOLUME and SIZE_BYTES set.
set -euo pipefail

virsh_() { virsh -q -c "$LIBVIRT_URI" "$@"; }
capacity() { virsh_ vol-info --bytes --pool "$POOL" "$VOLUME" | awk '$1 == "Capacity:" { print $2 }'; }

current=$(capacity)
if [ -z "$current" ]; then
  echo "grow-data-disk: cannot read the size of ${VOLUME} in pool ${POOL}" >&2
  exit 1
fi
if [ "$SIZE_BYTES" -lt "$current" ]; then
  echo "grow-data-disk: refusing to shrink ${VOLUME} from ${current} to ${SIZE_BYTES} bytes; set data_disk_size_bytes back to at least ${current}" >&2
  exit 1
fi
if [ "$SIZE_BYTES" -eq "$current" ]; then
  echo "grow-data-disk: ${VOLUME} is already ${current} bytes"
  exit 0
fi

# A running VM must be told through QEMU, so the guest sees the new size at once.
if [ "$(virsh_ domstate "$DOMAIN")" = running ]; then
  virsh_ blockresize "$DOMAIN" "$(virsh_ vol-path --pool "$POOL" "$VOLUME")" "${SIZE_BYTES}B"
else
  virsh_ vol-resize --pool "$POOL" "$VOLUME" "${SIZE_BYTES}B"
fi

now=$(capacity)
if [ "$now" != "$SIZE_BYTES" ]; then
  echo "grow-data-disk: ${VOLUME} is ${now} bytes after the resize, not ${SIZE_BYTES}" >&2
  exit 1
fi
echo "grow-data-disk: grew ${VOLUME} from ${current} to ${SIZE_BYTES} bytes"
