# 0004. Build distrobuilder from source

- **Status**: Accepted
- **Date**: 2026-09-15
- **References**: STACK.md section 25, SPEC.md section 21.8

## Context

Portikus uses distrobuilder to produce reproducible Incus workspace images.
Debian 12 (bookworm) does not package distrobuilder, and neither does the
Zabbly Incus repository. The alternatives are a static binary download, a
container-based build, or building from source with Go.

Go 1.23 is available in bookworm-backports without pulling in packages from
a later Debian release. Building from source pins the exact distrobuilder
version in the Ansible role and needs no third-party binary trust beyond the
Go module proxy.

The tagged release v3.3.1 does not compile: its go.mod pins
filepath-securejoin 0.6, which moved two functions that the pinned podman
storage library still expects. Upstream main fixed both dependencies, so we
build from a pinned commit on main instead of the tag.

The pinned commit's go.mod declares Go 1.25, which is newer than the
bookworm-backports Go. Setting GOTOOLCHAIN=auto lets the backports Go
bootstrap a download of the exact toolchain version go.mod names, verified
against Go's checksum database.

## Decision

Install Go from bookworm-backports (apt pin limited to `golang*` packages)
and clone the distrobuilder repository at a pinned commit (variable
`image_builder_distrobuilder_commit` in `infra/ansible/site.yml`). Build
with `go install ./distrobuilder` and `GOTOOLCHAIN=auto`. The Ansible role
writes a marker file recording the installed commit and skips the build
when it already matches, so runs are idempotent. Build dependencies
(`build-essential`, `pkg-config`, `libgpgme-dev`, `libbtrfs-dev`) are
installed alongside the existing debootstrap/rsync/squashfs-tools set.

## Consequences

- The first Ansible run takes a few minutes longer to compile distrobuilder.
  Subsequent runs skip the build.
- GOTOOLCHAIN=auto downloads the Go toolchain binary on first build; the
  download is cached in GOPATH and reused on subsequent runs.
- Upgrading distrobuilder means changing the commit hash in site.yml and
  verifying the build still compiles.
- When the platform VM moves to a Debian release that packages
  distrobuilder, the backports source and Go build can be replaced by a
  simple apt install.
