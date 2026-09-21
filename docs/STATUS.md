# Status: what has landed

The running history of what each epic and task delivered, and the known
gaps each one left. Newest work is at the bottom. Epic order and
acceptance criteria are in `docs/SPEC.md` section 29; the decision
records are under `docs/adr/`. Update this file in the same pull request
that lands the work it describes.

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
means installing the previous package. Epic 4 is authentication and
authorization: login is the OIDC Authorization Code flow with PKCE (proof
key for code exchange) through `openid-client`, and a session is a row in
PostgreSQL behind an opaque HttpOnly cookie, named with the `__Host-`
prefix when the public URL is https. Roles are `student` and
`administrator`, mapped from the identity provider's group claims and
denied by default. Every API route and the WebSocket upgrade need a
session, the workspace owner comes from that session rather than the
request body, and one student asking for another student's workspace gets
a 404. The WebSocket at `/workspaces/:id/ws` is now the presence
mechanism, so the old HTTP connection and heartbeat routes are gone, and
administrators get one listing route. `packages/auth` also holds an
in-repo mock identity provider, shipped as a fourth systemd unit that stays
disabled unless Ansible's `portikus_mock_idp` is true (ADR 0008). A new
`caddy` Ansible role fronts the VM with an internally issued certificate at
`portikus.<vm-ip>.nip.io` and serves the web bundle, which the Debian
package now ships, and the smoke test logs in through the real redirect
flow.

Epic 5 is the workspace agent and terminal transport (ADR 0009).
`apps/workspace-agent` is a Fastify service using `node-pty` and tmux that
runs as the unprivileged `student` user inside each container and listens
on TCP 7400 on the workspace bridge. Each terminal is one tmux session,
`pk-<terminalId>`, and every attachment is its own PTY running `tmux
attach-session`, so tmux and not the browser socket owns the shell. The
agent authenticates a per-workspace bearer token that the worker mints on
every start and the controller pushes to `/etc/portikus/agent.token`
through the Incus files API; `start` then polls the agent's `/health` and
fails if it is not up within 15 seconds. The Debian package ships the agent
at `/usr/lib/portikus/workspace-agent`, the workspace profile bind-mounts
it read-only at `/opt/portikus/workspace-agent`, and the workspace image
runs its unit as `student`. The API adds terminal routes and a
byte-pipe WebSocket at `/workspaces/:id/terminals/:tid/ws` that forwards
frames without parsing them, applies backpressure in both directions,
serves the workspace owner only (an administrator gets a 404), and
re-checks the session about once a second. Terminal metadata lives in a
`terminals` table, and the worker sets `ended_at` when a workspace stops.
The web app gains a terminal page built on xterm.js with tabs, reconnect,
and link routing to the placeholder files and preview routes, which answer
501 until Epics 7 and 8; Caddy now sends browser document requests under
`/workspaces` to the single-page app while JSON and WebSocket routes still
go to the API. On the infrastructure side the `incus_network` role loads
`br_netfilter`, which is what makes the peer-isolation ACL rule take
effect, and the workspace nic filters IP and MAC addresses while the ACL
allows tcp/7400 from the gateway only. Tests are 17 Playwright cases
against a fake agent, a vitest file against the real agent (it needs tmux,
now installed in CI), and an Epic 5 block in the smoke test.

Epic 6 is the three-pane shell and project management (ADR 0010). The
design system is now built: `packages/ui` holds the tokens as a Tailwind
theme plus the primitives and overlays, and `apps/web` is the real shell,
with a project pane on the left, a tabbed work area in the middle, a
placeholder file pane on the right, and a status bar. Projects are
database rows mirroring `~/projects/<slug>`; all filesystem and Git work
runs in the workspace agent behind the existing token, and a listing
discovers repositories already on disk and flags a row whose directory is
gone. Create, clone, template, Initialize Git, rename (which moves the
directory and rewrites terminal working directories), duplicate, zip
download, and archive (a flag, the directory stays) are all there.
Terminals gained splits, tab reordering, a per-project saved layout in one
JSON column, closing the pane when the shell exits, and full clipboard
handling in the terminal. Templates are configuration
(`PROJECT_TEMPLATES`), and the platform still never makes a commit.
Workspace image `2026.09.3` adds `zip` for downloads.

After Epic 6 came the live disconnect grace period (ADR 0011). The grace
period of SPEC.md section 6.4 is now a row in a `settings` table rather
than a startup constant: `SHUTDOWN_GRACE_SECONDS` seeds it on the worker's
first start and nothing else ever writes it from the environment.
Administrators change the platform value through `PUT /admin/settings` and
one student's override through `PUT /admin/users/<id>/settings`, both from
a new administration page at `/admin`. Zero means the workspace is never
stopped for being disconnected. The worker keeps a `disconnected_at`
timestamp and recomputes each running workspace's `shutdown_deadline` every
second, so a change applies at once, including to a workspace already
counting down.

Structured logging came next (ADR 0012). One shared pino logger in
`packages/observability` serves the API, worker, controller, workspace agent,
and the mock identity provider. Every request produces one JSON line, and
every 4xx or 5xx response is logged with its code and message, so a failed
request is visible without reproducing it. `LOG_LEVEL` sets each service's
default, and a `settings.log_level` row set from `/admin` overrides it at
runtime: the API relays the level to each running workspace's agent and the
worker relays it to the controller. CI now runs the tests with coverage and
fails below the floors set in `vitest.config.ts`.

On the pilot feedback branch, the workspace agent no longer drops the frames a
browser sends while an attachment is still starting. It listens from the first
moment of the attach, holds input in the existing early-input queue, and uses
the last size asked for during that window as the size of the new PTY, so a
pane that corrects its size straight after opening is no longer left blank
(SPEC.md 9.7). A socket that closes in that window aborts the attach without
starting a shell.
The terminal title bar now follows `cd` (SPEC.md section 9.3). The
workspace agent's single pane poll, described below, sends a `cwd` frame on
the terminal WebSocket when a pane's path changes, which the web app uses
to update the title. The path is not written to the database, so a new
attachment learns it from the next poll.

