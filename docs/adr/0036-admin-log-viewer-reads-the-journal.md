# 0036. The admin Logs tab reads the journal through journalctl

- **Status**: Accepted
- **Date**: 2026-09-26
- **References**: STACK.md section 15, SPEC.md sections 24.11 and 25.6, ADR 0012, issue #476

## Context

ADR 0012 left logs in journald with no viewer: diagnosing a failure meant a
shell on the VM and a `journalctl` command. Administrators asked for the
platform's errors and warnings on the admin page (#476). The journal holds
lines from every service on the VM, not only Portikus, and a log line can
carry values that must never reach a browser.

## Decision

The API serves `GET /admin/logs` (one page of lines, newest first) and
`GET /admin/logs/counts` (error and warn lines per time bucket), both for
administrators only. Reading logs is not audited, like reading the audit log.

- **Access.** `portikus-api.service` has `SupplementaryGroups=systemd-journal`.
  The group goes to the API process only, not to the `portikus` user, so the
  worker does not get it, and it ships in the package rather than through an
  Ansible `usermod`.
- **How the journal is read.** The API spawns `JOURNALCTL_PATH` (default
  `/usr/bin/journalctl`) with an argument array and no shell. The arguments
  are JSON output limited to `MESSAGE`, `_SYSTEMD_UNIT` and
  `__REALTIME_TIMESTAMP`; the three units `portikus-api.service`,
  `portikus-worker.service` and `portikus-controller.service`, always passed
  by the API; `--since` and `--until` as epoch seconds the server computed from
  validated dates; `--after-cursor` with a cursor that matched journald's
  syntax; and `--grep` built only from a fixed map of level names. Text, user
  and workspace filters run in the API after parsing, so request text never
  reaches an argument.
- **Limits.** One request reads at most 20,000 entries or 5 seconds, then
  kills `journalctl` and answers with what it found, a cursor to continue, and
  `scanComplete: false`. At most two `journalctl` processes run at once; a
  third request gets 429 `RATE_LIMITED`. A missing, failing or refused
  `journalctl` gives 503 `LOGS_UNAVAILABLE`.
- **Only Portikus JSON lines.** A `MESSAGE` that is not a JSON object with
  string `level`, `service` and `time` is skipped and counted. systemd's start
  and stop lines and raw stack traces stay a `journalctl` job on the VM.
- **Redaction.** `packages/observability` keeps one list of sensitive key
  names. The logger's pino redaction paths are built from it, and
  `redactLine` uses it to replace those keys' values at any depth with
  `"[redacted]"` and to cut strings over 2,000 characters. The API redacts
  every line before filtering or sending it, and sends only the parsed
  message, the service, the journal time and the cursor.
- **Counts.** The API keeps error and warn counts per minute for 7 days in
  memory, filled by reading error, warn and fatal lines forward from the last
  cursor it read, under the same limits. Until a read has reached the end,
  `complete` is false.

## Consequences

An administrator can find a failure from the browser. The cost is that a
compromised API process can read the whole system journal, including Dex's
and Caddy's lines. That is accepted because the API already holds the
database, the session secret and the agent tokens. Log counts start again
from the journal after every API restart, and the first requests after a
restart may report `complete: false` while they catch up. Lines that are not
Portikus JSON, and the workspace agents' logs inside containers, are not
shown.
