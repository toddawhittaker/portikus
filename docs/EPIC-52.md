# Epic 52: code help and course profiles

Feature epic for issue #1246. Branch `epic/52-code-help`, cut from main
dade44d6. This plan lives only on the epic branch; the fold task (T10)
folds its lasting rules into SPEC.md and deletes it (WORKFLOW.md, "Epic
plans"). The plan follows the architect's design of 2026-10-20 (read on
main b01fdda5) and Todd's rulings from the #1246 design interview. The
design file is not in the repository, so the parts builders need are
written out below.

## Goal

Two things, shipped together because the second depends on the first.

1. Code help: real language servers (Python through pyright, TypeScript
   and JavaScript through typescript-language-server, Python formatting
   through `ruff server`) run in each student's workspace and feed the
   Monaco editor. Six features: completion, hover, go to definition,
   rename, format and diagnostics, plus a Problems list for open files.
2. Course profiles: an LTI course is either Agentic (today's interface)
   or Traditional (hides the coding-agent launchers, the Docker controls
   and the system rows in the Running pane). The course's instructor, or
   an administrator, sets it. Hiding never blocks: the image, the egress
   rules and every API stay the same.

Why: a traditional programming course loses the coding agent as the
answer to "the editor has no IntelliSense" (ADR 0015). Real code help
fixes that, and a course can then choose a simpler interface.

### Sections served

- docs/VISION.md: the line on not simulating software development, and
  "Developer experience" (T1 edits both).
- docs/SPEC.md: 2.6 (workspace agent), 5.2 (authorization), 8.7 (new,
  course profile), 13.1 and new 13.6 (code help), 20.1 (admin
  capabilities), 24.1 (trust boundaries), 24.11 (audit), 25.1 and 25.2
  (performance and capacity), 26 (data model), 32 (non-requirements).
  Also 13.5 (version-aware save, used by rename), 12.7 (left alone), 18.1
  (Checks stay the project-wide check), 9.7 and 24.4 (what confinement
  does and does not do).
- docs/STACK.md: 3 (frontend), 10 (workspace agent), 13 (testing), 15
  (observability: no message bodies logged), 34 (summary), 35 (rejected).
- ADR 0065 "Language servers in the workspace" (supersedes the
  language-service part of ADR 0015) and ADR 0066 "Course profiles hide,
  stored on the LTI course".

## Rulings

Todd's rulings (interview and plan review, 2026-10-20):

- Real language servers in each workspace, not the in-browser Monaco
  services as a stopgap.
- First languages: Python and TypeScript/JavaScript. C/C++ and Java come
  later, one task each.
- The profile hides features only. It never blocks (no egress change, same
  image).
- The profile is stored per LTI course. A user with no course sees the
  full interface (Agentic). A user in several courses gets the fullest
  profile among them.
- The course's instructor sets it on the Course page (the first instructor
  write there, checked against teaching that course). An administrator
  can set it too.
- Two fixed profiles, no per-feature switches: Agentic and Traditional.
- Python Format uses `ruff server`, format-only (lint off). T9 bundles a
  pinned ruff binary with a sha256 check in `scripts/build-deb.sh`.
- Only student memberships decide the profile. Instructors and
  administrators always see Agentic.
- Load-test bar: 25 students on a 16 GiB VM, completion p95 under 1
  second, at least 2 GiB of memory free. The 8 GiB pilot VM is documented
  as too small for a full code-help class.
