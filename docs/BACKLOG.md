# Backlog

Work that is wanted but not yet scheduled as an epic or task. Each entry
says what, why, what it would take, and where it came from. Known gaps left
by landed work stay in `docs/STATUS.md`; move one here when it becomes
something we intend to build. Remove an entry when its work lands or when
it is rejected, and record the rejection in `docs/STACK.md` section 35.

## Sign-in setup in the admin area

**What.** An administrator sets up the site's SSO provider from the admin
area instead of the command line: choose Entra, Google, LDAP or generic
OIDC, fill in its fields, press "Test sign-in", and save only after the
test passes. The command line stays as the fallback.

**Why.** Today every provider setting is an Ansible variable. With Dex as
the only front door (ADR 0031) there is one thing to configure, Dex's
connector, and the local administrator is the way back from a mistake.

**What it would take** (about two weeks, now that Epic 14.2 has made Dex the only front door):

1. Confirm the pinned Dex's gRPC API can create and update connectors
   (it sits behind a feature switch) and that connectors kept in Dex's
   storage survive restarts. Then exactly one owner: the admin area owns
   the connector and Ansible only seeds it once.
2. The outbound allow list and LDAP's address rule are root-owned host
   files today. Either a narrow root helper in the style of ADR 0030, or
   Squid and the Dex unit read a list the API maintains.
3. A test sign-in that runs the connector without changing who can sign
   in, and an audit row for every change.

**Source.** Todd, 2026-09-25.

## OpenAPI generation from the Zod contracts

**What.** Generate an OpenAPI document from the schemas in
`packages/contracts` and serve or publish it.

**Why.** ADR 0003 chose Zod contracts partly so the API could describe
itself; that generation was never wired up.

**What it would take.** Add the Zod-to-OpenAPI step to the contracts build,
attach descriptions to the route schemas, and check the generated document
in CI. About a day.

**Source.** `docs/SPEC.md` around line 2227, Epic 3 known gaps, ADR 0003.



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

**Shipped** as Epic 13 (`docs/archive/epics/EPIC-13.md`, ADR 0025): the core launch, the
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

**Source.** `docs/archive/epics/EPIC-12A.md`, "Rules for the VM suite"; `docs/STATUS.md`,
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

**Why.** Epic 10 accepted an orphan archive as a known gap (`docs/archive/epics/EPIC-10.md`,
risk 8): the API can crash between the agent writing an archive and the
row being inserted. Rollback copies from a failed restore are also never
cleaned up automatically today (`docs/STATUS.md`, Epic 10 known gaps).
Left alone, both slowly eat the recovery quota.

**What it would take.** A worker sweep, similar to the existing retention
sweep, that lists each workspace's recovery directory through the agent
and deletes anything with no matching row past some age, plus ages out
`.portikus-aside-*` folders after a fixed period. One to two days,
including the busy-delete race with an in-progress restore.

**Source.** `docs/archive/epics/EPIC-10.md` risk 8; `docs/STATUS.md`, Epic 10 known gaps.

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
recovery-point rate limit is hit (`docs/archive/epics/EPIC-10.md` task 5 review fixes),
the same code the agent's per-project lock uses for "another operation
on this project is already running". A client cannot tell "try again in
a moment" from "wait for the other operation to finish" apart without
also checking the HTTP status.

**What it would take.** Epic 12b added `RATE_LIMITED` for the sign-in
throttle, so what is left is to switch Epic 10's recovery-point
rate-limit responses to it and update the handful of tests that assert on `BUSY` for a rate limit today. Half a day.

**Source.** `docs/archive/epics/EPIC-10.md`, task 5 review fixes; PR #428.
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

**Source.** SPEC.md section 25.10; `docs/archive/epics/EPIC-11.md`, "Out of this epic".

## Automated weekly off-host backup copy

**What.** Copy the backup sets in `/var/backups/portikus` to storage off
the host (an external drive, network storage, or a cloud bucket) once a
week, automatically.

**Why.** The sets sit on the same physical disk as the VM, so they do not
survive losing that disk (ADR 0024). Today Todd copies them by hand
weekly (docs/OPERATIONS.md, "Backups").

**What it would take.** A host timer that copies the newest complete set,
still encrypted, to a configured destination and reports its result on
the admin Backups tab. About two days.

**Source.** Issue #730; left out of Epic 24. Tracked as issue #753,
which would also make backups incremental and deduplicated (restic). Epic 15
left the same gap on an apt-installed server: its sets stay in
`/var/backups/portikus/local/` until the operator copies them off
(docs/INSTALL.md), so the push should work in local mode too.

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

**Source.** `docs/archive/epics/EPIC-11.md`, "Out of this epic".

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
for the whole site (SPEC.md section 22.4).

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

## Per-course instructor views of student workspaces

**What.** Let an instructor look into a student's workspace from the
Course page, read-only at first (SPEC.md section 31).

**Why.** Helping a student today means asking them to share their screen.

**What it would take.** An access class tied to course membership,
audited reads through the file routes, and a clear notice to the student.
Needs a security review. About a week.

**Source.** Left out of Epic 13.

## Group-ID and overage handling for Microsoft Entra ID

