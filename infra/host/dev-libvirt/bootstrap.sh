#!/usr/bin/env bash
# Reference development-host bootstrap for Pop!_OS + KVM/libvirt.
# Verifies or installs the tooling listed in STACK.md section 18.
# Safe to rerun: each step checks whether its prerequisite is already met.
set -euo pipefail

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }
fail()  { printf '\033[1;31m[fail]\033[0m  %s\n' "$1"; exit 1; }

# ---------- helpers ----------

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 is already installed"
    return 1
  fi
  return 0
}

# ---------- KVM capability ----------

info "Checking KVM support"
if [ ! -e /dev/kvm ]; then
  fail "/dev/kvm not found. Enable hardware virtualisation in BIOS/UEFI."
fi
ok "KVM is available"

# ---------- apt packages ----------

PACKAGES=(
  qemu-kvm
  libvirt-daemon-system
  libvirt-clients
  virtinst
  bridge-utils
  genisoimage          # cloud-init NoCloud ISO
  python3
  python3-pip
  python3-venv
  make
)

info "Checking apt packages"
MISSING=()
for pkg in "${PACKAGES[@]}"; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    MISSING+=("$pkg")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  info "Installing missing packages: ${MISSING[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING[@]}"
  ok "Apt packages installed"
else
  ok "All apt packages already installed"
fi

# ---------- libvirt service ----------

info "Ensuring libvirtd is running"
if ! systemctl is-active --quiet libvirtd; then
  sudo systemctl enable --now libvirtd
fi
ok "libvirtd is active"

# ---------- User in libvirt group ----------

if ! groups "$USER" | grep -qw libvirt; then
  info "Adding $USER to libvirt group (re-login required for effect)"
  sudo usermod -aG libvirt "$USER"
else
  ok "$USER is in the libvirt group"
fi

# ---------- OpenTofu ----------

TOFU_VERSION="1.9.0"

if need_cmd tofu; then
  info "Installing OpenTofu ${TOFU_VERSION}"
  # Use the official install script (https://opentofu.org/docs/intro/install/)
  curl -fsSL https://get.opentofu.org/install-opentofu.sh -o /tmp/install-opentofu.sh
  chmod +x /tmp/install-opentofu.sh
  /tmp/install-opentofu.sh --install-method deb --opentofu-version "${TOFU_VERSION}"
  rm -f /tmp/install-opentofu.sh
  ok "OpenTofu installed"
fi

# ---------- Ansible ----------

if need_cmd ansible-playbook; then
  info "Installing Ansible via pipx"
  if ! command -v pipx >/dev/null 2>&1; then
    sudo apt-get install -y -qq pipx
  fi
  pipx install --include-deps ansible
  ok "Ansible installed"
fi

# ---------- age ----------

if need_cmd age; then
  info "Installing age"
  sudo apt-get install -y -qq age
  ok "age installed"
fi

# ---------- SOPS ----------

SOPS_VERSION="3.9.4"

if need_cmd sops; then
  info "Installing SOPS ${SOPS_VERSION}"
  SOPS_DEB="sops_${SOPS_VERSION}_amd64.deb"
  curl -fsSL "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/${SOPS_DEB}" \
    -o "/tmp/${SOPS_DEB}"
  sudo dpkg -i "/tmp/${SOPS_DEB}"
  rm -f "/tmp/${SOPS_DEB}"
  ok "SOPS installed"
fi

# ---------- cloud-image tooling ----------

if ! dpkg -s cloud-image-utils >/dev/null 2>&1; then
  info "Installing cloud-image-utils"
  sudo apt-get install -y -qq cloud-image-utils
  ok "cloud-image-utils installed"
else
  ok "cloud-image-utils already installed"
fi

# ---------- Summary ----------

echo ""
info "Bootstrap complete. Installed tool versions:"
printf "  %-20s %s\n" "qemu"      "$(qemu-system-x86_64 --version | head -1)"
printf "  %-20s %s\n" "libvirtd"  "$(libvirtd --version 2>&1)"
printf "  %-20s %s\n" "tofu"      "$(tofu version 2>/dev/null | head -1)"
printf "  %-20s %s\n" "ansible"   "$(ansible --version 2>/dev/null | head -1)"
printf "  %-20s %s\n" "age"       "$(age --version 2>/dev/null)"
printf "  %-20s %s\n" "sops"      "$(sops --version 2>/dev/null)"

echo ""
info "If you were just added to the libvirt group, log out and back in."
