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

## Decision

Install Go from bookworm-backports (apt pin limited to `golang*` packages)
and build distrobuilder v3.3.1 with `go install`. The Ansible role checks
the installed version and skips the build when it already matches, so runs
are idempotent.

## Consequences

- The first Ansible run takes a few minutes longer to compile distrobuilder.
  Subsequent runs skip the build.
- Upgrading distrobuilder means changing the version string in the Ansible
  role.
- When the platform VM moves to a Debian release that packages
  distrobuilder, the backports source and Go build can be replaced by a
  simple apt install.
