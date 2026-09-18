# Portikus Technology Stack

**Status:** Draft technical stack  
**Audience:** Humans and software-development agents  
**Related documents:** `VISION.md`, `SPEC.md`, `OVERVIEW.md` (all under `docs/`)

## Purpose

This document defines the preferred technology stack for **Portikus**, including both the application and the infrastructure used to run it.

The stack is intentionally conservative. Portikus is an infrastructure-adjacent, security-sensitive, browser-based development environment with long-lived WebSocket connections, PTYs, file-system events, nested containers, authenticated application previews, and a control plane that manages user workspaces.

The primary goals of the stack are:

- strong end-to-end type safety;
- easy reasoning for a small engineering team and coding agents;
- minimal operational dependencies;
- mature libraries for terminals, WebSockets, OIDC, and Linux integration;
- explicit privilege separation;
- reproducible infrastructure;
- portable deployment;
- clear boundaries between platform infrastructure and runtime student resources;
- low dependency and tooling overhead;
- straightforward testing.

The default rule is:

> Prefer boring, mature technology with explicit interfaces over framework magic.

# Part I — Application stack

## 1. Language and runtime

### TypeScript end to end

Portikus should use **TypeScript** for the browser application, control-plane services, workers, workspace controller, and the initial workspace agent.

Use TypeScript in strict mode.

The main reason is not simply reuse of one programming language. Portikus has a large number of shared contracts crossing process boundaries:

- workspace lifecycle events;
- terminal events;
- filesystem events;
- Git status;
- preview metadata;
- project metadata;
- recovery-point metadata;
- quota/resource data;
- coding-agent session state;
- WebSocket messages;
- API request/response schemas.

Keeping these contracts in one strongly typed ecosystem allows schema changes to propagate through the browser, server, controller, and workspace agent with compile-time feedback.

For a small, AI-assisted engineering team, this reduces cognitive boundaries and makes refactoring safer.

### Node.js

Use the current **Node.js LTS** release.

Do not target Bun or Deno for production P0.

Reasons:

- excellent support for TypeScript tooling;
- proven compatibility with `node-pty`;
- mature WebSocket libraries;
- mature OIDC support;
- broad OpenTelemetry support;
- predictable Debian deployment;
- strong compatibility with native modules;
- coding agents and developer tooling already assume Node availability;
- low operational surprise.

The exact Node LTS version should be pinned in the repository and workspace image.

## 2. Repository model

Use a **pnpm workspace monorepo**.

Recommended structure:

```text
portikus/
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   ├── workspace-controller/
│   └── workspace-agent/   # Fastify service that runs inside each workspace
│
├── packages/
│   ├── contracts/
│   ├── db/
│   ├── auth/
│   ├── events/
│   ├── config/
│   ├── observability/
│   └── ui/
│
├── infra/
│   ├── host/
│   ├── tofu/
│   ├── cloud-init/
│   ├── ansible/
│   ├── workspace-image/
│   ├── caddy/
│   ├── secrets/
│   └── tests/
│
├── docs/
│   ├── OVERVIEW.md
│   ├── VISION.md
│   ├── SPEC.md
│   └── STACK.md
├── CLAUDE.md
├── package.json
├── pnpm-workspace.yaml
└── Makefile
```

All five apps hold real code. `apps/workspace-agent` is built and shipped
with the control plane but does not run on the platform VM: the Debian
package installs it and the workspace profile bind-mounts it into each
container, where it runs as the `student` user (section 10, ADR 0009).

A monorepo allows:

- one TypeScript version;
- one dependency policy;
- one lint/format configuration;
- one test toolchain;
- shared schemas;
- atomic changes across server/client/agent boundaries;
- easier AI-assisted repository navigation.

Do not split Portikus into multiple repositories during P0 unless there is a concrete operational requirement.

## 3. Frontend

### React

Use **React** for the browser application.

Portikus behaves more like a browser-hosted desktop application than a conventional content website. The application contains:

- persistent panes;
- tabs;
- terminals;
- file trees;
- editor surfaces;
- diff views;
- previews;
- drag/drop;
- split layouts;
- live WebSocket state.

React is a strong fit for this model and has excellent ecosystem support for Monaco, xterm.js, TanStack Query, and accessible component primitives.

### Vite

Use **Vite** for frontend development and production builds.

Do **not** use Next.js for P0.

Portikus does not require:

- server-side rendering;
- SEO;
- static site generation;
- React Server Components;
- route-level server rendering.

Next.js would introduce deployment and runtime machinery without helping with Portikus's difficult problems.

### Router

Use **TanStack Router**.

Reasons:

- strongly typed routes;
- good TypeScript ergonomics;
- suitable for a complex SPA;
- explicit route/search parameter behavior.

React Router is acceptable if there is a concrete implementation reason to prefer it, but TanStack Router is the default choice.

### Server-state management

Use **TanStack Query**.

Use it for server-owned state such as:

- workspace status;
- projects;
- Git state;
- changes;
- recovery points;
- quotas;
- preview metadata;
- admin data.

