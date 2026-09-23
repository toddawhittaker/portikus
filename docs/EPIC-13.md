# Epic 13: LTI 1.3 launch and an instructor role

This is the working brief for Epic 13. SPEC.md section 29 does not list an Epic 13 yet; the docs task (T7) adds the entry. Until then, this file is the requirement an agent implements against. Where this file is silent, `docs/SPEC.md` wins on behavior and `docs/STACK.md` wins on technology.

- **Base commit:** `main` at `ed17115`.
- **Epic branch:** `epic/13-lti-launch`. Builders reset to `origin/epic/13-lti-launch` and branch `task/13-<name>` from it.
- **Migration number:** `0015_lti` is reserved for T1. No other task adds a migration.

A few terms, used throughout:

- **LMS** (learning management system): Canvas, Moodle and the like. In LTI's words it is the **platform**; Portikus is the **tool**.
- **LTI 1.3** (Learning Tools Interoperability): a standard for opening a tool from a course. The launch is an OpenID Connect sign-in in which the LMS is the identity provider and signs an **id_token** (a JSON Web Token, JWT) describing the person, their role and the course.
- **JWKS** (JSON Web Key Set): the public keys a platform publishes so a tool can check its signatures.
- **Context**: LTI's word for a course.

## Where this epic sits

SPEC.md section 5.1 asks the architecture to leave room for "LTI-provided identity/course context", section 5.2 lists `instructor` as a P2 role, and section 31 lists LTI 1.3 launch as a future capability. The BACKLOG item "LTI 1.3 launch from the learning management system" (Todd, 2026-09-17) is the source.

Today a student signs in through Dex with a password Todd gives them (Epic 12b). This epic adds a second way into the same session: opening Portikus from a course in the LMS. It also adds the first role between student and administrator.

## What the user gets

- A student clicks a Portikus link in their course and lands in their own workspace. There is no second password.
- An instructor, TA or course designer who clicks the same link lands in their own workspace too, and gets a **Course** page. It lists everyone who has opened Portikus from that course, with their name, role, last launch and whether their workspace is running. It is read-only.
- An instructor cannot see any student's files or workspace, and cannot use any administrator page.
- If the LMS opens Portikus inside a frame, a small page says so and offers an "Open Portikus in a new tab" button.
- Todd registers each LMS in one file on his own machine, and the normal Ansible run applies it.
- Todd can try the whole thing against the pilot with a mock LMS that runs on his own machine, started by one `make` target and trusted only while a second `make` target has registered it.
- Dex accounts can be given the `instructor` role too.

## Rulings

Rulings 1 to 11 were made by the orchestrator. Rulings from 12 on were made in this brief because the spec does not settle them.

### Scope

1. **LTI 1.3 core resource-link launch only.** In scope:
   - third-party login initiation at `GET` and `POST /lti/login`;
   - a redirect to the platform's authorization endpoint with `state` and `nonce`;
   - the platform's form post of the id_token to `POST /lti/launch`;
   - id_token validation, listed in full under "Validation" below.

   Out, and listed under "Left out": LTI Advantage services (AGS grade passback, NRPS roster sync, Deep Linking), dynamic registration, and the LTI platform-storage postMessage API.

2. **Platforms are registered by the operator in a file rendered by Ansible.** There is no administrator UI. Several platforms may be registered at once. This follows the Dex users-file pattern: a file on the host, Ansible copies it to the VM, the API reads it at start.

### Identity and roles

3. **An LTI user is keyed by the platform's issuer and the LTI `sub`, in the existing `users (oidc_issuer, oidc_subject)` key.**
   - No automatic linking by email to a Dex account. An email from an LMS is not proof of anything; linking is left out.
   - LTI users get no password login.
   - A launch creates the normal Portikus server-side session (same `sessions` table, same `__Host-portikus_session` cookie) and redirects into the app.

4. **Roles.**
   - A new platform role, `instructor`.
   - LTI membership roles `Instructor`, `TeachingAssistant` or `ContentDeveloper` map to `instructor`. `Learner` maps to `student`. Anything else maps to `student`.
   - An institution-level `Administrator` role maps to `instructor`. **LTI never grants `administrator`.**
   - The role is refreshed on every launch. A user an administrator has disabled stays disabled, and the launch is refused the way `/auth/callback` refuses one today.
   - The Dex users file also accepts `instructor`: `make users-add` offers it, `users-check` accepts it, the Dex rendering gives it the group `instructor`, and `mapRole` maps the new `OIDC_INSTRUCTOR_GROUP` (default `instructor`) to it.

