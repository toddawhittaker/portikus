# 0064. Emailed reset and invitation links, roles from Google groups and Entra group IDs, and a passkey at link confirm

- **Status**: Accepted (Epic 50)
- **Date**: 2026-10-12
- **References**: SPEC.md sections 5.1, 5.3, 20.1, 24.8, 24.11, 24.13 and 26; ADRs 0049 and 0052; issues #1247, #1248, #1249 and #1293

## Context

People who forgot a Dex password had to ask an administrator, who read a
one-time password out to them. Invitations could not be emailed, and an
administrator could not fix a Dex user's email or username. Google sites
could not take roles from Google groups, and Entra sites could take roles
only from app roles. Confirming a course account link asked for a code
even when the SSO account had a passkey.

The site already had a mail sender: the SMTP (mail server protocol)
settings kept for alerts (ADR 0052), sent through the egress proxy with
TLS required. Dex's `google` connector can already read Google groups
through the Admin SDK. Dex cannot change a password's email in place.

## Decision

1. **Account email is an explicit switch**, `settings.account_email_enabled`,
   off by default. Setting SMTP for alerts never emails students on its
   own. Mail reuses the alert sender; there is no new transport,
   settings file or egress host.
2. **Links.** A token is 32 random bytes in the URL fragment of a link
   built from `PUBLIC_URL`. Only its SHA-256 hash is stored, in
   `account_email_tokens` (migration 0049). A reset link lasts 30 minutes
   and an invitation link 7 days; each works once, and the one completion
   route accepts both kinds. A new link revokes only older links. Every
   credential or access change revokes all of an account's links: the
   holder's own password change, an administrator's password or
   second-factor reset, disable, enable and an email change. Sessions end
   and links are revoked before Dex is called.
3. **Reset requests** answer the same for every login and send in a
   detached task. Caps are per address (429), and per account and
   site-wide (silent); the site-wide cap counts only real eligible
   accounts. Completing a link ends every session and known-device
   cookie, starts no session, and never counts as a second factor. The
   install administrator is refused; `portikus reset-admin` stays its
   recovery. Dex's "Forgot your password?" link is always shown.
4. **Administrator email actions** live in the Users detail panel, with
   their email boxes unticked by default. An email change deletes the
   Dex password and creates it again under the same Dex user ID, so the
   account, its Dex subject and its workspace stay.
5. **Invitations are still required** (ADR 0049). Group membership never
   admits anyone; it adds defense in depth and sets roles, and is checked
   only at sign-in. Only groups administrators alone can change may map
   to a role, and nested groups feeding a role group must be invite-only
   too.
6. **Google groups** use Dex's own Admin SDK lookup with a write-only
   service-account key at a fixed path (root:portikus-dex, 0640). Group
   emails are stored in lowercase. The site job may write
   `/etc/portikus-dex` to place the key. `admin.googleapis.com` is allowed
   only in this mode.
7. **Entra group IDs, option A.** `entraRoleSource` is `appRoles` or
   `groups`. In groups mode the site sends "groups assigned to the
   application" and assigns only the three role groups to the app, so a
   token never overflows. There is no Microsoft Graph call and no new
   credential or egress host.
8. **A passkey at link confirm.** The link page keeps its own challenge
   store, bound to the course session, the purpose and the SSO user, and
   used once. The confirm may carry neither factor when none is owed; it
   answers 403 when one is owed and none is sent.
9. Google and Entra group modes ship with render and unit tests only.

## Alternatives considered

- **Entra option B, a Microsoft Graph lookup** for users in more groups
  than a token holds. It needs a new credential and egress host. Left as
  a follow-up; the same three group IDs carry over unchanged.
- **Sending account email whenever SMTP is set.** Rejected: an
  administrator setting up alerts would start emailing students without
  choosing to.
- **Self sign-up through emailed links.** Rejected; invitations stay the
  only way in (ADR 0049).
- **Tokens in the query string.** Rejected: they would reach Caddy's and
  the API's logs and the Referer header.

## Consequences

- Real mail delivery was tried only through a stand-in relay on the
  rehearsal VM, and Google and Entra group modes have not met a real
  tenant.
- Two sends in the same millisecond both stay valid, and a link whose
  mail failed stays in the table until it expires.
- A user in very many Entra groups needs option B before group mode can
  be used without "groups assigned to the application".
