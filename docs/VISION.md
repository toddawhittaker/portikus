# Portikus

## Vision for a Browser-Based Agentic Development Workspace

**Status:** Draft vision  
**Audience:** Humans and software-development agents  
**Primary initial audience:** Non-technical and early-stage technical students learning agentic software development  
**Secondary audience:** Developers who want a browser-accessible remote agentic development environment

## Purpose

Portikus will provide a browser-based software-development workspace in which a user can work with coding agents such as Claude Code and Codex without first learning how to configure a local development machine.

The system should remove setup friction without replacing the actual tools and practices used in software development. Students should work in a real Linux environment with real files, Git, Docker, package managers, terminals, development servers, and coding agents. The platform should simplify access to those tools, not substitute educational imitations for them.

The central design principle is:

> **Simplify access to the development environment without simplifying the development environment itself.**

A student should be able to sign in from an ordinary web browser, choose a project, ask a coding agent to build or modify software, inspect the files it changes, run the application, view it in the browser, and use Git/GitHub to preserve and share the work.

## Why Portikus

**Portikus** is the German form of *portico*: an architectural entrance or covered passage that creates a threshold between spaces. The name fits the role of the system. Portikus is the controlled entrance into a full development environment—users approach it through an ordinary web browser and pass through into a Linux workspace containing real development tools, projects, agents, terminals, containers, and running applications.

The name also carries useful technical echoes without depending on them. A browser is a portal into the workspace; development applications are reached through authenticated ports; and the platform stands at the boundary between a simple user experience and a substantially more capable environment behind it. Those associations should remain secondary to the central architectural metaphor: **Portikus is an entryway, not the destination itself.** The software being built, the tools being used, and the learning taking place remain on the other side of that threshold.

That metaphor reinforces an important product choice. Portikus should not turn software development into a simulated or simplified exercise. It should make the entrance easier while preserving the authentic environment beyond it.

## The problem

Modern coding agents make it possible for people with limited programming experience to create useful software, but the surrounding development environment remains a significant barrier.

A learner may still need to understand or install:

- a terminal and shell;
- Git and GitHub authentication;
- language runtimes such as Python and Node.js;
- package managers;
- compilers and build tools;
- Docker and Docker Compose;
- editors and IDEs;
- local port forwarding;
- environment variables;
- API credentials;
- operating-system dependencies; and
- coding-agent command-line tools.

These are legitimate parts of software development, and students should encounter many of them. They should not, however, have to spend the first part of a course debugging Windows PATH variables, Docker Desktop, WSL, local firewall rules, conflicting language versions, or laptop-specific configuration before they can learn how to direct an agent.

Portikus provides a consistent remote development environment while leaving the development model itself intact.

## Product concept

Each user receives one Linux **workspace**. A workspace contains multiple **projects**, stored under:

```text
~/projects/<project-slug>
```

The browser is the user's window into that workspace.

The primary interface has three regions:

```text
┌──────────────┬────────────────────────────────────────┬──────────────────┐
│ Projects     │ Work area                              │ Project files    │
│              │                                        │                  │
│ my-app       │ Terminal | README.md | Preview         │ ▾ my-app         │
│ analysis     │ ┌────────────────────────────────────┐ │ ├─ src/          │
│ demo         │ │ $ claude                          │ │ ├─ .env       M  │
│              │ │                                    │ │ ├─ README.md  M  │
│ + Project    │ │ > Add authentication to the app...│ │ └─ app.py     ?  │
│              │ └────────────────────────────────────┘ │                  │
└──────────────┴────────────────────────────────────────┴──────────────────┘
```

The left pane selects projects. The center pane contains tabbed work surfaces such as terminals, files, Markdown previews, and running application previews. The right pane is a live file tree with Git state.

A user may open several terminals, split them horizontally or vertically, move them, and reconnect from another browser or device. Changes made by a coding agent, shell command, second browser, or file editor should appear throughout the interface quickly.

## The workspace mental model

For students, the workspace should feel like a remote computer rather than a collection of disconnected cloud services:

> **My workspace is my computer. My projects are folders. My coding agents work inside those folders.**

This mental model should remain true even though the implementation uses Linux containers, persistent volumes, reverse proxies, and a web control plane.

The student should not need to understand the underlying infrastructure in order to use it.

## Student execution model

Student workspaces have **persistent data and interface state but ephemeral process state**.

The following survive between sessions:

- projects and files;
- Git repositories and configuration;
- user configuration and dotfiles;
- coding-agent configuration that is intended to persist;
- inner Docker images, containers, and volumes;
- project metadata;
- recovery points;
- saved browser layout;
- open-file metadata;
- terminal names and last working directories; and
- preview definitions.

Running processes are different.

When the last authenticated browser connection to a student workspace disappears, the platform starts a 10-minute grace period. If the student reconnects during that period, the workspace continues unchanged. If no browser reconnects, the platform gracefully stops the workspace.

After a full stop:

- terminal processes are gone;
- coding-agent processes are gone;
- development servers are gone;
- inner containers are no longer assumed to be running; and
- RAM and CPU resources return to the host.

When the student returns, the same filesystem and saved interface are restored, but execution must be restarted.

This is intentional. The platform does not attempt to hibernate a complex Linux process tree.

## Developer experience

The core platform should also be useful to a professional developer working with coding agents. The student experience should therefore be implemented as a **profile or capability layer over the same system**, not as a separate educational toy.

A future developer profile may:

- allow longer-lived or manually controlled workspaces;
- expose more infrastructure controls;
- show richer resource information;
- support persistent unattended agent work;
- expose advanced Git and Docker capabilities; and
- relax some student-oriented UI simplifications.

