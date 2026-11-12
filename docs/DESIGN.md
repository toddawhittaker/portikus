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
of a student session without the student's consent (live help is allowed), no grading.

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
- An administrator-only listing of all workspaces (API only). There is now
  a minimal administration page at `/admin`, a plain form for the
  disconnect grace period and the per-user override; the workspaces table
  in the mockup is still Epic 11.
- Refusal states: not signed in (401), not authorized for this workspace
  (404, deliberately indistinguishable from "does not exist"), wrong role
  (403), account not in an allowed group (403 with a friendly message).

Epic 6 has since built the design system into `packages/ui`: the tokens
are the Tailwind theme and the CSS variables in `src/theme.css`, and the
primitives and overlays are exports with the names the system uses. The
three-pane shell exists in `apps/web`, with the project pane, the tabbed
work area with split terminals, the status bar, and a placeholder right
pane waiting for the file tree in Epic 7.

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
| Editor and Markdown | 8 | Monaco; autosave states `Saving…`, `Saved`, `Conflict`; Markdown Code, Rich and Split views, both sides editable |
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
quota. [Reset Docker…] [Workspace details]". Try again appears only when
starting again could succeed.

After a full stop and restart (SPEC 6.8): file tabs reopen, layout is
reconstructed, old terminals appear as ended sessions, previews come back
inactive, and nothing is replayed automatically.

Multiple windows and devices see the same workspace and stay in sync.

Every one of these states is designed, never left blank: an empty region
gets an EmptyState with the state picture, a loading region keeps its
shape with skeletons, and an error gets the error picture or a red start
border with its sentence and actions (section 11).

## 6. Constraints the design must respect

- Desktop browsers are the P0 target: current Chrome, Edge, Firefox;
  Safari is P1. Narrow displays may collapse panes.
- WCAG 2.2 AA for platform-owned controls; full keyboard navigation for
  primary controls (SPEC 25.8). Terminal and editor accessibility is
  limited by their libraries and must be documented, not papered over.
- Previews live on a separate origin, inside a sandboxed iframe, with no
  shared cookies. Always provide "open in new tab". Never a public link.
- Colour is never the only cue (SPEC 25.8). A folder's dot in the Files
  tree means "contains changes"; its hue, which follows the most important
  change below it, is a bonus, and a conflict folder also draws the alert
  shape.
- Access can be revoked at any moment; design a graceful "your access
  ended" state, including a closed WebSocket.
- Performance budgets (SPEC 25.1): shell under 2 s; workspace connectable
  under 10 s; keystroke echo under 150 ms; file changes visible under
  1 s. Skeletons and optimistic states matter more than animation.
- Privacy: the platform does not centrally record prompts, command
  history, or source. No "recent commands" or "activity feed" of that
  kind.
- The visual identity lives in `packages/ui/src/theme.css` and
  `design/system`: Public Sans for the interface and JetBrains Mono for
  terminals and code, warm ivory and charcoal surfaces, teal for actions
  and selection, violet for the coding agents, and the portico mark.
  Section 11 sets out the rules. New work uses them rather than inventing
  an alternative.

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
copies. Both artifacts were re-published with the November 2026 look on
2026-11-11, and the mockups now mount the real `packages/ui` components.
The mockup screens keep their September layouts and content, though, so
section 11 and the code win wherever a mockup differs from the product (the
chat composer, for one, is not drawn). If a screen needs a token or component the system lacks, add it to
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

## 9. Decisions taken while building Epic 6

These settle questions the design files left open. They are recorded here so
later epics do not reopen them.

**Leaving the terminal is Alt+Shift+Q.** The design handoff proposed it and it
survived checking: Chrome binds nothing to it, and in Firefox the only clash
would be with an `accesskey` attribute, of which the app uses none. So no
Portikus markup may add an `accesskey`; doing so would take the shortcut away
from the terminal. Pressing it moves focus from the terminal to the tab strip.

**Clipboard in the terminal.** xterm.js takes every key press, so the copy and
paste rules are explicit:

| Action | Result |
|---|---|
| Select text with the mouse | Copied at once, the UNIX convention |
| Right-click with a selection | Copies it and clears the selection |
| Right-click with nothing selected | Pastes |
| Ctrl+Shift+C | Copies |
| Ctrl+Shift+V | Pastes |
| Ctrl+V | Pastes |
| Ctrl+C with a selection | Copies |
| Ctrl+C with nothing selected | Reaches the shell as the interrupt |

