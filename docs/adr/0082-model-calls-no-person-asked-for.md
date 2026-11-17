# 0082. Model calls no person asked for: a fixed pipeline in the API, off by default, behind notice version 2

- **Status**: Accepted (Epic 70)
- **Date**: 2026-11-17
- **References**: SPEC.md sections 20.5, 24.1 and 24.11; STACK.md sections 15 and 35; ADR 0012, ADR 0079, ADR 0080, ADR 0081

## Context

Until now Portikus called a model only when a person asked: a message in the
assistant, a Diagnose button, or a price check an administrator started or
the weekly timer ran on public pages. The assistant is useful for alerts too.
When a service stops, an administrator would like two plain sentences about
the likely cause beside the alert. Nobody is at the keyboard when an alert
fires, so no person can read the call first, and the text it sends is log
lines that students can influence. An alert storm could also spend the
token budget. Epic 70 adds this call. This record says how it is kept small.

## Decision

1. **A fixed pipeline, not an agent.** The call has no tools. Code collects
   what is sent: the alert, the newest health sample and the latest error
   log lines. The model picks nothing to read and no address to fetch. This
   is the shape of the price check (SPEC.md section 20.5), reused.
2. **It runs in the API.** A timer with an advisory lock, like the other AI
   timers (ADR 0080, decision 7). The worker gets no AI key. The worker's
   alert forwarder only reads the explanation the API stored.
3. **Off by default, behind consent.** An **Explain alerts** switch on the AI
   page is off on every site, including a site that already has the assistant
   on. The privacy notice moves to version 2 to say so, so after an upgrade
   the assistant pauses until an administrator accepts it. Pausing every AI
   feature, not just this one, is the price of a notice that has one version.
4. **Bounded.** One explanation for each alert title in an hour. A daily
   maximum an administrator sets (5 by default), counted from the database,
   not from memory. About 5,000 input and 300 output tokens for each call.
   The tokens count against the shared monthly cap as purpose `triage`, with
   no person. Dollars are shown but never used as a limit.
5. **Plain text.** The answer is cut near 400 characters and stored and shown
   as text, never Markdown. A log line that steers the model cannot make the
   page draw a link or an image. The label says an AI wrote it.
6. **Forwarding is a second switch.** Email and Pushover leave the site, so
   adding the explanation to them is its own switch, off by default. When on,
   the forwarder waits up to 60 seconds for the explanation and then sends
   the alert with or without it. An alert is never held longer or changed.
7. **Audited as the system.** One audit row for each explanation, actor
   `system`, holding no alert text, log line or answer.
8. **The weekly digest stays code only.** It needs no model: the numbers are
   already in the database, and a model would add cost and a way to be wrong
   to a summary that should be dull and exact. It makes no model call, needs
   no key, and is not behind the notice.

## Consequences

- Version 1 acceptances stop counting. The pilot's upgrade note must say an
  administrator re-accepts the notice.
- An explanation can mislead. The page labels it, the alert and logs sit
  beside it, and it can change nothing.
- A student who can write a log line can try to steer an explanation. That is
  an accepted risk, limited by plain text, no tools and the label.
- Two more switches and a daily maximum are settings an administrator may
  need to find; the AI page keeps them together.
- Any further unasked call needs its own record. This one is not a
  precedent for a model that acts.

## Alternatives rejected

- **A worker job with the AI key.** The worker is the process that talks to
  the outside world for alerts, so it is a bigger target. Keeping the key in
  the API only (ADR 0080) is worth a 60-second wait in the forwarder.
- **An agent with read tools, as in Diagnose.** It would pick what to read
  and could be steered into reading more. A person watches a Diagnose
  conversation; nobody watches this call.
- **On by default for sites with the assistant already on.** A site that
  consented to answers for people did not consent to log lines sent when
  nobody asked.
- **A dollar limit.** Portikus cannot know every model's price, so a dollar
  limit would be wrong in the dangerous direction for a model without a row.
- **Triage for every alert, with no daily maximum.** An alert storm would spend
  the month's tokens and send the provider a stream of log lines.
- **A model-written weekly digest.** More cost and more room for error than
  the plain numbers need.
