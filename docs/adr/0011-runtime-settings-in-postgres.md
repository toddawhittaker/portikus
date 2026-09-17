# 0011. Runtime settings live in Postgres

- **Status**: Accepted
- **Date**: 2026-09-17
- **References**: STACK.md §7; SPEC.md §6.4, §20.1; ADR 0006

## Context

The disconnect grace period (SPEC §6.4) was an environment variable read
once at worker start. Changing it during a class meant editing
`/etc/portikus/worker.env` and restarting the worker, which needs a shell
on the VM. Administrators need to change it from the browser, set it to
"never stop", and give one student a different value from everyone else.

## Decision

Settings an administrator changes while the platform runs live in
Postgres, not in the environment. There is one `settings` row holding
`shutdown_grace_seconds`, plus an optional override per user.
`SHUTDOWN_GRACE_SECONDS` only seeds that row on the worker's first start,
so a restart never overwrites the administrator's value.

The worker keeps a `disconnected_at` timestamp on each workspace and
recomputes `shutdown_deadline` from it on every sweep, using the user's
override or the platform value. A change therefore applies at once, even
to a workspace already counting down, and the deadline stays a durable
column as in ADR 0006.

**Rejected alternatives:**

- Re-reading the environment file on each sweep: still needs a shell to
  edit, still has no per-user value, and gives the API nothing to write.
- Restarting the worker on every change: interrupts an unrelated sweep
  and needs the API to be allowed to restart a system service.
- A general key-value settings table: one typed row is enough for one
  setting, and a typed column lets the database reject a negative value.

## Consequences

- Administrators change the grace period from `/admin` with no restart,
  and 0 means the timer is never armed.
- The worker runs one extra statement per sweep, writing
  `shutdown_deadline` only where the value would change.
- Each new runtime setting is a column and a migration, which is
  deliberate friction against adding them casually.
