# 0076. Codex chat and the chat host core

- **Status**: Accepted (Epic 66)
- **Date**: 2026-11-13
- **References**: SPEC.md sections 4.4, 10.1, 10.2, 10.8, 24.1 and 24.2; STACK.md sections 10, 15 and 35; ADR 0012, ADR 0068, ADR 0069, ADR 0070, ADR 0073, ADR 0074, ADR 0075; issue #1531

## Context

ADR 0069 gave students a chat tab for Claude Code. Codex was a terminal
only. A student who uses Codex should get the same chat, with the same
cards, pickers, skills, MCP list and subagent rows, and should be able to
move between the two agents in one chat. Portikus must not read or keep
prompts, replies or files (STACK.md section 15, ADR 0012), and must not
depend on undocumented behaviour of an agent.

The chat host grew around the Claude Agent SDK. A second agent means the
parts that are the same for any agent (sockets, attach order, sequence
numbers, frame fitting, cards) must be separated from the parts that speak
Claude's protocol.

## Decision

1. **Codex is driven through `codex app-server`.** App-server is a mode of
   the unmodified Codex CLI that a program drives over standard input and
   output with JSON-RPC. The Codex driver starts one per chat tab, over a
   private stdio pipe, with no network port, no WebSocket listener and no
   shared daemon. There is nothing to authenticate, and the process ends
   with its tab. The host logs lifecycle events and the Codex version only,
   throws app-server's error output away, calls `account/read` (it
   returns the email) only to see whether the student is signed in and
   keeps only the account type (SPEC.md section 10.2), never calls
   `plugin/list` or `app/list` (they fetch a remote
   catalogue), and never sets `developerInstructions` on a thread, which
   could displace the platform's instructions. Measured memory is about
   125 MB for an idle server with no thread and 240 MB after a turn; a
   shared server can come later without changing the browser side.
2. **Terms: offered to every Codex sign-in.** OpenAI's app-server
   documentation says: "App-server authentication has never been permitted
   for commercial or hosted services." Todd reads that as aimed at
   reselling subscriptions, not at a student who brings their own Codex
   account into a workspace, and notes that other hosted tools do the same.
   Portikus never handles Codex credentials; the student signs in inside
   the workspace, and the binary is the unmodified one. The chat is offered
   to ChatGPT plans and API keys alike. **Risk:** OpenAI may read the
   sentence the other way, and the account at risk is the student's own, not
   Portikus's, as with ADR 0069 for Claude. The remedy would be to hide the
   Codex (GUI) launcher; nothing else depends on it. The plan-limits reader (`codex-limits.ts`) is unchanged.
3. **One chat host core, one interface, a driver for each agent.** The core
   (`chat/core.ts`) owns the sockets, attach order, sequence numbers, frame
   fitting, routing of browser messages, the latest models, modes,
   settings, commands, MCP list, context and rules, and the open cards. A
   driver implements `ChatAgent` (`chat/agent.ts`): start, stop, history,
   in-progress events, send, interrupt, set, revoke a rule, watch and
   unwatch a subagent, rename and adopt a handoff. It reports through a
   `ChatSink`: events, models, modes, settings, commands, rules, MCP list,
   context, open cards and a conversation reset. Claude and Codex are the
   two drivers. A test proves the core imports nothing from the Claude SDK.
   The contract carries what differs between agents as data: each model
   lists its own efforts, the host sends a list of permission modes with a
   warning flag and a plan flag, each card button names its decision, and
   each command has its own prefix, so the browser holds no table of one
   agent's words.
4. **No ACP adapters for Claude and Codex.** The Agent Client Protocol
   (ACP) is Zed's open protocol for driving a coding agent. Adapters exist
   for both agents (`claude-agent-acp` and a Codex adapter). Portikus
   rejects them for these two, because a protocol common to all agents
   leaves out what Portikus ships: revocable session rules, plan limits,
   the cache countdown, conversation titles, `!` commands, `/review` and the
   handoff between agents. The Codex adapter also runs about two weeks
   behind Codex releases, so a new Codex feature would wait for it. Claude
   and Codex keep their native protocols.
5. **ACP is the path for later harnesses.** Oh My Pi, DeepSeek Harness, Kimi
   Code, OpenCode and Gemini CLI all speak ACP. A later ACP driver behind
   `ChatAgent` is how a third harness arrives: start and stop map to
   starting the process and `initialize`, `send` to `session/prompt`,
   `interrupt` to `session/cancel`, `set` to `session/set_mode` and the
   session's config options, and a card to `session/request_permission`.
   Features ACP lacks would show as absent for that agent. No ACP driver is
   built now.
