# Epic 11 — Administration and observability

This is the working brief for Epic 11 (`docs/SPEC.md` section 29). It was written against `main` at f82b12e. Where this file says nothing, `docs/SPEC.md` still wins on behaviour and `docs/STACK.md` still wins on technology. Issues #302 (sign-in identity and duplicate accounts) and #284 (egress allow-list) are part of this epic.

## Where this epic sits

Epic 11 runs at the same time as Epic 10 (recovery, quotas, resets) and comes before Epic 12 (hardening). Both epic branches, `epic/10-recovery-quotas` and `epic/11-admin-observability`, currently sit at `main`.

Epic 10 builds the operations: recovery points, storage accounting, quota warnings, Reset Docker and workspace rebuild. Epic 11 builds the administrator's view of those operations and the controls over them. Epic 11 must be able to land first, so each Epic 10 operation is reached through one hook file (see "Hooks for Epic 10" below).

The migration number for this epic is 0014; Epic 10 takes 0013.

## What administrators get today

- `/admin` (`apps/web/src/admin/AdminPage.tsx`) is a settings form. It holds the platform grace period, the log level, and a users table with a grace override for each user.
- `GET /admin/workspaces` exists, but no screen uses it.
- The student routes `POST /workspaces/:id/start|stop|restart` already accept an administrator. `findOwnedWorkspace` in `apps/api/src/routes/workspace-view.ts` lets administrators through, and the audit row records the administrator as the actor.
- Disabling a user means setting `users.disabled_at` by hand in SQL (STATUS.md, Epic 4 gaps). `packages/auth/src/sessions.ts` already refuses a session whose user is disabled, on every request.
- `workspaces.image_version` holds the Incus image fingerprint, not a readable version. The readable version (for example `2026.09.9`) is written into the image as `image.serial` by `infra/workspace-image/build-on-vm.sh`.
- `workspaces.quota_config` holds `{homeGiB, dockerGiB}`, the sizes given to the controller at create. CPU, memory and process limits come from the shared Incus profile (`infra/ansible/roles/portikus_workspace_profile`).
- Only the worker talks to the controller (ADR 0006). The API has no controller token.
- There are no metrics and no health view. Logs are pino JSON in journald (ADR 0012).
- Nothing records preview authorization failures or role changes in `audit_events`, although SPEC.md section 24.11 asks for both.
- The mockup is `design/mockups/AdminWorkspaces.dc.html` (and its dark and 1024 variants): a workspaces table, a detail panel, and tabs for Workspaces, Users, Audit events and Health.

## What administrators get

`/admin` becomes a page with four tabs: **Workspaces**, **Audit**, **Health** and **Settings**. The chosen tab is kept in a `tab` search parameter so it can be linked.

### Workspaces tab (SPEC.md 20.1, issue #302)

There is one row per user, with that user's workspace beside them (one workspace per student, section 6.1). Each row shows:

- display name, email, and preferred username;
- the issuer, shortened, with the full value on hover;
- the workspace label and state (a state that is changing is shown as motion, DESIGN.md section 5);
- last activity ("Now" when connected, otherwise the time since `last_active_connection_at`) and the last sign-in;
- configured storage ("Home 25 GiB · Docker 20 GiB");
- the image version, with "current" or "older";
- the connection count;
- markers: Disabled, Archived, Duplicate email, Stale.

There is a text filter plus filters for state and image. Archived rows are hidden unless "Show archived" is ticked.

Selecting a row opens a detail panel with:

- the user-facing error sentence first, then `errorCode` and `errorMessage` as technical detail (SPEC.md section 28);
- a "Copy log command" button;
- storage: the configured home and Docker sizes. While the workspace is running, it also shows live home-disk used and total, CPU and memory from the agent's usage sample. There are Docker and Recovery rows once Epic 10 supplies them;
- whether the agent answers, when the workspace is running;
- preview ports: the listening ports from the API's listening registry (port, short process name, preview reachability, system flag) and the open preview sessions (port, opened at);
- the last 10 audit events for this workspace and its owner, with "All events" linking to the Audit tab filtered to this workspace;
- actions: Start, Stop, Restart, Rebuild workspace…, Reset Docker…, Change storage…, Disable account… or Enable account, Archive workspace… or Unarchive, and the grace override for this user (moved here from the old users table).

### Audit tab (SPEC.md 24.11, 26)

Newest first, 50 rows per page, with keyset paging by id. Filters are workspace, user and action prefix. Each row shows time, actor (resolved to a display name), action, target, result and metadata as key–value pairs.

### Health tab (SPEC.md 25.6)

- The platform VM's load average and CPU count.
- Memory used and total.
- Storage-pool used and total, with a warning at 80 percent (section 19.2).
- The profile's CPU, memory and process limits.
- The current image version and fingerprint.
- Workspaces by state.
- Controller reachable or not, and the age of the last sample. The worker counts as stale when the newest sample is older than 2 minutes.
- Agents answering, as N of M running.
- 24-hour counts of: start failures, stop failures, forced stops, provision failures, controller outages, failed or denied sign-ins, and refused previews.
- The last 24 hours of pool, memory and load as 15-minute maxima, shown as a small chart.

### Settings tab

The existing grace-period and log-level sections, unchanged. Issue #284's egress policy is added here if task 7 lands.

## Decisions

