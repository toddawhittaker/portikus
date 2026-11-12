# Epic 63: fix and enhancement batch

Branch `epic/63-fix-batch`, cut 2026-11-11 from main `b9110f1a`. Milestone
"Epic 63 fix batch". Todd asked for the next batch of fixes and
enhancements as an overnight run, so the orchestrator chose the scope and
made the rulings below; Todd confirms them at the epic PR. The architect's
design (2026-11-11) is the basis for the chat and terminal question tasks.

## Issues

| Issue | What |
|---|---|
| #1928 | Flaky second-factor test: the tamper could equal the original |
| #1921 | Files pane: language tags, more file families, colour on every icon, equal widths |
| #1919 | Terminal box-drawing lines show gaps between rows |
| #1785 | Chat: a quiet line records each permission decision |
| #1762 | A browser question card for Claude Code in a terminal tab, through a PreToolUse hook |

Left out: #1829 (no Monaco release bundles the fixed DOMPurify yet) and the
Codex GUI epic, which is a feature epic of its own.

## Rulings (orchestrator, for Todd to confirm)

1. #1919: add `@xterm/addon-webgl` 0.19.0, the release for xterm 6.0.0, so
   box characters fill the cell. Keep line height 1.1. Fall back to the DOM
   renderer when WebGL is missing or a context is lost. Line height 1.0
   was rejected because it drops the spacing Todd asked for.
2. #1785: decisions live in the chat host's memory only (ADR 0069 item 5,
   "nothing stored"). They survive a reattach and show in every browser,
   and are lost when the host restarts or an ended chat is resumed. A file
   can come later with no contract change.
3. #1785: the decision line sits at its tool call and folds into "Worked
   for" at the end of the turn, as answered questions do. Wording:
   "Allowed: ...", "Allowed for this chat: ...", "Denied: ...", "Plan
   approved", "Kept planning". A cancelled card leaves no line.
4. #1762: the hook waits up to 30 minutes for an answer. After that, or on
   "Answer in the terminal", Claude Code shows its own dialog.
5. #1762: the card sits over the bottom of the terminal pane and does not
   resize the terminal.
6. #1762: only the workspace owner sees or answers a terminal question.
   Never for a chat tab. The hook answers only AskUserQuestion. Questions
   and answers are never logged or stored.
7. #1762 and #1785 are the first to drop if the night runs short.

## Tasks

No two tasks edit the same file. A task starts as soon as the PRs it
starts after have merged.

| Task | Issue | Owner, model | Files | Starts after |
|---|---|---|---|---|
| T1 | #1928 | builder, Sonnet | `packages/auth/src/second-factor.test.ts` | none |
| T2 | #1921 | ui-designer, Opus | `packages/ui/src/primitives/Icon.tsx`, `apps/web/src/files/fileIcon.ts`, `files.css`, `design/system/**` (Icon mirror), `e2e/files*.spec.ts` | none |
| T3 | #1919 | builder, Sonnet | `apps/web/src/terminal/useXterm.ts` and helpers (not `TerminalLeaf.tsx` or `terminal.css`), `apps/web/package.json`, `pnpm-lock.yaml`, one `docs/STACK.md` row, terminal e2e specs | none |
| A1 | #1785 | builder, Sonnet | `packages/contracts/src/chat.ts` and test; `apps/workspace-agent/src/chat/host.ts` and test; `apps/api/src/testing/fake-agent/chat.ts` and test | none |
| A2 | #1785 | ui-designer, Opus | `apps/web/src/chat/chatStore.ts` and test, `MessageList.tsx`, `messages.test.tsx`, `messages.css`, new `e2e/chat-decisions.spec.ts` | A1 |
| B0 | #1762 | builder, Sonnet | `packages/contracts/src/coding-agent-status.ts` and test | none |
| B1 | #1762 | builder, Opus | new `apps/workspace-agent/scripts/portikus-agent-question`, `claude-managed-settings.json`, `infra/workspace-image/portikus.yaml` (one-line mirror), new `src/terminal-questions.ts` and test, `src/agent-usage.ts`, `src/coding-agent-status.ts`, `src/server.ts`, `src/chat/main.ts`, `src/agent-signal-scripts.test.ts`, `apps/workspace-controller/src/agent-instructions.test.ts`, `docs/adr/0074-*.md`, `docs/adr/README.md` | B0 |
| B2 | #1762 | builder, Sonnet | new `apps/api/src/routes/terminal-questions.ts` and test, `apps/api/src/server.ts` (one line), `apps/api/src/agent-client.ts`, `apps/api/src/workspaces/coding-agents.ts` and test, `apps/api/src/testing/fake-agent/coding-agents.ts` | B0 |
| B3 | #1762 | ui-designer, Opus | new `apps/web/src/terminal/TerminalQuestion.tsx` and test, `TerminalLeaf.tsx`, `terminal.css`, `apps/web/src/chat/QuestionCard.tsx` and test, `apps/web/src/api/workspace.ts`, new `e2e/terminal-question.spec.ts` | B0 (its Playwright run after B2) |
| D | all | builder, Sonnet | `docs/SPEC.md`, `docs/STATUS.md`, `docs/DESIGN.md`, the in-app Help, removes this plan | all, plus the fix round |

Reviews: code-reviewer over the whole epic; security-reviewer for B1 and
B2; a11y-reviewer for T2, A2 and B3. ADR 0074 is reserved for B1.

## Design notes from the architect

- #1785: `card.resolved` gains an optional `decision` of `allowed`,
  `allowedAlways` or `denied`. The host keeps up to about 500 decisions by
  tool call id, forgets them on `/clear`, and replays them after the
  history when a browser attaches. The browser keeps a tool-id-to-decision
  map so the order of arrival does not matter.
- #1762: the hook script skips chat tabs (`PORTIKUS_CHAT_TAB`), keeps only
  `tool_name`, `tool_use_id` and `tool_input`, posts them to the loopback
  receiver and prints the receiver's reply, or nothing, and always exits 0.
  The receiver holds at most one waiting question per terminal and shows
  it on that terminal's coding-agents entry, which is already owner-only.
  The answer arrives from the API at the agent's authenticated port; the
  loopback receiver never accepts answers. curl gives up at the limit less
  5 seconds, the receiver at the limit less 10.
- To check on the real CLI: what a skipped question does when a hook
  answers. The pilot has no Claude login, so this is left for Todd.
