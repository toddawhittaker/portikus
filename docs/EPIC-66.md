# Epic 66: Codex in the chat GUI, and better Codex support

Branch `epic/66-codex-chat`, cut 2026-11-13 from main `2115e96c`. A
feature epic: the architect's design came first, and Todd ruled on its
open questions in chat on 2026-11-13.

Goal: a Codex chat tab that looks and behaves like the Claude chat tab
(SPEC.md section 10.8), adapted for Codex's models, efforts, permission
modes and commands; Codex subagent rows in the left pane; switching
between Claude and Codex in a chat without relearning; and the Codex gaps
that remain beside Claude closed.

Terms: **app-server** is `codex app-server`, a mode of the unmodified
Codex CLI that a program drives over standard input and output with
JSON-RPC. In its vocabulary a **thread** is a conversation, a **turn** one
prompt and its work, and an **item** one step in a turn. Facts below were
checked by running Codex 0.167.1 on the development host unless they say
otherwise.

## Rulings

1. **Sign-ins (Todd).** The Codex GUI is offered to every Codex sign-in,
   ChatGPT plans included. OpenAI's app-server documentation says
   "App-server authentication has never been permitted for commercial or
   hosted services". Todd reads that as aimed at reselling subscriptions,
   not a student bringing their own, and notes that other hosted tools
   (T3 Code among them) do the same. ADR 0076 records the sentence, the
   reading and the risk, which falls on the student's own account, as
   ADR 0069 did for Claude. The existing Codex plan-limits reader
   (`codex-limits.ts`) stays as it is.
2. **Plan mode and questions (Todd).** Included, although they sit behind
   app-server's experimental API. Parsing is defensive: a missing or
   changed field falls back to a plain message, never a broken chat. The
   recorded fixtures and the smoke check catch a Codex update that breaks
   them.
