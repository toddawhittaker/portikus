# 0053. Sign-in counters live in PostgreSQL, and a recovery code or passkey gets past the account lockout

- **Status**: Accepted (Epic 36). Supersedes in part ADR 0048 (where the
  second-factor counts are kept).
- **Date**: 2026-10-06
- **References**: SPEC.md section 24.13; ADR 0048; issue #1192

## Context

The sign-in limits in SPEC.md section 24.13 (sign-in starts and password
posts per address, password failures per account, the second-factor
counts per 10 minutes and per day, and the password-change form) are
kept in API memory. A restart of `portikus-api` clears them, so an
attacker who can cause or wait for a restart gets fresh guesses.

The daily second-factor lockout has a second problem. Anyone who knows a
login can spend its 30 daily wrong codes and lock the real holder out
for the day, even though the holder has a recovery code.

## Decision

1. **One table.** Migration 0040 adds `signin_counters(scope, key,
   window_started_at, count, reported)`, keyed on `(scope, key)`, with
   an index on `window_started_at`. The windows stay fixed, as today.
   Each hit is one atomic `INSERT ... ON CONFLICT DO UPDATE` that
   restarts a stale window and returns the count and whether the first
   refusal was already logged. Giving a count back is a conditional
   decrement.
2. **Keys are plain text**: an address key or a login, the same values
   audit rows already hold. Rows live at most a day; a worker loop
   deletes rows whose window ended more than a day ago.
3. **What moves.** The sign-in throttle, the second-factor counts and
   the password-change count share one stored counter with the same
   hit, give-back and first-refusal behaviour as before. Passkey
   challenges, socket caps and the per-address limit on public routes
   stay in memory: losing them on a restart only means a retry, and a
   database write per request would cost more. The in-memory per-address
   limit runs first, so a flood is refused before it reaches the
   database.
4. **Recovery-code and passkey bypass.** When the account count refuses a second
   factor, a code shaped like a recovery code is still checked. These
   checks are counted per session, 10 in 10 minutes, so an attacker's
   sessions cannot use up the holder's. A recovery code carries about
   79 bits, so guessing one is not a risk. The refusal text says a
   recovery code still works. The same applies when an account is
   linked.
5. **Passkeys** get the same bypass and the same per-session count,
   since a passkey cannot be guessed (Todd, 2026-10-06).

## Consequences

- Counts survive an API restart; a smoke check proves it.
- Every counted request writes one row. That is fine at sign-in rates
  and is why only the sign-in counts moved.
- An attacker can no longer lock a holder out of their own account for
  the day.
- Counting from `audit_events` was rejected: audit rows are written
  after Dex answers, and sign-in starts are not audited.
