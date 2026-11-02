# Epic 57: Pilot fixes

Fix batch. Branch `epic/57-pilot-fixes`, cut from main 7048bb4f. This
plan lives only on the epic branch; the fold task (F) folds its lasting
rules into SPEC.md and deletes it (WORKFLOW.md, "Epic plans"). Fix
batches skip the architect design step.

## Issues closed

The epic pull request into `main` closes #1731, #1732, #1725 and #1703.
Task pull requests use `Refs #N`; the epic pull request body carries one
`Fixes #N` line per issue.

## Rulings (2026-11-02)

1. **#1731 layout saves refused.** Fix on the browser side: the layout's
   version is read from the `etag` header even when Caddy has added a
   `-gzip` (or other `-<encoding>`) suffix or a weak `W/` prefix. Caddy
   keeps compressing API responses. The second defect in the issue (the
   save queued while leaving a project sends a stale version) is fixed in
   the same task. A Playwright test rewrites the layout `etag` the way
   Caddy does, so the suite catches this without Caddy. The smoke test
   gains a check that saves a layout over 512 bytes through Caddy twice
   in a row.
2. **Other ETag round trips.** The file editor and the checks file also
   send back an `etag` they read. R checks on the rehearsal VM that
   saving a file and a checks list over 512 bytes, twice in a row,
   works through Caddy. A failure there becomes a fix-round task.
3. **#1732 rebuild notice.** The title is one sentence ending with the
   packages as a comma-separated list in code style. The command gets a
   copy icon shown on hover and on keyboard focus, named "Copy command",
   and it replaces the separate **Copy command** button.
4. **#1725 flaky attach test.** Diagnose before changing anything. Fix
   the cause, in the test or in the attach path; a retry or longer wait
   is not a fix.
5. **#1703 LTI platforms file.** Reproduce first. When the configured
   source file is missing, setup must keep the installed platforms file
   and say so plainly in its output, not remove it silently.

## Tasks

Base for all wave-one tasks: 7048bb4f.

| Task | Issue | Owner, model | Files it may touch | Wave |
|---|---|---|---|---|
| A | #1731 | builder, Sonnet high | `apps/web/src/layout/persist.ts`, `apps/web/src/layout/persist.test.tsx`, a new or existing layout e2e spec under `e2e/`, `infra/tests/smoke-test.sh` and `infra/tests/smoke/` (the layout check only) | 1 |
| B | #1732 | ui-designer, Sonnet | `apps/web/src/shell/ReinstallNotice.tsx` and its test, `e2e/reinstall-note.spec.ts`, `e2e/a11y-announcements.spec.ts` if the wording changes it | 1 |
| C | #1725 | builder, Opus low | `apps/workspace-agent/src/agent.test.ts` and the attach path it tests (name the files in the report) | 1 |
| D | #1703 | infra, Opus low | `packaging/site/`, `infra/ansible/roles/portikus/tasks/lti*.yml`, `infra/tests/lti-platforms-test.sh` | 1 |
| R | all | infra, Sonnet (D's agent, continued) | none; on the rehearsal VM: install the epic build, reproduce #1703 gone, ruling 2 checks, layout saves through Caddy, then the full smoke with a Dex sign-in file | 2 |
| F | all | builder, Sonnet | `docs/STATUS.md`, `docs/SPEC.md` (sections 7.5, 22.3 and 29), Help text if B's wording appears there, delete this plan | 3 |

Reviews after wave one: code-reviewer, a11y-reviewer (A and B change
`apps/web`), and security-reviewer on D (LTI platform trust, SPEC.md
section 24).
