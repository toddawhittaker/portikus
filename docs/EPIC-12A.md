# Epic 12a: security test suites

This is the working brief for the half of Epic 12 that tests code already on `main`. SPEC.md section 29 does not list an Epic 12a yet. Until it does, this file is the requirement an agent implements against. Where this file is silent, `docs/SPEC.md` wins on behavior and `docs/STACK.md` wins on technology. Base commit: `main` at `f82b12e`.

## Where this epic sits

Epic 12 in SPEC.md section 29 bundles two kinds of work. The first is tests of code that already exists: the authorization matrix, filesystem escape, network isolation, preview origin, and resource exhaustion. The second is operational exercises: load and concurrency, backup and restore, the destructive infrastructure rebuild, deployment documentation, and the threat-model review. Epic 12a is the first kind, plus SPEC.md section 30 Gate C. Epic 12b is the second kind.

Epic 12a adds tests and the harness they need. It does not fix what the tests find. A finding follows the procedure in Part 3, and its fix goes in its own task PR.

## Why this epic is needed now

A lot is already tested, but in pieces, and one important piece never runs on the pilot VM.

- **Unit tests** cover the deny-by-default exemptions and CSRF (`apps/api/src/routes/hardening.test.ts`), socket origins (`ws-isolation.test.ts`), the preview threat model (`apps/api/src/preview/threat-model.test.ts`, `hostname-fuzz.test.ts`, `policy.test.ts`), the agent's path gate (`apps/workspace-agent/src/files.test.ts`), and several caps.
- **Cross-user tests** exist route by route, not as a matrix. Nothing fails when someone adds a route and forgets its ownership check.
- **The agent's token test** (`apps/workspace-agent/src/agent.test.ts`) probes only `/health`.
- **Playwright** covers one student reaching another's workspace, terminals, and projects, and preview browser isolation with a stand-in edge.
- **On the VM**, `infra/tests/smoke-test.sh` has Gate C checks, but they sit inside the lifecycle block, which skips itself whenever any workspace already exists. On the live pilot, Gate C has never run. The smoke test also never probes PostgreSQL, the host's own addresses, the inner Docker network, a second user's session through the real Caddy, or resource limits.
- **Archive extraction:** no file API extracts archives today, so zip-slip has no code to test until Epic 10's restore.

## What the suites prove

1. Every API route, WebSocket route, and workspace-agent route has a stated access rule, and the rule holds for every kind of caller.
2. No path spelling, symlink, or id mix-up moves a file operation outside the selected project of the caller's own workspace. Nothing a workspace does, including root inside nested Docker, reaches files on the VM or in another workspace.
3. A workspace, its processes, and its inner Docker containers can reach the Internet, but not management services, the host, or another workspace. The Internet cannot reach a workspace directly.
4. Preview content never gets the control plane's authority, and one student can never see another student's preview through the real edge.
5. The platform's size, count, and rate limits hold, and one workspace using everything it is allowed does not stop the platform or another workspace.
6. Gate C, on the real VM, with two users the suite creates and removes itself.

## The matrix

### Actors

| Actor | How it is made |
|---|---|
| Anonymous | No cookie. |
| Student A | Owns workspace A, project PA, terminal TA. |
| Student B | Owns workspace B, project PB, terminal TB. |
| Administrator | Role `administrator`; owns no student data. |
| Disabled user | A live session for a user with `disabled_at` set. |
| Workspace process | Code in workspace A. At the API it carries A's agent token as a bearer header and no cookie. At the network layer it is a process in A: as `student`, as root, or in an inner Docker container. It is also a hostile agent, because the agent runs as the student (ADR 0009, BROWSER-HANDLING.md section 11.2). |
| Preview origin | A request that carries A's cookie but has `Origin: https://<label>-5173.<preview suffix>`. |

### Targets

