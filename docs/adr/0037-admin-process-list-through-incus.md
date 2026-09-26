# 0037. The administrator reads processes from Incus and stops them through the agent

- **Status**: Accepted (built in Epic 21, task T4)
- **Date**: 2026-09-26
- **References**: SPEC.md sections 20.1, 24.11 and 26; ADRs 0005, 0006, 0022, 0032; issue #595

## Context

An administrator wants to see what is using a workspace's CPU and memory, and
to stop a runaway program. The workspace agent already lists processes for
the student, but it runs as the student inside the container, so a student
who tampered with it could hide a miner from the administrator. Only the
worker holds the controller's token (ADRs 0006 and 0022); giving the API one
would let a compromised API act on every instance. Process names are
student-controlled text, and command lines can hold secrets, so SPEC.md 20.1
allows the administrator short names only.

## Decision

The list is read from Incus. **Refresh** writes a request row in
`workspace_process_snapshots` and answers 202. A worker loop, once a second,
serves each pending request by calling the controller's
`GET /instances/:name/processes` with a 10-second timeout, and writes the
rows or an error code. The browser polls the API's read route. Rows older
than an hour are deleted.

The controller runs one Incus exec, as uid 1000 and gid 1000, with a fixed
POSIX shell command and no caller input. It prints each process's uid (from
`status`, whose name line the kernel escapes) and its `/proc/<pid>/stat`
line, sleeps one second, prints them again, and prints the agent's
`MainPID` from `systemctl show`. Records are separated by NUL bytes. The
output is read from Incus's recorded output log, capped at 4 MiB, and the
logs are deleted afterwards. The controller computes CPU percent over that
second against the instance's CPU limit and resident memory from `rss`, and
returns the union of the top ten by each. The short name is taken between
the first `(` and the last `)`, control and format characters become `?`,
and it is cut to 15 characters. Command lines are never read.

The administrator's **Stop** goes through the agent's checked stop route,
the same one the student uses (PID, start ticks, protected list). It writes
the `workspace.process_stopped` audit row and a notification to the student
that names no process.

## Consequences

- A tampered agent cannot hide a process from the list, and the API still
  never calls the controller.
- The list is a snapshot a second or two old, not live, which is what the
  issue asked for.
- If the agent is down, the administrator cannot stop one process; stopping
  or restarting the workspace still works. A root-level kill path in the
  controller was rejected as more to secure than that case is worth.
- The one-second sample forks once per process, which is fine at a
  workspace's process limit but would not scale to a whole host.