Terminal panes can now be rearranged by dragging their title bars (SPEC.md
sections 8.3 and 9.3). Dropping a pane on another pane's left, right, top,
or bottom half makes it that pane's sibling in a row or column split, and
dropping on the middle swaps the two, so a stacked pair becomes a
side-by-side pair and back. While a drag is live the hovered pane shades
the half it would take. Dropping on the tab strip pulls the pane out into a
tab of its own at the marked position, and a tab left empty disappears.
`moveLeaf` and `moveLeafToNewTab` in `apps/web/src/layout/tree.ts` do the
work; both refuse a move that would break the split-depth or tab limits and
leave the layout alone. The drag uses the dnd-kit already in the repo, with
the same 4-pixel activation distance as tab reordering, so a click on a
title bar still just focuses the pane.

Reviving an ended terminal now stays in its own pane (SPEC.md sections 9.5
and 9.7): `reconcile` no longer gives a tab back to an ended terminal that
has no pane, since those rows are listing history rather than panes, and the
store drops any pane a terminal already has before placing it, so a list
refetch that arrives mid-revive cannot leave the same terminal in two places.
Creating a terminal no longer refetches the terminal list by itself either:
the caller places the new terminal and then asks for the refetch, so no
reconcile ever sees a terminal that has no pane yet and no half-placed layout
can be saved. One consequence: a terminal that ends within about a second of being opened,
before its pane reaches the saved layout, is not restored as a tab on reload
and stays only in the ended list.

Workspace image `2026.09.4` keeps the apt package lists instead of deleting
them at the end of the build and adds Debian's `command-not-found`, so a
fresh workspace can run `sudo apt install <package>` without `apt update`
first, and a mistyped or missing command names the package that provides
it. The lists are as of the build date and Debian's daily timer refreshes
them in a running workspace.

Known gaps: from Epic 4, a real identity provider is not reachable from the
API yet, the real client secret travels through the environment until SOPS
is wired up, the only admin UI is the grace period page, nothing
rate-limits login, and disabling a user means setting `users.disabled_at`
by hand in SQL. From Epic 5, the file and preview link targets are
placeholders until Epics 7 and 8; traffic between the API and the agent is
plaintext on the workspace bridge until Epic 12; the token file sits in a
directory the student owns, so containment relies on the Incus files API
resolving paths inside the instance; the eight-terminal cap has a benign
check-then-act race; and terminal rows (open plus the 20 most recent ended
per listing) are never pruned (tracked in `docs/BACKLOG.md`). From Epic 6, the 1024-wide rail collapse is
deferred, a clone shows no progress while it runs, a download has no size
cap, discovery ignores directories that are not repositories, unarchiving
is only reachable through the API, right-click paste in Firefox depends on
the browser's own paste prompt, a failed archive stream can reach the browser
as a truncated zip, a failed download shows the API's JSON error page, and
rename is not atomic across the agent and the database, so a crash between
them leaves the old row missing and the new directory discovered as a
separate project (tracked in `docs/BACKLOG.md`). Terminal names count per workspace rather than per
project, so a second project's first terminal may be "Terminal 3", and a
workspace created on an older image lacks zip until it is recreated, which
the agent reports as a download failure, and the same workspace has empty
apt lists and no `command-not-found` until it is recreated. The projects pane now refetches every
ten seconds while the tab is visible and again when it regains focus, so a
repository made in a terminal turns up without any UI action, and every row that
is not missing shows its folder name next to the project name. A project can
also be deleted for good from its menu: the student types the project's slug
back, the API ends any terminal sitting in the folder, the agent removes
`~/projects/<slug>`, and the row and an audit event record it. The delete now
takes the same one-at-a-time slot the other slow project operations take, so it
cannot run beside a clone or a copy, but it only ends terminals that were
created in the project: a terminal that had moved into the folder with `cd`
keeps running with its shell in a directory that no longer exists, until the
student opens a new one. Whenever the
agent runs `git init` for a project, whether on create, on a template, or
through Initialize Git, it also writes a default `.gitignore` if the project
has none, so a template that ships its own keeps it. From the grace period task, the
administration page is a settings form, not the Epic 11 mockup, and the
infrastructure smoke test now signs in as the mock identity provider's
administrator to shorten the grace period. From structured logging, an agent
that restarts inside a still-running workspace loses the log level override
until an administrator changes it again; a burst of failing requests writes
one warn line each, with no rate limit and no journald size cap set by
Ansible, so a flood can push older journal entries out (the fix belongs with
the login rate-limit gap above: a Caddy rate limit plus a journald
`SystemMaxUse`); at debug the worker writes one line per workspace per
second, so debug is meant for short investigations rather than everyday
running; and a workspace owner who holds the agent token can set their own
agent's level, which stays until the setting next changes or the workspace
restarts. From pane dragging, there is no keyboard equivalent: a pane is
rearranged with a pointer only, and a drop is refused silently when it
would pass the split-depth or tab limits. The mouse wheel now scrolls a
terminal's own scrollback and the viewport has a thin scrollbar, which
needed tmux to stop using the alternate screen. tmux and the browser both
keep 5,000 lines, and an attachment is sent the pane's earlier lines, at
most 256 KiB of them, so a reload no longer starts with a bare prompt; the
cost is one blank screenful between that history and the repainted screen,
and a capture cut at the byte limit can lose the colour of its first few
lines. A full-screen program such as nano still moves a line at a time: one
poll for the whole agent asks tmux which panes have such a program on them
and tells the browser, which turns wheel notches into arrow keys while it
does. The poll runs twice a second normally and four times a second while
any pane is in that state, so for up to about half a second after a program
takes the screen, and a quarter of a second after it lets go, a wheel notch
may do the other thing. The workspace dialog can now start,
stop and restart the workspace (a confirmation first for stop and restart),
and dialog rows wrap rather than scrolling sideways, so a 64-character image
fingerprint no longer pushes the title and close button off screen; the
fingerprint is shown shortened with the full value in its tooltip. A review of
the epic branch also fixed a few things: a pane torn off to the tab strip now
gets a tab id of its own rather than reusing the terminal id, which could give
two tabs the same id, and the layout schema rejects a saved layout with
duplicate tab ids; a newly created terminal is written into the cached list, so
a list request already in flight cannot answer without it and take its pane
away; and a split keys its children by terminal, so dropping a pane on another
pane's centre swaps them without tearing down and reconnecting both terminals. The infrastructure smoke test now records every workspace, Incus instance and user row it creates and deletes only those, and lists any workspace that already exists, leaves it alone, and skips the lifecycle checks entirely rather than adopting or shortening the grace period around somebody else's workspace; `infra/tests/cleanup-scope-test.sh` proves that with a stubbed SSH command and runs in `make infra-check`.
## Epic 7 — Files, Monaco, search, Git status, and change review

