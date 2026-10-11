# 0061. Package removal stops what setup wrote, and purge deletes it, with three deliberate keeps

- **Status**: Accepted (Epic 44)
- **Date**: 2026-10-11
- **References**: SPEC.md sections 21.12, 24.2; ADRs 0029, 0059; issues #1477, #1296

## Context

Setup writes systemd units and drop-ins into `/etc/systemd/system` that
the Debian package does not own. After `apt remove` they kept running or
pointed at the removed `portikus-alert@` template. A reinstall followed by
setup has to bring everything back, so nothing may be lost that setup
cannot rewrite.

## Decision

- **Remove.** `postrm` stops and disables each Portikus unit and deletes
  the two alert drop-ins (Caddy and PostgreSQL are never stopped).
- **Purge.** Also deletes the unit files, the other drop-ins,
  `/etc/portikus-workspace-proxy` and the site's `/etc/hosts` line (only
  lines ending in `# portikus site address`).
- **Kept on remove: boot units.** Storage attach and the workspace limits
  load what Incus needs at boot. Remove keeps data and configuration, so
  they stay enabled. Purge disables and deletes them.
- **Kept on purge: the `docker-registry` mask.** Without it Debian's
  registry would listen on every interface.
- **Kept on purge: the nftables drop-in** `10-portikus.conf`. Without it
  Debian's nftables stop flushes every table, Incus's included.
- **One list, tested.** `packaging/tests/prerm-units-test.sh` checks the
  list in both directions against the paths the Ansible roles write.

## Consequences

- Purge still leaves Squid's include folder and the helpers in
  `/usr/local/sbin` (#1492).
- A new unit written by a role fails the test until it is added to the
  list.
