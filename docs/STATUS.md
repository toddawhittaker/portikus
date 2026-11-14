# Status

This file says, in a sentence or two per epic, what each epic delivered,
and then lists the open items: gaps that are still true today. Epic order
and acceptance criteria are in `docs/SPEC.md` section 29, and the reasons
for decisions are in `docs/adr/`. The detailed per-epic history up to
Epic 60, with every task, test run and rehearsal, is in
`docs/archive/STATUS-HISTORY.md` and in git history.

An epic's fold task adds one entry of one or two sentences below, adds any
new open items, and removes the open items the epic fixed. Wanted work
that is not a gap in something built goes in a GitHub issue instead.

## Epics

- **Epics 0 to 3.5, foundations.** The pnpm monorepo and its tooling, the reproducible platform VM (OpenTofu, cloud-init, Ansible, Incus, LVM thin storage), the Debian 13 workspace image with nested Docker, the workspace controller, API and worker, and the control plane packaged as one Debian package.
- **Epic 4, authentication.** OpenID Connect (OIDC) sign-in with sessions in PostgreSQL, student and administrator roles denied by default, owner-only workspace routes, and Caddy in front of the VM.
- **Epic 5, terminals.** The workspace agent inside each container, with one tmux session per terminal and a byte-pipe WebSocket from the browser through the API.
- **Epic 6 and the pilot feedback after it, the three-pane shell.** The design system in `packages/ui`, projects as folders under `~/projects` with create, clone, template, rename, duplicate, zip download, archive and delete, terminal splits and saved layouts, the live disconnect grace period, and structured logging.
- **Epic 7, files and Git.** The file tree, the Monaco editor, search, Git status and change review.
- **Epic 7.1, pilot fixes.** A batch of fixes and small features from the first hands-on use of the pilot after Epic 7.
- **Epic 8, preview.** The Running pane, project checks, and authenticated preview of a running web application on a host only its owner can reach (ADR 0018, `docs/BROWSER-HANDLING.md` phases A and B).
- **Epic 8 pilot fixes and Epic 8.1.** Two batches of small fixes from driving the pilot after Epics 7.1 and 8.
- **Epic 9, coding agents.** Launchers for Claude Code and Codex, the URL broker that lets a student confirm a link a workspace program asks to open, and review of a session's changes against its starting snapshot.
- **Epics 9.1 and 9.2, pilot fixes and accessibility.** Settings with a profile and per-user appearance, image paste into the terminal, and the fixes from an 18-issue WCAG 2.2 AA review, including a per-user screen-reader mode.
- **Epic 10, recovery and quotas.** Recovery points per project with restore, restore to before an agent session, three storage classes with warnings, and reset workflows.
- **Epic 11, administration.** The admin page with Workspaces, Audit, Health and Settings tabs, disable and enable, archive and unarchive, and grow-only storage.
- **Workspace egress to private ranges.** The VM firewall and the workspace network access control list (ACL) drop workspace traffic to private and special address ranges.
- **Epic 12a, security tests.** The route authorization matrix, filesystem-escape cases, hostile-agent and limit tests, and browser isolation checks (SPEC.md section 30, Gate C).
- **Epic 12b, pilot readiness.** Dex as the sign-in server, load and capacity runs, backup and restore, the destructive rebuild exercise, and the operator's runbook in `docs/OPERATIONS.md`.
- **Epic 13, LTI.** LTI 1.3 launch from a learning management system (LMS) and an instructor role (ADR 0025).
- **Epic 13.1, account linking.** Linking a course account to a single sign-on (SSO) account, and promoting administrators (ADR 0026).
- **Epic 14, sign-in providers.** Provider sign-in through Dex connectors, a first-administrator setup code, Dex users and the instructor grant in the Users view, the egress proxy, and Dex storage in PostgreSQL.
- **Epic 14.1, fixes after Epic 14.** LTI workspace names, Dex pages in the Portikus look, administrators landing on the admin page, and asking for a person's name in Add user.
- **Epic 14.2, one front door.** Dex is the only sign-in front door and every install has a local administrator (ADR 0031).
- **Epic 14.3, resource guard.** A terminal limit of 20, toasts that time out with a notification history, and the resource guard with CPU throttling, idle stop and an acceptable-use notice.
- **Epic 18, admin interface polish.** A compact admin frame with consistent headings and table styles.
- **Epic 20, student interface polish.** Clearer status bar items and a way forward from every stuck screen.
- **Epic 16, workspace resilience.** Size-capped `/tmp`, tmux in its own unit, and recorded exits after out-of-memory kills (ADR 0035).
- **Epic 17, platform resilience.** Caddy and PostgreSQL restart on failure, and the platform's own services are protected from workspace load (ADR 0034).
- **Epic 19, admin observability.** A Health tab with a Trends card, failure lists and workspaces by state (ADR 0036).
- **Epic 21, resource tools.** Monitor with Stop for a student's own processes, and the administrator's process list (ADR 0037).
- **Epic 23, student interface leftovers.** Storage meters on the error screen, clear disabled confirmations, and a confirmation for resetting preview data.
- **Epic 22, pilot fixes after Epics 16 to 21.** Reliable workspace stop and a batch of small fixes.
- **Epic 24, admin operations.** Workspace egress in open or allow-list mode, per-workspace limits, re-provisioning after a failed create, and backup operations (ADRs 0038 to 0043).
- **Epic 25, UI polish and help.** Toggletips, page introductions, the in-app `/help` page by role, and a design pass over every screen.
- **Epic 15, `apt install portikus`.** An operator installs Portikus on a rented Debian 13 server with `apt install portikus` and a few questions, and the server backs itself up (ADRs 0029, 0030 and 0044).
- **Epic 15.1, install docs and release polish.** The install guide, GitHub community files, and release fixes.
- **Epics 15.2 and 15.3, pilot fixes.** Claude Code login in a workspace, archive extraction, PDF viewing, and other fixes from the pilot.
- **Epic 26, shared Docker pull storage.** A Docker Hub pull-through cache on the workspace gateway and a seeded image store (ADR 0045).
- **Epic 27, certificates.** A Certificate admin tab for Caddy's internal authority, ACME issuers and uploaded certificates (ADR 0046).
- **Epic 28, fix batch.** "Keep running until" for workspaces and a batch of fixes and backlog items.
- **Epic 29, code quality.** Shared helpers across the apps, complexity and copied-code limits in lint.
- **Epic 30, architecture review fixes.** One background runner per workspace for controller calls in the worker, and the other fixes from the architecture review.
- **Epic 31, reliability and polish.** Start retries, a verified-state signal for the workspace, admin polish, and CI and lint work.
- **Epic 32, hotspots.** The busiest files split, and one deadline for every worker-to-controller call.
- **Epic 33, UI polish.** Admin layouts, Settings and accessibility fixes (ADR 0047).
- **Epic 34, internet launch.** A site on a rented host with a public address on one domain, with sign-in limits, second factors and passkeys, invitations instead of self sign-up, and off-site backups (ADRs 0048 to 0050).
- **Epic 35, notifications and root shell.** Admin notification settings with alert channels, and a root shell for administrators (ADRs 0051 and 0052).
- **Epic 36, internet hardening.** Sign-in counters in PostgreSQL, an offline breached-password list, and other hardening before a site faces the internet (ADRs 0053 and 0054).
- **Epics 37 and 38, bug fixes.** Two fix batches of 25 and 17 issues from the old backlog.
- **Epic 39, workspace polish.** Fifteen bug fixes and small features for the work area, including voice input (ADR 0055).
- **Epic 40, coding agent updates.** Claude Code and Codex live in a shared folder on the server, so they update without rebuilding images (ADR 0056).
- **Epic 41, fix batch.** Certificate job and tool fixes after Epic 40.
- **Epic 42, instructor features.** Read-only project sharing with instructors, roster sync, Deep Linking to a starter project, and agent usage reporting (ADRs 0057 and 0058).
- **Epic 43, admin self-service.** A root site job that applies the site address, proxy hosts and LMS platforms from the admin pages, with a trial and revert (ADRs 0059 and 0060).
- **Epic 44, site address and package removal fixes.** DNS checks before an address change, and clean package removal (ADR 0061).
- **Epic 45, image and Docker cache.** Playwright's headless Chromium in the workspace image and a default Docker seed list (ADR 0062).
- **Epic 46, operator tests and package leftovers.** Clean purge and reinstall, and install-test and rehearsal coverage for the operator's paths.
- **Epic 47, workspace polish.** Multi-item tree drag, deleting kept restore folders, stopping a process tree, and other polish.
- **Epic 48, live help.** Instructor live help in a student's workspace, and live layout sync between browsers (ADR 0063).
- **Epic 49, fix and polish batch.** Closing a terminal ends its processes, narrow-width layouts, and other fixes.
- **Epic 50, sign-in and identity.** Account email for set-password and reset links, invitations by email, passkey linking, and Google and Entra group sign-in (ADR 0064).
- **Epic 51, fix batch.** Fixes after Epics 48 to 50.
- **Epic 52, code help and course profiles.** Language servers in the workspace for code help, and an Agentic or Traditional profile per LTI course (ADRs 0065 and 0066).
- **Epic 53, Settings redesign.** A redesigned Settings page and code help turned on per language (ADR 0067).
- **Epic 54, fix batch.** Load-proof unit tests, backup and audit fixes, and other fixes after Epic 53.
- **Epic 55, quick fixes.** Faster multi-delete of backups and a flaky test fixed.
- **Epic 56, agent status.** Working, needs-input and finished marks on agent tabs, plan usage meters, and file drop into the terminal (ADR 0068).
- **Epic 57, pilot fixes.** Layout saves behind compression, LTI setup and other pilot fixes.
- **Epic 58, chat tab.** A graphical chat tab for Claude Code (ADR 0069).
- **Epics 58.1 and 58.2, chat and phone fixes.** Two fix batches for the chat tab and the phone layout.
- **Epic 59, agent rows and chat.** Agent and subagent rows in the left pane, and a chat batch with `!` shell commands, `@` file mentions and changed-file lists (ADRs 0070 to 0073).
- **Epic 60, documentation refresh.** The guides, the in-app Help and the documentation images brought up to date, and this file cut down to this form.
- **Epic 61, UI refresh.** A new look for the student and administrator screens in both themes: a warm palette with teal actions and a violet agent hue, a type scale, a context meter in the chat composer and clearer admin pages (DESIGN.md section 11).
- **Epic 62, fix batch after the UI refresh.** Claude Code's own model list with a Version picker, chat titles with a pencil rename, per-pane zoom, an always-shown context meter, coloured Git letters and file-type icons, a tinted Monitor, a read-only panel for watching a subagent, and fixes for the phone drawer names, the ended chat tab and the Dex logo cache; pilot testing then reshaped the Chat options panel into labelled fields, gave split panes an even focus ring, made the subagent panel a floating card, dropped the Agent card's raw text and lined up the Running pane's ports (ADR 0074).
- **Epic 63, fix batch.** A quiet line in the chat for each permission decision, a browser question card for Claude Code's questions in a terminal tab (ADR 0075), every terminal drawn with WebGL so box lines have no gaps, a language tag and colour on every file-type icon in the Files pane, and two flaky tests made certain.
- **Epic 64, admin and instructor redesign.** The winner of a graded design hill climb for the administrator and instructor pages: one page frame with a left rail, an attention summary, a side inspector with Overview, Activity and Account tabs, quiet dot-and-word states, Logs and Audit as workbenches, a Class now summary and dot per student on the course page, and live help in a workspace-style terminal frame; plus the graders' remaining notes, the code and accessibility review fixes, and the design system and mockups brought up to date (DESIGN.md sections 9 and 11, SPEC.md 20.1).
- **Epic 65, fix batch with editor colour schemes.** Students pick an editor colour scheme in Settings: Portikus (the default), VS Code, IntelliJ, GitHub, Solarized, Catppuccin or High contrast, each in light and dark; the Health page says "Worker not reporting" when the worker has never reported; a terminal question is announced to screen readers when focus is in another pane; the Files pane gains database, binary, slides and log icons; the design README says what the console stylesheet is built from; and three flaky tests are fixed.
- **Epic 66, Codex in the chat.** A Codex (GUI) chat tab at parity with Claude Code, through one shared chat core with a driver for each agent (ADR 0076); skills and MCP servers for both agents, Codex subagent rows in the left pane and the chat, and switching a chat between Claude Code and Codex mid-conversation.

