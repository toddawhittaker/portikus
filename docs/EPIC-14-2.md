# Epic 14.2: One front door

This is the working brief for Epic 14.2 (issue #537). It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. It builds ADR 0031 ("Dex is the only sign-in front door, with a local administrator made at install") and replaces the BACKLOG entry "One front door: Dex for every site". It changes what Epic 14 built (`docs/EPIC-14.md`, ADRs 0027 and 0028) and comes before Epic 15 (`docs/EPIC-15.md`), whose 2026-09-25 amendment already assumes it. The entry "Sign-in setup in the admin area" stays in the BACKLOG and is not part of this epic.

- **Base commit:** `main` once Epic 14.1 has merged. **Epic branch:** `epic/14-2-one-front-door`. Builders reset to `origin/epic/14-2-one-front-door` and branch `task/14-2-<name>` from it.
- **Migration number:** `0019_local_admin` is reserved for T2. No other task adds a migration. (Epic 14's setup-code table is `0018_setup_codes`, not the `0017` its brief names; `0017` is `0017_session_method`. No branch holds a `0019`.)

Todd answered the brief's two open questions on 2026-09-25; they are rulings 5 and 17.

## Terms used throughout

- **OIDC** (OpenID Connect): the sign-in standard Portikus speaks. The service that signs people in is the **provider**; it sends a signed **ID token** whose fields are **claims**. **`sub`** is the claim that names the person permanently.
- **Dex**: the small OIDC provider Portikus runs beside the API (ADRs 0023 and 0028). A Dex **connector** is an upstream source of people (Microsoft, Google, an LDAP directory, or any OIDC provider). Dex's **local passwords** are accounts Dex holds itself, managed through its **gRPC API** (Google's remote procedure call protocol) on loopback behind mutual TLS.
- **Entra ID**: Microsoft's identity service. A **tenant** is one organisation in it. An **app role** is a role defined on an app registration and assigned to people or groups; it arrives in the ID token's `roles` claim.
- **LTI** (Learning Tools Interoperability): opening Portikus from a course in the learning management system. Unchanged by this epic.
- **The local administrator**: the one Dex local-password account every install gets, made by setup, with the `administrator` grant. It is the way in when the institution's sign-in is broken.
- **The flag**: "must change password", a column on the Portikus account. While it is set, that account can use only the change-password page.
- **The role rule** (EPIC-13-1 ruling 20): each account has a `provider_role` from its sign-in, an optional `granted_role` (`instructor` or `administrator`) stored by Portikus, and an effective `role`, the higher of the two.

## What the user gets

- Every site signs people in through Dex, plus LTI launches. A site with an institutional provider connects it to Dex as one connector: Microsoft Entra ID, Google Workspace, an LDAP or Active Directory directory, or any other OIDC provider (Okta, Keycloak, Shibboleth with its OIDC plugin). Dex's own passwords are always available beside it.
- Under Entra, people from the site's tenant who hold one of the three Portikus app roles sign in, and their role comes from that app role, as in Epic 14. Grants in the Users view still raise a role.
- Under any other OIDC provider, Dex passes on the provider's groups claim, and people in none of the named groups are refused.
- Every install has a local administrator. At the end of setup the operator is told where to read its one-time password, which is never shown in a log. The first sign-in with it opens a page that only lets them set a new password; after that it is an ordinary administrator account.
- If every administrator is locked out, or the institution's sign-in breaks, root on the host runs `portikus reset-admin`: a new one-time password, the administrator grant back, every session of that account ended.
- Anyone with a Dex local password can change it from Settings, Password. A person given a password by an administrator (Add user or Reset password) must choose their own at first sign-in.
- The setup code, the `/setup` page and its first-account form are gone.

## Rulings

Rulings marked **(user)** came from Todd, **(orchestrator)** from the orchestrator, and **(brief)** were made in this brief.

### One front door

1. **(user)** ADR 0031 in full. Portikus signs people in through Dex only, plus LTI. Each institution provider is one Dex connector: `google`, `ldap` or `oidc` (Entra is the `oidc` connector, ruling 5; this replaces the ADR's first choice, the `microsoft` connector). Dex's local passwords are always on. The API's direct Entra, Google and generic OIDC paths are removed; its one issuer is Dex.
2. **(brief)** **"One issuer" is a property of every deployed site, not a new check in the API.** The API keeps its plain OIDC client against `OIDC_ISSUER_URL`, with no provider-specific branches. Ansible always points it at Dex, except under `portikus_idp: mock` (development, CI and Playwright), where it points at the in-repo mock provider as today. Reason: the generic client is what talks to Dex; only the Entra and Google branches were extra.
3. **(brief)** **Removed from the API:** `OIDC_PROVIDER` and its values `entra` and `google`, `OIDC_ALLOWED_TENANT`, `OIDC_ALLOWED_DOMAINS`, the `tid` and `hd` admission checks and their audit reasons `tenant_not_allowed` and `domain_not_allowed`, the skipped userinfo call for Entra and Google, and the `hd` login hint. The API always calls userinfo, as it does for Dex today, because Dex puts `groups` there. Reason: Dex's connector options now do the admitting (ruling 6).
4. **(brief)** **`OIDC_DEFAULT_ROLE` stays, and Ansible sets it to `student` on every Dex site.** The local administrator and every guest have no groups, and `mapRole` refuses before a grant is looked at, so `none` would lock the local administrator out under any upstream that used it (Entra and generic OIDC did). `none` remains the config default for the mock, where Playwright's `dave` (no groups) must still be refused. Reason: keeps one setting and every existing test; removing it would touch the mock's refusal tests for no gain.

### Connectors

5. **(user, 2026-09-25)** **Entra through Dex's generic `oidc` connector, with roles from Entra app roles**, not through Dex's `microsoft` connector. The `microsoft` connector can read groups only with the delegated Microsoft Graph permission `Directory.Read.All`, which needs a tenant administrator's consent; the `oidc` connector reads the app roles Epic 14 used straight from the ID token, with no Graph permission and no Graph host on the egress list. **(brief)** Details:
    - `portikus_dex_upstream: entra` renders an `oidc` connector with `id: entra`, `name: Microsoft`, `issuer: https://login.microsoftonline.com/<tenant ID>/v2.0` (the tenant's own issuer, so only that tenant's tokens validate; guests invited into the tenant are included), `scopes: [openid, profile, email]`, `getUserInfo: false`, `insecureEnableGroups: true`, `claimMapping.groups: roles` with `overrideClaimMapping: true`, `allowedGroups` set to the three app role values, `insecureSkipEmailVerified: true` (Entra sends no `email_verified`) and `pkceChallenge: S256`.
    - The app role values default to `Portikus.Student`, `Portikus.Instructor` and `Portikus.Administrator` (the `PORTIKUS_OIDC_*_GROUP` inputs change them); the API maps them with its three group settings and asks for the `groups` scope. Someone with none of the three is refused by Dex, as Epic 14 refused them; "Assignment required" on Dex's app registration stays recommended.
    - App roles are assigned only by the tenant's administrators, so a student cannot make one; the play's refusal of the `groups` scope behind an Entra upstream is removed.
    - `portikus_dex_upstream: microsoft` is refused by the play with a message naming `entra`. Nothing on the pilot uses it.
6. **(brief)** **Admission moves into Dex, per connector:**

    | Connector | Who may sign in | `provider_role` from | No group matched |
    |---|---|---|---|
    | local passwords | people an administrator added, and the local administrator | nothing (grants) | student |
    | `entra` (the `oidc` connector) | the tenant's people with one of the three app roles | the `roles` claim | refused by Dex |
    | `google` | the listed domains (`hostedDomains`) | nothing (grants) | student |
    | `ldap` | people the required user filter admits | directory groups | student |
    | `oidc` | members of one of the three groups (`allowedGroups`) | the groups claim | refused by Dex |

    A person Dex refuses sees Dex's own error page and never reaches Portikus, so the refusal is in Dex's log, not Portikus's audit table. Reason: Portikus cannot see a sign-in Dex stopped; SPEC 24.11's "authentication failure" is met by Dex's JSON log for those.
7. **(brief)** **Dex's generic `oidc` connector** is added, for Okta, Keycloak, Shibboleth's OIDC plugin and anything else. It renders `issuer`, `clientID`, `clientSecret`, `redirectURI`, `scopes: [openid, profile, email]` plus `portikus_oidc_upstream_extra_scopes` (Okta, for one, sends groups only when asked for a `groups` scope), `getUserInfo: true` (as Epic 14 did for generic OIDC), `insecureEnableGroups: true`, `claimMapping.groups` from `portikus_oidc_upstream_groups_claim` (default `groups`) with `overrideClaimMapping: true`, `allowedGroups` set to the three group names, and `pkceChallenge: S256`. Reason: these are the options the pinned Dex (v2.45.1, `11d2eeb`) has; `allowedGroups` keeps Epic 14's "no group, no account" rule for generic OIDC.
8. **(brief)** **Still one upstream connector per site** (EPIC-14 ruling 13), beside local passwords. `google` is unchanged: its groups need a Google service account and the Admin SDK, which stays left out.
9. **(brief)** **Ansible variables.** `portikus_idp` takes only `dex` and `mock`. `portikus_dex_upstream` takes `none`, `ldap`, `entra`, `google` and `oidc`. The generic connector's settings are `portikus_dex_upstream_issuer` (new) and the existing `portikus_dex_upstream_client_id` and `portikus_dex_upstream_client_secret`. The API's `portikus_oidc_client_id`, `portikus_oidc_client_secret` and `portikus_oidc_issuer` environment inputs (`PORTIKUS_OIDC_CLIENT_ID`, `PORTIKUS_OIDC_CLIENT_SECRET`, `PORTIKUS_OIDC_ISSUER`) are removed: the API's client is always Dex's generated static client. A play with `PORTIKUS_IDP` set to `entra`, `google` or `external` fails before any role runs, naming `PORTIKUS_DEX_UPSTREAM` and OPERATIONS.md's section. Reason: a clear failure beats a silent change of issuer, which would give everyone a new empty account.

### The local administrator

10. **(user)** Every install has a local administrator in Dex with a random password unique to the install (at least 80 random bits), stored by Dex only as a bcrypt hash, which must be changed at first sign-in. Fixed default passwords are rejected.
11. **(brief)** **Its Dex user ID is the constant `local-admin`**, so its subject is `dexLocalSubject("local-admin")` under the site's Dex issuer. Reason: `reset-admin` can always find the Portikus account and the Dex password, and recreating a removed password gives back the same subject, so the same account and workspace. The subject is not a secret; it is unique per site because the issuer is.
12. **(orchestrator)** **Its email is `portikus_admin_email`**, default `admin@<portikus_public_host>`; Epic 15 asks it through debconf. **(brief)** It is set when the account is created; changing the variable later does not change an existing account (Dex cannot change a password's email in place). A new email means removing the account in the Users view and running `portikus reset-admin --email <new>`. If another Dex password already has that email, creation fails and names the variable. Reason: the rare case gets a manual step instead of code.
13. **(brief)** **The password** is `generateDexPassword()`, the 20-character readable password Add user already makes (about 115 bits), hashed at bcrypt cost 10. The Portikus account is created with `precreateDexAccount` (the Add user path), with `granted_role = 'administrator'`, `role = 'administrator'` and the flag set.
14. **(orchestrator)** **The password never reaches a log or the journal** (STACK.md section 15, ADR 0012). It is written to `/etc/portikus/admin-password`, owner root, mode 0600, and the command or the play prints only: `Read the local administrator's one-time password with: sudo cat /etc/portikus/admin-password`.
15. **(brief)** **The stale file.** The API runs unprivileged and cannot delete a root-only file. Once the password has been changed, the file holds a password that no longer works, so it is harmless; the play (and so, after Epic 15, `portikus setup`) removes it on its next run when the flag is clear, and `reset-admin` overwrites it. The change-password page's success message says "The one-time password no longer works." Reason: that is honest and needs no privileged helper; a root timer or path unit to delete it sooner was rejected as a new moving part for a dead secret.
16. **(orchestrator)** **Settings, Password, for every Dex local account.** The current password is checked through Dex's gRPC `VerifyPassword`, and the new hash is written with `UpdatePassword`; both exist in the pinned `api.proto` (`packages/auth/proto/dex-api.proto`), and the client gains one method, `verifyPassword`. While the flag is set, the same form is the only page that account can reach. **(brief)** This is a small addition (about a day across server and web), because the flag needs the form anyway; it is not narrowed.
    - `POST /me/password` with `{currentPassword, newPassword}`, CSRF-checked. 404 when `DEX_GRPC_ADDR` is unset; 400 `NOT_LOCAL_PASSWORD` when the account is not a Dex local password (its issuer is not `OIDC_ISSUER_URL`, its subject does not decode with `dexLocalUserId`, or Dex holds no password with that user ID); 400 `VALIDATION_FAILED` when the new password is shorter than 15 characters, longer than 72 bytes (bcrypt's limit), or equal to the current one; 403 `WRONG_PASSWORD` for a wrong current password.
    - Wrong current passwords count against a per-address throttle of 10 per 10 minutes (the setup code's throttle, renamed), answering 429 and auditing the first refusal as `auth.throttled`.
    - On success: the new bcrypt hash (cost 10) goes to Dex, the flag clears, every other session and preview session of the account ends (the current one stays), and `user.password_changed` is written with `{ip, userAgent}` and no password or hash. A wrong current password writes `user.password_changed` `failed`.
    - The 15-character minimum follows NIST SP 800-63B revision 4 for a password used as a single factor; there are no composition rules.
17. **(user, 2026-09-25)** **A password an administrator sets must be changed at first sign-in.** Add user and Reset password in the Users view set the flag on the account, as `reset-admin` does. **(brief)** The dialog that shows the password once adds: "They will choose their own password when they first sign in." Reset password already ends the account's sessions, so the flag takes effect at the next sign-in.
18. **(brief)** **The gate.** `loadSession` returns `mustChangePassword` on the session user. While it is true, the auth plugin answers `403 {code: "PASSWORD_CHANGE_REQUIRED"}` to every request except `GET /auth/me`, `POST /me/password`, `POST /auth/logout` and the routes that need no session today (`/health`, `/auth/*`, the LTI routes); a WebSocket upgrade is refused the same way; and the preview gateway (`/preview/authorize`, `/__portikus/*`), which loads sessions by id, refuses the account too. `/auth/me` also gains `localPassword` (the account is a Dex local password), which the web uses to show Settings, Password. The web sends every page to `/change-password` while the flag is set. Reason: the server enforces it, so a hand-typed URL or an old tab cannot skip it.
19. **(user)** **`portikus reset-admin`**, run by root on the host, replaces the setup code, `/setup`, its claim route and the first-account form. **(brief)** What it does, in one database transaction plus Dex calls:
    - finds the Dex password with user ID `local-admin`; if there is none, creates it with the email from `--email`, else the account's stored email, else `admin@<host of PUBLIC_URL>`;
    - sets a new random password (ruling 13) and writes it to `/etc/portikus/admin-password` (ruling 14);
    - creates the Portikus account if it is missing, or re-enables it (`disabled_at = null`), sets `granted_role = 'administrator'` and recomputes `role`, and sets the flag;
    - ends every session and preview session of the account;
    - writes `local_admin.created` or `local_admin.reset`, actor `host:root`, target the account id, with no password, hash or email.

    With `--if-missing` it does nothing when a Portikus account with that subject exists, even a disabled one, so an administrator's deliberate Remove in the Users view is not undone by a later play run; it then exits with status 10 when the flag is still set and 11 when it is clear, which the play uses for ruling 15.
20. **(brief)** **How it runs.** The package ships `/usr/bin/portikus`, a shell script with one subcommand, `reset-admin`; Epic 15 adds `setup` and `status` to the same script (its ruling 15). It refuses to run unless it is root and `/etc/portikus/api.env` names `DEX_GRPC_ADDR`. It runs the Node entry point `reset-admin-main.js` in `@portikus/auth` with `systemd-run --wait --pipe --quiet --uid=portikus -p EnvironmentFile=/etc/portikus/api.env`, so the entry point sees exactly the API's settings (database, Dex gRPC files, issuer, public URL) parsed as systemd parses them, and its standard output, which carries only the password, goes straight into the root-only file through the pipe (`umask 077`, a temporary file, then `mv`), never through the journal. Reason: no second settings parser, no new configuration file, and the same code path for the play and for an operator at 2 a.m.

### The pilot, and the order of work

21. **(brief)** **Egress.** The API's own outbound requests to a provider disappear: it reaches only Dex (through Caddy, under the site's own name, as today) and LMS keysets. The allow list for sign-in is Dex's connector: the discovery document of the tenant issuer for `entra` (without its userinfo host, so no `graph.microsoft.com`), Google's issuer for `google`, `portikus_dex_upstream_issuer` for `oidc` (with its userinfo host), and nothing for `ldap` (Dex's `IPAddressAllow` drop-in, as today).
22. **(orchestrator)** **The pilot runs Dex already; its accounts and subjects do not change.** The pilot has no upstream connector, so only the migration (the flag column, the setup-code table dropped) and the new local administrator touch it. The play creates the local administrator on the pilot too; carol stays an administrator by grant.
23. **(orchestrator)** Built as its own epic branch, `epic/14-2-one-front-door`, from `main` after Epic 14.1 merges, and before Epic 15.

## Data model and configuration

**Migration `0019_local_admin`:** `alter table users add column must_change_password boolean not null default false`; `drop table setup_codes`. The `down` recreates `setup_codes` exactly as `0018_setup_codes` made it (empty) and drops the column.

**API settings (`packages/config`):**

| Setting | Change |
|---|---|
| `OIDC_PROVIDER`, `OIDC_ALLOWED_TENANT`, `OIDC_ALLOWED_DOMAINS` | removed, with their refinements and `oidcAllowedDomains` |
| `OIDC_DEFAULT_ROLE` | kept; Ansible writes `student` for `dex`, `none` for `mock` |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM`, the three group settings | kept; Ansible fills them from Dex's client and the connector's groups |
| `DEX_GRPC_*`, `OUTBOUND_PROXY_URL` | unchanged |

**Contracts:** `AuthUser` (so `MeResponse`) gains `mustChangePassword: boolean` and `localPassword: boolean`. New `ChangePasswordRequest {currentPassword, newPassword}`. `packages/contracts/src/setup.ts` is removed.

**Ansible variables:**

- `portikus_idp`: `dex` or `mock`.
- `portikus_dex_upstream`: `none`, `ldap`, `entra`, `google`, `oidc` (`microsoft` refused).
- New: `portikus_admin_email`; `portikus_dex_upstream_issuer`, `portikus_oidc_upstream_groups_claim`, `portikus_oidc_upstream_extra_scopes` (for `oidc`).
- Removed: `PORTIKUS_OIDC_ISSUER`, `PORTIKUS_OIDC_CLIENT_ID`, `PORTIKUS_OIDC_CLIENT_SECRET` as inputs; `portikus_oidc_provider`; `portikus_entra_issuer` and `portikus_google_issuer` stay only as the connectors' discovery sources; `portikus_setup_code_script`.
- The three `PORTIKUS_OIDC_*_GROUP` inputs stay: the group names for `ldap` and `oidc`, and the app role values for `entra` (defaulting there to `Portikus.Student`, `Portikus.Instructor` and `Portikus.Administrator`).

**Files on the host:** `/usr/bin/portikus` (package, root, 0755); `/etc/portikus/admin-password` (written by `reset-admin`, root, 0600).

**Audit events (SPEC 24.11):** `local_admin.created`, `local_admin.reset` (actor `host:root`); `user.password_changed` (`ok` or `failed`); `auth.throttled` for the change form. Every sign-in to the local administrator is already an `auth.login` row, like any other account's. `setup.code_issued` and `setup.code_claimed` are no longer written; old rows stay.

## The flows

1. **A new install.** The play installs the package, starts the services, and runs `portikus reset-admin --if-missing --email <portikus_admin_email>`. It prints the email and the "read it with" line. The operator reads the file, opens the site, chooses "Log in with Email" on Dex's page, and signs in. Portikus shows only **Set a new password** (current password, new password twice). On success they land on the workspace page as an administrator, and the next play run removes the file.
2. **Recovery.** Every administrator is locked out, or the institution's provider is down. Root runs `sudo portikus reset-admin`, reads the file, signs in with the local password, sets a new one, and fixes things from the admin area.
3. **An Entra sign-in.** Dex sends the person to the tenant; Microsoft asks for their second factor under the tenant's rules; Dex validates the ID token against the tenant's issuer, reads its `roles` claim, refuses the person if none of the three app roles is there, and otherwise hands Portikus a token whose `groups` holds the matching roles; `mapRole` maps them.
4. **A generic OIDC sign-in.** Dex sends the person to the provider, reads the configured groups claim, refuses them if none of the three names match, and passes on the groups.
5. **A new Dex user.** An administrator uses Add user and passes the password on. The person signs in with it and sees only **Set a new password** until they choose their own. Reset password works the same way.
6. **Changing a Dex password.** Settings, Password: current password, new password twice. The API checks the current one with Dex and stores the new hash in Dex; other sessions end.

## Security invariants to test

- No code path in the API reads `tid` or `hd`, and no configuration value selects a provider-specific branch.
- The local administrator's password appears in exactly one place, the root-only file: never on standard output of the play or the command, in the journal, in an API log line, in an audit row, or in a response body.
- While the flag is set, every API route except those ruling 18 lists answers 403 `PASSWORD_CHANGE_REQUIRED`, a WebSocket upgrade is refused, and the preview gateway refuses the account.
- `POST /me/password` refuses a wrong current password, is throttled, refuses a non-local account (an SSO account, a course account, an upstream-connector account), never changes another account's password, and ends the account's other sessions on success.
- `reset-admin` restores the administrator grant, re-enables a disabled account, sets the flag and ends every session of that account; `--if-missing` never touches an existing account.
- Under `entra`, a token from another tenant is refused (issuer mismatch), and a person with no Portikus app role is refused by Dex.
- Add user and Reset password leave the flag set, so an account an administrator gave a password to can use nothing but the change form until it changes it.
- Under `oidc`, a person in none of the allowed groups is refused by Dex.
- `/setup`, `/setup/state`, `/setup/claim` and `/setup/first-account` answer 404, and `route-policy.ts` and the authorization matrix list none of them.

## Tasks for parallel builders

Each task owns only the files listed; ask the orchestrator before touching any other. The settings, contracts, entry point name and exit codes above are fixed, so T3 can build against T2 before it lands.

| Task | Agent | Files it owns | Depends on | Estimate |
|---|---|---|---|---|
| **T1 One issuer** | builder | `packages/config/src/index.ts` and test; `packages/auth/src/types.ts`, `oidc.ts` and their tests; `packages/auth/src/testing/mock-oidc.ts`, `testing/index.ts` (remove eve, ian, gina, gabe, gus, the `tid`, `roles` and `hd` claims and the constants only they use; erin stays as a link target); `apps/api/src/auth-options.ts`, `test-support.ts`; `apps/api/src/routes/auth.ts` and `auth.test.ts` | none | 1 day |
| **T2 Local administrator and password change (server)** | builder | `packages/db/src/migrations/0019_local_admin.ts`, `migrations/index.ts`, `schema.ts`, `db.test.ts`, `testing.ts`; `packages/auth/src/local-admin.ts`, `reset-admin-main.ts` (new) and tests; `dex-api.ts` (`verifyPassword`) and its tests; `testing/fake-dex-grpc.ts`; `sessions.ts`, `plugin.ts`, `index.ts` and tests; remove `setup-code.ts`, `setup-code-main.ts`, `setup-code.test.ts`; `packages/contracts/src/auth.ts`, `index.ts`, remove `setup.ts`; `apps/api/src/routes/me-password.ts` (new) and test, remove `routes/setup.ts` and test; `apps/api/src/routes/auth.ts` and test (`/auth/me` fields only, after T1); `apps/api/src/routes/preview.ts` (the gate only); `apps/api/src/routes/admin-dex-users.ts` and test (set the flag); `packages/auth/src/links.ts` (`precreateDexAccount` takes the flag); `apps/api/src/signin-throttle.ts`; `apps/api/src/server.ts`, `security/route-policy.ts`, `authz-matrix.test.ts` | T1 (shares `auth.ts`, `types.ts`, `index.ts`) | 2 days |
| **T3 Dex connectors, the play and the command** | infra | `infra/ansible/site.yml`; `infra/ansible/roles/dex/**` (the `oidc` connector and its `entra` preset in place of `microsoft`, settings guards); `infra/ansible/roles/portikus/**` (api.env, remove the setup-code tasks, run `portikus reset-admin --if-missing`, remove the stale file); `infra/ansible/roles/egress_proxy/**` only if ruling 21 needs it; `infra/ansible/roles/caddy/templates/Caddyfile.j2` (remove `handle /setup/*`); `packaging/bin/portikus` (new), `packaging/nfpm.yaml`, `scripts/build-deb.sh` if it lists shipped files; `infra/tests/dex-render-test.yml` and fixtures, `egress-proxy-render-test.yml`, `caddy-preview-test.sh`, `smoke-test.sh`, `security-test.sh`, `security/lib.sh`, `rebuild-exercise.sh` (the `PORTIKUS_IDP` values); `Makefile` (help text, the rehearsal comment) | T2 for the rehearsal run only | 1.5 days |
| **T4 Web and Playwright** | builder, then tester for e2e | `apps/web/src/password/**` (new: the change-password page and the Settings section's form); `apps/web/src/settings/sections.ts`, `SettingsDialog.tsx` and tests; `apps/web/src/admin/DexUserDialogs.tsx` and test (the added sentence); `e2e/admin-dex-users.spec.ts`; `apps/web/src/router.tsx` and test; `apps/web/src/useMe.ts`; remove `apps/web/src/setup/**`; `apps/web/vite.config.ts` (remove the `/setup/` proxy); `e2e/fake-dex-grpc.mjs` (`VerifyPassword`); `e2e/change-password.spec.ts`, `e2e/a11y-change-password.spec.ts` (new); remove `e2e/setup.spec.ts`, `e2e/a11y-setup.spec.ts` | T2 | 1.5 days |
| **T5 CI against the real Dex** | tester | `.github/workflows/ci.yml` (the `dex-signin` job only); `packages/auth/src/dex.integration.test.ts`, `dex-api.integration.test.ts`, `testing/dex-signin.ts`; `testing/mock-oidc.ts` (the `roles` claims, after T1 has landed); a new `infra/tests/fixtures` entry for the `oidc` render | T1, T2, T3 | 1 day |
| **T6 Docs, rehearsal and pilot** | builder for docs, infra for the rehearsal and pilot | `docs/SPEC.md` (5.1, 5.2, 5.3, 24.11, 29); `docs/EPIC-14.md` (a superseded note per ruling); `docs/adr/0031` (status to built), `0028` and `0023` (status lines); `docs/OPERATIONS.md` (every provider section, "The first administrator" becomes "The local administrator"); `infra/README.md`; `docs/OVERVIEW.md`; `docs/STATUS.md`; `docs/BACKLOG.md`; `docs/EPIC-15.md` (its amendment's `microsoft` connector becomes the `entra` preset of the `oidc` connector) | all others | 1.5 days docs, 1 day rehearsal and pilot |

T1, and T3's connector and render work, start together. T2 starts when T1 lands. T4 starts when T2 lands; T5 when T2 and T3 have. T6 is last. Total work is about 9.5 agent-days; with the parallel starts it is about 6 working days end to end, a little over the BACKLOG's "about a week".

After every task has landed: code-reviewer over the epic head, security-reviewer (auth, sessions, the gRPC boundary, the root command and the password file), and a11y-reviewer (`apps/web`).

## Test plan, per task

- **T1 (unit and API route tests through the mock):** config tests that the removed settings no longer exist in the schema and that `OIDC_DEFAULT_ROLE` still takes `none` and `student`; route tests through the real `openid-client` and the mock for alice, carol and dave under both default roles; the Entra- and Google-shaped tests are deleted, not skipped. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- **T2 (unit, database and API route tests):** migration up and down on a fresh database; `local-admin.ts` against a database and the fake gRPC server: create, create again with `--if-missing` (nothing changes), reset after a disable and a demotion (grant and enable restored, flag set, sessions and preview sessions gone), recreate after the Dex password was deleted (same subject, same account id), the email-taken refusal; a captured log and captured standard error hold no password; `reset-admin-main` exit codes 0, 10 and 11. Route tests that Add user and Reset password set the flag. Route tests for `POST /me/password`: success (Dex hash changed, flag cleared, other sessions ended, current one kept, audit row without secrets), wrong current password (403, audit `failed`), the throttle (429 on the eleventh), too short, over 72 bytes, same as current, an SSO account, a course account, 404 with `DEX_GRPC_ADDR` unset. Gate tests: a flagged session gets 403 `PASSWORD_CHANGE_REQUIRED` from a sample of routes across every router file (the authorization matrix gains a flagged-user column), a WebSocket upgrade is refused, the preview authorize subrequest is refused, and `/auth/me` answers. The `/setup` routes answer 404.
- **T3 (render and host tests):** `dex-render-test.yml` gains the `oidc` connector (its `allowedGroups` and claim mapping) and the `entra` preset (the tenant issuer, `roles` as groups, the three app roles allowed, no userinfo, and the `groups` scope in api.env), and refusals for `PORTIKUS_IDP=entra`, `google` and `external`, for `PORTIKUS_DEX_UPSTREAM=microsoft`, for an `entra` tenant ID that is not a GUID, and for `oidc` without an issuer. `egress-proxy-render-test.yml` checks that an `entra` site's list has the tenant's hosts and not `graph.microsoft.com`. `caddy-preview-test.sh` checks `/setup/*` is no longer routed. `ansible-lint` passes. On the rehearsal VM: a fresh install creates the local administrator, the play output holds no password, `/etc/portikus/admin-password` is root 0600, a second play run changes nothing, and after the password is changed a third run removes the file. `make smoke-test` and `make security-test` pass.
- **T4 (Playwright and component tests):** a mock-provider user whose `sub` is `dexLocalSubject("local-admin")` is added to the mock's table for e2e. The spec runs `reset-admin-main` against the e2e database and the fake Dex gRPC server, signs in as that user, and checks that every page it opens lands on **Set a new password**; a wrong current password shows an error and the field keeps focus; a short password is refused with the rule shown; a good change lands on the workspace page with the administrator link. Settings, Password is present for that user and absent for alice (an SSO account). The Add user and Reset password dialogs show the added sentence. `/setup` shows the not-found page. axe on the change page and the Settings section, in both themes.
- **T5 (CI `dex-signin` job):** against the real pinned Dex with PostgreSQL storage and the gRPC API: run `reset-admin-main` into a CI database, sign in through Dex's password form with the printed password, see the flag through `/auth/me`, change the password through `POST /me/password` (a real `VerifyPassword` and `UpdatePassword`), sign in again with the new one, and see the old one refused. A second Dex configuration adds the generic `oidc` connector pointed at the mock provider (started with `mock-oidc-main.ts` on `127.0.0.1:3002`, `MOCK_OIDC_REDIRECT_URI` set to Dex's callback, and `pkceChallenge: S256`, which the mock requires): carol signs in through Dex with her mock groups and becomes an administrator by group, alice a student, and dave (no groups) is refused by Dex's `allowedGroups`. The same job covers the Entra shape: a third configuration renders the `entra` preset with the mock as its issuer (`portikus_entra_issuer` overridden), and the mock's users gain `roles` claims for it (erin `Portikus.Student`, carol `Portikus.Administrator`, ian none), so erin signs in as a student, carol as an administrator, and ian is refused. Also in T5: a password made by Add user through the real Dex leads to the flag at first sign-in.
- **T6:** `pnpm lint` passes with the docs; the rehearsal and pilot steps below, with results in STATUS.md.

## Rehearsal and pilot, in order

1. **Rehearsal VM, fresh:** `make rehearsal-up`, deploy the epic head's package with `PORTIKUS_IDP=dex`, follow flow 1, and run the smoke and security tests.
2. **Rehearsal VM, with a pilot backup restored:** restore the latest pilot backup (Portikus and `dex` databases), record `select oidc_issuer, oidc_subject, id from users order by id` and every workspace's owner, deploy, and check the same query gives the same rows plus exactly one new account (the local administrator), and every workspace keeps its owner. carol, alice and bob sign in; the local administrator signs in and changes its password; `portikus reset-admin` works a second time.
3. **Pilot:** snapshot the VM and take a fresh `pg_dump` of both databases (as OPERATIONS.md's Dex cutover did), deploy from `origin` with the full role, repeat step 2's checks, and run `make smoke-test`. Rollback is the snapshot, or the previous package with migration `0019`'s `down`.

Epic 15 is built only after this has landed on `main` and the pilot has run it.

## SPEC.md changes (T6)

- **5.1 Authentication:** the "Added by Epic 14" list is replaced by: every site signs in through Dex, plus LTI; each institution provider is one Dex connector (`google`, `ldap`, or `oidc`, which also serves Entra with its app roles) beside Dex's local passwords; accounts are keyed by Dex's issuer and `sub`; every install has a local administrator with a one-time password that must be changed, and `portikus reset-admin` on the host is the recovery path; nobody becomes an administrator by signing in first. The Entra-by-`tid` and Google-by-`hd` bullets and the setup-code bullet go.
- **5.2 Authorization:** roles come from the connector's groups (directory groups, Entra app roles, or a generic provider's groups claim) or from grants; a password an administrator set must be changed at first sign-in; Dex refuses people outside the connector's admission rules before Portikus sees them.
- **5.3 Session security:** one line: an account that must change its password can use only the change-password page, and a password change ends its other sessions.
- **24.11 Audit logging:** names `local_admin.created`, `local_admin.reset` and `user.password_changed` as break-glass and authentication events, notes that sign-ins Dex refuses are in Dex's log, and says no password or hash is ever recorded.
- **29:** a new "Epic 14.2 — One front door" entry with its includes and acceptance, and the Epic 14 entry's direct-provider and setup-code lines marked superseded.

## EPIC-14 rulings superseded

Rulings 2 and 3 (direct Entra and Google), 6 (generic OIDC by configuration only), 8, 9 and 10 (the `tid` and `hd` checks and skipping userinfo), 11 (its table and the per-provider default role, replaced by ruling 6 here), 13 in part (Dex's generic OIDC connector is now built), 15 to 18 (the setup code and the first-account form), 28 in part (the API's discovery hosts; only Dex's connectors' remain), and 31 in part (the Entra- and Google-shaped mock users and the `/setup` tests). From "Left out", Dex's generic OIDC connector and self-service password change for Dex accounts are now built. ADR 0028's first-administrator part was already marked superseded by ADR 0031.

## Unverified until a real tenant exists

- The `entra` preset against a real tenant: that the ID token carries `roles`, `name` and `email` (Entra sends `email` only when the account has a mail address, or when the optional `email` claim is added to the registration), and that a guest's token comes from the tenant's issuer.
- The `oidc` connector against real Okta, Keycloak or Shibboleth (the mock stands in).
- That the Dex sign-in page reads well with two choices, "Log in with Email" and the institution's.

OPERATIONS.md lists these as the first checks when a real site is set up.

## Risks

1. **Dex is now the only way in except LTI.** If Dex is down, nobody signs in. It already was for the pilot; its unit restarts on failure and the smoke test checks it.
2. **The local administrator is a password-only account.** Mitigations from ADR 0031: a long generated password, the forced change, the Dex form's per-address throttle, and an `auth.login` row per sign-in. An operator who never reads the file leaves a working one-time password in a root-only file until the next play run after a change; the play prints the reminder on every run while the flag is set.
3. **An Entra account without an `email` claim** fails in Dex, because the scope asks for email. OPERATIONS.md tells the site to add the optional `email` claim to the app registration; the first real tenant checks it.
4. **A site that changes `portikus_admin_email`** gets nothing until it recreates the account (ruling 12). Documented in OPERATIONS.md.
5. **The migration drops `setup_codes`.** Nothing reads it after this epic; the `down` recreates it empty, and codes lived an hour anyway.

## Left out

- Two-factor sign-in for Dex local passwords (Dex has none at the pinned version; ADR 0031).
- Dex's `microsoft` connector and its Graph permission; Google groups through the Admin SDK.
- More than one upstream connector per site.
- Everything in the BACKLOG entry "Sign-in setup in the admin area".
