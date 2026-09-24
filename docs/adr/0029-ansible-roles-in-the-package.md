# 0029. `apt install portikus` ships the Ansible roles and runs them locally

- **Status**: Proposed
- **Date**: 2026-09-24
- **References**: STACK.md sections 22, 30 and 31; SPEC.md section 21;
  docs/EPIC-15.md rulings 5 to 13; ADR 0007

## Context

The control plane is one Debian package (ADR 0007), but the host around
it (Incus, LVM storage, the firewall, PostgreSQL, Caddy, Dex, the egress
proxy, the workspace image) is a set of Ansible roles run from a
workstation. An operator with a rented Debian 13 server should need only
`apt install portikus`. The setup takes many minutes, installs packages
from other repositories, and can erase a disk.

## Decision

The package ships `site.yml`, the roles and the pinned collections under
`/usr/share/portikus/ansible` and depends on Debian's `ansible-core`.
`portikus setup` runs the play against the local host with
`/etc/portikus/portikus.yaml` and a root-only secrets file as extra
variables, whose keys are the play's own variable names. debconf asks the
few questions that cannot be guessed and writes those files.

postinst never runs the play itself. When the answers are complete it
starts `portikus-setup.service`, a root oneshot, without waiting, and
says how to follow it. The play's apt tasks wait for the dpkg lock that
the outer apt releases when it finishes.

Node 24 is bundled in the package, so the package installs from Debian
and the Portikus repository alone.

## Consequences

- One implementation of host setup serves both the pilot, from the
  workstation, and a packaged install.
- The roles run under Debian's `ansible-core`, which may differ from the
  workstation's; the fresh-install test catches that.
- A Node security fix needs a Portikus release.
- Rejected: rewriting the roles in shell (clearer, but weeks of work and
  a second copy to keep in step); running the play inside postinst (it
  would wait forever on the dpkg lock, and die with the operator's SSH
  session); depending on NodeSource (a second repository to trust before
  apt can resolve the package).
