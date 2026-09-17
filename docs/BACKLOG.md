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
