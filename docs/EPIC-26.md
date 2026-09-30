# Epic 26: shared Docker pull storage (issue #840)

This plan lives only on `epic/26-docker-cache` (docs/WORKFLOW.md, "Epic
plans"). Code, tests and other docs cite SPEC.md sections or the ADR the
fold task writes, never this file. The fold task deletes it.

Base: `epic/26-docker-cache` at 1e0aa64, plus this plan's pull request,
which also adds the shared contracts in
`packages/contracts/src/docker-cache.ts` (tests beside it) and one
optional `docker` field on `StartInstanceRequest` in
`packages/contracts/src/controller.ts`. Every task builds against those
shapes and does not change them; a task that finds one wrong says so in
its pull request and the orchestrator rules.

## What the user gets

- Students pull Docker Hub images through a cache on the Portikus VM, so
  the second student to pull `redis:7` downloads nothing from the internet
  and the site stays under Docker Hub's anonymous rate limit.
- New workspaces, a student's Reset Docker and an admin rebuild start with
  a Docker volume that already holds the seed images (for example
  `python:3.12`, `node:22`, `postgres:16`), as a thin copy that costs no
  disk until changed.
- Administrators get a Docker admin tab: cache size, use and Clear cache;
  an optional Docker Hub credential; a ghcr.io cache switch (off by
  default); the seed image list, the seed size cap, Rebuild seed with
  progress, and the current seed's size, images and image version; and a
  usage report of images pulled that are not in the seed and seed images
  nobody uses.

## Rulings (product owner, settled)

1. Build both a pull-through cache and seed snapshots.
2. The Hub cache is Debian's `docker-registry` 2.8 in proxy mode on the
   workspace gateway, `10.200.0.1:5000`, with its storage on its own
   loop-file ext4 filesystem at `/var/lib/portikus-registry`, sized by an
   install question. Debian's own `docker-registry.service` (which listens
   on every interface) is masked.
3. Registry 2.8 has no size cap. Its built-in 7-day expiry stays; the
   helper's timer also clears the cache when it passes 90 percent full
   (`REGISTRY_AUTO_CLEAR_PERCENT`). Clearing remakes the filesystem (S1).
4. Docker Hub is always cached. ghcr.io is an administrator opt-in, off by
   default: a second registry on `10.200.0.1:5001` with a certificate for
   `ghcr.io` from an internal certificate authority (CA), plus a hosts
   entry pointing `ghcr.io` at the gateway (S3). The page says plainly that
   while it is on, `docker push` to ghcr.io, private ghcr images and
   non-Docker tools that talk to ghcr.io (curl, `gh`, ORAS) do not work.
5. The optional Docker Hub credential is write-only, stored like other
   admin secrets, applied through a root helper on the ADR 0030 path-unit
   pattern. The page warns to use an account with no private
   repositories, because every student could pull them (S5).
6. One global seed volume, `portikus-docker-seed`, with
   `security.shifted=true`. A workspace Docker volume is created as a copy
   of it, sized at the configured Docker size plus the seed's size, only
   at workspace create, student Reset Docker and admin rebuild with Reset
   Docker. An existing volume is never replaced. No seed means today's
   empty volume.
7. Usage is aggregate only. Registry pulls come from the registry's
   notification webhook to the worker on 127.0.0.1, matched to a workspace
   by the pulling bridge address at receipt. Seed use comes from a new
   workspace-agent inventory route, polled by the worker. A seed image
   counts as used in a workspace if a container references it, or another
   local image's layer list starts with its layer list.
8. The egress allow-list is not bypassed through the cache. The gate is
   the name-based drop in S2; the worker also leaves the mirror out of
   `daemon.json` when the policy would drop the port.
9. The controller writes `daemon.json` (keeping the `overlay2` storage
   driver and containerd snapshotter off) and, while ghcr is on, the hosts
   entry and the CA into the workspace before each start. `incus file
   push` works on a stopped container.
