# Epic 20: Student interface polish

This is the working plan for Epic 20. It closes issues #608 (batch 1) and #609 (batch 2), which come from the student interface review of 2026-09-26. Where this plan is silent, `docs/SPEC.md` wins on behaviour, `docs/DESIGN.md` and `design/` win on look, and the issue bodies give the detail of each item (file and line references, screenshot names).

- **Base commit:** `3da8d6b` (main). **Epic branch:** `epic/20-student-ux`. Builders reset to `origin/epic/20-student-ux` and branch `task/20-<name>` from it.
- **No migrations, no contract changes, no infrastructure.** Everything is in `apps/web`, `packages/ui` and `e2e/`.

## Goal

Make every control a student has to use look like a control, and give each place a student can get stuck (an empty work area, an error screen, a slowed-down workspace) a button that moves them forward. Then tidy the layouts the review found confusing: the "Your workspace" dialog, the Preview toolbar, the right-pane headings, Running rows, Settings and a few shared details.

## Rulings

Rulings are the planner's unless marked otherwise. Each says what a builder would otherwise have to guess.

### Shared components and Epic 18

1. **`packages/ui` changes are additive only**, because Epic 18 (admin polish) edits the admin pages on another branch at the same time. This epic makes exactly three changes there, all in T2:
    - `ConfirmDialog` gains one prop, `destructive` (default `true`). With `false` it uses the primary button, the `info` icon and neutral colours for the "lost" box. Every existing caller is unchanged.
    - A new `.pk-segmented` class in `primitives.css`, which is the editor's `.pk-md-modes` segmented control moved from `apps/web/src/work/work.css` under a general name. The New project dialog needs it outside the work area, where `work.css` is not always loaded.
    - `.pk-dialog:focus { outline: none; }` in `overlays.css`. This changes every dialog, admin ones included, but only removes the browser's ring around the whole dialog box; controls keep their `:focus-visible` rings. It is the one non-additive line, and it is harmless to Epic 18.
2. **Settings' taller dialog is done in `settings.css`**, scoped to the Settings dialog, not by changing `.pk-dialog--fit` in `packages/ui`. Reason: it keeps the shared modifier unchanged and keeps T5 out of T2's files.
3. **No new dependencies, tokens or icons.** Use existing components (`EmptyState`, `StateBadge`, `Button`, `IconButton`, `Menu`, `MenuCheckboxItem`, `Select`) and the mockup CSS the issues name.

### Opening the workspace dialog from elsewhere (#608 items 4 and 7)

4. **`WorkspacePage` owns whether the workspace dialog is open**, as plain state passed by props: `closed`, `open`, or `restart` (open with the restart confirmation already on top). `StatusBar` takes it as a controlled prop; `WorkspaceStarting` and `ThrottleNotice` get an `onOpenWorkspace` callback. Reason: props are the boring option; a context would be a new moving part for three callers.
5. **The throttle notice's "Restart workspace…" opens the workspace dialog with its restart confirmation on top.** Cancel leaves the student in the workspace dialog, which is where Restart normally lives. Reason: it reuses the existing confirmation without lifting it into a second copy. The notice keeps its dismiss ×. "See what's using CPU" is left to #607.
6. **The error screen's buttons:** primary "Try again" sends the same `start` action as `StartAgain`; secondary "Workspace details" opens the workspace dialog. `errorMessage` and `errorCode` move into `<details>` with the summary "Technical details", styled with `.pk-techdetail`. The alert header (`.pk-dialog-status` with `status-error-soft`) arrives in T6 with the meters.

### Status bar (#608 items 2 and 3)

7. **Both status-bar buttons (the state and the storage warning) get the bordered look** the issue gives: height 20 px, `0 var(--space-2)` padding, `1px solid var(--line-strong)`, `var(--radius-sm)`, and a trailing `chevron-up` icon marked `aria-hidden`. The warning colour bug is fixed by dropping `color: inherit` from `button.pk-statusbar-item` and giving the plain state button `color: var(--ink-muted)` through a class, so no rule has to out-rank the tone classes. The e2e test asserts the computed colour equals `--status-warning` and `--status-error`.
8. **The status bar's new memory figure is not this epic's.** #607 adds it; this epic only changes the look of the existing items.

### Work area and projects (#608 items 1, 5, 9; #609 items 3, 6)

