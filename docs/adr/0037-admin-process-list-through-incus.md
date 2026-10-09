# 0037. The administrator reads processes from the host and stops them through the agent

- **Status**: Accepted (built in Epic 21, task T4; the read moved to the host in the Epic 21 security review)
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

The first version ran a fixed shell command in the instance through Incus
exec, as uid 1000, and read its output from Incus's recorded log. The
security review rejected it. A student with sudo can replace `/bin/sh` in
the container, so that command could print any list it liked, and it could
keep writing to the recorded log, which lives on the host's root disk. It
also recognised the terminals' tmux server by its short name, which any
program can set to `tmux: server` to protect itself.

## Decision

The list is read by the controller on the host. **Refresh** writes a request
row in `workspace_process_snapshots` and answers 202. A worker loop, once a
second, serves each pending request by calling the controller's
`GET /instances/:name/processes` with a 10-second timeout, and writes the
rows or an error code. The browser polls the API's read route. Rows older
than an hour are deleted.

The controller asks Incus only for metadata: the instance's state (it must be
running, and its init's host PID) and its config (`limits.cpu` and
`volatile.idmap.current`). It then walks the instance's cgroup tree on the
host (`/sys/fs/cgroup/lxc.payload.<project>_<instance>`, every
`cgroup.procs` below it) and reads the host's `/proc/<pid>/stat` and
`/proc/<pid>/status` for each PID, twice, one second apart:

- The PID shown is the process's PID in the workspace: the `NSpid` entry at
  the level where the instance's init is PID 1, so a nested Docker container
  does not change it.
- The uid is the real uid from `status`, mapped back through the instance's
  idmap to the uid the workspace sees. A host uid outside the map shows as
  65534.
- CPU percent is the change in `utime + stime` over the host's uptime
  change, against the instance's CPU limit; memory is `VmRSS`.
- The short name is taken from `stat` between the first `(` and the last
  `)`; control and format characters become `?`, and it is cut to 15
  characters. Command lines are never read.
- A PID that vanishes between the cgroup read and the `/proc` read is left
  out.

A row is protected when its workspace PID is 1, its uid is not 1000, or it is
the main process of `portikus-workspace-agent.service` or
`portikus-terminals.service`. The main process is the oldest process in the
unit's cgroup inside the container, because every other process in a unit
descends from it; the name plays no part. The union of the top ten by CPU and
the top ten by memory is returned.

The administrator's **Stop** goes through the agent's checked stop route,
the same one the student uses (PID, start ticks, protected list). It writes
the `workspace.process_stopped` audit row and a notification to the student
that names no process.

## Consequences

- No code runs inside the workspace and nothing is written to disk, so the
  student can slow the read only up to its caps, cannot fill the host's
  disk, and cannot feed it false text beyond a process's own short name.
  Root in the container can create more than 10,000 empty cgroups; every
  Refresh then fails with an error (measured at 2.8 seconds) rather than
  showing a false list, and the administrator can still stop the workspace.
- The PID, uid, cgroup, CPU and memory come from the host kernel, so a
  student cannot forge them. A student with sudo can still run a program as
  root, which makes it protected (it is root's, not the student's). The
  student can also restart or stop the agent or terminals unit and then
  move a long-running program into that unit's cgroup, so it becomes the
  oldest process there and shows as protected. Neither hides it from the
  list, and the effect is the same as the old name trick: the
  administrator stops the whole workspace instead of one process.
- The controller needs only read access to `/proc` and `/sys/fs/cgroup`,
  which it has as an ordinary user while `/proc` is mounted without
  `hidepid`.
- The list is a snapshot a second or two old, not live, which is what the
  issue asked for.
- If the agent is down, the administrator cannot stop one process; stopping
  or restarting the workspace still works. A root-level kill path in the
  controller was rejected as more to secure than that case is worth.
- CPU ticks are counted at 100 a second (Linux's fixed USER_HZ), and
  `startTicks` comes from the host's `stat`, which matches the agent's view
  as long as instances have no time namespace (Incus does not give them one).

## Later note (Epic 22)

The Running pane's listener `commandLine` field has existed since Epic 9.1.
Epic 22 narrowed it to listeners owned by the student's own processes. The
agent reads the uid and then `cmdline`, so a PID reused in between is a
low-severity race, accepted while `/proc` has no `hidepid`. If `hidepid` is
ever turned on, re-check the uid after the read (SPEC.md section 24.11).

## Later note (Epic 38)

The rule above for the agent and terminals units is replaced. The oldest
process in a unit's cgroup is not what the agent's stop refuses: it missed
the pane shells and the agent's attach clients, which the stop does refuse,
and it marked a program a student had moved into the unit. Now the worker
asks the agent's `GET /processes/protected` for the exact set its stop
refuses (the agent, its attach clients, the tmux server and the pane
shells, each with its start ticks) and marks those rows protected. The
controller keeps only the host facts: PID 1 and any uid other than 1000.
If the agent does not answer, or is an older agent without the route, the
list shows the host facts alone. A student can still protect a program by
running it as root, so the aim is a list that matches the stop, not one a
sudo student cannot fool.
