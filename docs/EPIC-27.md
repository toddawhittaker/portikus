# Epic 27: Certificate settings page (#804)

This plan lives only on `epic/27-certificates` (docs/WORKFLOW.md, "Epic plans"). The fold task turns its lasting rules into SPEC.md and ADR 0046 and deletes it. Where it is silent, SPEC.md wins on behaviour (sections 20.1, 21.12, 22.4, 24.8, 24.10, 24.11) and STACK.md on technology (sections 12 and 13).

- **Base:** `origin/epic/27-certificates`, cut from `main` at 614a14a7. Builders reset to the epic head and branch `task/27-<name>`.
- **Migration:** `0034` is reserved, but no task is expected to need one (notifications and audit already have tables).

Terms:

- **ACME** (Automatic Certificate Management Environment): the protocol Let's Encrypt and ZeroSSL speak. A **directory URL** names one ACME service.
- **DNS-01** proves control of a name by a DNS record, so it can issue a wildcard. **HTTP-01** proves it by a file served on port 80, one name at a time; for previews this needs Caddy's **on-demand TLS**, which asks Portikus before issuing for each new name.
- **EAB** (External Account Binding): a key ID and HMAC (keyed hash) key some ACME services require to tie an account to a customer.
- **Pebble**: Let's Encrypt's small ACME test server, run locally in tests.
- **The job**: the root-owned Python program `certificate-job`, started by a systemd path unit when the API drops a request file, as the image job does (SPEC.md 22.4, ADR 0030).

## Goal