10. The admin section is a new `docker` tab, placed after `image` in
    `apps/web/src/admin/tabs.ts`, because the image tab is its nearest
    relative and the settings tab is already long.

## Security rulings

From the security design review of 2026-09-30; the orchestrator adopted
every amendment. Each ruling names the task that owns it, and that task's
done criteria below include it.

- **S1, the Hub cache process (T1).** The registry runs as its own system
  user under a systemd sandbox with `MemoryMax=` and `TasksMax=`. It
  listens only on `10.200.0.1:5000`, and the host firewall accepts that
  port only from the workspace bridge interface. Its storage is its own
  loop-file filesystem. Debian's `docker-registry.service` is masked, not
  just disabled. The access log is off (`log.accesslog.disabled: true`),
  the log level is info or lower, and there is no `http.debug` listener.
  Each source address gets a connection-count cap on 5000 and 5001, like
  Squid's 256. Clearing the cache means stop the service, unmount, make a
  fresh filesystem on the loop file, mount, start; root never runs
  `rm -rf` inside a directory the registry user owns. T1 confirms the
  Debian build carries the fix for CVE-2023-2253. The smoke test checks
  that PUT and POST to 5000 (and to 5001 while ghcr is on) answer 405.
- **S2, the egress gate (T2 renders it, T1 the fail-closed files).** The
  gate lives in the egress helper's `inet portikus_egress` table as an
  input-hook chain. It drops every packet to 5000 and 5001, with no
  "established" accept ahead of it, unless the policy's own name matcher
  allows fixed names: for Hub, `registry-1.docker.io`, `auth.docker.io`
  and `production.cloudflare.docker.com`; for ghcr, `ghcr.io` and
  `pkg-containers.githubusercontent.com`. This covers allow-list mode and
  open mode's blocked sites alike. `egress-drop-all.nft` and the guard
  table carry the same drops, so a failure closes the ports.
- **S3, ghcr (T1 and T2; T5 the page).** Off by default. The Incus ACL
  opens only 5001 on the gateway, never 443. The redirect of 443 to 5001
  is rendered next to the S2 gate in `portikus_egress`. The CA is name
  constrained to `ghcr.io`, its key is root-only, and it is trusted only
  through `/etc/docker/certs.d`. The page states what breaks while it is
  on.
- **S4, shifted volumes (T2 code, T1 smoke).** `security.shifted` is
  accepted. One shifted volume is never attached to two workspaces. The
  smoke test checks that the `portikus` and `nobody` accounts cannot walk
  into `/var/lib/incus/storage-pools/workspace-data/custom/` (a mounted
  Docker volume, the seed, a stopped workspace's volume), by `stat` on
  each part of each path.
- **S5, the Hub credential (T1 helper, T4 API, T5 form).** The form asks
  for a Docker Hub personal access token with "Public Repo Read-only"
  scope, beside the warning. Setting, changing or clearing it clears the
  cache. The request file is mode 0600, and the helper reads and deletes
  it. The audit records only "set" or "cleared". The API answers only
  whether one is set.
- **S6, `/v2/_catalog` (no task).** Every workspace can list what is
  cached. Accepted; no proxy goes in front (Caddy was ruled out in ADR
  0038).
- **S7, usage data (T1 token file, T3 agent, T4 worker, T5 rendering).**
  A notification's address can carry a student's X-Forwarded-For value, so
  it is a hint only: keep it only when it is a single IPv4 address inside
  the bridge range, and never use it for anything per student. Store at
  most 2000 distinct image names a day; the rest count as "(other
  images)". Repository and tag must match the reference grammar, and the
  page renders them as text. The webhook listener on 127.0.0.1 requires a
  header token, set in the registry's notification headers, read from a
  root-generated file readable only by the registry and worker users. The
  agent's inventory calls `/usr/bin/docker` by absolute path, with a
  timeout, an output size cap and an item cap; the platform checks the
  reply against the schema, and a failure counts as no data.
