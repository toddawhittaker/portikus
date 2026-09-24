# Portikus Specification

## Browser-Based Agentic Development Workspace

**Status:** Draft specification  
**Version:** 0.1  
**Audience:** Humans and software-development agents  
**Scope:** Initial student pilot, with architectural provisions for a future developer profile

## 1. Purpose

This specification defines the functional, non-functional, security, infrastructure, and operational requirements for **Portikus**, a browser-based agentic software-development environment.

Portikus provides each authenticated user with one remote Linux workspace containing multiple projects. Users interact with that workspace through a browser using terminals, file views/editors, Git-aware navigation, and authenticated application previews. Coding agents such as Claude Code and Codex run inside the same workspace and operate on the same files visible to the user.

The initial Portikus implementation is optimized for teaching agentic software development to non-technical and early-stage technical students.

The specification must be interpreted together with `VISION.md`. Where the two documents appear to conflict, this specification controls implementation details and `VISION.md` controls product intent.

## 2. Terminology

### 2.1 Portikus

**Portikus** is the product and project name for the browser-based agentic development workspace defined by this specification. The name must be used consistently in user-facing branding, repository documentation, architecture documentation, and deployment documentation unless a deployment intentionally applies institution-specific branding.

Portikus refers to the complete platform, not to an individual workspace, VM, container, project, or coding agent.

### 2.2 Host

The physical or primary machine on which the pilot VM runs.

Initial pilot host:

- Pop!_OS Linux;
- no ZFS requirement;
- KVM/QEMU virtualization available;
- libvirt is the preferred VM-management layer.

### 2.3 Platform VM

The Debian virtual machine that runs Incus, the platform control services, networking/proxy components, and student LXC workspaces.

The platform VM is infrastructure and must be reproducible from source-controlled automation.

### 2.4 Workspace

One persistent Linux system-container environment assigned to one user.

A workspace:

- is implemented initially as an unprivileged LXC container managed by Incus;
- has a stable platform identity;
- contains multiple projects;
- permits `sudo` inside the workspace;
- can run Docker inside itself;
- persists filesystem state across normal stops and starts;
- does not guarantee process persistence after a full workspace stop.

Exactly one active student workspace is assigned to a user in P0.

### 2.5 Project

A directory under:

```text
~/projects/<slug>
```

Each project is independently selectable in the browser and has its own saved UI layout.

A project may or may not be a Git repository.

### 2.6 Workspace agent

A platform-supplied service running inside the workspace.

It provides controlled communication between the platform control plane and the user's Linux environment for functionality such as:

- PTY creation and attachment;
- filesystem watching;
- file operations;
- Git status;
- port discovery;
- workspace health;
- resource information available from inside the workspace;
- project discovery; and
- approved management operations.

The workspace agent is not a coding agent.

### 2.7 Coding agent

A software-development agent used by the student, initially including:

- Claude Code; and
- Codex.

Coding agents run in ordinary user-visible terminal sessions unless a provider requires a different launch mechanism.

### 2.8 Control plane

The trusted platform application outside student workspaces that manages:

- authentication and authorization;
- workspace lifecycle;
- Incus;
- project metadata;
- UI state;
- reverse proxy authorization;
- administration;
- audit data;
- recovery metadata; and
- communication with workspace agents.

### 2.9 Preview

An authenticated browser route to a TCP service running inside the user's workspace.

A preview is never an unauthenticated public deployment.

### 2.10 Recovery point

A platform-managed recoverable copy of project data made without modifying Git state or Git history.

## 3. Scope and release priorities

Requirements use these priorities:

- **P0** — required for the initial student pilot;
- **P1** — expected shortly after or during pilot refinement;
- **P2** — future capability; architecture should not prevent it.

Unless explicitly stated otherwise, functional requirements below are P0.

### 3.1 Product prioritization model

Portikus should prioritize features according to the role they play in learning and productive work. P0 may include features with little direct pedagogical value when they remove friction that would otherwise distract from the learning goals.

P0 capabilities should be evaluated in three categories:

1. **Pedagogical core** — capabilities that make important agentic-development behaviors visible and repeatable. These include directing an agent, reviewing its changes, independently verifying the result, and preserving accepted work in source control.
2. **Learning-support infrastructure** — capabilities that make experimentation safe and make the runtime understandable, including recovery points and visibility into running services and ports.
3. **Friction reducers** — capabilities that do not themselves teach agentic development but prevent avoidable operational work from consuming instructional attention, including project search, autosave/version protection, clickable file references, and localhost-to-preview handling.

The primary student workflow should support the following cycle without requiring the student to leave Portikus:

```text
Direct → Review → Verify → Preserve → Repeat
```

This does not require those words to be used as persistent UI labels. The product should make the behaviors natural through context and state.

## 4. Architectural baseline

The initial pilot architecture is:

```text
Pop!_OS host
│
├── KVM/QEMU + libvirt
│
└── Debian platform VM
     │
     ├── control-plane services
     ├── PostgreSQL
     ├── authenticated reverse proxy / preview gateway
     ├── Incus
     │    │
     │    ├── user-workspace-001
     │    │    ├── Linux userspace
     │    │    ├── systemd
     │    │    ├── sudo
     │    │    ├── Docker Engine
     │    │    ├── Git
     │    │    ├── language/toolchain base
     │    │    ├── Claude Code
     │    │    ├── Codex
     │    │    └── workspace-agent
     │    │
     │    └── user-workspace-N
     │
     └── persistent storage
          ├── Incus workspace roots
          ├── user home/project volumes
          ├── inner Docker data volumes
          ├── recovery data
          └── PostgreSQL data
```

### 4.1 Container isolation

Student workspaces must use unprivileged LXC containers.

The implementation must:

- enable unique/isolated UID/GID mappings per student workspace where supported;
- enable nesting only to the extent required to run Docker inside the workspace;
- never use the host Docker socket inside student workspaces;
- never give a student workspace direct Incus administrative access;
- avoid privileged LXC containers;
- retain default confinement mechanisms such as AppArmor/seccomp unless a documented exception is necessary.

### 4.2 Nested Docker

Each workspace must support an ordinary Docker workflow including, at minimum:

```text
docker
docker build
docker run
docker ps
docker compose
```

The purpose is pedagogical authenticity and application isolation within the workspace.

Docker state must be isolated per user.

### 4.3 Pilot storage

The initial Pop!_OS host does not use ZFS. ZFS is therefore not required anywhere in the pilot.

Preferred storage layout:

```text
Pop!_OS host filesystem
    ↓
Debian VM
    ├── OS virtual disk
    └── workspace data virtual disk
            ↓
         LVM thin provisioning
            ↓
         Incus storage pool
```

Requirements:

1. The platform VM should receive a dedicated second virtual disk for Incus/workspace data where practical.
2. The second virtual disk should preferably be raw or direct block storage rather than another copy-on-write filesystem layered over the host.
3. Incus should use LVM thin provisioning for the primary pilot storage pool.
4. The implementation must not depend on LVM-specific behavior outside the infrastructure/storage adapter layer.
5. A simple Incus `dir` backend is acceptable for an early developer proof of concept, but not the preferred pilot configuration.
6. A future bare-metal deployment may use ZFS without requiring application-level changes.

### 4.4 Workspace filesystem model

The implementation should separate replaceable system state from persistent user data.

Target model:

```text
workspace root filesystem
    replaceable platform/system state

/home/<student>
    persistent user state
    └── projects/

/var/lib/docker
    persistent, quota-controlled Docker state
```

Normal workspace stop/start must preserve all three.

A deliberate workspace rebuild may replace the root filesystem while retaining the user's home/projects volume. Docker state may be retained or reset according to the selected administrative action.

## 5. Identity and access

### 5.1 Authentication

The platform must support standards-based single sign-on.

P0 requirement:

- OIDC authentication with at least one configurable identity provider.

Architecture must allow later support for:

- Microsoft Entra ID;
- generic OAuth/OIDC providers;
- LDAP-backed institutional authentication;
- LTI-provided identity/course context.

LDAP support does not need to be implemented directly in P0 if the institutional LDAP directory can be fronted by an OIDC identity provider.

### 5.2 Authorization

Access must be denied by default.

Authorization may be based on:

- configured identity-provider group claims;
- explicit platform role assignments; or
- both.

P0 roles:

