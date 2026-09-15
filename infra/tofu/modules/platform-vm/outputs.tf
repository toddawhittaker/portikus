output "vm_id" {
  description = "Libvirt domain ID"
  value       = libvirt_domain.vm.id
}

output "vm_ip" {
  description = "IP address leased to the VM (first interface)"
  value       = libvirt_domain.vm.network_interface[0].addresses
}

output "data_disk_id" {
  description = "Libvirt volume ID of the workspace-data disk"
  value       = libvirt_volume.data_disk.id
}
