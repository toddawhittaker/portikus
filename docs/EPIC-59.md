# Epic 59: agent rows in the left pane, and a chat batch

A feature epic (#1770) run together with a batch of chat issues, as one
overnight run. Milestone "Epic 59: agent rows and chat batch". The epic
branch `epic/59-agents-and-chat` was cut from main b1d311bd. The
architect's design is summarised under "Design"; this plan is the
contract for every task.

## Rulings (Todd, 2026-11-09)

1. Epic 59 and the chat batch run together. The architect found that
   #1770 needs no chat-host or `chat.ts` change, because Claude Code's
   hooks already run in chat tabs. So the batch's host lane (#1838,
   #1782, #1780, #1783, `!` commands) runs alongside #1770 rather than
   after it.
2. #1784 uses a small, lazily loaded highlighter, not Monaco. The
   architect chose highlight.js core with about ten languages, coloured
   through CSS variables (ADR 0072). The first page does not load it
   (SPEC.md section 25.1).
3. #1783 and #1785 were added at the end of the host lane. #1785 is cut
   for time and stays open. #1783 must be per conversation (each chat
   tab), and it shows the time until the prompt cache goes cold as well
   as how full the context is. The cache timer is the last thing to cut.
4. #1841 (new): the status bar shows each provider's 7-day plan usage
   only (percent and reset day and time; Claude no longer has a 5-hour
   limit), Codex included, as a list keyed by provider so later
   providers plug in. Subscription usage replaces tokens and spend when a
   plan limit exists. Status bar only. No new work for terminal tabs:
   they may be removed once the chat is solid.
5. #1839: `!` works the way the terminal Claude Code does. The chat host
   runs the command itself, with no model, as the student in the project
   folder, with a time limit and an output cap. It appends the command
   and its output to the transcript as `<bash-input>` and
   `<bash-stdout>` entries with the SDK's `shouldQuery: false`, so no
   turn starts and Claude sees them with the next message (ADR 0073).
6. #1782: `@` searches every file name in the project through a new
   ripgrep file-list route that respects `.gitignore`.
7. #1770: an agent tab gets its left-pane row after its first hook,
   not before.

## Design (#1770, #1841, #1783)

- **Left-pane data.** One new hook script,
  `apps/workspace-agent/scripts/portikus-agent-subagent <event>`, copied
  from `portikus-agent-state` (one-second limit, always exits 0, checks
  `PORTIKUS_TERMINAL`). It keeps only allow-listed fields with `jq` and
  never sends the prompt. Hooks: `PreToolUse` and `PostToolUse` on
  Agent or Task, `PostToolUseFailure`, `SubagentStop`,
  `UserPromptSubmit`, `Stop`. The same data covers chat and terminal
  tabs. This changes ADR 0068 item 1 (the hooks read input fields), so
  ADR 0070 records it.
- **Row rules.** A row's key is the Agent tool call id, which is also
  the chat's tool row id. A foreground subagent finishes at its
  `PostToolUse`, a background one at the `SubagentStop` with its agent
  id. A failed call removes its row. `Stop` finishes working foreground
  rows; `UserPromptSubmit` drops finished ones; a `SubagentStop` with no
  start is ignored. At most 16 rows per terminal, finished rows dropped
  first. Order posts per row, not per terminal.
- **Contract** (`packages/contracts/src/coding-agent-status.ts`):
  `CodingAgentSubagent {id, type, description (120 max), state working
  or finished, since}`; `AgentCodingAgentStatus.subagents` with
  `.max(16).default([])`; `CodingAgentTerminal.name`, joined by the API.
- **Web.** A new `ProjectAgents.tsx`: a list of links under each
  project row, one `aria-expanded` disclosure per project, open by
  default. A row links to `?tab=<terminalId>&subagent=<toolCallId>`;
  `WorkArea.tsx` selects the tab and `chat/revealTool.ts` opens and
  focuses the tool row. The project state icon stays.
