# Epic 14: Sign-in providers

This is the working brief for Epic 14. It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. It builds on Epic 13 (`docs/archive/epics/EPIC-13.md`, ADR 0025) and Epic 13.1 (`docs/archive/epics/EPIC-13-1.md`, ADR 0026), whose role rule it uses unchanged. ADR 0027 (the egress proxy) and ADR 0028 (Dex user storage and the first administrator) record the decisions made here. Epic 15 (`docs/EPIC-15.md`) packages the result for `apt install portikus` and is built after this one.

- **Base commit:** `epic/14-sign-in-providers` once Epic 13.1 has merged to `main`. Builders reset to `origin/epic/14-sign-in-providers` and branch `task/14-<name>` from it.
- **Migration number:** `0017_setup_codes` is reserved for T2. No other task adds a migration.

**Later decision (Todd, 2026-09-25):** ADR 0031 makes Dex the only sign-in front door and replaces the setup code with a local administrator made at install. It supersedes rulings 2, 3 and 6 (direct Entra, Google and generic OIDC) and 15 to 18 (the setup code and the first-account form) once built (docs/BACKLOG.md, "One front door: Dex for every site"). This brief still describes what Epic 14 built.

Terms used throughout:

- **OIDC** (OpenID Connect): the sign-in standard Portikus already speaks. The institution's service that signs people in is the **provider**; it sends Portikus a signed **ID token** whose fields are **claims**.
- **SSO account** (single sign-on): as in docs/archive/epics/EPIC-13-1.md, an account whose sign-in is the site's OIDC provider, keyed by (issuer, `sub`).
- **Entra ID**: Microsoft's identity service. A **tenant** is one organisation in it, named by a tenant ID; the ID token's `tid` claim names the tenant that issued it. An **app role** is a role defined on the Portikus app registration and assigned to people; it arrives in the `roles` claim.
- **Google Workspace**: Google's identity service for organisations. The ID token's `hd` claim ("hosted domain") names the person's organisation domain; a personal Gmail account has none.
- **Dex**: the small OIDC provider Portikus already runs (ADR 0023). A Dex **connector** is an upstream source of people, such as an LDAP directory; **local passwords** are accounts Dex holds itself.
- **LDAP** (Lightweight Directory Access Protocol): the protocol of campus directories, including Microsoft **Active Directory** (AD).
- **Egress**: traffic the server starts toward the internet.
- **Forward proxy**: a small service the API sends its outbound requests through, which allows only named destinations.
- **The role rule** (docs/archive/epics/EPIC-13-1.md ruling 20): each account has a `provider_role` from its own sign-in, an optional `granted_role` (`instructor` or `administrator`) stored by Portikus, and an effective `role`, the higher of the two.

## What the user gets

- A site picks one SSO provider: Microsoft Entra ID, Google Workspace, an LDAP or Active Directory directory, Dex with its own passwords, or any other OIDC provider (Okta, Keycloak, Shibboleth with its OIDC plugin). Opening Portikus from a course (LTI) keeps working alongside whichever is chosen.
- Under Entra, only people from the site's tenant can sign in, and their role comes from the app roles assigned to them in Entra.
- Under Google, only people from the site's domains can sign in. Everyone starts as a student; an administrator makes someone an instructor or an administrator in the Users view.
- Under LDAP or Active Directory, Dex checks the password against the directory and passes on the person's groups. Portikus never talks to the directory.
- A site with no institutional provider runs Dex alone. An administrator adds people in the Users view, resets a forgotten password, and removes people, without touching the server. A site that has a provider but also needs guest accounts puts Dex in front: guests get Dex passwords, everyone else signs in through the upstream provider.
- The Users view gains **Make instructor** and **Remove instructor** beside Promote and Demote.
- A new site gets its first administrator from a one-time **setup code** printed on the server. The first person to enter it on the `/setup` page becomes the administrator. Nobody becomes an administrator just by signing in first.
- The server reaches Entra, Google and cloud LMS keysets by name, through an allow list of hostnames, without an operator hunting for IP ranges.
- SAML and Shibboleth sites get a documented path: turn on the Shibboleth identity provider's OIDC plugin and configure Portikus as a generic OIDC client.

## Rulings

Rulings marked **(user)** came from Todd, **(orchestrator)** from the orchestrator, and **(brief)** were made in this brief.

### Providers