Do not duplicate server state into a client-only state store unless there is a specific reason.

### Local UI state

Use **Zustand** for ephemeral browser/UI state such as:

- active tabs;
- selected files;
- pane widths;
- expanded tree nodes;
- drag/drop state;
- split geometry;
- temporary UI preferences.

Important layout state should be persisted to the control plane periodically, but Zustand remains the local interaction store.

### Styling and UI primitives

Use:

- **Tailwind CSS** for styling;
- accessible headless primitives such as **Radix UI** or equivalent;
- optionally shadcn-style composition patterns.

Do not build custom accessible primitives for dialogs, menus, tabs, popovers, and similar controls when mature accessible primitives already exist.

### Editor

Use **Monaco Editor**.

Supported uses include:

- text editing;
- configuration files;
- Markdown;
- `.env`;
- source files;
- diff/change review.

Use Monaco Diff Editor for file diffs.

Do not attempt to reproduce the complete VS Code extension system.

### Markdown rendering

Use **react-markdown** with **remark-gfm** and **remark-frontmatter** for the
rendered preview of SPEC.md section 13.4. It builds React elements directly
rather than producing an HTML string, and raw HTML is off unless `rehype-raw`
is added, which it is not. Markdown in a project may have been written by a
coding agent, so it is untrusted content; not rendering HTML at all is a
smaller promise to keep than sanitizing it correctly. Front matter is split
off and shown as a collapsed block. ADR 0015.

### Terminal

Use **xterm.js** in the browser.

The browser terminal is a view onto an actual PTY inside the student's workspace.

xterm.js must not own the server process lifetime.

### Dragging and layout

Use a mature drag/drop library such as **dnd-kit** for tab/pane rearrangement.

Use a mature resizable-panel implementation rather than writing split-pane resizing from scratch.

## 4. Backend API

### Fastify

Use **Fastify** for the primary HTTP/WebSocket application API.

Reasons:

- strong TypeScript support;
- low framework overhead;
- mature plugin ecosystem;
- schema-oriented design;
- good WebSocket support;
- easy OpenAPI integration;
- suitable for a small team without introducing NestJS-style ceremony.

The API should manage:

- authentication/session state;
- authorization;
- project metadata;
- saved UI state;
- recovery metadata;
- quota metadata;
- workspace lifecycle requests;
- preview authorization decisions;
- admin operations;
- API/event coordination.

The API process should **not** hold direct administrative control over Incus.

## 5. API contracts and validation

### Zod

Use **Zod** as the primary runtime-schema and TypeScript contract library.

Schemas should define:

- HTTP request/response bodies;
- WebSocket/event payloads;
- workspace-agent protocol messages;
- controller requests/responses;
- configuration objects;
- important persisted JSON fields.

Where practical, schemas should be defined once and reused across:

```text
browser
  ↕
API
  ↕
workspace-controller
  ↕
workspace-agent
```

### OpenAPI

The HTTP API must expose an **OpenAPI** specification.

Prefer a Zod-to-OpenAPI integration compatible with Fastify.

OpenAPI is required because Portikus may eventually have:

- a CLI;
- instructor tooling;
- non-TypeScript clients;
- external integrations;
- additional workspace providers.

Do not use tRPC as the primary external API contract.

tRPC may feel convenient in a TypeScript-only system, but it unnecessarily couples service boundaries to TypeScript function calls.

### REST vs WebSocket

Use **REST/HTTP** for durable resource operations:

```text
POST /workspaces/:id/start
POST /workspaces/:id/stop
POST /projects
GET  /projects/:id/changes
POST /projects/:id/recovery-points
```

Use **WebSockets** for continuous event streams:

- terminal I/O;
- workspace lifecycle updates;
- filesystem events;
- Git-state changes;
- listening-port changes;
- agent-session events.

Do not introduce GraphQL.

## 6. Database

### PostgreSQL

Use **PostgreSQL** as the primary persistent application database.

Expected data includes:

- users;
- roles;
- workspaces;
- projects;
- layouts;
- terminal metadata;
- preview metadata;
- recovery-point metadata;
- audit events;
- agent-session metadata;
- lifecycle jobs;
- configuration/version metadata.

PostgreSQL should be the only required stateful application service in the pilot if practical.

### Query layer

Use **Kysely** as the default query layer.

Reasons:

- strongly typed SQL;
- small runtime footprint;
- no heavy runtime engine;
- SQL remains visible and understandable;
- good fit for coding agents;
- easy to reason about migrations and query behavior.

Drizzle is an acceptable alternative if its stable release line is preferred at implementation time.

The important requirement is to avoid a heavy ORM abstraction that obscures SQL or introduces a large runtime engine.

### Migrations

Database schema migrations must be:

- source controlled;
- forward-applicable through deployment automation;
- tested in CI;
- compatible with backup/restore procedures.

## 7. Background jobs

Use **pg-boss** or a similar PostgreSQL-backed durable job queue.

Initial jobs include:

- delayed workspace shutdown;
- workspace provisioning;
- workspace rebuild;
- recovery-point creation;
- recovery retention cleanup;
- image-related maintenance;
- retryable lifecycle operations.

