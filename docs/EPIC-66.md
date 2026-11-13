# Epic 66: Codex in the chat GUI, at parity with Claude

Branch `epic/66-codex-chat`, cut 2026-11-13 from main `2115e96c` and
brought up to main `fb37f19e` (after Epic 65) the same day. A feature
epic: three architect reports came first (the Codex design, a
Claude-Codex parity audit, and a shared harness layer), and Todd ruled
on their open questions in chat on 2026-11-13.

Goal: Codex gets everything Claude gets in Portikus today, with no
second-class agent. A Codex chat tab looks and behaves like the Claude
chat tab (SPEC.md section 10.8), adapted for Codex's models, efforts,
permission modes and commands. Both agents get the same tool-call views,
subagent rows in the left pane, skills and MCP servers. A student
switches between them mid-chat without relearning. The chat host gains
a small shared core so later harnesses can plug in.

Terms:
- **app-server** is `codex app-server`, a mode of the unmodified Codex
  CLI that a program drives over standard input and output with
  JSON-RPC. A **thread** is a conversation, a **turn** one prompt and its
  work, an **item** one step in a turn.
- A **harness** is a coding-agent program (Claude Code, Codex, Kimi Code).
  A **driver** is the part of the chat host that speaks one harness's
  protocol.
- **MCP** (Model Context Protocol) servers are separate programs that give
  an agent extra tools. An **elicitation** is an MCP request for input
  from the user.
- **ACP** (Agent Client Protocol) is Zed's open protocol for driving any
  harness.

Facts below were checked by running Codex 0.167.1 and the Claude Agent
SDK 0.3.319 on the development host unless they say otherwise.

## Rulings

1. **Sign-ins (Todd).** The Codex GUI is offered to every Codex sign-in,
   ChatGPT plans included. OpenAI's app-server documentation says
   "App-server authentication has never been permitted for commercial or
   hosted services". Todd reads that as aimed at reselling subscriptions,
   not a student bringing their own, and notes that other hosted tools
   (T3 Code among them) do the same. ADR 0076 records the sentence, the
   reading and the risk, which falls on the student's own account, as
   ADR 0069 did for Claude. The Codex plan-limits reader
   (`codex-limits.ts`) stays as it is.
2. **No second-class agent (Todd).** Everything Portikus supports for
   Claude today is supported for Codex. Where Claude's own support is
   thin (MCP display), both are raised together. Reasoning text stays
   hidden for both, as today.
3. **Plan mode and questions (Todd).** Included, although they sit behind
   app-server's experimental API. Parsing is defensive: a missing or
   changed field falls back to a plain message. The recorded fixtures and
   the smoke check catch a Codex update that breaks them.
4. **Real-account checks (Todd).** On the development host and on the
   pilot (Todd's development VM). The rehearsal VM gets no Codex login;
   its smoke check opens a Codex chat but sends no prompt.
5. **Permission labels (Todd).** Claude's five slots, in the same places
   and style, with Codex's own words: **Ask** (approval policy
   `untrusted`), **Read only** (read-only sandbox, `on-request`), **Plan**
   (Plan mode), **Auto** (`on-request` with the workspace sandbox, Codex's
   default), **Full access** (`never` with full access). Full access
   carries the Bypass warning and, like Bypass, is never carried into a
   new chat.
