# 0078. API keys for administrators and instructors, with renewable expiry

- **Status**: Accepted (Epic 68)
- **Date**: 2026-11-15
- **References**: SPEC.md sections 5.1, 20.4, 24.1, 24.8, 24.11 and 24.13; ADR 0048, ADR 0049, ADR 0053, ADR 0077, ADR 0079

## Context

A coding assistant should be able to run some operations an administrator
or instructor runs in the browser. Portikus signs people in with cookies
and, for Dex local-password accounts, a second factor, neither of which a
program can use. It needs a credential a person makes, limits, and can end,
which does not become a quiet permanent way in. Prior art for expiring
tokens differs. GitHub and Azure DevOps "regenerate" an expired token with
a new secret. Okta extends a token's 30 days each time it is used. Kerberos
renews a ticket only while it is still valid.

## Decision

1. **Format and storage.** A key is `portikus_` plus 32 random bytes in
   base64url. Only its SHA-256 is stored, with a short display prefix. The
   secret is shown once, when the key is made or rotated.
2. **Who and what.** Only administrators and instructors, whatever the
   source of their role. Students never. A key has one scope, `read`,
   `write` or `destructive`, as one ordered level over the catalog's risks
   (ADR 0077). Keys are made, renewed and revoked only in a signed-in
   browser, never by a key.
3. **Three states.** Active, expired (stopped, but its owner can renew it)
   and revoked (final). Single-sign-on (SSO) and course-launch accounts get
   30-day keys only. Dex local-password accounts choose 7, 30 or 90 days or
   never, with 30 the default.
4. **Renew keeps the secret.** Renewing restarts the key's own period and
   needs a signed-in staff session. The role it checks is the one
   recorded at that session's sign-in, which for a role the identity
   provider gives is at most 12 hours old (SPEC.md section 24.13); renewal
   does not ask the provider again. We chose to keep the secret, unlike GitHub and Azure
   DevOps, so an instructor who teaches again months later signs in, clicks
   Renew, and changes nothing in their client's settings. **Rotate**
   (renew with a new secret) is the escape hatch for a key that may have
   leaked, and it needs the same code or passkey as making a key, for a
   Dex local-password account only. A daily worker job reminds owners 7 days ahead, 1 day for 7-day
   keys.
5. **Ending keys.** An administrator may expire or revoke one key, one
   person's keys or every key. A person's keys are also revoked when an
   administrator disables them (which includes removing their password
   account), when their password or second factor is reset (a
   forgot-password reset included), when an administrator changes a Dex
   account's email, when an administrator demotes them to student, and
   when the sign-in sync from the identity provider or the LMS lowers them
   to student (audited with actor `identity-provider`, reason
   `role_removed`).
6. **A removed role is not noticed until the next sign-in.** A role
   taken away at the provider, which Portikus has not yet seen, leaves
   keys working until they expire or the person next signs in. For SSO
   and course-launch accounts that is at most 30 days from the last
   renewal, because renewal needs a signed-in session and the person can
   no longer make a new one. Disabling the person in Portikus ends their
   keys at once. Accepted.
7. **Creation and rotation need a second factor for Dex local accounts
   only.** A code or a passkey is checked in the create dialog and when a
   key is renewed with a new secret, because those are where a stolen
   session could mint a lasting credential. SSO and launch
   sessions have their second factor at the provider and add no check.
   The gap this accepts: a stolen SSO session can make a key.
8. **Staff invitations need a destructive key.** A write key may invite
   students. Inviting an instructor or administrator creates an account that
   outlives the key, so it needs `destructive`.
9. **Every key request is audited.** One `api_key.used` row for each
   request, reads included, with the operation name and result. Audit rows
   also record `via` and `api_key_id`. **One exception:** a request refused
   by the per-key limit of 300 a minute writes no row, because a runaway
   client could otherwise fill the table; only the first refusal for each
   key in each minute is a log line. This bends the rule that every key
   request is audited, on purpose.

## Consequences

- A leaked read key shows an attacker what the owner could read, for at
  most the key's period. Rotating ends the old secret at once.
- Keeping the secret on renewal means a leaked, expired key can be renewed
  by its owner, not by the thief, who has no session. An owner who suspects
  a leak must rotate or revoke; a plain renewal does not help.
- A key skips the second factor at use. That is the price of a credential a
  program can hold, and why scope, the never list and revocation matter.
- A key with no expiry, offered only to Dex local accounts, can outlive the
  person's need. The guides tell administrators to review such keys.

## Alternatives rejected

- **Regenerate with a new secret on every renewal.** Safer, but it breaks
  every client that holds the old key, which is the common case.
- **Extend on use (Okta).** A stolen key that is used often never expires.
- **OAuth in front of the API.** Heavy for a handful of staff, and a fixed
  bearer header is what Claude Code and Codex already accept (ADR 0079).
