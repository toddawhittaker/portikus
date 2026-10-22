# Epic 54: Fix batch after Epic 53

Fix batch. Branch `epic/54-fix-batch`, cut from main 69b82bf5. This plan
lives only on the epic branch; the fold task (G) folds its lasting rules
into SPEC.md and deletes it (WORKFLOW.md, "Epic plans"). Fix batches skip
the architect design step.

## Issues closed

The epic pull request into `main` closes #1642, #1602, #1665, #1245,
#1223 and #1138. Task pull requests use `Refs #N`; the epic pull request
body carries one `Fixes #N` line per issue.

## Rulings (Todd, 2026-10-22)

1. **#1665 multi-delete.** All four Backups lists (backup sets, database
   dumps, VM snapshots, kept home folders) get row checkboxes and a
   "select all" for the list. The newest backup set cannot be selected;
   the API already refuses deleting it (`apps/api/src/routes/admin-backups.ts`
   around line 236), and the UI makes that visible. The orchestrator
   ruled the mechanism: the browser sends the existing per-item delete
   request for each selected item, so each item stays its own audited
   request (SPEC.md section 24.11) and no new API route or contract is
   added. One confirm names the count and kinds. A partial failure lists
   the items that were not deleted and keeps them selected.
2. **#1245 audit retention.** One window for every action type: rows in
   `audit_events` older than 365 days are deleted by a daily worker
   sweep. No export, no setting. Nightly database backups still hold
   older rows until those age out. No migration: the sweep deletes in
   batches, and a daily scan is cheap at the table's size.
3. **#1602 worktree deploys.** When the checkout has no OpenTofu state,
   the Makefile reads it from the main checkout (found through
   `git rev-parse --git-common-dir`), so VM_IP and the pilot's public
   host come out right with no overrides.
4. **#1223 changed-line coverage.** 80% of a pull request's added or
   changed lines, outside the vitest coverage exclude list, must be
   covered. The check runs in the existing `unit` job, which is already
   required. It runs on pull request events only and compares against
   the pull request's base branch (`github.base_ref`), so task pull
   requests into an epic are measured against the epic.
5. **#1138 Dex sign-in job.** It becomes a required check on the main
   and epic rulesets once its last 30 runs show it is reliably green;
   if it flakes, task F1 fixes the flake first. The orchestrator makes
   the ruleset change at fold time and reports it.

## Tasks

Base for wave one: 69b82bf5. Wave two is cut from the epic head after
wave one lands.

| Task | Issue | Owner, model | Files it may touch | Wave |
|---|---|---|---|---|
| A | #1642 | builder, Opus | `apps/workspace-agent/src/agent.test.ts`, `apps/workspace-agent/src/git.test.ts`, `packages/db/src/db.test.ts`, `packages/auth/src/dex-import.test.ts`, `apps/worker/src/reconcile.test.ts`; the code under test only if a test cannot be made load-independent otherwise (name it in the report) | 1 |
| C | #1665 | ui-designer, Opus | `apps/web/src/admin/backups/*`, `e2e/admin-backups.spec.ts`, `e2e/a11y-admin-backups.spec.ts`, help page text for the Backups tab if one exists | 1 |
| D | #1245 | builder, Sonnet | new `apps/worker/src/audit-retention.ts` and its test, the worker's loop wiring (`apps/worker/src/index.ts` or `loop.ts`) | 1 |
| E | #1223 | builder, Sonnet | new `scripts/check-changed-coverage.mjs` and its test, `.github/workflows/ci.yml` (the `unit` job only) | 1 |
| F1 | #1138 | infra, Opus | `infra/tests/security-test.sh`, `infra/tests/security/*`, `infra/tests/backup-scope-test.sh`, new tests under `infra/tests/`, `Makefile` (the `security-test` target and a new `backup-scope-test` target only), `docs/OPERATIONS.md` security-test section | 1 |
| F2 | #1138 | tester, Sonnet | new `apps/api/src/audit-coverage.test.ts`; a route under `apps/api/src/routes/` other than `admin-backups.ts` only to fix a listed event that writes no row | 1 |
| B | #1602 | infra, Sonnet | `Makefile` (the state and address variables, lines about 55-245), `docs/WORKFLOW.md` deploy section, `.claude/skills/pilot-deploy/SKILL.md` | 2 |
| G | all | builder, Sonnet | `docs/STATUS.md`, `docs/SPEC.md` (sections 20.1, 24.11, 25.10, 29), delete this plan | 3 |

B waits for F1 because both edit the Makefile.

### What done looks like

- **A.** Each named test waits on an event, not on wall-clock time, and
  passes under load. Shown by running the full sharded suite while
  `stress-ng` (or a CPU-burning loop) holds the load average above 20.
  Timeouts are not simply raised.
- **C.** Select, select all, confirm naming count and kinds, delete, and
  a partial failure, all covered by Playwright. Keyboard and screen-reader
  use per SPEC.md section 25.8; the newest set's checkbox is disabled and
  says why.
- **D.** A unit test with a real test database: a row 366 days old goes, a
  row 364 days old stays. The sweep runs once a day and logs a count
  only (STACK.md section 15).
- **E.** The script's tests cover a covered change, an uncovered change, an
  excluded path, a deleted-only diff, and a diff with no measurable lines
  (passes). CI's `unit` job fetches the base branch and runs the script
  after the merged coverage report.
- **F1.** `make security-test` runs on a plain apt-installed host (the
  rehearsal VM) with no workspace-host VM in between; a restore keeps file
  owners and modes; coding-agent logins stay out of recovery points;
  `make backup-scope-test` exists. Reports the Dex job's last 30 runs.
  F1 owns the rehearsal VM for this epic.
- **F2.** One test per SPEC.md section 24.11 event shows the action
  writes an audit row. Any event with no row is reported, and fixed if
  the route is in scope.
- **B.** `make deploy-app` and `make smoke-test` from a worktree reach the
  pilot's address and public host without overrides, shown with a dry
  run (`make -n`) and the printed variables; the pilot itself is not
  deployed by this task.
- **G.** STATUS section from the task pull request bodies, SPEC.md
  updated, the plan deleted, `Fixes #N` lines.

## Reviews

code-reviewer always; security-reviewer (audit retention, security
suite); a11y-reviewer (Backups tab).

## Left out

- A per-type or configurable audit window, and exporting old rows.
- A bulk delete API route.
- The other #1138-adjacent launch items (#1142, #1240, #1236).
