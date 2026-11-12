# Epic 64: admin and instructor UI redesign

Branch `epic/64-admin-ui-redesign`, cut 2026-11-12 from main `1d2dcaf8`.
Todd approved the whole list on 2026-11-12 ("The whole list. v8 is the
winner."), so this plan runs through without a plan stop.

The design is the winner of the 2026-11-12 hill-climb (v8, commit
`026b01ed`, scored 8.50 by three graders against 7.67 for main), plus the
admin capture in `e2e/doc-images` (`d98dc97b`, `8896b183`). It serves
SPEC.md section 20 (Administration), 8.6 (Help in the product), 8.7
(Course profile) and 25.8 (Accessibility), and DESIGN.md section 11.

## Rulings (orchestrator)

1. v8 lands as task T1 together with the end-to-end fixes it needs, since
   the epic ruleset requires a green pull request. T1 lands with a merge
   commit, not a squash, because T2, T4 and T5 start from its import
   commit `bd8b47b4` and need that history to merge cleanly.
2. The grader notes on v8 are fixed inside v8's structure and look; no new
   layout.
3. Audit date-range and result filters need an API change and are out of
   scope; the epic PR says so.
4. The student screens must be no worse than main in either theme. Any
   regression from the shared token changes is fixed in T2's files.

## Tasks

No two tasks edit the same file. A task starts as soon as the PRs it
starts after have merged; T2, T4 and T5 may start from `bd8b47b4` at once
and open their PRs after T1 lands.

| Task | What | Owner, model | Files | Starts after |
|---|---|---|---|---|
| T1 | v8 import; fix every e2e spec the redesign broke without weakening an assertion | tester, Opus | existing `e2e/*.spec.ts` and e2e helpers (not `e2e/doc-images/**`) | none |
| T2 | Grader fixes on v8: Class now card and dot legend; sticky admin rail and Settings index; one attention count; log chip on and off styles; readable disabled buttons in dark; phone fixes (Health range, Backups heading, member cards, 44 px targets); help text near 65-70 characters a line; any student regression T3 finds | ui-designer, Opus | `apps/web/src/**` except `help/content/**`, `packages/ui/src/**`, new `e2e/admin-polish.spec.ts` | `bd8b47b4` |
| T3 | Student screens on main and on v8, both themes; report regressions to T2 | ui-designer (review only), Opus | none (scratchpad captures) | `bd8b47b4` |
| T4 | New Playwright coverage for v8: More menu, inspector tabs, attention strip, sticky save bar, phone section controls | tester, Opus | new `e2e/admin-redesign*.spec.ts` files only | `bd8b47b4` |
| T5 | Docs: DESIGN.md and `design/` mirror, SPEC.md sections 20, 8.6, 8.7, 25.8, admin and instructor Help text | builder, Opus | `docs/DESIGN.md`, `design/**`, `docs/SPEC.md` (not section 29), `apps/web/src/help/content/**` | `bd8b47b4` |
| R | code-reviewer and a11y-reviewer over the epic diff; fixes as task PRs | reviewers | none | T1, T2, T4 |
| T6 | Fold: STATUS.md entry, `make screenshots` for docs/images, delete this plan | builder, Sonnet | `docs/STATUS.md`, `docs/images/**`, this file | R fixes |