## Open items

Items marked "unverified" were not checked against the code when this
list was made and may already be fixed.

### Security

- Previews are served under the site's own registrable domain; a separate preview domain is #1236, and the stronger binding of preview tickets than the `Sec-Fetch-Dest` header is #1240. Until #1236, administrators who sign in through Google or LTI should teach from a separate instructor-only account.
- Traffic between the API and each workspace agent is plain HTTP on the workspace bridge, protected by the per-workspace bearer token and the network ACL.
- Accepted: the agent's token is readable by the student, so a student can call their own agent's API directly; the control plane trusts none of the agent's claims (`docs/BROWSER-HANDLING.md` section 11.2).
- Accepted: a hard link inside a project to a file outside it gets past the agent's path confinement; the student already has a shell in the container.
- Accepted: a student with sudo can protect a program from the administrator's Stop by running it as root, or slow the process list with many empty control groups (ADR 0037).
- Blocking sites in open egress mode is best effort, and domain fronting inside TLS stays open in allow-list mode (ADRs 0038 and 0043). While `nftables.service` is stopped, only the Incus ACL protects the gateway.
- Ending a root shell by audit session id is best effort against root, and a service started with plain `systemd-run` from a root shell is listed but not stopped.
- New breached passwords are caught only when the pinned SecLists snapshot is bumped.
- Some counters live in one API process and reset on restart: the log alerts' hourly memory, the certificate ask endpoint's hourly count, and the per-workspace administrator-socket count (unverified).
- Agent usage counts come from the student's own workspace and can be forged, so they are for reporting only. The secret filter on shared projects is a deny list.
- Codex downloads rely on GitHub's digest and the release checksum file, with no signature check (accepted, ADR 0056).
- Encryption at rest and an off-server backup copy on rented hardware: #1142. Incident response for administrators: #920.
- The threat model is kept private until Todd decides whether to publish it.
- Safari is not tested against the content security policy.

