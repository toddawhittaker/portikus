# 0069. The Claude Code (GUI) chat tab

- **Status**: Accepted (Epic 58)
- **Date**: 2026-11-07
- **References**: SPEC.md sections 8.3, 9.7, 10.1, 10.2, 10.8, 24.1, 25.8, 25.10 and 26; STACK.md sections 10, 15 and 35; ADR 0012, ADR 0068

## Context

Students use Claude Code in a terminal. A chat view shows its replies as
formatted text, shows permissions and questions as cards, and takes images.
Portikus must not read or keep prompts, replies, files or images (STACK.md
section 15, ADR 0012), and must not depend on undocumented behaviour of the
agent.

## Decision

1. **The Claude Agent SDK drives the shared CLI.** The chat host calls the
   SDK's `query()` with `pathToClaudeCodeExecutable` set to the unmodified
   Claude Code the image already ships (SPEC.md section 10.1). The SDK is
   pinned exactly, and its optional per-platform binaries are ignored and
   checked absent at package time. Rejected: Claude Code's raw stream-json
   mode (we would re-implement its undocumented permission control
   protocol), ACP through `claude-agent-acp` (a third-party layer on the same
   SDK), and a hook-only question card (it cannot render a chat).
2. **The host runs in the tab's own tmux session.** A small chat host, shipped
   with the workspace agent, is the command of `pk-<id>`, as an agent
   terminal's CLI is. It survives a workspace-agent restart, keeps the
   terminal unit's limits and ends with the tab. It talks to the API through
   a private socket, and the API relays frames without reading them. The
   record is a `terminals` row with `kind = 'chat'` (migration 0052).
3. **Terms: offered for every sign-in.** The chat is offered whether the
   student signs in with a subscription or an API key. Anthropic's legal page
   allows an end user to sign in to the unmodified Claude Code binary with
   their own subscription, including where a platform hosts Claude Code.
   Anthropic's Agent SDK overview forbids third-party products from offering
   claude.ai login unless approved. We rely on the first sentence: Portikus
   never handles Claude credentials, the student signs in through
   Anthropic's own flow inside their workspace, and the binary is the
   unmodified one. **Risk:** Anthropic may read the two texts the other way
   and ask us to stop offering the chat to subscription sign-ins. The
   remedy would be to hide the launcher for them; nothing else depends on it.
4. **Owner-only holds at the API, not against same-user processes.** Only
   the project's owner may attach; administrators, instructors, share viewers
   and live-help helpers are refused, and a helper does not see the tab. The
   host's socket is in a 0700 directory owned by the student, which is
   enough against other users but not against another process running as the
   same student in the workspace. That process already has the student's
   files and terminals, so this is accepted (SPEC.md section 24.2).
5. **Nothing is logged or stored.** History lives only in Claude's own
   transcripts in the workspace. On attach the host replays recent turns as
   events with their real times. Resume records only the chain of Claude
   session ids in `~/.local/state/portikus/chat-sessions/<tabId>`.
6. **Untrusted Markdown, bypass offered, images shrunk.** Assistant Markdown
   is cleaned before display. Bypass permissions is offered with a visible
   warning. The browser redraws large images to at most 2000 pixels and 5 MiB
   before upload.

## Consequences

- A real Claude turn has not been run on a VM, because there was no login;
  the host's real-CLI test and a smoke check that sends no prompt cover the
  rest.
- Running a GUI and a TUI on one session at once is not prevented; Help says
  not to.
- The SDK adds about 5.5 MB to the .deb and a dependency to keep current
  against the CLI the image installs.
