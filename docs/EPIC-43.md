# Epic 43: Admin self-service

Working plan for `epic/43-admin-self-service` (base `6a5c2586`). Issues
#1250, #1220, #935, #1252, #1251, #1256. Code, tests and other docs cite
SPEC.md sections and ADRs 0059 and 0060, never this file. The fold task
(T11) moves the lasting rules into SPEC.md and deletes this file.

## Goal and scope

An administrator can do six things from the admin page that today need
the server's command line or cannot be done at all:

1. Add host names the platform may reach on the internet, and register
   LMS platforms for LTI launches (#1250).
2. Choose the site's single sign-on provider and check it with a test
   sign-in (#1220).
3. Move the site to a new host name or port (#935).
4. Link or unlink a course account and an SSO account for someone else
   (#1252).
5. Search and page the Users list on the server (#1251).
6. Read the workspace agent's own log lines for one workspace (#1256).

The API never runs as root. Everything that changes the host goes through
one new root job, `site-job`, built like the image, certificate and alerts
jobs (ADRs 0030, 0046, 0052).

## How it works

`site-job` starts from a systemd path unit and serves these request kinds:

- `proxy-hosts` and `lti-platforms` write page-owned files, write matching
  Squid rules and reload Squid. `lti-platforms` also restarts the API.
- `address` and `signin` change the same install answers that
  `dpkg-reconfigure portikus` changes (debconf answers, `portikus.yaml`,
  `secrets.yaml`), then rerun `portikus setup`, which derives Caddy, Dex,
  Squid, api.env, the firewall and the hosts entry.
- `keep` and `rollback` end a trial.

An `address` or `signin` change is a **trial**. The administrator confirms
it with **Keep**: from the new address for `address`, and after a passing
test sign-in for `signin`. A trial nobody keeps is put back automatically.
Setup writes a secret-free view file so the page can show current
settings.

## Rulings (decided by the orchestrator, 2026-10-10)

All of the architect's recommendations were accepted. R1b (plan-only
pages) is not used.

- **R1** #1220 changes the provider by the `signin` job writing the install
  answers and rerunning setup, as a trial. Not Dex's gRPC connector API.
  ADR 0059 amends ADR 0031's consequence line.
- **R2** The page covers Entra, Google, generic OIDC and "Dex passwords
  only". LDAP shows read-only and is set with `dpkg-reconfigure`; switching
  from LDAP on the page is allowed (the settings writer drops LDAP keys).
- **R3** Trial apply, then **Test sign-in**, then **Keep**. Keep is offered
  only after a passing test, or at once for "Dex only". An unkept trial is
  reverted after 30 minutes. The local administrator's Dex password always
  works (ADR 0031); the confirmation dialog says students cannot sign in
  during a bad trial.
- **R4** #935 is a full guided switch: plan, pre-flight, trial. Keep must
  be pressed from the new address; an unkept trial is reverted after 15
  minutes.
- **R5** Allowed when the certificate source is Caddy's internal authority
  or ACME; refused for uploaded files that do not cover the new names.
- **R6** The preview suffix follows the host (`preview.<host>`) unless set
  by hand in `portikus.yaml`; a hand-set suffix is kept and the page says
  so. Editing the suffix is left out (#1236).
- **R7** Recovery when the new address is unreachable after Keep is
  documented: `sudo dpkg-reconfigure portikus`, plus editing
  `portikus_public_port` in `portikus.yaml`.
- **R8** Running workspaces keep the old preview suffix until their next
  start; the page lists them; nothing is restarted.
- **R9** #1250 data lives in page-owned files beside the operator's:
  `/etc/portikus/proxy-hosts.json` and
  `/etc/portikus/lti-platforms-admin.json`, with Squid includes
  `egress-proxy.d/admin.conf` and `lti.conf`. The operator's list and file
  stay Ansible-owned and show read-only.
- **R10** The job restarts the API to pick up page-registered platforms
  (no edit to `routes/lti.ts`). The page warns before saving that root
  shells end and sockets reconnect.
- **R11** Page platforms: HTTPS only; `mock: true` refused; an issuer and
  client ID pair already in the operator's file refused; keyset hosts into
  Squid on 443 only; at most 20. Page platforms may carry the optional
  `authTokenUrl` (Epic 42, https only), whose host is also allowed on 443.
- **R12** Page hosts: host names only, port 443, CONNECT only, no IP
  addresses, at most 50, same host-name rule as ADR 0052.
- **R13** #1251: offset paging in memory after markers are computed over
  all accounts. Search, role, state, image and archived filters and the sort
  run on the server. Page size 50. No `limit` returns the whole list (Audit
  and Logs pickers, `?image=older`). The operation-end poll uses
  `?pending=1`. Bulk actions act on the selected rows of the current page.
- **R14** #1252: the administrator picks both accounts; reuse
  `linkAccounts` and `unlinkAccount` (`packages/auth/src/links.ts`) with all
  their refusals. Unlink works on any link, including one whose SSO account
  is now disabled or an administrator. Audit `user.linked` and
  `user.unlinked` carry the administrator as actor and `by:
  "administrator"`. The SSO account's holder gets a notification
  (`recordNotification`, as `apps/api/src/admin/reset-notice.ts`).
- **R15** #1256: the agent keeps an in-memory ring of its own lines (warn
  and above, last 200, 128 KiB cap, allowlisted fields time, level, msg,
  code, status, durationMs). The API pulls it on demand. The page labels
  the lines as reported by the workspace. ADR 0060.
- **R16** Two new admin tabs, `signin` ("Sign-in": SSO group and LMS group)
  and `address` ("Site address"); page proxy hosts are a group in the
  Network tab. Tabs are always shown; off apt installs the address and SSO
  parts explain they are unavailable.
- **R17** The test sign-in result is an audit row `settings.signin_tested`
  (result, mapped role, connector; no email). The page reads the latest.
- **R18** No migrations. 0044 to 0046 stay reserved and unused.

## The contract (T1 writes it in ADR 0059; later tasks code against it)

- **Request file** `/var/lib/portikus/site-jobs/request-<uuid>.json`, mode
  0600, `{version: 1, id, kind, requestedAt, …}`:
  - `proxy-hosts {hosts[]}`
  - `lti-platforms {platforms[]}` (platforms-file version 1 shape)
  - `address {host, port}`; port 443 or 1024–65535 minus the job's reserved
    local ports
  - `signin {provider: dex|entra|google|oidc, entraTenantId?,
    googleDomains?, oidcIssuer?, clientId?, clientSecret: string|null,
    groupsClaim?, groups?{student, instructor, admin}}`
  - `keep {trialId}`, `rollback {trialId}`
- **Status** `status/<id>.json`: `{state:
  queued|running|trial|kept|reverted|done|failed, code, startedAt,
  finishedAt, trialEndsAt?}`; `<id>.log` holds setup output. No secret in
  either.
- **Value rules** Every free-text value reaches a root Ansible run, so the
  job refuses `{`, `}` and control characters in every field, plus a
  per-field pattern.
- **Secrets** go only to `secrets.yaml`, never debconf. When the issuer,
  tenant or client ID changes, the stored secret is cleared unless a new
  one arrives in the same request (ADR 0052 rule).
- **One job at a time** `address` or `signin` refused while a trial is
  open (`trial_open`) or setup is running (`busy`).
- **Trial deadline** a transient systemd timer runs `site-job expire <id>`.
  A setup failure reverts the answers and reruns setup.
- **View file** setup writes `/etc/portikus/site-view.json` (0644):
  `{version: 1, apt, host, port, previewSuffix, previewSuffixSetByHand,
  provider, entraTenantId, googleDomains, oidcIssuer, clientId,
  clientSecretSet, groupsClaim, groups, ldapHost?, certificateSource}`.
- **Page-owned files** `/etc/portikus/proxy-hosts.json`,
  `/etc/portikus/lti-platforms-admin.json`, root:portikus 0640.
- **Squid includes** `/etc/portikus/egress-proxy.d/admin.conf`, `lti.conf`.
  The alerts job and the site job share one lock before changing any Squid
  include.
- **API settings** `SITE_JOBS_DIR` (unset turns the routes off),
  `SITE_VIEW_FILE`, `PROXY_HOSTS_FILE`, `LTI_ADMIN_PLATFORMS_FILE` (defaults,
  overridden in e2e). `address` and `signin` work only where
  `/etc/portikus/portikus.yaml` exists (apt installs).

## Reuse (builders must use these)

| Need | Use |
|---|---|
| Request and status files | `apps/api/src/job-files.ts`; `packages/contracts/src/jobs.ts`; `queuedView` and `noteFinished` in `apps/api/src/certificate/jobs.ts` |
| Root job pattern (O_NOFOLLOW reads, size cap, Squid swap and roll back, host-name rule) | `packaging/alerts/alerts-job` |
| Units and Ansible wiring | `packaging/systemd/portikus-alerts-job.{path,service}`; `infra/ansible/roles/portikus/tasks/alerts.yml` |
| Real job in e2e without root | `e2e/notify-jobs.ts` (`playAlertsJob`) |
| Install answers to YAML keys | the Python block in `packaging/scripts/postinst` (T2 moves it into a shared file); `packaging/debian/settings-keys` |
| Address pre-flight | `apps/api/src/certificate/preflight.ts` |
| LTI platform validation | `packages/auth/src/lti/platforms.ts` (`parsePlatformsFile`); `platforms-check-main.js` as in `infra/ansible/roles/portikus/tasks/lti.yml` |
| Link and unlink | `linkAccounts`, `unlinkAccount`, `listLinks` in `packages/auth/src/links.ts` |
| Groups to role | `packages/auth/src/roles.ts` |
| Users list | `listAdminUsers` in `apps/api/src/admin/users.ts`; `apps/api/src/admin/markers.ts` |
| Notify an account holder | `recordNotification`; `apps/api/src/admin/reset-notice.ts` |
| Agent log ring | `createLogger` `destination` option and `REDACT_PATHS` in `packages/observability/src/logger.ts` |
| Admin UI parts | `apps/web/src/table/`, `AdminGroup`, `admin/JobLog.tsx`, `admin/ConfirmByLabelDialog.tsx`, `admin/DraftFields.tsx`, `admin/Notice.tsx`, `admin/people.ts`, `admin/certificate/*`, `admin/notifications/*` |

## Tasks

| Task | Issue | Owns (files) | SPEC / ADR | Tests | Done means | Model |
|---|---|---|---|---|---|---|
| **T1 Foundation** | all | `docs/adr/0059-*.md`; new `packages/contracts/src/site.ts` (request, status, view schemas, page bodies, `AdminLtiPlatform` incl. optional `authTokenUrl`); stub `packages/contracts/src/agent-log.ts`; `packages/contracts/src/index.ts` (both export lines); `packages/config/src/index.ts` (four variables); new `apps/api/src/site/jobs.ts`, `site/view.ts`; `apps/api/src/server.ts` (stubs `routes/admin-account-links.ts`, `admin-lms.ts`, `admin-proxy-hosts.ts`, `admin-address.ts`, `admin-signin.ts`, registered in the admin block); `apps/web/src/admin/tabs.ts`, `AdminNav.tsx`, `AdminPage.tsx` (tabs `signin`, `address`); `admin/signin/SignInTab.tsx` (final); stubs `admin/signin/SsoGroup.tsx`, `LmsGroup.tsx`, `admin/address/AddressTab.tsx` | 20.1, 21.12, 24.1, 24.8, 24.11; ADR 0059 | Contract tests (good and bad requests, no secret in the view schema); `site/jobs.ts` with a temp dir; tab routing | ADR merged; contracts frozen; stubs compile; `make check` green | Opus |
| **T2 Root site job** | #1250 #935 #1220 | `packaging/site/site-job`, `packaging/site/tests/` (incl. `fixtures/values.json`, shared with API tests); `packaging/site/write-settings` (moved out of postinst); `packaging/scripts/postinst`; `packaging/systemd/portikus-site-job.{path,service}`; `packaging/systemd/portikus-api.service` (ReadWritePaths); `packaging/nfpm.yaml`; `packaging/alerts/alerts-job` (shared Squid lock only); `packaging/tests/*`; `.github/workflows/ci.yml` (one line); `infra/ansible/roles/portikus/tasks/site.yml` (new), `tasks/main.yml`, `templates/api.env.j2`, `defaults/main.yml`, `site-view.json.j2`; `infra/tests/smoke/` (path unit check); `e2e/site-jobs.ts`; `playwright.config.ts` | 21.12, 24.1, 24.8, 24.10; ADR 0059 | Python unittest per kind: each refusal (incl. `{{ 7*7 }}`), no secrets in status or log, trial keep, revert, expiry with fake setup and fake `debconf-set-selections`, Squid roll back with fake squid, concurrent lock; postinst and settings-keys tests | Unit and packaging tests green; e2e helper plays a request | Opus |
| **T3 Server paging** | #1251 | `apps/api/src/routes/admin.ts` (GET /admin/users query only); new `apps/api/src/admin/users-query.ts`; `packages/contracts/src/admin.ts`; `apps/web/src/admin/queries.ts`, `WorkspacesTab.tsx`, `users/filters.ts`, `users/sort.ts`, `users/BulkActions.tsx`, `users/operationEnd.ts` | 20.1; R13 | Query units (markers over all accounts, filters, sort, `total`, no-limit returns all); routes; web; e2e `admin-users-paging.spec.ts` with 120 seeded accounts; existing admin specs updated | Users view fetches 50 rows per poll; pickers still resolve people | Sonnet |
| **T4 Admin linking** (after T3) | #1252 | `apps/api/src/routes/admin-account-links.ts`; `route-policy.ts` entries after `"POST /admin/users/:id/remove-instructor"`; `packages/contracts/src/links.ts` (additions); `apps/web/src/admin/workspace-detail/AccountSection.tsx`, new `LinkDialog.tsx`, `linkQueries.ts`; `docs/adr/0026-*.md` ("Update, Epic 43") | 5.2, 20.1, 20.2, 24.11; ADR 0026; R14 | Each refusal, archive and unarchive, sessions ended, audit actor and `by`, notification, student 403; e2e `admin-account-links.spec.ts` | Admin links and unlinks from the detail panel; lockout case fixed | Sonnet |
| **T5 Agent log** (after T1) | #1256 | `docs/adr/0060-*.md`; new `apps/workspace-agent/src/log-ring.ts`, `src/index.ts` (logger destination), `src/server.ts` (`GET /log` next to `/log-level`); `packages/contracts/src/agent-log.ts`; `apps/api/src/agent-client.ts` (one method after `setLogLevel`); `apps/api/src/routes/admin-workspaces.ts` (`GET /admin/workspaces/:id/agent-log`); `route-policy.ts` entry after `"POST /admin/workspaces/:id/processes/:pid/stop"`; `apps/api/src/testing/fake-agent/*`; new `apps/api/src/security/agent-log-hostile.test.ts`; `apps/web/src/admin/workspace-detail/AgentLogSection.tsx`, `WorkspaceDetail.tsx` (one line) | 20.1, 24.1, 24.2, 25.6; STACK 15; ADRs 0012, 0036, 0060; R15 | Ring (cap, allowlist, levels); hostile agent; routes (409 not running, 403 student); e2e `admin-agent-log.spec.ts` | Panel shows the agent's warnings | Opus |
| **T6 LMS platforms and proxy hosts** (after T2 and the Epic 42 platforms.ts sync) | #1250 | `apps/api/src/routes/admin-lms.ts`, `admin-proxy-hosts.ts`; `apps/api/src/lti/deps.ts` (merge the page file; a bad page file is logged and skipped); `route-policy.ts` entries after `"DELETE /admin/egress/blocked-sites/:id"`; `apps/web/src/admin/signin/LmsGroup.tsx` + dialog; `admin/network/ProxyHostsGroup.tsx`; `NetworkTab.tsx` (one line) | 5.1, 20.1, 24.1, 24.11; ADRs 0025, 0027, 0059; R9–R12 | Routes against the T2 fixture; deps merge; e2e `admin-lms.spec.ts`, `admin-proxy-hosts.spec.ts` with the real job | Admin adds and removes both; operator entries read-only | Sonnet |
| **T7 Site address** (after T2) | #935 | `apps/api/src/routes/admin-address.ts`; new `apps/api/src/site/address-plan.ts`; `apps/api/src/certificate/preflight.ts` (exports only); `route-policy.ts` entries after `"HEAD /admin/certificate/root.crt"`; `apps/web/src/admin/address/*` | 14.3, 20.1, 21.12, 24.10; ADRs 0046, 0059; R4–R8 | Plan (Dex issuer and callback, LTI URLs, preview wildcard, hand-set suffix); pre-flight refuses DNS not pointing here; routes (trial, keep only from new host, rollback); e2e `admin-address.spec.ts` with fake setup | Plan, pre-flight, apply, keep or revert work | Opus |
| **T8 Sign-in provider** (after T2) | #1220 | `apps/api/src/routes/admin-signin.ts`; `apps/api/src/routes/auth.ts` (test-mode branch in the callback); login-state helper in `packages/auth/src/oidc.ts` if needed; `route-policy.ts` entries after `"POST /admin/dex-users/:id/remove"`; `apps/web/src/admin/signin/SsoGroup.tsx` + form files | 5.1, 5.2, 20.1, 24.8, 24.11; ADRs 0031, 0059; R1–R3, R17 | Test-mode callback writes no user, session or role (DB assertions); only admins start a test; audit has no email; API validation agrees with T2 fixture; e2e `admin-signin.spec.ts` | Trial, test, keep work; LDAP read-only | Opus |
| **T9 Docs and help** (wave 3) | all | `docs/ADMIN-GUIDE.md`; `docs/OPERATIONS.md`; `docs/INSTALL.md`; `docs/STACK.md` §15 (one line); `apps/web/src/help/content/admin.tsx` | 8.6 | `make docs-check`; help tests | Each new page has help and a guide section | Sonnet |
| **T10 Rehearsal** (wave 3) | all | Nothing in the repo; findings become fix tasks | 21.11, 21.12 | See Rehearsal | Every step passes or is filed | infra (Opus) |
| **T11 Fold** (last) | all | `docs/STATUS.md`; `docs/SPEC.md` (20.1, 24.1, 24.11 audit names, 29 entry); "Update, Epic 43" lines in ADRs 0025, 0027, 0031, 0036, 0046; delete `docs/EPIC-43.md` | 29 | `audit-coverage.test.ts` | Plan folded and deleted | Sonnet |

New audit actions for SPEC 24.11: `site.job_requested`,
`site.job_finished` (kind and state, never a secret),
`settings.signin_tested`, and the reused `user.linked` and `user.unlinked`
with `by: "administrator"`.

## Waves

| Wave | Tasks | Waits on |
|---|---|---|
| 0 | T1, T3 | none (T3 shares no file with T1) |
| 1 | T2, T5 | T1 merged |
| 2 | T4, T6, T7, T8 | T4 on T3; T6, T7, T8 on T2; T6 also on the Epic 42 platforms.ts sync |
| 3 | T9, T10 | all of wave 2 |
| Reviews | code, security, a11y, then fixes | T9, T10 |
| Last | T11 | fixes merged and confirmed |

## Collisions with Epic 42

- `packages/auth/src/lti/platforms.ts`: Epic 42 owns it and adds optional
  `authTokenUrl`. Its change is applied to this branch by a task PR before
  T6 starts.
- `apps/api/src/lti/deps.ts`: T6 adds the page-file merge only.
- `routes/lti.ts`, `routes/courses.ts`, `packages/mock-lms`,
  `lti/validate.ts`, `agent-instructions.ts`, `claude-managed-settings.json`:
  not touched here.
- Additions only, both epics: `packages/contracts/src/index.ts`,
  `packages/config/src/index.ts`, `apps/api/src/server.ts`,
  `security/route-policy.ts`, workspace agent `src/server.ts`,
  `apps/api/src/agent-client.ts`, admin tabs (Epic 42 adds `agents` after
  `audit`), `playwright.config.ts`, `nfpm.yaml`, `postinst`, `ci.yml`, help
  content.
- Docs and SPEC/STATUS: each fold; the epic merged second rebases its
  fold.

## Reviews

code-reviewer (epic head plus dead code); security-reviewer (required:
root site job, free text into root Ansible, debconf, secrets, trial timer,
Squid lock; the API widening its own internet access; page-registered LMS
platforms as a new trust root; test-mode callback never creating a
session; admin linking; the untrusted agent-log channel); a11y-reviewer
(Sign-in and Site address tabs, Network group, link dialog, agent-log
section, paged Users table and its announcements).

## Rehearsal (T10, infra agent, rehearsal VM)

The rehearsal VM is ours to do anything with, including test sign-ins in
the database.

1. Build the `.deb` from the epic head and `apt install` it as an upgrade;
   `portikus-site-job.path` enabled and `site-view.json` written.
2. Proxy hosts: add a host on the page; a request through Squid as the
   `portikus` user succeeds; remove it and it is refused; break
   `admin.conf` by hand and the next job rolls it back.
3. LMS: register an HTTPS platform; check `lti.conf`, the API restart and
   `/lti/jwks`; remove it.
4. Sign-in: switch from Dex only to generic OIDC against a test provider
   reachable from the VM; test, Keep; a new trial left to expire reverts;
   `dpkg-reconfigure portikus` shows the page's values.
5. Address: move to a second nip.io name on another port and back; each
   time Keep from the new address, sign-in, LTI keyset, a preview on the
   new suffix, internal-authority certificate; one unkept trial reverts.
6. Open the agent log on a running workspace.
7. Full smoke with a Dex sign-in file, no avoidable skips; `apt remove`
   then install again with nothing left behind.

## Left out

- Dex gRPC connector management, LDAP from the page, LDAP CA upload.
- Google group admission (#1248), Entra security groups (#1247).
- A grace redirect from the old address, editing the preview suffix
  (#1236), a throwaway-Caddy certificate test for new names.
- Live LTI reload without an API restart; mock platforms, IP addresses
  and non-443 ports on the page.
- Agent log history across restarts, agent lines in the Logs tab,
  info-level agent lines.
- A name-lookup route for pickers; DB search indexes; bulk selection
  across pages.
- Course-to-course or SSO-to-SSO merges; link suggestions by email.
