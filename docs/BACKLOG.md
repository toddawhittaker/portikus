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
