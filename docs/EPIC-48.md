# Epic 48 — Instructor live help and live layout sync

Branch `epic/48-live-help`, from main 135b76fe. Issues #1461 (instructor
live help in a student's workspace) and #1384 (live layout sync between
browsers on one project). Migration 0048, ADR 0063. Runs beside Epic 49
(fix batch) and Epic 50 (identity). This plan comes from the architect's
design of 2026-10-12. It lives only on this branch; the fold folds it
into SPEC.md and ADR 0063 and deletes it.

Use the name "live help" (`livehelp`, `live-help`, `live_help`) in
folders and audit names. `apps/web/src/help/` is the in-product Help.

## Rulings

Todd was away, so the orchestrator decided D1 to D6 below, taking the
architect's recommendation each time. The epic PR lists them for Todd to
review.

- **D1.** A session reaches one instructor. The student names that
  instructor, who must teach one of the student's courses. Only the
  student starts a session. There is no request state (ADR 0057: the
  student shares).
- **D2.** Previews are included in both view mode and type mode (task T4).
- **D3.** The instructor gets no scrollback history: only the current
  screen and what follows it.
- **D4.** Typing with the student's consent is not "takeover". The fold
  rewords the VISION.md non-goal to "takeover without the student's
  consent". The epic PR flags this for Todd.
- **D5.** A session lasts at most 60 minutes (`LIVE_HELP_MINUTES` in
  contracts).
- **D6.** When the student has no browser open, the instructor's sockets
  close and attaching is refused. The session stays open until its
  limit, so an API restart does not end it.
- **C1.** A new `live_help_sessions` table, with one open session per
  workspace, scoped to one project. States: open, then ended.
- **C2.** Typing ships now, off by default. Only the student can turn it
  on or off. The attach `mode` (view or type) is part of the protocol.
- **C3.** The instructor attaches to a terminal through its own route,
  `GET /courses/:courseId/live-help/:sessionId/terminals/:tid/ws`, never
  through the owner-only route.
- **C4.** Input rules:
  - The API enforces them. View mode drops every client frame. Type mode
    forwards `input` frames only, never `resize`.
  - As a second layer, the agent attaches view mode with
    `-f read-only,ignore-size` and type mode with `-f ignore-size`.
  - A mode change closes the instructor's sockets with a new close code,
    and the instructor's browser reconnects in the new mode.
- **C5.** Helper attachments get an extra `{"type":"size","cols","rows"}`
  frame from the agent's pane poll. The instructor's terminal fixes
  itself to that size.
- **C7.** The student sees a bar across the top of the workspace that
  cannot be dismissed. It names the instructor, the project and the
  terminals, and has a "Let them type" / "Stop typing" switch and an End
  button. It polls every 5 seconds and announces changes in a status
  region.
- **C8.** A session ends when:
  - the student presses End;
  - the instructor leaves;
  - the project is archived;
  - the instructor no longer teaches the course (checked every second);
  - the 60 minutes run out. An expiry is not audited, as with shares.
- **C9.** Audit actions, with ids only (no bytes, names or paths):
  - `project.live_help_started`, with the session, helper and course ids
    and the end time;
  - `project.live_help_ended`, with a reason (stopped, helper_left,
    archived or helper_removed) and the duration;
  - `project.live_help_typing_changed`;
  - `project.live_help_terminal_opened`, whose actor is the instructor.
    It is written before the pipe opens, and the attach is refused if
    the write fails;
  - `project.live_help_preview_opened`.

  The instructor also gets a notification when a session starts.
- **C10.** Layout versions:
  - The version is `projects.layout_version integer not null default 0`.
  - GET returns `ETag: "<n>"`, on a 204 too.
  - PUT needs a matching `If-Match`. A missing or stale one gets 412
    `LAYOUT_CHANGED`.
  - The write is one atomic update, guarded by the version.