**What.** Map Entra security groups to roles, by their object IDs, and
handle the overage claim Entra sends instead of the list past about 200
groups.

**Why.** Epic 14 takes roles from Entra app roles, which a tenant assigns
to people or groups on the Portikus registration and which have no
overage limit. A site that wants to reuse existing groups without
assigning app roles cannot today.

**What it would take.** Group object IDs in the three role settings, and
a Microsoft Graph call to page through an overage. A few days plus a
security review of the new Graph credential and its egress host.

**Source.** Left out of Epic 13.1 (ruling 25) and Epic 14.

## Several Entra tenants on one site

**What.** Let people from more than one Entra tenant sign in to one site.

**Why.** Epic 14 allows one tenant per site (docs/archive/epics/EPIC-14.md ruling 8).
A site shared by several organisations would need more.

**What it would take.** Entra's shared `organizations` endpoint, whose
tokens carry a different issuer per tenant, so Portikus would replace
`openid-client`'s single issuer check with its own. About two days plus a
security review.

**Source.** Left out of Epic 14 (Todd, 2026-09-24).

## A Google group check

**What.** Admit only members of a Google group, not a whole Workspace
domain, and optionally map groups to roles.

**Why.** Under Google, the domain is the only gate, and everyone starts
as a student (docs/archive/epics/EPIC-14.md risk 3).

**What it would take.** A Google Admin SDK call with a service account
and domain-wide delegation, and its host on the egress allow list. A few
days plus a security review.

**Source.** Left out of Epic 14.

## Self-service passwords and invitations for Dex accounts

**What.** Let a Dex user change their own password, reset a forgotten
one by email, and receive an emailed invitation; let an administrator
edit a Dex user's email or username in place.

**Why.** Today an administrator resets every forgotten password and hands
it over privately, and changing an email or username means removing and
re-adding the person, who then gets a new, empty workspace.

**What it would take.** A signed-in password-change page through Dex's
gRPC API; outbound email for resets and invitations, with its own
throttle; and an update route that keeps the user ID. About a week.

**Source.** Left out of Epic 14.

## Admin pages for the egress allow list and LMS platforms

**What.** Edit the API's egress allow list and the registered LMS
platforms from the admin area instead of files Ansible applies.

**Why.** Both change rarely today, and a file keeps every change in the
operator's hands. A site with many courses or providers may want an
administrator to do it without the host.

**What it would take.** Storing both in the database, reloading Squid
and the API's platform list on change, and auditing each edit. A few
days plus a security review, since both widen what the API trusts.

**Source.** Left out of Epic 13 and Epic 14.

## Server-side search and paging for the Users view

**What.** Move the Users view's search and role filter to the server, and
page the list, instead of filtering the whole fetched list in the browser.

**Why.** Fine for one pilot's account count; a list past about 1,000
accounts would fetch and filter too much in the browser.

**What it would take.** A search and paging API on `GET /admin/users` and
the matching web changes. A day or two.

**Source.** Left out of Epic 13.1 (ruling 24).

## Administrator-side account linking

**What.** Let an administrator link or unlink two accounts on someone
else's behalf, for a person who cannot complete the self-service flow
(docs/archive/epics/EPIC-13-1.md).

**Why.** Today only the account holder can start and confirm a link.
A student whose course sign-in is linked to an SSO account that is later
disabled or promoted to administrator is locked out of launches: every launch lands
in that account and is refused, and only an administrator-side unlink
would bring the course account back (docs/archive/epics/EPIC-13-1.md rulings 21 and N4).

**What it would take.** An admin route that skips the "recent launch"
proof and instead requires the administrator to pick both accounts
explicitly, with its own audit trail. Needs a security review, since it
removes one of the two proofs of control ordinary linking requires.

**Source.** Left out of Epic 13.1.

## "Still working?" under an open dialog

**What.** Make the idle notice reachable when it appears while a dialog is
open. Today the dialog marks the rest of the page hidden from screen
readers, and its focus trap pulls focus back from Keep working.

**What it would take.** Raise the notice as its own alert dialog, or
render it inside the open dialog's layer, so it is announced and can take
focus. About a day with tests.