Example:

```text
last browser disconnect
        ↓
enqueue stop-workspace in 10 minutes
        ↓
student reconnects?
   yes → cancel job
   no  → execute stop
```

Do not use in-memory timers for lifecycle behavior that must survive a control-plane restart.

Do not introduce Redis in P0 solely for jobs or timers.

Redis may be introduced later if concrete scale or latency requirements justify it.

### Runtime settings

A value an administrator changes while the platform runs is a database row, not an environment variable. The disconnect grace period is the first of these: it lives in a single `settings` row, with an optional per-user override, and the worker reads it on every sweep. The environment variable of the same name only seeds that row on the worker's first start, so a restart never overwrites what an administrator set. See ADR 0011.

## 8. Authentication

Use **OIDC Authorization Code Flow** with a mature library such as `openid-client`.

The browser should not store institutional OAuth access tokens when this can be avoided.

Preferred model:

```text
Browser
   ↓
Portikus API
   ↓
OIDC provider
   ↓
Portikus server session
   ↓
secure HttpOnly cookie
```

The authentication implementation must remain provider-neutral enough to support:

- Microsoft Entra ID;
- institutional OIDC;
- Okta;
- Keycloak;
- LDAP-backed OIDC gateways.

Avoid Passport unless a future requirement makes its abstraction useful.

## 9. Workspace controller

The **workspace controller** is a separate trusted service/process.

Its job is to broker privileged lifecycle operations against Incus.

Conceptual API:

```text
createWorkspace()
startWorkspace()
stopWorkspace()
restartWorkspace()
rebuildWorkspace()
setQuota()
getStatus()
getMetrics()
destroyWorkspace()
```

The workspace controller should initially be written in TypeScript/Node for consistency.

### Privilege boundary

Only the workspace controller receives Incus administrative access.

The primary Fastify API must not directly possess the Incus admin socket or equivalent administrative credentials.

Architecture:

```text
Browser
   ↓
API
   ↓ narrow authenticated internal API
workspace-controller
   ↓
Incus
```

This separation limits the blast radius of an application-layer compromise.

## 10. Workspace agent

The **workspace agent** runs inside each student LXC workspace.

Initial implementation: TypeScript/Node, built with Fastify and
`@fastify/websocket` like the main API.

Responsibilities include:

- PTY creation;
- terminal attach/detach;
- filesystem watching;
- file operations;
- Git status;
- Git diff support;
- project-wide search;
- listening-port detection;
- process/service information;
- workspace health;
- selected Docker health/status;
- coding-agent launch support;
- project discovery.

### Transport and delivery

The agent runs as the unprivileged `student` user inside the container and
listens on TCP port **7400** on the workspace bridge (`10.200.0.0/24`). The
API dials it directly; the workspace controller is not in the terminal path.
See ADR 0009 for why we did not tunnel through the Incus `exec` websocket.

Every request carries a per-workspace bearer token. The control plane writes
it into the container at `/etc/portikus/agent.token`, owned by uid 1000 with
mode 0600, and the agent re-reads that file on each request and compares
with `timingSafeEqual`. Incus address and MAC filtering on the profile nic,
plus a network ACL that isolates peers and allows tcp/7400 from the gateway
only, are what keep one workspace from receiving another's token.

The agent is not baked into the workspace image. The control-plane Debian
package (ADR 0007) ships the built agent tree at
`/usr/lib/portikus/workspace-agent`, and the workspace profile bind-mounts
it read-only at `/opt/portikus/workspace-agent`, where the image's
pre-enabled systemd unit expects `bin/workspace-agent`. Upgrading the
package upgrades every agent.

### File, Git, search, and event routes

Beside the project routes of SPEC.md section 7.6, the agent serves, all of
them under one project and all confined to it (ADRs 0013 and 0014):

| Route | What it does |
|---|---|
| `GET /projects/:slug/tree` | One directory listing, at most 2,000 entries, saying when it was truncated |
| `GET /projects/:slug/file` | Streams one file out with a content-hash ETag |
| `PUT /projects/:slug/file` | Conditional write: `If-Match` to overwrite, `If-None-Match: *` to create |
| `DELETE /projects/:slug/file` | Removes one file or an empty directory |
| `POST /projects/:slug/mkdir` | Creates one directory |
| `POST /projects/:slug/move` | Moves or renames inside the project, both ends confined |
| `GET /projects/:slug/git/status` | Branch, upstream, ahead and behind, conflicts, and one entry per changed path |
| `GET /projects/:slug/git/diff` | One file, `HEAD` against the working tree, each side capped at 1 MiB |
| `GET /projects/:slug/search` | ripgrep over the project, at most 500 matches |
| `GET /projects/:slug/events` (WebSocket) | Batched filesystem changes, with a ready frame first |

### PTY implementation

Use **node-pty** for actual PTYs.

Use **tmux** for terminal persistence during the 10-minute browser-disconnect grace period.

The browser WebSocket must not determine process lifetime.

Conceptual path:

