# 0058. LTI roster sync through NRPS, and Deep Linking to a template or public repository

- **Status**: Accepted (Epic 42)
- **Date**: 2026-10-10
- **References**: SPEC.md sections 7.2, 7.6, 24.11 and 26; ADR 0025, ADR
  0026

## Context

The Course page lists only people who have launched Portikus, and people
who left a course keep their membership. Instructors also want an LMS link
that drops a student straight into a starter project. LTI offers both:
NRPS (Names and Role Provisioning Service) for the roster and Deep Linking
for links.

## Decision

1. **Sync in the API.** `POST /courses/:courseId/roster/sync` runs a
   sync, one in flight per course (a second request gets the running
   sync's answer). The hourly refresh is driven by the Course page, not by
   the API in the background: when the page opens and the last attempt is
   missing or more than an hour old, the page calls the same route, so the
   instructor sees the result. `roster_synced_at` is the last attempt,
   successful or not, and `roster_sync_result` says how it went, so a
   failing platform is also tried at most hourly. The platform registration gains an
   optional `authTokenUrl` (https, or http for the mock). Without it the
   Course page says sync is unavailable.
2. **Only `Active` roster members count.** A membership whose LTI subject
   is missing from the roster is deleted, instructors too, each audited as
   `course.member_removed` with `source: roster`. Accounts and workspaces
   are never touched. An empty roster or a failed page applies nothing and
   records the result on the course.
   - A sync that would leave the course with no launched instructor is
     refused before anything is written, with result `no_instructor`.
     This departs on purpose from the plain rule above: one bad roster
     must not lock every instructor out of the Course page.
   - The API reaches the token URL and the memberships URL through the
     egress proxy. Ansible allows each platform's keyset and token hosts;
     a memberships host that is neither must be added by the operator
     (`portikus_egress_extra_hosts`).
3. **Roles.** The roster changes only the course membership role; the
   account role changes at the next launch (ADR 0025).
4. **Not started.** Roster people with no account are kept in
   `lti_roster_members` (course, subject, display name, role; no email),
   replaced on each sync, and shown as "Not started". A membership's
   subject is its user's `oidc_subject` under `lti:<issuer>`, or the
   linked course account's (ADR 0026).
5. **Deep Linking picker.** The request gets a script-free picker page
   that creates no session or account. Only a role that maps to instructor
   may use it (`not_instructor` otherwise). The choice is a
   `PROJECT_TEMPLATES` template or a public `https` repository, and a
   project name. The signed response goes back through a "Return to your
   course" button, never an auto-submitting script. The picker opens in a
   new tab. A pending picker lives ten minutes and is single use
   (`lti_deep_link_requests`). The `lti.deep_link` audit row's actor is
   `user:<id>`, the account found by `lti:<issuer>` and the subject (or
   through an account link), or `subject:<sub>` when no account exists
   yet; its target is the platform issuer.
   - Signing the Deep Linking response and the NRPS client assertion
     derives the key id from the tool's private key inside `@portikus/auth`
     (which also owns `toolJwks`); a key with no id is refused rather than
     signed with an empty `kid`.
6. **Custom parameters.** `portikus_project`, and exactly one of
   `portikus_template` or `portikus_repository`. The content item URL is
   `PUBLIC_URL + "/"`.
7. **Starter launch.** A student launch of such a link stores a starter
   (`lti_starter_launches`, 30 minutes, bound to the user) and answers 303
   to `/?starter=<id>`. `POST /workspaces/:id/projects/starter` creates
   the project only if no project has that slug; otherwise it opens the
   existing one, or says it is archived. It never overwrites.

## Consequences

- Rosters stay current without a scheduled job, at the cost of a sync only
  when an instructor looks.
- A roster removal is real: the person loses the Course page row until
  they launch again.

## Rejected

- Roster sync on a worker schedule, and NRPS without a token URL.
- Private repositories or ssh clones through Deep Linking; per-course
  templates.
