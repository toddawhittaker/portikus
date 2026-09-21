# Backlog

Work that is wanted but not yet scheduled as an epic or task. Each entry
says what, why, what it would take, and where it came from. Known gaps left
by landed work stay in `docs/STATUS.md`; move one here when it becomes
something we intend to build. Remove an entry when its work lands or when
it is rejected, and record the rejection in `docs/STACK.md` section 35.

## `apt install portikus` on a bring-your-own Debian 13 host

**What.** An operator with their own Debian 13 machine, virtual or bare
metal, runs one `apt install portikus`, edits a config file, and runs one
`portikus configure` command to get a working platform. Today the control
plane is one package but the host setup is nine Ansible roles driven from
a workstation, and the documented path starts from a libvirt VM
(`infra/README.md`, "Bring your own Debian host").

**Why.** The pilot runs in a VM we build, but the design is already
"Debian 13 host plus Ansible plus one package". Dedicated hardware is the
better fit for more than a handful of students, and nested virtualization
is only needed because the pilot puts containers inside a VM.

**What it would take** (about a week, in this order):

1. A variable audit of the roles (half a day, can be its own PR): the
   `deploy` account name, the two `/dev/vdb` checks in the smoke test, and
   the Makefile's `PORTIKUS_PUBLIC_HOST` default, all listed under "Limits
   today" in `infra/README.md`.
2. A signed apt repository published by CI from each release, with the
   signing key kept out of the repository. One day.
3. A `portikus configure` command that reads `/etc/portikus/portikus.yaml`
   (public URL, OIDC issuer and client id, administrator group, data block
   device, grace period, log level) plus a mode-0600 secrets file, and
   applies the existing roles against localhost by shipping them in the
   package with `ansible-core` as a dependency. Two to three days. Rewriting
   the roles in shell would be cleaner for operators but is a multi-week
   job; not worth it until a second deployment exists.
4. Package dependencies: `incus`, `postgresql-17`, `caddy`, `nftables`,
   `lvm2`, `zip`, and Node 24, which Debian 13 does not ship, so either
   bundle a runtime or depend on NodeSource. The workspace image becomes a
   release asset that `configure` downloads and imports by version. One day.
5. A fresh-Debian install test on this host. One day.

Commit to Debian 13 only. Ubuntu 24.04 lacks Incus in its archive and ships
PostgreSQL 16, so supporting it means external repositories for both.

**Source.** Todd, 2026-09-17, during the structured logging task. Schedule
after Epic 7; the pilot does not need it.

## Request rate limiting and journal sizing

**What.** A rate limit in Caddy for the API, and explicit journald
`SystemMaxUse` and per-service `RateLimit*` settings in the Ansible
`portikus` role.

**Why.** Nothing rate-limits login (known gap since Epic 4), and since
structured logging every 4xx writes a warn line, so a flood of bad
requests can evict older journal entries. Both fixes are small and belong
together.

**Source.** Security review of the structured logging task, 2026-09-17.

## Parallel worker sweep

**What.** Start and stop operations run with a bounded concurrency, and each
workspace's timers are computed independently of any start in flight.

**Why.** The sweep is serial today, so one slow workspace start delays every
other workspace's timers. The spec says to revisit this before the
25-concurrent-workspace target of §25.2.

**What it would take.** Split the sweep into timer work, which stays
in-line and cheap, and operations, which go through a small concurrency
limit. Half a day plus a test that a slow start does not delay a timer.

**Source.** `docs/SPEC.md` around line 2223, Epic 3 known gaps, §25.2.

## Re-provision after a failed create

**What.** An administrator action that retries a workspace stuck in `error`.

**Why.** There is no re-provision path today: the row stays in `error` and
an operator clears it by hand in SQL.

**What it would take.** An admin route that resets the row to a state the
worker will pick up again, an audit row recording who did it, and a button
on the administration page. About a day.

**Source.** `docs/SPEC.md` around line 2225, Epic 3 known gaps.

## OpenAPI generation from the Zod contracts

