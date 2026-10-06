# 0052. Notification settings are set from the admin page and kept in a root-owned file

- **Status**: Accepted (Epic 35)
- **Date**: 2026-10-05
- **References**: SPEC.md sections 24.8, 24.11, 25.6; STACK.md section 15; ADRs 0027, 0030, 0046, 0051; issue #918

## Context

Alert channels (Pushover and a generic webhook) are set only in
`secrets.yaml` and applied by setup. Administrators want to set them,
plus email, ntfy and Microsoft Teams, from the admin page, without
Ansible and without restarting services.

## Decision

1. **One file.** Settings live in `/etc/portikus/notify.json`, owned by
   root, mode 0640, group `portikus-notify`, which the API and worker
   units join through `SupplementaryGroups=` (`portikus alert` gets the group through `systemd-run`).
   It is read at each send, so a change needs no restart. It is not in
   the database, so the alert for a failed unit still works when
   PostgreSQL is down. Format version 1:

   ```json
   {
     "version": 1,
     "smtp": { "host": "smtp.example.edu", "port": 587,
               "username": "", "password": "",
               "from": "Portikus <portikus@example.edu>" },
     "alerts": {
       "email":    { "to": ["ops@example.edu"] },
       "pushover": { "userKey": "", "appToken": "" },
       "webhook":  { "url": "https://..." },
       "ntfy":     { "url": "https://ntfy.sh/<topic>", "token": "" },
       "teams":    { "url": "https://..." }
     },
     "rootShellOpenedAlert": false
   }
   ```

   `smtp` and each of the five alert channels may be `null`, meaning
   off. `alerts.email` requires `smtp`. SMTP (Simple Mail Transfer
   Protocol) sits apart from the alert channels because invitation and
   password-reset email may reuse it later. A missing file reads as
   everything off.
2. **One event switch.** `rootShellOpenedAlert` is a flat boolean,
   default `false`; a missing key reads as `false`. When true, the API
   sends a site alert each time a root shell opens (ADR 0051). It is a
   top-level key, not an `events` object, because it is the only one.
3. **Who owns the file.** The page owns it after its first save, as for
   the certificate (ADR 0046). Setup creates it only when it is missing,
   from the `portikus_alert_*` keys in `secrets.yaml` or the old
   `alerts.env`, then deletes `alerts.env`. Setup writes
   `rootShellOpenedAlert: false`. Backups carry the file.
4. **A root job applies changes**, following ADR 0030:
   `portikus-alerts-job.path` and `.service`, Python standard library.
   The API writes a request file with mode 0600. The job deletes the
   request file first, whatever the outcome, as in ADR 0046, and reads
   it the way the certificate job does: `O_NOFOLLOW`, a regular file
   only, and a size cap. It checks every field again, then writes
   `notify.json` atomically with mode 0640 and group `portikus-notify`.
   It writes `/etc/portikus/egress-proxy.d/alerts.conf`, runs
   `squid -k parse` against the new configuration before swapping it in,
   reloads Squid, and writes a status file holding only channel kinds,
   host names and fixed codes.
5. **A Squid include folder.** Squid's configuration includes
   `/etc/portikus/egress-proxy.d/*.conf`, after both the IP-literal deny
   and the private-address deny, and before `deny all`. Each owner
   writes its own file; the alerts job alone writes `alerts.conf`, and
   setup always writes it, empty if need be, so the include
   always finds its file. Ansible no longer derives alert hosts. The page may
   set any alert host name, within these rules:
   - Host names follow the label rule ported from
     `infra/ansible/roles/portikus/tasks/alerts_settings.yml`: no leading
     or trailing dot, not all digits, at most 253 characters.
   - Ports are bound to the channel kind: the SMTP host gets its one
     port, 587 or 465, and every other host gets 443 only.
   - Only CONNECT is allowed.
   - Webhook, ntfy and Teams URLs must start with `https://`.
6. **Channels**, at most one of each kind:
   - Pushover and the generic webhook, as today. The webhook's body
     carries `text`, so it also serves Slack, Mattermost, Rocket.Chat,
     Google Chat, Discord (through its Slack-compatible URL ending in
     `/slack`) and Zulip.
   - Email through `nodemailer`, sent through Squid's CONNECT proxy.
     SMTP uses port 587 with STARTTLS or port 465 with TLS (Transport
     Layer Security) only. TLS is required and certificates are
     verified. Recipients are the explicit `alerts.email.to` list, at
     most ten. Errors become short codes, never the server's text.
     nodemailer runs with `logger: false` and `debug: false`.
   - ntfy: a POST of the text to the topic URL with `Title`, `Priority`
     and `Tags` headers and an optional bearer token. ntfy.sh and a
     self-hosted server both work.
   - Microsoft Teams: an Adaptive Card posted to a Teams Workflows
     webhook URL.
7. **Secrets are write-only.** The secret fields are `smtp.password`,
   the Pushover `userKey` and `appToken`, the webhook URL, the Teams
   URL, the ntfy URL and the ntfy token. The API and the page show each
   only as its host name (for URLs) plus "set" or "not set". A secret
   never appears in a log, an audit row, a status file or a process
   argument. When `smtp.host`, `smtp.port` or `smtp.username` changes,
   the stored password is cleared unless a new one comes in the same
   request; when the ntfy URL's host changes, the stored token is
   cleared. The root job enforces both, so a changed host never receives
   an old secret. Each change writes a
   `settings.notifications_updated` audit row (changed kinds and hosts,
   no secrets) and notifies every administrator.

## Consequences

- A compromised API can widen its own outbound reach to any alert host.
  This is accepted: it already reaches the internet through any
  workspace in open mode, and each change is audited and announced.
- Once the page has saved settings, a setup run no longer changes them.
  INSTALL.md says so.
- Certificate expiry and renewal-failure notices are already site
  alerts, so they reach email with no new code.

## Rejected

- Storing the settings in the database: it fails when PostgreSQL is
  down.
- Keeping `alerts.env` and restarting services: a restart drops every
  socket, and env-file quoting is fragile for SMTP passwords.
- A fixed host list per service: SMTP hosts are always site-specific.
- Gotify (wants a `message` field) and Matrix (needs a token and a
  PUT).
- Several channels of one kind, and per-channel tone filters.