- Every HTTP route the API registers (`apps/api/src/server.ts`, `apps/api/src/routes/*.ts`, about 70 today).
- The four browser sockets: `/workspaces/:id/ws`, `/workspaces/:id/terminals/:tid/ws`, `/workspaces/:id/projects/:pid/events`, `/workspaces/:id/projects/:pid/checks/:checkId/runs/current`.
- The file routes, along two axes: path spelling, and id mixing (A's workspace id with B's project or terminal id).
- Preview hosts: A's host asked for by B, by anonymous, and by a forged `Host` or `X-Forwarded-*`.
- Workspace-agent routes and sockets (`apps/workspace-agent/src/server.ts`).
- The management network: the VM's addresses on the workspace bridge and management network, the libvirt host, every IPv4 address the host holds, link-local and metadata addresses, and the other test workspace.

### Access classes

Every route belongs to exactly one class. A route in no class fails the matrix.

| Class | Anonymous | Student A | Student B | Admin | Disabled | Bearer only | Preview origin (state-changing) |
|---|---|---|---|---|---|---|---|
| `public` (`GET /health`, `/auth/login`, `/auth/callback`) | allowed | allowed | allowed | allowed | allowed | allowed | n/a |
| `self` (`/auth/me`, `/auth/logout`, `/me/*`, `POST /workspaces`) | 401 | on self | on self | on self | 401 | 401 | 403 |
| `owner` (projects, files, git, search, checks, terminals, layout, listening, usage, preview grants and reset, and the terminal, events, and check sockets) | 401 | allowed | 404 | 404 | 401 | 401 | 403 |
| `owner-or-admin` (`GET /workspaces/:id`, start, stop, restart, the presence socket) | 401 | allowed | 404 | allowed | 401 | 401 | 403 |
| `admin` (`/admin/*`) | 401 | 403 | 403 | allowed | 401 | 401 | 403 |
| `preview-edge` (`/__portikus/bootstrap`, `/__portikus/reset`, `/preview/authorize`) | preview session only | a main cookie grants nothing extra | same | same | same | same | n/a |
| `inert` (`/workspaces/:id/preview/:port/*`, the old 501 placeholder) | 401 | 501 | 501 | 501 | 401 | 401 | n/a |

