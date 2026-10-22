# Epic 53: Settings redesign and per-language code help

Feature epic. Branch `epic/53-settings-redesign`, cut from main 02ccc4ac.
This plan lives only on the epic branch; the fold task (D) folds its
lasting rules into SPEC.md and deletes it (WORKFLOW.md, "Epic plans"). It
follows the architect's design of 2026-10-21 and Todd's rulings of the same
day. Where the two differ, the rulings win. The design file is not in the
repository, so everything builders need is written out below.

## Goal and scope

Two things, shipped together because the Settings page carries both.

1. Redesign Administration > Settings to the approved mock-up: five
   sections, one Save per section, nothing saves on click, a warning when
   leaving with unsaved changes, units and defaults shown in place, a
   designed loading and error state, and one site-wide "Last changed" line.
2. Replace the single code-help switch with one checkbox per language,
   with a live estimate of memory per student and students per server. A
   turned-off language gets the plain editor.

Four bundled fixes ride along because Todd chose them: the Keep running
fields (#1649), the editor right-click menu after a diff round trip
(#1650), the hover text backslash, and the split-view double announcement.
The `schema.ts` split is also bundled.

### Issues closed

The epic pull request into `main` closes #1653 (the redesign), #1651 (the
language choice), #1649 (Keep running fields) and #1650 (right-click menu).
GitHub closes issues only when a pull request reaches the default branch,
so task pull requests use `Refs`, and the epic pull request body carries
the four `Closes` lines. Issue #1652 (new languages) stays open.

### Sections served

- docs/SPEC.md: 6.4, 13.6, 19.4, 20.1, 24.1, 24.11, 25.2, 25.8, 26, 29.
- docs/STACK.md: 3 (frontend), 13 (testing).
- docs/CAPACITY.md: the source of every per-student figure.
- docs/DESIGN.md: the visual rules the page follows.
- ADR 0065 (language servers in the workspace) and the new ADR 0067.

## Rulings

Todd's rulings from the mock-up review (issue #1653):

- One Save per section. Nothing saves on click.
- The estimate reads the server's real memory (`useSiteLimits()`,
  `host.memory.totalBytes`). When memory is unknown, it says so.
- The student count is not capped. It is labelled worst case and memory
  only.
- Languages not yet shipped (Java, C and C++, HTML/CSS/JSON, SQL) are
  listed but disabled and marked "Coming later". They have no contract id.
- The section is named "Student tools".
- One site-wide "Last changed" line, from `updatedAt` of the platform
  settings. Section footers show "Saved" after a save, with no stored time
  per section.

Todd's rulings on the architect's questions:

1. A turned-off language is refused at the API relay only, with close code
   4416 DISABLED. The agent is not taught the set.
2. The per-workspace dialogs on the Users tab (guard, limits, grace) adopt
   the new labels and the unit suffix in this epic.
3. "Last changed" also moves on a log-level change and does not move for
   mail and alerts. Accepted. Email and alerts keeps its existing
   "Applied <time>" footer line.
4. "Restore built-in text..." saves at once after its confirm dialog and
   stores null, as Reset to default does today. It is the one action on
   the page that saves without the section's Save.

Bundled fixes Todd chose:

- #1649: align the Keep running fields on their tops, make the time field
  fit its content, add an e2e check that the inputs' top edges match, and
  check that the storage meter bars are all the same length.
- #1650: diagnose, start with a failing Playwright test, then fix.
- Split `packages/db/src/schema.ts` below 800 lines (lint warns at 806).
  The split goes where the file does a second job.
- Hover text shows a stray backslash before `![` inside code samples
  (`apps/web/src/lsp/content.ts`).
- Split view: two editors side by side both announce a code-help crash.
  Only one announcement should be made.

Not bundled: A11, the focus loss on a profile change. It stays a gap in
the STATUS.md section that D writes.

Choices from the design, kept because the rulings are silent:

