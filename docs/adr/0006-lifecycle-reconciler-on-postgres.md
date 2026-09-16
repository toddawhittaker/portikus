# 0006. Lifecycle reconciler on Postgres

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: STACK.md §7; SPEC.md §6.4, §6.5, §25.3, §25.4, §27

## Context

Workspace lifecycle requires a disconnect grace timer (SPEC §6.5) and a
reconciliation loop that drives state transitions. STACK.md §7 requires
that timers survive process restarts ("no in-memory timers"). We need a
durable mechanism for tracking lifecycle state and scheduling the
graceful shutdown.

## Decision

Lifecycle state lives in the `workspaces` row. The worker runs a
one-second reconcile loop and is the only process that calls the
controller and writes `state`. The API writes `desired_state` and
presence rows. The disconnect grace timer is a `shutdown_deadline`
column: when active connections drop to zero the worker sets the
deadline, and when a connection reappears it clears it. The deadline
is durable across restarts because it is a timestamp in the database.

**Rejected alternative:**

- pg-boss: adds a second schema, a polling table, and its own retry
  semantics before we have any job that needs them. Deferred until
  rebuild or recovery jobs require retries.

## Consequences

- The worker is the single writer for `state`, eliminating race
  conditions between the API and the worker on state transitions.
- Grace timers survive crashes and restarts with no recovery logic
  beyond the normal reconcile sweep.
- Start latency increases by up to one second (the reconcile interval)
  compared to a synchronous call, well within the 10-second p95 budget.
- State transitions use conditional updates (`WHERE state = <from>`)
  so concurrent sweeps cannot double-act.
