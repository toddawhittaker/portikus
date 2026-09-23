# 0022. Operational metrics live in PostgreSQL, not OpenTelemetry

- **Status**: Accepted
- **Date**: 2026-09-22
- **References**: STACK.md section 15, SPEC.md sections 24.11, 25.6 and 25.10, ADR 0006, ADR 0012, docs/EPIC-11.md

## Context

SPEC.md section 25.6 asks administrators to see platform health: host load,
memory, storage-pool use, workspace states, whether the controller and the
workspace agents answer, and recent failures. STACK.md section 15 said to use
OpenTelemetry "where practical", and ADR 0012 said metrics would arrive with
Epic 11.

The pilot is one VM. Nothing scrapes a metrics endpoint or receives traces,
and the administrator page is where an operator looks. Only the worker holds
the controller's token (ADR 0006), so the API cannot ask the controller for
host facts itself.

## Decision

- Every 60 seconds the worker asks the controller for one host snapshot and
  writes it to the `health_samples` table, which keeps 7 days. A row is
  written even when the controller does not answer, so the age of the newest
  row is also the worker's heartbeat.
- Failure counts are counts over `audit_events`, which already records
  workspace lifecycle failures, controller outages and sign-in failures.
  Preview refusals (403 answers from the edge check) are added as
  `preview.denied`, at most one row per workspace and reason per minute with
  a `count`.
- `GET /admin/health` reads the newest sample, fifteen-minute maxima over the
  last day, workspace counts by state, and the 24-hour audit counts, and it
  probes each running workspace's agent in parallel with a 2-second timeout.
- There is no OpenTelemetry SDK and no Prometheus endpoint.

## Consequences

- No new dependency, process or port. The data sits in the database that is
  already backed up and already guarded.
- Nothing outside the platform can alert on these numbers. An operator has
  to open the administrator page.
- `audit_events` grows without a limit; the throttle and the indexes from
  migration 0014 keep that manageable for the pilot, and retention is a
  backlog item.
- OpenTelemetry export is worth adding when a second VM or an external
  monitor exists. The samples and counts would then feed it rather than be
  replaced by it.
