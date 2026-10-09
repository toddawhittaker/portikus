# 0035. Terminals run in their own systemd unit

- **Status**: Accepted
- **Date**: 2026-09-26
- **References**: SPEC.md sections 9.7, 19.3 and 21.7; issues #610,
  #619, #620 and #625

## Context

Before workspace image 2026.09.11 the workspace agent's unit held the
agent, the tmux server, every shell and every program a student started
in a terminal. One cgroup meant one fate. A program that ran out of
memory or forked a few hundred threads could get the agent killed or
starved of processes, and when the agent restarted for any reason, every
terminal went with it. A `tmux kill-server` from a tutorial did the same.

## Decision

The tmux server runs in its own unit, `portikus-terminals.service`, as
the student, on a private socket (`tmux -L portikus -f /dev/null -D`),
with `Restart=always` after one second, `OOMPolicy=continue` and
`TasksMax=1700`. The agent runs in external mode: it passes `-N` to every
tmux call and never starts a server. The agent unit wants the terminals
unit but never requires it, so each can restart without the other. The
agent unit's own process limit is lifted to `TasksMax=infinity`. When
the terminals unit stops it writes an exit record that the control plane
uses to tell the student why their terminals closed.

With the split, an out-of-memory kill in a terminal lands in the
terminals unit, and an agent restart leaves terminals open. That is the
shielding the agent needed.

Two measures in the plan were dropped after the rehearsal:

- `OOMScoreAdjust=-500` on the agent unit. The kernel refuses to lower an
  OOM score in an unprivileged container, so the value stayed 0 and the
  setting did nothing. No unit sets `OOMScoreAdjust`; the agent, the
  terminals and the student's Docker containers all stay at 0.
- `choom -n 0` for Checks. It existed only to undo the agent's -500 for
  Check commands, which inherit the agent's score. With no -500 there was
  nothing to undo.

Own-server mode (the agent starts tmux itself) stays for workspaces on
older images until they are rebuilt.

## Consequences

- Checks still run in the agent's cgroup, so a Check that runs out of
  memory can still take the agent down with it (issue #1254).
- The terminals unit is a second place a student's processes live, and
  the tmux socket name changed to `portikus` on every image.
- Known gap: the exit record says `oom-kill` when tmux died of `SIGKILL`
  and the unit's cgroup `memory.events` counts an `oom_kill`. That counter
  covers the whole cgroup for the unit's current run, so if a pane's
  program was OOM-killed earlier and tmux is later killed with a plain
  `SIGKILL` before the unit restarts, the record wrongly says `oom-kill`
  and the student is told their workspace ran out of memory.
- Later note (Epic 38): neither unit sets a memory limit, so an
  out-of-memory kill is container-wide and the kernel kills the process
  with the highest OOM score, whatever its cgroup. Each Check now starts
  under `choom -n 500`, which then runs the Check's shell, so a
  memory-hungry Check is killed before the agent. Checks still count
  against the agent unit's process count, which has no limit of its own.
