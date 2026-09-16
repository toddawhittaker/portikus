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
means installing the previous package. Epic 4
(authentication and authorization) is next.

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
| `contracts` | Zod schemas for the workspace API and the controller API |
| `config` | Per-service `loadConfig`, which validates the environment at startup |
| `events` | Schemas for the WebSocket and cross-process event streams |
| `db` | PostgreSQL access: Kysely types, connections, migrations, test helpers |
| `auth` | OIDC login, sessions, and authorization helpers |
| `observability` | OpenTelemetry setup and the structured JSON logger |
| `ui` | Shared React components used by `apps/web` |

`contracts`, `config`, and `db` have real content today; the rest are
placeholders waiting on their epic.

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
