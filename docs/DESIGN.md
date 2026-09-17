# Portikus design

What the Portikus user interface is meant to be, and where the design
files that define it live. Sources: docs/VISION.md, docs/SPEC.md (section
numbers cited), docs/STACK.md section 3, and the Epic 4 code. Nothing here overrides
those documents; when in doubt, VISION.md wins on intent and SPEC.md on
detail.

## 1. What Portikus is

Portikus is a browser-based development workspace for students learning
agentic software development. A student signs in, gets one Linux
workspace with real tools (shell, Git, Docker, Claude Code, Codex), and
works entirely in the browser. Nothing is installed on the student's own
machine.

The name is German for portico: a covered entrance between spaces. The
guiding line for the visual identity is "Portikus is an entryway, not the
destination itself." The product should feel like a calm, well-built
threshold into a real workshop, not like a toy or a themed learning game.

Principle that shapes every screen: "Simplify access to the development
environment without simplifying the development environment itself." A
project is a directory. A terminal is a terminal. A preview is a running
service. The UI must never hide those facts or invent a parallel model.

Mental model to reinforce: "My workspace is my computer. My projects are
folders. My coding agents work inside those folders."

Explicit non-goals: not a VS Code clone, no graphical Git client, no
hidden auto-commits, no real-time collaboration, no instructor takeover
of a student session, no grading.

## 2. Who uses it

| Role | Status | What they need |
|---|---|---|
| Student | P0 | One workspace; projects; terminals; files; changes; previews; recovery points; clear lifecycle and error states |
| Administrator | P0 | Users and workspaces list; lifecycle actions; quotas; audit events; revoke access; disable or archive a workspace |
| Instructor, developer, support | P2 | Not designed now. Leave room for role-conditional density and a role switch. A "developer" is a student with fewer guardrails, not a separate app |

Roles come from the identity provider's group claims. Someone who
authenticates but is in no allowed group is refused with a plain
message. There is no self-service sign-up.

## 3. What exists after Epic 4 (the starting point)

Built and working:

- Sign-in through OIDC (a mock provider in development, the institution's
  provider later). Sign-in is a full-page redirect, not a modal.
- A signed-in state with display name and role, a sign-out action.
- One workspace per student, created on first visit, shown live over a
  WebSocket: state, desired state, active connection count.
- An administrator-only listing of all workspaces (API only; no admin UI).
- Refusal states: not signed in (401), not authorized for this workspace
  (404, deliberately indistinguishable from "does not exist"), wrong role
  (403), account not in an allowed group (403 with a friendly message).

The current web app is a placeholder: a heading, a sign-in link, a
signed-in line, a sign-out button, and a one-line workspace panel. The visual
design is now settled and lives in `design/system`; none of it has been
built into the web app yet.

Front-end stack the designs will be built with (STACK.md section 3):
React 19, Vite, TanStack Router, TanStack Query for server state,
Zustand for ephemeral layout state, Tailwind CSS, Radix UI primitives
(dialogs, menus, tabs, popovers are never hand-built), Monaco for the
editor and diffs, xterm.js for terminals, dnd-kit for tab and pane
rearrangement, and a mature resizable-panel library for splitters. The
shared component library lives in `packages/ui` and is empty today, so
the design system can be defined from scratch there.

## 4. Screens to design, in build order

Epics are SPEC.md section 29. Design the shell and the first two rows
first; the rest can be wireframes.

