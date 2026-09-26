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
| [0036](0036-admin-log-viewer-reads-the-journal.md) | The admin Logs tab reads the journal through `journalctl` with fixed arguments, limits and redaction (accepted, Epic 19) |