- The column is replaced, not added beside the boolean (schema is hard to
  undo). It stores the enabled set. A language added later is off on every
  existing site until an administrator ticks it. That suits heavy servers.
- Language ids are separate from server ids: `python` and `typescript`.
  `typescript` covers JavaScript, and the label says so.
- Strict on write, lenient on read: requests use the enum, responses use
  plain strings, so an open tab with older JavaScript still parses.
- Each section sends changed fields only.
- `UnitInput` is exported from `packages/ui` beside the `TextField` `unit`
  prop, because the page row and the dialogs both need it.
- The unit is in the field's accessible description, not `aria-hidden`.
- Estimate constants live in web, not contracts, with a drift test against
  a table in `docs/CAPACITY.md`.
- The leave guard uses TanStack Router's `useBlocker` and the existing
  ConfirmDialog.

## Where things are

Mock-up (approved spec for layout and wording), on the development host:

`/home/todd/projects/portikus/screenshots/settings-mockup/`

It is gitignored, so worktree agents do not have it. Read it from that
absolute path, not from a relative `screenshots/` path in the worktree. It
holds the PNGs named in issue #1653 and, in `source/`, `gen.mjs`,
`mock.css` and `estimate.js`. Where the issue text and the images differ,
the issue wins (see "Contradictions").

## Numbers preassigned

| What | Value |
|---|---|
| Migration | `0051_code_help_languages` (highest today is 0050; 0045 was never used) |
| ADR | 0067 Code help chosen per language |
| Close code | 4416 DISABLED, unchanged, reason "code help is off" |
| Audit action | `settings.code_help_updated`, unchanged, metadata `{from, to}` as arrays |
| Language ids | `python`, `typescript` |
| Locks | `SETTINGS_ROW_LOCK` and `CODE_HELP_SWITCH_LOCK`, names unchanged |

## Design that builders must follow

### Data and contracts (A1)

Migration `0051_code_help_languages`:

- `up`: add `code_help_languages text[] not null default '{python,typescript}'`;
  `update settings set code_help_languages = '{}' where not code_help_enabled`;
  drop `code_help_enabled`.
- `down`: add `code_help_enabled boolean not null default true`; set it to
  `cardinality(code_help_languages) > 0`; drop `code_help_languages`.
- No check constraint on the ids (precedent: `egress_presets`, migration
  0025). The API validates on write, and readers drop ids they do not know.
- `schema.ts`: `code_help_languages: Generated<string[]>`.
- Move the code-help test out of `0050_course_profile.test.ts` into
  `0051_code_help_languages.test.ts`: a fresh row gets both languages; a
  false row carries over as `{}`; a true row carries over as both; down
  restores the boolean.

Contracts, in `packages/contracts/src/language-servers.ts`:

```ts
export const CODE_HELP_LANGUAGE_IDS = ["python", "typescript"] as const;
export const CodeHelpLanguage = z.enum(CODE_HELP_LANGUAGE_IDS);
/** Total over LanguageServerId, so adding a server without a language is a compile error. */
export const CODE_HELP_LANGUAGE_OF_SERVER: Record<LanguageServerId, CodeHelpLanguage> =
  { python: "python", ruff: "python", typescript: "typescript" };
```

Do not name anything `CODE_HELP_LANGUAGES`; `apps/web/src/lsp/servers.ts`
already uses that name for Monaco language names.

Wire shapes, in `packages/contracts/src/settings.ts`. `codeHelpLanguages`
replaces `codeHelpEnabled` in each:

| Shape | Schema |
|---|---|
| `PlatformSettings` (answer of GET and PUT `/admin/settings`) | `z.array(z.string())` |
| `UpdatePlatformSettingsRequest` | `z.array(CodeHelpLanguage)`, unique, optional; `[]` means code help off |
| `MeSettings` (`GET /me/settings`) | `z.array(z.string()).optional()`; missing means none |

The API stores the set in canonical order (`CODE_HELP_LANGUAGE_IDS` order)
and `siteSwitches` drops unknown ids on read. The request enum makes the
API answer 400 for `java`, so "Coming later" is enforced on the server too.