The browser's own context menu is suppressed over the terminal screen, which
is what makes right-click usable. On macOS the Command key does the same job
as Control. Pasting depends on the browser being willing to read the
clipboard: Firefox only allows it behind its own paste prompt and older
versions refuse it altogether, so when clipboard reading is unavailable the
pane falls back to the browser's native paste event. Ctrl+V therefore works
everywhere; right-click paste in Firefox depends on the browser's prompt.

**Splitter naming.** `design/system/README.md` says `PaneHandle` wraps "the
resizable-panel library's handle". In react-resizable-panels 4 that component
is `Separator`, inside a `Group` of `Panel`s, and the styling hook it sets is
`data-separator` rather than the older `data-resize-handle-state`. The
`PaneHandle` export keeps its design-system name; only what it wraps changed.

**Checkbox is a native input.** The design system lists `Checkbox` among the
components that wrap their Radix namesake, but a native `<input
type="checkbox">` inside its label already gives the whole label as the hit
target and the browser's own keyboard behaviour, with the visible box drawn as
a sibling. That is fewer moving parts than the Radix primitive for no loss, so
`Checkbox` is the one place where the Radix rule does not apply.

**Narrow windows put the side panes in drawers, opened from a pane bar.** Desktop is the P0 target (SPEC 8.1), but the shell has no minimum width. Below 56rem, the width at which both side panes still fit at their default widths beside the work area's 360 px minimum, the work area fills the space between the header and a pane bar along the foot, and the width handles hide. The pane bar holds three buttons, each an icon over a word: **Projects** (the `list` icon), **Work** (the `terminal` icon) and **Files** (the `folder` icon). Projects and Files open the project list and the right pane, with all its tabs, as drawers between the header and the pane bar, which stay in view as the frame; Work closes whichever is open. The button for what is in view has an `accent-soft` pill behind its icon. Each drawer is a named modal dialog over a scrim, fades in, takes focus as it opens, and keeps Tab inside. Under 40rem a drawer is opaque and full width, its rows grow to 44 px and its buttons to at least 40 px, and the header grows to 56 px and shows the mark without the name. In a short window (under 30rem tall, a phone held sideways) the bar slims to 48 px and the drawers also cover the header. The rest of the shell is hidden from screen readers with `aria-hidden`, not `inert`, so its live regions, such as the chat announcer, are still heard (ADR 0047); only the shell is hidden, so the toast region beside it stays reachable. A drawer closes on Escape, its close button, a tap on the scrim, Work, following a link in it (choosing a project), opening a file, or a change of project. Focus returns to the pane-bar button that opened it; if a wider window has hidden the bar, focus goes to the pane's selected tab, or else its first control. If code moves focus to the shell behind the drawer, the drawer closes and focus stays where the code sent it. A notice or tab that asks for a right-pane surface, such as Monitor, opens the Files drawer on it. Toasts and dialogs sit above the drawers and stay reachable. The fade uses `opacity` and `--duration-base`, so reduced motion makes it instant. The pane bar replaced Projects and Files buttons in the header, which gave no one-tap way back to the work area; it costs 60 px of height, which the composer gives up on a phone. The `Shell1024` icon-rail mockup stays as a design for later.

**Table styles are CSS classes (Epic 18).** The Table rules from
`design/system/components/bundle.css` and the cell classes from
`design/mockups/portikus-screens.css` are ported into
`packages/ui/src/primitives/primitives.css` as `.pk-table-wrap`, `.pk-table`,
`.pk-num` and the `.pk-cell-*` classes, not a React component. They sit in
Tailwind's components layer so a utility can override them, which is how the
admin wraps swap `overflow: auto` for `overflow-clip` and let the sticky header
stick to the scrolling page. One rule is added to the design: a row header
(`tbody th`) looks like an ordinary cell. The sortable-header rules are left
out until something sorts.

**Where the build departs from the mockups on purpose (Epic 20).** These were
dropped or moved deliberately; do not restore them to match `design/`. The
project list shows no change count. The file tree's "Show hidden and
generated files" lives in the pane's "…" menu, not a footer checkbox. The
status bar has no save state or listening port. It does show compact
"Memory X of Y" and "Disk X of Y" meters (Epic 21), with the full storage
breakdown in the workspace dialog and a warning at 80%. The
launcher has no File… item. The header has no search and no role tag, and
there is no leave-terminal hint. In the right pane the tab names the pane,
so no visible title row repeats it. The Preview frame width is a set of
checkable items in the More menu rather than radio items, and "Reset
preview data" has no ellipsis because it opens no confirmation.

