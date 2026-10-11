# 0060. The workspace agent keeps a small in-memory ring of its own warnings, which the admin page pulls on demand

- **Status**: Accepted (Epic 43)
- **Date**: 2026-10-10
- **References**: SPEC.md sections 20.1, 24.1, 24.2, 25.6; STACK.md section 15; ADRs 0009, 0012, 0036; issue #1256

## Context

When a workspace misbehaves, an administrator wants to see what the
workspace agent said about it. The agent's log goes to the container's
journal, which the control plane does not read, and the Logs tab shows
only the host's services (ADR 0036). Reading the container's journal
from the host would need a new path into the instance and would bring
along everything else the student's processes write there.

The agent runs as the student, and its token is readable by that user
(ADR 0009, SPEC.md 24.1). Whatever it reports is the student's to
change, so it can be a hint for the administrator, never evidence.

## Decision

- The agent keeps a ring in memory of its own log lines at warn level
  and above: the last 200 lines, and no more than 128 KiB in total. The
  logger's destination copies each line into the ring and still writes
  it to standard output as before. Nothing is written to disk.
- Only six fields are kept from each line: `time`, `level`, `msg`,
  `code`, `status` and `durationMs`. Every other field is dropped,
  including the service name, paths and project names, which the agent
  logs beside its messages. The message text itself is kept, so agent
  code must keep following STACK.md section 15 and put names in fields,
  not in messages.
- The agent serves the ring at `GET /log`, behind its bearer token.
- The API pulls it only when an administrator asks, through
  `GET /admin/workspaces/:id/agent-log`. It reads the reply under a
  256 KiB cap, removes control characters from every string, and checks
  it against the contract schema. An oversize or off-schema reply is
  refused with a clear error, never passed on. The API does not store
  the lines or log them.
- The admin page labels the lines as reported by the workspace, and says
  that the owner can change them.

## Consequences

- An administrator sees the agent's recent trouble without a shell.
- The lines are lost when the agent restarts. That is accepted: the
  journal still has them, and the panel is for what is happening now.
- A student can forge or hide lines. The label says so, and the API's
  checks mean a forged reply cannot break the page or the API.
- Lines quieter than warn are never kept, so turning on debug logging
  (ADR 0012) does not fill the ring with request detail.