An administrator chooses and changes the site's certificate from an admin tab without touching the server: Caddy's internal authority, ACME (Let's Encrypt, its staging service, ZeroSSL, or any directory URL) by DNS-01 with one of nine DNS providers or by HTTP-01, or uploaded files. The page checks first, tests against staging before going live, rolls back on its own when the live change fails, shows what certificate is in use and when it expires, warns administrators before expiry and on renewal failure, and offers the internal root certificate for download. A root command recovers a site the page has made unreachable. Changing the site's address is out (#935).

## Todd's answers (2026-09-30)

- **A1** DNS plugins: Cloudflare, Route 53, DigitalOcean, OVH, Hetzner, Gandi, Porkbun, Google Cloud DNS, Azure. Only Cloudflare is tested end to end; the other eight get configuration-generation unit tests.
- **A2** HTTP-01 with on-demand previews ships, tested by unit tests and Pebble only. The pilot's names resolve to a private address, so there is no real HTTP-01 issuance on the pilot. The epic PR says so.
- **A3** Pilot test domain `pilot.portikus.thewhittakers.org`, Cloudflare token in `~/portikus_dns_token.txt` on the workstation. Agents copy the file and never read or echo it. Staging first, then a production DNS-01 wildcard (site plus `*.preview.pilot.portikus.thewhittakers.org`) as the final pilot state.
- **A4** No campus EAB account: EAB is tested with Pebble only.

## Rulings

1. **R1** Epic 27, ADR 0046, migration 0034 only if a database change turns out to be needed.
2. **R2** Caddy stays the only ACME client. No lego, certbot or acme.sh.
3. **R3** Setup always builds Caddy with the nine plugins, as it builds Dex and distrobuilder; `plugin.yml` loses its letsencrypt-only condition. Rejected: a prebuilt Caddy in the .deb, which adds a Go build to CI and packaging for no gain.
4. **R4** The page owns the certificate after install. State lives in root-owned `/etc/portikus/certificate/` (see the contract below). Setup writes it from the debconf answer only when it does not exist yet. A later setup run or `dpkg-reconfigure` never touches it; INSTALL.md says so.
5. **R5** `Caddyfile.j2` imports one snippet, `/etc/portikus/certificate/tls.caddy`, for the TLS directive of both site blocks. For HTTP-01 the job's snippet set also carries the preview block's on-demand directive and the global `on_demand_tls { ask ... }` option. Ansible no longer renders a TLS directive.
6. **R6** The installer default becomes `internal`. The TLS question stays and stays preseedable, but is asked at a low enough debconf priority that a normal interactive install skips it, following the existing config script. Old `letsencrypt` preseeds (`acme_email` plus `cloudflare_api_token`) still work and seed ACME DNS-01 with Cloudflare.
7. **R7** Request file, root job and systemd path unit, copied from the image job: `/var/lib/portikus/certificate-jobs/request-<id>.json` written by the API; Python standard library only; `portikus-certificate-job.path` and `.service`; `status.json` and `log.txt` per job. The job re-validates everything and never trusts the API. Kinds: `test` (staging only), `apply`, `renew`, `rollback`, `check`, plus `reset` written only by the recovery command.
8. **R8** Secrets (DNS credentials, the EAB HMAC key, an uploaded private key) are write-only in the API and page. They travel once, in the 0600 request file, which the job deletes as soon as it has taken them. They are stored only in root-owned files Caddy can read, referenced from the snippet as `{env.NAME}` placeholders, and never appear in Caddy's autosave, a log, the journal, an audit row, `status.json`, a view, or a process's arguments. A blank secret field on re-apply keeps the stored one.
9. **R9** Uploads are checked twice: by the API with `node:crypto` (`X509Certificate`, `createPrivateKey`) for an immediate message, and by the job with `openssl` (argument lists, never a shell). Checks: the key matches; the chain is complete to a root in the system store or to an included self-signed root; dates are valid; the names cover the site and `*.<preview suffix>`, or a separate preview wildcard is uploaded that covers it. Each failure names the check that failed.
10. **R10** Pre-flight runs in the API with Node's `dns.Resolver` (which skips `/etc/hosts`): the site and a sample preview name resolve, and a nonce Caddy serves is reachable at each name, which proves the name points here. For HTTP-01 it also checks plain `http://` on port 80. Failures block HTTP-01; for DNS-01 they are warnings, because the certificate does not depend on them. Known limit, documented: the check runs from the server itself, so a firewall that only blocks outside traffic is caught by the staging test, not the pre-flight.
11. **R11** An ACME apply runs pre-flight, then a staging issuance by a throwaway second Caddy with its own storage, then the live change. If the live certificates do not appear in time, the job restores the previous snippet and secrets, reloads Caddy, and the page shows Caddy's error with secrets scrubbed. "Test only" runs pre-flight and the staging issuance. Mechanics: **from the spike** (placeholder S1 below).
    **R11 amendment (orchestrator, 2026-09-30):** when the chosen directory is Let's Encrypt production, the test uses Let's Encrypt staging. ZeroSSL and custom directories have no staging service, so the test issues from the chosen directory itself into the throwaway Caddy's storage; the live site is still untouched, and the page says this test gets a real certificate from that authority. There is no separate staging directory field.
12. **R12** An hourly root `check` (timer) writes `status.json`: issuer, names and expiry for the site and a sample preview name, the source, and whether the last renewal worked (from Caddy's journal). The API turns it into notifications to every enabled administrator for expiry within 14 days and for renewal failure, once per certificate per condition. Email (#918) is out; a BACKLOG line records it.
13. **R13** An admin-only API route serves Caddy's internal root, which the job copies to a world-readable path. Help text gives short install steps.
14. **R14** The trust bundle the API uses (`portikus_caddy_root_cert`) is always the system authorities plus Caddy's internal root plus any uploaded chain, so a mode switch never breaks the API's own calls through Caddy. The job restarts the API only when that file's content changes.
15. **R15** `portikus reset-certificate` (in `packaging/bin/portikus`) resets to the internal authority, keeps the old state as `previous`, reloads Caddy, prints the root certificate path, and writes a `reset` job directory so the API audits it. Documented in OPERATIONS.md and tested on the pilot.
16. **R16** Audit: `certificate.job_requested` and `certificate.job_finished` (the latter also for a `reset` job found on disk), metadata without secrets: kind, source, directory, provider, state.
17. **R17** The tab is `certificate`, in the "change" group of `ADMIN_TABS`, placed after `image` and before `docker` (both are root-job pages).
18. **R18** Changing the site's address is out (#935).

## The file contract

`packages/contracts/src/certificate.ts` is the contract; its top comment is authoritative. In short:

- **Job directory** `/var/lib/portikus/certificate-jobs/` (root:portikus, 0770). The API writes `.request-<id>.tmp` (0600) and renames it to `request-<id>.json` (`CertificateJobRequestFile`). The job takes the secrets, writes `<id>/request.json` as `CertificateJobRecord` (secrets replaced by "set" flags), deletes the request file, and writes `<id>/status.json` (`CertificateJobStatusFile`) and `<id>/log.txt`. It keeps the last 20 job directories. One job at a time; refused requests get state `refused` with the failed check named.
- **State directory** `/etc/portikus/certificate/` (root:caddy, 0750), never touched by the API: `settings.json` (`CertificateSettingsView`, no secrets), `secrets.env` (root 0600, loaded into Caddy's environment by a systemd drop-in), `files/` (uploads, keys 0640 root:caddy), `tls.caddy` (the snippet), `previous/` (one earlier generation).
- **Status directory** `/var/lib/portikus/certificate/` (root, 0755), read-only for the API: `status.json` (`CertificateStatusFile`) and `root.crt`.
- Every write is a temporary file renamed into place.
- Views (`AdminCertificate`, `CertificateSettingsView`, `CertificateJobView`) are strict schemas with no secret field; secrets appear only as booleans (`secretsSet`, `hmacKeySet`, `privateKeySet`). The unit tests pin this.
- DNS provider field names are in `DNS_PROVIDER_FIELDS`, split into plain and secret fields. Names marked **from the spike** (S2) until confirmed against each plugin.

## Spike placeholders

The pilot spike answers these. The orchestrator sends the findings to the owning tasks by message; this plan is not updated.

- **S1** How the staging test runs (throwaway Caddy command line, storage path, timeout), how `renew` forces a renewal, and how the job knows the live certificate has appeared.
- **S2** Each plugin's Caddyfile field names, and which are secrets.
- **S3** Caddy's journal format for renewal success and failure, which the `check` parses.
- **S4** Pebble: version, how it is run in tests (binary or container), and how EAB is enabled.
- **S5** Whether `{env.NAME}` placeholders keep every plugin's secrets out of autosave (Google's service account JSON may need a file path instead).

## Tasks

No two tasks edit the same file (see "Parallelism and file ownership"). T1 to T4 and D run in parallel from the epic head; V runs after they land; F runs last.

| Task | Agent | Files in scope | Done looks like | Depends on |
|---|---|---|---|---|
| **T1** Root job | builder | `packaging/certificate/` (job, Python tests, Pebble integration test), `packaging/systemd/portikus-certificate-*` (job path and service, check timer and service, Caddy secrets drop-in), `packaging/bin/portikus` (`reset-certificate`), `packaging/nfpm.yaml` entries | Every kind implemented to the contract; snippet generation unit-tested for internal, files, HTTP-01 and all nine providers; validation refuses everything the zod schemas refuse; `openssl` upload checks each named; rollback and failed-apply restore tested; secret scrubbing tested on Caddy messages; a Pebble test issues by HTTP-01 and with EAB; `reset-certificate` tested against a temp root; `make check` green | S1 to S5 |
| **T2** Infra and installer | infra | `infra/ansible/roles/caddy/` (nine-plugin build, Caddyfile imports the snippet, first-install seeding of `/etc/portikus/certificate`, trust bundle per R14, port 80 and firewall for HTTP-01, on-demand ask target), the role that enables timers, `packaging/debian/templates`, `packaging/debian/config`, `packaging/scripts/postinst` | Fresh install seeds `internal`; an old `letsencrypt` preseed seeds ACME DNS-01 Cloudflare; a re-run leaves existing state alone; the TLS question is skipped at default priority; `make check` and infra lint green; bootstrap to smoke test on this host green | S2, S5 |
| **T3** API | builder | `apps/api/src/routes/admin-certificate.ts` and its tests, the on-demand ask endpoint, pre-flight, upload checks, status-to-notification logic in the worker or API (wherever the image page's `published.json` is read today), audit, root certificate download; `packages/contracts` additions beyond `certificate.ts` | Unit tests for: refusing a second job, writing the request file 0600 by rename, keeping stored secrets on blank fields, every upload check by name, pre-flight blocking for HTTP-01 and warning for DNS-01, the ask endpoint answering only for the site and `*.<preview suffix>`, notifications once per certificate per condition, audit rows without secrets, the download route admin-only; no secret in any response (asserted) | contract |
| **T4** Web | ui-designer | `apps/web/src/admin/` (Certificate tab, `tabs.ts`), its help text, `e2e/admin-certificate.spec.ts`, `e2e/certificate-jobs.ts` (fake job, like `e2e/image-jobs.ts`) | The tab shows the current certificate and expiry, the source form with write-only secret fields ("set" or "not set"), pre-flight results, Test only, Apply, Renew now, Roll back, job progress and scrubbed errors, root download; Playwright covers each flow with the fake job, a failed apply with the old certificate kept, a refused upload naming the failed check, and an axe scan of the tab with no violations | contract |
| **V** Pilot verification | infra | the pilot only; no repo files except fixes it hands back | Every step in "Pilot verification" below passes, with evidence in the report | T1 to T4 landed |
| **D** Docs draft | builder | `docs/adr/0046-*.md`, `docs/INSTALL.md`, `docs/OPERATIONS.md`, `docs/ADMIN-GUIDE.md` | ADR 0046 records R2, R3, R4, R7 and R8; INSTALL.md covers the new default and that setup never touches the certificate again; OPERATIONS.md covers `portikus reset-certificate`; ADMIN-GUIDE.md covers the tab | plan |
| **F** Fold | builder | `docs/SPEC.md` (20.1, 21.12, 22.4 sibling section, 24.8, 24.10, 24.11), `docs/STATUS.md`, `docs/BACKLOG.md` (email for #918, real HTTP-01 and EAB tests), delete this plan | Lasting rules folded in a sentence or two each; D's docs checked against the final code; STATUS written once from the task PR bodies; the plan is gone | V |

## Parallelism and file ownership

Todd approved wide parallelism with as few merge conflicts as possible, because conflicts serialize CI. The plan lands with S1 to S5 still open. The orchestrator sends spike findings straight to the builders, and the task that owns a file fixes it.

1. T1 to T4 and D start as soon as this plan merges; they need only the contract. After that, `packages/contracts/src/certificate.ts` and `packages/contracts/src/index.ts` belong to T3 alone. If the spike changes `DNS_PROVIDER_FIELDS`, T3 changes it. T1 mirrors the names in Python, with a test that reads the contract's table (or a shared JSON fixture owned by T3), so the two cannot drift.
2. Task D (docs draft, builder) writes `docs/adr/0046-*.md`, `docs/INSTALL.md`, `docs/OPERATIONS.md` (including `portikus reset-certificate`) and `docs/ADMIN-GUIDE.md` from the rulings during the build. No other task edits those four. F keeps only SPEC.md, STATUS.md and BACKLOG.md, deletes the plan, and checks D's docs against the final code with small edits.
3. Early reviews run as tasks merge: security-reviewer on T1 as soon as it lands, code-reviewer on each task as it lands, a11y-reviewer on T4. They are read-only. Each fix goes in a fix PR for the owning directory, never one that crosses directories.
4. One owner per path:

| Owner | Paths |
|---|---|
| T1 | `packaging/certificate/`, `packaging/systemd/portikus-certificate-*`, `packaging/bin/portikus`, `packaging/nfpm.yaml`, any CI workflow change for Pebble |
| T2 | `infra/ansible/**`, `packaging/debian/**`, `packaging/scripts/**` |
| T3 | `apps/api/**`, `packages/contracts/**`, `packages/db/**` (migration 0034 only if needed) |
| T4 | `apps/web/**`, `packages/ui/**` if needed, `e2e/admin-certificate.spec.ts`, `e2e/certificate-jobs.ts`, `playwright.config.ts` |
| D | `docs/adr/0046-*.md`, `docs/INSTALL.md`, `docs/OPERATIONS.md`, `docs/ADMIN-GUIDE.md` |
| V | `infra/tests/smoke-test.sh` |
| F | `docs/SPEC.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, this plan |

   A task that needs a change in another task's path asks the orchestrator instead of editing it. No task but F edits `docs/STATUS.md`.
5. One PR per task, plus at most one fix PR per directory. Merger lands them in the order T3, T1, T2, T4, D, so the contract's owner lands first.

## Pilot verification

Run by the infra agent on the pilot, from a worktree at the epic head, after a full deploy:

1. Staging DNS-01 wildcard with Cloudflare: Test only passes, then Apply with the staging directory issues for the site and `*.preview.pilot.portikus.thewhittakers.org`.
2. Pre-flight catches a wrong DNS record (a sample name pointed elsewhere) and says which name.
3. A bad Cloudflare token: Apply fails, the old certificate stays in use, the page shows a clear error with no token in it.
4. An invalid upload (a key that does not match) is refused, naming the failed check.
5. Roll back returns to the previous certificate.
6. `portikus reset-certificate` brings back a site made unreachable on purpose.
7. Production DNS-01 wildcard with Let's Encrypt, left as the final pilot state; the page shows the issuer and expiry.
8. No secret anywhere: grep for the token and the uploaded key in Caddy's autosave, `journalctl` for Caddy, the API and the job, every job directory, the audit table, and the agent's own output. The token is copied from `~/portikus_dns_token.txt` by file and never echoed.
9. Smoke test green.

HTTP-01 with on-demand previews and EAB are tested with Pebble only (A2, A4); the epic PR says so.
