# Epic 10: Recovery, quotas, and reset workflows

This is the working brief for Epic 10 in `docs/SPEC.md` section 29. The base is `main` at `f82b12e`. Where this file says nothing, `docs/SPEC.md` still wins on behaviour and `docs/STACK.md` still wins on technology.

The sections this epic serves are:

- SPEC 2.10, 4.3, 4.4, 6.6
- SPEC 7.3 and 7.4 (archive and delete trigger points)
- SPEC 10.9 (restoring the pre-session state was left to this epic; see STATUS.md, Epic 9 "Left out")
- SPEC 12.5, 15, 16.4, 16.5, 17, 18.3, 19, 20.1 (reset and rebuild only), 22.3, 24.6, 24.8, 24.9, 24.11, 25.7, 26, 27, 28
- STACK 6, 7, 9, 10, 13, 23, 24, 32
- ADR 0005 (Incus REST), ADR 0006 (worker is the only writer of `state`), ADR 0010 (project operations in the agent), ADR 0019 (session baseline)

## Where this epic sits

Epics 0 to 9.2 are on `main`. Epic 11 (administration and observability) and Epic 12 (hardening) come after this one.

Epic 11 owns:

- the redesigned admin workspace list
- the admin screen for inspecting and changing quotas
- metrics

This epic builds the operations and the smallest controls that let a student and an administrator use them.

## What the student gets

**Recovery points for each project.** Portikus keeps compressed copies of each active project outside the project folder. It makes one:

- every 15 minutes while the project has changed
- before the project is archived
- before a restore
- before an administrator rebuilds the workspace
- before a Claude Code or Codex session starts
- when the student clicks **Create recovery point now**

No copy ever touches Git: no commit, branch, tag, stash entry, index change, or ref move (SPEC 12.5).

**A Recovery points dialog.** It opens from the project's menu in the left pane. It lists each point with its time, its reason ("Every 15 minutes", "Before Claude session", and so on) and its size, plus how much of the recovery allowance is in use.

**Restore.** Restoring a point uses an application-styled confirmation. It names the project and the timestamp, says that current files will be replaced, and says that a recovery point of the current state is made first (SPEC 15.8).

**Restore to before this session.** The session review header ("Changes since Claude session started") gains a **Restore to before this session** action when that session has a recovery point (SPEC 10.9).

**`.workspaceignore`.** A student can put this file at the project root to leave paths out of recovery points (SPEC 15.5).

**Storage accounting.** The workspace dialog shows three storage classes with used and total: Projects & home, Docker, and Recovery (SPEC 18.3, 19.2).

- When any class reaches 80%, the status bar shows a warning that names the class.
- At 95% the warning says which class is nearly full and what to do next (SPEC 19.2, 28).

**Reset Docker.** Available in the workspace dialog, behind an application-styled confirmation. It lists what is lost (images, containers, volumes, build cache, running programs) and what survives (projects, home, recovery points) (SPEC 16.4).

**Rebuild explained.** One line in the workspace dialog explains rebuild: an administrator can rebuild the workspace system; home and projects are kept; programs installed with `sudo apt` are not (SPEC 17.3).

## What the administrator gets

- **Reset Docker** and **Rebuild workspace** actions on each user row of the existing `/admin` page (SPEC 17.2, 20.1). Rebuild keeps Docker data by default and has a checkbox to reset it as well. Epic 11 replaces this page. These are the minimum controls needed to drive and test the operations.
- Audit rows for the following (SPEC 24.11):
  - every restore
  - every Reset Docker request and its result
  - every rebuild request and its result

## Decisions where the spec is silent

**Where recovery data lives.**

- Decision: each workspace gets a third custom Incus volume, `<instance>-recovery`, next to `-home` and `-docker`. It is sized from `WORKSPACE_RECOVERY_SIZE_GIB` (default 3, SPEC 19.1) and mounted at `/var/lib/portikus/recovery`. The directory is owned by uid 1000 with mode 0700; each archive is mode 0600. Reason: SPEC 19.1 and 19.2 make Recovery its own storage class with its own limit, and a separate volume enforces that limit and survives a rebuild without special handling.
- Decision: the controller adds this volume to existing workspaces at their next start. If that step fails, it logs and the start still succeeds. Reason: the three pilot workspaces must never be locked out by a new feature.
- Decision: archives are stored at `/var/lib/portikus/recovery/<projectId>/<pointId>.tar.zst`, keyed by project id and not slug. Reason: a rename must not orphan them.

**Who makes and restores archives.**

- Decision: the workspace agent. It runs GNU `tar` (always in the image) with an explicit file list, `--null -T - --no-recursion`, and pipes the output through Node 24's built-in `zlib.createZstdCompress`. Reason:
  - no image rebuild is needed, because `zstd` is not in the image and existing roots do not rebase (SPEC 22.1)
  - the format is still `tar.zst` (SPEC 15.3)
  - the agent already does every filesystem operation (ADR 0010)
