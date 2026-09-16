# Portikus Overview

A one-page orientation for humans and agents. The authoritative sources are
`docs/VISION.md` (product intent), `docs/SPEC.md` (implementation
requirements), and `docs/STACK.md` (technology choices). This page
summarizes them so a reader knows where to look.

## Current state

Epics 0 through 4 in SPEC.md section 29 have landed: the pnpm workspace
monorepo, the reproducible platform VM under `infra/`, the Debian 13
workspace image, and the control-plane workspace lifecycle. Workspaces are
now created, started, and stopped by the control plane rather than by hand:
the workspace controller talks to Incus over the REST API on its unix
socket, the API records intent and browser presence, and the worker
reconciles every second and owns the 10-minute disconnect timer. The
workspace agent, the terminals, and the preview gateway are still unbuilt,
and the web UI is a single page rather than the three-pane workspace.
Epic 3.5 packaged the control plane as one
versioned `portikus` Debian package (ADR 0007) that owns the service users,
`/etc/portikus`, `/var/lib/portikus`, and the three systemd units, and
Ansible installs the newest published release, or the release named by
`PORTIKUS_VERSION` when rolling back, and renders only the environment files
and the controller token. Epic 4 has landed too: students and
administrators log in through OpenID Connect with the Authorization Code
flow and PKCE (proof key for code exchange), a session is a revocable row
in PostgreSQL behind an opaque HttpOnly cookie, roles come from group
claims and are denied by default, and every API route and the WebSocket
upgrade require a session with the workspace owner taken from it. The
WebSocket at `/workspaces/:id/ws` replaced the old HTTP presence routes. A
Caddy Ansible role now fronts the VM with an internally issued certificate
and serves the web bundle, and an in-repo mock identity provider in
`packages/auth` ships as a systemd unit that is disabled unless Ansible is
told otherwise (ADR 0008).

Known gaps after Epic 4: a real identity provider is not reachable from the
API yet, because the units allow loopback traffic only; the real client
secret travels through the environment until SOPS is wired up; there is no
admin UI beyond one listing route; nothing rate-limits login; and disabling
a user means setting `users.disabled_at` by hand in SQL.

Epic 5 (workspace agent and terminal transport) is next. Gate A in
SPEC.md section 30 (architecture proof) must pass before substantial UI
polish.

## Planned architecture

```
Pop!_OS host  ->  KVM/libvirt  ->  Debian platform VM  ->  Incus
   VM runs: control plane, PostgreSQL, Caddy reverse proxy / preview gateway
   Incus runs one unprivileged LXC system container per user, with Docker nested inside
```

Components, each a separate trust zone (SPEC.md section 24.1):

- **Control plane** (`apps/api`): Fastify, reached through Caddy rather
  than directly; it listens on loopback only. OIDC auth, authorization,
  project metadata, UI layout state, audit, recovery metadata. SPEC.md
  section 2.8, STACK.md section 4.
- **Worker** (`apps/worker`): owns delayed shutdown, provisioning,
  rebuilds, and recovery-point creation. Lifecycle timers must survive a
  control-plane restart, so they live in the database, never in memory.
  Today it is a one-second reconcile loop over PostgreSQL (ADR 0006); a job
  queue arrives when rebuild and recovery work needs retries. STACK.md
  section 7.
- **Workspace controller** (`apps/workspace-controller`): the only process
  that talks to Incus. STACK.md section 9.
- **Workspace agent** (`apps/workspace-agent`): runs inside each user
  container. PTYs, filesystem watching, file operations, Git status, port
  discovery. It is not a coding agent. SPEC.md section 2.6, STACK.md
  section 10.
- **Preview gateway**: Caddy plus per-request authorization, on a separate
  browser origin. It is configuration rather than a TypeScript app, so it
  lives in the `caddy` Ansible role under `infra/`. Epic 4 added that role
  to put the control plane behind HTTPS; the per-request authorization for
  previews arrives with the preview epic. SPEC.md section 14, STACK.md
  section 12.
- **Browser UI** (`apps/web`): three panes. Project list, tabbed work
  surfaces (xterm.js terminals, Monaco, Markdown, preview), live file tree
  with Git decorations. SPEC.md section 8.

Coding agents (Claude Code, Codex) run as ordinary processes in user-visible
terminals inside the workspace, on the same files the UI shows.

## Rules that shape every design decision

- **Real tools, not simulations.** Real Git, Docker, shells, and agent CLIs.
  A project is a directory under `~/projects/<slug>`; a preview is a running
  TCP service. VISION.md, "Design principles".
- **Student code is untrusted**, including agent-generated code. Previews
  never share the control plane's origin or cookies. No unauthenticated
  public preview mode. SPEC.md sections 24.2, 24.3, 14.3.
- **Never touch Git automatically.** Recovery points are compressed
  archives (`tar.zst` initially, SPEC.md section 15.3) stored outside the
  working tree. No hidden commits, branches, tags, or stashes. Displayed
  Git status is real Git status. SPEC.md sections 12.2, 12.5, 15.
- **Persistent data, ephemeral processes.** Files, Git, dotfiles, Docker
  state, and UI layout survive a stop. Processes do not. A workspace stops
  10 minutes after the last browser disconnects. Terminal processes outlive
  the WebSocket during that grace period (tmux). No CRIU, no hibernation.
  SPEC.md section 6.
- **Infrastructure is cattle.** VM, Incus config, images, and services are
  rebuildable from automation under `infra/`. User data is not cattle and
  lives on separate volumes. SPEC.md section 21, STACK.md Part II.
- **Isolate provider-specific code.** Incus, LVM thin storage, the OIDC
  provider, preview routing, recovery storage, and agent launch definitions
  each sit behind an interface. P0 implements only an Incus provider.
  SPEC.md section 25.7, STACK.md section 32.
- **Server-side authorization only**, denied by default. HTTP APIs carry an
  OpenAPI schema generated from Zod. Live events go over WebSocket.
  SPEC.md sections 5.2, 27; STACK.md section 5.
- **Errors in user terms first**, technical detail kept for admins.
  SPEC.md section 28.
- **Priorities:** unlabeled spec requirements are P0 (pilot). P1 is
  post-pilot, P2 is future. The student experience is a profile over a
  shared core, not a separate product. SPEC.md section 3.