**What.** Generate an OpenAPI document from the schemas in
`packages/contracts` and serve or publish it.

**Why.** ADR 0003 chose Zod contracts partly so the API could describe
itself; that generation was never wired up.

**What it would take.** Add the Zod-to-OpenAPI step to the contracts build,
attach descriptions to the route schemas, and check the generated document
in CI. About a day.

**Source.** `docs/SPEC.md` around line 2227, Epic 3 known gaps, ADR 0003.

## Mark workspace state unverified when the controller is unreachable

**What.** When the worker cannot reach the controller, the API says the
state is unverified instead of reporting the last known state as fact.

**Why.** Today a student sees a confident but possibly stale state while the
controller is down.

**What it would take.** Record the last successful reconcile time, add an
`unverified` flag to the workspace response once it is too old, and show it
in the status bar. Half a day.

**Source.** `docs/SPEC.md` around line 2229, Epic 3 known gaps.

## Terminal row pruning and a race-free terminal cap

**What.** Two small fixes in one: the worker deletes ended terminal rows
older than a set number of days, and the eight-terminal cap is enforced
without a check-then-act race.

**Why.** Ended rows are never pruned, so the table only grows (a listing
just hides all but the 20 most recent). The cap check is benign today but
two fast requests can both pass it.

**What it would take.** A delete in the worker's sweep, and either a
database constraint or a per-workspace advisory lock around the create.
Half a day with tests.

**Source.** `docs/STATUS.md`, Epic 5 known gaps.

## Atomic project rename

**What.** A rename that leaves no broken state if the process dies partway.

**Why.** Rename moves the directory in the agent and updates the database
row separately. A crash between them loses the old row and the new
directory is then discovered as a second project.

**What it would take.** Write the new row as pending first, move the
directory, then commit the row, with discovery ignoring pending rows and a
sweep clearing stale ones. About a day.

**Source.** `docs/STATUS.md`, Epic 6 known gaps.

## Size cap on zip downloads

**What.** A configured limit on the size of a project download, with a clear
error above it.

**Why.** Downloads stream with no cap, so one large project can tie up the
agent and the browser gets a very long transfer.

**What it would take.** The agent measures the tree before streaming and
refuses over the limit; the web app shows the message. Half a day.

**Source.** `docs/STATUS.md`, Epic 6 known gaps.

## Per-change coverage threshold

**What.** A CI check that fails when the lines a pull request adds or
changes are covered below a threshold, separate from the repository-wide
floors in `vitest.config.ts`.

**Why.** The floors measure the whole codebase, so a large untested file
only nudges the totals and can pass. New code has no legacy to hide
behind, so a stricter bar on changed lines is fair.

**What it would take.** A short TypeScript script in `scripts/` that reads
`coverage/lcov.info`, takes the changed line ranges from `git diff -U0
origin/main...HEAD`, skips the same paths the vitest coverage config
excludes, and exits non-zero below the threshold (80% of changed lines is
the common choice). Run it in the app job after `pnpm test:coverage`, with
a fetch depth that includes `main`. No new dependency; `diff-cover` and
hosted services were considered and rejected for adding a toolchain or an
external service. Half a day.

**Source.** Todd, 2026-09-17, after the coverage floor landed in PR 101.

## LTI 1.3 launch from the learning management system

**What.** A student opens Portikus from a course in Canvas or Moodle and
lands in their workspace without a separate sign-in. SPEC.md section 3
requires the architecture to leave room for it; section 31 lists it as a
future capability.

**Why.** For a course, the LMS is where students already are, and the launch
carries the course and roster context that instructor-managed templates
and roster provisioning would need later.

**What it would take.** An LTI 1.3 launch is an OpenID Connect flow in
which the LMS is the issuer, so it becomes a second way to create the same
session row beside the existing login: platform registration and key
management (JWKS), launch validation with nonce and state, mapping LMS
roles to `student` and `administrator`, deciding whether an LTI-launched
user also gets a plain login, and a test harness that plays the LMS. One
to two weeks; a post-pilot epic candidate.

