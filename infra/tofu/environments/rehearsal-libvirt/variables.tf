# Defaults size the VM for the 25-workspace load test. The Makefile passes
# REHEARSAL_VCPUS and REHEARSAL_MEMORY_MB, whose defaults match these.

variable "ssh_public_key" {
  description = "SSH public key for the deploy user. make rehearsal-up passes ~/.ssh/id_ed25519.pub (REHEARSAL_SSH_KEY)."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) ", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key line, e.g. the contents of ~/.ssh/id_ed25519.pub."
  }
}

variable "libvirt_uri" {
  description = "Libvirt connection URI"
  type        = string
  default     = "qemu:///system"
}

variable "vm_name" {
  description = "Name of the rehearsal VM"
  type        = string
  default     = "portikus-rehearsal"

  validation {
    condition     = var.vm_name != "portikus"
    error_message = "vm_name must differ from the pilot's name, portikus."
  }
}

variable "vcpus" {
  description = "Number of virtual CPUs"
  type        = number
  default     = 12
}

variable "memory_mb" {
  description = "RAM in megabytes"
  type        = number
  default     = 24576
}

variable "os_disk_size_bytes" {
  description = "OS disk size in bytes"
  type        = number
  default     = 21474836480 # 20 GiB
}

variable "data_disk_size_bytes" {
  description = "Workspace-data disk size in bytes (sparse qcow2)"
  type        = number
  default     = 107374182400 # 100 GiB
}

variable "base_image_url" {
  description = "URL or local path of the Debian 13 cloud image (qcow2)"
  type        = string
  default     = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2"
}

variable "base_image_sha512" {
  description = "SHA-512 checksum of the Debian cloud image; keep equal to dev-libvirt's"
  type        = string
  default     = "a733e7d49442a03e70d03e4eb5aaf3967f3efc69ef70952f9bb10fc1ee2c4876eb95956b5ad2d31350e5fada768feb651352535fb8cd1233f61998a5a7d2e93c"
}

variable "mac_address" {
  description = "MAC address of the VM's network interface. make passes the one in the state, so a replaced VM keeps it; empty on a new VM."
  type        = string
  default     = ""
}

variable "network_name" {
  description = "Libvirt network name"
  type        = string
  default     = "portikus-rehearsal"

  validation {
    condition     = var.network_name != "portikus"
    error_message = "network_name must differ from the pilot's network, portikus."
  }
}

variable "network_cidr" {
  description = "CIDR for the libvirt network"
  type        = list(string)
  default     = ["10.101.0.0/24"]

  validation {
    condition     = !contains(var.network_cidr, "10.100.0.0/24")
    error_message = "network_cidr must not be the pilot's network, 10.100.0.0/24."
  }
}

variable "pool_name" {
  description = "Libvirt storage pool name"
  type        = string
  default     = "portikus-rehearsal"

  validation {
    condition     = var.pool_name != "portikus"
    error_message = "pool_name must differ from the pilot's pool, portikus."
  }
}

variable "pool_path" {
  description = "Path on the host for the libvirt storage pool"
  type        = string
  default     = "/var/lib/libvirt/images/portikus-rehearsal"

  validation {
    condition     = var.pool_path != "/var/lib/libvirt/images/portikus"
    error_message = "pool_path must differ from the pilot's pool path."
  }
}
