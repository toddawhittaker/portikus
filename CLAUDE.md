# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Portikus is a browser-based agentic development workspace for students.
Keep this file short. Detail lives under `docs/` and is referenced by file
and section.

## Where things are documented

- `docs/OVERVIEW.md`: one-page orientation, architecture summary, and the
  design rules every change must respect. Read this first.
- `docs/VISION.md`: product intent. Wins on questions of intent.
- `docs/SPEC.md`: requirements. Wins on implementation detail. Section 29
  lists epics in order; section 30 lists milestone gates; section 24 is
  security.
- `docs/WORKFLOW.md`: branching (main and epic branches change only by
  pull request), CI, secret scanning, and the local pre-commit hook.
- `docs/DESIGN.md`: the visual design, with the design system and screen
  mockups mirrored under `design/`.
- `docs/STACK.md`: technology choices and why. Section 2 is the repo
  layout, section 34 the stack summary, section 35 what was rejected.

Before implementing any subsystem, read the SPEC.md and STACK.md sections
that cover it. Cite sections by number in prompts and reports.

## Current state

Epics 0 through 3.5 (SPEC.md section 29) have landed. Epic 0 is the pnpm
workspace monorepo with the apps and packages from STACK.md section 2,
Biome, Vitest, Playwright, a Makefile, and the decision records in
`docs/adr/`. Epic 1 is the reproducible platform VM under `infra/`:
host bootstrap, OpenTofu on libvirt, cloud-init, Ansible roles for the
firewall, LVM thin storage, Incus, and the workspace network, plus the
smoke test. Epic 2 is the Debian 13 workspace image built with
distrobuilder, the hardened workspace profile with nested Docker and
isolated ID mapping, persistent home and Docker volumes, and the interim
`workspace.sh` provisioning script. Epic 3 is the control-plane
workspace lifecycle: a workspace controller that talks to Incus over the
REST API on its unix socket and serves loopback HTTP behind a bearer
token, an API with workspace and presence routes (also loopback only), and
a worker that reconciles every second, is the only writer of workspace
state, and keeps the disconnect grace timer in a durable
`shutdown_deadline` column. The `contracts`, `config`, and `db` packages
now have real content, including Kysely and the database migrations.
Ansible gained `postgresql`, `node`, and `portikus` roles with three
systemd units, and the smoke test covers all four Epic 3 acceptance
criteria. Epic 3.5 packages the control plane as one versioned `portikus`
Debian package built by `nfpm` in CI (ADR 0007), which owns the service
users, `/etc/portikus`, `/var/lib/portikus`, and the three systemd units.
Ansible installs the newest published release, or the version or local
package named on the command line, and renders only the environment files
and the controller token, so the VM has no build toolchain and rolling back
means installing the previous package. Epic 4 is authentication and
authorization: login is the OIDC Authorization Code flow with PKCE (proof
key for code exchange) through `openid-client`, and a session is a row in
PostgreSQL behind an opaque HttpOnly cookie, named with the `__Host-`
prefix when the public URL is https. Roles are `student` and
`administrator`, mapped from the identity provider's group claims and
denied by default. Every API route and the WebSocket upgrade need a
session, the workspace owner comes from that session rather than the
request body, and one student asking for another student's workspace gets
a 404. The WebSocket at `/workspaces/:id/ws` is now the presence
mechanism, so the old HTTP connection and heartbeat routes are gone, and
administrators get one listing route. `packages/auth` also holds an
in-repo mock identity provider, shipped as a fourth systemd unit that stays
disabled unless Ansible's `portikus_mock_idp` is true (ADR 0008). A new
`caddy` Ansible role fronts the VM with an internally issued certificate at
`portikus.<vm-ip>.nip.io` and serves the web bundle, which the Debian
package now ships, and the smoke test logs in through the real redirect
flow.

