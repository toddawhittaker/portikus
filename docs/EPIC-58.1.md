# Epic 58.1 — Chat fix batch

Branch `epic/58.1-chat-fixes`, cut from main 3a33e776. Milestone "Pilot
fixes (next fix batch)". A fix batch: no architect step. Todd approved an
unattended run on 2026-11-07; this file is deleted by the fold task.

## Rulings (Todd, 2026-11-07)

1. #1761's design review runs first. Small proposals that fit files already
   in the batch are built in wave three; large or contentious ones are
   filed as issues for Todd.
2. #1759: the composer becomes a WYSIWYG Markdown editor built on an editor
   library (TipTap/ProseMirror), with the Markdown markers hidden as you
   type, as Remote Control does. It still sends plain Markdown text.
3. #1775: last-used chat settings are stored server-side, per user and per
   project. Model and effort carry over; a last-used Bypass falls back to
   Auto.
4. #1777: Markdown may show local images from the project or anywhere
   under `/home/student` (owner-only, symlink escapes refused, png, jpeg,
   gif or webp, 5 MiB cap), and the agent instructions tell Claude to save
   images it wants to show under `.portikus/`. Security review required.
5. #1745 (sticky agent toasts) is included.

## Tasks

Each task lands as its own PR into the epic branch. New styles go in a new
CSS file owned by the task unless the task owns the existing file.

### Wave one (from 3a33e776)

| Task | Owner | Issues | Files it may touch |
|---|---|---|---|
| 1 review | ui-designer, Opus, review only | #1761 | none; writes proposals to the scratchpad |
| 2 permissions | builder, Opus | #1774 | `apps/workspace-agent/src/chat/**`, `packages/contracts/src/chat*.ts`, `apps/web/src/chat/PermissionCard.tsx`, `apps/web/src/chat/chatStore.ts` (+ tests), `apps/web/src/chat/cards.test.tsx`, new `e2e/chat-permissions.spec.ts`, the fake chat host used by e2e |
| 3 toasts | builder, Sonnet | #1745 | `apps/web/src/terminal/useCodingAgentAlerts.tsx` (+ test), the toast component in `packages/ui` if needed, `e2e/agent-status.spec.ts` |
| 4 split | builder, Opus | #1773 | `apps/web/src/terminal/PaneFrame.tsx`, `apps/web/src/work/WorkArea.tsx`, the layout split code, their tests, pane-menu and layout e2e specs |
| 5 question card and chat layout | ui-designer, Opus | #1771, #1772 | `apps/web/src/chat/ChatView.tsx`, `QuestionCard.tsx`, `questionAnswer.ts`, `useFollowEnd.ts`, `MessageList.tsx`, `chat.css`, `chat-frame.css` (+ tests), workspace shell layout CSS, `e2e/chat.spec.ts`, new `e2e/chat-layout.spec.ts` |
| 6 images | builder, Opus | #1777, #1776 (viewer and tool images) | the workspace-agent file route and project-files code, `apps/api/src/routes/files.ts`, `packages/contracts/src/files.ts`, `apps/workspace-agent/src/agent-instructions.ts`, `apps/web/src/chat/ChatMarkdown.tsx`, `ToolBlock.tsx`, new `ImageViewer.tsx` and `image-viewer.css` (+ tests), new `e2e/chat-images.spec.ts` |
| 7 composer | ui-designer, Opus | #1759 (composer), #1760 | `apps/web/src/chat/Composer.tsx`, `ComposerChips.tsx`, `composer.css` (+ tests), `apps/web/package.json` and the lockfile for the editor library, `e2e/chat-composer.spec.ts` |
| 8 pickers | ui-designer, Opus | #1768 | `apps/web/src/chat/ComposerPickers.tsx` (+ test), new `pickers.css`, the menu primitive in `packages/ui` if one is reused, new `e2e/chat-pickers.spec.ts` |

### Wave two (from the epic head after wave one)

| Task | Owner | Issues | Files |
|---|---|---|---|
| 9 sticky settings | builder, Opus | #1775, and #1774's "Ask" hint under the picker | migration 0053, `packages/db`, `packages/contracts`, an API route, `ComposerPickers.tsx`, `chatStore.ts`, `useChatSession.ts`, `e2e/chat-pickers.spec.ts` |
| 10 messages | ui-designer, Opus | #1758, #1776 (sent thumbnails), #1759 (sent messages as Markdown) | `MessageList.tsx`, `CodeBlocks.tsx`, `ToolBlock.tsx`, `ChatMarkdown.tsx`, new `messages.css`, `e2e/chat-images.spec.ts`, new `e2e/chat-copy.spec.ts` |

### Wave three

Task 11 onward: the small proposals from task 1, split by file. Then the
reviews (code, security for task 6 and task 2, accessibility), the fix
round, and the fold task.

## Left out

- Epic 59 (#1770 agent rows, #1769 grouped tool calls) and Codex chat.
- Large #1761 proposals, filed as issues.