- **S8, the seed build (T2 builder, T4 guard and setting, T5 page).** The
  seed builder is an ordinary unprivileged workspace container on the
  workspace network behind the workspace ACL. Image names follow the
  strict pattern (first character a lowercase letter or digit; no host
  but `docker.io`, and `ghcr.io` only while S3 is on; no `host:port`; an
  optional `@sha256` digest), are passed as separate arguments with no
  shell, and are capped in count (30). Before the snapshot the builder's
  dockerd is stopped cleanly and its containers and build cache removed.
  The seed has a size cap, a setting defaulting to 8 GiB. The resource
  guard's admission check (Epic 14.3) counts the configured Docker size
  plus the seed size.
- **Also (T2).** A unit test shows that `incus file push` into a
  container whose `/etc/docker` is a symlink stays inside the container.

## Interfaces

All shapes named here are exported from `@portikus/contracts`
(`packages/contracts/src/docker-cache.ts`).

### Admin API (T4 builds, T5 calls)

All routes are administrator only, added to
`apps/api/src/security/route-policy.ts`, and every change writes an
`audit_events` row (never the token).

| Route | Body | Answer |
|---|---|---|
| `GET /admin/docker` | none | `DockerAdminResponse` |
| `PUT /admin/docker/settings` | `DockerSettingsRequest` | 204; saves `ghcrEnabled` and `seedMaxGiB`, and writes a `set-ghcr` helper request when the switch changed |
| `PUT /admin/docker/hub-credential` | `HubCredentialRequest` | 204; writes a `set-hub-credential` helper request only; the API keeps no copy |
| `DELETE /admin/docker/hub-credential` | none | 204; `remove-hub-credential` request |
| `POST /admin/docker/cache/clear` | none | 202; `clear` request |
| `PUT /admin/docker/seed/images` | `SeedImagesRequest`, then `seedImageListFor(ghcrEnabled)` | 204; saves the list for the next rebuild |
| `POST /admin/docker/seed/jobs` | none | 202 with `SeedJob`; 409 `SEED_JOB_RUNNING` when one is queued or running, 409 `SEED_LIST_EMPTY` when the list is empty |
| `GET /admin/docker/seed/jobs` | none | `SeedJobsResponse`, newest first, last 10 |
| `GET /admin/docker/usage` | none | `DockerUsageResponse`, window 30 days |

`GET /admin/docker` reads `cache` from `REGISTRY_STATUS_FILE`,
`hubCredential.isSet` from its `hubCredentialSet` (false when the file is
missing), and `seed` from the `docker_seed` row (below). The audit row
for the credential says only "set" or "cleared" (S5).

### Root cache helper (T1 builds, T4 writes requests)

- Directory `REGISTRY_JOBS_DIR`, `/var/lib/portikus/registry-jobs/`,
  root:portikus 0770. The API writes `.request-<id>.tmp` then renames it
  to `request-<id>.json` (`RegistryJobRequestFile`, `<id>` a lowercase
  UUID, mode 0600). `portikus-registry-job.path`
  (`PathExistsGlob=.../request-*.json`) starts
  `portikus-registry-job.service`, which runs
  `/usr/lib/portikus/registry-job` as root.
- The helper checks the file against the same rules (unknown kinds and
  extra keys refused), deletes it before acting, and logs only the kind.
- `set-hub-credential` writes `proxy.username` and `proxy.password` into
  the Hub registry's config (`/etc/portikus/registry/hub.yml`, readable by
  root and the registry user only) and clears the cache;
  `remove-hub-credential` removes them and clears the cache (S5).
  `set-ghcr` starts or stops `portikus-registry-ghcr.service` and records
  the state in `/etc/portikus/registry/ghcr-enabled` (`on` or `off`),
  which the controller's egress render reads for the S3 redirect. `clear`
  stops both registries, unmounts, runs `mkfs.ext4` on the loop file,
  mounts and starts what was running (S1).