```text
xterm.js
   ↓ WebSocket
workspace-agent
   ↓
node-pty / tmux
   ↓
shell / claude / codex
```

The packages chosen for that path, at exact versions pinned in
`package.json` as every dependency is:

| Package | Side | Role |
|---|---|---|
| `node-pty` | agent | real PTYs |
| `@xterm/xterm` | browser | terminal emulator |
| `@xterm/addon-fit` | browser | size the terminal to its pane |
| `@xterm/addon-web-links` | browser | detect links for §14.9 linkification |

`@xterm/xterm` is the maintained scope of the package STACK calls xterm.js;
the old `xterm` package name is not used.

### Search

Use `ripgrep` (`rg`) inside the workspace for project-wide text search rather than implementing search in JavaScript.

### Git

Use the actual `git` CLI as the source of truth for repository state.

Do not implement a competing Git model.

### Future Go rewrite

If profiling later shows that the Node workspace agent uses excessive memory or has operational limitations, it is a good candidate for an isolated rewrite in Go.

Do not introduce Go in P0 without a measured reason.

## 11. Coding agents

P0 supports:

- Claude Code;
- Codex.

Both should remain ordinary CLI tools visible in terminal sessions.

Portikus may provide launchers that create appropriately labeled sessions:

```text
+ Terminal
+ Claude Code
+ Codex
```

But the underlying tool must remain real and observable.

Do not create hidden coding-agent execution environments separate from the project filesystem.

## 12. Preview proxy and edge

### Caddy

Use **Caddy** as the external TLS terminator and reverse proxy.

Caddy should own:

- TLS;
- browser-facing HTTP;
- WebSocket forwarding;
- preview-host routing;
- forwarding traffic to the appropriate service.

### Preview authorization

Do not put arbitrary student application traffic through the Fastify process unless necessary.

Preferred pattern:

```text
Browser
   ↓
Caddy
   ↓
authorization subrequest → Portikus API
   ↓ allowed
Caddy
   ↓
workspace:port
```

The API answers the authorization question.

Caddy moves the application traffic.

This avoids turning the Node control plane into a general-purpose proxy for untrusted student workloads.

### Origin separation

Use separate origins for:

```text
workspace.example.edu
*.preview.example-dev.net
```

Student preview JavaScript must not share control-plane cookies or trust boundaries.

### Traefik

Traefik is an acceptable alternative if infrastructure requirements later favor it, but Caddy is the preferred default because of its simplicity and strong TLS/proxy model.

## 13. Testing

### Unit and integration tests

Use **Vitest**.

Use it across shared packages and Node services where practical.

### Browser end-to-end tests

Use **Playwright**.

This is mandatory for Portikus because important behavior crosses many subsystem boundaries.

Representative E2E scenario:

```text
authenticate
→ workspace starts
→ open project
→ launch terminal
→ modify file
→ filesystem event appears
→ Changes view updates
→ run application
→ preview opens
→ disconnect/reconnect
→ verify lifecycle behavior
```

### Infrastructure smoke tests

Infrastructure tests should validate:

- VM availability;
- Incus availability;
- workspace provisioning;
- nested Docker;
- workspace agent;
- terminal connectivity;
- preview routing;
- control-plane health.

## 14. Linting and formatting

Use **Biome** for TypeScript/JavaScript linting and formatting where possible.

Reasons:

- one tool rather than ESLint + Prettier + plugin collection;
- lower dependency count;
- fast execution;
- straightforward CI;
- easier environment for coding agents.

If a framework/library requires ESLint-specific rules that materially improve safety, ESLint may be added narrowly rather than replacing Biome wholesale.

## 15. Observability

Use **OpenTelemetry** for application-level tracing/metrics where practical.

At minimum, instrument:

- API requests;
- workspace lifecycle operations;
- workspace-controller calls;
- workspace-agent connectivity;
- preview authorization;
- recovery operations;
- job execution.

Structured logs are pino JSON lines carrying `service`, `level`, `time`, and
`msg`, written by the shared logger in `packages/observability`. `LOG_LEVEL`
sets each service's default level and the `settings.log_level` row overrides it
at runtime without a restart (ADR 0012). `pino-pretty` is used only when
`NODE_ENV=development`.

Do not log:

- API keys;
- OIDC secrets;
- coding-agent prompts;
- project source code;
- `.env` contents;
- raw terminal history.

A lightweight metrics/log stack may be added during pilot hardening, but application instrumentation should not depend on one specific monitoring vendor.

# Part II — Infrastructure stack

## 16. Infrastructure philosophy

Portikus infrastructure must be treated as **cattle, not pets**.

The platform VM, Incus configuration, storage configuration, system packages, Caddy configuration, systemd units, networks, workspace images, and application deployment must all be reproducible from source-controlled automation.

Routine state must never depend on remembered SSH commands.

If an emergency manual change is made, it must either:

1. be reverted; or
2. be captured in the infrastructure code before it becomes expected state.

Persistent user data is different. User project data, database state, recovery data, and backups are valuable state and must be handled explicitly.