Callers A1 changes (all in this repository):

- API: `apps/api/src/site/switches.ts`, `routes/admin.ts`
  (`SETTINGS_COLUMNS`, `toPlatformSettings`, the `singleFields` entry),
  `routes/language-servers.ts`, and their tests. `routes/me.ts` spreads
  `siteSwitches`, so it changes for free; its test changes.
- Web, to compile only: `editor/settingsQueries.ts` and its test (add
  `useCodeHelpLanguages(): ReadonlySet<CodeHelpLanguage>`; keep
  `useCodeHelpEnabled` as "set not empty"), and `admin/SettingsTab.tsx`
  (the existing "Allow code help" box maps to all or none).
- Web fixtures: the platform-settings objects in the files A1 owns below.
- e2e: helpers and the specs A1 owns below.
- No worker, controller or agent code reads the setting.

Audit: the action stays `settings.code_help_updated`, written in the same
transaction as the change. Metadata is `{from, to, ip, userAgent}` with
both sets in canonical order. No row is written when the sets are equal,
ignoring order (compare as sets; arrays compare by reference).
`apps/api/src/security/audit-coverage.test.ts` keeps passing because the
action name is unchanged. Rows written before this epic hold booleans; the
Audit tab shows raw metadata, so nothing breaks.

### Refusal path (A1 for the API, B2 for the browser)

API, `routes/language-servers.ts`:
`enabled = (await switches).codeHelpLanguages.includes(CODE_HELP_LANGUAGE_OF_SERVER[server.data])`.
The rest of the flow is unchanged: the socket slot is taken first and
released on refusal; a failed database read closes with SERVER_ERROR; the
check is read fresh on every connect, with no cache; the agent is never
dialled on refusal. It is a resource control, not a security boundary: a
student can still start pyright by hand in a terminal (ADR 0065). Sockets
already open close at their next reconnect.

Browser (B2):

- `useCodeHelpManager` (`lsp/context.ts`) takes the set in place of
  `enabled`. It is null when the set is empty, and keyed on the sorted,
  joined ids so a refetch does not restart the servers.
- `CodeHelpManager.attach`, and the server that `CodeEditor` asks for, skip
  any Monaco language whose code-help language is off. A file of a
  turned-off language is the plain editor: no socket, no status in the
  editor bar.
- On a DISABLED close, `manager.disable(language)` stops only that
  language's clients (python and ruff together), not the whole page.
- Problems tab (`shell/FilesPane.tsx`): shown while the set is not empty.

### Estimate (B1)

Server memory comes from `useSiteLimits()`
(`apps/web/src/admin/health/queries.ts`), which reads `GET /admin/health`
under the Health tab's query key. Use `host.memory.totalBytes`. When `host`
is null or the read failed, show per-student memory and replace the
student counts with "Server memory not known yet". No new field or
endpoint.

Constants, web only, in `apps/web/src/admin/settings/estimate.ts`:

| Constant | Value | Source in docs/CAPACITY.md |
|---|---|---|
| Python (pyright and ruff) | 185 MiB | 167 + 18 |
| TypeScript and JavaScript | 57 MiB | 57 |
| Traditional base per workspace | 160 MiB | 550 - 240 - 150 (stand-in agent) |
| Agentic base per workspace | 310 MiB | 550 - 240 |
| Platform | 1,434 MiB | 16 GiB - 14.6 GiB available before the run |
| Reserve | 2,048 MiB | the 2 GiB target |

`estimate(totalBytes | null, ticked)` is a pure function. It returns the
added MiB and, for each profile, memory per student and
`students = floor((total - platform - reserve) / perStudent)`, floored at
0. Unit-test it at 16 GiB (32 and 23 students), at 8 GiB, with none ticked
and with null memory. B1 adds an "Estimate on the Settings page" table to
`docs/CAPACITY.md` and a web unit test that reads the table and compares it
with the constants (precedent: `audit-coverage.test.ts` reads SPEC.md).
B1 writes the derivations into CAPACITY.md.