- The helper, and `portikus-registry-status.timer` every minute, write
  `REGISTRY_STATUS_FILE` (`RegistryStatusFile`, root 0644, write then
  rename). The timer clears the cache (`lastClearReason: "full"`) past 90
  percent.

### Worker to controller (T4 calls, T2 builds)

The worker already drives the controller over HTTP
(`apps/worker/src/controller-client.ts`); the API never calls it for
these.

- `POST /instances/:name/start` gains the optional
  `docker: WorkspaceDockerConfig` (`hubMirror`, `ghcr`). The worker sets
  `hubMirror` when the policy lets the Hub names in S2 through, and
  `ghcr` when the setting is on and the policy lets the ghcr names
  through. Absent means the controller leaves Docker's config as it is.
- The controller, with the container stopped, pushes
  `/etc/docker/daemon.json` as `{"storage-driver":"overlay2",
  "features":{"containerd-snapshotter":false}}` plus
  `"registry-mirrors":["http://10.200.0.1:5000"]` when `hubMirror`; when
  `ghcr` it pushes `/etc/docker/certs.d/ghcr.io/ca.crt` (from
  `/etc/portikus/registry/ghcr-ca.crt`) and a marked `ghcr.io` line in
  `/etc/hosts`, and removes both when not. It keeps whatever else the
  image's `daemon.json` holds.
- Create, Reset Docker and rebuild with Reset Docker keep their bodies.
  When a seed exists the controller copies it (Incus
  `POST /1.0/storage-pools/workspace-data/volumes/custom?project=portikus`
  with `source.type: "copy"`, `config.size` = `dockerGiB` plus the seed
  size rounded up to GiB, `config["security.shifted"]: "true"`). No seed
  means today's empty volume. A copy that fails falls back to an empty
  volume and logs a warning, so a broken seed never blocks a workspace.
- `POST /docker-seed/builds` (`SeedBuildRequest`, 202 with
  `SeedBuildStatus`), `GET /docker-seed/builds/:id` (`SeedBuildStatus`),
  and `GET /docker-seed` (`SeedInfo`, or 404 when no seed). One build at a
  time (409 otherwise). The controller re-checks the list with
  `seedImageListFor(ghcrEnabled)`. A build launches an ordinary
  unprivileged workspace container (the workspace profile, network and
  ACL) from the current default image with a fresh volume and the mirror
  on, runs `docker pull` once per image with the name as its own argument
  and no shell, then removes all containers and the build cache, stops
  dockerd cleanly, and stops the container (S8). A seed larger than
  `maxBytes` fails the build and the old seed stays. Otherwise it
  detaches the volume, sets `security.shifted=true`, and swaps it in as
  `portikus-docker-seed` (the old seed is deleted; live copies are
  unaffected, per the spike). The controller keeps the seed's `SeedInfo`
  in the volume's `user.portikus.seed` config key.
- The egress render in `apps/workspace-controller/src/egress/` adds the
  S2 gate and, when `/etc/portikus/registry/ghcr-enabled` says `on`, the
  S3 redirect of gateway tcp 443 to 5001 behind the same gate.

### Worker (T4)

- Seed jobs: `docker_seed_jobs` rows the API inserts as `queued`; the
  worker's loop starts the build on the controller (`maxBytes` from
  `docker_seed_max_gib`) and polls it every 5 seconds, copying state and
  step into the row, and on success writes the `docker_seed` row. A worker
  restart resumes polling by id; a controller that forgot the id marks
  the job failed.
