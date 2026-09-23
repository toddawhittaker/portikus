# Variables for the platform VM module (STACK.md sections 19, 23).
# The module declares what Portikus needs; the environment wires
# provider-specific values.

variable "libvirt_uri" {
  description = "Libvirt connection URI, for growing the data disk"
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
  description = "URL of the Debian cloud image (qcow2)"
  type        = string
}

variable "base_image_sha512" {
  description = "SHA-512 checksum of the base image file"
  type        = string
}

variable "base_image_cache_path" {
  description = "Local path to cache the verified base image"
  type        = string
  # Must be writable by the operator running tofu (the download runs as
  # them); libvirt reads it as root when importing the volume.
  default = "~/.cache/portikus/debian-13-generic-amd64.qcow2"
}

variable "cloud_init_user_data" {
  description = "cloud-init user-data as a string"
  type        = string
}

variable "cloud_init_network_config" {
  description = "cloud-init network-config as a string (optional)"
  type        = string
  default     = ""
}

variable "mac_address" {
  description = "MAC address of the VM's network interface; empty lets libvirt pick one"
  type        = string
  default     = ""
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
