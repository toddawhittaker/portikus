# Epic 16: Workspace resilience

This is the working plan for Epic 16. It lives only on `epic/16-workspace-resilience` and the last task deletes it (WORKFLOW.md, "Epic plans"). Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. The evidence behind it is the workspace resilience audit of 2026-09-26 (kept on Todd's machine, not in the repository).

- **Base commit:** `main` at 3da8d6b. Task branches are `task/16-<name>`, cut from `origin/epic/16-workspace-resilience`.
- **Migrations:** none. No task adds one.
- **Image version:** every image change in this epic ships under one bump of `infra/workspace-image/VERSION` to `2026.09.11` (2026.09.10 was never built). Only T1 edits the image.
- **Not in this epic:** deploying to the pilot or rebuilding its workspaces. That is Todd's call after the epic merges.

## Goal

A student's ordinary mistakes (a big file in `/tmp`, a few hundred threads, a broken `~/.bashrc`, a tutorial's `tmux kill-server`, a full home folder, a huge project tree) no longer take their terminals or the workspace agent down, and when something is lost the student is told why. The tmux server moves into its own systemd unit so terminals survive an agent restart and the agent can be shielded from the out-of-memory (OOM) killer and from process exhaustion.

Closes #618, #619, #610, #620, #621, #622, #623, #624, #625.

## Terms

- **The agent unit:** `portikus-workspace-agent.service`, which today holds the agent, the tmux server, every shell and every student program.
- **The terminals unit:** the new `portikus-terminals.service`, which will hold the tmux server and every shell and program started in a terminal.
- **External mode:** the agent talks to a tmux server the terminals unit runs, and never starts one. **Own-server mode** is today's behaviour, where the agent starts tmux itself; it stays for workspaces on images older than 2026.09.11.
- **The exit record:** a small file the terminals unit writes when it stops, holding systemd's `$SERVICE_RESULT` (for example `oom-kill`).

## Rulings

Rulings marked **(orchestrator)** were decided before planning; the rest were made here.

### Image and units (T1)