9. **The empty work area keeps its title "No terminals open"** (existing e2e depends on it). Body: "Or use + in the tab bar for Codex and previews." Actions: primary `Button iconStart="terminal"` "Open a terminal" calling `openTerminalTab()`, secondary `Button iconStart="agent"` "Start Claude Code" calling `openAgent("claude")`, the launcher's own two calls. The tab-strip "+" IconButton label becomes "New tab".
10. **New project's "What to create"** is a `fieldset.pk-segmented` with the legend "What to create" (visually hidden if the dialog already shows the label) and three `aria-pressed` buttons, as in the editor's mode switch (`work/FileLeaf.tsx`), which switches to `.pk-segmented` in the same task.
11. **Archive is neutral:** the menu item drops `danger`; `ArchiveConfirm` passes `destructive={false}`. Red stays for Delete, Stop, Reset Docker and Restore.
12. **Success toasts:** Archive shows `tone: "success"`, title "<name> archived", body "Find it under Archived projects." Duplicate shows `tone: "success"`, title "<new name> created". Rename stays silent.
13. **The "Saved" state** becomes plain `ink-muted` text with a `check` icon and no pill. The text stays "Saved" (e2e helpers wait for it). Conflict and Failed keep their soft fill.

### Preview (#608 item 6; #609 item 2)

14. **Preview picker rows:** in `preview.css`, `.pk-portlist .pk-portrow` gets the border, radius, `surface-hover` hover and a trailing `chevron-right` icon (`aria-hidden`). Description: "Pick a running port below, or type one." The Port field aligns with the dialog's left edge. The rules are scoped to `.pk-portlist` so the Running pane's rows, which share `.pk-portrow`, are untouched.
15. **Preview toolbar:** the bar holds the host, Back and Forward (`Button size="sm"`, variant `quiet`), Reload and Open in new tab. A `more` IconButton labelled "More preview actions" opens a `Menu` with Copy URL, a "Width" `MenuLabel` followed by one `MenuCheckboxItem` per width (checked on the current one), "Reset preview data" and "Show in Running". Reason: `MenuCheckboxItem` exists; a radio-item component would be a new `packages/ui` export for one menu.
16. **"Reset preview data" has no ellipsis**, because it opens no confirmation today and this epic adds none. (The review suggested an ellipsis; the ellipsis convention means "opens a dialog".)
17. **Existing `data-testid`s on moved controls stay** (`preview-copy`, `preview-width`, `preview-reset`, `preview-running-link`) on the menu items, so existing specs change only in how they reach them.

### Right pane (#608 item 8; #609 items 4 and 5)

18. **Pane titles inside the tabbed right pane:** the visible `pk-pane-title` row goes for Files, Checks, Running and Monitor. Each pane keeps its `h2`, now `sr-only`, so heading navigation still works (SPEC.md section 25.8). Where the head held action buttons, a slimmer row keeps them right-aligned; where it held none, the row goes. "Find in files" keeps its visible title, because it is not a repeat of the tab name.
19. **Gutters:** Monitor and Running bodies use the same `var(--space-4)` side gutter as the other panes. Monitor's rows are otherwise unchanged; #607 adds Stop buttons to them later.
20. **Running rows:** the first action is a visible `Button size="sm"` "Preview" whose accessible name is "Preview port <n>" (it contains the visible word, as WCAG 2.5.3 asks). New tab and Stop stay IconButtons. The Docker and reserved-port tags move under the name as a `pk-text-caption` second line. All `data-testid`s stay (`running-open-<port>` and so on), so the preview specs need no change.
21. **Terminal-coloured panel heads** (Checks "Output", Running "Details") use `var(--terminal-muted)`. `.pk-running-panel` moves to `surface-raised` with `ink`, because it is a key-and-value list, not terminal output. Checks output stays on terminal colours.

### Smaller items (#609 item 6)

22. **Skeletons only while starting.** `PaneSkeleton` and the tab-strip skeleton show only in the connecting, starting and restoring phases. In the stopped and error phases the side panes show a static `EmptyState`: "Start your workspace to see your projects" on the left, "Start your workspace to see its files" on the right.
23. **Type floor and fonts:** each file's owner raises text under 12 px to 12 px (`pk-text-caption` or `font-size: 12px`) and replaces `ui-monospace` stacks with `var(--font-mono)`: `app.css` in T1, `preview.css` in T3, `monitor.css`, `running.css` and `files.css` in T4.
24. **Settings:** group titles get `border-t border-line pt-4` and `font-semibold` (the first group has no border); read-only values get `overflow-wrap: anywhere`; the dialog body may grow to `min(800px, 100vh - 64px)`; Appearance moves first under Preferences, because it is what students most often look for.

### Workspace dialog and error screen (#609 item 1)

