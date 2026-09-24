# 0026. Linking a course account to an SSO account, and a stored role grant

- **Status**: Proposed
- **Date**: 2026-09-24
- **References**: SPEC.md sections 5.2, 12.5, 20.1, 24; docs/EPIC-13-1.md;
  ADR 0025

## Context

Since Epic 13 a person can reach Portikus two ways: through the
institution's single sign-on (SSO), which speaks OpenID Connect (OIDC),
or by an LTI launch from a course. Each way creates its own account,
keyed by (issuer, `sub`), so a person who uses both has two accounts and
two workspaces. Nothing may join them by email, because an email from an
LMS proves nothing.

Separately, an account's role comes from the SSO provider's groups claim
on every sign-in. An administrator could not promote anyone in Portikus,
because the next sign-in would overwrite the change. Some providers
(Google) send no groups at all, and Entra sends group object IDs.

## Decision

**Linking.** A person links from the course account, within 15 minutes
of a launch, by completing a full OIDC sign-in (PKCE, state, nonce and
`prompt=login`) and then confirming on a page that names both accounts.
A server-side intent row, single use and bound to the course session,
carries the link through the callback. The callback in link mode never
creates or updates a user and never starts a session; an SSO identity
with no account is refused.

**The SSO account survives.** A link row maps the course account's
`users` row to the SSO account's row. Identities stay only in `users`,
unique by (issuer, `sub`). Later launches from the linked identity sign
into the SSO account. The course account is retired: its sessions end,
`loadSession` refuses it, and its workspace is archived through the
existing archive path. Unlink deletes the row and undoes that archive.
At most one course identity per LTI platform issuer links to an SSO
account.

**One role rule.** Each account stores the role its own sign-in gave
(`provider_role`: the groups claim for SSO, the LTI role for an unlinked
course account) and an optional `granted_role` (`instructor` or
`administrator`) stored by Portikus. The effective `role`, the one column
every check reads, is the higher of the two. A launch into a linked
account changes no role; the Course page is keyed on course membership,
not on the account role. This epic exposes only promote to administrator
and its undo, demote. A grant is refused on a course account. A launch
never starts a session for an administrator, because an LMS
administrator can act as any user in the LMS.

## Consequences

- Promotion works whatever the provider's groups look like, and a later
  Entra or Google epic can grant `instructor` without a migration.
- `make users-deploy` cannot remove a grant; only demote does.
- A role change takes effect on the target's next request, since the
  session check reads `users.role` every time.
- A fresh, stolen course session could link the victim's course identity
  to the thief's SSO account within 15 minutes of a launch. Accepted.
- Rejected: matching by email (proves nothing); refusing to link when the
  course workspace holds work (no honest cheap test, and the student
  could not fix it); a general identities table (moves every sign-in
  lookup for one feature); an admin-only boolean grant (Google would
  need another migration).
