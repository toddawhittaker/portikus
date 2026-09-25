# Epic 15: `apt install portikus`

This is the working brief for Epic 15. It is the requirement an agent implements against. Where it is silent, `docs/SPEC.md` wins on behaviour and `docs/STACK.md` on technology. It replaces the BACKLOG entry "`apt install portikus` on a bring-your-own Debian 13 host", builds on Epic 14 (`docs/archive/epics/EPIC-14.md`), and is built after it. ADR 0029 (Ansible in the package) and ADR 0030 (workspace image jobs) record the decisions made here.

- **Base commit:** `main` once Epic 14 has merged. **Epic branch:** `epic/15-apt-install`. Builders reset to it and branch `task/15-<name>`.
- **Migration number:** none. No task adds a migration.

**Amendment (Todd, 2026-09-25): Dex is the only front door (ADR 0031).** Epic 15 is built after the BACKLOG work "One front door: Dex for every site", and these rulings change with it:

- Ruling 3: `portikus/provider` keeps its five answers, but each one is a Dex connector (`dex` means no connector). The Entra and Google questions fill the Dex `microsoft` and `google` connectors; `oidc` fills Dex's generic `oidc` connector. A new question, `portikus/admin_email` (default `admin@<public_host>`), names the local administrator.
- Rulings 14 and 15: no setup code. The last task of the play creates the local administrator when it does not exist and prints its one-time password in a box; `portikus setup --follow` shows it. The `portikus` command's `setup-code` becomes `reset-admin`.
- Ruling 20: the install test signs in as the local administrator with the printed password, changes it, and then runs the smoke test.
- The user story's setup-code sentence reads the same way: at the end setup prints the administrator's email and a one-time password, which must be changed at first sign-in.

Terms used throughout:

- **debconf**: Debian's system for asking a package's install questions. It shows them as text dialogs (the `whiptail` or `dialog` front end), remembers the answers, and accepts them in advance: **preseeding** loads answers with `debconf-set-selections` so an install asks nothing. `dpkg-reconfigure portikus` asks again.
- **postinst**: the package script dpkg runs after unpacking.
- **Setup**: the heavy host configuration (Incus, LVM storage, the nftables firewall, PostgreSQL, Caddy, Dex, the egress proxy, the workspace image), which the Ansible roles under `infra/ansible` do today from a workstation.
- **Apt repository**: a web directory apt installs from, whose index is signed with a key the host trusts.
- **Workspace image**: the Incus image every student container starts from (`infra/workspace-image/`, SPEC.md sections 21.7, 21.8 and 22).
- **Release asset**: a file attached to a GitHub release.

## What the user gets

- On a freshly rented Debian 13 server (docs/HOSTING.md), the operator adds the Portikus apt repository in two commands and runs `apt install portikus`. It asks a handful of questions: the public hostname, how to get the TLS certificate, the sign-in provider and that provider's fields, and the disk for student storage. Then setup starts on its own, and `portikus setup --follow` shows it working. At the end it prints a one-time setup code; the operator signs in, enters it on `/setup`, and is the administrator (Epic 14).
- The same install runs with no questions from a preseed file, for a scripted rebuild.
- `dpkg-reconfigure portikus` changes an answer and applies it. `portikus setup` can be run again at any time and changes only what differs.
- `apt upgrade` brings new Portikus releases, from a repository CI signs.
- The workspace image arrives as a signed, versioned download instead of a 20-minute build on the server.
- Last, and separable: an administrator's **Workspace image** section shows the image new workspaces get, updates it to the newest published image or rebuilds it with the latest packages and a chosen Node and Python, checks the result, and makes it the default or rolls back, with progress and logs on the page.

## Rulings

Rulings marked **(user)** came from Todd, **(orchestrator)** from the orchestrator, and **(brief)** were made in this brief.

### Target and questions

