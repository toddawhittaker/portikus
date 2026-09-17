# 0010. Project operations run in the workspace agent

- **Status**: Accepted
- **Date**: 2026-09-17
- **References**: SPEC.md §7, §7.6, §12.5, §24.6, §26; STACK.md §10; ADR 0009

## Context

Epic 6 adds project management (SPEC §7): create, clone, instantiate from a
template, initialize Git, rename, duplicate, download, and archive. Every one
of those touches `~/projects` inside the student's container, and some of them
run `git`. The control plane has no way to run a command inside a workspace
except the Incus `exec` websocket, which ADR 0009 already rejected for
terminals. The workspace agent, on the other hand, already runs inside the
container as the `student` user behind a per-workspace bearer token.

## Decision

All project filesystem and Git work happens in the workspace agent, behind the
same token and the same path-confinement rule as terminals (SPEC §7.6). The
API brokers it: it owns authorization, the database, and the slug, and calls
the agent for everything on disk.

A project is a database row that mirrors a directory. The slug names the
directory (`~/projects/<slug>`) and is derived from the name. On every list the
API reconciles rows against what the agent sees: a Git directory with no row
gets one with `source = discovered`, and a row whose directory is gone comes
back with `missing: true`. Todd's rule is that anything Git-enabled under
`~/projects` is a project; other directories are ignored for now.

Rename changes the name, the slug, and the directory. The agent moves the
directory and the API rewrites the `cwd` prefix of that project's terminal rows
in the same transaction; running shells keep working because a process's
working directory follows the inode on Linux.

Archive is a database flag (`state`, `archived_at`) and writes an audit event.
The directory stays exactly where it is, which is what makes an archived
project recoverable by an administrator (SPEC §7.4). Unarchiving is a PATCH
back to active.

Download is a zip. The agent streams `zip -r -y` and the API pipes it to the
browser as `<slug>.zip`.

Templates are configuration, not data: one API environment variable
`PROJECT_TEMPLATES` of the form `name=url,name=url`. Instantiating one is a
clone with `.git` removed and `git init` run afterwards. The platform never
runs `git commit`, on any path (SPEC §12.5).

Per-project layout is one JSON column written by the browser: tab order plus
the split tree, last write wins, reconciled against the terminal list on every
refetch so a tree can never reference a terminal that no longer exists.

**Rejected alternatives:**

- Running project commands from the controller through Incus `exec`: a second
  execution path to secure and audit, with no home for the file and search
  APIs that Epics 7 and 8 need.
- Moving the directory to an `.archive` folder on archive: it breaks every
  open terminal and shell path in the project and gains nothing, since the row
  already hides the project from the active list.
- `tar.gz` for download: students on Windows and macOS open zip without
  installing anything.
- A templates table with an admin UI: nobody manages templates through the
  product yet, and an environment variable is one line of configuration.

## Consequences

- One trust boundary for project work instead of two. The agent's realpath
  check on `~/projects/<slug>` is the only thing standing between a slug and
  the rest of the filesystem, so it is a security requirement, not a detail.
- A project operation needs a running workspace. When the workspace is stopped
  the API answers 409 and the list still shows the rows it has, with
  `isGitRepo` and `missing` null.
- Discovery makes the directory the source of truth for existence and the row
  the source of truth for name, state, and layout. The two can disagree
  briefly; the list reconciles them.
- Clone runs inside the request with a five-minute bound, so a large repository
  holds a connection open and the student sees no progress until it finishes.
- Last-write-wins layout means two browser windows arranging the same project
  at once will settle on whichever wrote last, which is acceptable for a UI
  preference and would not be for project data.