- **#1841 contract.** `AgentLimitsReport {providers: PlanUsage[] (8
  max)}` with `PlanUsage {id, label, usedPercent, resetsAt, observedAt}`;
  `AgentMeter {providers: [{id, label, plan | null, today | null}]}`.
  Provider ids are the agent ids. The `/claude-limits` POST body is
  unchanged; the receiver ignores `five_hour`.
- **#1783 contract.** A `context` server event in `chat.ts`:
  `{usedTokens, windowTokens | null, cache: {at, ttlSeconds 300 or 3600}
  | null}`, sent after each main-thread assistant message and on attach.
  The browser counts down to `at + ttl`. The meter sits in each tab's
  picker row.
- **Compatibility.** Messages from the browser to a chat host are
  checked strictly, so every new field is optional and sent only when
  used; a host from before a deploy must keep working.

## Tasks

| Task | Owner, model | Files it may touch | Closes | Starts after |
|---|---|---|---|---|
| T0 Contracts | builder, Sonnet high | `packages/contracts/src/coding-agent-status.ts`, `chat.ts`, `agent-limits` contract file, their tests: subagents, `name`, `PlanUsage`, `permission.answer.message?` (1 to 2,000 characters), the `commands` event (`ChatCommand {name, description, argumentHint, terminalOnly}`), the `context` event, the shell-command item shape, `ChatLastSettings.readAloud?`, the file-search request and response | contract parts of all | none |
| L0 Limits diagnosis | builder, Opus low (pilot read-only) | none; reports why the pilot shows tokens and spend for a subscribed Claude sign-in | Refs #1841 | none |
| P1 Pebble flake | builder, Sonnet high | `packaging/certificate/tests/test_pebble.py` | #1830 | none |
| P2 migrateDownTo | builder, Sonnet high | `packages/db/src/db.test.ts`, `instructor-tables.test.ts`, one new test helper | #1820 | none |
| H1 /clear | builder, Opus low | `apps/workspace-agent/src/chat/host.ts`, `session-record.ts`, `snapshot.ts`, `claude-adapter.ts` (also filter `parent_tool_use_id` live, as the replay does), their tests, `claude-real.test.ts`, a new e2e spec | #1838 | none |
| B1 Insert as text | ui-designer, Sonnet high | `apps/web/src/chat/ComposerChips.tsx`, `composerAttachments.ts`, `composer.css`, `Composer.tsx`, their tests, a new e2e spec | #1831 | none |
| C1b `!` in the conversation | builder, Sonnet high | new `apps/web/src/chat/shellCommand.ts`, `MessageList.tsx`, `messages.css`, tests, a new e2e spec | part of #1839 | T0 |
| X1 Highlighting | ui-designer, Opus low | `apps/web/src/chat/ChatMarkdown.tsx`, `CodeBlocks.tsx`, `chat.css`, new `chat/highlight.ts`, `apps/web/package.json`, `pnpm-lock.yaml`, ADR 0072, tests, a new e2e spec | #1784 | none |
| E1 Subagent hooks | builder, Opus low | `apps/workspace-agent/src/coding-agent-status.ts`, `agent-usage.ts` (the new route only), the new script, `agent-signal-scripts.test.ts`, `claude-managed-settings.json`, the managed-settings block of `infra/workspace-image/portikus.yaml`, the packaging script list if it names scripts, ADR 0070, tests | part of #1770 | T0 |
| E2 API join | builder, Sonnet high | `apps/api/src/workspaces/coding-agents.ts` and its test, `apps/api/src/testing/fake-agent/coding-agents.ts` | part of #1770 | T0 |
| E3 Left-pane rows | ui-designer, Opus | `apps/web/src/projects/ProjectPane.tsx`, new `ProjectAgents.tsx` and its CSS, `router.tsx`, `WorkArea.tsx`, `ChatView.tsx`, new `chat/revealTool.ts`, tests, new e2e and a11y specs | #1770 | T0 |
| L2 Status bar | ui-designer, Sonnet high | `apps/web/src/shell/StatusBar.tsx`, `apps/web/src/agents/AgentMeter.tsx`, `agentDisplay.ts`, `useAgentMeter.ts`, `agent-meter.css`, their tests, `e2e/agent-meter.spec.ts`, `e2e/status-bar-narrow.spec.ts` | #1841 | T0 |
| F1 File search | builder, Sonnet high | new `apps/workspace-agent/src/search-routes.ts`, an API relay route, tests | part of #1782 | T0 |
| T6a Speech module | builder, Opus low | new `apps/web/src/voice/speak*.ts`, ADR 0071, tests | part of #1840 | none |
| H2 Commands on the host | builder, Sonnet high | `host.ts`, `chatStore.ts`, `claude-adapter.ts` (pass #1780's `message` through; any fix L0 finds), their tests | part of #1782 | H1, L0, T0 |
| B3 / and @ menus | ui-designer, Opus | `Composer.tsx`, `composerEditor.ts`, `composer.css`, new `ComposerCommandMenu.tsx`, `apps/web/package.json` and `pnpm-lock.yaml` (`@tiptap/suggestion`, exact pin), tests, a new e2e spec | #1782 | B1, X1; store wiring after H2 and F1 |
| T6b Read aloud | builder, Sonnet high | `MessageList.tsx`, `messages.css`, `ComposerPickers.tsx`, `pickers.css`, `apps/api/src/routes/project-chat-settings.ts` (merge `readAloud`), tests, a new e2e spec | #1840 | C1b, T6a |
| H3 Deny with a reason | builder, Opus low | `claude-adapter.ts`, `PermissionCard.tsx`, `permissions.css`, `cards.test.tsx`, a new e2e spec | #1780 | H2 |
| H4a Context on the host | builder, Opus low | `host.ts`, `chatStore.ts`, new `apps/workspace-agent/src/chat/context-usage.ts`, tests | part of #1783 | H2 |
| L1 Limits agent and API | builder, Sonnet high | `apps/workspace-agent/src/agent-limits-route.ts`, `codex-limits.ts`, `agent-usage.ts` (the `claudeLimits` part only), `apps/api/src/routes/agent-meter.ts`, `apps/api/src/testing/fake-agent/coding-agents.ts`, tests | part of #1841 | E1, E2, T0 |
| H5 `!` on the host | builder, Opus low | `host.ts`, new `apps/workspace-agent/src/chat/shell-command.ts`, ADR 0073, tests, `claude-real.test.ts` | #1839 | H4a, C1b |
| C2 Files changed | ui-designer, Opus low | `MessageList.tsx`, `toolView.ts`, `fold.ts`, `turn.css`, `ChatView.tsx`, `WorkArea.tsx`, tests, a new e2e spec | #1781 | T6b, E3 |
| C1a `!` in the composer | ui-designer, Sonnet high | `Composer.tsx`, `composerEditor.ts`, `composer.css`, tests, e2e | part of #1839 | B3 |
| H4b Context meter and cache timer | ui-designer, Sonnet high | `ComposerPickers.tsx`, `pickers.css`, new `ContextMeter.tsx`, tests, a new e2e spec | #1783 | H4a, T6b |
| R Rehearsal | infra, Sonnet high | none; `make install-test` on the rehearsal VM with a Dex sign-in file, full smoke | | E1, and again on the last head if infra changed |
| F Fold | builder, Sonnet high | `docs/STATUS.md`, `docs/SPEC.md` (8.2, 9.7, 10.8, 25.10, 29), Help pages, delete this plan | every `Fixes` line | the fix round |

No task edits `e2e/chat-helpers.ts`; a task that needs a helper adds it
to its own spec. Only one task at a time edits `pnpm-lock.yaml` (X1,
then B3). No migration is needed. ADR numbers 0070 to 0073 are
preassigned as above.

## If the night runs short, cut in this order

1. The `@` mention (F1 and its part of B3).
2. #1781 (C2).
3. #1840's automatic reading (keep the button on each reply).
4. #1783's context percentage. The cache timer goes last.

## Check while building

- Confirm that `SubagentStop` and the Agent hooks fire under the SDK
  (a pilot check; the rehearsal has no Claude login).
- Confirm the API's four-a-second throttle sends the latest list rather
  than dropping it.
- Confirm `/clear` gives a new `session_id` on `init`.
- #1783: context size from `getContextUsage()` or `modelUsage`; cache
  lifetime from `usage.cache_creation`; confirm cache reads refresh it.
- #1840: prefer `localService` voices, split long replies into
  sentences, never log reply text.

## Reviews

code-reviewer and a11y-reviewer over the whole epic. security-reviewer
over the new hook script and ADR 0070, the `!` command path (H5), the
file-search route (F1), and the deny message. They start once T0, H1,
H2, E1, E2, E3, B1, X1 and L2 have landed, then do a short pass over the
rest.
