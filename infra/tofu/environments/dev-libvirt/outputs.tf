output "vm_ip" {
  description = "IP address(es) of the platform VM"
  value       = module.platform_vm.vm_ip
}

output "management_cidr" {
  description = "CIDR of the libvirt management network"
  value       = var.network_cidr[0]
}
