# Epic 14.3: Resource guard

This is the working plan for Epic 14.3 (issue #554). It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. It builds the BACKLOG entry "Resource guard: idle stop, CPU throttling, memory flags" and replaces it.

This plan lives only on the epic branch (WORKFLOW.md, "Epic plans"). Code comments, tests and other documents cite SPEC.md sections or ADRs, never this file. The last task (T8) folds its lasting rules into SPEC.md, writes ADR 0032, and deletes this file.

- **Base commit:** `origin/epic/14-3-resource-guard` (cut from `epic/14-1-fixes` at `7a31795`). **Epic branch:** `epic/14-3-resource-guard`. Builders reset to it and branch `task/14-3-<name>` from it.
- **Migration number:** `0020_resource_guard` is reserved for T2. No other task adds a migration. (`0019_local_admin` is reserved by Epic 14.2; Epic 15 adds none. The migrator runs with `allowUnorderedMigrations: true`, so `0020` may reach a database before `0019`.)
- **ADR number:** `0032` for T8.

## Terms used throughout

- **Incus**: the container manager each workspace runs in. The **controller** is the only process that talks to it (ADR 0005); the **worker** is the only process that talks to the controller (ADR 0006).
- **CPU limit**: the number of CPUs a workspace may use, Incus's `limits.cpu` on the workspace profile (4 on the pilot, SPEC.md 19.1). Incus applies it as a CPU set: the workspace may keep all 4 busy.
- **CPU allowance**: Incus's `limits.cpu.allowance`. Written as a percentage (`25%`) it is a *soft* share that only matters when the host is busy. Written as a time slice (`100ms/100ms`) it is a *hard* cap: at most 100 ms of CPU time every 100 ms, which is one CPU's worth.
- **Throttled**: a workspace whose CPU allowance the guard has lowered.
- **Flagged**: a workspace whose memory use the guard has marked for an administrator. Nothing is slowed.
- **Window**: the stretch of time the guard averages over, 30 minutes by default.
- **Sample**: one reading of a workspace's CPU time and memory, taken every minute.
- **Activity**: something the student did on purpose: a key press or click in the Portikus page, a file save, or opening a page in a preview.
- **Idle stop**: stopping a running workspace after a stretch with no activity.
- **Grace period**: the existing timer that stops a workspace once no browser is connected (SPEC.md 6.4).
- **AUP** (acceptable-use policy): the statement every person accepts before using Portikus.
- **Gate**: a rule that lets a signed-in account reach only one page until it does something. Epic 14.2 adds the first gate, "must change password" (`docs/EPIC-14-2.md` ruling 18); this epic adds the second.

## What the user gets

- A workspace that keeps its CPUs above 80% busy for 30 minutes is slowed to a quarter of its CPU limit. The student sees a notice saying why and how to get full speed back (stop and start the workspace). An administrator sees it marked in the admin area, with an audit row, and can lift it.
- A workspace that keeps memory above 90% of its limit for 30 minutes is marked for administrators, with an audit row. Nothing is slowed.
- An open, forgotten tab no longer keeps a workspace running for ever. After 60 minutes with no activity the student sees "Still working?"; unless they answer within 5 minutes, the workspace stops. The grace period still applies once every tab is closed; whichever timer fires first stops the workspace.
- Administrators set the thresholds, the window, the throttled share and the idle time in Settings, and override any of them for one workspace.
- Everyone accepts an acceptable-use statement at first sign-in, and again whenever an administrator changes its text.

## Rulings

Rulings marked **(user)** came from Todd, **(orchestrator)** from the orchestrator, and **(brief)** were made in this plan.

### From Todd

1. **(user)** A workspace using more than 80% of its CPU limit for 30 minutes is throttled to 25% of its limit. The student sees a banner; administrators see a flag and an audit row. The throttle lifts at the next stop and start, or when an administrator lifts it.
2. **(user)** A workspace using more than 90% of its memory limit for 30 minutes is flagged with an audit row. It is not throttled: memory already has a hard limit.
3. **(user)** The thresholds, the window and the throttled share are admin settings with per-workspace overrides, the way quotas are.
4. **(user)** Idle stop counts activity (keystrokes, terminal input, file saves, preview visits), not an open tab. "Still working?" after 60 minutes; stop 5 minutes later unless the student answers. An admin setting with per-user overrides, like the grace period. *(Superseded in part by ruling 6b: the override is per workspace.)*
5. **(user)** An acceptable-use statement at first sign-in.
6. **(user)** No blocking of mining pools or tunnel services (Todd, 2026-09-25, PR #553), and no blocking of miner programs by name. Flagging, throttling and the acceptable-use statement are enough.

6a. **(user, 2026-09-25)** **Idle stop applies to unattended coding agents too.** An agent working alone is stopped with its workspace after the idle time, like anything else; its output does not count as activity.

6b. **(user, 2026-09-25)** **The idle time is an admin setting with a per-workspace override**, stored the same way as the CPU and memory overrides (ruling 19), not per user.

6c. **(user, 2026-09-25)** **On upgrade, a workspace whose owner has a grace override of 0 gets an idle override of 0**, so it keeps running as before.

### Measuring

7. **(brief)** **The worker samples every running workspace every 60 seconds**, on its own loop beside the host sampler (ADR 0022), not inside the one-second sweep. Reason: the same cadence as the host samples; a one-minute resolution is plenty for a 30-minute rule.
8. **(brief)** **The numbers come from Incus, through the controller, never from the workspace agent.** The agent runs inside the workspace, where the student can stop or change it (SPEC.md 24.2). A new controller route, `GET /instances/usage`, makes one `GET /1.0/instances?recursion=2` call and returns, for each running instance, its name, `cpuUsageNs` (Incus `state.cpu.usage`, CPU time in nanoseconds since the instance started), `memoryBytes`, `cpuLimit` (a count from `expanded_config["limits.cpu"]`, or the host's CPU count when unset), `memoryLimitBytes` (from `expanded_config["limits.memory"]` through `parseIncusSize`) and `cpuAllowance` (the current `limits.cpu.allowance`, or null). No process list, command line or file name is read (SPEC.md 20.1).
9. **(brief)** **Memory is the working set**: usage without reclaimable file cache. Linux counts page cache toward a cgroup's memory until it needs the room, so a workspace that reads large files sits near its limit without any real pressure. T1 checks on the pilot whether Incus's `state.memory.usage` already leaves the cache out. If it does not, the controller subtracts `inactive_file` from the instance's cgroup `memory.stat` (`/sys/fs/cgroup/lxc.payload.<project>_<name>/memory.stat`, the path `infra/tests/security/limits.sh` already reads). Reason: without this, an ordinary build would be flagged.
10. **(orchestrator)** **"Above 80% for 30 minutes" is an average over a rolling 30-minute window of the per-minute samples.** **(brief)** Each tick, for each running workspace:
    - **(user)** Usage is remembered across restarts (Todd, 2026-09-25): the window is wall-clock time, and stopping does not start a new one.
    - CPU: take the newest sample at least `window` minutes old, stopped time included (the anchor). Sum the CPU time used between each pair of consecutive samples from the anchor to now; when the counter drops, the instance restarted, so the later sample's whole value counts (a restart from zero). Time the workspace was stopped has no samples and so counts as no use. The average is `used CPU time / (nanoseconds since the anchor × cpuLimit)`, as a percentage. Because the counter is cumulative this is exact even if the worker missed some ticks. A student who runs 25 minutes and stops for one, over and over, still averages about 97% and is throttled.
    - Memory: the mean of `memoryBytes / memoryLimitBytes` over the samples in the last window of wall-clock time, and only when there are at least `window / 2` of them. Stopped minutes have no samples, so they neither raise nor lower the mean. A flag cleared at a stop can return soon after the restart if memory stays high.
    - The first judgement waits until the oldest kept sample is at least a window old, stopped time included. Before that there is no decision.
    - The rule fires when the average is strictly above the threshold, so a threshold of 100 turns that check off for a workspace.

    Reason: an average cannot be dodged by pausing a miner for one minute every half hour, which "every sample above 80%" could.
11. **(brief)** **Samples live in a new table, `workspace_usage_samples`**, one row per running workspace per minute. A workspace's rows are kept when it stops (ruling 10), except that a stop which clears a throttle deletes the rows from before that throttle, so a restart after a throttle starts fresh. Rows older than the longest allowed window plus five minutes are pruned each tick. Reason: the window survives a worker restart, and the table stays small (about 60 rows per running workspace).

### Throttling

12. **(brief)** **The throttle is a time slice, not a percentage.** The allowance is `<N>ms/100ms`, where N is the share times the CPU limit times 100 ms, rounded to a whole millisecond: 25% of 4 CPUs is `100ms/100ms`, one CPU's worth. Reason: a percentage allowance is a soft weight that only applies when the host is busy, so a miner on a quiet host would keep all four CPUs.
13. **(brief)** **The database is the source of truth, and the worker makes Incus match it every tick.** Throttling writes `workspaces.cpu_throttle` (when, the average, the threshold, the window, the share and the allowance string) and the audit row `workspace.cpu_throttled` in one transaction, then asks the controller to set the allowance (`PUT /instances/:name/cpu-allowance {allowance}`, the controller patching the instance's config). On every tick the worker compares each running workspace's `cpuAllowance` from `GET /instances/usage` with the row, and sets or removes it when they differ. Reason: the throttle survives a restart of the worker or the controller, and an administrator's lift reaches Incus even if the controller was down when they clicked.
14. **(brief)** **The allowance is removed at every start.** The controller's start removes `limits.cpu.allowance` from the instance before starting it (a read with its ETag and a guarded write, as `putIfMatch` already does). The worker clears `cpu_throttle`, deletes the samples taken at or before the throttle (ruling 11), and writes `workspace.cpu_throttle_lifted` with `{reason: "stopped"}` when it records the workspace stopped by any path. Reason: ruling 1's "lifted at the next stop and start" in one place on each side.
15. **(brief)** **A failed controller call** is audited once as `workspace.cpu_throttle_failed` and retried on the next tick; the row stays throttled. Reason: the same pattern as quota growth (`apps/worker/src/quota.ts`) without the five-minute rest, because this call is cheap.
16. **(brief)** A throttled workspace is still sampled but not judged for CPU again until it is lifted.

### Memory flag

17. **(brief)** Flagging writes `workspaces.memory_flag` (when, the average, the threshold, the window) and `workspace.memory_flagged`. The flag clears when the workspace stops (`workspace.memory_flag_cleared` with `{reason: "stopped"}`) or when an administrator clears it. A flagged workspace is not judged for memory again until it is cleared. Reason: ruling 2 said nothing about clearing, and the same life as the throttle is the least surprising.

### Settings and overrides

18. **(orchestrator)** **Platform defaults are new columns on the `settings` row**, edited in the admin Settings tab: CPU threshold 80%, memory threshold 90%, window 30 minutes, throttled share 25%, idle stop 60 minutes. **(brief)** Allowed values: thresholds 1 to 100; window 5 to 240 minutes; share 5 to 100 (100 means the throttle changes nothing); idle stop 0 (never) or 10 to 1440 minutes. The column defaults fill the existing pilot row, and the worker's `seedSettings` insert needs no change.
19. **(orchestrator)** **Per-workspace overrides are one nullable jsonb column, `workspaces.guard_config`**, holding any of `cpuThresholdPercent`, `memoryThresholdPercent`, `windowMinutes`, `throttleSharePercent` and `idleStopMinutes`; a missing key uses the platform value. This is how `quota_config` works. Edited in the workspace detail panel. Reason: "the way quotas are" (ruling 3).
20. **(user)** **The idle override is the key `idleStopMinutes` in `workspaces.guard_config`** (rulings 6b and 19), 0 for never; a missing key uses the platform value. It is edited in the same guard dialog as the CPU and memory overrides. **(brief)** Migration `0020` adds `{"idleStopMinutes": 0}` to the `guard_config` of every workspace whose owner's `shutdown_grace_seconds` is 0 (ruling 6c).
21. **(brief)** Changing a setting or override takes effect on the next tick or sweep, as the grace period does (SPEC.md 6.4). Lowering the idle time below how long a workspace has already been idle shows "Still working?" on the next sweep, never an immediate stop.

### Idle stop

22. **(orchestrator)** **Activity is reported by the web app and recorded by the API; the workspace agent reports nothing.** **(brief)** What counts, all only from the workspace's owner, never from an administrator looking at it:
    - a key press, click or paste anywhere in the Portikus page (which covers typing in a terminal and in the editor): the web app sends `{type: "activity"}` on the workspace socket, at most once a minute;
    - a file save or other write through the API's file routes (`PUT`, `DELETE`, `mkdir`, `move`);
    - a page load in a preview that the user started: the edge check `/preview/authorize` sees `Sec-Fetch-Dest` of `document` or `iframe` and `Sec-Fetch-User: ?1` (`forward_auth` passes the browser's headers on). So a load in a new tab or in the embedded Preview tab counts, while a page reloading itself, a dev server's live reload, assets and fetches do not (orchestrator ruling after the security and code reviews, 2026-09-25, PR #573).

    Terminal frames are not inspected: the browser's terminal also answers programs' queries on its own (a cursor-position report, for one), which would count a program as a person. The agent is left out because anything inside the workspace can make it say anything.
23. **(brief)** **The API writes `workspaces.last_activity_at` at most once a minute per workspace** (an in-memory map in the API process), and clears `idle_stop_at` in the same statement. The worker sets `last_activity_at` to the start time whenever it records a start, so a workspace never starts already idle. Migration `0020` sets it to the migration time for workspaces already running.
24. **(orchestrator)** **Both timers run; whichever fires first stops the workspace.** **(brief)** In the reconcile sweep, next to the grace-period step (`apps/worker/src/reconcile.ts`):
    - a running workspace with `idle_stop_at` null, an idle time `coalesce((guard_config->>'idleStopMinutes')::int, settings.idle_stop_minutes)` above 0, and `last_activity_at + idle` in the past gets `idle_stop_at = now + 5 minutes`;
    - a running workspace whose `idle_stop_at` has passed is stopped whether or not a browser is connected: `desired_state` becomes `stopped` (or `running` after a restart, as the grace step does), `workspace.idle_stopped` is written with `{idleMinutes}`, and the usual stop path follows;
    - the grace period is unchanged: with no browser connected it may stop the workspace first.

    The five minutes is fixed, not a setting. Reason: ruling 4 names it, and nobody has asked to change it.
25. **(brief)** **What the student sees.** The workspace view gains `idleStopAt`. While it is set, the work area shows a warning notice in the `DisconnectNotice` style: "Still working? Your workspace will stop in N minutes, at HH:MM, because nothing has happened in it for 60 minutes. Your files are saved; running terminals, agents and previews will end." with a **Keep working** button, which sends an activity message and takes focus when the notice appears. Any other activity also answers it. If the workspace then stops while the tab is open, the stopped screen adds "Stopped after 60 minutes without activity." (the web app knows it showed the notice; no new column). With no tab open nobody sees the notice, and the stop happens anyway.
26. **(brief)** A new connection still sets `desired_state = running` (SPEC.md 6.4), so reloading the page after an idle stop starts the workspace again, as after a grace-period stop.

### What the student and administrator see of the guard

27. **(orchestrator)** **The student sees a throttle banner at once, and nothing about memory.** **(brief)** The workspace view gains `cpuThrottle` (`{at, thresholdPercent, windowMinutes, sharePercent}` or null). While it is set, the work area shows a warning notice: "Your workspace has been slowed down. It kept its CPUs more than 80% busy for 30 minutes, so it now gets 25% of its usual CPU. Stopping and starting the workspace restores full speed; an administrator can also lift this." The numbers come from the row. The notice is dismissible for the page's life only. There is no warning before the throttle. Reason: ruling 1 asks for a banner when it happens; a warning was not asked for.
28. **(orchestrator)** **Administrators see, and lift, in three places.** **(brief)**
    - The Workspaces table gains two tags beside the name, **Throttled** and **High memory**, in the existing `Markers` style.
    - The Health tab gains a "Resource guard" section listing throttled and flagged workspaces (owner, which, since when, the average that triggered it), each linking to its detail panel.
    - The workspace detail panel gains a "Resource guard" section: the current state, **Lift throttle** and **Clear memory flag** buttons, the overrides (a dialog like the quota dialog), and the last activity time (SPEC.md 20.1's "last connection/activity time").

    Lifting writes `workspace.cpu_throttle_lifted` with `{reason: "administrator"}`, clears `cpu_throttle`, and deletes the workspace's samples so it gets a full new window before it can be throttled again. Clearing the memory flag does the same for memory. The worker removes the allowance on its next tick (ruling 13).

### Acceptable use

29. **(orchestrator)** **The statement is an administrator-edited setting with a built-in default.** **(brief)** `settings.acceptable_use_text` (null means the built-in default, a constant in `packages/contracts`) and `settings.acceptable_use_version` (starts at 1). The Settings tab gains an "Acceptable use" section with a text area and a **Reset to default** button. Plain text; blank lines separate paragraphs; at most 10,000 characters. The default says, in five short paragraphs: the workspace is for coursework and learning; no crypto mining, no public hosting or tunnels, no attacks on other systems, no sharing your account; heavy use is slowed automatically and administrators can see CPU and memory totals, not your files; breaking these rules can end your access; your institution's own rules also apply.
30. **(orchestrator)** **Any saved change to the text asks everyone to accept again.** **(brief)** Saving a different text (or resetting to the default from a custom text) adds one to the version and writes `settings.acceptable_use_updated` with `{fromVersion, toVersion}`, not the text. The section says so beside the Save button. Reason: the simplest rule an administrator can predict; a "minor edit" switch was not asked for.
31. **(brief)** **Everyone accepts**, students, instructors and administrators alike, whether they signed in through Dex or launched from a course. `users.acceptable_use_version` records the version accepted (null for never) and `users.acceptable_use_accepted_at` when. Accepting writes `user.acceptable_use_accepted` with `{version}`.

### One gate mechanism for Epics 14.2 and 14.3

32. **(orchestrator)** **The AUP is a second gate on 14.2's mechanism, not a second mechanism.** **(brief)** Epic 14.2 makes `loadSession` return `mustChangePassword` and has the auth plugin answer `403 PASSWORD_CHANGE_REQUIRED` to everything but a short allowed list, refuse WebSocket upgrades, and have the preview gateway refuse the account. This epic turns that single check into an ordered list of two, in one place in `packages/auth`:
    1. `must_change_password` set: code `PASSWORD_CHANGE_REQUIRED`, extra allowed route `POST /me/password`, web page `/change-password`;
    2. `users.acceptable_use_version` differs from `settings.acceptable_use_version`: code `ACCEPTABLE_USE_REQUIRED`, extra allowed routes `GET /acceptable-use` and `POST /me/acceptable-use`, web page `/acceptable-use`.

    `loadSession` computes both in its existing query (one join to `settings`). The first unmet gate wins, so a new local administrator changes the password, then accepts. The routes both gates allow (`GET /auth/me`, `POST /auth/logout`, and those that need no session) are shared. `/auth/me` gains `mustAcceptUse: boolean`, and the web router sends every page to the first unmet gate. Reason: one enforcement point means a new route cannot forget one of the two, and the preview gateway and WebSocket refusals come for free.
33. **(brief)** `POST /me/acceptable-use {version}` is CSRF-checked. It answers 409 `ACCEPTABLE_USE_CHANGED` when `version` is not the current one, so a person never accepts a text they did not see. The page shows the text, **I accept** and **Sign out**. Because the gate is checked on every request, a text change reaches people who are already signed in at their next request; their workspace keeps running.
34. **(orchestrator)** **Dependency on 14.2.** Everything except T6 is independent of Epic 14.2 and can be built in parallel with it. T6 edits the gate 14.2's T2 creates (`packages/auth/src/sessions.ts`, `plugin.ts`, `apps/api/src/routes/preview.ts`, `apps/web/src/router.tsx`, `useMe.ts`), so T6 starts only after Epic 14.2 has merged to `main` and `main` has been merged into `epic/14-3-resource-guard`. If 14.3 is otherwise ready first, T6 waits; nothing else does.

### Order of work

35. **(orchestrator)** Built as its own epic branch, `epic/14-3-resource-guard`. It merges to `main` after Epic 14.2, because T6 needs it. Its order relative to Epic 15 is Todd's call; the two share no files except SPEC.md, STATUS.md and OPERATIONS.md.

## Data model and configuration

**Migration `0020_resource_guard`:**

- `settings`: `cpu_guard_threshold_percent int not null default 80`, `memory_guard_threshold_percent int not null default 90`, `guard_window_minutes int not null default 30`, `cpu_throttle_share_percent int not null default 25`, `idle_stop_minutes int not null default 60`, `acceptable_use_text text` (null), `acceptable_use_version int not null default 1`, each range from ruling 18 as a check constraint.
- `workspaces`: `guard_config jsonb` (null), `cpu_throttle jsonb` (null), `memory_flag jsonb` (null), `last_activity_at timestamptz` (null), `idle_stop_at timestamptz` (null).
- `users`: `acceptable_use_version int` (null), `acceptable_use_accepted_at timestamptz` (null).
- Then `update workspaces w set guard_config = coalesce(guard_config, '{}'::jsonb) || '{"idleStopMinutes": 0}'::jsonb from users u where u.id = w.owner_user_id and u.shutdown_grace_seconds = 0` (ruling 6c). The API checks `idleStopMinutes` is 0 or 10 to 1440, as for the platform value.
- New table `workspace_usage_samples (id bigserial primary key, workspace_id uuid not null references workspaces on delete cascade, observed_at timestamptz not null, cpu_usage_ns bigint not null, cpu_limit int not null, memory_bytes bigint not null, memory_limit_bytes bigint not null)` with an index on `(workspace_id, observed_at)`.
- `down` drops the table and every column.

**Controller routes (`packages/contracts/src/controller.ts`):** `GET /instances/usage` → `{instances: [{name, cpuUsageNs, cpuLimit, memoryBytes, memoryLimitBytes, cpuAllowance}]}`; `PUT /instances/:name/cpu-allowance {allowance: string | null}` → 204. The allowance must match `^\d{1,6}ms/100ms$` or be null; the controller refuses anything else. Start removes the allowance (ruling 14).

**API routes:**

| Route | Change |
|---|---|
| `GET`/`PUT /admin/settings` | gains `cpuGuardThresholdPercent`, `memoryGuardThresholdPercent`, `guardWindowMinutes`, `cpuThrottleSharePercent`, `idleStopMinutes`, `acceptableUseText` (null resets to default), and read-only `acceptableUseVersion` |
| `PUT /admin/workspaces/:id/guard` | new; body is `guard_config`'s five keys, each a number or null (null removes the key); audit `workspace.guard_updated {from, to}` |
| `POST /admin/workspaces/:id/lift-throttle`, `POST /admin/workspaces/:id/clear-memory-flag` | new; 409 when there is nothing to lift or clear |
| `GET /admin/health` | gains `guard: [{workspaceId, owner, cpuThrottle, memoryFlag}]` |
| `GET /acceptable-use`, `POST /me/acceptable-use` | new (T6) |

**Contracts:** `Workspace` gains `cpuThrottle`, `idleStopAt` and `lastActivityAt`; the admin workspace shape gains `guardConfig`, `effectiveGuard` and `memoryFlag`; `PlatformSettings` and its update request gain the settings fields; `AuthUser` gains `mustAcceptUse` (T6). `packages/events` `ClientMessage` becomes `heartbeat` or `activity`. The workspace socket's `signatureOf` includes `cpuThrottle` and `idleStopAt`, so both reach the browser at once.

**Audit events (SPEC.md 24.11), actor `worker` unless noted:** `workspace.cpu_throttled`, `workspace.cpu_throttle_lifted` (`reason` `stopped`, or actor `user:<id>` with `reason` `administrator`), `workspace.cpu_throttle_failed`, `workspace.memory_flagged`, `workspace.memory_flag_cleared` (same two reasons), `workspace.idle_stopped`, `workspace.guard_updated` (user), `settings.resource_guard_updated` and `settings.idle_stop_updated` (user, `{from, to}`), `settings.acceptable_use_updated` (user), `user.acceptable_use_accepted` (the person). No row holds a process name, a file name or the statement's text.

No new environment setting and no Ansible change: every number is a runtime setting (ADR 0011).

## The flows

1. **A miner.** A student starts a miner on all four CPUs. Each minute the worker samples it. Thirty minutes after the first sample the average is about 100%, above 80%: the worker writes `cpu_throttle` and `workspace.cpu_throttled`, and sets `limits.cpu.allowance = 100ms/100ms`. Within a second the student's page shows the throttle notice; the Workspaces table shows **Throttled**. The miner now gets one CPU.
2. **Lifting.** An administrator opens the workspace, reads the audit row, and chooses **Lift throttle**. The row clears, its samples go, and within a minute the worker removes the allowance. If the miner is still running, it is throttled again 30 minutes later. Alternatively, the student stops and starts the workspace: the worker clears the row at the stop and the controller removes the allowance at the start.
3. **Memory.** A workspace holds 5.6 of its 6 GiB for 30 minutes. The worker writes `memory_flag` and `workspace.memory_flagged`; the admin sees **High memory**. Nothing changes for the student.
4. **A forgotten tab.** A student leaves a tab open and goes home. Sixty minutes after their last key press the worker sets `idle_stop_at`; the tab shows "Still working?". Five minutes later the worker stops the workspace and writes `workspace.idle_stopped`. The open tab shows the stopped screen with "Stopped after 60 minutes without activity."
5. **Answering.** The student comes back at minute 62 and presses **Keep working**. The API writes `last_activity_at` and clears `idle_stop_at`; the notice goes away.
6. **Tab closed.** The student closes the tab after 10 minutes. The grace period (10 minutes) stops the workspace at minute 20, well before idle stop would.
7. **First sign-in.** A new student signs in. Every page shows the acceptable-use statement until they choose **I accept**; then they reach their workspace. A new local administrator (Epic 14.2) sees **Set a new password** first, then the statement.
8. **The text changes.** An administrator edits the statement and saves. Version 1 becomes 2. A student working in their workspace gets the statement at their next request, accepts, and carries on; their workspace never stopped.

## Invariants and tests

- A workspace whose CPU average over the window is at or below the threshold is never throttled; one strictly above it is throttled exactly once, with one audit row, until it is lifted.
- A throttled running workspace always ends up with the allowance set in Incus, and an unthrottled one without it, after a restart of the worker, of the controller, or both.
- The throttle and the memory flag never outlive a stop. A started workspace never carries an allowance.
- The allowance is always a time slice, never a percentage.
- No sample, audit row or API response carries a process name, command line or file name.
- An administrator's socket, file request or preview visit on a student's workspace never counts as that student's activity.
- The workspace agent has no way to report activity.
- A running workspace with a connected browser and no activity stops `idle + 5` minutes after its last activity; one with activity every few minutes never stops by idle. The grace period's behaviour with no browser is unchanged.
- Idle 0 (platform or workspace override) never stops a workspace by idle; a workspace override wins over the platform value.
- A coding agent's output never counts as activity, so an unattended agent is stopped like anything else.
- While an account has an unmet gate, every API route except the ones ruling 32 lists answers 403 with that gate's code, a WebSocket upgrade is refused, and the preview gateway refuses the account. The password gate comes before the AUP gate.
- `POST /me/acceptable-use` with an old version answers 409 and records nothing.

## Tasks

Each task owns only the files listed; ask the orchestrator before touching any other. The migration, contracts and route shapes above are fixed, so T1, T3, T4 and T5 can build against T2 before the others land.

| Task | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|
| **T1 Controller: usage and allowance** | builder | `apps/workspace-controller/src/provider.ts`, `server.ts`, `host.ts` (the cgroup read, if ruling 9 needs it), `fake-provider.ts` and their tests; `apps/worker/src/controller-client.ts`, `fake-controller.ts` | T2 (contracts) | 1.5 days |
| **T2 Data layer and contracts** | builder | `packages/db/src/migrations/0020_resource_guard.ts`, `migrations/index.ts`, `schema.ts`, `db.test.ts`; `packages/contracts/src/controller.ts`, `workspace.ts`, `admin.ts`, `settings.ts`, `index.ts` and tests (the default statement lives in `settings.ts`); `packages/events/src/index.ts` | none | 0.5 day |
| **T3 Worker: guard and idle stop** | builder | `apps/worker/src/guard.ts` (new) and test; `apps/worker/src/index.ts` (start the loop); `apps/worker/src/reconcile.ts` and test (idle step, `last_activity_at` at start, clearing throttle and flag at stop) | T1, T2 | 2 days |
| **T4 API: settings, overrides, activity** | builder | `apps/api/src/routes/admin.ts`, `admin-workspaces.ts`, `admin-health.ts`, `workspace-view.ts`, `ws.ts`, `files.ts`, `preview.ts` (the activity write in `/preview/authorize` only) and their tests; `apps/api/src/activity.ts` (new, the once-a-minute writer) and test; `apps/api/src/fake-agent.ts` if a test needs it; `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts` | T2 | 2 days |
| **T5 Web: notices, activity, admin screens** | builder, then tester for e2e | `apps/web/src/shell/` (new `ThrottleNotice.tsx`, `IdleNotice.tsx`); `apps/web/src/WorkspacePage.tsx`, `WorkspaceStarting.tsx`, `useWorkspaceSocket.ts`; `apps/web/src/admin/SettingsTab.tsx`, `WorkspaceDetail.tsx`, `WorkspacesTab.tsx`, `markers.tsx`, `queries.ts`, new `GuardDialog.tsx`, `health/HealthTab.tsx`, `health/queries.ts`, and their tests; `e2e/resource-guard.spec.ts`, `e2e/idle-stop.spec.ts`, `e2e/a11y-resource-guard.spec.ts` (new) | T2; T4 for e2e | 2.5 days |
| **T6 Acceptable-use gate** | builder, then tester for e2e | `packages/auth/src/sessions.ts`, `plugin.ts`, `types.ts` and tests (the ordered gate list); `apps/api/src/routes/acceptable-use.ts` (new) and test; `apps/api/src/routes/auth.ts` (`/auth/me` field only); `apps/api/src/server.ts`; `apps/api/src/routes/preview.ts` (gate only); `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts`; `packages/contracts/src/auth.ts`; `apps/web/src/acceptable-use/**` (new), `apps/web/src/router.tsx` and test, `useMe.ts`; `e2e/acceptable-use.spec.ts`, `e2e/a11y-acceptable-use.spec.ts` (new); existing e2e sign-in helpers (accept once per test user) | Epic 14.2 merged into this branch (ruling 34); T2, T4, T5 (shared files, run after them) | 1.5 days |
| **T7 Rehearsal and pilot** | infra | `infra/tests/security/limits.sh` (a throttled workspace's `cpu.max` matches its allowance; an unthrottled one keeps `max 100000`); `infra/tests/smoke-test.sh` if a check is added; no role changes | T1 to T6 | 1 day |
| **T8 Fold into SPEC.md and delete this plan** | builder | `docs/SPEC.md` (6.4, 19, 20.1, 24.11, 25.6, 26, 29, and 5.1 for the AUP gate); `docs/adr/0032-resource-guard.md` (new: time-slice allowance, Incus not the agent, rolling averages, one gate list); `docs/STATUS.md`; `docs/OPERATIONS.md` (the settings and how to lift); `docs/BACKLOG.md` (remove the entry); delete `docs/EPIC-14-3.md` | all others | 1 day |

T2 starts alone and is small. T1, T4 and T5 start when it lands; T3 when T1 has. T6 waits for Epic 14.2 (ruling 34) and for T4 and T5, which touch `route-policy.ts`, `authz-matrix.test.ts` and `preview.ts`. T7 and T8 are last. Total work is about 12 agent-days; with the parallel starts about 7 working days end to end, in line with the BACKLOG's "about two weeks" once reviews and the pilot are counted.

After every task has landed: code-reviewer over the epic head, security-reviewer (the controller's new write to Incus, the gate, activity from untrusted sources, the preview gateway), and a11y-reviewer (`apps/web`).

## Test plan, per task

- **T1:** unit tests against a fake Incus socket for the usage route (a running and a stopped instance, `limits.cpu` as a count and missing, `limits.memory` in each unit `parseIncusSize` knows, an allowance present and absent); the allowance route sets and removes the key through the ETag-guarded write and refuses `25%`, `0ms/100ms` and anything not matching the pattern; start removes an allowance left on a stopped instance. **On the pilot, read-only:** record `GET /1.0/instances/<one>/state` for a running workspace and confirm the `cpu.usage` and `memory.usage` fields and whether memory includes page cache (read a large file inside the workspace and compare with `memory.stat`), and time one `recursion=2` call with every workspace running. Report both before T3 starts.
- **T2:** migration up and down on a fresh database and on one with a settings row and a user whose grace override is 0 (their workspace's `guard_config` gains `idleStopMinutes: 0`, other keys kept; other workspaces untouched); the check constraints refuse out-of-range values; contract tests for every new shape.
- **T3:** with a fake controller and a fixed clock: a steady 100% workspace is throttled at the first tick with a full window and not before; a workspace at 79% is not; one that pauses for one minute every 29 is still throttled (the average); a workspace that runs 25 minutes and stops for one, repeatedly, is still throttled with one audit row; a steady 79% is not throttled across restarts; a throttled workspace that stops and restarts starts a fresh window; a workspace stopped between the guard's read and its judgement is neither throttled nor flagged; throttling sets the allowance, writes one audit row, and a second tick writes nothing; a worker restart (a new loop over the same database) and a controller that lost the allowance both end with it set again; a lift in the database removes it; a controller failure audits once and retries; the memory flag at 91% and not at 89%, and not with fewer than half the samples; samples pruned, kept at a stop, and deleted from before a throttle that a stop clears. Idle: the warning time, the stop five minutes later with a browser connected, an activity in between cancelling it, idle 0 at either level, the workspace override winning, a shortened setting warning rather than stopping, grace firing first with no browser, and `last_activity_at` set at start.
- **T4:** route tests for each settings field and range, the guard override including `idleStopMinutes` (merge, clear one key, range, audit), lift and clear (409 when nothing is set, samples deleted, audit), the health list; activity: an owner's socket message, file write and user-started preview page load (`Sec-Fetch-Dest` `document` or `iframe` with `Sec-Fetch-User: ?1`) each set `last_activity_at` and clear `idle_stop_at`, at most once a minute; an administrator's socket, a `GET` file read, and a preview asset, fetch, or load without `Sec-Fetch-User: ?1` do not; the workspace socket pushes `cpuThrottle` and `idleStopAt` changes.
- **T5:** component tests for both notices (text from the row's numbers, the countdown, **Keep working** sends activity and has focus, dismissal), the settings sections (validation, the re-acceptance sentence), the guard dialog and the detail section buttons, the markers. Playwright: an administrator sets an override and sees it; a workspace given a throttle row in the e2e database shows the student notice and the admin tag, and **Lift throttle** clears both; with the idle time set to 10 minutes and `last_activity_at` moved back in the database, the notice appears, **Keep working** clears it, and without an answer the workspace stops and the page says why. axe on every new notice, section and dialog in both themes.
- **T6:** gate tests: an account that has not accepted gets 403 `ACCEPTABLE_USE_REQUIRED` from a sample of routes across every router file (the authorization matrix gains a column), a WebSocket upgrade is refused, the preview gateway refuses, `/auth/me` and the two AUP routes answer; an account with both gates sees the password gate first; accepting with the current version clears the gate and audits; an old version answers 409; a text change puts everyone back behind the gate; LTI and Dex accounts alike. Playwright: first sign-in shows the statement, **I accept** lands on the workspace, a changed text shows it again, **Sign out** signs out; axe in both themes. Existing e2e users are marked as having accepted in the e2e seed so the other specs are unchanged.
- **T7:** on the rehearsal VM, then the pilot: with a workspace's override set to a 5-minute window, run `stress-ng --cpu 4` (or a shell busy loop on four cores) and see the throttle land, `cpu.max` read `100000 100000`, the student notice and the admin tag; restart the controller and the worker and see the allowance stay; lift and see `cpu.max` go back to `max 100000`; stop and start and see it gone. The same for memory with a 5-minute window and a process holding 95% of the limit. Idle stop with the platform idle time set to 10 minutes. `make smoke-test` and `make security-test` pass.
- **T8:** `pnpm lint` passes; SPEC.md sections read as rules without citing this plan; no file in the repository names `EPIC-14-3.md`.

## Rehearsal and pilot, in order

1. **Rehearsal VM:** deploy the epic head's package, then T7's checks.
2. **Pilot:** snapshot the VM and take a `pg_dump`, deploy from `origin` with the full role, confirm the migration filled the settings row with the defaults and gave every workspace whose owner has a grace override of 0 an idle override of 0, run T7's checks on one test workspace, then `make smoke-test`. Rollback is the snapshot, or the previous package with migration `0020`'s `down` (after lifting every throttle, so no allowance is left behind in Incus).

## SPEC.md changes (T8)

- **6.4:** a second timer: idle stop by activity, what counts, the notice, the per-workspace override, that an unattended coding agent is stopped too, and that the grace period is unchanged.
- **19:** a new 19.4 "Resource guard": the CPU and memory rules, the averages, the time-slice throttle, when it lifts, the settings and per-workspace overrides.
- **20.1:** administrators see throttled and flagged workspaces and last activity, lift a throttle, clear a flag, and edit the guard settings, overrides and the acceptable-use statement.
- **24.11:** the new audit events.
- **25.6:** per-workspace CPU and memory samples from Incus, kept an hour.
- **26:** the new columns and table.
- **5.1:** every account accepts the acceptable-use statement at first sign-in and after it changes; the gates are ordered, password first.
- **29:** an "Epic 14.3 — Resource guard" entry.

## Unverified until T1 runs on the pilot

- That Incus's `state.cpu.usage` is CPU time in nanoseconds for a container and `state.memory.usage` is bytes, and whether memory includes page cache (ruling 9).
- That a time-slice allowance above one CPU (`100ms/100ms` with `limits.cpu = 4`) sets the cgroup's `cpu.max` to `100000 100000`, live, on the pilot's Incus.
- That one `recursion=2` instance listing with every workspace running takes well under the 60-second tick.
- That Caddy's `forward_auth` passes `Sec-Fetch-Dest` and `Sec-Fetch-User` to `/preview/authorize` (T4 checks it on the rehearsal VM).

## Risks

1. **A long unattended job is stopped.** An agent left to work for an hour, or a long build, stops at 65 minutes if the student does nothing in the page. That is Todd's ruling 6a; an administrator can set that workspace's idle override to 0.
2. **A determined student can fake activity** with a script that holds their session cookie and sends activity messages. The throttle still catches heavy CPU, and the script's requests carry the student's session, so it is their act. Nothing more is planned.
3. **A student can lift their own throttle** by stopping and starting (ruling 1), and the restart then starts a fresh window (ruling 11). Stopping and starting before a throttle does not help: usage is remembered across restarts (ruling 10, Todd 2026-09-25), so a 25-minutes-on, 1-off cycle is still throttled. Each throttle writes an audit row, so an administrator sees a repeat offender in the detail panel's recent events.
4. **A legitimate heavy job is throttled.** A 30-minute build on all four CPUs is throttled. The student sees why and can restart; an administrator can raise that workspace's threshold (100 turns the CPU check off).
5. **A text change interrupts everyone at once.** Every signed-in person meets the statement at their next request. The Settings section says so before saving.
6. **Page cache.** If ruling 9's fallback is needed, the controller reads a cgroup file, a new dependency on the host's cgroup layout; `limits.sh` already depends on the same path.

## Left out

- Blocking mining pools, tunnel services and miner programs by name (ruling 6).
- A warning to the student before the throttle, and any student-facing memory notice.
- Throttling or stopping for memory.
- Counting terminal output, running processes or CPU use as activity.
- A setting for the five-minute "Still working?" wait.
- A "minor edit, no re-acceptance" option for the statement, and formatted (Markdown) statement text.
- A history of accepted statement texts; the audit rows record versions only.
- Alerts outside the admin area (ADR 0022 still applies).

## Open questions for Todd

None. Todd answered both on 2026-09-25; they are rulings 6a to 6c.