- Registry webhook: a listener on `127.0.0.1:${REGISTRY_EVENTS_PORT}`
  (default `REGISTRY_EVENTS_DEFAULT_PORT`, 8792) at
  `REGISTRY_EVENTS_PATH`, body `RegistryEventEnvelope`, header
  `REGISTRY_EVENTS_TOKEN_HEADER` carrying the token in
  `REGISTRY_EVENTS_TOKEN_FILE` (root-generated by postinst, readable only
  by the registry and worker users; T1 writes it into the registry
  configs' notification headers). A wrong or missing token is 401; a
  body that fails the schema is 400 and stores nothing. Only
  `action: "pull"` with a manifest media type counts. The workspace is
  `registryEventWorkspaceIp(addr)` matched against running workspaces'
  bridge addresses at receipt; anything else is dropped (S7). Rows roll
  up into `docker_image_pulls` by canonical image name
  (`canonicalImageName`) and workspace: count, first and last seen. After
  `REGISTRY_NAMES_PER_DAY_MAX` distinct names in a day, new names count
  under `OTHER_IMAGES_LABEL`. A digest-only pull is kept as the
  repository with `@digest`.
- Inventory: every 6 hours, for each running workspace, `GET
  /docker/inventory` on its agent. A reply that fails the schema counts as
  no data. The seed-use rule (ruling 7) is computed in the worker, with
  the seed's layer lists taken from the inventory entries whose tags
  match seed images. Results go to `docker_image_presence` (workspace,
  canonical image, in_seed, used, sampled_at). Images present but not in
  the seed also feed `notInSeed`, which covers registries other than the
  caches.
- Admission: the resource guard (`apps/worker/src/guard.ts`, Epic 14.3)
  counts the configured Docker size plus the current seed's size (S8).
- Retention: rows older than 90 days are deleted daily.

### Workspace agent (T3)

`GET /docker/inventory` answers `AgentDockerInventory`. It runs
`/usr/bin/docker` by absolute path as the student, the way `dockerPs` in
`apps/workspace-agent/src/listening.ts` does: `image ls --no-trunc
--format json`, `ps -a --no-trunc --format json`, and one `image inspect`
over the image ids for `RootFS.Layers`. It returns `available: false`
and empty lists when dockerd does not answer within 10 seconds or any
output passes `INVENTORY_OUTPUT_MAX_BYTES`, and truncates lists to the
`INVENTORY_*_MAX` caps (S7). Nothing is cached or logged beyond the
count.

### Configuration and packaging (T1)

- Install question `portikus/registry-cache-gib` (debconf, default 20),
  the loop file `/var/lib/portikus-registry.img` mounted at
  `/var/lib/portikus-registry` by a systemd mount unit.
- Units: `portikus-registry-hub.service`,
  `portikus-registry-ghcr.service` (off until the helper starts it),
  `portikus-registry-job.path` and `.service`,
  `portikus-registry-status.service` and `.timer`.
- Configs: `/etc/portikus/registry/hub.yml` and `ghcr.yml` (root and the
  registry user only; notifications endpoint
  `http://127.0.0.1:8792/registry/events` with the token header; access
  log off; no debug listener), the token file
  `/etc/portikus/registry/events-token`, the ghcr state file
  `/etc/portikus/registry/ghcr-enabled`, and the CA at
  `/etc/portikus/registry/ghcr-ca.crt` with its key root-only.
- Firewall: nft input accepts 5000 and 5001 only from the bridge
  interface, with a per-source connection cap; the Incus ACL opens 5000
  and 5001 on the gateway, never 443 (S1, S3). `egress-drop-all.nft` and
  `packaging/egress-guard.sh` drop 5000 and 5001 (S2).
- Package `Depends` gains `docker-registry`.
- Worker environment gains `REGISTRY_EVENTS_PORT` (T4 owns the
  `packages/config` schema, T1 the packaged env file).

### Database (T4)

Migration `0031_docker_cache` (preassigned):

- `settings` gains `docker_ghcr_enabled boolean not null default false`,
  `docker_seed_max_gib integer not null default 8` and
  `docker_seed_images jsonb not null default '[]'`.
- `docker_seed` (one row): `images jsonb`, `size_bytes bigint`,
  `image_version text`, `built_at timestamptz`.
- `docker_seed_jobs`: `id uuid`, `state`, `step`, `images jsonb`,
  `message`, `requested_by`, `requested_at`, `finished_at`.
- `docker_image_pulls`: `image text`, `workspace_id uuid`, `pulls int`,
  `first_seen`, `last_seen`, primary key (image, workspace_id).
- `docker_image_presence`: `workspace_id`, `image`, `in_seed`, `used`,
  `sampled_at`, primary key (workspace_id, image).

The usage report never returns workspace ids or owners, only counts.

## Tasks for parallel builders

T1 to T4 start together once this plan merges. Their file sets do not
overlap.

| Task | Agent | Files | Depends on |
|---|---|---|---|
| T1 infra | infra | `infra/ansible/roles/registry_cache/` (new), `roles/firewall/templates/nftables.conf.j2`, `roles/incus_network/templates/workspace-acl.yaml.j2`, `roles/workspace_egress/templates/egress-drop-all.nft.j2`, `site.yml`, `packaging/egress-guard.sh`, `packaging/nfpm.yaml`, `packaging/scripts/postinst`, `packaging/debian/templates`, `config`, `settings-keys`, `packaging/registry/registry-job` (new), unit files, `infra/tests/smoke-test.sh`, `infra/tests/workspace-egress-render-test.yml`, the install-test checks | plan |
| T2 controller | builder | `apps/workspace-controller/src/` (provider, fake provider, server, `egress/render.ts`, new `docker-seed.ts` and `docker-config.ts`) and tests | plan |
| T3 agent | builder | `apps/workspace-agent/src/` (new `docker-inventory.ts`, route in `server.ts`) and tests | plan |
| T4 platform | builder | `packages/db/src/migrations/0031_docker_cache.ts`, db types, `packages/config`, `apps/api/src/routes/admin-docker.ts` (new), `route-policy.ts`, `apps/worker/src/` (webhook listener, seed jobs, inventory poll, usage roll-up, start options, `guard.ts`) and tests | plan |
| T5 web | ui-designer | `apps/web/src/admin/docker/` (new), `tabs.ts`, `AdminPage.tsx`, `queries.ts`, `e2e/admin-docker.spec.ts`, the e2e fakes for the new routes | T4 merged |
| R review fixes | builder | as findings need | T1 to T5 |
| V verify | infra | none in the repo; install on the rehearsal VM, then the pilot | R |
| F fold | builder | `docs/SPEC.md`, `docs/adr/0045-shared-docker-pull-storage.md`, `docs/STATUS.md`, `docs/BACKLOG.md`, `docs/INSTALL.md`, `docs/STACK.md`, delete this plan | V |

### T1 infra

SPEC sections 16, 23.1, 23.6, 24; STACK section 2. Done when a fresh
install on the rehearsal VM asks the size question, runs the Hub cache on
the gateway only, the helper applies every request kind, the status file
updates, and the smoke test passes new checks: a second pull of a small
image from a workspace downloads nothing from the internet; the port is
refused from the management network; the ghcr switch round-trips; PUT and
POST to 5000 (and 5001 when on) answer 405 (S1);
`docker-registry.service` is masked, the registry runs as its own user
with `MemoryMax=` and `TasksMax=`, and no debug port is open (S1); the
Debian package's version carries the CVE-2023-2253 fix (S1); 443 on the
gateway stays closed in the ACL (S3); the `portikus` and `nobody`
accounts cannot `stat` into the custom volume paths (S4); the drop-all
and guard files drop 5000 and 5001 (S2); the request file is read and
deleted, and a credential change clears the cache (S5); the token file is
readable only by the registry and worker users (S7). Tests: `make check`
infra checks (ansible-lint, shellcheck), the egress render test, smoke,
install test.

### T2 controller

SPEC sections 16.2, 16.4, 17.2, 23.6; ADR 0021, 0038. Unit tests with the
fake provider and Incus fakes: copy request body and size; fallback to
empty on copy failure; never replacing an existing volume at start; never
attaching the seed or one copy to two instances (S4); daemon.json merge
keeps overlay2 and the snapshotter pin; ghcr files added and removed; a
file push into a container whose `/etc/docker` is a symlink stays inside
it; seed build steps and the one-at-a-time rule; the builder is an
unprivileged workspace container; pulls pass names as separate arguments;
containers and build cache are removed and dockerd stopped before the
snapshot; a ghcr name is refused while ghcr is off; an oversize seed fails
and keeps the old one (S8); `SeedInfo` stored and read back; and the
egress render's S2 gate (drop 5000 and 5001 unless the fixed names are
allowed, in allow-list and open-with-blocked-sites modes, with no
established accept ahead of it) and S3 redirect. Done when the unit tests
pass and a manual create on the rehearsal VM shows the seed images in
`docker image ls`.