- **Decision:** start, stop and restart from the admin screen call the existing `POST /workspaces/:id/start|stop|restart`. They already allow administrators and record the actor, so there is one code path and no new routes.
- **Decision:** the same audit action names are used whoever asks (`workspace.stop_requested`, `workspace.rebuild_requested`), and the `actor` column says who. Filtering by actor then works without a second vocabulary.
- **Decision:** "revoke platform access" and "disable" are one action, **Disable account**. It sets `disabled_at`, deletes the user's sessions, revokes their preview sessions, and sets their workspace's `desired_state` to `stopped`, all in one transaction with a `user.disabled` audit row. **Enable account** clears `disabled_at`. Reason: roles come from identity-provider groups at each login, so the only platform-side revocation is the disabled flag.
- **Decision:** an administrator cannot disable their own account (400). Reason: it prevents locking the last administrator out.
- **Decision:** **Archive workspace** sets a new `workspaces.archived_at` and requests a stop. The worker never starts an archived workspace. Start and restart answer 409 `WORKSPACE_ARCHIVED` ("This workspace was archived by an administrator."). The data stays where it is, and Unarchive reverses everything. Reason: SPEC.md section 20.1 lists archive separately from disable, and the #302 debris accounts need a way to be parked without deleting data.
- **Decision:** the administrator's socket on a student's workspace (`/workspaces/:id/ws`) no longer registers presence. Reason: today it sets `desired_state = running` and holds the workspace up, which quietly overrides a stop. The admin page never opens that socket, but the route allows it.
- **Decision:** storage quotas can only grow. Changing them covers home and Docker, capped at 1024 GiB each. Shrinking is refused with 400 `VALIDATION_FAILED` ("Storage can only be increased."). Reason: shrinking a filesystem that is in use is unsafe, and "full" is the failure students actually hit.
- **Decision:** a quota change is applied by the worker. The API writes `quota_config` (the size wanted). The worker compares it with a new `quota_applied` column and calls a new controller route to grow the volumes, then records the result. Reason: ADR 0006 says the API records intent and the worker acts, and the API has no controller token.
- **Decision:** CPU, memory and process limits are shown, not edited. They come from the shared profile, which Ansible owns. Reason: YAGNI; changing them per workspace goes to the backlog.
- **Decision:** the image version is read from each instance's `image.serial` config key. The current image is the one the `portikus` alias points to. An instance with no serial shows the first 12 characters of its fingerprint. Reason: the fingerprint is what the database holds, and the serial is what people recognise.
- **Decision:** host and instance facts reach the API through PostgreSQL. Every 60 seconds the worker asks the controller for one host snapshot and writes it to a new `health_samples` table, which keeps 7 days. Reason: this keeps the controller token in the worker, and the age of the newest sample doubles as the worker's heartbeat.
- **Decision:** no OpenTelemetry SDK and no Prometheus endpoint in this epic. "Metrics" means the snapshot series in `health_samples` plus counts over `audit_events`. Reason: one pilot VM with nothing to scrape an endpoint; the admin page is where an operator looks. STACK.md section 15 and the last line of ADR 0012 are updated to say so. A new ADR (next free number when it lands) records it.
- **Decision:** logs stay in journald, and the admin UI has no log viewer. The detail panel copies a ready-made command instead:

  ```text
  journalctl -u portikus-api -u portikus-worker -u portikus-workspace-controller -o cat --since -1h | grep -E '<workspace id>|<instance name>'
  ```

  Reason: every line already carries the workspace id, and shipping logs into the browser would widen the exposure ADR 0012 guards.
- **Decision:** an administrator sees workspace aggregates and never contents. That means CPU, memory, disk, port numbers, short process names and preview reachability. It never includes `/proc` command lines, the process list, terminal access or files. Reason: SPEC.md sections 20.2 and 25.10; command lines can carry secrets.
- **Decision:** preview authorization refusals that answer 403 are audited as `preview.denied` with the reason and workspace id. There is at most one row per workspace and reason per minute, and the metadata holds a count. 401 and 503 answers are not audited. Reason: SPEC.md section 24.11 asks for failures, but the edge check runs on every request, and 401 is the ordinary "sign in first".
- **Decision:** a role change at sign-in is audited as `user.role_changed` with the old and new role. Reason: SPEC.md section 24.11 "authorization changes"; roles come from identity-provider groups.
- **Decision:** an account is **stale** when it has had no sign-in for 30 days, or when another account with the same email (compared without regard to case) signed in more recently. **Duplicate email** marks every row that shares an email, and those rows sort together. The 30 days is a constant (`STALE_AFTER_DAYS` in `packages/contracts/src/admin.ts`), not a setting. There is no automatic merging. Reason: this is issue #302 as written; no one needs the threshold changed today.
- **Decision:** the account list is not paginated. Filtering happens in the browser, and the list refreshes every 5 seconds. The detail panel refreshes every 5 seconds and Health every 30. Reason: a pilot of a few hundred rows renders fine, and a push channel for administrators is not needed yet.
- **Decision:** Kysely's `allowUnorderedMigrations` is turned on in `packages/db/src/migrate.ts`. Reason: Epic 11's 0014 may reach the pilot before Epic 10's 0013. Today that would stop the API at start (`ExecStartPre` runs the migrator). Both migrations only add things.

## Hooks for Epic 10

Epic 11 defines one file, `apps/api/src/admin/operations.ts`:

