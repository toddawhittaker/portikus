# Epic 13.1: Link a course account to an SSO account, and promote administrators

This is the working brief for Epic 13.1. SPEC.md section 29 lists Epic 13 and this follows it; this file is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. `docs/EPIC-13.md` and ADR 0025 describe the LTI launch this builds on; ADR 0026 records the decisions made here.

- **Base commit:** `main` at `a3a1378`.
- **Epic branch:** `epic/13-1-account-linking`. Builders reset to `origin/epic/13-1-account-linking` and branch `task/13-1-<name>` from it.
- **Migration number:** `0016_account_links` is reserved for T1. No other task adds a migration.

Terms used throughout:

- **SSO account** (single sign-on): an account whose sign-in is the institution's OpenID Connect (OIDC) provider. On the pilot that provider is Dex; in production it may be Microsoft Entra ID or another. Nothing in this epic may depend on Dex: only the issuer and the `sub` claim, through the existing OIDC client and config. Entra's `sub` is stable per application, so accounts stay keyed on (issuer, `sub`), never on email, `oid` or `preferred_username`.
- **Course account**: an account created by an LTI launch, stored under the issuer `lti:<platform issuer>` (EPIC-13 ruling 12).
- **Link**: a record that sends every later launch from one course account into one SSO account.

## What the user gets

- A person who uses both sign-ins opens Portikus from their course, goes to Settings, Profile, and chooses **Link to my SSO account**. They sign in with SSO, see a page naming both accounts, and confirm. From then on, opening Portikus from that course lands in their SSO account and its workspace. The course account's workspace is archived, not deleted.
- The SSO account's Settings, Profile, lists its linked course sign-ins, each with an **Unlink** button.
- An instructor keeps their Course page after linking.
- An administrator sees a searchable **Users** list with each account's role and sign-in source, and can **promote** an SSO account to administrator, or **demote** one they promoted, each after a confirmation dialog. Demote was added as the undo for promote.

## Rulings

R1 to R9 and P1 to P6 were made by the orchestrator. Rulings from 10 on were made in this brief.

### Linking

1. **Linking starts from the course account**, because a launch can only start in the LMS. It uses the normal OIDC sign-in with a link intent, then a confirmation page naming both accounts. The intent is a single-use, short-lived, server-side row bound to the current course session, like the LTI state row.
2. **The SSO account survives.** Later launches from the linked course identity sign into it.
3. **Never auto-link and never match by email.** In link mode the OIDC callback never creates or updates a user. If the SSO identity has no account, the link is refused.
4. **One role rule** for every account, below under "The role rule". LTI never grants administrator and never demotes one.
5. **The retired course account** has its sessions ended and can never be signed into again. Its workspace is archived through the existing archive path (ruling 14). The user's Git repositories are never touched (SPEC.md section 12.5).
6. **Unlink** from Settings; what a later launch does is ruling 15.
7. **At most one linked course identity per LTI platform issuer on an SSO account**, and (issuer, `sub`) stays unique across every identity (ruling 12).
8. **Audit** link and unlink, with nothing beyond what sign-in rows carry (STACK.md section 15, ADR 0012). Ruling 19.
9. **Tests**: unit and database tests for the logic; Playwright through the mock LMS and the mock OIDC provider that e2e already uses (`packages/auth/src/testing/mock-oidc.ts`). A smoke-test block is not worth it (ruling 22).

### Rulings made in this brief: linking

