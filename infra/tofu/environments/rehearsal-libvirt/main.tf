# Rehearsal-libvirt environment: a second platform VM beside the pilot, for
# restore, rebuild and load exercises (docs/EPIC-12B.md, "Decisions").
# It has its own network, pool and state, and is never published.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    libvirt = {
      source  = "dmacvicar/libvirt"
      version = "~> 0.8.0"
    }
  }

  # `make rehearsal-up` passes -backend-config=path=<file outside the repo>,
  # so every worktree shares one state and removing a worktree cannot orphan
  # the VM.
  backend "local" {}
}

provider "libvirt" {
  uri = var.libvirt_uri
}

module "platform_vm" {
  source = "../../modules/platform-vm"

  libvirt_uri          = var.libvirt_uri
  vm_name              = var.vm_name
  vcpus                = var.vcpus
  memory_mb            = var.memory_mb
  os_disk_size_bytes   = var.os_disk_size_bytes
  data_disk_size_bytes = var.data_disk_size_bytes
  base_image_url       = var.base_image_url
  base_image_sha512    = var.base_image_sha512
  cloud_init_user_data = templatefile("${path.module}/../../../cloud-init/user-data.yml", {
    hostname       = var.vm_name
    ssh_public_key = var.ssh_public_key
  })
  mac_address  = var.mac_address
  network_name = var.network_name
  network_cidr = var.network_cidr
  pool_name    = var.pool_name
  pool_path    = var.pool_path
}