### Sign-in and courses

- Google and Entra group sign-in have not met a real tenant (#1587), and Entra users in more groups than a token holds need a Microsoft Graph lookup (#1588). Active Directory has not been tried; OpenLDAP stood in for it.
- Real mail delivery has been checked only through a stand-in relay.
- Two set-password links sent in the same millisecond both stay valid, and a link whose email failed to send stays until it expires.
- Removing a Dex user deletes the Dex password inside the database transaction, so a failed commit leaves the account enabled with no password.
- Changing `PORTIKUS_ADMIN_EMAIL` after the local administrator exists changes nothing; the manual step is `portikus reset-admin --email`.
- More than one Dex connector per site is not built (unverified).
- Grade passback to the LMS is not built.
- Roster sync runs only when an instructor opens the Course page or presses Sync, and a memberships host that is not a keyset or token host must be added to the egress list by the operator.
- Accepted: a course user who can edit their own LMS email can choose their workspace label through the email fallback.

### Workspaces and resources

- Workspace starts are over target under load: with 25 students starting within 48 seconds, start p95 was about 12.6 seconds against 10 (`docs/CAPACITY.md`).
- The VM replacement for a memory and CPU resize has not been rehearsed, and the confirming load test at 8 vCPUs and 16 GiB has not run. At 25 Agentic students on 16 GiB the 2 GiB free-memory target is not met (`docs/CAPACITY.md`).
- A student can fake activity with a script that holds their session cookie, which keeps idle stop away; the CPU throttle still applies.
- Files in the workspace's `/tmp`, a tmpfs, count as memory and can raise the memory flag.
- The Docker slice's process cap is an accident guard that a determined student can leave, and it does not follow a per-workspace process override.
- The Checks process cap counts all the student's processes, so a fork bomb in a check can starve terminals while it runs.
- The exit record can wrongly say `oom-kill` after an earlier out-of-memory kill in another pane (ADR 0035).
- A closed terminal cannot catch a process that clears its own environment; only a control group per terminal would.
- Kept restore folders are listed only while the workspace runs, and a folder that no recovery point or restore names is shown nowhere.
- A workspace whose agent lists more than 20,000 archives never has its orphan archives swept.
- The storage quota warning reads only user quotas, not group or project quotas.
- A priority lowered from Monitor cannot be raised again from Portikus.
- A student's own edits to `/etc/docker/daemon.json` are reset at every start.
- An abort during the Docker seed copy or instance create does not cancel the Incus operation; a retry adopts what exists (ADR 0034). An in-container edit that times out is left running until it exits.
- The language servers' output buffers in the agent are not bounded; the harm stays inside the student's container.
- A named pipe at `/etc/hosts` or `/etc/docker/daemon.json` blocks the controller's read at start, for that workspace only (unverified).
- Wanted: a bandwidth cap per workspace (#915), ZFS storage (#799), admin-chosen image packages (#627) and per-course tool versions (#1623).

### Files, editor and terminals

- Live file updates inside hidden and generated folders reach one level deep, at the project root only; deeper changes wait for the next refetch.
- The destination of a create-folder or move can race, because Node has no `RENAME_NOREPLACE`.
- The Move to dialog and the file viewer's sibling list see only the first page of a long folder.
- Undo history is lost when an editor remounts; only the text is carried over.
- A PDF over 50 MB is offered as a download, and CSV view is read-only with at most 1,000 rows and 200 columns.
- Screen-reader mode is off by default, because xterm.js then drops text that arrives without a key press, such as dictation.
- Turning a code help language off does not close sockets already open.
- Code help for more languages is #1652 and a debugger is #1622; signature help, find references, code actions and format on save are not built, on purpose (SPEC.md section 13.6).
- Wanted: picking an element in the preview to send to the agent (#1708), and stored check history (#1237).
- The Playwright projects other than `terminal-webgl` run Chromium with 3D off, so most terminal specs exercise the DOM renderer; only `e2e/terminal-webgl.spec.ts` covers WebGL.
- The editor's per-file zoom is lost when the student leaves the workspace route, because it lives only in the layout store; SPEC.md says it survives. Terminal and chat zoom do survive, in the tab's sessionStorage.

### Chat and coding agents

- The full chat path with a signed-in Claude account (subagent rows, `!` commands, read aloud, the context meter) has not been run end to end on a VM. The pilot still needs a check that `SubagentStop` hooks fire under the SDK and that only `/clear` changes the session id.
- Haiku sometimes ignores a message sent while Claude works (#1801).
- Permission decisions shown in the chat live in the chat host's memory, so a host restart or a resumed ended chat loses them.
- Answering a permission card splits an open tool group, because a call with a decision stands alone (a visual jump).
- The "Answered in the terminal or timed out" notice on a terminal's question card shows for 4 seconds only.
- A long decision target in the chat is cut with an ellipsis; its full text is in a tooltip.
- A question asked in a Codex terminal tab has no browser card, because Codex has no hook that can hold a question open; the tab shows needs input.
- Codex subagent panels opened from separate left-pane rows share the title "Subagent".
- The smoke check's self-test (`chat-probe-test.sh`, `fake-chat-server.mjs`) has no Codex scenarios.
- A `!` command run in a resumed Claude chat before the first message after an agent switch is hidden after a reload.
- Claude's automatic title for a chat that began on Codex is unchecked: it may read the handoff block.
- Accepted: if a student stops Claude Code with Esc, its tab shows "working" until the next prompt, because Claude sends no hook for it.
- A GUI and a terminal session of Claude Code can still run one session at once; Help says not to.
- The `@` menu lists files only, with no recency boost, and does not work in shell mode. A `!` command cannot be sent while Claude works and has no standard input. `/resume` stays terminal-only.
- Files changed does not count deleted files or changes made by shell commands.
- A typed message that contains `<bash-input>` text replays as a shell item on reload (display only).
- Subagent frames re-render the whole chat view while the subagent panel is open.
- More than 256 running subagents drop from the running list.
- Accepted: Escape closes the subagent panel only when focus is inside it.
- A model row from Claude Code whose value ends in `[1m]` would be listed as its own family and never highlight (only if Claude Code lists such rows).
- Unread marks do not survive a reload, and usage warnings are remembered per browser, not per user.

### Interface and accessibility

- A manual VoiceOver pass over headings inside `<summary>` elements is #1260.
- A toast can cover a focused row near the bottom of a drawer (WCAG 2.4.11), and the plan meter popover can cover a toast.
- The Audit tab and the other refreshing admin tabs do not announce new rows to screen readers. The Health heat map's cell values are not readable by sighted keyboard users.
- The shared Checkbox's unavailable look is faint in both themes.
- A course profile change picked up when the window regains focus can remove the control that has focus.
- Audit has no date-range or result filter; both need an API change.
- Each course card on the instructor's course list asks for its own members and live help counts; the course list response could carry them in one request.

### Infrastructure, packaging and backups

- Incremental, deduplicated backups with an off-host copy are #753. The off-site target needs rrsync, and its prune bounds only steady use, so a broken-into server can fill the target's disk.
- The `FAILED`, `SKIPPED` and `REQUESTED` marker files in a backup set are not covered by its MAC (message authentication code), and a set's MAC does not check its `vm` line. A whole-server restore is a shell command, not a button.
- A VM that sends data slowly can hold the host-wide backup lock for up to 12 hours.
- Pinning between two published versions is untested (#1263).
- Purge keeps the `squid.conf` setup wrote, so Squid stays disabled until its owner restores Debian's file, and keeps `distrobuilder`.
- A connection to a newly blocked site that already goes through Squid keeps working until it closes, because Squid is reloaded, not restarted.
- Setup fetches a provider's discovery document directly as root rather than through Squid (accepted, ADR 0059).
- The shared coding-agent tools arrive only when setup runs, about two minutes after an upgrade restart.
- Certificates: only Cloudflare DNS-01 is tested end to end, re-applying the same settings leaves Caddy serving its old certificate until renewal, split-horizon DNS can make a public name read as private, and the internal authority's 12-hour certificates show the red expiry notice.
- Monaco bundles DOMPurify 3.4.15 (#1829). Wanted: an OpenAPI document from the contracts (#1221), the libvirt provider 0.9 (#767), and self-hosted CI runners (#958).

### Tests and docs

- Under heavy machine load some unit tests and chat Playwright specs time out; each passes when run alone; two chat composer specs are #1887. The workspace-agent unit suite has order dependence under `--sequence.shuffle`.
- Nothing checks that the guides and the in-app Help agree, and the documentation images show scripted data.
- The build script for `design/mockups/portikus-console.css` is not committed, so the file cannot be rebuilt from the repository (`design/README.md`).
