output "vm_ip" {
  description = "IP address(es) of the rehearsal VM"
  value       = module.platform_vm.vm_ip
}

output "management_cidr" {
  description = "CIDR of the rehearsal libvirt network"
  value       = var.network_cidr[0]
}
