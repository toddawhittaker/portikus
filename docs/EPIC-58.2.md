# Epic 58.2: fix batch after Epic 58.1

A fix batch (no architect pass). It carries Todd's pilot requests for the
Claude Code (GUI) chat tab, a phone layout, two small fixes, an
install-test gap, and the 22 open Dependabot alerts. Milestone "Epic 58.2
fix batch". The epic branch `epic/58.2-fix-batch` was cut from main
50084a7b (after #1810, the seroval update, merged).

## Rulings (Todd, 2026-11-08)

1. Scope is fixes and pilot requests only, with no contract changes. The
   design-review proposals #1780 to #1785 wait for a later chat epic
   beside Epic 59 (#1770).
2. #1801: the Agent SDK is already on its newest release (0.3.319). Add a
   Help note that a message sent while Claude works may be treated with
   caution, and that Stop then send always works. Mid-turn steering
   stays. The issue stays open to recheck on SDK upgrades.
3. #1809: the agent picker's short form is "Claude", shown only when the
   composer is narrow.
4. #1786 (Rewind) is closed as not wanted. #1747 is closed as a
   duplicate of #1782.
5. The rulings inside each issue body stand (#1805 option A, #1806's
   list, #1807's 0.8 seconds, #1808 option C, #1809 parts A and B).
6. #1811: the raised state of each administrator alert is kept in the
   existing `settings` table (migration 0005), so no migration is
   needed.
7. #1808 is built directly from the issue, without a mockup first. T5's
   PR attaches screenshots at 360, 420 and 800 px in both themes.

## Tasks

| Task | Owner, model | Files it may touch | Closes | Starts after |
|---|---|---|---|---|
| T1 Dependabot alerts | builder, Sonnet high | `pnpm-lock.yaml`, `pnpm-workspace.yaml` (a dompurify 3.4.17 override, with a comment to drop it when `monaco-editor` moves past 3.4.15) | #1812 | none |
| T2 Composer row | ui-designer, Sonnet high | `apps/web/src/chat/Composer.tsx` (the bottom row's markup only), `composer.css`, `ComposerPickers.tsx`, `pickers.css` and their tests, `e2e/chat-pickers.spec.ts`, `e2e/chat-composer-row.spec.ts` (new) | #1809 | none |
| T3 Composer editor | ui-designer, Opus low | `apps/web/src/chat/composerEditor.ts`, `composerMarkdown.ts`, `composerAttachments.ts`, `ComposerChips.tsx`, `Composer.tsx` (the dictation note), `composer.css`, their tests, `apps/web/package.json` and `pnpm-lock.yaml` (new TipTap extensions at 3.33.0), `apps/web/src/help/content/studentClaudeChat.tsx` (typing shortcuts), `e2e/chat-composer.spec.ts`, new composer specs | #1806, #1805, #1807 | T1, T2, T6 |
| T4 Tool-call groups | ui-designer, Opus low | `apps/web/src/chat/MessageList.tsx`, `ToolBlock.tsx`, `fold.ts`, `toolView.ts`, `useFollowEnd.ts`, `messages.css`, `turn.css`, their tests, `e2e/chat.spec.ts`, `e2e/chat-layout.spec.ts` | #1769, and the Jump button that covers the last message's corner (Epic 58.1 gap) | none |
| T5 Phone drawers | ui-designer, Opus low | `apps/web/src/app.css` (the `width < 56rem` block), `apps/web/src/shell/AppHeader.tsx`, `header.css`, `FilesPane.tsx`, `right-pane.css`, the projects pane component, a drawer component if needed, their tests, `apps/web/src/help/content/student.tsx` (layout), `docs/DESIGN.md` section 9 and its `design/` mirror, `e2e/phone-drawers.spec.ts` (new), and existing specs that assert stacking below 56rem | #1808 | none |
| T6 Alerts and Help note | builder, Sonnet high | `apps/worker/src/alert-sources.ts` and its test, `apps/web/src/help/content/studentClaudeChat.tsx` (the #1801 note) and the Help spec | #1811; Refs #1801 | none |
| T7 Install-test | infra, Sonnet high | `infra/tests/install-test.sh`, `docs/OPERATIONS.md` (the LTI step) | #1764 | none |
| R Rehearsal | infra, Sonnet (T7's agent, continued) | none; on the rehearsal VM: `make install-test` with the epic build and the full smoke with a Dex sign-in file, LTI checks included | | every task PR |
| F Fold | builder, Sonnet high | `docs/STATUS.md`; `docs/SPEC.md` section 8.1 and the line near 891 (#1808), sections 10.8 and 25.10 if a rule changed, section 29; the design README's radius-full list (the round Jump button, an Epic 58.1 gap); delete this plan | every `Fixes` line | the fix round |

Wave one runs T1, T2, T4, T5, T6 and T7 together. T3 waits for T1
(lockfile), T2 (`Composer.tsx` and `composer.css`) and T6 (the chat Help
page). T3 is one task because #1805, #1806 and #1807 all live in
`composerEditor.ts`; it may open one PR per issue in that order.

## Tests each task ships

- **T1:** `make check` and the full Playwright run, the editor specs
  above all (Monaco uses dompurify). The Dependabot list should read
  empty once the epic reaches main.
- **T2:** the widths, themes and accessible-name checks listed in #1809,
  with the container-query breakpoint measured.
- **T3:** serializer unit tests for every new mark and block, link
  schemes limited to http and https, the dictation decoration hidden
  from assistive technology, the 0.8-second double paste in both cases
  #1807 lists, and Playwright for each.
- **T4:** unit tests for grouping in `fold.ts`; Playwright for a run of
  tool calls under one block, a byline once per run of text, progress
  while running, and the native disclosure with a polite announcement
  (SPEC.md section 25.8).
- **T5:** the 360, 420 and 800 px checks in both themes with axe that
  #1808 lists.
- **T6:** a failing test first: two alert-source instances over one
  database with the reboot file present send one notification; a
  condition that clears and returns sends a second. The same for the
  sign-in spike and full-disk alerts.
- **T7:** `make install-test` on the rehearsal VM with no skipped LTI
  checks.

## Reviews

code-reviewer, a11y-reviewer (most of the change is in `apps/web`), and
security-reviewer scoped to link handling and paste-file removal in T3
and the dependency override in T1. They start once T1, T2, T4, T5 and T6
have landed.
