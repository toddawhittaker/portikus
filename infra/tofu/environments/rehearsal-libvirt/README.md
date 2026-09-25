# Rehearsal VM

A second platform VM, `portikus-rehearsal`, on the same host as the live
pilot. Restore, rebuild and load exercises run here, so the pilot is never
touched (docs/archive/epics/EPIC-12B.md, "Decisions").

It shares nothing with the pilot's `dev-libvirt` environment:

| | Pilot (`dev-libvirt`) | Rehearsal (`rehearsal-libvirt`) |
|---|---|---|
| VM | `portikus`, 4 vCPUs, 8 GiB | `portikus-rehearsal`, 12 vCPUs, 24 GiB by default |
| Libvirt network | `portikus`, 10.100.0.0/24 | `portikus-rehearsal`, 10.101.0.0/24 |
| Storage pool | `/var/lib/libvirt/images/portikus` | `/var/lib/libvirt/images/portikus-rehearsal` |
| OpenTofu state | in this repository's `dev-libvirt` directory | `~/.local/state/portikus/rehearsal-libvirt/terraform.tfstate` |
| Published on the LAN | yes, port 8443 | never |

The state lives outside the repository so that every Git worktree sees the
same VM, and removing a worktree cannot leave the VM without its state.

## Use

The shell needs the `libvirt` group. Until you log in again after
`make bootstrap-host`, wrap each command in `sg libvirt -c '...'`.

```
make rehearsal-up                      # create it and wait for first boot
make configure-vm TOFU_ENV=rehearsal-libvirt
make build-workspace-image TOFU_ENV=rehearsal-libvirt   # a new VM has no image
make smoke-test   TOFU_ENV=rehearsal-libvirt
make rehearsal-destroy                 # remove the VM, disks, network and pool
```

The play makes the local administrator and prints how to read its
one-time password (`sudo cat /etc/portikus/admin-password` on the VM). A
restore brings Dex's accounts from the set's
`dex.dump` instead. For this VM the Makefile sets `PORTIKUS_USERS_FILE`
to a path that does not exist, so the play never imports the pilot's
retired users file: the accounts it would create make `make restore`
refuse the VM. `make rebuild-exercise` needs a set that holds `dex.dump`.

Every other VM target (`configure-vm`, `deploy-app`, `smoke-test`,
`security-test`, `wait-vm`) takes `TOFU_ENV=rehearsal-libvirt` and then reads
the rehearsal VM's address from its state. `ssh deploy@<address>` works with
your `~/.ssh/id_ed25519` key.

- `rehearsal-up` refuses to create the VM when the host has less free memory
  than the VM's size. Pass `REHEARSAL_MEMORY_MB=<MiB>` and
  `REHEARSAL_VCPUS=<n>` for a smaller VM; keep the same values on later runs,
  or OpenTofu will replace the VM with one of the new size.
- `REHEARSAL_DATA_DISK_GB=<GiB>` grows the data disk in place; `make
  configure-vm TOFU_ENV=rehearsal-libvirt` then grows the thin pool. It
  defaults to the size in the state, or 100 GiB for a new VM. The disk never
  shrinks: a smaller value than the disk's size fails the apply.
- `REHEARSAL_SSH_KEY=<file>` picks another public key for the `deploy` user.
- `configure-vm` uses the pilot's own site name and port by default, so a
  restored pilot database matches. Caddy's role resolves that name to
  loopback on the VM, and the smoke test runs its checks on the VM, so
  nothing reaches the pilot.
- `publish-vm` refuses this environment: port 8443 belongs to the pilot.
- Destroy the VM when an exercise ends if it holds restored student data.