**Source.** Accessibility review of Epic 14.3 (issue #554).

## A larger unread badge

**What.** The unread badge on the account button uses 10px text and an
18px target that overlaps the account button (SPEC.md section 25.8).

**What it would take.** A 24px target that sits beside the account button
rather than over it, with at least 12px text, and a design check against
design/. Half a day with the header tests.

**Source.** Accessibility review of Epic 14.3 (issue #475).

## Sortable admin tables and a table component

**What.** Sortable column headers and a React `<Table>` component.

**What it would take.** Port the design's sortable-header rules and add
sort state per table. Worth a component only once column definitions
repeat.

**Source.** Left out of Epic 18; the CSS classes are enough today.

## Admin tabs in the app header

**What.** Move the admin tab navigation into the app header, as the
mockup's `.pk-adminnav` does, to save about 110 px of height.

**What it would take.** A header change that knows about admin routes,
with the header tests and e2e updated.

**Source.** Left out of Epic 18.

## Per-row "more" menus in admin tables

**What.** A menu on each Users row with its actions, from the mockup.

**What it would take.** A menu per row reusing the detail panel's
actions. Bulk selection and the detail panel already carry them.

**Source.** Left out of Epic 18.

## A tablet admin layout

**What.** An admin area usable below 1024 px.

**What it would take.** A narrow layout for the tables and detail panel.
The admin area is desktop-only today (SPEC.md section 20.1).

**Source.** Left out of Epic 18.

## Shared storage thresholds for the admin detail panel

**What.** The admin detail panel could reuse the student side's
StorageMeters and storageLevel thresholds, so both sides colour usage
the same way.

**What it would take.** Import the shared helper in the panel's meters,
with a unit test. Under half a day.

**Source.** Epic 18 confirmation review.

## A radio-item menu component

**What.** The Preview frame width uses checkable menu items; a radio-item
component would state "one of these" more precisely to assistive
technology.

**What it would take.** A new `packages/ui` export wrapping the Radix
radio group item, used by the width menu. Half a day.

**Source.** Left out of Epic 20 (issue #609).

## A full accessibility audit of the student interface

**What.** Epic 20's accessibility review covered only that epic's changes.

**What it would take.** An a11y-reviewer pass over the whole student
interface against SPEC.md section 25.8, with fixes filed as issues.

**Source.** Left out of Epic 20.


## Clone and template on a full disk

**What.** Cloning a repository or creating a project from a template on a
full disk still reports `GIT_FAILED`, not `STORAGE_FULL`, so the student
is not told that storage is the cause.

**What it would take.** Have the workspace agent recognise "No space left
on device" in the git or copy output and answer `STORAGE_FULL`, with unit
tests. Under a day.

**Source.** Left out of Epic 17.

## Systemd watchdogs for the Node services

**What.** systemd could restart a Portikus service that hangs without
crashing.

**What it would take.** `sd_notify` support in each Node service and
`WatchdogSec=` on its unit. No process has been seen wedged so far.

**Source.** Left out of Epic 17 (ADR 0034).

## Disk I/O priority between the platform and workspaces

**What.** `IOWeight` on the platform's services or `limits.disk.priority`
on workspaces. Neither works without the BFQ disk scheduler, and the VM's
disks use `none`. Contention between the VM's two disks on the host was
not measured.

**What it would take.** Measure host-level contention first; if it
matters, switch the VM's disks to BFQ and set weights.

**Source.** Left out of Epic 17 (ADR 0034).

## A per-address limit on made-up preview cookies

**What.** A made-up preview cookie is neither cached nor capped; each costs
two indexed lookups, bounded only by the database pool timeouts.

**What it would take.** Reuse the sign-in edge throttle for
`/preview/authorize` misses, per address.

**Source.** Left out of Epic 17.

## Connection-tracking and dnsmasq limits per workspace

**What.** Workspaces share the host's connection-tracking table (262,144
entries) and dnsmasq. No pressure has been measured.

**What it would take.** Measure under load, then add per-workspace limits
if one workspace can fill either.

**Source.** Left out of Epic 17.

## Rate limits on reads and recovery points

**What.** File reads and project reads are not rate-limited, and recovery
points and check runs are outside the new file-write limit. Reads are
cheap and bounded by size caps; recovery points already have their own
limit.

**What it would take.** Add counters with the shared
`apps/api/src/rate-limit.ts` if a need appears.

**Source.** Left out of Epic 17.

## Keep the old save error while the disk stays full

**What.** While the home folder is full, the editor's save error is
announced to screen readers again after every autosave attempt.

**What it would take.** Keep the existing error in `FileLeaf.tsx` until a
save succeeds instead of replacing it with an identical one. Under a day.

**Source.** Accessibility review of Epic 16.

## A per-user cap on terminal WebSocket connections

**What.** Each terminal allows 4 attachments and each workspace 20
terminals, but nothing caps how many terminal WebSockets one user holds
open across the control plane. This predates Epic 16.

**What it would take.** A per-user connection count in the terminal
WebSocket route with a clear refusal code. About a day with tests.

**Source.** Security review of Epic 16.

## An exact out-of-memory reason in the terminals exit record

**What.** The exit record says `oom-kill` when tmux died of `SIGKILL` and
the terminals unit's cgroup counts any `oom_kill`. An earlier pane OOM
kill followed by a plain `SIGKILL` of tmux in the same run is reported as
out of memory (ADR 0035).

**What it would take.** Record the `oom_kill` count when the unit starts
and compare it at stop, or read the kernel's per-process OOM report.
About a day, with a rehearsal.

**Source.** Epic 16 rehearsal.

## CPU weights and a memory floor for the agent

**What.** Audit recommendation 3: give the agent a CPU weight and
`MemoryMin`. Checks still run in the agent's cgroup, so a CPU weight would
favour student Check code too.

**What it would take.** Moving Checks out first (below), then the unit
settings and a rehearsal.

**Source.** Left out of Epic 16.

## Move Checks out of the agent's cgroup

**What.** Checks run in the agent's cgroup, so a Check that uses too much
memory can take the agent with it.

**What it would take.** Start Checks in the terminals unit or their own,
and change how they are started and replayed. Several days.

**Source.** Left out of Epic 16.

## A watchdog for a stopped agent

**What.** An agent stopped with `SIGSTOP` stays stopped. Only a deliberate
act causes it.

**What it would take.** A systemd watchdog with a heartbeat from the
agent. About a day.

**Source.** Left out of Epic 16.

## The preview registry connecting only on demand

**What.** The control plane keeps one port-events socket per running
workspace, so each agent's scanner stays awake.

**What it would take.** Connect only while a browser watches Running or a
preview is open, without losing current ports for preview routing.

**Source.** Left out of Epic 16.

## A Docker process share per student

**What.** Docker containers share the container's 2000 processes with the
agent; the terminals unit's cap does not cover them.

**What it would take.** A pids limit for the Docker daemon's containers,
set in the image. About a day with a rehearsal.

**Source.** Left out of Epic 16.

## Explain an agent restart on images before 2026.09.11

**What.** On older images an agent restart still closes every terminal
with no explanation.

**What it would take.** Nothing beyond rebuilding those workspaces on the
new image, which fixes it.

**Source.** Left out of Epic 16.

## A per-route breakdown of API requests

**What.** Slowest and busiest routes on the Health tab. The charts show totals only.

**What it would take.** A `route` column in `api_request_samples` (a migration) and a table view. Storing per route multiplies the rows by the number of routes.

**Source.** Left out of Epic 19.

## A sliding or custom time window on the Health tab

**What.** Any window, not only the four presets of 1 hour, 6 hours, 1 day and 7 days (issue #597 allows it later).

**What it would take.** A from and to control and a bucket width chosen from the span; the series route already buckets on the server.

**Source.** Left out of Epic 19.

## Workspace agent logs in the Logs tab

**What.** The agents' own lines. They live inside each container, not in the VM's journal.

**What it would take.** A way to collect them from the containers without the platform reading student data (#476, "Left out on purpose").

**Source.** Left out of Epic 19.

## Alerts or emails on errors

**What.** Tell an administrator when errors appear, instead of waiting for them to look.

**What it would take.** A mail setting and a threshold rule in the worker (#476, "Left out on purpose").

**Source.** Left out of Epic 19.

## Dex, Caddy and PostgreSQL lines in the Logs tab

**What.** Only the three Portikus units are read today.

**What it would take.** Their lines are not Portikus JSON, so each needs its own parser and redaction rules before it can be shown.

**Source.** Left out of Epic 19.

## Non-JSON journal lines in the Logs tab

**What.** systemd's start and stop lines and raw stack traces are skipped and counted.

**What it would take.** A plain-text row type with redaction for free text, which is harder than redacting named keys.

**Source.** Left out of Epic 19.

## Per-workspace figures beyond about 4 hours

**What.** The heat map covers at most the 245 minutes `workspace_usage_samples` keeps.

**What it would take.** A decision on that table's size, since it holds one row per running workspace per minute.

**Source.** Left out of Epic 19.

## Sampling faster than once a minute

**What.** Health charts cannot be finer than the worker's one-minute samples (#597).

**What it would take.** A faster sampler and a larger `health_samples` table.

**Source.** Left out of Epic 19.

## OpenTelemetry or a metrics endpoint

**What.** ADR 0022 still holds: metrics stay in PostgreSQL.

**What it would take.** Only when a second VM or an external monitor needs one.

**Source.** Left out of Epic 19.

## Heat map values for sighted keyboard users

**What.** The heat map's cells are not focusable, so a sighted keyboard user cannot read a cell's exact value; the Peak column is the summary. Screen readers get every value.

**What it would take.** A keyboard cursor over the table like the charts' readout, one tab stop with arrow keys, without making thousands of tab stops.

**Source.** Left out of Epic 19.

## Monitor buttons while Find in files is open

**What.** "See what's using CPU", "See what's using memory" and the
status bar's Memory meter do nothing visible while Find in files covers
the right pane's tabs. Monitor is chosen and focus moves to its tab only
once the search closes.

**What it would take.** Close the search, or show Monitor over it, when
one of these buttons is pressed, with a unit and a Playwright test. Half
a day.

**Source.** Epic 21 accessibility confirmation review; the behaviour
predates Epic 21.

## Stop a process tree, and renice

**What.** Stop a program and its children together from Monitor, or
lower its priority.

**What it would take.** Reuse Epic 16's `process-tree.ts` behind the
agent's checked stop route, with the same PID and start-ticks checks for
each process. About two days with tests.

**Source.** Left out of Epic 21 (issue #607).

## Per-workspace idle-lift settings

**What.** Let one workspace override the automatic throttle lift's quiet
time and percent.

**What it would take.** Two more keys in the guard override dialog and
the worker's settings lookup. A day with tests.

**Source.** Left out of Epic 21 (issue #596 asks for none until needed).

## An administrator's stop when the agent is down

**What.** Stop one process in a workspace whose agent does not answer.
Today the administrator stops or restarts the whole workspace instead.

**What it would take.** A root-level kill path in the controller keyed on
host PID and start ticks, with its own security review. More to secure
than the case is worth so far (ADR 0037).

**Source.** Left out of Epic 21.

## A live administrator's process list

**What.** Refresh the administrator's process list on its own, or show
it with the workspace list.

**What it would take.** A timer in the section that presses Refresh, with
thought about the audit rows each read writes. A day.

**Source.** Left out of Epic 21 (issue #595 asks for a Refresh button).

## Tell the student of an idle lift they missed

**What.** A student who was away when their throttle lifted on its own
is not told; only an open page shows the "back to full speed" toast.

**What it would take.** A notification row written by the worker on an
idle lift. Half a day.

**Source.** Left out of Epic 21.

## Protect a unit's main process by its MainPID

**What.** A student with sudo can restart the agent or terminals unit
and then move a long-running program into that unit's cgroup, so it is
the oldest process there and the administrator's list marks it
protected. The administrator then stops the whole workspace instead.

**What it would take.** Read each unit's MainPID from the host side, or
have the agent report its own PID and the tmux server's, and protect only
those. About a day with tests (ADR 0037).

**Source.** Epic 21 security confirmation review.


## Course page at narrow widths

**What.** A Course page that fits a narrow window without scrolling
sideways.

**Why.** Instructors may open it on a laptop beside the learning system;
today the members table scrolls sideways below about 1024 px.

**What it would take.** Let the table drop or stack less important
columns in a container query, as the right pane does. Half a day with
Playwright checks.

**Source.** Epic 25 design review.

## Check summary headings with VoiceOver

**What.** A pass with VoiceOver on macOS over the `<summary>` elements that
hold headings (PageIntro, the Health Trends groups, Backups Clean up).

**Why.** Axe passes, but VoiceOver is known to read headings inside
`<summary>` inconsistently, and nobody has listened to them.

**What it would take.** An hour on a Mac; if they read badly, move the
heading out of the summary.

**Source.** Epic 25 accessibility review.

## Whiptail's top padding on yes/no screens

**What.** The install screens' yes/no dialogs, such as the summary, show
a blank line above the text.

**Why.** It looks like a layout slip. It is whiptail's own padding and
debconf gives no way to remove it.

**What it would take.** Nothing short of replacing debconf's front end;
accepted unless a later debconf release adds a way.

**Source.** Epic 15 installer polish (#803).

## Watch a possibly flaky Users dialog test

**What.** `DexUserDialogs.test.tsx`, "Show details for dana", timed out
once under heavy machine load and passes alone.

**Why.** A flaky unit test trains people to rerun CI instead of reading
it.

**What it would take.** Nothing yet. If it fails again in CI, find the
slow wait and fix it.

**Source.** Epic 15, T6 (#792).

## A weekly re-sign can cancel a queued release

**What.** The scheduled weekly re-sign of the apt index can still cancel
a release run queued behind another one.

**Why.** GitHub's concurrency groups cancel pending runs before any job
starts, so no check inside a job can save the queued release.
WORKFLOW.md tells operators to rerun it for now.

**What it would take.** Restructuring the release workflow so the
re-sign and the release no longer share one pending slot.

**Source.** Epic 15.1 review.

## Test the host backup targets on a configure-vm VM

**What.** `make backup-install-timer` and `make backup-install-channel`
now refuse self-backing VMs and remain for VMs set up with `make
configure-vm`, but they have not been run against such a VM since.

**Why.** Untested operator paths break quietly.

**What it would take.** Run both targets against a rehearsal VM set up
with `make configure-vm`, then take and restore one set.

**Source.** Epic 15.1 (#834).

## Test the pin between two published versions

**What.** Setup's `PORTIKUS_VERSION` pin to an older published package
cannot be tested until a second release exists in the repository.

**Why.** A downgrade path nobody has run may fail when an operator needs
it.

**What it would take.** After the next release, run install-test pinned
to the previous published version.

**Source.** Epic 15.1.

## Probe the worker's refusals on every local address

**What.** The install-test and smoke checks that the worker cannot reach
the API or Dex probe only 127.0.0.1, not ::1 or the VM's own address.

**Why.** A rule that holds on one address can have a gap on another.

**What it would take.** Repeat the same probes against ::1 and the host's
own address.

**Source.** Epic 15.1 confirmation review.

## CSV files as a table in the file viewer

**What.** Show a CSV file as a table, not as text. Issue #816 listed it
as optional.

**Why.** Students open data files and a table is easier to read.

**What it would take.** A read-only table view in the file viewer, with a
row cap like the editor's size limit.

**Source.** Epic 15.2 (#816).

## Progress for Extract here

**What.** "Extract here" shows an "Extracting" notice, not a percentage.

**Why.** A large zip gives no sign of how long it will take.

**What it would take.** The agent streams unzip's per-entry output as
progress, and the toast shows entries done out of the total.

**Source.** Epic 15.2 (#817).

## Refresh a large image or PDF when it changes on disk

**What.** An image or PDF over the 2 MiB editor limit has no version in
its address, so a change on disk shows only after its tab is reopened.
A PDF over 50 MB is offered as a download, because the in-page copy is
held in memory.

**Why.** A student regenerating a large figure or report sees a stale one.

**What it would take.** A version from the file's size and modified time
for large files, and a streamed PDF source instead of an in-memory copy.

**Source.** Epic 15.2 (#816).

## Catch a clear followed at once by long output

**What.** The terminal's clear frame comes from a half-second poll of
tmux's history size, so `clear && npm test` scrolls new history in before
the poll sees it empty, and the browser keeps the old scrollback.

**Why.** A student who clears before a test run still scrolls back into
the previous run.

**What it would take.** A signal that does not depend on timing: for
example a counter the agent can read from tmux that changes on every
history clear (a tmux patch or a newer tmux), or scanning the pane's
output for CSI 3 J in the agent before tmux sees it, which needs the
agent in the pane's output path.

**Source.** Issue #882 review.

## Leave an administrator's disabled services alone

**What.** Setup enables the API, controller and worker on every
configure, so it undoes an administrator's own `systemctl disable`.

**Why.** It was added so a remove and reinstall brings the services back,
but it also overrides a deliberate choice.

**What it would take.** Enable them only on a reinstall, for example
when postinst sees no enable links left.

**Source.** Epic 15.2 review fixes (#876).

## Build the workspace image on an apt-installed VM

**What.** `make build-workspace-image` fails on a VM installed with apt,
because its rsync cannot create `/var/lib/portikus/incus`.

**What it would take.** Have the target create that folder with the
right owner first, or copy to a folder the build user owns.

**Source.** Epic 15.3.

## Announce an admin rebuild result after the panel closes

**What.** A rebuild or Docker reset that ends after its detail panel is
closed or switched gets no toast. The Audit tab still shows it.

**What it would take.** Watch pending operations at the Users view level
rather than the panel, and toast when any of them ends.

**Source.** Epic 15.3 (#881).

## End toast for Replace home folder

**What.** Replace home folder shows a pending badge but no toast when it
ends.

**What it would take.** Read its result audit row the same way rebuild
and Reset Docker now do, and show the same toast.

**Source.** Epic 15.3 (#881).

## A "moving" option for StateBadge

**What.** A pending label follows the workspace state's badge, so the
student's "Rebuilding" badge can show a stopped ring.

**What it would take.** A StateBadge option that shows a spinner whatever
the workspace state, used by every pending label.

**Source.** Epic 15.3 (#881).

## Keycap emoji in clone names

**What.** A keycap emoji such as 1️⃣ keeps its digit in the suggested
clone name.

**What it would take.** Strip a digit, `#` or `*` followed by the keycap
combining mark, and add a unit test.

**Source.** Epic 15.3 (#883).

## Sturdier agent restart check in the install test

**What.** The install test reads the agent's start time from the process,
and leaves its test workspace behind if a step fails.

**What it would take.** Read systemd's `ExecMainStartTimestamp` for the
agent unit, and destroy the test workspace in a shell trap.

**Source.** Epic 15.3 (#887).

## Registry first pull downloads twice

**What.** Registry 2.8 in proxy mode downloads about twice an image's
bytes on the first fetch.

**What it would take.** Try a newer `distribution` release once Debian
ships one, and measure the first pull again on the rehearsal VM.

**Source.** Epic 26 (#840) spike.

## Seed share key on early seeded volumes

**What.** Docker volumes seeded before the `user.portikus.seed-gib` fix
lack the key, so a later Docker quota change on them does not count the
seed's share.

**What it would take.** A one-time controller step that sets the key on
volumes copied from a seed without it, or a Reset Docker for those
workspaces. Only the pilot has such volumes.

**Source.** Epic 26 (#840) review fixes.

## Stall when the cache connection is dropped

**What.** When the cache drops connections instead of refusing them,
Docker waits about 15 seconds before it falls back to Docker Hub.

**What it would take.** Make the firewall reject rather than drop the
cache ports when the registry is down, or lower dockerd's mirror timeout
if Docker adds one; test by stopping the unit on the rehearsal VM.

**Source.** Epic 26 (#840) verification.

## Ansible egress re-apply matches the helper

**What.** The Ansible handler that re-applies egress rules is not the
same as the helper's own re-apply, which also rewrites the dnsmasq and
Squid configuration.

**What it would take.** Have the handler start `portikus-egress-apply`
with no request, as the registry helper does, and drop its own steps.

**Source.** Epic 26 (#840) review.

## One student can wipe the shared cache

**What.** A student can fill the pull cache past 90 percent and set off
the automatic clear, which empties it for everyone. Ruling SEC5 accepted
this: it costs download time, never data.

**What it would take.** Per-workspace pull accounting and a limit, or a
registry with a least-recently-used size cap in place of the full clear.

**Source.** Epic 26 (#840), ruling SEC5.

## Cache catalog visible to every workspace

**What.** Any workspace can list every cached repository through
`/v2/_catalog`, and so see which images others pulled. Ruling S6 accepted
this.

**What it would take.** A small proxy on the gateway that answers 404 for
`/v2/_catalog` and passes everything else, with a smoke test.

**Source.** Epic 26 (#840), ruling S6.

## Seeded workspaces share one Docker engine ID

**What.** `/var/lib/docker/engine-id` comes from the seed, so every seeded
workspace reports the same Docker engine ID. Nothing in Portikus uses it,
and no harm is known.

**What it would take.** Remove `engine-id` from the seed volume after the
build (dockerd writes a new one at first start), with a check in the seed
builder test.

**Source.** Epic 26 (#840) pilot verification.

## Email for certificate warnings

**What.** Certificate expiry and renewal-failure warnings reach
administrators only as notifications in Portikus. An administrator who
does not sign in misses them.

**What it would take.** Send the same notices by email once outgoing mail
exists. This is blocked on #918.

**Source.** Epic 27 (#804), ruling R12.

## Shared file input in packages/ui

**What.** The Certificate tab builds its own file picker for the PEM
uploads. There is no shared file input that looks and behaves like the
Select in `packages/ui`.

**What it would take.** A file input component in `packages/ui`, styled
like Select, with its hint linked by `aria-describedby`, used by the
Certificate tab, with unit and axe tests.

**Source.** Epic 27 (#804) review of the Certificate tab.

## Caddy reloads and long WebSockets

**What.** A Caddy reload closes every proxied WebSocket, such as a
terminal. Setup sets `stream_close_delay 1h` on the WebSocket routes, so
a certificate change does not drop them. A connection still open an hour
after a reload is closed anyway, and the page reconnects. Each reload
inside that hour also keeps an old configuration in memory.

**What it would take.** Nothing now. Revisit if reloads become frequent
or terminals drop after certificate changes.

**Source.** Epic 27 (#804), ruling R19.

## ACME "unauthorized" treated as final

**What.** The certificate job treats every ACME `unauthorized` error as
final and stops at once. During DNS propagation a DNS-01 challenge can
fail with that error and would succeed a minute later, so a test can fail
when a retry would have passed.

**What it would take.** Watch for it on real installs. If it happens,
retry `unauthorized` for DNS-01 a few times before giving up, with a unit
test for the classification.

**Source.** Epic 27 (#804) review of the root job.

## Duplicate keys in a Google key file

**What.** A Google Cloud DNS service-account key with a duplicate JSON key
is refused only by the root job. The page and the API accept it, because
`JSON.parse` keeps the last value, so the administrator learns of it only
when the job fails.

**What it would take.** A duplicate-key check in the contract's parser
(a small reviver or a token scan), with a unit test.

**Source.** Epic 27 (#804) security review of the API.

## Open home instruction files with O_NONBLOCK in the workspace agent

**What.** At start the workspace agent opens `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` to remove what older versions wrote (SPEC.md section 3). It opens them without `O_NONBLOCK`, so a named pipe there could stall that step.

**What it would take.** Open with `O_NOFOLLOW | O_NONBLOCK` and check the type is a regular file before reading, with a unit test.

**Source.** Epic 28 review (#933).

## A student's Codex developer_instructions replace the platform's

**What.** A student's own `developer_instructions` in `~/.codex/config.toml` replaces the platform's guidance from `/etc/codex/config.toml` (SPEC.md section 3), so Codex then loses the workspace advice.

**What it would take.** Find a Codex setting that adds to rather than replaces system instructions, or tell the student in the Student Guide; test on a workspace.

**Source.** Epic 28 (#933), the pilot Codex test.

## Status bar overflow and page reflow at narrow widths

**What.** At narrow widths the status bar's text, including the Keep running line, overflows, and the workspace and admin pages do not reflow at 560 pixels.

**What it would take.** Shorten or wrap the status bar items under a container query, and check both pages at 560 pixels with a Playwright screenshot and an axe run.

**Source.** Epic 28 UI review (#955).

## Move the shell's storage meters onto the Meter component

**What.** The status bar and workspace dialog storage meters are CSS-only bars. Epic 28 added the `Meter` component in `packages/ui` (SPEC.md section 25.8), whose empty track meets 3:1 contrast; the shell's empty track is about 1.2:1.

**What it would take.** Replace the shell meters with `Meter`, keeping their text and warning tones, and update their unit and Playwright tests.

**Source.** Epic 28 a11y notes (#931).

## Image sizes of existing images

**What.** Images on a host before Epic 28 show "Not measured yet" in the Admin image page's size column until the next image job records their size (SPEC.md section 22.4).

**What it would take.** Have the image job's status timer, or the first job after an upgrade, record sizes for every image, with a unit test.

**Source.** Epic 28 (#936).

## Dedicated error codes for the Docker cache and seed match

**What.** Clearing the pull cache while it is off returns 404 `NOT_FOUND`, and the seed match route's refusals (over the size limit, a rebuild running, no manifest) share generic codes, so the page tells them apart by message.

**What it would take.** Add `CACHE_OFF` and seed-match codes to `ApiErrorCode`, return them from `apps/api/src/routes/admin-docker.ts`, and update the tests.

**Source.** Epic 28 (#931, #932).

## Download sizes, not on-disk sizes, on the Docker tab

**What.** The Docker tab shows each image's compressed download size, not what it takes unpacked on disk, and a seed name pinned by digest shows a dash.

**What it would take.** Measure unpacked sizes during the seed build, and match digest-pinned names to the cache's manifests.

**Source.** Epic 28 (#931).

## The default seed list builds only on Rebuild seed

**What.** On a new install the default seed list is written when an administrator first opens the Docker tab, and nothing builds it until they press Rebuild seed (SPEC.md section 16.6).

**What it would take.** Write the list at install and queue the first seed build after setup, if the pool has room.

**Source.** Epic 28 (#932).

## Keep running at a clock time

**What.** A student picks how many hours to keep the workspace running, not an end time on the clock (SPEC.md section 6.4).

**What it would take.** A time picker beside the hours choice, limited by the cap, with unit and Playwright tests.

**Source.** Epic 28 (#955).

## A cap on the browser's listening event

**What.** The listening-services event the API sends the browser (`packages/events/src/index.ts`) has an uncapped services array. The API's acceptance of agent frames bounds it today (SPEC.md section 24.5), but the browser schema does not say so.

**What it would take.** Apply `MAX_LISTENING_SERVICES` to the event schema too, with a contract test.

**Source.** Epic 28 security fix #984.

## The e2e toast helper can match two toasts

**What.** The shared `toast()` helper in `e2e/helpers.ts` can match two toasts when the same message shows twice, which trips Playwright's strict mode; one spec works around it with `.last()`.

**What it would take.** Take `.last()` inside the helper and drop the workaround, then run the specs that use it.

**Source.** Epic 28 (#981).

## Holds can be renewed indefinitely

**What.** The Keep running cap bounds how far ahead a hold reaches, not the total time held, as ruled, so a student can renew a hold forever (SPEC.md section 6.4).

**What it would take.** If that becomes a problem, a site setting for the longest total hold, counted from the first hold of a run.

**Source.** Epic 28 review (#955).

## Restore Claude Code's managed settings at start

**What.** A student who deletes `/etc/claude-code` in their workspace loses the image's `managed-settings.json`, which blanks `BROWSER` for Claude Code. The controller's start step restores only `CLAUDE.md` (SPEC.md section 3).

**What it would take.** Ship `managed-settings.json` from the package template too, or restore it at start, with a unit test.

**Source.** Epic 28 pilot verification.


## Move the 'student@<label>' rule into a numbered section

**What.** The SPEC.md rule for `student@<label>` lives only in section 29's Epic 8 entry, where readers looking for requirements will not find it.

**What it would take.** Move the rule into the numbered section it belongs to and point the Epic 8 entry there.

**Source.** Epic 29 review.

## Make the comment check read regex literals and quoted strings

**What.** `scripts/check-comment-history.mjs` does not understand regex literals, so a backtick inside one hides the rest of the file from the check (today only `apps/worker/src/grants.test.ts`). It also flags a CSS colour such as `/* grey #333 */`, a `#12` inside a quoted shell or YAML string, and a `.test("#123")` call read as a test title. None of these occur today.

**What it would take.** Teach the scanner regex literals and quoted strings, or use a real parser per language, with tests for each case.

**Source.** Epic 29 review.

## Drop workspaceId from the browser-open request

**What.** `BrowserOpenRequest` in `packages/contracts/src/browser.ts` still carries a `workspaceId`. The workspace agent always sends the nil id, and the API takes the workspace from its own records, because an id from inside the container cannot be trusted.

**What it would take.** Remove the field from the contract, the agent's broker and the API's frame handling, with the contract tests updated. Optional; nothing reads it today.

**Source.** Epic 30 review.

## Bound the unconfirmed-state check

**What.** A `settings.controller_checked_at` in the future, which happens when the clock is stepped back, counts as a fresh check, so the state is never marked unconfirmed until the clock catches up. `STATUS_REFRESH_SECONDS` also has no upper bound; above 120 seconds the state would flap to unconfirmed between refreshes (SPEC.md section 18.3).

**What it would take.** Treat a check time in the future as stale, and cap `STATUS_REFRESH_SECONDS` below the two-minute window in the worker's config schema, each with a unit test.

**Source.** Epic 31.

## A refused terminal create's recovery point

**What.** A terminal create refused at the 20-terminal cap may already have taken an agent-session recovery point. The point is left behind, bounded by the per-project point cap (SPEC.md section 9.7).

**What it would take.** Take the recovery point only after the capped insert succeeds, or delete it when the create is refused, with an API test.

**Source.** Epic 31.

## Caller deadlines on the remaining controller calls

**What.** Set-limits, CPU allowance, replace-home, deleting kept volumes and the added-packages read do not take the worker's budget signal; the lifecycle calls do (ADR 0034 decision 7).

**What it would take.** Pass `callerSignal` from each route into its provider method and Incus requests, with a deadline test per route like the lifecycle ones.

**Source.** Epic 32.

## Files over 800 lines

**What.** Lint warns about non-test source files over 800 lines. Still over: the controller's `provider.ts` (about 1,470), `FileTree.tsx`, `BackupsTab.tsx` (issue #1087), `reconcile.ts`, the API's projects routes, `git.ts`, `ImageTab.tsx`, `WorkspacesTab.tsx` and `listening.ts`.

**What it would take.** Split each along the seam where it starts doing a second job, as Epic 32 did for the agent's server and the controller's start steps, keeping existing tests' assertions.

**Source.** Epic 32.
