# Epic 74: side conversations (/btw) for chat tabs

Branch `epic/74-side-chat`, base commit `c8f5dfbf` (main after
Epic 73). Scope: GitHub issue #2110. This file goes away at the fold.

## Rulings that apply

- **The epic (Todd, 2026-11-19).** #2110 is next, ahead of #2070.
- **Pane placement (Todd, 2026-11-19).** The side conversation is a
  resizable split inside the chat pane, using the chat's existing panel
  library and `PaneHandle`. It is not a node in the saved layout
  (SPEC.md section 7.6 is unchanged), so it cannot be dragged to
  another tab.
- **Reload (Todd, 2026-11-19).** The chat host keeps the side
  conversation in memory and replays it when a browser attaches. It
  ends when the student closes the pane, on `/clear`, on an agent swap,
  when the host restarts, or when the workspace stops. Nothing is
  written to disk.
- **Claude route (Todd, 2026-11-19).** Use the Agent SDK's
  `Query.askSideQuestion`, which `/btw` uses but the SDK does not
  document. It sits behind one wrapper in `sdk.ts`, a test against the
  real CLI pins it, and ADR 0083 records why this bends ADR 0069. A CLI
  without it gives a clear error and no `btw` command.
- **Codex commands (Todd, 2026-11-19).** The Codex side conversation
  may run read-only commands, as Codex's own `/side` does. They show as
  rows in the pane.
- **Codex follow-ups (orchestrator).** Each side question forks the
  main thread again and injects the earlier side questions and answers,
  so it sees the main conversation as it stands, like Claude.
- **One side conversation per chat, one question at a time
  (orchestrator).** It uses the main chat's model, because the prompt
  cache belongs to one model.

## Facts checked

- SDK 0.3.325 (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)
  has `askSideQuestion(question, { history, signal })`, returning
  `{ response, synthetic }`; `sdk.d.ts` does not declare it. The
  architect ran it mid-turn against Claude Code 2.1.327: the answer
  knew the main conversation, nothing was written to the transcript,
  and the main turn finished. The only trace on the main stream is a
  `system/control_request_progress` message.
- `codex app-server` (codex-cli 0.167.1) `thread/fork` with
  `ephemeral: true` and `excludeTurns: true`, a read-only sandbox and
  approval policy `never` answered about the running main turn, left
  it untouched, wrote no session file, and read most of its input from
  the cache.
- `/btw` is not in the command list the SDK reports.
- The API relays any chat frame that parses against the contract
  (`apps/api/src/chat/route.ts`), so the API needs no change.
- A chat host started before an upgrade destroys the socket on a frame
  it cannot parse (`core.ts`, `onLine`).

## Design

- **Wire messages** (`packages/contracts/src/chat.ts`). The browser
  sends `side.ask { text }` (capped at 4,000 characters, like a
  message), `side.stop` and `side.end`. The host sends
  `{ type: "side", sessionId, event }`, where `event` reuses
  `ChatSubagentEvent`, to every attachment, with no sequence number
  (like the `subagent` frame).
- **Capability.** The host lists `btw` in its commands only when the
  driver supports side questions. The browser never sends `side.*`
  unless `btw` is listed, so an older host never sees a frame it cannot
  parse.
- **Core** (`apps/workspace-agent/src/chat/side.ts`, called from
  `core.ts`). Holds the side state and the earlier exchanges, allows
  one question at a time, replays on attach, and ends the conversation
  on the events in the reload ruling. A plain `send` of `/btw …` is
  caught and turned into a side question, so it never reaches the main
  conversation.
- **Driver interface** (`chat/agent.ts`, optional so the two drivers
  build in parallel):
  `askSide?(text, earlier: SideExchange[], emit, signal): Promise<void>`
  and `endSide?(): Promise<void>`.
- **Read-only, enforced in the host.** `side.ask` reaches only
  `askSide`, which has no access to permission cards. Claude's side
  call has no tools. Codex's fork uses a read-only sandbox and approval
  policy `never`; `requests.ts` refuses any request from a side thread
  before card code runs. Codex gets the side boundary as an injected
  item, not `developerInstructions` (SPEC.md section 10.2).
- **State and meters.** A side turn never changes the tab's working or
  finished state, and a Codex side thread's token usage never feeds the
  main context meter.
- **Logging.** Nothing from a side conversation is logged (ADR 0012).
- **Pane** (`apps/web/src/chat/SidePanel.tsx`). Opened by `/btw` (with
  or without a question) from the composer's command menu. Titled
  "Side: <chat name>". It draws events with the subagent fold and
  `MessageList`, and has its own small composer (text only), a Stop
  button while a question runs, and a close button that sends
  `side.end`. Test ids: `side-panel`, `side-composer`, `side-send`,
  `side-stop`, `side-close`.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 contracts | builder, Sonnet high | local | `packages/contracts/src/chat.ts`, `packages/contracts/src/chat.test.ts` | #2110 | none | no |
| T2 core and Claude driver | builder, Opus low | local | `apps/workspace-agent/src/chat/agent.ts`, `core.ts`, `side.ts` (new), `side.test.ts` (new), `host.ts`, `sdk.ts`, `core.test.ts`, `host.test.ts`, `test-fixtures/core-harness.ts`, `claude-real.test.ts` | #2110 | T1 | no |
| T3 Codex driver | builder, Opus low | pve | `apps/workspace-agent/src/chat/codex/host.ts`, `codex/side.ts` (new), `codex/side.test.ts` (new), `codex/requests.ts`, `codex/fake-app-server.ts`, and their tests | #2110 | T1 (uses the interface above; does not edit `agent.ts`) | no |
| T4 pane and `/btw` | ui-designer, Opus | desk | `apps/web/src/chat/ChatView.tsx`, `SidePanel.tsx` (new), `side.css` (new), `SidePanel.test.tsx` (new), `chatStore.ts` and its test, `Composer.tsx`, `ComposerCommandMenu.tsx` and their tests, `apps/web/src/help/content/studentClaudeChat.tsx`, `studentCodexChat.tsx` | #2110 | T1 | yes, in T5 |
| T5 browser tests | tester, Sonnet high | desk | `apps/api/src/testing/fake-agent/chat.ts`, `e2e/chat-side.spec.ts` (new) | #2110 | T4 | yes |
| T6 docs | builder, Sonnet high | local | `docs/SPEC.md` section 10.2 (an "Added by Epic 74" paragraph), `docs/adr/0083-side-conversations.md` (new) | #2110 | none | no |
| T7 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` section 29 entry, delete this plan | #2110 | T1 to T6 and the fix round | no |

- T2 and T3 tests prove no permission card opens from the side path, a
  side turn leaves the tab's state alone, and (T3) a side thread's
  token usage stays out of the main meter.
- T5 covers both agents: `/btw` opens the pane, a side answer while a
  turn runs with the main transcript unchanged, Stop, closing the pane,
  a reload keeping the conversation, and a host without `btw` offering
  nothing.
- No migrations and no API change.

Waves, for reading only: T1 and T6 first; T2, T3 and T4 when T1 lands;
T5 when T4 lands; T7 last.

## Reviews

- code-reviewer over the epic head, always.
- security-reviewer: the workspace agent and the read-only boundary
  (SPEC.md section 24).
- a11y-reviewer: the new pane, its composer and buttons (SPEC.md
  section 25.8).

## Rehearsal

None. Nothing touches install, packaging or infrastructure.

## Left out on purpose

A cost display for side conversations, a model or effort picker for
them, attachments, `!` commands and voice in the side composer, more
than one side conversation per chat, side conversations for terminal
(TUI) tabs, and any change to what a message sent mid-turn does today.
