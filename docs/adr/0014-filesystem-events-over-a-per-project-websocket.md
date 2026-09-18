# 0014. Filesystem events over a per-project WebSocket

- **Status**: Accepted
- **Date**: 2026-09-18
- **References**: SPEC.md §11.3, §11.4, §12.1, §25.1; STACK.md §5, §10; ADR 0009

## Context

SPEC §11.4 says changes made by a coding agent, a shell command, Git, an
upload or a second browser must appear in the tree promptly. The Epic 6 tree
had no live channel at all, and the Git decorations of §12.1 need the same
signal, since polling `git status` on a timer is both slow to notice a change
and expensive on a large repository.

## Decision

The workspace agent watches each open project with chokidar and pushes batches
over a WebSocket at `/projects/:slug/events`. One watcher per project root is
shared by every subscriber.

`followSymlinks` is off, so a link out of the project is never walked, and the
generated and dependency directories of §11.3 are excluded, which is what
keeps the inotify watch count and the event rate reasonable on a repository
with `node_modules` in it. Changes are collected for 150 milliseconds and sent
as one frame of at most 200 paths; past that the frame says `truncated` and
the browser refetches the listing instead of trying to apply it. Everything
under `.git/` is folded into a single `git` flag rather than listed, because
the browser's only reaction is to refetch Git status. A `ready` frame is sent
once the first scan completes, so the browser knows when its tree is live and
tests have something to wait on.

The control plane relays one browser socket to exactly one agent socket. It
does not multiplex. Closes carry a fixed set of reasons the browser can act
on, never a message passed through from the agent. An agent serves at most 32
event sockets and one workspace may hold at most 8 through the control plane.

**Rejected alternatives:**

- Server-sent events: no upstream channel for the subscribe message, and the
  API already has the WebSocket plumbing from ADR 0009.
- Long polling: a request per change, and either latency or an idle connection
  per project anyway.
- Multiplexing onto the existing presence socket: it would mix a lifecycle
  signal with a data stream, and a project's events would have to be routed
  inside a socket whose lifetime means something else.
- Native `fs.watch` or raw inotify: recursive watching is not portable or
  reliable, and chokidar already handles the coalescing and the edge cases.
- Polling `git status`: it notices a change late, costs a process per poll per
  project, and gets worse exactly on the repositories students care about.

## Consequences

An agent change shows up in the tree in about a fifth of a second without a
reload, and Git decorations stop needing a timer. The cost is one inotify
watch per directory per open project, which is why the exclusions matter, and
a known gap: a change inside a hidden or generated directory produces no
event, so with hidden files shown the tree can go stale. The events socket is
not presence, so watching a project does not keep a workspace from stopping.
