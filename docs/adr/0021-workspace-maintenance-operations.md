# 0021. Reset Docker and Rebuild are pending operations the worker drives

- **Status**: Accepted
- **Date**: 2026-09-22
- **References**: SPEC.md sections 16.4, 17.2, 22.3, 24.11, 27;
  STACK.md sections 7 and 9; ADR 0005, ADR 0006

## Context

SPEC.md section 16.4 asks for a Reset Docker that discards Docker data and
keeps projects, and section 17.2 for a rebuild that replaces the root
filesystem and keeps home, projects, and optionally Docker. Both need the
workspace stopped. ADR 0006 makes the worker the only writer of a
workspace's `state`, and section 27 asks for explicit asynchronous states.

## Decision

The API records the request in `workspaces.pending_operation`, one of
`reset-docker`, `rebuild`, or `rebuild-reset-docker`, with who asked and
when, and answers 202. A second request while one is set gets 409
`OPERATION_PENDING`. Reset Docker is open to the owner and administrators,
at `POST /workspaces/:id/reset-docker`. Rebuild is for administrators only,
at `POST /admin/workspaces/:id/rebuild` with body `{ resetDocker }`.

The worker drives the rest. A running workspace with a pending operation is
stopped without changing `desired_state`; a rebuild first makes a
`before-rebuild` recovery point of each active project. Once the workspace
is `stopped` or `error`, the worker calls the controller, clears the
operation, records the new image fingerprint after a rebuild, audits the
result, and lets the ordinary start step bring the workspace back if
`desired_state` is `running`. That start step skips rows with a pending
operation. A rebuild also runs from `error`, because it is the repair path
of section 17.1; it needs the instance to exist.

In the controller, Reset Docker reads the stopped instance, writes it back
without the `docker` device using an ETag-guarded update, deletes the
volume named exactly `<validated name>-docker`, creates a new one at
`WORKSPACE_DOCKER_SIZE_GIB`, and puts the device back. It aborts if the
`home` device is missing from what it read. Each step is idempotent, so a
retry finishes a half-done reset. Rebuild calls Incus's
`POST /1.0/instances/<name>/rebuild` with the current image alias; the
instance keeps its own devices, so `home`, `docker`, and `recovery` stay,
and Docker is reset the same way first when asked. Both controller routes
refuse a running instance with 409.

## Consequences

Lifecycle stays in one writer, and the pending state is visible to the UI
as "Resetting Docker…" or "Rebuilding…". Reset and rebuild run inside the
serial reconcile loop, so a slow Incus call delays other workspaces'
timers; on LVM thin both take seconds and are rare, which is acceptable for
the pilot. A new Docker volume picks up the current quota, but existing
volumes are not resized in place (Epic 11). Re-creating a workspace whose
instance is gone stays a backlog item. The device update is the most
dangerous code in the epic, so it is unit-tested to keep the `home` and
`recovery` devices exactly and is first run only on a throwaway workspace.
