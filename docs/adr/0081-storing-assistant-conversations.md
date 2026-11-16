# 0081. Assistant conversations are stored as data, as our own events, for 30 days

- **Status**: Accepted (Epic 69)
- **Date**: 2026-11-15
- **References**: SPEC.md sections 20.5, 24.1 and 24.9; STACK.md section 15; ADR 0012, ADR 0074, ADR 0080

## Context

The platform logs and stores no student prompt, answer or file (ADR 0012;
ADR 0074 keeps a student chat's title in memory). The assistant is
different: an administrator needs to return to a conversation, a card may
wait for a day, and an API restart must not lose it. Its text also holds
people's names and log lines.

## Decision

1. **PostgreSQL, as data.** Three tables: the conversation (owner, title,
   tokens used, last use), its events in order, and the approvals. A
   conversation is never written to a log (STACK.md section 15).
2. **Our own events.** The events are the chat's wire events, so the browser
   store reads them unchanged and a reconnect replays them. They are not the
   AI SDK's messages. The model's messages are rebuilt from the events
   before each step.
3. **Owner only.** Every query names the owner. No administrator route reads
   another person's conversation, and one that is not the caller's answers
   404. A person may delete their own.
4. **Thirty days.** A conversation goes 30 days after its last use. An
   hourly timer in the API deletes old ones and expires cards unanswered
   for 24 hours.
5. **Approvals are rows.** A card is claimed once by an update from
   `pending`, so a second tab, a replay or a restart cannot run it twice.
6. **Counts apart.** Token use is kept for each day, person, purpose and
   model, with no content, and outlives the conversation.
7. **Backups hold them.** Database dumps include the tables, so a backup
   keeps a conversation until that backup expires. The privacy notice and
   the administrator guide say so. No infrastructure change was made.

## Consequences

- An SDK upgrade never needs a data migration, since no SDK type is stored.
- A conversation's tool results can hold real names, so the 30 days, the
  owner filter and the notice are the controls; backups are the gap.
- A restart closes a turn it left running as interrupted, and no card is lost.
- Deleting an account deletes its conversations.
- Nothing is searchable across people. A support request to read a
  conversation has no answer in the product.

## Alternatives rejected

- **Memory only, like the student chat.** A pending card and a long
  diagnosis would vanish on a restart, and two API processes could not share
  a conversation.
- **The SDK's message format.** It changes with each major version and would
  tie our database to a library.
- **Logs.** Logs are redacted and kept for other purposes, and the rule
  against prompts in them is the one this decision keeps.
- **Visible to every administrator.** It would turn one person's questions
  about students into a record the others could read.
- **Longer retention.** Nobody needs a month-old conversation to act now, and
  every added day is more student data held.
