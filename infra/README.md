# Portikus Pilot Infrastructure

End-to-end steps to create the platform VM from a fresh Pop!_OS host.
See STACK.md sections 16 through 24 and 27 through 33 for design rationale.

## Prerequisites

A Pop!_OS machine with hardware virtualisation (KVM) enabled in BIOS/UEFI.

## 1. Bootstrap the host

Installs KVM, libvirt, OpenTofu, Ansible, age, SOPS, and supporting packages.

```
make bootstrap-host
```

If `make` itself is missing, run the script directly; it installs make
along with everything else:

```
bash infra/host/dev-libvirt/bootstrap.sh
```

## 2. Prepare secrets

Generate an age key pair and update `infra/secrets/.sops.yaml` with the
public key. Then copy the OpenTofu variables example and put your SSH
public key in it. The copy is git-ignored, so the key never sits in a
tracked file.

```
age-keygen -o infra/secrets/age-key.txt
cp infra/tofu/environments/dev-libvirt/terraform.tfvars.example \
   infra/tofu/environments/dev-libvirt/terraform.tfvars
$EDITOR infra/tofu/environments/dev-libvirt/terraform.tfvars
```

## 3. Create the platform VM

Review the plan, then apply it.

```
make infra-plan
make infra-apply
```

OpenTofu creates the Debian VM with two virtual disks (OS and data),
a libvirt NAT network, and a cloud-init ISO for first boot.

## 4. Wait for cloud-init

The VM boots and runs cloud-init, which installs Python and creates the
`deploy` user. VNC is disabled for security; use the serial console to
watch boot progress if needed:

```
virsh console portikus
```

Alternatively, wait for the SSH port to open.

## 5. Configure the VM with Ansible

The VM address is read from the OpenTofu output automatically; pass
`VM_IP=<ip>` only to override it.

```
make configure-vm
```

This installs Incus, creates the LVM thin pool on the data disk, sets
up the workspace network, profile, and project, and applies the firewall.

## 6. Verify

```
make smoke-test
```

## Destroy and recreate

```
make destroy-pilot
```

Then repeat from step 3. User data on the data disk is destroyed when the
VM is destroyed; persistent-data backup and restore is a later epic.