**Help inside the product (Epic 25).** Two new components carry
explanations: `PageIntro`, a remembered, closable note under a page heading
with a "More in Help" link, and `Toggletip`, a click-to-open help button
beside a label, header or heading. Their placement rules are in
`design/system/README.md`, "Help in the product". `Toggletip` wraps Radix
Popover; a native popover was rejected because Firefox lacks anchor
positioning, and a Tooltip because it opens on hover only. The panel never
takes focus, so Tab moves on and closes it; a polite live region beside the
button reads the text to screen readers. The account menu
has a Help item that opens, in a new tab, `/admin/help` from an admin
page and `/help` everywhere else. `/help`, "Using your workspace", shows the
part for students to everyone and the instructor part to instructors,
administrators and anyone who teaches a course. `/admin/help`, "For
administrators", holds only the administrator part and sits beside the admin
rail, with no page marked current; only administrators reach it. Each page
links to the other. The split is presentation only; the text holds nothing
secret.

**Native select in dense filter bars (Epic 25).** The Users filters and the
Logs time filter keep the native `select`; everywhere else uses `Select`.
Dialogs take the density of what opened them, so a dialog opened from the
compact admin page is compact.

**Admin page order.** The admin pages are listed in a left rail in five
groups, each under a small overline label: People (Users), Activity (Health,
Logs, Audit, Agent usage), Server (Network, Backups, Image, Certificate,
Docker), Site (Sign-in, Address, Settings) and Shell (Root shell, only where
the server offers it). The addresses are still `/admin/<page>`. On a phone
the rail folds into one control that names the open page.

## 10. Which Monaco features are on

Pilot feedback asked for the stock editor rather than a stripped-down one
(SPEC 13.1, 13.2). These are on for both the file editor and the diff viewer:

| Feature | Keys | Why |
|---|---|---|
| Find and replace | Ctrl+F, Ctrl+H, F3 and Shift+F3, Enter | Monaco handles the keys itself, so the browser's own find never opens |
| Overview ruler | — | The whole file's changes and problems at a glance, in the scrollbar |
| Code folding | Click the gutter arrow, Ctrl+Shift+[ and Ctrl+Shift+] | Long files stay navigable |
| Bracket pair colouring and bracket match | — | Reading aid, no configuration |
| Command palette | F1 | Reaches every editor action without more shortcuts |
| Multiple cursors | Ctrl+D, Alt+click | Standard editing, nothing Portikus binds |

These stay off: the TypeScript, CSS and HTML language services, because their
diagnostics do not know the project's configuration (SPEC 13.2), and Monaco's
own Ctrl+wheel zoom, because Portikus zooms one editor at a time instead.

**No minimap; the scrollbar carries the overview.** The minimap is off. In
its place the editor has a clean scrollbar with an overview ruler: coloured
ticks for Git added, modified and deleted lines (the `git-*` colours),
warnings and errors (the status colours) and find matches (the accent),
on a transparent ground with no border. It gives the same whole-file
overview in a few pixels instead of a second, unreadable copy of the code.

**Editor zoom is per editor and per session.** Ctrl with the mouse wheel over
the editor, Ctrl+Shift+Plus and Ctrl+Shift+Minus step it by ten percentage
points, Ctrl+0 returns to 100%, and a thin bar under the editor shows the
percentage with minus, plus and Reset. It changes the editor font only, never
the browser's page zoom, and nothing is saved: every file opens at 100%.

**Language is guessed from the first line when the name says nothing.** A file
such as `.git/hooks/pre-applypatch.sample` is highlighted as shell because of
its `#!/bin/sh` line. The table covers shebangs for sh, bash, zsh, Python,
Node, Perl and Ruby, an XML or HTML opening, a JSON object or array, and the
file names `Makefile` and `Dockerfile`. Nothing recognised means plain text.

## 11. The look

The November 2026 refresh gave the product a warmer, clearer look. The
values live in `packages/ui/src/theme.css`; `design/system/README.md`
gives the full rules and `design/system/tokens.json` lists every token
with its use. This section is the summary engineering works from.