1. **(orchestrator)** `/tmp` is a tmpfs capped at `size=512M` and `/dev/shm` at `size=256M`. Fixed sizes, no setting. The mechanism (a `tmp.mount` drop-in, an fstab line, or a remount unit) is T1's choice; what counts is `findmnt` on a rebuilt workspace. Reason: a big temporary file then fails with "No space left on device" instead of OOM-killing the session.
2. **(orchestrator)** The terminals unit runs `tmux -L portikus -f /dev/null -D` as `User=student`, `Group=student`, `WorkingDirectory=/home/student`, with `OOMPolicy=continue` and `TasksMax=1700`. `-D` keeps tmux in the foreground and turns off `exit-empty`, so a server with no sessions stays up.
3. **`Restart=always` with `RestartSec=1`**, not `Restart=on-failure`. Reason: `tmux kill-server` makes tmux exit with status 0, which `on-failure` would not restart, and the agent in external mode cannot start the server itself (a student cannot start a system unit).
4. **The terminals unit sets no `OOMScoreAdjust`** (it stays 0, like the student's Docker containers). The agent unit gets `OOMScoreAdjust=-500`. Reason: the audit's suggested +300 would make terminal programs preferred victims over Docker containers for no stated gain; -500 on the agent alone is what protects it.
5. **(orchestrator)** The agent unit gets `TasksMax=infinity` and keeps `OOMPolicy=continue`; the container's `pids.max` of 2000 is its only ceiling. The agent unit sets `Environment=TMUX_EXTERNAL_SERVER=true` and `Wants=`/`After=portikus-terminals.service`, never `Requires=` or `BindsTo=`, so a terminals restart never restarts the agent. The terminals unit is `After=portikus-home-init.service` and does not depend on the agent.
6. **The terminals unit adds no sandboxing options** beyond what the agent unit has. Reason: shells must behave exactly as today (sudo, Docker, the browser broker).
7. **Shells keep the environment they get today, less the agent's own settings** (`NODE_ENV`, `LOG_LEVEL`). The browser broker's `BROWSER` comes from `/etc/profile.d/portikus-agents.sh` and is unaffected. T1 compares `env` in a new terminal on the old and new images during the rehearsal and fixes any other difference.
8. **The exit record.** The terminals unit sets `RuntimeDirectory=portikus-terminals`, `RuntimeDirectoryMode=0755`, `RuntimeDirectoryPreserve=yes`, and `ExecStopPost=/bin/sh -c 'printf "%%s\n" "$SERVICE_RESULT" > /run/portikus-terminals/last-exit'`. The file's modification time is when it stopped. `/run` is cleared when the workspace stops, so any record present means the terminals restarted during this boot. The student can write the file; the only effect is their own message.
9. **No platform tmux config file.** The issue suggested `/etc/portikus/tmux.conf`; `-f /dev/null` does the same job (tmux never reads the student's `~/.tmux.conf` or `/etc/tmux.conf`) because the agent already sets every option it needs on each `new-session`. Reason: one file fewer, and no copy of the agent's options to keep in step.
10. **(orchestrator)** Platform deploys do not restart agents in running workspaces (the agent is bind-mounted from the package), so no deploy-time handling is needed.

### The agent and terminals (T2)

11. **The tmux socket name becomes `portikus` in both modes** (`/tmp/tmux-1000/portikus`), as #620 asks; this replaces #610's "socket path unchanged". The directory, its permissions (tmux's own 0700 directory) and the `pk-<id>` session names do not change. The config default of `TMUX_SOCKET_NAME` becomes `portikus`; tests keep passing their own name. Reason: changing the default is safe for running workspaces, because today an agent restart kills every session anyway, and it brings the private socket to old images with the next platform deploy.
12. **External mode** (`TMUX_EXTERNAL_SERVER=true`) passes tmux's `-N` flag on every command, so a missing server is an error rather than a new server in the agent's cgroup. That error is the existing `TMUX_FAILED` code with the message "The terminal service is not running; it restarts on its own within seconds." Reason: the outage lasts about a second (ruling 3), so a new error code through contracts, API and web is not worth it.
13. **Own-server mode also passes `-f /dev/null`**, so a broken `~/.tmux.conf` stops breaking new terminals on old images too, with no rebuild.
14. **Every tmux call gets a 5-second timeout with `SIGKILL`** (`execFile`'s `timeout` and `killSignal`), reported as `TMUX_FAILED` "tmux did not answer in time". The pane poller keeps its single `list-panes` call.
15. **Ordinary terminals start through a wrapper, `apps/workspace-agent/scripts/portikus-shell`, shipped in the agent package** (so it reaches every image through the bind mount at `/opt/portikus/workspace-agent`). It is a bash script that unsets `TMUX` and `TMUX_PANE`, runs the login shell, and, if that shell exits within one second of starting (measured with `$EPOCHREALTIME`), prints "Your ~/.bashrc made the shell exit; this terminal skipped it." and runs `bash --noprofile --norc` once. Otherwise it exits with the shell's status, so "shell exit closes the pane" still holds. Launchers (Claude Code, Codex) do not use the wrapper.
    - Reason for the wrapper rather than the agent waiting a second after `new-session`: every new terminal would open a second later.
    - Reason for unsetting `TMUX`: tmux commands typed in a pane use `$TMUX`'s socket, so without this `tmux kill-server` from a tutorial still reaches the Portikus server however private its name. With it, a student's `tmux` in a pane is their own server on the default socket.
16. **Closing a terminal and stopping a Check stop the whole tree** (#624). A new helper, `process-tree.ts`, collects the root process's descendants (by parent PID from `/proc`) and every process in its session (by session ID), sends them `SIGTERM`, waits up to 3 seconds (the Running pane's `STOP_GRACE_MS`), and sends `SIGKILL` to what is left. Terminal close reads `#{pane_pid}` before `kill-session`; Check stop uses the PTY's PID. A program that double-forks out of both the tree and the session escapes; Monitor's stop (#607) is the way to it.
17. **Checks output gets the terminals' backpressure** (#624): the Check's PTY pauses while any subscriber's socket has more than the terminals' high-water mark buffered, and resumes below the low-water mark, using the same constants. With no subscribers it never pauses.
18. **Check programs are not shielded by the agent's -500.** Checks are started by the agent, so they would inherit its `oom_score_adj`; the Check command runs under `choom -n 0 --` (util-linux, already in the image), which an unprivileged process may do because it raises the value. On old images the agent's value is 0 and this changes nothing.

### Port scanner (T3)

19. **No overlapping scans:** a tick is skipped while the previous scan is running. **Idle when unwatched:** the scan runs only while at least one `/listening/events` socket is open or a forward exists; the in-process subscription the forwards use does not count, and `GET /listening` still scans on demand. **Owners are cached:** a listening socket's inode maps to its owner PID from the last scan, and `/proc/*/fd` is walked only when a socket's inode is new or its cached owner has exited.
20. In practice the control plane's preview registry keeps one `/listening/events` socket per running workspace, so the saving comes from the overlap guard and the owner cache; making the registry connect on demand is left out (preview routing needs current ports).

### Files (T4)

21. **The watcher skips more folders, but the tree does not hide more.** A new `WATCH_SKIP_NAMES` in `packages/contracts/src/files.ts` holds `GENERATED_NAMES` plus `venv`, `env`, `.next`, `.cache`, `vendor`, `coverage`, `.gradle`, `.pytest_cache`, `.mypy_cache` and `.tox`; only `watch.ts` uses it. `GENERATED_NAMES`, which the tree also uses to hide folders (SPEC.md §11.3), is unchanged. Reason: hiding a student's `env` or `vendor` folder in the tree would surprise them.
22. **The watcher is capped at 20,000 directories**, counted from `addDir` events before `ready`. Past the cap the agent closes that watcher and sends one new event, `{type: "watch_limited"}`, instead of an error; the browser stops reconnecting for that project and refreshes Files and Changes when the window regains focus and after its own file actions, and the Files pane says once "This project is too large to update live. It refreshes when you return to the window." Reason: a retry would rescan the whole tree again.
23. **Disk full is `STORAGE_FULL` on every agent route.** The agent's `sendError` maps an `ENOSPC` or `EDQUOT` error to `STORAGE_FULL` (507) before it falls back, which covers save, upload, new folder, move and project create in one place (and fixes project create's `TMUX_FAILED` for this case). The control plane already relays `STORAGE_FULL` as 507.
24. **The words:** the editor says "Your home folder is full. Delete files, then save again." for a failed save; upload, new folder, move and project create say "Your home folder is full. Delete files, then try again."

### Why terminals vanished (T5)

25. **Only the terminals unit's exit is explained.** After the split an agent restart no longer loses terminals, so the agent's own exit is not recorded. On images older than 2026.09.11 there is no record and the pane ends as it does today.
26. **The agent reports, the control plane decides.** The agent reads the exit record and reports it (`{result, at}` or `null`) on a small read-only route. When the agent says a terminal's session is gone, the control plane compares the record's time with the terminal's `created_at`; if the record is newer, the browser gets `{type: "error", code: "TERMINAL_NOT_FOUND", reason}` where `reason` is `out_of_memory` for `oom-kill` and `restarted` for anything else.
27. **The student sees a toast, once per restart**, not a line in the pane (a pane closes when its terminal ends): "Your workspace ran out of memory and its terminals were restarted." or "Your workspace's terminals were restarted." Terminals already open keep closing as they do today.

## Tasks

Tasks that run at the same time own different files. Nobody but T6 edits `docs/STATUS.md` or SPEC.md section 29; each task updates the SPEC.md sections for its own behaviour. Every PR carries its `Fixes #N` lines.

| Task | What it does | Fixes | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|---|---|
| **T1 Image and units** | Rulings 1 to 8: `/tmp` and `/dev/shm` caps; the terminals unit; the agent unit's `TasksMax`, `OOMScoreAdjust`, `TMUX_EXTERNAL_SERVER` and ordering; the exit record; `VERSION` to 2026.09.11. Infra checks (below) and one rehearsal run. SPEC.md §19.3, §21.7. | #618, #619, #610 (unit side) | infra | `infra/workspace-image/portikus.yaml`, `infra/workspace-image/VERSION`; `infra/tests/smoke-test.sh`, `infra/tests/security/limits.sh`, `infra/tests/security/container.sh` | T2 for the rehearsal run only (writing can start at once) | 1.5 days |
| **T2 Terminals and process trees** | Rulings 11 to 18: socket name `portikus`, external mode with `-N`, `-f /dev/null`, tmux call timeout, the `portikus-shell` wrapper, process-tree stop for terminal close and Check stop, Checks backpressure, `choom` for Checks. SPEC.md §9.7, §18.1. | #610 (agent side), #620, #624 | builder | `apps/workspace-agent/src/tmux.ts`, `terminals.ts`, `cwd.ts`, `checks-route.ts`, `process-tree.ts` (new), `server.ts`, `index.ts` and their tests; `apps/workspace-agent/scripts/portikus-shell` (new) and its test; `apps/workspace-agent/package.json` and `scripts/build-deb.sh` only as far as shipping the wrapper needs; `packages/config/src/index.ts` and test | none | 2.5 days |
| **T3 Port scanner** | Ruling 19. SPEC.md §18.2. | #623 | builder | `apps/workspace-agent/src/listening.ts`, `listening-route.ts` and their tests (not `server.ts`) | none | 1 day |
| **T4 Files: watcher and disk full** | Rulings 21 to 24, with Playwright for the full-disk messages and the watch-limited fallback. SPEC.md §11.4, §13.5, §28. | #621, #622 | builder | `packages/contracts/src/files.ts` and the watch event schema; `apps/workspace-agent/src/watch.ts`, `events-route.ts`, `errors.ts`, `files.ts`, `projects.ts` (error mapping only) and their tests; `apps/api/src/routes/project-events.ts`, `files.ts`, `projects.ts` only if a relay is missing; `apps/api/src/fake-agent.ts`; `apps/web/src/work/FileLeaf.tsx`, `apps/web/src/files/**`, the project-create dialog; `e2e/files.spec.ts` or a new spec | none | 1.5 days |
| **T5 Why terminals vanished** | Rulings 25 to 27: the agent's record route, the control plane's comparison and frame, the web toast, Playwright through the fake agent. SPEC.md §9.7. | #625 | builder | `apps/workspace-agent/src/terminals.ts`, `server.ts` (the record route only); `packages/contracts/src/agent.ts`; `packages/events/src/index.ts`; `apps/api/src/agent-client.ts`, `routes/terminals.ts`; `apps/api/src/fake-agent.ts`; `apps/web/src/TerminalPane.tsx`, `terminalFrames.ts`; a new e2e spec | T2 (agent files), T4 (`fake-agent.ts`) | 1 day |
| **T6 Fold the plan** | Folds the lasting rules into SPEC.md (§9.7, §18.1, §18.2, §19.3, §11.4, §21.7 as needed), adds an ADR (next free number) on "tmux in its own unit, the agent shielded", adds Epic 16 to SPEC.md §29 and `docs/STATUS.md`, adds the left-out items below to `docs/BACKLOG.md`, deletes this file. | none | builder | `docs/SPEC.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/adr/`, `docs/EPIC-16.md` | T1 to T5 | 0.5 day |

T1, T2, T3 and T4 start together. T5 starts when T2 and T4 have landed. T1's rehearsal runs when T2 has landed, so the rebuilt image meets an agent that knows external mode.

## Verification

**Every task:** `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage` above the floors; `make check` and `pnpm test:e2e` on a fresh test database before the PR.

**Unit tests (the invariant each pins):**

- T2: a call to a tmux that never answers fails with `TMUX_FAILED` after 5 seconds and the process is killed; external mode never starts a server (`-N` on every call) and reports the missing server; own-server mode passes `-f /dev/null`; a real tmux on a test socket with a `default-command exit` in `~/.tmux.conf` still opens a terminal; the wrapper, given a shell that exits at once, prints the message and runs the fallback, and given one that runs longer, exits with its status and prints nothing; the wrapper's shell has no `TMUX`; closing a terminal and stopping a Check kill a `setsid` and a `nohup` child, not just the shell; a Check's PTY pauses under a slow subscriber and resumes, as the terminals' existing backpressure test does; a Check's program has `oom_score_adj` 0 when the agent's is lower.
- T3: a tick is skipped while a scan is running; no scan with no events socket and no forward, and scanning resumes when one opens; the fd walk is skipped when every listening inode's owner is known, and runs for a new inode.
- T4: the watcher skips each new name; the tree still shows them; past the cap exactly one `watch_limited` is sent and no error; `ENOSPC` and `EDQUOT` give 507 `STORAGE_FULL` on save, upload, new folder, move and project create; the editor and the other file actions show their sentences.
- T5: the record is read and missing records give `null`; `oom-kill` maps to `out_of_memory` and anything else to `restarted`; a record older than the terminal gives no reason; the web shows the toast once per restart.

**Playwright (through the fake agent):** T4, a save and a new folder on a full disk show their sentences, and a project past the watch cap shows the notice and refreshes on focus; T5, a terminal lost to an out-of-memory restart shows its toast. #610's "a terminal survives an agent restart" cannot be staged by the fake agent, so it is an infra check instead.

**Infra checks added by T1** (smoke test, or `security/limits.sh` for the heavy ones):

- `findmnt` shows `/tmp` at 512M and `/dev/shm` at 256M; writing 600 MB to `/tmp` fails with "No space left on device" and the agent and a terminal keep working.
- `systemctl show` gives `TasksMax=infinity` and `OOMScoreAdjust=-500` on the agent unit, `TasksMax=1700` on the terminals unit.
- The tmux server's cgroup is the terminals unit's; the agent's `oom_score_adj` is lower than a shell's.
- `systemctl restart portikus-workspace-agent` leaves a terminal's session alive, and attaching through the API afterwards replays that session.
- `tmux kill-server` typed into a pane leaves the Portikus sessions alive (T2's wrapper); killing the tmux server with `SIGKILL` brings the terminals unit back within a few seconds and writes the exit record.
- A `~/.tmux.conf` with `set -g default-command exit` and a `~/.bashrc` ending in `exit` still let a new terminal open, the second with the wrapper's message.
- The existing heavy OOM test in `limits.sh`, which starts its tmux in the agent's cgroup, moves to the terminals unit's cgroup and still shows only the program killed.

**Rehearsal (T1, once, after T2 lands):** `make rehearsal-up`; `make configure-vm` for the rehearsal VM with `PORTIKUS_DEB` built from the epic head; `make build-workspace-image`; create a workspace; `make smoke-test`; `make security-test` with `PORTIKUS_SECURITY_HEAVY=1`; compare a pane's `env` on the old and new images (ruling 7); `make rehearsal-destroy`. Never the pilot VM.

**Reviews after T5:** code-reviewer over the epic head; security-reviewer (a new unit running as the student, the socket and its permissions, the exit record the student can write, the process-tree kill never reaching outside the student's own processes); a11y-reviewer for the new toasts and the Files notice.

## Left out

These go to `docs/BACKLOG.md` in T6.

- **CPU weights and `MemoryMin` for the agent** (audit recommendation 3). Checks still run in the agent's cgroup, so a CPU weight would favour student Check code too.
- **Moving Checks out of the agent's cgroup** (into the terminals unit or their own). It is what would make rulings 17 and 18 unnecessary, but it changes how Checks are started and replayed.
- **A systemd watchdog for a stopped (`SIGSTOP`) agent.** Only a deliberate act causes it.
- **The preview registry connecting to the agent only on demand** (ruling 20).
- **A per-student Docker pids share.** Docker containers still share the container's 2000 pids with the agent; the terminals unit's cap does not cover them.
- **Changing project routes' non-disk fallback from `TMUX_FAILED` to `INTERNAL`.** A wrong code for rare errors; only the disk-full case was asked for.
- **Explaining an agent restart on images before 2026.09.11.** Those workspaces pick up the fix when rebuilt.