**Source.** Todd, 2026-09-17.

## Student processes in their own cgroup, with a kill-all action

**What.** Run the student's shells and programs in a cgroup separate from
the workspace agent, with a task ceiling below the container's process
limit, and give the terminal pane a "Stop all my processes" action.

**Why.** Today the agent runs as `student` and every shell is a child of
its tmux sessions, so a fork bomb or a runaway build exhausts the same
process and memory budget the agent needs. The terminal goes dead and the
only recovery is stopping and starting the whole workspace from the
header, which loses running programs. With the agent guaranteed headroom,
a student can recover from the UI in seconds. SPEC.md 19.1 asks for a
"configurable defensive ceiling"; the container-level `limits.processes`
is the first half, this is the second.

**What it would take.** The agent starts each tmux server through
`systemd-run --user --slice=student-work.slice` (or a scope) with
`TasksMax=` set from configuration; the image gains the slice unit; the
agent gets a route that kills every process in that slice and the pane
menu calls it with a confirmation; a smoke-test check that a fork bomb in
a workspace leaves the agent's `/health` answering. Half a day to a day.
Belongs with the Epic 10 reset workflows.

**Source.** Todd, 2026-09-17, asking whether a student can recover from a
fork bomb on their own.

## Regular-expression and case options for search

**What.** Toggles in the search panel for a regular expression, case
sensitivity and whole-word matching.

**Why.** Search is literal and case-insensitive today, which is the right
default but makes some searches impossible.

**What it would take.** Three flags in the search query contract, mapped to
the ripgrep flags the agent already builds, and three controls in the panel.
Half a day with tests.

**Source.** `docs/STATUS.md`, Epic 7.

## File and diff panes inside terminal splits

**What.** Let a file or diff tab be dragged into a split beside a terminal,
so a student can read code next to the shell that is building it.

**Why.** A document tab is a single leaf today, so the only side-by-side
view is the browser's own window splitting.

**What it would take.** Drop the single-leaf restriction in
`apps/web/src/layout/tree.ts`, decide what the split-depth and tab caps mean
for mixed trees, and extend the saved layout schema. Two days, mostly
testing the layout rules.

**Source.** `docs/STATUS.md`, Epic 7.

## Watcher coverage of hidden and generated directories

**What.** Push filesystem events for changes inside hidden and generated
directories while the student has hidden files turned on.

**Why.** The watcher skips those directories, so with hidden files shown the
tree goes stale until the next refetch.

**What it would take.** A second, narrower watcher started only while a
browser asks for hidden files, so the everyday case keeps its small watch
set. A day, including the watch-count cost.

**Source.** `docs/STATUS.md`, Epic 7.

## Raise `fs.inotify.max_user_watches` in the workspace image

**What.** A sysctl in the workspace image that raises the per-user inotify
watch limit.

**Why.** One chokidar watcher per open project uses one inotify watch per
directory. The Debian default is generous, but a pilot repository with a
very large tree could exhaust it, and the failure shows up as a tree that
stops updating rather than an error.

**What it would take.** A sysctl drop-in in the image build plus a check in
the smoke test. Half a day, and only worth doing if the pilot hits it.

**Source.** `docs/STATUS.md`, Epic 7.

## Configurable upload size cap

**What.** Make the 50 MiB upload limit a setting instead of a constant.

**Why.** The limit is a fixed number in the contracts package today, so
changing it means a release. A course with large data files may need a
different number.

**What it would take.** A row in the `settings` table, read by the API and
passed to the agent, with the browser showing the current limit in its
message. Half a day.

**Source.** `docs/STATUS.md`, Epic 7.

## Markdown relative images through the file route

**What.** Render an image a Markdown file refers to by a relative path.

**Why.** A README that shows a screenshot from the repository renders a
broken image today, because the browser resolves the path against the app's
origin rather than the project.

**What it would take.** Rewrite relative image sources in the preview to the
existing file download route for that project, and refuse anything that is
not a relative path. Half a day.

**Source.** `docs/STATUS.md`, Epic 7.