**Surfaces.** There are three steps, so the work reads first. The chrome
(header, side panes, pane heads, tab strips, status bar) is `surface`, a
warm ivory in the light theme and a warm charcoal in the dark. The work
area (editor, terminal, chat) is `surface-work`: one step lighter in the
light theme, and in the dark the darkest step, so the canvas sits below
the chrome as it does in a code editor. Cards, dialogs, menus, inputs and
the composer are `surface-raised`, white in light and the lightest step in
dark. A well inside a surface (a code block, a table header) is
`surface-sunken`. Panes are divided by 1 px lines, never shadows. Every pane head is the height
of the tab strips, so the line under them meets across the shell.

**Colour roles.** Colour carries meaning, never decoration.

| Colour | Token | Means |
|---|---|---|
| Teal | `accent` | Something you can act on, or what is selected: the primary button, Send, the selected tab's bar, the selected project row, progress |
| Violet | `agent` | A coding agent: agent tab icons, the turning working ring, menu items that start an agent, Claude's byline, the composer's options summary, plan meters |
| Amber | `status-warning` | Waiting on you: an agent that needs input, a permission or question card, a limit near 80% |
| Red | `status-error` | Something failed: a workspace or chat error, a failed check |
| Green | `status-running` | Running or passed |
| Blue | `status-starting` | In progress (a workspace changing state) and information callouts |
| Magenta | `git-conflict` | A Git conflict, which must look like nothing else |

Teal and violet are kept apart on purpose: a student can tell at a glance
whether something is theirs to do or an agent's doing. Text and status
colours meet 4.5:1, and control borders 3:1, on the chrome, work and
raised surfaces in both themes (SPEC 25.8). Muted and faint text sit close
to the body ink in both themes, so secondary text stays easy to read.

**Type.** Public Sans for the interface, JetBrains Mono for code. The
interface uses five sizes: 12 px for metadata, badges and the status bar;
14 px for the body (rows, tabs, labels, buttons, menus); 16 px for pane
titles, the project name in the header, section headings and chat prose;
20 px for dialog titles; 24 px for page titles. Code set inside the
interface (chat code, shell boxes) is 13 px; the editor and terminal start
at 14 px. Weight 600 is for titles, selected names and badges. Paths and
folder names in the chrome use the interface face, so the chrome never
reads as code.

**Admin pages.** Every admin page uses one frame. The left rail lists the
pages (section 9); it stays in view while the page scrolls, and Health
shows a count pill there when something needs attention. The page itself
reads top to bottom: a quiet eyebrow (the portico glyph and the word
Administration), the page title, an attention summary when something needs
a look, the work surface (a table, chart or form), and, where a row can be
opened, a side inspector beside it. The status bar students see runs along
the foot of every admin page, showing the site, the host's vitals and one
state that leads to Health. There are three type levels: the page title at
28 px, a section title at 18 px, and an overline (11 px, spaced capitals,
muted) that names a group, a tile or a column. Under the title, one sentence
says what the page is for; the rest of the "About …" text and "More in
Help" sit in a disclosure that starts closed. Explanatory text is capped
near 65 to 70 characters a line. Admin controls are compact (32 px, 13 px
text) but otherwise the student set: one radius, the `line-strong` edge,
one focus ring; on a phone, checkboxes are 20 px and preset and segment
targets 44 px. Native selects drop the browser arrow for a caret in the
muted ink, and native boxes tick in the accent. Disclosures use the chevron
that turns when open, never the browser's triangle.

**The inspector.** Choosing a person on Users opens their inspector beside
the table, with the selected row in the student selected-row look. It has
three tabs: Overview (errors first, then storage and limits, the guard, the
image, Restore from backup and Rebuild), Activity (processes, ports, the
agent log and recent audit events) and Account (the account, linked course
accounts, and the actions that disable or delete). Overview carries an
attention mark when the workspace has a problem. Every tab stays mounted, so
an edit survives a tab switch.

**Status on admin pages.** A normal state is a small dot and a word in the
muted ink ("Running", "Stopped"); a badge is kept for an exception, such as
an error, a throttled workspace or a waiting invitation, so badges stand out
because they are rare. A count of errors that is zero is drawn neutral,
never red. A page shows one attention count, not the same number twice.

**Admin tables.** Tables are reading surfaces: hairline rules between rows,
headers in the overline style, and tabular figures for numeric columns only,
so names and words keep their normal spacing. Actions a row rarely needs
(Delete set… on Backups, Remove from course on the Course page) sit in a
menu at the row's end, leaving at most one visible row action.

