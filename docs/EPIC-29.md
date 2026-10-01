# Epic 29: code quality cleanup

Started 2026-10-01 from `main` 9206f1a6 on branch `epic/29-code-quality`.
This plan lives only on the epic branch. The fold task (F) moves its
lasting rules into SPEC.md, STACK.md or WORKFLOW.md and deletes it.

## Goal

Remove duplication that has already drifted, split the files that do
several jobs, and trim comments that narrate history instead of
explaining why. No behaviour a student or administrator can see changes,
except where a task says so. Source: a read-only review of the whole
repository on 2026-10-01 (five code reviewers, one per area).

## Rules for every task

- Refactor only. Keep request and response bodies, status codes, audit
  rows, file modes and page text the same unless the task says
  otherwise. Where two copies have drifted, the task names which
  behaviour wins; pin it with a test first.
- Stay inside the paths your task owns (table below). If you need a
  change in a path someone else owns, stop and report it.
- Do not edit `docs/STATUS.md`. Put your proposed STATUS line in the
  pull request body.
- New comments cite SPEC.md sections or ADRs, never this plan, an issue
  number, an epic or a "ruling".
- Tests and coverage floors as in CLAUDE.md. `pnpm typecheck`,
  `pnpm lint` and the affected tests must pass before the pull request.

## Tasks

Wave 0 lands first, because waves 1 and 2 import from it.

| Id | Task | Agent |
|---|---|---|
| P | This plan | orchestrator |
| D | Shared helpers: `recordAudit(db, {actor, target, action, result, metadata})` and `isUniqueViolation(err, constraint?)` in `@portikus/db`; `errorMessage(e)` in `@portikus/observability`. Helpers and tests only; callers move in their own tasks. | builder |

Wave 1, in parallel:

