# 0083. Side conversations in a chat tab

- **Status**: Accepted (Epic 74)
- **Date**: 2026-11-19
- **References**: SPEC.md sections 7.6, 10.2 and 24; STACK.md section 15; ADR 0012, ADR 0069, ADR 0076; issue #2110

## Context

A student watching a long turn often wants to ask a quick question about it
without disturbing it. Claude Code's `/btw` and Codex's `/side` do this in
their own terminals. In the chat tab, a message sent mid-turn steers the
turn, so there was no safe way to ask. The side conversation must see the
main conversation as it stands, must never add to it, and must not change any
file or run anything that does.

## Decision

1. **Claude.** The chat host calls the Agent SDK's `Query.askSideQuestion`,
   which has no tools and writes nothing to the transcript. It is not in the
   SDK's `sdk.d.ts`, so it bends ADR 0069's rule against relying on
   undocumented behaviour. We accept that, because the documented route,
   `query({ resume, forkSession: true })` with read-only tools, needs a second
   CLI (command-line) process, writes a session file, and reads the whole
   conversation again at the cache-write price, which costs students more.
   The call sits behind one wrapper in `sdk.ts`, a test against the real CLI
   pins it, and a CLI without it gets a clear error and no `btw` command.
2. **Codex.** The host calls `thread/fork` with `ephemeral` and
   `excludeTurns`, with a read-only sandbox and approval policy `never`,
   and forks again for each question. Earlier side questions and answers are
   injected, so a follow-up sees the main conversation as it stands. Read-only
   commands are allowed, as in Codex's own `/side`. Requests from a side
   thread are refused before any permission card is built.
3. **Read-only in the host.** A side question reaches only the driver's side
   method, which cannot open a permission card. The browser never sends a
   side message unless the host lists `btw`.
4. **Kept in memory.** The host holds the conversation and replays it to a
   browser that attaches. It ends on close, `/clear`, an agent swap, a host
   restart or a workspace stop. Nothing is written to disk or logged
   (ADR 0012). One side conversation per chat, one question at a time, on
   the main chat's model, because the prompt cache belongs to one model.

## Consequences

- A Claude Code update could remove `askSideQuestion`; the pinned test fails
  first and the command disappears until the wrapper is changed.
- A side question reads from the prompt cache of the main model, so it
  costs little while the cache is warm.
- A host restart loses the side conversation. We accept that for never
  keeping it on disk.

## Alternatives rejected

- **A node in the saved layout.** It would persist the conversation's
  place, let it be dragged to another tab, and change section 7.6.
- **A workspace file for side conversations.** It would keep student
  questions and answers on disk, against ADR 0012.
- **Codex with no shell tool.** It changes the tool list, which loses the
  prompt cache.
