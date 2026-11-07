# Epic 58: Claude Code chat tab

Feature epic. Branch `epic/58-agent-chat`, cut from main be7f1814. This
plan lives only on the epic branch; the fold task (F) folds its lasting
rules into SPEC.md, writes ADR 0069 and deletes it (WORKFLOW.md, "Epic
plans"). The architect's design report (2026-11-07) is the basis for
every task below.

## What it delivers

A new kind of centre-pane tab, "Claude Code (chat)", that replaces the
terminal view of Claude Code with a chat view, in the manner of
Anthropic's Remote Control web view and t3code:

- streamed Markdown replies; tool work folded into a "Worked for 3m 43s"
  block, with the turn's first and final assistant messages kept visible;
  each tool call expandable to its input and output;
- permission cards, and AskUserQuestion as a native card: header chip,
  options with descriptions, side-by-side previews, multi-select, "Other"
  text and notes;
- images both ways: paste, drop or attach images into the message, and
  images that tools return shown inline;
- a composer with an agent picker, model, effort and permission-mode
  pickers, an attach button, the existing microphone, and send;
- Epic 56's state marks, toasts and plan-limit meter working for chat
  tabs as they do for terminals.

The left and right panes are unchanged in this epic. Agent and subagent
rows under each project are Epic 59; Codex chat is Epic 60 (below).

## Rulings (Todd, 2026-11-07)

1. **Full chat replacement, centre pane only.** The left pane gets agent
   and subagent rows in Epic 59, not a new thread sidebar. The right pane
   gets no new work: the existing file tree and diff views stay. A
   "changed files" card linking to the existing diff view is optional and
   falls to a later epic if time runs short.
2. **Claude sign-in.** Offer the chat for every sign-in, subscription
   included. Anthropic's legal page allows "an end user signing in to the
   unmodified Claude Code binary with their own Claude subscription,
   including where a platform hosts Claude Code"; the Agent SDK overview
   forbids third-party products offering claude.ai login unless approved.
   Portikus never handles Claude credentials: the student signs in
   through Anthropic's own flow, inside their workspace, to the shared
   unmodified binary. ADR 0069 records this ruling and the risk that
   Anthropic reads it otherwise.
3. **Protocol.** The Claude Agent SDK's `query()` with
   `pathToClaudeCodeExecutable=/opt/portikus/coding-agents/bin/claude`
   (SPEC.md section 10.1). Rejected: Claude Code's raw stream-json mode
   (we would re-implement its undocumented control protocol for
   permissions) and ACP through claude-agent-acp (a third-party layer on
   the same SDK). The SDK version is pinned in
   `apps/workspace-agent/package.json` and tested against the CLI the
   image job installs; the optional platform binary is not installed.
4. **Process.** A small host, `portikus-chat-host`, shipped with the
   workspace agent, runs as the command of the tab's own tmux session
   `pk-<id>`, as an agent terminal does (SPEC.md section 10.2). It
   survives a workspace-agent restart, keeps the terminal unit's limits,
   and is killed with the tab (section 9.7).
5. **Record.** Reuse the `terminals` row with a new `kind` column
   (`terminal` or `chat`), migration 0052. The layout leaf, the 20-tab
   limit, the project link and the state marks keep working. The SDK
   `sessionId` is the terminal id, so no mapping is stored.
6. **Contract.** A Portikus chat contract, `packages/contracts/src/chat.ts`,
   that does not depend on the agent. Server to browser: `snapshot`,
   `turn.started`, `text.delta`, `message`, `tool.started`, `tool.output`
   (text or image), `tool.finished`, `permission.requested`,
   `question.requested`, `card.resolved`, `turn.finished`, `error`.
   Browser to server: `send {text, attachments[]}`, `permission.answer`,
   `question.answer {answers, notes}`, `interrupt`,
   `set {model, effort, mode}`. Caps: 1 MiB text frames; images up to
   5 MiB, png, jpeg, gif or webp only (no SVG), at most 10 per message; at
   most 4 questions of 2 to 4 options.
7. **History and privacy.** History lives only in Claude's own transcript
   files under `~/.claude/projects` in the workspace. On attach the host
   sends a snapshot (`getSessionMessages`, last N turns, open cards, the
   turn in progress), then live events. Nothing reaches the database or a
   log (STACK.md section 15, ADR 0012). The chat socket is owner-only,
   copying `apps/api/src/routes/language-servers.ts`; administrators,
   instructors, share viewers and live-help helpers are refused. The API
   relays frames without reading them.
8. **Waiting.** Cards wait with no time limit, as the terminal dialog
   does; the tab shows "needs input". Up to 4 browser tabs attach; the
   first answer wins and `card.resolved` clears the card everywhere. At
   the next workspace start a chat tab offers "Resume"; a turn in
   progress at the stop is lost.
9. **Answers.** `canUseTool` returns `allow` with
   `updatedInput: {...input, answers, annotations}`: multi-select picks
   joined with commas, "Other" text as the answer when nothing is picked
   and as `notes` otherwise (verified on Claude Code 2.1.319).
   `ExitPlanMode` shows as a permission card holding the plan.
10. **Images.** Pasted, dropped or attached files are saved through the
    existing helper in `apps/web/src/files/queries.ts` into
    `.portikus/pastes/<stamp>/`; `send` carries project-relative paths and
    the host sends images to Claude as image blocks, other files as path
    references. Images in tool results reach the browser as `data:` URLs.
11. **Untrusted Markdown.** Assistant Markdown goes through
    `sanitizeMarkdown` in `apps/web/src/lsp/content.ts` (no HTML, no
    remote images, only http and https links), so a prompt-injected image
    link cannot leak data.
12. **Composer pickers.** The agent picker shows Claude Code and a
    disabled "Codex (coming soon)" entry until Epic 60. The permission
    picker offers Ask, Accept edits, Plan, Auto and Bypass permissions.
13. **Voice.** Reuse the existing speech input (ADR 0055,
    `apps/web/src/voice/VoiceButton.tsx`) and its administrator switch.
    Dictated text lands in the composer and is never sent on its own.
14. **Terminal interop.** "Claude Code (chat)" joins the "New tab" menu
    next to "Claude Code"; the Traditional course profile hides it
    (section 8.7). After a chat tab closes, `claude --resume <id>` in a
    terminal continues the session; Help says not to run both at once.
15. **Limits meter.** The status line does not run under the SDK, so the
    five-hour and seven-day figures come from the SDK's
    `rate_limit_event` into the same store `/claude-limits` feeds.

## Tasks

Base for wave one: the epic head after this plan lands (epic cut from be7f1814).

| Task | Owner, model | Files it may touch | Wave |
|---|---|---|---|
| T1 Contracts and migration | builder, Sonnet high | `packages/contracts/src/chat.ts` (new) and its test, `kind` in `packages/contracts/src/terminal.ts`, `packages/db/src/migrations/0052_terminal_kind.ts` and its test, `packages/db` types | 1 |
| T2 Chat host and Claude adapter | builder, Opus low | `apps/workspace-agent/src/chat/*` (new), the chat branch of the tmux launch in `apps/workspace-agent/src/terminals.ts`, the `/chats/:id/attach` route, `apps/workspace-agent/package.json` and the lockfile (the SDK) | 2 |
| T3 API relay | builder, Sonnet high | `apps/api/src/routes/chat.ts` (new), `kind` on terminal create, `apps/api/src/testing/fake-agent/chat.ts` (new) | 2 |
| T4 Conversation view | ui-designer, Opus low | `apps/web/src/chat/` (store, socket, `MessageList`, `ToolBlock`, `QuestionCard`, `PermissionCard`), the `kind` branch in `apps/web/src/terminal/TerminalLeaf.tsx`, `e2e/chat.spec.ts` (new) | 2 |
| T5 Composer and launcher | ui-designer, Sonnet high | `apps/web/src/chat/Composer*` (new), the menu entry in `apps/web/src/work/WorkArea.tsx`, `e2e/chat-composer.spec.ts` (new) | 3 |
| T6 Package and smoke | infra, Sonnet high | `packaging/` (the chat host, no optional SDK binaries), `infra/tests/smoke/` (a new chat check) | 3 |
| R Rehearsal | infra, Sonnet (T6's agent, continued) | none; on the rehearsal VM: install the epic build, run a chat turn with an image and a question, then the full smoke with a Dex sign-in file | 4 |
| F Fold | builder, Sonnet high | `docs/STATUS.md`; `docs/SPEC.md` sections 8.3, 9.7, 10.2, 10.8, 24.1, 25.8, 25.10, 26 and 29; `docs/STACK.md` sections 10 and 35; `docs/adr/0069-chat-tab.md` (new); the Help page (`student.tsx`); delete this plan | 5 |

T1 lands first because every other task builds on its contract. T2, T3
and T4 then run in parallel: T3 and T4 test against T3's fake agent, so
they do not wait for T2. T5 starts after T4's store lands, because the
composer writes to it.

## Tests each task ships

- **T1:** Zod tests for every cap in ruling 6; a migration test that
  existing rows read back as `terminal`.
- **T2:**
  - adapter mapping tests from recorded SDK frames;
  - a card waiting with no time limit, and the first answer winning;
  - a snapshot on reattach;
  - one test against the real CLI that answers a question with notes
    and checks Epic 56's state hooks still fire under the SDK (if
    `PermissionRequest` does not fire, T2 posts to `CodingAgentBoard`
    directly and says so).
- **T3:** a browser other than the owner's (administrator, instructor,
  helper, share viewer) is refused; the frame cap; nothing logged.