1. **(user)** The target is a rented bare-metal (or full virtual) Debian 13 server, x86-64. Debian 13 only.
2. **(user)** `apt install portikus` asks debconf questions and asks only what cannot be guessed; it writes `/etc/portikus/portikus.yaml` and a mode-0600 secrets file; preseeding gives a fully unattended install; `dpkg-reconfigure portikus` changes answers and re-applies.
3. **(brief)** **The questions**, at debconf priority `high`, each shown only when the one before makes it relevant:
    - `portikus/public_host`: the name browsers use. Default: the host's fully qualified name.
    - `portikus/tls`: `letsencrypt`, `files` or `internal` (ruling 9). Then `portikus/acme_email` for `letsencrypt`, or `portikus/tls_cert` and `portikus/tls_key` paths for `files`.
    - `portikus/provider`: `entra`, `google`, `ldap`, `dex`, `oidc`. Then only that provider's fields, the names of Epic 14's Ansible variables: Entra's tenant ID and client ID; Google's domains and client ID; LDAP's host, schema (AD or OpenLDAP), bind DN, user base DN, user filter, group base DN and the three group names; OIDC's issuer, client ID, groups claim and group names. Dex alone asks nothing. Every client secret and the LDAP bind password are debconf `password` questions.
    - `portikus/storage`: a whole empty block device, or the name of an existing LVM volume group. Default: the one disk with no partitions, no filesystem and no mount, when exactly one exists. A device is followed by `portikus/storage_confirm`, a boolean, default false: "Everything on /dev/nvme1n1 will be erased." Setup refuses to touch a device without it.
4. **(brief)** **Guessed, never asked** (preseedable, and editable in the file): the public port (443), the management network (the subnet of the default route's interface), the preview suffix (`preview.<public_host>`), and the grace period and sizes (site.yml's defaults).
5. **(brief)** **`portikus.yaml` holds Ansible variable names**, such as `portikus_public_host` and `portikus_entra_tenant_id`, and setup passes it with `-e @`. Extra variables beat play variables, so there is no second schema and no translation code. The secrets file, `/etc/portikus/secrets.yaml` (root, mode 0600), holds `portikus_oidc_client_secret`, `portikus_ldap_bind_password`, `portikus_dex_upstream_client_secret` and, for a `letsencrypt` site, `portikus_cloudflare_api_token` (ruling 9), and setup passes it the same way. postinst writes each secret there and then clears it from the debconf database (`db_set` to empty), so the secret lives in one file. On reconfigure a blank password keeps the current one.
6. **(brief)** **postinst writes both files from the answers**, keeping any key it does not own, so an operator's hand edit of a guessed value survives `dpkg-reconfigure`.

### Setup

7. **(user)** The heavy setup does not run inside the apt step. A shipped `portikus setup` command applies it and is safe to run again.
8. **(brief)** **Ship the existing Ansible roles in the package and run them against the local host** (ADR 0029). The package puts `site.yml` and the roles in `/usr/share/portikus/ansible`, with the pinned collections from `requirements.yml` downloaded at build time into `/usr/share/portikus/ansible/collections`, and depends on Debian's `ansible-core`. `portikus setup` runs `ansible-playbook -i /usr/share/portikus/ansible/inventory-local.ini -e @/etc/portikus/portikus.yaml -e @/etc/portikus/secrets.yaml site.yml` with `ansible_connection=local`. The same roles keep serving the pilot from the workstation, so there is one implementation. Rewriting them in shell would be clearer to read but is weeks of work and a second copy to keep in step.
9. **(brief)** **TLS.** `internal` is today's Caddy certificate authority. `letsencrypt` gets the application host's certificate from Let's Encrypt (Caddy's automatic HTTPS; the firewall opens port 80 for the challenge). Preview hosts need a wildcard certificate for `*.<preview suffix>`, and Let's Encrypt issues wildcards only through a DNS challenge, which needs a Caddy build with a DNS provider's plugin and that provider's API credentials. Per-host certificates for previews on demand were rejected: each preview port would be a new certificate, Let's Encrypt allows 50 a week per registered domain, and an institution's shared domain would pay for it.

    **(Todd, 2026-09-24)** A `letsencrypt` site gets a Let's Encrypt wildcard certificate for `*.<preview suffix>` through a DNS-01 challenge, using one DNS provider's API: Cloudflare, unless the operator's domain is hosted elsewhere. This needs a custom Caddy build with the `caddy-dns/cloudflare` plugin (built with `xcaddy`, replacing the Cloudsmith package in the `letsencrypt` path). The Cloudflare API token is a new debconf `password` question, `portikus/cloudflare_api_token`, asked only when `portikus/tls` is `letsencrypt`; postinst writes it to `/etc/portikus/secrets.yaml` (root, mode 0600) as `portikus_cloudflare_api_token`, alongside the OIDC and LDAP secrets, and clears it from debconf the same way. Caddy's internal authority stays the default for `internal` and for sites with no public DNS at all, such as the pilot; setup still prints that browsers must trust its root there. This is added to T3 (the setup roles render and serve TLS) and its estimate grows by about two days, from two to three days to four to five days.
