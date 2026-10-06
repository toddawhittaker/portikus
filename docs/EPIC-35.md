# Epic 35: Admin notification settings and root shell

This plan lives only on the epic branch (WORKFLOW.md, "Epic plans"). The
fold task (T9) moves its lasting rules into SPEC.md and deletes it. The
design comes from the architect's report of 2026-10-05, made against
base commit `c866c1c9` (main after Epic 34). The lasting decisions are
in ADR 0051 (root shell) and ADR 0052 (notification settings).

## Goal

Two admin features that both let the admin page ask root to change the
host:

- **Notification settings.** Administrators set alert channels from the
  Settings tab instead of `secrets.yaml`: Pushover and the generic
  webhook as today, plus email, ntfy and Microsoft Teams. Certificate
  notices are already site alerts, so they reach email with no new code.
- **Root shell.** Administrators open root shells on the server from a
  new admin tab, in panes with the same split and drag layout as the
  workspace terminals.

It serves SPEC.md sections 20.1, 20.3, 24.1, 24.8, 24.11, 24.13 and
25.6, and STACK.md sections 15 and 34.

## Rulings

Todd, 2026-10-05, on the root shell. These override the requirements
listed in issue #1063.

1. No second factor, no host-enrolled code and no password prompt. Any
   signed-in administrator can open a root shell.
2. No per-administrator or site-wide shell limits, and no idle timeout
   or hard cap beyond the existing session rules. Sign-out, role loss, a
   disabled account and the 12-hour provider-role limit still end
   shells. Administrators can run tmux themselves.
3. Several root shells in panes, with the same split and drag layout as
   the workspace terminals. No reconnect and no platform tmux: closing
   the socket ends the shell.
4. No address-range restriction.
5. On by default for administrators. An operator turns it off with
   `portikus_root_shell: false` in `portikus.yaml`; then the socket unit
   is not enabled and the tab is hidden.

Kept from #1063: a privileged helper outside the API (the API never runs
as root), audit rows for open, close and duration but never contents
(ADR 0012), journal lines from the helper, and a banner.

Todd, later on 2026-10-05: the alert when a root shell opens is a
setting, **off by default**. It is one flat boolean in `notify.json`
v1, `rootShellOpenedAlert`, shown as a checkbox in the Notifications
section. When on, the API sends a warning-tone site alert through
`notifyAdministrators` on each open, titled with the administrator's
name. When off, the record is the audit rows and the helper's and PAM's
journal lines.

Orchestrator rulings, accepting the architect's recommendations:

- Root-shell sockets count toward the existing 60 terminal sockets per
  user. systemd's default of 64 connections on the socket stays.
- The shell is a PAM sign-in session (`login -f root`) and behaves like
  SSH.
- Channels to add: email (SMTP), ntfy and Microsoft Teams.
- SMTP uses ports 587 (STARTTLS) and 465 (TLS) only, with TLS required.
- Alert email recipients are an explicit list in the settings file.
- The page may set any alert host name, with an audit row and a notice
  to every administrator on each change.
- Two epics: this one, then Epic 36 (hardening, appendix). Disk
  encryption at rest is a separate later epic.

## Tasks

No migrations. New state lives in root-owned files, the existing
`audit_events` table, or API memory.