6. **Switching agents mid-chat (Todd).** Picking the other agent swaps it
   in place after a warning, like a model change ("Codex starts fresh
   with this conversation as context; the cache is lost"). The swap is a
   handoff, because each agent keeps its own history:
   - Claude to Codex: earlier messages go into the new Codex thread
     through `thread/inject_items` (in the protocol, not yet run; T0a
     checks it).
   - Codex to Claude: earlier messages go in as text with the next
     prompt. If the chat began on Claude, Claude resumes its own session
     and receives only the Codex turns.
   - Tool calls pass as a short summary. The oldest turns are dropped when
     the handoff would not fit the new agent's context window, and the
     warning says so. An empty chat swaps with no warning.
7. **Chat host core and agent interface.** One core (`chat/core.ts`) owns
   the sockets, attach order, sequence numbers, frame fitting, browser
   message routing, the latest models, modes, settings, commands, MCP
   list, context and rules, and the open cards. Each harness is a driver
   behind a narrow interface (`chat/agent.ts`: start, stop, history,
   in-progress, send, interrupt, set, revoke rule, watch and unwatch a
   subagent, rename, and adopt a handoff). Claude and Codex are the two
   drivers. A test proves the core imports nothing from the Claude SDK.
8. **No ACP driver in this epic.** Oh My Pi, DeepSeek Harness, Kimi Code,
   OpenCode and Gemini CLI all speak ACP, so a later ACP driver behind
   the same interface is the path for a third harness. ADR 0076 records
   the interface-to-ACP mapping; the fold files an `enhancement` issue.
   Claude and Codex keep their native protocols, because the ACP adapters
   lose features Portikus ships (revocable rules, plan limits, cache
   countdown, titles, `!` commands, `/review`, the handoff) and the Codex
   adapter runs about two weeks behind Codex releases.
9. **Contract shapes** (wire contract and stored data, hard to undo, so
   done right once):
   - Effort is a bounded string; each model lists its own `efforts` and
     `defaultEffort`, because Codex adds values (`ultra`) without notice.
     Known values get Portikus wording; an unknown one shows as written.
   - Permission mode is a bounded string. The host sends a list of modes
     (id, label, description, `warning`, `plan`) and the picker draws it.
     `warning` drives the Bypass and Full access warning and the rule
     that such a mode is never carried into a new chat.
   - Each card button says which decision it is; a permission card may
     carry a `plan`. The web no longer recognises Claude's button ids or
     `ExitPlanMode`.
   - A looser chat question (zero to four options, optional `secret`)
     beside the strict `ChatQuestion`, which the terminal question hook
     (ADR 0075) keeps.
   - `ChatCommand.prefix`, `"/"` or `"$"`, so skills appear with each
     agent's own prefix.
   - A new `mcp` server event: each server's name and status (connected,
     starting, failed, needs sign-in, disabled). No URLs, tools or errors.
   - Stored chat settings add `agent` (the last agent used) and a `codex`
     object beside Claude's keys. Stored as JSON, so no migration.
   - A client request to switch agent, and a handoff divider event.
10. **Skills, both agents.** The student's own skills appear in the `/`
    menu for both: Claude's as `/name`, Codex's as `$name` (Codex's
    `skills/list`). Typing `$` in a Codex chat opens a skills-only list.
    A Codex skill is sent as plain `$name` text, which Codex expands
    itself. A skill call shows as "Used skill *name*" for both.
11. **MCP, both agents.** `/mcp` runs in the chat for both and opens a
    read-only list of the student's servers with their status, also shown
    in Chat options; servers are managed in a terminal. One MCP tool row
    for both ("Used *tool* · *server*", with arguments and output) and
    one approval card ("Allow *server* to run *tool*?").
12. **Plugins, both agents.** Their skills and MCP servers work in both
    chats. Installing and managing them stays in the terminal for both
    (`/plugin`, `/plugins` shown dimmed). The host never calls Codex's
    `plugin/list` or `app/list`, which fetch a remote catalogue.
13. **Approvals and elicitations.** A Codex MCP tool approval arrives as an
    elicitation marked `mcp_tool_call`; it becomes the ordinary permission
    card: Allow, Allow for this chat (`persist: "session"`), Deny.
    "Always" is never offered, because it writes a lasting rule into
    `~/.codex`; no exec-policy amendment is offered for the same reason.
    Any other elicitation (a server asking for a form or a URL) is
    declined for both agents, with a line saying to use a terminal tab.
    Dynamic tool calls and permission requests are declined.
14. **Tool-call views.** Codex items keep their own names, drawn with the
    same row styles as Claude's. Commands use Codex's `commandActions`
    ("Read a.ts", "Searched for x"), file changes get a unified diff view,
    and collaboration tools (spawn, send input, wait, close) get verbs
    like Claude's Agent rows.
