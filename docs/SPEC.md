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

Storage pool rules (Epic 17, ADR 0034):

1. The thin pool fails writes at once when full (`lv_when_full` is `error`), so a full pool gives the writing program "No space left on device" instead of freezing every workspace.
2. A root timer writes the pool's data and metadata use to `/run/portikus-thinpool.json` every minute; the controller reads metadata use from it (section 20.1).
3. The pool's fill is the larger of data and metadata use. At 70% the Health tab warns and administrators are notified; at 90% new workspaces are refused with `POOL_FULL` and wait in `provisioning` until there is room (section 20.1).

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

Added by Epic 15.2, changed by Epic 28 (issue #933): the coding agents' platform instructions are system files the student does not own.

- One template, `agent-instructions.md`, ships in the Portikus package with the workspace agent (`/usr/lib/portikus/workspace-agent/`, bind-mounted read-only into every workspace), written for the agents in plain English: what the workspace is, projects and checks, previews and the host suffix, opening a URL with `/usr/local/bin/portikus-open` (because `BROWSER` is empty inside Claude Code), preferring the seed's preloaded Docker images, never committing on the student's behalf unless asked. It holds no issue, pull request, SPEC or ADR references.
- Before every start the workspace controller writes it, as root with mode 0644, to `/etc/claude-code/CLAUDE.md` (Claude Code's system memory) and as `developer_instructions` in `/etc/codex/config.toml` (Codex's system config, beside `check_for_update_on_startup = false`). The controller, not the agent, writes them because the agent runs as the student and cannot write `/etc`. An edit or deletion lasts until the next start. The controller never opens what is at those paths: it deletes the path (a file, named pipe or link alike) and pushes the new file, so a pipe cannot block a start; a directory there is refused and logged. A failure is logged and never stops the start, and a host without the template writes nothing. A student's own `developer_instructions` in `~/.codex/config.toml` replaces the platform's for Codex; other keys there keep it. The controller also rewrites `/etc/claude-code/managed-settings.json` at every start from a template in the package, by the same rules, so a student who deletes `/etc/claude-code` gets Claude Code's `BROWSER` setting back at the next start.
- `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` belong to the student. The workspace agent only removes what older versions wrote there: a `~/.codex/AGENTS.md` that is an unchanged copy of an old template (checked by SHA-256), and the exact line `@~/.codex/AGENTS.md` in `~/.claude/CLAUDE.md` once that file is gone (the file too if nothing else is left). It never follows a symbolic link.
- The image also sets `init.defaultBranch main` in `/etc/gitconfig`, so a student's own `git init` starts on `main`.

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

Added by Epic 14 (docs/archive/epics/EPIC-14.md, ADRs 0027 and 0028) and changed by Epic 14.2 (ADR 0031): every site signs people in through Dex, the small OIDC (OpenID Connect) provider Portikus runs beside the API, and LTI (Learning Tools Interoperability) launch works beside it.

- The API trusts one issuer, Dex. It keeps a plain OIDC client against `OIDC_ISSUER_URL` with no provider-specific branches, and always calls userinfo, because Dex puts `groups` there. Local development and CI point it at the in-repo mock provider instead. `OIDC_DEFAULT_ROLE` stays; Ansible sets it to `student` on every site, so the local administrator and guests, who have no groups, are not refused.
- Dex's own passwords are always on, kept in PostgreSQL and managed by administrators from the Users view. Add user asks for the person's name as well as email, username and role, because Dex sends only the username as the name; the account keeps that name through sign-in.
- An institution's provider is one Dex connector beside the local passwords, never more than one per site. Dex decides who may sign in; a person Dex refuses sees Dex's error page, never reaches Portikus, and is recorded in Dex's log:

  | Connector (`portikus_dex_upstream`) | Who may sign in | Role from | No group matched |
  |---|---|---|---|
  | `none` (local passwords only) | people an administrator added, and the local administrator | grants | student |
  | `entra` (Dex's `oidc` connector held to the tenant's own issuer) | the tenant's people, guests included, with one of the three Portikus app roles | the `roles` claim, passed on as groups | refused by Dex |
  | `google` | the listed Google Workspace domains | grants | student |
  | `ldap` (LDAP or Active Directory) | people the required user filter admits | directory groups | student |
  | `oidc` (Okta, Keycloak, Shibboleth's OIDC plugin, any other) | members of one of the three groups | the provider's groups claim | refused by Dex |

  The three group names default to `portikus-students`, `portikus-instructors` and `portikus-administrators`, and under `entra` to the app role values `Portikus.Student`, `Portikus.Instructor` and `Portikus.Administrator`; the `PORTIKUS_OIDC_*_GROUP` settings change them, and an `oidc` site whose provider uses other names must set them. The `entra` connector reads no Microsoft Graph data and needs no Graph permission. Dex's `microsoft` connector, Google groups and SAML are not supported. Portikus never speaks LDAP.
- An account is always keyed by the provider's issuer and `sub`, never by email; under Dex that is Dex's issuer and the subject Dex gives.
- Every install has a local administrator: a Dex local password with Dex user ID `local-admin`, username `admin`, display name "Local administrator", the `administrator` grant, and the email `portikus_admin_email` (default `admin@<public host>`), set only when the account is created. Its password is random and unique to the install (the 20-character password Add user makes, about 115 bits), stored by Dex only as a bcrypt hash, and must be changed at first sign-in. It is written only to `/etc/portikus/admin-password` (owner root, mode 0600), never to a log, the journal or the play's output; the play removes the file once the password has been changed.
- `portikus reset-admin`, run by root on the host, is the recovery path. It creates the local administrator if it is missing, gives it a new one-time password, re-enables it, restores the administrator grant, sets "must change password", and ends every session and preview session of the account. With `--if-missing` it leaves an existing account alone, even a removed one, and exits 10 while the one-time password is unchanged and 11 once it has been changed; otherwise 0 is success, 1 a failure (such as another Dex password already holding the email) and 2 bad arguments or settings. It refuses to run unless it is root and the site has Dex's gRPC API.
- Nobody becomes an administrator by signing in first; there is no setup code and no `/setup` page.
- Only Dex reaches an outside provider, through a forward proxy that allows named hosts: the discovery hosts of its one connector (for `entra`, without the userinfo host, so no `graph.microsoft.com`). The API reaches only Dex, under the site's own name, and LMS keysets.

Added by Epic 14.3 (ADR 0032): every account accepts the acceptable-use statement before it uses Portikus.

- Everyone accepts: students, instructors and administrators, whether they signed in through Dex or launched from a course. An account accepts at its first sign-in and again whenever the statement's text changes.
- The statement is an administrator setting, `settings.acceptable_use_text`, plain text with blank lines between paragraphs and at most 10,000 characters. Null means the built-in default, a constant in `packages/contracts`, which says in five short paragraphs: the workspace is for coursework and learning; no crypto mining, no public hosting or tunnels, no attacks on other systems, no sharing your account; heavy use is slowed automatically and administrators can see CPU and memory totals, not your files; breaking these rules can end your access; your institution's own rules also apply.
- `settings.acceptable_use_version` starts at 1. Any saved change to the text, including a reset to the default from a custom text, adds one to it, so everyone must accept again. There is no "minor edit" that skips re-acceptance. The Settings tab says so beside the Save button.
- `users.acceptable_use_version` records the version an account accepted (null for never) and `users.acceptable_use_accepted_at` when.
- Acceptance is a gate on the same mechanism as "must change password" (section 5.3). The gates are one ordered list, `GATES` in `packages/auth/src/plugin.ts`, and the first unmet gate wins. Each gate allows only its own routes:
  1. `must_change_password` is set: code `PASSWORD_CHANGE_REQUIRED`, allowed route `POST /me/password`, web page `/change-password`. A password-gated account can neither read nor accept the statement;
  2. the account's accepted version differs from the current one: code `ACCEPTABLE_USE_REQUIRED`, allowed routes `GET /me/acceptable-use` (the statement and its version) and `POST /me/acceptable-use`, web page `/acceptable-use`.

  So a new local administrator changes the password first, then accepts.

  Added by Epic 34 (section 24.13): a Dex-password account meets a second-factor gate (code `SECOND_FACTOR_REQUIRED`) in two places, so the full order is: verify a code, if the account already has a factor; change the password; set up a factor, if it has none; accept acceptable use. While a gate is unmet, every other API route answers 403 with that gate's code, except `GET /auth/me`, `POST /auth/logout` and the routes that need no session. New WebSocket upgrades are refused, and open sockets (terminal, workspace, project events and checks) are closed at their periodic session re-check. The preview gateway refuses the account. `loadSession` decides both gates in its one query, left-joining the settings row (`id = 1`) and treating a missing row as version 1.
- `GET /auth/me` carries `mustAcceptUse: boolean`, and the web sends every page to the first unmet gate. When any request answers with a gate code, the web fetches `/auth/me` again, so an open tab moves to the gate page. Both gate pages move focus to their heading on arrival. The acceptable-use page shows the text, its first paragraph as an introduction and the rest as a list, with **Accept and continue** and **Sign out** (Epic 25).
- `POST /me/acceptable-use {version}` is CSRF-checked. It is one conditional update of the account plus the audit row `user.acceptable_use_accepted` with `{version}`, in one transaction. When `version` is not the current one it answers 409 `ACCEPTABLE_USE_CHANGED` and records nothing, so nobody accepts a text they did not see.
- The gate is checked on every request, so a text change reaches people already signed in at their next request. Their workspaces keep running. An administrator who saves a new text meets the gate too.

### 5.2 Authorization

Access must be denied by default.

Another user's workspace, project, file, or terminal answers 404, never 403,
so its existence is not revealed (Epic 12a). An administrator gets the same
404 for a student's terminals, files, projects, previews, and checks.

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
`docs/archive/epics/EPIC-13-1.md` and ADR 0026.

Added by Epic 14.2 (ADR 0031): roles come from the Dex connector's groups
(directory groups, Entra app roles, or a generic provider's groups claim)
or from grants. Dex refuses people outside the connector's admission rules
(5.1) before Portikus sees them. A password an administrator sets (Add user
or Reset password in the Users view) or `portikus reset-admin` sets must be
changed at first sign-in: the account carries a "must change password"
flag until it does.

Added by Epic 42 (ADR 0057): an instructor sees a student's project only
while the student shares it, and only read-only. A share covers one
project, reaches the instructors of every course the student belongs to,
and ends after 24 hours, when the student stops it, or when the project
is archived. An instructor never opens a student's files on their own
initiative, and an administrator still gets 404 on a student's files.

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
- reject access immediately when server-side authorization is removed
  (the preview gateway may lag by up to 2 seconds; see section 24.7).

Sign-in is rate limited per client address in the API, since Dex has no
lockout (Epic 12b, ADR 0023): sign-in starts and Dex password attempts have
separate limits, the password attempts also have a site-wide total, and a
refusal answers 429 `RATE_LIMITED` and is audited as `auth.throttled`.

Added by Epic 17: each user may make 20 workspace start, stop and restart
requests a minute in total, and 600 file and project writes a minute
(every non-GET route in the files and projects APIs; recovery points,
check runs and administrator routes are not limited). Over either limit the answer is 429
`RATE_LIMITED`, "Too many requests just now. Try again in a minute.",
with a `Retry-After` header; one warning is logged per user per window
and nothing is audited. All of these limits, and the preview cap in
section 24.7, count in fixed windows held in the API process. When no
database connection frees up within 5 seconds the API answers 503
`SERVICE_BUSY`; statements end after 30 seconds and idle transactions
after 60.

Added by Epic 14.2: an account that must change its password can use only
the change-password page. Every other API route answers 403
`PASSWORD_CHANGE_REQUIRED`, except `GET /auth/me`, `POST /me/password`,
`POST /auth/logout` and the routes that need no session (`/health`,
`/auth/*`, the LTI routes); WebSocket upgrades and the preview gateway
refuse the account too, and the web sends every page to
`/change-password`. Anyone with a Dex local password can change it from
Settings, Password (`POST /me/password`, CSRF-checked): the current
password is checked through Dex's gRPC `VerifyPassword`; the new one must
be at least 15 characters, counted as Unicode code points (NIST SP 800-63B revision 4 for a single
factor, no composition rules), at most 72 bytes (bcrypt's limit) and
different from the current one; it is stored in Dex as a bcrypt hash. A
wrong current password answers 403 `WRONG_PASSWORD` and counts against a
per-account limit of 10 in 10 minutes, after which the answer is 429
(per account, not per address, so a lab behind one address is not
blocked together; Todd's ruling of 2026-09-25). Each attempt is counted
before Dex is asked, so parallel requests cannot pass the limit, and is
given back when the password was not wrong. A
change clears the flag and ends the account's other sessions and preview
sessions; the current session stays. The route answers 404 without Dex's
gRPC API and 400 `NOT_LOCAL_PASSWORD` for an account that is not a Dex
local password.

On the forced change page the first field is labelled "Current or one-time
password", with a hint that a one-time password from an administrator goes
there; in Settings it stays "Current password" (Epic 25).

### 5.4 Multiple browser connections

A user may connect to the same workspace from multiple browser windows or devices.

All authorized connections must see the same underlying workspace.

Events originating in one connection must propagate to other active connections when relevant.

## 6. Workspace lifecycle

### 6.1 One workspace per student

P0 assigns one workspace to each authorized student.

A student's projects all live inside that workspace.

An administrator signs in to the administration page, not a workspace. An administrator gets a workspace only when they choose to open one from that page.

### 6.2 Provisioning

On first use, the platform must be able to provision a workspace from the current approved workspace image.

Provisioning must be fully automated.

The student must not need administrator intervention for routine provisioning.

Creating a workspace leaves it stopped until the owner connects or starts it.

### 6.3 Start behavior

If an authenticated user opens the platform and the assigned workspace is stopped:

1. the control plane requests workspace start through Incus;
2. the UI displays a clear connecting/starting state;
3. the control plane waits for workspace-agent health;
4. the browser reconnects to project/file/terminal services when ready.

If the workspace is stopped because the student stopped it by hand, the platform does not start it again on its own. The work area says the workspace is stopped and offers a button that starts it, which is the same request as the Start button in the workspace dialog. The platform never shows starting progress while no start has been requested.

Loading skeletons appear only while the workspace is connecting, starting or reopening tabs; a stopped or failed workspace shows a plain message in the side panes instead. If the workspace failed to start, the work area offers "Try again", which is the same start request, and "Workspace details", which opens the workspace dialog. The raw error message and code sit under a collapsed "Technical details".

If a start fails while the workspace should run, the worker retries it at most five times, waiting 10 seconds, 30 seconds, 1 minute, 2 minutes and then 5 minutes after each failure. The count is stored on the workspace row (`start_retries`), so a worker restart does not start it over. After the fifth failed retry the workspace stays in error with its message, and the worker logs one warning. The student's Start, Stop or Restart sets the count back to zero, and so does a successful start. A start from stopped is a first attempt and also sets it to zero, so a student's Start gives the workspace five more attempts: their own start counts as the first after the 10-second wait. Opening the workspace in the browser does not.

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

Added by Epic 14.3 (ADR 0032): a second timer, **idle stop**, stops a running workspace after a stretch with no activity, whether or not a browser is connected, so an open, forgotten tab no longer keeps it running.

- Activity is something the workspace's owner did on purpose, never something an administrator did while looking at the workspace:
  - a key press, click or paste anywhere in the Portikus page, which covers typing in a terminal and the editor. The web app sends `{type: "activity"}` on the workspace socket at most once a minute;
  - a write through the API's file routes (save, delete, new folder, move);
  - a page load in a preview that the person started: the preview authorization check sees `Sec-Fetch-Dest` of `document` or `iframe` together with `Sec-Fetch-User: ?1`. A new tab or the embedded Preview tab counts; a page reloading itself, a dev server's live reload, assets and fetches do not.
- Nothing else counts. Terminal output and frames are not inspected, because the browser's terminal answers some program queries on its own. The workspace agent reports nothing, because anything inside the workspace can make it say anything. So an unattended coding agent is stopped with its workspace like anything else.
- The API writes `workspaces.last_activity_at` at most once a minute per workspace and clears `idle_stop_at` in the same statement. The worker sets `last_activity_at` to the start time whenever it records a start, so a workspace never starts already idle.
- The idle time is an administrator setting, `settings.idle_stop_minutes`, default **60**, 0 (never) or 10 to 1440 minutes. Each workspace may override it with the key `idleStopMinutes` in `workspaces.guard_config` (section 19.4); the override wins, and 0 at either level turns idle stop off.
- In the reconcile sweep, a running workspace whose idle time is above 0 and whose `last_activity_at` plus the idle time has passed gets `idle_stop_at` set five minutes ahead. The five minutes is fixed. When `idle_stop_at` passes, the workspace is stopped by the usual stop path and `workspace.idle_stopped` is audited with `{idleMinutes}`.
- While `idle_stop_at` is set, the workspace view carries `idleStopAt` and the work area shows "Still working?" with the stop time and a **Keep working** button that takes focus and sends an activity message. Any other activity also answers it. If the workspace then stops while the tab is open, the stopped screen says it stopped after that many minutes without activity.
- A changed setting or override takes effect on the next sweep. Lowering the idle time below how long a workspace has already been idle shows the warning on the next sweep; it never stops the workspace at once.
- The grace period above is unchanged and runs beside idle stop; whichever fires first stops the workspace. A new connection still starts a stopped workspace.

Added by Epic 28 (issue #955): **Keep running until.** The owner can hold a running workspace up until a time, from the "Keep running" section of the workspace dialog, for example while a coding agent works overnight.

- While `workspaces.keep_running_until` is ahead, the worker arms neither the disconnect grace deadline nor the idle warning, and withdraws a warning already shown. When the hold ends, by time or by the student, both timers start from its end as if the student had just acted, so "Still working?" and its five-minute warning still come first. A hold does not lift resource guard limits.
- How far ahead a hold may reach is `settings.keep_running_max_hours` (default 12, 0 to 168; 0 turns holds off), overridden per workspace by `keepRunningMaxHours` in `workspaces.guard_config` (section 19.4). A lowered cap cuts existing holds to now plus the cap at the next sweep, or ends them at 0.
- Only the owner may set or end a hold (`PUT` and `DELETE /workspaces/:id/keep-running`); anyone else, administrators included, gets 404. The API refuses a time in the past or past now plus the cap (400), and any hold when the cap is 0 (409 `KEEP_RUNNING_OFF`). A requested end up to five minutes past the cap is taken as exactly now plus the cap, to absorb browser clock skew. The cap bounds how far ahead a hold reaches, not the total time held, so a student may renew a hold. Setting a hold counts as activity. The worker's cut and end updates recheck the row itself, so a student's concurrent end or shorter hold is not undone.
- Audit: `workspace.keep_running_set` (`until`, `previousUntil`, or `reason: "cut_by_cap"` from the worker), `workspace.keep_running_ended` (`reason` `ended_early`, `expired` or `cut_by_cap`) and `settings.keep_running_updated`.
- The status bar shows "Kept running until {time}" in the student's timezone setting, with the date added when the end is six or more days ahead. The dialog's button names its result ("Keep running until …"), and "Don't keep running" ends a hold early. While a hold lasts, the admin workspace detail's guard summary says "Kept running by its owner until …".

### 6.5 Graceful stop

A stop should allow the workspace operating system and inner services a bounded period to shut down cleanly.

If graceful stop does not complete within the configured timeout, the platform may force-stop the workspace and must record the event.

A slow stop must not hold up other workspaces. The worker runs each stop in the background, so the next reconcile sweep starts other workspaces without waiting for it, and it leaves a workspace whose stop is still running in `stopping` rather than resolving it from the instance list. Every controller call the worker makes (creates, starts, stops and maintenance operations) runs in one background runner, at most one call per workspace at a time. Creates, starts and maintenance share a cap of 6 calls at once; stops sit outside the cap, so they never wait behind a slow rebuild (ADR 0034). Every call from the worker to the workspace controller has a time budget (a stop gets twice the stop timeout plus 25 seconds), and the controller bounds each Incus request at 30 seconds unless the caller sets its own limit; a call over its budget fails with `TIMEOUT`, and the controller stops its own work on that call once the budget runs out or the worker hangs up.

A stop succeeds when the instance reaches Stopped within the timeout. The controller decides from the instance's state, never from the text of an Incus error, so a stop that races another stop or a shutdown from inside still ends Stopped with no error. Its first state read tolerates any error except not-found, because for about a second of some shutdowns Incus answers the state read itself with HTTP 500 "Invalid PID -1" (Epic 22).

Stop on a workspace in error stops its instance if the instance still runs. The worker sees this in the instance list, moves the workspace to `stopping`, clears the error and stops it as usual. If the instance is already stopped or gone, the workspace stays in error. If that stop fails, the workspace goes back to error with the code `STOP_FAILED`, and the worker does not try again on its own; the student's next Stop clears the code and the worker tries once more.

A stop or restart confirmation opened while the workspace is changing state keeps its Confirm button disabled and says why, until the workspace settles. The Confirm button stays focusable (`aria-disabled`) and the reason is announced to screen readers.

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

Every repository Portikus initializes starts on branch `main`
(`git init --initial-branch=main`); a clone keeps the branches it has.
Choosing the initial branch name is part of creating the repository, so it
does not conflict with §12.5.

Portikus keeps working files, such as pasted images, under `.portikus/` in
the project. Git ignores them with these lines, which keep
`.portikus/checks.json` and `.portikus/README.md` as project content:

```gitignore
.portikus/*
!.portikus/checks.json
!.portikus/README.md
```

A new project's default `.gitignore` carries them. A repository that
already has its own `.gitignore` (a clone, a template that ships one, or a
folder given Initialize Git) gets them in `.git/info/exclude` instead,
because the platform never edits a student's tracked files. A project
made before these lines existed gets them in `.git/info/exclude` the
first time the platform writes anything under `.portikus/`. A new project
and a new project from a template also get `.portikus/README.md`, which
explains checks (§18.1) to the student and to coding agents; an existing
README there is never overwritten.

When a repository is cloned, the dialog first suggests the folder name read
as a title (`ipeds-oracle` reads "Ipeds Oracle"). Unless the student types
their own name, the project then takes the name the repository gives
itself: the README's first Markdown heading with its formatting and emoji removed
(a heading that is only emoji is skipped),
else `displayName` or `name` in `package.json`, else `name` in
`pyproject.toml`, trimmed to the name limit. The folder keeps the slug of
the name the dialog sent, so only the displayed name changes.

Added by Epic 42 (ADR 0058): an instructor can place a starter project in
an LMS through LTI Deep Linking. The picker offers a configured template
(§7.6, `PROJECT_TEMPLATES`) or a public `https` repository, and a project
name. A student who launches that link lands on `/?starter=<id>`, and the
project is created only when no project with that slug exists; otherwise
the existing one opens, or the student is told it is archived. A starter
never overwrites a project or a folder.

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

Rename changes the name, the slug, and the directory together. A row with no
recorded directory identity first gets one from the agent's listing, so a
failure between the folder move and the row update is healed by the next
listing. The agent moves
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
`row` or `column`, one size per child, and at least two children. A node may
also be a file (`{"type":"file","path":…}`), alone in its tab or inside a
split beside terminals and other files; a preview is always a whole tab. A
path appears at most once in a layout. A tab whose only pane is a file has
the id `file:<path>`, and a split that collapses to one file takes that id
back. The tree is checked for depth before the schema recurses, so a layout
nested thousands deep is a 400, not a stack overflow. The browser
owns this document and writes it back, at most once a second; the last write
wins. Before it is used the browser reconciles it against the terminal list:
a terminal with no leaf is added as a new tab, and a leaf whose terminal no
longer exists is removed, so a saved layout can never point at a terminal that
is gone. Ended terminals keep their leaf (§9.7). The selected tab and the pane
widths are browser-local, not part of this document. One user's saved layouts
together may hold at most 8 MiB; a save past that is refused with 413
`LAYOUT_LIMIT`, and the browser shows the server's message once as a toast.

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

Terminal panes must additionally support splitting. A file pane can join a
terminal's split, by dragging its name onto a pane's edge or through its
actions menu's "Move into"; resting a drag on a tab opens that tab. A tab
shows the unsaved dot when any file in it has unsaved edits, and closing a
tab that holds unsaved edits asks first.

A file pane has one header line, alone in its tab or in a split. The name, which is the drag handle, is at the start, followed by its parent folder in muted text. The save state and the view buttons come next, then the microphone (§25.10), and the actions menu is at the end. An image, a PDF, or a file that cannot be edited has no view buttons, and it shows itself even when its diff is asked for. The whole bar drags the pane, as a terminal's bar does, except its buttons, fields and menus and the folder path, which a student can select and copy. The editor's zoom buttons are at least 24 px by 24 px however long the name is (§25.8). Added by Epic 40.

When a project has no tabs open, the centre pane says "No terminals open" and
offers two buttons: "Open a terminal" (primary) and "Start Claude Code". The
tab strip's "+" button, labelled "New tab", holds the rest (Codex, previews).

### 8.4 Right pane

The right pane contains the selected project's file tree and Git decorations.

### 8.5 Toasts and notifications

Every toast goes away on its own: neutral and success toasts after 5
seconds, warnings and errors after 10. The timer pauses while the
pointer or keyboard focus is on the toast, and the close button stays.
A toast that carries an action the user must answer, such as replacing
a file that already exists, stays until it is answered.

Archiving a project is reversible, so its menu item and confirmation are
neutral (primary button, no red), and it ends with a success toast
"<name> archived" that says where to find it. Duplicating ends with a
success toast "<new name> created". Renaming shows no toast.
The shared confirmation dialog is destructive (danger button, red) by
default and has a neutral form for reversible actions such as archiving.

Every toast shown is also recorded as a notification with its tone,
title, body text, time, and whether it has been read. Notifications are
stored on the server (ADR 0033) in a `notifications` table, so they
follow the user to any browser. Each user keeps at most 200 and none
older than 90 days; the API trims as it records and the worker prunes
hourly. The routes act only on the signed-in user's own rows:
`GET /me/notifications` (newest first, paged, with the unread count),
`POST /me/notifications` (record one), `PATCH /me/notifications/:id`
(mark one read), `POST /me/notifications/read-all`, and
`DELETE /me/notifications` (clear). The title is capped at 200
characters and the body at 2,000, and recording is limited to 30 per
user per minute. Titles and bodies are never logged, because they can
name files and projects. If recording fails, the toast still shows, and
the failure is neither retried nor reported.

The unread count is its own button in the top bar, right after the account
button, in the accent colour: "9+" above nine and hidden at zero, named
"Notifications, 3 unread notifications", and it opens the Notifications
dialog. The account button's accessible name includes the count too
("…, 3 unread notifications"), and the menu's "Notifications" item shows
the count after its label (Epic 25). The browser polls the count every
30 seconds and again when the window regains focus, so a read on one
device clears the badge on another. A "Notifications" item in the
account menu, or the unread-count button, opens the Notifications dialog:
newest first, each with its tone icon, title, body and relative time,
unread ones marked. The user can mark one read, mark all read, or clear
the list. Opening the dialog marks nothing read by itself.

### 8.6 Help in the product

Added by Epic 25. The account menu has a Help item that opens, in a new
tab, `/admin/help` from an admin page and `/help` everywhere else. Help is
two pages of plain sentences, each with a table of contents. "Using your
workspace" at `/help` holds the student part for everyone and the
instructor part for instructors, administrators and anyone who teaches a
course. "For administrators" at `/admin/help` holds the administrator
part, shown inside the admin page under its tabs and guarded like every
admin route. Each page links to the other. The text holds nothing secret.
Admin tab intros link to `/admin/help#admin-…`. The text
lives in `apps/web/src/help/content` (one file per part), and every topic
has a stable anchor such as `/help#student-keyboard`. Opening `/help#topic`
scrolls to that heading and moves focus to it; a malformed anchor is
ignored.

Two components explain the product where it is used (placement rules in
`design/system/README.md`, "Help in the product"):

- **PageIntro**: one or two sentences under a page's heading on what the
  page is for, in a native `details` whose summary reads "About {page}".
  It is open until the person closes it, the browser remembers that per
  page, and it may link to the matching Help section. Once per page, and
  only where the heading does not already say it.
- **Toggletip**: a small help button named "About {subject}" that shows
  one to three sentences when clicked or pressed, never on hover. It sits
  beside a field's label, after the text of a table header, beside a
  section heading, or beside a button; never inside a sentence, never
  holding a link or control, and never more than one per control.
  Keyboard behaviour is in section 25.8.

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

A file row dragged from the file tree onto a pane's edge opens that file in a split on that edge, or moves its pane there when it is already open. Folders do not drop on panes. The keyboard alternative is the pane's Move into menu. A file pane keeps the view it shows (editor, diff, or picture/table) when it is moved, for the session.

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

Pasting an image into a terminal (Epic 9.2) writes it through the ordinary
project upload, under its limits and owner check, to
`.portikus/pastes/<timestamp>.png` (or `.jpeg`) in the terminal's own
project. The terminal then receives the file's absolute path and a trailing
space, never a newline, so the paste cannot run a command. Image bytes are
never logged. Pastes older than 7 days are removed on the next paste in that
project (#885).

### 9.7 Session model and wire protocol

Each terminal is one tmux session inside the workspace, named
`pk-<terminalId>` and created with `window-size latest`. Every browser
attachment is its own PTY running `tmux attach-session` against that
session, so tmux owns the shell and the WebSocket does not. Several
attachments to one terminal are a shared tmux attach and must not create a
second process. A full workspace stop ends the container and therefore the
tmux sessions with it.

The tmux server listens on a private socket named `portikus`
(`/tmp/tmux-<uid>/portikus`, in tmux's own mode-0700 directory) and is
started with `-f /dev/null`, so a student's `~/.tmux.conf` is never read;
the agent sets every option it needs on each `new-session`. On images that
run tmux in its own unit (`TMUX_EXTERNAL_SERVER=true`), the agent passes
`-N` and never starts a server: a missing server is `TMUX_FAILED` saying the
terminal service restarts within seconds. Every tmux call is killed after 5
seconds and reported as `TMUX_FAILED`; only tmux's own "no such session"
or "no server" answers count as a missing session, and a `new-session`
whose later setup fails is killed rather than left behind. An ordinary terminal starts in the
agent's `portikus-shell` wrapper, which unsets `TMUX` and `TMUX_PANE` (so a
`tmux` typed in a pane is the student's own server) and, when the login
shell exits within a second, prints "Your shell settings (~/.bashrc or
~/.profile) made the shell exit, so this terminal started a plain shell.
Fix the file, then open a new terminal." and starts
`bash --noprofile --norc` once. Closing a terminal stops the pane's whole
process tree, its descendants and every process in its session, with
`SIGTERM`, then `SIGKILL` after 3 seconds to whatever is left, including
anything that joined the session meanwhile; a zombie counts as gone, and a
root whose start time no longer matches is left alone. A program that
double-forks out of both escapes.

Terminal metadata (§9.6, §26) is a durable control-plane row holding at
least the terminal ID, its workspace, display name, working directory,
layout position, creation time, and the time it ended. The control plane
marks a terminal ended when its workspace begins stopping; closing a
terminal deliberately deletes its row instead. An ended terminal is shown
as ended with an action to create a new one, and a listing returns every
open terminal plus the 20 most recently ended ones. The worker deletes
an ended row 30 days after it ended. On attach the agent
replays the pane's recent history from tmux, up to the capture limit, into
the browser's scrollback, so a reload shows earlier output above the
prompt; the platform still stores no terminal output anywhere. tmux does
not pass `clear`'s erase-scrollback on, so when a pane's history drops to
nothing the agent sends `{"type":"clear"}` and the browser drops its own
scrollback (issue #882). The agent also reads a copy of each pane's
output through tmux's `pipe-pane -O` into a FIFO in its runtime directory,
scans it for the erase-scrollback sequence, and sends the clear at once, so
`clear && npm test` clears too; the bytes are dropped after the scan and
never logged. The pipe starts when a terminal is created and when the agent
starts with terminals already running. The half-second poll remains for a
pane whose pipe was replaced. The browser draws tmux's redraw, so a line
printed in the same instant as the clear may land either side of the wipe.
Growing the pane taller can pull the whole history back onto
the screen, which also sends a clear.

The browser connects to the control plane at
`/workspaces/:id/terminals/:terminalId/ws`, and the control plane connects
to the workspace agent at `/terminals/:terminalId/attach`. The two
connections carry identical frames so that the control plane can forward
bytes without interpreting them:

- client to server, text frames: `{"type":"input","data":"…"}` and
  `{"type":"resize","cols":N,"rows":N}`;
- server to client, binary frames: raw PTY output;
- server to client, text frames: `{"type":"exit"}` and
  `{"type":"error","code":"…"}`, plus the `cwd`, `screen`, `clear` and
  `agent` frames described in this section and section 22.5.

Limits, enforced by the server:

- at most 20 terminals per workspace. The cap stops a runaway client from
  creating terminals without end; it is not the resource limit, which is
  the container's CPU, memory and process limits. A refused create shows
  the user a toast naming the limit. Parallel creates are serialized per
  workspace, so they cannot pass the cap together;
- at most 4 simultaneous attachments per terminal;
- at most 64 KiB of data in one input frame, and at most 1 MiB in any
  frame the browser sends;
- the workspace agent pauses reading the PTY when a socket's buffered
  output passes 1 MiB and resumes when it falls below 256 KiB, so that a
  runaway process cannot exhaust memory.

The browser sends a `resize` frame only once the pane has stopped
changing size for 100 ms, so a drag sends one settled size rather than
one per step, each of which would make tmux reflow and the program
redraw (issue #849).

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

When the terminals unit stops, systemd's `$SERVICE_RESULT` is written to
`/run/portikus-terminals/last-exit`, or `oom-kill` when tmux died of
`SIGKILL` and the unit's cgroup `memory.events` counts an `oom_kill`
(with `OOMPolicy=continue` systemd itself says only `signal`), and the agent reports it on
`GET /terminals/last-exit` as `{"exit":{"result":"…","at":"…"}}`, with `at`
the file's modification time, or `{"exit":null}` when there is no record
(images before 2026.09.11) or the record is not a plain result word. When
the agent says a terminal's session is gone (`TERMINAL_NOT_FOUND` on
attach), or ends an open terminal with `{"type":"exit","serverGone":true}`
(the agent reads the attach client's final line, where tmux prints
`[exited]` for an ended session and `[server exited]` or
`[server exited unexpectedly]` when the server died, and asks tmux only
when no such line ends the output; `serverGone` is true only when the
terminals unit's tmux server is gone, and a line a student forges costs
at most the one bounded record lookup), the control plane asks for that record (after an `exit` it asks
again for up to 2 seconds, because the unit writes the record only once
its processes are gone), and if the
stop came after the terminal's creation time, sends the browser
`{"type":"error","code":"TERMINAL_NOT_FOUND","reason":"…","at":"…"}`, where
`reason` is `out_of_memory` for `oom-kill` and `restarted` for anything
else; otherwise the agent's own frame passes through. An `exit` without
`serverGone: true`, including one from an older agent, is an ordinary
exit and reaches the browser at once with no lookup. The agent is
untrusted, so the control plane makes at most one record lookup per
terminal connection and drops whatever the agent sends after the ending
frame. The browser then closes the pane and shows a warning toast, once per
restart (`at`), titled "Your workspace ran out of memory, so its terminals
were closed." or "Your workspace's terminals were closed.", with the body
"Open a new terminal to carry on." When a pane that ends held the keyboard
focus, focus moves to the work area's New control. Only the terminals
unit's stop is explained; an agent restart no longer loses terminals.

## 10. Coding-agent integration

### 10.1 Supported agents

P0:

- Claude Code;
- Codex.

The architecture should allow additional CLI agents without redesigning the terminal system.

Added by Epic 40 (ADR 0056): Claude Code and Codex are not part of the workspace image. They live in one shared folder on the platform VM, `/var/lib/portikus/coding-agents`, which every workspace sees read-only at `/opt/portikus/coding-agents` through the `coding-agents` disk device of the workspace profile. The folder is mounted as a whole, because a bind mount of the `current` link would freeze it. `bin/claude` and `bin/codex` in the folder never change; they point at `claude/current` and `codex/current`. In images from 2026.10.2 on, `/usr/local/bin/claude` and `/usr/local/bin/codex` are links to those `bin` links. For older images the workspace controller writes the same two links into the stopped workspace at each start, by the replace-the-path rules of §24.1, so every workspace moves to the shared tools at its next start. `/usr/local/bin` comes before `/usr/bin` on the path. An administrator updates the tools from the admin page without a rebuild (§22.4, §22.6). Open sessions keep the version they started with. The package's install script makes the folder and its `bin` links before it restarts the services, so a workspace that starts during an upgrade still gets its links; setup downloads the tools afterwards.

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

A launched agent starts in a new terminal whose tmux session runs the CLI directly, with no shell and no earlier output, so its scrollback starts empty (issue #886).

### 10.3 Direct CLI use

Students must also be able to launch coding agents manually from an ordinary shell.

A coding agent's interface assumes it owns the screen, so earlier shell output left as scrollback above it reads as a broken view (issue #886). The workspace image's `/etc/profile.d/portikus-agents.sh` therefore defines `claude` and `codex` shell functions for interactive bash only. When standard input and output are both a terminal, each runs `clear` and then the real CLI (`command claude "$@"`). `clear` empties tmux's history, which the workspace agent turns into a cleared browser scrollback (§9.7). A script, a pipe, `sh`, or a launcher gets the plain CLI with no clear, and ordinary commands keep their scrollback. `infra/tests/agent-clear-test.sh` and the smoke test check both sides. Added in image 2026.09.15.

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
- move within the project (a move may replace an existing file when the
  student confirms, never a directory);
- delete file/directory with application-styled confirmation where appropriate;
- upload;
- drag-and-drop upload;
- download file;
- download directory/project as archive;
- extract a zip into a new folder beside it (§11.6).

Rows are dragged with the browser's own drag and drop. A drop that would
leave the item where it is, or move a folder into itself, is refused and not
highlighted; the Move to dialog is the keyboard alternative. A rename or move
made in the files pane keeps the open tab of every file it moves, alone or in
a split, at its new path, with its unsaved text, diff baseline, cursor and
zoom; moves made by an agent or in a terminal are not followed. The project
download takes a repeated path to zip a selection of up to 100 files and
folders, named relative to their common folder (the menu's "Download N items
as zip"); the same size cap applies, and a selection whose names are too long
for one request is refused before it is sent. `GET .../extract/progress`
reports `{done, total}` entries of a running extraction, and "Extract here"
shows them on a progress bar.

A directory listing returns at most 2,000 entries per page with a
continuation token (the last entry sent, so a change between pages does not
shift the rest); the tree offers **Show more** for the rest.

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

The watcher does not follow generated folders (the names the tree hides,
section 11.3) or other common caches and environments: `venv`, `env`,
`.next`, `.cache`, `vendor`, `coverage`, `.gradle`, `.pytest_cache`,
`.mypy_cache` and `.tox`. The tree still shows those extra names. A project
with more than 20,000 folders, or whose first scan takes more than 10
seconds, is not watched at all: the agent closes that
watcher and sends one `{type: "watch_limited"}` frame instead of an error,
because a retry would scan the whole tree again. The browser then stops
reconnecting for that project, refreshes Files and Changes when the window
regains focus and after the student's own file actions, and the Files pane
says once: "This project is too large to update live. It refreshes when you
return to the window."

While a browser shows hidden files, the agent also follows the top-level
generated folders and the entries directly inside them, with a second watcher
that runs only while such a browser is connected; deeper changes inside them
wait for the next refetch.

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

The panel offers Match case, Whole word and Regex. All three are off by
default, which gives a case-insensitive literal search. A regular expression
uses ripgrep's default engine, never PCRE2. A pattern ripgrep refuses (a parse
error, or a regex too large to compile) is a 400 `PATTERN_INVALID`; a search
that only met unreadable folders returns what it found.

As built, the workspace agent runs at most four searches at once (one agent per workspace). A search past that is refused with 409 `BUSY`, and the search panel says too many searches are running in this workspace.

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

A download of a file, folder, or project is capped at 1 GiB (Epic 12b). The
agent refuses a larger one before doing any work, with `FILE_TOO_LARGE`, and
the API cuts off a relayed stream that runs past the cap plus a fixed zip
allowance.

A file read with `inline=1` is served for display in the browser (issue
#816). It serves only PNG, JPEG, GIF, WebP, SVG and PDF files, with the
type taken from the file name and never sniffed, plus
`X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that
starts with `sandbox;`. A response without `Content-Length` is refused.
Images, SVG included, are drawn only through `img`. A PDF is fetched and
shown from an in-page blob, because Chrome's PDF viewer refuses a
sandboxed frame.

**Extract here** on a zip (issue #817) extracts into a new sibling folder
named after the zip, `name-2`, `name-3` and so on when taken, and never
`.git`; nothing is merged. Before extracting, the agent reads the whole
central directory and refuses the zip with `ARCHIVE_INVALID` (422) for an
entry with `..`, an absolute or drive-letter path, any symbolic link, a
password, zip64, a `.git` path part, or a Unicode path field that does
not match the name, and for a central directory that does not end
exactly at the end record. The limits are 1 GiB declared size and 10,000
entries, and free space is checked. unzip runs under `prlimit`, and is
killed when the request aborts or when disk use passes the cap. A walk
after extraction refuses any `.git` path part.

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

A file's diff view has a small "Compare with" button in the file header. It opens a menu: Last commit (the default), A Git ref…, or A recovery point…. A ref or a point is asked for in a small dialog. The ref the student types The ref is at most 256 characters, with no leading `-`, no control characters and no `..`, and is resolved to a commit with `rev-parse --end-of-options`. A recovery point is read only when the student presses Compare, because the read can take up to a minute (§15.8). The choice is local to the view and is never saved in the layout. There is no Changes list against a ref.

### 12.7 Agent-session change review

In addition to the Git `HEAD` comparison, P0 must support reviewing changes relative to the baseline created when a Portikus-launched coding-agent session began.

The session review must:

- show files created, modified, renamed, and deleted during the session;
- allow opening individual text-file diffs relative to the session baseline;
- distinguish the session baseline from Git `HEAD`;
- continue to work when the repository was already dirty before the agent session began;
- use the same large-file and binary-file safeguards as the Git diff view.

The UI should make the baseline explicit, for example `Changes since Claude session started`, rather than presenting session changes as Git changes.

As built: the session baseline holds tracked files and the untracked files Git would show, so Git-ignored files are left out of the session review, except `.env` and `.env.*` files at the project root. The diff's two sides are labelled "Session start" (or "Last commit" in the Git diff) and "Your changes" (Epic 25).

### 12.8 Branch, remote, and preservation state

Portikus must make the minimum Git state needed to understand whether work has been preserved visible without becoming a graphical Git client.

P0 should show, when available:

- current branch or detached-HEAD state (a detached HEAD shows its short commit id);
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

A `.csv` file small enough to edit opens as a read-only table with View, Edit and Diff. The first record heads the columns. Each row shows its data-row number as a row header, and the column headers sort a view of the whole file (ascending, descending, file order). Sorting never changes the file and never saves. At most 1,000 rows and 200 columns are drawn, and the view says how many the file holds. A file that is not valid RFC 4180 CSV says so and offers its text.

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

Fenced code that names a language Monaco knows is highlighted with Monaco's tokenizer. The highlighter's HTML is never inserted: it is rebuilt from token classes and text only (§24.3).

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
- keep unsaved text when a file pane remounts, as a move into or out of a split or a rename does, whether autosave is on or off (with autosave on it is saved at once; the undo history is not kept);
- surface save failures clearly.

A write that fails because the disk or quota is full (`ENOSPC` or `EDQUOT`)
is `STORAGE_FULL` (HTTP 507) on every agent route, and the control plane
relays it as such. A failed save then says "Your home folder is full. Delete
files, then save again."; upload, new folder, move and project create say
"Your home folder is full. Delete files, then try again." Clone, template,
`git init` and duplicate answer `STORAGE_FULL` too when git or the copy reports
a full disk or quota, and the clone dialog says the home folder is full.

An explicit keyboard save command such as `Ctrl/Cmd+S` may force an immediate save, but students should not need to remember to save manually for normal operation.

Per-user preferences. Autosave on or off, the autosave delay, word wrap, the
terminal colour scheme, and the workspace timezone are settings of the
signed-in user, not of the browser. They are stored on the server, read and
written through `GET` and `PUT /me/settings`, and changed in Settings,
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
`accessibilitySupport` "on"; when off, Monaco's support is "auto", not
"off". A browser cannot detect a screen reader, so in practice "auto"
behaves as off, but it keeps the editor's own name, which "off" replaces
with "The editor is not accessible at this time.". That name gives the
file and the way out, such as "Editor, src/app.ts. Ctrl+M makes Tab leave
the editor." (Ctrl+Shift+M on macOS, Monaco's key there), and each side of a diff is named the same way. A change applies
to open terminals and editors without a reload. It is set in Settings or
by the workspace page's first Tab stop, a skip-link-style button that is
hidden until focused, reads "Turn on screen-reader mode" or "Turn off
screen-reader mode", saves the setting at once, and announces the change
from a status region. The keys that are hard to discover and what xterm.js
and Monaco cannot do (section 25.8) are listed on the Help page under
`/help#student-keyboard`; Settings, Accessibility links there (Epic 25).

Settings saves as it goes (Epic 25). Each preference is saved as soon as it
changes; a typed value, such as the autosave delay, is saved on blur, Enter
or when the dialog closes. One status line says "Saved", and the dialog has
only a Close button. A save that fails while the dialog is open shows its
error in the dialog; one that fails after it closed shows the danger toast
"Your settings change was not saved".

Profile. Settings opens with a Profile section. The display name, email,
sign-in name, and workspace label come from the institution sign-in and are
shown as a list of labels and values, not as fields. The student may add a GitHub username or https link, one personal
https link, and a PNG or JPEG picture of at most 1 MiB, read through
`GET /me/profile`, changed through `PUT /me/profile`, `PUT /me/picture`, and
`DELETE /me/picture`. The API reads the picture type from its bytes, stores
the picture on the users row, and serves it at `GET /me/picture` to its owner
only. The picture replaces the initials in the account menu button. The
links are saved like the autosave delay, on blur, Enter or close, and only
when valid: an invalid link shows its error and is not sent. A picture is
saved as soon as it is chosen. Links are
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

HTTPS upstreams (Epic 24, issue #283, ADR 0041): a student server that
speaks HTTPS on its port, such as `vite --https`, previews like any
other. Changed by Epic 28 (issue #957): the agent never sends anything to
a listener while discovering it. The first time a preview of a port is
requested, from the Preview tab or the preview gateway's first request
for that port, the API asks the agent (`POST /listening/:port/probe`) to
settle the port's protocol. The agent completes one TLS handshake, with
certificate checks off and a one-second timeout, with that socket at its
own loopback or bound address, never at an address the caller names;
racing requests share one probe. It caches the answer by socket inode, so
a restarted server is probed again, and publishes it with
`protocolKnown: true`; a completed handshake sets `protocolHint: "https"`.
Until then `protocolHint` is a guess from the port number (`http` or
`unknown`). System listeners and ports below 1024 are never probed. The
API remembers every probe answer, final or not, for 30 seconds per
workspace and port, and caches only a final answer beyond that; a failed
or unsettled probe leaves the guessed protocol standing. The memo for a
port is forgotten when its hint changes, or when a listener the API knew
as probed comes back unprobed, so a server restarted with `--https` is
probed again. Concurrent requests share one call, the call has a
1.5-second timeout, and the memo is pruned as it goes and dropped with
the workspace. A workspace reports at most 1,024 listening services
(`MAX_LISTENING_SERVICES`): the agent trims to that, student listeners
first and then by port, and the API drops any longer frame and keeps the
previous list. `/preview/authorize` then sends
a second trusted header, `X-Portikus-Upstream-Scheme: https` (or `http`),
taken only from the listening registry. Caddy strips any client-sent
copy, and for `https` uses a TLS transport with certificate checks off
for that hop only, WebSocket upgrades included. The API's framing probe
speaks HTTPS to the same registry target. The browser still sees only
the platform's certificate.

### 14.6 Preview tab

The center pane must support an application Preview tab.

The user may:

- select or enter a listening port;
- open the service within the center pane;
- open it in a separate browser tab/window.

In the "Open a preview" dialog each listening port is a bordered row with a trailing chevron, so it reads as a button. The Preview tab's toolbar holds the host, Back, Forward, Reload and Open in new tab; a "More preview actions" menu holds Copy URL, the frame width (one checkable item per width), Reset preview data and Show in Running.

"Reset preview data…" first asks for confirmation in the neutral (not red) confirmation dialog.

### 14.7 Port discovery

The workspace agent should detect listening TCP ports.

The UI may surface likely development ports automatically.

P0 should favor unprivileged application ports, normally `1024-65535`.

As built: a preview is refused for a port below `PREVIEW_PORT_MIN` (1024) or listed in `PREVIEW_DENIED_PORTS` (by default 22, 2375, 2376 and 5432, plus the agent's port). The preview then says "Port {n} cannot be previewed", explains that such ports, including ones kept for SSH, Docker and PostgreSQL, cannot be opened, suggests a port such as 3000 or 5173, and offers **Choose another port…** (Epic 25). The browser keeps no port minimum of its own: a terminal link to any port opens the Preview tab, and the API's policy alone decides.

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

A restore puts back the whole project, its `.git` folder included, so the repository returns to the state it was in at that point, commits and all. Portikus never makes Git commits for the student; the recovery dialog says so (Epic 25).

A student can compare one file with its version in a recovery point. The agent reads only that file from the archive, checks the archive's recorded SHA-256 first, caps each side as Git diffs are capped (§12.6), and gives up after 60 seconds with `RECOVERY_READ_TIMEOUT`. Only one such comparison runs per workspace at a time; a second answers 429 `RATE_LIMITED` until the first ends.

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
of its allowance. The newest point of each project is never deleted. Once
per sweep the worker lists the archives on each workspace's recovery volume
and deletes any file older than one hour that has no `recovery_points` row,
at most 20 per workspace per sweep, stopping at the first failure. The
`.portikus-aside-*` folders a failed restore leaves in the student's home are
never deleted automatically, because they may hold the only copy of the
student's files.

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

The workspace image pins Docker to the classic overlay2 store, so images
land on the workspace's Docker volume rather than in Docker 29's default
containerd image store on the root disk. The image health check refuses
an image that does not (section 22.4; issue #840).

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
409 `OPERATION_PENDING`. Since Epic 26 the new volume is a copy of the
current seed when there is one (section 16.6).

### 16.5 Docker status

The UI should expose understandable Docker resource/status information without requiring the student to parse daemon internals.

### 16.6 Docker pull cache and seed

Added by Epic 26 (issue #840, ADR 0045). Two things share Docker's cost
across workspaces.

**Pull cache.** Workspaces pull Docker Hub images through a pull-through
cache on the Portikus VM: Debian's `docker-registry` 2.8 in proxy mode on
the workspace gateway, `10.200.0.1:5000`. The second student to pull an
image downloads almost nothing from the internet, and the site stays under
Docker Hub's anonymous rate limit. The cache's storage is its own
fixed-size ext4 file at `/var/lib/portikus-registry`, sized by the install
question `portikus/registry-cache-gib` (default 20 GiB). Registry 2.8 has
no size cap; it expires blobs 7 days after first fetch, and the status
timer clears the whole cache when it passes 90 percent full. An
administrator can also clear it from the Docker tab (section 20.1).
The cache is an optimisation and never fails setup: when the answered size
would leave less than 10 GiB free on the main disk, setup makes the largest
whole-GiB cache that keeps the 10 GiB, and when not even 1 GiB fits it turns
the cache off (the file `/etc/portikus/registry/cache-off`), warns in its
output, and workspaces get no mirror. Added by Epic 28: the marker holds one
sentence saying why (the free space counted and the 10 GiB kept), which the
cache helper reports in its status and the Docker tab shows with how to turn
the cache back on; Clear cache does nothing while the cache is off, and the
API refuses it. The install question for the cache size uses setup's rule:
the free space beside the cache file plus the space the file already holds,
less 10 GiB. A workspace already running when the
cache turns off keeps its cache settings until its next restart; meanwhile
the gateway no longer redirects ghcr.io traffic, so its pulls fail plainly.
The cache file's space is reserved in full: setup and a clear reserve any
holes again, and the weekly fstrim leaves it alone because it trims only
the file systems in `/etc/fstab`.

**ghcr.io cache, on by default.** A second registry on `10.200.0.1:5001`
caches ghcr.io (GitHub's container registry). It is on by default (Todd's
ruling of 2026-09-30, migration 0033), because students push images from
GitHub Actions to the real ghcr.io and only pull public images inside
workspaces. While it is on, a workspace's `/etc/hosts` points `ghcr.io` at
the gateway and Docker trusts an internal certificate for it, so inside
workspaces `docker push` to ghcr.io, private ghcr.io images, and tools
other than Docker that talk to ghcr.io (curl, `gh`, ORAS) do not work, and
`docker login ghcr.io` reports success without checking. An administrator
can turn it off; the change reaches each workspace at its next start.

**Workspace Docker settings.** Before each start the worker tells the
controller whether to use the Hub mirror and the ghcr.io cache, each only
when the egress policy lets that registry's names through (section 23.6).
The controller, with the container stopped, writes `/etc/docker/daemon.json`
whole (the overlay2 pin of section 16.2, the only setting the image puts
there, plus `registry-mirrors` only for the Hub mirror) and adds or
removes the ghcr.io certificate. A student's own edits to `daemon.json`
last until the next start. After the start a command inside the
container adds or removes the ghcr.io hosts line and keeps the student's
other lines; if `/etc/hosts` is not a regular file it is replaced by a
fresh one. If the cache is down,
Docker falls back to Docker Hub directly.

**Seed.** One global seed volume, `portikus-docker-seed`, holds a list of
images an administrator chooses (at most 30, total size capped by a
setting, default 8 GiB). A new workspace, a student's Reset Docker
(section 16.4) and an admin rebuild with Reset Docker get a Docker volume
that is an LVM-thin copy of the current seed: it costs no disk until
changed. The copy is sized at the configured Docker size plus the seed's
size (never below the seed volume's own size), and the seed's share is
recorded on the volume in the `user.portikus.seed-gib` key so later quota
changes count it. Only those three moments take the current seed; an
existing volume is never replaced behind a student's back. With no seed,
or when the copy fails, the workspace gets an empty volume as before and
the controller logs a warning.

A seed rebuild runs in an ordinary unprivileged workspace container from
the current default image, pulls each image through the cache, removes
containers and build cache, stops dockerd cleanly, and swaps the new
volume in. A seed over the size cap fails the build and the old seed
stays. Workspaces already copied from the old seed are not affected.

Added by Epic 28 (issues #931, #932). The Docker tab shows each image's
download size (compressed, for the host's platform), read by the cache
helper from manifests the cache already holds; it never fetches anything.
The helper keeps a size 120 days after the cache last held the image (at
most 1,000), and the tab shows a dash, read as "Not known", for an image
the cache never held. A meter shows the cache's use with its 90 percent
auto-clear mark, and another shows the seed's size on disk against its
limit. A seed list no administrator has set starts with the official slim
images matching the default workspace image: `node:<major>-slim` and
`python:<major.minor>-slim` (3.14 when the image was built with uv 3.14).
The API writes it, sets `settings.docker_seed_images_set` and audits
`docker.seed_images_defaulted` when the Docker tab is first read; it starts
no rebuild. The platform never edits a list an administrator has set or
emptied. When the default image changes and the list lacks its matching
images, the Seed card shows a notice with one button
(`POST /admin/docker/seed/match`) that replaces the old matching slim tags
with the new ones and queues a seed rebuild in one transaction. The button
is not offered, and the route refuses, when the estimated download would
pass the seed's size limit.

**Usage report.** The registry's notification webhook tells the worker
about each pull, and every hour the worker asks each running
workspace's agent for its Docker inventory (`GET /docker/inventory`). A
seed image counts as used in a workspace when a container references it or
another local image is built on it. The Docker tab shows, over the last
120 calendar days, today included, and as counts with download sizes,
images pulled that are not in the seed and seed images nobody uses. Rows
are kept 120 days, never less than the report's window (Epic 28, issue
#934).

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
- checks live in `.portikus/checks.json`, which Git tracks (§7.2); a new
  project gets a `.portikus/README.md` that explains the format with an
  example that must stay a valid checks file, and no check is written for
  it;
- projects without configured checks must remain usable;
- an agent may run the same commands directly, and resulting state should be reflected when practical;
- test execution must obey ordinary workspace resource limits.
- stopping a check stops its whole process tree as closing a terminal does
  (§9.7), and a check's output pauses for a slow watcher as a terminal's does.
- a run the student ends with Stop is state `stopped`, shown with a neutral badge, even when its command catches the signal and exits on its own. Any other death by a signal (the out-of-memory killer, a `kill` from a shell) is `failed` with exit code 128 plus the signal number. The exit frame carries a `stopped` flag so the output panel can tell the two apart (Epic 40).

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

Each row shows the port, then the process or container name with its tags (Docker, Can't be previewed, System service) on a second line, so the name keeps the row's width. A previewable row's first action is a visible **Preview** button named "Preview port <n>" for assistive technology; opening in a new tab and Stop stay icon buttons. The details panel under a selected row is a key-and-value list on the page surface, not terminal-styled. In the tabbed right pane (Files, Checks, Running, Monitor) the tab names the pane, so each pane's heading is kept for screen readers only and no title row repeats it.

Added by Epic 25: Checks, Running and Monitor each have a pane head row with an "About" toggletip at the start and the pane's actions at the end; Running's head holds the "Show system" checkbox, shown when there are system listeners or the box is ticked, and a row that cannot be previewed has a toggletip saying why. The right pane is a size container (the product's first `@container`), so each surface lays itself out from the pane's width, not the window's: below 18rem a Running row moves its actions to a second line, and the tabs tighten below 17rem. Checks that have never run say "Run a check to see its output here."

A listener owned by one of the student's own processes carries an optional `commandLine`, and its row has the same full-command disclosure button as Monitor (section 18.3). The workspace agent reads `/proc/<pid>/cmdline` only when the process's real and effective uid are the student's; system and Docker listeners carry none, and an older agent sends none, so the row shows no button. The API truncates it to 1024 characters. Like Monitor's, it goes only to the student and is never logged, audited or shown to an administrator (Epic 22).

The workspace agent finds listening ports by scanning `/proc` on a timer. A scan never starts while the previous one runs, and the timer scans only while a browser or the control plane watches the port events or a forward exists; `GET /listening` still scans on demand. A socket's owner is remembered from the last scan, and the `/proc/<pid>/fd` links are walked only for a new socket or an owner that has exited. Stopping a listener always walks afresh, and fails with `STOP_FAILED` rather than act on stale data when that scan fails.

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

The state is marked unconfirmed when Portikus cannot vouch for it. The worker records in `settings.controller_checked_at` each time it reaches the workspace controller. The API sends `stateVerified: true` on the Workspace only while that time is within the last two minutes; before any check, after a longer gap, or when the recorded time is in the future, it sends `false`. `STATUS_REFRESH_SECONDS` may be at most 60, half that window; a larger value stops the worker from starting. In every state, the status bar then shows a warning-toned "unconfirmed" with an alert icon inside the state button, and the button's accessible name adds "Portikus can't reach the workspace host right now, so this may be out of date." The state text itself is unchanged.

The "Your workspace" dialog, opened from the status bar, puts the state and its Restart and Stop (or Start) buttons first. Below them come "Storage", with one meter per class that also states its figure as text ("X of Y"); "Docker", with Reset Docker and a line saying what it throws away and what it keeps; the rebuild note; and a collapsed "Technical details" with the desired state, connections and image. While the workspace is in error, the dialog shows the error message and the same storage figures as the error screen (section 28).

As Monitor narrows, the PID column hides below 16rem and the Memory column below 14rem, so Command, CPU and the two action cells always fit; the Stop button still names the PID (Epic 25).

Stopping one process (Epic 21): the agent's `POST /processes/:pid/stop`
takes `{startTicks, force}`. It rereads `/proc/<pid>/stat` and `status`
first and refuses a gone PID (404 `PROCESS_NOT_FOUND`), different start
ticks (field 22 of `stat`, which catches a reused PID; 409
`PROCESS_CHANGED`), and a protected process (403 `PROCESS_PROTECTED`):
PID 1, anything whose real or effective uid is not the student's, and
the platform's own machinery, by PID: the agent itself, its
`tmux attach-session` clients (the PIDs the terminal registry spawned),
and the tmux server that holds the terminals (the main process of
`portikus-terminals.service`, found through the agent's own tmux
socket, never by the name `tmux: server`, which any process can take)
with its direct children, the pane shells, read from the parent links
in `/proc` at the moment of the stop. Stopping any of these closes a
terminal or breaks the agent. A program the student asked to run stays
stoppable, wherever it sits in the tree: everything below a pane shell,
and a program the agent starts on the student's behalf, such as a check
run (§18.1), with all its descendants. There is no list of protected
names. A "no server" answer is reused for 10 seconds by the
usage sample, but never by a stop. Otherwise it sends
SIGTERM, or SIGKILL when `force` is set, waits up to 3 seconds, and answers
`{pid, exited}`; a zombie or a vanished PID has exited. It never escalates
to SIGKILL on its own. The student reaches it through
`POST /workspaces/:id/processes/:pid/stop` (owner only, 409
`WORKSPACE_NOT_RUNNING` when stopped, one stop per workspace at a time with
409 `STOP_IN_PROGRESS`, shared with the administrator's stop, and 30 stops
per person a minute). Each usage row
carries `startTicks`, `stoppable` (false for a protected process) and
`commandLine`; an agent older than Epic 21 sends none of the three, and the
API reads its rows as start ticks 0, not stoppable, with no command line, so
Monitor shows them without Stop until the workspace restarts. `commandLine` is the student's own processes' `/proc/<pid>/cmdline` with NULs
as spaces, capped at 1024 characters, null for anyone else's. The command
line goes only to the student; it is never logged, audited or shown to an
administrator. Memory used is the cgroup's working set: `memory.current`
less `inactive_file` from `memory.stat`, as the guard counts it (19.4).

In Monitor, a row whose process is `stoppable` has a Stop icon button named
"Stop {name} (PID {pid})". It opens a confirmation, "Stop {name}?" with the
PID. If the process outlives the stop, the dialog stays open, says "{name}
is still running." and offers **Force stop**; nothing is killed until the
student presses it. Refusals show in the dialog in plain words ("That
program has already stopped.", "That process ID now belongs to a different
program. Refresh and try again.", "Portikus needs this process, so it
cannot be stopped here."). A stopped row leaves the list at once, the
result is announced, and focus moves to the list's heading. Focus also
moves to that heading whenever a new sample takes away the row that held
focus. While focus is inside the list, rows keep their order (new rows go
last) and the list sorts again when focus leaves it. A long name wraps
rather than being cut off. A row with a
`commandLine` has a disclosure button ("Show the full command for PID
{pid}") that shows the command line in a row below it, in the monospace
face. Monitor's sort is held by the right pane, so a notice or the status
bar can open Monitor sorted by CPU or memory, largest first; opened that
way, focus moves to the visible Monitor tab once the tabs are shown (not
while Find in files covers them). A throttle or memory notice that goes
away on its own while it holds focus hands focus to the work area; a
notice that never held focus moves nothing.

Every Monitor row has the same height, with or without buttons. The actions sit in two fixed columns, the command disclosure first and Stop second, and a row without one of them leaves that cell empty (Epic 22).

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

- Projects and home;
- Docker;
- Recovery.

As built (Epic 10): the agent's usage sample reports `storage.home`,
`storage.docker`, and `storage.recovery`, each used and total bytes from
`statfs` on its mount, or null when the mount is missing. A stopped
workspace has nothing to measure, and the UI says the figures are available
when it runs. The status bar warns at 80% of any class and names it. At 95%
the message also names a next step: Reset Docker or `docker system prune`
for Docker, automatic removal of older points for Recovery, and deleting
files for Projects and home. The warning, like the workspace state beside it, is a bordered
button that opens the workspace dialog, and it keeps its warning or error
colour. Quotas are environment configuration in this
epic; changing them at runtime is Epic 11.

The status bar always shows two compact meters while the workspace runs
(Epic 21): "Memory {used} of {total}", the working set against the limit
(19.4), and "Disk {used} of {total}", the Projects and home volume. Each is a
bordered button with a small bar: Memory opens Monitor sorted by memory, Disk
opens the workspace dialog and its storage meters. A meter turns to the
warning tone with the alert icon at or above 85% of its limit and stays so
until use falls below 80%, so it does not flicker near the line; Disk turns
to the error tone at 95%. The bar shows a percentage, and the accessible name
carries the full figure in words and adds "nearly full" when warning
(Epic 33). The storage warning above keeps its own
wording and tone beside them. A meter with no figure is not drawn. The
meters use the same 30-second usage poll, which asks every 2 seconds until
its first sample arrives. Only a crossing is announced, never a new figure:
memory into warning through a status region of its own, so a storage change
does not repeat it, and storage through the storage warning's region. When
the bar is short of room the project path gives way first, with an ellipsis.

### 19.3 Denial behavior

Resource exhaustion must fail safely.

One student's CPU, memory, storage, process count, or Docker workload must not materially degrade other users beyond the capacity limits of the shared host.

When a workspace reaches its memory limit, the kernel kills the biggest process in it, and only that process: both the workspace agent's unit and the terminals unit set `OOMPolicy=continue`, so the rest keep running.

On images from 2026.09.11 the tmux server, every shell and every program started in a terminal run in their own unit, `portikus-terminals.service` (`tmux -L portikus -f /dev/null -D` as the student, `Restart=always` after one second, `TasksMax=1700`), so an agent restart or an out-of-memory kill of the agent leaves terminals open, and a terminal's runaway program cannot starve the agent of processes. The agent's unit has `TasksMax=infinity`; the container's `pids.max` of 2000 is its only ceiling. On images from 2026.10.1 Docker puts every container under `portikus-docker.slice` (the `cgroup-parent` in daemon.json, which the controller also writes before each start), capped at `TasksMax=1000`, so containers together cannot take the room the agent and the terminals need; each container's own scope stops at systemd's default of 15%, 300. The slice cap guards against accidents, not a determined student. A Check also runs under a 1,700-task limit (`RLIMIT_NPROC`, the same number as the terminals unit's `TasksMax`), so a fork bomb in a Check cannot starve the agent, which is not limited itself. The limit is per student user, not per Check: it counts every process the student owns, a Check will not start once the student already has 1,700, and terminals may starve while a bomb runs. Like the other caps it guards against accidents, not a determined student. The agent unit wants and orders after the terminals unit but never requires it, so a terminals restart never restarts the agent. No unit sets `OOMScoreAdjust` (ADR 0035).

`/tmp` is a tmpfs capped at 512 MB and `/dev/shm` at 256 MB, so a big temporary file fails with "No space left on device" instead of using up the workspace's memory.

### 19.4 Resource guard

Added by Epic 14.3 (ADR 0032). The guard slows a workspace that keeps its CPUs busy for a long time and marks one that keeps its memory near the limit, so a crypto miner or a long-lived site cannot hold the platform's CPU. Programs, mining pools and tunnel services are not blocked by name; the throttle, the memory flag and the acceptable-use statement (section 5.1) are the whole response.

**Measuring.**

- The worker samples every running workspace every 60 seconds, on its own loop beside the host sampler (ADR 0022). The numbers come from Incus through the controller's `GET /instances/usage`, never from the workspace agent, which the student controls (section 24.2). For each running instance the route returns its CPU time since start (`state.cpu.usage`), its memory working set, its CPU limit (`limits.cpu`, or the host's CPU count when unset), its memory limit, its current CPU allowance, and a boot marker (Incus `state.pid`, the host PID of the instance's init, which changes on every boot, including a reboot from inside the workspace; null when Incus reports 0).
- Memory is the working set: Incus's usage minus the `inactive_file` page cache from the instance's cgroup `memory.stat`, so reading large files does not look like memory pressure. If that file cannot be read, the controller reports the usage with cache and logs a warning.
- No process list, command line or file name is read (section 20.1).
- Each sample is a row in `workspace_usage_samples` (section 26). A workspace's samples are kept when it stops. Samples older than the longest allowed window plus five minutes (245 minutes) are pruned each tick.

**Judging.** A rule fires when an average is strictly above its threshold, so a threshold of 100 turns that check off.

- A restart between two consecutive samples is a changed boot marker (when both samples have one) or a CPU counter that went down.
- CPU is judged across runs over a rolling window of wall-clock time, and usage is remembered across stops and restarts. The anchor is the newest sample at least one window old; with no such sample there is no decision yet. The CPU time used between each pair of consecutive samples from the anchor to now is summed. Across a restart, the later sample's whole counter counts, plus the time between the two samples, capped at one sample interval (60 seconds), times the CPU limit, as if the workspace had used every CPU before restarting. Stopped time has no samples and counts as no use. The average is the used CPU time divided by the time since the anchor times the CPU limit. So a student who runs 25 minutes and stops for one, over and over, is still throttled, while an honest restart in a quiet window adds at most one minute of assumed use. Because of that assumed use, the average recorded after a reboot from inside the workspace can exceed 100%.
- Memory is judged per run: the mean of working set over memory limit across the samples in the last window that were taken since the latest restart, and only when there are at least half a window of them. For memory, a gap of more than two sample intervals also counts as a restart, since a stop leaves no samples.
- A throttled workspace is still sampled but not judged for CPU again until the throttle is lifted; a flagged one is not judged for memory until the flag is cleared.
- Each tick a throttled workspace is judged for an automatic lift (Epic 21, #596). Only samples taken after the throttle's `at` count. The anchor is the newest such sample at least the lift time old; with none there is no decision yet. The average is computed as for the CPU judgement (the same restart rule, against the full CPU limit, not the throttled allowance), and the throttle lifts when it is strictly below both the lift percent and half the throttle's share. A throttled workspace cannot use more than its share, so without the second bound a busy workspace with a small share would lift and be throttled again in a loop. The student's `idleLiftPercent` is the smaller of the two, rounded down to a whole percent.

**Throttling.**

- A workspace whose CPU average is above the CPU threshold (default 80%) over the window (default 30 minutes) is throttled to the throttle share (default 25%) of its CPU limit. The throttle is Incus's `limits.cpu.allowance` written as a time slice, `<N>ms/100ms`, where N is the share times the CPU limit times 100 ms, rounded to a whole millisecond: 25% of a pilot workspace's 2 CPUs is `50ms/100ms`, half a CPU, which the cgroup shows as `cpu.max` `50000 100000`. It is never a percentage, which Incus treats as a soft weight that only applies when the host is busy.
- The database is the source of truth. Throttling writes `workspaces.cpu_throttle` (when, the average, the threshold, the window, the share and the allowance) and the audit row `workspace.cpu_throttled` in one transaction, then asks the controller to set the allowance (`PUT /instances/:name/cpu-allowance`, which accepts only `^\d{1,6}ms/100ms$` or null). Every tick the worker compares each running workspace's allowance in Incus with its row and sets or removes it when they differ, so the throttle survives a restart of the worker or the controller and a lift reaches Incus even if the controller was down. A failed controller call is audited once as `workspace.cpu_throttle_failed` and retried next tick; the row stays throttled.
- The throttle lifts on its own after a quiet spell (above), at the next stop, or when an administrator lifts it. An automatic lift clears `cpu_throttle`, deletes the samples taken at or before the throttle, and audits `workspace.cpu_throttle_lifted` with `{reason: "idle", averagePercent}` in one transaction; the same tick removes the allowance from Incus. The controller removes any allowance before every start, unless the worker passes a held throttle's allowance with the start (below). When the worker records a stop by any path it clears `cpu_throttle`, deletes the workspace's samples taken at or before the throttle, so the next run starts a fresh window, and audits `workspace.cpu_throttle_lifted` with `{reason: "stopped"}`. An administrator's lift clears the row, deletes all the workspace's samples, and audits the same event with `{reason: "administrator"}`; the worker removes the allowance on its next tick.
- The student sees a warning notice at once, with the numbers from the row (the student's `cpuThrottle` also carries `idleLiftMinutes` and `idleLiftPercent` from the settings row, both null when automatic lifting is off): the workspace was slowed because it kept its CPUs busy, what share it now gets, and that stopping and starting restores full speed or an administrator can lift it. When lifting is on, the notice adds "It returns to full speed on its own after {minutes} minutes under {percent}% use." Its **See what's using CPU** button opens Monitor sorted by CPU. It is dismissible for the page's life. There is no warning before the throttle. When a throttle the open page was showing goes away while the workspace is running, the page shows the toast "Your workspace is back to full speed" (a stop or restart clears the throttle too, and gets no toast); the worker writes no notification.

**Memory flag.** A workspace whose memory average is above the memory threshold (default 90%) is flagged: `workspaces.memory_flag` (when, the average, the threshold, the window) and `workspace.memory_flagged`. Nothing is slowed, because memory already has a hard limit. The owner's workspace view carries the flag as `memoryFlag` (when, the average, the threshold, the window). The student sees a warning notice, dismissible for the page's life per flag: "Your workspace has been near its memory limit", "For {window} minutes it used more than {threshold}% of its memory. If it runs out, the biggest program is stopped.", with a **See what's using memory** button that opens Monitor sorted by memory. The flag clears at the next stop (`workspace.memory_flag_cleared` with `{reason: "stopped"}`) or when an administrator clears it (`{reason: "administrator"}`, which also deletes the workspace's samples).

**Settings and overrides.** The platform values are columns on the `settings` row, edited in the admin Settings tab in four groups, "Slow down heavy CPU use", "Give full speed back", "Keep repeat cases slowed" and "Flag high memory" (Epic 25): CPU threshold (1 to 100, default 80), memory threshold (1 to 100, default 90), window (5 to 240 minutes, default 30), throttle share (5 to 100, default 25; 100 means the throttle changes nothing), the automatic lift's quiet time (`cpu_idle_lift_minutes`, 1 to 60, default 5) and quiet percent (`cpu_idle_lift_percent`, 0 to 100, default 10; 0 turns automatic lifting off), and the idle time of section 6.4. The two lift settings have no per-workspace override. Each workspace may override any of the others in the nullable jsonb column `workspaces.guard_config`, with the keys `cpuThresholdPercent`, `memoryThresholdPercent`, `windowMinutes`, `throttleSharePercent` and `idleStopMinutes` and, since Epic 28, `keepRunningMaxHours` (section 6.4); a missing key uses the platform value, as `quota_config` does. A change takes effect on the next tick.

**Throttle hold (Epic 24).** Stopping and starting used to lift every throttle, so a student could run a heavy load, get throttled, restart and repeat. Two settings bound that: `cpu_throttle_hold_after` (0 turns holding off, otherwise 1 to 10, default 3) and `cpu_throttle_hold_hours` (1 to 168, default 24). The worker keeps each workspace's recent throttle times in `workspaces.cpu_throttle_recent`, trimmed to the window. When a throttle is the Nth within the window, the row's `cpu_throttle` gains `held: true`, the worker audits `workspace.cpu_throttle_held`, and every enabled administrator gets one warning notification. A held throttle is not cleared when the worker records a stop: the worker passes the allowance with the start request (`POST /instances/:name/start` with `{cpuAllowance}`), and the controller sets it before the instance runs, so there is no moment at full speed. The automatic idle lift and an administrator's lift still work. The student's notice adds "It stays slowed after a restart because it was slowed {n} times in the last {hours} hours." The Health tab and the Workspaces table show a **Held** tag beside **Throttled**. An administrator's lift does not clear `cpu_throttle_recent`, so a workspace lifted by hand can be held again sooner than one that started fresh.

**Per-workspace limits (Epic 24).** An administrator can set one workspace's CPU count (1 to 64), memory (512 to 262,144 MiB) and process ceiling (500 to 32,768) in the nullable jsonb column `workspaces.limits_config`; a missing key uses the Incus profile. A worker sync, like the quota sync, applies the change and records it in `limits_applied`. The controller sets or removes `limits.cpu`, `limits.memory` and `limits.processes` on the instance, never on the profile, and Incus applies them live to a running workspace. The controller refuses more CPUs than the host has. Lowering memory below what the workspace uses makes the kernel stop its biggest process (section 19.3), and the dialog says so before Save. A CPU change while throttled rewrites the throttle's allowance from its share in the same transaction; clearing the CPU override recomputes it from the profile's CPU count (a CPU set such as `0-3` counts as four), or the host's when none is readable. A process ceiling above 1,700 does not raise the terminals unit's own `TasksMax` (section 19.3), and the dialog says so. The guard's averages use the instance's own CPU limit, so an override counts.

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
- revoke platform access;
- view the platform's own error, warning, info and debug log lines (Epic 19, section 24.11).

As built (Epic 11, ADR 0022): revoking access and disabling are one action,
Disable account, which ends the user's sessions and preview sessions and
stops their workspace; an administrator cannot disable their own account.
Archiving a workspace stops it and keeps its data; an archived workspace is
never started until it is unarchived. Home and Docker quotas can only grow,
up to 1024 GiB each, and the worker applies the change; CPU, memory, and
process limits are shown but not edited (Epic 24 made them editable per
workspace; see below and section 19.4). An account is marked stale after
30 days without a sign-in (counted from its creation when it has never
signed in), or when another account with the same email signed in more
recently; nothing is merged automatically. An account that has never
signed in and is not stale shows a neutral "Not signed in yet" note
instead (issue #842). An administrator
sees a workspace's aggregates (CPU, memory, disk, port numbers, short
process names) but never its files, terminals, or process command lines.
Logs stay in journald; since Epic 19 (ADR 0036) the admin page's Logs
tab shows the platform's own lines from it (section 24.11).

Added by Epic 14.3 (section 19.4, ADR 0032): administrators see throttled
and flagged workspaces as **Throttled** and **High memory** tags in the
Workspaces table and in a "Resource guard" section of the Health tab
(`GET /admin/health` carries `guard`). The workspace detail panel shows
the guard state and the last activity time, with **Lift throttle**
(`POST /admin/workspaces/:id/lift-throttle`) and **Clear memory flag**
(`POST /admin/workspaces/:id/clear-memory-flag`), each answering 409
when there is nothing to lift or clear, and a dialog for the workspace's
guard and idle overrides (`PUT /admin/workspaces/:id/guard`, each key a
number or null to remove it). The Settings tab edits the guard
thresholds, window, throttle share, the automatic lift's quiet time and
percent, and idle time, and the acceptable-use statement with **Reset to default** (section 5.1).

Added by Epic 21 (ADR 0037): an administrator can read a running
workspace's heaviest processes and stop one. The list comes from Incus
through the worker, never from the workspace agent. **Refresh**
(`POST /admin/workspaces/:id/processes/refresh`, 202, 409 when the
workspace is not running) records a request; the worker, within a second,
asks the controller (`GET /instances/:name/processes`), which reads the
instance's cgroup tree and `/proc` on the host, running nothing inside the
instance and writing nothing, and returns the top ten
processes by CPU over one second and the top ten by resident memory,
each with PID, uid, short name (control characters replaced, at most 15
characters), start ticks, CPU percent of the instance's CPU limit,
resident bytes and whether it is protected (PID 1, not uid 1000, or one of the
processes the agent's stop refuses: the agent, its attach clients, the tmux
server and the pane shells, which the worker reads from the agent's
`GET /processes/protected` by PID and start ticks; if the agent does not
answer, only the first two rules apply). `GET /admin/workspaces/:id/processes` returns
the latest snapshot, with `takenAt` null until it is served and `error`
set to a code when it could not be read. Snapshots are deleted after an
hour. **Stop** (`POST /admin/workspaces/:id/processes/:pid/stop`, body
`{startTicks, force}`) goes through the agent's checked stop route with
the same answers as the student's. The table sorts by CPU or memory, the
sorted column's button shows an arrow, and a protected row says
"Protected" in its Actions cell with the reason for screen readers. When
the process exited, the student
gets a notification, "An administrator stopped a process in your
workspace", naming no process; a stop the process survived tells the
student nothing but is still audited. Like Monitor, the Processes table
keeps a fixed Stop column, so a row without Stop leaves that cell empty
(Epic 22).

The admin area works in windows 768 px wide and up. Below about 990 px
the tab strip wraps to a second row, wide tables scroll sideways inside
the frame, and the page itself never scrolls sideways. Below that it
scrolls sideways; there is no phone layout. The workspace keeps its
1024 px minimum (Epic 33).

Added by Epic 33: the admin page keeps the app header to the wordmark,
"Administration" and the account menu. Under it, a frame as wide as the
window less a 16 px gutter on each side holds the admin tab strip at its
top and the tab's content below. Text and forms keep their own measure,
about 72 characters; tables use the full width. A 1 px line in
`--line-strong` runs down each side of the frame to the bottom of the
window. The strip uses the workspace tab-strip look, with 36 px rows.
Tabs are links, one per admin path, with `aria-current` on the current
one. Each shows its icon and its whole name, with no fade, no hover text
and no gaps between tabs. When the tabs do not fit on one row, they wrap
to further rows in a fixed order, and keyboard order is left to right,
top row first. In forced-colours mode the current tab, admin or
workspace, carries a bar and is semibold, without shifting any tab.
Only the content inside the frame scrolls, 16 px in from the lines and
compact in density, with a stable scrollbar gutter just inside the right
line. The header, the strip and the frame lines never move. Table
headers stick at the top of the scrolling content, right under the
strip. Panels kept in view beside long lists cap their height to the
scrolling area's height less the content padding. Where the content is
narrower than 56rem, the Users detail panel stacks under the table
instead of beside it. The Settings dialog's
section pane also reserves a stable scrollbar gutter, so content does
not shift between
tall and short tabs. `AdminGroup`, at heading level 3 or 4 with an
optional description, is the one card frame for admin groups and their
parts. Every sortable table, the Users, Logs, Audit and Processes
tables and Monitor included, uses the shared sort header in
`apps/web/src/table/`, which carries `aria-sort` and announces
"Sorted by …" through a polite status region;
Audit sorts by Time only, because it is paged on the server. The Users
table has a per-row "more" menu for the lifecycle actions.

The admin page is one frame (Epic 18): its heading, tab navigation and tab
content fill the frame, with text and forms at their own measure, at compact density (28 px
controls, above the 24 px minimum target of section 25.8), and `<main>` keeps
the scroll. Each tab is an h2 section with an optional count and actions in
its heading row, headings inside a tab are h3, and the browser title names
the tab ("Users, Administration, Portikus"). Admin tables use the design's
table classes, and their headers stick to the scrolling page, so nothing
between a table and `<main>` may be a scroll container. The Users table has
seven columns: selection, a two-line Account cell (name, then email or
username), Role, Workspace, Last activity, Image (an "Older image" tag only
when out of date) and Connections; source, last sign-in and storage are in
the detail panel. The detail panel stays in view beside the table with its
own scroll. (Epic 25 changed the Users table and the panel; see below.) The Audit table shows the first 8 characters of an
ID with the full ID in its title and accessible name, short times with the
full time in the title, the result as a tag (red for anything but ok or
success), and details clipped to one line per key with the full text
available to screen readers. A target ID links to the Audit filter for
that target, labelled "Target ID". Settings cards sit in a grid, each Save
below its fields (one column since Epic 25).

Rebuild is also a bulk action on the Users table, with a "Rebuild all on
older images…" shortcut while the Image filter is Older (Epic 18). The
browser calls the single-workspace rebuild route once per workspace, so
each request keeps its own audit row, CSRF check and pending-operation
refusal; a refusal with 409 counts as skipped. There is no bulk API route,
because it would only duplicate that logic.

While a rebuild or Reset Docker is pending or running (issue #881), the
detail panel's state badge and the workspace's badge in the Users row say
"Rebuilding…" or "Resetting Docker…" with a spinner; each row of
`GET /admin/users` carries the workspace's `pendingOperation` for this. The
panel's badge sits in a status region, so the start is announced. Confirming
the dialog refetches at once, and the panel and list keep their 5-second
poll. Rebuild and Reset Docker stay off until the operation clears. When it
clears, the panel reads the result from the worker's audit row in its recent
audit (`workspace.rebuilt`, `workspace.rebuild_failed`,
`workspace.docker_reset`, `workspace.docker_reset_failed`) and shows a toast:
"finished" as a status, "failed" as an alert that gives the error code and
points to the Logs tab.

Added by Epic 17 (issue #613): the storage pool's fill is the larger of
its data use (from Incus) and its metadata use (from
`/run/portikus-thinpool.json`, written each minute by a root timer; the
controller ignores a file older than 5 minutes). The host snapshot and
`GET /admin/health` carry it as `pool.metadataPercent`, null when not
reported. The Health tab shows metadata use beside data use and, at 70%
fill, the text "Storage pool is over 70% full"; memory keeps its 80%
warning. When the worker's health sample sees the fill cross 70% it
records a warning notification for every enabled administrator, and at
90% a danger one ("new workspaces are refused"); each level re-arms once
the fill falls 5 points below it. At 90% the controller refuses
`POST /instances` with 507 `POOL_FULL`, separate from `STORAGE_FULL`
(one workspace's own volume). The worker leaves the workspace in
`provisioning` with the message "There is no room for a new workspace
right now. Your administrator has been told.", audits the first refusal
as `workspace.provision_refused`, and tries again every sweep, so the
workspace is created once space is freed. The student's starting screen
shows that message. Start, stop and rebuild are never refused.

Added by Epic 24 (issues #730, #626, #283 and #284): the admin page gains
two tabs, **Network** and **Backups**, after Health and before Settings,
built to the frame rules above.

- **Network** edits the workspace egress policy of section 23.6: the
  mode, one-click presets, the allowed ports, a labelled list of host
  names and address ranges, and, in open mode, a list of blocked sites.
  Switching mode is confirmed in a dialog that says what stops. The tab
  shows whether the policy is applied, a "Test a host" box that explains
  why a name would be allowed or refused, and the 20 names workspaces
  were refused most over the last 7 days, site-wide, each with "Allow…".
  The routes are `GET /admin/egress`, `PUT /admin/egress/mode`,
  `/presets` and `/ports`, `POST`, `PUT` and `DELETE
  /admin/egress/entries`, and `POST`, `PUT` and `DELETE
  /admin/egress/blocked-sites`. Every write carries the `egress_version`
  it was based on and answers 409 when that is stale.
- **Backups** shows recent backup sets (when, complete or not, size, the
  workspaces covered), the next scheduled run, the last failure, and
  whether the host has reported in the last 3 minutes. **Back up now**
  starts a run. Old sets, pre-change dumps, `pre-*` snapshots and kept
  homes can be deleted. One workspace can be restored from a set into a
  side copy in its home, and then, as a second step confirmed by typing
  the account's name, the whole home can be replaced with it (section
  24.9, ADRs 0039 and 0040). Each write answers 202 with the request, or
  409. A site installed with `apt install portikus` backs itself up on
  the server (section 24.9, ADR 0044), and its tab also has **Download
  backup key**, confirmed in a dialog that says what the key unlocks and
  to store it off the server, with a "Backup key not yet downloaded"
  reminder until the first download, and **Upload backup key**, which
  asks before replacing a different key. The routes are `GET
  /admin/backups/key`, `POST /admin/backups/key/download` and `POST
  /admin/backups/key`; they are 404 on a VM whose host holds the key.
- The workspace detail panel gains **Limits…**, a dialog for the
  workspace's CPU count, memory and process ceiling (section 19.4,
  `PUT /admin/workspaces/:id/limits`, each key a number or null), and,
  for a workspace in `error`, **Re-provision**
  (`POST /admin/workspaces/:id/reprovision`). Re-provision answers 409
  from any other state and otherwise sets the row back to `provisioning`
  with its error cleared, in one conditional update. The worker's create
  path then runs as for a new workspace; the controller adopts an
  instance and volumes that already exist, so home data survives.
- The Settings tab edits the two throttle-hold settings (section 19.4).
- **Workspace image** (Epic 15) shows, updates, rebuilds, activates and
  rolls back the workspace image (section 22.4).
- The Workspace image tab ends with "Packages students add", beside the
  actions that act on its candidates: for the latest completed
  UTC day that surveyed at least 3 workspaces, how many surveyed
  workspaces added each package with `sudo apt install`, with first and
  last seen, and a base-image candidate mark when at least 2 workspaces
  and at least a third of those surveyed added it (`GET
  /admin/packages`, section 22.3, ADR 0042). Figures are aggregates
  only; no table or view pairs a package with a workspace or student. A
  per-student view would need a spec change.

Changed by Epic 25 (UI polish and help):

- **Tab order.** Users, Health, Logs, Audit, Network, Backups, Settings,
  with a small gap before Health and before Network and no group labels.
  Every tab has a PageIntro and
  toggletips on its fields and headers (section 8.6).
- **Tab addresses.** Each tab has its own path, `/admin/<tab>`:
  `/admin/users`, `/admin/health`, `/admin/logs`, `/admin/audit`,
  `/admin/network`, `/admin/backups`, `/admin/image`,
  `/admin/certificate`, `/admin/docker`, `/admin/settings` and
  `/admin/shell` (eleven tabs; Root shell is last and shown only when
  root shells are on). `/admin`
  opens Users. An older `/admin?tab=<x>` link redirects to `/admin/<x>`
  and keeps its other search keys; `?tab=workspaces` goes to
  `/admin/users`. Moving between tabs adds a history entry, so the back
  button returns to the previous tab. The edge serves the page for a
  document request to `/admin` or `/admin/<one segment>`; deeper paths
  under `/admin/` stay with the API.
- **Users table.** Five columns: selection; Account (the name with its
  tags, then email or username); Role; Workspace (label, state, and an
  "Old image" tag when out of date); and Activity ("Now" with the
  connection count, or the time since a browser last connected). Since
  Epic 15.2 (issue #860) the tags keep two causes apart. Stale is only
  about the account: no sign-in for 30 days, or a newer sign-in by another
  account with the same email (`apps/api/src/admin/markers.ts`). Old image
  is only about the workspace: its image fingerprint differs from the
  default image in the newest host sample, and rebuilding moves it to the
  default. When the detail panel sees a rebuild or Docker reset finish, it
  refetches the Users list at once instead of waiting for its next poll. A
  toolbar row is always there: "Showing N of M" when the view hides rows
  (archived workspaces are hidden by default), or "N selected" with the
  bulk actions. Bulk Enable and Unarchive confirm in the neutral style.
- **Detail panel.** Its head holds the name, the state and the lifecycle
  actions that fit the state. During a transition the opposite action
  stays enabled (Stop and Restart while starting, Start while stopping),
  so an administrator can rescue a stuck workspace, and a note says what
  it is waiting for. Only Start on an archived workspace is off, with its
  reason. Then come Error, Workspace, Resources, Resource guard,
  Processes, Ports and connections, Account, and Recent audit with the
  logs link. Workspace has **Restore from backup…**, the Backups tab's
  restore dialog set to that workspace with a choice of the sets that
  hold it. Resources shows storage, use, limits and disconnect grace,
  with **Edit limits…**, whose blank fields name the site value, and
  **Edit disconnect grace…**, in minutes (the API stores seconds). It
  reads the site limits without polling. Resource guard has **Guard
  settings…** and shows the last input time as "Last input (idle stop)".
  The quota dialog is titled "Storage for {name}'s workspace".
- **Settings.** One column. The guard settings are in four groups
  (section 19.4), and the disconnect grace is edited in minutes while the
  API keeps seconds. The service log level moved to the Logs tab.
- **Logs.** Filters sit in one block with Apply filters and Clear: level,
  service, time (a native select), text, a Person field that takes a
  name, email or username and sends the person's ID, and, when a link
  named a workspace, an "Only {name}'s workspace" checkbox. The URL keys
  did not change. An empty result is one sentence saying what was searched
  and what to widen, with no table. The head sets the level the services
  log at ("Services log at").
- **Audit.** Filters are Person (resolved to an ID as on Logs) and "Action
  starts with". Actor and target cells show a name when one is known (a
  workspace shows its owner's), with the short ID under a named target. A
  target filter shows as "Only events about {name}" with **Show all
  targets**.
- **Backups.** The tab groups the status, the sets and Back up now; then
  restored copies; then a Clean up section for snapshots, kept homes and
  dumps, which starts closed when all three are empty. A restore can also
  start from the workspace's panel.
- **Network.** While the policy is not yet applied, the mode summary
  starts "Saved setting:".
- **Course page.** It has an intro, and **Remove** is offered only on
  students; the API refuses removing an instructor, whose membership
  belongs to the learning system.

Added by Epic 26 (section 16.6, ADR 0045): a **Docker** tab after
Image. It shows the pull cache's size and use, the last clear and any
clear error, and **Clear cache**. It holds an optional Docker Hub
credential, write-only, which the page asks to be a personal access token
with "Public Repo Read-only" scope from an account with no private
repositories, because every student could pull them; the page shows only
whether one is set and says a change clears the cache. It has the
**Cache ghcr.io images** switch with the list of what breaks while it is
on; the seed image list, the seed size cap, **Rebuild seed** with
progress, and the current seed's size, images and image version; and the
Image use report, with **Add to seed** and **Remove from seed**. Every
change writes an audit row, and the credential's row says only "set" or
"cleared". The report lists at most 200 rows per table, with a total.

Added by Epic 27 (section 21.12, ADR 0046): a **Certificate** tab after
Image and before Docker. It shows the certificate in use for the site and
a sample preview name (issuer, names, expiry), the source and the last
renewal, and chooses between Caddy's internal authority, ACME (Let's
Encrypt, its staging service, ZeroSSL or a directory URL, optional EAB,
DNS-01 with nine providers or HTTP-01) and uploaded files. Secret fields
are write-only and show only "set" or "not set"; a blank one keeps the
stored value. **Test only** and **Apply** run a pre-flight first, from
the server with a resolver that skips `/etc/hosts`: the names resolve and
a nonce at `/.well-known/portikus-preflight/` answers, plus plain HTTP on
port 80 for HTTP-01. A failure blocks HTTP-01 and is a warning for
DNS-01. When the host resolver is systemd-resolved, it answers
from `/etc/hosts`, so a hosts entry can make a name pass the pre-flight
that the public DNS does not have. Uploads are checked by the API and again by the job, and a
refusal names the failed check. **Renew now** shows only for ACME,
**Roll back** returns to the one earlier generation, and **Download root
certificate** serves Caddy's internal root. Every enabled administrator
gets a notification for expiry within 14 days (not for the internal
authority) and for a failed renewal, once per certificate per condition.
Under HTTP-01, preview certificates are on demand: Caddy asks the API on
loopback, which approves the site and a preview name only for a
non-system listening port in a running workspace, and at most 10 new
names per workspace per fixed clock hour (the count resets at the start
of each window, it does not roll), counted in memory so an API restart
resets it. Changing the site's address is out (#935).

Added by Epic 35 (ADRs 0051 and 0052):

- **Notifications.** A Notifications group in the Settings tab sets the
  alert channels (section 25.6): email through SMTP, Pushover, ntfy,
  Microsoft Teams and a generic webhook, at most one of each, plus the
  alert email recipients and the "Alert when a root shell opens"
  checkbox, off by default. `GET` and `PUT /admin/notifications` read
  and change the settings; secrets are write-only (section 24.8). A
  change is applied by a root job, so the page shows the job's status.
  Each saved channel has its own **Send test** button
  (`POST /admin/alerts/test` with an optional `channel`).
- **Root shell.** The Root shell tab, `/admin/shell`, opens root shells
  on the server in panes with the workspace terminals' split and drag
  layout. Any signed-in administrator may open one; there is no second
  factor, password prompt, address rule, idle timeout or shell limit.
  Section 20.3 and ADR 0051 describe it. A one-line warning beside the
  heading says these are root shells on the server and that reloading,
  leaving or a restart ends them, and links the Help topic, which says
  nothing typed is recorded and that opening and closing are audited. The
  tab has no About box. Reloading the page
  or leaving the admin area ends the shells; no layout is saved and
  there is no reconnect. When the operator has turned root shells off,
  `GET /admin/root-shell` answers `{enabled: false}` and the tab is
  hidden.

### 20.2 User impersonation

P0 must not require silent administrator impersonation of a student session.

P2 workspace-sharing/support access must be explicit and auditable.

An administrator may reset another person's password, second factor, or
both, so that someone who lost both can get back in. The holder is
always told by a notice they cannot delete, and the install administrator
is protected from other administrators; its recovery is `portikus
reset-admin` (section 24.13, #1135).

### 20.3 Break-glass access

Operators may have host/Incus-level diagnostic access.

Break-glass activity should be limited to authorized administrators and should not become the ordinary management path.

Added by Epic 35 (ADR 0051): the admin page's root shell is an in-browser
root sign-in to the server, on by default. An operator turns it off with
`portikus_root_shell: false` in `portikus.yaml` and `sudo portikus
setup`; an upgrade turns it on for existing sites. The API never runs as
root. Each pane is its own WebSocket
(`/admin/root-shell/ws?cols=&rows=`), its own connection to
`/run/portikus-root-shell.sock` (root:portikus-root-shell, 0660, only
`portikus-api.service` in that group) and its own per-connection helper,
`portikus-root-shell@.service`, which runs `login -f root -h <address>`
on a pseudo-terminal. That is a PAM session that behaves like SSH, with
a logind scope and entries in `who`, `last` and wtmp. Setup installs
`/etc/pam.d/remote` when absent, and tmux.

- Closing a pane only hangs the shell up (SIGHUP), so a tmux the
  administrator started survives.
- The API re-checks the session once a second. Sign-out, losing the
  administrator role, a disabled account and the 12-hour provider-role
  limit end the shell: the API drops further input, sends the helper an
  `end` frame and closes the browser socket with 4401. On `end` the
  helper ends the shell's logind session and kills every process left
  in it with SIGKILL, with no grace period.
- When the database cannot be reached for about 60 seconds of checks,
  the API closes the shell with 1011 but sends no `end`, so the shell is
  only hung up and tmux survives.
- The off switch ends every recorded root-shell session, including tmux
  left behind closed panes. A tmux pane that ignores SIGHUP, or a
  process started outside the session, for example with `systemd-run`,
  can outlive it.
- Input queued while the shell is busy is capped at 256 KiB; past that
  it is dropped until the shell catches up, and the shell shows one
  notice. Keys typed before the prompt appears are lost.
- Root-shell sockets count toward the 60 terminal sockets per user
  (section 24.13), and systemd allows 64 connections on the socket.
- Anything that restarts the API ends every root shell, so upgrades and
  database maintenance belong inside tmux.

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
- links to the shared Claude Code and Codex (§10.1), which are not installed in the image;
- tmux or the selected PTY persistence layer;
- workspace-agent and service definition;
- the terminals unit and its exit record (§9.7, §19.3).

Additional language runtimes may be added according to course requirements.

### 21.8 Versioned images

Workspace images must be versioned.

The platform must record which image version a workspace was created/rebuilt from.

The system must allow a new image to be built and validated without immediately replacing all existing student workspaces.

Added by Epic 15 (ADR 0030): an image version is `YYYY.MM.N`, or
`<recipe VERSION>-local.<YYYYMMDDHHMM>` for one built on the server. Every
image has a manifest (section 22.4). Incus keeps the default as alias
`portikus`, the one before it as `portikus-previous`, and each image as
`portikus-<version>`.

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

### 21.12 Install on a rented Debian 13 server

Added by Epic 15 (ADR 0029). `apt install portikus` is the default way to
install Portikus. The workstation Ansible and libvirt tooling under
`infra/` is for development only: it creates the libvirt VMs, and it
configures the rehearsal VM and unreleased builds. The pilot's VM is
created by it but installed with apt and upgraded with `apt upgrade`,
like any real install. The pilot's and the rehearsal VM's MAC addresses
are fixed in their environments' `variables.tf`, so a destroyed and
recreated VM gets the same DHCP address. docs/INSTALL.md is the operator's guide.

- **Target.** A rented bare-metal or full virtual server, x86-64, Debian
  13 only. Other distributions, Debian's own Incus and an `.rpm` are out.
- **Questions.** The package asks its questions through debconf, Debian's
  install-question system, in the `whiptail` text interface, and asks
  only what cannot be guessed. Each question shows only when the one
  before makes it relevant: the public host name (default: the host's
  fully qualified name, when it passes the host-name check), the local
  administrator's email (default `admin@<public_host>`), TLS
  (`letsencrypt`, `files` or `internal`, with that choice's fields; since
  Epic 27 the default is `internal`; since Epic 34 the question is asked
  at high priority, so a normal install asks it, and it is not asked once a
  certificate state exists; with Let's Encrypt or certificate files the
  administrator's one-time password is held until the site serves a
  publicly trusted certificate, section 24.10), the
  sign-in provider (`dex`, `entra`, `google`, `ldap` or `oidc`; each but
  `dex` fills one Dex connector, section 5.1) with only that provider's
  fields, and storage. Every client secret, the LDAP bind password and
  the Cloudflare token are password questions. A summary screen ends the
  questions; No goes back with every answer kept. Guessed and never asked,
  but preseedable and editable in the file: the public port (443), the
  management network (the subnet of the default route's interface), the
  preview suffix (`preview.<public_host>`), and the grace period and
  sizes.
- **Storage.** `portikus/storage` is a whole empty block device, an
  existing LVM volume group, or a file on the root filesystem. **The
  default choice is the file**, because many rented servers mirror their
  disks and have no empty one. The file asks its size (default half the
  free space on `/`, in GiB) and becomes a loop-backed volume group under
  `/var/lib/portikus-storage`, attached by a small unit before Incus
  starts; from there it is the same thin pool as a disk, and a larger size
  later grows it. A device needs `portikus/storage_confirm`, default No;
  setup changes no disk without it, and refuses a device with a mounted
  filesystem.
- **Files.** The answers go to `/etc/portikus/portikus.yaml` (root, 0644)
  as Ansible variable names, passed to the play with `-e @`, so there is
  no second schema. Secrets go only to `/etc/portikus/secrets.yaml`
  (root, 0600); postinst clears each one from the debconf database on
  every path, and a blank password on reconfigure keeps the stored one.
  postinst keeps every key it does not own, and the questions read the
  file back first, so a hand edit survives `dpkg-reconfigure`.
- **Setup runs outside apt.** When the answers are complete, postinst
  starts `portikus-setup.service`, a root oneshot, without waiting, and
  prints how to follow it. Setup cannot run inside postinst: it installs
  packages with apt while the outer apt holds the dpkg lock, and a long
  run tied to an SSH session dies with it. Every apt task waits up to 15
  minutes for the lock. `dpkg-reconfigure portikus` and an upgrade start
  it the same way. Setup is the Ansible roles shipped in
  `/usr/share/portikus/ansible` with their pinned collections, run
  against the local host with Debian's `ansible-core`; it is safe to run
  again and changes only what differs. On a first install it ends by
  creating the local administrator and printing only `sudo cat
  /etc/portikus/admin-password` (section 5.1). An upgrade prints only how
  to follow setup.
- **TLS.** `internal` is Caddy's own authority, for sites with no public
  DNS. `files` serves a given certificate and key, which must parse and
  match. `letsencrypt` gets both the site's certificate and the
  `*.<preview suffix>` wildcard by a DNS-01 challenge through Cloudflare.
  Since Epic 27 (ADR 0046) the answer only seeds the certificate state on
  the first install; the admin page's Certificate tab owns it after that
  (section 20.1).
- **Certificate state (Epic 27, ADR 0046).** Caddy is the only ACME
  client. Setup always builds it with nine caddy-dns plugins (Cloudflare,
  Route 53, DigitalOcean, OVH, Hetzner, Gandi, Porkbun, Google Cloud DNS,
  Azure) and checks each module and Caddy's version. The Caddyfile renders
  no TLS directive; it imports `/etc/portikus/certificate/tls.caddy`,
  which defines `portikus_tls_global`, `portikus_tls_site` and
  `portikus_tls_preview`. Caddy's `pki` app always loads, so the internal
  root exists whatever the source. Setup seeds the state only through
  `certificate-job first-install` (answers as JSON on standard input,
  never in arguments), and only when none of `settings.json`, `tls.caddy`
  or `secrets/` exists; a later setup run, an upgrade or
  `dpkg-reconfigure` never changes it. An old `letsencrypt` preseed seeds
  ACME DNS-01 with Cloudflare, and the token then leaves `secrets.yaml`.
  Secrets live in `/etc/portikus/certificate/secrets/` (root:caddy, 0640)
  and reach Caddy only through `{file.…}` placeholders.
- **The certificate job.** The API writes a 0600 request file into
  `/var/lib/portikus/certificate-jobs/` by rename; a path unit starts the
  root job `certificate-job` (Python standard library only, like the
  image job in section 22.4). The job deletes the request first,
  re-validates everything and never trusts the API, runs one job at a
  time, keeps the last 20 job directories (root:portikus 0750) with
  `status.json` and `log.txt`, and scrubs every stored secret from logs
  and messages. Kinds are `test`, `apply`, `renew`, `rollback`, `check`,
  and `reset` from the command line. Test and apply never touch the live
  site first: a throwaway Caddy with its own storage issues (from Let's
  Encrypt staging for a Let's Encrypt test, otherwise from the chosen
  authority), and for apply the job then copies the certificates into
  live storage, swaps the snippet, runs `caddy reload --force` and checks
  the served certificate on loopback; a failed check puts the previous
  generation back. Apply and renew refuse a chain the system authorities
  do not trust. HTTP-01 tests and applies run in the throwaway on
  127.0.0.1:8796; the live port-80 block proxies
  `/.well-known/acme-challenge/*` there, and only the `caddy` account
  may answer on that port. Renew is refused for the internal and
  uploaded-files sources. Rollback swaps the current and previous
  generations, secrets included. The hourly
  `portikus-certificate-check` writes `/var/lib/portikus/certificate/status.json`
  and `root.crt` and rebuilds the API's trust bundle (system authorities,
  Caddy's internal root, any uploaded chain), restarting the API only
  when the bundle changes. WebSocket routes carry `stream_close_delay
  1h`, so a reload does not drop terminals.
- **Node is bundled** at `/usr/lib/portikus/node`, the exact version in
  `.nvmrc`, checked against nodejs.org's SHA-256 at build time. The host
  has no NodeSource Node. A Node security fix therefore needs a Portikus
  release.
- **Dependencies** are Debian-archive packages only. Setup adds Incus
  from Zabbly and Caddy from its pinned, checksum-verified GitHub release
  package, and builds Dex and distrobuilder
  from their pinned commits, so the first run needs the internet.
- **The `portikus` command** has `setup` (in the foreground), `setup
  --follow` (follows the current or last run and exits 0 or 1),
  `status`, `reset-admin`, `restore` (section 24.9) and, since Epic 27,
  `reset-certificate`, which puts Caddy's internal authority back, keeps
  the old settings and secrets as the previous generation for Roll back,
  reloads (or restarts) Caddy, prints the root certificate's path, and
  writes a `reset` job the API audits.
- **Unattended install.** `debconf-set-selections` with a preseed file,
  then a noninteractive install. The package ships
  `/usr/share/doc/portikus/preseed.example`, which lists every question.
- **The first workspace image.** When the host has no `portikus` default
  alias, setup runs the image job's `first-install` (section 22.4): a
  fetch of the version named by `portikus_image_version` (default: the
  recipe VERSION the package was built from), its health check, and an
  activate. A host that already has a default is left alone, so setup
  never overrides an administrator's choice. A failed first install fails
  setup unless a default exists by then.
- **The install test.** `make install-test` builds a signed repository
  from the checkout on this host, installs it on a throwaway rehearsal VM
  (never the pilot), signs in as the local administrator, runs the smoke
  test, upgrades, and with `IMAGE_JOBS=1` rehearses the image jobs and a
  rebuild from an off-site backup.

### 21.13 Signed apt repository and image releases

Added by Epic 15.

- The apt repository is a static directory on GitHub Pages
  (`https://toddawhittaker.github.io/portikus/apt`, suite `trixie`,
  component `main`), built with `apt-ftparchive` and signed with `gpg`.
  It keeps the ten newest packages of the current major.minor line and
  the newest package of each earlier line, so every old line stays
  installable. Reprepro and aptly were rejected
  because they keep a database a stateless CI job would have to carry.
- The signing key does not expire. Its revocation certificate is kept
  offline (docs/OPERATIONS.md, "The package signing key"). The private
  key is the secret `APT_SIGNING_KEY` in the GitHub environment
  `publish`, which admits only branch `main` and has no required
  reviewer. The public key is committed as
  `packaging/portikus-archive-keyring.asc` and shipped to
  `/usr/share/keyrings/`.
- The release workflow runs on a push to `main`, checks the live
  repository's signature before adding to it, and waits for the matching
  image release before publishing.
- The signed index carries `Valid-Until` 30 days after it is made, so a
  mirror or a man in the middle cannot keep serving an old index that
  hides a fix. The release workflow signs it again every week, even
  when nothing is released; the weekly run skips the re-sign when the
  live index was signed less than 6 days before.
- Setup installs an older package only when `PORTIKUS_VERSION` names it.
- CI builds the workspace image when `infra/workspace-image/**` changes on
  `main`, or by hand, and publishes a release `image-<VERSION>` with
  `incus.tar.xz`, `rootfs.squashfs`, `manifest.json` and a `SHA256SUMS`
  signed with the same key. No file may reach 2 GiB. Nothing imports an
  image whose signature or checksum fails.

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

A rebuild replaces the system disk, so packages a student added with
`sudo apt install` are lost while the home folder survives. Added by
Epic 24 (issue #626, ADR 0042):

- **The apt hook.** The workspace image saves its own package list as
  `/usr/share/portikus/image-packages.txt` and installs an apt hook
  (`DPkg::Post-Invoke`). After every apt run the hook writes the
  packages the student asked for (`apt-mark showmanual` minus the
  image's list) to `~/.portikus/apt-packages.txt`, with a header naming
  the image version. It writes as the student (`runuser -u student`,
  temporary file then `mv -fT`), so a symbolic link planted there gains
  nothing. After a rebuild the hook keeps the old header and merges the
  new list into the old one; only the student's dismissal moves the
  header forward. The history log is not read.
- **The reinstall note.** At start the workspace agent reads that file.
  When its image version differs from the running image and some listed
  packages are not installed now, `GET /workspaces/:id/reinstall-note`
  (owner only, passed to the agent's `GET /packages/reinstall-note`)
  returns them, and the student sees a dismissible notice: "Packages you
  had installed with sudo apt were removed when your workspace was
  rebuilt: … Reinstall them with:" and a copyable `sudo apt install …`
  line. Dismiss rewrites the header to the current image through the
  agent. The note empties once dpkg shows the packages installed. Every
  name is checked against Debian's package-name form before it is shown
  or put in the command line.
- **The survey.** Once per UTC day for each running workspace, the worker
  reads that file through the controller (`GET
  /instances/:name/added-packages`: the Incus file API, a regular file of
  at most 64 KiB, each line checked) and adds one to each package's count
  for the day. Only the date a workspace was last surveyed is stored per
  workspace. Counts are kept 90 days. A workspace with no list, on an
  image without the hook or before its first apt run, gets an empty
  answer (no image, no packages) rather than a 404, and counts as not
  surveyed. The admin view is in section 20.1.

### 22.4 The Workspace image section

Added by Epic 15 (ADR 0030). The admin page's **Workspace image** tab
shows the default and previous images, candidates with their health and
manifest summary, and how many workspaces run each version. New
workspaces use the default; existing ones keep their root until rebuilt
(sections 17.2 and 22.3). Per-course or per-project tool versions are
out; they belong with issue #1246, "Course profiles and a
language-aware editor".

- **Update to the latest published image** fetches, verifies, imports
  and health-checks it. When the newest is already the default or the
  previous image, the job ends with "Already up to date".
- **Rebuild with latest packages** builds the shipped recipe on the
  server with current Debian and vendor packages. It does not touch Claude
  Code or Codex, which have their own update (§22.6). The only choices are
  two dropdowns, never free text: Node major 24 or 26, and Python
  "Debian's 3.13" or "Debian's plus 3.14 from uv" (in `/opt/python`,
  linked as `python3.14` and `python`; `/usr/bin/python3` stays Debian's).
- **Manifest and diff.** Every image has a manifest: the `dpkg-query`
  list, the versions of node, npm, python3, git and docker, the build
  choices, the source (`published` or `local`) and the
  recipe VERSION. The page shows added, removed and changed packages and
  tools against the default.
- **Coding agents.** A card on the tab shows each tool's version in use and
  its previous one. **Update coding agents**, behind a confirmation, and a
  **Roll back** button for each tool start the jobs of §22.6. A rollback
  with no previous version is refused (409 `CODING_AGENT_NO_PREVIOUS`) and
  its button says why. While any image job runs every button is off. After a
  rollback the next update moves forward to the newest version again. Until
  setup has seeded the folder the card says so. New image manifests do not
  list claude or codex; older ones that do are not shown as changed or
  removed.
- **Health check.** A throwaway `imgcheck-<hex>` container with the
  workspace profile must run `node`, `python3`, `git`, `docker info`,
  `claude` and `codex` (and `python3.14` for the uv choice). The last two
  run from the shared folder (§22.6). `docker info`
  must report the overlay2 driver in `/var/lib/docker`, so images land on
  the workspace's Docker volume rather than in Docker 29's default
  containerd image store on the root disk. The root job
  writes the result where the API cannot. An image that did not pass
  cannot be made the default, even by a hand-written request.
- **Make default** moves the `portikus` alias in one step and keeps the
  old default as `portikus-previous`; **Roll back** swaps them. Changed by
  Epic 28 (issue #936): after a fetch or build that passes its health
  check, every image other than the default, the previous and the new one
  is deleted.
- **Delete** on an image row removes one image that is neither the
  default nor the previous. Both the API (409 `IMAGE_IN_USE`) and the root
  job refuse those two, so rollback always works. The confirmation shows
  the database's count of workspaces made from the image. Workspaces made
  from a deleted image keep working, because on LVM thin each instance's
  root is its own thin volume. After every job the root job records each
  image's size in `images/<version>/size.json`, best effort, never failing
  the job. The page shows it as "Image size (compressed)", the size of the
  image file Incus stores, or a dash read as "Not measured yet", and
  shows the disk that holds the image store as a meter ("Main disk
  space") that warns from 80 percent used. The confirmation says what
  deleting frees when the size is known.
- **The boundary.** The API writes one request file into
  `/var/lib/portikus/image-jobs/` (`root:portikus`, 0770), and a
  path-activated root oneshot, `portikus-image-job.service`, runs it.
  Kinds are `fetch`, `build`, `activate`, `rollback` and `delete`, plus
  `first-install`, which only setup runs, and `local-build` (a build
  then an activate), which only `make build-workspace-image` runs on a
  development VM. The job refuses an unknown
  kind, choice or extra field, and a version not matching
  `^\d{4}\.\d{2}\.\d+(-local\.\d{12})?$`, and never puts a request value
  in a shell command. One job runs at a time; the API refuses a request
  while one is queued or running. A job lost to a reboot is marked
  failed. Sudo and polkit were rejected (ADR 0030).
  Every job request file, here and for the other root jobs, is written
  through one helper that removes its temporary file on failure; the
  image request file is 0640 and the others 0600.
- **Routes.** `GET /admin/image`, `GET /admin/image/diff?from=&to=`,
  `POST /admin/image/jobs` with `{kind, version?, node?, python?}`, and
  `GET /admin/image/jobs/:id` (status and the last 500 log lines, read
  from at most the last 256 KiB). All are administrator-only and
  CSRF-checked, and audited as `image.job_requested` and
  `image.job_finished`. The page polls a running job every two seconds.
  With `IMAGE_JOBS_DIR` unset the routes answer 404 and the tab says
  image management is off.
- **Release notices** (Epic 15.2, issue #861). The platform never
  upgrades itself, so it tells administrators when something newer is
  out. `portikus-image-check.timer` runs `image-job check` as root once
  a day (and 15 minutes after boot). It reads the same release list that
  **Update to the latest published image** reads, and apt's cache for
  the `portikus` package as apt's own daily refresh left it. It writes
  `images/published.json` (`PublishedReleasesFile`): the newest
  published image, and the installed and available package versions
  only when apt's candidate is newer (`dpkg --compare-versions`). It
  downloads no image, changes no default and upgrades no package. The
  API compares that image with every image in the store. When it is
  newer than all of them, `GET /admin/image` returns it as
  `newerPublished`, and the tab shows a notice at the top naming the
  version, with an **Update to** button that asks for the same fetch.
  The notice goes once that version is in the store. `GET /admin/health`
  returns the package pair as `packageUpdate`, and the Health tab shows
  it with the command `sudo apt update && sudo apt upgrade`. Every
  enabled administrator gets one neutral notification per image version
  and one per package version. The audit rows `image.release_noticed`
  and `package.release_noticed` (target: the version) record that it was
  sent. The API sends notices when it starts and then every
  `RELEASE_NOTICE_SECONDS` (default 3600), under a PostgreSQL advisory
  lock so two checks cannot both send. The check caps the release list
  at 16 MiB and follows only https redirects. A check that cannot read
  the release list keeps the image the last check recorded. Setup runs
  the check once, right after enabling the timer.

### 22.5 The workspace agent after a package upgrade

The workspace agent is bind-mounted read-only from the package, but a
running agent keeps the code it loaded at start (issue #887). So when the
workspace controller starts, which it does after every package upgrade,
it restarts `portikus-workspace-agent.service` in each running workspace
whose agent started before the installed agent files last changed.

- **What it compares.** The change time (ctime) of the host's
  `/usr/lib/portikus/workspace-agent/dist/index.js`, which dpkg rewrites
  on every upgrade and nothing can set back, against the start time of
  the oldest process in the instance's
  `system.slice/portikus-workspace-agent.service` cgroup, read from the
  host's `/proc`. The image version is the instance's `image.serial`,
  which the host sets. Nothing is read from inside the workspace, and the
  only command run there is a fixed `systemctl restart` through the
  Incus exec API (section 24).
- **What it skips.** A workspace whose image is older than 2026.09.11, or
  has no readable serial, is skipped and logged at warn, because an agent
  restart there ends its terminals (section 9.7). It gets the new agent
  at its next start. A workspace whose agent is not running, or started
  after the change, is left alone.
- **How it runs.** In the background after the controller is listening,
  one workspace at a time and each at most once. A workspace that stops
  meanwhile, or a failed restart, is logged at warn and the next one goes
  ahead. A restarted agent starts after the change, so a later
  controller start leaves it alone.
- **What the student sees.** The agent names its build (its entry file's
  change time, the same ctime the controller compares) in an `{"type":"agent","build":"…"}` frame on every
  terminal attach. The page remembers the first build it sees for each
  workspace, and forgets it when the page sees that workspace leave the
  running state (a stop or an idle stop ends its terminals) or when a
  terminal closes with a reason. An agent-only restart keeps the workspace
  running, so it still toasts. When a reconnecting terminal reports a different one, the
  page shows one neutral toast: "Portikus was updated. Your terminals are
  still running." A page opened after the upgrade shows nothing.

### 22.6 Coding agents

Added by Epic 40 (ADR 0056). The root image job (§22.4) gained three commands under its existing lock. The API may ask only for `agents-update` and `agents-rollback {tool}`; the request is strict, with `tool` one of `claude` or `codex` and no version, URL or other field.

- **`agents-update`.** Refused when there is no default image or less than 2 GiB is free. Claude Code takes the version from the `stable` channel at `downloads.claude.ai`. Its `manifest.json` is checked with `gpgv` against a keyring shipped in the package, and the job requires the signature to come from the pinned fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`. The binary must match the manifest's SHA-256. Codex takes the latest GitHub release with a plain `rust-v<x.y.z>` tag, builds the download URL itself, and requires GitHub's asset digest to equal the hash in `codex-package_SHA256SUMS`. Downloads have size caps. Archives unpack into a `0700` staging folder, `.staging-<job id>`, with only regular files and folders (no links, devices, setuid or setgid files, absolute paths or `..`), capped in members and size, then set to `root:root` with mode 0755 or 0644. A version name must match `[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}` before it joins a path.
- **Health check and switch.** One throwaway `imgcheck-<hex>` container from the default image, with the workspace profile, runs each candidate by its absolute path as the student (uid 1000), plus the Claude login check. Boot is awaited for at most five minutes in total. Each tool that passes switches on its own, by writing a temporary relative link and renaming it over `current`; the old `current` becomes `previous`. A failed candidate is deleted, and the job fails with a message that says which tools switched. An error while staging one tool does not stop the other. An update never moves a tool below its current version: the stable pointer is unsigned, so an older offer leaves the tool as it is and the message says so.
- **`agents-rollback {tool}`.** Swaps `current` and `previous` for that tool with no health check, and leaves the other tool alone. Refused when there is no previous version.
- **`agents-links`.** Run by the package's install script before the services restart (`image-job agents-links`). It makes the shared folder and the two `bin` links, downloads nothing and takes no job lock. Setup downloads the tools afterwards with `agents-seed`.
- **`agents-seed`.** Runs from setup only, never as a job. For any tool with no `current` it installs the version pinned in `image-job`, checked against a SHA-256 pinned there, and prints `changed` or `unchanged`. Setup stops, naming the tool, if either tool is still missing.
- **Pruning.** Three versions are kept per tool. A version a running process uses (matched by device and inode through `/proc/<pid>/exe`) is kept too, but never more than five folders per tool, and the job log says when it removed one still running. `current` and `previous` are never removed. Recovery removes stale `.staging-*` folders.
- **State.** The job writes `images/coding-agents.json`: `{claude: {current, previous, kept[]}, codex: {...}, updatedAt}`; the API reads it for `AdminImage.codingAgents`, which is null before the first seed. The audit rows are `image.job_requested` and `image.job_finished` with the kind in the metadata.
- **Network.** The server needs outgoing access to `downloads.claude.ai`, `api.github.com`, `github.com` and the host GitHub redirects release assets to (docs/INSTALL.md).

## 23. Networking

### 23.1 Workspace egress

Student workspaces require broad Internet egress for:

- package registries;
- GitHub;
- coding-agent APIs;
- documentation;
- Docker registries;
- external APIs used in coursework.

Open mode, the default, keeps this broad egress. Since Epic 24 an
administrator can instead restrict workspaces to an allow-list, or block
a few sites while staying open (section 23.6). The private-range deny
list of section 23.2 applies in every mode.

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

### 23.6 Egress policy

Added by Epic 24 (issue #284; ADRs 0038 and 0043). Egress is traffic a
workspace starts toward the internet. There is one policy per site, with
no per-user or per-course override, edited on the admin Network tab
(section 20.1). The deny list of private ranges and the host (PR #424,
`workspace_egress_denied_ranges` in `infra/ansible/site.yml`, enforced by
the Incus ACL and the firewall's forward chain) stays in force in every
mode, unchanged. The workspace network has no IPv6, so the policy is
IPv4 only.

**Modes.**

- **Open mode** is the default. With an empty blocked-sites list it is
  exactly the behaviour before Epic 24: no DNS redirect and no proxy.
- **Open mode with blocked sites.** An administrator lists host names to
  block, each with a label, at most 500. This is a list, not a third
  mode, and the table starts empty: no sites are seeded, because a
  non-empty list changes every workspace's network (QUIC is dropped,
  non-TLS protocols on port 443 such as `ssh.github.com:443` stop, and
  all DNS goes through our resolver). ADR 0043 names the public DNS over
  HTTPS services as a suggestion an administrator may add. Allow-list
  mode ignores the list.
- **Allow-list mode** lets a workspace reach only listed names and
  ranges, on the allowed TCP ports (default 22, 80 and 443; at most 20).
  An entry is a host name (lower-case letters, digits, hyphens and dots,
  at least one dot, at most 253 characters, no wildcard, URL or IP
  address) or an IPv4 CIDR range that does not overlap a denied range,
  each with a label of at most 80 characters; at most 500 names and 100
  ranges. An entry covers itself and its subdomains (`github.com` covers
  `api.github.com`, never `evilgithub.com`). Presets (npm and Node.js,
  Python packages, Debian and the image's apt repositories, Docker Hub,
  GitHub, GitLab, Claude, Codex) are stored by id and expanded from
  `packages/contracts/src/egress.ts` when the policy is applied, so a
  release that corrects a preset corrects every site. Rules are by name,
  never by URL (that would need decryption) and never by address for
  named services, because CDN addresses are shared and rotate.

**Allow-list enforcement: DNS and TLS names.**

- **DNS.** Workspace DNS to the bridge gateway (TCP and UDP 53) is
  redirected to our own dnsmasq, `portikus-egress-dns.service`, on the
  gateway's port 5300. Incus's own dnsmasq is not configured by us: it
  keeps its AppArmor profile, DHCP and the `.incus` names. Setting
  `raw.dnsmasq` on it was rejected because Incus then drops that profile
  (ADR 0038). Our dnsmasq runs as `nobody` with only `CAP_NET_ADMIN`,
  under a systemd sandbox. It sends each listed name to the upstream
  (systemd-resolved at 127.0.0.53 by default, from configuration), and
  every address it answers goes into the nftables set `learned_v4` through
  `nftset`. Every other name goes to the worker's counter on
  127.0.0.1:5399, which answers NXDOMAIN. It sets `no-resolv` (a stopped
  counter fails closed), `stop-dns-rebind` (a listed name cannot put a
  private address in the set) and a 300-second cap on TTLs. DNS and DNS
  over TLS (53 and 853) to anything else are dropped.
- **The firewall.** A separate table, `inet portikus_egress`, that
  Ansible's `/etc/nftables.conf` never flushes (a drop-in replaces
  Debian's `flush ruleset` on stop). Its forward chain accepts TCP on the
  allowed ports only to `learned_v4`, `recent_v4` and the administrator's
  ranges, and drops everything else from the bridge, UDP and ICMP
  included. Since Epic 34 a learned address expires after 300 seconds, the
  TTL cap; each new connection to it also puts it in `recent_v4` for 300
  seconds, so an address no DNS answer has named for ten minutes is closed
  to new connections (ADR 0038). Each set holds at most 65,535 addresses
  and fails closed when full. It is
  flushed when a name is removed, the mode changes or the previous apply
  failed; clients heal on their next lookup, within the 300-second cap.
- **TLS and HTTP names.** Connections to a learned address on 443 and
  80 are redirected to a second Squid for workspaces,
  `portikus-workspace-proxy.service` (the `squid-openssl` build, as its
  own user `portikus-wsproxy`), on the gateway's ports 3130 and 3129. It
  reads the TLS SNI or the HTTP `Host`, splices only listed names, never
  decrypts, refuses the rest, refuses denied destinations with
  `ssl_bump terminate`, caches nothing and logs no client address. So an
  address shared by a CDN cannot reach an unlisted site on it. A
  redirect is rendered only for an allowed port. Squid's own lookups go
  to our dnsmasq through a nat output rule matching its user, so it
  cannot leak an unlisted name to the internet. The API's proxy (ADR
  0027) is a separate instance, and Ansible pins the `squid`
  alternatives link to the GnuTLS build so it never switches.
- **The Incus ACL** carves the gateway out of every drop that covers it
  and adds gateway-only drops for TCP except 3129, 3130 and 5300, UDP
  except 5300, and ICMP. The host's input chain accepts those three ports
  from the bridge only for redirected connections (`ct status dnat`), so
  a workspace cannot use Squid or our dnsmasq directly.
- SSH and other non-web ports keep only the address check.

**Open mode with blocked sites.** Workspace DNS goes to our dnsmasq,
which forwards every name upstream except blocked names and their
subdomains, which get NXDOMAIN. TCP 80 and 443 to every public address
are redirected to the workspace Squid, which refuses a blocked TLS name
or `Host` and splices everything else, and lets a WebSocket upgrade
through. Outside DNS on 53 and 853 and UDP 443 are dropped. Blocking is
best effort against casual use: other DNS services, direct addresses,
TLS with no name and tunnels on other ports get round it. Only
allow-list mode stops a determined student, and the Network tab says so.

**In every mode:** each workspace may hold at most 256 connections to
the workspace Squid (`ct count` per source address), and the next is
reset, so one workspace cannot exhaust the shared proxy.

**Who changes the rules.** The database holds the policy; nobody types a
rule. Every admin write raises `settings.egress_version`. The worker
sees it ahead of the applied version, expands the presets, and calls the
controller's `PUT /egress-policy`. The controller, which keeps
`NoNewPrivileges` and no network capabilities, only writes a request
file and waits up to 30 seconds for the answer. A root helper,
`portikus-egress-apply`, started by a systemd path unit (ADR 0030's
pattern), reads the request without following links, caps it at 256 KiB,
and checks every field with the same schema, plus the denied ranges and
bridge settings from its own root-owned `/etc/portikus/egress.env`. It
then loads the table in one `nft -f` transaction, writes our dnsmasq's
configuration and restarts or stops it, and writes Squid's name lists and
reloads it. It controls only those two services, only with `reload`,
`restart` and `stop`. It records `applied.json` only after every step
worked. The worker records the applied version, or audits
`egress.apply_failed` and retries.

**Order and failure.** Every change fails closed. Going from plain open
mode to open mode with blocks, dnsmasq and Squid are readied before the
table loads; going from blocks to allow-list, Squid is reloaded before
the table. A request the helper refuses, or a failed step, leaves the
previous table and `applied.json`. When the blocked list changes, the
helper deletes the conntrack entries of the workspace subnet's TCP
connections to ports 80 and 443, so a connection that bypassed the proxy
is judged again. A connection already going through Squid keeps working
until it closes, because Squid is reloaded, not restarted; a restart
would cut every workspace's proxied connections.

**Boot.** The helper also runs at boot, after `nftables.service` and
before `incus.service`, and loads the last applied policy. If an
allow-list or blocked-sites policy cannot be loaded, or `applied.json`
cannot be read, it loads a table that drops all forwarded workspace
traffic. A site that never applied a policy loads nothing. If the helper
cannot run at all, its unit's `ExecStopPost=` runs
`/usr/lib/portikus/egress-guard.sh`, a short shell script that loads
`/etc/portikus/egress-drop-all.nft` when the table is missing and
`applied.json` does not plainly record open mode.

**Refused names.** The worker's counter hears only dnsmasq (on
127.0.0.1:5399) and Squid's name-only UDP lines (on 127.0.0.1:5398), so
it never learns which workspace asked: counts are site-wide by
construction. It stores (day, name, source `dns` or `tls`, count) in
`egress_blocked_names`, at most 2,000 names a day (the rest count as
"(other names)"), 30 days in all, counts only A queries, and never
stores an address. dnsmasq's query log stays off.

**What a student sees.** A refused name fails as "Could not resolve
host" and a refused HTTPS connection as a reset, the tools' usual
errors.

**Registry cache gate (Epic 26).** The pull cache must not bypass the
policy. The egress helper renders an input-hook chain in `inet
portikus_egress` that refuses every packet to the gateway's ports 5000 and
5001 with a TCP reset, with no "established" accept ahead of it, unless the policy's own
name matcher allows fixed names: for Docker Hub `registry-1.docker.io`,
`auth.docker.io` and `production.cloudflare.docker.com`; for ghcr.io
`ghcr.io` and `pkg-containers.githubusercontent.com`. This covers
allow-list mode and open mode's blocked sites alike. While the ghcr.io
cache is on, the helper also renders the redirect of gateway TCP 443 to
5001 behind the same gate. The Incus ACL opens only 5000 and 5001 on the
gateway, never 443. `egress-drop-all.nft` and the guard table refuse both
ports the same way, so a failure closes them. A reset, not a drop, because
Docker waits 15 seconds on a silent mirror before it falls back to the
registry. The worker leaves a mirror out of the
workspace's Docker settings when the policy would drop its names. The
name lists live in `packages/contracts` beside the ports, shared by the
worker and the render. When the registry helper changes the ghcr.io
switch it starts the egress helper with no request, which re-renders the
policy already applied (or the default open policy). Setup starts it the
same way after it sets the switch, so the table follows the switch without
a reboot.

**Rulings behind this design.** After the Epic 24 spike the orchestrator
ruled (E1 to E10, recorded in ADR 0038): our own dnsmasq rather than
`raw.dnsmasq` (E1); its exact configuration, with the upstream, gateway
and bridge from configuration (E2); a names set with no timeout (E3); the
table's DNS redirect and the apply order of table, dnsmasq, Squid (E4);
the ACL carve-out and `ct status dnat` input rule (E5); the workspace
Squid's configuration (E6); pinning `squid` to the GnuTLS build (E7); the
file interface between the controller, the helper and Ansible (E8);
ADR 0038 as the record (E9); and a check that the denied ranges in
`packages/contracts/src/egress.ts` equal those in `site.yml` (E10). For
blocked sites (ADR 0043): a list in open mode, not a third mode, with
open mode unchanged while it is empty; no seeded list; and the design
above, including the connection cap, the conntrack flush and reload
rather than restart.

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

Zones 6 and 7 describe the pilot, where the platform runs in a VM on a
separate host. On an apt install the host and the platform are one zone
that faces the internet. Only SSH, HTTP and HTTPS may answer from
outside, and a check run from outside the server proves it (#1137).

Added by Epic 35 (ADR 0051, an accepted risk): a stolen administrator
session, a cross-site scripting bug in the web app, or a compromised API
process now equals root on the host, through the root shell (section
20.3). The barriers are the session rules, the WebSocket origin check,
the content security policy, the second factor for Dex-password
accounts and the 12-hour provider-role limit. The API still never runs
as root, and the helper accepts only the `portikus` user on its socket.
The API may also add any alert host name to the egress proxy through
the alerts job (ADR 0052); each change is audited and announced.

Added by Epic 40 (ADR 0056): the root image job now writes a folder, `/var/lib/portikus/coding-agents`, whose programs every workspace executes. That makes the job's checks part of the trust boundary: the API's request names only a job kind and a tool; downloads are verified (§22.6); archives unpack with no links, devices or setuid files; everything is owned by root. Workspaces see the folder read-only through the profile device; a container root cannot remount it read-write, and unmounting it only uncovers the container's own empty folder. The Codex download is trusted on GitHub's digest and the release's checksum file, with no signature (accepted risk, ADR 0056). The controller writes the two links into `/usr/local/bin` by the replace rules below, and a failure never stops a start.

As built (Epic 29): the API and the worker reach the workspace agent
through one shared client, `packages/agent-client`. It keeps the size cap
on responses, refuses redirects, and skips an empty body. A stream that
breaks part way is handled per app. In the API, `readJson` returns
nothing, so a route answers 503, or the global handler answers 500 where
a route does not check; the API's typed agent methods raise
`AgentStreamError`, which answers `AGENT_UNAVAILABLE`. In the worker the
error is thrown.

When the controller writes a file into a container it replaces the file:
it deletes the path and then writes it, so a student cannot leave a link
or other special file there to redirect the write. It does this only
while the container is stopped, so no student process can put a named
pipe back between the two steps; a start that finds the container
already running (a retry after a start that failed late) force-stops it
first. It never reads a file through the Incus
files API, because Incus 7.5 reports a named pipe there as a regular file
and opening one blocks an Incus thread until something opens the other
end or Incus restarts.
What it must change or read in a running container (the ghcr.io hosts
line and the apt hook's package list) it does with a command inside the
container. A student is root there and can replace any command, so the
bounds are the controller's own: output comes back over the exec
websocket and the controller reads at most 64 KiB, then kills the
command and closes the sockets; nothing is recorded to a file on the
host. Incus 7.5 refuses to cancel an exec operation, but closing the
control socket kills the command; a process it left in the background
can hold one Incus read open until that process exits.
An edit that runs without sockets (the hosts line, `hostname`, the
timezone link) is only waited for: past its timeout it is left until it
exits or the container stops, and a retried start force-stops the
container. A start that keeps failing is retried at most five times
(section 6.3).

Added by Epic 42 (ADR 0057): a shared project crosses from the student's
zone to an instructor's browser only through the API's read-only shared
routes (tree, file, Git status, diff, latest checks). The API checks on
every read that the viewer teaches a course the owner belongs to and that
an open, unexpired share exists for an active project. A shared read
never starts a stopped workspace and never counts as presence. Every
answer sends `Cache-Control: no-store`.

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

Workspaces cannot send outbound mail by default. Their new-connection and
packet rates are limited, and outbound rates are counted so
administrators can see outliers (#1134; alerts #918).

As built (Epic 34): the table `inet portikus_workspace_limits` holds in
every egress mode and survives an nftables restart.

| Limit | Value |
|---|---|
| Mail (TCP 25, 465, 587) | blocked unless `portikus_workspace_mail_allowed` is set |
| New connections | 20 a second per workspace |
| Packets outside established TCP | 5,000 a second per workspace |

Drops are counted per workspace and logged at a limited rate with the
prefix `portikus-ws-`; the admin Logs tab shows them as Network warnings.
Workspaces cannot reach the host's own address on ports 80 and 443: the
host drops anything from the workspace bridge to those ports.

### 24.3 Browser-origin isolation

Student preview content must not share a trusted origin with the control-plane UI.

Authentication cookies for the control plane must not be available to preview JavaScript.

Preview embedding must use appropriate iframe sandboxing and content-security policy where compatible with development workflows.

The control-plane UI sends a content security policy that limits scripts
to its own (#1143).

### 24.4 Container isolation

Student LXC containers must be unprivileged.

Unique UID/GID maps should be used.

Do not mount sensitive host paths.

Do not mount Incus or host-Docker sockets.

Do not grant arbitrary host devices.

The host applies kernel hardening settings where workspace workloads
allow, and the administrator is told when a security update needs a
reboot (#1137).

### 24.5 Nested Docker

Nested Docker privileges must terminate at the workspace boundary.

Root inside an inner Docker container must not imply root on:

- the outer LXC host mapping;
- the platform VM;
- the Pop!_OS host.

**Registry cache (Epic 26, ADR 0045).** The pull cache is a new
service that every workspace can reach. Rulings S1 to S8 of the design
review, as built:

- **S1, the cache process.** Each registry runs as its own system user
  under a systemd sandbox with `MemoryMax=` and `TasksMax=`, and listens
  only on the workspace gateway; the host firewall accepts 5000 and 5001
  only from the workspace bridge, with a per-source connection cap.
  Debian's own `docker-registry.service`, which listens on every
  interface, is masked. The access log is off, the log level is info or
  lower, and there is no debug listener. Clearing the cache stops the
  registries, makes a fresh filesystem on the loop file and starts them
  again; root never deletes inside a directory the registry user owns.
  Push and delete answer 405.
- **S2, the egress gate.** Section 23.6, "Registry cache gate".
- **S3, ghcr.io.** The certificate authority may sign only `ghcr.io`, its
  key is readable by root alone, and only Docker in workspaces trusts it,
  through `/etc/docker/certs.d`. Port 443 on the gateway is never opened
  in the ACL; only the rendered redirect reaches 5001.
- **S4, shifted volumes.** The seed and its copies use
  `security.shifted=true`, set from the start of the build. One shifted
  volume is never attached to two workspaces. The smoke test checks that
  the `portikus` and `nobody` accounts cannot reach into the Incus custom
  volume paths.
- **S5, the Hub credential.** It should be a personal access token with
  public-repository read-only scope. The API writes a mode 0600 request
  file that a root helper reads and deletes; the API keeps no copy and
  answers only whether one is set. Setting, changing or clearing it
  clears the cache, so nothing fetched with one account is served under
  another; if that clear fails the Hub cache stays stopped until a clear
  succeeds.
- **S6, the catalog.** Every workspace can list what is cached through
  `/v2/_catalog`. Accepted; no proxy goes in front.
- **S7, usage data.** A pull event's address can carry a student's
  `X-Forwarded-For` value, so it is a hint: it is kept only as a single
  IPv4 address inside the bridge range and never used for anything per
  student. The worker's webhook listens on 127.0.0.1 and requires a header
  token from a root-generated file readable only by the registry and
  worker users. At most 2,000 image names a day are stored; the rest count
  as "(other images)". Names must match Docker's reference grammar and
  are shown as text. The agent's inventory runs `/usr/bin/docker` by
  absolute path with a timeout, an output size cap and an item cap, and a
  reply that fails the schema counts as no data.
- **S8, the seed build.** The builder is an ordinary unprivileged
  workspace container behind the workspace ACL. Image names follow a
  strict pattern (Docker Hub, or ghcr.io only while that cache is on; no
  other host or port; an optional `@sha256` digest), at most 30, passed
  as separate arguments with no shell. The seed has a size cap.
- **Accepted overcommit (ruling SEC1).** Thin-pool overcommit already
  exists for home and Docker quotas, a thin copy costs nothing until
  written, and the seed adds at most the seed cap to each workspace. The
  controller's refusal to fill the pool past 90 percent, the Health tab's
  pool usage, and the seed cap are the protection. Added by Epic 28: when
  a new workspace's Docker volume will be copied from the seed, the
  controller counts the seed's size on top of the pool's current use and
  refuses the create (`POOL_FULL`) when that would reach 90 percent. A
  seed whose size cannot be read is not counted. A default seed list is
  checked against the same image-name rules before the API writes it.
- **Listening frames (Epic 28).** An agent's listening-services frame is
  bounded at 1,024 services by the contract and compared with the
  previous list in linear time, so a replaced agent cannot stall the
  shared API with large frames (section 14.5).
- **Shared cache availability (SEC5).** Clearing is an administrator's
  action, but one student can fill the shared cache past 90 percent and so
  set off the automatic clear, which wipes it for everyone. That costs
  only download time, never data; accepted.

### 24.6 File API security

All file APIs must prevent:

- `..` traversal;
- symlink escape;
- encoded-path escape;
- archive extraction traversal/zip-slip;
- cross-project access unless deliberately supported;
- cross-user access.

Added by Epic 42 (ADR 0057): shared reads are stricter than the owner's.
The API hides secret-looking paths in the tree, file, status and diff:
any `.git` segment, `.env` and `.env.*` except `.env.example`, `*.pem`,
`*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.pypirc` and
`.portikus/`. The workspace agent refuses a shared path with a symlink in
any component (answered as missing), opens files with `O_NOFOLLOW`, and
leaves symlinks out of listings and Git status. Shared check results
carry no command.

### 24.7 Preview gateway security

The preview gateway must:

- authenticate every request;
- authorize workspace ownership/access;
- validate target port;
- prevent proxying to arbitrary platform IPs;
- prevent target-host manipulation;
- support WebSockets safely;
- apply reasonable request/body/time limits while preserving development usability.

As built (Epic 17): `GET /preview/authorize` keeps the preview session,
main-session user and workspace rows behind a preview cookie in memory for
2 seconds, and only when all three were found. It never keeps a decision:
the host, port, label, owner, running state, bridge path, registry,
bridge forward and activity checks run on every request from those rows.
Any removal of authorization (sign-out, account disable, session expiry,
a workspace stop or delete, a session gate) therefore reaches the gateway
up to 2 seconds late, and so can regaining it, such as accepting the
acceptable-use statement; a preview reset made through the API takes effect at
once. Each preview session may make 2,000 authorized requests per 10
seconds; past that the gateway answers 429 with a small "Too many
requests" page and a `Retry-After` header, and logs one warning per session
per window.

Added by Epic 15: Caddy's admin interface can load any configuration,
including one that drops the authorization step above, so it listens only
on a Unix socket, `/var/lib/caddy/admin.sock`, that root and the caddy
user can open. It is never on a loopback port every local account could
reach; the smoke test checks that the `portikus` account and `nobody`
cannot open it.

### 24.8 Secrets

Sensitive credentials must not appear in:

- platform logs;
- browser telemetry;
- audit-event payloads;
- error traces;
- project metadata.

Recovery data may contain `.env` and must therefore be treated as sensitive user data.

Added by Epic 15: an apt-installed server keeps its install secrets (the
client secrets, the LDAP bind password and the Cloudflare token) only in
`/etc/portikus/secrets.yaml` (root, 0600). They are never in
`portikus.yaml`, the debconf database after postinst, a log line, the
play's output or `ps` output.

Added by Epic 27 (ADR 0046): certificate secrets (DNS credentials, the
EAB HMAC key, a Google service-account key, an uploaded private key) are
write-only in the API and page. They travel once in the 0600 request
file, which the root job deletes first, and are stored only in files
under `/etc/portikus/certificate/` (root:caddy, 0640) that the snippet
names with `{file.…}` placeholders. They never appear in Caddy's
autosave, a log, the journal, an audit row, a status file, a view or a
process's arguments, and the job scrubs them from Caddy's messages.

Added by Epic 35 (ADR 0052): alert settings live in
`/etc/portikus/notify.json` (root:portikus-notify, 0640), read at each
send. The secrets in it (the SMTP password, the Pushover keys, the
webhook, Teams and ntfy URLs, and the ntfy token) are write-only: the
API and the page show each only as its host name and "set" or "not
set". They travel once in a 0600 request file that the root alerts job
deletes first, and never appear in a log, an audit row, a status file or
a process argument. A change of the SMTP host, port or user name clears
the stored password, and a change of the ntfy host clears its token,
unless a new one comes in the same request. Setup seeds the file once
from the `portikus_alert_*` keys in `secrets.yaml` or the old
`alerts.env`; after that the page owns it. A malformed file shows every
channel as off with a notice, and the next save replaces it.

### 24.9 Storage security

At minimum:

- filesystem ownership and container isolation must prevent cross-user reads;
- recovery archives must have restrictive permissions;
- backups must preserve access controls;
- production deployments must provide encryption at rest at the host, block-device, volume, or backup layer.

For a controlled pilot, any accepted encryption-at-rest gap must be documented explicitly.

As built (Epic 12b, ADR 0024): backups of the database and each workspace's
home and recovery volumes are pulled to the host nightly and encrypted there
with age; Docker data and root filesystems are not backed up, because Reset
Docker and Rebuild recreate them.

Added by Epic 24 (issue #730, ADRs 0039 and 0040): backups are run and
restored from the admin Backups tab (section 20.1).

- **The request-row channel.** The VM never gets write access to the
  host. The API records a row in `backup_requests`. A host timer,
  `portikus-backup-channel.timer`, every 30 seconds asks the VM over SSH
  (`sudo portikus backup-channel pull`) for at most one claimed request,
  checks it, runs it, and sends the result and a fresh status back
  (`sudo portikus backup-channel report`). Everything that talks to the
  VM runs as the operator's account, so the VM trusts no new key. The
  host treats every request as hostile: one of five kinds (`backup`,
  `delete_set`, `delete_dump`, `restore_copy`, `import_home`), each
  argument matched against a strict pattern, quoted in every command;
  anything else is "refused by the host" and nothing runs. The VM checks
  the status document with Zod and caps it at 256 KiB. A request left
  claimed 15 minutes after the host last said it was running is marked
  failed ("interrupted"). Deleting `pre-*` snapshots and kept homes is
  VM work, done by the worker through the controller, which refuses any
  other snapshot or volume name. Pre-change dumps live in
  `/var/backups/portikus/<VM name>/dumps/`.
- **Host-side bounds.** The host, not the request, sets every limit. It
  never deletes a set younger than 14 days and always keeps the newest 3
  complete sets, in the channel and in `backup.sh`'s own retention. It
  refuses a requested backup within 60 minutes of the last one, and while
  3 requested sets are younger than the minimum age. Every run needs free
  space of at least the newest complete set plus a fifth, and at least
  1 GiB, and then has a byte budget of the free space less that floor;
  passing it stops the run and keeps nothing. Only the home and recovery
  volumes of instances the VM listed are fetched. The per-file index,
  path lengths, entry counts and every answer from the VM are capped. One
  host-wide lock covers a run; the units have a 12-hour start timeout.
- **The host holds the restore key.** The private age key is installed
  root-only at `/etc/portikus-backup/age-key.txt` by `make
  backup-install-key KEY=<path>`. Only the channel's restore steps read
  it, as root; the operator's account never gets it. Whoever takes the
  host can read every backup. Todd accepted that, and his
  password-manager copy stays the recovery copy (ADR 0039 supersedes that
  part of ADR 0024).
- **Restore one workspace into a side copy.** The workspace must be
  running (409 "Start the workspace first" otherwise), and a presence row
  keeps the grace period from stopping it. The copy goes to
  `/home/student/restored-<YYYY-MM-DD>-<HHMM>` (the set's UTC time). The
  host decrypts the home volume as root and streams it into `incus exec
  --user 1000 --group 1000 … tar -xz`, so the files are written by the
  student's own account, bound by the student's permissions and quota;
  nothing is written as root inside the workspace. An existing folder is
  refused ("… already exists. Rename or delete it, then try again."), as
  is a copy larger than the home's free space less 5%. Every remote call
  runs under a host-side timeout. The student is notified.
- **Then replace the home.** Offered only on a finished side copy and
  confirmed by typing the account's name, `replace-home` is a pending
  operation the worker runs like a rebuild (section 17.2, ADR 0021). It
  makes a `before-replace-home` recovery point of each active project,
  stops the workspace, has the host import the set's home volume as
  `<instance>-home-import` with the backup's ID map, and has the
  controller swap it in, keeping the old volume as
  `<instance>-home-replaced-<unix seconds>` (a kept home). Each step can
  be repeated, so a retry finishes a half-done swap. The workspace starts
  again if it was running, and the student is notified. The kept home
  stays until an administrator deletes it; putting it back is a runbook
  step (OPERATIONS.md), not a button.
- The weekly off-host copy stays a manual step (issue #753).

Added by Epic 15, task T7 (ADR 0044): an apt-installed server backs
itself up.

- **Local mode.** The same scripts run on the server as root with
  `--local`: no SSH, no `deploy` account. Setup enables
  `portikus-backup.timer` and `portikus-backup-channel.timer` only on the
  server itself. The channel takes requests from the local worker, which
  is unprivileged, so every check above still applies. The worker runs
  as its own `portikus-worker` account, so it cannot open the key socket
  below, which admits only the API's `portikus` group. Its database role
  is not a member of `portikus` and holds only the table privileges its
  queries use: nothing on sessions or the other sign-in tables and no
  write on users, so it cannot sign in as an administrator to reach the
  key through the API. Setup and the package's upgrade apply those
  grants after the migrations, dropping the membership first and on its
  own so that a failed grant cannot leave it. The host firewall lets the
  worker's account open loopback connections only to the controller, so
  it cannot reach the API or Dex around Caddy's sign-in rate limit. Sets go to
  `/var/backups/portikus/local/`; sets copied in by hand are listed and
  checked the same way, and a link or a badly named folder is ignored.
- **The key stays on the server**, root-only in `/etc/portikus-backup/`,
  made by setup when there is none, so one-click restore works. Whoever
  controls the server can already read the live workspaces; the
  encryption protects copies kept elsewhere.
- **Download and upload go through a root socket**,
  `portikus-backup-key.socket`, never a file the API can read or write.
  Both are administrator-only, CSRF-checked and audited
  (`backup.key_downloaded`, `backup.key_uploaded` with `ok` or
  `refused`), recording only the key's public half; the key is in no log.
  The download is `Cache-Control: no-store`, named
  `portikus-backup-key.txt`. An upload must be one age identity of at most
  4 KiB, and replacing a different key needs `replace: true`, which the
  tab sends only after a confirmation; a replace waits while a backup
  runs, and keeps the replaced key root-only as
  `age-key.txt.replaced-<unix time>`, never overwriting an earlier one.
  The "not yet downloaded" reminder clears only after a download has been
  sent in full; an upload never clears it.
- **Sets are authenticated.** Each set carries an HMAC-SHA256 of its
  encrypted MANIFEST under a key derived from the private backup key, and
  the MANIFEST lists the size and SHA-256 of every other file, index files
  included. Every restore and the tab's listing check the MAC before
  trusting anything in the set, so someone who knows only the public key
  cannot make a set that restores. A set without a valid MAC is shown as
  not verified and cannot be restored from the tab; a set made before
  MACs restores only with root's explicit `--unverified`. A decrypted
  MANIFEST over 4 MiB is refused (ADR 0044, "Authenticated sets").
- **Whole-server restore** is `sudo portikus restore <set>` on the
  server, with the same empty-target checks as `restore.sh`.
- **The MAC checks the set's name.** A set's MANIFEST must name its own
  folder (`created` equals the folder name), so a genuine set renamed to
  another time is refused. The `vm` line is not checked, because it
  differs after a rebuild from an off-site copy; this is accepted. The
  4 MiB cap on the decrypted MANIFEST is sized for 2,000 workspaces.
- **Copies off the server** are the real backup (docs/INSTALL.md); the
  copy's target never needs the key. Sets come back onto a server with
  rsync or scp, never by upload in the browser.
- **The off-site copy (Epic 34, ADR 0050).** With `portikus_backup_offsite`
  set, the server pushes the newest complete, MAC-verified set every hour
  by rsync over SSH, with a dedicated key and a pinned host key. The key
  is write-only: the target's `authorized_keys` runs `rrsync -wo` into an
  `incoming` folder. The target's own `portikus-offsite-prune` moves
  finished sets in, accepts at most one set per UTC day, never replaces a
  set, and removes a set only once it is more than KEEP days old with
  KEEP newer sets present. Disk encryption at rest is deferred
  (issue #1142).
- **A restore keeps file owners and modes** (#1138). Tests check owners,
  modes and the marker for a whole restore, a side copy and Replace
  home, and that recovery points never hold `~/.claude` or `~/.codex`
  logins, even through links.
- **Off-site quota (Epic 36).** The prune script empties `incoming` when
  it uses more than twice the disk (at least 1 GiB) or ten times the
  file count (at least 100,000) of the median kept set, or cannot be
  measured, never following links, and warns on stderr. It leaves out
  the newest unfinished set (named at most an hour ahead) until it is
  KEEP days old, so a big, stalled or late upload survives, warning past
  four times the median, drops unfinished sets
  dated over a day ahead, and before any set is kept limits only non-set
  entries. A run that adds a set warns when `quota` shows no disk or no file
  limit for the account on that filesystem, or is not installed. The
  operator's filesystem quota on the target account is the real bound on
  bursts (docs/INSTALL.md); a broken-into server can keep one unfinished set
  for up to KEEP days.

### 24.10 Transport security

Production/pilot network access must use TLS for browser-facing interfaces.

Internal traffic carrying credentials or privileged control messages must be protected appropriately for the deployment network.

An internet-facing site holds a publicly trusted certificate before any
credential is typed into it (#1139).

Since Epic 36 the certificate job refuses Caddy's internal authority at
first install, apply and rollback when the site name resolves, through
DNS rather than `/etc/hosts`, to any public address. A name that does
not resolve, or resolves only to loopback, is "unknown" and allowed.
The one stated exception is `portikus_allow_internal_ca_on_public_address:
true` in the root-owned `portikus.yaml`, read only from there; a request
file carrying it is refused. `portikus reset-certificate` always works.
The hourly certificate check repeats the test, and while the internal
authority serves a public address it raises one warning site alert per
settings change and the Certificate tab shows a banner.

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

As built (Epic 11): a preview refusal that answers 403 is audited as
`preview.denied`, at most once per workspace and reason per minute; 401 and
503 answers are not audited. A role change is audited as `user.role_changed`
with the old and new role and its source.
Since Epic 29 the four admin role routes share one helper: they write
the audit row only when the role actually changed, and every role,
enable and disable row carries the request's address and user agent.

As built (Epic 14.2): `local_admin.created` and `local_admin.reset` (actor
`host:root`) record the break-glass command `portikus reset-admin`, and
`user.password_changed` (`ok` or `failed`, with address and user agent)
records a Dex password change. None of them, nor any other audit row or
log line, holds a password, a hash or the local administrator's email.
Sign-ins that Dex refuses under a connector's admission rules never reach
Portikus, so they are recorded in Dex's JSON log, not the audit table.
`setup.code_issued` and `setup.code_claimed` are no longer written.

As built (Epic 27): `certificate.job_requested` and
`certificate.job_finished`, the latter also for a `reset` job written by
`portikus reset-certificate`, with kind, source, directory, provider and
state and no secret.

As built (Epic 14.3, sections 5.1, 6.4 and 19.4): the worker (actor
`worker`) writes `workspace.cpu_throttled`, `workspace.cpu_throttle_failed`,
`workspace.memory_flagged` and `workspace.idle_stopped`, and
`workspace.cpu_throttle_lifted` and `workspace.memory_flag_cleared` with
`reason` `stopped`, and `workspace.cpu_throttle_lifted` with `reason`
`idle` and the quiet `averagePercent` (Epic 21). An administrator (actor `user:<id>`) writes the same
two with `reason` `administrator`, `workspace.guard_updated`,
`settings.resource_guard_updated` and `settings.idle_stop_updated` (each
with `{from, to}`), and `settings.acceptable_use_updated` with
`{fromVersion, toVersion}`. The person accepting writes
`user.acceptable_use_accepted` with `{version}`. No row holds a process
name, a command line, a file name or the statement's text.

As built (Epic 19, the Logs tab): the admin page has a Logs tab (since
Epic 25 between Health and Audit; its filters are described in section
20.1). It reads `GET /admin/logs` and shows the platform's own
JSON log lines, newest first, 100 a page, with "Load older lines" for
more. Filters are level (Error, which includes fatal, Warn, Info and
Debug; Error and Warn by default), service, time (last hour, last day,
last 7 days, or custom from and to), text, user ID and workspace ID, and
they live in the URL (`level`, `service`, `since`, `until`, `q`, `user`,
`workspace`), so a view can be linked. Each row shows the time, the level
as a word in a tag, service, code, message, route, status, user and
workspace, and a disclosure button shows the whole redacted line as JSON.
Every value is shown as text, never as HTML. The list refreshes every 30
seconds until older lines are loaded; then a Refresh button starts over.
An "Auto refresh" toggle pauses and resumes the refresh, and a visible
note says which is in force (WCAG 2.2.2). Older pages keep the first
page's start time, so a preset window does not slide while paging. A
search that hit its time limit before finding any line asks the
administrator to narrow the time range. A link that switches admin tabs
puts focus on the new tab's heading.
A busy journal (429) is retried twice a second apart before its message
shows; an unreadable one (503) shows its message at once. The workspace
detail panel's Logs section is a "View logs" link filtered to that
workspace and the last hour, replacing the printed `journalctl` command,
and the panel's Account section has a "View this user's logs" link
filtered to that user; the Users table keeps its seven columns. The
Health tab's Trends card has a stacked errors and warnings bar chart from
`GET /admin/logs/counts`, with warnings hatched; a click anywhere in a
bucket's column opens the Logs tab for its time span and the level under
the pointer, and from the keyboard Up and Down pick the level, announced,
and Enter opens it. Reading logs is not audited, because it is a read by
an administrator like the Audit tab and a row per refresh would be noise.

Added by Epic 25: each `GET /admin/audit` row carries `targetName`, the
target user's display name or, for a workspace, its owner's, and null
otherwise. The `user=` filter matches rows where the person is the actor
or the target, and also rows whose target is a workspace the person owns
now; rows about a workspace that has since been destroyed are not
matched.

How the journal is read (Epic 19, ADR 0036): only the units
`portikus-api.service`, `portikus-worker.service` and
`portikus-controller.service`, always named by the API. `journalctl` is
spawned from `JOURNALCTL_PATH` with an argument array and no shell;
request text never reaches an argument, and the text, user and workspace
filters run in the API after parsing. Only the API process has the
`systemd-journal` group, through its systemd unit. One request reads at
most 20,000 entries or 5 seconds and says when it stopped short; at most
two reads run at once, and a third gets 429 `RATE_LIMITED`; a missing or
refused `journalctl` gives 503 `LOGS_UNAVAILABLE`. Lines that are not
Portikus JSON (systemd's own lines, raw stack traces) are skipped and
counted. Every line is redacted with the logger's own list of sensitive
keys before it leaves the server. A workspace filter also matches the
controller's `instance` field for that workspace. The errors chart's
counts are kept in the API's memory at one-minute resolution for 7 days
and fill in over several requests; until the window is counted the chart
says "Still counting older lines". Workspace agents' logs, Dex, Caddy
and PostgreSQL lines are not shown; `journalctl` on the VM remains the
tool for those and for when the API is down (OPERATIONS.md).

As built (Epic 21): each stop signal sent to a workspace process writes
`workspace.process_stopped` (actor `user:<id>`, target the workspace) with
`{pid, signal, exited}`. A refused stop is not audited. The row holds no
process name or command line. The same row is written when an
administrator stops a process (section 20.1); the actor's role tells the two
apart. An administrator's **Refresh** of a workspace's process list writes
`workspace.processes_read` (actor `user:<id>`, target the workspace, no
metadata), because it reads what the student is running.

As built (Epic 22): the listener `commandLine` field has existed since
Epic 9.1; Epic 22 narrowed who receives it to listeners owned by the
student's own processes (section 18.2), and it is never audited or logged.
The agent checks the uid in `/proc/<pid>/status` and then reads
`cmdline`, so a PID reused between the two reads could expose another
process's command line to the student. This low-severity race is
accepted because `/proc` is mounted without `hidepid` today, so the
student can already read any command line; if `hidepid` is ever turned
on, the agent must re-check the uid after the read.

As built (Epic 24): every administrator action in the epic writes an
audit row, and no row holds a secret, file contents, a command line, a
workspace's network address, or a name a workspace looked up.

- Egress (actor `user:<id>`): `egress.mode_changed`,
  `egress.presets_changed`, `egress.ports_changed`, `egress.entry_added`,
  `egress.entry_updated`, `egress.entry_removed`, `egress.block_added`,
  `egress.block_updated` and `egress.block_removed`. The worker writes
  `egress.applied` and `egress.apply_failed`.
- Backups (actor `user:<id>` for the request): `backup.requested`,
  `backup.set_delete_requested`, `backup.dump_delete_requested`,
  `backup.restore_requested`, `backup.snapshot_delete_requested`,
  `backup.kept_home_delete_requested` and
  `workspace.home_replace_requested`. The outcomes are written with actor
  `host` when the channel reports, or by the worker for VM work:
  `backup.completed`, `backup.failed`, `backup.set_deleted`,
  `backup.set_delete_failed`, `backup.dump_deleted`,
  `backup.dump_delete_failed`, `backup.restore_copied`,
  `backup.restore_failed`, `backup.home_imported`,
  `backup.home_import_failed`, `backup.snapshot_deleted`,
  `backup.snapshot_delete_failed`, `backup.kept_home_deleted`,
  `backup.kept_home_delete_failed`, `workspace.home_replaced` and
  `workspace.home_replace_failed`.
- Sign-in (Epic 34, section 24.13): `auth.password_failed`,
  `auth.second_factor_enrolled`, `auth.second_factor_verified`,
  `auth.second_factor_failed` (with `bypass: true` when it came through
  the holder bypass, section 24.13), `auth.second_factor_reset`,
  `auth.second_factor_removed`,
  `auth.second_factor_recovery_codes_replaced` and
  `auth.invitation_claimed`. Administrators write
  `admin.invitation_created`, `admin.invitation_revoked` and
  `admin.accounts_imported`.
- Workspaces: `workspace.limits_updated` (with the before and after
  values), then the worker's `workspace.limits_applied` or
  `workspace.limits_apply_failed`; `workspace.reprovision_requested`;
  and the worker's `workspace.cpu_throttle_held`. The two throttle-hold
  settings join `settings.resource_guard_updated`.

- Root shell (Epic 35, ADR 0051): `admin.root_shell_opened` (shell id,
  address and user agent), written before the shell starts, and the
  shell is refused if the write fails; `admin.root_shell_closed` (shell
  id, `durationSeconds` and a reason: `exit`, `client`,
  `session_ended`, `database_lost` or `api_stopped`). Nothing typed or
  shown is recorded.
- Notifications (Epic 35, ADR 0052): `settings.notifications_updated`
  (the changed channel kinds and hosts, never a secret) and
  `settings.alert_tested` (each channel and whether it sent).

- Instructor features (Epic 42, ADRs 0057 and 0058):
  `project.share_started` and `project.share_stopped` (actor
  `user:<owner>`, target the project, with the share id; a stop says
  `stopped` or `archived`); `project.share_viewed` on each instructor's
  first view of a share, not on every read; `course.roster_synced` with
  counts only, never names; `course.member_removed` with `source:
  roster` for each membership a sync removes; and `lti.deep_link`, with
  actor `user:<id>` or `subject:<sub>` and the platform issuer as
  target.

A test checks that every event this section lists writes an audit row
(#1138).

### 24.12 Dependency/security maintenance

The project must define a process for:

- base-image patching;
- dependency updates;
- vulnerability review;
- rebuilding workspace images;
- revoking compromised credentials;
- updating coding-agent CLIs.

### 24.13 Sign-in abuse

These rules hold before a site faces the internet. Epics 34 and 36
built them (ADRs 0048 to 0050, 0053 and 0054).

- Rate limits never refuse one client because of other clients'
  failures. They count per account as well as per address, and treat
  each IPv6 /64 as one address (#1133).
- **The password relay.** The API relays Dex's password posts. It counts
  each post against the account before forwarding it, and gives the count
  back when the post did not fail: 10 wrong passwords in ten minutes
  throttle the account (`auth.throttled`, scope `password-account`). Every
  failure is audited as `auth.password_failed`. Logins must be ASCII; any
  other login is refused before Dex sees it. A browser that signed in
  before carries the `__Host-portikus_known_device` cookie and is exempt
  from the account count. The cookie is bound to the account's last
  password change or reset and expires on the server after 90 days, and
  `portikus reset-admin` ends it too.
- New passwords are checked offline against a breached-password list
  shipped in the package: the SecLists top-million list, lower-cased and
  kept to entries of 15 or more characters (about 11,000), plus the
  earlier hand-written entries. A newer breach is caught only when the
  pinned snapshot is bumped (ADR 0054, #1133).
- **Anonymous requests (Epic 36).** Routes that need no session take at
  most 600 requests a minute per address (`ANONYMOUS_REQUEST_LIMIT_PER_MINUTE`),
  an IPv6 /64 counting as one address, answered with 429 `RATE_LIMITED`
  and one warning log line per window, no audit row. The limit runs
  before every other count, so a refused request writes no counter.
  Made-up preview cookies at `/preview/authorize` have their own count
  per address, which refuses only that route. A session cookie that
  matches no session counts against the anonymous limit on any route
  and is refused past it, though each one still costs one session
  lookup, because the lookup must come first so a real session is never
  refused. `/auth/login` and `/lti/login` count as sign-in starts (150 a
  minute per address), and so, in a count of its own with the same
  limit, does a GET of a Dex connector's page (`/dex/auth/<connector>`,
  matched on the decoded path), because that is where Dex stores a
  sign-in record; bare `/dex/auth`, the callback, the LTI launch and
  Dex's other pages fall under the anonymous limit.
- **Stored guess counts (ADR 0053).** Password posts per address,
  password failures per account, the second-factor counts and the
  password-change count live in PostgreSQL (`signin_counters`), so a
  restart does not reset them; sign-in starts and passkey challenges
  stay in memory. Each hit returns a receipt, and a give-back takes only
  that receipt's count. A counter that cannot be read or written
  refuses with 503 `SERVICE_BUSY`, never lets the request through. Each
  refusal window writes one audit row. The API deletes ended rows every
  hour; the worker has no rights on the table.
- **Holder bypass (ADR 0053).** When the account's second-factor count
  refuses, a recovery code or a passkey is still checked, 10 tries per
  session per 10 minutes (kept in memory), so others cannot lock the
  holder out. The bypass gives no count back. A wrong bypass code is
  audited as `auth.second_factor_failed` with `bypass: true`. The daily
  lockout notice tells the holder to change their password.
- **Second factor (ADR 0048).** Every account that signs in with a Dex
  local password has a second factor, built inside Portikus: time-based
  codes (TOTP), passkeys (WebAuthn), and ten single-use recovery codes
  stored as hashes. An account keeps at least one factor. Wrong codes
  count per account across sign-in and linking, with one counter: 10 in
  ten minutes and 30 in 24 hours, after which the holder gets a kept
  notice. Linking an LMS account to a Dex-password account needs a passed
  second factor (a code or a recovery code). A session that came from an
  LMS launch cannot add or remove factors. TOTP secrets and recovery codes
  are sealed with `/etc/portikus/second-factor.key` (root, 0600), which
  backups carry and restore writes back before the API starts.
- **Invitations only (ADR 0049).** The site admits only accounts an
  administrator created: Add user, an invitation, CSV bulk upload, or an
  LTI enrolment. For SSO providers, only a Portikus invitation creates an
  account, always, for every provider. Entra matches the invitation by
  user principal name (UPN), Google and generic OIDC by a verified email,
  and LDAP by username or email. Anyone else sees a refusal page and is
  audited as a failed `auth.login` with reason `not_invited` (#1136,
  #1132).
- A session whose administrator or instructor role came from the
  identity provider ends after 12 hours, and its open sockets close
  within a second. Twelve hours spares instructors and long-running
  agents an hourly sign-in; disabling the account in Portikus still
  takes effect at once. Signing in again skips Dex's chooser (#1141).
- **Administrator resets.** An administrator may reset another person's
  password, second factor, or both. The holder is always told by a kept
  notice they cannot clear (one notice when both are reset). The install
  administrator is protected from other administrators; its recovery is
  `portikus reset-admin` on the host, which also clears its second factor
  (#1135).
- **Socket caps.** The front door limits connections and slow clients.
  Each user may hold 60 terminal sockets, 16 check-output sockets and 32
  workspace event sockets; one more is closed with code 4429 and a clear
  message. The counts live in one API process, as the event-socket cap
  does (ADR 0010) (#1140).

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

The web app loads `/admin`, `/course` and `/help` on first visit, as separate files, so a student's first page does not carry them (Epic 25). When such a file is gone after a deploy, the page reloads once, guarded in `sessionStorage`; if that fails too, the router's error page shows.

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

One crashed service or one busy workspace must not take the platform down for everyone (Epic 17, ADR 0034):

- Caddy, PostgreSQL, Dex and every Portikus service restart on failure after 5 seconds.
- The platform's services outrank workspaces: `system.slice` has CPU weight 1000 (a workspace has 100) and `MemoryLow=512M`, and PostgreSQL and the API each have `MemoryLow=256M`.
- Each workspace's network is capped at 200 Mbit/s each way (`workspace_network_limit` in `site.yml`).
- Every worker call to the controller and every controller call to Incus has a time budget, and stops run in the background so a stuck stop never delays a start (section 6.5). The worker sends its budget with each call; every lifecycle call (create, start, stop, reset-Docker, rebuild), volume growth and the process read stop their remaining Incus and host work once that budget runs out or the worker hangs up, except that a stop whose graceful request has been sent always runs on to the forced stop, a start whose request has been sent to Incus always finishes its remaining steps (otherwise the sweep would mark a half-started instance running), and an aborted create never falls back to an empty Docker volume (ADR 0034).
- The database pool waits at most 5 s for a connection, a statement at most 30 s, and an idle transaction at most 60 s; a pool timeout or an unreachable database answers 503 `SERVICE_BUSY`.

### 25.4 Availability

High availability is not required for P0.

A single pilot VM is acceptable.

The system must fail clearly rather than presenting stale or misleading workspace state. When the worker has not reached the workspace controller for two minutes, the status bar marks the state unconfirmed (section 18.3).

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

Added by Epic 34 (#918): administrator notifications with tone warning or danger that are marked site alerts (`site_alert`, written only by `notifyAdministrators`) are forwarded to Pushover, then to a webhook, through the egress proxy. The webhook body is `{text, title, tone, site, at}`, with flood control. `portikus-alert@.service` reports a failed API, worker, PostgreSQL, Caddy, backup or off-site copy unit at most once per unit per 10 minutes.

Added by Epic 36: the API, the only unit that may read the journal,
reads it each minute and raises two more site alerts. A workspace that
hits the mail block or the connection or packet limit raises one
warning per workspace and reason an hour, naming the Incus instance,
never the student. Twenty or more error lines from the Portikus units
in 15 minutes raise one alert with a fixed sentence giving the count and
unit names, never log text; it is raised again only after it clears.

Added by Epic 35 (ADR 0052): the channels are set on the admin page
(section 20.1) and kept in `/etc/portikus/notify.json` (section 24.8),
read at each send, so a change needs no restart and alerts still go out
when PostgreSQL is down. Site alerts go to every configured channel:
email (nodemailer through the egress proxy, ports 587 with STARTTLS or
465 with TLS, TLS required and certificates checked, at most ten
recipients), Pushover, ntfy (with an optional bearer token), Microsoft
Teams (an Adaptive Card to a Workflows webhook) and the generic webhook,
whose `text` body also serves Slack, Mattermost, Google Chat and
Discord. Every URL must be `https://` on port 443; other ports are
refused. A root job, `portikus-alerts-job.path`, applies each change and
writes the alert hosts into `/etc/portikus/egress-proxy.d/alerts.conf`,
which Squid includes after its private-address denies. Errors are short
codes, never a server's text. When `rootShellOpenedAlert` is on, each
root shell opened sends a warning site alert naming the administrator.
Certificate expiry and renewal failures are site alerts, so they reach
email too.

Added by Epic 14.3 (section 19.4): the worker records each running
workspace's CPU time, memory working set and limits from Incus once a
minute in `workspace_usage_samples`, keeping them for 245 minutes (the
longest allowed guard window plus five). They hold no process, command
or file names.

As built (Epic 19): the admin Health tab has three rows: Platform and
Resource guard; a full-width Trends card; then Failures (fixed at the
last 24 hours) and Workspaces by state (every known state, zeros
included). The Trends card offers four ranges, 1 hour, 6 hours, 1 day
and 7 days, in 1-minute, 5-minute, 15-minute and 1-hour buckets. The
choice is remembered per browser and defaults to 1 day. One admin-only
route, `GET /admin/health/series?range=`, returns every chart's data
already bucketed, at most 168 points per series; `GET /admin/health`
keeps only the current state. Charts are hand-drawn SVG with a Y axis,
time labels, threshold lines, a legend that uses dash patterns so no
series relies on colour alone, a visible text summary, and one tab stop
whose arrow keys read each bucket aloud. The host charts show pool and
memory use and the 1, 5 and 15 minute load, each the maximum in its
bucket, with the CPU count as a reference line.

Changed by Epic 25: the Health tab reads top to bottom as the worker-stale
banner; "At a glance", four cards side by side when there is room
(Platform, Resource guard, Failures in the last 24 hours, Workspaces by
state); the Trends card in four groups, Host, Workspaces, API and Events,
open by default and remembered per browser. "Packages students add" is
on the Workspace image tab, not here (section 20.1).
Each chart names its unit in its title, its Y ticks are bare numbers, and
axis text is 12 px at any width. A chart with no samples in the range is
one line of text with no axis.

As built (Epic 19, activity): the Trends card has a per-workspace heat
map, one row per workspace with a guard sample in the window and one
cell per bucket, capped at the 50 highest peaks and sorted by owner
name. A cell holds the highest CPU % (the guard's arithmetic: CPU time
over the limit's allowance) or memory % (working set over the limit) in
the bucket, with a CPU and Memory toggle. Cells shade in four steps of
the accent colour, and a cell at or over the workspace's effective guard
threshold is hatched in the warning colour. The map is an HTML table, so
each cell's value and threshold are read aloud, and each row shows its
peak as text and links to the owner's detail panel. Usage samples are
kept about 4 hours, so the map covers at most that and says so on longer
ranges; stopped workspaces have none. Two count charts show guard events
(throttles, memory flags, idle stops, and lifts) and activity (start
requests, stop requests including idle stops, and successful sign-ins)
per bucket from the audit log, with totals for the range as the summary.

As built (Epic 19, platform): the controller measures host CPU %,
network and disk throughput from `/proc` as deltas against its previous
reading (`HostSnapshot.rates`, null on the first reading after a restart
or when a counter goes backwards). Network counts only the default-route
interface, and disk only whole block devices, not `loop`, `ram`, `zram`
or `dm-` devices, so nothing is counted twice. The worker stores the
running workspace count from the database in each health sample.
Percentages, load, CPU % and the running count use the bucket's maximum;
throughput uses the average bytes per second; counts are sums. An
availability strip shows, per bucket, the share of minutes with a sample
and where the controller was unreachable, with a pattern as well as
colour. Buckets with no data are left out of the series, and charts draw
a gap. Since Epic 25 outages are the error colour with a stripe and
missing samples a faint grey dot pattern.

As built (Epic 19, API requests): the API counts every response per
minute in memory (requests, 4xx, 5xx, WebSocket upgrades apart from
requests and latency, and a latency histogram with bounds 5 ms to 10 s
plus an overflow bucket), except `/health` polls, and adds the totals to
`api_request_samples` once a minute and at shutdown. It stores no route,
path, user or workspace. A failed write is logged and dropped, and the
API prunes rows older than 7 days at most once an hour. The Trends card
charts the request rate, the 4xx and 5xx share, and the median and 95th
percentile response time, interpolated inside the histogram bucket.

Request lines are logged at error for 5xx answers and at info for 4xx
answers, which are the API refusing as meant, except a 429 at warn and an
unmatched path (404) at debug, so smoke runs and routine refusals do not
fill the Warn view or the errors chart.

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

A control that cannot act yet, such as a Confirm button while the workspace is changing state (section 6.5), stays focusable with `aria-disabled` and has its reason announced, rather than being removed from the tab order.

Every Stop icon button (Running, Checks, Monitor and the admin Processes table) uses one shared danger colour, the `pk-iconbtn-danger` class, for its normal, hover and focus states, and keeps a target of at least 24 px (WCAG 2.5.8) (Epic 22).

Added by Epic 25: a Toggletip (section 8.6) is a button named "About {subject}". Opening it leaves focus on the button, and a polite live region reads the text. The live region sits at the end of the page, or of the dialog that holds the tip, so the text never joins the name of a table header or label around the button. The button makes no popup claim (no `aria-haspopup`), and the visible tip is hidden from screen readers, so browse mode never finds an empty dialog; the button still reports `aria-expanded`. Tab or Shift+Tab moves on and closes it, as do Escape and a click outside; after Escape focus is still on the button. The PageIntro is a native `details`. Icon-button tooltips can be hovered, so the pointer can move onto them without closing them (WCAG 1.4.13). The Help page moves focus to the heading its anchor names. A sticky table header never hides a focused control (WCAG 2.4.11): the admin page and the Course page keep a scroll padding for it.

Added by Epic 28: a meter is the `Meter` component in `packages/ui`: a native `meter` with an accessible name matching its row label, its value text beside it (hidden from screen readers) and as `aria-valuetext`, and a `line-strong` edge on the track so its empty part meets 3:1. At or past its warning mark (`high`) the text and value gain the alert icon and "nearly full", and past `max` "over the limit", so colour is not the only sign.

Added by Epic 28: setting or ending a Keep running hold is announced through a status region that is always mounted ("Kept running until {end}." or "Keep running ended."). After "Don't keep running", focus moves to the "Keep running until …" button, or to the dialog's title when no hold can be set. A button whose label holds a date wraps rather than clipping at 320 px and at 200% text. After a control is removed by its own action, such as the seed drift update or an image delete, focus moves to the nearest heading.

The automated axe checks in the Playwright suite run the WCAG 2.0, 2.1 and 2.2 A and AA rules from one shared tag list, `WCAG_TAGS` in `e2e/helpers.ts`.

Added by Epic 24: a dialog whose opener is gone after it closes (a removed row, a used "Allow…" button) passes `returnFocusTo` to `Dialog` or `ConfirmDialog` in `packages/ui`, and focus goes to that target, usually the card's heading, scrolled into view; otherwise focus returns to the opener. A control that is busy, such as a preset checkbox while its save runs or a Delete button reading "Deleting…", stays mounted and focusable with `aria-disabled`. A button that cannot act yet, such as "Restore copy", names its reason through `aria-describedby`. A message that appears later, such as the restore dialog's stopped-workspace warning or the reinstall notice, is announced through a status region that is always mounted. A ticking time ("3 minutes ago") is not announced.

Added by Epic 33: status regions on the workspace page set `aria-live`
explicitly, so an open modal does not silence them, and a modal in
`packages/ui` also hides page content that mounts after it opened (ADR
0047). No live region carries a ticking time. Every sortable table, Monitor
included, announces each sort change politely. Every drag has a click
alternative: a tab menu (right-click or Shift+F10) moves a tab left or
right, a terminal or file pane's actions menu has "Move into" another tab, and
"Reset pane sizes" evens out a tab's splits. The file tree is a
multi-select tree (`aria-multiselectable`) with Home, End, type-ahead,
Shift+Arrow to extend the selection and Ctrl+Space to toggle a row. The
editor's text box is named after its file and the Ctrl+M way out of it
(Ctrl+Shift+M on macOS).

Added by Epic 39: when the focused file-tree row disappears, the Tab stop
moves to its next sibling, else the row above it, else its folder, and the
focus moves with it if the tree held it. The extraction toast's bar is a
native progress element that carries its figure in `aria-valuetext`, inside a
region with live announcements off, so the toast does not read every tick.
The search, Compare with and CSV controls report state to screen readers (the
option toggles with `aria-pressed`, the pattern error as the field's own
error, one always-mounted polite status region for the slow recovery read and, in the recovery point dialog, one polite region for the list's wait,
visible muted "Column N" names for blank CSV headers, sortable headers as buttons with `aria-sort`).

Voice input in a terminal or an open file is a deliberate exception to the click alternative
for held actions. The microphone button and Alt+Shift+M listen only while held
(pointer, Space or Enter on the button, or the shortcut), and there is no
click-to-latch mode. The product owner chose this so the microphone is never
left open by accident (ADR 0055). A click that cannot be held (keyboard or
screen reader click) says in the status region how to hold.
The app header and the Course page work down to 320 px.

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

Voice input uses the browser's own speech recognition, in terminals and in editable text files. In a file, the microphone sits in the file header and Alt+Shift+M held in the editor does the same. Each final phrase is inserted at the cursor, replacing any selection, as one undo step, and marks the file unsaved as typing does. It gets one leading space when the character before it is not whitespace and not the start of a line. A Markdown tab dictates into the editor side. There is no microphone on images, view-only files, the CSV table, the SVG picture, the diff or conflict view. Errors also show as a visible line under the file header. The audio goes to the browser vendor's service (Google for Chrome, Microsoft for Edge, Apple for Safari), not to Portikus. Portikus sends nothing to its server and logs nothing, and types only final phrases with every control character removed, so dictation never presses Enter. Errors and hints show on the pane and in a polite status region. A browser without the API, or whose service fails with a network error (Brave), shows no microphone and says so (ADR 0055).

Added by Epic 42 (ADR 0057): coding-agent usage is collected as counts
only: sessions, input, output and cache tokens, Claude Code's estimated
API cost, and lines added and removed, per user, UTC day, agent and
model. Never a prompt, a response, a file name or code. Instructors see
totals for their course members and administrators see everyone; there
is no student view. Students are told in Help. The counts come from the
student's own agents and can be forged, so they are for reporting, never
enforcement. The worker stores only real days from 40 days back to one
day ahead and at most 48 boot ids per user per day. They are kept 365
days.

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

### Added by Epic 14.3

Migration `0020_resource_guard` (sections 5.1, 6.4 and 19.4):

- `settings` gains `cpu_guard_threshold_percent` (default 80, 1 to 100), `memory_guard_threshold_percent` (default 90, 1 to 100), `guard_window_minutes` (default 30, 5 to 240), `cpu_throttle_share_percent` (default 25, 5 to 100), `idle_stop_minutes` (default 60, 0 or 10 to 1440), each range a check constraint; `acceptable_use_text` (null for the built-in default) and `acceptable_use_version` (default 1).
- `workspaces` gains `guard_config` (jsonb overrides), `cpu_throttle` and `memory_flag` (jsonb, null when clear), `last_activity_at` and `idle_stop_at`. On upgrade, every workspace whose owner has a grace-period override of 0 gets `{"idleStopMinutes": 0}`, so it keeps running as before, and every workspace not stopped gets `last_activity_at` set to the migration time.
- `users` gains `acceptable_use_version` (null for never) and `acceptable_use_accepted_at`.
- A new table, `workspace_usage_samples`: `id`, `workspace_id` (cascades on delete), `observed_at`, `cpu_usage_ns`, `boot_marker` (nullable), `cpu_limit`, `memory_bytes`, `memory_limit_bytes`, indexed on `(workspace_id, observed_at)`.

Migration `0021_notifications` (section 8.5, ADR 0033): a new table, `notifications`: `id`, `user_id` (cascades on delete), `tone` (`neutral`, `success`, `warning` or `danger`), `title`, `body`, `created_at`, `read_at` (null while unread), indexed on `(user_id, created_at desc)`.

Migration `0023_guard_idle_lift` (section 19.4, Epic 21): `settings` gains `cpu_idle_lift_minutes` (default 5, 1 to 60) and `cpu_idle_lift_percent` (default 10, 0 to 100), each range a check constraint.

Migration `0024_process_snapshots` (section 20.1, Epic 21, ADR 0037): a new table, `workspace_process_snapshots`: `workspace_id` (primary key, cascades on delete), `requested_at`, `taken_at` (null until served), `processes` (jsonb rows with short names only, never command lines) and `error` (a code).

### Added by Epic 24

- `0025_egress` (section 23.6): `settings` gains `egress_mode` (`open` or `allow-list`, default `open`), `egress_presets`, `egress_ports` (default 22, 80, 443), `egress_version`, `egress_applied_version`, `egress_applied_at` and `egress_apply_error`. New tables `egress_entries` (`kind` `host` or `range`, unique `value`, `label`, `created_by`) and `egress_blocked_names` (day, name, source `dns` or `tls`, count), which has no workspace, user or address column.
- `0026_backups` (section 24.9): `backup_requests` (kind, args, state `pending`, `claimed`, `done` or `failed`, who and when, error, result, and `workspace_id` for restores), with at most one pending or claimed `backup`; `backup_status`, one row holding the host's last report and the worker's list of snapshots and kept homes. `workspaces.pending_operation` accepts `replace-home`, with `pending_operation_args`, and recovery points accept the reason `before-replace-home`.
- `0027_workspace_limits` (section 19.4): `workspaces.limits_config` and `limits_applied` (jsonb, nullable).
- `0028_throttle_hold` (section 19.4): `settings.cpu_throttle_hold_after` (default 3, 0 to 10) and `cpu_throttle_hold_hours` (default 24, 1 to 168); `workspaces.cpu_throttle_recent`; `cpu_throttle` may carry `held`.
- `0029_package_survey` (section 22.3): `package_survey_days` (day, workspaces surveyed) and `package_survey_counts` (day, package, workspaces); `workspaces.package_surveyed_on`. No table holds both a workspace and a package name.
- `0030_egress_blocked_sites` (section 23.6): `egress_blocked_entries` (unique `value`, `label`, `created_by`), created empty.
- `0041_lti_roster_and_deep_linking` (ADR 0058): `lti_contexts` gains `platform_client_id`, `nrps_url`, `roster_synced_at` (the last attempt) and `roster_sync_result`; new tables `lti_roster_members` (course, subject, display name, role; no email), `lti_deep_link_requests` (single use, ten minutes) and `lti_starter_launches` (bound to a user, thirty minutes, exactly one of template and repository).
- `0042_project_shares` (ADR 0057): `project_shares` (at most one open share per project) and `project_share_views` (first and last view per instructor).
- `0043_agent_usage_days` (ADR 0057): `agent_usage_days`, counts per user, boot id, day, agent and model, with no content column.

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

[ Reset Docker… ] [ Workspace details ]
```

rather than only:

```text
ENOSPC
```

Technical details should remain available for administrators and debugging.

Student-facing views show every error as a plain sentence, with a
fallback per view for an unexpected code. Admin views keep the raw error
text and code.

When a workspace fails to start and the workspace agent still reports storage figures, the error screen shows the storage meters. It offers "Reset Docker…" (the Reset Docker confirmation) as its main action only when the error is `STORAGE_FULL` and Docker storage is at the critical level, because resetting Docker when project storage is what filled up would destroy data for nothing.

While a workspace is in error, the API still serves its usage figures if the workspace agent answers. The error screen then shows the storage meters and, for `STORAGE_FULL` with Docker at the critical level, "Reset Docker…". It offers "Try again" for every error except `IMAGE_NOT_FOUND` and `INSTANCE_MISSING`, which only an administrator can fix; for `STORAGE_FULL` it follows "Reset Docker…" when that is offered, because an administrator may have grown the quota. "Workspace details" is always there, and the Workspace dialog shows the same figures while the workspace is in error (Epic 25). After a failed first request the error screen asks for usage again every 30 seconds.

To make that safe, the worker keeps an error workspace's recorded agent address current: the address Incus reports now, or none when the instance is stopped or gone. The API never calls the agent of an `INSTANCE_MISSING` workspace.

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
- There is no re-provision path after a failed create; the row stays in
  `error` and an operator has to clear it.
- OpenAPI generation from the Zod contracts (ADR 0003) is not wired up yet.
  Tracked in issue #1221.
- When the controller is unreachable the worker records an audit event, but
  the API still reported the last known state instead of marking it
  unverified. Closed by Epic 31: see section 18.3.
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
  instead, which is enough for one platform VM. (Delivered by Epic 15.)

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
  missing); a course (LTI) account's username is the launch's
  `preferred_username`, else the LTI custom claim `username`, and when it
  has neither its label falls back to the part of its email before the
  `@` (issue #558), then to its LTI user ID (the launch's `sub`), each
  reduced the same way and skipped when it reduces to nothing, never random
  hex while either exists (issue #549, replacing Epic 13 ruling 12, which
  stored no username); when the `-2`, `-3` suffixes run out, the later
  fallbacks are each tried once; an existing label never changes;
  the label names the preview hosts and is pushed into the
  container as its hostname at every start, so the prompt reads
  `student@<label>.<public host>`; a failed hostname set logs a warning
  and the start carries on;
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
A server-side browser for loopback OAuth callbacks is not planned.

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

As built: `docs/archive/epics/EPIC-10.md` has the working brief; landed on
`epic/10-recovery-quotas`. §15.10 describes recovery storage and
operations, §16.4 Reset Docker, §17.2 rebuild, and §19.2 storage figures
and warnings; ADR 0020 and ADR 0021 record the choices. Out of this epic:
comparing against a recovery point (§12.6) and per-file history (§15.9),
the guided student rebuild, changing quotas at runtime, re-creating a
workspace whose instance is gone, and deleting, downloading, or restoring
points into a new project by hand.

### Epic 11 — Administration and observability
**Estimate:** 3–4 engineer-days

See `docs/archive/epics/EPIC-11.md` for the working brief and decisions; landed on
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

Epic 12a (security test suites): see docs/archive/epics/EPIC-12A.md; landed on epic/12a-security-tests.

Epic 12b (Dex sign-in and pilot readiness: load, backup and restore, rebuild, deployment documentation, threat model): see docs/archive/epics/EPIC-12B.md; the operations runbook is docs/OPERATIONS.md.

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

See `docs/archive/epics/EPIC-13.md` for the working brief and rulings, and `docs/adr/0025-lti-launch.md` for the design; landed on `epic/13-lti-launch`.

Includes:

- LTI 1.3 core resource-link launch (third-party login, id_token validation, state and nonce);
- LMS platforms registered in an operator file applied by Ansible;
- the `instructor` role, from LTI or from the site's sign-in provider;
- a read-only Course page for instructors;
- a mock LMS on the operator's host for trying and testing launches.

Acceptance:

- a student and an instructor launched from a registered LMS land in their own workspace with no second password;
- every invalid launch is refused with its own reason code;
- an instructor is refused on every administrator route and cannot reach another user's workspace.

### Epic 13.1 — Link a course account to an SSO account, and promote administrators

See `docs/archive/epics/EPIC-13-1.md` for the working brief and rulings, and `docs/adr/0026-account-links-and-role-grant.md` for the design; landed on `epic/13-1-account-linking`.

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

### Epic 14 — Sign-in providers

See `docs/archive/epics/EPIC-14.md` for the working brief and rulings, `docs/adr/0027-egress-by-hostname-through-a-forward-proxy.md` for the egress proxy, and `docs/adr/0028-dex-storage-and-first-administrator.md` for Dex's storage and the first administrator; built on `epic/14-sign-in-providers`.

Includes:

- Microsoft Entra ID (one tenant, app roles) and Google Workspace (listed domains) by direct OIDC (superseded by Epic 14.2: both are now Dex connectors);
- LDAP and Active Directory, and Entra or Google for guests, through Dex connectors;
- Dex's accounts in PostgreSQL, with Add user, Reset password and Remove in the Users view through Dex's gRPC API behind mutual TLS, and the users file imported once and retired;
- Make instructor and Remove instructor in the Users view;
- a one-time setup code for the first administrator (superseded by Epic 14.2: the local administrator and `portikus reset-admin`);
- API egress by hostname through a Squid forward proxy, replacing the API's address allow list;
- operator documentation for each provider, including Shibboleth's OIDC plugin and why SAML is not built.

Acceptance:

- each provider admits exactly the people its rules allow, tested against imitation tokens, and refuses the rest with a reason in the audit log;
- moving the pilot's accounts into Dex's storage keeps every account, `sub` and workspace;
- nobody becomes an administrator by signing in first;
- the API cannot reach any internet address except through the proxy, and through it only listed hosts.

### Epic 14.2 — One front door

See `docs/adr/0031-dex-is-the-only-front-door.md` for the decision and sections 5.1 to 5.3 and 24.11 for the rules; built on `epic/14-2-one-front-door` (issue #537).

Includes:

- the API trusting only Dex, with its direct Entra, Google and generic OIDC paths and their settings (`OIDC_PROVIDER`, `OIDC_ALLOWED_TENANT`, `OIDC_ALLOWED_DOMAINS`) removed;
- Dex connectors for Entra (app roles, the tenant's own issuer), Google, LDAP and any other OIDC provider, one per site;
- a local administrator on every install, with a one-time password in a root-only file, and `portikus reset-admin` for recovery;
- "must change password" for the local administrator and for passwords an administrator sets, enforced by the server;
- Settings, Password for every Dex local password;
- the setup code, `/setup` and the first-account form removed.

Acceptance:

- no API code path reads `tid` or `hd`, and no setting selects a provider-specific branch;
- the local administrator's password appears only in the root-only file;
- while the flag is set, every route but the change-password ones answers 403, and WebSocket upgrades and previews are refused;
- under `entra` a token from another tenant is refused, and under `entra` or `oidc` a person with none of the three roles or groups is refused by Dex;
- moving the pilot keeps every account, `sub` and workspace, and adds only the local administrator.

### Epic 14.3 — Resource guard

See `docs/adr/0032-resource-guard.md` for the decision and sections 5.1, 6.4, 19.4, 20.1, 24.11, 25.6 and 26 for the rules; built on `epic/14-3-resource-guard` (issue #554).

Includes:

- per-workspace CPU and memory samples from Incus every minute, through the controller;
- a CPU throttle by time-slice allowance after a rolling average above the threshold, remembered across restarts, with a student notice, admin tags, a Health section, lift, and audit rows;
- a memory flag for administrators, with clear and audit rows;
- idle stop by activity, with the "Still working?" notice, beside the unchanged grace period;
- guard and idle settings with per-workspace overrides;
- the acceptable-use statement, accepted at first sign-in and after every change, as the second gate after "must change password";
- a notification history for toasts (issue #475, ADR 0033) and a terminal limit of 20 (issue #474).

Acceptance:

- a workspace at or below the CPU threshold over the window is never throttled; one above it is throttled once, with one audit row, and a stop-start or reboot cycle does not reset its usage;
- a throttled running workspace always ends with the allowance set in Incus, and an unthrottled one without it, after restarting the worker, the controller or both;
- the throttle and memory flag never outlive a stop, and a started workspace never carries an allowance;
- no sample, audit row or response carries a process name, command line or file name;
- an administrator's actions and the workspace agent never count as a student's activity, and an unattended coding agent is stopped by idle stop;
- while a gate is unmet, every route but that gate's answers 403 with its code, and the password gate comes first.

### Epic 15 — `apt install portikus`

See sections 20.1, 21.8, 21.12, 21.13, 22.4, 24.7, 24.8 and 24.9, and
ADRs 0029, 0030 and 0044; built on `epic/15-apt-install` (task PRs #790
to #812). No migrations. Delivered.

Includes:

- `apt install portikus` as the default install: debconf questions,
  preseeding, `dpkg-reconfigure`, and setup run by a root unit from the
  Ansible roles shipped in the package;
- storage on an empty disk, a volume group or, by default, a file;
- TLS by Caddy's authority, given files, or Let's Encrypt with a DNS-01
  wildcard through Cloudflare;
- Node bundled in the package;
- a signed apt repository on GitHub Pages and signed image releases;
- the admin Workspace image section, with a root job for fetch, build,
  health check, activate and rollback, which setup also uses for the
  first image;
- backups on the server itself, with the key downloaded and uploaded in
  the Backups tab.

Acceptance:

- `make install-test IMAGE_JOBS=1` goes from nothing to a signed-in local
  administrator, a green smoke test, an upgrade, the image rehearsal and
  a rebuild from an off-site backup, on a throwaway VM;
- no secret is in `portikus.yaml`, debconf, a log or `ps`;
- an unconfirmed device changes no disk;
- apt refuses the repository without the key, and nothing imports an
  image whose signature fails;
- an image that failed its health check cannot be made the default;
- a forged or renamed backup set does not restore.

### Epic 15.1 — Install docs and release polish

See sections 16.2, 20.1, 21.12, 21.13, 22.4 and 24.9; built on
`epic/15-1-docs-release` (issues #821 to #834, #840 and #842; task PRs
#830 to #853). No migrations. Delivered.

Includes:

- the Ansible role installs Portikus from the signed apt repository, and
  releases no longer attach the `.deb`; the pilot is updated only by
  `apt upgrade`;
- apt retention that keeps the ten newest packages of the current
  major.minor line and the newest of each older line, a `Valid-Until` of
  30 days, and a weekly re-sign;
- setup installs an older package only when `PORTIKUS_VERSION` names it,
  and goes on when only the Portikus repository is unreachable;
- the worker under its own `portikus-worker` account and least-privilege
  database role, with a firewall rule that lets it reach only the
  controller on loopback (section 24.9);
- Docker pinned to overlay2 on the workspace's Docker volume, checked by
  the image health check;
- fixed VM MAC addresses, so a rebuilt pilot or rehearsal VM keeps its
  address;
- a just-created account shows "Not signed in yet" rather than stale;
- one source for the install settings keys, the development VM's image
  built by the image job, community files, install screenshots, a docs
  pass and a Markdown link check.

Acceptance:

- `make install-test UPGRADE_FROM_PUBLISHED=1 IMAGE_JOBS=1` is green,
  including the worker's refusals on the API, Dex and the sign-in tables;
- the pilot reinstalls from the apt repository and passes the smoke test.

### Epic 18 — Admin interface polish

See section 20.1 for the rules and `docs/DESIGN.md` section 9 for the table styles; built on `epic/18-admin-ux` (issues #600, #601, #602, #604 and #629).

Includes:

- one width-capped, compact frame for the four admin tabs, with h2 tab headings and per-tab page titles;
- the design's table classes on every admin table, with sticky headers;
- a seven-column Users table, a reordered sticky detail panel, a tidier Audit table and a Settings card grid;
- bulk Rebuild, and "Rebuild all on older images…", through the single-workspace route.

Acceptance:

- the admin frame fills the window less a 16 px gutter on each side, text and forms keep their own measure, and the Users table does not scroll sideways at 1280 px with the detail panel open;
- each bulk-rebuilt workspace gets its own audit row, and a pending operation counts as skipped, not failed.

### Epic 20 — Student interface polish

Built on `epic/20-student-ux` from the student interface review of 2026-09-26 (issues #608 and #609). No migrations, contract changes or infrastructure. See sections 6.3, 8.3, 8.5, 14.6, 18.2, 18.3, 19.2 and 28 for the rules.

Includes:

- bordered status-bar buttons that keep their warning and error colours;
- a way forward from each stuck screen: buttons on the empty work area, "Try again" and "Workspace details" on the error screen, and "Restart workspace…" on the throttle notice;
- loading skeletons only while the workspace is starting;
- neutral archiving with success toasts for archive and duplicate, and a segmented "What to create" choice in New project;
- clickable preview picker rows and a Preview toolbar with a More menu;
- right-pane headings kept for screen readers only, a visible Preview button on Running rows, and readable panel heads;
- a reordered workspace dialog with storage meters, shared with the error screen;
- clearer Settings groups, wrapping read-only values and a taller Settings dialog.

Acceptance:

- every button a student needs looks like a button, and each stuck screen offers a next step;
- the error screen never offers a Docker reset unless Docker storage is what filled up.

### Epic 16 — Workspace resilience

See `docs/adr/0035-terminals-in-their-own-unit.md` for the decision and sections 9.7, 11.4, 13.5, 18.1, 18.2, 19.3 and 21.7 for the rules; built on `epic/16-workspace-resilience` (issues #610, #618 to #625). Workspace image 2026.09.11.

Includes:

- `/tmp` and `/dev/shm` capped as tmpfs;
- the tmux server in its own unit on a private socket, with the agent in external mode, a 5-second timeout on every tmux call, and the `portikus-shell` wrapper for a shell whose settings make it exit;
- terminal close and Check stop that stop the whole process tree, and backpressure for Check output;
- a port scanner that does not overlap itself, idles when unwatched, and caches socket owners;
- a file watcher that skips more generated folders, stops at 20,000 folders with a "too large to update live" notice, and `STORAGE_FULL` on every agent route for a full disk;
- a toast that says why terminals closed when the terminals unit stopped, from the unit's exit record.

Acceptance:

- a `tmux kill-server` typed in a pane, a broken `~/.tmux.conf` or `~/.bashrc`, a 600 MB file in `/tmp`, and an agent restart each leave the student's terminals working;
- a full home folder gives the home-folder-full sentences, never a tmux error;
- an agent that reports a terminal gone causes at most one exit-record lookup per connection.

### Epic 17 — Platform resilience

Built on `epic/17-platform-resilience` from the platform resilience audit of 2026-09-26 (issues #611 to #617). See sections 4.3, 5.3, 6.5, 20.1, 24.7 and 25.3 and ADR 0034.

Includes:

- restart on failure for Caddy and PostgreSQL, and CPU and memory priority for the platform's services over workspaces;
- time budgets on every worker and controller call, and stops in the background;
- a 2-second preview lookup cache, a per-session preview cap, database pool timeouts, and per-user limits on workspace lifecycle requests and file writes;
- storage pool metadata on the Health tab, administrator notifications at 70% and 90%, refusal of new workspaces at 90%, and a pool that errors when full;
- a 200 Mbit/s network cap per workspace.

Acceptance:

- killing Caddy or PostgreSQL brings the site back within about 10 s without restarting the API or worker;
- a workspace whose stop hangs does not delay another workspace's start;
- a write to a full pool fails at once, and a new workspace waits in `provisioning` until there is room.

### Epic 19 — Admin observability

Built on `epic/19-admin-observability` (issues #476, #597, #598, #599 and #603). See sections 20.1, 24.11 and 25.6, ADR 0036 and STACK.md section 15 for the rules.

Includes:

- a Health tab in three rows with a Trends card of hand-drawn SVG charts over 1 hour, 6 hours, 1 day or 7 days, from one `GET /admin/health/series` route;
- host charts (pool, memory, load, CPU %, network, disk, running workspaces and availability), a per-workspace heat map, guard event and activity counts, and API request rate, error rate and response time from a new `api_request_samples` table;
- a Logs tab reading the three Portikus units' journal lines through `journalctl`, filtered, redacted and linkable, with "View logs" links from the detail panel and an errors and warnings chart on Health.

Acceptance:

- an administrator can find a platform warning from the browser without a shell on the VM, and a student gets 403 on every logs and series route;
- only the API process can read the journal, and no request text reaches a `journalctl` argument.

### Epic 21 — Resource tools for students and admins

See `docs/adr/0037-admin-process-list-through-incus.md` for the decision and sections 18.3, 19.2, 19.4, 20.1, 24.11 and 26 for the rules; built on `epic/21-resource-tools` (issues #595, #596 and #607). Migrations 0023 and 0024.

Includes:

- Stop and Force stop for the student's own processes in Monitor, through a checked agent route keyed on PID and start ticks, and the full command line on request;
- a throttle that lifts on its own after a quiet spell (5 minutes under 10% by default), with the facts in the student's notice and a "back to full speed" toast;
- a memory notice for the student, "See what's using CPU" and "See what's using memory" buttons that open Monitor sorted, and always-visible memory and disk meters in the status bar;
- an administrator's process list read on the host from the cgroup tree and `/proc` through the worker, never from the agent, with Stop and Force stop through the agent and a notification to the student.

Acceptance:

- no stop path signals PID 1, the agent, the terminals' tmux server, another user's process or a reused PID, and nothing escalates to SIGKILL without the person asking;
- no log, audit row, snapshot or administrator view carries a command line;
- a throttled workspace lifts only after a quiet spell measured against its full CPU limit, and a workspace busy at its throttled share never looks quiet;
- the administrator's list shows a program the student hid from the agent, because nothing in it comes from the workspace but short names.

### Epic 24 — Admin operations

See sections 14.5, 19.4, 20.1, 22.3, 23.6, 24.9, 24.11 and 26, and ADRs 0038 to 0043; built on `epic/24-admin-operations` (issues #730, #626, #283 and #284). Migrations 0025 to 0030.

Includes:

- workspace egress control: open mode by default, an allow-list by host name enforced through our own resolver, a root-owned nftables table and a workspace Squid that reads TLS names without decrypting, and a blocked-sites list for open mode;
- a Backups tab over a host-polled request channel, with Back up now, deletes, restoring one workspace into a side copy and then replacing its home, and the restore key held on the host;
- re-provision of a workspace in `error`, per-workspace CPU, memory and process limits, and a throttle that holds through restarts after repeated throttles;
- an apt hook in the image, an aggregate "Packages students add" survey and a reinstall note after a rebuild;
- previews of student servers that speak HTTPS.

Acceptance:

- allow-list mode fails closed at every layer and after a reboot, and no table, log or audit row pairs a looked-up name with a workspace;
- a lying VM makes the host refuse and run nothing, and the VM never reads the key or decrypted data except a copy into the named workspace as its student;
- a client-sent upstream scheme header never reaches the proxy.

### Epic 25 — UI polish and help

See sections 5.1, 5.3, 8.5, 8.6, 12.7, 13.5, 14.7, 15.8, 18.2, 18.3, 19.2, 19.4, 20.1, 24.11, 25.1, 25.6, 25.8 and 28, and `design/system/README.md`, "Help in the product"; built on `epic/25-ui-polish`.

Includes:

- a Help page with parts by role, and PageIntro and Toggletip help on every admin tab and student pane;
- the admin tabs reordered, a five-column Users table, a reordered workspace detail panel, one-column Settings, and Logs and Audit filters by person;
- Settings that saves as it goes, narrow right-pane layouts, and a Reset Docker… and Try again error screen.

Acceptance:

- every help button works the same by keyboard, mouse and touch, and axe passes in both themes;
- an administrator can stop or start a workspace stuck in a transition.

### Epic 26 — Shared Docker pull storage

See sections 16.6, 20.1, 23.6 and 24.5, and ADR 0045; built on
`epic/26-docker-cache` (issue #840). Migrations 0031 to 0033.

Includes:

- a Docker Hub pull-through cache on the workspace gateway, and a ghcr.io
  cache that is on by default;
- a global seed volume copied as a thin snapshot into new workspaces,
  Reset Docker and admin rebuilds;
- a Docker admin tab with the cache, the Hub credential, the ghcr.io
  switch, the seed and an image use report.

Acceptance:

- a second pull of an image from any workspace downloads almost nothing
  from the internet;
- the cache ports are closed to the management network and to any
  workspace whose egress policy does not allow the registry's names;
- a seeded workspace's files have real owners and `docker run` works.

### Epic 27 — Certificates from the admin page

See sections 20.1, 21.12, 24.8 and 24.11, and ADR 0046; built on
`epic/27-certificates` (issue #804). No migration.

Includes:

- a Certificate admin tab for the internal authority, ACME by DNS-01
  (nine providers) or HTTP-01 with on-demand previews, and uploaded
  files, with Test only, Apply, Renew now, Roll back and the root
  download;
- a root certificate job with a throwaway Caddy, automatic restore, an
  hourly check and expiry and renewal notices;
- `portikus reset-certificate`, and an installer that defaults to the
  internal authority and seeds the state once.

Acceptance:

- a failed change leaves the live certificate in use;
- no secret appears in Caddy's autosave, a log, an audit row, a status
  file or a view;
- only Cloudflare is tested end to end; HTTP-01 and EAB are tested
  against Pebble, Let's Encrypt's local test server.

### Epic 28 — Fix batch

See sections 3, 6.4, 14.5, 16.6, 19.4, 22.4, 24.5 and 25.8, and ADR 0045;
built on `epic/28-fix-batch` (issues #928, #931 to #934, #936, #955,
#957, #959). Migrations 0034 and 0035.

Includes:

- Keep running until, a student hold over the disconnect grace and idle
  stop, with a site cap and a per-workspace override;
- platform agent instructions as system files the controller rewrites at
  every start;
- a protocol probe only when a preview first asks, which asks in plain HTTP first and tries a TLS handshake only when the answer is not an HTTP status line, or is a 400;
- Docker tab sizes and meters, the cache-off reason, a 120-day usage
  window, and a seed matched to the default image's Node and Python;
- deleting workspace images, a smaller automatic keep, and image sizes;
- seed admission against the pool limit, the install question's
  free-space rule, and CI time limits.

Acceptance:

- a held workspace is not stopped by grace or idle stop before the hold
  ends, and both timers warn first afterwards;
- discovery sends nothing to a student's listener;
- the default and previous images can never be deleted.

### Epic 29 — Code quality cleanup

Built on `epic/29-code-quality`. No migration and no change to request
or response bodies. See sections 22.4, 24.1 and 24.11, and WORKFLOW.md,
"Code style".

Includes:

- shared helpers for audit rows, unique-violation checks, error
  messages, API errors and parameters, worker timer loops, and the
  workspace-agent client;
- large files split along their seams in the API, the worker, the
  workspace agent and the web app;
- shared shell test helpers and a smoke test split by subsystem;
- comments that explain why instead of narrating history, and a lint
  check that keeps them so.

Acceptance:

- the smoke test gives the same counts before and after;
- `pnpm lint` fails on an issue, epic, task, ruling or review reference
  in a code comment.

### Epic 30 — Architecture review fixes

Built on `epic/30-architecture-fixes`. No migration and no change to
request or response bodies between apps. See sections 6.5, 18.3, 20.1,
24.1 and 28, STACK.md sections 2 and 9, and ADR 0034.

Includes:

- one background runner in the worker for every controller call, keyed
  by workspace, with stops outside the shared cap;
- controller writes that replace the file and reads that refuse
  non-regular files;
- workspace agent fixes: guarded port stops, an `INTERNAL` fallback for
  unexpected errors, and no unused workspace id setting;
- every API rate limit on the shared fixed-window counter;
- API layers: `routes/` holds only route files, test doubles live in
  `src/testing/`, and relay tests run against the real workspace agent;
- one source for notifications, close codes, workspace state types,
  guard arithmetic and the agent error map;
- student-facing errors in plain sentences, and the project events
  socket kept open whatever right-pane tab shows.

Acceptance:

- a slow rebuild does not delay another workspace's start or stop;
- `apps/api/src` has no import cycles, and the Debian package carries no
  test code;
- the API's project, file, Git, search and checks routes pass their relay
  tests against the real workspace agent.

### Epic 31 — Workspace reliability, admin polish, CI and lint

Built on `epic/31-reliability`. Migration 0036 adds
`workspaces.start_retries` and `settings.controller_checked_at`. See
sections 6.3, 6.5, 9.7, 18.3, 20.1 and 25.3, STACK.md section 14 and
ADR 0034.

Includes:

- a failing start retried five times, from 10 seconds to 5 minutes, then
  left in error until the student acts; the count is stored on the row;
- Stop on an errored workspace stops a still-running instance, once per
  Stop;
- one deadline from the worker to the controller for a create and a
  process read, with a 480-second create budget;
- the workspace state marked unconfirmed after two minutes without a
  controller check;
- a race-free 20-terminal cap and pruning of ended terminal rows after
  30 days;
- a path per admin tab, and the package survey on the Workspace image
  tab;
- lint import rules and a warning on files over 800 lines, and no
  Playwright system-package download in CI.

Acceptance:

- a workspace whose start keeps failing ends in error after five retries;
- parallel terminal creates never exceed the cap;
- the status bar shows "unconfirmed" when the controller cannot be
  reached.

### Epic 32 — Split the busiest hotspots, one deadline for every controller call

Built on `epic/32-hotspots`. No migration. See sections 6.5 and 25.3
and ADR 0034.

Includes:

- the worker's budget and hang-up honoured by start, stop,
  reset-Docker, rebuild and volume growth, as they already were by
  create and the process read, with the budget formulas in the
  contracts package;
- a started stop that always runs on to its forced stop;
- a failed hostname set logged as a warning while the start carries on;
- the workspace agent's routes as plugins in their own files, the
  controller's start steps and Docker seed builder in their own
  modules, and the web terminal socket and file buffer state in their
  own modules.

Acceptance:

- a worker that gives up on a lifecycle call leaves the controller
  sending Incus nothing more for it;
- a stop with a process ignoring SIGTERM ends stopped inside its budget;
- routes, statuses and bodies of the workspace agent are unchanged.

### Epic 33 — UI polish: admin layouts, Settings, accessibility

Built on `epic/33-ui-polish`, issues #1087 and #1096. No migration. See
sections 19.2, 20.1 and 25.8 and ADR 0047.

Includes:

- the admin tabs in the app header, a stable scrollbar gutter, one admin
  card frame, and new layouts for the Network, Backups, Certificate,
  Docker and Settings views;
- sortable admin tables and a per-row "more" menu on Users;
- a radio-item menu, a shared file input and a "moving" state badge in
  `packages/ui`;
- status bar meters on the shared `Meter`, and admin end toasts for
  rebuild, Docker reset and Replace home folder;
- an accessibility pass over the whole student interface: live regions
  under dialogs, click alternatives to dragging, file tree keys, and a
  header and Course page that work at 320 px.

Acceptance:

- admin content does not shift between tall and short tabs;
- every drag has a click alternative;
- a status announcement is heard while a dialog is open.

### Epic 34 — Internet launch

Built on `epic/34-internet-launch`, issue #917. Migrations 0037 to 0039.
See sections 5.1, 20.2, 21.12, 23.6, 24.2, 24.9, 24.11, 24.13 and 25.6
and ADRs 0048, 0049 and 0050.

Includes:

- the section 24 rules for an internet-facing site;
- the Dex password relay with per-account counts and a known-device
  cookie, and a second factor for Dex-password accounts;
- invitation-only accounts and CSV import, administrator resets, and
  socket caps;
- site alerts to Pushover and a webhook, workspace outbound limits, and
  an off-site backup copy.

Acceptance:

- nobody can sign themselves up;
- one client's failures never refuse another;
- a Dex-password account cannot sign in without its second factor.

### Epic 35 — Admin notification settings and root shell

Built on `epic/35-admin-notifications-root-shell`, issues #918 and
#1063. No migration. See sections 20.1, 20.3, 24.1, 24.8, 24.11 and
25.6 and ADRs 0051 and 0052.

Includes:

- alert channels set on the Settings tab: email, Pushover, ntfy,
  Microsoft Teams and a webhook, kept in a root-owned `notify.json`
  applied by a root job, with the alert hosts in a Squid include folder;
- a Root shell admin tab with split panes, served by a per-connection
  root helper that starts a PAM sign-in session;
- the workspace pane layout shared with the root shell, and workspace
  terminals that stop input at once when a session is revoked.

Acceptance:

- a saved channel's test reaches it through the egress proxy;
- alerts still go out with PostgreSQL down;
- revoking an administrator ends their root shells and what they left
  running, while a closed pane leaves their tmux running;
- nothing typed in a root shell reaches a log or an audit row.

### Epic 36 — Internet hardening

Built on `epic/36-internet-hardening`, issues #1145 and #1192, with
parts of #1138. Migration 0040. See sections 24.9, 24.10, 24.11, 24.13
and 25.6 and ADRs 0053 and 0054.

Includes:

- an offline breached-password list from SecLists;
- a per-address limit on anonymous routes and on made-up preview
  cookies, and fewer counted sign-in starts;
- sign-in guess counts in PostgreSQL, with a recovery-code and passkey
  bypass for the holder;
- refusing the internal certificate authority on a public address unless
  allowed;
- pinned coding-agent versions in the admin image rebuild (replaced by Epic 40);
- journal-based alerts for outbound limits and error spikes;
- restore-mode tests, an off-site quota, a full content security policy
  on API pages, a cap on kept notices, and help and text fixes.

Acceptance:

- guess counts survive an API restart;
- a holder locked out by others' wrong codes still signs in with a
  recovery code or passkey;
- the internal authority is refused for a public name without the flag.

### Epic 40 — Update Claude Code and Codex without rebuilding images

Built on `epic/40-agent-updates`, issues #1215, #1366, #1371, #1373, #1393 and #1403. No migration. See sections 9.3, 10.1, 18.1, 22.4, 22.6 and 24.1 and ADR 0056.

Includes:

- a shared, read-only coding agents folder on the server, mounted into every workspace, with links written at each start for older images;
- Update coding agents and a per-tool Roll back on the Workspace image tab, run by the root image job with verified downloads, a health check as the student, and a switch for each tool on its own;
- a Check the student stops shows as Stopped;
- a file pane drags by its whole title bar, and the editor zoom buttons keep a 24 px target.

Acceptance:

- an open `claude` session survives an update and a new one runs the new version;
- a workspace on an older image runs the shared tools after its next start;
- a failed health check leaves the tool at its old version;
- a rollback of one tool leaves the other alone.

### Epic 42 — Instructor features

Built on `epic/42-instructor`, issues #1216, #1217, #1218 and #1219. Migrations 0041 to 0043. See sections 5.2, 7.2, 7.6, 10, 20.2, 24.1, 24.6, 24.11, 25.10 and 26 and ADRs 0057 and 0058.

Includes:

- a student shares one project, read-only, with the instructors of their courses, who see its files, Git status, diffs and latest check results; the student sees a Shared tag, who can see it, and who looked;
- coding-agent usage counts (sessions, tokens, estimated cost, lines changed) for instructors and in an admin Agent usage tab, never content;
- roster sync through NRPS from a Sync button and an hourly refresh when the Course page opens, with "Not started" rows and removal of people who left;
- LTI Deep Linking to a template or a public repository, and a student starter launch that never overwrites.

Acceptance:

- an instructor who does not teach the student's course, or a share that ended, gets 404;
- secret-looking paths and symlinks never appear in a shared view;
- a roster that would leave no instructor is refused and changes nothing;
- a second launch of a starter link opens the same project.

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
- ~~roster provisioning~~ (delivered by Epic 42);
- instructor support/share sessions (read-only project sharing delivered by Epic 42; the live help session is not);
- ~~read-only or temporary instructor workspace access~~ (delivered by Epic 42);
- developer profile with long-running agents;
- notifications when agents finish;
- ~~agent usage/cost reporting~~ (delivered by Epic 42);
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
