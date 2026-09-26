# 0034. Platform resilience: restarts, priority, bounded calls, cached preview checks and a fail-fast storage pool

- **Status**: Accepted
- **Date**: 2026-09-26
- **References**: SPEC.md sections 4.3, 5.3, 6.5, 20.1, 24.7 and 25.3;
  STACK.md section 23; ADR 0033; issues #611 to #617

## Context

An audit of `main` on 2026-09-26 found that one crashed service, one busy
or stuck workspace, one full disk or one runaway browser tab could take
the platform down for everyone. Caddy and PostgreSQL did not restart on
failure. The whole platform had the CPU weight of a single workspace. A
hung stop held up the worker's sweep (its reconcile loop). Each preview
asset cost three database queries. A full storage pool froze every
workspace's writes. Epic 17 fixed these. This record keeps the reasons for
the choices a later reader is likely to question.

The numbers below match the rulings in the Epic 17 plan, which code
comments cite as "ADR 0034 ruling N". The settings with no real
alternative are listed briefly at the end.

## Decisions

1. **Caddy and PostgreSQL restart with `Restart=on-failure` and
   `RestartSec=5`,** like every Portikus unit and Dex. With a 5-second
   delay, systemd's default start limit (5 starts in 10 s) can never trip,
   so a crash loop retries for ever. The issue suggested 2 s; that starts
   about five times in ten seconds, close enough to the limit to risk
   leaving the site down for good. No watchdogs: they need `sd_notify`
   plumbing and no process has been seen wedged.
3. **`system.slice` gets `CPUWeight=1000` and `MemoryLow=512M`.** A
   workspace container is its own control group (cgroup), a sibling of
   `system.slice`, at the default weight of 100. At weight 1000 the
   platform wins about ten to one against each busy workspace. Under
   cgroup v2 a unit's `MemoryLow` protects it only up to its parent's
   protection, so the slice needs one for the units' own settings to work.
4. **`MemoryLow=256M` on PostgreSQL and the API,** so their page cache is
   not the first thing reclaimed. Because systemd 257 does not write a new
   `MemoryLow` into a running service's cgroup on a daemon reload, a change
   to PostgreSQL's drop-in restarts it once. The first deploy of Epic 17
   therefore restarts Caddy and PostgreSQL once each.
5. **No `IOWeight` and no `limits.disk.priority`.** I/O weights work only
   under the BFQ disk scheduler. The rehearsal found `none` on both of the
   VM's disks, and PostgreSQL already has the root disk to itself while
   workspaces use the data disk.
6. **No `limits.cpu.priority` on the workspace profile.** The slice weight
   gives the priority; two knobs would be hard to reason about together.
9. **Stops run in the background.** After the sweep moves a row to
   `stopping`, it starts the stop without waiting for it. A set of
   workspace ids with a stop in flight makes the sweep leave those rows
   alone, both when resolving stale `stopping` rows and when it sees a
   stopped row's instance still running. Running stops through the
   bounded loop inside the sweep, the issue's first idea, would still make
   the next sweep's starts wait up to 75 s behind one slow stop, which is
   the delay the audit measured. On worker shutdown in-flight stops are
   abandoned and the next sweep resolves their rows, as after a crash.
10. **The preview gateway caches the three database lookups for 2
    seconds, not the decision.** The cache maps the preview cookie's token
    hash to the preview session, main session user and workspace rows, and
    keeps only complete sets, at most 10,000 entries. Every check that
    reads the request (host, port, label, owner, running state, bridge
    path, registry, activity) still runs each time. A page of hundreds of
    assets costs three queries instead of three per asset.
11. **So any removal of authorization reaches the gateway up to 2 seconds
    late,** and so does its return. That covers sign-out, account disable,
    session expiry, workspace stop or delete, and a session gate. The
    cache lives in the API process while stops are revoked by the worker;
    exact invalidation would need a signal between processes for a
    2-second gain. A reset of the cache (`clear()`) bumps a generation
    counter so a lookup already in flight cannot store old rows.