3. **Real-account checks (Todd).** Run on the development host and on the
   pilot (Todd's development VM) with logins already there. The rehearsal
   VM gets no Codex login; its smoke check opens a Codex chat but sends
   no prompt.
4. **Permission labels (Todd).** The Codex picker uses Claude's five
   slots, in the same places and style, with Codex's own words: **Ask**
   (approval policy `untrusted`), **Read only** (read-only sandbox,
   `on-request`), **Plan** (Plan mode), **Auto** (`on-request` with the
   workspace sandbox, Codex's default), **Full access** (`never` with full
   access). Full access carries the Bypass warning and, like Bypass, is
   never carried into a new chat.
5. **Switching agents mid-chat (Todd).** Picking the other agent in a chat
   swaps it in place after a warning, like a model change ("Codex starts
   fresh with this conversation as context; the cache is lost"). The swap
   is a handoff, because each agent keeps its own history:
   - Claude to Codex: the earlier messages go into the new Codex thread
     through `thread/inject_items` (seen in the 0.167.1 protocol, not yet
     run; T0a checks it).
   - Codex to Claude: the earlier messages go in as text with the next
     prompt. If the chat began on Claude, Claude resumes its own session
     and receives only the Codex turns.
   - Tool calls pass as a short summary, not as the other agent's own
     actions. The oldest turns are dropped when the handoff would not fit
     the new agent's context window, and the warning says so.
   - In an empty chat the swap needs no warning.
6. **One shared chat.** One chat contract and one web chat for both
   agents. A second host class for Codex emits the same server events as
   the Claude host. Only the socket fan-out (listen, attach, sequence
   numbers, broadcast, frame fitting) is pulled out of the Claude host to
   share; no general adapter layer.
7. **Contract shapes** (changes to the wire contract, hard to undo, so
   done right once):
   - Effort becomes a bounded string, and each model lists its own
     `efforts` and `defaultEffort`, because Codex adds effort values
     (`ultra` today) without notice. Known values get Portikus wording;
     an unknown one shows as written.
   - A `CodexPermissionMode` enum beside Claude's.
   - A looser chat question (zero to four options, optional `secret`)
     beside the strict `ChatQuestion`, which the terminal question hook
     (ADR 0075) keeps.
   - Stored chat settings add `agent` (the last agent used) and a `codex`
     object beside Claude's keys. Stored as JSON, so no migration.
   - A client request to switch agent, and a handoff divider event.
8. **Tool names.** Codex items keep their own names (command, file
   change, MCP call, web search), with a small web table and a unified
   diff view for file changes. Renaming them to Claude's tool names would
   hide which agent did what and does not fit Codex's diffs.
9. **Protocol types.** Hand-written narrow Zod schemas for only the fields
   used; an unknown item shows as a plain tool row. The 926 generated
   files are not committed.
10. **Subagent rows.** Codex's `SubagentStart` and `SubagentStop` hooks
    feed the existing subagent receiver, so rows appear for Codex TUI and
    GUI tabs alike. Only `agent_id` and `agent_type` are kept (the ADR
    0070 pattern); Codex gives no description, so a row shows the type.
    The STATUS line "Codex has no subagent hooks" is out of date.
11. **Slash commands.** Codex has none over app-server, so the host keeps
    a fixed list. It runs `/model`, `/effort`, `/permissions`, `/plan`,
    `/compact`, `/new`, `/clear`, `/rename` and `/review`, and shows
    `/resume`, `/fork`, `/status`, `/diff`, `/mcp`, `/init` and `/logout`
    dimmed as terminal-only.
12. **Codex's inner sandbox.** SPEC.md section 24.2 makes the container
    the trust boundary. If T0b shows Codex's bubblewrap works inside an
    unprivileged Incus container, the GUI uses the workspace sandbox, as
    the TUI does; if not, it uses `externalSandbox` and Help says Auto
    asks only when the model asks.
13. **Nothing logged** (ADR 0012, STACK.md section 15). The host logs
    lifecycle events and the Codex version only, and discards
    app-server's error output. The host never calls `account/read`, which
    returns the email (SPEC.md section 10.8). No exec-policy amendment is
    offered, because it writes a lasting allow rule into the student's
    `~/.codex`. Requests the host does not support (dynamic tool calls,
    MCP elicitation, permission requests) are declined.

## Gaps closed

| Gap | In this epic |
|---|---|
| No Codex GUI | T1 to T6, T11 |
| No Codex subagent rows, TUI or GUI | T7 |
| #1531 Codex delta metrics unconfirmed | T0a checks per-turn counts against a local OTLP listener |
| A student's own `developer_instructions` may replace the platform's | T0b checks; if confirmed, T7 moves the platform settings to `/etc/codex/managed_config.toml`, which outranks the user's file |
| No needs-input mark for a Codex question in a chat | T3: the host posts it, since no hook fires |
| Launcher labels lack a TUI or GUI suffix | T5 |
| Help says Codex shows no subagents | T10 |
| No Codex e2e or smoke coverage | T8, T9 |

## Tasks

No two tasks edit the same file unless one starts after the other. A task
starts as soon as the PRs it starts after have merged. Days are agent
days.

| Task | What | Owner, model | Files | Starts after | Days |
|---|---|---|---|---|---|
| T0a | Record app-server fixtures on the development host (approval with decline and cancel, question, plan item, subagent with child events, file change, image, steer, interrupt, `!` command and its Stop, resume, turns list, `thread/inject_items`), scrubbed of content; the #1531 per-turn metrics check; memory use per app-server | builder, Opus low | new `apps/workspace-agent/src/chat/codex/test-fixtures/**` | none | 0.5 |
| T0b | Pilot checks with Todd's Codex login: Codex version, bubblewrap in the container, hooks under app-server with `PORTIKUS_TERMINAL`, whether a user `developer_instructions` replaces the platform's. Report only | infra, Opus low | none | none | 0.5 |
| T1 | Contracts (ruling 7); allow `kind: chat` with `agent: codex` | builder, Sonnet high | `packages/contracts/src/chat.ts`, `packages/contracts/src/terminal.ts` and their tests | none | 1 |
| T2 | Pull the socket fan-out out of the Claude host | builder, Opus low | `apps/workspace-agent/src/chat/host.ts` and test, new `chat/sockets.ts` and test | none | 1 |
| T3 | Codex chat host: JSON-RPC client, narrow schemas, item mapper, cards, history replay, slash list, needs-input post, entry flag `--agent=codex` | builder, Opus medium | `apps/workspace-agent/src/chat/codex/**` (not the fixtures), `chat/main.ts`, `src/tmux.ts`, `src/terminals-route.ts` and their tests | T0a, T1, T2 | 4 |
| T4 | API: per-agent stored settings, refuse a resume across agents, fake host speaks Codex | builder, Sonnet high | `apps/api/src/routes/terminals.ts`, `apps/api/src/routes/project-chat-settings.ts` and their tests, `apps/api/src/testing/fake-agent/chat.ts`, `e2e/fake-agent-server.mjs` | T1 | 1 |
| T5 | Web, choosing: pickers per agent (models, efforts, modes, Version hidden for Codex), launcher labels, per-agent last settings, the agent's name in every chat string, Codex rows in the left pane | ui-designer, Opus medium | `apps/web/src/chat/{ComposerPickers.tsx, models.ts, pickers.css, chatStore.ts, useChatSession.ts, ChatView.tsx, Composer.tsx, ComposerCommandMenu.tsx, ContextMeter.tsx}`, `apps/web/src/agents/codingAgentName.ts`, `apps/web/src/work/{LauncherItems.tsx, WorkArea.tsx}`, `apps/web/src/projects/ProjectAgents.tsx`, and their tests | T1, T4 | 2 |
| T6 | Web, the conversation: Codex tool rows and the diff view, files changed, agent-aware cards, free-text and secret questions, the plan card, the subagent card and panel for Codex | builder, Sonnet high | `apps/web/src/chat/{toolView.ts, ToolBlock.tsx, MessageList.tsx, PermissionCard.tsx, QuestionCard.tsx, questionAnswer.ts, DecisionLine.tsx, fold.ts, SubagentPanel.tsx, NeedsInputTag.tsx, SpeakButton.tsx, readAloud.ts}`, the files-changed helper, and their tests | T1 | 2 |
| T7 | Codex config: subagent hooks and the script's Codex input, the board's start and stop rule, `managed_config.toml` if T0b confirms the override | builder, Sonnet high | `apps/workspace-controller/src/agent-instructions.ts` and test, `apps/workspace-agent/scripts/portikus-agent-subagent`, `packages/contracts/src/coding-agent-status.ts`, `apps/workspace-agent/src/coding-agent-status.ts` and their tests, `infra/workspace-image/portikus.yaml` (comment only) | T0b | 1 |
| T11 | Agent swap (ruling 5): handoff builder for both directions, per-agent session ids in the tab's session record, the API change of a chat row's agent, the warning, the divider | builder, Opus medium | new `apps/workspace-agent/src/chat/handoff.ts` and test, `chat/host.ts`, `chat/codex/host.ts`, `apps/api/src/routes/terminals.ts`, `apps/web/src/chat/{ComposerPickers.tsx, useChatSession.ts, MessageList.tsx}`, and their tests | T3, T4, T5, T6 | 2.5 |
| T8 | e2e: a Codex chat spec (pickers, cards, question, plan card, swap both ways, rows, owner-only refusal) and Codex rows in the agent-rows and launcher specs | tester, Sonnet high | new `e2e/chat-codex.spec.ts`, `e2e/chat-helpers.ts`, `e2e/agent-rows.spec.ts`, `e2e/agent-launchers.spec.ts` | T5, T6, T7, T11 | 1.5 |
| T9 | Smoke: open a Codex chat, get its snapshot and `agent: codex` settings, send no prompt | infra, Sonnet high | `infra/tests/smoke/chat.sh`, `infra/tests/smoke/chat-probe.mjs` | T3 | 0.5 |
| T10 | Docs and Help: SPEC.md sections 10.1, 10.2, 10.8 and the section 29 entry; ADR 0076 "Codex chat through app-server" (ruling 1, the sandbox outcome, ADR 0070's Codex line); STACK.md chat host (rejected: the Codex TypeScript SDK, which has no approvals, and ACP adapters); the student and agent-status Help pages | builder, Sonnet high | `docs/SPEC.md`, `docs/STACK.md`, `docs/adr/0076-*.md`, `apps/web/src/help/content/{student.tsx, studentAgentStatus.tsx}` and their tests | ADR after T0b; the rest after T3, T5, T6, T11 | 1 |
| D | Fold: STATUS entry and open items, lasting rules into SPEC.md, delete this plan | orchestrator | `docs/STATUS.md`, this file | every task and the fix round | 0.5 |

About 19 agent days. Read as waves: T0a, T0b, T1 and T2 first; then T3,
T4, T6 and T7; then T5, T9 and T11; then T8 and T10.

No migration (stored chat settings are JSON). The next ADR is 0076.

## Reviews

code-reviewer over the whole epic; security-reviewer, because the epic
touches the workspace agent and adds approvals (SPEC.md section 24);
a11y-reviewer over T5, T6 and T11. Reviews start once T3 to T7 have
landed. The rehearsal VM smoke runs because T7 changes the workspace
image's Codex config.

## Left out

- Signing in to Codex from the GUI; Claude's GUI does not either.
- A shared history list or `/resume` picker across agents.
- Codex skills, plugins, apps, MCP management and `$skill` mentions.
- Showing reasoning summaries; a checklist view for plan steps; Codex's
  automatic review mode; "always allow this command" rules; goals and
  realtime voice; special handling for generated images.
- Descriptions on Codex subagent rows (Codex gives none).
- Moving `codex-limits.ts` onto the new JSON-RPC client.
- The WebSocket transport and the app-server daemon.
