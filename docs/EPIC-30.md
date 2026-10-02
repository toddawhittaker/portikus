# Epic 30 — Architecture review fixes

Branch `epic/30-architecture-fixes`, from `main` at fa86312c. Source: the
architecture review on issue #1023 (comment of 2026-10-02), items B1–B9,
S1, S2 and the tidy-ups. S3 and S4 are deferred to issue #1041.

No migration. No change to request or response bodies between apps,
except where a task says so. Admin views keep showing raw error detail;
B7 covers student-facing views only.

## Rulings

- R1. Admin pages keep raw error text (Todd, 2026-10-02). B7 changes
  student-facing views only.
- R2. B4 goes through security-reviewer before merge (SPEC.md §18.3).
- R3. S1 runs the API's relay tests against the real agent in vitest.
  Browser tests keep the fake agent for now (CI time); the fake shrinks
  only where a real-agent test now covers the same route.
- R4. The import-cycle check itself (#1011) is not part of this epic;
  S2 only clears the cycles so #1011 starts at zero.

## Tasks

Wave 1 runs in parallel; each task owns the files listed and touches no
other task's files.

| Task | Items | Owns |
|---|---|---|
| T1 web-events | B1; web `FileNode` type cycle | `apps/web/src/files/` (except the B7 lines), `apps/web/src/WorkspacePage.tsx`, a new e2e spec |
| T2 web-errors | B7; one user-settings query; one stale-chunk reload; workspace state lists from contracts; decode socket frames with shared schemas (`@portikus/events` as a web dependency) | the B7 view files, `shell/KeepRunning.tsx`, `editor/settingsQueries.ts`, `router.tsx`, `shell/reloadOnStaleChunk.ts`, `admin/WorkspaceStateBadge.tsx` and its three users, `terminalFrames.ts`, `checks/checkFrames.ts`, `useWorkspaceSocket.ts`, `apps/web/package.json` |
| T3 worker-loops | B2; `startLoop` owns the busy guard; the three hand-rolled loops use it | `apps/worker/src/loop.ts`, `backups.ts`, the `start*` loop files except `reconcile.ts`, `apps/worker/src/index.ts` |
| T4 worker-reconcile | B3 (one in-flight runner keyed by workspace, cap 6); re-create keeps `quota_config` sizes | `apps/worker/src/reconcile.ts` and its tests (may split into `lifecycle.ts`) |
| T5 controller-writes | B9 (test first); one `replaceFile` on `IncusClient`; `readFile` refuses non-regular files; request-parse helper with one error code | `apps/workspace-controller/src/` |
| T6 agent-fixes | B4; B5; `git-runner.ts` breaks the git cycle; one disconnect helper; `PORTIKUS_WORKSPACE_ID` in `AgentConfigSchema` | `apps/workspace-agent/src/`, `packages/config/src/index.ts` (agent schema only) |
| T7 api-limits | B8: all limits through `rate-limit.ts`; live push signature from the whole view | `apps/api/src/rate-limit.ts`, `routes/preview.ts`, `routes/processes.ts`, `routes/notifications.ts`, `certificate/edge.ts`, `routes/ws.ts` |

Wave 2 (after T7):

| Task | Items | Owns |
|---|---|---|
| T8 api-test-doubles | S1 and B6: API test doubles into `apps/api/src/testing/`; relay tests for files, Git, search, projects and checks against the real agent; build-deb strips and checks `testing/` at any depth | `apps/api/src/fake-*`, `test-support.ts`, `logs/fake-journal.ts`, test imports, `e2e/fake-agent-server.mjs`, `scripts/build-deb.sh` |

Wave 3 (after T8):

| Task | Items | Owns |
|---|---|---|
| T9 api-layers | S2 for the API: `routes/` holds only `register*` files; shared workspace code to `src/workspaces/`, session code to `src/sessions/`; `ServerDeps` to `src/deps.ts`; `workspaceView(s)` helper; `requestPendingOperation()` | `apps/api/src/routes/`, `server.ts`, new folders |

Wave 4 (after T9):

| Task | Items | Owns |
|---|---|---|
| T10 shared-values | `recordNotification` and `notifyAdministrators` in `packages/db`, used by both apps; close-code constants in contracts; state columns narrowed to contract unions; `recordAudit` returns the id (audit-throttle uses it); guard arithmetic into `packages/contracts/src/guard.ts`; `AGENT_ERROR_STATUS` keyed by `AgentErrorCode`; typed `sendText` for the three agent attach frames | `packages/db`, `packages/contracts`, the call sites |
| T11 fold | STATUS.md section from PR bodies; SPEC.md §29 Epic 30 entry and lasting rules; STACK.md §9 diagram (the API never calls the controller); BACKLOG cleanup (presence.ts typing, audit-throttle); delete this plan | docs |

Then: code-reviewer over the epic; security-reviewer (B4, rate limits,
build-deb); a11y-reviewer (B7 views); fixes as task PRs; battery
(`make check`, `pnpm test:e2e` on a fresh database); full rehearsal VM
run with signin file; epic PR; stop.

## Verification per task

`pnpm typecheck`, `pnpm lint`, the app's tests, and `pnpm test:e2e` for
any web change. Each PR body carries its proposed STATUS line.