```ts
export interface AdminOperations {
  readonly available: { rebuild: boolean; resetDocker: boolean };
  rebuild(input: { workspaceId: string; actorUserId: string; preserveDocker: boolean }): Promise<void>;
  resetDocker(input: { workspaceId: string; actorUserId: string }): Promise<void>;
}
export const adminOperations: AdminOperations; // both unavailable until Epic 10
```

- `POST /admin/workspaces/:id/rebuild` (body `{ preserveDocker: boolean }`) and `POST /admin/workspaces/:id/reset-docker` call the hook. While `available` is false, they answer 501 `NOT_IMPLEMENTED` ("Not available in this release.").
- The detail response carries `capabilities: { rebuild, resetDocker }`. While a capability is false, the button is disabled and explains why.
- The confirmation dialogs are built now. Each is application-styled and asks the administrator to type the workspace label (SPEC.md sections 16.4 and 17.2). Unit tests cover them with the capability turned on.
- Epic 10 edits only `operations.ts`: it points each method at the function its own student-facing route uses, and sets `available` to true. The operation writes its own audit row, and the actor is the administrator.
- The detail contract has `storage: { home, docker, recovery } | null`, each `{ usedBytes, limitBytes }`. Epic 11 always sends null there. Epic 10's storage accounting fills it in the admin route when it lands, and the UI already draws the three bars with an 80 percent warning.
- If Epic 10 adds workspace states (for example `rebuilding`), the admin state labels need matching entries. Whichever epic merges second adds them.
- Recovery restore is not an admin action in SPEC.md section 20.1, so there is no hook for it.

### What the Epic 11 PR can include without Epic 10

Everything above except live Rebuild, Reset Docker and the per-class storage bars. Specifically:

- the list and detail;
- start, stop and restart;
- disable and enable;
- archive and unarchive;
- storage grow for home and Docker, and the per-user grace override;
- preview-port inspection;
- image version;
- audit, with its new sources;
- health, and the `health_samples` sampling;
- the #302 markers.

Rebuild and Reset Docker appear as disabled buttons, their routes answer 501, and the Docker and Recovery storage rows are hidden. If Epic 10 lands first, task 3 wires `operations.ts` and the `storage` field in the same PR, and nothing else changes.

## Done

1. **Account list.** `GET /admin/users` returns every user with their preferred username, issuer, last sign-in, markers, and a workspace summary (or null). The Workspaces tab shows them as described.
   - API unit test.
   - Playwright: two users share an email, both rows show "Duplicate email", and they sit next to each other.
   - Playwright: a user whose last sign-in is 31 days old shows "Stale".
2. **Start, stop, restart.** They work from the detail panel on another user's workspace. The audit row's actor is `user:<admin id>`.
   - Playwright: stop, then the row's desired state reads stopped, then the audit tab shows the row.
3. **Disable and enable.** Disable deletes the user's sessions, revokes their preview sessions, requests a stop, and writes `user.disabled`. The student's next API request answers 401, and a new sign-in is denied. Enable lets sign-in work again. Disabling yourself answers 400.
   - API tests for each effect.
   - Playwright: disable, then the student's page is signed out.
4. **Archive and unarchive.** Archive requests a stop and sets `archived_at`. The row is hidden by default. Start and restart answer 409 `WORKSPACE_ARCHIVED` for owner and administrator alike, and the worker never starts an archived workspace, including through presence. Unarchive clears all of it. Both are audited.
   - Worker unit test.
   - API test.
   - Playwright.
5. **Storage grow.** A change to home or Docker writes `workspace.quota_updated` with from and to values. The worker applies it through the controller and writes `workspace.quota_applied`, or `...quota_apply_failed` with the error code. Until then the detail panel shows the change as pending. A smaller value answers 400.
   - Worker test against the fake controller.
   - API test.
   - Playwright covering validation and the pending state.
6. **Rebuild and Reset Docker.** Without Epic 10, both buttons are disabled with an explanation and both routes answer 501. With a capability turned on in a unit test, the dialog requires the exact workspace label before it calls the route.
7. **Preview ports.** The detail panel lists listening ports and open preview sessions. The response never contains `commandLine`, `processes`, `agent_token`, or `agentToken`.
   - API test asserting those keys are absent.
8. **Live usage.** While the workspace is running and its agent answers, the detail panel shows home disk, CPU and memory. When the agent is down or the workspace is stopped, it says "Agent not answering" or "Stopped" and not an error.
   - API tests with the fake agent up and down.
9. **Image version.** The current image version comes from the newest health sample. Each row shows its instance's version and "current" or "older". An instance with no serial falls back to the fingerprint prefix.
   - Unit test of the comparison.
   - Playwright with seeded samples.
10. **Audit tab.** Newest first, pages of 50 via `before=<id>`, filterable by workspace, user and action prefix. Only administrators can use it.
    - API test for paging and filters.
    - Playwright: filter by workspace from the detail panel's "All events".
11. **New audit sources.** `preview.denied` (throttled as decided), `user.role_changed`, `user.disabled`, `user.enabled`, `workspace.archived`, `workspace.unarchived`, `workspace.quota_updated`, `workspace.quota_applied`.
    - Each has a test.
    - The throttle test shows ten refusals in a minute give one row with count 10.
12. **Sampling.** The worker writes one `health_samples` row every 60 seconds, even when the controller is unreachable (then with `controller.reachable = false` and the error code). It deletes rows older than 7 days.
    - Worker unit test with a fake clock and the fake controller.
