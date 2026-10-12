# Epic 50 — Sign-in and identity

Branch `epic/50-identity`, from main 135b76fe. Issues:
- #1249: emailed password reset and invitations, and an administrator editing a Dex user's email or username.
- #1248: Google group admission.
- #1247: Entra group IDs.
- #1293: a passkey at LMS link confirm.

Migration 0049, ADR 0064. The epic runs beside Epics 48 and 49. This
plan comes from the architect's design of 2026-10-12. It lives only on
this branch; the fold folds it into SPEC.md and ADR 0064 and deletes it.

## Facts the design rests on

- **Email already has a sender.** The SMTP block in `notify.json` was
  kept for invitation and reset email (ADR 0052, decision 1).
  `sendEmail` in `packages/observability/src/alerts.ts` already sends
  through Squid with TLS required, and Squid already allows the SMTP host
  whenever SMTP is set (`packaging/alerts/alerts-job`). Email needs no new
  transport, settings file or egress host.
- **Dex can check Google groups itself.** The `google` connector in the
  pinned Dex (v2.45.1) already calls the Admin SDK. Its settings are
  `serviceAccountFilePath`, `domainToAdminEmail` (with a `"*"` wildcard),
  `groups` and `fetchTransitiveGroupMembership`. Portikus writes no Google
  client.
- **Self-service password change already exists** (Epic 14.2, SPEC 5.3,
  `apps/api/src/routes/me-password.ts`). Nothing to build there.
- **Dex cannot change a password's email.** Its UpdatePassword gRPC call
  changes only the username and hash, and ListPasswords removes the hash.
  So an email change has to delete the password and create it again under
  the same `user_id`.

## Rulings

Todd was away, so the orchestrator decided these, taking the architect's
recommendation each time. The epic PR lists them for Todd.

