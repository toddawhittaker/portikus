# 0073. The chat host runs a `!` command itself, as the student, within limits

- **Status**: Accepted (Epic 59)
- **Date**: 2026-11-09
- **References**: SPEC.md sections 10.8, 12.5 and 24.1; STACK.md section 15; ADR 0012; ADR 0069; issue #1839

## Context

In the terminal Claude Code, a message that starts with `!` is bash mode:
Claude Code runs the command with no model and adds the command and its
output to the conversation, so Claude sees them with the next message.
The Agent SDK has no bash mode of its own. Sent through the SDK as an
ordinary message, `! ls` reached the model as a request, which answered
with a Bash tool call: slower, billed, and behind a permission card. The
SDK does let a client append a user message to the transcript without
starting a turn (`shouldQuery: false`); it documents that as how Claude
Code Desktop does bash mode.

## Decision

1. **The chat host runs it.** When a sent message, after leading spaces,
   starts with `!` and has more than the `!`, the host does not send it to
   the model. It runs the rest with the student's login shell
   (`$SHELL -lc`, else `/bin/bash`) in the tab's project folder, the same
   folder the session uses. The composer and the host share the rule
   (`isShellCommand` in `@portikus/contracts`).
2. **The transcript gets what Claude Code itself writes.** Two user
   messages with `shouldQuery: false`: `<bash-input>command</bash-input>`,
   then `<bash-stdout>output</bash-stdout><bash-stderr>note</bash-stderr>`.
   The output is standard output and standard error together, in the order
   written. The note says the exit code when it is not 0, that the command
   was stopped at the time limit, or that the output was cut. Each append
   makes the SDK report one empty result; the host counts them so they end
   no turn. On reattach the pair is replayed as one shell item.
3. **Limits.** Two minutes, then the whole process group is killed and the
   exit code is shown as none. At most 65,536 characters of output are kept
   (`MAX_CHAT_SHELL_OUTPUT_CHARS`); the rest is read and dropped so the
   command is not stalled, and the item is marked truncated. A background
   job the command leaves behind is killed when the shell exits. A command
   over 4,000 characters is refused.
4. **One thing at a time.** A `!` command is refused while Claude is
   working, and a message is refused while a command runs, each with an
   error on the sender's chat view, the way the host already refuses a
   send it cannot take. Steering a running turn with a command would put
   the output in the middle of Claude's work, which the terminal does not
   do either.
5. **Never logged.** Neither the command nor its output is logged (ADR
   0012, STACK.md section 15). They go only to the chat views and the
   student's own transcript.

## Trust boundary

The chat host is a process of the workspace user, inside the student's
own container (SPEC.md section 24.1, ADR 0069). The command runs as that
user with exactly the rights the student's own terminal tab has: the same
files, the same network rules, nothing more. No new privilege, socket or
route is added; the `send` frame already reaches the host only from the
workspace's owner. The platform does not commit, branch or stash on the
student's behalf (SPEC.md section 12.5); a command the student types may,
as it may in their terminal.

## Alternatives rejected

- **Send it to the model, as before.** Every `!` became a billed turn and a
  permission card, and Claude, not the shell, chose what ran.
- **Run it in a hidden terminal pane.** It would need a pane, a reader for
  its bytes and a way to tell when it ended; a child process of the host
  gives the output and the exit code directly.

## Consequences

- `!` costs nothing and needs no permission card, as in the terminal.
- A command that waits for input reads end of file, since standard input
  is closed; an interactive program belongs in a terminal tab.
- `claude --resume` in a terminal sees the same commands, because the
  transcript holds them in Claude Code's own form, and commands run there
  in bash mode replay in the chat.
- If a later SDK starts a turn for each append, or stops reporting an
  empty result for one, the real-CLI test in `claude-real.test.ts` fails.