13. **Health tab.** It shows the numbers listed under "Health tab" above, warns at 80 percent pool or memory, and flags a sample older than 2 minutes as "Worker not reporting".
    - API test on the SQL aggregates.
    - Playwright with seeded samples and audit rows.
14. **Students refused.** A student gets 403 on every `/admin/*` route.
    - One table-driven API test lists them all, so a new route cannot miss the check.
15. **No administrator presence.** An administrator's workspace socket on a student's workspace does not set `desired_state` or count as a connection.
    - API test.
16. **Nothing secret leaves.** New log lines and audit metadata carry no tokens, command lines, prompts or file contents (STACK.md section 15, ADR 0012).
    - A test serialises every new audit row's metadata and checks it against a list of allowed keys.
17. **Out-of-order migrations.** Applying 0014 and then a later-arriving 0013 succeeds.
    - `packages/db` test with a stand-in 0013.
18. **Old tests still pass.** The grace-period and log-level controls work unchanged on the Settings tab. `e2e/admin.spec.ts` passes after its selectors are updated to open that tab.

Issue #284 has its own done list under task 7.

## Out of this epic

- OpenTelemetry, a metrics endpoint, log shipping, and a log viewer in the browser.
- Impersonation, terminal or file access for administrators, and a break-glass button (SPEC.md sections 20.2 and 20.3).
- Merging duplicate accounts; deleting a user, a workspace, or its volumes.
- Re-provisioning a workspace stuck in `error` after a failed create (stays in `docs/BACKLOG.md`).
- Per-workspace CPU, memory or process limits, and shrinking storage.
- Storage accounting for Docker and recovery, the recovery quota, student-facing quota warnings, Reset Docker, rebuild and restore themselves (all Epic 10).
- Rate limiting and journald sizing (BACKLOG, "Request rate limiting and journal sizing").
- Audit retention and export.
- Bulk actions, and live push updates to the admin page.
- A student-side "archived" screen: the 409 message is what the student sees.
- Smoke-test changes: the smoke test cannot be run on the only VM (see "Real-host constraints").

---

# Task split

Task 1 lands first. Tasks 2 to 6 then run in parallel. Task 7 comes last and may slip to Epic 11.1.

A file a task "owns" is edited only by that task. Once task 1 has merged, the files it created as empty or placeholder stubs pass to the task named below, and task 1 does not touch them again.

## Task 1 — Shared contracts, migration 0014, and scaffolding

**SPEC sections:** 20.1, 24.11, 25.6, 26, 27; STACK.md sections 5 and 6.

**Owns:**

- `packages/contracts/src/admin.ts` (new):
  - `AdminWorkspaceSummary`, `AdminWorkspaceDetail`, `AdminAccountMarkers`
  - `UpdateQuotaRequest`, `RebuildRequest`
  - `AuditQuery`, `AuditEvent`, `AuditPage`
  - `HealthReport`, `AdminCapabilities`, `STALE_AFTER_DAYS`
- `packages/contracts/src/host.ts` (new, controller side): `HostSnapshot`, `GrowVolumesRequest`, `GrowVolumesResponse`
- `packages/contracts/src/index.ts` (export lines)
- `packages/contracts/src/settings.ts`: additive fields on `AdminUser` (`preferredUsername`, `issuer`, `lastLoginAt`, `markers`, `workspace`)
- `packages/contracts/src/workspace.ts`:
  - `archivedAt` on `Workspace`
  - `WORKSPACE_ARCHIVED` in `ApiErrorCode`
- `apps/api/src/routes/workspace-view.ts` (fill `archivedAt` only)
- `packages/db/src/migrations/0014_admin.ts`, `packages/db/src/migrations/index.ts`, `packages/db/src/schema.ts`
- `packages/db/src/migrate.ts` (`allowUnorderedMigrations: true`) and `packages/db/src/db.test.ts`
- `apps/api/src/server.ts`: register new route files, and pass `routeDeps` (which carries the listening registry) to them
- Stubs handed on:
  - `apps/api/src/routes/admin-workspaces.ts` and `apps/api/src/admin/operations.ts` go to task 3
  - `apps/api/src/routes/admin-audit.ts` and `apps/api/src/routes/admin-health.ts` go to task 4
  - `apps/web/src/admin/audit/AuditTab.tsx` and `apps/web/src/admin/health/HealthTab.tsx` (placeholder components) go to task 6

**Migration 0014 adds:**

- `workspaces.archived_at timestamptz null`
- `workspaces.quota_applied jsonb null`, backfilled from `quota_config`
- a `health_samples` table: `id bigserial`, `observed_at timestamptz not null default now()`, `sample jsonb not null`, with an index on `observed_at`
- indexes on `audit_events`: `(target, id desc)`, `(actor, id desc)`, `(action, at)`

This is the only migration for tasks 2 to 6. If one of them finds it needs a column, it asks the orchestrator, who adds it to 0014 while nothing has deployed it yet. Task 7 takes 0015.

**Depends on:** nothing.

**Real-host verification:** no.

**Done:**

- `pnpm typecheck`, lint and tests pass.
- Contract unit tests: round-trips, grow-only validation in `UpdateQuotaRequest`, and the `HostSnapshot` shape.
- A `db` test: 0014 applies and rolls back, and the out-of-order case (done item 17) passes.
- The stubs compile and answer nothing (no routes registered yet).

## Task 2 — Controller and worker: host snapshot, image version, storage grow, archive guard