## Compare against a recovery point or another ref

**What.** Diff the working tree against a recovery point (SPEC.md section
12.6, P1) and later against any Git commit or ref (P2).

**Why.** The spec names both as the next steps after the `HEAD` comparison,
and a recovery point is the comparison a student wants after an agent has
changed a lot at once.

**What it would take.** The recovery-point comparison needs Epic 10's
archives first, plus a way to read one file out of an archive without
unpacking it. The ref comparison is a parameter on the existing agent diff
route and a picker in the UI. Two days for the first, half a day for the
second.

**Source.** `docs/SPEC.md` section 12.6.

## Retarget an open tab when its file moves

**What.** When a file is renamed or moved, the tab that has it open follows
it instead of showing a deleted-file banner.

**Why.** Renaming a file from the tree, or an agent moving it, leaves the
open tab pointing at a path that no longer exists.

**What it would take.** Match the move against open tabs, in the tree for a
UI rename and against the events batch otherwise, and rewrite the tab's
path. Half a day; the agent case is a guess, since the events stream reports
a delete and a create rather than a move.

**Source.** `docs/STATUS.md`, Epic 7.

## Prompt before a rename replaces an existing file

**What.** Renaming or moving onto an existing name asks before replacing it.

**Why.** The agent refuses the move today and the browser shows an error, so
the student has to delete the other file first.

**What it would take.** A confirmation in the tree and a replace flag on the
move route, which the agent only honours for a file, never a directory. Half
a day.

**Source.** `docs/STATUS.md`, Epic 7.

## Directories with more than 2,000 entries

**What.** Show the rest of a directory that was truncated at the listing cap.

**Why.** A listing stops at 2,000 entries and says it was truncated, which is
honest but leaves the remaining files unreachable from the tree.

**What it would take.** A continuation token on the listing route and a "show
more" row in the tree. A day. Paging the whole tree would be more work than
the case deserves.

**Source.** `docs/STATUS.md`, Epic 7.

## Cap on concurrent searches in the agent

**What.** A limit on how many ripgrep processes the agent runs at once.

**Why.** Each search is bounded in time and output, but nothing bounds how
many run together, so several browser windows typing at once can load the
container.

**What it would take.** A small queue in the agent's search route that
refuses or waits past the limit, and a message in the panel. Half a day.

**Source.** Security review of Epic 7.

## Write rate limit per workspace in the API

**What.** A ceiling on file writes per workspace per minute in the control
plane.

**Why.** Autosave writes on a debounce, and nothing stops a stuck client or
a script from writing continuously through the API.

**What it would take.** A counter per workspace in the file routes, shared
with the rate-limiting work already in this backlog. Half a day.

**Source.** Security review of Epic 7.

## Keep `fake-agent.ts` out of the deployed build

**What.** Exclude the test fake agent from the Debian package.

**Why.** It ships today as dead code in the published package. It is not
reachable, but a test double does not belong on a production machine.

**What it would take.** Move it under a test directory the build excludes,
or exclude the file in the package's file list, and assert its absence in
the package test. An hour.

**Source.** `docs/STATUS.md`, Epic 7.

## Short object id for a detached HEAD

**What.** Show the short commit id when the repository is on a detached
`HEAD`.

**Why.** The status bar says "detached" with nothing after it, so a student
cannot tell which commit they are on without the command line.

**What it would take.** One more field in the Git status contract, filled
from the status output the agent already parses, and a change to the status
bar. An hour.

**Source.** `docs/STATUS.md`, Epic 7.

## Syntax highlighting in Markdown code blocks

**What.** Highlight fenced code blocks in the Markdown preview.

**Why.** Code in a README renders as plain text, which is the one place
students read example code most often.

**What it would take.** A remark or rehype highlighting plugin, or reusing
Monaco's own tokenizer so the bundle gains nothing new. Half a day, and the
second option is worth trying first.

**Source.** `docs/STATUS.md`, Epic 7.

## One filesystem watcher shared by the terminal and events pipes

