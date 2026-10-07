# 0048. The second factor is built inside Portikus, not in Dex

- **Status**: Accepted (Epic 34). Superseded in part by ADR 0053, which
  moves the second-factor counts into PostgreSQL and lets a recovery
  code or passkey past the daily lockout.
- **Date**: 2026-10-04
- **References**: SPEC.md sections 5.1 and 24.13; issues #914, #1135

## Context

Every Dex local-password account must have a second factor before a site
faces the internet. Dex has multi-factor support only in unreleased code,
and the pinned Dex (v2.45.1) has none for its own passwords.

## Decision

Todd ruled on 2026-10-04 that Portikus builds the second factor itself.
After Dex accepts the password, Portikus asks for a time-based code
(TOTP), a passkey (WebAuthn), or one of ten single-use recovery codes.
It is a session gate on the same list as "must change password". TOTP
secrets and recovery codes are sealed with their own key,
`/etc/portikus/second-factor.key`, which backups carry, so factors
survive a rebuild and do not depend on the session secret. Wrong codes
count per account, with one counter for sign-in and linking. An
administrator may reset a person's factor, and the holder is always told.

## Consequences

- Dex-password accounts get the same factor screens on every site. SSO
  accounts rely on their provider's own factor.
- The counters and passkey challenges live in the API's memory, so they
  assume one API process and reset on restart.
- Moving to Dex's own multi-factor later would mean everyone enrols
  again, because Dex cannot read Portikus's sealed secrets.