25. **The dialog moves out of `StatusBar.tsx`** into `shell/WorkspaceDialog.tsx`, and the storage meters into `shell/StorageMeters.tsx`, used by both the dialog and the error screen. Reason: `StatusBar.tsx` is already 459 lines and the meters now have two users.
26. **Dialog order:** a `StateBadge` with Restart and Stop (or Start) in one `pk-actions` row; then "Storage" as a `pk-text-heading` h3 with one `.pk-meter` per class (the text "X of Y" stays in each meter's head, so screen readers and colour-blind students read the figure, and the fill has no role of its own); then "Docker" as an h3, the line "Throws away images, containers and volumes; keeps your projects", and "Reset Docker…"; then the rebuild note; then `<details>` "Technical details" with Desired state, Connections and Image.
27. **Meter levels:** `--warning` at the existing warning threshold, `--full` at the critical one, from `storageLevel` in `recovery/storage.js`. No new thresholds.
28. **The error screen's storage part:** when the usage query returns figures in the error state, the meters show under the explanation. "Clean up Docker…" (the same Reset Docker confirmation) shows only when `errorCode` is `STORAGE_FULL` and the Docker class is at the critical level. With no figures, the screen shows only "Try again" and "Workspace details". Reason: offering a Docker reset when projects storage is the problem would destroy data for nothing.

## Tasks

Tasks that run at the same time own non-overlapping files. Each task PR carries `Fixes #608` or `Fixes #609` (or both) for the items it delivers, before-and-after screenshots at 1280 px in both themes, and updates the SPEC.md sections for its own behaviour. Nobody but T7 edits `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/DESIGN.md` or SPEC.md section 29. Unit tests live beside the files they test and belong to the same owner.

| Task | What it does | Issues | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|---|---|
| **T1 Shell: status bar, error screen, throttle notice, skeletons** | Rulings 4 to 8, 22; `app.css` part of 23 | #608 items 2, 3, 4, 7; #609 item 6 (skeletons, `app.css` type) | builder | `apps/web/src/shell/StatusBar.tsx`, `shell/ThrottleNotice.tsx`, `WorkspaceStarting.tsx`, `WorkspacePage.tsx` and their tests; `apps/web/src/app.css`; `e2e/storage-warnings.spec.ts`, `workspace-chrome.spec.ts`, `workspace-starting.spec.ts`, `resource-guard.spec.ts`, `a11y-resource-guard.spec.ts`, `idle-stop.spec.ts`; SPEC.md 6.3 and 19.2 | none | 1 day |
| **T2 Work area, projects and shared overlays** | Rulings 1, 9 to 13 | #608 items 1, 5, 9; #609 items 3, 6 (Saved, toasts) | builder | `apps/web/src/work/WorkArea.tsx`, `work/FileLeaf.tsx`, `work/work.css`; `apps/web/src/projects/**`; `packages/ui/src/overlays/confirm-dialog.tsx` and test, `overlays/overlays.css`, `primitives/primitives.css`; `e2e/projects.spec.ts`, `agent-launchers.spec.ts`, `terminal.spec.ts`, `editor.spec.ts`, `markdown.spec.ts`, `a11y-overlays.spec.ts`, `a11y-work-area.spec.ts`; SPEC.md 8.3 and 8.5 | none | 1 day |
| **T3 Preview picker and toolbar** | Rulings 14 to 17; `preview.css` part of 23 | #608 item 6; #609 item 2 | builder | `apps/web/src/preview/**` (including `preview.css`); `e2e/preview.spec.ts`, `preview-browser.spec.ts`; SPEC.md 14.6 | none | 0.75 day |
| **T4 Right pane: headings, Running rows, panel colours** | Rulings 18 to 21; `monitor.css`, `running.css`, `files.css` part of 23 | #608 item 8; #609 items 4, 5, 6 (type) | builder | `apps/web/src/files/FileTree.tsx`, `files/files.css`; `apps/web/src/checks/ChecksPane.tsx`, `checks/checks.css`; `apps/web/src/shell/FilesPane.tsx`; `apps/web/src/monitor/MonitorPane.tsx`, `monitor/monitor.css`; `apps/web/src/running/**`; and their tests; `e2e/running-details.spec.ts`, `a11y-right-pane.spec.ts`, `files.spec.ts`, `checks.spec.ts`, `checks-colors.spec.ts`; SPEC.md 18.2 | none | 1 day |
| **T5 Settings hierarchy and overflow** | Rulings 2, 24 | #609 item 6 (Settings) | builder | `apps/web/src/settings/**`; `e2e/a11y-settings.spec.ts`, `appearance.spec.ts`, `profile.spec.ts`, `timezone.spec.ts` | none | 0.5 day |
| **T6 Workspace dialog and error-screen meters** | Rulings 25 to 28 | #609 item 1 | builder | `apps/web/src/shell/StatusBar.tsx`, `shell/WorkspaceDialog.tsx` (new), `shell/StorageMeters.tsx` (new), `WorkspaceStarting.tsx`, and their tests; `apps/web/src/app.css` (the `.pk-meter` rules ported from `design/mockups/portikus-screens.css`); `e2e/workspace-controls.spec.ts`, `reset-docker.spec.ts`, `storage-warnings.spec.ts`, `workspace-starting.spec.ts`; SPEC.md 18.3 and 28 | T1 (same files) | 1.5 days |
| **T7 Fold the plan and close the epic** | Folds rulings 1, 7, 9, 15, 18, 22 and 26 into SPEC.md in a sentence or two each; adds Epic 20 to SPEC.md section 29 and `docs/STATUS.md`; adds the "Left out" items to `docs/BACKLOG.md`; records the issue's "where the build departs from the mockups" list in `docs/DESIGN.md` section 9 so no one "fixes" them later; deletes `docs/EPIC-20.md` | #608, #609 | builder | `docs/SPEC.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/DESIGN.md`, `docs/EPIC-20.md` | T1 to T6, and the review fixes | 0.25 day |

T1 to T5 run in parallel. T6 starts from the epic head once T1 has landed. A spec file used by two tasks is edited by only one of them at a time: `storage-warnings.spec.ts` and `workspace-starting.spec.ts` pass from T1 to T6 in order. If a task finds it must change a file another running task owns, it stops and asks the orchestrator.

No ADR is planned: nothing here is a "why" a later reader needs beyond a SPEC sentence. If T6 finds the error-screen rule in ruling 28 needs defending, T7 records it in SPEC.md section 28.

## Verification

- **Each task:** `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage` above the floors, `pnpm build`, and the Playwright specs it owns (plus any it changed) against a fresh test database. Unit tests where logic changes, designed from the rulings above:
    - T1: status bar tone classes; `WorkspacePage` opens the dialog in the `restart` mode from the notice; the error screen's two actions; skeleton versus empty state by phase.
    - T2: `ConfirmDialog` with `destructive` true and false (button variant, icon, colours); empty-state actions call the right openers; the pressed state in New project; the two success toasts.
    - T3: the menu's items and the checked width; host, Back, Forward, Reload and new tab stay in the bar.
    - T4: sr-only headings remain; the Running row's Preview button name.
    - T6: meter level classes from `storageLevel`; the Clean up Docker condition (ruling 28).
- **Playwright (every visible change):**
    - T1: the status-bar item has a visible border, and its warning text's computed colour equals `--status-warning` (and `--status-error` at critical); on the error screen, "Try again" starts the workspace and "Workspace details" opens the dialog, with technical details collapsed; the throttle notice's "Restart workspace…" opens the restart confirmation; stopped and error screens show no `aria-busy` skeleton.
    - T2: the empty state's buttons open a terminal and Claude Code; New project shows exactly one pressed option and switches fields; Archive's confirmation has a primary (not danger) button and a success toast; Duplicate's toast; a dialog opened from a menu has no outline on the dialog box.
    - T3: clicking a picker row opens that port; the more menu holds Copy URL, Width, Reset preview data and Show in Running; the bar does not wrap at 1280 px.
    - T4: no visible repeated title under each right-pane tab while the heading remains for assistive technology; Running's Preview button opens the preview; the process name is not truncated at 1280 px with tags present; panel head contrast of at least 4.5:1 in the light theme.
    - T5: group titles are visually distinct; a long email wraps inside the dialog.
    - T6: actions at the top of the dialog, technical details collapsed, one meter per class with its text figure; the error screen with a `STORAGE_FULL` error and critical Docker storage offers Clean up Docker.
- **Before the epic PR:** `make check` and the full `pnpm test:e2e` green on the epic head with a fresh test database.
- **Reviews:** code-reviewer and a11y-reviewer over the epic head after T6 (a11y-reviewer confirms item 8's contrast and item 9's focus change in one line each). No security-reviewer: the epic touches no trust boundary in SPEC.md section 24.
- **No rehearsal VM:** nothing under `infra/` changes.

## Left out

- **#607's parts:** "See what's using CPU" on the throttle notice, the memory notice, the status bar's memory warning and Stop in Monitor. They belong to the epic that branches from this one.
- **A confirmation before "Reset preview data".** Not asked for; the item only moves into a menu (ruling 16). Goes to BACKLOG if Todd wants one.
- **A radio-item menu component** for the preview width. Checkbox items do the job without a new `packages/ui` export (ruling 15).
- **The mockup features the build dropped on purpose** (project change count, file-tree footer checkbox, status-bar save state, listening port and storage line, launcher File… item, header search and role tag, the leave-terminal hint). Recorded in DESIGN.md by T7, not built.
- **A full accessibility audit.** a11y-reviewer checks this epic's changes only.
