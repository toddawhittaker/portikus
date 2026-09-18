# 0013. The file API lives in the workspace agent, with conditional writes

- **Status**: Accepted
- **Date**: 2026-09-18
- **References**: SPEC.md §11.1, §11.2, §13.2, §13.5, §24.6; STACK.md §10; ADR 0010

## Context

Epic 7 needs to read, write, create, move, delete and upload files inside a
student's container. ADR 0010 already put project operations in the workspace
agent, so the place is settled; what was not settled is how a write avoids
losing work. Autosave, a coding agent and a second browser window can all
write the same file, and SPEC §13.5 says stale browser content must never
silently overwrite a newer version on disk.

## Decision

Every file route is on the workspace agent behind the existing per-workspace
token, and the control plane relays it for the workspace owner only.

A file's version is the SHA-256 hash of its content, sent as an ETag. A write
must carry exactly one of `If-Match: <etag>` to overwrite the version the
browser last read, or `If-None-Match: *` to create a file that does not exist
yet. A mismatch is a 412 carrying the current ETag, which is what the editor's
conflict bar acts on. Bodies are raw bytes in and out, so the same route
serves a 2 MiB source file and a 50 MiB upload without a JSON round trip.

A write streams into a temporary file in the same directory, opened with
`O_EXCL` and `O_NOFOLLOW`, and only a whole body reaches the target: an
overwrite ends with `rename`, a create ends with `link`, which fails rather
than replacing a file that appeared meanwhile. A half-finished upload
therefore never truncates the file it was replacing.

Confinement is one rule: resolve the path with `realpath` and refuse unless
the result is inside the realpath of `~/projects/<slug>`. For a file that does
not exist yet, the parent is resolved instead and the final component is
checked to be a plain name. Three caps are fixed constants in
`packages/contracts`: 2 MiB for a file the editor opens or saves, 50 MiB for
an upload, and 2,000 entries for one directory listing.

**Rejected alternatives:**

- Modification times as versions: two writes inside one millisecond are
  indistinguishable, and clocks in a container are not something to bet a
  student's work on.
- JSON-wrapped bodies: base64 costs a third more bytes and forces the whole
  file into memory on both ends.
- Writing in place: a failed or interrupted write leaves a truncated file,
  which is the one outcome a data-safety feature must not produce.
- A file cache in the control plane: it would be a second source of truth for
  content the agent already owns, and every filesystem event would have to
  invalidate it.

## Consequences

Conditional writes make the conflict case explicit rather than silent, and the
browser can always tell an overwrite from a create. The cost is one hash of
the whole file per read and per write, which is cheap at 2 MiB and is the
reason the editor cap exists. Temporary files are written beside the target,
so a project on a full disk fails the write rather than corrupting the file,
and a crash can leave a dot-prefixed temporary file behind. The caps are
compile-time constants: raising one is a release, not a setting.