## 17. Deployment portability and reference development host

Portikus must not depend on a specific host operating system, hypervisor, cloud provider, or host storage technology.

The primary portability boundary is the **Debian platform VM**. Everything below that boundary should remain materially the same across supported deployments:

```text
host / hypervisor / cloud
          ↓
Debian platform VM
          ↓
Portikus platform
├── Incus
├── PostgreSQL
├── Caddy
├── API / workers / controller
└── student LXC workspaces
```

The initial **reference development deployment** is:

- Pop!_OS host;
- KVM/QEMU;
- libvirt;
- no ZFS requirement.

That combination exists because it matches the initial developer workstation. It is not a Portikus platform requirement.

Equivalent future deployment targets may include, for example:

```text
Ubuntu / Debian + KVM/libvirt
Proxmox → Debian VM
VMware → Debian VM
Hyper-V → Debian VM
Azure → Debian VM
AWS → Debian VM
other suitable virtualization/cloud platforms → Debian VM
```

Portikus does not need first-class automation for every provider in P0. It does need an architecture that does not make libvirt, Pop!_OS, ZFS, or any one cloud provider an application assumption.

The reference development topology is therefore:

```text
Pop!_OS
   ↓
KVM/QEMU + libvirt
   ↓
Debian platform VM
   ↓
Incus
   ↓
unprivileged LXC workspace per student
   ↓
Docker inside each workspace
```

## 18. Reference development-host bootstrap

Use a small, explicit bootstrap script for the reference development environment.

Recommended location:

```text
infra/host/dev-libvirt/bootstrap.sh
```

For the Pop!_OS/KVM/libvirt reference deployment, it should verify or install:

- KVM/QEMU;
- libvirt;
- required libvirt networking utilities;
- OpenTofu;
- Ansible;
- cloud-image tooling;
- age/SOPS;
- Make or required build tooling.

The script should be safe to rerun or clearly report already-satisfied prerequisites.

This bootstrap script is **development-provider specific**. It must not be treated as a prerequisite for Portikus itself.

Future provider-specific bootstrap or operator documentation may live alongside it, for example:

```text
infra/host/
├── dev-libvirt/
├── proxmox/
├── vmware/
└── cloud/
```

Only the providers actually supported by the project should be implemented. Do not build unused provider integrations merely for theoretical portability.

## 19. Infrastructure provisioning

### OpenTofu

Use **OpenTofu** for infrastructure resource declaration.

OpenTofu owns the stable platform-compute resources through a **deployment-specific provider**.

The required logical resources are:

- Debian platform VM;
- OS virtual disk;
- workspace-data virtual disk;
- CPU allocation;
- RAM allocation;
- network interface(s);
- cloud-init seed/configuration;
- provider-specific network resources required to make the VM reachable.

For the reference development environment, OpenTofu uses the **libvirt provider** and therefore owns resources such as the libvirt network and VM definition.

A future deployment may use a different provider without changing the Portikus application architecture.

Conceptual repository structure:

```text
infra/tofu/
├── modules/
│   └── platform-vm/
└── environments/
    └── dev-libvirt/
```

Future environments may be added only when needed, for example:

```text
infra/tofu/environments/
├── dev-libvirt/
├── proxmox/
├── azure/
└── aws/
```

The module/provider boundary should preserve the basic contract:

```text
Portikus needs:
- a Debian-compatible VM
- CPU
- RAM
- OS disk
- workspace-data disk
- network connectivity
```

How those resources are implemented is deployment-specific.

Conceptual workflow:

```text
tofu plan
tofu apply
```

OpenTofu should **not** manage runtime student workspaces.

Student workspaces are application runtime resources and are created through the Portikus control plane using the Incus API.

Do not represent every student LXC instance in OpenTofu state.

### Terraform

Terraform syntax and provider concepts are compatible with this architecture, but **OpenTofu is preferred** unless a deployment environment requires Terraform specifically.

## 20. OpenTofu state

OpenTofu state is sensitive infrastructure metadata.

Requirements:

- do not commit plaintext state to Git;
- use state encryption where practical;
- back state up;
- use locking/remote state when deployment grows beyond a single administrator;
- document state recovery.

For the pilot, encrypted local state with reliable backup may be sufficient.

A future deployment can move to an S3-compatible remote backend or another supported state service.

## 21. cloud-init

Use **cloud-init** only for minimal first-boot bootstrap.

cloud-init is part of the portability strategy because it gives provider-specific VM creation a common handoff into the Debian platform VM.

The intended flow is:

```text
deployment-specific provider creates VM
               ↓
           cloud-init
               ↓
            Ansible
               ↓
      common Portikus platform
```

cloud-init responsibilities should include only what is necessary for Ansible to take over, for example:

- hostname;
- deployment user;
- SSH authorized key;
- Python;
- sudo configuration;
- initial network configuration if required.

Do not put the full Portikus server configuration into cloud-init.

Reason:

cloud-init is primarily first-boot provisioning.

Ansible is the repeatable convergence mechanism.

## 22. Debian configuration management

### Ansible