1. **(user)** One SSO provider per site. Dex sits in front when a site needs guest accounts too. LTI launch is always available alongside.
2. **(user)** Microsoft Entra ID by direct OIDC; sign-in restricted to the allowed tenant by the `tid` claim; roles from Entra app roles in the `roles` claim.
3. **(user)** Google Workspace by direct OIDC; sign-in restricted by the `hd` claim; roles from Portikus grants, the `granted_role` of Epic 13.1, because Google sends no groups.
4. **(user)** LDAP and Active Directory through Dex's LDAP connector. Portikus never speaks LDAP.
5. **(user)** Standalone Dex with local passwords, managed from the admin area through Dex's gRPC API (Google's remote procedure call protocol), with Add user, Reset password and Remove. Standalone sites only.
6. **(user)** Generic OIDC (Okta, Keycloak, Shibboleth's OIDC plugin): configuration and docs only.
7. **(user)** SAML and Shibboleth are documented only, through the Shibboleth identity provider's OIDC plugin. Dex's SAML connector is not built.
8. **(brief)** **One tenant per Entra site.** The issuer is the tenant's own, `https://login.microsoftonline.com/<tenant ID>/v2.0`, and `tid` must equal that tenant ID. Several tenants would need Entra's shared `organizations` endpoint, whose ID tokens carry a different issuer per tenant; `openid-client` checks the issuer against one value, so accepting several means replacing that check with our own. That is security-sensitive code for a need nobody has yet. **(Todd, 2026-09-24)** One Entra tenant per site, as ruled. Multi-tenant support is left out; if it is ever needed it is about two days of work plus a security review. Guests invited into the tenant (Entra B2B) sign in and are checked like anyone else.
9. **(brief)** **Admission is checked on the ID token's claims only.** The `tid` and `hd` checks read the signed ID token, never userinfo. A missing claim is a refusal. A refused sign-in gets the existing `not_authorized` page and an `auth.login` `denied` audit row with `{reason: "tenant_not_allowed"}` or `{reason: "domain_not_allowed"}`.
10. **(brief)** **No userinfo call for Entra and Google.** Their ID tokens carry `sub`, `name`, `email` and the admission and role claims. Skipping userinfo removes a second host from each allow list (`graph.microsoft.com`, `openidconnect.googleapis.com`) and a failure point. Dex and generic OIDC keep the userinfo call, because Dex puts `groups` there.
11. **(brief)** **Where the role comes from, per provider.** One new setting, `OIDC_DEFAULT_ROLE`, `none` or `student`, says what an admitted person gets when no group or app role matches. `mapRole` is otherwise unchanged: Entra is the existing groups mapping with the claim `roles` and the app role values `Portikus.Student`, `Portikus.Instructor` and `Portikus.Administrator`.

    | Provider | Who may sign in | `provider_role` from | No match |
    |---|---|---|---|
    | Entra | the tenant; "Assignment required" recommended | `roles` claim | refused (`none`) |
    | Google | the listed domains | nothing | `student` |
    | Dex, local passwords | people an administrator added | nothing | `student` |
    | Dex, LDAP connector | people the connector's user filter admits | the directory groups | `student` |
    | Dex in front of Entra or Google | the tenant or domains, by Dex's own connector options | nothing | `student` |
    | Generic OIDC | whoever the provider signs in | the groups claim | refused (`none`) |

    Under LDAP the user filter is required, not optional, because it is the only gate: without it every directory account could sign in.
12. **(brief)** **Identity stays (issuer, `sub`)** for every provider (docs/archive/epics/EPIC-13-1.md). For Entra that is the pairwise `sub`, not `oid`; for Google, `sub`. No lookup by email, `preferred_username` or `upn`.
13. **(brief)** **Dex in front of Entra or Google uses Dex's own `microsoft` or `google` connector**, restricted by its `tenant` or `hostedDomains` option, beside local passwords for guests. Only one upstream connector per site. Dex's generic OIDC connector is left out.

### Instructor grant

14. **(brief, agreeing with the user's leaning)** **The Users view gets Make instructor.** Under Google and under Dex it is the only way to an instructor role other than an LTI launch, and 13.1 already stores it. `POST /admin/users/:id/make-instructor` and `POST /admin/users/:id/remove-instructor`, beside 13.1's promote and demote and following docs/archive/epics/EPIC-13-1.md ruling 23:
    - Make instructor: 400 for an `lti:` account; 400 when `granted_role` is `administrator` ("Demote first."); 200 with no change when the effective role is already instructor or higher from the provider. Otherwise sets `granted_role = 'instructor'` and recomputes `role`.
    - Remove instructor: 400 unless `granted_role` is `instructor`. Clears it and sets `role = provider_role`.
    - Both write `user.role_changed` with `{from, to, source: "admin", ip, userAgent}` and return the `AdminUser`. Neither ends sessions; the next request reads the new role.

### First administrator

15. **(user)** The first administrator comes from a one-time setup code printed on the host. The first person to enter it becomes administrator through `granted_role`. Never "the first sign-in wins".
16. **(brief)** **The code.** 16 characters from the Crockford base-32 alphabet, shown as four groups of four (80 bits), valid for 60 minutes, single use. Only its SHA-256 is stored; with 80 random bits a slow hash adds nothing. Issuing a code deletes any unused one. The command is the Node entry point `setup-code-main.js` in `@portikus/auth` (shipped in the package as `users-revoke-main.js` is), run as root on the host; Epic 15 wraps it as `portikus setup-code`. It works whether or not an administrator exists, so it is also the recovery path when every administrator is gone; running it needs root on the host, which already owns everything. Ansible runs it at the end of a play when no enabled administrator exists and prints the code. Each issue writes `setup.code_issued` with no code in it.
17. **(brief)** **Claiming it.** `/setup` (web) and `POST /setup/claim` (CSRF-checked, throttled at 10 attempts per 10 minutes per address with the existing sign-in throttle's mechanism). The caller must be signed in with an enabled SSO account; a course (`lti:`) account is refused. A good code sets `granted_role = 'administrator'`, marks the code used by that account, and writes `setup.code_claimed` and `user.role_changed` `{source: "setup"}`. A wrong or expired code answers one generic "That code is not valid" and writes `setup.code_claimed` `failed`, with no code in it.
18. **(brief)** **A new standalone Dex site has nobody to sign in as.** So under Dex local passwords, and only while no enabled administrator exists, `/setup` shows a form for the first account instead: email, username, password twice, and the code. `POST /setup/first-account` checks the code first, then creates the Dex password and the Portikus account with `granted_role = 'administrator'` in one step (ruling 21's pre-created row), and the person then signs in normally.

### Standalone Dex

19. **(brief)** **Dex keeps its accounts in PostgreSQL.** The gRPC API writes to Dex's storage, and today's storage is memory, which a restart empties. Dex gets its own database, `dex`, owned by the `portikus-dex` role, on the existing server; the nightly backup dumps it with the `portikus` database. SQLite was the other choice; it would be one more file to back up by a different path.
20. **(brief)** **The gRPC API listens on `127.0.0.1:5557` with mutual TLS.** Loopback alone is not enough: any process on the host could otherwise reset an administrator's password. Ansible makes a small certificate authority, a server certificate for Dex and a client certificate for the API (`/etc/portikus/dex-grpc/`, client key `root:portikus` mode 0640). Caddy never routes to it.
21. **(brief)** **Add user** takes email, username, and role (student, instructor or administrator). The API generates a 20-character password, hashes it with bcrypt at cost 10 (the users file's rule, `dex_bcrypt_pattern`), creates the Dex password with a new random user ID, and pre-creates the Portikus account under (Dex issuer, `dexLocalSubject(userId)`) with `granted_role` set from the chosen role (null for student). The password is shown once in the dialog and never stored or logged by Portikus. The first sign-in finds the pre-created row. T3 first reads `api.proto` at the pinned Dex commit: if its `Password` carries a display name, the form asks for one; otherwise the name is the username.
22. **(brief)** **Reset password** generates a new password, shown once, updates the Dex hash, and ends the account's sessions and preview sessions. **Remove** deletes the Dex password, disables the Portikus account through the existing disable path (which ends sessions), and keeps the workspace for an administrator to archive. Audit: `dex_user.created`, `dex_user.password_reset`, `dex_user.removed`, actor `user:<admin id>`, target the account id, no passwords, hashes or emails.
23. **(brief)** **The users file is imported once and then retired.** When Dex's storage holds no passwords and a users file is given, Ansible imports every entry through the gRPC API with its existing bcrypt hash and user ID, so every `sub`, and so every account and workspace, stays the same. An `administrator` or `instructor` in the file becomes that account's `granted_role`, because a password created through the gRPC API carries no groups (T3 confirms this against `api.proto`). After that the users file, `make users-*`, `packages/users-file`, and the users-deploy session revocation are removed; the Users view replaces them. Keeping both would give two places a password can live, only one of which the admin area can change. **(Todd, 2026-09-24)** Retire the users file after the one-time import. `make users-*` and its encrypted backup copy go away; the `dex` database dump replaces that copy.
24. **(brief)** The Dex user routes exist only when `DEX_GRPC_ADDR` is set, which Ansible does only when `portikus_idp` is `dex`. Otherwise they answer 404 and the Users view hides the buttons. Under Dex in front of an upstream provider, the view manages the local (guest) accounts only.

### Egress by hostname

25. **(user)** Entra, Google and cloud LMS keysets live on changing CDN addresses, so the API's IP allow list does not fit. Egress is allowed by hostname.
26. **(brief)** **Squid, from Debian, as a forward proxy on `127.0.0.1:3128`** (ADR 0027). The API unit keeps `IPAddressAllow` for loopback and the workspace bridge only, so any request that does not go through the proxy fails closed. Squid allows only `CONNECT` to port 443 of the listed hostnames, refuses any destination that resolves to a private, loopback or link-local address (so a listed name pointed at an internal address is refused), and caches nothing. Explicitly listed IP entries, such as the mock LMS's `http://<LAN address>:8765`, are the one exception to the private-address rule.
27. **(brief)** **The API sends exactly three kinds of request through the proxy**, by passing a proxy-aware `fetch` (undici's `ProxyAgent`, when `OUTBOUND_PROXY_URL` is set) to `openid-client` and to `jose`'s remote keyset through their `customFetch` options. Nothing else changes: the agent and controller clients stay direct. Setting `HTTPS_PROXY` for the whole process was rejected, because the agent client's workspace addresses would then need a `NO_PROXY` list that Node does not read as address ranges. `undici` becomes a direct, exactly pinned dependency of `packages/auth`; it is already in the lockfile.
28. **(brief)** **Ansible builds the allow list; nobody types it.** It is the hosts of the provider's discovery document (the issuer, `authorization_endpoint`, `token_endpoint`, `jwks_uri` and `userinfo_endpoint`, fetched at play time), the host of every LMS keyset URL in the platforms file, and `portikus_egress_extra_hosts` for anything else. Dex uses the same proxy (`HTTPS_PROXY` in its unit) for an upstream Entra or Google connector. An LDAP connector is not HTTP, so Dex reaches the directory through its own `IPAddressAllow` drop-in with `portikus_ldap_ip_allow`; campus directory addresses are stable.
29. **(brief)** **`PORTIKUS_API_IP_ALLOW` and the `10-idp-egress.conf` drop-in are removed.** One way out is easier to reason about than two. A play that still sets `PORTIKUS_API_IP_ALLOW` fails with a message naming `PORTIKUS_EGRESS_EXTRA_HOSTS`.

### Tests

30. **(user)** Every provider is tested against imitation tokens through the existing mock OIDC provider. What stays unverified is listed under "Unverified until a real tenant exists".
31. **(brief)** The mock provider's users gain optional extra claims, and the test table gains Entra-shaped users (`erin`: allowed `tid`, `roles: ["Portikus.Student"]`; `eve`: another `tid`; `ian`: allowed `tid`, no `roles`) and Google-shaped users (`gina`: `hd` allowed; `gabe`: another `hd`; `gus`: no `hd`). API route tests drive the real `openid-client` through the mock to `/auth/callback` under each provider setting. Playwright keeps the current groups-shaped mock and covers the new screens: `/setup`, Make instructor, and the Dex user dialogs against a fake Dex gRPC server in `e2e/` (as `fake-agent-server.mjs` fakes the agent). The CI `dex-signin` job gains PostgreSQL storage and the gRPC API, and an integration test creates, signs in, resets and removes a Dex password against the real pinned Dex.

## Data model and configuration

**Migration `0017_setup_codes`:** `setup_codes`: `code_hash text primary key`, `created_at timestamptz not null default now()`, `expires_at timestamptz not null`, `used_at timestamptz null`, `used_by uuid null references users on delete set null`. The `down` drops it. Nothing else in Portikus's schema changes; the instructor grant uses 13.1's columns.

**API settings (`packages/config`):**

| Setting | Values | Default |
|---|---|---|
| `OIDC_PROVIDER` | `oidc`, `entra`, `google` | `oidc` |
| `OIDC_ALLOWED_TENANT` | one tenant ID; required when `entra` | none |
| `OIDC_ALLOWED_DOMAINS` | comma-separated domains; required when `google` | none |
| `OIDC_DEFAULT_ROLE` | `none`, `student` | `none` |
| `OUTBOUND_PROXY_URL` | `http://127.0.0.1:3128` | unset (direct, for tests) |
| `DEX_GRPC_ADDR`, `DEX_GRPC_CA`, `DEX_GRPC_CERT`, `DEX_GRPC_KEY` | address and file paths | unset (routes off) |

`OIDC_ISSUER_URL` stays the one issuer setting; Ansible derives it for Entra and Google, so the API has no provider-specific URLs and the mock can stand in for either. Config refuses `entra` without a tenant and `google` without domains.

**Ansible variables** (environment names in capitals, as today; Epic 15's config file uses the lower-case names):

- `portikus_idp`: `dex`, `entra`, `google`, `external`, `mock`.
- `portikus_dex_upstream`: `none`, `ldap`, `microsoft`, `google` (Dex only).
- `portikus_entra_tenant_id`, `portikus_google_domains` (a list): for direct Entra or Google, and for Dex's `microsoft` or `google` connector.
- `portikus_ldap_host` (`host:636`), `portikus_ldap_schema` (`ad` or `openldap`, which picks attribute defaults), `portikus_ldap_bind_dn`, `portikus_ldap_bind_password` (secret), `portikus_ldap_user_base_dn`, `portikus_ldap_user_filter` (required), `portikus_ldap_group_base_dn`, `portikus_ldap_root_ca` (optional file), `portikus_ldap_ip_allow` (CIDRs).
- `portikus_dex_upstream_client_id`, `portikus_dex_upstream_client_secret` (secret).
- `portikus_egress_extra_hosts`: a list of `host` or `host:port`.
- Removed: `portikus_api_ip_allow_extra` and `portikus_users_file` (after the import).

## The flows

1. **Entra sign-in.** `/auth/login` redirects to the tenant's authorize endpoint (through the browser; no proxy). At `/auth/callback` the API exchanges the code through the proxy, validates the ID token against the tenant's keys (fetched through the proxy), checks `tid`, skips userinfo, maps `roles`, and continues as today: `upsertUser` writes `provider_role`, the effective role follows 13.1.
2. **Google sign-in.** The same, with the `hd` check and `OIDC_DEFAULT_ROLE=student`. The login redirect also sends `hd=<first domain>` as a hint to Google's account picker; the check at the callback is what counts.
3. **LDAP sign-in.** Portikus sees plain Dex. Dex checks the password against the directory over LDAPS and puts the directory groups in `groups`; `mapRole` maps the three configured group names.
4. **First administrator.** Ansible (or, after Epic 15, `portikus setup`) prints a code when no enabled administrator exists. The person signs in, opens `/setup`, enters it, and is an administrator on the next request. Under standalone Dex they create their account on `/setup` first (ruling 18).
5. **Adding a Dex user.** Users view, **Add user**: email, username, role. The dialog shows the password once with a Copy button and the text "Give this to them privately. It will not be shown again."
6. **An outbound request.** The API's `fetch` connects to Squid, which checks the name against the list, resolves it, refuses a private answer, and tunnels to port 443. TLS runs end to end between the API and the provider; Squid sees only the host name.

## Security invariants to test

- An Entra token with another `tid`, or none, is refused; a Google token with another `hd`, or none, is refused; both checks read the ID token, and a userinfo response cannot add a missing claim.
- Under Entra and generic OIDC, no matching role claim means no account. Under Google and Dex, an admitted person with no grant is a student, never more.
- No sign-in path looks an account up by email, `preferred_username` or `upn`.
- A setup code is single use, expires, is stored only as a hash, is refused for a course account, and never appears in a log or audit row. A wrong code is throttled. `/setup/first-account` is refused once any enabled administrator exists and under any provider other than Dex.
- Make instructor and remove instructor refuse course accounts and never touch an administrator grant.
- Dex user routes are administrator-only, CSRF-checked, in `route-policy.ts` and the authorization matrix, and 404 when `DEX_GRPC_ADDR` is unset. A generated password appears in exactly one response body and no log line. Reset and remove end the account's sessions.
- The Dex gRPC port refuses a client without the client certificate, and is not reachable through Caddy.
- The API process cannot reach any internet address directly; through the proxy it reaches only listed hosts on 443, and a listed name that resolves to a private address is refused.

## Tasks for parallel builders

Each task owns only the files listed; ask the orchestrator before touching any other. The settings, variables, routes and table above are fixed, so tasks build against each other without waiting.

| Task | Agent | Files it owns | Depends on |
|---|---|---|---|
| **T1 Provider sign-in** | builder | `packages/config/src/index.ts` and test; `packages/auth/src/types.ts`, `oidc.ts`, `outbound-fetch.ts` (new), `lti/validate.ts`, `testing/mock-oidc.ts`, `index.ts` and their tests; `packages/auth/package.json`; `apps/api/src/auth-options.ts`; `apps/api/src/routes/auth.ts` and test | none |
| **T2 First administrator** | builder, then tester for e2e | `packages/db/src/migrations/0017_setup_codes.ts`, `migrations/index.ts`, `schema.ts`, `db.test.ts`; `packages/auth/src/setup-code.ts`, `setup-code-main.ts` (new) and tests; `packages/contracts/src/setup.ts` (new); `apps/api/src/routes/setup.ts` (new) and test; `apps/web/src/setup/**` (new); `apps/web/src/router.tsx`; after T3 lands, `apps/api/src/server.ts`, `route-policy.ts` and `authz-matrix.test.ts` for its own routes; `e2e/setup.spec.ts`, `e2e/a11y-setup.spec.ts` (new) | T3 (it shares three API files and uses `dex-api.ts`) |
| **T3 Users view: Dex users and instructor grant** | builder, then tester for e2e | `packages/auth/src/dex-api.ts` (new gRPC client) and `dex-api.integration.test.ts`; `packages/auth/src/proto/dex-api.proto` (copied from the pinned commit); `apps/api/src/routes/admin-dex-users.ts` (new) and test; `apps/api/src/routes/admin.ts` and test (make and remove instructor); `apps/api/src/server.ts`; `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts`; `packages/contracts/src/settings.ts`; `apps/web/src/admin/WorkspacesTab.tsx`, `WorkspaceDetail.tsx`, `queries.ts`, new `DexUserDialogs.tsx`, and tests; `e2e/fake-dex-grpc.mjs` (new), `e2e/admin-dex-users.spec.ts`, `e2e/admin-instructor.spec.ts` (new); `.github/workflows/ci.yml` (the `dex-signin` job only) | none |
| **T4 Egress proxy and provider settings** | infra | `infra/ansible/roles/egress_proxy/**` (new); `infra/ansible/site.yml`; `infra/ansible/roles/portikus/**` (api.env settings, remove the drop-in, run the setup-code entry point); `infra/ansible/roles/caddy/**` (`/setup` needs nothing new; only if the build finds otherwise); `packaging/systemd/portikus-api.service` (comment only); `infra/tests/smoke-test.sh`, `security-test.sh` (proxy checks); `Makefile` (new `PORTIKUS_*` pass-throughs, not the users targets) | T1 for the settings' names only |
| **T5 Dex storage, gRPC and connectors** | infra | `infra/ansible/roles/dex/**` (PostgreSQL storage, gRPC with mTLS, LDAP, `microsoft` and `google` connectors, `HTTPS_PROXY`, the one-time import); `infra/ansible/roles/postgresql/**` (the `dex` database and role); `infra/ansible/roles/backup/**` (dump `dex`); `infra/tests/dex-render-test.yml` and fixtures; `packages/users-file/**` and `packages/auth/src/users-revoke*.ts` (removed, with their export in `packages/auth/src/index.ts` once T1 has landed); `Makefile` (the `users-*` targets only) | T3's `dex-api.ts` for the import script |
| **T6 Docs and rehearsal** | builder | `docs/OPERATIONS.md` (a section per provider: the Entra app registration, redirect URI and app roles; the Google OAuth client; LDAP and AD filters; standalone Dex; generic OIDC; Shibboleth's OIDC plugin; why not SAML); `infra/README.md` ("Identity provider"); `docs/SPEC.md` sections 5.1 and 29; ADRs 0027 and 0028 accepted; `docs/STATUS.md`; `docs/BACKLOG.md`; `docs/OVERVIEW.md` | all others |

T1 and T3 start together. T4 starts when T1 lands. T2 and T5 start when T3 lands. T6 is last and includes the rehearsal.

After every task has landed: code-reviewer over the epic head, security-reviewer (auth, sessions, egress, the gRPC boundary), and a11y-reviewer (`apps/web`).

## What done looks like, per task

- **T1:** config tests for each provider's required settings; route tests through the mock for every Entra-shaped and Google-shaped user in ruling 31, each allowed or refused with its audit reason; a userinfo response carrying `hd` or `tid` does not admit a token that lacks it; `OIDC_DEFAULT_ROLE` under both values; a test that the keyset and token requests go to a stub proxy when `OUTBOUND_PROXY_URL` is set and nowhere else. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- **T2:** database tests for issue (replaces an unused code), claim (single use, expiry, hash only), and the first-account path; route tests for every refusal and the throttle; a captured log holds no code. Playwright: run the setup-code entry point against the e2e database, sign in as alice, claim, see the admin link; a second claim refused; axe on `/setup`.
- **T3:** unit tests of the gRPC client against a stub; the CI `dex-signin` job creates, signs in as, resets and removes a user on the real Dex; route tests for every refusal, the 404 when unset, and session ending; Playwright for Add user (password shown once), Reset, Remove, Make instructor and Remove instructor, and refusals for a course account; axe on each dialog.
- **T4:** on the rehearsal VM, `curl` through the proxy reaches a listed host, and is refused for an unlisted host and for a listed name resolved to `10.0.0.1`; a `systemd-run` process with the API unit's `IPAddressAllow` cannot reach the internet directly; `make smoke-test` and `make security-test` pass; `ansible-lint` passes.
- **T5:** on the rehearsal VM with a pilot backup restored: the import keeps every `sub` (checked with SQL: every account still owns its workspace), carol keeps administrator by grant, and a second run imports nothing; a gRPC call without the client certificate fails; the LDAP connector signs in a user from a throwaway OpenLDAP (`slapd`) on the rehearsal VM, and refuses one outside the user filter; the nightly backup contains the `dex` database.
- **T6:** every doc above updated and `pnpm lint` passing; the pilot moved to Dex storage (snapshot and dump first, as OPERATIONS.md's Dex cutover did) and signed into by carol, alice and bob; a setup code claimed on the rehearsal VM; results in STATUS.md.

## Unverified until a real tenant exists

The imitation tokens prove Portikus's own checks. They cannot prove how a real provider behaves:

- that Entra puts `roles` in the ID token for this app registration, and `tid` for a B2B guest, as documented;
- that Entra's and Google's discovery documents name only the hosts the allow list derives today, and that key rotation through the proxy works;
- that Google sends `hd` for every Workspace account and honours the `hd` hint;
- that `prompt=login` (13.1's linking) forces a password at Entra and Google;
- Dex's `microsoft` and `google` connectors, and the LDAP connector against real Active Directory (OpenLDAP stands in).

OPERATIONS.md lists these as the first checks when a real site is set up.

## Risks

1. **A proxy outage stops every SSO sign-in and every LMS launch.** Squid is one small, mature Debian service under systemd with `Restart=on-failure`, and the smoke test checks it. Dex and mock sign-ins do not use it.
2. **The Dex storage move touches every pilot account.** The import keeps user IDs so `sub` values match, and T6 rehearses on a restored backup before the pilot; the rollback is the snapshot and dump.
3. **Google admits a whole domain as students.** That is the ruling: the domain is the gate. A site that wants fewer people should use Dex in front, or ask for a Google group check later.
4. **A copied setup code** could be claimed by whoever types it first within the hour. It is printed only to root on the host; its hour, single use and the throttle bound it.
5. **Dex's gRPC API changes shape between releases.** The proto file is copied from the pinned commit, and the `dex-signin` job fails on a mismatch.

## Left out

- Several Entra tenants on one site (ruling 8), Entra group object IDs and the groups overage claim (docs/archive/epics/EPIC-13-1.md ruling 25), and a Google group check through the Admin SDK.
- Dex's SAML and generic OIDC connectors; more than one upstream connector.
- Self-service password change or reset for Dex users; e-mailed invitations.
- An admin UI for LTI platforms or for the egress allow list; both stay in files Ansible applies.
- Editing a Dex user's email or username (remove and re-add).