The core runtime, project model, terminal implementation, file system, preview system, and agent integrations should be shared.

## Technology direction

The initial architecture is expected to use:

```text
Pop!_OS host
    ↓
KVM/libvirt
    ↓
Debian VM
    ↓
Incus
    ↓
unprivileged LXC system container per user
    ↓
Docker inside the user's LXC container
```

The initial host does not use ZFS.

For the pilot, the Debian VM should use a separate virtual data disk for Incus storage. LVM thin provisioning is the preferred Incus storage backend so that workspace instances and snapshots can use efficient copy-on-write behavior without requiring ZFS inside the VM.

The technology stack is a means to the product goals, not part of the user-facing model. Infrastructure-specific assumptions should be isolated behind clear service interfaces wherever practical.

## Infrastructure philosophy

Infrastructure is cattle, not pets.

The pilot VM, Incus configuration, networks, storage pools, workspace images, system services, and application deployment must be reproducible from source-controlled automation.

A failed VM should be rebuildable without reconstructing its configuration manually.

Human operators may use diagnostic commands and emergency access, but routine configuration should not depend on undocumented manual changes.

Persistent user data is not cattle. It must be deliberately separated from replaceable infrastructure and backed up according to policy.

## Pedagogical intent

Portikus is specifically designed to teach **agentic software development**, not merely prompt writing.

Students should learn that software development with an agent still involves:

- describing goals and constraints;
- reading and questioning plans;
- examining artifacts;
- running and interpreting tests;
- observing applications;
- managing environment variables;
- using Git and GitHub;
- understanding containers at a useful level;
- diagnosing failures;
- asking an agent to revise its work;
- deciding when work is acceptable; and
- taking ownership of the resulting software.

The platform should remove incidental machine-setup friction while preserving these practices.

## Design principles

### Use authentic tools

Use real Git, real GitHub, real Docker, real shells, and actual coding-agent CLIs wherever possible.

Do not build simplified substitutes merely because the first users are students.

### Prefer understandable abstractions

The platform may hide infrastructure mechanics, but its concepts should map cleanly to the underlying environment.

A project is a directory. A terminal is a terminal. A file is a file. A preview is a running TCP service. A Git status marker represents actual Git status.

### Make recovery easy

Agentic development can change a large number of files quickly. The system should provide automatic recovery points that do not alter Git history or working-tree state.

Students should be able to recover from mistakes without the platform secretly committing code for them.

### Keep security boundaries outside student control

Students receive broad control **inside** their own workspace, including `sudo` and nested Docker.

They do not receive control over:

- the Debian VM;
- Incus;
- other users' workspaces;
- host filesystems;
- host container sockets;
- management networks; or
- unauthenticated Internet-facing application ports.

### Never expose student applications directly to the Internet

Application previews must pass through an authenticated reverse proxy.

There must be no user option that creates an unauthenticated public endpoint for a student process.

Preview applications should run on a separate browser origin from the trusted workspace application.

### Keep process persistence simple

Do not make CRIU, VM hibernation, or container checkpoint/restore a core dependency.

For student workspaces, shut down cleanly after the disconnect grace period and reconstruct the user interface at the next session.

### Let agents use the same environment the human sees

The coding agent, terminal, file browser, editor, Git status display, and application preview should all operate on the same project files.

There should not be a hidden agent workspace separate from the student's workspace.

### Make state changes visible

When an agent creates, modifies, renames, or deletes files, the file tree and open editors should update.

When Git state changes, the interface should update.

When a service begins listening on a port, the platform should be able to surface it.

When a workspace approaches a quota, the student should see understandable guidance.

## Initial product scope

The first Portikus student pilot should support:

- single sign-on;
- one workspace per user;
- workspace automatic start and stop;
- multiple projects per workspace;
- project creation from blank, Git clone, or template;
- terminal tabs and splits;
- Claude Code and Codex launchers plus ordinary terminal access;
- a live project file tree;
- Git status decorations;
- file upload and download;
- Monaco-based text editing;
- Markdown editing and preview;
- authenticated application preview tabs;
- external opening of authenticated previews;
- persisted interface layout;
- automatic recovery points;
- basic quotas and resource reporting;
- reset/recovery operations;
- basic administration; and
- infrastructure that can be recreated from scripts.

## Explicit non-goals for the first pilot

The first pilot does not need:

- process persistence after the 10-minute disconnect shutdown;
- VM-per-student isolation;
- public student application hosting;
- a full replacement for VS Code;
- a graphical Git client;
- hidden automatic Git commits;
- real-time collaborative editing between different students;
- instructor takeover of a student's workspace;
- full LTI course workflows;
- grading features;
- permanent student environments across semesters;
- high-availability infrastructure;
- transparent live migration;
- CRIU-based container hibernation;
- Kubernetes; or
- a general-purpose cloud development platform.

The architecture should leave room for selected future capabilities without compromising the simplicity of the pilot.

## Success

Portikus succeeds when a student with little or no local development setup can:

1. sign in with institutional credentials;
2. open or create a project;
3. start a coding agent;
4. describe software they want to build;
5. watch and inspect the files change;
6. run the resulting software;
7. open it in a browser preview;
8. use the agent and terminal to diagnose and revise it;
9. commit and push the project to GitHub; and
10. return later and continue from the same saved files without needing the same computer.

The strongest test is simple: the environment should be powerful enough that an experienced developer would also want to use it, while being understandable enough that a non-technical learner can begin productive work without first becoming a workstation administrator.
