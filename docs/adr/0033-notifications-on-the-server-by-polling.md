# 0033. Notifications live on the server, and browsers poll for them

- **Status**: Accepted
- **Date**: 2026-09-25
- **References**: SPEC.md sections 8.5 and 24; STACK.md section 15;
  ADR 0012; issue #475

## Context

Toasts were the only record of what Portikus told a user. Warnings and
errors stayed until dismissed and piled up; other toasts vanished after
five seconds with no trace. Every toast now times out, so the message
needs a second home: a notification history with an unread count. Two
choices shape it: where the history is kept, and how a second browser
learns that the first one read something.

## Decision

The history is a `notifications` table in PostgreSQL, one row per toast
shown, recorded by the browser through `POST /me/notifications` and read,
marked read and cleared through the other `/me/notifications` routes.
Each user keeps at most 200 rows and none older than 90 days; the API
trims a user's rows as it records one, and the worker prunes every hour.
Recording is rate-limited per user and the title and body are capped in
length. Neither is ever logged.

Browsers poll `GET /me/notifications` every 30 seconds and again when
the window regains focus. There is no push channel.

## Consequences

- The history follows a student to any browser or device, like the rest
  of their settings, and the whole-database backup covers it.
- A read on one device reaches another within 30 seconds, or at once
  when that window is next focused.
- Rejected: browser storage (`localStorage`). It is simpler, but the
  history would stay on one machine, and a lab computer shared by many
  students would keep one student's messages for the next.
- Rejected for now: a push channel over the workspace socket or
  server-sent events. It would make the badge instant, but it adds a
  second delivery path to keep correct for a count that tolerates a
  30-second delay. Revisit if polling proves too slow.
- A toast recorded while offline is lost from the history. The toast
  itself still shows, and the failure is not retried.