- Decision: user-triggered creates and restores run inside the API request, using the existing one-at-a-time slot (`claimLongOperation`). The worker runs the periodic points, the pre-rebuild points, and retention. Reason: this matches how clone, duplicate and delete already work.
- Decision: the agent holds an in-memory lock for each project and answers 409 `BUSY` to a second operation on that project. Reason: it covers the API and the worker racing each other.

**What goes in an archive.**

- Decision: everything under the project, including `.git`, `.env` and other Git-ignored files, minus the exclusions below. Reason:
  - SPEC 15.4 says not to trust `.gitignore`
  - including `.git` is what makes an agent's `git reset --hard` or `rm -rf .git` recoverable
- Decision: symlinks are stored as links and never followed (`lstat` walk, no `-h`).

**Default exclusions and `.workspaceignore`.**

- Decision: the default exclusions are exactly the SPEC 15.5 list: `node_modules/`, `.venv/`, `dist/`, `build/`, `target/`, `__pycache__/`.
- Decision: `.workspaceignore` adds to these using `.gitignore` syntax, and `!pattern` can re-include a default. Matching uses the `ignore` npm package, pinned to an exact version. Reason: students already know the syntax, and gitignore rules are too subtle to hand-write.

**Skipping unchanged projects.**

- Decision: while walking, the agent computes a fingerprint: a hash over the sorted (path, type, size, mtime, mode, link target) of every included entry. The worker passes the latest point's fingerprint, and the agent writes nothing when the new one matches. Reason: SPEC 15.6 allows skipping when nothing changed, and this needs no watcher state.

**Archive integrity.**

- Decision: the SHA-256 of each archive is stored on its database row. Restore streams the archive, checks the hash, and refuses on a mismatch. Before extracting, the agent lists the members and refuses any absolute path or `..` member. Reason: the archive sits somewhere the student can write, and SPEC 24.6 forbids extraction traversal.

**How restore works.**

- Decision: the agent extracts into `~/projects/.portikus-restore-<pointId>`. That name fails the slug pattern, so discovery ignores it. Then the agent does three things:
  1. deletes every entry of the current project that is not excluded, never following links
  2. moves the extracted entries in, merging into directories that still exist because they hold excluded children
  3. removes the staging directory
- Decision: the project directory itself is never replaced. Reason: its inode is the project's identity (SPEC 7.6), and shells and watchers keep working.
- Decision: excluded paths such as `node_modules` are left as they are, and the confirmation dialog says so.

**The safety point before a restore.**

- Decision: the restore refuses if the safety point fails. The one exception is a failure because recovery storage is full. Then the dialog offers a second confirmation, "Restore without saving the current state", which sends `skipSafetyPoint: true`. Reason: SPEC 15.8 says "when practical", and a full allowance must not block recovery at the moment it is needed.

**Retention.**

- Decision:
  - every point gets `expires_at = created_at + RECOVERY_RETENTION_DAYS` (default 14)
  - after expiry, the worker deletes points oldest first until each workspace's stored total is at or below 90% of its recovery allowance
  - the newest point of each project is never deleted, by age or by size
- Reason: SPEC 15.7 wants retention that is configurable and bounded by the quota. The 10% headroom covers filesystem overhead.

**Pre-session point.**

- Decision: when a terminal is created with `agent: claude|codex`, the API asks the agent for a point with reason `agent-session` before it launches the CLI. The wait is bounded to 30 seconds. On failure it logs and launches anyway. The point id is stored on the terminal row. Reason: SPEC 10.9 requires the pre-session state to be restorable, and the ADR 0019 stash object can be pruned by Git.

**Archive and delete hooks.**

- Decision: before archiving, the point is best effort. If the workspace is running, the point is made first; if that fails, the archive still goes ahead. Reason: archive leaves the directory in place (SPEC 7.6).
- Decision: permanent delete also deletes the project's recovery points, both the rows (by cascade) and the directory. The delete confirmation says so. Reason: there is nothing left to restore into.

**How periodic points are scheduled.**

- Decision: a second loop in the worker, every `RECOVERY_SWEEP_SECONDS` (default 60), separate from the one-second reconcile loop. It covers only running workspaces and active, non-missing projects. A project is due when `projects.recovery_checked_at` is older than `RECOVERY_INTERVAL_SECONDS` (default 900). Reason: a slow archive must not delay lifecycle timers (ADR 0006, BACKLOG "Parallel worker sweep").

**How Reset Docker and Rebuild run.**

- Decision: the API writes `workspaces.pending_operation`, one of `reset-docker`, `rebuild`, or `rebuild-reset-docker`. The worker then drives the whole operation:
  1. if the workspace is running, stop it (a rebuild first makes a `before-rebuild` point of each active project)
  2. once it is `stopped` or `error`, call the controller
  3. clear `pending_operation`
  4. restart the workspace if `desired_state` is `running`