5. **What an instructor can do in this epic:** everything a student can (their own workspace), plus a read-only Course page for each course they have launched from as an instructor. No access to anyone else's workspace or files (SPEC.md section 31 keeps that for later). Instructors are never administrators: every administrator route refuses them, and the security suite's authorization matrix proves it.

6. **Course context.** Each launch stores the platform, the context id and the context title, and the membership (user, mapped role, last launch). Minimal tables, one migration.

### Browser rules

7. **Cookies, CSRF and frames.**
   - The launch is a cross-site POST. Only `POST /lti/launch` and `POST /lti/login` are exempt from the CSRF origin check. Signature, state and nonce protect them.
   - The state check must work under SameSite rules, and inside a frame where cookies are blocked a fallback page offers a new tab. How, below (ruling 16 and 17).
   - The operator docs recommend the "open in a new window" placement in each LMS.

8. **Mock LMS.** A small TypeScript mock platform, not a port of the Python one. Details under "The mock LMS".

9. **Logs.** Never log an id_token, `state`, `nonce`, login hint, or any roster data (names, emails, member lists). Audit LTI sign-in and role changes in the SPEC.md section 24.11 style (ruling 22).

10. **Tests.** Unit tests for validation including every defect; database tests; Playwright end-to-end tests for a student launch, an instructor launch and the Course page, the frame fallback page, and administrator routes refused for an instructor; a smoke-test block and security-test checks on a real VM; a CI job like the Dex sign-in job; accessibility of the Course page and the fallback page (SPEC.md section 25.8).

11. **Docs.** An OPERATIONS.md section on registering an LMS, with Canvas and Moodle field names; ADR 0025 for the LTI design; STATUS.md and BACKLOG.md updates; the SPEC.md section 29 entry for Epic 13.

### Rulings made in this brief

12. **LTI users are stored under the issuer `lti:<platform issuer>`.** For example `lti:https://canvas.instructure.com`. The key is still (issuer, `sub`), as ruling 3 says; the prefix keeps an LTI identity apart from an OIDC identity if the same server is ever both (Moodle can be an OAuth provider). It also lets the admin page tell LTI rows apart. `preferred_username` stays null; the workspace label falls back the way `apps/api/src/routes/workspaces.ts` already does, and T3 adds a test that an LTI user with a UUID `sub` gets a valid, unique label.

13. **A registration is keyed by (issuer, client_id), not issuer alone.** Every Canvas cloud instance shares the issuer `https://canvas.instructure.com`, so the client id is what tells two registrations apart. Contexts are keyed by (platform issuer, context id).

14. **The platforms file, version 1.** Host path `~/.config/portikus/lti-platforms.json` (Makefile `PORTIKUS_LTI_PLATFORMS_FILE`, Ansible `portikus_lti_platforms_file`). Ansible copies it to `/etc/portikus/lti-platforms.json`, owner `root:portikus`, mode 0640, and sets `LTI_PLATFORMS_FILE` in `api.env`. It holds no secret (LTI 1.3 platforms sign; the tool holds no shared secret).

    ```json
    { "version": 1,
      "platforms": [
        { "name": "Canvas",
          "issuer": "https://canvas.instructure.com",
          "clientId": "10000000000001",
          "authLoginUrl": "https://sso.canvaslms.com/api/lti/authorize_redirect",
          "keysetUrl": "https://sso.canvaslms.com/api/lti/security/jwks",
          "deploymentIds": ["1:8865aa05b4b79b64a91a86042e43af5ea8ae79eb"],
          "mock": false } ] }
    ```

    - `name`: 1 to 60 characters, unique; shown on the Course page and in audit rows.
    - `issuer`, `authLoginUrl`, `keysetUrl`: HTTPS URLs. `http://` is allowed only when `mock` is `true`.
    - `deploymentIds`: at least one.
    - (`issuer`, `clientId`) is unique. Unknown keys are refused.
    - The API validates the file with Zod at start and refuses to start on a bad file, naming the problem. No file, or no `LTI_PLATFORMS_FILE`, means LTI is off and every `/lti/*` route answers 404.

