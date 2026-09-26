# 0032. The resource guard: a time-slice throttle set through Incus, and one gate list

- **Status**: Accepted
- **Date**: 2026-09-25
- **References**: SPEC.md sections 5.1, 6.4, 19.4, 20.1, 24.2 and 24.11;
  ADRs 0005, 0006, 0011 and 0022; issue #554

## Context

A student can keep a workspace running all day with an open tab, or run
a crypto miner on its four CPUs. The platform needs to slow sustained
heavy CPU, point administrators at sustained high memory, stop
workspaces nobody is using, and have everyone accept an acceptable-use
statement. Five choices shape how.

## Decision

1. **The throttle is a time slice.** The guard sets Incus's
   `limits.cpu.allowance` to `<N>ms/100ms`, the share of the CPU limit in
   milliseconds of CPU time per 100 ms (25% of 4 CPUs is `100ms/100ms`).
   A percentage allowance is only a soft weight that applies when the
   host is busy, so a miner on a quiet host would keep every CPU.
2. **The numbers come from Incus, not the workspace agent.** The
   controller reads each instance's CPU time, memory working set, limits
   and boot marker in one listing, and the worker samples it every 60
   seconds. The agent runs inside the workspace, where the student can
   stop or change it. The worker keeps the throttle in the database and
   makes Incus match it every tick, so it survives restarts of either
   process. Activity for idle stop likewise comes only from the web app
   and the API, never from the agent.
3. **Rolling averages, not "every sample above".** A rule fires when the
   average over a rolling window (default 30 minutes) is above its
   threshold. An average cannot be dodged by pausing for one minute in
   every thirty.
4. **Usage is remembered across restarts.** The window is wall-clock
   time and stopped time counts as no use, so a stop and start does not
   begin a fresh window. A restart is detected by a changed boot marker
   (Incus `state.pid`) or a CPU counter that went down, which catches a
   `sudo reboot` inside the workspace. Across a restart the guard counts
   the time since the previous sample, up to 60 seconds, as full use of
   every CPU, because the use just before a restart is never seen. CPU is
   judged across runs; memory is judged only over the current run, so a
   flag cleared at a stop does not return from memory the workspace no
   longer holds. A stop that lifts a throttle deletes the samples from
   before it, so the next run starts fresh.
5. **One ordered gate list.** Acceptable use is a second gate on the
   mechanism that enforces "must change password", in one place in
   `packages/auth`. The first unmet gate wins, password first. One
   enforcement point means a new route cannot forget a gate, and the
   WebSocket and preview gateway refusals come with it.

Every number is a runtime setting with a per-workspace override, not an
environment setting (ADR 0011).

## Consequences

- A throttle bites on a quiet host too, and changes nothing when the
  share is 100%.
- The controller gains one read route and one write route to Incus, and
  reads each instance's cgroup `memory.stat` to leave page cache out of
  memory.
- A student can lift their own throttle by stopping and starting. Each
  throttle and each lift is audited, so a repeat offender shows in the
  audit log, but the number of throttle-then-restart cycles is not
  limited (docs/BACKLOG.md).
- A long unattended job, including a coding agent, is stopped by idle
  stop unless an administrator sets that workspace's idle override to 0.
- Rejected: sampling from the workspace agent. It is simpler, but the
  student controls it.
- Rejected: a percentage allowance. It is Incus's usual form, but it
  does nothing on an idle host.
- Rejected: blocking mining pools, tunnel services or miner programs by
  name (Todd, 2026-09-25). The throttle, the flag and the statement are
  enough, and administrators never see process command lines.