The live `output` announces the headline sentence politely, not the whole
table.

### Saving (B1)

Two endpoints exist today. No API change is needed beyond
`codeHelpLanguages`.

| Section | Endpoint | Body |
|---|---|---|
| When workspaces stop | `PUT /admin/settings` | changed of `shutdownGraceSeconds`, `idleStopMinutes`, `keepRunningMaxHours` |
| Resource guard | `PUT /admin/settings` | changed guard fields |
| Student tools | `PUT /admin/settings` | changed of `codeHelpLanguages`, `voiceInputEnabled` |
| Acceptable use | `PUT /admin/settings` | `acceptableUseText`; after "Restore built-in text..." is confirmed, `null` at once |
| Email and alerts | `PUT /admin/settings` `{accountEmailEnabled}` then `PUT /admin/notifications` | each only when its part changed |

- Send changed fields only. A voice-only save never touches the code-help
  lock's state, and one section's save never rewrites another
  administrator's concurrent change.
- Validate in the browser before sending, with the contract schemas, so a
  range error lands under its field. The API's 400 is one message for the
  whole body, so a server failure goes in the footer.
- Email and alerts sends account email first, then notifications. If the
  second call fails, the footer says which part was saved and the failed
  part stays unsaved. The secret rules stay: the SMTP password and ntfy
  token are never echoed back, the mutation uses `gcTime: 0`, the leave
  dialog's text never includes field values, and the "Was ..." line is
  never shown for secret fields.
- Each section uses its own `useUpdatePlatformSettings()` instance.

"Last changed": `usePlatformSettings().data.updatedAt`, formatted with
`longTime` from `apps/web/src/admin/backups/model.ts`; hidden when null.

### Unit primitive (A2)

`TextField` gets `unit?: string`, built on a small exported `UnitInput`
(input plus unit suffix). The page's `SettingRow` uses `UnitInput` with its
label in the left column.

- Give the unit span an id and put it first in `aria-describedby` (extend
  `fieldDescribedBy` in `FieldMessages.tsx`), so a screen reader hears
  "Disconnect grace, minutes".
- `LimitsDialog` sets the input width with `fieldClassName="[&>input]:w-40"`.
  Once the input sits in a wrapper, that stops matching; B1 changes it to
  `[&_input]:w-40`.

### Leave guard (B1)

