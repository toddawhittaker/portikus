# 0075. A terminal's AskUserQuestion is answered in the browser through a waiting PreToolUse hook

- **Status**: Accepted (Epic 63)
- **Date**: 2026-11-11
- **References**: SPEC.md sections 10.8, 24.1 and 24.2; STACK.md section 15; ADR 0012, ADR 0068, ADR 0069; issue #1762

## Context

When Claude Code in a terminal (TUI) tab calls AskUserQuestion, it draws
its own dialog in the terminal. The chat tab shows the same question as a
card the student answers with the mouse (ADR 0069), but a terminal tab had
nothing: a student watching another tab saw only "needs input".

Claude Code runs PreToolUse hooks before a tool call and waits for them.
A hook that prints `permissionDecision: "allow"` with an `updatedInput`
that carries `answers` makes AskUserQuestion return those answers without
drawing its dialog. A hook that prints nothing leaves the dialog to draw
as usual. Both were checked on Claude Code 2.1.322.

## Decision

1. **A waiting hook.** `portikus-agent-question` runs on PreToolUse with
   matcher `AskUserQuestion`. Unlike the other agent hooks it does not run
   in the background, and its timeout in the managed settings is the
   contract's limit, 30 minutes. It keeps only `tool_name`, `tool_use_id`
   and `tool_input`, posts them to `POST /coding-agent-question` on the
   loopback receiver, and waits. It prints the reply only on a 200, never
   writes to stderr, and always exits 0. curl gives up 5 seconds before
   the limit and the receiver 10 seconds before it, so the hook, not
   Claude Code, ends the wait.
2. **Chat tabs are skipped.** The chat host sets `PORTIKUS_CHAT_TAB`, which
   its Claude Code inherits, and the hook exits at once when it is set. The
   chat answers its own questions.
3. **One question per terminal, shown on the status path.** The workspace
   agent holds at most one waiting question per terminal, in memory, and
   adds it as `question` to that terminal's coding-agents entry, which only
   the owner receives (ADR 0068).
4. **Answers come only through the API.** The browser's answer goes to the
   API, which checks that the caller owns the workspace, and then to
   `POST /terminals/:id/question` on the agent's authenticated port. The
   agent builds the hook's reply itself, with the same `answers` and
   `annotations` shape the chat sends. The loopback receiver has no answer
   route.
5. **Anything else asks in the terminal.** The receiver replies 204, and
   Claude Code draws its own dialog, when the student picks "Answer in the
   terminal", the tool is not AskUserQuestion, the questions do not fit the
   contract, the terminal is not open or already has a waiting question,
   too many terminals or too many bytes of questions are waiting, or the
   wait ends. If the hook's connection drops,
   the question is cleared.
6. **Questions and answers are never logged or stored.** No audit row,
   and the routes log only status codes and ids.

## Trust

The loopback post is unauthenticated, as every loopback route is
(ADR 0068 item 5). A forged post can only show the owner a question card
on their own screen; it is capped at 64 KiB, 4 KiB per string, one per
open terminal, and 512 KiB held across all terminals, so the status frame
stays under the API's 1 MiB cap. A workspace process can post a made-up
question for an open terminal and the student would see a card; this is
accepted, as it is the same trust as a process writing to that terminal. It cannot
answer a question, because answers arrive only on the authenticated port,
from the API, for the owner. A secret per terminal would not help: every
process in the terminal, the student's own code among them, could read it
from the environment the hook reads it from.

## Consequences

- Claude Code waits on the hook while the card is open, as it would wait
  on its own dialog. The student can still answer in the terminal by
  picking "Answer in the terminal" on the card.
- A workspace agent restart drops the hook's connection, so Claude Code
  shows its own dialog.
- If Claude Code stops honouring `updatedInput` for AskUserQuestion, the
  answer is lost and the student answers again in the terminal.

## Rejected

- **Reading the dialog off the terminal's screen.** Portikus never reads
  terminal output (ADR 0012), and the dialog's layout is not a contract.
- **Answering on the loopback port.** Any process in the workspace could
  then answer the student's questions.
- **A per-terminal token on the hook's post.** Every process in the
  terminal can read it, so it would prove nothing.