**One primary button per page.** Each page has at most one filled button,
for the action the page is for. On Users that is Add user…, with Invite… and
Import from CSV… in a More menu beside it (where the site has no Portikus
passwords, Invite… is the primary and Import sits beside it). On Backups,
Back up now is outlined while the restore key is still missing.

**Logs and Audit are workbenches.** Each has one filter bar at the top, the
results as readable rows below it, and a side inspector for the chosen row.
Logs rows lead with the message in plain words, with the method and route
beneath; level chips use their own colour, and each chip shows a check icon
when it is on and is plain when off, so the state never rests on colour.
The service log level sits under the results beside Auto refresh. Audit
lines up its event codes in one column.

**Other admin pages.** Health reads as an incident briefing: attention rows
that link into Users, Logs and Audit, one strip of host vitals, failures
beside a state bar, and short platform facts. Agent usage opens with a
summary and a daily chart. Backups leads with recovery readiness and a
strip of the last 14 nights. Settings has a section index that stays in
view, shows each value with its default on one line and Last changed in the
title row, puts longer explanations in disclosures, and previews the guard
rules in plain words. Network hosts are cards. An empty state uses the
portico picture (`StateArt`) in its quiet form.

**The instructor course page.** It uses the admin frame and type levels. At
the top, Class now sums up the students in one sentence ("24 students · 3
waiting for help") over a row of dots, one per student, sorted so who needs
the instructor comes first: green running, amber waiting for help, red
failed, a hollow ring stopped. A small legend names the dot colours; the
dots themselves are decorative because the sentence says the same. The
live help queue sits beside Class now. Below, Members lists the people,
with Remove from course in each student's row menu, and the course
settings. A live help session opens in a terminal frame drawn like the
student workspace, with one back link where the eyebrow sits, and the
shared project page works the same way.

**Buttons.** A primary button is the accent fill; a secondary one is the
raised face with a `line-strong` edge. A destructive action that sits
beside quieter ones in a row, such as a snapshot's Delete…, is the
danger-secondary button: danger text and edge on the raised face. The
filled primary uses its own `accent-fill` token, which in the dark theme is
a deeper teal than `accent`, so its white label stays well over 4.5:1 while
the brighter `accent` marks checks, dots and selection. A filled danger
button is white on solid red (`danger-fill`) in both themes. A button that
cannot act keeps its own look, faded, with its label still readable, so it
reads as the same button at rest rather than a broken one.

**Meters.** Every bar of figures uses one meter: a filled track
(`meter-track`) with no edge and its figure beside it in text. In the
status bar and the chat composer it is the slim meter, a 56 px rounded
track. Memory and Disk fill with the accent, the plan meters and the
composer's context with the agent violet; past a warning mark the fill
turns amber with the alert icon, and at the critical mark red. The
composer's context meter is always shown ("34.2k / 1M") and its look steps
at 25% (ink text), 50% (agent tint), 75% (warning look, alert icon and
"nearly full") and 90% (error look). Monitor's process rows are 26 px with
24 px buttons, and a CPU or memory figure turns amber and bold from 50% and
red and bold from 80%, with the state also in words for screen readers.

**Spacing and shape.** A 4 px scale; components never set their own outer
margin. Corners are small: 4 px for controls and badges, 6 px for cards
and menus, 8 px for dialogs, square for tabs, panes, terminals and the
editor.

**Badges.** Every status is one `Badge` (22 px tall, 12 px semibold, 4 px
corners) in one of seven tones: success, warning, danger, info, neutral,
accent, agent. Workspace states, check results and the
needs-input tag all use it, except that admin and course pages draw a
normal state as a dot and a word and keep the badge for exceptions. A new status picks a tone rather than a new
pill, and always carries a word or letter, never colour alone. Git marks are
not badges: each is a 12 px semibold letter in the kind's colour (M amber,
U and A green, D red, R blue, and a conflict magenta with the alert icon),
A file-type icon is a distinct glyph per family, and a source file is a page stamped with a short language tag (py, js, ts, and so on). Every file and folder icon is lightly tinted by family or language, at least 3:1 on every row background; magenta is never a tint. Secrets (.env, .pem, .key) get a key glyph with the strongest tint.

