# Backlog

Work that is wanted but not yet scheduled as an epic or task. Each entry
says what, why, what it would take, and where it came from. Known gaps left
by landed work stay in `docs/STATUS.md`; move one here when it becomes
something we intend to build. Remove an entry when its work lands or when
it is rejected, and record the rejection in `docs/STACK.md` section 35.

## `apt install portikus` on a bring-your-own Debian 13 host

**What.** An operator with their own Debian 13 machine, virtual or bare
metal, runs one `apt install portikus`, edits a config file, and runs one
`portikus configure` command to get a working platform. Today the control
plane is one package but the host setup is nine Ansible roles driven from
a workstation, and the documented path starts from a libvirt VM
(`infra/README.md`, "Bring your own Debian host").

**Why.** The pilot runs in a VM we build, but the design is already
"Debian 13 host plus Ansible plus one package". Dedicated hardware is the
better fit for more than a handful of students, and nested virtualization
is only needed because the pilot puts containers inside a VM.

**What it would take** (about a week, in this order):

1. A variable audit of the roles (half a day, can be its own PR): the
   `deploy` account name, the two `/dev/vdb` checks in the smoke test, and
   the Makefile's `PORTIKUS_PUBLIC_HOST` default, all listed under "Limits
   today" in `infra/README.md`.
2. A signed apt repository published by CI from each release, with the
   signing key kept out of the repository. One day.
3. A `portikus configure` command that reads `/etc/portikus/portikus.yaml`
   (public URL, OIDC issuer and client id, administrator group, data block
   device, grace period, log level) plus a mode-0600 secrets file, and
   applies the existing roles against localhost by shipping them in the
   package with `ansible-core` as a dependency. Two to three days. Rewriting
   the roles in shell would be cleaner for operators but is a multi-week
   job; not worth it until a second deployment exists.
4. Package dependencies: `incus`, `postgresql-17`, `caddy`, `nftables`,
   `lvm2`, `zip`, and Node 24, which Debian 13 does not ship, so either
   bundle a runtime or depend on NodeSource. The workspace image becomes a
   release asset that `configure` downloads and imports by version. One day.
5. A fresh-Debian install test on this host. One day.

Commit to Debian 13 only. Ubuntu 24.04 lacks Incus in its archive and ships
PostgreSQL 16, so supporting it means external repositories for both.

**Source.** Todd, 2026-09-17, during the structured logging task. Schedule
after Epic 7; the pilot does not need it.

## Request rate limiting and journal sizing

**What.** A rate limit in Caddy for the API, and explicit journald
`SystemMaxUse` and per-service `RateLimit*` settings in the Ansible
`portikus` role.

**Why.** Nothing rate-limits login (known gap since Epic 4), and since
structured logging every 4xx writes a warn line, so a flood of bad
requests can evict older journal entries. Both fixes are small and belong
together.

**Source.** Security review of the structured logging task, 2026-09-17.