`useBlocker` from TanStack Router with `shouldBlockFn` returning true when
there are unsaved changes and `current.pathname !== next.pathname` (so the
section index's `#anchor` links do not open the dialog),
`enableBeforeUnload: () => unsaved > 0`, and `withResolver: true`. The
dialog is `ConfirmDialogRoot` and `ConfirmDialog` from
`packages/ui/src/overlays/confirm-dialog.tsx`: title "Leave without
saving?", confirm "Leave without saving", cancel "Stay on Settings". The
description names sections and counts, never values. Each section reports
its own count to a small page-level context in `apps/web/src/admin/settings/`.

## Tasks

Each task owns only its listed files and updates every existing test it
breaks, so its own CI stays green. A task that needs a file it does not own
stops and reports. Paths under `apps/web` are relative to `apps/web/src/`;
under `apps/api` to its `src/`; under `packages/db` and `packages/ui` to
their `src/`.

Task pull requests do not edit `docs/STATUS.md`. Each puts its proposed
STATUS line (what it delivered, gaps left) in its pull request body; D
writes the section once.

| Task | Branch | Agent | Wave | Issues |
|---|---|---|---|---|
| A1 Back end, contract, schema split | `task/53-backend` | builder, high effort | A | refs #1653, #1651 |
| A2 Unit primitive and Keep running | `task/53-unit` | ui-designer | A | refs #1653; fixes #1649 |
| A3 Right-click menu after diff | `task/53-diff-menu` | builder, Opus | A | fixes #1650 |
| B1 The Settings page | `task/53-settings-page` | ui-designer, high effort | B, after A1 and A2 | refs #1653, #1651 |
| B2 Editor follows the set | `task/53-editor-set` | builder | B, after A1 and A3 | refs #1651 |
| C Playwright for the done list | `task/53-e2e` | tester | C, after B1 and B2 | refs #1653, #1651 |
| D Fold | `task/53-fold` | builder, low effort | D | closes none; the epic PR closes (see above) |

### A1 Back end, contract, schema split

May edit:

- `packages/db`: `migrations/0051_code_help_languages.ts` and `.test.ts`
  (new), `migrations/index.ts`, `migrations/0050_course_profile.test.ts`,
  `schema.ts`, and the new file the split creates (its seam: move the
  group of tables that makes `schema.ts` do a second job, for example the
  LTI and course tables at about lines 459 to 616, into their own module
  that `schema.ts` re-exports; keep `Database` in `schema.ts` and keep
  Knip and imports clean).
- `packages/contracts`: `language-servers.ts`, `settings.ts` and tests.
- `apps/api`: `site/switches.ts`, `routes/admin.ts`,
  `routes/language-servers.ts`, `routes/me.ts` and their tests.
- `apps/web`, compile only: `editor/settingsQueries.ts` and test,
  `admin/SettingsTab.tsx`, and the platform-settings fixtures in
  `admin/SettingsTab.test.tsx`, `admin/AdminPage.test.tsx`,
  `admin/logs/LogsTab.test.tsx`, `admin/WorkspaceDetail.test.tsx`,
  `admin/users/testRows.ts`, `profile-test-utils.ts`.
- `e2e`: `helpers.ts` (lock comment, add `CODE_HELP_ALL_LANGUAGES` and a
  reset helper; the restore query becomes
  `code_help_languages = '{python,typescript}'`), `code-help-helpers.ts`,
  `course-profile.spec.ts` (database queries and `studentSees` only),
  `code-help-states.spec.ts` and `problems.spec.ts` (stubs send
  `codeHelpLanguages`).

Done means:

- The migration carries values over, tested both ways.
- The API answers 400 for `java`, for duplicates and for non-arrays.
- The audit row holds `{from, to}` arrays, and none is written on an equal
  set.
- The socket for each server id gets DISABLED when its language is off and
  opens when it is on.
- `/me/settings` drops unknown ids.
- `schema.ts` is under 800 lines and lint no longer warns.
- `make check` and the touched e2e specs are green.

### A2 Unit primitive and Keep running

May edit:

- `packages/ui`: `primitives/TextField.tsx`, `primitives/FieldMessages.tsx`,
  `index.ts`, `primitives/primitives.css` and their tests.
- `apps/web`: `shell/KeepRunning.tsx` and `shell/KeepRunning.test.tsx`,
  `shell/StorageMeters.tsx` and `shell/StorageMeters.test.tsx`.
- `e2e`: `keep-running.spec.ts`, `a11y-storage-meters.spec.ts`.

Done means:

- `TextField` has `unit`, and `UnitInput` is exported; the unit is in the
  accessible description; unit tests cover both.
- Keep running: fields align on their tops (`items-start`), the hint hangs
  below the time input, the time field fits its content, and the submit
  button stays aligned to the inputs. An e2e check in `keep-running.spec.ts`
  asserts the two inputs' top edges match, at the default dialog width, a
  narrow dialog and 200% text, in both themes.
- All storage meter bars are the same length (fix if they differ, and an
  e2e check either way).
- No other app file is touched. `UnitInput` is used first by B1.

### A3 Right-click menu after diff

May edit: `apps/web/src/editor/DiffViewer.tsx`, `editor/monaco.ts`,
`editor/features.ts`, their tests, and `e2e/diff.spec.ts`,
`e2e/editor.spec.ts`, plus one new spec `e2e/editor-context-menu.spec.ts`.
If the fix needs `editor/CodeEditor.tsx` or its test, A3 owns them in
wave A and B2 picks them up in wave B.

Done means:

- A Playwright test does the round trip (open a Python file, switch to the
  diff view and back, right-click, run Format Document) and fails before
  the fix.
- The fix. The diagnosis (cause) is in the pull request body.
- The same round trip is checked for F2, F12 and Ctrl+Space, and for a
  TypeScript file.

### B1 The Settings page

May edit:

- `apps/web/src/admin`: `SettingsTab.tsx`, `SettingsTab.test.tsx`,
  `AdminPage.test.tsx`, `WorkspaceDetail.test.tsx`; the new `settings/`
  directory (SettingRow, SaveFooter, unsaved context and LeaveGuard,
  SectionIndex, the five sections, `codeHelpLanguages.ts`, `estimate.ts`
  and unit tests); everything in `notifications/` (it becomes Email and
  alerts); `guardFields.ts`, `DraftFields.tsx`, `GuardDialog.tsx`,
  `LimitsDialog.tsx`, `GraceDialog.tsx` and their tests.
- `apps/web/src/help/content/admin.tsx` and its test.
- `docs/CAPACITY.md` (the estimate table, and the "turn code help off"
  lines at about 11 and 133).
- `e2e`, kept green or updated: `admin-settings`, `guard-settings`,
  `idle-stop`, `keep-running`, `voice-switch`, `admin-notifications`,
  `a11y-admin-notifications`, `a11y-resource-guard`, `resource-guard`,
  `admin`, `admin-limits`, `admin-detail-panel`, `course-profile`
  (the admin switch test only), `a11y-course` (the code-help card), `help`;
  and checks that `scrollbar-gutter` and `lti-course` still pass.

Done means:

- The page matches the mock-up at 1280 px, 390 px and 200% text, in both
  themes: five sections; sticky index that wraps at narrow widths; one Save
  per section, named for its section; nothing saves on click (except the
  confirmed Restore); "Not saved. Was ..."; Discard changes; skeletons the
  size of the real rows; a failed load notice with "Load again"; a failed
  save that keeps other edits; the leave guard.
- Language checkboxes, with Java, C and C++, HTML/CSS/JSON and SQL as
  "Coming later" rows that are `aria-disabled` with a reason (SPEC 25.8).
- The estimate from Health, with the unknown-memory text, and the worst
  case and memory-only line.
- "Last changed" line.
- New labels in the page and in the three Users-tab dialogs, with the unit
  suffix (`Memory` with MiB, `Disconnect grace` with minutes, and so on);
  existing label lines in tests and e2e updated.
- Unit tests for draft, dirty and discard logic and for the estimate maths;
  the CAPACITY drift test.
- Help topics updated: `admin-settings` (sections, Save per section,
  languages, estimate), `admin-notifications` ("The Notifications section
  of Settings" becomes "Email and alerts"), `admin-workspaces` (the keep
  running label near line 127).
- If this is too big for one agent, split in sequence: B1a (frame, the four
  `/admin/settings` sections and the dialogs), then B1b (Email and alerts).
  They cannot run in parallel; B1b uses B1a's footer and unsaved context.

### B2 Editor follows the set

May edit: `apps/web/src/lsp/{context,manager,client,servers}.ts`,
`lsp/content.ts`, `lsp/CodeHelpStatus.tsx`, `lsp/store.ts` and their
tests; `editor/CodeEditor.tsx` and test; `editor/settingsQueries.ts` and
test; `shell/FilesPane.tsx` and test; `WorkspacePage.tsx`;
`help/content/student.tsx` and its test (the line saying an administrator
chooses which languages have code help); `e2e/code-help-states.spec.ts`,
`e2e/problems.spec.ts`.

Done means:

- A file of a turned-off language gets no socket and no status; other
  languages keep working; DISABLED stops one language only; the Problems
  tab is shown while the set is not empty.
- Hover text no longer shows a backslash before `![` in code samples (unit
  test on `content.ts`; keep images stripped).
- With two editors side by side, a code-help crash is announced once
  (unit test and an e2e check in `code-help-states.spec.ts`).

### C Playwright for the done list

May create only: `e2e/settings-sections.spec.ts`,
`e2e/settings-leave-guard.spec.ts`, `e2e/code-help-languages.spec.ts`,
`e2e/settings-estimate.spec.ts`, `e2e/a11y-admin-settings.spec.ts`.

Done means every bullet of the issue's "Done means" has a test: saving each
section; discard; the leave guard; nothing saving on click; a failed load
and a failed save; the checkboxes turning code help off and on for one
language; the disabled "Coming later" rows; the estimate reading the
server's memory; axe in both themes. C reports any failure in B1 or B2
rather than editing their files.

### D Fold

May edit: `docs/SPEC.md`, `docs/adr/0067-*.md` (new), `docs/adr/README.md`,
`docs/STATUS.md`, `docs/OVERVIEW.md`, `e2e/shard-timings.json`; deletes
`docs/EPIC-53.md`.

Done means: the SPEC edits below are made; ADR 0067 records the enabled-set
choice (new languages opt in), refusal at the API only, strict write with
lenient read, and the worst-case estimate (ADR 0065 stays as written); the
STATUS.md section is written from the task PR bodies and lists the gaps,
including A11; the plan is deleted. The epic pull request body closes
#1653, #1651, #1649 and #1650.

## SPEC.md sections the fold task updates

| Section | Edit |
|---|---|
| 6.4 | New labels (Disconnect grace, Idle stop, Longest keep running) in "When workspaces stop", saved with "Save stop times" |
| 13.6 | The "site switch" paragraph becomes "Languages with code help": `settings.code_help_languages` (migration 0051), the per-language refusal, the browser following the set, DISABLED stopping one language; the close-code table now reads "Code help is off for this server's language"; the "adding a language later" sentence adds a language id and its server mapping |
| 19.4 | Measuring period at the top of Resource guard, for CPU and memory; new labels (Heavy CPU use, Speed while slowed, Quiet time, Quiet means under, Slowdowns before a hold, Hold period, High memory); the four group names unchanged |
| 20.1 | Settings tab: five sections, one Save per section, nothing on click, leave guard, "Last changed", estimate; rewrite the Epic 52 code-help switch line |
| 24.1 | The refusal is per language at the API; a resource control, not a boundary |
| 24.11 | "As built (Epic 53)": `settings.code_help_updated` with `{from, to}` as language-id arrays; older rows hold booleans |
| 25.2 | "Turn code help off for the site" becomes "untick languages"; the estimate is on Settings |
| 25.8 | The unit is in the field's description; "Coming later" rows are `aria-disabled` with a reason; the leave dialog; the estimate `output` |
| 26 | Migration 0051 entry; the 0050 entry notes the column was replaced |
| 29 | Epic 53 entry |

## Waves

- Wave A (A1, A2, A3) runs in parallel from the epic head once this plan
  lands. File sets do not overlap.
- Wave B starts per task: B1 after A1 and A2 land; B2 after A1 and A3
  land. B1 and B2 run in parallel; their file sets do not overlap.
- Wave C (C) starts after B1 and B2.
- Wave D: reviews and their fixes, then D.

### Shared files and owners

| File | Wave A | Wave B |
|---|---|---|
| Migration 0051, `schema.ts`, contracts | A1 | none |
| `editor/settingsQueries.ts` and test | A1 | B2 |
| `admin/SettingsTab.tsx`, `SettingsTab.test.tsx`, `AdminPage.test.tsx`, `WorkspaceDetail.test.tsx` | A1 (fixtures only) | B1 |
| `e2e/code-help-states.spec.ts`, `e2e/problems.spec.ts` | A1 | B2 |
| `e2e/course-profile.spec.ts` | A1 (queries) | B1 (admin switch test) |
| `e2e/keep-running.spec.ts` | A2 | B1 (label lines only) |
| `editor/CodeEditor.tsx` and test | A3, only if the fix needs it | B2 |
| `help/content/admin.tsx` | none | B1 |
| `help/content/student.tsx` | none | B2 |
| `docs/CAPACITY.md` | none | B1 |
| `docs/SPEC.md`, ADRs, `docs/STATUS.md`, `docs/OVERVIEW.md` | none | D (wave D) |

### Locks in e2e

- `CODE_HELP_SWITCH_LOCK` keeps its name. Only its comment and the restore
  query change (A1).
- Any spec that changes the language set takes `SETTINGS_ROW_LOCK` and
  `CODE_HELP_SWITCH_LOCK` alone, as `course-profile.spec.ts` does. In C that
  is `code-help-languages.spec.ts`; in B1 it is the rewritten admin switch
  test in `course-profile.spec.ts`.
- Specs that save other sections take `SETTINGS_ROW_LOCK` only, because
  saves send changed fields only.

## Review plan

After every wave C task has landed:

- code-reviewer over the epic head, and over the whole repository's dead
  code.
- a11y-reviewer (the epic touches `apps/web` and `packages/ui`): the unit
  description, the "Coming later" rows, the leave dialog, the estimate
  `output` (headline only is announced), skeletons and the failed-load
  notice, against SPEC 25.8.
- security-reviewer: the epic touches the language-server upgrade route and
  the Email and alerts secret handling. Focus: `CODE_HELP_LANGUAGE_OF_SERVER`
  total over server ids; the fail-closed database read; the slot released on
  refusal; the strict, admin-only PUT; audit rows holding ids only; secrets
  never echoed and never in the leave dialog.

Findings are fixed or deferred through further task PRs, landed by merger,
then confirmed by each reviewer.

## Contradictions in the design, and how each was resolved

1. The issue says the API and the agent refuse a turned-off language "as
   the site switch does today". Today only the API refuses; the agent never
   learns the switch (SPEC 13.6). Resolved by ruling 1: API only.
2. The PNGs and `gen.mjs` show a per-section "Saved 14 Oct 2026 at 15:02".
   The issue rules out a per-section stored time. Follow the issue:
   "Saved" after a save, the site-wide "Last changed" line, and the existing
   notification-job text.
3. The PNGs show future languages as enabled checkboxes ("Not measured
   yet"), and `estimate.js` has an "unmeasured" warning. The issue and the
   rulings make them disabled and "Coming later". The unmeasured-warning
   path is not built.
4. "Last changed" is not exactly "the settings on this page": it moves on a
   log-level change and not on mail or alert changes. Resolved by ruling 3.
5. CAPACITY.md gives about 340 MiB per workspace without code help (24 GiB
   run); the estimate uses 310 for Agentic, derived from the 16 GiB run. The
   1.4 GiB platform figure was taken against a nominal 16 GiB, but Health
   reports MemTotal, a little smaller, so the count is conservative by about
   one student. B1 writes the derivations into CAPACITY.md.
6. The `GUARD_FIELDS` labels are shared with the per-workspace Guard dialog,
   which the issue does not mention. Resolved by ruling 2: the dialogs adopt
   the new labels.
7. The mock's estimate puts the whole table in a live `output`. Only the
   headline sentence is announced politely.
8. The mock-up is gitignored, so worktree agents cannot see it. They read
   the absolute path above.
9. The design put "Restore built-in text..." inside the section's Save.
   Resolved by ruling 4: it saves at once after its confirm.

## Left out on purpose

- A11, the focus loss on a profile change. It stays a STATUS.md gap.
- Agent-side refusal of a turned-off language.
- Any new Health field or endpoint.
- Per-course language choice (#1651 says later).
- Java, C and C++, HTML, CSS and JSON, and SQL language ids and servers
  (#1652). They appear only as disabled rows.
- Field-level errors from the API.
- A per-section stored time.
- Cutting open sockets at once when a language is unticked.
- Changing any file outside the lists above.