Across every class: a refused request never reaches any workspace agent (the fake agent's request log shows no call); a refused request's body names nothing about the other user's data; on every route with `:pid`, `:tid` or `:checkId`, A's workspace id with B's child id is a 404.

### A route added later fails until it is classified

The class table lives on the test side, in `apps/api/src/security/route-policy.ts`, keyed by `"<METHOD> <url pattern>"` with a `websocket` flag. `authz-matrix.test.ts` builds the server with `buildTestServer`, adds an `onRoute` hook before `app.ready()`, and checks both ways: every route the hook saw (including automatic `HEAD` twins and WebSocket routes) has a class, and every table entry still exists (`app.hasRoute`). `/health` is registered before the hook can be added, so `hasRoute` covers it. The agent gets the same check in `apps/workspace-agent/src/security/agent-auth-matrix.test.ts`: every agent route refuses no token and a wrong token, except `/__test/*` routes, which exist only on the fake agent.

## Where each test runs

| Kind | Where | Files |
|---|---|---|
| Authorization matrix: API, sockets, agent | Vitest, real test database, fake agent | `apps/api/src/security/`, `apps/workspace-agent/src/security/` |
| Filesystem escape through the API | Vitest, real database, two real agents in-process (pattern: `apps/api/src/routes/terminal-real-agent.test.ts`) | `apps/api/src/security/file-escape.test.ts` |
| Path spellings at the agent | Vitest, temporary directory | `apps/workspace-agent/src/security/path-escape.test.ts` |
| Limits and the hostile agent | Vitest, real database | `apps/api/src/security/limits.test.ts`, `hostile-agent.test.ts`, `apps/workspace-agent/src/security/limits.test.ts` |
| Browser behavior across users and from preview code | Playwright | `e2e/security-cross-user.spec.ts`, `e2e/security-preview-origin.spec.ts` |
| Gate C, network, container boundary, real Caddy edge, bounded limits | On the VM, over SSH, `make security-test` | `infra/tests/security-test.sh`, `infra/tests/security/*.sh` |
| Proof that the VM suite's cleanup deletes only its own rows | Shell, no VM, in `make infra-check` | `infra/tests/security-cleanup-scope-test.sh` |

## Rules for the VM suite

These protect the three live student workspaces.

- **It makes its own users** directly in PostgreSQL: subjects `sectest-<run id>-a`, `-b`, `-admin`; sessions expire in one hour; cookie `__Host-portikus_session`. It never signs in as alice, bob, or carol.
- **It makes its own workspaces**, two, through `POST /workspaces` as its own users. It records every id and instance name, and keeps them running by holding a presence socket, not by changing any setting.
- **It changes nothing global:** no grace period, log level, or other setting; no service restart; no admin lifecycle action on a workspace it did not create. The administrator actor only reads or acts on the suite's own workspaces.
- **It probes only its own workspaces.**
- **It proves it disturbed nothing:** before and after, it snapshots every other workspace (row state, desired state, shutdown deadline, Incus status) and the `settings` rows. A difference fails the run.
- **It checks capacity first:** if free memory or thin-pool space cannot take two more workspaces, it exits without creating anything.
- **It cleans up only what it recorded.** It reports leftover `sectest-` rows from an earlier run but deletes them only with `--sweep`.

## Decisions

- **Decision:** another student's resource answers 404, never 403, so its existence is not revealed (already the behaviour in `apps/api/src/routes/workspace-view.ts`; SPEC.md sections 5.2 and 24).
- **Decision:** an administrator can list workspaces and users, start, stop, and restart any workspace, and open its presence socket; an administrator gets 404 on terminals, files, projects, previews, events, and checks (SPEC.md section 20.2 rules out silent impersonation; the code already draws the line there).
- **Decision:** the route class table lives on the test side, so no production change is needed and no route can skip a check it cannot see.
- **Decision:** the VM suite makes its users by SQL, not the mock sign-in, whose fixed accounts may be in use on the pilot; this also works with a real identity provider.
- **Decision:** disk quotas are proved with `fallocate` past the volume size, not by writing data, so the shared thin pool is not used up.
- **Decision:** heavy limit tests (memory past 4 GB, an untimed fork bomb) run only with `PORTIKUS_SECURITY_HEAVY=1` and no other workspace present. By default the suite reads cgroup limits and runs bounded probes.
- **Decision:** a workspace reaching the public site through its public name and port is allowed. Blocked: direct access to the API, controller, mock provider, PostgreSQL, Incus, and SSH; the host on any address except the published port; link-local addresses; the other workspace (SPEC.md sections 23.1 and 23.2).
- **Decision:** the workspace agent counts as untrusted; the API is tested against a hostile agent (oversized, malformed, slow answers; answers claiming other workspaces; listening lists naming other addresses).
- **Decision:** zip-slip is not tested in 12a, because nothing extracts archives; Epic 10's restore brings its own traversal tests (recorded in `docs/BACKLOG.md`).
- **Decision:** gaps already documented in `docs/STATUS.md` are pinned as expected failures, not fixed here: no sign-in rate limit, no download size cap, plaintext API-to-agent traffic on the bridge, unbounded warn-line logging.
- **Decision:** suites live in `security/` directories and use existing helpers (`@portikus/auth/testing`, `@portikus/db/testing`, `ws`, `pg`, Playwright). No new dependency.
- **Decision:** matrix tests follow `test.skipIf(!hasTestDb())`, but `authz-matrix.test.ts` throws when `CI` is set and there is no database.

## Done

1. `authz-matrix.test.ts` fails, naming the route, when a route is registered with no class and when a class entry names a route that no longer exists.
2. Every API HTTP route answers each actor with its class's result. Every state-changing route refuses a missing Origin and a preview Origin with 403.
3. For every route with a child id, A's workspace id with B's project, terminal, or check id is a 404, and the agent log shows no call.
4. Every browser socket refuses anonymous, B, the disabled user, and a preview Origin before upgrading; the terminal, events, and check sockets also refuse the administrator.
5. A workspace's agent token as a bearer header with no cookie is a 401 on every API route.
6. Every workspace-agent route and socket refuses a missing token and another workspace's token. The URL broker socket is mode 0600.
7. File operations through the API reach only A's selected project, on two real agents with separate homes, for percent-, double-, and mixed-case-encoded `..`; `%2f` and `%5c`; overlong UTF-8; full-width dots and slashes; NUL; trailing dots and slashes; very long paths; symlink loops; and a symlinked project directory, across read, write, delete, mkdir, move (source and target), tree, download, search, git diff, and baseline diff.
8. Every cap without a direct test gets one at the API edge: attachments per terminal, forwards per workspace, preview sessions per user, search matches, checks per project, the JSON body limit on every route that takes a body, the 1 MiB frame limit on each browser socket, and the 64 KiB input frame.
9. A hostile agent cannot make the API crash, hang past its timeouts, buffer past its limits, send frames to another user's sockets, or name a preview upstream other than `<workspace agent_address>:<allowed port>`.
10. Playwright: in B's browser, A's workspace page shows no terminals, files, previews, or project names; A's preview URL shows a Portikus refusal; an administrator's browser on A's workspace page shows no terminals or files; preview code in A's browser cannot read `/auth/me`, cannot make a state-changing request, and cannot see the session cookie.
11. `make security-test VM_IP=<ip>` runs on the pilot with the live workspaces present, creates and removes only its own users and workspaces, and the before-and-after snapshot of every other workspace and every setting is identical.
12. **Gate C, files.** Through the real Caddy, B's session gets 404 on A's file, project, and download routes. A's container has no mount of B's volumes. The two workspaces' `volatile.idmap.current` ranges do not overlap. A file written by root in a privileged inner Docker container with a bind mount of `/` belongs on the VM to an unprivileged shifted UID. Symlinks planted at the paths the controller pushes, followed by a restart, create nothing on the VM.
13. **Gate C, terminals.** Through Caddy, B's and the administrator's sessions cannot open A's terminal socket. From workspace B, A's agent attach endpoint is unreachable. A's token is refused by B's agent.
14. **Gate C, previews.** Through the real Caddy, A's preview host refuses anonymous and B (including B with B's own preview cookie). A forged `Host` or `X-Forwarded-*` names no upstream. `/preview/authorize` and `/__portikus/*` are not reachable through the main site's host. A denied port (22, 2375, 2376, 5432, 7400) never gets an upstream.
15. **Gate C, agent endpoints.** From workspace B, from B's inner Docker container, and from the host, A's port 7400 is unreachable. From the VM without a token it is a 401.
16. **Gate C, management network.** From A as `student`, as root, and from an inner Docker container (default bridge and `--network host`), each target is refused or times out: the VM on 22, 80, the public port, 3000, 3001, 3002, 5432, and 8443 on its bridge and management addresses; the libvirt host; every address the host holds, on 22 and any listening port except the published one; 169.254.169.254; the other workspace on every probed port. With B's address added to A's interface, A cannot receive B's traffic or answer as B's agent. Internet egress (a package registry and GitHub) still works.
17. **Inbound.** From the host, neither workspace's agent port nor application port is reachable directly.
18. **Bounded exhaustion.** The container's `pids.max`, `memory.max`, and `cpu.max` match the profile (`infra/ansible/site.yml`). A bounded fork loop in A hits the process limit. `fallocate` past the home, Docker, and root sizes fails. Throughout, the API's `/health` and workspace B's agent answer within two seconds.
19. Every expected failure (Part 3) is listed in the run summary with its issue number. A marked test that unexpectedly passes is reported as needing its marker removed.

