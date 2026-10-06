# 0049. Only an invitation admits an SSO account, matched per provider

- **Status**: Accepted (Epic 34)
- **Date**: 2026-10-04
- **References**: SPEC.md section 24.13; issues #1136, #1132

## Context

On the open internet nobody may sign themselves up. Before Epic 34, any
person a connector let through got an account at first sign-in, for
example anyone in a listed Google domain.

## Decision

Only a Portikus invitation creates an SSO account, for every provider,
always; there is no setting to turn it off. An administrator invites a
person in the Users view or through CSV upload. At first sign-in the
invitation is matched on something the person cannot choose:

- **Entra**: the user principal name (UPN, sent as `preferred_username`).
  Entra sends no `email_verified` claim, but the tenant's administrators
  set the UPN and keep it unique in the tenant.
- **LDAP**: the username or the email, both set by the directory's
  administrators.
- **Google and generic OIDC**: the email, and only when the provider says
  it is verified.

Anyone not invited sees a refusal page and is audited as a failed
`auth.login` with reason `not_invited`. Dex passwords and LTI enrolments
were already made by administrators and are unchanged.

## Consequences

- Every SSO person must be invited before their first sign-in.
- The provider's name replaces the invited name at first sign-in.
- Under Google or generic OIDC, admission is only as strong as the
  provider's own email verification.
