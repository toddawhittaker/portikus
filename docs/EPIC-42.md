# Epic 42: Instructor features

Working plan for `epic/42-instructor` (base `6a5c2586`). Code and tests
cite SPEC.md sections and ADRs 0057 and 0058, never this file. The fold
task (T14) moves the lasting rules into SPEC.md and deletes this file.

## Goal and scope

Help instructors teach with Portikus without weakening the student's
privacy.

| Issue | Delivers |
|---|---|
| #1219 | A student shares one project, read-only, with the instructors of their courses. The instructor sees its files, Git status, diffs and latest check results. The share is audited, and the student sees who looked. |
| #1216 | Coding-agent usage counts per student (sessions, tokens, estimated cost, lines changed) for instructors (their course members) and administrators (everyone). Never content. |
| #1217 | Roster sync through NRPS (LTI Names and Role Provisioning Service), from a Sync button and a refresh when the Course page is opened. People who never launched show as "Not started"; people who left lose their membership. |
| #1218 | LTI Deep Linking: an instructor picks a template or a public repository in the LMS; a student launching that link lands in the project, created once and never overwritten. |

SPEC sections served: 5.2, 7.2, 7.6, 10, 20.2, 24.1, 24.6, 24.11, 25.10,
26, 29 (Epics 13 and 13.1 "left out"), 31. STACK sections 8, 10, 11, 13,
15. ADRs 0012, 0025, 0026.