- Out of scope, already filed as issues: the debugger (#1622) and
  per-course tool versions (#1623).

Orchestrator rulings (from the design; each is easy to undo):

- A thin LSP client of our own in `apps/web/src/lsp/`, not Monaco 0.57's
  built-in client (it syncs every model to every server, sends `pk:/` URIs
  raw and lowercases URIs, which is wrong on Linux) and not
  monaco-languageclient 11 (it replaces monaco-editor with about 30
  packages, against ADR 0015). Builders may read Monaco's MIT adapters as
  reference. Protocol types come from `vscode-languageserver-protocol`
  3.18.4 as a type-only dev dependency.
- The servers ship in the .deb agent tree (no image rebuild, pinned in the
  lockfile, about 45 MB more unpacked), bind-mounted read-only at
  `/opt/portikus/workspace-agent`.
- TypeScript 6.0.3 is bundled beside typescript-language-server 6.0.2,
  because TypeScript 7 is the Go port and has no tsserver. The agent's own
  type-checking stays on TypeScript 7.
- The profile is a text column on `lti_contexts` with a check constraint
  (`agentic` or `traditional`, default `agentic`).
- Last window wins: a second page for the same project and server replaces
  the first.
- Code help is on in both profiles.

Choices this plan makes where the rulings were silent:

- Ruff is a third server id, `ruff`, beside `python` and `typescript`.
  T2 adds it to the `LanguageServerId` contract. T3 adds its table entry,
  which serves only the format feature for Python files, and starts it
  with lint turned off. T7 sends Python Format to `ruff` and the other five
  features to `python`. The binary is `bin/ruff` in the agent tree, which
  T9 installs; a missing binary shows as "unavailable" like any server.
  Servers run per project and id, so a student with two projects open can
  reach the 3-servers-per-workspace cap. Ruff (about 30 MB) does not count
  toward the cap; only `python` and `typescript` servers do.
- Task ids keep the design's numbering, so there is no T5.

## Design that builders must follow

### Agent (T3), apps/workspace-agent

- Route `GET /projects/:slug/language-servers/:server` (WebSocket), shaped
  like the events route. The existing token hook authenticates. The
  project is resolved with `resolveProject`, which rejects symlink escapes.
- One server process per (project, server), started at the first socket,
  with cwd set to the real project path. Spawn wrapped in prlimit and choom
  as the Checks route does (`--nproc` limit, `choom -n 500`). Kill with
  `killProcessTree`.
- Wire protocol: plain LSP with Content-Length framing on the server's
  stdio, one JSON-RPC message per WebSocket text frame, no envelope. The
  stdio framing module is named generically (`stdio-messages.ts`) so the
  debugger (#1622) could reuse it, but nothing is built for that.
- The agent reads only the first client message (`initialize`). It
  overwrites `rootUri`, `rootPath`, `workspaceFolders` and `processId`
  (the agent's own pid) and merges the table's `initializationOptions`.
  Everything after passes through unread.
- Confinement is scope, not security: servers run as the student inside
  the container (SPEC 24.4). For Python, the project's `.venv/bin` (or
  `venv/bin`) goes first on PATH; the builder must verify this works with
  pyright. TypeScript automatic type acquisition is off (no npm installs,
  no network).
- Memory: Node `--max-old-space-size=1024` for pyright and the TypeScript
  wrapper, `maxTsServerMemory` 1024, choom 500. The container's 4 GB
  memory limit is the ceiling. The load test tunes the 1024 values.
- Lifecycle: one window at a time. A second socket for the same pair
  restarts the server and closes the old socket with REPLACED (4412); that
  page shows "Code help is on in another window" with a "Use here" button
  and does not reconnect by itself. Stop 60 seconds after the last socket
  closes. Close with IDLE (4413) after 15 minutes without a browser
  message (the client reconnects quietly on the next edit or focus). At
  most 3 `python` or `typescript` servers per workspace (ruff is not
  counted); the 4th stops the least recently used one with IDLE. Stopping is shutdown, exit, then kill the tree after 3
  seconds.
- Crashes: an exit the agent did not cause closes with CRASHED (4414) (if
  the kill was not ours the message says "may have run out of memory").
  Three crashes in 5 minutes make the server UNAVAILABLE (4415) for 5
  minutes. A server that is not installed, or an older agent without the
  route (the API maps the upgrade 404), is also UNAVAILABLE. Agent restart
  after an upgrade (SPEC 22.5) uses the same reconnect path.
- Table entry: id, Monaco languages, command, heap flag,
  `initializationOptions`, and which of the six features it serves.
  Adding clangd or jdtls later is one table entry, one enum value in
  contracts, one line in `web/lsp/servers.ts`, image packages and tests.
- Logging: stderr is drained and dropped. No message body is logged
  anywhere (STACK 15, ADR 0012).
- An oversized server response (over 4 MiB) is replaced by the agent with
  a JSON-RPC error carrying the same request id.

### API relay (T4), apps/api

- Browser route `GET /workspaces/:id/projects/:pid/language-servers/:server`.
  Owner only: `workspaceUpgradeGuard(..., { ownerOnly: true })` plus
  `scopedProject`. No admin, instructor, share or live-help access. It is
  an owner `websocket: true` entry in `security/route-policy.ts`, which the
  ws-authz-matrix test probes.
- A new `workspaces/message-pipe.ts` with `pipeMessages`, a message-framed
  relay (not a flag on `pipeOneWay`). It reuses `pipeBackpressure` and the
  once-a-second session check from `terminal-pipe.ts`, and `safeCloseCode`
  (currently private there; T4 exports it, and only exports it, from
  `terminal-pipe.ts`). Slots come from `createSocketSlots` (4 sockets per
  workspace) and `createPendingWork`.
- The API never reads frames. Close reasons are fixed strings of ours. The
  agent-to-API direction is capped at 4 MiB on this pipe; the
  browser-to-API direction stays at the global 1 MiB frame limit. The
  Origin check is the global one in `packages/auth/src/plugin.ts`.
- `languageServerUrl()` is added to `agent-client.ts`.
- Profile: `courses/profile.ts` holds `effectiveProfile()` (student
  memberships only, fullest wins, no course means Agentic) and
  `setCourseProfile()`. `PUT /courses/:courseId/profile` in
  `routes/courses.ts` (checked with `teachesCourse`) and
  `PUT /admin/courses/:courseId/profile` plus `GET /admin/courses` in a new
  `routes/admin-courses.ts` call the same function. Each change is audited
  in the same transaction as `course.profile_changed` with `from` and `to`
  (`recordAudit`, as `course.member_removed` does). `GET /courses` includes
  the profile. `GET /me/settings` gains a read-only `courseProfile`, like
  `voiceInputEnabled`.
- The e2e fake agent gets `testing/fake-agent/language-servers.ts`, a
  scripted LSP responder, patterned on `fake-agent/events.ts`.

### Web client (T7), apps/web

- `apps/web/src/lsp/`: `connection.ts` (socket, backoff like
  `useProjectEvents`), `client.ts` (one per project and server:
  initialize, document sync), `providers.ts` (the six features),
  `servers.ts` (Monaco language to server id), `opener.ts`, `rename.ts`,
  `store.ts` (zustand: problems, server status). About 800 lines in all.
- Only models whose URI is `pk:/<projectId>/...` are synced
  (`CodeEditor.tsx`); never diff or read-only text models. Language comes
  from `languageForFile`.
- Client rules: `snippetSupport` false, `resourceOperations` empty;
  incremental sync (both sides are UTF-16, only 0- versus 1-based differs);
  documents over 512 KiB are not sent and the editor bar says "Code help
  is off for files over 512 KB"; hover and completion content is untrusted
  (`isTrusted` false, `supportHtml` false, only http(s) links with
  `noopener`, images stripped from hover Markdown because CSP allows
  `img-src https:`); `workspace/applyEdit`, `window/showDocument` and
  `workspace/executeCommand` are declined; rename stays inside the
  project, touches at most 20 files, is all or nothing, opens unopened
  files as tabs and saves through the version-aware path (SPEC 13.5);
  cross-file definition uses `monaco.editor.registerEditorOpener` plus the
  layout store's `openFile(path, {line})`, and a target outside the project
  shows a short message; Problems covers open files only (project-wide is
  Checks, SPEC 18.1).
- `editor/features.ts` loads suggest, hover, gotoSymbol, rename, format
  and gotoError; `baseEditorOptions` sets `wordBasedSuggestions: "off"`.
  The editor bar shows server state (starting, ready, unavailable,
  crashed, replaced) with a Restart button; editing never blocks.
  `WorkspacePage.tsx` owns one client manager per project.

### Profile in the web (T6) and Problems (T8)

- Traditional hides the Claude Code and Codex launchers and the empty-pane
  "Start Claude Code" button (`work/WorkArea.tsx`), the Docker section
  (`shell/WorkspaceDialog.tsx`), and the system rows and their toggle
  (`running/RunningPane.tsx`). The ResetDocker action stays on the
  storage-full error screen, because it is a recovery path. The change
  takes effect on the next page load or window focus.
- Instructor control: `course/CourseProfile.tsx` on `CoursePage.tsx`.
  Administrator control: `admin/signin/CoursesGroup.tsx` on `SignInTab.tsx`,
  beside the LMS group.
- Problems is the fifth right-pane tab (`"problems"` in
  `shell/rightPane.ts`, tab in `shell/FilesPane.tsx`, content in
  `problems/ProblemsPane.tsx`), built like Checks, Running and Monitor.

## Numbers preassigned

| What | Value |
|---|---|
| Migration | `0050_course_profile` (adds `lti_contexts.profile`) |
| ADRs | 0065 Language servers in the workspace; 0066 Course profiles hide, stored on the LTI course |
| Close codes | 4412 REPLACED, 4413 IDLE, 4414 CRASHED, 4415 UNAVAILABLE |
| Frame limit, agent to API | 4 MiB |
| Document limit | 512 KiB |
| Sockets per workspace | 4 |
| Servers per workspace | 3 |
| Server ids | `python`, `typescript`, `ruff` |
| Audit action | `course.profile_changed` (from, to) |
| Pinned servers | pyright 1.1.414, typescript-language-server 6.0.2, typescript 6.0.3 |

## Tasks

Each task owns only its listed files. A task that needs a file it does not
own, above all a `package.json`, stops and reports.

| Task | Agent | Model | Wave | Owns | Issues |
|---|---|---|---|---|---|
| T1 Documents | builder | Sonnet | A | docs/VISION.md, docs/SPEC.md (sections above), docs/STACK.md, docs/adr/0065-*.md, docs/adr/0066-*.md, docs/adr/0015-editor-stack.md (status line only), docs/adr/README.md | refs #1246 |
| T2 Contracts, migration, dependencies | builder | Sonnet | A | packages/contracts/src/language-servers.ts (new), close-codes.ts, courses.ts, settings.ts, index.ts; packages/db migration `0050_course_profile` plus test, migrations/index.ts, schema.ts; every package.json and pnpm-lock.yaml | refs #1246 |
| T3 Agent language-server host | builder | Opus | B after T2 | apps/workspace-agent/src/language-servers.ts, language-server-table.ts, stdio-messages.ts, language-servers-route.ts (all new) and their tests; src/security/language-servers.test.ts (new); server.ts registration; integration tests against real pyright and typescript-language-server | refs #1246 |
| T4 API relay and profile | builder | Sonnet | B after T2 | apps/api/src/workspaces/message-pipe.ts (new); terminal-pipe.ts (export only); agent-client.ts; server.ts; security/route-policy.ts; routes/language-servers.ts (new); testing/fake-agent/language-servers.ts (new) and fake-agent/index.ts; courses/profile.ts (new); routes/courses.ts; routes/admin-courses.ts (new); routes/me.ts | refs #1246 |
| T7 Web LSP client | builder | Opus | B after T2 | apps/web/src/lsp/* (new); editor/features.ts, editor/monaco.ts, editor/CodeEditor.tsx, editor/editor.css; WorkspacePage.tsx; unit tests | refs #1246 |
| T6 Profile in the web | ui-designer | Sonnet | C after T4 | editor/settingsQueries.ts; course/CoursePage.tsx, course/CourseProfile.tsx (new), course/queries.ts; admin/signin/SignInTab.tsx, admin/signin/CoursesGroup.tsx (new), admin/signin/queries.ts; work/WorkArea.tsx; shell/WorkspaceDialog.tsx; running/RunningPane.tsx; help/content/instructor.tsx, help/content/admin.tsx; e2e/course-profile.spec.ts and e2e/a11y-course.spec.ts (new) | refs #1246 |
| T8 Problems and student help | ui-designer | Sonnet | C after T7 | shell/rightPane.ts, shell/FilesPane.tsx; problems/* (new); help/content/student.tsx; e2e/problems.spec.ts (new) | refs #1246 |
| T11 Code-help e2e | tester | Sonnet | C after T4 and T7 | e2e/code-help.spec.ts, e2e/a11y-code-help.spec.ts (both new) | refs #1246 |
| T9 Packaging, smoke, load test | infra | Opus | C after T3 and T4 | scripts/build-deb.sh (keep `.d.ts` and `.pyi` files when pruning; add the pinned ruff binary with sha256), infra/tests/smoke/workspace-agent.sh, infra/tests/load/*.mjs, docs/CAPACITY.md, SPEC 25.1 and 25.2 figures; owns the rehearsal VM | refs #1246 |
| T10 Fold | builder | Sonnet | D | SPEC section 29 entry, docs/STATUS.md, delete docs/EPIC-52.md, docs/OVERVIEW.md current state, e2e/shard-timings.json | closes #1246 |

Paths under apps/web are relative to `apps/web/src/`, and under
apps/workspace-agent and apps/api to their `src/`, where no prefix is
given. Shared contract constants (limits, close codes, server ids) live
only in `packages/contracts`; every app imports them.

T2 also checks that `tsc` in `apps/workspace-agent` still resolves
TypeScript 7 after `typescript@6.0.3` is added beside it, and states how.

Task PRs do not edit `docs/STATUS.md`. Each puts its proposed STATUS line
(what it delivered, gaps left) in its PR body; T10 writes the section once.

## Waves

- Wave A (T1, T2) runs in parallel from the epic head once this plan
  lands. They touch disjoint files. Nothing else starts until T2 is
  merged, because T2 owns the contracts, the migration number and every
  dependency change.
- Wave B (T3, T4, T7) runs in parallel after T2. T3, T4 and T7 write
  against the same wire protocol, fixed by T2's contracts and the design
  above, so they do not wait on each other. T1 need not have landed.
- Wave C starts per task as its inputs land: T6 after T4; T8 after T7;
  T11 after T4 and T7; T9 after T3 and T4. T1 must have landed before T9
  writes the SPEC 25 figures, so T9 also waits on T1.
- Wave D: reviews and their fixes, then the rehearsal-VM full smoke, then
  T10.

## Review plan

After every wave C task has landed:

- code-reviewer over the epic head, and over the whole repository's dead
  code.
- security-reviewer (required): the epic adds a workspace-agent route and
  a new browser socket, and spawns processes. Focus: the owner-only guard,
  the ws-authz matrix entry, Origin, the session re-check, frame limits,
  that the agent rewrites `initialize` fields, that no body is logged, and
  that untrusted hover and completion content cannot run script or load
  images.
- a11y-reviewer (T6, T8, T11, and the editor-bar status in T7): the course
  profile control, the Problems tab, the "Use here" banner and the
  unavailable-state announcements, against SPEC 25.8.

Findings are fixed or deferred through further task PRs, landed by merger,
then confirmed by each reviewer.

## Rehearsal VM and load test

T9 owns one rehearsal VM for the run. Because the load test needs it, that
VM is sized at 16 GiB (the host has room). After the review fixes land,
T9 does a full install of the epic head and the full smoke test, including
the Dex sign-in file, with no avoidable skips.

The load test (extends `infra/tests/load/` and the method in
docs/CAPACITY.md): 25 simulated students, each with one Python file and
one TypeScript file open, requesting a completion and making an edit every
5 seconds. It records per-server resident memory, completion p50 and p95,
edit-to-diagnostics time, and VM memory. The bar is completion p95 under 1
second and at least 2 GiB free on the 16 GiB VM. If it fails, the levers
are lower heap caps and fewer servers per workspace; a site switch to turn
code help off is not built. The figures go into SPEC 25.1 and 25.2 and
docs/CAPACITY.md, which states plainly that the 8 GiB pilot VM cannot hold
a full code-help class.

Smoke additions in `infra/tests/smoke/workspace-agent.sh`: the three
servers start from the installed package tree, answer `initialize`, and
are reported unavailable when a binary is removed.

## Left out on purpose

- Signature help, find references, code actions and the outline.
- Format on save.
- Project-wide problems (Checks covers the project, SPEC 18.1).
- Peek definition outside the project.
- Language servers as named processes in the Monitor pane.
- A site switch to turn code help off.
- Blocking tools: the profile hides and never blocks.
- The debugger (#1622). The stdio message module is named generically but
  nothing is built for it.
- Per-course tool versions (#1623).
- Instructor preview of the Traditional interface.
- Hiding the review of agent sessions (SPEC 12.7).
- C/C++ and Java servers, one task each later.
- A cgroup per language server (only if the load test fails; it would also
  close the setsid escape in SPEC 9.7).
- Any change to the egress rules, the image, or the sandbox.