Use **Ansible** to configure the Debian platform VM.

Ansible owns desired operating-system/service state and should be largely **hypervisor-independent**.

Once Ansible can connect to the Debian VM over the supported management path, it should not need to know whether the VM runs under libvirt, Proxmox, VMware, Hyper-V, or a cloud provider.

This makes Ansible the common configuration layer below the deployment-provider boundary.

Suggested roles:

```text
infra/ansible/
├── roles/
│   ├── base/
│   ├── firewall/
│   ├── lvm/
│   ├── incus/
│   ├── incus_network/
│   ├── portikus_workspace_profile/
│   ├── caddy/
│   ├── postgresql/
│   ├── node/            # Node runtime only, no pnpm
│   ├── portikus-api/
│   ├── portikus-worker/
│   ├── portikus-controller/
│   ├── monitoring/
│   ├── backup/
│   └── hardening/
└── site.yml
```

Ansible configures:

- apt repositories;
- OS packages;
- users/groups;
- kernel/sysctl requirements;
- LVM thin pool;
- Incus;
- Incus networks;
- Incus profiles;
- Incus projects/policies;
- UID/GID mapping prerequisites;
- firewall policy;
- Caddy;
- PostgreSQL;
- Node, the runtime only. There is no pnpm and no build toolchain on the
  VM;
- Portikus services, installed from the versioned `.deb` described in
  ADR 0007 (the package owns the service users, `/etc/portikus`,
  `/var/lib/portikus`, and the systemd units; Ansible renders the
  environment files and secrets);
- systemd units;
- backup jobs;
- logging/monitoring;
- security hardening.

The `portikus` role installs the newest release by default: it asks the
GitHub API for the latest release, verifies the `.deb` against the checksum
in that release's `SHA256SUMS` asset, installs it with apt, and renders only
the controller token and the three environment files. Rolling back is
`make configure-vm PORTIKUS_VERSION=<previous>`, which installs that release
with `--allow-downgrades`. For local development,
`make deploy-app` builds the package on the developer's machine, copies it
to the VM, and installs it the same way; `make build-deb` builds it without
deploying.

Playbooks should be idempotent.

Running the same playbook repeatedly should converge the VM toward desired state without causing unnecessary destructive changes.

## 23. VM storage

Portikus must not require a particular **host** storage technology.

The host may use ext4, XFS, ZFS, VMFS, SAN-backed storage, cloud block storage, or another suitable implementation.

The preferred Portikus VM contract is:

```text
host storage implementation
          ↓
virtual block device
          ↓
Debian platform VM
├── OS disk
└── workspace-data disk
        ↓
     LVM thin pool
        ↓
     Incus storage pool
```

For the initial reference deployment, the Pop!_OS host does not use ZFS. That fact must not appear as an application assumption.

Using a separate virtual block device for Incus/workspace data provides a useful storage portability boundary. Portikus sees a block device; the underlying host storage implementation may differ by deployment.

Reasons:

- clean separation of OS and workspace data;
- easier quota/storage management;
- thin provisioning;
- cheap snapshots/clones;
- avoids unnecessary nested copy-on-write assumptions;
- easier future storage migration;
- keeps host storage choices outside the application architecture.

A simple Incus `dir` storage pool is acceptable for an early proof of concept, but LVM thin is the preferred reference VM storage backend.

A future bare-metal or specialized deployment may intentionally use another Incus storage driver such as ZFS or Ceph. Application code must not depend on LVM-specific details.

## 24. Incus

Use **Incus** to manage student system containers.

Student workspace model:

```text
Incus
   ↓
unprivileged LXC
   ↓
systemd Linux environment
   ↓
student sudo
   ↓
Docker
```

Requirements:

- unprivileged containers;
- isolated UID/GID mapping where supported;
- nesting enabled only as needed;
- no host Docker socket;
- no Incus admin socket inside student workspaces;
- resource limits;
- separate workspace networking;
- restricted management-network access.

Incus handles:

- workspace creation;
- start/stop;
- quotas;
- profiles;
- storage attachment;
- networking;
- image versioning;
- lifecycle state.

The Portikus workspace controller interacts with Incus programmatically.

## 25. Workspace base images

### distrobuilder

Use **distrobuilder** to create reproducible Incus/LXC workspace images.

Suggested directory:

```text
infra/workspace-image/
├── portikus.yaml
├── files/
└── scripts/
```

The image should include:

- systemd-capable Linux base;
- sudo;
- Git;
- GitHub CLI;
- Docker Engine;
- Docker Compose;
- Python;
- Node.js;
- npm;
- common build tools;
- ripgrep;
- tmux;
- Claude Code;
- Codex;
- workspace-agent;
- required service definitions.

Workspace images must be versioned.

Example:

```text
portikus-2026.09
portikus-2026.10
portikus-2026.11
```

Existing student workspaces do not automatically rebase onto a new image.

Upgrades occur through an intentional workspace rebuild operation.

## 26. Why not Packer initially?

Do not introduce Packer for the pilot unless VM convergence time becomes a real problem.

The Debian platform VM can be reproduced with:

```text
Debian cloud image
   +
cloud-init
   +
Ansible
```

This is sufficient for P0.

Packer becomes useful later if the platform VM itself should boot from a pre-baked Portikus image to reduce provisioning time.

Do not use Packer merely because it is commonly associated with immutable infrastructure.

## 27. Secrets

### SOPS + age

Use **SOPS** with **age** for source-controlled encrypted secrets.

Examples:

```text
infra/secrets/pilot.enc.yaml
```

May contain:

- OIDC client secret;
- PostgreSQL credentials;
- preview authorization secrets;
- institutional coding-agent credentials;
- backup credentials;
- encryption keys.

Never commit plaintext secrets in:

- `.tfvars`;
- Ansible `group_vars`;
- `.env`;
- cloud-init;
- source code.

Deployment automation should decrypt secrets only at the point required.

### Runtime secrets

Runtime application secrets should be delivered to services through:

- protected environment files;
- systemd credentials;
- secure mounted files;
- another documented secret-injection method.

Do not expose platform secrets to student workspaces unless the specific feature requires a carefully scoped credential.

## 28. Edge/network infrastructure

Use **Caddy** on the Debian platform VM for:

- TLS;
- trusted Portikus application origin;
- preview wildcard origin;
- reverse proxy;
- WebSocket forwarding;
- preview authorization integration.

Network policy must prevent student workspaces from reaching:

- Incus management interfaces;
- host management services;
- the Pop!_OS host;
- other students' workspaces by default;
- cloud metadata endpoints;
- private management CIDRs not required for application use.

Student applications must not be directly Internet-addressable.

All inbound preview traffic passes through Caddy authorization.

## 29. Firewall

Use host/VM firewall rules managed by Ansible.

The firewall configuration is infrastructure code.

Required policy:

```text
Internet
  → Caddy ports only

student LXC
  → Internet egress allowed
  → management networks denied
  → peer workspaces denied by default

control plane
  → workspace-agent/control interfaces permitted

workspace-controller
  → Incus administrative interface permitted
```

No firewall rule should exist solely because an administrator once typed it manually.

## 30. CI/CD

### GitHub Actions

Use **GitHub Actions** for repository validation.

Application checks:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`ci.yml` also builds the versioned control-plane `.deb` with `nfpm`
(ADR 0007) on every pull request and keeps it as a build artifact for seven
days. A separate `release.yml` publishes a release when an epic branch merges
into `main`, or when the workflow is run by hand from `main` for a hotfix.
It builds the same package from the merge commit on `main` and publishes it
as a GitHub release with two assets: the `.deb` and a `SHA256SUMS` file
Ansible reads the checksum from.

Infrastructure checks:

```text
tofu fmt -check
tofu validate
ansible-lint
ansible-playbook --syntax-check
shellcheck
distrobuilder validation/build checks
```

Security checks may include:

- dependency audit;
- Trivy or equivalent filesystem/image scan;
- IaC checks;
- secret scanning.

### Production/pilot apply

For the initial pilot, CI should validate infrastructure but should **not automatically control the developer's Pop!_OS host**.

Preferred pilot deployment:

```text
administrator
    ↓
make deploy-app
```

A later institutional deployment may move to controlled automated deployment if appropriate.

## 31. Operator interface

Use **Make** as the primary documented operator entry point.

A `justfile` is acceptable, but Make is preferred because it is ubiquitous and requires little additional tooling.

Example targets:

```text
make check

make bootstrap-host

make infra-plan
make infra-apply

make configure-vm

make build-workspace-image

make build-deb
make deploy-app

make smoke-test

make backup
make restore-test

make destroy-pilot
make rebuild-pilot
```

Underlying tools remain independently usable, but humans and coding agents should prefer the repository's documented Make targets.

`CLAUDE.md` explicitly instructs coding agents not to invent deployment commands when a Make target already exists.

## 32. Infrastructure ownership and portability boundaries

Each layer owns a specific category of state.

| State | Owner |
|---|---|
| Reference development-host prerequisites | provider-specific bootstrap |
| VM/network/disks | OpenTofu + deployment-specific provider |
| First boot | cloud-init |
| Debian desired state | Ansible |
| Incus host configuration | Ansible |
| Workspace image | distrobuilder |
| Application build | pnpm/TypeScript, in CI |
| Installed control plane (binaries, users, directories, units) | Debian package built in CI, installed by Ansible from the newest release |
| Application DB migrations | application deployment |
| Secrets | SOPS + age |
| Runtime student LXCs | Portikus control plane → workspace controller → Incus |
| TLS/reverse proxy | Caddy + Ansible-managed configuration |
| Validation | GitHub Actions |
| Operator workflow | Make |

Do not allow two systems to compete for ownership of the same resource.

Two portability boundaries should remain explicit:

### Platform-compute boundary

```text
deployment-specific OpenTofu provider
               ↓
        Debian platform VM
```

Anything above this boundary may vary by deployment.

### Workspace-provider boundary

```text
Portikus control plane
          ↓
WorkspaceProvider
          ↓
Incus
```