15. **The tool publishes a JWKS at `GET /lti/jwks`.** Canvas's developer-key form and Moodle's tool form both ask for a tool key or keyset URL, so a registration needs one even though this epic never signs anything with it. Ansible generates an RSA 2048 key once on the VM (`openssl genpkey`, `/etc/portikus/lti-tool-key.pem`, root:portikus, 0640, `no_log`), like the other generated secrets, and sets `LTI_TOOL_KEY_FILE`. The route serves only the public part, with a `kid` that is the key's SHA-256 thumbprint.

16. **State: a server-side row plus a cookie that carries it.**
    - `/lti/login` creates a random 32-byte `state` and `nonce`, stores a row in `lti_login_states` keyed by the SHA-256 of the state (with the nonce, the registration, and an expiry 10 minutes out), and sets the cookie `__Secure-portikus_lti_state` = the state, `HttpOnly; Secure; SameSite=None; Path=/lti; Max-Age=600`.
    - `/lti/launch` requires the form's `state` to equal the cookie's, and a matching unexpired row. It deletes the row in the same transaction that uses it, so the state, and the nonce with it, are single use. The id_token's `nonce` must equal the row's.
    - Why both: the row makes the nonce single use and survives nothing but its own expiry; the cookie binds the state to the browser that started the login, which is what stops a login-CSRF launch. `SameSite=None` is needed because the platform's form post is a cross-site top-level POST, which never carries a `Lax` cookie. A signed cookie with no row was rejected: it cannot make the nonce single use without a table anyway.
    - Expired rows are cleared when a new row is written, the way sessions are today.
    - On a plain-HTTP development site (e2e), the cookie drops the `__Secure-` prefix and `Secure`, the same rule `sessionCookieName` follows, and uses `SameSite=Lax`; the mock LMS posts from the same site in that setup (both on `localhost`), so Lax still arrives.

17. **Frames.** Caddy today sends `frame-ancestors 'none'` on every control-plane response, and that stays for everything except `/lti/*`.
    - For `/lti/*`, Caddy does not add the header, and the API sends `Content-Security-Policy: frame-ancestors <the origins of every registered platform's authLoginUrl>`.
    - `/lti/login` checks `Sec-Fetch-Dest`. When it is `iframe` (or `frame`), it does not start the flow. It answers 200 with the fallback page: a heading, one sentence, and an "Open Portikus in a new tab" button. The button is a form with `target="_blank"` that re-submits the same login-initiation parameters (`iss`, `login_hint`, `target_link_uri`, `lti_message_hint`, `client_id`, `lti_deployment_id`) to `/lti/login` as a top-level request. Those parameters are not secrets; the platform checks its own session when it receives them back.
    - If `/lti/launch` itself arrives in a frame, or arrives without the state cookie, the launch is refused with the same page, reworded: "Portikus could not finish opening here. Open it again from your course; if this keeps happening, ask your instructor to set Portikus to open in a new window." There is nothing to re-submit at that point.
    - Why this beats a hand-off token after the launch: nothing that grants a session ever travels in a URL or a second tab, and no cookie is ever needed inside the frame.
    - The fallback page is server-rendered HTML from the API (it must render inside the LMS frame, outside the SPA), uses the design tokens' colours and font by inline CSS, and needs no JavaScript.

18. **After a good launch**, the API sets the session cookie and answers `303` to the path of `target_link_uri` (only its path and query; anything that fails to parse, or is not on our origin, becomes `/`). The web app routes `/` into the workspace as it does today.