6. **Codex's own sandbox is kept.** SPEC.md section 24.2 makes the
   container the trust boundary. On the pilot, Codex's bubblewrap
   `workspace-write` sandbox works inside the unprivileged Incus container,
   so Auto uses the workspace sandbox as the terminal Codex does, with
   approvals on request. Full access runs with no sandbox and carries the
   same warning as Claude's Bypass permissions; it is never carried into a
   new chat.
7. **Platform instructions and hooks move to the managed config.** Checked
   on Codex 0.167.1: a student's own `~/.codex/config.toml` overrides
   `developer_instructions`, `daemon_auto_start` and `otel.log_user_prompt`
   in `/etc/codex/config.toml`, but none of them in
   `/etc/codex/managed_config.toml`. The controller therefore writes the
   instructions, every hook, the daemon switch and the `[otel]` table to the
   managed file at every start, and `/etc/codex/config.toml` keeps only the
   update switch the image ships. A live check showed the managed
   instructions survive switches into and out of Plan mode.
8. **Approvals never write lasting rules.** A Codex MCP tool approval
   becomes the ordinary permission card: Allow, Allow for this chat, Deny.
   "Always" is never offered, because it would write a rule into
   `~/.codex`, and no exec-policy amendment is offered for the same reason.
   Allow-for-this-chat grants live in Codex, cannot be revoked from the
   rules list, and a new chat clears them. Any other elicitation (a form or
   a URL), a dynamic tool call or a permission request is declined for both
   agents, with a line telling the student to use a terminal tab.
9. **Plan mode and questions are used although they are experimental.**
   App-server's plan and question requests sit behind its experimental API.
   Parsing is defensive, so a missing or changed field becomes a plain
   message, and the recorded fixtures and the smoke check catch a Codex
   update that breaks them.
10. **Switching agents in a chat is a handoff, and a restart.** Each agent
    keeps its own history, so the swap carries the earlier messages in. The
    API asks the workspace agent, which has the host prepare the swap and
    then restarts the chat process in the same tmux session with the other
    agent's driver. Only the new agent's institutional key is passed and
    the old one is removed from the session environment (SPEC.md sections
    10.6 and 24), which is why the swap is a restart and not a driver swap
    inside one process. A browser cannot start a swap; the relay drops an
    `agent.switch` message from it, and only the API route starts one. A
    swap is refused while a reply, a card or a `!` command is running.
    A switch makes the `agent-session` recovery point first, as launching
    an agent does (SPEC.md sections 15.6 and 15.10).
    Two switches of one chat at once are refused with 409. A host still
    waiting a minute after it prepared a swap takes the chat back, and if the
    new host cannot start, the old agent is started again with its own key.
    A handoff that fails marks the divider failed.
    Claude to Codex: the messages go through `thread/inject_items` into a
    new thread. To Claude: as text with the next prompt, inside a marked
    block that the transcript hides on replay. Claude resumes its own
    session whenever the tab has one, even in a chat that began on Codex,
    and receives only the turns since it last spoke (Todd, accepted
    2026-11-14); the tab keeps a session id for each agent. Tool calls pass
    as a one-line summary and never with their output. The oldest turns are
    dropped when the handoff would not fit half of the new agent's context
    window, or 200k tokens when the window is not yet known, and the
    divider says how many. `/clear` forgets the swap history.

## Consequences

- A real Codex turn needs a Codex sign-in. The rehearsal VM has none, so its
  smoke check opens a Codex chat and sends no prompt. Real-account checks
  run on the development host and on the pilot.
- The chat host spawns one more process for each Codex chat tab, about
  240 MB after a turn. It ends with the tab.
- Codex gaps Help states: a question asked in a Codex terminal has no browser
  card; the context meter shows tokens only, with no cache countdown; and
  a project's MCP servers start only once the project is trusted in a
  terminal.
- The Codex driver depends on app-server's wire format, which OpenAI may
  change. Narrow schemas that ignore unknown fields, and the recorded
  fixtures, limit the harm to a plain row or a missing card.
- The core and the driver interface are the seam for a later harness; adding
  one is a new driver and its entry flag, not a change to the browser.

## Rejected

- **The Codex TypeScript SDK.** It has no approvals, so a permission card,
  a question or a plan card cannot work.
- **ACP adapters for Claude and Codex** (decision 4).
- **The app-server WebSocket listener and the shared daemon.** A network
  port needs authentication, and a shared daemon keeps the environment of
  the first terminal that started it (ADR 0068 item 3).
