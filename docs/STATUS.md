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
per listing) are never pruned. From Epic 6, the 1024-wide rail collapse is
deferred, a clone shows no progress while it runs, a download has no size
cap, discovery ignores directories that are not repositories, unarchiving
is only reachable through the API, right-click paste in Firefox depends on
the browser's own paste prompt, a failed archive stream can reach the browser
as a truncated zip, a failed download shows the API's JSON error page, and
rename is not atomic across the agent and the database, so a crash between
them leaves the old row missing and the new directory discovered as a
separate project. Terminal names count per workspace rather than per
project, so a second project's first terminal may be "Terminal 3", and a
workspace created on an older image lacks zip until it is recreated, which
the agent reports as a download failure. From the grace period task, the
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
restarts. Epic 7 (files, Monaco, search,
and change review) is next.
