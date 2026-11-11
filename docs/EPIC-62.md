# Epic 62: fix batch after the UI refresh

Branch `epic/62-fix-batch`, cut 2026-11-11 from main `d1738be2`. Milestone
"Epic 62 fix batch". Fixes Todd found on the pilot after Epic 61. The
architect's design (2026-11-11) is the basis for the task split; its SDK
findings are summarised under "Claude Code facts".

## Issues

| Issue | What |
|---|---|
| #1880 | Phone drawer buttons share names with the panes they open |
| #1893 | Dex theme files have no Cache-Control, so browsers keep the old logo |
| #1894 | Ended chat tab: New chat first, Resume chat second |
| #1895 | Model list from Claude Code, a Version picker (default Latest), Read replies aloud moved right; fresh chats start Opus, Medium, Auto |
| #1896 | Conversation titles in the left pane, pencil rename and `/rename`, subagent summary |
| #1897 | Watch a running subagent's conversation |
| #1898 | Agent tool card shows Claude Code's model-only launch text |
| #1899 | Always-on context meter "34.2k / 1M", looks that step at 25, 50 and 75% |
| #1900 | Per-pane zoom, Ctrl + wheel zooms the pane under the pointer |
| #1901 | Monitor: 26 px rows, 24 px buttons, tint heavy CPU and memory |
| #1902 | Files pane Git marks and file-type icons |
| #1903 | Terminal line height 1.25 to 1.1 |
| #1904 | Checks pane: pencil in place of "…" for Edit checks |

## Rulings

Todd, 2026-11-11:

1. #1895 and #1897 are in this batch, not deferred.
2. A fresh Claude Code (GUI) chat (no stored last-used settings) starts at
   Opus, Medium effort, Auto permissions, Version Latest. If the model says
   it does not support Auto, it starts at Ask.
3. #1897: the subagent view is read-only, with a note to ask Claude in the
   main chat to pass a message on. Claude Code offers no way to message a
   subagent.
4. #1897: the view is a panel inside the parent chat, not a tab of its own.
5. #1896: a subagent row's summary is the Agent call's existing
   `description`. No model call.
6. #1896: terminal (TUI) tabs get no title and keep the tab name.
7. #1900: terminals zoom by Ctrl + wheel and the pane's buttons only (the
   shell keeps Ctrl+= and Ctrl+-); chat and editor also take the editor's
   keys. A trackpad pinch over a pane zooms that pane, and the SPEC.md 20.1
   pinch sentence changes to say so.
8. #1904: a pencil with a visible "Edit checks" tooltip; the hint reads
   "To add one, choose the pencil above."

## Claude Code facts (Agent SDK 0.3.319)

- `supportedModels()` returns short names (`default`, `opus`, `fable`,
  `sonnet`, `haiku`) and specific versions (`claude-opus-4-8` and so on),
  each with `value`, `resolvedModel`, `displayName`, `description` and
  `supportsAutoMode`. A family's versions are the rows whose value starts
  with `claude-<short name>-`.
- Titles: `getSessionInfo()` gives `customTitle` (set by `/rename`) and
  `summary`; `renameSession()` sets a title. The CLI sends no event on a
  title change, so the host reads it back after each result.
- Subagents: `forwardSubagentText` streams a subagent's full
  conversation; `getSubagentMessages()` replays it from disk. There is no
  way to send a message to a subagent.

## Design decisions (architect)

- **Model contract.** `ChatModelChoice` becomes `ChatModel`, a string of
  at most 100 characters matching `^[a-z0-9][a-z0-9.\-\[\]]*$`, holding
  the SDK `value` exactly: a short name means Latest, a full ID a pinned
  version. Stored values from before still parse. A new `models` server
  event (at most 50 rows) is sent on attach. Until it arrives the picker
  keeps the last list, or shows Default plus the current model. A saved
  choice no longer offered falls back to its family's short name, then
  `default`. One `CHAT_START_SETTINGS` constant serves host, pickers and
  the new-chat check.
- **Context window.** The host calls `getContextUsage` at start, on attach
  and after a model change, so the window is known before the first reply.
  The session record file does not change. Before the first reply the
  meter reads "0 / 1M".
- **Titles.** Claude Code's session file is the source (`customTitle`,
  else `summary`); no database column. The chat host posts the title to
  the workspace agent's loopback status receiver; it reaches the browser
  through the existing agent status path as an optional `title` (at most
  80 characters). The pencil sends a new `rename` client message; the host
  strips control characters, calls `renameSession` and republishes.
  Titles are drawn from prompts: they are held in memory only and never
  logged. ADR 0074 records this and amends ADR 0070's consequences;
  security-reviewer reviews it.
- **Subagent view.** The client sends `subagent.watch` and
  `subagent.unwatch`; the server sends `subagent` events only to sockets
  that asked, outside the main store's sequence check. The host turns on
  `forwardSubagentText` and replays with `getSubagentMessages`. The panel
  reuses the chat message list with its own store; nested subagents open in
  the same panel with Back.
- **Monitor.** No contract change: per-process CPU is already a share of
  the workspace's CPU, and the memory total is the limit. Amber from 50%,
  red from 80%. The 24 px slots are scoped to `monitor.css`.

## Tasks

