# 0050. The off-site copy is pushed with a write-only key and pruned by the target

- **Status**: Accepted (Epic 34)
- **Date**: 2026-10-05
- **References**: SPEC.md section 24.9; ADR 0044; issue #1142

## Context

Backup sets on the server do not survive losing the server. An off-site
copy must also survive someone who breaks into the server, who could
otherwise use the copy's credentials to delete or replace it.

## Decision

The server pushes the newest complete, MAC-verified set every hour by
rsync over SSH (Secure Shell), with a dedicated key and a pinned host
key. The target's `authorized_keys` runs that key only through
`rrsync -wo` into an `incoming` folder, so it can add files but never
read, change or delete them. A prune script on the target, run from the
target's own crontab, moves finished sets in. It keeps the first set of
each UTC day, never replaces a set, and removes a set only once it is
more than KEEP days old with KEEP newer sets present.

## Consequences

- Protected: a copy already on the target survives a break-in until it
  is KEEP days old, and junk sets push genuine ones out at most one a
  day. The backup key is never sent, so the target cannot read the sets.
- Not protected: an attacker on the server can fill the target's disk
  (the operator should set a quota there), send garbage sets newer than
  the real ones, or backfill past days that have no kept set.
- The target needs `rrsync`: Debian 12 or later, or Ubuntu 24.04 or
  later.