| Id | Task | Agent |
|---|---|---|
| A1 | API helpers: one `sendError` (and the logs variant's no-store header as an option or a one-line wrapper); shared `UuidParam`, `ProjectParam` and `parseOr400`; `recordAudit` and `isUniqueViolation` everywhere in the API; `writeRequestFile(dir, file, mode)` in `job-files.ts` (temp file always removed on failure; modes unchanged) and drop `readStatus`; one `escapeHtml` (the stricter one, escaping `'`); `errorMessage`. | builder |
| W | Worker: one loop helper (guarded tick, run now and on an interval, returns stop) for the ten timer loops, absorbing `loopEvery`; `recordAudit` for the five copies and guard's inline inserts; shared `notifyAdministrators` and `utcDay`; `errorMessage`; split `reconcile()` into one function per numbered step with an options object. | builder |
| C | Workspace-agent client: new `packages/agent-client` used by the API and the worker. Keep the size cap and no-redirect rule (SPEC 24.6). Drifted behaviour: a stream error throws; empty bodies are skipped. Pin both with tests first. | builder (effort medium) |
| G | Workspace agent: `projects.ts` git calls go through `runGit` (gets `core.fsmonitor=` and process-group kill), one `STDERR_LIMIT`; `listening.ts` docker calls use `runDocker`; move `/proc/net` parsing and docker helpers out of `listening.ts`; `StopFailure`, `ProcessStopFailure`, `ForwardFailure` become `AgentFailure` (moved to `errors.ts`) with `FORWARD_*` codes in the contract; one `errorCode` and `isNoSpace`; `HISTORY_LINES` and the web `SCROLLBACK_LINES` share one contract constant; `errorMessage`. | builder |
| K | Controller timeouts: controller timeouts as constants in `contracts/src/controller.ts`, worker `controller-client.ts` budgets derived from them; `errorMessage` in the controller. | builder |
| U | Web helpers: `errorText` exported from `api/request.ts`, `DialogError` and `announced` moved to a shared folder; one `text.ts` (`timeAgo`, `shortTime`, `plural`, `joinWords`, one wording chosen and tests updated); one `GrantChange` for the two role buttons; `PORT_REFUSED_TEXT` from `MIN_PREVIEW_PORT`; `postJson` beside `request`; `formatBytes` in `FileViewer`; storage meters on the ui `Meter`, `STORAGE_LABEL` imported, one 80% warning constant; drop the unused `DialogTrigger` export. | builder, then ui-designer review |
| E | End-to-end helpers: one `expectNoViolations(page, ...include)` in `e2e/helpers.ts`; shared `openAdmin`, `studentIn`, `openDetail`, `contrast`, `headersOf`, `cookiePairs`; `FAKE_AGENT_TOKEN` imported by `playwright.config.ts`. | builder |
| S | Shell tests: `infra/tests/lib.sh` (`ok`, `bad`, `expect_eq`, `check`, `image_file`) used by every test script; split `smoke-test.sh` into `infra/tests/smoke/<area>.sh` sourced from a short driver that keeps the shared cleanup trap; inline FAIL lines use the `check` helpers; sections named by subsystem. Verified on the pilot. | infra |
| I | Infrastructure: `REQUIRE_VM_IP` macro and one `sed` substitution variable in the Makefile; `backup-install-timer` stops repeating `backup-install-channel`; remove the `PORTIKUS_MOCK_IDP` shims (smoke test excepted, owned by S); shared Go build `tasks_from` for caddy, dex and image_builder; one `@api` matcher in `Caddyfile.j2`; a sourced backup library for the four backup scripts with one set of SSH options. Verified bootstrap to smoke on the rehearsal VM. | infra |
| Q | Packages: delete unused contract constants (`REGISTRY_JOBS_DIR`, `REGISTRY_STATUS_FILE`, `CERTIFICATE_JOBS_DIR`, `CERTIFICATE_STATUS_DIR`, `REGISTRY_EVENTS_DEFAULT_PORT`, `SEED_MAX_GIB_DEFAULT`); one `SharedWorkspaceConfig` spread into the API and worker config schemas; one `sha256Hex` in auth; role grants out of `auth/src/links.ts` into `roles.ts`; `recordAudit` in `dex-import.ts`. | builder |

Wave 2, after the wave 1 task that owns the same files:

| Id | Task | Agent | After |
|---|---|---|---|
| A2 | API structure: one role-change helper for the four admin role routes (audit when the role actually changed; every row carries `requestMetadata`, including enable); user functions out of `routes/admin.ts`; WebSocket piping out of `routes/terminals.ts`; typed workspace mappers with settings read once per request. | builder | A1 |
| V | Web structure: split `admin/WorkspaceDetail.tsx` into section files, `ProfilePane` and `LinkedAccounts` out of `SettingsDialog.tsx`, file-tree drag and drop into a hook, one `pendingView` in the layout store. | builder | U |

Wave 3, comment trim, after all code has landed, five in parallel by
area: api; web and ui; worker, controller and agent; packages; e2e and
infra. Keep the why, the invariants and SPEC or ADR citations. Remove
issue, epic, review and ruling tags; point a ruling at the SPEC section
it became, or drop it and keep the reason. Delete comments that restate
the code. Fix comments that have drifted. No code changes.

Then: code, security and accessibility reviews over the epic head, fix
tasks, confirmation reviews, the fold task F, the full local battery,
the pilot install of the epic head with the smoke test, and the epic
pull request.

## Ownership

| Paths | Owner |
|---|---|
| `packages/db/src/**`, `packages/observability/src/**` | D |
| `apps/api/src/**` except `agent-client.ts` | A1, then A2 |
| `apps/worker/src/**` except `agent-client.ts`, `controller-client.ts` | W |
| `packages/agent-client/**`, `apps/api/src/agent-client.ts`, `apps/worker/src/agent-client.ts`, `pnpm-lock.yaml`, root `tsconfig.json`, `vitest.config.ts` | C |
| `apps/workspace-agent/src/**`, `packages/contracts/src/agent.ts`, `packages/contracts/src/terminal.ts`, `apps/web/src/TerminalPane.tsx`, `apps/web/src/checks/CheckOutput.tsx` | G |
| `apps/workspace-controller/src/**`, `packages/contracts/src/controller.ts`, `apps/worker/src/controller-client.ts` | K |
| `apps/web/src/**` (except G's two files), `packages/ui/src/**` | U, then V |
| `e2e/**`, `playwright.config.ts` | E |
| `infra/tests/**` | S |
| `Makefile`, `infra/ansible/**`, `infra/host/**`, `packaging/**`, `infra/README.md` | I |
| `packages/contracts/src/**` (other files), `packages/config/src/**`, `packages/auth/src/**` | Q |

## Rulings

- R1. The agent client keeps the worker's behaviour on a stream error
  (throw) and the API's on an empty body (skip). Both are pinned by
  tests in C.
- R2. Admin role changes write an audit row only when the role actually
  changed, and every one carries the request metadata.
- R3. The image job-request file keeps mode 0640 and the others 0600;
  every copy removes its temporary file on failure.
- R4. Comments no longer cite issue numbers. A lasting sentence saying so
  goes into WORKFLOW.md at the fold.
