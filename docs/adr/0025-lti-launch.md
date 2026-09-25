# 0025. LTI 1.3 launch: state row and per-login cookie, file-registered platforms, and the instructor role

- **Status**: Accepted
- **Date**: 2026-09-23
- **References**: SPEC.md sections 5.1, 5.2, 14.3, 24, 29 (Epic 13), 31;
  docs/archive/epics/EPIC-13.md; ADR 0008, ADR 0023

## Context

Students already work in the course site of a learning management system
(LMS) such as Canvas or Moodle. LTI 1.3 (Learning Tools Interoperability)
lets the LMS open a tool from a course. The launch is an OpenID Connect
sign-in in which the LMS signs an id_token (a signed JSON Web Token) that
names the person, their role and the course. Portikus needed to accept
that as a second way into the same session as Dex. It also needed a role
between student and administrator for the people who teach.

The launch is a cross-site form post, often from inside a frame. It meets
the browsers' third-party cookie rules and the control plane's "never
framed" rule head on.

## Decision

**Scope.** Only the core resource-link launch: third-party login at
`/lti/login`, the platform's form post to `/lti/launch`, and a public key
set at `/lti/jwks`. Grade passback, roster sync, Deep Linking and dynamic
registration are left out.

**Registration.** The operator lists platforms in a JSON file on the host,
`~/.config/portikus/lti-platforms.json`. Ansible copies it to
`/etc/portikus/lti-platforms.json` and checks it at install time by
running the API's own parser, so there is only one validator. A
registration is keyed by issuer and client id, because every Canvas cloud
site shares one issuer. An empty list is refused. No file means LTI is off
and `/lti/*` answers 404. The file holds no secret, and there is no
administrator UI.

**Identity.** An LTI user is stored under the issuer `lti:<platform
issuer>` and the LTI subject. Email is kept for the profile only. It is
never used to find or link an account, so a student who also has a Dex
account has two accounts.

**Validation.** Every check has its own reason code: RS256 only, the
signature against the platform's keyset, a known issuer, the audience and
authorized party, expiry and issue time with 60 seconds of skew, the
nonce, the state, the deployment id, the message type, the version, a
target link on our origin, and a subject. No database transaction is held
open while the keyset is fetched.

**State.** `/lti/login` stores a row keyed by the SHA-256 hash of a random
state. The row holds the nonce and expires in 10 minutes. The login also
sets a cookie that carries the state, named
`__Host-portikus_lti_state_<first 16 hex characters of sha256(state)>`,
with `Path=/`, `Secure`, `HttpOnly`, `SameSite=None` and a 10-minute
lifetime. `/lti/launch` needs the form's state to match both the cookie and
an unexpired row, and deletes the row, so state and nonce are single use.

- The row makes the nonce single use. The cookie ties the launch to the
  browser that began it, which stops a login forgery.
- `SameSite=None` is needed because the platform's post is a cross-site
  top-level request.
- The `__Host-` prefix, not `__Secure-`, because a preview subdomain could
  plant a `__Secure-` cookie for the parent domain (SPEC.md section 14.3).
- One cookie per login, so two launches in one browser do not clash.

**Frames.** Caddy keeps `frame-ancestors 'none'` everywhere except
`/lti/*`. `/lti/login` and `/lti/launch` send `frame-ancestors *`. Canvas
cloud frames the tool from the school's own host while its sign-in URL is
`sso.canvaslms.com`, so no list built from the registrations would match.
When either route is framed, it only renders a small page. At login, the
page has a button that reopens the login in a new tab. At launch, it
refuses and asks the student to open Portikus again. Nothing that grants a
session is ever served in a frame. `/lti/jwks` keeps
`frame-ancestors 'none'`.

**After the launch.** The API creates the normal session and answers 303
to the path and query of the target link. It falls back to `/` unless the
path begins with exactly one slash, which closes an open redirect through
a `//host` path.

**Roles.** A new `instructor` role. LTI gives it only for the LIS
membership roles Instructor, TeachingAssistant and ContentDeveloper, their
sub-roles under Instructor or ContentDeveloper, and their bare short
forms. It also gives it for Administrator under the institution, system or
membership vocabularies. The institution role Instructor and
`Learner#Instructor` give `student`, as does anything unknown. LTI never
grants `administrator`. The role is refreshed on every launch.

Dex users can be instructors too, through the group named by
`OIDC_INSTRUCTOR_GROUP` (default `portikus-instructors`). `make
users-deploy` ends a user's sessions on any role change. An instructor has
a student's rights plus a read-only Course page listing who has launched
from each of their courses.

**Audit and logs.** Each launch writes an `auth.login` row with the
method, platform, role or reason code, IP address and user agent. A role
change writes `user.role_changed`. Refusals for a missing state cookie or a
frame are logged but not audited, since anyone can cause them. No token,
state, nonce, login hint or roster data is ever logged.

**Testing.** A mock LMS lives in `packages/mock-lms`. No app depends on
it, so the Debian package never contains it, and a build guard checks
that. It runs only on the operator's host and is trusted only while
registered. Its launch form carries a token made fresh for each process.

## Consequences

- A registration whose keyset is given by hostname needs the API's egress
  allow list widened (`PORTIKUS_API_IP_ALLOW`). A cloud LMS has changing
  addresses, so this weakens the API sandbox. A keyset-fetch proxy would be
  the stronger fix and is not built.
- Removing someone from a course in the LMS does not remove them from the
  Course page. That needs roster sync.
- The design assumes browsers send a `SameSite=None` cookie on a
  cross-site top-level POST. If that changes, launches fail closed with the
  refusal page.
- Rejected: a signed state cookie with no row, because it cannot make the
  nonce single use. A hand-off token after a framed launch, because a
  session-granting value would travel in a URL. A `frame-ancestors` list
  built from the registered sign-in URLs, because it does not match Canvas
  cloud.
