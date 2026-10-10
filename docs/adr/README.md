# Architecture decision records

An architecture decision record (ADR) is a short note about one decision that
shapes the system: what we chose, why, and what it costs. We keep them so that
a new engineer or agent can find the reasoning behind a choice without reading
the whole history of the repository.

## Format

One file per decision, named `NNNN-short-title.md`, numbered in the order the
records are written. Copy `0000-template.md` to start a new one. Each record
has four sections:

- **Status**: Proposed, Accepted, Superseded by NNNN, or Deprecated.
- **Context**: the situation that forced a choice.
- **Decision**: what we decided, in the present tense.
- **Consequences**: what this makes easy and what it makes hard.

## Rules

- Keep a record under 40 lines. If it needs more, it is a document, not an ADR.
- Cite the `docs/SPEC.md` and `docs/STACK.md` sections the decision serves.
  Those files remain authoritative; an ADR records the decision, it does not
  replace the specification.
- Records are immutable once accepted. To change a decision, write a new record
  and mark the old one "Superseded by NNNN".

## Records

| Record | Decision |
|---|---|
| [0001](0001-typescript-monorepo-with-pnpm.md) | TypeScript monorepo managed with pnpm |
| [0002](0002-biome-over-eslint-and-prettier.md) | Biome instead of ESLint plus Prettier |
| [0003](0003-zod-contracts-with-generated-openapi.md) | Zod schemas are the single source of API contracts |
| [0004](0004-distrobuilder-from-source.md) | Build distrobuilder from source |
| [0005](0005-incus-rest-over-unix-socket.md) | Incus REST API over unix socket |
| [0006](0006-lifecycle-reconciler-on-postgres.md) | Lifecycle reconciler on Postgres |
| [0007](0007-debian-package-for-control-plane.md) | Debian package for the control plane |
| [0008](0008-server-side-sessions-and-mock-idp.md) | Server-side sessions and an in-repo mock identity provider |
| [0009](0009-workspace-agent-transport.md) | Workspace agent transport and terminal model |
| [0010](0010-project-operations-in-the-agent.md) | Project operations run in the workspace agent |
| [0011](0011-runtime-settings-in-postgres.md) | Runtime settings live in Postgres |
| [0012](0012-structured-logging.md) | Structured logging with pino and a runtime log level |
| [0013](0013-file-api-in-the-workspace-agent.md) | The file API lives in the workspace agent, with conditional writes |
| [0014](0014-filesystem-events-over-a-per-project-websocket.md) | Filesystem events over a per-project WebSocket |
| [0015](0015-editor-stack.md) | Editor stack: bundled Monaco and react-markdown (in force again: 0017 was reversed) |
| [0016](0016-automatic-task-merges-with-epic-level-review.md) | Automatic task merges with epic-level review |
| [0017](0017-rich-markdown-editor.md) | Rich Markdown editing with MDXEditor (reversed by issue #218) |
| [0018](0018-preview-deployment-shape-upstream-and-iframe-policy.md) | Preview deployment shape, Caddy upstream resolution, and iframe policy |
| [0019](0019-session-baseline.md) | Session baseline is a dangling git stash object |
| [0020](0020-recovery-archives-on-a-recovery-volume.md) | Recovery archives live on a recovery volume, made by the workspace agent |
| [0021](0021-workspace-maintenance-operations.md) | Reset Docker and Rebuild are pending operations the worker drives |
| [0022](0022-operational-metrics-in-postgres.md) | Operational metrics live in PostgreSQL, not OpenTelemetry |
| [0024](0024-backups-pulled-to-host.md) | Backups are pulled to the host and encrypted there with age |
| [0025](0025-lti-launch.md) | LTI 1.3 launch: state row and per-login cookie, file-registered platforms, and the instructor role |
| [0026](0026-account-links-and-role-grant.md) | Linking a course account to an SSO account, and a stored role grant (accepted) |
| [0027](0027-egress-by-hostname-through-a-forward-proxy.md) | API egress by hostname through a Squid forward proxy (accepted, Epic 14) |
| [0028](0028-dex-storage-and-first-administrator.md) | Dex accounts in PostgreSQL, managed from the admin area, and a setup code for the first administrator (accepted, Epic 14; first-administrator part superseded by 0031) |
| [0029](0029-ansible-roles-in-the-package.md) | `apt install portikus` ships the Ansible roles and runs them locally (proposed, Epic 15) |
| [0030](0030-workspace-image-jobs.md) | Workspace image jobs run in a path-activated root unit (proposed, Epic 15) |
| [0031](0031-dex-is-the-only-front-door.md) | Dex is the only sign-in front door, with a local administrator made at install (accepted, not yet built) |
| [0032](0032-resource-guard.md) | The resource guard: time-slice CPU throttle set through Incus, rolling averages remembered across restarts, and one ordered gate list (accepted, Epic 14.3) |
| [0033](0033-notifications-on-the-server-by-polling.md) | Notifications live on the server, and browsers poll for them (accepted, Epic 14.3) |
| [0034](0034-platform-resilience.md) | Platform resilience: restarts, priority, background stops, cached preview checks and a fail-fast storage pool (accepted, Epic 17) |
| [0035](0035-terminals-in-their-own-unit.md) | Terminals run in their own systemd unit, and the agent's negative OOM score was dropped (accepted, Epic 16) |
| [0036](0036-admin-log-viewer-reads-the-journal.md) | The admin Logs tab reads the journal through `journalctl` with fixed arguments, limits and redaction (accepted, Epic 19) |
| [0037](0037-admin-process-list-through-incus.md) | The administrator reads processes from the host through the worker and stops them through the agent (accepted, Epic 21) |
| [0038](0038-workspace-egress-allow-list.md) | Workspace egress allow-list: our own resolver, a root-owned table, and Squid by name (accepted, Epic 24) |
| [0039](0039-backup-channel-and-host-held-key.md) | Backup requests reach the host through a polling channel, and the host holds the restore key (accepted, Epic 24) |
| [0040](0040-restore-one-workspace-and-replace-home.md) | Restoring one workspace into a side copy, and replacing a home (accepted, Epic 24) |
| [0041](0041-https-upstreams-in-the-preview-gateway.md) | HTTPS upstreams in the preview gateway (accepted, Epic 24) |
| [0042](0042-package-survey.md) | The package survey and the reinstall note (accepted, Epic 24) |
| [0043](0043-blocked-sites-in-open-mode.md) | Blocked sites in open mode (accepted, Epic 24) |
| [0044](0044-backups-on-the-server.md) | An apt-installed server backs itself up, keeps its key, and hands the key over through a root socket (accepted, Epic 15) |
| [0045](0045-shared-docker-pull-storage.md) | Shared Docker pull storage: a pull-through cache and LVM-thin seed snapshots (accepted, Epic 26) |
| [0046](0046-certificates-from-the-admin-page.md) | Certificates from the admin page: Caddy as the only ACME client, a root job, and staging before live (accepted, Epic 27) |
| [0047](0047-modals-hide-late-content-and-monaco-auto.md) | Modals re-hide late page content with aria-hidden, and Monaco's accessibility support is "auto" (accepted, Epic 33) |
| [0048](0048-second-factor-inside-portikus.md) | The second factor is built inside Portikus, not in Dex (accepted, Epic 34) |
| [0049](0049-invitation-only-admission.md) | Only an invitation admits an SSO account, matched per provider (accepted, Epic 34) |
| [0050](0050-write-only-off-site-copy.md) | The off-site copy is pushed with a write-only key and pruned by the target (accepted, Epic 34) |
| [0051](0051-root-shell.md) | Administrators get a root shell in the admin area through a root helper behind a socket (accepted, Epic 35) |
| [0052](0052-notification-settings.md) | Notification settings are set from the admin page and kept in a root-owned file (accepted, Epic 35) |
| [0053](0053-signin-counters-in-postgresql.md) | Sign-in counters live in PostgreSQL, and a recovery code or passkey gets past the account lockout (accepted, Epic 36) |
| [0054](0054-offline-breached-password-list.md) | Breached passwords are checked against an offline list from SecLists (accepted, Epic 36) |
| [0055](0055-voice-input-web-speech.md) | Voice input uses the browser's Web Speech API, hold to talk only (accepted, Epic 39) |
| [0056](0056-shared-coding-agents.md) | Claude Code and Codex live in a shared read-only folder, updated by the root image job (accepted, Epic 40) |
| [0057](0057-instructor-visibility.md) | Instructors see a project only when the student shares it, and see agent usage as counts (proposed, Epic 42) |
| [0058](0058-lti-roster-and-deep-linking.md) | LTI roster sync through NRPS, and Deep Linking to a template or public repository (proposed, Epic 42) |
