# 0074. Chat titles come from Claude Code's session file and are never logged

- **Status**: Accepted (Epic 62)
- **Date**: 2026-11-11
- **References**: SPEC.md sections 8.2, 10.8 and 24.1; STACK.md section 15; ADR 0012, ADR 0069, ADR 0070; issue #1896

## Context

With two or three Claude Code (GUI) chats open in one project, every row
in the left pane and every chat tab read "Claude Code (GUI)", so a student
could not tell the chats apart without opening each one. Claude Code
already keeps a title for each session: `/rename` sets the student's own
(`customTitle`), and otherwise Claude Code writes a summary, which falls
back to the first prompt. The pinned Agent SDK reads both with
`getSessionInfo()` and sets the student's title with `renameSession()`. It
sends no event when the title changes.

A title is drawn from the student's prompts. Portikus never logs prompts
(STACK.md section 15, ADR 0012), and the hook scripts read no prompt
(ADR 0070).

## Decision

1. **Claude Code's session file is the only store.** The title is the
   session's `customTitle`, else its `summary`. Portikus adds no database
   column, so a title cannot outlive the session or drift from what
   `claude --resume` shows in a terminal.
2. **The chat host reads it and posts it.** The host reads the title when
   its session starts, after each result (so a `/rename` typed in the chat
   and Claude Code's own summary both show up), and when `/clear` moves the
   tab to a new session. It cleans the text to one line of at most 80
   characters with no control characters, and posts it, or null for none,
   to `POST /coding-agent-title` on the workspace agent's loopback
   receiver, only when it changed. Posts go one at a time; a failed post
   is tried again on the next read.
3. **It reaches the browser on the agent status path.** The board keeps
   each chat's title in memory beside its state, and the status frame
   carries it as an optional `title`. The left pane shows it under the
   row's name, and the chat's tab uses it as its label, with "Claude Code
   (GUI): title" as hover text.
4. **The pencil renames through the chat socket.** A chat row's pencil
   opens the title for editing in place; Enter saves and Escape cancels.
   The browser opens the chat's own socket for one `rename` message. The
   host cleans the title, calls `renameSession()`, and publishes the
   result as in item 2. An error goes back only to the socket that asked.
   Renaming with the pencil and typing `/rename` both set `customTitle`,
   so each shows in the other place.
5. **Titles are shown, never logged.** The host, the receiver, the board
   and the API hold a title in memory and send it only on the status path
   to the owner's screen. None of them logs it; the API's log of a refused
   frame names fields only.
6. **Subagent rows and terminal tabs get no new title.** A subagent row's
   summary is the description the Agent call already carries (ADR 0070),
   with no model call. Portikus does not see a terminal (TUI) tab's
   conversation, so that tab keeps its name.

## Consequences

- This amends ADR 0070's consequences: the left pane now shows text drawn
  from the student's own prompts, not only labels the agent chose. It goes
  only to the owner's screen, as the chat itself does, and the hook
  scripts still read no prompt.
- Any process in the workspace can post a title, as it can post a state.
  It changes only the student's own screen.
- A workspace agent restart forgets every title until each chat's next
  result or rename.
- If Claude Code changes how it stores titles, rows fall back to the tab
  name rather than breaking.

## Rejected

- **A title column in the database.** It would copy prompt-derived text
  into Portikus storage and drift from Claude Code's own title.
- **Asking a model for a summary.** It costs a call per chat, and Claude
  Code already writes one.
- **Sending `/rename` as a chat message from the pencil.** It would put a
  message in the conversation the student did not type.
