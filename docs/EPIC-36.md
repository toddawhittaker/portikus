# Epic 36: Internet hardening (plan)

This plan lives only on `epic/36-internet-hardening`. The fold task (H10)
moves its lasting rules into SPEC.md and deletes it (WORKFLOW.md, "Epic
plans"). Code, tests and other docs cite SPEC.md sections or ADRs, never
this file. It follows the architect's design for the epic, base main at
734c8264.

The epic closes the gaps BACKLOG.md "Epic 36" lists before a site faces
the internet: a real breached-password list, a per-address limit on
public routes, sign-in counts that survive a restart, no own certificate
authority on a public address, pinned agent versions in the admin image
rebuild, alerts from the logs, and the residual risks Epic 35 left. It
serves SPEC.md sections 24.9, 24.10 and 24.13.

## Rulings

- **H1, breached passwords (Todd, 2026-10-05).** Use the SecLists
  top-1M list (`xato-net-10-million-passwords-1000000.txt`), keep only
  entries of at least 15 characters, and ship it offline. The MIT
  licence is approved. Recorded in ADR 0054.
- **H8, sign-in counters (Todd, 2026-10-05).** Counters move into
  PostgreSQL in migration 0040, and a recovery code still gets through
  when the account count refuses. Recorded in ADR 0053, which supersedes
  part of ADR 0048.
- **#1192, the Dex password throttle smoke check: the relay is right,
  the smoke test is wrong.** SPEC.md section 24.13 says the relay counts
  each post and gives the count back when the post did not fail. When
  Dex answers 400 to a made-up `state`, no password was checked, so
  nothing failed and nothing can be guessed; H2 bounds a flood of such
  posts. The smoke check must get a real Dex `state` the way `dex_signin`
  does, then post 31 times with a different made-up login each time.
  With one login, the account limit (10) refuses first and gives the
  address count back, so the address count never reaches 30. Task H11.
- **Session-ended reason (H9).** One fixed sentence on the page; no
  reason is passed from the server. Passing it later costs the same.
- **H1 format.** A plain text file read into a `Set`. A Bloom filter
  only pays off for millions of entries; this list has about 11
  thousand.
- **Counter table shape (H8).** One table, the same fixed windows as
  today, one atomic upsert per hit (ADR 0053). Counting from
  `audit_events` is rejected: audit rows are written after Dex answers,
  and sign-in starts are not audited.

## Todd's answers to the architect's questions (2026-10-06)

1. **Passkeys get past the daily lockout.** When 30 wrong codes lock an
   account for the day, a passkey still gets through, like a recovery
   code, with the same per-session count (ADR 0053). H8 builds both.
2. **A setting allows the own authority on a public address.** This is
   not the architect's recommendation (reset-certificate as the only
   override). A new `portikus.yaml` key,
   `portikus_allow_internal_ca_on_public_address`, default `false`,
   in the same snake_case style as `portikus_public_port`, lets the
   internal certificate authority run on a public address. Without it,
   setup and the certificate job refuse and tell the operator to set the
   key, run `dpkg-reconfigure portikus` to pick Let's Encrypt or files,
   or run `sudo portikus reset-certificate`. H3 owns it. The key lives
   in the Ansible defaults and `portikus.yaml`, not in
   `packages/config`, so it does not collide with H2. H10 adds the
   INSTALL and OPERATIONS wording, and a debconf question only if the
   fold finds `portikus.yaml` alone is not enough.
3. **Both small backlog items are in.** H12 (a killed job hides newer
   ones on the Certificate and Image tabs) and counting made-up preview
   cookies against H2's per-address limit.

**For Todd to do:** make the Dex sign-in CI job a required check in the
repository ruleset. That closes the last part of #1138.

## Tasks

Sizes are S (small), M (medium) and L (large).

