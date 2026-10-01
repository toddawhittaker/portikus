# Epic 28: fix batch

This plan lives only on `epic/28-fix-batch`. The fold task (F) moves its
lasting rules into SPEC.md and deletes this file (WORKFLOW.md, "Epic
plans"). Code, tests and other docs cite SPEC.md sections, never this file.

Base: `main` at 62748b19. Done means a green epic pull request to `main`
with a "Fixes" line for every issue below.

## Scope and tasks

| Task | Issue | What | Agent |
|---|---|---|---|
| C | #959 | `timeout-minutes` on every CI job, about 5 minutes on each apt and Playwright install step, one cheap retry on those steps if boring | builder |
| A | #928 | Admin audit e2e waits for the person to resolve before Apply | builder |
| D | #931, #934 | Docker tab: image sizes, a `Meter` in `packages/ui` for the cache and the seed, 120-day usage window and retention, plus two backlog items: the tab says when setup turned the cache off, and the usage window's 31-day edge | ui-designer |
| S | #932 | Seed matched to the active image's Node and Python: mapping, default seed, drift notice with one button. Starts after D lands (same tab and route) | builder |
| I | #933 | Platform-owned agent instruction files, rewritten at every workspace start; Codex test on the pilot; the seed paragraph from #932 | builder |
| M | #936 | Delete an image, keep default + previous + one newest, sizes and disk free on the Admin image page, plus the backlog item to share the image job's lock and jobs-directory setup | builder |
| K | #955 | Keep running until…: a student hold over the disconnect grace and idle stop | builder (high effort) |
| L | #957 | TLS probe only when a preview of the port is first requested | builder |
| G | backlog | Workspace create refuses when the pool's fill plus the seed's size would reach the full line (the backlog named guard.ts, but the only admission check is the controller's pool-fill refusal) | builder |
| P | backlog | The install question uses setup's free-space rule for the Docker cache size | builder |
| F | all | Fold: SPEC.md, STATUS.md, BACKLOG.md, ADMIN-GUIDE.md, STUDENT-GUIDE.md, in-app help, delete this plan | builder |

Left for their own epics: #753, #918, #935, #627, #767, #799, #958.

## Todd's answers (2026-10-01)

- #955: on by default with a 12-hour cap. 0 turns the feature off. A
  per-workspace override follows the existing guard overrides (SPEC.md
  19.4).
- #936: the automatic clean-up keeps the default, the previous, and the
  single newest other image.
- Add the five backlog items above.
- The pilot may be used for the #933 Codex check, the #936 check that a
  workspace from a deleted image still starts, the epic head install and
  the smoke test.

## Rulings

- R1 (#955). The hold is a timestamp on the workspace (`keep_running_until`,
  migration 0034). The site cap is a settings column (hours, default 12, 0
  = off) beside the grace and idle defaults. The per-workspace override is
  a field in the guard override JSON. While `now < keep_running_until`,
  the worker neither starts the disconnect grace countdown nor the idle
  stop countdown. When the hold ends, both timers start from the end of
  the hold, as if the student had just acted, so the "Still working?"
  notice and its five-minute warning still apply. A hold never lifts
  resource guard limits. Audit actions: `workspace.keep_running_set` and
  `workspace.keep_running_ended`. A hold set while the cap is later
  lowered is cut to the new cap at the next reconcile pass.
- R2 (#957). Discovery never touches the listener. The agent probes once
  when a preview of that port is first requested, from either the Preview
  tab or the gateway, and caches the answer by socket inode as today.
  Until then `protocolHint` is `http` or `unknown`.
- R3 (#933). One template in the image is the source for both agents.
  Claude Code gets `/etc/claude-code/CLAUDE.md` (root, 0644), rewritten
  from the template at every workspace start. The workspace agent runs as
  the student, so if it cannot write that path, the controller writes it
  at start. For Codex, use `/etc/codex/config.toml` only if the pilot test
  shows Codex applies it; otherwise a marked block in `~/.codex/AGENTS.md`
  that only the block is rewritten. Remove only the exact platform import
  line from `~/.claude/CLAUDE.md`. Record the Codex result on #933.
- R4 (#932). Seed `-slim` tags at major (Node) or major.minor (Python)
  level, as the issue rules. The platform never edits the seed silently:
  the default applies only to an empty seed on a new install, and drift is
  a notice with one button. Nothing is added past the seed size cap.
- R5 (#936). Delete is refused for the default and the previous image in
  both the API and the root job. The job confirms, on the pilot's LVM thin
  storage, that a workspace made from a deleted image still starts.
- R6 (#934). Window 120 days, retention 120 days, and a test that fails if
  retention is ever shorter than the window. The window counts 120
  calendar days, not 121.
- R7 (#931). Use a native `<meter>` through a new `Meter` component in
  `packages/ui`, with its text kept beside it. M uses that component after
  D lands.

## File ownership

One owner per path. Anything not listed belongs to the task whose issue it
serves; ask the orchestrator before editing a path another task owns.

| Path | Owner |
|---|---|
| `.github/workflows/ci.yml` | C |
| `e2e/admin-audit.spec.ts`, `apps/web/src/admin/audit/**` | A |
| `apps/web/src/admin/docker/**`, `apps/api/src/routes/admin-docker.ts` and its tests, `apps/worker/src/docker-usage.ts`, `packages/contracts/src/docker-cache.ts`, `packaging/registry/**`, `e2e/admin-docker.spec.ts` | D, then S after D lands |
| `packages/ui/**` | D (the `Meter`); nobody else |
| `apps/workspace-agent/src/agent-instructions.ts`, `infra/workspace-image/portikus.yaml`, controller start step for the system file | I |
| `packaging/image/**`, `apps/api/src/routes/admin-image.ts`, `packages/contracts/src/image.ts`, `apps/web/src/admin/image/**`, `e2e/admin-image*.spec.ts` | M |
| `apps/worker/src/reconcile.ts`, `packages/contracts/src/guard.ts`, workspace and settings contracts, `packages/db/src/migrations/0034_*`, `packages/db/src/schema.ts`, `packages/db/src/migrations/index.ts`, `apps/web/src/shell/**`, `apps/web/src/admin/SettingsTab.tsx`, `GuardDialog.tsx`, `guardFields.ts`, `apps/web/src/admin/queries.ts`, `packages/contracts/src/index.ts` | K |
| `apps/workspace-agent/src/listening.ts`, `packages/contracts/src/listening.ts`, `apps/api/src/routes/preview.ts`, `apps/web/src/preview/**` | L |
| `apps/workspace-controller/src/provider.ts` create() admission check, a helper in `docker-seed.ts`, their tests | G |
| `packaging/debian/config`, `packaging/tests/debconf-test.sh` | P |
| `docs/**`, `README.md`, `apps/web/src/help/content/**` | F |

Migration numbers: K takes 0034. If S needs one, it takes 0035. No one
else adds a migration. Nobody edits `e2e/helpers.ts`; put a helper in your
own spec file. A new contract module is avoided; add to the owned file.

## Merge order

C first, so later task runs get the time limits. Then A, P, G, L, I, D,
M, K as each is green; S after D; review fixes; F last.

## Verification

Every task ships unit tests; every visible change ships Playwright tests
with an axe scan; a bug fix starts with a failing test. After all tasks:
code-reviewer, security-reviewer (K and L touch the workspace agent and
the preview gateway; I touches the agent) and a11y-reviewer, fixes, then
confirmation reviews. Battery on the final head with a fresh database.
On the pilot: install the epic head, the #936 deleted-image start check,
the #933 agent check, and the smoke test.