**SPEC sections:** 6.3, 19.1, 20.1, 21.8, 22, 25.6; STACK.md sections 7, 9 and 24; ADR 0006.

**Owns:**

- `apps/workspace-controller/src/host.ts` and `host.test.ts` (new)
- `apps/workspace-controller/src/provider.ts`: append `hostSnapshot()` and `growVolumes()` to the interface and the Incus provider, and change nothing else
- `apps/workspace-controller/src/fake-provider.ts`
- `apps/workspace-controller/src/server.ts`: `GET /host` and `POST /instances/:name/volumes`, both behind the existing bearer token
- `apps/worker/src/health.ts` and `apps/worker/src/quota.ts` (new), with tests
- `apps/worker/src/controller-client.ts`, `apps/worker/src/fake-controller.ts`
- `apps/worker/src/index.ts`: two timers, each on its own interval like the log-level sync
- `apps/worker/src/reconcile.ts`: add `archived_at is null` to the two start queries (steps 3b and 3d) and nothing else

**What the host snapshot contains:**

- load average (the controller reads `/proc/loadavg` on the VM)
- CPU count and memory from `/1.0/resources`
- pool usage from `/1.0/storage-pools/<pool>/resources`
- profile limits from `/1.0/profiles/<profile>`
- the current image from alias `portikus`, then `/1.0/images/<fingerprint>` for `properties.serial`
- for each instance, `config["image.serial"]` from `/1.0/instances?recursion=1`

**How storage grow works:** `PATCH` the custom volume's `size` for `<name>-home` and `<name>-docker`. It refuses a smaller size.

The worker's quota loop:

- picks rows where `quota_config` is not the same as `quota_applied` and an instance exists;
- calls grow;
- writes `quota_applied` and the audit row.

It skips rows in `provisioning`.

**Depends on:** task 1.

**Real-host verification:** yes, and it must be done first as a spike (see "Real-host constraints"):

- confirm the three Incus response shapes, read-only;
- confirm `image.serial` is present on an existing instance, read-only;
- confirm growing a filesystem volume on LVM thin works while the instance runs, on a scratch volume and instance.

If growing live is refused, `quota.ts` applies the change at the next stop instead, and the pending text says "applies at next stop".

**Done:**

- Unit tests for each controller route against the fake provider and against a mocked Incus client.
- A test that grow refuses a shrink.
- Worker tests: a sample every 60 seconds with a fake clock; an unreachable controller still writes a row; rows older than 7 days are pruned; a pending quota is applied once and audited; an archived row is never started.
- Controller and worker coverage floors hold.
- A short real-host note goes in the PR body: the commands run and their output with ids masked.

## Task 3 — API: accounts and workspace controls

**SPEC sections:** 5.2, 5.3, 6.4, 14.4, 16.4, 17.2, 18.3, 19, 20.1, 20.2, 24.8, 24.11, 28; issue #302.

**Owns:**

- `apps/api/src/routes/admin.ts`:
  - extend `GET /admin/users` with markers and workspace summary
  - `POST /admin/users/:id/disable` and `.../enable`
- `apps/api/src/admin/markers.ts` (new, pure: duplicate and stale logic)
- `apps/api/src/routes/admin-workspaces.ts`:
  - `GET /admin/workspaces/:id` (detail)
  - `POST .../archive` and `.../unarchive`
  - `PUT .../quota`
  - `POST .../rebuild` and `.../reset-docker`
- `apps/api/src/admin/operations.ts` (the Epic 10 hook)
- `apps/api/src/routes/workspaces.ts`: 409 on start or restart of an archived workspace
- `apps/api/src/routes/ws.ts`: no presence for a non-owner administrator
- Tests: `admin.test.ts`, `admin-workspaces.test.ts`, `workspaces.test.ts`, `ws.test.ts`

**Where the detail data comes from:**

- the image is joined from the newest `health_samples` row;
- live usage is the agent's `/usage` with `processes` removed;
- ports come from the listening registry, keeping only `port`, `process.command`, `previewReachability` and `system`;
- sessions are `preview_sessions` rows where `revoked_at is null`;
- the agent probe is `/health` with a 2-second timeout;
- recent audit is the last 10 rows where the target is the workspace or its owner, or the actor is the owner.

**Depends on:** task 1.

**Real-host verification:** no. After deploy, the verifier opens the detail views on the pilot and does nothing else.

**Done:**

- Done items 1 to 8, 14 and 15 are covered by API tests, including the student-refused matrix.
- API line coverage stays at or above 85 percent.
- Playwright for these routes lives in task 5.

## Task 4 — API: audit and health read models, and the missing audit sources

**SPEC sections:** 24.11, 25.6, 25.10, 26; STACK.md section 15; ADR 0012.

**Owns:**

- `apps/api/src/routes/admin-audit.ts` (`GET /admin/audit`) and its test
- `apps/api/src/routes/admin-health.ts` (`GET /admin/health`) and its test. Its SQL covers:
  - the newest sample;
  - 96 fifteen-minute maxima using `date_bin`;
  - state counts;
  - 24-hour audit counts;
  - agent probes for running workspaces, run in parallel with a 2-second timeout
- `apps/api/src/preview/audit-throttle.ts` (new) and `apps/api/src/routes/preview.ts` (audit the 403 refusals in `/preview/authorize`)
- `apps/api/src/routes/auth.ts` and `packages/auth/src/sessions.ts` (`upsertUser` returns the previous role so `user.role_changed` can be written)
- `docs/adr/00NN-operational-metrics-in-postgres.md` (next free number), the `docs/STACK.md` section 15 wording, and the last sentence of `docs/adr/0012-structured-logging.md`