Epic 7 (ADRs 0013, 0014 and 0015) is on the `epic/7-files` branch and has
not been merged to `main`. The pilot VM was not deployed from it.

The workspace agent gained file primitives (SPEC.md sections 11.1, 11.2,
13.5 and 24.6). Every path is resolved with `realpath` and refused unless
the result is inside `~/projects/<slug>`, so a symbolic link, a `..`
segment or an encoded separator cannot reach the rest of the filesystem. A
read streams the file out and carries an ETag, which is the SHA-256 hash of
the content rather than a timestamp, so two writes in the same millisecond
still differ. A write is conditional and must carry exactly one of
`If-Match: <etag>` to overwrite or `If-None-Match: *` to create; a stale
ETag is a 412 with the current one attached. The body streams into a
temporary file in the same directory, opened with `O_EXCL` and `O_NOFOLLOW`
so the kernel itself refuses a planted link, and only a whole, hashed body
reaches the target. An overwrite finishes with `rename`, so a failed save
never leaves a truncated file; a create finishes with `link`, which fails
rather than replacing a file that appeared while the upload was in flight.
The fixed caps are 2,000 entries per directory listing, 2 MiB for a file
the editor opens or saves, and 50 MiB for an upload.

Git status and diff are next, and both are read-only (SPEC.md sections
12.1, 12.6 and 12.8). The agent runs the real `git` command line and never
keeps a model of its own. Each command gets a ten-second budget and a byte
cap on its output, and runs in its own process group, so a timeout kills
any credential or filter helper git started as well as git itself. Status
returns the branch or detached state, the upstream, how far ahead and
behind, the number of unresolved conflicts, and one entry per changed path
with its staged and working-tree letters, the earlier path when git
detected a rename, and ignored paths only when the browser asks for hidden
files. Diff compares the `HEAD` version with the working tree and covers
the cases section 12.6 names: modified, added, deleted, renamed, binary and
too large, with each side capped at 1 MiB.

Project search runs ripgrep with a fixed argument list and no shell (SPEC.md
section 11.5). It returns at most 500 matches, skips any file over 1 MiB,
carries one line of context on each side, and reports a 1-based character
column rather than ripgrep's byte offset, so clicking a result on a line
with accented text lands in the right place. A search that runs past ten
seconds is stopped.

Filesystem events go over a per-project WebSocket at
`/projects/:slug/events` (SPEC.md section 11.4). One chokidar watcher per
project root is shared by every subscriber. It does not follow symbolic
links and skips the generated and dependency directories of section 11.3.
Changes are batched for 150 milliseconds and sent as one frame of at most
200 paths; past that the frame says `truncated` and the browser refetches
the tree instead. Anything under `.git/` is folded into a single `git`
flag rather than listed, which is what tells the browser to refetch Git
status. A `ready` frame is sent once the first scan has finished, so the
browser knows when its listing is live. One agent serves at most 32 event
sockets.

The control plane relays all of it under the authorization rules of SPEC.md
section 5.2 and for the workspace owner only; an administrator asking for a
student's file gets a 404, as with terminals. The file routes stream in both
directions rather than buffering, pin the content type of anything they
return so an HTML file cannot execute on the control-plane origin, and
apply their own byte cap, so a workspace agent cannot make the control
plane hold an unbounded body. The Git, search and events routes are a thin
relay on top: one browser socket is one agent socket, closes carry fixed
reasons the browser can act on rather than a passed-through message, and a
single workspace may hold at most 8 event sockets at once, below the
agent's 32.

In the browser, the tabbed work area now holds file and diff tabs beside
terminal tabs (SPEC.md section 8.3). A document tab is a single leaf and is
not split. The reconcile that keeps the saved layout honest evicts the
oldest document tab when the 16-tab cap is reached, so opening a file
always works and never closes a terminal.

The file tree does the CRUD of section 11.2: create, rename, move, delete,
upload and download. Uploads run four at a time; when a name already
exists the student is offered Replace, which repeats the write with
`If-Match: *`. Files and directories move by dragging, including onto the
project root. One toggle shows hidden and generated files, and every
failure is a plain-English toast rather than a status code.

The editor is Monaco 0.56.0 bundled with the app (no CDN), loading only
`editor.api`, the Monarch highlighters and the JSON language service; the
TypeScript and CSS services are left out, because their diagnostics do not
know the project's configuration and would mislead a student. Text is
autosaved 750 milliseconds after the last keystroke, with one save in
flight at a time and a keepalive flush when a tab unmounts, so closing a
tab does not lose the last edit. A conflicting write brings up a bar with
Keep mine and Take theirs, and a file deleted on disk while open shows a
banner rather than silently saving it back.

Markdown tabs open in Preview by default and offer Edit, Preview and Split
(SPEC.md section 13.4). Front matter is split off and shown as a collapsed
block rather than as body text. Rendering is react-markdown with GitHub
flavoured Markdown, with raw HTML deliberately not enabled.

Git state is visible in three places (SPEC.md sections 12.1 and 12.8): a
decoration on each tree row, a compact status bar reading
`main • 3 changes • 2 commits ahead`, and a project Changes list whose
entries open the matching diff. All three are driven by the events socket,
so a change made by a coding agent or the Git command line shows up without
polling and without a reload. A diff tab shows the Monaco diff editor, with
its own presentation per status: added, deleted, renamed, binary and
oversized each say what they are instead of rendering an empty pane.

The search panel cancels a superseded search, and its results open a file
through a `?open=&line=` route, which also closes the Epic 5 gap where a
file link from a terminal answered 501.

Known gaps. Session change review is deferred to Epic 9: the baseline is
created when an agent session is launched, so the acceptance line about
reviewing changes since the session began moves to Epic 9 (SPEC.md section
29). The watcher does not push events for changes inside hidden or
generated directories, so turning hidden files on shows a listing that then
goes stale until the next refetch. Hard links inside a project to a file
outside it defeat confinement, because a path check cannot see them;
confinement bounds the coding agent, not a student who already has a shell
in the container. The destination race on `mkdir` and `move` is left open,
because Node has no `RENAME_NOREPLACE`. The events socket does not register
presence, so watching a project does not by itself keep a workspace alive.
A detached `HEAD` shows no short object id, because the contract does not
carry one. Untracked and unmerged paths share the letter `U` and are told
apart by colour, icon and the `data-git` attribute. A project that is not a
Git repository diffs every file as "added". The agent has no cap on
concurrent searches. `fake-agent.ts` ships inside the Debian package as
dead code. Relative image paths in Markdown are not resolved, so an image
in a repository does not render. Code blocks inside Markdown have no syntax
highlighting. The test database name and the Playwright ports are shared,
so two local test runs at once collide (`docs/WORKFLOW.md`). Two CI flakes
were seen during the epic and are still being isolated.

