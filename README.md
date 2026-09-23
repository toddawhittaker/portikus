<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/system/assets/Logos/portikus-wordmark-paper.svg">
  <img alt="Portikus" src="design/system/assets/Logos/portikus-wordmark-ink.svg" width="360">
</picture>

Portikus is a browser-based development workspace for students learning
agentic software development. Each student gets a real Linux workspace with
Git, Docker, terminals, and coding agents, reached through an ordinary web
browser.

## Why it exists

Coding agents let people with little programming experience build useful
software, but the development environment around them is still a barrier. A
student's own laptop means installing runtimes, package managers, Docker, and
agent command-line tools, and then debugging whatever is specific to that
machine before any learning happens.

Portikus removes that setup friction without replacing the tools themselves.
The guiding principle from `docs/VISION.md` is to simplify access to the
development environment without simplifying the development environment
itself: real Git, real Docker, real shells, real agent CLIs. An instructor
also needs to see and manage student workspaces, so administration, quotas,
and lifecycle control are part of the platform rather than an afterthought.

## What it looks like

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/shell-dark.png">
  <img alt="The Portikus workspace: a project list on the left, two split terminals in the middle, and the files pane on the right" src="docs/images/shell.png" width="900">
</picture>

The three-pane shell: projects on the left, a tabbed work area in the middle
holding two split terminals in the `weather-cli` project, and the files pane
on the right. The header shows the workspace state and the signed-in user;
the status bar shows the current directory and how to leave the terminal.

## How it works

One Debian platform VM runs on KVM/libvirt. Inside it, Incus runs one
unprivileged LXC system container per user, with Docker nested inside that
container. The VM also runs PostgreSQL, the control plane, and Caddy, which
terminates HTTPS in front of everything and serves the web bundle. Login is
the OpenID Connect authorization code flow with PKCE (proof key for code
exchange); a session is a row in PostgreSQL behind an opaque cookie.

| Process | What it does |
|---|---|
| `apps/web` | The browser UI: three panes, terminals, projects |
| `apps/api` | Fastify HTTP and WebSocket API; auth, projects, terminals. Loopback only, reached through Caddy |
| `apps/worker` | The only writer of workspace state; reconciles every second and owns the disconnect shutdown timer |
| `apps/workspace-controller` | The only process that talks to Incus |
| `apps/workspace-agent` | Runs inside each user container as the unprivileged `student` user: PTYs via tmux, files, Git |

Coding agents such as Claude Code and Codex run as ordinary processes in the
student's own terminals, on the same files the UI shows. The platform never
commits, branches, tags, or stashes in a student's Git repository.

`docs/OVERVIEW.md` has the full architecture and the design rules every
change must respect.

## Status

Epics 0 through 12a have landed and run on the pilot VM. Epic 12b, sign-in
through Dex and pilot readiness, is the last epic before the pilot.

`docs/STATUS.md` records what each epic delivered and the gaps it left.

## Running it locally

You need Node.js at the major version in `.nvmrc`, pnpm through corepack, and
Docker for a throwaway PostgreSQL.

```sh
nvm install && nvm use
corepack enable
git config core.hooksPath .githooks   # once per clone
pnpm install --frozen-lockfile
cp .env.example .env                  # .env is git-ignored; never commit it
make check                            # typecheck, lint, test with coverage, build, infra-check
```

The database-backed test suites (`db`, `api`, `auth`, and `worker`) need a
real PostgreSQL. Without `TEST_DATABASE_URL` they skip; to run them, start a
throwaway instance and export the URL:

```sh
docker run --rm -d --name portikus-test-pg \
  -e POSTGRES_PASSWORD=portikus -e POSTGRES_DB=portikus_test \
  -p 55432:5432 postgres:17
export TEST_DATABASE_URL=postgres://postgres:portikus@127.0.0.1:55432/portikus_test
```

Then `pnpm dev` runs every app in watch mode (API on port 3000, web on 5173)
and `pnpm test:e2e` runs the Playwright browser tests. Logging in uses the
mock identity provider in `packages/auth`.

`docs/WORKFLOW.md`, section "Local development", has the rest: the mock
provider's accounts, the Playwright browser install, gitleaks for the
pre-commit hook, and the tools `make infra-check` needs.

## Deploying

The platform is a reproducible VM built from `infra/`: host bootstrap,
OpenTofu on libvirt, cloud-init, and Ansible roles for the firewall, storage,
Incus, network, PostgreSQL, Caddy, and the application. The control plane
ships as one versioned Debian package, so an upgrade is a package install and
a rollback is installing the previous version.

`make help` lists the targets. See
[infra/README.md](infra/README.md) and [docs/WORKFLOW.md](docs/WORKFLOW.md).
Running the pilot day to day (deploys, users, backups, restore, routine
checks) is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Repository layout

| Directory | Holds |
|---|---|
| [`apps/`](apps) | The five processes: web, api, worker, workspace-controller, workspace-agent |
| [`packages/`](packages) | Shared libraries: contracts, config, events, db, auth, observability, ui |
| [`e2e/`](e2e) | Playwright browser tests |
| [`infra/`](infra) | Host bootstrap, OpenTofu, cloud-init, Ansible, workspace image, smoke tests |
| [`packaging/`](packaging) | The nfpm configuration and maintainer scripts for the Debian package |
| [`design/`](design) | The design system and screen mockups |
| [`docs/`](docs) | Vision, spec, stack, design, workflow, status |
| [`docs/adr/`](docs/adr) | Decision records, one per significant choice |

## Documentation

| Document | What it is |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | One-page orientation and the design rules. Read this first |
| [docs/VISION.md](docs/VISION.md) | Product intent; wins on questions of intent |
| [docs/SPEC.md](docs/SPEC.md) | Requirements; wins on implementation detail |
| [docs/STACK.md](docs/STACK.md) | Technology choices and why, plus what was rejected |
| [docs/DESIGN.md](docs/DESIGN.md) | The visual design, mirrored under `design/` |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Branching, review, CI, secret scanning |
| [docs/STATUS.md](docs/STATUS.md) | What has landed and what gaps remain |
| [docs/adr/](docs/adr) | Decision records |

Licensed under the [MIT License](LICENSE).