## Out of this epic

Load and concurrency tests, backup and restore, the destructive rebuild exercise, deployment documentation, and the threat-model review are Epic 12b. Fixes for findings are later task PRs, as are encrypting API-to-agent traffic, a sign-in rate limit, and the journald size cap.

---

# Part 2: Tasks for parallel builders

Each task owns only the files listed. Only T1 may edit `apps/api/src/fake-agent.ts` and `apps/api/src/test-support.ts`. Only T5 edits `Makefile` and `infra/README.md`. The orchestrator writes the Epic 12a section of `docs/STATUS.md` and the `docs/BACKLOG.md` note in a closing PR; no builder edits either.

- **T1: Authorization matrix** (unit, real test database). Files: `apps/api/src/security/route-policy.ts`, `authz-matrix.test.ts`, `ws-authz-matrix.test.ts`, `apps/workspace-agent/src/security/agent-auth-matrix.test.ts`; may add a request log to `apps/api/src/fake-agent.ts`. Done items 1 to 6.
- **T2: Filesystem escape** (unit). Files: `apps/api/src/security/file-escape.test.ts`, `apps/workspace-agent/src/security/path-escape.test.ts`. Done item 7. Read `apps/workspace-agent/src/files.test.ts` first and do not repeat its cases.
- **T3: Limits and the hostile agent** (unit). Files: `apps/api/src/security/limits.test.ts`, `hostile-agent.test.ts` (its own small Fastify agent), `apps/workspace-agent/src/security/limits.test.ts`. Done items 8 and 9, plus expected-failure tests for the documented sign-in rate-limit and download-cap gaps. Add only missing caps.
- **T4: Browser checks** (Playwright). Files: `e2e/security-cross-user.spec.ts`, `e2e/security-preview-origin.spec.ts`. Done item 10. Copy helpers from `e2e/preview-browser.spec.ts` if not exported; do not edit `e2e/helpers.ts`.
- **T5: VM harness and network isolation** (on the VM; infra agent). Files: `infra/tests/security-test.sh`, `infra/tests/security/lib.sh`, `infra/tests/security/network.sh`, `infra/tests/security-cleanup-scope-test.sh`, `Makefile` (`security-test` target with the `smoke-test` variables plus `PORTIKUS_SECURITY_HEAVY`, and the scope test in `infra-check`), and an `infra/README.md` section. Done items 11, 15, 16, 17, and the VM rules. `lib.sh` provides: `sec_init`, `sec_preflight`, `sec_snapshot_others`, `sec_cleanup`; `sec_mint_user KEY ROLE`, `sec_create_workspace KEY`, `sec_hold_presence KEY`; `sec_http KEY|- METHOD URL [curl args]`, `sec_ws_upgrade KEY|- URL ORIGIN`; `sec_exec KEY student|root CMD`, `sec_docker_exec KEY [--network host] CMD`; `sec_ws_ip KEY`, `sec_agent_token KEY`; `check`, `check_output`, `known_vuln ISSUE LABEL CMD...`. Verified on this host against the live VM before its PR opens. Lands before T6.
- **T6: VM cross-user, container boundary, preview edge, bounded limits** (on the VM). Files: `infra/tests/security/cross-user.sh`, `container.sh`, `preview-edge.sh`, `limits.sh`. Done items 12, 13, 14, 18. Built against the T5 interface; runs and opens its PR only after T5 lands. Modules use only the runner's two workspaces.