**Depends on:** task 1.

**Real-host verification:** no (read-only look after deploy).

**Done:**

- Done items 10 to 13 and 16 at API level.
- The throttle test.
- A role-change test through the mock identity provider with groups changed.
- `pnpm test` shows the preview tests unchanged apart from the new audit assertions.

## Task 5 — Web: the Workspaces tab, detail panel, actions, and the Settings tab

**SPEC sections:** 8, 20.1, 25.8, 28; DESIGN.md sections 4 and 5; `design/mockups/AdminWorkspaces*.dc.html`; issue #302.

**Owns:**

- `apps/web/src/admin/AdminPage.tsx` (tab shell, `tab` search parameter)
- `apps/web/src/admin/queries.ts`
- new files in `apps/web/src/admin/`: `WorkspacesTab.tsx`, `WorkspaceDetail.tsx`, `ConfirmByLabelDialog.tsx`, `QuotaDialog.tsx`, `SettingsTab.tsx` (the existing grace and log-level sections move here), `markers.tsx`, `logCommand.ts`
- their unit tests
- `apps/web/src/router.tsx` (the `/admin` search validation only)
- `e2e/admin.spec.ts` (selector updates)
- `e2e/admin-workspaces.spec.ts` (new)

The detail panel's "All events" link goes to `/admin?tab=audit&workspace=<id>`.

Use `packages/ui` primitives only: Radix dialogs and menus, and an application-styled confirmation. Every row action has a name that says whose it is, following the #371 pattern.

**Depends on:**

- task 1 for code;
- task 3 merged before this PR opens, because Playwright runs against the real API. Seed state with `e2e/helpers.ts` `query` and `setWorkspaceState`, because no worker runs in e2e.

**Real-host verification:** no.

**Done:**

- Unit tests: markers, filters, pending quota, disabled Rebuild and Reset Docker with an explanation, and the confirm dialog requiring the exact label.
- Playwright:
  - done items 1 to 5;
  - duplicate and stale rows;
  - stop from admin;
  - disable signs the student out;
  - archive hides the row and refuses start;
  - quota shrink refused and grow shown as pending;
  - the old grace and log-level tests pass on the Settings tab.
- Accessibility: the table has a caption, the detail panel is a labelled region, and focus returns to the row after a dialog.

## Task 6 — Web: the Audit and Health tabs

**SPEC sections:** 24.11, 25.6, 25.8; DESIGN.md section 4 ("Admin: audit and health").

**Owns:**

- `apps/web/src/admin/audit/*` and `apps/web/src/admin/health/*`: components, their own `queries.ts`, and tests
- `e2e/admin-audit.spec.ts` and `e2e/admin-health.spec.ts` (new)

The chart follows the repository's existing chart conventions. If there are none, use a plain inline SVG sparkline with a text fallback and no new dependency.

**Depends on:** task 1 for code; task 4 merged before this PR opens.

**Real-host verification:** no.

**Done:**

- Unit tests: paging, filters from search parameters, 80 percent warning, stale-worker banner, and controller-unreachable state.
- Playwright:
  - seeded audit rows filter by workspace and page with "Older";
  - seeded samples show the pool warning;
  - a sample 3 minutes old shows "Worker not reporting".

## Task 7 — Egress allow-list for each deployment (issue #284)

**SPEC sections:** 23.1, 23.2, 24.1, 24.2, 25.6; STACK.md sections 15, 24 and 29; issue #284.

**Owns:**

- `packages/contracts/src/egress.ts` (new)
- `packages/db/src/migrations/0015_egress.ts`, plus its lines in `migrations/index.ts` and `schema.ts`: `settings.egress_policy jsonb not null default '{"mode":"open","destinations":[]}'`
- `apps/workspace-controller/src/egress.ts` (new), with one route line in `server.ts`
- `apps/worker/src/egress.ts` (new), with one timer line in `index.ts`: apply when the policy changes, and resolve hostnames hourly
- `apps/api/src/routes/admin-egress.ts` (new; `GET` and `PUT /admin/egress`, audited as `settings.egress_updated`)
- `apps/web/src/admin/egress/*` (a section rendered from `SettingsTab.tsx`, with one import line there)
- `infra/ansible/roles/incus_network/*`: behind a new variable `portikus_egress_managed`, default `false`
- `e2e/admin-egress.spec.ts`

It edits `server.ts`, `index.ts`, `SettingsTab.tsx`, `migrations/index.ts` and `schema.ts` only after tasks 1, 2 and 5 have merged.

**Depends on:** tasks 1, 2 and 5. Starts with a spike.

**Real-host verification:** yes, heavy, and gated.

**Spike:** measure Incus ACL rule priority on a bridge network. The question is whether a network-level allow of `0.0.0.0/0` can be overridden per NIC. The spike runs on a scratch instance with its own NIC ACL and never on the shared `<net>-acl`. It writes the result into an ADR.

- If allow-list mode can only be enforced by removing the shared catch-all allow, the task stops after the spike. It lands the contracts, the settings UI in "open" mode, and a rendering that is unit tested. The live cutover then becomes Epic 11.1 with a maintenance window.

**Done (if the full task lands):**