Out of this epic: the live help session with terminals (#1219 step 2).

## Rulings (decided by the orchestrator, 2026-10-10)

All of the architect's recommendations were accepted.

- **R1 Instructor visibility.** The student shares one project
  ("Share with my instructors"): read-only, audited, ends after 24 hours
  or when stopped. Instructors never look on their own initiative, and
  administrators stay at 404 on student files (SPEC 5.2).
  - Visible: the project's file tree, file contents (text and images),
    Git status, per-file diffs, latest check results.
  - Never visible: terminals, previews, search, downloads, Docker,
    processes, anything outside `~/projects/<slug>`.
  - Secret filter in the API on tree, read, status and diff: hide any
    path segment `.git`; `.env` and `.env.*` except `.env.example`;
    `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`; `.npmrc`, `.netrc`,
    `.pypirc`; `.portikus/`.
  - Who: instructors of any course in which the student has a membership.
  - Audit: share started, share stopped, first view by each instructor per
    share (not every file read).
  - The student is told by a "Shared" badge on the project row, a
    notification on each instructor's first view, and a viewer list in
    the share dialog. No email or Pushover.
  - A stopped workspace answers "The workspace is stopped"; the view never
    starts it and never counts as presence for the idle timer.
  - The instructor's view refreshes by polling every 10 seconds.
- **R2** The live help session is left out and filed as an issue.
- **R3** Roster sync runs in the API: `POST /courses/:id/roster/sync`, plus
  a refresh on Course page open at most once an hour per course, one sync
  in flight per course.
- **R4** Only NRPS `Active` members count. A membership whose LTI subject
  is not on the roster is deleted (instructors too), each writing
  `course.member_removed` with `source: roster`. Accounts and workspaces
  are never touched. An empty roster or a failed page fetch applies
  nothing and records the result.
- **R5** A roster role updates only the membership role. The account role
  still changes only at the next launch (ADR 0025).
- **R6** Roster-only people: store course, subject, display name and role;
  no email. Shown as "Not started". Rows replaced on each sync.
- **R7** Optional `authTokenUrl` on a platform registration, https only
  (http when `mock`). Without it, roster sync is unavailable for that
  platform and the Course page says so.
- **R8 Deep Linking.** The request is answered with a script-free picker
  page that creates no session or account. Only an LTI role mapping to
  instructor may use it (others refused, reason `not_instructor`).
  Choices: a configured template (`PROJECT_TEMPLATES`, SPEC 7.6) or a
  public `https` repository URL (no ssh). The instructor names the
  project (default: template name or the repository's folder name). The
  signed response returns through a "Return to your course" button, not an
  auto-submitting script. Picking happens in a new tab (ADR 0025 frame
  rule). A student launch creates the project only if no project with that
  slug exists; otherwise it opens it, or says "you archived this project".
  Never overwrites.
- **R9** Custom parameters, recorded in ADR 0058: `portikus_project`, and
  exactly one of `portikus_template` or `portikus_repository`. The content
  item URL is `PUBLIC_URL + "/"`.
- **R10** Usage comes from a receiver inside the workspace agent, on a
  fixed loopback port in the container. Claude Code (managed settings) and
  Codex (system config) export OpenTelemetry metrics as JSON to it. It
  keeps only allow-listed counters per UTC day, agent and model. The
  worker reads them every 5 minutes. No OpenTelemetry SDK (Zod-parsed
  JSON). Counts are student-forgeable: reporting, not enforcement.
- **R11** Codex is included only if the pinned Codex version exports token
  counts through an allow-listable event with prompts off; otherwise ship
  Claude Code only and file an issue.
- **R12** Show sessions, input, output and cache tokens, and lines added
  and removed. Claude Code's cost goes in an "Estimated API cost" column
  with a toggletip saying it is not what a subscription pays. Codex shows
  "—".
- **R13** Fixed 365-day retention, pruned daily by the worker; no setting.
- **R14** Instructors see totals for their course members (including use
  outside that course); administrators see everyone; no student usage
  view. Students are told in Help and STUDENT-GUIDE.md; ADMIN-GUIDE.md
  suggests an acceptable-use line.
- **R15** A new admin tab `agents`, "Agent usage", after Audit.
- **R16** T1 creates empty route-registration files and one placeholder web
  route, so later tasks never edit `server.ts`, the contracts index, the
  schema types or the router.

## Key designs

**Migrations (T1 owns all three, plus `schema.ts` and
`migrations/index.ts`):**

- `0041_lti_roster_and_deep_linking`:
  - `lti_contexts` gains nullable `platform_client_id`, `nrps_url`,
    `roster_synced_at`, `roster_sync_result`.
  - `lti_roster_members(context_id → lti_contexts ON DELETE CASCADE,
    subject, display_name, role, PK(context_id, subject))`.
  - `lti_deep_link_requests(state_hash PK, platform_issuer, client_id,
    deployment_id, return_url, data NULL, expires_at)`: 10 minutes,
    single use.
  - `lti_starter_launches(id uuid PK, user_id → users CASCADE,
    project_name, template NULL, repository_url NULL, created_at,
    expires_at)`, CHECK exactly one of template and repository: 30 minutes,
    consumed when the project is created or opened.
- `0042_project_shares`:
  - `project_shares(id uuid, project_id → projects CASCADE, started_at,
    ends_at, ended_at NULL)`, partial unique index: one open share per
    project.
  - `project_share_views(share_id → CASCADE, viewer_user_id → users
    CASCADE, first_viewed_at, last_viewed_at, PK(share_id,
    viewer_user_id))`.
- `0043_agent_usage_days`:
  - `agent_usage_days(user_id → users CASCADE, boot_id uuid, day date,
    agent ('claude'|'codex'), model text ≤100, sessions, input_tokens,
    output_tokens, cache_read_tokens, cache_write_tokens (bigint),
    cost_usd numeric NULL, lines_added, lines_removed, updated_at,
    PK(user_id, boot_id, day, agent, model))`, index on `day`.
  - The workspace agent reports cumulative totals since it started, tagged
    with a `boot_id` it picks at start. The worker upserts absolute values;
    reports sum across boots. Safe to repeat; at most one poll interval is
    lost at a stop.
- Roster matching needs no new membership column: a membership's LTI
  subject is its user's `oidc_subject` when `oidc_issuer = 'lti:' ||
  platform_issuer`, or that of the linked course account through
  `account_links` (ADR 0026).

**API paths (all under existing Caddy prefixes; no Caddyfile change):**

- `POST /courses/:courseId/roster/sync`; `GET /courses/:courseId/members`
  includes not-started rows and roster status.
- `GET`, `POST`, `POST …/stop` on `/workspaces/:id/projects/:pid/share`
  (owner only, through `ownedScope`).
- `GET /courses/:courseId/shares`; read-only
  `GET /courses/:courseId/shares/:projectId/{tree,file,git/status,git/diff,checks}`.
- `GET /courses/:courseId/agent-usage?days=7|30|90` and
  `GET /admin/agent-usage?days=…`.
- `POST /lti/deep-link` (picker submit): signs the `LtiDeepLinkingResponse`
  with the tool key (`kid` from `toolJwks`) and renders the return form;
  CSP `form-action` includes the return URL's origin.
- `POST /workspaces/:id/projects/starter {starterId}` → `{project,
  created}`, registered before `/:pid` as `templates` is.
- After a starter launch the API answers 303 to `/?starter=<id>`; the id
  is bound to the user and expires.

**Agent usage receiver:** fixed loopback port inside the container (T7
picks it, records it in ADR 0057, avoiding 4317 and 4318). JSON only, at
most 1 MiB per request. Keeps only allow-listed metrics (Claude Code
`claude_code.session.count`, `token.usage` by type and model,
`cost.usage`, `lines_of_code.count`; the Codex token-count event). Drops
every other metric, event and attribute (email, account ids, session ids),
caps models per day at 50. Telemetry is switched on in
`apps/workspace-agent/claude-managed-settings.json` (metrics exporter
otlp, protocol `http/json`, temporality `delta`, logs and events exporter
off, `OTEL_LOG_USER_PROMPTS` unset) and the Codex `[otel]` table in
`codexSystemConfig`. The controller rewrites both at every start.

## Tasks

| Task | Owns (files) | SPEC/ADR | Migration/ADR | Tests | Done means | Model |
|---|---|---|---|---|---|---|
| **T1 Schema, contracts, wiring** | `packages/db/src/migrations/0041_*.ts`, `0042_*.ts`, `0043_*.ts`, `migrations/index.ts`, `schema.ts`, db tests; `packages/contracts/src/courses.ts` (`CourseMember` gains `status: active\|not_started`; `userId` and `lastLaunchAt` nullable; course gains `roster {available, syncedAt, result}`; `RosterSyncResponse`); new `shares.ts`, `agent-usage.ts` (API responses and the agent-to-worker `AgentUsageReport`); `project.ts` starter request/response; `contracts/src/index.ts`; new `apps/api/src/courses/membership.ts` (`teachesCourse`, `sharesCourseWith`) + test; empty route-registration files `routes/course-roster.ts`, `course-shares.ts`, `project-shares.ts`, `agent-usage.ts`, `lti-deep-link.ts`, registered in `server.ts` right after `registerCourseRoutes`; placeholder `apps/web/src/course/SharedProjectPage.tsx` and route `/course/$courseId/shares/$projectId` in `router.tsx`; draft `docs/adr/0057-instructor-visibility.md` and `0058-lti-roster-and-deep-linking.md` | 26, 27, 5.2 | 0041–0043, ADR 0057, 0058 | Migration up/down on a fresh DB, constraints, contract schemas, membership helpers | Later tasks compile against frozen schema and contracts; `make check` green | Opus |
| **T2 Mock LMS and token URL** | `packages/mock-lms/**` (token endpoint verifying the tool's client assertion against `/lti/jwks`; NRPS memberships with paging and `Link: next`; roster-only and dropped seed people; Deep Linking launch; return URL that verifies and stores content items; launching a stored link with its custom parameters); `packages/auth/src/lti/platforms.ts` + test (optional `authTokenUrl`); `infra/host/lti-mock-registration.py`; `infra/tests/lti-platforms-test.sh`; `playwright.config.ts` (platform file gains `authTokenUrl`); `e2e/lti-helpers.ts`; the INSTALL.md platform-file field | ADR 0025, 13 | none | mock-lms unit tests; platform parser (https rule, mock http) | Playwright can drive NRPS and Deep Linking; the platform file accepts and checks `authTokenUrl` | Sonnet |
| **T3 LTI library** | `packages/auth/src/lti/validate.ts` + test (accept `LtiDeepLinkingRequest` with its own refusal codes; return a launch kind; read the NRPS claim `context_memberships_url`); new `lti/deep-linking.ts` (response JWT builder); new `lti/nrps.ts` (client-assertion token request; memberships fetch through `createOutboundFetch`, paging capped at 50 pages and 5,000 members, 10 s timeout, Zod-parsed members); `packages/auth/src/index.ts`. Token URL is a parameter, so no dependency on T2 | ADR 0025, 24.11 | none | Signature, audience, claims; hostile roster input (oversized, bad types, endless paging); no token or roster data in logs | Library complete and unit-tested | Opus |
| **T4 Roster sync API** | `routes/course-roster.ts`; `routes/courses.ts` (not-started rows, roster status, hourly refresh on page open, one sync in flight); new `apps/api/src/courses/roster.ts` (R4–R6 in one transaction; audit `course.roster_synced` counts only; `course.member_removed` source roster); tests | 24.11, ADR 0025 | none | DB integration: add, remove, role change, linked account, empty roster, no token URL, token failure | Rules applied; no names in logs or audit | Opus |
| **T5 Deep Linking API and starter** | `routes/lti.ts` (message-type dispatch only, plus storing `platform_client_id` and `nrps_url` in `recordMembership`; platforms read from `lti.platforms` at request time); `routes/lti-deep-link.ts` (picker and response pages, audit `lti.deep_link`); `routes/projects.ts` (extract create body into a helper, add starter route); tests; `e2e/lti-deep-link.spec.ts` (with axe) | 7.2, 7.6, 24, ADR 0025 | none | Non-instructor refused, expired or replayed handle, open-redirect guard, never overwrite, foreign or expired starter id 404 | Instructor flow works end to end against the mock | Opus |
| **T6 Project shares API** | `routes/project-shares.ts`; `routes/course-shares.ts`; new `apps/api/src/workspaces/shared-scope.ts` (viewer teaches the course, owner is a member, open unexpired share, active project; never opens presence); new `workspaces/secret-paths.ts`; tests. Reuse `agentClientFor`, `sendAgentError`, `recordAudit`, `recordNotification`. Every read sends `Cache-Control: no-store` | 5.2, 20.2, 24.1, 24.6, 24.11, 25.10 | none | Non-member 404; ended/expired 404; other course 404; secret paths hidden in tree, read, status, diff; traversal; stopped workspace 409 and not started; audit and notification on first view only | Read-only reads work; every other route still refuses an instructor | Opus |
| **T7 Usage collection** | `apps/workspace-agent/src/agent-usage.ts` (receiver, counters); `agent-usage-route.ts` (`GET /agent-usage` on the authenticated listener); registration and start in `apps/workspace-agent/src/server.ts`; `apps/workspace-agent/claude-managed-settings.json`; `apps/workspace-controller/src/agent-instructions.ts` (Codex `[otel]`) + test; `apps/worker/src/agent-usage.ts` (5-minute loop, 365-day prune, after `docker-usage.ts`); a fetch in `apps/worker/src/agent-client.ts`; start in `apps/worker/src/index.ts`. Confirm the listener is a system listener (`isSystemListener` in `listening.ts`) | 10, 25.10, STACK 15, ADR 0012 | none | Receiver drops content payloads, oversize bodies, unknown attributes; idempotent upsert; prune | On the rehearsal VM an OTLP payload posted inside a container reaches `agent_usage_days` | Opus |
| **T8 Usage API** | `routes/agent-usage.ts` (course view members only; admin view everyone; `days` 7/30/90; per-user and daily totals) + tests | 25.10 | none | Other-course instructor 404; non-admin refused; sums across boot ids | Contract-shaped data | Sonnet |
| **T9 Course page** | `apps/web/src/course/CoursePage.tsx`, `course/queries.ts`, new `course/RosterStatus.tsx`, new `course/CourseUsage.tsx`, a "Shared project" link per member; `e2e/course-roster.spec.ts`, `e2e/course-usage.spec.ts`, `e2e/a11y-course.spec.ts` | 8.6, 25.8 | none | Not-started rows, dropped member vanishes after sync, usage figures, axe | Instructor sees roster, usage, shares | Sonnet (ui-designer) |
| **T10 Shared project viewer** | `apps/web/src/course/SharedProjectPage.tsx`, new `course/shared/*`; reuse view-only components by props, no read-only flags on `FileTree` write paths; `e2e/fake-agent-server.mjs` if needed; `e2e/shared-project.spec.ts` | 5.2, 12.1, 12.6, 25.8 | none | Browse, secrets absent, refresh after change, stopped state, axe, no write controls | Read-only view, no way to write | Opus |
| **T11 Admin usage tab** | `apps/web/src/admin/tabs.ts` (`agents` after `audit`), `AdminNav.tsx`, `AdminPage.tsx`, new `admin/agent-usage/*`, admin help entry, `e2e/admin-agent-usage.spec.ts`, tab-list assertion in `e2e/admin-layout.spec.ts` | 20.1, 25.8 | none | Seeded rows, axe | Admins see usage for everyone | Sonnet |
| **T12 Starter landing** | `apps/web/src/WorkspacePage.tsx` (mount), new `apps/web/src/projects/StarterLaunch.tsx`, `e2e/lti-starter.spec.ts` | 7.2, 28 | none | First launch creates; second opens; existing folder never overwritten; expired id toast | Student lands in the starter project | Sonnet |
| **T13 Student share UI and Help** | `apps/web/src/projects/ProjectPane.tsx` (menu item, "Shared" badge), `projects/queries.ts`, new `projects/ShareDialog.tsx`, student help under `apps/web/src/help/content/`, `docs/STUDENT-GUIDE.md`; `e2e/project-share.spec.ts` | 20.2, 25.10, 8.6 | none | Start, viewer appears after an instructor reads, stop, expiry; axe | Student controls sharing and is told | Sonnet (ui-designer) |
| **Review fixes** | As found | | | | Each reviewer confirms | per finding |
| **T14 Fold** | `docs/STATUS.md`; `docs/SPEC.md` §29 "Epic 42" and short rules in 5.2, 7.2/7.6, 24.1, 24.11, 25.10, 26, 31; finalise ADRs 0057, 0058; `docs/ADMIN-GUIDE.md`; `docs/OVERVIEW.md`; delete `docs/EPIC-42.md` | 29 | none | `make check` | Plan gone; SPEC and ADRs hold the rules | Opus (low) |

## Waves

| Wave | Tasks (parallel) | Waits on |
|---|---|---|
| 1 | T1, T2, T3 | none |
| 2 | T4, T5, T6, T7, T8 | T1; T4, T5 also T3; T5's e2e also T2 |
| 3 | T9, T10, T11, T12, T13 | T9: T4, T6, T8, T2. T10: T6. T11: T8. T12: T5. T13: T6 |
| 4 | Reviews, then review-fix tasks | All of wave 3 |
| 5 | T14 | Reviewers confirm |

Before the epic PR: rehearsal VM (deploy, full smoke, an OTLP payload
posted inside a container). A real Claude Code session needs Todd's
sign-in, so that check is marked pending for him.

## Collisions with Epic 43

- **C1** `packages/auth/src/lti/platforms.ts`: Epic 42 goes first. T2
  lands `authTokenUrl` in wave 1; it is applied to `epic/43` before Epic
  43's platform task starts, and Epic 43's table and form carry a nullable
  `auth_token_url`.
- **C3** `apps/api/src/routes/lti.ts`: Epic 42 edits only the message-type
  dispatch and `recordMembership`; Epic 43 only platform loading and the
  CSP `origins` list.
- Additions only, by both: `packages/auth/src/index.ts`,
  `apps/api/src/server.ts` (Epic 42 after `registerCourseRoutes`, Epic 43
  in the admin block), `packages/contracts/src/index.ts`, `schema.ts`,
  `migrations/index.ts`, `apps/workspace-agent/src/server.ts`,
  `apps/worker/src/index.ts`, `apps/worker/src/agent-client.ts`,
  `apps/web/src/router.tsx`, admin tabs (Epic 42 adds `agents` after
  `audit`).
- Epic 42 only: `validate.ts`, `routes/courses.ts`, `lti_memberships`,
  `agent-instructions.ts`, `claude-managed-settings.json`.
- Epic 43 only: `apps/api/src/lti/deps.ts`, account-linking code,
  `contracts/admin.ts`, `contracts/agent.ts`, `admin/users/*`, the
  Caddyfile.
- Docs (`INSTALL.md`, `ADMIN-GUIDE.md`, SPEC §24.11, §26, §29, STATUS,
  OVERVIEW): each epic's fold edits them; the epic merged second rebases
  its fold.

## Reviews

code-reviewer (epic head and whole-repo dead code); security-reviewer
(shared projects and secret filter, NRPS signed outbound calls, untrusted
roster input, Deep Linking message and launch parameters, the new loopback
listener, ADR 0012 and 25.10 content rules); a11y-reviewer (Course page,
viewer, share dialog, admin tab, picker page, starter toasts).

## Left out

- The live help session (#1219 step 2); file as an issue.
- An instructor-initiated view or per-course opt-in (R1 options A, C).
- A student usage view; budgets or enforcement; a retention setting.
- Per-course instructor templates (#1246); Deep Linking uses
  `PROJECT_TEMPLATES` only.
- Private repositories or ssh clones through Deep Linking.
- Roster sync on a worker schedule; NRPS without `authTokenUrl`.
- Grade passback (AGS rejected in STACK 35).
- An admin view of shares; email or Pushover notices for shares.
- NRPS and Deep Linking checks in the smoke test; file next to #1423.
