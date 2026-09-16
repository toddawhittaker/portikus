# 0007. Debian package for the control plane

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: STACK.md §21, §22, §31; SPEC.md §21

## Context

The platform VM is cattle (SPEC §21): rebuildable from source control plus
restored data, with Ansible as the convergence layer (STACK §22) behind the
Make targets in STACK §31. Epic 3 shipped the first real services, and at
that point `make deploy-app` copied the source tree to the VM and built it
there: a toolchain on the VM, a non-reproducible deploy, and no way back.

## Decision

The control plane is distributed as a versioned Debian package. CI runs the
pnpm production build and packs it with `nfpm` into a `.deb`. The `portikus`
Ansible role installs that package at a pinned version.

The package owns the service users, `/etc/portikus`, `/var/lib/portikus`, and
the three systemd units. Ansible owns only the deployment-specific part: the
environment files and secrets it renders.

**Rejected alternatives:**

- Docker on the platform VM: it rewrites the host packet filter, blurs the
  Incus socket boundary, and is awkward for the preview gateway.
- Rsync the source and build on the VM (the Epic 3 path): needs a build
  toolchain on the VM and offers no rollback.

An `.rpm` is out of scope until a non-Debian host is supported. `nfpm` can
emit one from the same configuration when that day comes.

## Consequences

- Deploying is installing a version; rolling back is installing the last one.
- CI has to build and publish the package, and versions must be managed.
- `make deploy-app` now builds the package locally and installs it on the
  VM, which keeps one install path for development and production.