15. **Slash commands.** Codex has none over app-server, so its driver keeps
    a fixed list. It runs `/model`, `/effort`, `/permissions`, `/plan`,
    `/compact`, `/new`, `/clear`, `/rename`, `/review` and `/mcp`, and
    shows `/resume`, `/fork`, `/status`, `/diff`, `/init`, `/plugins` and
    `/logout` dimmed as terminal-only.
16. **Subagent rows.** Codex's `SubagentStart` and `SubagentStop` hooks feed
    the existing subagent receiver, so rows appear for Codex TUI and GUI
    tabs alike. Only `agent_id` and `agent_type` are kept (the ADR 0070
    pattern). Codex gives no description, so a row shows the type. In the
    chat, the subagent panel replays and follows the child thread.
17. **Codex's inner sandbox.** SPEC.md section 24.2 makes the container
    the trust boundary. If T0b shows Codex's bubblewrap works inside an
    unprivileged Incus container, the GUI uses the workspace sandbox as
    the TUI does; if not, `externalSandbox`, and Help says Auto asks only
    when the model asks.
18. **Transport.** The driver starts one `codex app-server` per chat tab
    over a private stdio pipe: no network port, nothing to authenticate,
    and the process ends with its tab. The WebSocket listener and the
    shared daemon are not used. T0a measures memory per app-server; if it
    proves large, a shared server can come later without changing the
    browser side.
19. **Nothing logged** (ADR 0012, STACK.md section 15). The host logs
    lifecycle events and the Codex version only, and discards
    app-server's error output. It never calls `account/read`, which
    returns the email (SPEC.md section 10.8), and never sets
    `developerInstructions` on a thread, which could displace the
    platform's instructions.

## Honest gaps

Things Codex cannot match; Help says so.
- A question asked in a Codex **terminal** gets no browser question card:
  Codex has no hook for questions. The chat has the card.
- "Allowed for this chat" grants live inside Codex and cannot be revoked
  from the rules list; a new chat clears them.
- The context meter shows tokens only: Codex gives no cache timing.

## Gaps closed

| Gap | Where |
|---|---|
| No Codex GUI | T1 to T6, T11 |
| No Codex subagent rows, TUI or GUI | T7, T3, T6 |
| Skills not shown for Codex; skill calls thin for Claude | T1, T2b, T3, T5, T6 |
| MCP status missing and MCP rows thin for both; elicitations silent for Claude | T1, T2b, T3, T5, T6 |
| #1531 Codex delta metrics unconfirmed | T0a checks per-turn counts against a local OTLP listener |
| A student's own `developer_instructions` may replace the platform's | T0b checks; if confirmed, T7 moves the platform settings to `/etc/codex/managed_config.toml` |
| No needs-input mark for a Codex question in a chat | T3 posts it |
| Launch type and labels hard-wired to Claude | T5 |
| Help and the live-help warning mention only Claude | T10 |
| No Codex e2e or smoke coverage | T8, T9 |

## Tasks

No two tasks edit the same file unless one starts after the other. A task
starts as soon as the PRs it starts after have merged. Days are agent
days. Paths under `chat/` are in `apps/workspace-agent/src/chat/`.

