# Epic 49 — Fix and polish batch

Branch `epic/49-fix-batch`, from main 135b76fe. A fix batch, so no
architect pass (WORKFLOW.md, "Epic plans"). No migration, no ADR. Runs
beside Epic 48 (live help) and Epic 50 (identity).

## Tasks

| Task | Issues | Agent | Files | Notes |
|---|---|---|---|---|
| T1 flakes | #1533, #1519 | tester | `apps/workspace-agent/src/tmux.test.ts`, `e2e/editor.spec.ts` (and the code under test only if the race is real) | Wait on the real condition; run each test many times to show it is stable. |
| T2 fontconfig | #1522 | infra | `infra/workspace-image/` | Owns the rehearsal VM while it builds. Image VERSION bump is the fold's. |
| T3 open selection | #1524 | builder | `apps/web/src/files/TreeRows.tsx` and its tests, `e2e/` new spec | Reuse the `dropTreeFiles` path. |
| T4 bogus cookies | #1298 | builder | `apps/api` session lookup and rate limit | Real sessions are never refused; SPEC 24 review. |
| T5 recovery insert | #1241 | builder | `apps/api` and `apps/worker` recovery-point paths, one shared helper | Keep every existing test's assertions. |
| T6 narrow layout | #1276 | ui-designer | `apps/web` workspace and admin layout CSS and shells, `packages/ui` | 560 px Playwright screenshots and axe; SPEC 20.1 and DESIGN.md updated by the fold. |
| T7 file splits | #1289 | builder | the files named in #1289 | Starts after T3, T5 and T6 land, so it splits their final versions. |
| T8 fold | #1284 and all | builder (Sonnet) | `docs/` | Moves the `student@<label>` rule, writes STATUS and SPEC, bumps the image VERSION if T2 changed the image, deletes this plan. |

## Rulings

- R1: T7 splits along the seam where a file starts a second job and changes no behaviour; files that Epics 48 or 50 are editing at the time may be left for a later pass, named in the PR body.
- R2: T6 sets the narrow layout for the existing pages only; no new navigation pattern beyond what DESIGN.md already allows.

## Rehearsal

One rehearsal VM run after all tasks land: smoke test with the new image (fontconfig message gone), the narrow layout checked by hand at 560 px, and the bogus-cookie limit checked against the real API.
