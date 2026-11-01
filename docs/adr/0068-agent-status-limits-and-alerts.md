# 0068. Agent status from hooks, plan limits from the agents, and alerts that are not recorded

- **Status**: Accepted (Epic 56)
- **Date**: 2026-11-01
- **References**: SPEC.md sections 8.5, 9.6, 9.7, 10.8, 24.1, 25.8, 25.10 and 26; STACK.md section 15; ADR 0012, ADR 0057; issues #1707, #1709, #1710

## Context

A student running Claude Code or Codex in a tab cannot tell whether it is
working, finished or waiting for them, and an agent in another project is
invisible. They also cannot see how much of their plan is used. Students who
sign in with an API key have no plan limit at all. Portikus must not read
prompts, replies or terminal output to learn any of this (STACK.md section
15, ADR 0012), and must not lean on private agent internals (SPEC.md 10.8).

## Decision

1. **Hooks are the state signal.** Claude Code and Codex both run a command
   at defined moments. The controller writes those hooks into Claude Code's
   managed settings and Codex's system config at every workspace start. One
   small script, `portikus-agent-state`, posts `{terminal, agent, state}` for
   working, needs input, finished, or clear. It throws its input away unread,
   has a 1-second limit and always exits 0, so it never slows or blocks the
   agent. The terminal comes from `PORTIKUS_TERMINAL`, which every Portikus
   terminal already sets (SPEC.md 9.7).
2. **Two documented sources for plan limits.** Claude Code's managed settings
   set `statusLine` to a script that keeps only the five-hour and seven-day
   `rate_limits` numbers, posts them, and prints them in Claude Code's own
   status line. A student's own status line is replaced. For Codex, the
   workspace agent runs `codex app-server` for a moment and calls
   `account/rateLimits/read`, at most every three minutes and after a Codex
   turn. It keeps only the percentage, label and reset time of each window,
   never calls `account/read`, and kills the child after the reply or 10
   seconds.
3. **The Codex daemon is off.** Codex runs hooks in a long-lived background
   `codex app-server` that keeps the environment of the first terminal that
   started it, so a second terminal's hooks reported the first terminal's id.
   The system config sets `daemon_auto_start = false` so hooks run in each
   session's own process. The short-lived reader in item 2 is unaffected.
4. **The frame rides the listening socket, to the owner only.** The receiver
   in the workspace agent (ADR 0057) gains two loopback routes,
   `POST /coding-agent-state` and `POST /claude-limits`. The agent keeps the
   states in memory, up to 20 terminals, and sends them to the API on the
   listening socket it already has. The API drops terminal ids the database
   does not hold for that workspace, adds each terminal's project, throttles
   notifications to four a second per workspace, and sends a `coding-agents`
   message to the owner's workspace sockets only. Terminal ids are never
   reused, so once a terminal is removed every later post for its id is
   refused. The terminal socket stays a byte pipe.
5. **Forged posts only change the student's own screen.** Any process in a
   workspace can post to the loopback routes. Nothing is stored or enforced,
   the contracts cap sizes, ranges and counts, and the throttle bounds the
   work.
6. **Today's counts for students.** A student whose agent reports no plan
   limit sees their own tokens and cost for the current UTC day from
   `agent_usage_days`. This reverses ADR 0057's "no student usage view" for
   the current day only. The data is stored by UTC day, so the day is not the
   student's local day.
7. **Operating-system notifications are a per-user setting.** `ask` (the
   default), `on` or `off`. Choosing On saves the choice and never asks the
   browser, because a browser prompt that nobody expects is refused and then
   blocked. The browser permission is asked only from a click: "Allow in this
   browser" in Settings, or "Turn on desktop notifications" in the first
   agent toast while the setting is `ask`. A notification fires only when the
   page is hidden or unfocused. Its text is the agent and the state ("Claude
   Code needs your input"), never a project, terminal or file name, because
   lab computers are shared.
8. **Agent alert toasts are not recorded.** They are frequent and say
   nothing the tab marks do not. The warning at 85 percent of a plan limit is
   rare and is recorded in the notification history (SPEC.md 8.5).

## Consequences

- No database migration and no workspace image rebuild: the controller writes
  the settings at every start and the scripts ship in the workspace agent's
  folder.
- Claude Code has no hook for Esc, so a stopped turn keeps "working" until
  the next prompt. This was accepted.
- Claude Code's status line is Portikus's, not the student's.
- The first Codex limits after a workspace start appear on the next
  minute's poll.
- Turning the Codex daemon off gives up whatever the daemon would have
  shared between sessions. Nothing Portikus uses depends on it.
- Unread marks and the 85 percent warning memory do not survive a reload or
  move between browsers. Both are kept in the page or in the browser.

## Rejected

- Guessing the state from terminal output: it reads terminal bytes, which
  Portikus never keeps or inspects, and it breaks whenever an agent changes
  its screen.
- An undocumented usage endpoint, such as the one a vendor's own app calls
  with the student's login token: it needs the student's credentials in the
  platform and can change without notice.
- Reading Codex's session logs for limits: the logs hold prompts and
  replies, and their format is private.
- Timing out Claude Code's stale "working" mark: a long, quiet turn would be
  marked finished while the agent is still working, which is worse than a
  mark that waits for the next prompt.
- Watching for the Esc key in the terminal: it needs to read the student's
  keystrokes, and Esc also means other things in many programs.
