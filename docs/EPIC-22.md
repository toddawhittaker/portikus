# Epic 22: Pilot fixes after Epics 16 to 21

This is the working plan for Epic 22. It closes issues #699, #700, #701, #702 and #704, which came from the pilot after the 2026-09-26 deploy of Epics 16 to 21 (package 0.1.573+g24c744d). Where this plan is silent, `docs/SPEC.md` wins on behaviour, `docs/DESIGN.md` and `design/` win on look, and the issue bodies give the detail (file and line references, what done looks like).

- **Base commit:** `f437be5` (main). **Epic branch:** `epic/22-pilot-fixes`. Builders reset to `origin/epic/22-pilot-fixes` and branch `task/22-<name>` from it.
- **No migrations and no infrastructure changes.** One contract change: T3 adds an optional field to the agent's listener list.

## Rulings

Rulings are the orchestrator's unless marked otherwise.

1. **#704, stop that fails with "Invalid PID -1".** First find out from the controller code and the Incus behaviour recorded in ADR 0034 what the stop call saw: most likely an instance that was already stopping or had just stopped, whose operation now reports failure because Epic 17 reads the operation's own status. Then make stop succeed when a fresh read of the instance shows it Stopped, the same way `provider.ts` already treats "already stopped" (around line 697), and fail as before otherwise. Do not match on the message text alone. A unit test reproduces the failure first. The rehearsal (T5) confirms it on a real instance.
2. **One danger rule for Stop icon buttons (#700).** Add one shared class, `pk-iconbtn-danger`, in `apps/web/src/app.css`, holding the red of `.pk-running-stop` and `.pk-check-stop` (normal, hover, focus, and the icon's `svg`), and use it on all four Stop buttons: Running, Checks, Monitor and the admin Processes section. Remove the two old copies. Existing unit tests that look for the old class names change to the new one.
3. **Monitor rows (#702).** Every row has the same height, whether or not it has buttons. The action area is two fixed columns, the command disclosure first and Stop second, and a row without one of them leaves an empty cell. Buttons keep a target of at least 24 px (WCAG 2.5.8). The admin Processes section follows the same column rule.
4. **Running full command (#701).** The agent's listener scan adds an optional `commandLine` to a listener only when the listening process belongs to the student (the same ownership test Monitor uses, SPEC.md section 24.11). System and Docker listeners get none. An older agent sends none, and the row then shows no disclosure button. The Running tab reuses Monitor's disclosure as one shared component: move it out of `MonitorPane.tsx` into its own file rather than copying it. The command line never goes to logs, audit rows or the admin view.
5. **Grace period Save (#699).** The Save button lines up with the input, not the whole field block, using the same approach Epic 18 used on the Settings tab. The hint stays under the input. The Playwright check mirrors `e2e/admin-settings.spec.ts` "every Save sits below its fields".

## Tasks

| Task | Issues | Files | Order |
|---|---|---|---|
| T1 controller stop | #704 | `apps/workspace-controller` | parallel |
| T2 Stop colour and Monitor rows | #700, #702 | `apps/web/src/monitor`, `running`, `checks`, `admin/ProcessesSection.tsx`, `app.css`, `e2e` | parallel |
| T3 Running full command | #701 | `apps/workspace-agent/src/listening.ts`, `packages/contracts`, `apps/web/src/running`, `monitor`, `e2e` | after T2 (same files) |
| T4 grace period Save | #699 | `apps/web/src/admin/WorkspaceDetail.tsx`, `e2e` | parallel |
| T5 rehearsal | all | rehearsal VM | after T1 to T4 |
| T6 fold | all | `docs/` | last |

Each task pull request says `Fixes #N` for its issues, and the epic pull request lists them all again.

## Reviews

After T4: code-reviewer over the epic head, security-reviewer (T3 sends command lines from the agent), and a11y-reviewer (T2, T3 and T4 change `apps/web`). Fixes land as further task pull requests, then each reviewer confirms.

## Rehearsal (T5)

Build the package from the epic head and deploy it to the rehearsal VM, following the Epic 21 rehearsal. Check:

- stopping a workspace twice in quick succession, and stopping one that is already stopping, both end Stopped with no 500 (#704);
- the Running tab shows the full command for a student's own dev server and none for a system listener;
- the smoke test and the heavy smoke test pass.

## Fold (T6)

Fold the rulings that last into SPEC.md (section 24.11 for the Running command line, section 20.1 for the admin Processes columns, the Monitor section for the row layout), add an Epic 22 section to STATUS.md, record anything deferred in BACKLOG.md, and delete this plan.

## Rehearsal results

Run on a throwaway rehearsal VM (8 vCPUs, 16 GiB), never the pilot, with package 0.1.579+gb3b3f1e from the epic head, then 0.1.580 with the fix below. `make configure-vm` finished with no failures, and `make build-workspace-image` made image 2026.09.11.

- **#704 was not fully fixed, and now is.** For about a second of some shutdowns (2 of 8 in-container poweroffs), Incus answers the state read itself with HTTP 500 "Invalid PID -1". The instance goes from Running straight to that error, then to Stopped; it never read as Stopping. The controller's stop read the state first, outside the #713 handling, so a stop in that window still answered 500 `OPERATION_FAILED` "Invalid PID -1" (3 of 3 hits, 10 to 33 ms). The read now tolerates any error except "not found", and the stop settles on the real state. On 0.1.580, 5 of 16 tries hit the window and every one answered 200 with `forced: false` in 0.6 to 1.3 seconds. Through the API, two stops in a row, a poweroff inside then a stop, and an `incus stop` then a stop all ended Stopped with no error, in 0.3 to 1.8 seconds. A normal stop, a start and a restart still work.
- **#701 holds.** The Running data for a student's `python3 -m http.server` carries its full command line. systemd-resolved (ports 53 and 5355), the agent (7400) and a Docker-published port (8088) carry none.
- `make smoke-test`: 299 passed, 0 failed, on both packages. `make security-test PORTIKUS_SECURITY_HEAVY=1`: 295 passed, 0 failed, with the expected warning about the host's mock LMS.