| Screen | Epic | Notes |
|---|---|---|
| Sign-in page | 4 | One action. Must also show "you are signed in with the institution but not authorized for Portikus" and "your session ended" |
| Workspace status / starting | 5, 6 | Connecting, starting, running, stopping, stopped, error, and the "shutting down in N minutes unless you reconnect" countdown (SPEC 6.4) |
| Application shell | 6 | Three panes (SPEC 8.1): left project navigation, centre tabbed work area, right file tree. Desktop first; panes may collapse on narrow displays |
| Terminal tabs | 6, 8 | xterm.js; multiple tabs; horizontal and vertical splits; rename; close; "ended session" state after a stop with a "new terminal" action. Launchers: `+ Terminal`, `+ Claude Code`, `+ Codex`, `+ File`, `+ Preview` (SPEC 10.2) |
| Project navigation | 7 | Active projects, archived entry point, create (new, clone, template), rename, duplicate, download, archive. No permanent delete for students |
| File tree | 8 | Create, rename, move, delete with confirmation, upload and drag-drop, download; generated folders hidden behind "Show hidden and generated files"; live updates from agents and other windows |
| Editor and Markdown | 8 | Monaco; autosave states `Saving…`, `Saved`, `Conflict`; Markdown edit, preview, side-by-side |
| Changes and diff | 9 | Status decorations; a project "Changes" list (`M src/app.ts`); Monaco diff; a compact status like `main • 3 changes • 2 commits ahead`; conflict state must look nothing like an ordinary change; "Review session changes" with the baseline label `Changes since Claude session started` |
| Search | 8 | Project-wide, results as path, line, matching text, click to open at line |
| Preview | 10 | Pick a port; embedded (sandboxed iframe) or open in a new tab; inactive copy: "Nothing is currently listening on port 3000. Start your application to reconnect this preview." No share link, ever |
| Running services | 10 | Rows like `3000 node Preview`, `5432 postgres Docker`, with "Open preview"; stale saved previews clearly marked |
| Workspace status panel | 10 | State, storage per class ("Projects & home", "Docker", "Recovery") with warnings near 80 percent, CPU and memory, Docker health, agent sign-in status, preview ports, recent checks |
| Checks | 10 | Configured commands with running, pass, fail, and terminal-style output |
| Recovery points | 9 | Timeline, create, restore with "this replaces current files" warning; Reset Docker and Rebuild workspace flows with clear "what survives" copy (SPEC 17.3) |
| Admin: users and workspaces | 11 | Table with state, last activity, actions (start, stop, restart, rebuild, reset Docker, disable, archive, revoke access), quotas, image version, recent audit events. Break-glass is exceptional and audited, not a normal button |
| Admin: audit and health | 11 | Recent lifecycle and auth events, basic logs and metrics |

## 5. States and copy rules

Workspace `state` is one of provisioning, starting, running, stopping,
stopped, error. `desiredState` is running, stopped, or restarting. When
they differ, a transition is in progress; show it as motion, not as an
error. `shutdownDeadline` is a timestamp for the disconnect countdown.
`errorCode` and `errorMessage` exist; students see a user-language
sentence first, administrators can expand the technical detail.

Error copy pattern (SPEC 28): user terms first, implementation second,
then actions. Example: "Your workspace could not start because its
storage allocation is full. Docker is using 19.8 GB of your 20 GB Docker
quota. [Clean up Docker] [View details]".

After a full stop and restart (SPEC 6.8): file tabs reopen, layout is
reconstructed, old terminals appear as ended sessions, previews come back
inactive, and nothing is replayed automatically.

Multiple windows and devices see the same workspace and stay in sync.

## 6. Constraints the design must respect

- Desktop browsers are the P0 target: current Chrome, Edge, Firefox;
  Safari is P1. Narrow displays may collapse panes.
- WCAG 2.2 AA for platform-owned controls; full keyboard navigation for
  primary controls (SPEC 25.8). Terminal and editor accessibility is
  limited by their libraries and must be documented, not papered over.
- Previews live on a separate origin, inside a sandboxed iframe, with no
  shared cookies. Always provide "open in new tab". Never a public link.
- Access can be revoked at any moment; design a graceful "your access
  ended" state, including a closed WebSocket.
- Performance budgets (SPEC 25.1): shell under 2 s; workspace connectable
  under 10 s; keystroke echo under 150 ms; file changes visible under
  1 s. Skeletons and optimistic states matter more than animation.
- Privacy: the platform does not centrally record prompts, command
  history, or source. No "recent commands" or "activity feed" of that
  kind.
- The visual identity now exists in `design/system`: Public Sans for the
  interface and JetBrains Mono for terminals and code, a warm neutral
  palette with a verdigris accent, and the portico mark. New work uses it
  rather than inventing an alternative.

## 7. Where the design lives

- `design/system/` is the design system: the written rules in its
  `README.md`, the tokens, roughly a dozen components with previews, the
  two variable fonts, and the logo files.
- `design/mockups/` is nineteen screen mockups in light and dark, with a
  few 1024-wide collapsed variants, plus the CSS the screens propose.
- The handoff notes at the end of `design/README.md` say which components
  the screens mount from the system and which new ones they propose for
  `packages/ui`. They also propose a `terminal-line` token and an
  Alt+Shift+Q shortcut for leaving the terminal, which still needs
  checking against browser and shell bindings.

`design/README.md` names the source artifacts and says how to refresh the
copies. If a screen needs a token or component the system lacks, add it to
the system first and then use it.

## 8. Hooking the designs back into engineering

- The tokens become the Tailwind theme in `apps/web`, following the
  "Mapping to Tailwind and Radix" section of `design/system/README.md`.
- Each component in the system becomes an export of `packages/ui` with
  the same name, so later epics build on the design rather than
  reinterpreting it.
- Epic 6 does both of those before it builds any screen.
- Use the design sync skill in the sessions that build Epics 6 to 11 so
  each screen is generated against these design files.