| Task | Delivers | Owns | Contract changes | Wave | Size | Reviewers |
|---|---|---|---|---|---|---|
| T1 | This plan, ADRs 0051 and 0052, BACKLOG and STACK section 35 edits | `docs/EPIC-35.md`, `docs/adr/0051-root-shell.md`, `docs/adr/0052-notification-settings.md`, `docs/adr/README.md`, `docs/BACKLOG.md`, `docs/STACK.md` section 35 | Pins the helper socket protocol and `notify.json` v1 | First, alone | S | security-reviewer on both ADRs before code |
| T2 | Notification file schema and the new senders (email, ntfy, Teams) | `packages/contracts/src/notify.ts` (new), `packages/contracts/src/alerts.ts`, `packages/contracts/src/index.ts`, `packages/observability/src/alerts.ts` and tests, `packages/observability/package.json` (adds `nodemailer` at an exact version), `packages/observability/src/redact.ts` | `NotifyFile` v1; `AlertChannelResult.channel` gains `email`, `ntfy`, `teams`; settings view and update schemas; `rootShellOpenedAlert` (default `false`); shared reader `readNotifyFile(path)` (a missing file reads as all off) | A | M | code-reviewer |
| T6 | Root-shell helper, units and setup switch | `packaging/root-shell/` (new Python helper and `tests/`), `packaging/systemd/portikus-root-shell.socket` and `portikus-root-shell@.service`, `infra/ansible/roles/portikus/tasks/root_shell.yml` (new) and its include in `roles/portikus/tasks/main.yml`, `portikus_root_shell: true` in `infra/ansible/site.yml`, `roles/portikus/templates/api.env.j2` (`ROOT_SHELL_SOCKET`), `packaging/nfpm.yaml`, `packaging/scripts/prerm` (stop the socket and its instances), the per-shell process-id files under `/run/portikus-root-shell/`, the helper's handling of the `end` frame, the `portikus-root-shell` group and its `SupplementaryGroups=` line in `packaging/systemd/portikus-api.service` | The helper socket protocol of ADR 0051 | A | M | security-reviewer; verified on a real host (PAM login, logind scope, SIGHUP on close, the administrator's tmux survives, the on and off switch, nothing the shell writes reaches `journalctl -u 'portikus-root-shell@*'`) before its PR. Must fix review findings 4, 5, 6, 8 and 11 first |
| T8a | Generalize the pane layout with behaviour unchanged. Already in progress as its own task. | new `apps/web/src/layout/SplitTree.tsx`, `apps/web/src/work/usePaneDrag.ts`, `apps/web/src/terminal/PaneFrame.tsx`, `apps/web/src/terminal/useXterm.ts`; edits `TerminalGroup.tsx`, `TerminalLeaf.tsx`, `TerminalPane.tsx`, `apps/web/src/work/WorkArea.tsx` and their tests | none | A (no ADR dependency) | L | code-reviewer, a11y-reviewer; existing terminal unit and e2e tests pass unchanged |
| T3 | Root alerts job, Squid include, seeding of `notify.json` from `secrets.yaml` or `alerts.env`, backups carry `notify.json`. Keeps `alerts.env` and its unit lines working, so alerts keep working until T4 lands | `packaging/alerts/` (new `alerts-job` and `tests/`), `packaging/systemd/portikus-alerts-job.path` and `.service`, `infra/ansible/roles/egress_proxy/templates/squid.conf.j2`, `roles/portikus/tasks/alerts_settings.yml` (rewritten), the `packaging/scripts/prerm` lines that disable `portikus-alerts-job.path` on removal (as for `portikus-image-job.path`; T6 edits `prerm` in an earlier wave), the `portikus-notify` group lines in `packaging/systemd/portikus-api.service`, `portikus-worker.service` and `portikus-alert@.service`, the `alert` verbs in `packaging/bin/portikus`, `packaging/nfpm.yaml`, `infra/host/portikus-backup-export` and the restore script | Installed file `/etc/portikus/notify.json`; folder `/etc/portikus/egress-proxy.d/`. The job validates and writes `rootShellOpenedAlert`; seeding writes `false` | B, after T6 (shared `nfpm.yaml`, `main.yml`, `site.yml`) | L | security-reviewer; real-host verify. Must fix review findings 3, 7, 9, 12, 13 and 14 first (shared with T4) |
| T7 | Root-shell API | `packages/contracts/src/root-shell.ts` (new) and its export line, `apps/api/src/root-shell/` (new: socket client, frame codec, pipe with session re-check), `apps/api/src/routes/admin-root-shell.ts`, its entries in `apps/api/src/security/route-policy.ts` and route registration, `ROOT_SHELL_SOCKET` and `NOTIFY_FILE` (default `/etc/portikus/notify.json`) in `packages/config/src/index.ts`, `e2e/fake-root-shell-server.mjs` (echo and resize, not root), its environment in `playwright.config.ts`. On each open it reads `rootShellOpenedAlert` with `readNotifyFile` and, when true, calls `notifyAdministrators` (unit tests for both states) | `GET /admin/root-shell` (`{enabled}`); WebSocket `/admin/root-shell/ws?cols=&rows=`; audit actions `admin.root_shell_opened`, `admin.root_shell_closed` | B, after T2 (shared contracts index) | M | security-reviewer. Must fix review findings 1, 2, 10 and 15 first. Copies the pipe pattern from `terminal-pipe.ts` but must not edit it (T10 owns it); adds the role check and tests demotion, disabling, sign-out and the 12-hour limit |
| T4 | Notification settings in the API and worker | `apps/api/src/alerts/` (new: request file, job status), `apps/api/src/routes/admin-alerts.ts`, its route-policy entries and registration, `apps/worker/src/alerts.ts`, `apps/worker/src/alert-command.ts`, `packages/config/src/index.ts` (drop `ALERT_*`; reuse `NOTIFY_FILE`), removal of `alerts.env` (`roles/portikus/templates/alerts.env.j2` deleted, its lines dropped from the units and from `alerts_settings.yml`), the notification environment in `playwright.config.ts`. Carries `rootShellOpenedAlert` in the view and the PUT, with the same audit row as other changes | `GET /admin/notifications`, `PUT /admin/notifications` (both carry `rootShellOpenedAlert`), job status, `POST /admin/alerts/test` with optional `channel` | C, after T3 and T7 (shared route policy, registration, config, `playwright.config.ts`) | M | security-reviewer (write-only secrets). Must fix review findings 3, 7, 9, 12, 13 and 14 first (shared with T3) |
| T10 | Workspace terminals get the same fix for the window after a client is revoked: close the upstream first, drop further input, then `terminate()` the browser socket | `apps/api/src/workspaces/terminal-pipe.ts` and its tests only | none | A | S | security-reviewer |
| T8b | Root-shell tab | `apps/web/src/admin/root-shell/` (new: area, leaf, `rootShellSocket.ts`, banner), `apps/web/src/admin/tabs.ts`, `AdminNav.tsx`, `AdminPage.tsx`, `e2e/admin-root-shell.spec.ts`, an a11y spec | none | C, after T7 and T8a | M | a11y-reviewer, security-reviewer |
| T5 | Notifications section in Settings | `apps/web/src/admin/notifications/` (new), `apps/web/src/admin/AlertsSection.tsx` (deleted), its import line in `SettingsTab.tsx`, `e2e/admin-notifications.spec.ts` (replaces `e2e/admin-alerts.spec.ts`), an a11y spec, `e2e/notify-jobs.ts` (fake job runner), `e2e/ports.ts` (fake SMTP and ntfy receivers). Includes the "Alert when a root shell opens" checkbox, off by default, saved through T4's PUT, with an e2e test that it saves and reloads | none | After T4 (may be written alongside T4 against T2's contracts) | M | a11y-reviewer |
| T9 | Fold | SPEC sections 20.1, 20.3, 24.1, 24.8, 24.11 (new audit events), 25.6 and a section 29 entry; STACK sections 15 and 34; `docs/INSTALL.md` (alerts on the page; root shell on by default and turned on by upgrades); `docs/ADMIN-GUIDE.md`; `docs/OPERATIONS.md` (root shell, "run upgrades inside tmux"); `apps/web/src/help/content/admin.tsx`; `docs/STATUS.md`; delete this plan | - | Last | S-M | code-reviewer |

