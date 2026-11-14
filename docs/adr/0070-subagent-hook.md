# 0070. A subagent hook that reads a few named input fields

- **Status**: Accepted (Epic 59)
- **Date**: 2026-11-09
- **References**: SPEC.md sections 10.8 and 24.1; STACK.md section 15; ADR 0012, ADR 0068; issue #1770

## Context

The left pane should list the subagents each Claude Code session has
started, with their type and short description, and show when each one
finishes. ADR 0068 item 1 says the hook script throws its input away
unread. That input is the only documented place the subagent's type,
description, tool call id and agent id appear, so a hook that stays blind
cannot show them.

## Decision

1. **One more hook script, `portikus-agent-subagent <event>`.** Claude
   Code's managed settings run it, in the background, on `PreToolUse`,
   `PostToolUse` and `PostToolUseFailure` for the `Agent` tool (and `Task`,
   its older name), and on `SubagentStop`, `UserPromptSubmit` and `Stop`.
   Like `portikus-agent-state` it checks `PORTIKUS_TERMINAL`, gives up after
   a second and always exits 0. It posts to `POST /coding-agent-subagent` on
   the loopback receiver.
2. **It keeps only these fields, with `jq`.** From a tool call event:
   `tool_use_id` (the row's key, which is also the chat's tool row id),
   `tool_input.description` (the row's label, cut to 120 characters),
   `tool_input.subagent_type` (the row's type), `tool_input.run_in_background`
   (which event ends the row), and the agent id in `tool_response` (which
   `SubagentStop` names when a background subagent ends). From
   `SubagentStop`: `agent_id`. From `UserPromptSubmit` and `Stop`: nothing;
   their input is thrown away unread. A field that is missing or of the wrong
   type is left out. Without `jq` the script sends nothing.
3. **The prompt is never read out.** `tool_input.prompt`, the subagent's
   reply in `tool_response`, the student's prompt and the transcript path
   hold what the student and the agent wrote. Portikus never logs or sends
   prompts or source (STACK.md section 15, ADR 0012), and a row needs none
   of them. The receiver's contract is strict, so a body with any other
   field is refused.
4. **This changes ADR 0068 item 1** for this script only:
   `portikus-agent-state` still reads nothing.

## Consequences

- A description is text the agent wrote about its task, and it reaches the
  owner's screen. It is short, the agent chose it as a label, and it goes
  only where the session already shows it.
- A hook's input format is Claude Code's, and a change to it hides rows
  rather than breaking the agent.
- Codex gained `SubagentStart` and `SubagentStop` hooks, so since Epic 66
  (ADR 0076) its sessions show subagent rows too. The script keeps only
  `agent_id` and `agent_type` from a Codex start and `agent_id` from a stop;
  Codex gives no description, so a Codex row shows its type.

## Rejected

- **Reading subagents from the transcript file.** It holds every prompt and
  reply, and its format is private.
- **Sending the whole hook input and filtering in the receiver.** The prompt
  would leave the script for no gain, and one receiver bug could then log it.