- **R1 (Entra, #1247).** Option A. A new setting `entraRoleSource` takes
  `appRoles` or `groups`.
  - In groups mode, Dex's `claimMapping.groups` is set to `groups` and
    `allowedGroups` holds the three role object IDs.
  - The site configures Entra to send "groups assigned to the
    application" and assigns the three groups to the Portikus app. The
    token then carries at most three groups, so the overage case cannot
    happen.
  - There is no Microsoft Graph call and no new credential or egress host.
  - The Graph-based overage path (option B) gets a follow-up issue. It
    needs no rework later, because the same three IDs carry over.
- **R2.** Google and Entra ship with render and unit tests only. STATUS
  records "unverified against a real tenant", and a follow-up issue asks
  Todd for real tenants.
- **R3.** There is no real mail relay for this epic.
  - e2e tests catch mail through `MAIL_CAPTURE_FILE`, a development-only
    setting using nodemailer's `jsonTransport`. It is refused when
    `NODE_ENV=production`.
  - The TLS path is covered by unit tests with an injected
    `MailTransportFactory`.
  - Delivery through a real relay is a gap, recorded in STATUS.
- **R4.** A reset link lasts 30 minutes and an invitation link 7 days.
  Each works once.
- **R5.** Account email has an explicit switch,
  `settings.account_email_enabled`, which is off by default and lives in
  the administrator Settings tab. Setting SMTP for alerts alone never
  emails students.
- **R6.** Group membership never admits anyone without an invitation
  (ADR 0049). Groups only add defense in depth and roles.
- **R7.** The install administrator is refused for emailed reset and for
  edits by other administrators. `portikus reset-admin` stays the way to
  recover it (SPEC 24.13).
- **R8.** Group membership is checked again only at sign-in, with no
  background sync. Sessions with a provider-elevated role already end
  after 12 hours.
- **R9.** The link page keeps its own challenge store for a passkey at
  link confirm and calls the shared passkey functions in `packages/auth`.
  There is no shared route helper.
- Migration 0050 is not needed and goes back to the pool.

## Design

### Tokens (migration 0049)

`account_email_tokens` has these columns:
- `id`;
- `user_id`, referencing users, on delete cascade;
- `purpose`, `'reset'` or `'invite'`;
- `token_hash`, unique;
- `created_by`, `created_at`, `expires_at`, `used_at` and `revoked_at`.

How tokens work:
- **Format.** A token is 32 random bytes in base64url. Only its SHA-256
  hash is stored. Grant the API's database role only; the API deletes
  ended rows hourly, as it does for `signin_counters`.
- **The column.** The same migration adds `settings.account_email_enabled boolean not null default false`.
- **Link.** It is `${PUBLIC_URL}/reset-password#<token>`, always built from
  `PUBLIC_URL`, never from the request Host. The token sits in the
  fragment, so Caddy, the API logs and the Referer never see it, and the
  page clears it with `history.replaceState`.
- **Revocation.** A new link revokes older ones for the same account and
  purpose. A password change, removal, disable or email change revokes
  all of them.

### Throttles

All throttles use stored counters (`createStoredCounter`) with new scope
names:
- Reset requests: 5 an hour per address, answered with 429; 3 an hour
  per account and 100 an hour site-wide, both answered with the same
  silent 202.
- Sends an administrator triggers: 5 an hour per account.
- A wrong or expired token at completion: 20 per 10 minutes per address.
- The reset request answers 202 first, then looks up the account and
  sends in a detached task, so the timing does not reveal whether an
  account exists.

### What completing a reset does

It starts no session and does not mark the second factor as passed. It:
- ends every session, preview session and known-device cookie (add the
  new completion audit action to `passwordStamp` in
  `apps/api/src/dex-password-relay.ts`);
- revokes other tokens;
- clears "must change password";
- emails a confirmation.

### Changing a Dex user's email (keeping the user ID)

The Portikus account is keyed by the Dex subject, which encodes Dex's
`user_id`, not the email (SPEC 5.1). The steps:
1. Delete the old Dex password.
2. Create one under the new email with the same `user_id` and a random
   hash.
3. Update `users.email`.
4. End the user's sessions.
5. Set "must change password", or send a set-password link to the new
   address when account email is on.
6. Notify the old address, and write an audit row with no addresses in
   it.

If the create step fails after the delete, the account fails closed, and
a retry of the route creates the missing password. `findDexPassword`
must cope with two rows for one `user_id`. A username change happens in
place (`new_username`) and keeps the password. The workspace label does
not change.

### Google groups (#1248)

- **The key.** A service-account key lives at a fixed path,
  `<dex_config_dir>/google-service-account.json`, owned
  `root:portikus-dex` with mode 0640.
  - The site page uploads it once, write-only, inside the 0600 site-job
    request. An operator may instead copy the file into place.
  - debconf asks only for the administrator email to impersonate.
  - `site-view.json` shows only "key set".
- **Checking the key.** Before writing it, the job checks that it is a
  `service_account` key with `token_uri` `https://oauth2.googleapis.com/token`.
  A bad file stops Dex for everyone.
- **Turning the mode on.** When the key and the administrator email are
  set:
  - Dex `groups` lists the three role group emails, all lowercase;
  - `fetchTransitiveGroupMembership` is true;
  - `domainToAdminEmail` is `{"*": admin}`;
  - the API's scopes gain `groups`, and `groupsClaim` is `groups`.
- **Render tests.** One must check the `groups` scope is present: Dex
  filters by group only when the client asks for that scope.
- **Egress.** `admin.googleapis.com:443` is added only in this mode.
- **Schemas.** Any new `SiteView` field is optional, because the schema is
  strict and older view files lack it.

### Passkey at link confirm (#1293)

- **Contract.** `PendingLink.passkey: boolean`, and `LinkConfirm` takes
  exactly one of `code` or `credential`.
- **The challenge.** It is bound to the course session, the "link"
  purpose and `pending.userId`, and used once. The credential is checked
  against that user only.
- **The rest.** A passkey uses the holder bypass, as at the gate, and the
  intent is checked again inside the transaction.
- **Framed pages.** A page framed by the LMS gets the browser's refusal
  and shows the error text.

### What to reuse

- **Mail.** Take `sendMail(smtp, proxyUrl, {to, subject, text}, transportFactory)` out of `sendEmail` and have `sendEmail` call it. Also reuse `readNotifyFile`, `NotifySmtp`, `MailTransportFactory`, `NOTIFY_FILE` and `OUTBOUND_PROXY_URL`.
- **Throttles.** `createStoredCounter`, `accountKey`, the IPv6 /64 rule, and `auth.throttled` audited once per window.
- **Passwords.** `isBreachedPassword`, `BREACHED_PASSWORD_MESSAGE`, the 15-character / 72-byte rule in `ChangePasswordRequest`, `hashDexPassword`, `generateDexPassword` and `localDexUserId`.
- **Dex calls.** `viaDex` and `DexCallFailed` (`apps/api/src/admin/dex-accounts.ts`). Add `updateUsername` to `packages/auth/src/dex-api.ts` and the fake gRPC server.
- **Sessions.** Move `endSessions` out of `admin-dex-users.ts` into `apps/api/src/sessions/`.
- **Notices.** `notifyCredentialReset` and `refuseInstallAdminChange`.
- **Passkeys.** `passkeyAuthenticationOptions`, `checkPasskey`, `createChallengeStore`, `listPasskeys` and `SecondFactorThrottle.allow(..., {passkeys})`. In the browser: `PasskeyButton`, `passkeysSupported` and `passkeyErrorText`. For e2e: `packages/auth/src/testing/soft-passkey.ts`.
- **Route registry.** Every new route goes into `apps/api/src/security/route-policy.ts` (additions only). Public POSTs use `checkCsrf`.
- **Settings switch.** Copy Epic 47's voice switch: `voiceInputEnabled` in `contracts/settings.ts`, `routes/admin.ts` and `SettingsTab.tsx`.
- **Sign-in trial.** `finishSigninTest` already maps groups to a role on a trial sign-in.
- **Real-Dex tests.** `submitDexPasswordForm`, the CI `dex-signin` job and `dex.integration.test.ts`.

## Tasks

| Task | Scope | Depends on | Owns |
|---|---|---|---|
| T1 Account email foundation | Migration 0049 and its test; `schema.ts` and the migrations index; the `sendMail` extraction; `apps/api/src/account-email/` (`tokens.ts`, `messages.ts`, `send.ts`); `MAIL_CAPTURE_FILE` in `packages/config`; the switch in `contracts/settings.ts`, `routes/admin.ts` and `SettingsTab.tsx`; the `e2e/mail.ts` helper and `playwright.config.ts` env; moving `endSessions` | — | migrations, `schema.ts`, `playwright.config.ts`, `packages/config`, `contracts/settings.ts` (switch) |
| T2 Forgotten password | `routes/password-reset.ts`; `contracts/password-reset.ts` and its line in the contracts index; registration in `server.ts`; `route-policy.ts` additions; the `passwordStamp` action; the `/forgot-password` and `/reset-password` pages and router entries; the Dex `password.html` "Forgot your password?" patch in `infra/ansible/roles/dex/tasks/web.yml`; the STUDENT-GUIDE section; e2e | T1 | `contracts/index.ts` (one line), `router.tsx` |
| T3 Admin emails and edits | Add user with "email a link" in place of showing a password; email for SSO invitations, with resend; the same for CSV import; "Send reset link"; `PATCH /admin/dex-users/:id` for email and username; `dex-api.ts` and the fake gRPC server; a `dex-signin` test that the subject stays the same; the Users dialogs and menu; `CreateDexUserRequest`; the ADMIN-GUIDE Users section; e2e | T1; runs beside T2 | `dex-api.ts`, `admin-dex-users.ts`, `AccountMenu.tsx`, `DexUserDialogs.tsx` |
| T4 Google groups and Entra group IDs | Dex `config.yaml.j2`, `site.yml`, `roles/dex/tasks/settings.yml`, `packaging/debian/{templates,config,settings-keys}`, `packaging/site/{site-job,site_values.py,write-settings}`, `contracts/site.ts`, `SsoFields.tsx` and `ssoForm.ts`; egress; render and Python tests; the INSTALL and ADMIN-GUIDE provider sections, with the rule that only groups administrators can change may map to roles | — (starts at once) | `contracts/site.ts`, `packaging/site/*`, `packaging/debian/*`, `site.yml`, `config.yaml.j2` |
| T5 Passkey at link | `routes/links.ts`, `contracts/links.ts`, `LinkPage.tsx`, `second-factor/passkey.ts`, and the e2e flow in `account-link.spec.ts` | — (starts at once) | `contracts/links.ts` |
| T6 Fold | SPEC 5.1, 5.3, 20.1, 24.8, 24.11 (the new audit actions), 24.13, 26 and 29; ADR 0064; STATUS with the gaps from R2 and R3; follow-up issues for real tenants and the Entra Graph overage path; delete this plan | all | `docs/` |

Order: T1, T4 and T5 start together. T2 and T3 start after T1 lands.
`route-policy.ts` and `server.ts` take additions only. Epic 48 adds to
them too.

## Security review focus (SPEC 24)

1. **Tokens.** 256 bits, stored as hashes, carried in the URL fragment. Never logged or audited; audit rows hold only the row id.
2. **Links.** Built from `PUBLIC_URL` only.
3. **Account enumeration.** One answer for every request, a detached send, and a silent per-account throttle.
4. **Mail bombing.** The caps in the throttle section apply. Mail goes only to the address Dex stores for that `user_id`. The login is ASCII-only with an exact lowercase match. The templates are fixed text.
5. **No skipping the second factor.** Completing a reset never skips it, and it ends sessions, preview sessions and known-device cookies.
6. **The install administrator** is excluded.
7. **Email change.** The old Dex password never survives, and the old address gets a notice.
8. **The new public POSTs** have CSRF checks and route-policy entries, and count against the anonymous limit.
9. **The mail capture setting** is refused in production.
10. **The Google key.**
    - It is write-only, owned `root:portikus-dex` with mode 0640, and sent once in the 0600 request.
    - It never appears in a view, a status file or a log.
    - Its only scope is `admin.directory.group.readonly`.
    - The docs advise impersonating a custom administrator role that can only read groups.
11. **Self-joinable groups** must never map to a role, and the docs say so.
12. **Egress.** `admin.googleapis.com` is allowed only in Google groups mode.
13. **The passkey challenge at link** is bound to the course session, the purpose and the user, and used once.
14. **Admission still needs an invitation.** Group membership alone never admits anyone.

## Rehearsal

On the rehearsal VM:
- A forgotten-password reset end to end, with the mail capture file on a development build or a hand-run check. Real delivery is a gap.
- An administrator changes a Dex user's email and username, and the same account and workspace survive the next sign-in.
- The Google and Entra Dex configs render, and Dex starts with them.
- A passkey confirms an LMS link through the mock LMS.