The "review findings" numbers refer to the security review of this plan
and ADRs 0051 and 0052 (PR #1176); the ADRs now state each fix.

Order: T1 alone. Then T2, T6, T8a and T10 in parallel, since their files do
not overlap. Then T3 and T7 in parallel. Then T4 and T8b in parallel.
Then T5, then T9. No two tasks in one wave edit the same file. Task pull
requests put their STATUS line in the pull request body; only T9 edits
STATUS.md and SPEC.md.

Epic-level reviews after all tasks: code-reviewer (including dead code
across the repo), security-reviewer (root shell, root jobs, egress
proxy, secrets) and a11y-reviewer (`apps/web`).

## Reuse

Builders must use these instead of writing their own.

Alerts and notifications:

- `packages/observability/src/alerts.ts`: `sendAlert`, `post()` (its
  errors never carry a URL or secret) and `webhookBody`. Each new
  channel is a plain function here.
- `packages/observability/src/outbound-fetch.ts`: `createOutboundFetch`,
  the proxy-aware fetch.
- `apps/worker/src/alerts.ts` (`AlertGate` flood control and the
  forwarder), `apps/worker/src/alert-command.ts`, `alert-main.ts`, and
  `packaging/systemd/portikus-alert@.service`.
- `packages/db/src/index.ts`: `notifyAdministrators` (always sets
  `site_alert`) and `recordAudit`; also
  `apps/api/src/notifications/notify-once.ts`.
- `apps/api/src/certificate/notices.ts`: certificate expiry and renewal
  failure are already site alerts, so email gets them. T4 adds a test
  that proves it.
- `packages/observability/src/redact.ts` `SENSITIVE_KEYS`: add the new
  secret field names. Log only channel kinds, never the settings object.

Root jobs and helpers:

- The request-file pattern: `apps/api/src/job-files.ts` (`readJson`,
  `currentJob`, `listDir`), `apps/api/src/certificate/`, and
  `apps/api/src/routes/admin-certificate.ts` (write-only secrets shown
  as "set").
- The Python root job pattern: `packaging/certificate/certificate-job`,
  `packaging/certificate/tests/helpers.py`, and
  `packaging/systemd/portikus-certificate-job.path` and `.service`.
- Validation rules to port into `alerts-job`:
  `infra/ansible/roles/portikus/tasks/alerts_settings.yml`.
- Squid layout: `infra/ansible/roles/egress_proxy/templates/squid.conf.j2`.
  The include goes after `http_access deny portikus_private` and before
  `http_access deny all`.
- A per-connection root socket: `packaging/systemd/portikus-backup-key.socket`
  and `portikus-backup-key@.service`; the verb protocol and journal
  logging in `packaging/backup/backup-key`.

Root shell, server side:

- `apps/api/src/workspaces/terminal-pipe.ts`: the once-a-second session
  re-check (`loadSession`, `sessionGate`), the back-pressure constants,
  and `safeCloseCode`.
- `apps/api/src/workspaces/socket-slots.ts` (`createSocketSlots`) and
  the `terminalSockets` slots in `apps/api/src/routes/terminals.ts`;
  root-shell sockets count there.
- The WebSocket origin check in `packages/auth/src/plugin.ts`.
- The client address from `request.ip`, correct through `trustProxy` in
  `apps/api/src/server.ts`.
- The SPEC.md section 9.7 frames in `packages/events` (`ClientMessage`,
  `TerminalServerMessage`) and `CloseCode` in `packages/contracts`.

Root shell, web side:

- `apps/web/src/layout/tree.ts` (split, move, resize and close on
  `ProjectLayout`; a pane id goes in the leaf's `terminalId`).
- `createLayoutStore()` in `apps/web/src/layout/store.ts`.
- `apps/web/src/work/dropZone.ts`, `moveInto.ts` and `pointerDismiss.ts`.
- `@portikus/ui` (`Tabs`, `PaneHandle`, `tabDomId`, `tabPanelDomId`),
  `react-resizable-panels` and `@dnd-kit/core`.
- `apps/web/src/terminal/terminalFrames.ts`, `terminalClipboard.ts` and
  `terminal.css`.
- `ProjectLayout` and `MAX_SPLIT_DEPTH` in `packages/contracts`, with no
  contract change.
- Not reused: `useLayoutPersistence` and `apps/web/src/layout/local.ts`
  (a reload ends root shells, so no layout is saved), and
  `openTerminalSocket` (it reconnects).

Admin UI: `apps/web/src/admin/AdminSection.tsx` (`AdminGroup`),
`JobLog.tsx`, `DraftFields.tsx` and the `@portikus/ui` fields.

Tests: `e2e/fake-backup-key-server.mjs` and `e2e/backup-key.ts` (a fake
root socket), `e2e/certificate-jobs.ts` (a fake job runner),
`e2e/admin-alerts.spec.ts` (a fake webhook receiver), `e2e/ports.ts`,
and `apps/api/src/security/route-policy.ts` with its
`authz-matrix.test.ts`, `ws-authz-matrix.test.ts` and
`audit-coverage.test.ts`.

## Choices in brief

- **C1, who may open a root shell.** Any administrator whose session
  passes the existing checks and the WebSocket origin check. The helper
  relies only on the socket's permissions, `root:portikus` 0660.
- **C2, helper and transport.** A per-connection Python helper behind a
  systemd socket, one process per pane, running `login -f root`. The
  frame protocol is pinned in ADR 0051.
- **C3, on by default.** `portikus_root_shell` in `portikus.yaml`,
  default true. When false, setup disables the socket and leaves
  `ROOT_SHELL_SOCKET` empty; the API refuses and the tab hides. Upgrades
  turn it on for existing sites.
- **C3a, limits, alerts and audit.** No root-shell-specific limit; the
  socket backstops stay. The open alert is the `rootShellOpenedAlert`
  setting, off by default, read on each open. Audit rows record open
  and close, never contents. Anything that restarts the API ends every
  root shell, so upgrades should run inside tmux.
- **C3b, pane layout.** Extract the split, drag, pane frame and xterm
  setup from the workspace terminals (T8a) rather than copy about 160
  lines. The root-shell area uses its own socket that never reconnects
  and saves no layout.
- **C4, where notification settings live.** The versioned file
  `/etc/portikus/notify.json` (ADR 0052), not the database and not
  `alerts.env`.
- **C5, how the API reaches alert hosts.** A Squid include folder,
  `/etc/portikus/egress-proxy.d/`, where the alerts job alone writes
  `alerts.conf`.
- **C6, channels.** At most one of each kind. Email through
  `nodemailer`, ntfy, and Teams; Slack, Discord, Google Chat and
  Mattermost through the existing webhook.
- **C7, where the page goes.** A Notifications group in the Settings
  tab, replacing `AlertsSection`. A channel is tested after it is saved,
  because Squid must allow its host first.
- **C8, agent versions in the image rebuild (#1145).** Use the pinned
  versions; moved to Epic 36 (H4).

## Left out

- Changing the site's address (#935): it touches Dex, Caddy, LTI,
  cookies and certificates, and needs its own epic.
- Other settings in the admin UI: the sign-in provider, LTI platforms
  and extra API egress hosts (later, reusing the include folder), the
  off-site backup target, workspace outbound mail, storage and cache
  sizes, and session and workspace defaults.
- Root-shell layout saved across reloads, reconnect, recording of
  contents, and any limit beyond the existing session rules (ruled out).
- Several channels of one kind, per-channel tone filters, Gotify and
  Matrix.
- Email for password resets and invitations: the settings file leaves
  room for it; nothing is built.
- Passkey at link confirmation (#1165), removing the `names_v4` upgrade
  code, domain fronting, and incident response (#920): not requested.
- LTI grade passback (rejected, STACK.md section 35) and provider
  sign-out on shared computers (#1144, an accepted risk): only BACKLOG
  changes, made in T1.

## Appendix: Epic 36, Internet hardening (outline)

Migration **0040** is reserved for H8. Reviewers are in brackets.

| Task | Delivers | Size |
|---|---|---|
| H1 | An offline breached-password list: the SecLists top-1M list (MIT licence, approved by Todd 2026-10-05), filtered to passwords of 15 or more characters, with the generated file and its generator script committed [security] | S-M |
| H2 | A per-address limit on routes without a session, about 600 requests a minute per address, an IPv6 /64 counted as one address, answering 429 (SPEC.md section 24.13). High enough for a class launching from one campus address [security] | S |
| H3 | Refuse Caddy's internal certificate authority on a public address unless overridden; `portikus reset-certificate` still works [security] | S |
| H4 | Pinned coding-agent versions in the admin image rebuild (C8, #1145) [code] | S |
| H5 | API-side alert sources: workspaces hitting outbound limits, and an error spike [code] | S-M |
| H6 | The rest of #1138: a test per restore mode, and coding-agent logins kept out of recovery points. Making the Dex CI job required is Todd's ruleset change [code] | S |
| H7 | Residual risks: an expired passkey challenge not counted as a wrong try, a cap on kept notices per person, a full content security policy on API-written pages, a quota check in the off-site prune script [security] | M |
| H8 | Sign-in and second-factor counters in PostgreSQL (migration 0040), and a recovery code that bypasses the per-account lockout. Approved by Todd 2026-10-05; runs after H7 [security] | M |
| H9 | Help on invitations and CSV upload (#1155), the link page's empty status line (#1166), and "Session ended" giving the 12-hour reason (#1156) [a11y] | S |
| H10 | Fold | S |

Accepted as is: Dex sign-in names that are not ASCII are refused, and
that stays an accepted risk. Disk encryption at rest (#1142) is its own
later epic; the recommended shape is LUKS on the data volumes only,
unlocked after boot over SSH with `sudo portikus unlock`.
