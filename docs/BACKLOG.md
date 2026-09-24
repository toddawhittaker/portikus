# Backlog

Work that is wanted but not yet scheduled as an epic or task. Each entry
says what, why, what it would take, and where it came from. Known gaps left
by landed work stay in `docs/STATUS.md`; move one here when it becomes
something we intend to build. Remove an entry when its work lands or when
it is rejected, and record the rejection in `docs/STACK.md` section 35.

## `apt install portikus` on a bring-your-own Debian 13 host

**Scheduled as Epic 15.** `docs/EPIC-15.md` is now the plan, after Epic 14
(`docs/EPIC-14.md`); it keeps this entry's shape (Debian 13 only, the
Ansible roles shipped in the package, a signed apt repository, the image
as a release asset, a fresh-install test) and adds debconf questions and
an admin Workspace image section. Remove this entry when Epic 15 lands.
The text below is the original proposal.

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

**Shipped** as Epic 13 (`docs/EPIC-13.md`, ADR 0025): the core launch, the
`instructor` role and a read-only Course page. What it left out is listed
in the LTI entries at the end of this file.

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
the terminal's working-directory updates, instead of a watcher per purpose.
Session review already subscribes to the existing project watcher (Epic 9,
PR #308). The terminal's own poll of its current directory was left in
place on purpose and is not part of that subscription.

**Why.** A second watcher doubles the inotify cost for the same
information. The session-review half of that is done. The terminal poll
is the part still separate.

**What it would take.** Have the terminal's directory updates come from
the agent's existing watcher registry, and remove the poll only then.
Half a day.

**Source.** Epic 7 review, 2026-09-18. Updated after Epic 9, 2026-09-21.

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

## Zip-slip tests for archive extraction

**What.** Traversal tests for any code path that extracts an archive a
student provides, checking that an entry named like `../../etc/passwd`
or an absolute path cannot write outside the intended directory.

**Why.** Epic 12a's filesystem escape suite covers every path a student
can name directly. Epic 10's recovery restore now extracts an archive,
and its tests cover symlinks, but no test yet feeds it an archive with a
hostile entry name. Epic 12b did not add one.

**What it would take.** Add traversal and absolute-path entries to the
tests of `apps/workspace-agent/src/recovery.ts`, following the pattern in
`apps/workspace-agent/src/security/path-escape.test.ts`. Half a day.

**Source.** `docs/EPIC-12A.md`, decisions; `docs/STATUS.md`, Epic 12a.

## Optional content-length on downloads

**What.** Send a `Content-Length` header on a project, folder, or file
download when its size is already known, instead of always chunking.

**Why.** Streaming a zip through a pipe means the size is not known in
advance, but a single file, or a zip written to a temporary file first,
does have a known size, and a known length lets a browser show a
progress bar and lets a client detect a truncated download.

**What it would take.** Send the header when the size is available and
fall back to chunked transfer otherwise. About half a day, after
deciding whether it is worth a special case for the single-file path.

**Source.** `docs/STATUS.md`, Epic 12a (PR #440, the temporary-file zip).

## Group the security harness's connection lines by workspace

**What.** In the VM security suite's before-and-after snapshot, list each
other workspace's presence and other live connections together under
that workspace, instead of as one flat count.

**Why.** The snapshot already proves nothing changed, but a flat count
makes a failure harder to read: an operator has to guess which
workspace's connections moved.

**What it would take.** Group the snapshot's connection lines by
workspace id when building the fingerprint and the diff. About half a
day, in `infra/tests/security/lib.sh`.

**Source.** `docs/STATUS.md`, Epic 12a (PR #440).

## A run lock for the security suite across machines

**What.** `make security-test` already refuses to run twice from one
machine at once. Extend the lock so two different machines running it
against the same VM at the same time are also refused, rather than
relying on the live-process check alone.

**Why.** The current lock is a local `flock` plus a check that no
`/tmp/portikus-sectest-<id>` directory has a live process on the VM. That
check works today, but it depends on process liveness rather than an
explicit lock the VM itself holds, so a race at the moment a run starts
is still conceivable.

**What it would take.** A lock file or advisory row taken on the VM
itself at the start of a run, checked before minting any user. About half
a day.

**Source.** `docs/EPIC-12A.md`, "Rules for the VM suite"; `docs/STATUS.md`,
Epic 12a (PR #440).

## A shared point-insert helper for the API and the worker

**What.** One function that creates a `recovery_points` row and writes
its archive, called by both the API (manual points and restore's safety
point) and the worker (periodic, before-archive, and before-rebuild
points), instead of each keeping its own copy of the same sequence.

**Why.** Epic 10 built the API and worker paths in separate task pull
requests against a shared contract, so each ended up with its own
version of "call the agent, then insert the row, then stamp the
project". They agree today, but a future fix, such as the point-count
cap or the retry-on-agent-unavailable behaviour, has to be made twice.

**What it would take.** Pull the shared steps into a
`packages/db`-adjacent helper or a small shared package, with the
agent-calling part left to each caller. About half a day, including
moving the existing tests.

**Source.** `docs/STATUS.md`, Epic 10 known gaps.

## Reconcile orphan recovery archives against their rows

**What.** A periodic or on-demand check that lists the files under each
workspace's recovery volume and compares them with the `recovery_points`
rows, and handles every mismatch: an archive with no row (delete it), an
archive that is deleted while a restore is reading it (retry or fail the
restore cleanly, not silently), and old `.portikus-aside-*` and
`.portikus-restore-*` folders left behind by an incomplete restore.

**Why.** Epic 10 accepted an orphan archive as a known gap (`docs/EPIC-10.md`,
risk 8): the API can crash between the agent writing an archive and the
row being inserted. Rollback copies from a failed restore are also never
cleaned up automatically today (`docs/STATUS.md`, Epic 10 known gaps).
Left alone, both slowly eat the recovery quota.

**What it would take.** A worker sweep, similar to the existing retention
sweep, that lists each workspace's recovery directory through the agent
and deletes anything with no matching row past some age, plus ages out
`.portikus-aside-*` folders after a fixed period. One to two days,
including the busy-delete race with an in-progress restore.

**Source.** `docs/EPIC-10.md` risk 8; `docs/STATUS.md`, Epic 10 known gaps.

## Recovery quota backfill should follow `WORKSPACE_RECOVERY_SIZE_GIB`

**What.** Migration 0013's backfill of `quota_config.recoveryGiB` for
existing workspaces should read the deployment's configured
`WORKSPACE_RECOVERY_SIZE_GIB` instead of writing a hard-coded 3.

**Why.** A deployment that has already changed the environment variable
away from its default gets existing workspaces stamped with the wrong
number, which then never matches what the controller actually
provisions until each workspace is rebuilt.

**What it would take.** A small follow-up migration that re-runs the
backfill using the current environment value, or a one-off script run at
deploy time. Half a day.

**Source.** `docs/STATUS.md`, Epic 10 known gaps.

## Let a student clear a kept rollback copy from the UI

**What.** A button, most likely in the Recovery points dialog, that
deletes a `.portikus-aside-<pointId>` folder a failed restore left
behind, once the student has checked it and no longer needs it.

**Why.** Epic 10's restore keeps this folder rather than lose files on a
failed rollback, but today the only way to remove it is a terminal
command, and a student who does not know it exists can slowly fill their
project storage.

**What it would take.** An agent route to list and delete a project's
aside folders, and a small addition to the Recovery points dialog. About
a day, including the confirmation copy explaining what the folder is.

**Source.** `docs/STATUS.md`, Epic 10 known gaps; PR #431, #435.

## A dedicated API error code for rate limits

**What.** A new `ApiErrorCode` such as `RATE_LIMITED`, used wherever a
request is refused only because the caller is going too fast, instead of
reusing `BUSY`.

**Why.** Epic 10 answers 429 with code `BUSY` when a project's manual
recovery-point rate limit is hit (`docs/EPIC-10.md` task 5 review fixes),
the same code the agent's per-project lock uses for "another operation
on this project is already running". A client cannot tell "try again in
a moment" from "wait for the other operation to finish" apart without
also checking the HTTP status.

**What it would take.** Epic 12b added `RATE_LIMITED` for the sign-in
throttle, so what is left is to switch Epic 10's recovery-point
rate-limit responses to it and update the handful of tests that assert on `BUSY` for a rate limit today. Half a day.

**Source.** `docs/EPIC-10.md`, task 5 review fixes; PR #428.
## OpenTelemetry export

**What.** Export the operational metrics that today live only in
PostgreSQL's `health_samples` table and `audit_events` counts to an
OpenTelemetry collector, once there is somewhere for it to send them.

**Why.** ADR 0022 chose PostgreSQL over an OpenTelemetry SDK because the
pilot is one VM with nothing to scrape a metrics endpoint. A second VM, a
managed database, or an external monitoring service would change that.

**What it would take.** An OpenTelemetry SDK in the worker, a collector
to send to, and a decision on whether `health_samples` keeps running
alongside it or is replaced. About two days once a destination exists.

**Source.** `docs/STATUS.md`, Epic 11; ADR 0022.

## Audit retention policy

**What.** A policy that ages out or archives old `audit_events` rows,
rather than keeping every row forever.

**Why.** SPEC.md section 25.10 asks for a retention policy, and Epic 11
added several new, higher-volume audit sources (`preview.denied`,
`user.role_changed`, and the workspace lifecycle actions) without adding
one.

**What it would take.** Decide a retention window per action type, a
sweep job similar to the one that already prunes `health_samples` after
7 days, and a decision on whether old rows are deleted or exported
first. About a day.

**Source.** SPEC.md section 25.10; `docs/EPIC-11.md`, "Out of this epic".

## Per-workspace CPU, memory, and process limits

**What.** Let an administrator set CPU, memory and process limits on one
workspace, rather than every workspace sharing the limits in the one
Incus profile that Ansible owns.

**Why.** Epic 11's Health tab shows the profile's shared limits but does
not let anyone change them per workspace; today a single misbehaving
workspace is bounded only by the platform-wide profile.

**What it would take.** A per-instance Incus limit override, a place to
store the chosen values, and admin UI to set them. About two days.

**Source.** `docs/EPIC-11.md`, "Out of this epic".

## Egress allow-list (issue #284)

**What.** Let an administrator restrict which external hosts a
workspace's outbound network traffic can reach, beyond the private-range
and host deny list.

**Why.** SPEC.md and issue #284 ask for administrator control over
egress. PR #424 already added a deny list that keeps workspace traffic
off private network ranges and the platform host itself, which closes
one class of risk (a workspace reaching the platform's own internal
services) but is not the allow-list itself.

**What it would take.** A policy store, an enforcement point (likely
nftables rules per workspace, alongside the existing deny list), and
admin UI in the Settings tab, which Epic 11 left a place for. About two
days.

**Source.** Issue #284; `docs/EPIC-11.md`, "Settings tab" and task 7.

## Bulk admin actions

**What.** Let an administrator act on more than one workspace or account
at a time, for example disabling several stale accounts together.

**Why.** Epic 11's Workspaces tab acts on one row at a time. A pilot with
a few hundred students will have batches of accounts that need the same
action, such as end-of-term disables.

**What it would take.** Row selection in the Workspaces tab, a
confirmation dialog naming every affected row, and either a bulk API
route or a loop over the existing single-row ones with a shared audit
row per action. About a day.

**Source.** `docs/EPIC-11.md`, "Out of this epic".

## Course profiles and a language-aware editor

**What.** Two changes that would make Portikus suit a traditional
programming course, one where students write the code themselves rather
than directing a coding agent:

1. A *course profile* that switches parts of the interface off to make
   it simpler for beginners, for example the Docker controls,
   coding-agent launchers, and the system rows in the Running pane.
2. An editor closer to VS Code, but still simpler: completion that
   understands the code (IntelliSense), hover help, errors as you type,
   go to definition, rename, format, and a Problems list.

**Why.** A colleague of Todd's suggested it after a demo. The editor
today has Monaco's editing features (folding, bracket matching, multiple
cursors, find and replace, the command palette; see
`apps/web/src/editor/features.ts`) but no language intelligence. ADR 0015
left that out on purpose, with the coding agent as the answer. A course
that does not use an agent loses that answer.

**Documents this would change first.** VISION.md says Portikus "should
not turn software development into a simulated or simplified exercise";
a profile needs that reworded as one environment in which a course
chooses how much to show. SPEC.md section 13.2 says Portikus is not a
VS Code clone, and section 32 rules out an IDE extension ecosystem and a
graphical debugger. A new ADR would supersede the language-service part
of ADR 0015.

**What it would take.**

*Course profile.*

- Hiding features is cheap. One setting is read by the web app and set
  on the admin page, and it switches panes and menu items on and off.
  About one small epic.
- Preventing features is not cheap. A student with a terminal can still
  install and run an agent, so a real block needs the egress allow-list
  (issue #284), and perhaps a workspace image without the agent tools.
  That is roughly three times the work of hiding.
- Courses do not exist yet (SPEC.md section 31; see the LTI 1.3 entry
  above). The first version would be one profile per deployment, or one
  set on each user by an administrator.

*Editor, cheap step (a day or two).*

- Load Monaco's suggestion widget, hover, parameter hints and snippets,
  with suggestions drawn from words in the file for every language. This
  is word matching, not IntelliSense, but it helps beginners type.
- Turn on Monaco's built-in TypeScript, JavaScript, CSS and HTML
  services. They run in the browser and see only the open files, not
  `tsconfig.json` or `node_modules`, so they report errors on imports
  that actually work. The simplest mitigation is to keep completion and
  hover and switch their diagnostics off. The cost is about 9 MB more to
  download the first time an editor opens.
- Python, Java, C and other languages get syntax colouring only from
  Monaco. There is no in-browser shortcut for them.

*Editor, real IntelliSense (one large epic, plus a task per language).*

1. The workspace image installs language servers for the course's
   languages: `pyright` for Python and `typescript-language-server` are
   easy; `clangd` for C and C++ is moderate; `jdtls` for Java is heavy.
2. The workspace agent starts one language server per project and
   language on demand, confines it to `~/projects/<slug>`, and stops it
   when idle.
3. The API relays the Language Server Protocol over a WebSocket route,
   authorized the same way terminal WebSockets are (SPEC.md section 9).
4. The web app connects Monaco to the server. The preferred route is a
   thin client of our own covering about six features (completion,
   hover, diagnostics, definition, rename, format), each wired straight
   to a Monaco provider. `monaco-languageclient` is fuller, but it
   replaces most of our Monaco setup with VS Code's service layer, which
   touches the diff editor and themes.
5. Around the editor: a Problems list, format on save, and an outline.

Memory is the hidden cost. A language server takes roughly 100 to
500 MB per active student, and Java takes more. Thirty students on one
VM needs a load test before this is promised to a course, and probably
the per-workspace limits entry above.

**Rejected for now.** Running the real VS Code server (openvscode-server)
in each workspace and showing it through the preview gateway would give
IntelliSense and a debugger almost for free. It was rejected because it
is the opposite of simpler: students get all of VS Code, the product has
two editors, only the Open VSX extension registry is available, and each
student uses even more memory.

**Likely next request.** A debugger (stepping through code). It follows
the same pattern as language servers, through the Debug Adapter
Protocol, but needs much more interface. SPEC.md section 32 excludes it
today.

**Decisions needed before it becomes an epic.**

1. Which languages. This sets most of the cost.
2. Whether the profile hides features or blocks them.
3. One profile per deployment, or per user.
4. Whether a debugger is in scope.

**Related.** Per-course or per-project tool versions (a version manager
such as mise, so one course gets a different Node or Python) belong here
too. Epic 15's Workspace image section only picks one Node and Python
for the whole site (docs/EPIC-15.md, ruling 29).

**Source.** Todd and a colleague, after a demo, 2026-09-23.

## LTI grade passback (AGS)

**What.** Send a score from Portikus back to the LMS gradebook through
the LTI Assignment and Grade Services (AGS).

**Why.** Instructors could grade work done in Portikus without copying
scores by hand.

**What it would take.** A tool key that signs service tokens (the key
already exists), an OAuth client-credentials call to the platform, and a
decision on what a score even is in Portikus. Days, after that decision.

**Source.** Left out of Epic 13.

## LTI roster sync (NRPS)

**What.** Read the course roster from the LMS through the Names and Role
Provisioning Services (NRPS), and remove members who have left the course.

**Why.** Today the Course page lists only people who have launched, and
never drops anyone who left.

**What it would take.** A service call per course with the tool key, a
worker job to refresh rosters, and removing memberships no longer on the
roster. About two days.

**Source.** Left out of Epic 13.

## LTI Deep Linking

**What.** Let an instructor pick a specific Portikus target, such as a
starter project, when adding the link in the LMS.

**Why.** A link could open a set exercise rather than just the workspace.

**What it would take.** The Deep Linking message type, a small picker
page, and a signed response to the LMS. Depends on course templates.

**Source.** Left out of Epic 13.

## Link an LTI account to a Dex account

**What.** Let one person who signs in both from the LMS and through Dex
have one account and one workspace.

**Why.** Today they get two accounts and two workspaces.

**What it would take.** A linking step that proves control of both
identities (sign in with one while signed in with the other), never a
match by email. A day or two plus a security review.

**Source.** Left out of Epic 13 (ruling 3).

## Per-course instructor views of student workspaces

**What.** Let an instructor look into a student's workspace from the
Course page, read-only at first (SPEC.md section 31).

**Why.** Helping a student today means asking them to share their screen.

**What it would take.** An access class tied to course membership,
audited reads through the file routes, and a clear notice to the student.
Needs a security review. About a week.

**Source.** Left out of Epic 13.

## Remove course memberships

**What.** Drop people from the Course page when they leave the course.

**Why.** The page keeps everyone who ever launched, with their old last
launch time.

**What it would take.** Roster sync (above), or an instructor-side remove
button as a stopgap. Half a day for the button.

**Source.** Left out of Epic 13 (ruling 27).

## StateBadge without role=status inside tables

**What.** An option on the StateBadge component to leave out
`role="status"` when it sits in a table cell.

**Why.** On the Course page, every row's badge is a live region, so a
screen reader may announce many rows at once.

**What it would take.** A prop on the component and passing it from the
tables that list many rows. An hour, plus tests.

**Source.** Epic 13 accessibility review.