19. **Validation.** `/lti/launch` refuses the launch unless every check passes, and each refusal has its own reason code (for the audit row and for tests):
    - the id_token's header `alg` is `RS256` (`alg_not_allowed`);
    - the signature checks against the registration's keyset URL, fetched with `jose`'s `createRemoteJWKSet` (cache 10 minutes, refetch on an unknown `kid` at most every 30 seconds, 5-second timeout) (`bad_signature`, `keyset_unavailable`);
    - `iss` names a registered platform (`unknown_issuer`);
    - `aud` is, or contains, that registration's `clientId`; when `aud` has several values, `azp` is present and equals the client id (`wrong_audience`);
    - `exp` is in the future and `iat` not in the future, with 60 seconds of clock skew (`expired`, `issued_in_future`);
    - `nonce` matches the state row (`nonce_mismatch`); state checks as ruling 16 (`state_mismatch`, `state_missing`);
    - `https://purl.imsglobal.org/spec/lti/claim/deployment_id` is in the registration's `deploymentIds` (`unknown_deployment`);
    - `message_type` is `LtiResourceLinkRequest` (`wrong_message_type`), `version` is `1.3.0` (`wrong_version`);
    - `target_link_uri` is on our public origin (`wrong_target`);
    - `sub` is present and 1 to 255 characters (`missing_subject`); anonymous launches are refused;
    - the `context` claim, when present, has an `id` of at most 255 characters.
    - A launch with no `context` claim signs the user in and records no membership.
    - `/lti/login` refuses (400) an `iss` and `client_id` pair it does not know, and a `target_link_uri` off our origin. When `client_id` is absent and the issuer has exactly one registration, that one is used; with several, the request is refused.

20. **Name and email.** Display name is the `name` claim, else `given_name` and `family_name` joined, else "LTI user". Email is stored when present, for the profile only; it is never used to find or link an account.

21. **Rate limit.** `/lti/login` and `/lti/launch` count as sign-in starts in the existing throttle (`apps/api/src/signin-throttle.ts`, 150 a minute per address).

22. **Audit.**
    - Every launch writes an `auth.login` row, the action the admin health page already counts, with metadata `{method: "lti", platform: <registration name>, role}` and result `ok`, `denied` (disabled user) or `failed`. A failure's metadata carries only `{method: "lti", platform?, reason}` with a reason code from ruling 19. No token, claim values, name, email or context title.
    - A role change on launch writes the existing `user.role_changed` row, with `source: "lti"`.
    - The API's own log line for a refusal carries the reason code only.

23. **Course page API.** Two routes, access class `course-instructor` (new in `route-policy.ts`):
    - `GET /courses`: the courses in which the caller's membership role is `instructor`, as `[{id, title, platformName}]`. An empty list for everyone else, including administrators.
    - `GET /courses/:courseId/members`: `{course: {id, title, platformName}, members: [{displayName, role, lastLaunchAt, workspaceState}]}`, sorted by role then name. `workspaceState` is the workspace's `state`, or `null` when the member has none. It answers 404 unless the caller is an `instructor` member of that course (the same "not yours looks like nothing" rule as workspaces).
    - The response never contains emails, user ids, subjects or workspace ids.
    - Administrators do not get the Course page; the admin page already shows every user. That can change later.

24. **Web.** The header shows a "Course" link when `GET /courses` returns at least one course. `/course` lists the courses (and opens the only one directly), `/course/:courseId` shows the members table. Instructors see no admin link. `/auth/me`'s `role` can now be `instructor`, and nothing in the web app treats "not administrator" as "student" for access.

25. **The mock LMS lives in a new workspace package, `packages/mock-lms` (`@portikus/mock-lms`).**
    - Why not `packages/auth/src/testing`, where the mock IdP lives: that directory ships in the Debian package, and this mock must never be installed on the VM. `packages/users-file` already shows the pattern of a package no app depends on, which `pnpm deploy` therefore leaves out. `scripts/build-deb.sh` gains a guard that fails if `mock-lms` appears in the package.
    - It uses `jose` (already pinned in `packages/auth`) and `node:http`. No new dependency.

26. **Registering the mock on the pilot.** The pilot's API reaches the mock at `http://10.100.0.1:<port>`, the host's address on the VM network. `make lti-mock-register` adds a `mock: true` registration named `mock-lms` to the host platforms file, adds `10.100.0.1/32` to the API's allowed addresses (`portikus_api_ip_allow_extra`), and runs the play limited to the LTI tasks. `make lti-mock-unregister` removes both. While a `mock: true` registration exists, `make security-test` prints a warning naming it, and the smoke test reports it.

27. **Membership is only ever added or refreshed.** A person removed from a course in the LMS stays on the Course page with their old last-launch time. Roster sync is NRPS, which is out.

## Validation reference

The claim names, for builders:

| Claim | Name in the id_token |
|---|---|
| message type | `https://purl.imsglobal.org/spec/lti/claim/message_type` |
| version | `https://purl.imsglobal.org/spec/lti/claim/version` |
| deployment | `https://purl.imsglobal.org/spec/lti/claim/deployment_id` |
| target link | `https://purl.imsglobal.org/spec/lti/claim/target_link_uri` |
| resource link | `https://purl.imsglobal.org/spec/lti/claim/resource_link` (must have `id`) |
| roles | `https://purl.imsglobal.org/spec/lti/claim/roles` |
| context | `https://purl.imsglobal.org/spec/lti/claim/context` (`id`, `title`) |

Role URIs are matched on their last segment after `#`, for both `http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor` and the short forms. `TeachingAssistant` also appears as `membership/Instructor#TeachingAssistant`; both map to `instructor`. The authorization request to the platform carries `scope=openid`, `response_type=id_token`, `response_mode=form_post`, `prompt=none`, `client_id`, `redirect_uri=<public url>/lti/launch`, `login_hint`, `lti_message_hint` when given, `state` and `nonce`.

## The data model (migration `0015_lti`)

- `users.role`'s check constraint becomes `role IN ('student','instructor','administrator')`. The `down` restores the old one.
- `lti_login_states`: `state_hash text primary key`, `nonce text not null`, `platform_issuer text not null`, `client_id text not null`, `expires_at timestamptz not null`.
- `lti_contexts`: `id uuid primary key default gen_random_uuid()`, `platform_issuer text not null`, `context_id text not null`, `title text not null default ''`, `platform_name text not null`, `created_at`, `updated_at`; unique (`platform_issuer`, `context_id`).
- `lti_memberships`: `context_id uuid references lti_contexts on delete cascade`, `user_id uuid references users on delete cascade`, `role text not null check (role in ('student','instructor'))`, `last_launch_at timestamptz not null`; primary key (`context_id`, `user_id`); index on `user_id`.

`platform_issuer` in these tables is the plain issuer, without the `lti:` prefix.

## The mock LMS

