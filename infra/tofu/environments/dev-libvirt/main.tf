# Dev-libvirt environment — Pop!_OS + KVM/libvirt reference deployment.
# Wires provider-specific values into the platform-vm module.
# See STACK.md sections 17, 19, 20.

terraform {
  required_version = ">= 1.9.0"

  # Pilot: encrypted local state (STACK.md section 20).
  # Move to a remote backend when the deployment grows beyond one admin.
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "libvirt" {
  uri = var.libvirt_uri
}

module "platform_vm" {
  source = "../../modules/platform-vm"

  vm_name              = var.vm_name
  vcpus                = var.vcpus
  memory_mb            = var.memory_mb
  os_disk_size_bytes   = var.os_disk_size_bytes
  data_disk_size_bytes = var.data_disk_size_bytes
  base_image_url       = var.base_image_url
  cloud_init_user_data = file("${path.module}/../../cloud-init/user-data.yml")
  network_name         = var.network_name
  network_cidr         = var.network_cidr
  pool_name            = var.pool_name
  pool_path            = var.pool_path
}
