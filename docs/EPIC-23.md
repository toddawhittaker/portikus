# Epic 23: Student interface leftovers

This is the working plan for Epic 23. It closes issues #706, #707 and #708, the three gaps Epic 20's reviews left in BACKLOG.md. The admin and student "batch 2" issues (#601, #604, #609) were already delivered by Epics 18 and 20 and are closed. Where this plan is silent, `docs/SPEC.md` wins on behaviour, `docs/DESIGN.md` and `design/` win on look, and the issue bodies give the detail.

- **Base commit:** `f437be5` (main). **Epic branch:** `epic/23-ux-leftovers`. Builders reset to `origin/epic/23-ux-leftovers` and branch `task/23-<name>` from it.
- **No migrations and no infrastructure changes.**

## Rulings

1. **Usage in the error state (#706).** The API serves the workspace usage query while the workspace is in error whenever the workspace agent still answers. When the agent does not answer, the query fails as it does today, and the error screen shows only "Try again" and "Workspace details" (Epic 20 ruling, SPEC.md section 28). "Clean up Docker…" still shows only for `STORAGE_FULL` with the Docker class at the critical level. Reset Docker's inline error box moves below the actions row.
2. **Restart confirmation before the workspace moves (#707).** Reproduce it with a failing unit test first. If the action can be sent, send it. If the state machine cannot accept a restart yet, keep Confirm disabled and say why in the dialog. Do not silently close the dialog.
3. **Reset preview data (#708).** The item gains an ellipsis and opens `ConfirmDialog` with `destructive={false}`. Existing `data-testid`s stay.
4. **Left out on purpose:** the radio-item menu component and the Epic 18 gaps (sortable columns, tabs in the header, per-row menus, tablet layout) stay in BACKLOG.md.

## Tasks

| Task | Issues | Files | Order |
|---|---|---|---|
| T1 usage in error, restart confirm | #706, #707 | `apps/api` usage route, `apps/web/src/shell`, `apps/web/src/recovery`, `e2e` | one builder, two PRs in turn |
| T2 reset preview confirm | #708 | `apps/web/src/preview`, `e2e` | parallel |
| T3 fold | all | `docs/` | last |

Each task pull request says `Fixes #N`, and the epic pull request lists them all again.

## Reviews

code-reviewer and a11y-reviewer over the epic head; security-reviewer on T1's API change. Fixes land as further task pull requests, then each reviewer confirms.

## Fold (T3)

Update SPEC.md section 28 (usage in the error state) and the Preview section, add an Epic 23 section to STATUS.md, remove the three BACKLOG entries, and delete this plan.