- Reason: ADR 0006 makes the worker the only writer of `state`, and SPEC 27 asks for explicit asynchronous states.
- Decision: a rebuild runs from `error` too. Reason: rebuild is SPEC 17.1's repair path. It needs the instance to exist; re-creating a missing one stays the backlog item "Re-provision after a failed create".
- Decision: step 3b of the reconcile loop, the start, skips any row with a pending operation.

**How Reset Docker is done in Incus.**

- Decision: with the instance stopped, the controller:
  1. reads the instance
  2. writes it back without the `docker` device, using an ETag-guarded `PUT`
  3. deletes the `<instance>-docker` volume
  4. creates a new one at `WORKSPACE_DOCKER_SIZE_GIB`
  5. puts the device back
- Decision: each step is idempotent, so a retry finishes a half-done reset. The controller never deletes a volume whose name is not exactly `<validated name>-docker`.
- Reason: SPEC 16.4 says "recreate clean Docker storage". A new volume also picks up the current quota.

**How Rebuild is done in Incus.**

- Decision: `POST /1.0/instances/<name>/rebuild` with `{source: {type: "image", alias}}` while the instance is stopped. Incus keeps the instance's own devices, so `home`, `docker` and `recovery` stay. The new image fingerprint goes into `image_version`.
- Reason: this is Incus's native root-only replacement (SPEC 17.2, 22.3). The next start already pushes the token, hostname, timezone and profile.

**Who may do what.**

- Decision:
  - Reset Docker: the owner or an administrator
  - Rebuild: administrators only (SPEC 17.2; the guided student flow is P1)
  - Recovery list, create and restore: the owner only, and an administrator gets a 404, as with projects
- Reason: an administrator restoring a student's files would be silent impersonation (SPEC 20.2).

**Quota values.**

- Decision: environment configuration only in this epic: `WORKSPACE_RECOVERY_SIZE_GIB`, `RECOVERY_INTERVAL_SECONDS`, `RECOVERY_RETENTION_DAYS`, `RECOVERY_SWEEP_SECONDS`, and the existing home and Docker sizes. Reason: changing quotas at runtime is Epic 11 ("quota inspection/change").

**How storage is measured.**

- Decision: the agent's `/usage` gains `storage.home`, `storage.docker` and `storage.recovery`, each `{usedBytes, totalBytes}` or `null`, measured with `statfs` on the three mount points. A stopped workspace shows "Available when the workspace is running". Reason: this reuses the existing usage path, and a stopped container has nothing mounted to measure.

**Warning thresholds.**

- Decision: warn at 0.80 and call it critical at 0.95. The critical message names the class and suggests a next step:
  - Docker: Reset Docker, or `docker system prune`
  - Recovery: older points are removed automatically
  - Projects & home: delete files
- Reason: SPEC 19.2 says "approximately 80%" and "near a hard limit".

**Audit and logs.**

- Decision: these actions write audit rows:
  - `recovery.restored`
  - `workspace.docker_reset_requested` / `workspace.docker_reset` / `workspace.docker_reset_failed`
  - `workspace.rebuild_requested` / `workspace.rebuilt` / `workspace.rebuild_failed`
- Decision: periodic and manual point creation is logged, not audited. Audit metadata holds ids, reason and size only; file names and paths never go in logs or audit rows. Reason: SPEC 24.8, 24.11, 25.10, and ADR 0012.

## Acceptance criteria ("Done")

