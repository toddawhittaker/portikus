# 0020. Recovery archives live on a recovery volume, made by the workspace agent

- **Status**: Accepted
- **Date**: 2026-09-22
- **References**: SPEC.md sections 12.5, 15, 19.1, 19.2, 24.6, 24.9;
  STACK.md sections 9 and 10; ADR 0005, ADR 0010, ADR 0019

## Context

SPEC.md section 15 asks for compressed copies of each project, kept outside
the project, made periodically and before destructive actions, bounded by a
quota, and restorable without touching Git. Section 19 makes Recovery its
own storage class with its own limit (3 GiB by default). Three pilot
workspaces already exist, their root filesystems do not rebase onto a new
image (section 22.1), and the image has no `zstd` binary.

## Decision

Each workspace gets a third custom Incus volume, `<instance>-recovery`,
sized from `WORKSPACE_RECOVERY_SIZE_GIB` and mounted at
`/var/lib/portikus/recovery`, owned by uid 1000, mode 0700. The controller
adds it to an existing workspace at its next start, and a failure there is
logged and does not fail the start. A separate volume enforces the
Recovery limit by itself and survives a rebuild with no special handling.

Archives are `/var/lib/portikus/recovery/<projectId>/<pointId>.tar.zst`,
mode 0600, keyed by project id so a rename does not orphan them. Each has a
`recovery_points` row with its size, SHA-256, tree fingerprint, reason, and
expiry.

The workspace agent makes and restores archives, as it does every other
filesystem operation (ADR 0010). It walks the project with `lstat`, never
following links, applies the SPEC 15.5 default exclusions and
`.workspaceignore` (matched with the `ignore` npm package), and pipes GNU
`tar --null -T - --no-recursion` through Node 24's built-in
`zlib.createZstdCompress`. `.git` and Git-ignored files such as `.env` are
included. Making a point runs no Git command at all.

A fingerprint over the sorted path, type, size, mtime, mode, and link
target of every included entry lets a periodic check skip an unchanged
project with no watcher state. Restore checks the SHA-256, refuses absolute
or `..` members, extracts into a staging directory under `~/projects` whose
name discovery ignores, and moves the entries into the existing project
directory, whose inode is the project's identity.

User-triggered creates and restores run in the API request; the worker runs
periodic points, `before-rebuild` points, and retention in a loop separate
from the one-second reconcile loop. The agent's per-project lock answers
`BUSY` when the two race.

## Consequences

No image rebuild is needed, and the format is still `tar.zst`. Node's zstd
is marked experimental in Node 24; a round-trip test in CI pins it. If it
ever fails, the fallback is adding `zstd` to the image for new roots and
gzip for old ones.

Including `.git` makes an agent's `git reset --hard` or `rm -rf .git`
recoverable, at the cost of allowance; a student can exclude `.git/` in
`.workspaceignore`.

The student has passwordless sudo, so a student or a coding agent can
delete the recovery directory. Recovery points guard against ordinary
accidents, not a deliberate root action inside the student's own
container. Platform backups are SPEC.md section 25.5 and Epic 12. The
SHA-256 check means a tampered archive is refused, never restored.

An archive written just before an API crash, with no row, stays on the
volume as an orphan. It is rare and bounded by the volume size; a later
epic can reconcile files against rows.
