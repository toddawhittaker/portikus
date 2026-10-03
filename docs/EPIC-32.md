# Epic 32: split the busiest hotspots, one deadline for every controller call

Issue #1041 (from the #1023 architecture review). Branch `epic/32-hotspots`,
base `main` at 42a6cde9. This plan lives only on the epic branch; the fold
task folds its lasting rules into SPEC.md and deletes it (WORKFLOW.md,
"Epic plans").

## Rulings (Todd, 2026-10-03)

- S4 is extended: start, stop, rebuild, reset-Docker and volume growth
  honour the worker's budget header the way create already does (ADR 0034
  decision 7 is updated in the fold).
- The seed-builder methods move out of `provider.ts` next to
  `docker-seed.ts`.
- `setHostname` logs a warning on a non-zero exit and the start carries on.
  This and S4 are the epic's only behaviour changes.
- After the epic pull request is open, install it on the pilot and run the
  smoke test there.

## Deadline rulings (architect, accepted)

1. An Incus operation already started is not cancelled (Incus does not
   offer it). On abort the controller stops waiting and sends Incus
   nothing more; existing repair paths cover half-done work.
2. Joins on lifecycle routes behave like create: the shared run aborts
   only when every caller has left.
3. Never tighten an existing bound: a step keeps its own limit and the
   caller's signal is added on top.
4. A worker restart now aborts in-flight starts and stops at the
   controller; the next sweep resolves the row (ADR 0034 decision 9).

## Tasks

T1, T3 and T4 run in parallel from the epic head and own disjoint files.
Controller tasks are listed below once designed. No task edits `docs/`
except the fold. Each task puts its proposed STATUS line in its pull
request body.

| Task | Scope | Files owned |
|---|---|---|
| T1 agent routes | Terminal, project and file routes out of `buildServer` into plugin files (pattern: `processes-route.ts`); git, search and recovery route files become plugins; `noteWrite` + `cleanPastes` become one `afterWrite` in `files-route.ts` (not `project-files.ts`: import cycle). Routes, statuses and bodies unchanged. | `apps/workspace-agent/src/server.ts`, new `terminals-route.ts`, `projects-route.ts`, `files-route.ts` (+ test), `git-routes.ts`, `search-routes.ts` (+ test), `recovery-routes.ts` |
| T3 file buffer hook | `useFileBuffer` hook on a plain reducer (load, edit, save start/done/failed, conflict, take disk, keep mine, deleted); refs and keepalive flush stay in the hook; `FileLeaf` keeps view code. | `apps/web/src/work/FileLeaf.tsx`, new `work/useFileBuffer.ts` (+ test) |
| T4 terminal module | Connect/backoff/fatal close codes/dispatch into `terminal/terminalSocket.ts`; terminal files move to `apps/web/src/terminal/`; the `onSessionEnded` prop chain becomes one `sessionEnded()` in `api/sessionEnded.ts`, registered in `main.tsx` and `test-utils.tsx`. Do not merge with `useWorkspaceSocket` reconnect (different rules). | terminal files and tests, `router.tsx`, `WorkArea.tsx` (+ test), `WorkspacePage.tsx`, `files/FileTree.tsx`, `checks/CheckOutput.tsx`, `layout/persist.ts`, `useWorkspaceSocket.ts`, `api/queryClient.ts`, `main.tsx`, `test-utils.tsx`, `links.test.tsx` |
| C1 start steps | In-container setup of `start()` into named functions in `start-setup.ts` (file writes, `setHostname`, `setTimezone`, `prepareRecoveryMount`, `waitForAddress`, `waitForAgent`), same order; `setHostname` non-zero exit warns and continues. | `provider.ts`, new `start-setup.ts` (+ test) |
| C2 budget source | `startBudgetMs`, `stopBudgetMs`, `MAINTENANCE_BUDGET_MS`, `GROW_BUDGET_MS` move from the worker into contracts beside `INSTANCE_CREATE_BUDGET_MS`; values unchanged. The only contracts change. | `packages/contracts/src/controller.ts` (+ test), `apps/worker/src/controller-client.ts` (+ test) |
| C3 deadlines (after C1, C2) | Start, stop, reset-Docker, rebuild and volume growth use `callerSignal` with the contract formula; the first four pass it into `singleFlight`. Optional `signal` threaded through provider, fake provider and `growVolumes` into every Incus request and polling loop. | controller `server.ts`, `provider.ts`, `host.ts`, `start-setup.ts`, `fake-provider.ts` and their tests |
| C4 seed builder (after C3) | `IncusSeedBuilder` (implements `SeedBuildHost`) in `seed-builder.ts`; shared volume helpers into `host.ts`; `WorkspaceProvider` stops extending `SeedBuildHost`; `ServerOptions.seedHost` required. | `provider.ts`, new `seed-builder.ts` (+ test), `host.ts`, `server.ts`, `index.ts`, `fake-provider.ts`, affected tests |
| Fold | SPEC.md section 29 entry and S4 rule, ADR 0034 decision 7, STATUS.md from task bodies, BACKLOG.md left-outs, delete this plan, close #1041. | `docs/` |

Done for every refactor task: existing unit tests keep their assertions
(imports may change), named Playwright specs pass, coverage floors hold,
Biome finds no import cycle.

## Rehearsal VM (after controller and agent tasks land)

`make build-deb`, install, full smoke with Dex password sign-in. By hand in
a started workspace: hostname and prompt, `/etc/timezone` and localtime
link, profile preview suffix and `TZ`, agent token 0600 uid 1000, recovery
mount 1000:1000 0700; create then restart; a `.portikus/` write updates the
Git exclude; pastes past the cap are pruned. Deadline checks: a stop
with a process ignoring SIGTERM ends `stopped` inside the budget; a worker
restart mid-start and mid-stop (abort logged, no Incus steps after it,
retry or sweep recovers); `kill -STOP incusd` for ~100 s during a start
(rehearsal VM only); an interrupted rebuild with Reset Docker, plus
`infra/tests/rebuild-exercise.sh`; `may_cancel: false` on a rebuild
operation; volume growth from admin limits; a full Docker seed build and
leftover-builder cleanup on controller restart.

## Left out

Getting `provider.ts` and the other large files under 800 lines; a shared
reconnect helper for the two sockets; the API fake agent's `registerX`
style.
