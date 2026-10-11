# Epic 47: workspace polish

Branch `epic/47-workspace-polish`, cut from main 7d1be2ac. A batch of
clearly specified issues, so there was no architect design (WORKFLOW.md,
"Epic plans"). The last task folds this plan into SPEC.md, STATUS.md and
ADR 0064 (if one is needed) and deletes it.

## Issues

- #1383 Drag several selected files from the tree at once.
- #1281 Keep the workspace running until a clock time.
- #1243 Recovery points dialog: delete a kept `.portikus-aside-<pointId>` folder.
- #1258 Tell a student about an automatic throttle lift they missed.
- #1257 Stop a process tree, and lower a program's priority, from Monitor.
- #1350 An administrator switch to turn voice input off.
- #1462 Epic 42 follow-ups, items a, b, d, e and f. Item c moved to Epic 46.

## Rulings

- R1 (#1383): when the drag starts on a selected row, it carries the whole
  selection in tree order. A drop on a folder moves every item with the
  single-move rules and conflict prompts. A drop on a pane edge opens the
  selected files as tabs in one new split; folders are skipped. The drag
  image says "N items". A drag that starts on an unselected row carries
  only that row, as today.
- R2 (#1281): beside the hours choice, a native time input in the
  student's timezone. A time earlier than now means tomorrow. It is
  limited by the same cap as the hours, and the API checks the cap the
  same way. Store the result in the existing `keep_running_until`.
- R3 (#1243): the agent lists and deletes only folders named
  `.portikus-aside-<pointId>` directly inside the project, never anything
  else, through a checked route. The Recovery points dialog lists them
  with a Delete button and a confirmation that says what the folder holds.
  The restore copy that says "do not delete it" changes to point at the
  dialog.
- R4 (#1258): on an idle lift, the worker writes one notification row
  through `recordNotification`, whether or not a page is open. It follows
  the student's notification settings (ADR 0052) if a category fits.
  SPEC section 19.4's "the worker writes no notification" changes.
- R5 (#1257): Monitor gains "Stop with children" (the process tree,
  Epic 16's `process-tree.ts`, PID and start-ticks checks for every
  process) and "Lower priority" (nice +10 for the process tree, only ever
  lowering). Same ownership rules as today's stop.
- R6 (#1350): a site setting, on by default, in migration 0048. When off,
  no microphone control is shown anywhere, and the Settings dialog's voice
  section says the administrator turned it off. The admin Settings tab
  holds the switch.
- R7 (#1462 f): confirming Codex delta metrics needs a real Codex
  sign-in. The rehearsal tries it only if a Codex login is already on the
  rehearsal VM; otherwise the item stays open in a new issue.
- R8: ADR 0064 and migration 0048 are reserved for this epic.

## Tasks

| Task | Issues | Agent | Owns |
|---|---|---|---|
| T1 multi-drag | #1383 | builder | apps/web/src/files/useTreeDragAndDrop.ts, treeDrag.ts, selection.ts; apps/web/src/work/TreeFileDrop.tsx, moveInto.ts; e2e for tree drag |
| T2 keep-until | #1281 | builder | apps/web/src/shell/KeepRunning.tsx; the keep-running parts of packages/contracts/src/workspace.ts and apps/api/src/routes/workspaces.ts; keep-running e2e |
| T3 aside | #1243 | builder | apps/workspace-agent/src/recovery.ts and its route; apps/api/src/routes/recovery.ts; apps/web/src/recovery/*; recovery contract; recovery e2e |
| T4 voice-switch | #1350 | builder | migration 0048; packages/contracts/src/settings.ts; admin settings route and SettingsTab; apps/web/src/voice/*; apps/web/src/settings/SettingsDialog.tsx (voice section); e2e/voice-input.spec.ts |
| T5 server-items | #1258, #1462 a b d e | builder | apps/worker/src/guard.ts; apps/api/src/routes/course-shares.ts, courses/*; apps/api/src/lti/starter.ts, deep-link.ts and the starter toast |
| T6 monitor-tree | #1257 | builder | apps/workspace-agent/src/process-tree.ts, processes-route.ts; apps/api/src/routes/processes.ts, workspaces/process-stop.ts; packages/contracts/src/processes.ts; apps/web/src/monitor/*; Monitor e2e |
| T7 fold | all | builder | SPEC.md, STATUS.md, ADR 0064 if needed; deletes this plan |

Shared files, additions only: packages/contracts/src/index.ts and
apps/web/src/help/content/student.tsx (each task edits only its own
paragraph).

After the build tasks: code, security (the agent's delete and process
routes are trust boundaries) and accessibility reviews, fixes,
confirmations, a rehearsal-VM run, the fold, then the epic pull request.