- Unit tests turn a policy into ACL rules, for both open and allow-list modes.
- A controller apply test against the fake provider.
- Presets for package registries, Git hosts, and the agent providers.
- Open mode produces exactly today's rules, and deploying with `portikus_egress_managed: false` changes nothing on the pilot.
- A count of denied connections appears on the Health tab. It is read from the ACL log, and the destinations never appear in labels or logs.
- The infra check that a denied destination is refused and an allowed one is not runs on the scratch instance only.

---

# Real-host constraints

The only VM is the live pilot. It runs three student workspaces that must not be stopped, restarted, resized, rebuilt, re-networked, or slowed. It also holds two old debris workspaces from #302 (labels `ws-c21ed03b` and `ws-a3539de7`).

- **Do not run `make smoke-test` on the pilot.** It stops and starts workspaces and shortens the platform grace period (WORKFLOW.md, "Infrastructure smoke test").
- **Before any real-host step, list what is there, read-only.** Run `incus list --project portikus` and `GET /admin/workspaces` as carol. Write down the instance names of the three student workspaces and the two debris ones in the task report, and never name them in a command that changes anything.
- **Read-only Incus checks are safe at any time.** These are:

  ```text
  incus query /1.0/resources
  incus query /1.0/storage-pools/<pool>/resources
  incus query /1.0/profiles/<profile>
  incus query /1.0/images/aliases/portikus
  incus config get <one existing instance> image.serial --project portikus
  ```

- **Volume-grow and ACL spikes use scratch objects only.**
  - Scratch names start with `e11-scratch-` (a custom volume of 1 GiB and one container) in the `portikus` project.
  - Check pool free space first.
  - Delete the scratch objects when done.
  - Never grow or patch a `ws-*` volume, and never change the shared `<net>-acl`, the network's `security.acls`, or the workspace profile.
- **Deploying a locally built package to the pilot** (`make deploy-app`) needs Todd's go-ahead, at a quiet time.
  - It restarts the API, worker and controller. Running containers and tmux sessions survive, and browsers reconnect within seconds.
  - Migration 0014 only adds things, so old code ignores it. With `allowUnorderedMigrations` on, Epic 10's 0013 can still apply afterwards.
  - Rolling back means installing the previous package; 0014 stays in place harmlessly.
- **After deploy, the admin screen on the pilot is looked at, not operated.** No start, stop, disable, archive, or quota change on the three student workspaces. The one exception is the debris accounts, and only if Todd agrees (see open question 6): disabling and archiving them is the intended first real use of the feature and the real-host test of it.
- **Sampling load** is one controller call per minute, each a handful of local Incus queries. Nothing is added to the per-second sweep.

# Risks and open questions

1. **Migration order between Epic 10 and Epic 11.** Kysely refuses a migration that arrives before one already applied, and the API's `ExecStartPre` would then fail at start.
   - *Recommendation:* enable `allowUnorderedMigrations` in task 1, with the test in done item 17. Tell Epic 10 so it does not add the same line.
2. **Merge conflicts with Epic 10** in `provider.ts`, `fake-provider.ts`, controller `server.ts`, `controller-client.ts`, `fake-controller.ts`, `reconcile.ts`, `migrations/index.ts`, `schema.ts` and `contracts/src/index.ts`.
   - *Recommendation:* Epic 11 puts its logic in new files and only appends to the shared ones, as the task split says. Whichever epic merges to `main` second resolves the conflicts, and the orchestrator does it rather than a builder.
3. **OpenTelemetry.** STACK.md section 15 says to use it "where practical", and ADR 0012 says metrics arrive with Epic 11.
   - *Recommendation:* no OpenTelemetry in this epic. PostgreSQL samples plus audit counts cover SPEC.md section 25.6 for one VM. Record it in an ADR and amend both documents. Add a BACKLOG item "OpenTelemetry export when a second VM or an external monitor exists".
4. **Who owns quota changes.** The request frames quota enforcement as Epic 10, while SPEC.md section 20.1 puts "adjust quotas" in administration.
   - *Recommendation:* Epic 11 owns growing home and Docker. Epic 10 owns accounting, warnings, the recovery quota, and filling `storage`. If Epic 10's plan already includes a resize, task 2 drops `growVolumes` and `quota.ts` calls Epic 10's route instead.
5. **Growing a volume while it runs on LVM thin** may not be allowed.
   - *Recommendation:* settle it in task 2's spike. If it is refused, apply at the next stop and say so in the UI. Do not stop a student's workspace to apply a quota.
6. **Using the debris accounts for the real-host test.**
   - *Recommendation:* ask Todd. If he agrees, disable and archive both debris accounts from the new screen after deploy. That is exactly what #302 wants done by hand today, and it touches no live student.
7. **No spare mock user** for pilot tests. The mock identity provider has alice, bob, carol and dave, and the pilot's students may be using them.
   - *Recommendation:* verify every changing admin action locally (Playwright, fake controller). Do not add a pilot test user in this epic.
8. **`image.serial` may be missing** on instances created from older images.
   - *Recommendation:* fall back to the fingerprint prefix and "older" whenever the fingerprint is not the current one. Confirm on one instance, read-only, during task 2.
9. **Administrator privacy.** Showing live usage and ports for another user's workspace goes a little further than today.
   - *Recommendation:* aggregates and port facts only, with the response keys pinned by test (done items 7 and 16). No process list or command lines. The security reviewer checks this at the epic head.