T1 to T4 run fully in parallel. After everything lands: security-reviewer and code-reviewer over the epic head, then the orchestrator's STATUS and BACKLOG PR.

---

# Part 3: When a suite finds a real vulnerability

1. **Write the test anyway**, stating the SPEC.md invariant it breaks. Do not fix product code in the same task.
2. **Mark it** so CI stays green and the mark cannot go stale: Vitest `test.fails("KNOWN-VULN #<issue>: <invariant>", ...)`; Playwright `test.fail(true, "KNOWN-VULN #<issue>")`; shell `known_vuln <issue> "<label>" <cmd>` (prints `KNOWN-VULN`, and `XPASS` when it unexpectedly succeeds).
3. **Report it:** what, how to reproduce, severity (crosses users, reaches the host, or only the student's own workspace), and whether it is exploitable on the live pilot now.
4. **Hold back what is exploitable now.** The repository is public. A high-severity finding exploitable on the live pilot is not pushed as a test or an issue: the builder stops and reports to the orchestrator, who brings it to the user; the fix and its test land together later. Low-severity and already-documented gaps get a public `bug` issue and the marker.
5. **Fix in a separate task PR**, starting from the marked test, removing the marker.

---

# Part 4: Risks and open questions

1. **The pilot runs the mock sign-in**, so anyone who can reach port 8443 can sign in as the administrator. The suite reports it as `KNOWN-VULN`, and Gate C is recorded as "passed except the identity provider" until a real one is in place.
2. **Likely findings in network isolation:** the VM's forward chain allows all egress except the management CIDR, the bridge address, and link-local, so the host's LAN address and the rest of the LAN are probably reachable from a workspace (SPEC.md section 23.2). Treat host SSH as high severity. The fix is a deny list of private infrastructure CIDRs in an infra fix task.
3. **Thin-pool overcommit:** the limits module reports the ratio and warns when free pool space is under one full workspace quota; the decision to fail on it belongs to 12b's capacity work.
4. **Load on the live VM:** run outside class hours, keep the capacity check and the heavy opt-in, keep the run under 15 minutes.
5. **The deployed version may not be `main`:** the runner prints `dpkg -s portikus`, and STATUS records it.
6. **A failed cleanup leaves an administrator row:** sessions expire in one hour, leftovers are listed each run, `--sweep` removes them, and the scope test proves cleanup touches nothing else.
7. **Route enumeration depends on Fastify:** `onRoute` with `hasRoute` fails loudly if behaviour changes.
8. **Findings could swamp the epic:** time-box each task; one marked test and one report per finding; fixes planned after all six tasks report.
9. **Plaintext API-to-agent traffic:** 12a pins the compensating controls (Done item 16); encryption is a later fix.
10. **A separate throwaway VM** is not needed for 12a; it belongs to 12b's rebuild exercise.

---

## Orchestrator rulings (2026-09-22)

These rulings settle overlaps between Epics 10, 11, and 12a, which are built in parallel. They override anything above that disagrees.

1. **Rebuild and Reset Docker routes belong to Epic 10.** Epic 10 registers `POST /workspaces/:id/reset-docker` (owner or administrator) and `POST /admin/workspaces/:id/rebuild` with body `{ resetDocker: boolean }` (administrator only), in a new file `apps/api/src/routes/maintenance.ts`, not in `admin.ts` or `workspaces.ts`. Epic 11 does not register either route and has no `operations.ts` hook. Epic 11's admin detail response reports `capabilities: { rebuild, resetDocker }` by asking Fastify whether those routes exist (`app.hasRoute`), so the buttons turn on by themselves once Epic 10 is merged, whichever epic lands first. Epic 11's dialogs call those two paths with that body.
2. **The admin page belongs to Epic 11.** Epic 10 does not edit `apps/web/src/admin/` or `e2e/admin*.spec.ts`. Epic 10's administrator path is covered by its API route tests and the smoke block; its admin buttons come from Epic 11. Epic 10 drops `e2e/admin-rebuild.spec.ts`.
3. **Unordered migrations.** Epic 11 task 1 turns on `allowUnorderedMigrations` in `packages/db/src/migrate.ts`. Epic 10 does not touch `migrate.ts`. Epic 10 uses migration 0013, Epic 11 uses 0014.
4. **Storage figures.** Epic 11's admin detail sends `storage: null` until Epic 10's per-class storage is on the same branch; whichever epic merges into main second fills it in.
5. **Issue #284 (egress allow-list) is deferred** to a later epic. Epic 11 task 7 is not built in this run. Epic 12a's network suite will show what egress is open today, which feeds that decision.
6. **Real host.** No builder stops, restarts, resizes, rebuilds, resets, or restores any existing student workspace, and none runs `make smoke-test` on the pilot while student workspaces exist. Epic 10 verifies on scratch instances it creates and removes itself, after taking `pre-epic10` snapshots of the student home volumes and a `pg_dump`. When Epic 10 has to install its package on the pilot to verify, the pilot is put back on the `main` package afterwards, so students never stay on unreviewed code. Epic 11's real-host work is read-only Incus queries plus volume-grow checks on `e11-scratch-*` objects. Epic 11 does not deploy to the pilot, and it does not disable or archive the #302 debris accounts; that waits for Todd.
7. **Shared tooling.** Every epic branch first receives the same "Per-run e2e ports and sharded browser tests in CI" change, so parallel Playwright runs do not clash.
8. **Docs.** Builders do not edit `docs/STATUS.md` or `docs/BACKLOG.md`; the orchestrator writes each epic's STATUS section and BACKLOG notes in a closing PR. SPEC.md edits named in a task stay with that task.
