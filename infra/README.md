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

## 6. Build the workspace image

Build the distrobuilder-based workspace image on the VM and import it into
Incus. The recipe lives in `infra/workspace-image/`.

```
make build-workspace-image
```

This rsyncs the image definition to the VM, runs distrobuilder, and imports
the result into the `portikus` Incus project. Re-runs replace the previous
image.

## 7. Verify

```
make smoke-test
```

The Epic 2 and Epic 3 blocks of the smoke test need the workspace image,
so build it first; without it those blocks are skipped, not failed.

## 8. Create a test workspace

```
make workspace-create NAME=alice
```

Destroy it when done:

```
make workspace-destroy NAME=alice
```

## 9. Deploying the control plane

The control plane ships as a versioned Debian package named `portikus`
(ADR 0007). The package contains the prebuilt API, worker, and workspace
controller, and it owns the two service users, `/etc/portikus`,
`/var/lib/portikus`, and the three systemd units. Ansible installs the
package and renders only the environment files and the controller token.

`make configure-vm` therefore deploys the control plane; there is no
separate build step on the VM, and the VM has no build toolchain.

### Release and rollback

**How a release is produced.** A release is published when an epic branch
merges into `main`, or by running the Release workflow by hand from `main`.
It builds the package and publishes it as a GitHub release with two
assets: the package and a `SHA256SUMS` file holding its checksum.
The version is derived from the repository and looks like `0.1.123+gabc1234`:
the release number, the commit count, and the short commit hash. The package
asset is named `portikus_<version>_amd64.deb`.

**How a version is deployed.** Run:

```
make configure-vm
```

Ansible asks GitHub for the newest release, downloads that release's
`SHA256SUMS` file and its `.deb` asset to `/var/cache/portikus`, checks the
package against the checksum from `SHA256SUMS`, and installs it. Nothing in
the repository has to be edited to deploy a new release. The checksum is
what makes the install reproducible: a version string only names an asset,
while the checksum guarantees the bytes that get installed.

**How to roll back.** Run:

```
make configure-vm PORTIKUS_VERSION=<previous-version>
```

That installs exactly that release instead of the newest one, with its own
checksum from the same release. The install task allows downgrades, so this
replaces the running version with the older one. The override is not
recorded anywhere, so the next plain `make configure-vm` rolls forward
again; revert or fix the bad commit rather than leaving a host pinned by
hand.

If the control plane is broken badly enough that you cannot run Ansible,
install the older package on the VM by hand:

```
gh release download v<previous-version> -p '*.deb'
sudo apt-get install -y --allow-downgrades ./portikus_<previous-version>_amd64.deb
```

**Testing a branch on a fresh VM.** A branch has no published release, so
build the package and hand Ansible the file:

```
make build-deb
make rebuild-pilot PORTIKUS_DEB=dist/deb/portikus_<version>_amd64.deb
make smoke-test
```

`PORTIKUS_DEB` works on `make configure-vm` too, and `make rebuild-pilot`
passes it through because it calls `configure-vm`. On a VM that already
exists, `make deploy-app` is the quicker path.

**Development path.** `make deploy-app` builds the package on your
workstation and installs it on the VM directly. It does not go through a
release, so use it only while developing. The next `make configure-vm` puts
the newest release back.

The three systemd units (`portikus-api`, `portikus-worker`,
`portikus-controller`) are enabled by the package but will not start until
their environment file exists (guarded by `ConditionPathExists`). Ansible
renders those files and starts the units, after which they start on boot.

There is no `make db-migrate`. Database migrations run from the
`portikus-api` unit's `ExecStartPre`, so they are applied when the service
starts.

The units run with `ProtectSystem=strict`, so the filesystem is read-only
apart from the paths they are explicitly given. A future service that has
to write under `/var/lib/portikus` should be granted a `ReadWritePaths`
entry for the directory it needs, not a weaker `ProtectSystem`.

`/var/lib/portikus` is a shared parent directory. The package creates it
but never removes it, even on purge, because the image builder
(`image-build`, `images`) and the workspace script (`incus`) keep their
own state under it. Purging the package removes `/etc/portikus` only.

Service configuration lives in `/etc/portikus/*.env`. To override a
variable for testing without changing the Ansible-managed file, create
the corresponding `.override.env` file (for example,
`/etc/portikus/worker.override.env` with `SHUTDOWN_GRACE_SECONDS=20`).

## Destroy and recreate

```
make destroy-pilot
```

Then repeat from step 3. User data on the data disk is destroyed when the
VM is destroyed; persistent-data backup and restore is a later epic.