| Task | What | Owner, model | Files | Starts after | Days |
|---|---|---|---|---|---|
| T0a | Record app-server fixtures on the development host, scrubbed of content: approvals (decline, cancel), question, plan item, subagent with child events and collab send-input, file change, command kinds, image, steer, interrupt, `!` command and its Stop, resume, turns list, `thread/inject_items`, skills list and a `$skill` turn, MCP status and MCP approval (accept, session, decline). Also the #1531 per-turn metrics check and memory per app-server | builder, Opus low | new `chat/codex/test-fixtures/**` | none | 0.75 |
| T0b | Pilot checks with Todd's Codex login: Codex version; bubblewrap in the container; hooks under app-server with `PORTIKUS_TERMINAL`; whether a user `developer_instructions` replaces the platform's; whether a terminal question fires any hook; whether a project MCP server loads before the project is trusted. Report only | infra, Opus low | none | none | 0.5 |
| T1 | Contracts (ruling 9); a chat tab may be either agent | builder, Sonnet high | `packages/contracts/src/chat.ts`, `packages/contracts/src/terminal.ts` and their tests | none | 1.75 |
| T2 | Chat host core and agent interface (ruling 7). The Claude host becomes the first driver and behaves exactly as before; `host.test.ts` still passes. Core tests use a fake driver | builder, Opus medium | `chat/host.ts` and test, new `chat/core.ts` and test, new `chat/agent.ts`, `chat/open-cards.ts` | none | 2 |
| T2b | Claude driver sends the new fields: efforts and default effort per model, the modes list (Claude's wording moves out of the web), a decision on each card button, `plan` on the plan card, skills with their prefix, the MCP list, "Used skill" input; declines elicitations with the notice; makes `/mcp` runnable | builder, Sonnet high | `chat/host.ts`, `chat/model-list.ts`, `chat/claude-adapter.ts`, `chat/decisions.ts`, `chat/slash-commands.ts`, new `chat/mcp-status.ts`, and their tests | T1, T2 | 1.75 |
| T3 | Codex driver behind `chat/agent.ts`: JSON-RPC client, narrow schemas, item mapper, cards (including MCP approvals), history replay, slash list, skills, MCP status, subagent panel feed, needs-input post, modes with ruling 5's wording, entry flag `--agent=codex` | builder, Opus medium | `chat/codex/**` (not the fixtures), `chat/main.ts`, `apps/workspace-agent/src/tmux.ts`, `apps/workspace-agent/src/terminals-route.ts` and their tests | T0a, T1, T2 | 5.5 |
| T4 | API: per-agent stored settings, refuse a resume across agents, fake host speaks both agents' new events (skills, MCP list, MCP rows and cards, modes) | builder, Sonnet high | `apps/api/src/routes/terminals.ts`, `apps/api/src/routes/project-chat-settings.ts` and their tests, `apps/api/src/testing/fake-agent/chat.ts`, `e2e/fake-agent-server.mjs` | T1 | 1.25 |
| T5 | Web, choosing: pickers draw the host's models, efforts and modes (Version shown only when pinned versions exist), launcher labels, per-agent last settings, the agent's name in every chat string, the `$` trigger, the MCP server list, Codex rows in the left pane | ui-designer, Opus medium | `apps/web/src/chat/{ComposerPickers.tsx, models.ts, pickers.css, chatStore.ts, useChatSession.ts, ChatView.tsx, Composer.tsx, ComposerCommandMenu.tsx, ContextMeter.tsx, composerEditor.ts}`, new `apps/web/src/chat/McpServers.tsx`, `apps/web/src/agents/codingAgentName.ts`, `apps/web/src/terminal/useTerminals.ts`, `apps/web/src/work/{LauncherItems.tsx, WorkArea.tsx}`, `apps/web/src/projects/ProjectAgents.tsx`, and their tests | T1, T4 | 2.75 |
| T6 | Web, the conversation: Codex tool rows, command-kind and collab verbs, the diff view, one MCP row and card for both agents, "Used skill" row, files changed, cards driven by each button's decision and the `plan` field, free-text and secret questions, the subagent card and panel for Codex | builder, Sonnet high | `apps/web/src/chat/{toolView.ts, ToolBlock.tsx, MessageList.tsx, PermissionCard.tsx, QuestionCard.tsx, questionAnswer.ts, DecisionLine.tsx, fold.ts, SubagentPanel.tsx, NeedsInputTag.tsx, SpeakButton.tsx, readAloud.ts}`, the files-changed helper, and their tests | T1 | 2.75 |
| T7 | Codex config: subagent hooks and the script's Codex input, the board's start and stop rule, `managed_config.toml` if T0b confirms the override | builder, Sonnet high | `apps/workspace-controller/src/agent-instructions.ts` and test, `apps/workspace-agent/scripts/portikus-agent-subagent`, `packages/contracts/src/coding-agent-status.ts`, `apps/workspace-agent/src/coding-agent-status.ts` and their tests, `infra/workspace-image/portikus.yaml` (comment only) | T0b | 1 |
| T11 | Agent swap (ruling 6): `adoptHandoff` on the interface, the handoff builder for both directions, per-agent session ids in the tab's session record, the API change of a chat row's agent, the warning, the divider | builder, Opus medium | `chat/agent.ts`, new `chat/handoff.ts` and test, `chat/host.ts`, `chat/codex/host.ts`, `apps/api/src/routes/terminals.ts`, `apps/web/src/chat/{ComposerPickers.tsx, useChatSession.ts, MessageList.tsx}`, and their tests | T2b, T3, T4, T5, T6 | 2.5 |
| T8 | e2e for both agents: Codex chat (pickers, cards, question, plan card, owner-only refusal), skills and the `$` trigger, `/mcp`, MCP rows, cards and the elicitation notice, swap both ways, Codex rows in the agent-rows and launcher specs | tester, Sonnet high | new `e2e/chat-codex.spec.ts`, `e2e/chat-helpers.ts`, `e2e/agent-rows.spec.ts`, `e2e/agent-launchers.spec.ts` | T5, T6, T7, T11 | 2 |
| T9 | Smoke: open a Codex chat, get its snapshot and `agent: codex` settings, send no prompt | infra, Sonnet high | `infra/tests/smoke/chat.sh`, `infra/tests/smoke/chat-probe.mjs` | T3 | 0.5 |
| T10 | Docs and Help: SPEC.md sections 10.1, 10.2, 10.8 and the section 29 entry; ADR 0076 "Codex chat and the chat host core" (ruling 1, the core and interface, the ACP mapping, the sandbox outcome, ADR 0070's Codex line); STACK.md chat host and section 35 (ACP adapters rejected for Claude and Codex, ACP named as the path for later harnesses); Help on skills, MCP, plugins and project trust for both agents, a Codex chat topic, the honest gaps; the live-help warning names Codex | builder, Sonnet high | `docs/SPEC.md`, `docs/STACK.md`, `docs/adr/0076-*.md`, `apps/web/src/help/content/{student.tsx, studentAgentStatus.tsx, studentClaudeChat.tsx}`, a new Codex chat Help topic, `apps/web/src/livehelp/StartLiveHelpDialog.tsx`, and their tests | ADR after T0b; the rest after T3, T5, T6, T11 | 1.75 |
| D | Fold: STATUS entry and open items, lasting rules into SPEC.md, delete this plan, file the "More coding agents in the chat through ACP" issue | orchestrator | `docs/STATUS.md`, this file | every task and the fix round | 0.5 |

About 27 agent days. Read as waves: T0a, T0b, T1 and T2 first; then T2b,
T3, T4, T6 and T7; then T5, T9 and T11; then T8 and T10.

File hand-offs: `chat/host.ts` passes T2, then T2b, then T11;
`chat/agent.ts` passes T2, then T11; `chat/codex/host.ts` passes T3, then
T11; `ComposerPickers.tsx` and `useChatSession.ts` pass T5, then T11;
`MessageList.tsx` passes T6, then T11; `apps/api/src/routes/terminals.ts`
passes T4, then T11.

No migration (stored chat settings are JSON). The next ADR is 0076.

## Reviews

code-reviewer over the whole epic; security-reviewer, because the epic
touches the workspace agent and adds approvals (SPEC.md section 24);
a11y-reviewer over T5, T6 and T11. Reviews start once T2b to T7 have
landed. The rehearsal VM smoke runs because T7 changes the workspace
image's Codex config.

## Left out

- An ACP driver and any third harness (ruling 8; an issue is filed).
- Installing or signing in to plugins, apps and MCP servers from the
  chat, for either agent; ChatGPT connectors as their own feature.
- Platform-provided skills or MCP servers: nothing asks for one, and a
  platform MCP server would be a new SPEC.md section 24 boundary.
- Signing in to Codex from the GUI; Claude's GUI does not either.
- A shared history list or `/resume` picker across agents.
- Showing reasoning summaries, for either agent.
- A checklist view for plan and to-do steps, for either agent.
- Codex's automatic review mode, goals and realtime voice; special
  handling for generated images.
- Descriptions on Codex subagent rows (Codex gives none).
- Moving `codex-limits.ts` onto the new JSON-RPC client.
- The WebSocket transport and the app-server daemon (ruling 18).