### T3 agent

SPEC section 16.5. Unit tests with a fake `docker` runner: parsing; the
absolute `/usr/bin/docker` path; `available: false` on timeout, error or
oversize output; item caps; runs as the student (S7). Done when the route
answers on a rehearsal workspace.

### T4 platform

SPEC sections 20.1, 23.6, 24. Unit and database tests: route validation
and audit rows (the credential audit says only set or cleared, and the
API answers only `isSet`); helper request files written atomically with
mode 0600 and the token never in the audit or logs (S5); the 409s; ghcr
names refused while ghcr is off; the seed size setting passed as
`maxBytes`; the start options against each egress mode; the webhook token
(401 without it); schema refusals; `registryEventWorkspaceIp` matching and
roll-up; the 2000-names-a-day cap (S7); an inventory reply failing the
schema counts as no data; the seed-use rule (container reference and
layer-prefix cases); the usage report's two lists and that it carries no
workspace ids; retention; and the guard's admission counting Docker size
plus seed size (S8). Done when `make check` is green.

### T5 web

SPEC sections 20.1, 25.8. The Docker tab with every part of "What the
user gets": the push, private-image and non-Docker-tool warning beside
the ghcr switch (S3); the credential form asking for a "Public Repo
Read-only" personal access token with the private-repository warning,
showing only whether one is set, and saying a change clears the cache
(S5); the seed size cap (S8); client-side name checks with
`seedImageListFor`; image names rendered as text only (S7); job progress
by polling. Playwright covers each control against the e2e fakes,
including the refusals. Done when unit, e2e and the accessibility review
pass.

