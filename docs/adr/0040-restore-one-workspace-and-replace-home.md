# 0040. Restoring one workspace into a side copy, and replacing a home

- **Status**: Accepted (Epic 24)
- **Date**: 2026-09-27
- **References**: SPEC.md sections 17.2 and 24.9; ADRs 0021, 0024 and 0039; issue #730

## Context

Until now a backup could only be restored whole, by the operator, with
`restore.sh` on the host (ADR 0024). An administrator wants to give one
student their files back from the admin page. The VM must never write to
the host, so the host pulls work from the VM (ADR 0039 describes the host
half). Two things were asked for: a copy of the old files next to the live
ones, and, when that is not enough, the whole home put back, with a way to
undo it.

## Decision

**The VM half of the channel.** `sudo portikus backup-channel pull` and
`sudo portikus backup-channel report` run `backup-channel-main.js` from the
worker's package as the worker's own user (`portikus-worker` since
Epic 15.1; `portikus` before it) with the worker's settings, as
`reset-admin` does for the API. `pull` first fails any host request claimed
more than 15 minutes ago that the host's last status does not name as
running ("interrupted"), then claims the oldest pending host request and
prints it as one JSON line, or prints nothing. `report` reads one JSON
document of at most 256 KiB on standard input, checks it with Zod, stores
the status whole, and finishes the request it names only if that request is
claimed. It writes the outcome audit row with actor `host` and, for a
finished side copy, the student's notification. The API writes neither.

**A side copy** is a host request. While the host runs it, `pull` holds a
presence row for the workspace, and the worker's backup loop keeps that row
fresh, so the grace period cannot stop the workspace under the copy. The
report, or the interruption, removes the row.

**Pre-change snapshots and kept homes** are VM work. A worker loop, every
30 seconds, runs waiting deletes through the controller one at a time,
audits each with actor `worker`, and lists what remains into
`backup_status.vm`. A delete of something already gone counts as done, so a
delete left claimed by a worker that died is simply run again.

**Replace home** is a pending operation, `replace-home`, run like Rebuild
(ADR 0021). A running workspace first gets a `before-replace-home` recovery
point of each active project and is stopped. The worker then records an
`import_home` request, keeps its id in `pending_operation_args`, and waits
across sweeps while the host imports the set's home volume as
`<instance>-home-import`. When the import is done, the controller swaps the
volumes and keeps the old home as `<instance>-home-replaced-<unix seconds>`.
A controller that is unreachable or slow is asked again on the next sweep;
a retry after a swap that had already finished finds the import gone and
takes the kept home named at or after the operation began as its result.
The workspace starts again if it was meant to be running. The student is
notified whether it worked or not.

**What a failure leaves.** A failed import leaves the workspace as it was,
with its home untouched. A swap that fails part-way leaves the workspace in
error with a message for the student, as a failed Rebuild does; the kept
home and the import volume are still there for the operator.

## Consequences

- The student can undo a replace alone, project by project, with the
  recovery points. The whole previous home is kept until an administrator
  deletes it; putting it back is a runbook step, not a button.
- A replace keeps the workspace stopped for as long as the host's import
  takes, which can be minutes.
- If the host dies during a side copy, the presence row stays fresh until
  the next `pull` marks the request interrupted, so that workspace does not
  stop for its grace period in the meantime.

## Rejected

- **Writing the side copy from the VM.** The VM never holds the key or
  decrypted data (ADR 0039).
- **Recording the import request in the API.** The worker records it after
  the workspace has stopped, so the host never imports while the old home is
  still in use.