- `node packages/mock-lms/dist/main.js` with `--port` (default 8765), `--bind` (repeatable), `--tool-url` (the Portikus public URL), `--issuer` (default `http://<first bind>:<port>`).
- A new RSA key every run, served at `/.well-known/jwks.json`. Nothing it signs outlives the process.
- `/` is the launch page: pick a person, a course and a role (default the person's seeded role), and optionally "inside a frame". Submitting starts third-party login by a top-level form POST to the tool's `/lti/login` (or loads it in an iframe for the frame case).
- Seed data: courses "CS 101 Intro to Programming" and "CS 240 Data Structures"; people Ivy Instructor (Instructor), Tom Assistant (TeachingAssistant), Sam Student and Lee Learner (Learner), Ada Admin (the institution `Administrator` role). Fixed `sub` UUIDs, so repeated launches find the same user.
- `/authorize` is the platform's auth login URL. It checks `redirect_uri`, `client_id` and `login_hint` against its own launch, then answers with an auto-submitting form that posts `id_token` and `state` to the tool.
- A defect is chosen by name, one per launch, from the launch page or `?defect=` on `/authorize`: `bad_signature`, `wrong_aud`, `expired`, `replayed_nonce` (re-posts the previous launch's id_token with the new state), `unknown_deployment`, `wrong_message_type`, `wrong_version`, `alg_none`, `wrong_target`. A launch is never wrong two ways, so a test knows which check refused it (the pulse-surveys lesson).
- It logs one line per launch with the person's seed key and the defect name, and never the id_token.
- It prints the registration JSON block to paste, and `make lti-mock-register` uses the same values.
- `make mock-lms` runs it on the host in the foreground, bound to `127.0.0.1` and `10.100.0.1` by default (`MOCK_LMS_BIND` overrides), so nobody on the LAN can launch as anyone. It is never installed on the VM.

# Tasks for parallel builders

Ownership rules:

- Each task owns only the files listed. A file not listed belongs to nobody; ask the orchestrator before touching it.
- The interfaces in this brief (the platforms file, the tables, the routes, the reason codes, the mock's URLs and defect names) are fixed, so tasks build against each other without waiting.
- The orchestrator writes `docs/STATUS.md` and `docs/BACKLOG.md` with T7.

| Task | Agent | Files it owns | Depends on | Real host |
|---|---|---|---|---|
| **T1 Data model** | builder | `packages/db/src/migrations/0015_lti.ts`, `migrations/index.ts`, `schema.ts`, `testing.ts` (an LTI user and membership helper), `db.test.ts` | none | No |
| **T2 LTI validation and roles** | builder | `packages/auth/src/lti/**` (platforms-file schema and loader, role mapping, login-request builder, id_token validator, state and nonce store); `packages/auth/src/types.ts` (`Role`, `OIDC_INSTRUCTOR_GROUP` in `mapRole`); `packages/auth/src/plugin.ts` (the two CSRF exemptions) and its tests; `packages/auth/src/index.ts`; `packages/contracts/src/auth.ts` (`Role` gains `instructor`); `packages/contracts/src/courses.ts` (new); `packages/config/src/index.ts` (`LTI_PLATFORMS_FILE`, `LTI_TOOL_KEY_FILE`, `OIDC_INSTRUCTOR_GROUP`); `packages/users-file/**` (accept and offer `instructor`, Dex group) | T1's schema types (fixed above) | No |
| **T3 API routes** | builder | `apps/api/src/routes/lti.ts` and test (login, launch, jwks, fallback page); `apps/api/src/routes/courses.ts` and test; `apps/api/src/server.ts`; `apps/api/src/auth-options.ts`; `apps/api/src/signin-throttle.ts` and test; `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts` (instructor column: every `admin` route 403, every `owner` route 404 for someone else's workspace), `ws-authz-matrix.test.ts`; any API file that treats "not administrator" as "student" | T1, T2 | No |
| **T4 Web Course page** | builder | `apps/web/src/course/**` (new); `apps/web/src/router.tsx` and test; `apps/web/src/shell/AppHeader.tsx` and test; `apps/web/src/useMe.ts`; any web file that treats "not administrator" as "student" | T2's contracts (fixed above) | No |
| **T5 Mock LMS and browser tests** | tester, with a builder for the package | `packages/mock-lms/**` (new); `pnpm-lock.yaml`; `playwright.config.ts` (a web server for the mock); `e2e/lti-launch.spec.ts`, `e2e/lti-course.spec.ts`, `e2e/lti-frame.spec.ts`, `e2e/lti-negative.spec.ts`, `e2e/a11y-course.spec.ts` (axe on the Course page and both fallback pages); `.github/workflows/ci.yml` (`lti-launch` job) | T3 and T4 for the specs to pass; the package starts at once | No |
| **T6 Deployment and host tests** | infra | `infra/ansible/roles/portikus/**` (platforms file, tool key, env lines, the `lti` tag); `infra/ansible/roles/caddy/templates/Caddyfile.j2` (no `frame-ancestors 'none'` on `/lti/*`); `infra/ansible/site.yml`; `infra/tests/caddy-preview-test.sh`; `Makefile` (`mock-lms`, `lti-mock-register`, `lti-mock-unregister`, `PORTIKUS_LTI_PLATFORMS_FILE`); `scripts/build-deb.sh` (the mock-lms guard); host firewall rule letting the VM reach `10.100.0.1:8765` if needed; `infra/tests/smoke-test.sh` (an LTI block using the mock when registered); `infra/tests/security-test.sh` and `infra/tests/security/*` (`/lti/launch` refuses a forged token, a replayed state, and a frame of `/` still gets `frame-ancestors 'none'`; an instructor session is refused on every admin route; the mock-registration warning); `infra/README.md` "LTI" | T3 for the smoke and security checks; the Ansible and Caddy parts start at once | Yes: `configure-vm` on the pilot with a local deb, `make mock-lms`, register, launch as a student and an instructor, unregister, smoke and security tests |
| **T7 Docs** | builder | `docs/OPERATIONS.md` ("Registering an LMS": Canvas developer-key fields and Moodle external-tool fields mapped to the platforms file; the new-window placement; trying the mock); `docs/adr/0025-lti-launch.md`; `docs/SPEC.md` section 29 (Epic 13 entry) and section 5.2 (`instructor` now exists); `docs/OVERVIEW.md` ("Current state"); `docs/STATUS.md`; `docs/BACKLOG.md` (close the LTI item; add the items under "Left out") | all others | No |

T1, T2, T4, the package half of T5, and the Ansible half of T6 start together. T3 starts when T1 and T2 land (or against their fixed interfaces). The specs in T5 and the host checks in T6 finish after T3 and T4. T7 comes last.

After every task has landed: code-reviewer over the epic head, security-reviewer (this epic touches auth, CSRF, cookies and the Caddy frame policy), and a11y-reviewer (it touches `apps/web`). Fixes land as further task PRs, then confirmation reviews, then the epic PR to `main`.

## What done looks like, per task

- **T1:** migration up and down on a fresh database; the role check accepts `instructor`; cascade on user delete; `pnpm test` in `packages/db` with `TEST_DATABASE_URL`.
- **T2:** a unit test per reason code in ruling 19, each against a token wrong in exactly one way; role mapping table test including `Administrator` → `instructor` and unknown → `student`; the platforms-file schema refuses each bad field; the CSRF exemption covers exactly the two POSTs (a test that `POST /lti/jwks` or `/lti/launchx` is not exempt); users-file tests for `instructor`.
- **T3:** route tests with a local signing key and JWKS server: a good launch creates the user under `lti:<issuer>`, a session, a membership and the audit row, and 303s; a disabled user is refused; a role change is audited; a second launch refreshes the role; `/lti/login` in a frame returns the fallback page with the platforms' `frame-ancestors`; LTI off means 404; the authorization matrix has an instructor column; no log line contains the token (a test captures the log).
- **T4:** component tests for the Course list and members table (empty, one course, several); the header link shows only when there is a course; no admin link for an instructor.
- **T5:** Playwright: a student launch lands in the workspace; an instructor launch shows the Course page with the student who launched before; each defect is refused with the error page; the frame case shows the button and the button opens a working new tab; an instructor gets 403 from admin routes in the browser; axe finds no violations. The CI job runs the LTI specs against the mock and Postgres, like `dex-signin`.
- **T6:** the play is idempotent with and without a platforms file; `configure-vm` on the pilot with the epic's deb; the smoke test's LTI block passes against the registered mock and skips cleanly when none is registered; the security test passes; the mock is unregistered at the end and `dpkg -s portikus` recorded before and after.
- **T7:** every doc named above updated; `pnpm lint` passes.

# Real-host constraints

- The pilot is live with student workspaces. Nothing may stop, rebuild, reset or restore a student workspace or volume.
- Pilot changes go through `make configure-vm` or the `lti` tag, out of class hours, after the usual snapshots and `pg_dump` (OPERATIONS.md, "Before a change").
- The mock LMS is registered on the pilot only while Todd is trying it, and unregistered afterwards. A user created by a mock launch stays in the database; T6 lists them, and Todd decides whether to archive them.
- The pilot never stays on a package that has not been merged to `main`.

# Risks and open questions

1. **Egress to a real LMS.** The API unit allows only loopback plus `portikus_api_ip_allow_extra`. A cloud LMS's keyset URL has changing addresses, so a real registration needs a broad allow list, which weakens the API sandbox. Recommended for the first real course: allow the LMS's published ranges if it has them, and otherwise accept `0.0.0.0/0` for the API only, recorded in the threat model. A small keyset-fetch proxy is the stronger fix, left for later.
2. **Third-party cookie rules keep changing.** The design never needs a cookie inside a frame, so it holds under today's rules. Safari's and Chrome's handling of a `SameSite=None` cookie on a cross-site top-level POST is the one assumption; the Playwright spec pins it for Chromium, and T6 tries Firefox by hand against the pilot.
3. **Canvas and Moodle quirks** (Canvas's shared issuer, Moodle's `TeachingAssistant` spelling, deployment ids that change when a tool is re-added in a course). The mock is only as faithful as its seed; the first real registration is the real test. T7's OPERATIONS section says how to read the refusal reason from the audit log.
4. **A student who is also a Dex user has two accounts and two workspaces.** Accepted: linking is left out on purpose (ruling 3).
5. **An instructor who teaches but also wants administrator rights** keeps a separate Dex administrator account. Accepted.

# Left out

- LTI Advantage services: grade passback (AGS), roster sync (NRPS), Deep Linking.
- Dynamic registration, and an administrator UI for platforms.
- Linking an LTI account to a Dex account, by email or otherwise.
- Instructor access to student workspaces or files (SPEC.md section 31).
- Removing members who left the course (needs NRPS).
- Course templates and any per-course workspace settings.
- The LTI platform-storage postMessage API for cookie-less frames.
- A Course page for administrators.
