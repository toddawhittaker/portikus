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
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/student-shell-dark.png">
  <img alt="The Portikus workspace: a project list on the left, two terminals in the middle, and the project's files and Git changes on the right" src="docs/images/student-shell.png" width="900">
</picture>

A student's workspace. Projects are on the left. The middle holds tabs; here
one tab is split into two terminals in the `weather-cli` project, one
running the tests and one running a development server. The files pane on
the right shows the project's folders, the Git state of each file, and the
changes waiting to be committed. The status bar shows the Git branch,
memory and disk use, and the workspace's state.

<img alt="The editor with a Markdown file and its preview side by side" src="docs/images/student-editor.png" width="900">

The editor saves as you type, and a Markdown file shows its preview beside
the source.

<img alt="A web app previewed inside Portikus, with the Running list of listening ports on the right" src="docs/images/student-running-preview.png" width="900">

A web app the student is running, previewed in a tab. Only the student can
open it, after signing in.

<img alt="The administration Users tab with one student's workspace panel open" src="docs/images/admin-users.png" width="900">

Administrators find a person on the Users tab and act on their workspace
from its panel: start, stop, rebuild, restore, change storage and limits.

The [student guide](docs/STUDENT-GUIDE.md) and the
[administrator guide](docs/ADMIN-GUIDE.md) walk through the rest, with more
screenshots. The same help is built into Portikus on its Help page.

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

Every epic through Epic 25 has landed, including Epic 15, which makes `apt
install portikus` the way to install (docs/INSTALL.md, SPEC.md section
21.12). The project's pilot, at
https://pilot.portikus.thewhittakers.org:8443 on the maintainer's LAN, is
installed and upgraded with apt like any other server.

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

## Installing

To run Portikus for a class, get a Debian 13 x86-64 server (bare metal or
a full virtual machine, from any provider or your own hardware).
[docs/HOSTING.md](docs/HOSTING.md) says what size of server suits a class.

Add the signing key, check it, and add the package repository:

```
sudo apt update
sudo apt install -y curl gpg
sudo curl -fsSL -o /usr/share/keyrings/portikus-archive-keyring.gpg https://toddawhittaker.github.io/portikus/apt/portikus-archive-keyring.gpg
test "$(gpg --show-keys --with-colons /usr/share/keyrings/portikus-archive-keyring.gpg | awk -F: '$1=="fpr"{print $10}')" = 9F6FD4CD5CC5C43AB5125705015D38802EF8D0F4 && echo "Key OK"
```

Continue only if it printed `Key OK`. Then:

```
echo "deb [signed-by=/usr/share/keyrings/portikus-archive-keyring.gpg] https://toddawhittaker.github.io/portikus/apt trixie main" | sudo tee /etc/apt/sources.list.d/portikus.list
sudo apt update
sudo apt install portikus
```

A few text screens ask for the web address, the administrator's email, how
people sign in, and where to keep student files:

![The sign-in screen, offering local accounts only, Microsoft Entra ID, Google Workspace, LDAP or Active Directory, or another OpenID Connect provider](docs/images/install/06-sign-in.png)

The site starts with Portikus's own certificate authority; an
administrator chooses the real HTTPS certificate on the Admin page.

When apt finishes, setup runs in the background for about ten minutes and
then you sign in as the administrator at your web address.
[docs/INSTALL.md](docs/INSTALL.md) walks through every step.

## Deploying for development

The project's own VMs are built from `infra/`: host bootstrap, OpenTofu on
libvirt, and cloud-init. The rehearsal VM and unreleased builds are then
configured from a workstation with the same Ansible roles the package runs
on a server. The pilot's VM is installed with apt instead, like any other
server. The control plane ships as one versioned Debian package, so an
upgrade is a package install and a rollback is installing the previous
version.

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
| [docs/STUDENT-GUIDE.md](docs/STUDENT-GUIDE.md) | How to use a workspace, for students |
| [docs/INSTALL.md](docs/INSTALL.md) | How to install Portikus on a Debian 13 server |
| [docs/ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) | How to run Portikus for a course, for administrators and instructors |
| [docs/VISION.md](docs/VISION.md) | Product intent; wins on questions of intent |
| [docs/SPEC.md](docs/SPEC.md) | Requirements; wins on implementation detail |
| [docs/STACK.md](docs/STACK.md) | Technology choices and why, plus what was rejected |
| [docs/DESIGN.md](docs/DESIGN.md) | The visual design, mirrored under `design/` |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | The operator's runbook for the pilot and the rehearsal VM |
| [docs/HOSTING.md](docs/HOSTING.md) | Choosing a server to rent |
| [docs/CAPACITY.md](docs/CAPACITY.md) | Load test results and sizing |
| [docs/BROWSER-HANDLING.md](docs/BROWSER-HANDLING.md) | Application preview and CLI browser requests |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Branching, review, CI, secret scanning |
| [docs/HOW-WE-WORK.md](docs/HOW-WE-WORK.md) | A plain-English guide to working with AI agents here |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Wanted work that is not yet planned |
| [docs/STATUS.md](docs/STATUS.md) | What has landed and what gaps remain |
| [docs/adr/](docs/adr) | Decision records |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and
[SECURITY.md](SECURITY.md) to report a vulnerability privately. Everyone
taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Licensed under the [MIT License](LICENSE).