**Cards and elevation.** A card resting in the flow of the work area (the
composer, a chat's step groups and shell boxes, check output) has a 1 px
line and the small shadow. A card that asks for attention or floats has
the medium shadow: permission and question cards (a terminal's question card floats over the
bottom of the pane without resizing it), which also carry a 4 px
amber start border, the workspace starting card, menus, popovers and
toasts. Dialogs have the large shadow. Errors in the chat and on the
workspace card have a 4 px red start border.

**Selection.** One selected look per kind of thing. A tab in the work area
takes the work area's ground as its face (in the right
pane the raised face), with full-ink text and a 2 px teal bar along its
foot; its icon turns teal, or stays violet for an agent. A row in
the project list, agent rows included, has a soft teal fill, a 2 px teal
bar at its start and its name in teal text, and so does the current
option of the composer's `/` and `@` list, which draws no ring of its own
because the message box holds the focus; an agent's state stays on its
mark and its state line, never on the row's fill. A row in a right-pane list has a neutral tonal fill and a 2 px ink
bar, so it never reads as a passed check or an added file. An agent's
state shows only in its tab's mark (a turning violet ring, an amber
triangle, a check), so the selected tab always looks the same.

**Pane focus ring.** In a split, the one pane that holds the keyboard (a
terminal, a chat or a file) is outlined by a 2 px ring drawn above its
contents and the splitters, so all four edges read evenly at any zoom. It
takes the colour of the pane's own scheme; a chat uses the page's focus
colour. A pane alone in its tab, and the side panes, have none.

**The subagent card.** A subagent's conversation opens as a bordered card
(`line-strong` edge, `radius-md`, `shadow-lg`) floating over the chat's log,
inset by `clamp(1rem, 4cqi, 2rem)` on every side so the pane's focus ring
stays whole, at most 48rem wide and centred. The log behind it is dimmed by
the `--scrim` token at 60% and is inert; the composer below stays usable.

**The right pane's tabs.** Files, Checks, Running, Monitor and Problems
show an icon and a name when the pane is wide, the names alone at desktop
width, and only the chosen name when the pane is under 22rem, the others
named by icon, tooltip and accessible name. On a window 1360 px or wider
the side panes start at 264 and 360 px; narrower, at 240 and 280 px.

**The composer.** Its bottom row holds only attach, the Chat options
summary, the microphone, Stop and Send. The summary (for example "Opus ·
Extra high · Plan") opens the Chat options panel with the model, version,
effort and permission fields, each a small muted label over its value on one wrapping line, and the
Read replies aloud switch in the panel's heading row. A value other than the starting one is
bold, and Bypass permissions shows the warning colour and icon on the
summary too. Send is the accent circle while there is something to send,
and a flat sunken circle while the box is empty, a file is still saving or a send is under way.
Stop, beside it while a turn runs, is a circle with an ink ring and a
solid ink square, so it holds its own against the filled Send.

**States and the state picture.** Empty, starting and error states share
one small picture, `StateArt`: the portico of the mark on a soft round
backdrop, with a violet prompt and a gold cursor in its doorway and the
state's icon in a badge at its corner. The error version is tinted red;
while something is under way the cursor blinks, except under reduced
motion. It is decorative, and the heading beside it says what it means. It
is the only illustration in the product; there are still no mascots or
encouragement. A loading region keeps its shape: a starting workspace shows
skeleton rows in the side panes and skeleton tabs, and a file that is
opening shows placeholder lines with its save state and language hidden.

**The mark.** A rounded teal tile holding an ivory portico (pediment,
lintel, two columns, a step) with a gold prompt and cursor in its doorway.
It is drawn by `NameMark` from the brand tokens, which read the same on
every surface; the SVG files in `design/system/assets/Logos` are for places
that cannot run React.

**Phone layout.** Below 56rem a pane bar with Projects, Work and Files runs
along the foot, and the side panes open as drawers between the header and
the bar (section 9).

**Code colours.** The editor's syntax colours come from the chrome's own
hues, distinct from one another and without violet, which means an agent:
terracotta keywords and tags, sage strings, teal numbers and constants,
amber types and attributes, blue for SQL built-ins, and faint italic comments, each at 4.5:1 or better on
the editor ground and the current-line highlight. The editor ground is the
work surface. There is no minimap; the scrollbar's overview ruler shows
Git changes, warnings, errors and find matches as coloured ticks (section 10). Terminals have
a dark scheme (the default, the dark work ground) and a light one, chosen per
terminal and independent of the page theme; every ANSI colour meets 4.5:1
on its own background.
