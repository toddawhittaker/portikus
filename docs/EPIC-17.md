# Epic 17: Platform resilience

This is the working brief for Epic 17. It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. It comes from the platform resilience audit of `main` at 87749e4 on 2026-09-26 (kept on Todd's machine, `screenshots/2026-09-26-resilience-platform.md`); the issues below quote the evidence from it.

- **Base commit:** `main` at 3da8d6b. **Epic branch:** `epic/17-platform-resilience`. Builders reset to `origin/epic/17-platform-resilience` and branch `task/17-<name>` from it.
- **Migrations:** none. No task adds one.
- **Runs beside:** Epic 16 (workspace resilience), which owns `infra/workspace-image/` and `apps/workspace-agent/`. No task here edits either. Epic 18 (admin UX) also edits the Health tab (#597, #598, #599, #603), so T4 keeps its web change small and whichever epic merges second resolves the conflict.

## Goal

One crashed service, one busy or stuck workspace, one full disk, or one runaway browser tab must not take the platform down for everyone else. The epic restarts Caddy and PostgreSQL on failure, gives the platform's own services priority over workspaces, bounds every worker and controller call, makes preview authorization cheap and capped, warns the administrator before the storage pool fills and fails fast when it does, and caps each workspace's network bandwidth.

Closes #611, #612, #613, #614, #615, #616, #617.

## Terms used throughout

- **Drop-in**: a small systemd file under `<unit>.d/` that adds settings to a unit without replacing it.
- **Slice**: a systemd group of services sharing one control group (cgroup). `system.slice` holds every platform service (API, worker, controller, Caddy, PostgreSQL, Dex, incusd). Each workspace container is its own `lxc.payload.*` cgroup, a sibling of `system.slice`.
- **CPU weight**: how the kernel shares a busy CPU among sibling cgroups. The default is 100 each, so today the whole platform counts as one workspace.
- **Thin pool**: the LVM thin-provisioned pool on the data disk that holds every workspace volume. **Metadata** is the pool's own bookkeeping space; when either data or metadata fills, the pool stops accepting writes.
- **The sweep**: the worker's reconcile loop (`apps/worker/src/reconcile.ts`), which starts, stops and provisions workspaces.
- **Forward auth**: Caddy's check with the API (`GET /preview/authorize`) before it proxies each preview request.

## Rulings

### Service restarts (#611)

1. **Caddy and PostgreSQL restart on failure with `Restart=on-failure` and `RestartSec=5`,** the same as the Portikus units and Dex. Each goes in the unit's existing drop-in: Caddy's `caddy.service.d/10-portikus-oom.conf` and PostgreSQL's `postgresql@.service.d/10-portikus-oom.conf`. Reason: with a 5-second delay, systemd's default start limit (5 starts in 10 s) can never trip, so both retry for ever, which matches every other unit and makes one CAPACITY.md sentence true for all of them. The issue's `RestartSec=2` was rejected because a crash loop then starts about five times in ten seconds, close enough to the limit to risk leaving the site down for good.
2. **No watchdogs.** Left out, as the audit recommends: they need `sd_notify` plumbing and there is no evidence of wedged processes.

### Platform priority (#612)

3. **A `system.slice` drop-in sets `CPUWeight=1000` and `MemoryLow=512M`.** CPU: the platform then wins about ten to one over each busy workspace (weight 100). Memory: under cgroup v2 a unit's `MemoryLow` only protects it up to its parent's protection, so the slice needs one for the units' settings to take effect. It lives in the `base` role.
4. **`MemoryLow=256M` on PostgreSQL (its drop-in) and the API (`packaging/systemd/portikus-api.service`).** Reason: keeps their page cache from being reclaimed first under memory pressure; the kernel's out-of-memory order (`OOMScoreAdjust=-900`) is already right.
5. **No `IOWeight` and no `limits.disk.priority`.** I/O weights take effect only under the BFQ disk scheduler, which the VM's virtio disks do not use, and PostgreSQL and the journal already sit on the root disk (vda) while workspaces use the data disk (vdb). The rehearsal records the scheduler in the task report. Host-level disk contention goes to the BACKLOG.
6. **No `limits.cpu.priority` on the workspace profile.** The slice weight alone gives the priority; a second knob would only make the two hard to reason about together.

### The sweep and the controller (#614)

7. **Every worker-to-controller call has a time budget,** passed as an `AbortSignal`: stop `2 × STOP_TIMEOUT_SECONDS + 15` s (75 s at the default, above the controller's 30 + 5 s graceful and 35 s forced tries); start `START_TIMEOUT_SECONDS + 30` s; create 300 s (generous, since creates are rare and it only has to bound a hang); list and log level 30 s; rebuild and reset-Docker 15 minutes unless they already have a bound. A call over budget throws `ControllerClientError("TIMEOUT")`, handled the way each call site already handles `INCUS_UNAVAILABLE`.
8. **The controller gives every Incus request a 30-second default timeout** when the caller passes no signal. An operation wait (`waitForOperation`) keeps its own `waitTimeout`, with its HTTP request bounded at that timeout plus 5 s.
9. **Stops run in the background.** After the compare-and-set moves a row to `stopping`, the sweep starts `doStop` without awaiting it, so no stop ever delays the next sweep's starts. A module-level set of workspace ids with a stop in flight makes step 5 (resolving stale `stopping` rows from the instance list) skip those rows, so a stop in progress is never flipped back to `running`. There is no concurrency bound: Incus runs stops in parallel, a stop frees resources, and the controller's per-instance single-flight already prevents duplicates. On worker shutdown in-flight stops are abandoned; step 5 resolves their rows after the restart, as it does after a crash today. Reason: running stops through `forEachBounded` inside the sweep, the issue's first suggestion, still makes the next sweep's starts wait up to 75 s behind one slow stop, which is the delay the audit measured.

### Preview authorization and the database pool (#615)

10. **Cache the three database lookups, not the decision.** `/preview/authorize` keeps an in-memory map from the preview cookie's token hash to the preview session, main-session user and workspace rows, for 2 seconds, filled only when all three are found. Every other check (host, port, label, owner, running state, bridge path, registry, `bridge.ensure`, activity) still runs on every request from the cached rows. The map holds at most 10,000 entries and drops expired ones as it goes. Reason: a page load of hundreds of assets costs three queries instead of three per asset, while every check that reads the request still runs.
11. **Revocation takes effect within 2 seconds, not at once.** Sign-out, a workspace stop and a session gate reach the preview gateway up to 2 seconds late. This is recorded in SPEC.md section 24.7 and BROWSER-HANDLING.md. Reason: the cache lives in the API process while stops are revoked by the worker, so exact invalidation would need a cross-process signal for a 2-second gain.
12. **Each preview session may make 2,000 authorized requests per 10 seconds.** Over that, the gateway answers 429 with a small "Too many requests" page (in `preview/pages.ts`) and logs one warning per session per window. Reason: a large Vite page (about 1,500 modules) fits in one window, while a runaway fetch loop is held to 200 requests a second.
13. **Made-up preview cookies are not cached or capped here.** Each still costs two indexed lookups; the pool timeouts (ruling 14) bound the damage. A per-address limit at the edge goes to the BACKLOG.
14. **`createDb` sets `connectionTimeoutMillis: 5000`, `statement_timeout: 30000` and `idle_in_transaction_session_timeout: 60000`** on the `pg.Pool` for every process (API, worker, controller, migrations). The API's error handler answers a pool-acquire timeout with 503 `SERVICE_BUSY` ("The server is busy. Try again in a moment."). Reason: set in the client, the guard rails are in code, covered by CI, and need no PostgreSQL role change or rehearsal; pool size stays at 10.

### Per-user rate limits (#616)

15. **The fixed-window counter moves from `signin-throttle.ts` to a new `apps/api/src/rate-limit.ts`,** which the sign-in throttle, the preview cap (ruling 12) and the new limits all use. The notifications route keeps its own list; it is left alone.
16. **Workspace lifecycle: 20 requests per minute per user** across `POST /workspaces/:id/start`, `/stop` and `/restart`. **File writes: 600 per minute per user** across every non-GET route in `routes/files.ts` and `routes/projects.ts`. Admin routes (`/admin/*`) are not limited. Reason: a person clicks a few times a minute, and an upload of a folder of files stays well under 600.
17. **Over the limit:** 429 `RATE_LIMITED`, "Too many requests just now. Try again in a minute.", with a `Retry-After` header, and one warning log line per user per window, no audit row. The web shows it through its existing error path; there is no new UI and so no Playwright test.

### Storage pool (#613)

18. **Metadata use comes from a root timer.** The `lvm` role installs `portikus-thinpool-status.service` (oneshot, root) and a timer (30 s after boot, then every 60 s) that runs `lvs --noheadings --nosuffix --separator , -o data_percent,metadata_percent <vg>/<pool>` and writes `{"observedAt": "<ISO time>", "dataPercent": <n>, "metadataPercent": <n>}` to `/run/portikus-thinpool.json`, mode 0644, by a temporary file and `mv`. Reason: Incus does not report metadata and the controller runs unprivileged with `NoNewPrivileges`, so it cannot run `lvs`; a timer and a file are the fewest moving parts.
19. **The controller's host snapshot adds `pool.metadataPercent`** (`number | null`), read from that file; null when the file is missing, unreadable or older than 5 minutes. Data use still comes from Incus, as today.
20. **Thresholds.** The pool's fill is the larger of data and metadata use. The Health tab warns at 70% ("Storage pool is over 70% full"), and shows metadata use beside data use. Memory keeps its 80% warning.
21. **The administrator is told without visiting the Health tab.** When the worker's health sample shows the pool's fill cross 70%, it records a `warning` notification ("Storage pool is N% full") for every enabled administrator; crossing 90% records a `danger` one ("Storage pool is N% full; new workspaces are refused"). Each level re-arms only after the fill falls 5 points below it. The last level is kept in memory, so a worker restart may repeat an alert once, which is accepted. Uses the existing `notifications` table (ADR 0033); no migration.
22. **New workspaces are refused at 90%.** The controller's `POST /instances` answers 507 with a new code `POOL_FULL` when the fill is 90% or more. The worker leaves the row in `provisioning`, sets `error_code = POOL_FULL` and the message "There is no room for a new workspace right now. Your administrator has been told.", audits the first refusal, and tries again on each later sweep, so the workspace is created once space is freed. Start, stop and rebuild are not refused. `POOL_FULL` is separate from the existing `STORAGE_FULL`, which means one workspace's own volume is full. If the web's provisioning screen does not already show `error_message`, T4 adds it, with a Playwright test.
23. **The pool fails writes at once when full:** `lvchange --errorwhenfull y <vg>/<pool>`, applied by the `lvm` role when `lv_when_full` is not already `error`. Reason: with `queue`, a full pool blocks every workspace's writes for about 60 s and can hang Incus operations, which stalls the sweep; with `error`, the writing program gets "No space left on device" immediately and the platform keeps working.
24. **The pilot's `pre-epic*` snapshots are not touched.** They are Todd's rollback kits, due for removal on their own schedule (2026-10-01 to 10-03).

### Network bandwidth (#617)

25. **Each workspace's `eth0` gets `limits.ingress` and `limits.egress` of `200Mbit`,** from one new `site.yml` variable, `workspace_network_limit`, applied by the `portikus_workspace_profile` role only when the device's value differs. Incus applies a profile device change to running containers too. Reason: no single workspace can fill the VM's uplink, and 25 MB/s keeps Docker pulls and preview comfortable.
26. **Connection-tracking and dnsmasq sharing are left alone.** The table holds 262,144 entries and there is no evidence of pressure; this goes to the BACKLOG with the host disk contention.

### Verification order

27. **One rehearsal pass at the end (T5), not one per infra change.** T1 lands after its static checks, so #611 reaches the epic branch first; T5 runs the whole epic head on the rehearsal VM, after Epic 16's rehearsal, and fixes what it finds in its own PR. Reason: only one rehearsal VM can exist at a time, and the orchestrator asked for a single pass. This relaxes the CLAUDE.md rule "infrastructure changes are verified before their pull request is opened" for T1 only; nothing reaches `main` or the pilot before T5 passes.

## Tasks for parallel builders

Each task owns only the files listed; ask the orchestrator before touching any other. The file format, codes, thresholds and budgets above are fixed, so T1 to T4 can run at the same time, except where a dependency is named.

| Task | What | Fixes | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|---|---|
| **T1 Host settings** | Rulings 1, 3 to 6, 18, 23, 25. Caddy and PostgreSQL restart drop-ins; `system.slice` drop-in; `MemoryLow` on PostgreSQL and the API; the thin-pool status timer and file; `errorwhenfull`; eth0 bandwidth limits. Adds checks to the smoke and security tests (heavy mode: a CPU burn in two workspaces while timing `/health` and a terminal echo; a check that Caddy and PostgreSQL come back after `systemctl kill -s KILL`; profile and pool settings read back). Rewrites the CAPACITY.md restart sentence and documents priority, bandwidth, and the 70% and 90% storage thresholds. | #611, #612, #617 (and the infra part of #613) | infra | `infra/ansible/roles/caddy/tasks/main.yml`; `infra/ansible/roles/postgresql/tasks/main.yml`; `infra/ansible/roles/base/**`; `infra/ansible/roles/lvm/**`; `infra/ansible/roles/portikus_workspace_profile/**`; `infra/ansible/site.yml` (the one variable); `packaging/systemd/portikus-api.service`; `infra/tests/smoke-test.sh`, `infra/tests/security/limits.sh`; `docs/CAPACITY.md`; `docs/STACK.md` sections it names (section 23 for the pool) | none | 1 day, then static checks only (rehearsal in T5) |
| **T2 Bounded sweep** | Rulings 7 to 9. Budgets on every controller call, the controller's default Incus timeout, background stops with the in-flight set. Unit tests: a stop over budget is aborted and does not hang the sweep; an Incus call with no signal times out at the default; a hanging stop does not delay a start in the next sweep; step 5 leaves an in-flight stop alone. Updates SPEC.md section 6.5 if it describes serial stops. | #614 | builder | `apps/worker/src/reconcile.ts`, `controller-client.ts`, `fake-controller.ts`, `index.ts` and their tests; `apps/workspace-controller/src/incus.ts` and its tests; SPEC.md section 6.5 | none | 1.5 days |
| **T3 API load limits** | Rulings 10 to 17. The preview lookup cache and per-session cap; pool timeouts and the 503; the shared counter; lifecycle and file-write limits. Unit tests: cache hit, miss, expiry and key; the cap; a full pool fails in about 5 s with 503; each new limit lets normal use through and refuses a burst with 429 and `Retry-After`. A database test drives 200 authorize requests for one session and asserts the query count stays at about three (Kysely's `log` hook counts them). Updates SPEC.md sections 24.7 and the rate-limit list in section 5.3, BROWSER-HANDLING.md's authorization section, and STACK.md if it describes the pool. | #615, #616 | builder | `packages/db/src/index.ts` and its test; `packages/contracts/src/workspace.ts` (`SERVICE_BUSY`); `apps/api/src/rate-limit.ts` (new) and test; `apps/api/src/signin-throttle.ts`; `apps/api/src/routes/preview.ts`, `apps/api/src/preview/store.ts`, `apps/api/src/preview/pages.ts` and tests; `apps/api/src/routes/workspaces.ts`, `routes/files.ts`, `routes/projects.ts` and tests; `apps/api/src/server.ts` (error handler only); SPEC.md sections 5.3 (rate limits) and 24.7; `docs/BROWSER-HANDLING.md` | none | 2 days |
| **T4 Storage warnings and refusal** | Rulings 19 to 22. `metadataPercent` in the host snapshot and `GET /admin/health`; the 70% warning and metadata on the Health tab; admin notifications at 70% and 90%; the `POOL_FULL` refusal and the worker's provisioning handling and message. Unit tests for each, and a Playwright test for the Health tab's metadata line and 70% warning (and for the provisioning message if the web had to change). Updates SPEC.md section 20.1 where it describes the Health tab. | #613 | builder | `packages/contracts/src/host.ts`, `admin.ts`, `controller.ts` and tests; `apps/workspace-controller/src/host.ts`, `server.ts`, `provider.ts` (the create refusal) and tests; `apps/worker/src/health.ts` and test; `apps/worker/src/reconcile.ts` (`userMessage` and the provisioning branch only); `apps/api/src/routes/admin-health.ts` and test; `apps/web/src/admin/health/**`; the web's provisioning screen if needed; `e2e/` files it adds; SPEC.md section 20.1 | T2 (shares `reconcile.ts`; start after T2 lands) | 1.5 days |
| **T5 Rehearsal** | On the rehearsal VM, after Epic 16's pass: `make rehearsal-up`, configure from the epic head, `make smoke-test`, `make security-test` with `PORTIKUS_SECURITY_HEAVY=1`, then the checks below; fix what fails in this task's PR (infra or app); `make rehearsal-destroy`. | (verifies all) | infra | whatever the fixes need, reported file by file | T1 to T4 | 1 day |
| **T6 Fold the plan** | Folds the lasting rules into SPEC.md (sections 6.5, 20.1, 24.7 and the rate-limit list are already updated by their tasks; this adds the restart, priority, bandwidth and storage-pool rules to section 25.3 and 4.3), writes an ADR for rulings 9, 10 to 11 and 23 (the "why"s a reader will ask; next free number when it runs, 0034 today), adds Epic 17 to SPEC.md section 29 and `docs/STATUS.md`, moves the left-out items to `docs/BACKLOG.md`, and deletes this file. | — | builder | `docs/SPEC.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/adr/`, `docs/EPIC-17.md` | T5 | 0.5 day |

T1, T2 and T3 run at the same time. T4 starts when T2 has landed. The files above do not overlap between tasks that run together; T1 and T4 both touch the storage pool, but T1 only its host side and CAPACITY.md, T4 only application code.

## Verification

- **Every task:** `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage`, and for T4 `pnpm test:e2e` with a fresh test database; `make check` before the PR.
- **T1 before its PR:** `make check` (Ansible syntax and lint), and a render of each new drop-in and unit.
- **T5 on the rehearsal VM (never the pilot):**
  - `systemctl show -p Restart caddy postgresql@17-main` reads `on-failure`; `systemctl kill -s KILL caddy`, and the site answers again within 10 s; the same for PostgreSQL, with the API recovering on its own.
  - `/sys/fs/cgroup/system.slice/cpu.weight` is 1000 and `memory.low` is set on the slice, PostgreSQL and the API.
  - Heavy security test: with two workspaces burning every CPU and writing to disk, `/health` and a terminal echo stay under the bound the test sets (record the numbers in the report, with and without the change if cheap).
  - `lvs -o lv_when_full` reads `error`; `/run/portikus-thinpool.json` exists, is fresh, and the Health tab shows metadata use; on a small loop-file thin pool made for the test, filling it fails a write at once instead of blocking. Then remove the loop pool.
  - Forced refusal: with the controller's threshold lowered by an environment override for the test only (or the file faked), a new workspace stays in `provisioning` with the message, an administrator gets the notification, and it provisions once the override is removed.
  - `incus profile device show workspace` shows both 200Mbit limits; a Docker image pull inside a workspace completes, a timed download shows the cap (about 25 MB/s), and preview works (the smoke test covers it).
  - A workspace whose stop is held (a container ignoring SIGTERM) does not delay another workspace's start.
  - The disk scheduler of vda and vdb, for ruling 5.
  - `make rehearsal-destroy` at the end.

## Left out (to docs/BACKLOG.md in T6)

- **Systemd watchdogs for the Node services:** need `sd_notify` plumbing, and there is no evidence of wedged processes.
- **Disk I/O priority** (`IOWeight`, `limits.disk.priority`): no effect without BFQ in the VM, and the platform's database already has its own disk; host-level contention between the VM's two disks was not measured.
- **A per-address limit on made-up preview cookies:** each costs two indexed lookups, bounded by the pool timeouts; an edge limit would reuse the sign-in edge throttle.
- **Connection-tracking and dnsmasq limits per workspace:** shared but with no measured pressure.
- **Rate limits on file reads, projects reads and recovery points:** reads are cheap and bounded by size caps; recovery points already have a limit.
- **Removing the pilot's `pre-epic*` snapshots:** on Todd's own schedule (2026-10-01 to 10-03).