- `student`;
- `instructor` (added by Epic 13: a student's rights plus a read-only Course page; never any administrator route);
- `administrator`.

Added by Epic 13.1: a course account (created by an LTI launch) can be
linked to a single-sign-on (SSO) account, so one person launching from a
course and signing in through SSO reaches the same account and workspace.
An account's effective role is the higher of the role its own sign-in
gave last time and an optional role, `instructor` or `administrator`,
stored by Portikus (a "grant"); an administrator grants and revokes it
from the Users view. A grant is refused on a course account, so LTI can
never make anyone an administrator, and a launch never starts a session
for an account whose effective role is administrator. See
`docs/EPIC-13-1.md` and ADR 0026.

P2 roles may include:

- `developer`;
- `support`.

### 5.3 Session security

Browser sessions must:

- use secure transport;
- use secure, HttpOnly cookies for server-maintained sessions where cookies are used;
- use appropriate SameSite policy;
- defend state-changing requests against CSRF;
- authenticate WebSocket upgrades;
- expire according to configurable policy;
- reject access immediately when server-side authorization is removed.

### 5.4 Multiple browser connections

A user may connect to the same workspace from multiple browser windows or devices.

All authorized connections must see the same underlying workspace.

Events originating in one connection must propagate to other active connections when relevant.

## 6. Workspace lifecycle

### 6.1 One workspace per student

P0 assigns one workspace to each authorized student.

A student's projects all live inside that workspace.

### 6.2 Provisioning

On first use, the platform must be able to provision a workspace from the current approved workspace image.

Provisioning must be fully automated.

The student must not need administrator intervention for routine provisioning.

### 6.3 Start behavior

If an authenticated user opens the platform and the assigned workspace is stopped:

1. the control plane requests workspace start through Incus;
2. the UI displays a clear connecting/starting state;
3. the control plane waits for workspace-agent health;
4. the browser reconnects to project/file/terminal services when ready.

If the workspace is stopped because the student stopped it by hand, the platform does not start it again on its own. The work area says the workspace is stopped and offers a button that starts it, which is the same request as the Start button in the workspace dialog. The platform never shows starting progress while no start has been requested.

Target cold-start performance is defined in the non-functional requirements.

### 6.4 Disconnect grace period

Student process persistence is tied to active browser connections.

When the number of authenticated browser connections for a student workspace becomes zero:

1. start a configurable shutdown grace timer;
2. default grace period: **10 minutes**;
3. if any authorized browser reconnects before expiry, cancel shutdown;
4. if no browser reconnects, gracefully stop the workspace.

The system must not rely on browser `beforeunload` events to determine disconnect state.

Connection presence must be determined server-side using active WebSocket/session state and heartbeat/timeout behavior.

The grace period is an administrator setting, not a deployment constant. There is one platform-wide default and an optional override for each user; a user's override wins over the default. An administrator changes either value while the platform runs, and the change takes effect immediately, including for workspaces that are already disconnected and counting down. Shortening the value below the time a workspace has already been disconnected stops it on the next sweep.

A grace period of **0** disables the timer: the workspace keeps running until it is stopped by hand. This applies at both levels, so 0 as one user's override keeps that user's workspace up while everyone else's still stops.

### 6.5 Graceful stop

A stop should allow the workspace operating system and inner services a bounded period to shut down cleanly.

If graceful stop does not complete within the configured timeout, the platform may force-stop the workspace and must record the event.

### 6.6 Persistence contract

The following must persist across a complete student workspace stop/start:

- files;
- Git repositories;
- project directories;
- user dotfiles;
- user agent configuration intended to persist;
- Docker images;
- Docker containers;
- Docker volumes;
- browser layout metadata;
- project metadata;
- terminal metadata such as display name and last working directory;
- preview tab definitions;
- recovery points.

The following are **not** guaranteed to persist:

- shell processes;
- coding-agent processes;
- tmux processes after the outer workspace has stopped;
- development servers;
- open TCP connections;
- process memory;
- application runtime state that was not written to persistent storage.

### 6.7 Reconnection during grace period

If a browser reconnects before the workspace has been stopped:

- existing terminals remain attached or reattachable;
- running agents continue;
- running dev servers continue;
- preview tabs reconnect;
- no process restart should be required.

### 6.8 Reconnection after stop

After a complete stop/start:

- previously open file tabs may reopen;
- project layout must be reconstructed;
- prior terminal tabs may be shown as ended sessions with an option to create a new terminal;
- the last terminal working directory should be remembered when possible;
- previous preview tabs may be reconstructed but should display an inactive state until the relevant service is listening again;
- commands must never be replayed automatically.

### 6.9 Developer lifecycle

P2: a developer profile may use a different shutdown policy, including manual stop or substantially longer idle limits.

This must be a policy difference, not a separate runtime implementation.

## 7. Project management

### 7.1 Project location

All projects must resolve under:

```text
~/projects/<slug>
```

The platform must validate slugs and prevent path traversal.

### 7.2 Create project

P0 creation methods:

- **New project** — create a new project directory and initialize Git by default;
- **Clone repository** — clone a Git repository into a new project;
- **From template** — instantiate from a configured project template.

For a new project, `git init` should be the default behavior because source control is part of the standard Portikus workflow. The UI may allow an explicit opt-out when appropriate.

If Portikus opens an existing project that is not a Git repository, the UI must identify that state clearly and offer an **Initialize Git** action. Initialization must invoke real Git and must not create hidden commits. A new project initialised with Git starts with a default `.gitignore` covering secrets, dependency directories, build output and local databases; it is left untracked, and a project that already has one keeps it.

### 7.3 Project operations

P0:

- rename;
- duplicate;
- download/export;
- archive;
- permanent delete, behind a confirmation that requires typing the project's
  slug.

### 7.4 Archive semantics

Archiving a project must remove it from the default active-project list without silently destroying project data.

Exact archive storage strategy is implementation-defined but must be recoverable by an administrator in P0.

### 7.5 Project switching

Selecting a project in the left pane must change the center and right panes to that project's saved state.

Each project must maintain independent:

- selected center tab;
- open files;
- terminal tabs;
- split layout;
- preview tabs;
- file-tree expansion state where practical.

### 7.6 Project API and storage

A project is a durable control-plane row (§26) that mirrors a directory under
`~/projects`. The row owns the name, state, source, and saved layout; the
directory owns existence and Git status. The control plane never touches the
directory itself: every filesystem and Git operation runs in the workspace
agent behind the per-workspace bearer token of §23.5 (ADR 0010).

The slug names the directory and matches `^[a-z0-9][a-z0-9-]{0,62}$`. It is
derived from the project name, so the same rule fits a DNS label and cannot
contain a path separator. The agent resolves `~/projects/<slug>` with realpath
and refuses the request unless the parent of the result is exactly the realpath
of `~/projects`, which is what enforces §7.1. Child processes are started
directly, never through a shell.

The workspace agent exposes `GET /projects` (each entry is a slug, whether the
directory holds a Git repository, and the directory's own identity), `GET /projects/:slug`,
`POST /projects`, `POST /projects/:slug/rename`,
`POST /projects/:slug/duplicate`, `POST /projects/:slug/git-init`, and
`GET /projects/:slug/archive`, which streams a zip.

The control plane exposes, under the authorization rules of §5.2 and for the
workspace owner only, `GET` and `POST /workspaces/:id/projects`,
`GET /workspaces/:id/projects/templates`,
`PATCH /workspaces/:id/projects/:projectId`, and under that project
`POST .../duplicate`, `POST .../git-init`, `GET .../download`, and `GET` and
`PUT .../layout`. An administrator asking for a student's project gets a 404,
as with terminals. An operation that needs the directory requires a running
workspace; otherwise it is refused with 409.

Discovery and missing projects. The listing takes a `state` query of `active`
or `archived` and defaults to active. When the workspace is running, the
control plane asks the agent what is on disk and reconciles: a directory that
is a Git repository and has no row gets one, with `source = discovered` and a
name read from the directory: the words between hyphens and underscores,
each capitalised, so `project-name` reads `Project Name`; a row whose
directory is gone is returned with `missing:
true` and may only be archived. A directory that is not a Git repository is
ignored. Discovery never resurrects an archived slug, because that slug already
has a row. When the workspace is not running, rows are returned with the Git
and missing fields null.

Renamed directories. A directory carries an identity of its own, independent
of its name: its inode, which `mv` preserves. The agent reports it with each
listing and the control plane stores it on the project row. Before discovery,
each listing does two things: it records the identity of any directory a row
already names, and it moves a row whose directory is gone to whichever
directory now carries that row's identity. So a project a student renames with
`mv` in a shell keeps its id, its open tabs, and its layout, and its
terminals' recorded working directories move with it. Its display name is read
from the new directory name the same way discovery reads one, because the
folder is the project: renaming the folder renames the project. A copy, or a restore from
a recovery archive, has a different identity and is honestly a new project. A
directory whose identity belongs to no row is discovered under the existing
rule: only if it is a Git repository.

Rename changes the name, the slug, and the directory together. The agent moves
the directory and refuses if the target already exists; the control plane
rewrites the working-directory prefix of that project's terminal rows in the
same transaction. Running shells are unaffected, because a process's working
directory follows the inode.

Archive is a state flag on the row plus an archive timestamp, and it writes an
audit event. The directory is left in place, which is how §7.4 recoverability
is met. Unarchiving is a change of the same field back to active.

Download is a zip named `<slug>.zip`. The agent streams `zip -r -y`, so a
symbolic link is stored as a link and never followed out of the project, and
the control plane pipes the bytes through with a fixed filename taken from the
slug. There is no size cap in P0.

Templates are configuration: one control-plane setting, `PROJECT_TEMPLATES`,
of the form `name=url,name=url`, empty by default, and the template option is
hidden when it is empty. Instantiating a template clones it, removes `.git`,
and runs `git init`. The platform never runs `git commit` (§12.5).

A clone URL must be `https`, `http`, `ssh`, or the `user@host:path` form.
Anything else, including `file://`, Git's `ext::` transport, a URL with
whitespace or control characters, and anything starting with a hyphen, is
refused by both the control plane and the agent. A clone runs inside the
request with `GIT_TERMINAL_PROMPT=0` and is abandoned after five minutes; it
writes into a temporary directory that is renamed on success and removed on
failure, so a failed clone leaves nothing behind.

The saved layout of §7.5 is one JSON document per project:

```json
{"tabs": [{"id": "…", "root": {"type": "leaf", "terminalId": "…"}}]}
```

A node is either a leaf naming one terminal or a split with a direction of
`row` or `column`, one size per child, and at least two children. The browser
owns this document and writes it back, at most once a second; the last write
wins. Before it is used the browser reconciles it against the terminal list:
a terminal with no leaf is added as a new tab, and a leaf whose terminal no
longer exists is removed, so a saved layout can never point at a terminal that
is gone. Ended terminals keep their leaf (§9.7). The selected tab and the pane
widths are browser-local, not part of this document.

## 8. Main browser interface

### 8.1 Three-pane layout

The primary desktop interface must have:

1. **Left pane:** project navigation;
2. **Center pane:** tabbed work area;
3. **Right pane:** project file tree.

Responsive behavior may collapse panes on narrow displays, but desktop browser use is the P0 optimization target.

### 8.2 Left pane

The left pane must provide:

- active project list;
- archived-project access or entry point;
- project creation;
- clear selected-project state;
- project context actions.

### 8.3 Center pane

Supported P0 tab types:

- terminal;
- file editor/viewer;
- diff/change review;
- Markdown editor/preview;
- application preview.

Tabs must be closable and reorderable.

Tab strip sizing. Every tab in a strip is the same width, whatever its label.
Tabs share the available width equally up to a maximum of 220 pixels, and the
label is truncated with a fade at its right edge rather than an ellipsis. When
the strip runs out of room, every tab shrinks together down to a floor width at
which the label is gone and only the kind icon and the close control remain.
Past that floor the strip scrolls sideways: the mouse wheel over the strip
scrolls it, a tab that becomes selected is scrolled into view, and fade edges
show that there are more tabs on either side. The close control is visible on
every tab at every width; on a tab with unsaved changes an unsaved dot takes its
place and turns back into the close control on hover or focus. There is no cap
on how many tabs a project may have open; memory is the only limit.

Closing the selected tab selects the tab that was selected most recently before
it, the way a web browser does. When no earlier selection is still open, the tab
to the left takes over, or the tab to the right when the closed tab was the
leftmost one. Closing a tab that is not selected does not change the selection.
This selection history lasts only as long as the workspace is open in the
browser; it is not saved.

Terminal panes must additionally support splitting.

### 8.4 Right pane

The right pane contains the selected project's file tree and Git decorations.

## 9. Terminal functionality

### 9.1 Terminal implementation

The browser terminal should use xterm.js or an equivalent terminal emulator.

The server must create actual PTYs inside the user's workspace.

### 9.2 Terminal persistence during browser disconnect

Within the 10-minute disconnect grace period, terminal processes must continue even when no browser is attached.

A server-side PTY/session mechanism such as tmux is recommended.

The browser WebSocket must not itself own the lifetime of the shell process.

### 9.3 Multiple terminals

Users must be able to:

- create a new terminal;
- create multiple terminal tabs;
- split a terminal area horizontally;
- split a terminal area vertically;
- resize splits;
- rearrange terminal panes/tabs;
- close a terminal.

A shell that exits, whether by `exit`, Ctrl+D, or any other route, closes its
terminal and removes its pane, and closes the tab when it was the last pane in
it. This is the same outcome as the explicit close action.

### 9.4 Working directory

A new terminal created from a project context should default to that project's directory unless the user explicitly chooses otherwise.

### 9.5 Multi-client behavior

Multiple connected browsers may attach to the same logical terminal where technically practical.

Input/output behavior must be deterministic and must not create separate hidden processes for what appears to be one terminal.

### 9.6 Terminal metadata

The platform should persist:

- terminal display name;
- project association, as the identifier of the project the terminal belongs
  to (§7.6);
- last known working directory where practical;
- center-layout location.

The process itself is not persisted across full workspace stop.

### 9.7 Session model and wire protocol

Each terminal is one tmux session inside the workspace, named
`pk-<terminalId>` and created with `window-size latest`. Every browser
attachment is its own PTY running `tmux attach-session` against that
session, so tmux owns the shell and the WebSocket does not. Several
attachments to one terminal are a shared tmux attach and must not create a
second process. A full workspace stop ends the container and therefore the
tmux sessions with it.

Terminal metadata (§9.6, §26) is a durable control-plane row holding at
least the terminal ID, its workspace, display name, working directory,
layout position, creation time, and the time it ended. The control plane
marks a terminal ended when its workspace begins stopping; closing a
terminal deliberately deletes its row instead. An ended terminal is shown
as ended with an action to create a new one, and a listing returns every
open terminal plus the 20 most recently ended ones. On attach the agent
replays the pane's recent history from tmux, up to the capture limit, into
the browser's scrollback, so a reload shows earlier output above the
prompt; the platform still stores no terminal output anywhere.

The browser connects to the control plane at
`/workspaces/:id/terminals/:terminalId/ws`, and the control plane connects
to the workspace agent at `/terminals/:terminalId/attach`. The two
connections carry identical frames so that the control plane can forward
bytes without interpreting them:

- client to server, text frames: `{"type":"input","data":"…"}` and
  `{"type":"resize","cols":N,"rows":N}`;
- server to client, binary frames: raw PTY output;
- server to client, text frames: `{"type":"exit"}` and
  `{"type":"error","code":"…"}`.

Limits, enforced by the server:

- at most 8 terminals per workspace;
- at most 4 simultaneous attachments per terminal;
- at most 64 KiB of data in one input frame, and at most 1 MiB in any
  frame the browser sends;
- the workspace agent pauses reading the PTY when a socket's buffered
  output passes 1 MiB and resumes when it falls below 256 KiB, so that a
  runaway process cannot exhaust memory.

The workspace agent additionally exposes `GET /health`, `GET /terminals`,
`POST /terminals`, and `DELETE /terminals/:terminalId`. Every agent route,
including the WebSocket upgrade, requires the per-workspace bearer token of
§23.5. The control plane exposes `GET` and `POST /workspaces/:id/terminals`
and `PATCH` and `DELETE /workspaces/:id/terminals/:terminalId` under the
authorization rules of §5.2. A terminal may be created with a `projectId`,
which must belong to the same workspace and which sets the working directory
to that project's directory (§9.4); the listing takes a `projectId` query that
returns only that project's terminals. The control plane re-checks the session on an
open terminal WebSocket at most once a second and closes the socket when
the session is gone.

## 10. Coding-agent integration

### 10.1 Supported agents

P0:

- Claude Code;
- Codex.

The architecture should allow additional CLI agents without redesigning the terminal system.

### 10.2 Launch experience

The center pane should support launch actions such as:

```text
+ Terminal
+ Claude Code
+ Codex
+ File
+ Preview
```

A coding-agent launcher may create a terminal and invoke the appropriate CLI.

The resulting session must remain a normal visible terminal.

### 10.3 Direct CLI use

Students must also be able to launch coding agents manually from an ordinary shell.

### 10.4 Credential models

The system must support both:

1. student-owned provider credentials/accounts; and
2. institution/platform-provided API credentials.

P0 does not require a general-purpose secrets-management UI.

### 10.5 Student-owned credentials

Student-owned agent configuration may persist in the user's home directory.

Files containing tokens must use restrictive permissions.

The platform must not expose another student's credentials.

### 10.6 Institution-provided credentials

Institution-provided credentials must not be written into project files automatically.

Where feasible, they should be supplied to the agent process using environment variables, provider-specific credential mechanisms, or a future credential broker.

Shared institutional secrets must never be visible through another student's workspace.

### 10.7 `.env`

The platform should allow students to use ordinary `.env` files because understanding environment-based application configuration is part of the instructional purpose.

The UI must not pretend that `.env` eliminates the need for safe secret handling.

### 10.8 Agent-session awareness

The platform should record enough metadata to distinguish an agent terminal from a normal terminal.

P1 may use this metadata to show:

- agent working/idle status;
- session duration;
- resumable provider sessions;
- usage/cost information where available.

The platform must not depend on private or undocumented agent internals for P0.

### 10.9 Agent-session baseline and review unit

Starting a coding-agent session from Portikus is a P0 review boundary. Before the agent begins modifying the selected project, Portikus must create or record a lightweight project baseline that can later answer:

> What changed during this agent session?

The baseline must be independent of Git `HEAD` because a project may already contain uncommitted work when the agent starts.

P0 requirements:

- associate the baseline with the agent session and project;
- capture enough project state to produce a session-change comparison;
- avoid modifying the project's Git history, index, branches, tags, or stash;
- provide a **Review session changes** action while or after the agent session exists;
- allow restoration to the pre-session project state through the recovery mechanism, with a recovery point of the current state created first when practical;
- treat ignored but project-relevant files according to the recovery-point policy rather than assuming `.gitignore` means disposable.

The implementation may reuse recovery-point infrastructure rather than introducing a second backup mechanism.

## 11. File browser

### 11.1 Project confinement

All file-browser operations must be confined to the selected project directory unless a future explicit feature permits browsing elsewhere.

Path traversal through `..`, symlinks, archive entries, encoded separators, or similar techniques must be prevented.

### 11.2 Tree operations

P0 file-tree operations:

- expand/collapse directories;
- create file;
- create directory;
- rename;
- move within the project;
- delete file/directory with application-styled confirmation where appropriate;
- upload;
- drag-and-drop upload;
- download file;
- download directory/project as archive.

### 11.3 Hidden and generated files

The tree shows hidden and generated files by default, because students kept
looking for a dotfile that was there all along. The **Show hidden/generated
files** control turns them off, which reduces noise from the
generated/dependency directories below.

Examples the control hides:

```text
.git/
node_modules/
.venv/
dist/
build/
target/
__pycache__/
```

The user must have a **Show hidden/generated files** control, on by default.

Hiding a path in the UI must not make it inaccessible to the terminal or coding agent.

### 11.4 Live filesystem events

The workspace agent must monitor project filesystem changes.

Changes made by:

- coding agents;
- shell commands;
- Git;
- uploads;
- editors; or
- another browser connection

should appear in the tree promptly.

Target event latency is defined in the non-functional section.

### 11.5 Project-wide search

Project-wide text search is P0. It is primarily a friction-reduction feature rather than a teaching objective.

The implementation should use `ripgrep` or an equivalent fast workspace-local search mechanism and must:

- search within the selected project by default;
- respect sensible generated/dependency exclusions while allowing the user to include hidden/generated files;
- return file path, line number, matching line, and limited surrounding context;
- allow clicking a result to open the file at the matching line;
- cancel superseded searches;
- avoid blocking the workspace agent or browser on very large repositories;
- enforce project confinement and not follow search paths outside the selected project.

Search must operate on the actual project files and update naturally as agents or tools modify them.

### 11.6 File API and storage

All file work happens in the workspace agent, behind the per-workspace bearer
token of §23.5 and the confinement rule of §11.1 (ADR 0013). The agent exposes
a directory listing, read, write, delete, make-directory and move under
`/projects/:slug`, and the control plane relays each one to the workspace
owner only, under the authorization rules of §5.2; an administrator asking for
a student's file gets a 404.

Writes are conditional. A file's version is a hash of its content, carried as
an ETag; a write must present exactly one of `If-Match` with the version the
client last read, to overwrite, or `If-None-Match: *`, to create. A version
that no longer matches is refused with 412 and the current version, and the
client resolves the conflict (§13.5). A write must not be applied in place: it
lands whole or not at all.

The agent enforces fixed limits: a file the editor opens or saves is at most
2 MiB, an upload at most 50 MiB, and one directory listing returns at most
2,000 entries and says when it was truncated. A larger file uses the download
path of §11.2 rather than the editor (§13.2).

The confinement rule is the one §7.6 already states for projects: the agent
resolves the requested path with realpath and refuses unless the result lies
inside the resolved `~/projects/<slug>`. For a path that does not exist yet the
parent is resolved instead. Files are opened so that the kernel itself refuses
to follow a final symbolic link (§24.6).

## 12. Git integration

### 12.1 Git status

The file tree must display Git state for repositories.

At minimum, distinguish:

- untracked/new;
- modified;
- deleted;
- renamed where available;
- staged/unstaged state where the UI design supports it;
- ignored files when hidden files are shown.

An untracked file's name is drawn in italic and slightly dimmed, so it reads
as not yet part of the repository. Directories are not styled this way: the
status data lists untracked files individually and says nothing about the
tracked files a directory may also hold.

### 12.2 Git source of truth

Git status displayed by the platform must reflect actual repository state.

The platform must not maintain a competing source-control model.

### 12.3 Git operations

P0 does not require a graphical commit/branch/merge client.

Students may use:

- coding agents;
- Git CLI;
- GitHub CLI where installed.

Changes caused by those tools must update the UI.

### 12.4 GitHub

The base workspace should include Git and the GitHub CLI or an equivalent supported authentication workflow.

Authentication may be performed by the student.

The platform should not require the platform operator to possess the student's GitHub credentials.

### 12.5 Automatic recovery must not alter Git

The platform must not create automatic Git commits, branches, tags, or stashes as part of ordinary recovery-point creation.

### 12.6 Diff and change-review view

Diff review is a P0 capability because inspecting agent-created changes is part of the intended agentic-development workflow. The feature is for review and understanding; it is not intended to become a full graphical Git client.

For a tracked modified file, the default comparison must be:

```text
Git HEAD version → current working-tree version
```

The platform should use Monaco Diff Editor or an equivalent mature diff component.

A user must be able to open a file diff from at least:

- the file's Git-status decoration or context action in the file tree; and
- an aggregate project-level **Changes** surface.

The **Changes** surface must list the current repository changes with status and path, for example:

```text
Changes (7)

M  src/app.ts
M  src/auth.ts
A  src/middleware.ts
M  package.json
M  package-lock.json
A  .env.example
D  src/old-auth.ts
```

Selecting an entry must open the corresponding diff in the center pane.

P0 diff behavior must support:

- modified tracked text files: previous `HEAD` content versus current working-tree content;
- new/untracked text files: the current file displayed as added content;
- deleted tracked text files: the `HEAD` version displayed as deleted content;
- renamed files: old path → new path when Git identifies the rename;
- staged and unstaged changes without inventing a source-control state separate from Git;
- binary files: a clear non-text message such as `Binary file changed`;
- files with no `HEAD` baseline, including repositories with no commits, through an understandable added-file presentation.

The diff view must update when relevant filesystem or Git state changes. If a coding agent modifies a file while its diff is open, the view should refresh without requiring a page reload while preserving the user's scroll position and review context where practical.

The platform must place reasonable limits on interactive diff generation. Very large files, generated files, unusually large diffs, or binary content must not freeze the browser or control-plane service. When an interactive diff exceeds configured limits, the UI should explain the limitation and offer an appropriate raw-file or download path.

P0 does **not** require graphical controls for:

- stage/unstage;
- commit;
- branch creation or switching;
- merge conflict resolution;
- discard hunk;
- interactive rebase.

Students may perform those operations through the coding agent or Git CLI. Any resulting changes must be reflected in the Changes surface and file tree.

P1 may add comparison against a recovery point. P2 may allow selection of another Git commit or ref as the comparison baseline.

### 12.7 Agent-session change review

In addition to the Git `HEAD` comparison, P0 must support reviewing changes relative to the baseline created when a Portikus-launched coding-agent session began.

The session review must:

- show files created, modified, renamed, and deleted during the session;
- allow opening individual text-file diffs relative to the session baseline;
- distinguish the session baseline from Git `HEAD`;
- continue to work when the repository was already dirty before the agent session began;
- use the same large-file and binary-file safeguards as the Git diff view.

The UI should make the baseline explicit, for example `Changes since Claude session started`, rather than presenting session changes as Git changes.

### 12.8 Branch, remote, and preservation state

Portikus must make the minimum Git state needed to understand whether work has been preserved visible without becoming a graphical Git client.

P0 should show, when available:

- current branch or detached-HEAD state;
- count of working-tree changes;
- whether commits exist locally that are ahead of the configured upstream remote;
- whether the local branch is behind its upstream;
- whether no upstream remote is configured;
- whether the repository contains unresolved merge conflicts.

An example compact status is:

```text
main • 3 changes • 2 commits ahead
```

Conflict state must be conspicuous and must not be represented as an ordinary modified-file state. Portikus does not need a graphical conflict resolver in P0; the student may ask the coding agent to resolve conflicts or use Git CLI.

The purpose of this status is pedagogical as well as practical: students should be able to distinguish files that merely exist on disk, work committed locally, and work pushed to a remote repository.

## 13. File editing

### 13.1 Editor

P0 should use Monaco Editor or an equivalent embeddable editor with mature syntax support.

The project is not intended to become a complete VS Code clone.

### 13.2 Editing scope

The editor should prioritize:

- text source files;
- `.env`;
- JSON/YAML/TOML;
- configuration files;
- Markdown;
- small scripts.

Large/binary files should open in a viewer or download flow rather than being forced through the text editor.

### 13.3 External modification

If a file changes on disk while open:

- the UI must detect the change;
- the user must not silently overwrite newer content;
- the editor should automatically refresh if there are no conflicting local edits;
- conflicting local edits must trigger an understandable resolution path.

### 13.4 Markdown

Markdown files must support:

- editing the raw Markdown text;
- a rendered preview of the same file;
- both at once, side by side.

A Markdown tab is a split while it is being edited: the raw Markdown in
the code editor on the left and the rendered preview on the right. The
preview is read-only; the raw text is the only place a file is edited, and
the two sides stay on the same line: whichever source line is first on the
left is the first one showing on the right, and scrolling either side
moves the other.

The tab's one Diff button replaces the whole split with this file's
side-by-side diff against the last commit, the same way the Diff button
works on every other file tab. Turning it off brings the split with the
preview back.

### 13.5 Autosave and version-aware writes

Editor autosave is P0. It is a friction-reduction and data-safety feature, not a teaching objective.

The editor must:

- autosave text changes after a short configurable debounce;
- display clear transient state such as `Saving…`, `Saved`, or `Conflict`;
- use version-aware or equivalent conditional writes so stale browser content cannot silently overwrite a newer on-disk version;
- coordinate with filesystem events so changes made by an agent or second browser are not silently overwritten;
- preserve unsaved local text long enough to resolve a detected conflict;
- surface save failures clearly.

An explicit keyboard save command such as `Ctrl/Cmd+S` may force an immediate save, but students should not need to remember to save manually for normal operation.

Per-user preferences. Autosave on or off, the autosave delay, word wrap, the
terminal colour scheme, and the workspace timezone are settings of the
signed-in user, not of the browser. They are stored on the server, read and
written through `GET` and `PUT /me/settings`, and changed in the account menu,
so they follow the student to any browser they sign in from. Word wrap
defaults to on. The terminal colour scheme is dark or light, and it is
deliberately independent of the page appearance: a student in a bright room
may want a light terminal on a dark page, or the other way round. Each
terminal carries its own colour scheme, chosen from that pane's menu and
stored with the terminal; the per-user value is the scheme a new terminal
starts in. The workspace timezone is an IANA zone name, `America/New_York` by
default; it is applied to the container at every start and to each new
terminal, so a change reaches a shell that has not been opened yet.

The page appearance, system, light, or dark, is a per-user preference too,
kept with the others and saved as soon as it is chosen. The browser keeps a
copy for the first paint and for the sign-in page; once the saved value
arrives it wins and refreshes that copy, and the workspace screen waits for
it so the page does not flash to the default.

Screen-reader mode is a per-user preference too, off by default: with it
on, xterm.js takes only typed keys and drops text that arrives without a
key press (an emoji picker, dictation, some on-screen keyboards), and bulk
output renders about half as fast. The default is the one constant
`EDITOR_SETTINGS_DEFAULTS.screenReaderMode` in the contracts package. When
on, every terminal and the check output run in xterm.js screen-reader
mode, and every Monaco editor, the diff editor included, runs with
`accessibilitySupport` "on"; when off, Monaco's support is "off", never
"auto", because a browser cannot detect a screen reader. A change applies
to open terminals and editors without a reload. It is set in Settings or
by the workspace page's first Tab stop, a skip-link-style button that is
hidden until focused, reads "Turn on screen-reader mode" or "Turn off
screen-reader mode", saves the setting at once, and announces the change
from a status region. Settings also has a "Keyboard and screen readers"
section listing the keys that are hard to discover and what xterm.js and
Monaco cannot do (section 25.8).

Profile. Settings opens with a Profile section. The display name, email,
sign-in name, and workspace label come from the institution sign-in and are
read-only. The student may add a GitHub username or https link, one personal
https link, and a PNG or JPEG picture of at most 1 MiB, read through
`GET /me/profile`, changed through `PUT /me/profile`, `PUT /me/picture`, and
`DELETE /me/picture`. The API reads the picture type from its bytes, stores
the picture on the users row, and serves it at `GET /me/picture` to its owner
only. The picture replaces the initials in the account menu button. Links are
shown only as plain anchors with `rel="noopener"`. Nothing in the profile is
used for authorization, and picture bytes are never logged.

## 14. Application preview and port proxying

`docs/BROWSER-HANDLING.md` is the detailed design for this section, for
section 24.7, and for how a command-line tool in the workspace opens a
browser (the URL broker and the remote-browser fallback). It refines
what follows; where it is more specific, it controls. Epic 8 builds
its Part I, Epic 9 its Part II.

### 14.1 Goals

A user must be able to run a service inside the workspace and view it from the browser without configuring SSH tunnels or local proxy software.

### 14.2 No literal local-port requirement

The platform does not need to make remote port 3000 appear as the user's local machine `localhost:3000`.

Instead, it must provide an authenticated browser URL mapped to the workspace port.

### 14.3 Separate security origin

The trusted workspace application and untrusted student previews must use
different browser origins: a preview is always its own host, never a path
under the workspace application.

Recommended: put previews under a different registrable domain from the
workspace application, or under a name registered on the Public Suffix
List, so that the browser treats each preview as a different site.

```text
portikus.example.edu
*.portikus-preview.net
```

ADR 0018 defers that separate registrable domain until a later task tests
it across the supported browsers, so the first deployments use the
same-registrable-domain arrangement below with the protections listed
under it.

Many institutions cannot issue a second domain, so a deployment may put
previews under the same registrable domain:

```text
portikus.example.edu
<workspace-label>-3000.preview.portikus.example.edu
```

The workspace label is the one Epic 8 derives from the login username;
`docs/BROWSER-HANDLING.md` section 8 gives the exact host format.

In that arrangement two hosts count as the same site, which weakens two
browser protections: the SameSite cookie rule no longer stops a preview
page from making requests to the workspace application, and any host under
the domain can set a cookie with a `Domain` attribute that the browser then
sends to the workspace application ("cookie tossing"). The platform must
therefore not rely on SameSite or on origin separation alone:

- the session cookie carries the `__Host-` prefix, which forbids a `Domain`
  attribute, so it is sent only to the exact workspace-application host and
  cannot be set or replaced from a preview host (section 24);
- the API checks the `Origin` header on every state-changing request and on
  the WebSocket upgrade, and refuses any origin other than the workspace
  application's own;
- the workspace application reads no cookie other than its own session
  cookie.

The exact DNS names are deployment-specific. A preview application must
not inherit privileged workspace-application cookies in either arrangement.

### 14.4 Authenticated access

Every preview request must pass through platform authorization.

The gateway must verify that:

- the requester is authenticated;
- the requester is authorized for the target workspace;
- the target workspace belongs to or is intentionally shared with that requester;
- the requested port is allowed.

There must be no unauthenticated public-preview mode in P0.

### 14.5 WebSockets and modern dev servers

The preview proxy must support:

- HTTP;
- HTTPS-to-proxy with HTTP to workspace if desired;
- WebSockets;
- streaming responses;
- hot-module-reload connections.

### 14.6 Preview tab

The center pane must support an application Preview tab.

The user may:

- select or enter a listening port;
- open the service within the center pane;
- open it in a separate browser tab/window.

### 14.7 Port discovery

The workspace agent should detect listening TCP ports.

The UI may surface likely development ports automatically.

P0 should favor unprivileged application ports, normally `1024-65535`.

### 14.8 Inactive preview

After a full workspace restart, a saved preview tab must fail gracefully until the application is restarted.

Example behavior:

```text
Nothing is currently listening on port 3000.
Start your application to reconnect this preview.
```

### 14.9 Terminal linkification and navigation

Terminal linkification is P0 because it removes repeated navigation friction from testing and debugging workflows.

Portikus should recognize at least:

- file/line references emitted by common tools, such as `src/auth.ts:73`, and open the referenced project file at that line;
- local development URLs such as `http://localhost:3000` or `http://127.0.0.1:8000` and convert them into the authenticated preview route for the corresponding workspace port.

Link handling must respect project confinement and preview authorization. Printed text must never be allowed to construct an arbitrary privileged control-plane URL or escape the selected workspace/project security boundary.

## 15. Recovery points

### 15.1 Purpose

Recovery points protect against accidental or agent-driven project changes without changing Git history.

### 15.2 Storage location

Recovery data must live outside the project's visible working tree.

### 15.3 Format

The initial implementation may use compressed project archives, preferably a fast modern compression format such as `tar.zst`.

The recovery format is an implementation detail and may later be replaced or supplemented by storage-native snapshots.

### 15.4 Contents

Recovery points should preserve files required to put the project back into the previous state, including ignored files such as `.env` when permitted by policy.

The system must not assume `.gitignore` identifies files that should be excluded from backup.

### 15.5 Exclusions

The platform should support a recovery exclusion mechanism, for example:

```text
.workspaceignore
```

Default exclusions may include dependency/build directories such as:

```text
node_modules/
.venv/
dist/
build/
target/
__pycache__/
```

The platform should preserve configuration and source files even when ignored by Git unless explicitly excluded.

### 15.6 Triggers

P0 recovery points should be created:

- periodically while an active project has changed;
- before project archive;
- before a platform-initiated destructive/reset action;
- on explicit user request.

Default periodic interval should be configurable. Fifteen minutes is a reasonable initial default, but implementations may debounce or skip creation when no filesystem changes occurred.

As built (Epic 10, §15.10): a point is also made before a restore, before an
administrator rebuilds the workspace, and before a Claude Code or Codex
session starts (§10.9). Reset Docker makes no point: it touches neither
`~/projects` nor anything a point holds, so a point would protect nothing.
A rebuild is the "platform-initiated destructive action" this list means.

### 15.7 Retention

Retention must be configurable and bounded by quota.

The initial pilot should keep a useful rolling history without allowing unlimited recovery growth.

### 15.8 Restore

Restoring a recovery point must:

- clearly identify the project and timestamp;
- warn that current files will be replaced;
- create a recovery point of the current state before restoration when practical;
- not alter Git through hidden commits.

### 15.9 File-level recovery history

P1 may expose earlier versions of an individual file derived from project recovery points.

This should allow a user to inspect or restore one file without rolling back the entire project. It must reuse the recovery system and must not create a separate hidden source-control mechanism.

### 15.10 Recovery storage and operations

Each workspace has a third Incus volume, `<instance>-recovery`, beside
`-home` and `-docker`. It is sized from `WORKSPACE_RECOVERY_SIZE_GIB`
(default 3, §19.1), mounted at `/var/lib/portikus/recovery`, and owned by
uid 1000 with mode 0700. The controller adds it to an older workspace at
that workspace's next start; if that step fails, the start still succeeds.
Rebuilds and Reset Docker leave it alone (ADR 0020).

A point is `/var/lib/portikus/recovery/<projectId>/<pointId>.tar.zst`,
mode 0600, keyed by project id so a rename does not orphan it. Its
`recovery_points` row (§26) holds the project, workspace, reason, time,
creator, size, SHA-256, a fingerprint of the tree, and an expiry. The
reasons are `periodic`, `manual`, `before-archive`, `before-restore`,
`before-rebuild`, and `agent-session`.

The workspace agent makes and restores archives, as it does every other
filesystem operation (ADR 0010). It walks the project with `lstat`, never
following a link, and passes an explicit file list to GNU `tar`, whose
output goes through Node's built-in zstd compressor. An archive holds
everything under the project, `.git`, `.env`, and Git-ignored files
included, minus the §15.5 defaults and whatever `.workspaceignore` at the
project root adds in `.gitignore` syntax; `!pattern` there re-includes a
default. Making a point never runs a Git command that writes, so HEAD, refs,
the stash, the reflog, and the index are untouched (§12.5). The agent holds
one lock per project and answers 409 `BUSY` to a second operation on it.

The fingerprint is a hash over the sorted path, type, size, mtime, mode,
and link target of every included entry. A periodic check passes the
latest point's fingerprint, and the agent writes nothing when the new one
matches. The worker runs periodic checks in a loop of its own, every
`RECOVERY_SWEEP_SECONDS` (default 60), over running workspaces and their
active, non-missing projects; a project is due when
`projects.recovery_checked_at` is older than `RECOVERY_INTERVAL_SECONDS`
(default 900). Retention gives every point an expiry of
`RECOVERY_RETENTION_DAYS` (default 14). After expiry, the worker deletes
points oldest first until the workspace's stored total is at or below 90%
of its allowance. The newest point of each project is never deleted.

Restore checks the archive's SHA-256 against the row and refuses a
mismatch, then lists the members and refuses any absolute or `..` path
(§24.6). The agent extracts into `~/projects/.portikus-restore-<pointId>`,
a name discovery ignores, deletes every non-excluded entry of the project
without following links, moves the extracted entries in, and removes the
staging directory. The project directory itself is never replaced, because
its inode is the project's identity (§7.6). Excluded paths such as
`node_modules` are left as they are. The safety point made first is
required, except when it fails because recovery storage is full; then the
student may confirm again and restore without it.

The control plane exposes, for the workspace owner only,
`GET` and `POST /workspaces/:id/projects/:projectId/recovery-points` and
`POST .../recovery-points/:pointId/restore`. An administrator gets a 404,
because restoring a student's files would be silent impersonation (§20.2).
Listing works while the workspace is stopped; creating and restoring need
it running. Archiving a project makes a best-effort point first; permanent
delete removes the project's points. Launching Claude Code or Codex waits
up to 30 seconds for an `agent-session` point, then launches anyway, and
stores the point's id on the terminal. A restore is audited as
`recovery.restored`; making a point is logged, not audited. File names and
paths never go in logs or audit rows.

## 16. Docker behavior

### 16.1 Docker isolation

Each workspace has its own Docker daemon and Docker data.

The host Docker socket, if any, must not be mounted into student workspaces.

### 16.2 Docker persistence

`/var/lib/docker` should use a dedicated persistent, quota-controlled storage allocation where practical.

Docker data should survive ordinary workspace stop/start.

### 16.3 Restart behavior

The platform does not need to guarantee that inner containers resume after the outer workspace starts.

Docker restart policies may function according to normal Docker semantics.

Students or agents may rerun:

```text
docker compose up
```

as part of normal work.

### 16.4 Reset Docker

The platform must provide an administrative or student-safe **Reset Docker** operation that can:

- stop the workspace as needed;
- discard the user's Docker data store;
- recreate clean Docker storage;
- preserve `~/projects`;
- preserve ordinary user files.

This action must use an application-styled confirmation and must be auditable.

As built (Epic 10, ADR 0021): the owner or an administrator calls
`POST /workspaces/:id/reset-docker`, which answers 202 and sets the
workspace's pending operation to `reset-docker`. The worker stops the
workspace if it is running, asks the controller to replace the Docker
volume, clears the operation, and starts the workspace again if it should
be running. With the instance stopped, the controller removes the `docker`
device with an ETag-guarded update, deletes the volume named exactly
`<instance>-docker`, creates a new one at `WORKSPACE_DOCKER_SIZE_GIB`, and
puts the device back; each step can be retried. The home and recovery
volumes are never touched. The request and its result are audited as
`workspace.docker_reset_requested`, then `workspace.docker_reset` or
`workspace.docker_reset_failed`. A second request while one is pending gets
409 `OPERATION_PENDING`.

### 16.5 Docker status

The UI should expose understandable Docker resource/status information without requiring the student to parse daemon internals.

## 17. Workspace reset and rebuild

### 17.1 Reset goals

A student may damage the workspace operating system while retaining valid project files.

The platform must provide a recovery path that does not require manual container repair.

### 17.2 Rebuild workspace

An administrator, and potentially a student through a guided P1 flow, may rebuild the workspace from the current approved base image.

A rebuild should:

- preserve the user's home/projects volume by default;
- optionally preserve Docker data;
- replace the system/root filesystem;
- reinstall/restore the workspace agent;
- reapply platform-required configuration;
- record the operation.

As built (Epic 10, ADR 0021): an administrator calls
`POST /admin/workspaces/:id/rebuild` with `{ "resetDocker": boolean }`. It
answers 202 and sets the pending operation to `rebuild` or
`rebuild-reset-docker`. If the workspace is running, the worker makes a
`before-rebuild` recovery point of each active project, then stops it. The
controller calls Incus's native rebuild from the current image alias; the
instance keeps its own devices, so home, projects, and recovery survive, and
Docker survives unless it was asked to be reset. The new image fingerprint
is stored as the workspace's image version, and the next start pushes the
agent token, hostname, timezone, and profile as any start does. A rebuild
also runs from `error` when the instance exists. It is audited as
`workspace.rebuild_requested`, then `workspace.rebuilt` or
`workspace.rebuild_failed`. The guided student rebuild stays P1.

### 17.3 User-installed system packages

Packages installed with `sudo apt install` persist across ordinary stops and starts because the same workspace root is reused.

They are not guaranteed to survive a deliberate workspace rebuild.

The UI/documentation must make this distinction clear.

P1 may support a declarative persistent customization mechanism such as:

```text
~/.workspace/packages.txt
~/.workspace/setup.sh
```

## 18. Verification, running services, and workspace status

### 18.1 Checks and test execution

Basic verification is P0 because independent checking is part of the intended agentic-development workflow. Portikus should reinforce that an agent's claim that software works is not sufficient evidence.

P0 must support project-level checks through one or more configured commands. Typical examples include:

```text
npm test
pytest
npm run lint
npm run build
```

Requirements:

- checks must execute as real commands inside the selected project;
- command output must remain visible to the student, preferably in an ordinary terminal or a terminal-backed check surface;
- Portikus must present an understandable running/pass/fail result without hiding the actual command or output;
- templates may provide check definitions;
- projects without configured checks must remain usable;
- an agent may run the same commands directly, and resulting state should be reflected when practical;
- test execution must obey ordinary workspace resource limits.

P0 does not require a universal test-framework parser, per-test graphical explorer, code-coverage UI, or IDE-style test debugging.

### 18.2 Running services and ports

A compact **Running** surface is P0 learning-support infrastructure. It should help a student understand the difference between files on disk and processes that are actually running.

The surface should show development-relevant runtime state such as:

```text
3000  node        Preview
5432  postgres    Docker
8000  python      Preview
```

P0 should include:

- detected listening ports;
- enough process/container identity to explain what is using the port when safely available;
- whether the service is associated with inner Docker where detectable;
- an authenticated **Open preview** action for eligible ports;
- clear indication when a previously saved preview is no longer running.

The Running surface is not intended to replace `ps`, `top`, `docker ps`, or a general process manager.

### 18.3 Workspace status

A compact status surface should show information useful to non-technical users.

P0 should include:

- workspace state: starting/running/stopping/stopped/error;
- storage usage;
- basic CPU/memory usage where available;
- Docker health;
- agent availability/authentication status where safely detectable;
- active preview ports or a link to the Running surface;
- configured check/test status when a recent result exists.

Error messages must suggest a next action where possible.

### 18.4 Recognized run/build commands

P1 may detect or configure common project commands, for example scripts in `package.json`, `Makefile` targets, or template-provided commands, and expose actions such as **Run**, **Test**, or **Build**.

When invoked, Portikus must execute the authentic underlying command in a visible terminal context rather than introducing an opaque proprietary launch mechanism.

## 19. Resource controls

### 19.1 Configurable quotas

All resource defaults must be configuration, not hard-coded assumptions.

Reasonable initial pilot defaults:

- CPU limit: 4 vCPU;
- memory limit: 6 GiB;
- persistent home/projects: 25 GiB;
- Docker data: 20 GiB;
- recovery storage: 3 GiB;
- process/PID limit: configurable defensive ceiling.

These values are starting points and must be validated by pilot telemetry.

### 19.2 Quota feedback

At approximately 80% utilization, the UI should warn the user.

Near a hard limit, the UI should identify the major storage class involved, e.g.:

- Projects & home;
- Docker;
- Recovery.

As built (Epic 10): the agent's usage sample reports `storage.home`,
`storage.docker`, and `storage.recovery`, each used and total bytes from
`statfs` on its mount, or null when the mount is missing. A stopped
workspace has nothing to measure, and the UI says the figures are available
when it runs. The status bar warns at 80% of any class and names it. At 95%
the message also names a next step: Reset Docker or `docker system prune`
for Docker, automatic removal of older points for Recovery, and deleting
files for Projects & home. Quotas are environment configuration in this
epic; changing them at runtime is Epic 11.

### 19.3 Denial behavior

Resource exhaustion must fail safely.

One student's CPU, memory, storage, process count, or Docker workload must not materially degrade other users beyond the capacity limits of the shared host.

## 20. Administration

### 20.1 Admin capabilities

P0 administration must support:

- list users/workspaces;
- view workspace state;
- view last connection/activity time;
- start workspace;
- stop workspace;
- restart workspace;
- rebuild workspace;
- reset Docker;
- inspect quota usage;
- adjust quotas;
- adjust the disconnect grace period globally and per user;
- inspect active preview ports;
- inspect base-image version;
- view recent lifecycle/audit events;
- archive or disable a user workspace;
- revoke platform access.

### 20.2 User impersonation

P0 must not require silent administrator impersonation of a student session.

P2 workspace-sharing/support access must be explicit and auditable.

### 20.3 Break-glass access

Operators may have host/Incus-level diagnostic access.

Break-glass activity should be limited to authorized administrators and should not become the ordinary management path.

## 21. Infrastructure as cattle

### 21.1 Principle

The platform VM and its infrastructure configuration must be disposable and reproducible.

A replacement VM should be able to be constructed from:

- source-controlled scripts/configuration;
- approved base images;
- environment-specific variables/secrets; and
- restored persistent data.

### 21.2 Infrastructure repository

The project repository should contain an explicit infrastructure area. Example:

```text
infra/
├── host/
│   └── Pop!_OS/libvirt bootstrap
├── vm/
│   ├── VM definition
│   ├── cloud-init
│   └── Debian configuration
├── incus/
│   ├── storage
│   ├── network
│   ├── profiles
│   └── project/policy configuration
├── workspace-image/
│   ├── build scripts
│   └── package/tool manifests
├── services/
│   ├── control-plane deployment
│   ├── database
│   └── reverse proxy
└── tests/
    └── infrastructure smoke tests
```

Exact tool choice may differ, but the conceptual separation is required.

### 21.3 Host bootstrap

Automation must be able to prepare a supported Pop!_OS host for the pilot.

At minimum it should verify/install:

- KVM/QEMU;
- libvirt;
- required networking tools;
- VM image tooling;
- automation dependencies.

The script must be safe to rerun or clearly detect already-completed steps.

### 21.4 VM creation

The platform VM must be creatable without manual installation.

Preferred approach:

- declarative or scripted libvirt domain definition;
- Debian cloud image or unattended install;
- cloud-init for first boot;
- configuration management for convergence.

A practical tool combination may include:

- shell/Make;
- Terraform/OpenTofu with libvirt where stable for the deployment;
- cloud-init;
- Ansible.

No one specific IaC product is mandatory. Reproducibility is mandatory.

### 21.5 VM disks

Automation must create/attach:

1. an OS disk;
2. a workspace data disk.

The workspace data disk must be initialized and assigned to the Incus storage layer automatically.

### 21.6 VM configuration

Configuration automation must install and configure:

- Incus;
- LVM thin storage;
- Incus networking;
- required kernel modules/settings;
- base packages;
- control-plane dependencies, and the control plane itself, installed from
  the versioned package rather than built on the VM;
- database;
- reverse proxy;
- metrics/logging components;
- backup tooling.

### 21.7 Workspace base image

The workspace image must be built reproducibly from source-controlled configuration.

It should include at least:

- systemd-capable Linux userspace;
- sudo;
- Git;
- GitHub CLI or equivalent;
- Docker Engine;
- Docker Compose;
- Python;
- Node.js;
- npm;
- common build tools;
- common command-line utilities;
- Claude Code;
- Codex;
- tmux or the selected PTY persistence layer;
- workspace-agent and service definition.

Additional language runtimes may be added according to course requirements.

### 21.8 Versioned images

Workspace images must be versioned.

The platform must record which image version a workspace was created/rebuilt from.

The system must allow a new image to be built and validated without immediately replacing all existing student workspaces.

### 21.9 No manual snowflakes

Routine changes must be captured in code.

If an emergency manual change is made to:

- the VM;
- Incus;
- the reverse proxy;
- a workspace image;
- a system service; or
- network/security configuration,

the change must be either reverted or incorporated into the source-controlled automation before it becomes expected platform state.

### 21.10 One-command/operator workflow

The repository should expose simple documented operator entry points. A target conceptual workflow is:

```text
make bootstrap-host
make build-vm
make configure-vm
make build-workspace-image
make deploy-app
make smoke-test
```

The exact commands may differ, but each step must be automatable and documented.

### 21.11 Destructive rebuild test

Before pilot launch, the team must prove that it can:

1. destroy a non-production platform VM;
2. recreate it from automation;
3. install the control-plane package from the newest release;
4. restore required application metadata and persistent data;
5. start a test workspace;
6. run Docker inside it;
7. launch a coding agent;
8. open a proxied application preview.

This is an acceptance criterion, not merely documentation.

## 22. Workspace image updates

### 22.1 Ordinary start/stop

Ordinary workspace start/stop must use the existing workspace root and must not silently change system packages.

### 22.2 Image release

A new approved base image may be introduced between terms or during a controlled maintenance event.

Existing workspace roots do not need to rebase automatically.

### 22.3 Rebuild-based upgrade

The supported upgrade path is:

1. stop workspace;
2. create recovery point/backup;
3. rebuild system root from approved image;
4. reattach persistent user data;
5. optionally reattach Docker data;
6. validate workspace agent;
7. start workspace.

This may require a maintenance window.

## 23. Networking

### 23.1 Workspace egress

Student workspaces require broad Internet egress for:

- package registries;
- GitHub;
- coding-agent APIs;
- documentation;
- Docker registries;
- external APIs used in coursework.

### 23.2 Management-network isolation

"Full Internet access" must not imply unrestricted access to platform management networks.

Student workspace egress must deny or tightly control access to:

- the platform VM's privileged management interfaces;
- the Pop!_OS host;
- Incus control interfaces;
- other student workspaces except explicitly permitted services;
- cloud-instance metadata endpoints;
- link-local management targets;
- configured private infrastructure CIDRs.

Required DNS/NTP/gateway services may be allowlisted.

### 23.3 Workspace-to-workspace traffic

Direct student workspace-to-workspace traffic should be denied by default.

Student collaboration should initially occur through Git/GitHub rather than shared container networks.

### 23.4 Inbound traffic

No student workspace port may be directly exposed to an external network.

Inbound application access must traverse the authenticated preview gateway.

### 23.5 Control-plane communication

Communication between the control plane and workspace agent must be mutually authenticated or otherwise protected by a strong per-workspace trust mechanism.

A student must not be able to impersonate another workspace agent.

## 24. Security requirements

Security is a release requirement, not a post-pilot enhancement.

### 24.1 Trust boundaries

At minimum, treat the following as separate trust zones:

1. browser/user;
2. trusted control plane;
3. preview gateway;
4. student workspace;
5. student inner Docker containers;
6. platform VM/Incus;
7. Pop!_OS host;
8. external Internet.

### 24.2 Student code is untrusted

All code in a student workspace must be considered untrusted, including code generated by a coding agent.

The system must assume it may:

- bind arbitrary ports;
- attempt privilege escalation;
- consume excessive resources;
- probe the network;
- serve malicious JavaScript;
- create symlinks;
- manipulate filenames;
- produce extremely large files;
- intentionally or accidentally attack platform services.

### 24.3 Browser-origin isolation

Student preview content must not share a trusted origin with the control-plane UI.

Authentication cookies for the control plane must not be available to preview JavaScript.

Preview embedding must use appropriate iframe sandboxing and content-security policy where compatible with development workflows.

### 24.4 Container isolation

Student LXC containers must be unprivileged.

Unique UID/GID maps should be used.

Do not mount sensitive host paths.

Do not mount Incus or host-Docker sockets.

Do not grant arbitrary host devices.

### 24.5 Nested Docker

Nested Docker privileges must terminate at the workspace boundary.

Root inside an inner Docker container must not imply root on:

- the outer LXC host mapping;
- the platform VM;
- the Pop!_OS host.

### 24.6 File API security

All file APIs must prevent:

- `..` traversal;
- symlink escape;
- encoded-path escape;
- archive extraction traversal/zip-slip;
- cross-project access unless deliberately supported;
- cross-user access.

### 24.7 Preview gateway security

The preview gateway must:

- authenticate every request;
- authorize workspace ownership/access;
- validate target port;
- prevent proxying to arbitrary platform IPs;
- prevent target-host manipulation;
- support WebSockets safely;
- apply reasonable request/body/time limits while preserving development usability.

### 24.8 Secrets

Sensitive credentials must not appear in:

- platform logs;
- browser telemetry;
- audit-event payloads;
- error traces;
- project metadata.

Recovery data may contain `.env` and must therefore be treated as sensitive user data.

### 24.9 Storage security

At minimum:

- filesystem ownership and container isolation must prevent cross-user reads;
- recovery archives must have restrictive permissions;
- backups must preserve access controls;
- production deployments must provide encryption at rest at the host, block-device, volume, or backup layer.

For a controlled pilot, any accepted encryption-at-rest gap must be documented explicitly.

### 24.10 Transport security

Production/pilot network access must use TLS for browser-facing interfaces.

Internal traffic carrying credentials or privileged control messages must be protected appropriately for the deployment network.

### 24.11 Audit logging

Audit events should include:

- authentication success/failure;
- authorization changes;
- workspace provision/start/stop/rebuild;
- Docker reset;
- quota changes;
- recovery restore;
- project archive;
- admin actions;
- preview authorization failures;
- break-glass administrative actions where practical.

Audit logs must not contain secrets or full agent prompts by default.

### 24.12 Dependency/security maintenance

The project must define a process for:

- base-image patching;
- dependency updates;
- vulnerability review;
- rebuilding workspace images;
- revoking compromised credentials;
- updating coding-agent CLIs.

## 25. Non-functional requirements

### 25.1 Performance

Initial targets:

- control-plane page shell visible within 2 seconds on a normal broadband connection after authentication, excluding identity-provider delay;
- stopped workspace ready for browser connection within **10 seconds p95** on the pilot host under expected load;
- terminal keystroke echo perceived as interactive, target under 150 ms platform-added latency on the local/institutional network;
- filesystem changes reflected in UI within **1 second p95**;
- Git decorations refreshed within **2 seconds p95** after a relevant filesystem event;
- the Changes surface refreshed within **2 seconds p95** after a relevant filesystem/Git event;
- ordinary text-file diffs open within **1 second p95** for repositories and files within supported interactive diff limits;
- project search should begin returning ordinary results within **1 second p95** for repositories within supported search limits;
- autosave acknowledgement should ordinarily complete within **1 second p95** after the debounce interval on an unloaded pilot system;
- listening-service state should refresh within **2 seconds p95** after a relevant process/port change;
- preview available within **2 seconds** after the gateway recognizes a listening service;
- project switching UI response within **500 ms** excluding unusually large repository scans.

Targets should be measured and revised from pilot telemetry.

### 25.2 Capacity

Pilot design target:

- at least 100 provisioned student workspaces;
- at least 25 concurrently active workspaces on appropriately sized pilot hardware.

The architecture must not encode these numbers as hard limits.

### 25.3 Reliability

A browser disconnect must not immediately kill a workspace process.

A platform service restart should not corrupt student files.

A control-plane failure must not silently destroy workspaces.

A host/VM failure may terminate running processes in P0, but persisted data must remain recoverable according to backup policy.

### 25.4 Availability

High availability is not required for P0.

A single pilot VM is acceptable.

The system must fail clearly rather than presenting stale or misleading workspace state.

### 25.5 Data durability

User project data and platform metadata require backup.

P0 should implement:

- regular PostgreSQL backup;
- regular persistent user-data backup;
- backup of recovery-point metadata/data as policy requires;
- infrastructure code in source control;
- documented restore procedure.

At least one restore exercise must be completed before pilot launch.

### 25.6 Observability

The platform must expose sufficient logs and metrics to diagnose:

- workspace start failures;
- workspace stop failures;
- Incus errors;
- workspace-agent connectivity;
- proxy errors;
- authentication/authorization failures;
- storage pressure;
- memory pressure;
- CPU saturation;
- Docker reset/rebuild failures.

Metrics should support capacity planning without exposing student source code or prompts.

### 25.7 Maintainability

Major subsystems should have clear interfaces.

In particular, isolate:

- workspace provider/lifecycle operations;
- authentication provider;
- preview routing;
- recovery storage;
- agent launch definitions;
- infrastructure configuration.

A future `WorkspaceProvider` abstraction should conceptually support operations such as:

```text
create()
start()
stop()
restart()
rebuild()
snapshotOrBackup()
setResources()
getStatus()
getMetrics()
destroy()
```

P0 may implement only `IncusWorkspaceProvider`.

### 25.8 Accessibility

The student UI should target WCAG 2.2 AA for platform-owned controls.

Terminal and code-editor accessibility constraints should be documented where third-party components impose limitations.

Keyboard navigation is required for primary application controls.

### 25.9 Browser support

P0 should support current versions of:

- Chrome/Chromium;
- Edge;
- Firefox.

Safari support is desirable but may be P1 if terminal/editor behavior differs materially.

### 25.10 Privacy

Collect only operationally necessary user information.

Do not record coding-agent prompts, terminal command history, or project source centrally unless a specific feature requires it and users are informed.

Institutional deployments must be able to define data-retention policy.

## 26. Control-plane data model

The exact schema is implementation-defined, but the platform must represent at least:

### User

- stable platform user ID;
- identity-provider subject;
- display information needed by UI/admin;
- role(s);
- authorization state.

### Workspace

- workspace ID;
- owner user ID;
- Incus instance identifier;
- lifecycle state;
- image version;
- quota configuration;
- creation/update timestamps;
- last active connection timestamp;
- shutdown deadline if scheduled.

### Project

- project ID;
- workspace ID;
- slug;
- display name;
- path;
- state: active/archived;
- creation source;
- saved layout.

### Terminal metadata

- terminal ID;
- project ID;
- type: shell/Claude/Codex/etc.;
- display name;
- last working directory;
- layout position;
- runtime attachment state.

### Agent session metadata

- agent session ID;
- project ID;
- terminal ID where applicable;
- agent type;
- start/end timestamps;
- baseline/recovery reference used for session-change review;
- runtime state where safely detectable.

### Check result metadata

- project ID;
- check identifier/name;
- command definition reference;
- start/end timestamps;
- result: running/passed/failed/error;
- terminal/session reference for output.

### Preview metadata

- project ID;
- workspace ID;
- port;
- display name;
- saved tab state.

### Recovery point

- project ID;
- timestamp;
- storage location;
- size;
- trigger/reason;
- retention/expiry metadata.

### Audit event

- actor;
- target;
- action;
- timestamp;
- result;
- safe metadata.

## 27. API principles

The UI should communicate with the platform through documented APIs.

Requirements:

- authorization enforced server-side;
- no client-side-only access control;
- stable resource identifiers;
- idempotency for lifecycle operations where practical;
- explicit asynchronous operation states for slow actions;
- structured error codes plus human-readable messages;
- WebSocket/event channel for live terminal/file/workspace events;
- API schemas suitable for code generation where practical.

OpenAPI or an equivalent machine-readable schema is strongly preferred for HTTP APIs.

## 28. Error handling and user messaging

Errors should be expressed in user terms first and implementation terms second.

Example:

```text
Your workspace could not start because its storage allocation is full.
Docker is using 19.8 GB of your 20 GB Docker quota.

[ Clean up Docker ] [ View details ]
```

rather than only:

```text
ENOSPC
```

Technical details should remain available for administrators and debugging.

## 29. Epics and rough implementation effort

The following breakdown is intended for planning by one strong AI-assisted engineer. It is not a contractual schedule.

### Epic 0 — Repository, architecture, and development conventions
**Estimate:** 2–3 engineer-days

Includes:

- monorepo/repository structure;
- coding standards;
- API/schema approach;
- local development setup;
- CI baseline;
- architecture decision records;
- configuration strategy.

Acceptance:

- a new engineer/agent can identify subsystem boundaries;
- lint/test/build run from documented commands;
- secrets are not committed.

### Epic 1 — Reproducible pilot infrastructure
**Estimate:** 4–6 engineer-days

Includes:

- Pop!_OS prerequisite/bootstrap automation;
- KVM/libvirt setup verification;
- Debian VM automated build;
- OS + data virtual disks;
- unattended/cloud-init boot;
- VM configuration management;
- Incus installation;
- LVM-thin storage;
- Incus network/profile/project configuration;
- reproducible destruction/recreation.

Acceptance:

- a fresh supported Pop!_OS host can create the platform VM from documented automation;
- no interactive Debian installation is required;
- infrastructure smoke tests pass.

### Epic 2 — Workspace base image and nested Docker
**Estimate:** 4–5 engineer-days

Includes:

- reproducible workspace image;
- toolchain packages;
- Claude Code/Codex installation;
- Docker inside unprivileged LXC;
- unique ID mapping;
- resource profile;
- persistent home and Docker volumes;
- workspace-agent service bootstrap.

Acceptance:

- provision workspace;
- `sudo` works inside it;
- `docker run hello-world` works;
- ordinary student root cannot access host/Incus resources.

### Epic 3 — Control-plane workspace lifecycle
**Estimate:** 3–4 engineer-days

Includes:

- Incus provider abstraction;
- provision/start/stop/restart;
- first-use provisioning;
- workspace health state;
- connection counting;
- 10-minute disconnect timer;
- graceful shutdown;
- persisted lifecycle metadata.

Acceptance:

- workspace starts on login;
- remains running during grace period;
- stops after grace period;
- reconnect cancels shutdown.

Known gaps after Epic 3, to be closed later:

- The worker sweep is serial, so one slow start delays the timers of other
  workspaces. Revisit before the 25-concurrent-workspace target in §25.2.
  Tracked in `docs/BACKLOG.md`.
- There is no re-provision path after a failed create; the row stays in
  `error` and an operator has to clear it. Tracked in `docs/BACKLOG.md`.
- OpenAPI generation from the Zod contracts (ADR 0003) is not wired up yet.
  Tracked in `docs/BACKLOG.md`.
- When the controller is unreachable the worker records an audit event, but
  the API still reports the last known state instead of marking it
  unverified. Tracked in `docs/BACKLOG.md`.
- Deployment copied the source tree to the VM and built it there, with no
  way to roll back. Closed by Epic 3.5.

### Epic 3.5 — Control-plane packaging as a Debian package
**Estimate:** 1–2 engineer-days
**Status:** landed.

Replaced the earlier copy-the-source-and-build deployment with the versioned
`.deb` decided in ADR 0007 (see STACK.md §22 and §30).

Includes:

- an `nfpm` configuration that packs the pnpm production build of the API,
  worker, and workspace controller into one `portikus` package;
- the package owns the service users, `/etc/portikus`,
  `/var/lib/portikus`, and the three systemd units;
- a CI job that builds the package and publishes it as a GitHub release
  when an epic branch merges into `main`, or when run by hand from `main`,
  with a version derived from the repository;
- the `portikus` Ansible role installs the newest release by default, with
  `PORTIKUS_VERSION` as the rollback override, and renders only environment
  files and secrets;
- the `node` role installs the runtime only, no pnpm or build toolchain;
- `make deploy-app` builds the package locally and installs it on the VM;
- the `portikus-api` unit runs the database migrations from its
  `ExecStartPre`, replacing `make db-migrate`. The unit rather than the
  package's `postinst`, so migrations run when the service starts and not
  when a file is unpacked;
- the `portikus` Ansible role stops creating the service users,
  `/etc/portikus`, `/var/lib/portikus`, and the systemd units, because the
  package owns them and no resource should have two owners (STACK.md §32);
- documentation of the release and rollback procedure in `infra/README.md`.

Acceptance:

- `make configure-vm` on a fresh VM installs the package and leaves the
  three units enabled, with no Node build step on the VM;
- installing the previous version rolls the control plane back;
- the Epic 3 smoke-test block passes against the packaged install;
- `.rpm` is out of scope until a non-Debian host is supported.

Deferred:

- an `.rpm` build, until a non-Debian host is supported. `nfpm` can emit one
  from the same configuration;
- an apt repository. Ansible downloads the release asset from GitHub
  instead, which is enough for one platform VM.

### Epic 4 — Authentication and authorization
**Estimate:** 2–3 engineer-days

Includes:

- OIDC;
- student/admin roles;
- group/claim authorization mapping;
- session security;
- WebSocket authorization.

Acceptance:

- unauthorized users cannot provision or connect;
- one student cannot access another student's workspace.

### Epic 5 — Workspace agent and terminal transport
**Estimate:** 4–5 engineer-days

Includes:

- agent protocol;
- PTYs;
- tmux/session persistence during disconnect grace;
- xterm.js transport;
- multiple terminals;
- project working directories;
- file/line terminal linkification;
- localhost URL → authenticated preview linkification;
- multi-client event behavior.

Acceptance:

- terminal survives browser refresh/disconnect inside grace period;
- second authorized browser sees same workspace/session;
- common file/line references open the correct project file;
- localhost development links route through the authenticated preview gateway;
- full workspace stop ends processes cleanly.

Notes on scope. Linkification in Epic 5 is detection and routing only: a
file/line reference navigates to `/workspaces/:id/files?path=…&line=N` and a
localhost URL navigates to `/workspaces/:id/preview/PORT/`. Both routes
answered 501 until the files UI landed in Epic 7 and the preview gateway in
Epic 8, so the two link acceptance criteria above were proven in those epics
rather than here. Terminal splits and pane reordering (§9.3) move to Epic 6,
where the three-pane shell and its layout library arrive. The transport
decisions are recorded in ADR 0009.

### Epic 6 — Core three-pane UI and project management
**Estimate:** 3–4 engineer-days

Includes:

- left/center/right shell;
- terminal splits and pane reordering, moved here from Epic 5;
- project switching;
- new/clone/template;
- default Git initialization for new projects;
- Initialize Git action for non-repository projects;
- rename/duplicate/download/archive;
- discovery of repositories already present under `~/projects`;
- saved per-project layout;
- terminal clipboard handling (copy and paste in the terminal).

Acceptance:

- switching projects restores project-specific UI state;
- project filesystem paths conform to `~/projects/<slug>`.

### Epic 6.1 — Pilot feedback on terminals and projects
**Estimate:** 2–3 engineer-days

Fixes and small features from the first hands-on use of the pilot after
Epic 6, gathered on 2026-09-17. Each item lands as its own pull request into
the epic branch.

Includes:

- terminal input sent in the first moments after attach is queued, not
  dropped, and the smoke test's terminal checks no longer race the agent;
- Ctrl+V and Ctrl+Shift+V paste once (the browser's own paste no longer
  runs alongside the application's);
- the project list refreshes on its own, so a repository created from the
  shell appears without any UI action, and every project row shows its
  folder;
- the terminal title follows the shell's current directory;
- a terminal pane can be dragged onto another pane's edge to reflow the
  split, onto its centre to swap, or onto the tab bar to become its own
  tab, with a drop zone drawn while dragging;
- a terminal revived after a grace-period stop draws its prompt correctly;
- a terminal revived after a grace-period stop takes the ended terminal's
  pane rather than also appearing as a new tab, and ended terminals no
  longer return as tabs;
- the workspace dialog can start, stop and restart the workspace, and its
  rows wrap instead of scrolling sideways;
- a project can be deleted for good from its menu, behind a confirmation that
  requires typing the project's slug;
- the mouse wheel scrolls the terminal's own output, wheel up for older
  lines, behind a thin scrollbar, and still moves a full-screen program
  such as nano a line at a time;
- initializing Git in a project writes a default `.gitignore` when the
  project has none;
- the workspace image ships with the apt package lists in place and with
  `command-not-found` installed, so `sudo apt install <package>` works in a
  fresh workspace without `apt update` first, and typing a command that is
  not installed prints the package that provides it.

Acceptance:

- every user-visible item above has a Playwright case, the default
  `.gitignore` is covered by workspace-agent unit tests, and the smoke test
  passes with no failures on the pilot after the epic is deployed;
- no terminal keystroke is lost between socket open and the first prompt;
- a drag that would exceed the split depth limit leaves the layout as it
  was.

### Epic 7 — Files, Monaco, search, Git status, and change review
**Estimate:** 7–9 engineer-days

Includes:

- live file tree;
- inotify/watch integration;
- Git decorations;
- branch/upstream/ahead-behind/conflict state;
- project-level Changes surface;
- agent-session baseline and session-change review;
- Monaco Diff Editor or equivalent;
- `HEAD` → working-tree diff generation;
- session-baseline → working-tree diff generation;
- added/deleted/renamed/binary-file diff handling;
- live diff refresh;
- large-diff safeguards;
- project-wide `ripgrep` search;
- file CRUD;
- upload/download;
- hidden/generated filtering;
- Monaco editing;
- autosave with version-aware writes;
- Markdown preview;
- external-modification handling.

Acceptance:

- agent/CLI changes appear without reload;
- path traversal tests fail closed;
- project search returns clickable file/line results;
- Git status reflects CLI operations;
- branch, remote preservation, and conflict state are understandable;
- the Changes surface reflects the current working tree;
- selecting a changed text file opens the correct diff against `HEAD`;
- autosave cannot silently overwrite a newer external version;
- new, deleted, renamed, and binary changes produce defined behavior;
- oversized diffs fail gracefully rather than degrading browser responsiveness.

Session change review (§12.7) is built in Epic 9, with the launchers that
create the baseline; its acceptance line moved there.

### Epic 7.1 — Pilot fixes after Epic 7
**Estimate:** 4–5 engineer-days

Fixes and small features from the first hands-on use of the pilot after
Epic 7, gathered on 2026-09-18. Each item lands as its own pull request
into the epic branch by the merger agent.

Includes:

- quieter unit test output, by stubbing canvas and window scrolling in the
  shared jsdom setup, and the CI cache action moved to v5 to clear the Node
  20 deprecation warning (#151, #152);
- the files pane header menu offers the project-root create actions, so an
  empty project can get its first file (#153);
- the workspace image disables the Claude Code self-updater through
  `/etc/profile.d/portikus-agents.sh` (§10; the equivalent Codex setting is
  left for Epic 9, with the rest of agent configuration) (#127);
- the clone dialog asks for the repository URL first and derives the
  project name, slug, and `.git` suffix from it (#130);
- per-user editor settings — auto-save, its delay, and word wrap — are
  stored on the server behind `GET`/`PUT /me/settings`, readable and
  writable only by their own user, and reached from an account-menu dialog
  that keeps all three in the browser without a reload (§13.1, §13.5)
  (#159);
- Administration is reached from the account menu as a link that opens in
  a new tab, so visiting it no longer disconnects the workspace and starts
  the grace timer (#164; closes #124);
- terminal names are numbered from the live terminals of the same project,
  and a revived terminal keeps the name of the ended terminal it replaces
  (§9.6, §9.7) (#123);
- terminal pilot fixes: tmux clipboard pass-through and focus events, OSC
  52 copying handled in the browser, wrapped URLs linkified as one link,
  and an OSC 52 clipboard shim shipped in the workspace image as `xclip`,
  `xsel`, and `pbcopy` (§9, §9.7, §14.9) (#125, #126, #128);
- the editor's external-change detection ignores writes the editor itself
  made, so autosaving never raises a false "this file changed on disk"
  prompt (§13.3, §13.5) (#157);
- editor pilot fixes: stock Monaco features turned on (find and replace,
  folding, bracket matching and colouring, minimap, multi-cursor, command
  palette), per-editor session zoom by wheel, keys, and a bottom bar, and
  language detection from the first line when the file name says nothing
  (§13.1, §13.2; DESIGN §10) (#156, #162, #163);
- one tab per file: the Changes surface opens a file's diff inside that
  file's own tab, with a toggle back to the editor, and a real on-disk
  change during editing opens as a Monaco conflict diff with keep-mine,
  take-disk, and keep-editing actions (#160, #158);
- create project warns about a name clash as it is typed, comparing the
  previewed slug against the workspace's existing project slugs
  client-side and disabling Create, with the server 409 kept as the final
  guard (#175);
- files pane batch operations: multi-row selection with mass delete and
  download, a visible project-root drop target for uploads, a tighter tree
  row density token, file-type icons, and an autofocused name dialog
  (#182–#186);
- the selected tab, the editor cursor, selection and scroll position, and
  the per-file zoom survive leaving the workspace route and returning; they
  are browser-local (§7.5) and never sent to the server (#161);
- Markdown viewer fixes: list markers in the rendered preview, scroll sync
  between the two sides of split view by relative position, and a visible
  scrollbar on the code side (§13.4) (#154);
- a Markdown tab is always a split: the raw Markdown in Monaco on the
  left, a read-only rendered preview on the right, the two sides scrolled
  together, and one Diff button that replaces the whole split with this
  file's side-by-side diff (§13.4) (#155, #218);
- an oversized OSC 52 copy warns, and 100.64.0.0/10 counts as private
  (§24.2);
- security follow-up: OSC 52 clipboard writes gated on a visible, focused
  pane with a 100 KB cap and a visible toast; terminal URLs with
  credentials refused; loopback and private addresses refused by range;
  browser-local layout cleared at sign-out (§24.2);
- browser test stability: a setup check that refuses to run when the API
  under test reads a different database from the test helpers, plus a
  fix for the file-tree tab-cap race (§6.4, §7.5);
- two flaky unit tests (the workspace-agent git timeout test, the API
  terminal input-limit test) made deterministic, so CI runs are repeatable;
- the unit test suite runs fully in parallel again: the shared-database
  test files each get a database of their own, created and dropped by the
  test helper, instead of one database that forced them to run one at a
  time (STACK §13);
- continuous integration keeps reporting its four required checks on a
  documentation-only change, but skips the heavy installs, builds, and
  test runs inside them;
- a merger agent lands task pull requests into an epic branch without
  human review once their CI is green, with the review moved to once per
  epic (ADR 0016);
- each Ansible role in the platform playbook carries its own name as a
  tag, so one role can be converged alone (infra);
- a generic, plain-English guide to how Portikus is built with AI agents
  (`docs/HOW-WE-WORK.md`);
- code-review fixes over the epic head: conflict-side edits survive Keep
  editing, reopening a file leaves diff view, per-project Monaco models,
  nested-path delete, stored-settings read strips unknown keys,
  self-cleaning test databases, one CI change-detection job, shim
  selection argument.

Issue #129 (Codex agent configuration) stays open for Epic 9. Issue #124
was closed by #164.

### Epic 8 — Verification, running services, and authenticated preview
**Estimate:** 5–7 engineer-days

Design: `docs/BROWSER-HANDLING.md`, Part I (preview hosts, grants,
bootstrap tickets, the Caddy authorization subrequest, the agent's
loopback forward for services bound to 127.0.0.1, the multi-port
bridge) and its phases A and B.

Includes:

- configurable project checks/test commands;
- visible check output and pass/fail state;
- listening-port discovery;
- compact Running surface;
- process/container identity for relevant services where safely available;
- per-workspace preview routing;
- a preview origin of its own for every preview, built as the
  same-registrable-domain arrangement of section 14.3 with the protections
  listed there; the separate registrable domain is deferred (ADR 0018);
- a per-workspace host label derived once, at workspace creation, from the
  identity provider's `preferred_username` (lowercased, reduced to a DNS
  label, stored on the workspace row, with a fallback when the claim is
  missing); the label names the preview hosts and is pushed into the
  container as its hostname at every start, so the prompt reads
  `student@<label>.<public host>`;
- authorization;
- WebSockets/HMR;
- embedded Preview tab;
- external-open action;
- inactive preview handling.

Acceptance:

- a configured test/check command runs visibly and reports pass/fail;
- a student can see which development-relevant services/ports are running;
- a student can run a Dockerized or host-level app and view it;
- another student cannot access the preview;
- no unauthenticated URL exposes the app.

### Epic 9 — Coding-agent launchers and credentials
**Estimate:** 2–3 engineer-days

Design: `docs/BROWSER-HANDLING.md`, Part II (the `portikus-open` URL
broker, the authentication order, provider adapters) and its phase C.
A server-side browser for loopback OAuth callbacks is not planned; the
idea is in `docs/BACKLOG.md`.

Includes:

- Claude launcher;
- Codex launcher;
- agent-session metadata;
- creation/association of pre-session review baselines;
- student-owned auth paths;
- institutional credential injection mechanism;
- safe credential handling.

Acceptance:

- both agents can operate in the selected project;
- session review shows changes since the agent began even when the repository was already dirty (§12.7, moved here from Epic 7);
- credentials do not appear in platform logs.

### Epic 10 — Recovery, quotas, and reset workflows
**Estimate:** 3–5 engineer-days

Includes:

- recovery-point creation;
- `.workspaceignore`;
- retention;
- restore;
- storage accounting;
- quota warnings;
- Reset Docker;
- workspace rebuild preserving home/projects.

Acceptance:

- destructive agent change can be restored;
- Git history is not modified by automatic recovery;
- Docker can be reset without deleting projects.

As built: `docs/EPIC-10.md` has the working brief; landed on
`epic/10-recovery-quotas`. §15.10 describes recovery storage and
operations, §16.4 Reset Docker, §17.2 rebuild, and §19.2 storage figures
and warnings; ADR 0020 and ADR 0021 record the choices. Out of this epic:
comparing against a recovery point (§12.6) and per-file history (§15.9),
the guided student rebuild, changing quotas at runtime, re-creating a
workspace whose instance is gone, and deleting, downloading, or restoring
points into a new project by hand.

### Epic 11 — Administration and observability
**Estimate:** 3–4 engineer-days

See `docs/EPIC-11.md` for the working brief and decisions; landed on
`epic/11-admin-observability`.

Includes:

- admin workspace list;
- lifecycle actions;
- quota inspection/change;
- image version;
- preview-port inspection;
- logs/metrics;
- audit events;
- operational dashboard basics.

Acceptance:

- common student failures can be diagnosed without direct database editing;
- administrators can stop/rebuild/reset a workspace from supported controls.

### Epic 12 — Security, load, recovery, and pilot hardening
**Estimate:** 5–7 engineer-days

Epic 12a (security test suites): see docs/EPIC-12A.md; landed on epic/12a-security-tests.

Epic 12b (Dex sign-in and pilot readiness: load, backup and restore, rebuild, deployment documentation, threat model): see docs/EPIC-12B.md; the operations runbook is docs/OPERATIONS.md.

Includes:

- authorization test matrix;
- filesystem escape tests;
- network-isolation tests;
- preview-origin tests;
- resource-exhaustion tests;
- concurrent-workspace load tests;
- backup/restore;
- destructive infrastructure rebuild exercise;
- user-facing failure cases;
- accessibility pass;
- deployment documentation.

Acceptance:

- documented threat model reviewed;
- rebuild-from-code exercise passes;
- backup restore passes;
- pilot concurrency target is tested.

### Epic 13 — LTI 1.3 launch and an instructor role

See `docs/EPIC-13.md` for the working brief and rulings, and `docs/adr/0025-lti-launch.md` for the design; landed on `epic/13-lti-launch`.

Includes:

- LTI 1.3 core resource-link launch (third-party login, id_token validation, state and nonce);
- LMS platforms registered in an operator file applied by Ansible;
- the `instructor` role, from LTI or from the Dex users file;
- a read-only Course page for instructors;
- a mock LMS on the operator's host for trying and testing launches.

Acceptance:

- a student and an instructor launched from a registered LMS land in their own workspace with no second password;
- every invalid launch is refused with its own reason code;
- an instructor is refused on every administrator route and cannot reach another user's workspace.

### Epic 13.1 — Link a course account to an SSO account, and promote administrators

See `docs/EPIC-13-1.md` for the working brief and rulings, and `docs/adr/0026-account-links-and-role-grant.md` for the design; landed on `epic/13-1-account-linking`.

Includes:

- linking one LTI course account to one OIDC (SSO) account, proved by a full sign-in on each side, never by matching email;
- the linked course account's workspace archived, not deleted, and restored on unlink;
- a stored role grant (`instructor` or `administrator`), separate from the role a provider's group claim gives, so an administrator can promote and demote without a later sign-in overwriting it;
- an admin Users view: search, a role filter and column, a sign-in source column, promote and demote with confirmation, and bulk Disable, Enable, Archive and Unarchive;
- an instructor removing one member from their Course page.

Acceptance:

- a person who launches from a course and also signs in through SSO can link the two and always land in the SSO account and workspace afterward;
- a launch never starts a session for an account whose effective role is administrator;
- an administrator can promote an SSO account and demote one they promoted, and can never demote the last administrator.

### Estimated total

**Approximately 47–66 focused engineer-days** for a credible student pilot, depending heavily on how much UI polish, institutional identity integration, and infrastructure troubleshooting is required.

A technical proof of concept should be targeted much earlier, after Epics 1–5 plus the minimum preview and file functionality.

## 30. Suggested milestone gates

### Gate A — Architecture proof

Prove:

- automated Debian VM;
- Incus/LVM;
- unprivileged nested Docker;
- workspace agent;
- browser terminal;
- start/stop lifecycle;
- one authenticated preview;
- control plane installed from the versioned package, rollback by
  reinstalling the previous version.

Do not build substantial UI polish until this passes.

### Gate B — Single-user dogfood

A developer can use the environment for a real small project with:

- Claude or Codex;
- GitHub;
- Docker;
- file editing and project search;
- Git and agent-session change review;
- a configured test/check command;
- running-service visibility;
- previews;
- reconnect.

### Gate C — Multi-user security

Prove two or more users cannot:

- read each other's files;
- attach to terminals;
- reach previews;
- access workspace-agent endpoints;
- use network paths to reach management services.

### Gate D — Student alpha

Complete project management, session review, checks/test execution, Git preservation state, recovery, quotas, error states, and student-oriented UI.

### Gate E — Pilot readiness

Pass:

- infrastructure rebuild;
- data restore;
- concurrency test;
- security review;
- accessibility review;
- operational runbook review.

## 31. Future capabilities

Architecture should leave room for, but P0 should not implement unless needed:

- LTI 1.3 launch and course context;
- course/project templates managed by instructors;
- roster provisioning;
- instructor support/share sessions;
- read-only or temporary instructor workspace access;
- developer profile with long-running agents;
- notifications when agents finish;
- agent usage/cost reporting;
- richer graphical Git operations;
- file-level recovery/history UI;
- project activity timeline;
- quick-open / command palette;
- detected Run/Test/Build actions beyond configured P0 checks;
- resumable provider agent sessions;
- group workspaces;
- shared collaborative editing;
- additional coding agents;
- multiple workspace images by course;
- multiple compute hosts;
- Incus clustering;
- ZFS or Ceph storage;
- Proxmox workspace-provider implementation;
- high availability;
- workspace migration;
- user-requested workspace deletion;
- public deployment workflows outside the student security boundary.

## 32. Explicit non-requirements

P0 must not spend effort attempting to provide:

- CRIU-based stateful hibernation;
- process checkpoint/restore;
- per-student virtual machines;
- Kubernetes orchestration;
- public unauthenticated student ports;
- a full IDE extension ecosystem;
- a graphical debugger;
- a graphical database client;
- a general REST/API client;
- a Docker-management GUI;
- a replacement Git implementation;
- a full graphical Git client;
- automatic hidden commits;
- arbitrary host mounts;
- persistent processes after the student shutdown grace period.

## 33. Definition of pilot success

The pilot is successful when an authorized student can perform this end-to-end workflow without local development software:

1. sign in;
2. have a workspace provisioned or started;
3. create or clone a project;
4. launch Claude Code or Codex;
5. direct the agent to build an application;
6. observe files appearing and Git state changing;
7. review both Git changes and the changes attributable to the current agent session;
8. search the project and inspect relevant files without leaving the browser;
9. run configured tests/checks and inspect the real command output;
10. run the application, including through Docker, and see which service/port is active;
11. open the application in an authenticated browser preview;
12. distinguish uncommitted work, local commits, pushed work, and conflict state;
13. use Git/GitHub to commit and push;
14. close the browser;
15. return after the workspace has stopped;
16. start the workspace automatically;
17. see the same projects and layout;
18. restart the relevant terminal/agent/application processes; and
19. continue working.

At no point should the student need SSH, a locally installed IDE, Docker Desktop, port-forwarding software, or administrator access to the platform infrastructure.