10. **(brief)** **postinst starts setup, but not inside itself.** When the answers are complete (and the storage device is confirmed), postinst runs `systemctl start --no-block portikus-setup.service` and prints "Setup is running. Follow it with: portikus setup --follow". Otherwise it prints what is missing and the command to run. Setup cannot run inline: it installs Incus and Caddy with apt, and the outer apt still holds the dpkg lock, so it would wait forever; and a 15-minute run tied to the operator's SSH session dies with it. The unit is a root oneshot; its Ansible `apt` tasks wait up to 15 minutes for the lock, which the outer apt releases when it finishes. `dpkg-reconfigure` and an upgrade start it the same way; for reconfigure that is the user's "re-applies". Running `portikus setup` by hand runs it in the foreground.
11. **(brief)** **Node 24 is bundled** in the package at `/usr/lib/portikus/node`, the exact version in `.nvmrc`, downloaded by `build-deb.sh` from nodejs.org and checked against its published SHA-256. The units call that binary. `apt install portikus` then resolves from Debian and the Portikus repository alone, and the Node that CI tested is the Node that runs. The `node` role and the NodeSource repository leave the host. The cost: a Node security fix needs a Portikus release (about 30 MB more per package).
12. **(brief)** **Package dependencies are Debian-archive packages only:** `ansible-core`, `python3-apt`, `debconf`, `whiptail | dialog`, `ca-certificates`, `gpg`, `curl`. Setup installs the rest as the roles do today: Incus from Zabbly and Caddy from Cloudsmith (the tested sources), PostgreSQL, nftables, LVM and Squid from Debian. Moving to Debian's own Incus 6.0 is a separate decision (left out).
13. **(brief)** **Dex and distrobuilder are still built on the host by their roles**, from their pinned commits. Setup needs GitHub and the Go module proxy for the first run, as today; moving the Dex build into CI would change a working role for no user-visible gain.
14. **(brief)** **The setup code**: the last task of the play runs Epic 14's setup-code entry point when no enabled administrator exists and prints the code in a box; `portikus setup --follow` shows it; `portikus setup-code` issues a fresh one at any time (Epic 14 ruling 16).
15. **(brief)** **The `portikus` command** is one shell script in `/usr/bin`: `setup` (foreground), `setup --follow` (journal of the unit), `setup-code`, and `status` (the units' states and versions). Nothing else.

### Repository and image

16. **(user)** A signed apt repository published by CI, the key kept out of the repository.
17. **(brief)** **The repository is a static directory on GitHub Pages** (`https://toddawhittaker.github.io/portikus/apt`, suite `trixie`, component `main`; the repository is public, so Pages is free), generated with `apt-ftparchive` from the Debian `apt-utils` package and signed with `gpg`. The release workflow adds each new `.deb` and keeps the last ten. The private key is a GitHub Actions secret available only to the release job's `publish` environment; the public key is committed as `packaging/portikus-archive-keyring.asc`, shipped in the package to `/usr/share/keyrings/portikus-archive-keyring.gpg`, and published beside the repository. Reprepro and aptly were rejected: both keep a database between runs, which a stateless CI job would have to carry.

    **(Todd, 2026-09-24)** The signing key does not expire. A revocation certificate is generated alongside the key and kept offline by Todd, so a compromised key can still be revoked without an expiry date forcing yearly rotation. Todd generates the key pair, the revocation certificate, and adds the private key as the Actions secret; this is a prerequisite for T4, not a task it does itself.
18. **(user)** The workspace image is a versioned release asset that setup downloads and imports.
19. **(brief)** **CI builds the image** when `infra/workspace-image/**` changes on `main` (or by hand), with distrobuilder built from the pinned commit on the runner, and publishes a release `image-<VERSION>` holding `incus.tar.xz`, `rootfs.squashfs`, `manifest.json` (ruling 24) and `SHA256SUMS` signed with the repository key. Setup downloads the version named by `portikus_image_version` (default: the recipe `VERSION` the package was built from), checks the signature with the shipped keyring and the checksums, and imports it with the aliases `portikus-<version>` and `portikus`, as `build-on-vm.sh` does. `make build-workspace-image` stays for development.
20. **(orchestrator)** **Fresh install test on this host, on a throwaway VM, never the pilot.** `make install-test` creates the rehearsal VM (`rehearsal-libvirt`), serves a repository built from the branch's `.deb` on the host's VM-network address, preseeds a standalone-Dex install, runs `apt install portikus`, waits for setup, claims the setup code through `/setup/first-account` with `curl`, runs the smoke test, and destroys the VM.
21. **(brief)** **The variable audit comes first** (the BACKLOG's step 1): the fixed `deploy` account (`image_builder` directories, the Makefile, the smoke test), the smoke test's two `/dev/vdb` checks, the Makefile's public-host default, and the libvirt-only targets listed under `infra/README.md`, "Limits today".

### The Workspace image section (the last task; separable)

22. **(user)** Rebuilding the workspace image eventually belongs in the admin interface. Show the current image version, offer "update to the latest published image" and "rebuild", with progress and logs. New workspaces use the new image; existing workspaces follow the current upgrade rules: they keep their root until an administrator rebuilds each one (SPEC.md sections 17.2 and 22). The section shows how many workspaces run each image version.
23. **(user)** **Rebuild with latest** uses the same recipe, `infra/workspace-image/portikus.yaml`, shipped in the package, and picks up current Debian and vendor-repository packages. Claude Code and Codex resolve to their latest versions for this action only; the committed recipe stays pinned, so CI and release builds stay reproducible.
24. **(user)** Every build gets a new version and a **manifest** of every package and tool version, and the admin sees a diff against the current default. **(brief)** The manifest is `dpkg-query` output plus the versions of node, npm, python3, git, docker, claude and codex, the build parameters, the source (`published` or `local`) and the recipe's `VERSION`. A local build is versioned `<recipe VERSION>-local.<YYYYMMDDHHMM>`. The diff lists added, removed and changed packages and tools; it is a pure function with unit tests.
25. **(user)** **Build choices are a short fixed list of dropdowns**, never free text and never package lists, because the build runs as root. **(brief)** The list:
    - **Node major:** 24 or 26, from NodeSource, as the recipe installs Node today.
    - **Python:** "Debian's Python 3.13" (today), or "Debian's plus Python 3.14 from uv". Debian has no deadsnakes-style repository (that is an Ubuntu archive), and building Python from source would add ten minutes to every build. uv, Astral's Python tool, installs a maintained, checksum-verified standalone build into `/opt/python`; the image links it as `python3.14` and `python`, and leaves `/usr/bin/python3` as Debian's, which Debian's own tools need.
    - Nothing else in this epic.
26. **(user)** **A new image must pass a health check before it can become the default.** **(brief)** The job starts a throwaway container from it with the workspace profile, and checks that `node --version`, `python3 --version`, `git --version`, `docker info`, `claude --version` and `codex --version` succeed, then deletes it. The result is written by the root job into the image's own directory, which the API cannot write.
27. **(user)** **The previous image is kept and rollback is one action.** **(brief)** "Make default" moves the `portikus` alias; the old default becomes "previous" (alias `portikus-previous`). "Roll back" swaps them. After a successful fetch or build, images other than the default, the previous and the two newest candidates are deleted; a workspace never needs its image to still exist.
28. **(brief)** **The privilege boundary is a path-activated systemd unit, not sudo and not polkit** (ADR 0030). The API writes a request file into `/var/lib/portikus/image-jobs/` (`root:portikus`, mode 0770). A `portikus-image-job.path` unit starts `portikus-image-job.service`, a root oneshot, which moves the request aside, validates it against the fixed kinds and choices, and runs it. Kinds: `fetch` (a version, or the newest published), `build` (Node and Python choices), `activate` (a version), `rollback`. Only one job runs at a time; the API refuses a request while one is queued or running. The job writes `status.json` and `log.txt` per job, readable by the `portikus` group, which the API reads and the page polls every two seconds. The job never trusts the request beyond its enums and a version matching `^\d{4}\.\d{2}\.\d+(-local\.\d{12})?$`, never puts a request value in a shell command unquoted, and never imports a download whose signature fails. Polkit was rejected because it is one more daemon on a minimal Debian host; sudo, because the API unit runs with `NoNewPrivileges`, and a sudo rule is a wider door than a file the root side parses.
29. **(user)** Per-course or per-project tool versions (a version manager such as mise) are out; they belong with the BACKLOG item "Course profiles and a language-aware editor".

## Data model and configuration

No migration. New files on the host:

| Path | Owner, mode | Written by |
|---|---|---|
| `/etc/portikus/portikus.yaml` | root, 0644 | postinst; the operator |
| `/etc/portikus/secrets.yaml` | root, 0600 | postinst |
| `/usr/share/portikus/ansible/**` | root, 0644 | the package |
| `/usr/lib/portikus/node/**` | root, 0755 | the package |
| `/usr/share/keyrings/portikus-archive-keyring.gpg` | root, 0644 | the package |
| `/var/lib/portikus/images/<version>/` (image files, `manifest.json`, `health.json`) | root, 0755 | setup; the image job |
| `/var/lib/portikus/image-jobs/` (request, then `<id>/status.json`, `<id>/log.txt`) | root:portikus, 0770 | the API (request only); the image job |

New units: `portikus-setup.service` (root oneshot), `portikus-image-job.path` and `portikus-image-job.service` (root oneshot). New Ansible variables: `portikus_tls` (`internal`, `letsencrypt`, `files`), `portikus_acme_email`, `portikus_tls_cert`, `portikus_tls_key`, `portikus_cloudflare_api_token` (secrets file only, for the `letsencrypt` DNS-01 wildcard, ruling 9), `portikus_storage` (a device or a volume group name), `portikus_storage_confirm`, `portikus_image_version`. API setting: `IMAGE_JOBS_DIR` (unset turns the section off, as in development).

New routes (T6): `GET /admin/image` (default, previous, candidates with manifest summary and health, workspaces per version, current job); `GET /admin/image/diff?from=&to=`; `POST /admin/image/jobs` with `{kind, version?, node?, python?}`; `GET /admin/image/jobs/:id` (status and the last 500 log lines). All administrator-only and CSRF-checked; each request writes `image.job_requested`, and the API writes `image.job_finished` `{kind, result, version}` when it first sees a finished status.

## The flows

1. **Install.** Add the key and the repository (two commands in `infra/README.md`), `apt install portikus`. debconf asks; postinst writes the files and starts `portikus-setup.service`; apt returns; setup waits for the lock, then runs the play: firewall, storage, Incus, network, profile, PostgreSQL, Caddy, the egress proxy, Dex, the image download and import, the Portikus services, backups, and the setup code.
2. **Unattended.** `debconf-set-selections preseed.txt && DEBIAN_FRONTEND=noninteractive apt-get install -y portikus`, then `portikus setup --follow` to wait. `packaging/debian/preseed.example` lists every question.
3. **Change an answer.** `dpkg-reconfigure portikus`, which asks again with the current answers filled in and restarts setup.
4. **Upgrade.** `apt upgrade` installs a new package; postinst restarts the running services as today and starts setup, as on install. The play is idempotent and restarts a service only when its configuration changed, so an upgrade always leaves the host matching the new roles.
5. **Update the image (T6).** Workspace image, "Update to the latest published image": a `fetch` job downloads, verifies, imports and health-checks it; the page shows the steps and log, then the diff and **Make default**.
6. **Rebuild the image (T6).** "Rebuild with latest packages", pick Node and Python, confirm; a `build` job runs distrobuilder (about 20 minutes), writes the manifest, health-checks; then diff and **Make default**, or discard.

## Security invariants to test

- No secret is in `portikus.yaml`, the debconf database after postinst, a log line, or `ps` output; `secrets.yaml` is root-only.
- An install with an unconfirmed storage device changes no disk.
- apt refuses the repository without the key, and setup refuses an image whose signature or checksum fails.
- The API cannot write the image store or health results; a request file with an unknown kind, choice or malformed version is refused by the root job and logged as refused; a second request while one runs is refused by the API.
- An image with a failed health check cannot be activated, even by a hand-written request file.
- Image routes are administrator-only, CSRF-checked, and in `route-policy.ts` and the authorization matrix.

## Tasks for parallel builders

| Task | Agent | Files it owns | Depends on |
|---|---|---|---|
| **T1 Package contents** | builder | `packaging/nfpm.yaml` (including the entries for T2's and T6's files at the paths above); `scripts/build-deb.sh` (bundled Node, Ansible tree, collections); `packaging/systemd/*.service` (the Node path); `packaging/systemd/portikus-setup.service` (new); `packaging/bin/portikus` (new); `infra/ansible/inventory-local.ini` (new); `packaging/portikus-archive-keyring.asc` (new; Todd generates the key pair and revocation certificate) | none |
| **T2 debconf** | builder | `packaging/debian/templates`, `packaging/debian/config`, `packaging/debian/preseed.example` (new); `packaging/scripts/postinst`; `packaging/tests/**` (new: a Debian 13 container test that installs the `.deb` with a preseed, checks both files, their modes, and the empty debconf passwords); `.github/workflows/ci.yml` (that test's job only) | T1's `nfpm.yaml` entries |
| **T3 Roles for a local host** | infra | `infra/ansible/site.yml`; `infra/ansible/roles/**`, including removing the `node` role and building Caddy with the `caddy-dns/cloudflare` plugin for the `letsencrypt` DNS-01 wildcard (ruling 9); new role `workspace_image` (download, verify, import); `infra/tests/smoke-test.sh`, `security-test.sh`; `Makefile` (the audit's fixes) | T1 (the bundled Node must land before the `node` role goes) |
| **T4 Signed repository and image releases** | builder | `.github/workflows/release.yml`; `.github/workflows/workspace-image.yml` (new); `scripts/publish-apt-repo.sh` (new) | none; prerequisite: Todd generates the key pair and the revocation certificate before this task and adds the private key as the Actions secret |
| **T5 Install test and docs** | infra, then builder for docs | `infra/tests/install-test.sh` (new); `Makefile` (`install-test` only); `infra/README.md`; `docs/OPERATIONS.md`; `docs/HOSTING.md`; `docs/SPEC.md` section 29; `docs/STATUS.md`; `docs/BACKLOG.md`; ADR 0029 accepted | T1 to T4 |
| **T6 Workspace image section** | builder, then infra for the job, then tester | `infra/workspace-image/portikus.yaml` (the Node, Python and tool-version parameters, pinned by default); `packaging/image/image-job` (new, the root job) and its tests; `packaging/systemd/portikus-image-job.{path,service}` (new); `packages/contracts/src/image.ts` (new); `packages/config` (`IMAGE_JOBS_DIR`); `apps/api/src/routes/admin-image.ts` (new) and test, `server.ts`, `route-policy.ts`, `authz-matrix.test.ts`; `apps/api/src/image/manifest-diff.ts` (new) and test; `apps/web/src/admin/image/**` (new), `AdminPage.tsx` (the tab); `e2e/admin-image.spec.ts`, `e2e/a11y-image.spec.ts` (new, against a fake job directory); ADR 0030 accepted | T5; separable |

T1 and T4 start together, T2 and T3 when T1 lands, T5 last. T3 and T5 both edit the `Makefile`, one after the other. T6 can start after T3 and ship in the same epic or later.

After T1 to T5: code-reviewer over the epic head and security-reviewer (secrets, the repository signature, setup as root). After T6: all three reviewers (it touches `apps/web` and a root boundary).

## Estimates

- **T1 to T5:** about 11 to 13 days: T1 two, T2 two, T3 four to five (two to three plus about two for the DNS-01 wildcard build, ruling 9), T4 two, T5 one to two.
- **T6 on its own: about 5 to 6 days**: recipe parameters and manifest one, the root job with health check, activation and pruning two, API and diff one, the page and tests one to two. It can be deferred without affecting T1 to T5.

## What done looks like, per task

- **T1:** the `.deb` holds the Node binary, the Ansible tree with its collections, the keyring and the command; `portikus setup` in a Debian 13 container reaches Ansible's first task; the units start on the bundled Node on the rehearsal VM.
- **T2:** the container test passes for a preseeded Entra, Google, LDAP, Dex and OIDC answer set, and for a reconfigure that keeps a hand-edited key and a blank password; `shellcheck` passes.
- **T3:** the play runs from the package on a host with no `deploy` user and a data disk not named `/dev/vdb`; `letsencrypt` and `files` modes render and serve (`letsencrypt` against Let's Encrypt's staging service, including a DNS-01 wildcard certificate for the preview suffix through the Cloudflare API); the image is downloaded, verified and imported; a second `portikus setup` reports no changes except the always-run checks.
- **T4:** a release adds the package to the Pages repository and `apt update` on a clean Debian 13 container verifies it; a tampered `Release` file is refused; the image workflow publishes a signed release under 2 GiB per file.
- **T5:** `make install-test` passes from nothing to a claimed administrator and a green smoke test, and destroys its VM; the docs describe install, preseed, reconfigure, upgrade, and what to do if the signing key is ever compromised (the offline revocation certificate).
- **T6:** unit tests for the job's validation (every bad kind, choice and version), the manifest diff and the routes; on the rehearsal VM, a fetch, a build with Node 26 and uv Python, a failed health check that cannot be activated (a deliberately broken recipe), make default, a new workspace on the new image, an old workspace unchanged until rebuilt, and a rollback; Playwright and axe on the section.

## Risks

1. **Debian's `ansible-core` is not the version the pilot runs from the workstation.** The install test runs the roles under Debian's; `ansible-lint` in CI keeps using its own. A role that needs a newer feature fails there first.
2. **Setup needs the internet** (Zabbly, Cloudsmith, GitHub, the Go proxy, the image release). A host behind a strict firewall must allow them for the first run.
3. **The health check's throwaway container** lives in the Incus project the controller manages. The controller's cleanup must ignore its name prefix (`imgcheck-`), or the check must use its own project with a copy of the profile; T6 picks one and tests it against `infra/tests/cleanup-scope-test.sh`.
4. **A local "latest" build can fail on the day** (a vendor repository down, a new tool release broken). The old default stays; nothing changes until "Make default".
5. **The image may outgrow GitHub's 2 GiB per-file limit.** T4 checks the size; the fallback is splitting the squashfs.

## Left out

- Other distributions, Debian's own Incus, and an `.rpm`.
- Running setup inside postinst (ruling 10).
- Free-text versions or package lists in the image builder, and per-course images (ruling 29).
- Migrating the pilot to the package-driven setup; the pilot keeps using the same roles from the workstation.