**What.** A single watcher per project feeding both the events socket and
whatever the terminal side needs, instead of a watcher per purpose.

**Why.** Epic 9's session change review will want the same events, and a
second watcher doubles the inotify cost for the same information.

**What it would take.** Make the agent's watcher registry the one source of
filesystem events and have every consumer subscribe to it. Half a day, best
done as part of Epic 9 rather than on its own.

**Source.** Epic 7 review, 2026-09-18.

## One merged zip for a multi-file download

**What.** Selecting several files or folders in the files pane and getting
back one zip, instead of one download per selected row.

**Why.** Epic 7.1's multi-row selection (#182–#186) can select many rows at
once, but the download route only ever takes a single path, so a large
selection opens one download per row, which the browser throttles and a
student has to save one at a time.

**What it would take.** A workspace-agent endpoint that takes a list of
paths and streams one zip back, plus a control-plane route that relays it
under the same authorization and byte caps as the existing download route.
About a day, including the path-confinement checks each path needs on its
own.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Source-line scroll mapping in the Markdown split view

**What.** Scroll the preview to the line that corresponds to where the
student is editing, instead of keeping the two sides at the same relative
scroll position.

**Why.** Epic 7.1 (#154) fixed split view drifting apart, by syncing the
two sides' relative scroll position, but a long document with short and
tall sections still leaves the preview a little off from the exact line
being edited.

**What it would take.** A source-map from Markdown source lines to
rendered DOM nodes, built while parsing, and using it instead of the
relative-position sync on both sides. Half a day; worth doing once a pilot
student notices the drift on a long document.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Codex agent configuration, including its update-check setting

**What.** The same kind of environment and configuration control Epic 7.1
gave Claude Code's self-updater (`DISABLE_AUTOUPDATER=1` in
`/etc/profile.d/portikus-agents.sh`, #127), extended to Codex and folded
into whatever general agent-configuration story Epic 9 builds.

**Why.** Codex has no equivalent environment variable; its update check is
a config file setting (`check_for_update_on_startup` in
`/etc/codex/config.toml`), which is one small piece of a larger question
about how the platform configures every coding agent it ships, better
answered once rather than agent by agent.

**What it would take.** Part of Epic 9's agent configuration work; no
separate estimate. Issue #129 stays open for it.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Per-run e2e ports and database

**What.** Give each Playwright run its own set of ports and its own
database, instead of the fixed ports and one shared `TEST_DATABASE_URL`
several agents' local runs use today.

**Why.** Epic 7.1 added a setup check that stops a run cleanly when the
API under test reads a different database than the test helpers write to,
which is what several agents running the suite on this host at once used
to trip over. The check catches the collision instead of preventing it;
two agents still cannot run the full suite on this host at the same time.

**What it would take.** Pick each run's web, API, and worker ports from a
free range instead of a fixed list, and give each run's Playwright
workers a database name derived from the run's process id, the way the
unit test suite already does for database test files. About half a day.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Reference-style Markdown links and images in the Rich view

**What.** Support reference-style links and images, written as
`[text][id]` with the address given elsewhere in the file, in the rich
Markdown view instead of sending the tab to Code view whenever one
appears.

**Why.** The importer that turns Markdown into the rich view's document
model has a handler for inline links and images but not the
reference-style form, so a file that uses it looks unreadable in the one
view most students will use.

**What it would take.** A visitor for the reference-style link and image
nodes, mirroring the one already written for inline links and images,
plus a definition-node visitor that keeps the referenced address in the
document model without rendering it as its own line. About a day,
including tests.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Relative Markdown image paths resolve against the workspace, not the app origin

**What.** A relative image path in a Markdown file (for example
`![diagram](./diagram.png)`) should resolve against that file's location
in the project, the way a browser resolves a relative link on a normal
page, instead of against the web app's own origin.

**Why.** The rich Markdown view now renders images from an allowlisted
address, but a relative path is handed to the browser unchanged, so it
resolves against `https://<app host>/...` rather than the file's own
folder, and the image shows as broken.

**What it would take.** Rewrite a relative image address to the
workspace's file-read route for that project and path before handing it
to the renderer, the way the file tree already builds download links.
About half a day, including tests for a nested-folder Markdown file.

**Source.** `docs/STATUS.md`, Epic 7.1.

## Remote browser for loopback OAuth callbacks

**What.** A browser that Portikus runs on the server, sharing only the
workspace's network namespace, so that a command-line tool whose OAuth
login must call back to `127.0.0.1:<port>` inside the workspace can
finish. The student would drive it from a Browser tab in the center
pane; frames and input would travel over the Chrome DevTools Protocol
(Xpra as the fallback if that is not usable enough).

**Why.** Opening such a login in the student's own browser cannot work,
because `localhost` there means the student's computer, and the redirect
URL is registered with the provider and cannot be rewritten
(`docs/BROWSER-HANDLING.md` section 20). Today no supported tool needs
it: Codex has device-code login, Claude Code accepts its code pasted back
into the terminal, and Epic 9 adds institutional credential injection.
It becomes wanted only if a required tool ships with no out-of-band path.

**What it would take** (a spike first, then roughly a week if it passes):

1. A spike proving Chromium can share the workspace's network namespace
   while keeping its own mount, PID, and user namespaces, an ephemeral
   profile the student cannot read, and a control channel over a pipe
   or protected Unix socket that no workspace process can reach. If
   Incus cannot do this without broader privilege, stop and write an ADR.
2. Measuring typing and pointer latency, frame rate on real login pages,
   HiDPI, paste, popups, MFA and CAPTCHA pages, and CPU and memory per
   session. The feature is accepted only if login pages are comfortably
   usable; this is a gate, not a foregone conclusion.
3. Lifecycle: one session per user, started only on the student's
   choice, a visible notice that the page runs on institution-managed
   infrastructure, idle warning at three minutes and termination at five,
   termination with the workspace or the Portikus session, profile
   deleted afterwards, and no screenshots, form data, cookies, or full
   URLs in logs. Password saving, sync, extensions, downloads, and device
   permissions off. Read-only address bar. No access to other workspaces
   or platform management endpoints.
4. Acceptance: a fake local OAuth provider's loopback callback completes
   through it; the workspace cannot discover the control channel or read
   the profile; passkey-only flows fail with a clear pointer to a device
   or external flow.

**Where it came from.** Cut from `docs/BROWSER-HANDLING.md` on
2026-09-19, when the remote browser was judged the most expensive and
security-sensitive piece in that design and unneeded by either P0 agent.


## A separate preview domain with partitioned cookies

**What.** Serve student application previews from their own registrable
domain, for example `*.portikus-preview.example`, instead of from a
subdomain of the Portikus application host, with the preview session
cookie partitioned by top-level site so it is not shared across sites.

**Why.** ADR 0018 chose the same-site shape for Epic 8 because it needs
no extra DNS and no extra certificate. A separate domain removes the
related-domain risks of `docs/BROWSER-HANDLING.md` section 9.3 entirely:
a student application could then not plant a cookie on a name the
Portikus host also reads.

**What it would take.** A second DNS name and certificate in the Ansible
Caddy role, a configuration switch that changes the cookie from
`__Host-` and `SameSite=Strict` to a partitioned cross-site cookie, and
a browser matrix that proves the flow in current Chrome, Firefox and
Safari, since partitioned cookie support differs between them. Roughly
three days, most of it the browser matrix.

**Source.** ADR 0018 and `docs/STATUS.md`, Epic 8.

## Camera and microphone in the preview iframe

**What.** A way for a student application that needs the camera or the
microphone to get them inside the Preview tab, instead of only in a
separate browser tab.

**Why.** ADR 0018 denies camera, microphone and geolocation in the
iframe's permissions policy, which is the right default. A course about
media or computer vision would want an exception.

**What it would take.** A per-workspace or per-preview opt-in that a
student turns on knowingly, the matching `allow` attribute on the frame,
and a decision about whether an administrator may switch it off for a
cohort. About a day, plus a design review of the consent wording.

**Source.** ADR 0018 consequences and `docs/STATUS.md`, Epic 8.

## Persisted check runs and check history

**What.** Store the result of each check run — when it ran, how long it
took, whether it passed, and its output — instead of keeping only the
latest runs in the workspace agent's memory.

**Why.** Today a check's result is gone when the workspace stops or the
agent restarts, so a student cannot show that a check passed earlier and
an instructor cannot see a trend. `docs/SPEC.md` section 25 lists check
result metadata that is currently produced but never kept.

**What it would take.** A `check_runs` table, a route that writes a
finished run through the control plane, retention so output does not
grow without bound, and a history list in the Checks pane. About two
days.

**Source.** `docs/STATUS.md`, Epic 8 decisions.

## `PORTIKUS_PREVIEW_*` environment hints for project templates

**What.** Set environment variables in each terminal that tell a
development server what its public preview origin will be, as
`docs/BROWSER-HANDLING.md` section 14 describes.

**Why.** Frameworks such as Vite check the `Host` header and need to be
told the external origin before hot module reloading works smoothly.
Today a student edits the framework's configuration by hand.

**What it would take.** Compute the values when a terminal starts, pass
them through the agent's terminal spawn, and document the one-line
configuration each supported framework needs. About a day.

**Source.** `docs/BROWSER-HANDLING.md` section 14; left out of PR #251.

## Move the last client-side port minimum into server policy

**What.** Remove the 1024 minimum still hard-coded in the terminal link
handler and the web app's preview route, and take that limit from the
API the way the launcher and the Running pane now do.

**Why.** The port policy lives in the API (`PREVIEW_PORT_MIN`,
`PREVIEW_PORT_MAX`, `PREVIEW_DENIED_PORTS`). Two copies in the browser
can disagree with it, so a deployment that allows a lower port would see
a terminal link silently refuse to open.

**What it would take.** Serve the policy to the browser once per
workspace, or let a Preview tab open and show the API's own refusal.
Half a day.

**Source.** `docs/STATUS.md`, Epic 8 known gaps.

## A total quota on saved layout

**What.** A limit on how much layout one user can store in total, not
only on the size of a single save request.

**Why.** Epic 8 removed the tab cap, and the only bound left is
Fastify's 1 MiB body limit per request plus the shape checks on each
tab. A user with many workspaces and projects can therefore hold a large
amount of layout in the database.

**What it would take.** Count stored layout bytes per user, refuse a
save past the limit with a clear message, and decide whether to prune
the oldest project layouts instead. Half a day.

**Source.** `docs/STATUS.md`, Epic 8 known gaps.

## Docker container identity when the socket is unavailable

**What.** Name the container behind a published port in the Running pane
even when `docker ps` cannot be run.

**Why.** Listener discovery matches published ports to containers with
`docker ps`. If the Docker socket is missing or slow, the row falls back
to `unknown` and the student cannot tell which service it is.

**What it would take.** Read the container identity from the process
tree or from the published-port rules in the container runtime's own
state instead of shelling out, with a test for a workspace whose Docker
daemon is stopped. About a day.

**Source.** `docs/STATUS.md`, Epic 8 known gaps.

## A stronger binding between a preview grant and its presentation

**What.** Prove that a bootstrap ticket made for an embedded preview is
really being opened in a frame, and one made for a top-level preview in
a top-level tab, by something better than the `Sec-Fetch-Dest` request
header.

**Why.** `Sec-Fetch-Dest` is set by the browser and is trustworthy in
current browsers, but a client that omits it is still accepted, so the
check tightens the door rather than closing it.

**What it would take.** Research first: candidates are a frame-ancestor
check on the bootstrap answer, a nonce the parent document passes into
the frame and the bootstrap route verifies, or refusing requests with no
fetch metadata at all once every supported browser sends it. Half a day
of research, then a day to build.

**Source.** Epic 8 security review; `docs/STATUS.md`, Epic 8 known gaps.
