# Platform VM module — libvirt provider (STACK.md sections 19, 23).
#
# Resources: network, storage pool, base image volume, OS disk,
# workspace-data disk, cloud-init ISO, and the VM itself.

terraform {
  required_providers {
    libvirt = {
      source  = "dmacvicar/libvirt"
      version = "~> 0.8"
    }
  }
}

# ── Storage pool ────────────────────────────────────────────────

resource "libvirt_pool" "portikus" {
  name = var.pool_name
  type = "dir"

  target {
    path = var.pool_path
  }
}

# ── Network ─────────────────────────────────────────────────────

resource "libvirt_network" "portikus" {
  name      = var.network_name
  mode      = "nat"
  autostart = true
  addresses = var.network_cidr
}

# ── Base image ──────────────────────────────────────────────────

resource "libvirt_volume" "base_image" {
  name   = "${var.vm_name}-base.qcow2"
  pool   = libvirt_pool.portikus.name
  source = var.base_image_url
  format = "qcow2"
}

# ── OS disk (backed by the base image) ──────────────────────────

resource "libvirt_volume" "os_disk" {
  name           = "${var.vm_name}-os.qcow2"
  pool           = libvirt_pool.portikus.name
  base_volume_id = libvirt_volume.base_image.id
  size           = var.os_disk_size_bytes
  format         = "qcow2"
}

# ── Workspace-data disk (blank, formatted inside the VM) ────────

resource "libvirt_volume" "data_disk" {
  name   = "${var.vm_name}-data.qcow2"
  pool   = libvirt_pool.portikus.name
  size   = var.data_disk_size_bytes
  format = "qcow2"
}

# ── cloud-init ISO ──────────────────────────────────────────────

resource "libvirt_cloudinit_disk" "init" {
  name           = "${var.vm_name}-cloudinit.iso"
  pool           = libvirt_pool.portikus.name
  user_data      = var.cloud_init_user_data
  network_config = var.cloud_init_network_config != "" ? var.cloud_init_network_config : null
}

# ── VM ──────────────────────────────────────────────────────────

resource "libvirt_domain" "vm" {
  name   = var.vm_name
  vcpu   = var.vcpus
  memory = var.memory_mb

  cloudinit = libvirt_cloudinit_disk.init.id

  cpu {
    mode = "host-passthrough"
  }

  network_interface {
    network_id     = libvirt_network.portikus.id
    wait_for_lease = true
  }

  disk {
    volume_id = libvirt_volume.os_disk.id
  }

  disk {
    volume_id = libvirt_volume.data_disk.id
  }

  console {
    type        = "pty"
    target_type = "serial"
    target_port = "0"
  }

  # No VNC listener — use `virsh console portikus` for serial access.
  # Leaving a VNC socket open without authentication is a security risk.
  graphics {
    type        = "vnc"
    listen_type = "none"
  }
}
