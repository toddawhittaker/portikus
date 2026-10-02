output "vm_ip" {
  description = "IP address leased to the VM (first interface)"
  value       = libvirt_domain.vm.network_interface[0].addresses
}
