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

The daily second-factor lockout has a second problem. Anyone who knows
the password can spend the account's 30 daily wrong codes and lock the
real holder out for the day, even though the holder has a recovery code
or a passkey. The holder's lockout notice tells them to change their
password, because whoever spent the codes knows it.

## Decision

1. **One table for guesses.** Migration 0040 adds `signin_counters(scope,
   key, window_started_at, expires_at, count, reported)`, keyed on
   `(scope, key)`, with an index on `expires_at`. The windows stay
   fixed, as today. Each hit is one atomic `INSERT ... ON CONFLICT DO
   UPDATE` that restarts a stale window and returns the count.
2. **Fail closed.** If the counter cannot be read or written, the
   request is refused with 503 `SERVICE_BUSY`. It is never let through.
3. **Receipts.** `hit` returns a receipt: scope, key and window start.
   `giveBack` takes the receipt and decrements only if this request's
   hit was counted and the window has not changed. A request can give
   back only its own count.
4. **One audit row per refusal.** The first-refusal flag is set by a
   separate `UPDATE ... SET reported = true WHERE reported = false
   RETURNING 1`, so concurrent refusals audit once.
5. **Keys are plain text**: an address key or a login, the same values
   audit rows already hold. The API deletes rows once `expires_at`
   has passed; the worker has no rights on the table.
6. **What moves.** Only guess counts: password posts per address,
   password failures per account, the second-factor counts and the
   password-change count. Sign-in starts stay in memory, because a
   start is not a guess and a flood of starts would otherwise be a flood
   of database writes. Passkey challenges, socket caps and the
   per-address limit on public routes also stay in memory: losing them
   on a restart only means a retry. The in-memory per-address limit runs
   first, so a flood is refused before it reaches the database.
7. **Recovery-code and passkey bypass.** When the account count refuses
   a second factor, a recovery code or a passkey is still checked. The
   code check looks at recovery codes only, never time-based codes. A
   recovery code carries about 79 bits and a passkey cannot be guessed
   (passkeys ruled by Todd, 2026-10-06). The bypass path gets no
   receipt for the account counts, so nothing on it can give a count
   back. Its tries are counted per session, 10 in 10 minutes, in
   memory, so an attacker's sessions cannot use up the holder's. Wrong
   bypass codes are still audited as `auth.second_factor_failed`. The
   refusal text says a recovery code or passkey still works. The same
   applies when an account is linked.

## Consequences

- Guess counts survive an API restart; a smoke check proves it.
- A database outage refuses sign-in guesses rather than allowing them.
- Every counted request writes one row. That is fine at sign-in rates
  and is why only the sign-in counts moved.
- An attacker can no longer lock a holder out of their own account for
  the day.
- A known-device exemption from the code counts was considered and
  left out.
- Counting from `audit_events` was rejected: audit rows are written
  after Dex answers, and sign-in starts are not audited.