14. **Database guard rails live in the client:** `connectionTimeoutMillis`
    5 s, `statement_timeout` 30 s and `idle_in_transaction_session_timeout`
    60 s on every process's `pg.Pool`, with a 503 `SERVICE_BUSY` from the
    API when no connection comes in time. In code they are covered by CI
    and need no PostgreSQL role change.
22. **A create refused because the pool is 90% full stays in
    `provisioning`,** with `error_code = POOL_FULL` and a message for the
    student, and the worker tries again every sweep. Failing the workspace
    to `error` would need someone to act once space is freed; staying in
    `provisioning` means it is created on its own. Start, stop and rebuild
    are never refused, because they do not add a volume. `POOL_FULL` is
    kept apart from `STORAGE_FULL`, which means one workspace's own volume
    is full.
23. **The thin pool errors when full (`lvchange --errorwhenfull y`).**
    With the default `queue`, a full pool blocks every workspace's writes
    for about 60 s and can hang Incus operations, which stalls the sweep.
    With `error`, the writing program gets "No space left on device" at
    once and the platform keeps working. The rehearsal measured 0.2 s
    against 62 s. The 70% and 90% thresholds (rulings 20 to 22) exist so
    this is rarely reached.

## The plain settings

7. Every worker-to-controller call has a time budget: stop
   `2 x STOP_TIMEOUT_SECONDS + 15` s, start `START_TIMEOUT_SECONDS + 30` s,
   create 300 s, list and log level 30 s, rebuild and reset-Docker 15
   minutes. Over budget is `ControllerClientError("TIMEOUT")`.
8. The controller gives every Incus request a 30-second default timeout
   when the caller passes no signal.
12. Each preview session may make 2,000 authorized requests per 10
    seconds; over that the gateway answers 429.
15. One fixed-window counter (`apps/api/src/rate-limit.ts`) serves the
    sign-in throttle, the preview cap and the per-user limits.
16. Per user: 20 workspace start, stop and restart requests a minute, and
    600 writes a minute across every non-GET files and projects route.
    Admin routes are not limited.
17. Over a limit: 429 `RATE_LIMITED` with `Retry-After`, one warning log
    line per user per window, no audit row.
18. A root timer writes the thin pool's data and metadata use to
    `/run/portikus-thinpool.json` every minute, because the unprivileged
    controller cannot run `lvs`.
20. The pool's fill is the larger of data and metadata use; the Health
    tab warns at 70%.
21. Administrators get a notification when the fill crosses 70% and 90%;
    each level re-arms 5 points below it.

## A fix found in the rehearsal: Incus operation status

Incus answers an operation wait with an outer success reply whatever
happened to the operation; the operation's own status sits inside it.
The controller read only the outer reply, so a graceful stop that timed
out counted as done and no forced stop followed. Waits now read the
operation's own status: 200 is success, 400 and up is a failure with
Incus's message, and anything else is a timeout. Callers that had relied
on every operation looking successful were made tolerant of the truth:

- start skips the request when the instance already runs, and goes on if
  a start fails but the instance is running;
- stop reports a forced stop when the forced stop fails but the instance
  is stopped, and a graceful stop that ends just as its wait gives up is
  not an error;
- the instance create waits up to 240 s instead of 60 s, inside the
  worker's 300 s create budget, and each volume create gets 60 s.

## Consequences

- One crash of Caddy or PostgreSQL costs about 5 seconds, not the site.
- A busy workspace cannot starve the API, worker or database of CPU.
- A stuck stop no longer delays anyone else's start.
- Preview access can lag a change of authorization by 2 seconds.
- A full pool fails writes in the workspace that hit it instead of
  freezing every workspace, and new workspaces wait until there is room.
- A create has no single shared deadline: on paper its steps can add up
  to more than the worker's 300 s budget. A retry adopts what already
  exists (BACKLOG, "One deadline for a workspace create").