Initially, the only application-level workspace provider is `IncusWorkspaceProvider`.

In particular:

> OpenTofu owns the stable platform compute through a provider-specific implementation. Portikus owns runtime student workspaces through the workspace-provider abstraction.

## 33. Destructive rebuild acceptance test

The infrastructure is not considered reproducible until a non-production environment passes a destructive rebuild exercise.

Required procedure:

```text
1. destroy the Debian platform VM;
2. recreate it with OpenTofu;
3. allow cloud-init to bootstrap it;
4. converge it with Ansible;
5. rebuild/import the current workspace image;
6. install the control-plane package from the newest release;
7. restore/reconnect persistent data as designed;
8. provision a test student workspace;
9. verify sudo;
10. verify nested Docker;
11. verify workspace agent;
12. verify terminal;
13. verify Claude/Codex availability;
14. run a test web application;
15. verify authenticated preview access;
16. reinstall the previous package version and confirm the control plane
    still works, proving rollback.
```

If any step requires undocumented manual intervention, the infrastructure automation is incomplete.

# Part III — Explicit technology decisions

## 34. Preferred stack summary

### Application

```text
TypeScript
Node.js LTS

React
Vite
TanStack Router
TanStack Query
Zustand
Tailwind
Radix-style accessible primitives
Monaco
react-markdown
xterm.js

Fastify
Zod
OpenAPI

PostgreSQL
Kysely
pg-boss

openid-client

node-pty
tmux
chokidar
ripgrep
git CLI

Vitest
Playwright
Biome
OpenTelemetry
```

### Infrastructure

```text
Deployment-specific host / hypervisor / cloud
OpenTofu + provider

Reference development provider:
  Pop!_OS
  KVM/QEMU
  libvirt

cloud-init
Ansible

Debian platform VM
LVM thin (reference VM storage backend)
Incus/LXC

distrobuilder

Caddy

SOPS + age

GitHub Actions
Make
nfpm-built Debian package for the control plane
```

## 35. Technologies intentionally not selected for P0

### Next.js

Not selected because Portikus is a stateful SPA and does not benefit materially from SSR, SEO, RSC, or static generation.

### NestJS

Not selected because its abstraction/ceremony is unnecessary for the initial team size and architecture.

### GraphQL

Not selected because REST + WebSockets better matches Portikus's resource and streaming model.

### tRPC as the API contract

Not selected because service boundaries should remain usable by non-TypeScript clients and external integrations.

### Prisma

Not selected because Portikus benefits from a thin SQL-oriented query layer rather than a heavier ORM/runtime abstraction.

### Redis

Not selected because PostgreSQL-backed durable jobs are sufficient for the pilot.

### Bun/Deno

Not selected because Node LTS provides the least-surprising compatibility for native modules, PTYs, OIDC, and Linux tooling.

### Kubernetes

Not selected because Incus directly matches the system-container workspace model and Kubernetes would add substantial operational complexity without solving a current requirement.

### Per-student virtual machines

Not selected because they are too heavyweight for the intended workspace density and are unnecessary for the initial threat model.

### Docker/Sysbox as the outer workspace runtime

Not selected for the current baseline because Incus/LXC more naturally models a persistent Linux system container with sudo and nested Docker.

### CRIU/stateful container hibernation

Not selected because student process state does not need to survive the 10-minute post-disconnect shutdown.

### Packer

Deferred because cloud-init + Ansible already provide sufficient reproducibility for the Debian platform VM.

### Docker or other containers for the control plane on the platform VM

Not selected because Docker rewrites the host packet filter, blurs the Incus
socket boundary, and is awkward for the preview gateway. The control plane
ships as a Debian package instead (ADR 0007).

### `.rpm` packaging

Deferred until a non-Debian host is supported. `nfpm` can emit one from the
same configuration when that day comes.

### Terraform-managed student containers

Explicitly prohibited.

Student workspaces are runtime application resources, not static infrastructure resources.

## 36. Portability requirement

Portikus must remain portable across reasonable VM-capable deployment environments.

Portability means:

- the application does not depend on Pop!_OS;
- the application does not depend on libvirt;
- the application does not depend on host ZFS;
- the application does not depend on a particular cloud;
- the Debian platform VM provides the main infrastructure portability boundary;
- provider-specific provisioning is isolated above that boundary;
- Ansible, Incus, Caddy, PostgreSQL, and Portikus services remain materially consistent below it.

Portability does **not** mean that every provider must be implemented or tested in P0.

The project should maintain one well-tested reference development deployment and add additional provider integrations only when there is a concrete deployment requirement.

## 37. Guiding rule for future stack changes

A new technology should be introduced only if it clearly improves one or more of:

- security;
- operational simplicity;
- reliability;
- maintainability;
- developer productivity;
- student experience;
- measured performance.

Do not add technology because it is fashionable or because it makes the architecture look more sophisticated.

Every additional stateful service, programming language, deployment system, or framework creates another operational boundary.

Portikus should remain understandable by one strong engineer and their coding agents for as long as practical.
