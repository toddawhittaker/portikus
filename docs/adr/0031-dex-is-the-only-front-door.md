# 0031. Dex is the only sign-in front door, with a local administrator made at install

- **Status**: Accepted (Todd, 2026-09-25); not yet built
- **Date**: 2026-09-25
- **References**: SPEC.md sections 5.1, 5.2 and 24.11; docs/archive/epics/EPIC-14.md
  rulings 1 to 3, 6, 13 and 15 to 18; docs/EPIC-15.md rulings 3, 14, 15
  and 20; ADR 0023; ADR 0028 (first-administrator part superseded)

## Context

After Epic 14 a site can sign people in seven ways: Dex alone; Dex in
front of LDAP, Microsoft Entra ID or Google; or Entra, Google or any other
OIDC provider directly, with no Dex. Entra and Google each work two ways.
A new site's first administrator can arrive three ways: a setup code
claimed by a signed-in SSO account, a first-account form on `/setup` for
standalone Dex, or (proposed in #535) an account made at install.

Two wanted features only work when Dex is present: a local administrator
account that still works when the institution's sign-in is broken, and
setting up SSO from the admin area instead of the command line. With
three direct-provider shapes, each would be built twice or left out for
some sites.

## Decision

Portikus signs people in through Dex only, plus LTI launches. Every
institution provider is one Dex connector: `microsoft` (Entra), `google`,
`ldap`, or Dex's generic `oidc` connector (Okta, Keycloak, Shibboleth's
OIDC plugin). Dex's own passwords are always on. The API's direct Entra,
Google and generic OIDC paths are removed; its one issuer is Dex.

Every install has a local administrator account in Dex. Setup creates it
with a random password unique to that install (at least 80 random bits),
prints the password once, and stores only its bcrypt hash. Portikus holds
a "must change password" flag and, while it is set, shows that account
only the change-password form. The same account is the way back in when
the institution's sign-in fails. A root command on the host,
`portikus reset-admin`, sets a new random password, sets the flag, ends
the account's sessions and prints the password; it recreates the account
if it was removed. It replaces the setup code, `/setup`, its claim flow
and the first-account form.

Roles under Entra come from Entra security groups, which Dex's
`microsoft` connector passes on in `groups`, or from grants in the Users
view. Two-factor sign-in stays the institution's: Dex sends each person
to their provider, which asks for the second factor under its own rules.

## Consequences

- One front door: one issuer, one set of egress rules for sign-in (Dex's),
  one first-administrator path and one recovery path.
- Setting up SSO in the admin area can manage Dex connectors only, through
  Dex's API, with the local administrator as the way back from a mistake
  (docs/BACKLOG.md, "Sign-in setup in the admin area").
- The local administrator is a password-only account: Dex at the pinned
  version has no second factor for its own passwords. Mitigations: a long
  generated password, the existing sign-in throttle, and an audit row for
  every sign-in to it.
- Portikus cannot read Entra app roles, and cannot see whether a second
  factor was used (Dex does not pass on the `amr` claim). The provider
  enforces two-factor sign-in, as is usual.
- Dex must be up for anyone to sign in except through LTI. It already is
  the default and runs beside the API.
- Code that landed in Epic 14 is removed: the direct-provider settings
  (`OIDC_PROVIDER` values `entra` and `google`, `OIDC_ALLOWED_TENANT`,
  `OIDC_ALLOWED_DOMAINS`), the setup-code table and routes, and the
  first-account form.
- A site already on direct Entra or Google would move its accounts to
  Dex subjects. No such site exists; the pilot runs Dex.
- Rejected: a fixed, published default password (whoever finds a new
  install first owns it, and several jurisdictions ban fixed default
  passwords in new products); keeping the direct paths beside Dex (every
  Dex-only feature built twice or missing for some sites).