| Task | What to build | Where | Reuse | Size | Agent |
|---|---|---|---|---|---|
| H0 | The plan `docs/EPIC-36.md`, ADR **0053** (sign-in counters in PostgreSQL and the recovery-code bypass), ADR **0054** (an offline breached-password list from SecLists), index lines in `docs/adr/README.md`, and a "superseded in part by 0053" line in ADR 0048 | docs only | WORKFLOW "Epic plans"; the EPIC-35 plan's table layout | S | builder (docs) |
| H1 | Generator `scripts/generate-breached-passwords.mjs`. Input: SecLists `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`, pinned by SecLists commit and sha256, plus the current hand-written entries. Output: lower-cased, at least 15 characters, sorted, de-duplicated. Today that is **10,898 lines, about 192 KB**, all ASCII (I measured it). Output goes to `packages/auth/data/breached-passwords.txt`, with SecLists' MIT notice in `packages/auth/data/SecLists-LICENSE`. `breached-passwords.ts` reads the file synchronously once at import into a `Set`, so `isBreachedPassword` keeps its signature and `routes/me-password.ts` is unchanged. Add a unit test that checks for a known entry such as one from the list's head, and an e2e case in `e2e/change-password.spec.ts` that uses a list entry that was not on the old list. Check `dpkg -c` to confirm the .deb carries `packages/auth/data/` | `packages/auth/src/breached-passwords.ts` (+ test), `packages/auth/data/` (new), `scripts/generate-breached-passwords.mjs` (new), `e2e/change-password.spec.ts` | `packages/auth/src/dex-api.ts` line 19: `new URL("../proto/dex-api.proto", import.meta.url)` is the pattern for a data file shipped beside `dist/`. Keep `BREACHED_PASSWORD_MESSAGE` | S-M | builder |
| H2 | A per-address limit of 600 a minute on routes without a session (SPEC 24.13). Add `anonymousLimit` with `addressKey` (an IPv6 /64 counts as one address) and `check()`. Answer 429 with `RATE_LIMITED` and `retry-after`. Log a warning on the first refusal per window, with no audit row. **Register it before `registerSigninThrottle`**, so its cheap in-memory count runs ahead of the database counts H8 adds. It cannot use the session, so it matches a fixed list of public route URLs. A unit test asserts that the list equals the `public` entries in `ROUTE_POLICY`, minus `/edge/certificate-ask`, which Caddy asks with no client address. Also count `/preview/authorize` misses (made-up preview cookies) on the same counter (BACKLOG "A per-address limit on made-up preview cookies"; Todd's answer 3). New config key `ANONYMOUS_REQUEST_LIMIT_PER_MINUTE`, default 600, set to "100000" in `playwright.config.ts`. Add a smoke check: 601 `GET /lti/jwks` requests through Caddy from one random loopback address get a 429 | `apps/api/src/rate-limit.ts` (+ test), `apps/api/src/server.ts`, `apps/api/src/routes/preview.ts`, `packages/config/src/index.ts`, `playwright.config.ts`, `infra/tests/smoke/control-plane.sh` | `createCounter`, `check`, `addressKey` in `rate-limit.ts`; `ROUTE_POLICY` in `apps/api/src/security/route-policy.ts` (test side only); the limit pattern in `packages/config` | S-M | builder |
| H3 | Refuse the internal authority on a public address unless the operator allows it. In `certificate-job`, `first-install` and `apply` with `source: internal` resolve the site host (an IP literal is taken as is). If any address is `ipaddress.is_global` and `portikus_allow_internal_ca_on_public_address` is not true, refuse with a fixed code and a message that names three ways out: set that key in `portikus.yaml`, pick Let's Encrypt or files with `dpkg-reconfigure portikus`, or run `sudo portikus reset-certificate`. A name that does not resolve counts as private. `reset` always works, including before any certificate state exists. Add the key with default `false` to the Ansible defaults and pass it to the job. Turn the postinst and `admin.yml` warnings into "refused unless...". Keep the key when postinst rewrites `portikus.yaml` (it already keeps keys it does not own; add a case to `settings-keys-test.sh`). The resolver is injected; tests fake it and `systemctl` (never run real `systemctl`, `loginctl` or `kill`). If the page maps job codes to text, add one entry in `packages/contracts/src/certificate.ts` | `packaging/certificate/certificate-job`, `packaging/certificate/tests/*`, `packaging/scripts/postinst`, `packaging/tests/settings-keys-test.sh`, `infra/ansible/roles/portikus/defaults/main.yml`, `infra/ansible/roles/portikus/tasks/admin.yml`, `infra/ansible/roles/caddy/tasks/certificate.yml`, `packages/contracts/src/certificate.ts` (if needed) | `Refused`, the status codes and `run_reset` in `certificate-job`; `packaging/certificate/tests/helpers.py`; the `portikus_public_port` key style | M | infra |
| H4 | Pinned agent versions in the admin rebuild (#1145). Delete `PORTIKUS_CLAUDE_VERSION="latest"` and `PORTIKUS_CODEX_VERSION="latest"` (`image-job` lines 780-781), so the recipe's pins in `portikus.yaml` apply and a package upgrade is the deliberate bump. Flip the test at `test_image_job.py:561`. Fix the README sentence "asks for the latest" | `packaging/image/image-job`, `packaging/image/tests/test_image_job.py`, `infra/workspace-image/README.md` | the pins already in `infra/workspace-image/portikus.yaml` lines 6-7 and 2223-2224 | S | builder |
| H5 | Alert sources in the API. The API is the only unit in the `systemd-journal` group (`packaging/systemd/portikus-api.service`), which is why these live there and not in the worker. Each minute, read the journal from the last cursor with levels `error` and `warn`. (a) The kernel outbound-limit lines (mail block, connection limit, packet limit) are mapped to a workspace by `workspaces.agent_address`, with one warning site alert per workspace and reason an hour (an in-memory map). (b) An error spike is 20 or more error or fatal lines from the three Portikus units in 15 minutes: one alert, raised again only after it clears (the worker's `alert-sources.ts` pattern). Alert text names the limit and the Incus instance name, never the student's email, because alerts leave the site. A busy or missing journal skips the tick | new `apps/api/src/alerts/log-alerts.ts` (+ test), `apps/api/src/index.ts` (start and stop) | `JournalReader`, `parseJournalLine` (`apps/api/src/logs/journal.ts`), `kernelLineMessage` (`logs/kernel.ts`), the address lookup in `routes/admin-logs.ts` lines 60-68, `notifyAdministrators` (`packages/db`), the start/stop shape of `startCertificateNotices` (`apps/api/src/certificate/notices.ts`) | M | builder |
| H6 | The rest of #1138. (a) For each restore mode (a whole `portikus restore`, a side copy, Replace home; ADR 0040), check that owners, modes and the marker survive. (b) A recovery point never carries `~/.claude/.credentials.json` or `~/.codex/auth.json`, even through a symlink in the project (unit test). The Dex required check is Todd's ruleset change, so this task's PR says "Refs #1138" | `infra/tests/backup-rehearsal.py`, `infra/tests/install-test.sh` (new steps), `apps/workspace-agent/src/recovery.test.ts` | the `seed`, `check-restored`, `psql` and `check` helpers in `backup-rehearsal.py` | M | infra |
| H7a | Residual risks, API side. (1) An expired passkey challenge gives its count back: `throttle.giveBack(user.id)` before `expired(reply)` in `/me/second-factor/webauthn/verify`. (2) A cap of 50 kept notices per person, oldest kept dropped, in `recordNotification`, with a constant beside `MAX_NOTIFICATIONS_PER_USER`. (3) A full content security policy on HTML the API writes: an `onSend` hook in a new `apps/api/src/page-policy.ts` sets `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` on `text/html` replies that carry no policy. `routes/lti.ts` sends a full policy with its own `frame-ancestors`. Check each HTML writer: `dex-password-relay.ts`, `routes/lti.ts`, `routes/preview.ts`. Verify through Caddy on the rehearsal VM, because Caddy adds its own `frame-ancestors 'none'` on non-LTI paths (`Caddyfile.j2` line 206) | `apps/api/src/routes/me-second-factor.ts`, `packages/db/src/index.ts`, `packages/contracts/src/notifications.ts`, new `apps/api/src/page-policy.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/lti.ts`, `apps/api/src/routes/preview.ts` (only if a page needs it) | the cap query already in `recordNotification`; `second-factor-throttle.ts` `giveBack` | M | builder |
| H7b | A quota in the off-site prune script, with no new argument. When `incoming` holds more than twice the largest kept set (at least 1 GiB), drop every unfinished entry and print a warning to stderr (cron mails it) | `infra/host/offsite-prune.sh`, `infra/tests/backup-offsite-test.sh` | the existing `is_set` and `is_dir` guards | S | infra |
| H8 | Sign-in counters in PostgreSQL, migration **0040** (ADR 0053). See Rulings. Move the counts in `createSigninThrottle` (starts and password posts per address, password failures per account), `createSecondFactorCounts` (10 minutes and daily) and `createAccountThrottle` (the password-change form) onto one `StoredCounter` with the same `hit`, `giveBack` and first-refusal semantics. The clock is passed in for tests. A worker loop deletes rows whose window ended more than a day ago. **The recovery-code bypass:** when the account count refuses, a code shaped like a recovery code (16 characters of `RECOVERY_ALPHABET` after removing spaces and dashes) is still checked. It is counted per **session**, 10 in 10 minutes, so an attacker's sessions cannot lock out the holder's own session. The 429 text says a recovery code still works. The same applies on `routes/links.ts`. Adds a smoke check: the per-address password count survives `systemctl restart portikus-api` (runs after H11). Adds an e2e test in `e2e/second-factor.spec.ts`: 30 wrong codes, then a recovery code still signs in | `packages/db/src/migrations/0040_signin_counters.ts`, `migrations/index.ts`, `packages/db/src/schema.ts`, `packages/db/src/testing.ts` (truncate list), new `apps/api/src/stored-counter.ts` (+ test), `signin-throttle.ts`, `second-factor-throttle.ts`, `dex-password-relay.ts`, `routes/me-second-factor.ts`, `routes/me-password.ts`, `routes/links.ts`, `server.ts`, new `apps/worker/src/counter-prune.ts`, `apps/worker/src/index.ts`, `e2e/second-factor.spec.ts`, `infra/tests/smoke/sign-in.sh` | `ThrottleDecision`, `decide`, `accountKey`, `addressKey`; `hashRecoveryCode` and `checkSecondFactor` (`packages/auth/src/second-factor.ts`); the `pruneNotifications` and `startLoop` pattern (`apps/worker/src/notifications.ts`); the migration shape of `0039_notification_flags.ts` | L | builder (high effort) |
| H9 | (a) A short "Inviting people" part in the Help page's "For administrators" covering Invite, matching per provider (ADR 0049) and CSV upload. (b) The link page's status region stays mounted with no height while it is empty. (c) "Session ended" gets one fixed sentence: a session whose administrator or instructor role came from the institution ends after 12 hours. The page is not told the reason; see Rulings. Re-run the axe scans in both themes | `apps/web/src/help/content/admin.tsx`, `apps/web/src/link/LinkPage.tsx` (+ test), `apps/web/src/pages/SessionEnded.tsx` (+ test), `e2e/help.spec.ts`, `e2e/a11y-link.spec.ts`, `e2e/elevated-session.spec.ts` | `StandalonePage.tsx`; the toggletip and help components already in `help/` | S | ui-designer |
| H11 | Fix the smoke throttle check as ruled above. "Fixes #1192" | `infra/tests/smoke/sign-in.sh` | `dex_signin`, `random_loopback`, `api_env`, `check_output` | S | infra |
| H12 | (Todd's answer 3.) `currentJob` skips jobs older than the stale limit and prefers the newest. `alerts/jobs.ts` imports `NOTIFY_JOB_STALE_MS` from contracts | `apps/api/src/job-files.ts` (+ test), `apps/api/src/alerts/jobs.ts` | BACKLOG "A killed job hides later ones" | S | builder |
| H10 | The fold: SPEC 24.10 (the H3 refusal), 24.13 (the list, the anonymous limit, the database counters, the bypass), 24.9 (the prune quota), 15 or 20.x (the new alert sources), 5.3 if it names the counts, and a section 29 "Epic 36" entry. STACK 15 (alert sources in the API). `docs/INSTALL.md` and `docs/OPERATIONS.md` (H3, H7b). BACKLOG: remove the entries this epic finished, and the stale "A per-user cap on terminal WebSocket connections", which the Epic 34 socket caps already did. `docs/STATUS.md` from the PR bodies. Delete the plan | docs only | | S-M | builder |

Citations per task. H1: SPEC 24.13, ADR 0054. H2: SPEC 24.13. H3: SPEC
24.10. H4: SPEC 24.10, #1145. H5: SPEC 24.8, STACK 15, ADR 0052. H6:
SPEC 24.9, ADR 0040. H7a: SPEC 24.13, ADRs 0048 and 0052. H7b: SPEC
24.9, ADR 0050. H8: SPEC 24.13, ADR 0053. H9: SPEC 25.8, ADR 0049. H11:
SPEC 24.13. H12: SPEC 24.8.

## File ownership and wave order

No two tasks in one wave touch the same file. A later wave may edit a
file an earlier wave already landed.

| Shared file | Owner (wave) |
|---|---|
| `apps/api/src/server.ts` | H2 (A), then H7a (B), then H8 (C) |
| `apps/api/src/routes/preview.ts` | H2 (A), then H7a (B) if needed |
| `apps/api/src/routes/me-second-factor.ts` | H7a (B), then H8 (C) |
| `apps/api/src/index.ts` | H5 only |
| `apps/worker/src/index.ts` | H8 only |
| `packages/config/src/index.ts`, `playwright.config.ts` | H2 only |
| `packages/contracts/src/notifications.ts` | H7a; `certificate.ts`: H3. Nobody adds a contracts file, so nobody edits `index.ts` |
| `packages/db` (migration **0040**, `schema.ts`, `testing.ts`, migrations index) | H8; `packages/db/src/index.ts`: H7a (B), before H8 |
| `infra/tests/smoke/sign-in.sh` | H11 (A), then H8 (C); `control-plane.sh`: H2 |
| `infra/tests/install-test.sh`, `backup-rehearsal.py` | H6 |
| `packaging/nfpm.yaml` | nobody needs it. If H1's `dpkg -c` check shows `data/` missing, H1 owns the fix |
| Ansible roles | H3 only (`portikus/defaults/main.yml`, `portikus/tasks/admin.yml`, `caddy/tasks/certificate.yml`) |
| `packaging/scripts/postinst`, `packaging/tests/settings-keys-test.sh` | H3 only. The new `portikus.yaml` key is not in `packages/config`, which stays H2's alone, so H2 and H3 can run in the same wave |
| `docs/adr/*` | H0; SPEC, STACK, INSTALL, OPERATIONS, BACKLOG and STATUS: H10 only; Help content: H9 |

- **Wave 0:** H0 alone, then security-reviewer on the plan and ADRs 0053 and 0054.
- **Wave A (parallel):** H1, H2, H3, H4, H5, H7b, H9, H11, H12.
- **Wave B:** H7a (after H2, for `server.ts` and `preview.ts`), and H6 (the rehearsal VM, after H3 frees it).
- **Wave C:** H8. It goes after H7a (`me-second-factor.ts`, `server.ts`, the second-factor counting), after H11 (`sign-in.sh`), and after H2, whose in-memory limit must sit in front of the new per-request database writes.
- **Wave D:** H10.

Task PRs put their proposed STATUS line in the PR body and do not edit
STATUS.md. One Fixes keyword per issue: H4 "Fixes #1145", H11 "Fixes
#1192", H6 "Refs #1138". H9 cites #1155, #1166 and #1156 with "Refs"
only, because those are merged PRs.

## Reviews and rehearsal-VM steps

- **security-reviewer:** H0 (the ADRs), H1, H2, H3, H7a, H7b and H8, then the epic head, which touches auth and the preview edge.
- **a11y-reviewer:** H9, and H8 only if it changes web text.
- **code-reviewer:** every task at the epic level, as usual.
- **Rehearsal VM.** There is one VM, so its use is serialized. H3 uses it in wave A: own authority allowed on a private name, refused on the admin page for a public one with a faked resolver, allowed again with `portikus_allow_internal_ca_on_public_address: true`, and `reset-certificate` still works. H6 uses it in wave B (restore modes). H11 can run its smoke check against the pilot, Todd's dev VM. After wave C, one epic-head pass on the rehearsal VM covers:
  - full smoke and security test runs;
  - H2: a 429 through Caddy;
  - H7a: `curl -I` of a relay refusal page through Caddy shows the full policy;
  - H5: `nc` to port 25 from a workspace raises one alert within 2 minutes;
  - H8: counts survive an API restart, and the recovery-code bypass works on real Dex;
  - H4 (optional, long): one admin rebuild reports the pinned versions.
- H7b needs no VM; `backup-offsite-test.sh` runs locally in `make infra-check`.

## Left out

- Disk encryption (#1142) and changing the site address (#935): ruled out of this epic.
- Processes that outlive the root-shell off switch: it needs its own real-host design, and only administrators reach it.
- SMTP cleared when email is turned off: deferred until invitations or password resets send email.
- The notification e2e repeat and run-as-root issues, and the real `apt remove` run: test hygiene, not internet hardening.
- Passkey at link confirm (#1165), removing the `names_v4` upgrade code, domain fronting, and Dex logins that are not ASCII (an accepted risk).
- Moving passkey challenges, socket caps and per-user limits into the database: a restart only means a retry.
- Requests with no session to protected routes are not counted by H2. The auth hook answers them with 401 before any route work, and at most one session lookup.
- A separate e2e test for H5. No UI changes, so unit tests with a fake `JournalReader` and the real-host check cover it.
