# Epic 55: Quick fixes

Fix batch. Branch `epic/55-quick-fixes`, cut from main b503bc58. This plan
lives only on the epic branch; the fold task (C) folds its lasting rules
into SPEC.md and deletes it (WORKFLOW.md, "Epic plans"). Fix batches skip
the architect design step.

## Issues closed

The epic pull request into `main` closes #1695 and #1685. Task pull
requests use `Refs #N`; the epic pull request body carries one
`Fixes #N` line per issue.

## Rulings (Todd, 2026-10-29)

1. **#1695 slow multi-delete.** `infra/host/backup-channel.sh` keeps
   its 30-second timer. Within one tick, after it runs a `delete_set`
   or `delete_dump` request and reports the result, it claims the next
   request, and keeps going while requests are deletes, up to 20
   requests or 25 seconds since the tick started. A `backup`,
   `restore_copy` or `import_home` request claimed during the drain
   runs as usual and ends the tick, so long jobs stay one per tick.
   No new request kind, no VM-side or API change. Each request is
   still checked, run and reported on its own (SPEC.md section 24.9,
   "The request-row channel"). SPEC.md 24.9 and ADR 0039 get a change
   note saying a tick may run several deletes.
2. **#1685 flaky offsite test.** Diagnose the cause in
   `infra/tests/backup-offsite-test.sh` ("prune drops a second copy of
   a set it holds") before changing anything. If the cause is in the
   test, fix the test; if it is in the offsite prune code, fix the code
   and say so. A retry or a longer sleep is not a fix.

## Tasks

Base for both wave-one tasks: b503bc58.

| Task | Issue | Owner, model | Files it may touch | Wave |
|---|---|---|---|---|
| A | #1695 | infra, Sonnet high | `infra/host/backup-channel.sh`, `infra/tests/backup-channel-test.sh` | 1 |
| B | #1685 | infra, Opus | `infra/tests/backup-offsite-test.sh`; the offsite prune code it tests only if the cause is there (name it in the report) | 1 |
| R | #1695 | infra, Sonnet | none; on the rehearsal VM, multi-delete four sets and confirm they finish in one or two ticks, then the full smoke with a Dex sign-in file | 2 |
| C | all | builder, Sonnet | `docs/STATUS.md`, `docs/SPEC.md` (sections 24.9 and 29), `docs/adr/0039-backup-channel-and-host-held-key.md` change note, delete this plan | 3 |

Reviews after wave one: code-reviewer and security-reviewer (the backup
channel is a SPEC.md section 24 trust boundary). No UI change, so no
a11y review.