Epic 5 is the workspace agent and terminal transport (ADR 0009).
`apps/workspace-agent` is a Fastify service using `node-pty` and tmux that
runs as the unprivileged `student` user inside each container and listens
on TCP 7400 on the workspace bridge. Each terminal is one tmux session,
`pk-<terminalId>`, and every attachment is its own PTY running `tmux
attach-session`, so tmux and not the browser socket owns the shell. The
agent authenticates a per-workspace bearer token that the worker mints on
every start and the controller pushes to `/etc/portikus/agent.token`
through the Incus files API; `start` then polls the agent's `/health` and
fails if it is not up within 15 seconds. The Debian package ships the agent
at `/usr/lib/portikus/workspace-agent`, the workspace profile bind-mounts
it read-only at `/opt/portikus/workspace-agent`, and the workspace image
runs its unit as `student`. The API adds terminal routes and a
byte-pipe WebSocket at `/workspaces/:id/terminals/:tid/ws` that forwards
frames without parsing them, applies backpressure in both directions,
serves the workspace owner only (an administrator gets a 404), and
re-checks the session about once a second. Terminal metadata lives in a
`terminals` table, and the worker sets `ended_at` when a workspace stops.
The web app gains a terminal page built on xterm.js with tabs, reconnect,
and link routing to the placeholder files and preview routes, which answer
501 until Epics 7 and 8; Caddy now sends browser document requests under
`/workspaces` to the single-page app while JSON and WebSocket routes still
go to the API. On the infrastructure side the `incus_network` role loads
`br_netfilter`, which is what makes the peer-isolation ACL rule take
effect, and the workspace nic filters IP and MAC addresses while the ACL
allows tcp/7400 from the gateway only. Tests are 17 Playwright cases
against a fake agent, a vitest file against the real agent (it needs tmux,
now installed in CI), and an Epic 5 block in the smoke test.

Epic 6 is the three-pane shell and project management (ADR 0010). The
design system is now built: `packages/ui` holds the tokens as a Tailwind
theme plus the primitives and overlays, and `apps/web` is the real shell,
with a project pane on the left, a tabbed work area in the middle, a
placeholder file pane on the right, and a status bar. Projects are
database rows mirroring `~/projects/<slug>`; all filesystem and Git work
runs in the workspace agent behind the existing token, and a listing
discovers repositories already on disk and flags a row whose directory is
gone. Create, clone, template, Initialize Git, rename (which moves the
directory and rewrites terminal working directories), duplicate, zip
download, and archive (a flag, the directory stays) are all there.
Terminals gained splits, tab reordering, a per-project saved layout in one
JSON column, closing the pane when the shell exits, and full clipboard
handling in the terminal. Templates are configuration
(`PROJECT_TEMPLATES`), and the platform still never makes a commit.
Workspace image `2026.09.3` adds `zip` for downloads.

Known gaps: from Epic 4, a real identity provider is not reachable from the
API yet, the real client secret travels through the environment until SOPS
is wired up, there is no admin UI beyond the one listing route, nothing
rate-limits login, and disabling a user means setting `users.disabled_at`
by hand in SQL. From Epic 5, the file and preview link targets are
placeholders until Epics 7 and 8; traffic between the API and the agent is
plaintext on the workspace bridge until Epic 12; the token file sits in a
directory the student owns, so containment relies on the Incus files API
resolving paths inside the instance; the eight-terminal cap has a benign
check-then-act race; and terminal rows (open plus the 20 most recent ended
per listing) are never pruned. From Epic 6, the 1024-wide rail collapse is
deferred, a clone shows no progress while it runs, a download has no size
cap, discovery ignores directories that are not repositories, unarchiving
is only reachable through the API, and right-click paste in Firefox depends
on the browser's own paste prompt. Epic 7 (files, Monaco, search, and
change review) is next.

## Commands