- **T4:** unit tests, plus Playwright tests:
  - streamed Markdown and the folded work block;
  - cards answered with the keyboard only, previews, multi-select,
    "Other" and notes;
  - a second browser tab clearing an answered card;
  - a remote image in Markdown not loaded.
- **T5:** Playwright tests:
  - paste, drop and attach an image;
  - each picker;
  - dictation inserting text and never sending;
  - the disabled Codex entry;
  - the Traditional profile hiding the launcher.
- **T6 and R:** the smoke test's chat check on the rehearsal VM.

## Reviews

After every task pull request lands: code-reviewer; security-reviewer
(the workspace agent, a new socket, untrusted Markdown, the SDK
dependency; SPEC.md section 24); a11y-reviewer (the conversation, the
cards and the composer; section 25.8).

## Left out

- The hook-based question card for terminal Claude Code. It is proven
  (a timeout falls back to the terminal dialog) and is to be filed as an
  issue.
- Live help in chat tabs, opening a terminal session in the chat view,
  and preventing a chat and a terminal from running one session at once.
- Slash commands and @-mentions of files in the composer.
- Commit & push, and choosing a worktree: the platform never commits or
  branches for the student (SPEC.md section 12.5).
- The per-turn diff viewer, thread search and snoozed and settled groups
  (Todd's ruling 1).

## Epics that follow

- **Epic 59: agent and subagent rows in the left pane (4 to 6 days).**
  - Under every project's row, one link per agent tab (terminal or
    chat), with its state and elapsed time ("Working 4m"). Under each
    agent, its subagents: description, type and state.
  - Data comes from the SDK's `task_*` messages for chat tabs. For
    terminal tabs it comes from a new hook script on `SubagentStart`,
    `SubagentStop` and `PostToolUse` for the `Agent` tool; the receiver
    keeps only allow-listed fields.
  - `CodingAgentTerminal` gains `subagents[]`, at most 16 per terminal.
  - Terminal Codex shows no subagents.
- **Epic 60: Codex chat (6 to 9 days).**
  - A second adapter in the chat host maps `codex app-server` to the same
    contract: questions from `requestUserInput`, subagents from
    `collabToolCall`, and images through `localImage`.
  - It waits on two things: those experimental APIs settling, and a check
    of OpenAI's terms for ChatGPT login in a third-party client.