Owners are agents in `.claude/agents/`. No two tasks that run at once
edit the same file. Task D is the only task that edits SPEC.md, DESIGN.md
and the help content (except T6's one Help paragraph); every other task
lists the SPEC.md sentences it changes in its PR body for D to apply.

| Task | Issues | Owner, model | Files it may touch | Starts after |
|---|---|---|---|---|
| T1 | #1893 | infra, Sonnet high | `infra/ansible/roles/caddy/templates/Caddyfile.j2` (`Cache-Control: no-cache` on `/dex/theme/*`), the smoke-test check for it; verified on the rehearsal VM | none |
| T2 | #1880, #1894 | builder, Sonnet high | `apps/web/src/shell/AppHeader.tsx`, `apps/web/src/terminal/TerminalLeaf.tsx` and their tests, `e2e/phone-drawers.spec.ts`, `e2e/chat.spec.ts` | none |
| T3 | #1901 | ui-designer, Sonnet high | `apps/web/src/monitor/monitor.css`, `MonitorPane.tsx`, `usage.ts` and their tests, `e2e/monitor-*.spec.ts` | none |
| T5 | #1900, #1903 | builder, Opus | `apps/web/src/editor/zoom.ts`, `CodeEditor.tsx`, `apps/web/src/layout/store.ts`, `apps/web/src/terminal/useXterm.ts`, `TerminalPane.tsx`, `PaneFrame.tsx`, `apps/web/src/chat/chat-frame.css`, new `e2e/pane-zoom.spec.ts`; not `ChatView.tsx` or `TerminalLeaf.tsx` | none |
| T6 | #1904 | ui-designer, Sonnet high | `packages/ui/src/primitives/Icon.tsx` (adds `pencil`, the only task that does) and its test, `apps/web/src/checks/ChecksPane.tsx` and its test, the Edit checks paragraph of `apps/web/src/help/content/student.tsx`, the Checks e2e specs that find the button | none |
| C0 | #1898 | builder, Sonnet high | `apps/web/src/chat/ToolBlock.tsx`, `cards.test.tsx`, new `e2e/chat-agent-card.spec.ts` | none |
| C1 | #1895, #1899 | builder, Sonnet high | `packages/contracts/src/chat.ts`, `apps/workspace-agent/src/chat/host.ts`, `context-usage.ts`, `apps/web/src/chat/ComposerPickers.tsx`, `ContextMeter.tsx`, `chatStore.ts`, `pickers.css`, the fake agent's `chat.ts`, `e2e/doc-images/seed.ts`, the chat-pickers and context-meter specs | none |
| T4 | #1902 | ui-designer, Opus | `apps/web/src/files/GitLetter.tsx`, `TreeRows.tsx`, `fileIcon.ts`, `files.css`, the Changes list, `packages/ui/src/primitives/Icon.tsx` (file-type glyphs), `e2e/files*.spec.ts` | T6 |
| C2 | #1896 | builder, Opus | `packages/contracts/src/coding-agent-status.ts`, `chat.ts` (`rename`), `apps/workspace-agent/src/chat/host.ts`, `sdk.ts`, `agent-usage.ts`, `coding-agent-status.ts`, `apps/web/src/projects/ProjectAgents.tsx` and its CSS, the tab label, the fake agent's `coding-agents.ts` and `chat.ts`, new `docs/adr/0074-*.md` | C1, T5, T6 |
| C3 | #1897 | builder, Opus | `packages/contracts/src/chat.ts`, `apps/workspace-agent/src/chat/host.ts`, `claude-adapter.ts`, `snapshot.ts`, `sdk.ts`, `apps/web/src/chat/ChatView.tsx`, new `SubagentPanel.tsx`, `ProjectAgents.tsx`, `ToolBlock.tsx` (the link), the fake agent's `chat.ts` | C2, C0 |
| D | fold | builder, Sonnet high | `docs/SPEC.md` (8.2, 8.3, 9.7, 10.2, 10.8, 11.2, 12.1, 13.1, 18.2, 20.1, 25.8, section 29), `docs/DESIGN.md` section 11, `apps/web/src/help/content/student.tsx` and its specs, `docs/STATUS.md`, `make screenshots`, delete this plan | all |

The longest chain is C1, C2, C3, because all three edit the chat host,
the chat contract and the fake chat agent.

## Waves (for reading only)

- Wave 1, at once: T1, T2, T3, T5, T6, C0, C1.
- Wave 2: T4 after T6; C2 after C1, T5 and T6.
- Wave 3: C3 after C2 and C0.
- Fold: D after everything, including the fix round.

## Reviews and verification

- code-reviewer over the epic head, a11y-reviewer (apps/web and
  packages/ui), security-reviewer (C2 titles from prompts and ADR 0074, C3
  subagent stream in the workspace agent), starting once wave 1 and C2
  have landed.
- C1, C2 and C3 each add a `claude-real` test against the real CLI where
  the behaviour depends on Claude Code (model list, rename surviving a
  later turn, subagent stream).
- T1 is verified on the rehearsal VM (bootstrap through smoke, with a Dex
  sign-in file).
- Deploy to the pilot after Todd merges.

## Left out

A general filter for tools' internal text, a Stop button for subagents,
messaging a subagent, per-model effort limits, zooming the side panes,
titles for TUI tabs, and anything for Codex (the next epic).