Prerequisites: the Node version in `.nvmrc`, and pnpm via
`corepack enable`. See docs/WORKFLOW.md, "Local development".

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | Install from the committed lockfile |
| `pnpm typecheck` | `tsc -b` over every project |
| `pnpm lint` / `pnpm lint:fix` | Biome check, and check with fixes applied |
| `pnpm format` | Rewrite files to the Biome format |
| `pnpm test` | Vitest, all projects |
| `pnpm build` | `tsc -b` plus the Vite build for `apps/web` |
| `pnpm test:e2e` | Playwright browser tests in `e2e/` |
| `pnpm dev` | Build, then run every app in watch mode |
| `make check` | typecheck, lint, test, build |

Deployment goes through Make: `make build-deb` builds the control-plane
Debian package and `make deploy-app` installs it on the VM.

`make help` lists the targets. Prefer the Make targets (STACK.md section
31); do not invent a deployment command when a Make target exists.

Layout: `apps/` holds the five processes, `e2e/` the Playwright tests, and
`docs/adr/` the decision records. The shared libraries under `packages/`:

| Package | Holds |
|---|---|
| `contracts` | Zod schemas for the workspace, terminal, controller, and agent APIs |
| `config` | Per-service `loadConfig`, which validates the environment at startup |
| `events` | Schemas for the WebSocket frames, including terminal input and output |
| `db` | PostgreSQL access: Kysely types, connections, migrations, test helpers |
| `auth` | OIDC login, sessions, authorization helpers, mock identity provider |
| `observability` | OpenTelemetry setup and the structured JSON logger |
| `ui` | Shared React components used by `apps/web` |

`contracts`, `config`, `db`, `auth`, and `events` have real content today;
`observability` and `ui` are placeholders waiting on their epic.

## How work gets done here

The main session is an orchestrator. Its job is to understand the request,
write good prompts, spawn subagents, and return to the user quickly. It
does not do the work itself unless the task is a one-line lookup or edit.

Agents live in `.claude/agents/`:

| Agent | Use for |
|---|---|
| explorer | Finding where things are. Cheap. Feed its report to other agents. |
| builder | Implementing a scoped change against a named SPEC.md section. |
| tester | Designing tests that pin SPEC.md invariants, then running them. |
| security-reviewer | Read-only review against SPEC.md section 24 trust boundaries. |
| code-reviewer | Read-only review for correctness, then YAGNI/KISS/DRY/SOLID quality, on app and infra code. |
| infra | Anything under `infra/`: OpenTofu, Ansible, cloud-init, Incus, images. |

Orchestration rules:

- Run independent agents in parallel. Never let two agents edit the same
  files; split by package or directory and merge in the main session.
- A good prompt names the SPEC.md and STACK.md sections, the files or
  package in scope, what done looks like, and what to leave alone.
- Run explorer first when the location of something is unknown, then pass
  its paths to the stronger agent instead of making that agent search.
- Send anything touching auth, the preview gateway, the workspace agent,
  file APIs, Incus, or nested Docker through security-reviewer before it
  is called done.
- Run code-reviewer over the epic branch before the PR that merges an
  epic into main, and fix or explicitly defer every finding it requires.
- When agents disagree, the orchestrator arbitrates. Read the spec section
  in dispute and decide; do not bounce the conflict back and forth between
  agents. If the spec does not settle it, bring the two positions and a
  recommendation to the user. Whatever the ruling, say so in the report.
- Relay agent reports to the user in plain English. The user does not see
  agent output directly.
- Default effort is low. Raise it for one task, not globally, when a task
  needs sustained reasoning. Use high for intensive debugging.

## Design defaults

- Build only what was asked. No options, abstractions, or files for needs
  nobody has today.
- Prefer boring, mature technology with explicit interfaces over framework
  magic (STACK.md, "Purpose"). Use what is already in the repo before
  adding a dependency, and say why if you add one.
- Pin exact dependency versions and commit the lockfile.
- Never write code that commits, branches, tags, or stashes in a user's Git
  repository on the platform's behalf (SPEC.md section 12.5).
