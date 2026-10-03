# Epic 31: workspace reliability, admin polish, CI and lint

This plan lives only on `epic/31-reliability`. The fold task folds its lasting
rules into SPEC.md and deletes it (WORKFLOW.md, "Epic plans"). Code and tests
cite SPEC.md sections or ADRs, never this file.

## Scope

- Group A, worker and controller reliability: #1057 (start retries and Stop on
  an errored row); #1041 part S4 only (one deadline from worker to
  controller); BACKLOG "Mark workspace state unverified when the controller
  is unreachable"; BACKLOG "Terminal row pruning and a race-free terminal cap".
- Group B, admin: #1059 (a path per admin tab), #1060 ("Packages students
  add" moves to the Image tab).
- Group C, CI and lint: #987 (no Playwright system-package download per run),
  #1010 (warn on files over 800 lines), #1011 (import rules in `pnpm lint`).

Left out: #1041 part S3 refactors, the security and operations set
#914-#920, #935, #1063, #958 and the rest of the backlog.

## Rulings

User (2026-10-02):
1. A failing start retries after 10 s, 30 s, 1 min, 2 min and 5 min, then
   stops. The row stays `error` with its message and the worker logs one
   warning. Start, Stop or Restart from the student resets the count.
2. #1011: rules on in `pnpm lint`; fix up to about 15 findings, else a
   baseline and an issue.
3. Verify on the rehearsal VM (full smoke with Dex sign-in), then install the
   same build on the pilot and run its smoke test, before the epic pull
   request.
4. Ended terminal rows are deleted after 30 days. A workspace state is
   "unconfirmed" after 2 minutes without a successful controller check.

Orchestrator, on the architect's design (2026-10-02):
5. "After 5 failures" means five automatic retries after the first failure,
   so each wait is used once.
6. The retry count is a column, `workspaces.start_retries`, so it survives a
   worker restart. A socket connect (presence) never resets it; only the
   API's start, stop and restart do.
7. The worker's create budget becomes 480 s (instance wait + three volume
   creates + 60 s), and the controller honours it through a request header.
8. The last good controller check is `settings.controller_checked_at`,
   written by the worker after each successful instance-list refresh.
9. The student sees "unconfirmed" with an alert icon inside the status-bar
   state button, in every state. Admin pages are unchanged.
10. #1011 uses Biome's rules (`noImportCycles`, restricted imports), not
    dependency-cruiser, which cannot parse TypeScript 7.

## Tasks

| Task | Issue | Owns | Base |
|---|---|---|---|
| lint-rules | #1010 #1011 | lint scripts, biome.json, packages/db connection split | 5aa70248 (PR #1066) |
| ci-deps | #987 | .github/workflows/ci.yml | 5aa70248 |
| admin | #1059 #1060 | apps/web/src/admin, router.tsx, admin e2e, admin SPEC/ADR lines | 5aa70248 |
| T0 schema | A | migration 0036 (`workspaces.start_retries`, `settings.controller_checked_at`), migrations index, packages/db schema.ts, worker-grants.sql (settings column, DELETE on terminals), this plan | 5aa70248 |
| T2 deadline | #1041 S4 | packages/contracts controller.ts; worker controller-client.ts; controller server.ts, provider.ts, processes.ts, host.ts, fake-provider.ts; ADR 0034; SPEC 25.3 budget bullet | 5aa70248 |
| T1 retries | #1057 | worker start-backoff.ts, reconcile.ts, lifecycle.ts (and the controller_checked_at write); api routes/workspaces.ts; SPEC 6.3, 6.5 | T0 head |
| T3 unconfirmed | backlog | contracts workspace.ts and fixtures; events test; api workspace-view.ts, ws-signature test; web StatusBar.tsx, test-utils and fixtures; e2e workspace-unverified.spec.ts, environment.setup.ts; SPEC 18.3, 25.4, 29 Epic 3 gap | T0 head |
| T4 terminals | backlog | api routes/terminals.ts; worker terminal-prune.ts (new), index.ts, grants.test.ts; SPEC 9.7 | T0 head |
| Fold | all | STATUS.md, BACKLOG.md (five entries), SPEC 29 Epic 31 entry, delete this plan | last |

The full design, with line numbers and tests per task, is the architect's
report (copied to the task prompts).

## After the tasks

code-reviewer over the epic and the repo's dead code; security-reviewer (the
controller and the API's terminal and workspace routes change);
a11y-reviewer (status bar, admin tabs). Fix rounds as task PRs. Then
`make check` and `pnpm test:e2e` with a fresh database, the rehearsal VM full
smoke test, the pilot install and smoke test, and the epic pull request.