## Epic 7.1

Epic 7.1 is a batch of fixes and small features from the first hands-on
use of the pilot after Epic 7, gathered on 2026-09-18 and landed as
individual pull requests into the epic branch.

**Editor.** A Markdown tab is a split while it is being edited: Monaco
holds the raw Markdown on the left and a read-only rendered preview on the
right. Its one Diff button replaces the whole split with this file's
side-by-side diff, as on every other file tab, and turning the button off
brings the split back. There are no
Code, Rich, and Split buttons and no rich-text toolbar any more. The rich
MDXEditor view that landed earlier in this epic (#155) was taken out
again after use: a second editing surface over one buffer brought its own
Markdown dialect and its own parse failures, and the raw text beside a
preview is what students wanted. `@mdxeditor/editor` and `lexical` are
gone from the web app, and react-markdown with remark-gfm and
remark-frontmatter is back. The two sides are kept at the same relative
position, and each side now ignores exactly the position it last asked
the other one for, instead of muting itself for a frame: the old flag
dropped a student's own wheel scrolls, which is why synchronized
scrolling looked broken on the pilot (§13.4) (#155, #218). Editor settings — auto-save, its delay, and word wrap — now persist per
user: a `users.editor_settings` JSONB column holds whatever the student
has changed, `GET`/`PUT /me/settings` read and write only the signed-in
user's own row, and an account-menu dialog reaches all three, with the
file tab obeying them without a reload (SPEC.md §13.1, §13.5) (#159). The
editor's external-change detection now ignores writes the editor itself
made: the save that used to race the project events socket's own refetch
of the same change no longer raises a false "this file changed on disk"
prompt (§13.3, §13.5) (#157). The same prompt had a second cause, found
on the pilot: Caddy compresses the file read and appends "-gzip" to its
ETag, so the editor saved against an ETag the workspace agent could not
match and every first save after a read was refused as a conflict. The
file read and write now say `Cache-Control: no-transform`, which Caddy
honours, and a save refused while the file on disk is still the tab's own
version saves again instead of prompting (§13.3, §13.5) (#157). The stock Monaco experience is on: find and
replace, code folding, bracket matching and colouring, multi-cursor, the
minimap, and the command palette, loaded as named contributions so the
excluded language services stay out of the bundle; the editor also gained
its own zoom, per open file and per session, and language detection from a
file's first line when its name says nothing (§13.1, §13.2; DESIGN.md §10)
(#156, #162, #163). A file now has one tab: opening a change from the
Changes list shows the diff inside that file's own tab rather than a
separate diff tab, with a toggle back to the editor, and a real on-disk
change during editing opens as a Monaco conflict diff offering keep-mine,
take-disk, and keep-editing (#160, #158). The selected tab, the editor
cursor, selection, and scroll position now survive leaving the workspace
route and returning; they live in this browser's `localStorage` and are
never sent to the server (§7.5) (#161). Zoom is kept in memory for the
session only and resets on reload (#162). Closing a tab now selects the
tab that was selected most recently before it, the way a web browser
does, falling back to the neighbour on the left, or on the right when the
closed tab was the leftmost one; closing a tab that is not selected
leaves the selection alone. The selection history lives in the layout
store for this session only and is never saved (§8.3) (#223).

**Workspace lifecycle.** A workspace the student stopped by hand no
longer shows an endless "Starting your workspace" progress card. The
starting screen has a stopped state: it says the workspace is stopped and
offers a Start workspace button that sends the same request as the Start
button in the workspace dialog. Before this, closing the dialog after a
stop revealed the progress card, which looked like a resume that hung for
ever, and the only way out was to reopen the dialog and press Start
(SPEC.md §6.2, §6.3) (#230).

**Markdown.** The three Markdown viewer defects from pilot feedback are
fixed (§13.4): rendered lists show their markers again, split view keeps
the two sides scrolled together, and the code side's scrollbar is now
drawn in a visible colour on both editor themes (#154).

The two sides now follow each other by source line rather than by how far
down each one is: the first line showing on the left is the first line
showing on the right, and scrolling either side moves the other (§13.4)
(#229). The preview marks every block it renders with the line it came
from, counting the front matter it hides.

The rich view's own failures — a file that stopped at the first raw HTML
node, and the keystrokes that were dropped after it — went away with the
rich view itself (#218). The preview renders raw HTML as text, so nothing
in a file is lost or run, and images render with react-markdown's own
address check.

**Projects pane.** A long project name no longer pushes the row's
three-dots menu out of sight when the pane is dragged narrow. The name
truncates with an ellipsis and the menu button keeps its width, in the
pane header row as well as in each project row (#222).

**Files pane.** The header's three-dots menu and an empty project's own
empty state now offer New file and New folder on the project root, the
same items a row's menu shows (#153). The pane now supports selecting
several rows — a plain click, Ctrl-click to toggle, Shift-click for a run
— with the row menu and the Delete key acting on the selection behind one
confirmation, a download that sends one file or zip per selected row, a
highlighted project-root drop target while an upload is dragged over it, a
tighter 24-pixel row height, file-type icons, and an autofocused name field
when the New file, New folder, or Rename dialog opens (#182–#186).

Two more pilot findings are fixed. The project-root drop target no longer
flickers when the upload drag crosses a top-level file row: the pane counts
how many of its elements the drag is inside, so the leave event fired for the
element behind a row no longer looks like the drag leaving the pane (#220).
Hidden and generated files are now shown by default, with the Show hidden and
generated files control still there to turn them off, and an untracked file's
name is drawn in italic and slightly dimmed (SPEC.md §11.3, §12.1) (#221).
Directories are not styled as untracked: Git status lists untracked files one
by one and says nothing about the tracked files a directory may also hold, so
the tree cannot tell a wholly untracked folder from a partly tracked one
without a second listing.

**Projects.** The clone dialog now asks for the repository URL first and
derives the project name, slug, and `.git` suffix from it, while any name
the student typed by hand is never overwritten (#130). Create project now
warns about a name clash while the student types, comparing the previewed
slug against the workspace's existing project slugs client-side and
disabling Create until the name changes, with the server's 409 kept as the
final guard (#175).

**Terminal and image.** Terminal names are now chosen from the terminals
of the same project rather than a row position that counted every
terminal the workspace ever had, so terminals renumber from 1 after a
restart and a second project starts at Terminal 1; a terminal created in
an ended terminal's place takes its chosen name back (§9.6, §9.7) (#123).
The workspace agent starts tmux with `set-clipboard` and `focus-events`
on, the browser decodes a program's OSC 52 copy request itself (and
ignores any request to read the clipboard back, since terminal programs
are untrusted, §24.2), and a URL too wide for the pane is joined into one
link across every row it covers (§9, §9.7, §14.9) (#125, #126, #128). A
shell shim at `/usr/local/bin/xclip`, with `xsel` and `pbcopy` as links to
it, lets command-line tools that copy through those names reach the
browser by writing an OSC 52 escape instead (workspace image 2026.09.6)
(#125 follow-up). The image also ships
`/etc/profile.d/portikus-agents.sh`, which exports `DISABLE_AUTOUPDATER=1`
so Claude Code stops trying to update itself into a root-owned npm prefix
it cannot write; Codex has no equivalent environment variable, so its
update check is left for Epic 9 (§10) (#127).

A security review of the batch found four issues in the web app, all now
closed: an OSC 52 clipboard write can only change the system clipboard
from the pane the student is looking at and typing in, is capped at
100 KB per copy, and shows a toast naming the terminal that did it; a URL
printed by a terminal no longer opens in a new tab when it carries a
username or password; the loopback and private-address refusal is now a
range check covering 127/8, IPv4-mapped IPv6 forms, and the private,
link-local, and unique-local ranges; and signing out clears every
project's browser-local layout from local storage (§24.2).

**Administration and settings.** The Administration entry moved out of
the workspace header and into the account dropdown menu, where only
administrators see it, and opens `/admin` in a new browser tab with
`rel="noopener"`, so the workspace tab's terminal sockets and disconnect
grace countdown never start while an administrator works on settings
(§6.4) (#164, closing #124).

**Editor icons.** The find widget's next, previous and close buttons
drew as empty rectangles. Monaco paints them with its "codicon" icon
font, whose `@font-face` rule lives in a stylesheet only
`editor.main.js` imports, and the workspace deliberately loads the
editor API plus named features instead of `editor.main.js`. The
codicon feature module is now loaded with the other features, so the
built bundle carries the font's stylesheet as well as the font file
(#219).

**Tests and CI.** Two intermittently failing unit tests were made
deterministic without changing what they assert: the workspace-agent git
timeout test no longer races a real git process, and the API terminal
input-limit test now waits for the server to clear its presence row
instead of reading the count the instant the close frame arrives. Unit
test output lost 44 jsdom "Not implemented" warnings by stubbing canvas
and window scrolling in the shared test setup, and the CI cache action
moved from v4 to v5 to clear a Node 20 deprecation warning (#151, #152).
Every database test file now gets a database of its own, created and
dropped by the test helper, so the suite runs fully in parallel again
instead of serializing the files that share one database; the whole suite
with coverage went from about 99 seconds to about 26 on a 32-core host
(STACK.md §13). Continuous integration now computes which files changed inside
each job and skips every heavy step — installs, typecheck, lint, tests, builds,
Playwright, OpenTofu, Ansible, shellcheck — on a documentation-only change,
while the job itself still reports its check, so branch protection is never
blocked by a workflow that never ran; a docs-only pull request now finishes CI
in under 40 seconds per job. The Application checks job went from 4m03s at the
start of the batch to about 2m30s now. The browser test suite is now stable on
a machine where several agents run Playwright at once: a new setup check
compares the database the API under test is reading with the one the test
helpers write to, and stops the run with a clear message when they differ,
which is what made a different administration test fail on each full-suite run
while each passed alone because Playwright had reused another checkout's
servers on the fixed ports; a genuine race in the file-tree "full tab strip"
test was also fixed, and the administration test file is recorded as needing a
single worker because those tests share one settings row (§6.4, §7.5).

**Process.** A merger agent now lands a list of task pull requests into
an epic branch on its own: it waits for CI, updates a branch that has
fallen behind, squash-merges, and reruns or escalates failures, so a task
lands as soon as it is green instead of waiting on a person between every
task; the human review moves to once per epic (ADR 0016). Each role in
the Ansible platform playbook now carries its own name as a tag, so one
role can be converged on its own, verified on the pilot host by applying
only the Caddy role. `docs/HOW-WE-WORK.md` is a new, generic guide to how
Portikus is built with AI agents, written in plain English for
non-technical readers.

**Review.** A code review over the epic head produced eleven findings,
all fixed in the batch: text typed on the student's side of a conflict
diff now survives Keep editing; opening a file that is showing its diff
takes the tab back to the editor; Monaco models are named per project;
deleting a folder together with a selected file inside it sends one
request instead of two; a user's stored editor settings survive an
unknown key in the row; per-file test databases are swept after a
crashed run; CI now classifies infra documentation and shell scripts
correctly from one shared change-detection job; and the clipboard shim
treats a selection name given as an argument the same as one piped in.
Duplication the parallel builders had introduced in the batch was also
removed: one scroll listener, one tree
query, one way to make a menu item a link, and zoom handled in one place
in the layout store. A security review of the batch is described above
under Terminal and image, which found and closed four issues in the web
app.

Known gaps. Multi-row selection downloads one file or zip per row rather
than one merged zip, because the download route takes a single path; a
multi-path agent endpoint would let the files pane send one request for a
merged zip (tracked in `docs/BACKLOG.md`). A new terminal in a project
with an ended, custom-named terminal inherits that name rather than
matching it exactly; a `replacesTerminalId` hint from the browser would
make the revive exact. The xclip/xsel/pbcopy shim covers the common
command-line case, but `@xterm/addon-clipboard` was not adopted because
its xterm 6 support is still in beta. `DiffViewer` still picks its
language from the file extension only; there is no Makefile grammar in
Monaco. Source-line to preview-line scroll mapping in the Markdown split
view is deferred; the current sync is by relative scroll position, not by
the corresponding source line (tracked in `docs/BACKLOG.md`). Codex's
update-check setting belongs with the rest of agent configuration in Epic
9, so issue #129 stays open. A handful of end-to-end tests were seen to
flake once during the batch (an admin grace-period toast, a full tab
strip, reviving both ended panes, and the two conflict-diff tests before
auto-save was turned off in their setup) and are worth watching rather
than fixing blind. Relative image paths in the Markdown
preview resolve against the app origin and show as broken images. Parallel local
end-to-end runs still collide on fixed ports and one shared database;
per-run e2e ports and database are tracked in `docs/BACKLOG.md`.

## Epic 8 — Verification, running services, and authenticated preview

Epic 8 is on the `epic/8-preview` branch and has not been merged to
`main`. It delivers phases A and B of `docs/BROWSER-HANDLING.md`: a
student can see which services are listening inside their workspace, run
the project's own checks, and open a running web application inside
Portikus on a host that only they can reach. ADR 0018 settled the three
decisions the design had left open before any code was written (#243).

**Workspace label and container hostname.** Every workspace now has a
label, derived once when the workspace is created from the identity
provider's `preferred_username` claim: lowercased, cut down to letters,
digits and hyphens, capped at 40 characters, prefixed with `u` if it
would otherwise start with a digit, and made unique with `-2`, `-3` and
so on. A missing claim gives `ws-<8 hex>`. The label names the preview
hosts and is pushed into the container as its hostname at every start,
through `/etc/hostname` and a `hostname` call, so the shell prompt reads
`student@<label>` (SPEC.md section 29 Epic 8, section 7.1; migration
`0008_preview`) (#245).

**The preview data model and configuration.** The same migration adds the
`preview_grants` and `preview_sessions` tables of BROWSER-HANDLING.md
section 17, holding only SHA-256 hashes of tickets and tokens, with
foreign keys that cascade, and carries the main session id on a grant so
a preview session can be tied to the Portikus session that created it. Five configuration keys drive the policy: `PREVIEW_SUFFIX`,
`PREVIEW_PORT_MIN`, `PREVIEW_PORT_MAX`, `PREVIEW_DENIED_PORTS` and
`PREVIEW_TICKET_TTL_SECONDS`. The workspace agent's own port is always
denied whatever the list says, and the API refuses to start in production
when the suffix is missing, is not a valid lowercase DNS name, or covers
the application host (#245).

**Grants, bootstrap and authorization.** The browser asks
`POST /workspaces/:id/preview-grants` for a grant and gets back a preview
origin and a one-use bootstrap URL. Opening that URL on the preview host
sets a host-only `__Host-portikus-preview` cookie with `SameSite=Strict`
and redirects to `/`. From then on every request through the preview edge
is decided by `GET /preview/authorize`, which Caddy calls as a
`forward_auth` subrequest. That endpoint answers only when the calling
socket's own peer address is loopback — the socket, not a forwarded
header — and it builds the internal upstream solely from the workspace
row and the port on the preview session, never from request text. The
upstream travels back in the `X-Portikus-Upstream` response header, which
Caddy copies onto the request; a client copy of that header is always
deleted first, so only the API can choose where a request goes (SPEC.md
sections 14 and 24.7; ADR 0018 decision 2) (#249).

**Revocation and reset.** A preview session dies with the main Portikus
session: signing out, the main session expiring, stopping the workspace,
or an explicit `POST /workspaces/:id/preview/reset` all revoke it and
close any forwards it opened. Reset preview data is driven from the
Portikus page rather than from inside the preview frame, because an
application may register a service worker at the root of its own preview
origin and that worker answers in-frame navigations before they reach the
network. The Portikus page instead revokes the sessions, fetches
`/__portikus/reset` on the preview origin in `no-cors` mode so the edge
answers with `Clear-Site-Data`, and then takes a fresh grant (#249,
#252).

**Listening discovery and loopback forwards.** The workspace agent reads
`/proc/net/tcp` and `/proc/net/tcp6` once a second, keeps the listening
sockets, and matches each one back to the process holding it through
`/proc`. Ports published by inner Docker containers are matched with
`docker ps`, cached for five seconds and given 500 milliseconds to
answer, so a workspace without Docker still gets a list. The agent never
probes a student's service: the protocol hint is a guess from well-known
port numbers. A service bound only to loopback is reached through a
forward — a listener on the container's own interface, on the same port
number, that copies bytes to that same port on loopback in the same
container and nowhere else, dialling `127.0.0.1` or `::1` for each connection,
whichever address the agent saw the service listening on, so an
IPv6-only service is reached too. Only the agent's `/forwards` routes can open one, a forward
closes itself when its loopback listener disappears, and a workspace may
hold at most eight forwards open at once, counting the preview and bridge
ones together (SPEC.md sections 14.7 and 18.2) (#244, #255).

**The listening registry.** The control plane keeps one WebSocket per
running workspace to the agent's listening events, decided by a
two-second poll of the running workspaces that never runs two passes at
once. It stamps the workspace id the agent does not know onto each entry
and marks as `denied` any port the policy refuses, which is the control
plane's word and never the agent's. The same list goes out to the browser
on the existing workspace socket as a `listening-services` frame: the
current list on connect, then every change (#249, #255).

**The Caddy preview edge.** A second virtual host,
`https://*.<preview suffix>`, serves every preview origin on the same
public port with a wildcard certificate from Caddy's internal authority.
On the pilot the suffix defaults to `preview.<public host>`, which nip.io
resolves without any DNS record. Inside that block,
`/__portikus/bootstrap` and `/__portikus/reset` go to the API, every
other reserved `/__portikus/` path is a 404 from Caddy without an API
call, and everything else strips the client's upstream and forwarding
headers, runs the authorization subrequest, and proxies the answer. The
preview session cookie is cut out of the Cookie header after
authorization, so the student's application never sees it, and the header
is deleted rather than sent empty. Two narrow compatibility rewrites are
applied: a redirect whose `Location` names `localhost`, `127.0.0.1` or
the workspace address on exactly the port this preview serves is
rewritten to the preview origin, and a `Set-Cookie` with
`Domain=localhost` or a bare IP address loses that attribute. Nothing
else is rewritten — no bodies, no external redirects, no security headers
removed. Preview access logs use Caddy's filter encoder to drop the query
string and the `Cookie`, `Referer` and `Authorization` headers, which
matters because a bootstrap ticket travels in a query string
(BROWSER-HANDLING.md sections 10, 12, 13 and 16.5) (#246, #253).

**The Preview tab and the Running pane.** A new centre-pane tab kind,
`preview:<port>`, is saved in the project layout like a file tab and is
never split. It points a sandboxed iframe at the bootstrap URL with
exactly the sandbox, referrer policy and permissions policy of ADR 0018:
scripts, same-origin, forms, modals, popups, downloads and pointer lock
allowed; no top navigation; camera, microphone and geolocation denied.
The toolbar offers reload, open in a new tab, copy URL, viewport widths,
reset preview data, and a link to the Running surface. The Running
surface is a third tab of the right pane beside Files and Checks, with
one row per listening port, its command, whether it is Docker, and an
Open preview action. A `+ Preview` launcher lists the listening ports and
accepts a typed one. A URL printed in a terminal whose host is exactly
`localhost`, `127.0.0.1` or `[::1]` opens a Preview tab for that port;
`localhost.evil.example`, user-info tricks, other loopback addresses and
non-HTTP schemes are all refused (SPEC.md sections 14.6 to 14.9 and 18.2)
(#250, #254).

**Checks.** A project's checks live in `.portikus/checks.json` inside the
project, and a check runs in a dedicated read-only output panel rather
than in a terminal tab. The agent reads and validates the file — a
missing file is an empty list and a broken one is reported rather than
thrown — and runs a check with `bash -lc` in the project directory
through node-pty, one run of a check at a time. Output is kept in memory,
capped at one mebibyte with the oldest bytes dropped, and fifty runs are
remembered whatever state they are in, with finished ones dropped before
running ones when room is needed. The control plane brokers the three
routes behind the same ownership gate as the file routes, and the output
socket is one-way, so nothing a page sends can reach the agent through
it. In the browser, the Checks pane shows each check's name, its real
command and its state, with Run and Stop, an output panel below, and an
Edit checks dialog that writes the file through the ordinary conditional
file API (SPEC.md section 18.1) (#247, #255).

**The multi-port bridge.** A request to `/__portikus/ports/<port>/…` on a
preview host is authorized for that other port and proxied to it in the
same workspace, so an application that calls its own API on a second port
works without a second preview host. Caddy keeps the original path in
`X-Forwarded-Uri` for the authorization call and strips the prefix before
the application sees the request. The bridge port goes through exactly
the same policy as any preview target and is always looked up in the
preview session's own workspace, so it cannot reach another student's
service. A bridge forward counts every session using it, so one session
ending does not close a forward another still needs (#251, #253, #255).

**Tests.** Beyond the unit and end-to-end tests each task carried, the
epic added a threat-model suite that walks the refusal matrix of
BROWSER-HANDLING.md section 26, a hostname fuzz test that throws four
thousand generated hostile names at the preview host parser, a real
browser matrix in `e2e/preview-browser.spec.ts` covering cookie
isolation, storage, form posts, popups and the Portikus-owned explanation
pages, and an infrastructure template test,
`infra/tests/caddy-preview-test.sh`, which now makes 53 assertions about
the rendered Caddyfile and is run by `make infra-check`. The browser
tests found two real product bugs, both fixed in the epic rather than
worked around (#252).

**Rate limiting.** A student may make thirty preview requests a minute,
counting bootstrap tickets and framing probes against one budget; past
that the answer is 429 with a `PREVIEW_RATE_LIMITED` code the browser
shows. A workspace also runs at most one framing probe at a time. A
student holds at most fifty live preview sessions, the oldest giving way
to a new one, and each new grant sweeps preview sessions that were
revoked more than a day ago or whose main session has gone (#255).

**Pilot verification.** On 2026-09-21 the epic head (build 0.1.234) was
deployed to the pilot VM and walked through BROWSER-HANDLING.md section 25.1
as a signed-in student in Chromium. Passed: a Vite application on port 5173
rendered in the embedded Preview tab with hot module reload working across
an edit; a Python `http.server` bound to all interfaces on port 8000; a
WebSocket application that stayed connected through the gateway; the
same-origin bridge reaching a second and third port while refusing the
agent port, a dead port, and malformed paths; Reset preview data clearing
the application's cookie, local storage, and service worker; the preview
session cookie stripped before the application saw the request; a second
student's workspace unable to reach the first student's ports while the VM
could; replayed, wrong-host, and cookie-less requests refused with
Portikus-owned pages and no existence detail; logout ending the preview;
the smoke test at 71 of 71. Two bugs found on the pilot are fixed on the epic
branch, by #258 and by the confirmation-review pull request that follows
it: an application that refuses framing showed a blank pane instead of
the Open in new tab offer, and the reset response's
`Clear-Site-Data: "cookies"` directive cleared the whole registrable
domain and signed the student out. Fixing the first added the framing
probe route `GET /workspaces/:id/preview/embeddable`, its contract, and
the rate limit and one-at-a-time rule that keep it from being used to
make the control plane hold outbound sockets open. Fixing the second
changed what reset clears: the answer now expires each cookie name the
request carried rather than asking the browser to clear the domain's
cookies. One gap was fixed the same way: the loopback forward dialed only
IPv4, while Vite's default bind is IPv6 loopback. One gap is deferred to the backlog: Vite
refuses unknown hosts until its `server.allowedHosts` names the preview
suffix, and nothing yet carries the suffix into the workspace for a
template to use. The Incus workspace network access list needed one new
ingress rule for the preview range, applied by hand on the pilot from the
Ansible play and now part of the play. The pilot's API environment file
still carries `PREVIEW_SUFFIX` added by hand until the next full
deployment.

**Decisions.**

- ADR 0018, taken on 2026-09-21, settled three things: the preview is
  built and tested for a same-site deployment only, with preview hosts
  under `*.preview.<application host>` and a `__Host-` cookie; Caddy
  learns a request's upstream from a trusted response header on the
  authorization subrequest rather than from anything the client sends;
  and the iframe ships with the design's baseline sandbox and permissions
  policy.
- Checks are defined in a file inside the project,
  `.portikus/checks.json`, so they travel with the repository, and a
  check runs in its own read-only output panel rather than in a terminal
  tab, so the student cannot type into a running check.
- Reset preview data is performed by the parent Portikus document rather
  than by the preview frame, because a service worker registered at the
  root of the preview origin can answer the frame's own navigations
  before they reach the edge.
- A check run lives only in the agent's memory. Nothing about it is
  written to the database.
- A project's identity is the inode of its directory, so a folder renamed
  with `mv` keeps its row, its tabs and its layout.

**Known gaps and residuals.**

- The separate registrable preview domain with partitioned cookies is
  unsupported. Only the same-site shape is built and tested (ADR 0018).
- Whether a grant was made for an embedded or a top-level preview is
  enforced only by the `Sec-Fetch-Dest` request header. A browser that
  sends no such header is still accepted, so this narrows the door rather
  than closing it.
- Any website can make a student's browser clear that student's own
  preview-origin data, by causing a request to `/__portikus/reset`. The
  reset route answers the same way with or without a preview cookie. This
  is accepted: the worst outcome is that one origin's storage in one
  browser is cleared.
- The saved layout is bounded per request, by Fastify's 1 MiB body limit
  and the shape checks on each tab, but there is no total quota on how
  much layout one user can store.
- An application that refuses to be embedded gives the browser no event,
  so the Preview tab guesses after eight seconds without a load. The
  guess is now an overlay over a frame that stays mounted, and a late
  load clears it, so a slow first compile recovers on its own.
- The framing probe honours only exact origins in a `frame-ancestors`
  source list. An application that names a wildcard host or a bare scheme,
  such as `https:` or `https://*.example.edu`, is reported as not
  embeddable even where it would in fact allow the Portikus page, so the
  student is offered the new tab instead of the frame.
- The Running pane shows `unknown` for a process the agent could not
  name, which happens when the `/proc` entries for it cannot be read.
- A client-side minimum port of 1024 is still in the terminal link
  handler and in the web app's preview route, even though the launcher
  and the Running pane now take the port policy from the API.
- The workspace agent runs as the student, inside the student's own
  container, and its bearer token sits in a file that user can read, so a
  student can call the agent's own API directly, including its loopback
  forward routes. This grants nothing the student does not already have:
  the agent has no authority outside the container, never calls the
  control plane, and the control plane trusts none of its claims for
  authorization (the registry stamps the workspace id, computes the deny
  state, and takes the upstream from the workspace row). A forward the
  student opens this way is reachable only from the platform VM. The
  design's sentence that a student process cannot ask for a forward is
  therefore true of the control plane's registry, not of the agent's
  socket; BROWSER-HANDLING.md section 11.2 now says so. Accepted.
- The pilot's `api.env` had `PREVIEW_SUFFIX` added by hand so the edge
  could be walked; the Ansible template carries the key, so the next full
  deployment sets it properly.
- Renaming a folder from `a` to `b` and then creating a new project at
  `a` now keeps the two apart: the reconciliation compares the identity
  of the directory sitting at the old name instead of only noticing that
  something is there.

## Epic 8 pilot fixes (issues #237 to #241)

A batch of small fixes from hands-on use of the pilot after Epic 7.1,
gathered on 2026-09-19 and landed into the Epic 8 branch.

**Files pane.** Dragging a row now puts a small copy of it, with its icon
and name, under the pointer, so it is clear what is being moved. The
empty area below the last row is a second drop target for the project
root, next to the path line under the header, so a file in a subfolder can
be dragged back to the top level (issue #237, SPEC.md section 11.2).

**Renamed projects.** A project whose folder a student renames with `mv`
in a shell keeps its row, its id, its open tabs, and its layout. The
marker is the directory's inode, which the agent reports with each listing
and the control plane stores on the project row (migration
`0009_project_directory_id`). Before discovery, each listing records the
identity of every directory a row names, then moves a row whose directory
is gone to the directory carrying its identity. A copy or a restore from a
recovery archive has a different inode and is honestly a new project
(issue #238, SPEC.md section 7.1).

**Terminal colours.** Terminals can be light as well as dark. The choice
is a per-user setting alongside the editor settings, saved through the
existing `/me/settings` route with no migration, and it applies to open
terminals without a reload. It is deliberately separate from the page
appearance, because a bright room may call for a light terminal on a dark
page (issue #239, SPEC.md section 13.5).

**Tab strip.** Centre-pane tabs follow the Chrome model: equal width up to
220 pixels, labels that fade out at the right edge, shrinking together to
a floor where only the kind icon and the close control are left, and
sideways scrolling past that floor, with the selected tab scrolled into
view. The close control is on every tab at every width, and an unsaved
file shows a dot in its place that turns back into the close control on
hover. `MAX_LAYOUT_TABS` and the "Too many tabs are open" toast are gone;
the saved layout is still bounded by the request body limit and by the
length and shape checks on each tab (issue #240, SPEC.md section 8.3).

**Header.** The disabled search icon that promised search "in Epic 7" is
gone. Search lives in the files pane and Ctrl+Shift+F still opens it from
anywhere in the workspace (issue #241, SPEC.md section 11.5).

Known gaps. The design mirror under `design/system/components/bundle.css`
still shows the old label-sized tab rule; it is generated from the Claude
Design artifact and was left for a design pull rather than hand-edited.

## Epic 8.1 pilot fixes — the Running pane (issues #265, #272, #273)

**System listeners.** The workspace agent now marks each listening port as
the student's or the system's and reports it as `system` on the listening
contract. A listener is the system's when its owning process id is the
agent's own, or when the socket's uid is below 1000, which covers
systemd-resolved, sshd and dnsmasq. A port published by an inner Docker
container is the student's, even though `docker-proxy` holds the socket as
root. The Running pane hides system rows behind a "Show system services"
checkbox, off by default and remembered in `localStorage`. Nothing about
preview authorization or the port deny list changed (issue #265, SPEC.md
section 18.2).

**Row actions.** Each previewable row has Open preview, an Open in new tab
icon, and Stop. Open in new tab uses the same single-tab pattern as the
Preview tab: the blank tab is opened inside the click and then pointed at
the bootstrap URL. That code now lives once, in
`apps/web/src/preview/grants.ts`. The "Preview" chip is gone; only the
Docker chip remains, and a row that cannot be previewed says why
("reserved port" or "system service") in place of the preview actions
(issue #272, SPEC.md section 18.2).

**Stop.** `POST /workspaces/:id/listening/:port/stop` proxies the agent's
`POST /listening/:port/stop` behind the owner gate. The agent sends
SIGTERM, then SIGKILL after three seconds, and runs `docker stop` for a
container row instead of signalling the process. It refuses a system
listener with 403, an unlisted port with 404, and a process that survives
SIGKILL with 409. The browser confirms first, naming the command and the
port. The row disappears on the next scan, and a Preview tab on that port
shows its inactive state on its own (issue #273, SPEC.md section 18.2).

Known gaps. The Running pane borrows the preview stylesheet's classes for
the new toggle row and the actions cell; the pane's own stylesheet under
`apps/web/src/running/` is another task's work.
