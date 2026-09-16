variable "ssh_public_key" {
  description = "SSH public key for the deploy user. Set it in terraform.tfvars (git-ignored); see terraform.tfvars.example."
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
  description = "Name of the platform VM"
  type        = string
  default     = "portikus"
}

variable "vcpus" {
  description = "Number of virtual CPUs"
  type        = number
  default     = 4
}

variable "memory_mb" {
  description = "RAM in megabytes"
  type        = number
  default     = 8192
}

variable "os_disk_size_bytes" {
  description = "OS disk size in bytes"
  type        = number
  default     = 21474836480 # 20 GiB
}

variable "data_disk_size_bytes" {
  description = "Workspace-data disk size in bytes"
  type        = number
  default     = 107374182400 # 100 GiB
}

variable "base_image_url" {
  description = "URL or local path of the Debian 13 cloud image (qcow2)"
  type        = string
  default     = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2"
}

variable "base_image_sha512" {
  description = "SHA-512 checksum of the Debian cloud image"
  type        = string
  # Fetched from https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS
  # on 2026-09-16.
  default = "a733e7d49442a03e70d03e4eb5aaf3967f3efc69ef70952f9bb10fc1ee2c4876eb95956b5ad2d31350e5fada768feb651352535fb8cd1233f61998a5a7d2e93c"
}

variable "network_name" {
  description = "Libvirt network name"
  type        = string
  default     = "portikus"
}

variable "network_cidr" {
  description = "CIDR for the libvirt network"
  type        = list(string)
  default     = ["10.100.0.0/24"]
}

variable "pool_name" {
  description = "Libvirt storage pool name"
  type        = string
  default     = "portikus"
}

variable "pool_path" {
  description = "Path on the host for the libvirt storage pool"
  type        = string
  default     = "/var/lib/libvirt/images/portikus"
}
