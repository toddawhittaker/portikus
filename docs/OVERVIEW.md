# Portikus Overview

A one-page orientation for humans and agents. The authoritative sources are
`docs/VISION.md` (product intent), `docs/SPEC.md` (implementation
requirements), and `docs/STACK.md` (technology choices). This page
summarizes them so a reader knows where to look.

## Current state

`docs/STATUS.md` records what each epic and task has delivered and the
gaps each one left. Epics 0 through 6 plus the live grace period and
structured logging have landed. Epic 7 (files, Monaco, search, and change
review) is finished on its epic branch and waiting to be merged; it is not
yet deployed to the pilot VM.

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