10. **Existing hole:** an administrator's workspace socket starts the student's workspace and keeps it running.
    - *Recommendation:* fix it in task 3 (done item 15). It is small and exactly the kind of silent override section 20.2 warns about.
11. **Issue #284 changes the shared network of the live pilot.**
    - *Recommendation:* it is task 7, last, behind `portikus_egress_managed: false`, and starts with a spike on scratch objects. If enforcing it needs the shared ACL changed, cut it over in Epic 11.1 during a window Todd schedules. The Epic 11 PR does not wait for it.
12. **`audit_events` grows without a limit,** and the preview refusals add rows.
    - *Recommendation:* the throttle plus the new indexes are enough for the pilot. Add a BACKLOG item "Audit retention policy (SPEC.md 25.10)" rather than building pruning now.
13. **Epic 10 may add workspace states** that the admin state labels and the Zod enum do not know.
    - *Recommendation:* whichever epic merges second adds the labels. The admin table shows an unknown state as its raw name, not as an error.
14. **Docs to update in the epic PR:**
    - SPEC.md section 29, Epic 11: point to this file;
    - SPEC.md section 20.1: note what disable, archive and grow-only mean;
    - STACK.md section 15;
    - STATUS.md: a new Epic 11 section;
    - BACKLOG.md: OpenTelemetry, audit retention, per-workspace CPU and memory limits, re-provision stays;
    - DESIGN.md section 3: the starting point changes.

    *Recommendation:* the orchestrator writes these in the final documentation PR onto the epic branch, not in the builders' tasks.

---

## Orchestrator rulings (2026-09-22)

These rulings settle overlaps between Epics 10, 11, and 12a, which are built in parallel. They override anything above that disagrees.

1. **Rebuild and Reset Docker routes belong to Epic 10.** Epic 10 registers `POST /workspaces/:id/reset-docker` (owner or administrator) and `POST /admin/workspaces/:id/rebuild` with body `{ resetDocker: boolean }` (administrator only), in a new file `apps/api/src/routes/maintenance.ts`, not in `admin.ts` or `workspaces.ts`. Epic 11 does not register either route and has no `operations.ts` hook. Epic 11's admin detail response reports `capabilities: { rebuild, resetDocker }` by asking Fastify whether those routes exist (`app.hasRoute`), so the buttons turn on by themselves once Epic 10 is merged, whichever epic lands first. Epic 11's dialogs call those two paths with that body.
2. **The admin page belongs to Epic 11.** Epic 10 does not edit `apps/web/src/admin/` or `e2e/admin*.spec.ts`. Epic 10's administrator path is covered by its API route tests and the smoke block; its admin buttons come from Epic 11. Epic 10 drops `e2e/admin-rebuild.spec.ts`.
3. **Unordered migrations.** Epic 11 task 1 turns on `allowUnorderedMigrations` in `packages/db/src/migrate.ts`. Epic 10 does not touch `migrate.ts`. Epic 10 uses migration 0013, Epic 11 uses 0014.
4. **Storage figures.** Epic 11's admin detail sends `storage: null` until Epic 10's per-class storage is on the same branch; whichever epic merges into main second fills it in.
5. **Issue #284 (egress allow-list) is deferred** to a later epic. Epic 11 task 7 is not built in this run. Epic 12a's network suite will show what egress is open today, which feeds that decision.
6. **Real host.** No builder stops, restarts, resizes, rebuilds, resets, or restores any existing student workspace, and none runs `make smoke-test` on the pilot while student workspaces exist. Epic 10 verifies on scratch instances it creates and removes itself, after taking `pre-epic10` snapshots of the student home volumes and a `pg_dump`. When Epic 10 has to install its package on the pilot to verify, the pilot is put back on the `main` package afterwards, so students never stay on unreviewed code. Epic 11's real-host work is read-only Incus queries plus volume-grow checks on `e11-scratch-*` objects. Epic 11 does not deploy to the pilot, and it does not disable or archive the #302 debris accounts; that waits for Todd.
7. **Shared tooling.** Every epic branch first receives the same "Per-run e2e ports and sharded browser tests in CI" change, so parallel Playwright runs do not clash.
8. **Docs.** Builders do not edit `docs/STATUS.md` or `docs/BACKLOG.md`; the orchestrator writes each epic's STATUS section and BACKLOG notes in a closing PR. SPEC.md edits named in a task stay with that task.

### Merging with Epic 10

Whichever of Epics 10 and 11 merges into main second has to make these changes while resolving the merge:

- Reset Docker and Rebuild must pass the row's `quota_config.dockerGiB` to the controller, falling back to the default size when it is missing. The spot is `reconcile.ts` on `epic/10`, around lines 884 to 890.
- The create path writes `quota_applied` as the two-key `result.quota` (homeGiB and dockerGiB only), never with Epic 10's `recoveryGiB`.
- Flip the tests that expect Rebuild and Reset Docker to be disabled: `e2e/admin-workspaces.spec.ts`, and `admin-workspaces.test.ts`, which expects `rebuild` to be false.
- `db.test.ts` needs 14 `migrateDown` calls, and `0013_recovery` in its migration list.
- The worker's start step (3b) and its error-retry step (3d) keep both `pending_operation is null` and `archived_at is null` in their conditions.
- Take the union of both epics' additions to `ApiErrorCode`.
- The admin detail fills in `storage`, and it disables Rebuild and Reset Docker while `pendingOperation` is set.