1. A recovery point of a project is a `tar.zst` under `/var/lib/portikus/recovery/<projectId>/`, mode 0600 in a 0700 directory, with a `recovery_points` row holding the project, time, reason, size, SHA-256 and expiry (SPEC 15.2, 15.3, 24.9, 26).
2. Making any recovery point, periodic or manual, leaves `git rev-parse HEAD`, `git for-each-ref`, `git stash list`, the reflog, and the bytes of `.git/index` unchanged. This is tested against the real agent with real Git (SPEC 12.5; the epic's second acceptance item).
3. A point includes `.env` and other Git-ignored files. It leaves out the six default directories and anything `.workspaceignore` names. `!dist/` in `.workspaceignore` brings `dist/` back. A symlink pointing outside the project is stored as a link and its target is not read (SPEC 15.4, 15.5, 24.6).
4. A periodic check on an unchanged project writes no archive and no row, but still updates `recovery_checked_at`. A changed project gets a new point within one interval (SPEC 15.6).
5. Restoring a point after files are deleted and modified, including `rm -rf .git` and `git reset --hard HEAD~1`, puts back every archived file and `.git` exactly. The project row, its id and its inode stay the same. Excluded directories are untouched. A `before-restore` point of the prior state exists afterwards (SPEC 15.8; the epic's first acceptance item).
6. Restore refuses:
   - an archive whose SHA-256 does not match the row
   - an archive with an absolute or `..` member
   - a point from another project or another workspace

   Only the owner can list, create or restore; another student and an administrator get 404 (SPEC 24.6, 5.2).
7. Archiving a project in a running workspace makes a `before-archive` point first. Launching Claude Code or Codex makes an `agent-session` point and stores its id on the terminal. **Restore to before this session** restores that point (SPEC 10.9, 15.6).
8. Retention deletes expired points and then the oldest points until usage is at or below 90% of the allowance, and never deletes the newest point of a project. Permanently deleting a project removes its points and their directory (SPEC 15.7).
9. Reset Docker from the student's workspace dialog, or from `/admin`:
   - stops the workspace
   - replaces the `-docker` volume
   - restarts the workspace if it was running

   Afterwards `docker images` is empty, while `~/projects`, the home volume and the recovery volume are byte-for-byte intact. The request and the result are audited (SPEC 16.4; the epic's third acceptance item).
10. Rebuild from `/admin`:
    - makes `before-rebuild` points when the workspace is running
    - replaces the root filesystem with the current image
    - keeps home, projects and recovery, and keeps Docker unless the box was ticked
    - updates `image_version`
    - audits the request and the result

    A file written to `/etc` before the rebuild is gone afterwards. Rebuild also brings a workspace in `error` back when its instance exists (SPEC 17.2, 22.3).
11. The workspace dialog shows Projects & home, Docker, and Recovery usage. The status bar warns at 80% and names the class. At 95% the message names the class and a next step (SPEC 18.3, 19.2, 28).
12. The workspace dialog states that packages installed with `sudo apt` do not survive a rebuild (SPEC 17.3).
13. An existing workspace with no recovery volume gets one at its next start. The start never fails because of it.
14. Unit tests cover every item above at the unit level, and Playwright covers the visible flows (task lists below). `make check` and `pnpm test:e2e` are green, and the Epic 10 smoke block passes on the pilot VM against a throwaway test workspace.

## Out of this epic

- Comparing the working tree with a recovery point (SPEC 12.6, P1), and per-file history (SPEC 15.9, P1). BACKLOG "Compare against a recovery point or another ref" stays open. This epic stores archives by id so that work can read them later.
- The guided student rebuild (SPEC 17.2, P1) and `~/.workspace/packages.txt` (SPEC 17.3, P1).
- Changing quotas at runtime, the admin quota inspection screen, and resizing existing volumes (Epic 11).
- Re-creating a workspace whose instance is gone (BACKLOG "Re-provision after a failed create").
- The student process cgroup with a kill-all action (BACKLOG). It is not in section 29's Epic 10 list.
- Deleting individual points by hand, restoring into a new project, and downloading a point.
- Platform backups of PostgreSQL and volumes, and the restore exercise (SPEC 25.5, Epic 12).
- Docker health beyond storage use (SPEC 16.5, 18.3), beyond what already exists.

---

## Task split

Migration **0013** belongs to Task 1 alone. No other task writes a migration; a task that finds it needs a column asks for an amendment to Task 1 before Task 1 lands, or a 0014 after it.

Order: Task 1 lands first. Tasks 2 to 6 then run in parallel against its contracts. Task 7 runs last.

### Task 1: Contracts, configuration, migration 0013, and decision records

**SPEC:** 15, 16.4, 17.2, 19, 26, 27.

**Owns:**
- `packages/contracts/src/recovery.ts` (new) and `recovery.test.ts` (new)
- `packages/contracts/src/controller.ts`, `workspace.ts`, `usage.ts`, `terminal.ts`, `agent.ts`, `index.ts`, and their `*.test.ts`
- `packages/config/src/index.ts` and `index.test.ts`
- `packages/db/src/migrations/0013_recovery.ts` (new), `packages/db/src/migrations/index.ts`, `packages/db/src/schema.ts`, `packages/db/src/db.test.ts`
- `docs/SPEC.md`: sections 15, 16.4, 17.2 and 19.2. Write the decisions above in the style of section 7.6, then add an Epic 10 note in section 29.
- `docs/adr/0020-recovery-archives-on-a-recovery-volume.md` (new) and `docs/adr/0021-workspace-maintenance-operations.md` (new)

**Contents to pin:**
- `RecoveryReason` enum: `periodic`, `manual`, `before-archive`, `before-restore`, `before-rebuild`, `agent-session`.
- `RecoveryPoint`: `{id, projectId, createdAt, reason, sizeBytes, expiresAt}`.
- `RecoveryPointList`: `{points, usage: {usedBytes, quotaBytes}}`.
- `RestoreRecoveryPointRequest`: `{skipSafetyPoint?: boolean}`.
- `DEFAULT_RECOVERY_EXCLUDES` and `WORKSPACEIGNORE_FILE`.
- Agent request and response shapes:
  - create: `AgentCreateRecoveryPointRequest {projectId, pointId, skipIfFingerprint?}`, answered with `{created: true, sizeBytes, sha256, fingerprint}` or `{created: false, fingerprint}`
  - restore: `AgentRestoreRecoveryPointRequest {projectId, sha256}`
- New agent error codes: `BUSY`, `STORAGE_FULL`, `RECOVERY_POINT_INVALID`.
- Controller: `ResetDockerRequest {dockerGiB}`, `RebuildInstanceRequest {resetDocker, dockerGiB}`, `RebuildInstanceResponse {imageFingerprint}`. `CreateInstanceRequest` gains a required `recoveryGiB`. `StartInstanceRequest` gains an optional `recoveryGiB`, and the controller skips the volume step when it is absent.
- `Workspace`: `pendingOperation` (nullable enum), and `quotaConfig.recoveryGiB`, optional.
- `Terminal`: `recoveryPointId` (nullable).
- `WorkspaceUsage`: `storage: {home, docker, recovery}`, each `{usedBytes, totalBytes} | null`. Keep `disk` as it is.
- New `ApiErrorCode` values: `STORAGE_FULL`, `OPERATION_PENDING`, `BUSY`.
- Config:
  - worker: `WORKSPACE_RECOVERY_SIZE_GIB` (3), `RECOVERY_INTERVAL_SECONDS` (900), `RECOVERY_RETENTION_DAYS` (14), `RECOVERY_SWEEP_SECONDS` (60)
  - API: `WORKSPACE_RECOVERY_SIZE_GIB` and `RECOVERY_RETENTION_DAYS`
  - agent: `RECOVERY_ROOT` (`/var/lib/portikus/recovery`)
- Migration 0013:
  - table `recovery_points`, with columns:
    - `id` uuid pk
    - `project_id`, references `projects` on delete cascade
    - `workspace_id`, references `workspaces` on delete cascade
    - `reason`
    - `created_at`
    - `created_by` (a user id or `worker`)
    - `size_bytes` bigint
    - `sha256`
    - `fingerprint`
    - `expires_at`
    - index on `(project_id, created_at desc)`
  - `projects.recovery_checked_at`
  - `workspaces.pending_operation` (check constraint limiting it to the three values), `pending_operation_at`, `pending_operation_by`
  - `terminals.recovery_point_id`, references `recovery_points` on delete set null
  - backfill `quota_config || '{"recoveryGiB":3}'` where the key is missing

**Depends on:** nothing.

**Real host:** no.

**Done:**
- Contract round-trip tests for each new schema, and rejection tests: a non-uuid id, an unknown reason, an unknown pending operation.
- The migration runs up and down against a fresh `TEST_DATABASE_URL`.
- A delete-cascade test removes points when a project is deleted.
- A config test confirms the defaults.
- `make check` is green. No Playwright, because nothing is visible yet.

### Task 2: Workspace agent, archives, `.workspaceignore`, restore, and storage figures

**SPEC:** 11.1, 12.5, 15.2–15.5, 15.8, 19.2, 24.6, 24.9.

**Owns:**
- `apps/workspace-agent/src/recovery.ts` and `recovery.test.ts` (new)
- `apps/workspace-agent/src/recovery-routes.ts` and `recovery-routes.test.ts` (new)
- `apps/workspace-agent/src/workspace-ignore.ts` and `workspace-ignore.test.ts` (new)
- `apps/workspace-agent/src/usage.ts` and `usage.test.ts`
- `apps/workspace-agent/src/server.ts`, `apps/workspace-agent/src/errors.ts`
- `apps/workspace-agent/package.json`, `pnpm-lock.yaml` (adds `ignore` at an exact version; this is the only task that changes the lockfile)

**Routes:**
- `POST /projects/:slug/recovery-points`
- `POST /projects/:slug/recovery-points/:pointId/restore`
- `DELETE /recovery-points/:projectId/:pointId`
- `DELETE /recovery-points/:projectId`

Every id is checked as a uuid before it becomes part of a path. The archive is written to `<id>.tar.zst.partial` and renamed when complete. `ENOSPC` becomes `STORAGE_FULL`, and the partial file is removed. `tar` is spawned directly and never through a shell. Each project has a lock that answers `BUSY`.

**Depends on:** Task 1.

**Real host:** yes, on the throwaway test workspace only (Task 7 runs it). The checks are ownership and modes on the mounted volume, and GNU tar and Node zstd in the real image.

**Done:** unit tests against real Git and real tar in a temporary home cover:
- criteria 2 to 6 at the agent level
- a fingerprint skip
- a `.workspaceignore` negation
- symlinks not followed on the walk, on delete, or on restore
- a hash mismatch refused
- a crafted `../` archive refused
- a nested excluded `node_modules` surviving a restore
- `statfs` values for the three storage classes, and `null` when a mount is missing

No Playwright, because this task has no UI.

### Task 3: Workspace controller and infrastructure, covering the recovery volume, Reset Docker and Rebuild

**SPEC:** 4.4, 16.4, 17.2, 22.3, 24.4, 25.7. **STACK:** 9, 23, 24. **ADR:** 0005.

**Owns:**
- `apps/workspace-controller/src/provider.ts`, `provider.test.ts`, `incus.ts`, `incus.test.ts`, `server.ts`, `server.test.ts`, `fake-provider.ts`
- `infra/incus/workspace.sh`, which gains the recovery volume
- `infra/ansible/site.yml`, which gains `portikus_workspace_recovery_size_gib`
- `infra/ansible/roles/portikus/templates/worker.env.j2`, `infra/ansible/roles/portikus/templates/api.env.j2`, and the role's `defaults/main.yml`

**Work:**
- `WorkspaceProvider` gains:
  - `resetDocker(name, {dockerGiB})`
  - `rebuild(name, {resetDocker, dockerGiB})`, which returns `{imageFingerprint}`
- `create` makes `<name>-recovery` and attaches it at `/var/lib/portikus/recovery`.
- `start` makes sure the recovery volume and its device exist, which is non-fatal and never creates `home`. After start it runs `chown 1000:1000` and `chmod 0700` on the mount, also non-fatal.
- New server routes `POST /instances/:name/reset-docker` and `POST /instances/:name/rebuild`, both single-flight and both refused with 409 unless the instance is stopped.

**Depends on:** Task 1.

**Real host:** yes. It is the riskiest task; see the real-host section.

**Done:** unit tests with the Incus fake cover:
- the reset `PUT` keeps the `home` and `recovery` devices exactly
- the only volume ever deleted is exactly `<name>-docker`
- a reset interrupted after the delete finishes when retried
- rebuild sends the image alias and refuses a running instance
- a failed recovery attach still starts the workspace
- no step ever creates `home` at start

Infra: `make check` infra lint passes. No Playwright.

### Task 4: Worker, covering maintenance operations, periodic points and retention

**SPEC:** 6.5, 15.6, 15.7, 16.4, 17.2, 22.3, 24.11. **STACK:** 7. **ADR:** 0006.

**Owns:**
- `apps/worker/src/reconcile.ts` and `reconcile.test.ts`
- `apps/worker/src/recovery.ts` and `recovery.test.ts` (new)
- `apps/worker/src/agent-client.ts` (new), `controller-client.ts`, `fake-controller.ts`, `index.ts`, `index.test.ts`

**Work:**
- In `reconcile()`:
  - a running workspace with a pending operation moves to stopping without changing `desired_state`
  - start step 3b skips rows with a pending operation
  - a new step runs the controller operation from `stopped` or `error`, clears the operation, sets `image_version` after a rebuild, and audits the result
- `recoverySweep()` runs on its own timer and does three things:
  - periodic points, passing `skipIfFingerprint`
  - `before-rebuild` points for workspaces with a pending rebuild that are still running, done before the stop
  - retention
- `create` sends `recoveryGiB`, and `start` sends it too.

**Depends on:** Task 1. It is tested against fakes, so it does not wait for Tasks 2 and 3.

**Real host:** yes, through Task 7.

**Done:** database-backed unit tests cover:
- the stop, operation and restart sequence
- no auto-start while an operation is pending
- rebuild from `error`
- a failed operation leaves `error` with a user message and an audit row
- due and not-due scheduling, and an unchanged project writes no row
- expiry, the 90% size bound, and the newest point per project kept
- a slow agent does not delay the one-second reconcile loop

No Playwright.

### Task 5: API routes, hooks, and the fake agent

**SPEC:** 5.2, 7.3, 7.4, 10.9, 15.6, 15.8, 16.4, 17.2, 20.2, 24.11, 27, 28.

**Owns:**
- `apps/api/src/routes/recovery.ts` and `recovery.test.ts` (new)
- `apps/api/src/routes/workspaces.ts` and `workspaces.test.ts`
- `apps/api/src/routes/workspace-view.ts`
- `apps/api/src/routes/admin.ts` and `admin.test.ts`
- `apps/api/src/routes/projects.ts` and `projects.test.ts`
- `apps/api/src/routes/terminals.ts` and `terminals.test.ts`
- `apps/api/src/routes/project-scope.ts`
- `apps/api/src/server.ts`, `apps/api/src/agent-client.ts`, `apps/api/src/fake-agent.ts`

**Routes:**
- `GET /workspaces/:id/projects/:pid/recovery-points`: works when the workspace is stopped.
- `POST .../recovery-points`: reason `manual`. It needs a running workspace (409 if not) and takes the long-operation slot.
- `POST .../recovery-points/:rpid/restore`: makes the safety point first, and honours `skipSafetyPoint` only for a `STORAGE_FULL` failure.
- `POST /workspaces/:id/reset-docker`: owner or administrator; answers 202.
- `POST /admin/workspaces/:id/rebuild`: administrators only; body `{resetDocker}`; answers 202.
- Both operation routes answer 409 `OPERATION_PENDING` when an operation is already set.

**Hooks:**
- archive makes a best-effort `before-archive` point first
- delete calls the agent's `DELETE /recovery-points/:projectId`
- an agent terminal gets an `agent-session` point, bounded to 30 seconds, before launch
- `toWorkspace` exposes `pendingOperation`

The fake agent gains the recovery routes (keeping archives in memory), `storage` in `/usage`, and `__test` hooks to set storage figures and to force `STORAGE_FULL`.

**Depends on:** Task 1.

**Real host:** through Task 7.

**Done:** route tests cover:
- the owner-only rule, with another student and an administrator both getting 404 on recovery
- only an administrator may rebuild
- reset and rebuild audit rows
- 409 when stopped
- an audit row for restore with no file names in it
- restore refused when the safety point fails, and allowed with `skipSafetyPoint` only after `STORAGE_FULL`
- archive still succeeds when its point fails
- the terminal row carries `recovery_point_id`
- deleting a project calls the agent cleanup

The Playwright specs live in Task 6.

### Task 6: Web UI and Playwright

**SPEC:** 8, 10.9, 15.8, 16.4, 16.5, 17.3, 18.3, 19.2, 25.8, 28.

**Owns:**
- `apps/web/src/recovery/` (new): `RecoveryDialog.tsx`, `RestoreConfirm.tsx`, `queries.ts`, `storage.ts`, and their tests
- `apps/web/src/projects/ProjectPane.tsx`, `DeleteConfirm.tsx`, `ArchiveConfirm.tsx`
- `apps/web/src/files/ChangesList.tsx`
- `apps/web/src/shell/StatusBar.tsx` and `StatusBar.test.tsx`
- `apps/web/src/WorkspaceStarting.tsx`
- `apps/web/src/admin/AdminPage.tsx`, `admin/queries.ts`
- `apps/web/src/monitor/usage.ts`, and `packages/ui` if `resolveWorkspaceState` needs a label for the pending operation
- `e2e/recovery.spec.ts`, `e2e/reset-docker.spec.ts`, `e2e/admin-rebuild.spec.ts`, `e2e/storage-warnings.spec.ts` (all new), and `e2e/helpers.ts`

**Work:**
- **Recovery points…** in the project menu, with a list, **Create recovery point now**, and **Restore** through a `ConfirmDialog` that shows the project and timestamp plus lost and survives lists.
- **Restore to before this session** in the session review header.
- A storage section, a Reset Docker button, and the sudo-apt line in the workspace dialog.
- The status-bar warning.
- "Resetting Docker…" and "Rebuilding…" labels while an operation is pending.
- Admin row actions for both operations.
- The delete dialog says recovery points are deleted too.

**Depends on:** Task 1 to build. Task 5 must land before the Playwright specs can pass.

**Real host:** a manual look through Task 7.

**Done:**
- Component tests for the storage thresholds (79%, 80%, 95%, and `null`) and the class names.
- Playwright:
  - create, list and restore a point, with the confirmation showing the project name and timestamp
  - restore to before a session
  - Reset Docker from the student dialog writes a pending operation and shows the pending label
  - an administrator's rebuild with the Docker checkbox
  - a student sees no rebuild action
  - 80% and 95% warnings name Docker and Recovery
  - keyboard-only operation of every new dialog, and an axe check in the existing a11y style

### Task 7: Real-host verification, the smoke test, and STATUS

**SPEC:** 21.11, 29 (Epic 10 acceptance). **STACK:** 13 ("Infrastructure smoke tests").

**Owns:** `infra/tests/smoke-test.sh` (the Epic 10 block) and `docs/STATUS.md` (the Epic 10 section and its gaps).

**Depends on:** Tasks 1 to 6.

**Real host:** yes. This is the task that touches the pilot VM.

**Done:**
- The smoke block runs against a workspace it creates and cleans up only what it recorded, as the Epic 3 and 4 block already does. It checks that:
  - the recovery volume is mounted, owned by uid 1000, mode 0700
  - a point leaves Git untouched
  - `rm -rf` of the project followed by a restore brings files and `git log` back
  - Reset Docker empties `docker images` and keeps a marker in `~/projects`
  - a rebuild drops a `/etc` marker and keeps the home marker
- STATUS.md records what landed and the gaps.

---

## Real-host constraints

The only VM is the live pilot, with three student workspaces whose data must survive. Rules for the builders and the orchestrator:

1. **Never run reset or rebuild on a student workspace.** Tasks 3, 4 and 7 are verified only on a throwaway workspace: either one the smoke test provisions for a dedicated test user through the mock identity provider, or one made with `infra/incus/workspace.sh create <test-name>`. Every destructive command in the smoke block must name the test instance, and must refuse to run when that name matches an existing student workspace row.
2. **Before the package is deployed** (`make deploy-app`), take non-destructive snapshots:
   - `incus storage volume snapshot create <pool> <instance>-home pre-epic10`, for each of the three student workspaces (`--project` as configured)
   - a `pg_dump` of the Portikus database

   Snapshots on LVM thin are cheap. Remove them once the epic has run for a week.
3. **Deploying changes the student workspaces in two ways only:**
   - the controller adds a `-recovery` volume and device at each student's next start (non-fatal by design)
   - the agent, bind-mounted from the package, gains the new routes

   Verify both on the test workspace first: stop and start it, and check `incus config device show`. Then let the student workspaces pick them up at their own next start. Do not force-restart them.
4. **Periodic points start for student projects as soon as the new worker runs.** They are read-only on the project and write only to the new volume. Before deploying, confirm on the test workspace that a point of a project with `node_modules` takes seconds, not minutes.
5. **Verify restore only on the test workspace.** Never exercise restore on a student project, because it replaces files.
6. **Safe on the pilot and read-only:**
   - `incus storage volume list`
   - `df` inside a workspace through the agent's `/usage`
   - `incus config show <instance>`
   - reading `recovery_points` rows

   Destructive only on the test instance: every controller operation and the smoke block.
7. **Tasks 1, 5 and 6 need no host verification** beyond the deployed smoke run. They are covered by CI and Playwright.

## Risks and open questions

**1. Should an archive include `.git`?**

- The risk: `.git` can be large and eat the 3 GiB allowance, and a restore rewinds commits made after the point.
- Recommendation: include it. It is what makes agent Git accidents recoverable, the pre-restore point keeps the newer commits, and pushed commits are still on the remote. A student can add `.git/` to `.workspaceignore`. The restore dialog says in plain words: "Commits made after this time are removed from this project; they are kept in the recovery point made just now."

**2. Node's zstd is marked experimental in Node 24.**

- Recommendation: use it. It is present and working on 24.21, and it avoids an image rebuild the three existing workspaces could not receive.
- Pin a round-trip test in CI.
- If it ever fails, the fallback is adding `zstd` to the image for new roots, plus gzip for old ones. Record this in ADR 0020.

**3. The student has passwordless sudo**, so `sudo rm -rf /var/lib/portikus/recovery` by a student or a coding agent can destroy their own points.

- Recommendation: accept it and document it in ADR 0020. Recovery points guard against ordinary accidents such as `rm -rf`, `git reset` or an agent rewriting files. They are not a backup against a deliberate root action inside the student's own container; platform backups belong to SPEC 25.5 and Epic 12. The SHA-256 check means a tampered archive is refused, never restored.

**4. Reset and rebuild run inside the serial reconcile loop**, so a slow Incus operation delays every other workspace's timers (BACKLOG "Parallel worker sweep").

- Recommendation: accept it for the pilot. Rebuild and reset on LVM thin take seconds, and they are rare actions taken by an administrator. Measure on the test workspace. If either takes more than 10 seconds, pull that backlog item into Epic 11.

**5. Can Incus `PUT` with an ETag drop a device by mistake during Reset Docker?**

- Recommendation: this is the most dangerous code in the epic. Mitigate it with:
  - a unit test that the `home` and `recovery` device maps are equal before and after
  - a guard that aborts when the `home` device is missing from what was read
  - a first run only on the test workspace

  If the Incus version on the VM supports removing a device through a `PATCH` whose body leaves that device out, prefer that. The builder checks the server's API extensions.

**6. What happens to running processes during a restore?** Shells whose working directory was a replaced subfolder end up in a deleted directory, and a running coding agent may write during the restore.

- Recommendation: do not stop anything. The confirmation says: "Stop Claude Code or Codex in this project first. Terminals open in a subfolder may need `cd` again." Blocking the restore while an agent terminal is live would stop students recovering from the very agent that caused the damage.

**7. The agent-session point adds latency to launching Claude Code or Codex.**

- Recommendation: keep it synchronous, capped at 30 seconds, and fail open. With the default exclusions a typical project archives in about a second. If pilot telemetry shows more than 3 seconds, move the point to a background call and drop "before" from its label.

**8. An orphan archive** is possible when the API crashes after the agent writes a file but before the row is inserted.

- Recommendation: leave it as a known gap. It is rare, bounded by the volume size, and shows in the Recovery figure. Epic 12 can add a reconcile of files against rows.

**9. Do quota changes apply to existing volumes?**

- Recommendation: no, not in this epic. Changing `WORKSPACE_DOCKER_SIZE_GIB` takes effect for new workspaces and at the next Reset Docker. Resizing volumes in place is Epic 11's "adjust quotas". Say this in STATUS.md.

**10. Should Reset Docker make a recovery point first?** SPEC 15.6 says "before a platform-initiated destructive/reset action".

- Recommendation: no. Docker data is not in recovery points, and projects are not touched, so the point would protect nothing. Rebuild does make one (SPEC 22.3 step 2). Record this reading in SPEC 15.6.

**11. Should periodic points run while no browser is connected but the workspace is still running** (during the grace period, or with a grace period of 0)?

- Recommendation: yes, while it runs. Agents keep editing during the grace period, and the fingerprint skip makes idle checks cheap.

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