### R, V, F

After T1 to T5 land, run code-reviewer, security-reviewer (Incus, nested
Docker, a root helper and a webhook are in scope) and a11y-reviewer; R
lands the fixes. V installs the epic build on the rehearsal VM and the
pilot and runs the smoke test. F writes each lasting ruling into SPEC 16
(seed and cache), 20.1 (the tab), 23.6 (the allow-list gate) and 24 (the
security rulings), writes the ADR, writes the STATUS section from the
task pull request bodies, adds what is left out to BACKLOG, and deletes
this plan.

## Left out

- Caching registries other than Docker Hub and ghcr.io (quay.io, gcr.io,
  mcr.microsoft.com). The usage report still shows those images.
- A seed per course or per image version; one global seed only.
- Swapping an existing workspace's volume to a newer seed.
- Resizing the cache from the page; the install question sets it.

## Risks

- Allow-list mode without the names: dockerd falls back to Docker Hub
  directly, where the egress rules already block it. Covered by T1's
  smoke test.
- A dropped (rather than refused) cache connection may stall pulls; the
  spike tested only refused. V tests stopping the unit.
- The seed's dockerd version must match the workspace image; the seed
  records `imageVersion`, and the page shows it next to the default
  image.
- Docker Hub rate limits through the proxy (429) show up as pull errors.