10. **Recent launch: 15 minutes.** The course session must have been created at most 15 minutes ago (`sessions.created_at`), checked at start and again at confirm. A session belongs to a course account only if it came from a launch, so its age is the age of the launch. Fifteen minutes covers clicking through Settings and an SSO sign-in with a password lookup. It bounds how long a copied session cookie could be used to link, where the session itself lives 12 hours (`SESSION_TTL_SECONDS`). A user who is too slow opens Portikus again from the course.
11. **Proof of control.** The course side is proved by the recent launch. The SSO side is proved by a full OIDC sign-in with PKCE, state and nonce, exactly as `/auth/login` does, plus `prompt=login`, the standard OIDC request to re-authenticate. Dex keeps no browser session today, so it always asks for the password; Entra honours `prompt=login`. `max_age` is not used, because `openid-client` then requires an `auth_time` claim that Dex does not send.
12. **The data model keeps identities in one place.** `users (oidc_issuer, oidc_subject)` stays the only place an identity lives, still unique. A link row maps a course account's `users` row to an SSO account's row; it copies no issuer or subject. An identity therefore resolves to exactly one row, and that row is either a live account or retired (it has a link row).
13. **Retired means refused at the session check.** `loadSession` returns null for a user who has a link row. This covers the race where a launch passes the link check just before a link commits. It is one indexed `not exists` on the hot path.
14. **R5: archive, not refuse.** Linking archives the course account's workspace (sets `archived_at` and `desired_state = 'stopped'`, as `POST /admin/workspaces/:id/archive` does), unless it is already archived. Why not refuse when the workspace holds work: "has work" has no cheap, honest test (it needs the workspace running and a judgement about files), and a refused student can do nothing about it but push their work themselves. Archiving keeps every byte, an administrator can unarchive it, and unlink undoes it (ruling 15).
15. **R6: after unlink, the course account comes back as it was.** Unlink deletes the link row and, when the link archived the course workspace, unarchives it (left stopped). The link stores the exact archive time it wrote in `account_links.archived_at` (migration 0017 replaced the earlier `archived_workspace` boolean), and unlink clears the archive only while the workspace still carries that time, so a later archive by an administrator stays (review S5). The next launch signs into the course account exactly as before the link. Memberships moved to the SSO account at link time stay there (ruling 16); the next launch adds the course account's membership again.
16. **Course memberships move at link time.** The course account's `lti_memberships` rows move to the SSO account (on conflict keep the later `last_launch_at` and its role), so the Course page lists one person, not two, and the instructor sees their courses before the next launch.
17. **Only the confirmation signs in.** The callback in link mode never starts a session. Confirm ends every session and preview session of the course account, including the current one, and starts a session for the SSO account.
18. **Refusals are shown on the link page.** Every link-mode callback outcome redirects to `/link`, with `?error=<code>` on failure: `no_account`, `not_authorized` (no role from the provider's groups, or disabled), `session_changed`, `expired`, `already_linked`, `failed`.
19. **Audit rows.** `user.linked` and `user.unlinked`, actor `user:<SSO account id>`, target the SSO account id, with `side: "sso"` on an unlink. An unlink started from a launch session (step 7) has actor `user:<courseUserId>` and `side: "course"`. Each row carries metadata `{platform: <registration name>, courseUserId, ip, userAgent}`. A refused link writes `user.linked` with result `failed` or `denied` and `{reason}` instead. The archive writes `workspace.archived` with `{reason: "account_linked"}`; unlink's unarchive writes `workspace.unarchived` with `{reason: "account_unlinked"}`. The confirmation's new session writes `auth.login` with `{method: "link"}`. No names, emails, subjects or tokens.

### Users, roles and promotion

P1. The admin UI gets a **Users** view: a searchable list matching name, email and username, plus role and sign-in source.
P2. Promote with a confirmation dialog; demote as the undo; no self-demotion; the last administrator can never be demoted.
P3. A stored grant, separate from the provider's role; one role rule with R4. (Amended by the orchestrator: the grant is a role, `instructor` or `administrator`, not an admin-only flag, so the later Entra and Google epic needs no migration.)
P4. Promotion only for SSO accounts, linked or not; refused for course accounts.
P5. Takes effect as role is read today; audited with the actor; admin-only and CSRF-protected.
P6. Unit tests, Playwright for search, promote, demote and the last-admin guard, and a11y review.

20. **The role rule** (R4 and P3 together). Each `users` row has:
    - `provider_role`: the role the account's own sign-in gave last time. For an SSO account, `mapRole` on the OIDC groups claim at sign-in. For an unlinked course account, the LTI role mapping at launch.
    - `granted_role`: null, `instructor` or `administrator`, stored by Portikus. In this epic only promote (sets `administrator`) and demote (clears it) write it. A database check refuses any grant on an `lti:` issuer.
    - `role`, the effective role every check already reads: the higher of `provider_role` and `granted_role` (student < instructor < administrator). It is written with the other two, so `loadSession`, `requireRole` and the web app do not change.

    Google ID tokens carry no groups claim, so under Google a grant will be the only way to an instructor or administrator; the column is ready for that.

    A launch into a linked SSO account changes none of the three; it only refreshes the course membership. The Course page is already keyed on `lti_memberships.role = 'instructor'`, never on the account role (`apps/api/src/routes/courses.ts`), so an instructor keeps it and the account role never flaps between an SSO sign-in and a launch. A `user.role_changed` row is written whenever the effective role changes, with `source` `"oidc"`, `"lti"` or `"admin"`.
21. **A launch never starts an administrator session.** If a launch resolves to an account whose effective role is administrator (only possible through a link), the API records the membership, writes `auth.login` `denied` with `{method: "lti", platform, reason: "administrator"}`, and shows a page: "Administrators sign in with SSO", with a link to `/auth/login`. Why: an LMS administrator can act as any user in the LMS (Canvas "Act as user"), so the course system must never be a way into an administrator session. This one check lets P4 allow linked accounts and lets a linked account be promoted later.
22. **No smoke-test block.** The smoke and security scripts are curl-based and cannot drive an SSO password page. The Playwright specs and the API route tests cover the flow; T5 does one manual rehearsal on the pilot with the mock LMS and the real Dex, which is the only check that `prompt=login` shows a password page.
23. **Promote and demote** (P2, P4, P5).
    - `POST /admin/users/:id/promote`: 400 for an `lti:` account ("Only SSO accounts can be administrators."). No change, and 200, when the effective role is already administrator. Otherwise sets `granted_role = 'administrator'` and `role`.
    - `POST /admin/users/:id/demote`: 400 on oneself; 400 when `granted_role` is not `administrator` ("This administrator comes from the SSO provider's groups."); 400 when no other enabled administrator would remain. It locks the target and every enabled administrator `FOR UPDATE`, as the disable route does, so two administrators demoting each other at once cannot both succeed. Sets `granted_role = null` and `role = provider_role`.
    - Both write `user.role_changed` with actor `user:<admin id>` and `{from, to, source: "admin", ip, userAgent}` in the same transaction, and return the `AdminUser`.
    - Neither ends sessions: `loadSession` reads `users.role` on every request, so the change takes effect on the target's next request, as a disable's role read does. Administrators have no socket that outlives a request with admin rights.
    - `make users-deploy` cannot remove a grant; its session revocation is unchanged. OPERATIONS.md says so.
24. **The Users view extends the existing Workspaces tab**, which already lists every account from `GET /admin/users` with a text search over name, email and username. The tab's label becomes "Users" (its address stays `?tab=workspaces`, so links and tests keep working). It gains a Role column ("Administrator (from SSO)", "Administrator (granted)", "Instructor", "Student"), a role filter, and a Source column in place of Issuer: "SSO", or "Course: <platform host>" for `lti:` issuers. The search also matches the source. The account detail's Account section gains Promote or Demote beside Disable. Linked course accounts show a "Linked" marker. Filtering stays in the browser: the list is one pilot's accounts, already fetched whole; server-side paging is left out until a list passes about 1,000 accounts.
25. **Known limit, not fixed here.** `mapRole` reads group names from one claim. Entra sends group object IDs and, past about 200 groups, an overage claim instead of the list. A stored grant works whatever the provider's groups look like, which covers administrators; mapping students and instructors under Entra is later work.
26. **Playwright uses only standard OIDC** behaviour of the mock provider: the authorization-code flow, the issuer and `sub`. No Dex subject encoding, no Dex paths, no email matching.

## The data model (migration `0016_account_links`)

- `users.provider_role text not null`, backfilled from `role`, with the same check as `role`.
- `users.granted_role text null`, with `check (granted_role in ('instructor','administrator'))` and `check (granted_role is null or oidc_issuer not like 'lti:%')`.
- `account_links`: `course_user_id uuid primary key references users on delete cascade`, `user_id uuid not null references users on delete cascade`, `platform_issuer text not null` (plain, no prefix), `archived_at timestamptz null` (the archive time the link wrote; migration 0017 replaced the `archived_workspace boolean` of 0016), `created_at timestamptz not null default now()`; unique (`user_id`, `platform_issuer`); check `course_user_id <> user_id`; index on `user_id`.
- `account_link_intents`: `state_hash text primary key` (SHA-256 of the OIDC `state`), `session_id text not null unique references sessions on delete cascade`, `course_user_id uuid not null references users on delete cascade`, `user_id uuid references users on delete cascade` (the SSO account, set by the callback), `expires_at timestamptz not null` (10 minutes); index on `expires_at`. Expired rows are cleared when a new row is written.
- The `down` drops both tables and both columns.

Migration `0017_session_method` adds:

- `sessions.method text not null default 'oidc'`, one of `oidc`, `lti` or `link`: how the session started.
- `sessions.course_user_id uuid null references users on delete cascade`: the linked course identity behind a launch session, allowed only when `method = 'lti'`.
- Its `up` ends every session of a user on either side of a link, since those cannot be classified, marks the remaining sessions of `lti:` accounts as `lti`, and fills `account_links.archived_at` from the workspace only when its archive time is within 5 seconds of the link's `created_at`. A later archive is not the link's to undo, so it stays null there.

That a link's `course_user_id` is an `lti:` row and its `user_id` is not, is checked in code and tested; SQL cannot check it across rows.

## The flow

1. **Settings, Profile** calls `GET /me/links`: `{source: "sso" | "course", linkUntil: string | null, links: [{courseUserId, platformName, displayName, linkedAt}]}`. `linkUntil` is the session's creation plus 15 minutes, for a course session only. A course account sees **Link to my SSO account** (or, past `linkUntil`, "Open Portikus again from your course to link it"). An SSO account sees its links with **Unlink**.
2. **`POST /me/links/start`** (self, CSRF-checked). Refused unless the session's user is an unlinked `lti:` account and the session is under 15 minutes old. Builds the OIDC redirect with `prompt=login`, sets the usual signed login cookie, replaces this session's intent row, and answers `{redirectUrl}`. (Todd, 2026-09-24) SSO sign-in opens in a new tab: **Link to my SSO account** opens the web page `/link/start` in a new tab, synchronously in the click so pop-up blockers allow it. That page makes this call and replaces itself with `redirectUrl`, or shows the refusal. The Portikus tab stays put, says "Finish signing in in the new tab." and offers to open the tab again. If the browser blocks the new tab, the current tab goes to `/link/start` instead.
3. **SSO sign-in** at the provider, then **`GET /auth/callback`**. After `completeLogin` succeeds, the callback looks up an intent row by the hash of the returned `state`. No row: the ordinary sign-in, unchanged. A row: link mode. The row's `session_id` must equal the hash of this request's session cookie (`session_changed`), the row must be unexpired with no `user_id` yet (`expired`), `mapRole` must give a role (`not_authorized`), a `users` row must exist for (issuer, `sub`) and not be disabled (`no_account`, `not_authorized`), and that account must have no link for this platform (`already_linked`). On success the row gets `user_id`, and the response is `302 /link`.
4. **`/link`** (web) calls **`GET /me/links/pending`**: `{course: {displayName, platformName}, sso: {displayName, signInName, email}}`, or 404. It shows both and a **Link accounts** button, and Cancel, which leaves the row to expire. (Todd, 2026-09-24) SSO sign-in opens in a new tab: this page runs in that tab. After confirm it posts `{type: "linked"}` on the same-origin BroadcastChannel `portikus-link`, says "Linked. You can close this tab.", offers **Go to Portikus**, and tries to close itself. Cancel posts `{type: "cancelled"}` and closes the tab, or goes to the workspace if the browser will not close it. The original tab reloads `/` on "linked", which lands in the SSO account, and stops waiting on "cancelled".
5. **`POST /me/links/confirm`** (self, CSRF-checked). In one transaction: delete this session's intent row with a `user_id` (single use; 404 if none), re-check ruling 10 and `already_linked`, lock both users rows, insert the link, archive the course workspace (ruling 14), move memberships (ruling 16), end the course account's sessions and preview sessions, write the audit rows. After commit, start the SSO session. Answers 200; the web app tells the original tab, which goes to `/` (step 4).
6. **Later launches** (`POST /lti/launch`, after validation): if the (issuer, `sub`) row has a link, then the SSO account is refused if disabled, ruling 21 applies if it is an administrator, and otherwise the SSO account gets a session and a membership refresh, with `auth.login` `{method: "lti", platform, role, linked: true}`. Its name, email and roles are not touched.
7. **`POST /me/links/:courseUserId/unlink`** (self, CSRF-checked): 404 unless the link belongs to the caller. It can start from either side. From an SSO session it removes any of the caller's links. From a launch session through a linked identity it removes only that identity's link, and any other course identity is 404 (ruling N2). In one transaction it deletes the link, unarchives per ruling 15, ends every session that came through the identity with their preview sessions (ruling N1), and audits (ruling 19). It answers `{signedOut}`: true when the calling session was one of those ended, in which case the cookie is cleared and the web app goes to `/unlinked`.

## Security invariants to test

- Link mode never creates a user, never updates one from claims, and never starts a session at the callback.
- No lookup anywhere uses email or `preferred_username` to find an account.
- An intent is used once, only by the session that made it, only before it expires; a callback carrying another session's state is refused.
- A course session older than 15 minutes cannot start or confirm a link; an SSO session cannot start one.
- After confirm, every course-account session is dead, the course account cannot sign in by launch or session, and its workspace is archived, not deleted.
- A second course identity from the same platform cannot link to the same SSO account; two SSO accounts cannot claim one course identity.
- A launch never yields an administrator session; LTI never changes `granted_role` or an SSO account's role.
- Promote refuses `lti:` accounts (API and database check); demote refuses oneself, a provider administrator, and the last enabled administrator, including two concurrent mutual demotions.
- Every new POST is CSRF-checked; every new route is in `route-policy.ts` and the authorization matrix; admin routes refuse students and instructors.
- No audit row or log line carries a token, state, name, email or subject.

# Tasks for parallel builders

Each task owns only the files listed; ask the orchestrator before touching any other. The routes, shapes, codes and table columns above are fixed, so tasks build against each other without waiting.

| Task | Agent | Files it owns | Depends on |
|---|---|---|---|
| **T1 Data model and role rule** | builder | `packages/db/src/migrations/0016_account_links.ts`, `migrations/index.ts`, `schema.ts`, `testing.ts`, `db.test.ts`; `packages/auth/src/sessions.ts` and test (`upsertUser` writes `provider_role` and the effective `role`; `loadSession` refuses retired accounts; an exported session-id hash); `packages/auth/src/links.ts` and test (new: intent save, bind and consume; link, unlink, resolve-by-identity; grant and revoke with the last-admin lock); `packages/auth/src/index.ts`; `packages/contracts/src/links.ts` (new) and `index.ts`; `packages/contracts/src/settings.ts` (`AdminUser` gains `providerRole`, `grantedRole`, `markers.linked`) | none |
| **T2 API** | builder | `apps/api/src/routes/links.ts` and test (new); `apps/api/src/routes/auth.ts` and test (link mode); `apps/api/src/routes/lti.ts` and test (linked launch, ruling 21); `apps/api/src/routes/start-session.ts`; `apps/api/src/routes/admin.ts` and test (promote, demote, new `AdminUser` fields); `apps/api/src/admin/markers.ts`; `packages/auth/src/oidc.ts` and test (`prompt` option); `apps/api/src/server.ts`; `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts` | T1 |
| **T3 Web: linking** | builder, then tester for e2e | `apps/web/src/link/**` (new `/link` page); `apps/web/src/router.tsx` and test; `apps/web/src/settings/SettingsDialog.tsx`, `sections.ts`, `profileQueries.ts` and tests; `e2e/account-link.spec.ts`, `e2e/a11y-link.spec.ts` (new) | T1's contracts; T2 for e2e |
| **T4 Web: Users view** | builder, then tester for e2e | `apps/web/src/admin/AdminPage.tsx`, `WorkspacesTab.tsx`, `WorkspaceDetail.tsx`, `queries.ts`, `markers.tsx` and their tests; `e2e/admin-roles.spec.ts` (new); `e2e/admin*.spec.ts` only where the tab label breaks them | T1's contracts; T2 for e2e |
| **T5 Docs and rehearsal** | builder | `docs/adr/0026-account-links-and-role-grant.md` (proposed in this PR; T5 brings it in line with what landed and marks it accepted); `docs/SPEC.md` section 5.2 and section 29; `docs/OPERATIONS.md` (unarchiving a linked account's workspace; grants versus the users file; the Entra limit); `docs/OVERVIEW.md`; `docs/STATUS.md`; `docs/BACKLOG.md` (close the linking item; add "Left out") | all others |
| **T6 Instructors remove a course member** | builder | `apps/api/src/routes/courses.ts` and test; `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts`; `apps/web/src/course/CoursePage.tsx`, `RemoveMemberConfirm.tsx` (new), `queries.ts` and tests; `packages/contracts/src/courses.ts` and test; `packages/mock-lms/src/seed.ts`; `e2e/course-remove.spec.ts` (new), `e2e/lti-course.spec.ts`, `e2e/lti-helpers.ts`; `docs/EPIC-13.md` (amends rulings 23 and 27); `docs/BACKLOG.md` (closes the two items this replaces) | T1 |

T1 starts alone; it is small. T2, T3 and T4 start when T1 lands, together. The e2e specs in T3 and T4 pass once T2 lands. T6 landed alongside the others, as `#506`, once T1 was in. T5 is last and includes the pilot rehearsal.

After every task has landed: code-reviewer over the epic head, security-reviewer (auth, sessions, CSRF, roles), and a11y-reviewer (`apps/web`). Fixes land as further task PRs, then confirmation reviews, then the epic PR to `main`.

## What done looks like, per task

- **T1:** migration up and down on a fresh database, backfill checked; the grant checks refuse an `lti:` row and an unknown role; database tests for every function in `links.ts`, including a single-use intent, an expired intent, the per-platform uniqueness, `loadSession` refusing a retired account, the effective-role rule on sign-in with no grant, an instructor grant and an administrator grant, and two concurrent mutual demotions leaving one administrator.
- **T2:** route tests for every step and every `?error=` code; link mode creates no user (a test with an unknown `sub`); an old course session is refused at start and confirm; a linked launch lands in the SSO account and leaves its role alone; ruling 21's refusal; promote and demote with every refusal; the matrix covers every new route; a captured log holds no state or token. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- **T3:** component tests for the Profile states (course inside and past the window, SSO with and without links) and the `/link` page (pending, each error, confirm); Playwright: launch as Sam Student from the mock LMS, link to mock user `bob`, confirm, land in bob's workspace, relaunch lands there too, the course account's old session is dead, unlink, relaunch lands in the course account; a link to an SSO identity with no account is refused; axe on `/link` and the Profile section.
- **T4:** component tests for search by name, email, username and source, the role filter, the role labels, and the Promote and Demote dialogs; Playwright: search, promote `alice`, alice's admin link appears on her next page load, demote, no demote for carol (provider administrator) or oneself, the last-admin refusal (seeded with only granted administrators), promote refused for a course account; axe on the tab and dialogs.
- **T5:** every doc above updated; ADR 0026 accepted; `pnpm lint` passes; the pilot rehearsal (mock LMS registered, launch, link to a real Dex user through the password page, relaunch, unlink, unregister) recorded in STATUS.md.
- **T6:** route tests for every refusal (student, another course's instructor, removing oneself, a non-member) and the success path; the authorization matrix covers the new route; component tests for the confirmation dialog and the list updating; Playwright removes a member from `cs350` and shows a relaunch adds it back; `docs/EPIC-13.md` rulings 23 and 27 amended in place, not restated here.

# Risks

1. **A stolen, fresh course session** could link the victim's course identity to the thief's SSO account, sending the victim's later launches into the thief's account. Ruling 10 bounds this to 15 minutes after a launch, and the victim would see someone else's account. Accepted.
2. **`prompt=login` is a request, not a guarantee.** A provider that ignores it and keeps an SSO session lets whoever sits at a signed-in browser link without a password. The pilot rehearsal checks Dex; a production provider's behaviour belongs in the OPERATIONS.md notes.
3. **After unlink, the SSO account keeps the memberships it gained**, so an instructor still sees those Course pages. It is the same person; accepted.

# Left out

- Linking in the other direction (starting from an SSO session), and linking two SSO accounts or two course accounts.
- Moving or merging workspaces, files or projects between accounts.
- An administrator UI to link or unlink for a user.
- Group-ID and overage handling for Entra (ruling 25).
- Server-side search and paging for the Users list (ruling 24).
- A smoke-test or security-test block for linking (ruling 22).
- An instructor grant in the UI or API. The `granted_role` column already accepts `instructor`, ready for the Entra and Google epic.
- A dedicated Playwright test for the last-administrator guard (ruling P11).

## Rulings made after the brief: review fixes

S1. **A launch session of an administrator is refused on every request.** `loadSession` refuses a session with `method = 'lti'` whose account's effective role is administrator, however the role arrived, so ruling 21 holds after a promotion too. The preview gateway reads the main session by id through the same rule (`loadSessionById`), and so also refuses a retired course account (ruling 13).

S2. **The launch notice and `/unlinked`.** After a launch into a linked account, the workspace shows a dismissible notice naming the course platform and the account, with Unlink behind a confirmation. A screen reader hears it through a status region that is mounted before the text arrives. An unlink that ends the session goes to `/unlinked`, a page with no sign-in button that says to open Portikus again from the course.

S3. **Confirm re-checks the SSO account.** A disabled SSO account is refused at confirm (`not_authorized`), even if it was enabled at the callback.

S4. **Instructors remove students only.** The member-removal route of P10 refuses to remove an instructor.

S5. **Unlink undoes only the link's own archive** (ruling 15 and migration 0017).

N1. **Every unlink ends every session through the identity.** Whichever side starts it, unlink deletes every session whose `user_id` is the SSO account and whose `course_user_id` is the unlinked identity, and revokes their preview sessions, inside the unlink transaction. Otherwise a second launch session on another device would keep acting as the SSO account through an identity that no longer maps to it.

N2. **A launch session unlinks only its own identity.** A session with `method = 'lti'` may unlink only its `course_user_id`; any other course identity answers 404, the same as a link that does not exist.

N4. **An administrator SSO account cannot be linked.** Confirm refuses it with `not_authorized` (the existing code, so the link page needs no new message), because every later launch would be refused by ruling 21 anyway. A student whose SSO account is disabled or promoted after linking is locked out of launches until an administrator-side unlink exists (BACKLOG.md, "Administrator-side account linking").

## Rulings made after the brief: additions

P7. **Bulk actions in the Users view** (T4). Rows can be ticked and acted on together: Disable, Enable, Archive and Unarchive. Each calls the existing single-row route once per selected row, in the browser, the same way a script calling the API repeatedly would; there is no new bulk route and no transaction across rows. A row that fails is reported and the rest continue. This is client-side convenience over routes T2 already shipped, not new authorization surface.

P8. **`StateBadge` gains an `inCell` option** (SPEC.md section 25.8). Inside a table cell it drops `role="status"`, so a list of many rows is not many live regions a screen reader announces at once. The Users view and the Course page (`#506`) both pass it. Plain `StateBadge` elsewhere is unchanged.

P9. **Issue #302 (the admin account detail shows the full issuer and username) is met** by T4's account section, which already prints both in full; no separate change was needed.

P10. **Instructors remove a course member** (`#506`, amending Epic 13 rulings 23 and 27). `POST /courses/:courseId/members/:userId/remove` deletes that one `lti_memberships` row and writes a `course.member_removed` audit row with ids only. It refuses students, an instructor of a different course, removing oneself, and a non-member. A later launch from the LMS adds the membership back, exactly as any other launch does. The Course page's member list now carries each member's `userId`, which Epic 13's ruling 23 said the response would never contain; T5 does not touch this, since #506 already amended `docs/EPIC-13.md` rulings 23 and 27 in place.

P11. **A last-administrator e2e test was deliberately left out.** P6 asks for Playwright coverage of "the last-admin guard"; that guard is exercised by the API route test (concurrent mutual demotions, `admin.test.ts`) and the component test for the Demote dialog's refusal state (`WorkspaceDetail.test.tsx`). A seeded, isolated database state (only granted administrators, nobody else) for one more end-to-end path was judged not worth the added run time and flake surface, given the two tests already pin the invariant at the unit and component levels.

P12. **Dedicated e2e test people.** The Playwright specs for this epic use named test fixtures, never the pilot's real accounts: `lin`, `max`, `rex` and `una` from the mock LMS (`packages/mock-lms/src/seed.ts`), `erin`, `frank` and `gail` from the mock OIDC provider, and the course `cs350`. Naming them here is so a later spec reaches for these rather than inventing new ones.