- **C11 (differs from the #1384 sketch).** The new layout version is
  announced as `{"type":"layout","projectId","version"}`:
  - It goes on the API-owned workspace socket (`ws.ts`, `ServerMessage`),
    not on the per-project events socket, which carries frames the
    agent could forge.
  - Only the owner's sockets receive it.
  - A newly opened socket gets the current version.
- **C12.** When two browsers conflict, the server's layout wins.
  - A load is held while a drag is in progress.
  - A pane with unsaved file text stays open.
  - A load that came from another browser is never written back unless
    the user then changes something here.
- **C13.** The instructor's terminal is a separate, minimal
  `course/live/HelperTerminal.tsx`, not a flag on `useXterm.ts`. It does
  not support OSC 52 clipboard writes, image paste, voice or automatic
  link opening, and it ignores title sequences.

## Design

### Migration 0048

```sql
create table live_help_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  helper_user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references lti_contexts(id) on delete cascade,
  typing boolean not null default false,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz null,
  check (ends_at > started_at));
create unique index live_help_one_open on live_help_sessions (workspace_id) where ended_at is null;
alter table preview_grants   add column live_help_session_id uuid null references live_help_sessions(id) on delete cascade;
alter table preview_sessions add column live_help_session_id uuid null references live_help_sessions(id) on delete cascade;
alter table projects add column layout_version integer not null default 0;
```

### Routes

Student routes (owner only):
- `GET /workspaces/:id/live-help`
- `POST /workspaces/:id/projects/:pid/live-help` with `{helperUserId, courseId}`; it checks that the helper teaches the course and that the student belongs to it
- `POST /workspaces/:id/live-help/typing`
- `POST /workspaces/:id/live-help/stop`

Instructor routes (course-instructor class):
- `GET /courses/:courseId/live-help`
- `GET /courses/:courseId/live-help/:sid`, with status and the project's open terminals
- `POST /courses/:courseId/live-help/:sid/leave`
- `GET /courses/:courseId/live-help/:sid/terminals/:tid/ws`
- Added by T4: `GET .../listening` (without `commandLine`) and `POST .../preview-grants`

### The gate

```ts
liveHelpScope(db, config, request, reply): Promise<LiveHelpScope | null>
// LiveHelpScope: { sessionId, workspaceId, projectId, ownerId, helperId, courseId, typing, agent, workspace }
// 404 unless: the caller is the helper, the session is open and unexpired,
// sharesCourseWith still holds, and the project is active.
// 409 when the workspace is not running or the student is not connected.
endLiveHelp(db, { sessionId, actor, reason }): Promise<void>
// Also deletes the session's preview grants and sessions, and calls registry.end.
```

### What to reuse

Builders must reuse these, not rewrite them:
- **Course checks.** `sharesCourseWith`, `teachesCourse` and `taughtCourseId` in `apps/api/src/courses/membership.ts`. `shareAudience` is the model for the instructor picker; add a variant that also returns user ids.
- **Audit and notices.** `recordAudit` and `recordNotification`. Ending follows the `stopShare` pattern in `apps/api/src/workspaces/project-share.ts`, and the gate follows `sharedProject` in `apps/api/src/workspaces/shared-scope.ts`.
- **Terminal pipe.** `pipeTerminal` in `apps/api/src/workspaces/terminal-pipe.ts`. Extend it with options for a client-frame filter, an extra still-allowed check, and optional presence. Do not fork it.
- **Limits.** `terminalSockets.take(userId)` counts helper sockets against the instructor's 60. `MAX_ATTACHMENTS_PER_TERMINAL` stays at 4.
- **Responses and parsing.** `sendError`, `parseOr400` and `ProjectParam` from `apps/api/src/http.js`.
- **Agent access.** `agentClientFor`. `attachUrl` in `agent-client.ts` gains a `mode` parameter.
- **Presence.** Helper sockets write no presence, so `countActive` counts only the student's browsers.
- **Previews.** `createGrant`, `previewHost`, `portAllowed` and the bridge. Only the owner check in `routes/preview.ts` changes, and instructor navigations skip `recordActivity`.
- **Web code.**
  - `decodeTerminalFrame` in `terminal/terminalFrames.ts`.
  - `openTerminalSocket` in `terminal/terminalSocket.ts`, which gains a URL argument.
  - The store's carry rule for unsaved text in `layout/store.ts`.
  - The query pattern in `course/shared/queries.ts`.
- **Tests.**
  - Add route-policy entries in `apps/api/src/security/route-policy.ts`; the authz and ws-authz matrices probe them.
  - `security/audit-coverage.test.ts` fails when SPEC 24.11 names an action the code never writes, so the new names go into SPEC in the fold.
  - The fake agent is `apps/api/src/testing/fake-agent/terminals.ts`.
  - Each e2e spec seeds its own course, as `courseWith` in `e2e/project-share.spec.ts` does.

## Tasks

| Task | What | Files it owns | Depends on |
|---|---|---|---|
| T1 Foundations | Migration 0048 and its test, database types, contracts (the `live-help.ts` contract, close codes for mode-changed and ended, attach mode, `LIVE_HELP_MINUTES`), the `size` terminal frame, and the `layout` server message | `packages/db/src/migrations/0048_live_help.ts` and its test, the migrations index, `packages/db/src/schema.ts`, `packages/contracts/src/live-help.ts`, the contracts index, `close-codes.ts`, `terminal.ts`, `packages/events/src/index.ts` | — |
| T2 API live help | The gate, sessions, registry, student and instructor routes, the instructor terminal socket, the `pipeTerminal` options, `attachUrl` mode, the archive hook and the notification | `apps/api/src/live-help/*`, `routes/live-help.ts`, `routes/course-live-help.ts`, `workspaces/terminal-pipe.ts`, `agent-client.ts`, `server.ts`, `security/route-policy.ts`, one call in `routes/projects.ts`, `testing/fake-agent/terminals.ts` | T1 |
| T3 Agent attach modes | The `mode` query, the tmux flags, skipping history for helpers, and the size frame, with real-tmux tests | `apps/workspace-agent/src/terminals-route.ts`, `terminals.ts`, `tmux.ts`, `cwd.ts` | T1 |
| T4 Instructor previews | The instructor's listening list, preview grants, the widened owner check, no activity recording, and the store lookup | `routes/course-live-help-preview.ts`, `routes/preview.ts` (owner check and activity only), `preview/store.ts`; additions to `server.ts` and `route-policy.ts` | T2 |
| T5 Student interface | The start dialog (instructor picker, plain consent text, typing off), the bar, the menu item, student Help text, and e2e tests with axe | `apps/web/src/livehelp/*`, `projects/ProjectPane.tsx`, `WorkspacePage.tsx`, `help/content/student.tsx`, `e2e/live-help-student.spec.ts` | T1; e2e needs T2 |
| T6 Instructor interface | The course page link, the live page, `HelperTerminal`, the preview list, instructor Help text, and a two-context e2e test (view refuses input, typing works, End closes within a second) | `apps/web/src/course/live/*`, `course/CoursePage.tsx`, `router.tsx`, `terminal/terminalSocket.ts` (URL argument), `terminal/terminalFrames.ts` (size frame), `help/content/instructor.tsx`, `e2e/live-help-instructor.spec.ts` | T2, T3 |
| T7 Layout sync | ETag, If-Match and 412; the version increment; the hub; announcements; the browser's reload and merge rules; unit tests and a two-context e2e test | `routes/project-layout.ts`, `routes/ws.ts`, `workspaces/workspace-hub.ts` (new), `layout/persist.ts`, `layout/store.ts`, the web workspace-socket hook, `e2e/layout-sync.spec.ts` | T1 |
| T8 Fold | Writes ADR 0063 (how it extends ADR 0057). Updates SPEC 5.2, 7.6, 9.7, 14.4, 20.2, 24.1, 24.7, 24.11 (the new audit names), 26, section 29 and section 31. Writes STATUS, rewords VISION (D4), and deletes this plan. | `docs/` | all |

Order: T1 first. Then T2, T3 and T7 at the same time. Then T4, T5 and T6. Then the fold.

### Consent text (T5)

The text must say plainly that letting the instructor type gives them
a full shell as the student. That includes the student's Git, Claude
and SSH credentials and their other terminals. ADR 0063 records this
as an accepted risk.

### Layout-sync trap (T7)

Browser A can load a remote layout, then reconcile it against a
terminal list it has not refreshed yet. That can remove the leaf of a
terminal browser B just made, and the two browsers then keep
overwriting each other. Never write back a remote load unless the user
changes something here. A required unit test: two stores sharing a
fake server reach the same layout with no further writes after one
user change.

### Cross-epic conflicts

- Epic 49's file splits (#1289) may split `routes/projects.ts`. T2 changes it by one call only.
- Epic 49's #1524 touched the tree drop helper in `work/moveInto.ts`. T7 owns `layout/store.ts`.
- Epic 49's narrow layout (#1276) may touch `WorkspacePage.tsx`. T5 merges the epic head before it opens its PR.

## Security review focus

1. One gate for every instructor route and socket. Each of these gets 404: another instructor of the same course, an administrator, an ended or expired session, an archived project, a terminal outside the session's project, and an ended terminal.
2. When a session starts, the helper must teach the course and the student must belong to it.
3. Input rules are enforced in the API. Turning typing off closes the instructor's sockets at once.
4. End, Stop typing and leave take effect immediately. Sign-out, roster removal, expiry and the student leaving take effect within about a second. Ending also clears the preview lookup cache.
5. The instructor never keeps the workspace awake.
6. The instructor's browser ignores OSC 52, auto-opened links and title sequences. Student code runs in previews in an instructor's browser, so cross-site risk applies; #1236 is the long-term fix.
7. No scrollback replay for the instructor.
8. Typing is a full shell as the student, and the consent text says so.
9. Audit and logs hold ids only.
10. The existing socket and attach limits apply to helpers.
11. The preview owner check is widened only through an open session.
12. Layout announcements go to the owner's sockets only.
13. Every new route has Origin checks and matrix entries.

## Rehearsal

On the rehearsal VM, with a real student and a real instructor (both made by test sign-ins):
- The student starts live help. The instructor sees the student's terminal.
- View mode refuses the instructor's input. With typing on, the instructor's keystrokes reach the student's shell.
- End closes the instructor's view within a second. An archive and a roster removal also end the session.
- The instructor opens a preview, and the workspace does not stay awake because of it.
- Two browsers keep one project's layout in step.
