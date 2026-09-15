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

Epic 0 (SPEC.md section 29) has landed the scaffolding: a pnpm workspace
monorepo with the apps and packages from STACK.md section 2, Biome, Vitest,
Playwright, a Makefile, and the architecture decision records in
`docs/adr/`. Every package is a real but near-empty TypeScript package with
one test. No subsystem behaviour is implemented yet; Epic 1 is next.

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

`make help` lists the targets. Prefer the Make targets (STACK.md section
31); do not invent a deployment command when a Make target exists.

Layout: `apps/` holds the five processes, `e2e/` the Playwright tests, and
`docs/adr/` the decision records. The shared libraries under `packages/`:

| Package | Holds |
|---|---|
| `contracts` | Zod schemas for every HTTP and event payload |
| `config` | `loadConfig`, which validates the environment at startup |
| `events` | Schemas for the WebSocket and cross-process event streams |
| `db` | PostgreSQL access: Kysely, connections, migrations |
| `auth` | OIDC login, sessions, and authorization helpers |
| `observability` | OpenTelemetry setup and the structured JSON logger |
| `ui` | Shared React components used by `apps/web` |

Only `contracts` and `config` have real content today; the rest are
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
