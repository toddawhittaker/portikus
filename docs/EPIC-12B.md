# Epic 12b: sign-in through Dex, and pilot readiness

This is the working brief for the second half of Epic 12, and the last epic before the pilot. SPEC.md section 29 does not list an Epic 12b yet. Until it does, this file is the requirement an agent implements against. Where this file is silent, `docs/SPEC.md` wins on behavior and `docs/STACK.md` wins on technology.

- **Base commit:** `main` at `001e10e`.
- **Epic branch:** `epic/12b-signin-and-readiness`.
- **Note:** the main checkout at `/home/todd/projects/portikus` was last seen at `f82b12e`. Builders reset to `001e10e`.

## Where this epic sits

Epic 12a tested the code that already exists and proved Gate C on the pilot, except for one condition. The pilot still signs in through the mock identity provider, so anyone who reaches the site can sign in as the administrator (issue #408).

Epic 12b has two parts.

- **Part A** replaces the mock with a real sign-in.
- **Part B** is the operational half of SPEC.md section 29 Epic 12, which 12a left out:
  - load and concurrency;
  - backup and restore;
  - the rebuild-from-code exercise;
  - deployment documentation and a runbook;
  - the threat-model review;
  - issues #398 and #399, which 12a pinned as known gaps.

Part A lands first, and it can be deployed to the pilot on its own.

## What the user gets

**Part A**

- The pilot's sign-in page is a real password login, served by Dex on the pilot's own address. Students sign in with their email address and a password Todd gives them.
- Todd manages accounts on his own machine with one command. The command:
  - asks for the password twice without showing it;
  - stores only a bcrypt hash;
  - deploys the change with the normal Ansible run.
- Nobody can pick "carol" from a list any more.
- carol, alice and bob keep their workspaces. After the switch, each signs in with a new password and lands in the same workspace, with the same projects and files.
- Repeated sign-in attempts from one address are slowed down (#398).
- When IT provides a real identity provider, switching to it is a change of settings, not of code.

**Part B**

- Project and folder downloads have a clear size limit (#399).
- A nightly, encrypted backup of the database and of every student's files is written to the host, and a restore that has actually been tested.
- A measured answer to "can this hold 25 students at once, and on what size of VM?"
- A replacement pilot built from the repository on a second VM, with the pilot's backup restored into it, passing the smoke test.
- An operations runbook, current deployment docs, and a reviewed threat model.

## Decisions

### Where Dex runs and how it is installed

- **Decision: Dex runs on the platform VM as `portikus-dex.service`, installed by a new Ansible role `dex`.**
  - Why: it is one more loopback service behind Caddy, like the mock. A separate host would add a machine to secure and back up.

- **Decision: Dex is built from source on the VM, at a pinned upstream commit, the same way distrobuilder is built (ADR 0004, `infra/ansible/roles/image_builder`).**
  - Why:
    - Debian 13 has no Dex package; the `dex` package is an unrelated desktop tool.
    - Dex's GitHub releases carry no binaries.
    - The upstream container image would need a container runtime or image-extraction tooling that the VM does not have.
    - The VM already has `golang-go`, `build-essential` and `git` for distrobuilder, and already uses `GOTOOLCHAIN=auto`. That setting verifies the toolchain against Go's checksum database, and the Go module sums verify every dependency.
  - Variables in `infra/ansible/site.yml`:
    - `dex_version: v2.45.1`
    - `dex_commit: 11d2eeb52b42e1980e14cb91e69dd9e3faab2076`
  - The role clones `https://github.com/dexidp/dex.git` at `dex_commit` into `/root/go/src/dex`. It checks that `git rev-parse HEAD` equals the pin, then runs `go build -o /usr/local/bin/dex.new ./cmd/dex` with the same environment as distrobuilder.
  - It then moves the binary into place and writes the marker `/usr/local/share/portikus/dex-commit`.
  - A run whose marker already matches builds nothing.
  - A failed build leaves the old binary and the old marker in place.
  - The role installs `golang-go` itself, so it does not depend on the order of roles.

- **Decision: Dex uses `storage: memory`.**
  - Why:
    - Every user comes from the static configuration.
    - Portikus reads the ID token only once, at sign-in, and keeps its own server-side session (ADR 0008). It never uses Dex refresh tokens.
  - What a restart loses: only sign-ins that are in flight at that moment, and Dex's signing keys. openid-client fetches the new keys by `kid`.
  - With no database file, there is nothing to back up or corrupt.

- **Decision: Dex listens on `127.0.0.1:5556` over plain HTTP. Caddy serves it at `https://<public host>:<public port>/dex/`.**
  - The issuer is `{{ portikus_public_url }}/dex`. On the pilot that is `https://portikus.<host-lan-ip>.nip.io:8443/dex`.
  - Dex mounts its routes under the issuer's path, so Caddy passes `/dex/*` through without stripping the prefix: `handle /dex/* { reverse_proxy 127.0.0.1:5556 }`.
  - TLS is Caddy's internal authority, which browsers on the pilot already trust. The API reaches Dex the same way it reaches the mock today: the public name resolves to 127.0.0.1 in `/etc/hosts`, and `NODE_EXTRA_CA_CERTS` trusts Caddy's root.
  - When Dex is not the provider, Caddy answers `/dex*` with 404, the same pattern `/mock-idp*` uses today.

- **Decision: the Dex configuration file is `/etc/portikus-dex/config.yaml`, owner `root:portikus-dex`, mode 0640. It is rendered from `roles/dex/templates/config.yaml.j2`.** It contains:
  - `issuer`
  - `storage: {type: memory}`
  - `web.http: 127.0.0.1:5556`
  - `logger: {level: info, format: json}`
  - `frontend: {issuer: Portikus}`
  - `oauth2: {skipApprovalScreen: true}`. There is no `passwordConnector`, so the password grant stays off.
  - `expiry: {authRequests: 10m, idTokens: 10m}`
  - `enablePasswordDB: true`
  - one static client:
    - `id: portikus`
    - `secret`: from `/etc/portikus/dex-client.secret`
    - `redirectURIs: ["{{ portikus_public_url }}/auth/callback"]`
  - `staticPasswords`, rendered from the users file (below).

- **Decision: the unit `portikus-dex.service` is an Ansible template (`roles/dex/templates/portikus-dex.service.j2`), not part of the Debian package.**
  - Why: the binary is not in the package either. Keeping the two together means the package never ships a unit whose binary may be missing.
  - The unit:
    - runs as the system user `portikus-dex`, created by the role;
    - runs `ExecStart=/usr/local/bin/dex serve /etc/portikus-dex/config.yaml`;
    - carries the same hardening as the Portikus units: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `IPAddressAllow=127.0.0.0/8`, `IPAddressDeny=any`;
    - is restarted by a handler when the config or the binary changes.

### The users file

- **Decision: the users file lives on the machine that runs Ansible, outside any Git work tree.**
  - Default path: `~/.config/portikus/users.json` (Makefile variable `PORTIKUS_USERS_FILE`, Ansible variable `portikus_users_file`).
  - Directory mode 0700, file mode 0600.
  - Ansible reads it on the controller with `lookup('file')` and `no_log: true`. The file itself is never copied to the VM, and the rendered Dex config is the only thing on the VM that holds the hashes.
  - `make build-deb` gains a guard: the build fails if any file in the package contains `staticPasswords` or a bcrypt hash (the pattern `\$2[aby]\$[0-9]{2}\$`).
  - The users tool refuses any path inside a Git work tree.

- **Decision: the file format, version 1.**

  ```json
  { "version": 1,
    "users": [
      { "username": "alice", "email": "alice@example.edu", "displayName": "Alice Student",
        "role": "student", "userId": "3f0c...-uuid", "passwordHash": "$2b$12$..." } ] }
  ```

  - `username`: matches `^[a-z][a-z0-9._-]{0,31}$`, unique.
  - `email`: a valid address, unique without regard to case. It is the login name on Dex's form.
  - `displayName`: 1 to 100 characters.
  - `role`: `student` or `administrator`.
  - `userId`: a random UUID the tool writes once, when the user is created, and never changes. It fixes the user's Dex subject.
  - `passwordHash`: bcrypt, matching `^\$2[aby]\$1[0-6]\$[./A-Za-z0-9]{53}$`.
  - Unknown keys are refused, and the file must hold at least one administrator.
  - Why a random `userId` rather than the username: at a school, usernames such as `jsmith` get reused. A reused username must never inherit the previous owner's workspace. A lost file can be recovered (see the risks).

- **Decision: the tool is a new workspace package, `packages/users-file` (`@portikus/users-file`).** It is written in TypeScript, validates with Zod, is tested with Vitest, and hashes with `bcryptjs`, pinned to an exact version.
  - Why:
    - The repository's tests and coverage are Vitest.
    - The host has neither Python's `bcrypt` module, `htpasswd` nor Go.
    - Node has no built-in bcrypt.
    - `bcryptjs` is pure JavaScript with no dependencies and no install scripts. ADR 0023 records this new dependency.
  - No app depends on the package, so `pnpm deploy` never puts it in the `.deb`.
  - Cost factor 12. Dex accepts costs 10 to 16.

- **Decision: the commands, wrapped as Make targets.**
  - `make users-add USERNAME=<name>`: creates or updates one user.
    - It asks for email, display name and role. On an update it offers the current values.
    - It then asks for the password twice, with echo off (raw TTY mode, no characters and no asterisks). A mismatch asks again.
    - Passwords shorter than 12 characters are refused.
    - It refuses to run when stdin is not a terminal. The only exception is a `--password-stdin` flag, meant for tests, which reads exactly one line.
    - The password never appears in argv, the environment, an error message or a log line.
    - It writes the file atomically: a temporary file with mode 0600 in the same directory, fsync, then rename. It creates the directory with mode 0700.
    - It refuses to touch an existing file whose mode is looser than 0600, and says how to fix it.
  - `make users-remove USERNAME=<name>`.
  - `make users-list`: lists username, email, role and the date the hash was last changed. It never shows hashes.
  - `make users-check`: validates the file.
  - Deploying a change is `make users-deploy`, which is `ansible-playbook site.yml --tags dex`.

- **Decision: validation runs before any deployment, in two places.**
  - `make configure-vm` and `make users-deploy` run `make users-check` first. That is the full validation: schema, unique usernames and emails, hash format and cost range, userId format, and at least one administrator.
  - A `pre_task` in `site.yml` repeats the cheap guards, for anyone who runs `ansible-playbook` directly: the file exists, has mode 0600, parses as JSON with version 1, and every hash matches the pattern.

- **Decision: Ansible renders one `staticPasswords` entry per user, with these fields:**
  - `email`
  - `hash`
  - `username`
  - `name: displayName`
  - `preferredUsername: username`
  - `userID: userId`
  - `emailVerified: true`
  - `groups`: `[portikus-students]` or `[portikus-administrators]`, following the role.

### Roles

- **Decision: roles keep coming from the provider's `groups` claim, and no Portikus role code changes.**
  - At the pinned commit, Dex's static passwords carry `groups`, and the local connector returns them (`storage.Password.Groups`; `passwordDB.Login` returns `Groups: p.Groups`).
  - The users file's `role` becomes a group name, and the existing `mapRole` with `OIDC_ADMIN_GROUP` and `OIDC_STUDENT_GROUP` maps it unchanged.
  - Why this beats an administrator-email setting:
    - It adds no second mechanism that could disagree with the provider.
    - It keeps `user.role_changed` audited as coming from the identity provider.
    - When IT supplies groups, only the group names and the issuer change.
  - Why this beats a Dex connector with groups: every other Dex connector needs an upstream service, and there is none yet.
  - ADR 0008's two reasons for rejecting Dex are out of date: it no longer needs a container runtime, and static passwords now carry groups. ADR 0023 records the new choice. ADR 0008 is marked "superseded in part by 0023".

- **Decision: scopes become a variable, `portikus_oidc_scopes`, overridable by `PORTIKUS_OIDC_SCOPES`.**
  - It defaults to `openid profile email groups` for Dex and to `openid profile email` for the mock and for an external provider.
  - Why: Dex puts `groups` in the token only when that scope is asked for, and some providers (Entra, for example) refuse scopes they do not know.

### Choosing the provider, and a configuration-only swap later

- **Decision: one variable picks the provider.** `PORTIKUS_IDP` (Ansible `portikus_idp`) takes the values `dex`, `mock` or `external`, and defaults to `dex`.
  - `site.yml` fails with a clear message if the old `PORTIKUS_MOCK_IDP` is set ("renamed: use PORTIKUS_IDP=mock").
  - With `dex`:
    - the issuer is `{{ portikus_public_url }}/dex`;
    - the client id is `portikus`;
    - the secret comes from `/etc/portikus/dex-client.secret`.
  - With `external`: the existing `PORTIKUS_OIDC_*` variables and their asserts apply.
  - Any mode other than `mock`:
    - stops and disables the mock unit;
    - removes `/etc/portikus/mock-idp.env` and `mock-client.secret`;
    - answers `/mock-idp*` with 404.
  - Any mode other than `dex`:
    - stops and disables `portikus-dex`;
    - removes its config;
    - answers `/dex*` with 404.

- **Decision: a new variable `portikus_api_ip_allow_extra` (list of CIDRs, from `PORTIKUS_API_IP_ALLOW`) renders a systemd drop-in, `/etc/systemd/system/portikus-api.service.d/10-idp-egress.conf`, holding the extra `IPAddressAllow=` lines.**
  - Why: today the API unit allows loopback only (`packaging/systemd/portikus-api.service`), which `infra/README.md` says blocks any real provider on the network. Without this, the move to IT's provider would need a package change.
  - The list is empty for `dex` and `mock`.

- **Decision: the Dex client secret is generated once on the VM, the same way the controller token, session secret and mock secret are.** `umask 077 && openssl rand -hex 32 > /etc/portikus/dex-client.secret`, root, mode 0600, `no_log`. It is rendered into `api.env` (root:portikus, 0640) and into the Dex config.

### Carrying existing accounts over

- **Decision: Dex's subject is predictable, and Portikus computes it.**
  - The subject is `base64url_nopad(0x0a, len(userId), userId, 0x12, 0x05, "local")`. That is the protobuf `IDTokenSubject{user_id, conn_id}` that Dex encodes with `base64.RawURLEncoding`. The format holds while `userId` is under 128 bytes; a UUID is 36.
  - The function is `dexLocalSubject(userId)` in `packages/auth/src/dex-subject.ts`.
  - It is unit-tested against Dex's documented example (`08a8684b-db88-4b73-90a9-3cd1661f5466` → `CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs`).
  - The CI Dex test pins it against a real Dex.

- **Decision: the carry-over is a TypeScript command shipped in the package.**
  - Code: `packages/auth/src/carry-over.ts` plus `carry-over-main.ts`.
  - Installed path: `/usr/lib/portikus/api/node_modules/@portikus/auth/dist/carry-over-main.js`.
  - It runs as the `portikus` user, with `api.env`'s `DATABASE_URL`.
  - Input: a file that Ansible writes to `/run/portikus-carry-over.json` (root:portikus, 0640) and deletes afterwards. It holds `toIssuer`, `fromIssuers[]` and `users[{email, username, userId}]`, and no hashes.
  - It is a dry run unless given `--apply`.
  - For each user in the file, comparing emails without regard to case:
    1. If a row already exists with (`toIssuer`, `dexLocalSubject(userId)`), report "already linked" and do nothing. This is what makes re-runs safe.
    2. Otherwise, the candidates are rows with that email whose issuer is in `fromIssuers`. If there are none, report "new user: created at first sign-in".
    3. If there are candidates, choose one: prefer rows under the first issuer in `fromIssuers`, then the newest `last_login_at`. Rewrite that row's `oidc_issuer` and `oidc_subject`, and set `updated_at`.
    4. Report every other candidate as "left behind (#302)" and do not touch it.
  - In one transaction, it also:
    - writes a `user.identity_changed` audit row per rewrite (actor `operator:carry-over`, metadata `{fromIssuer, toIssuer, username}`);
    - if at least one row was rewritten in this run, deletes every row in `sessions` and `preview_sessions` and writes one `auth.sessions_revoked` row (`{reason: "identity-provider-cutover", count}`).
  - Why revoke every session: while the mock was on, anyone could have made an administrator session.
  - The default `fromIssuers` is `["{{ portikus_public_url }}/mock-idp", "https://{{ portikus_public_host }}/mock-idp"]`. The second entry covers the #302 rows made before the move to port 8443.
  - Ansible runs the carry-over in the `portikus` role after the package install and before `api.env` changes. The API keeps running on the mock until the play's restart handler switches it, so no Dex identity can create a row first.
  - `make identity-carry-over-dry-run` runs only the dry run and prints the report.

- **Decision: Todd's users-file entries for carol, alice and bob use the emails their rows already have (`carol@example.edu` and so on).** Real addresses can be set later with `make users-add`. The subject does not depend on the email, and the next sign-in updates the row's email.

### Sign-in rate limit (#398), which Part A needs because Dex has none

- **Decision: one in-memory limiter in the API, keyed by client address, covering the Portikus sign-in routes and Dex's password form.**
  - Code: `apps/api/src/signin-throttle.ts`, registered as a plugin in `server.ts` with an `onRequest` hook.
  - Covered:
    - `GET /auth/login` and `GET /auth/callback`: 60 per minute per address.
    - Dex password form posts: 30 per 10 minutes per address, and 300 per 10 minutes in total. The total protects the VM's CPU from bcrypt checks. Only attempts the per-address limit lets through count toward the total, so one address cannot lock out the class.
  - How Dex's posts are covered: Caddy adds a `forward_auth` in front of `POST /dex/auth/local/login*`, pointing at the API's new loopback-only route `GET /edge/signin-throttle`. The route answers 204, or 429. Caddy matches the decoded path, so the API counts every check it is asked and does not match the URI again.
    - Caddy never proxies `/edge*` on the public site, the same way `/preview/authorize` works today.
  - The client address comes from `request.ip`. `trustProxy` is already `127.0.0.1`, and `publish-vm` only rewrites the destination, so LAN addresses reach the VM unchanged.
  - A refusal:
    - answers 429 with a new error code, `RATE_LIMITED` (the BACKLOG item "A dedicated API error code for rate limits", used here first);
    - is audited as `auth.throttled`, at most once per address per window.
  - The limits come from two environment variables in `packages/config`, with those defaults: `SIGNIN_START_LIMIT_PER_MINUTE` and `PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES`.
  - Why not Caddy's own rate limit: the stock Caddy package has no rate-limit module, and building Caddy with plugins is a bigger change.
  - Why in memory: one API process, the same assumption the administrator-socket cap already makes (STATUS Epic 11).
  - The BACKLOG pairs a journald size cap with this, and it lands in the same task:
    - `/etc/systemd/journald.conf.d/portikus.conf` with `SystemMaxUse=2G`;
    - `RateLimitIntervalSec=30s` and `RateLimitBurst=2000` in the `base` role.

### Other Part A decisions

- **Decision: `/auth/me` gains `signInName`** (the row's `preferred_username`, or its `oidc_subject` when that is empty), and the Settings dialog's "Sign-in name" shows it (`apps/web/src/settings/SettingsDialog.tsx`). Why: a Dex subject is a base64 blob and means nothing to a student.

- **Decision: the mock stays for development, CI and Playwright.** `playwright.config.ts` and the config defaults do not change. The Debian package keeps shipping the mock, disabled (ADR 0008).

- **Decision: the smoke test's lifecycle block stops depending on the mock.** When `PORTIKUS_IDP` is not `mock`:
  - it creates its users by SQL, as the security suite does, under issuer `urn:portikus:smoketest` with subjects `smoke-<run id>-alice`, `-bob` and `-carol` (carol an administrator);
  - it writes their cookies into the same cookie jars `login_as` fills today.

  A full Dex password sign-in runs only when `PORTIKUS_SMOKE_SIGNIN_FILE` names a file with mode 0600 holding an email and a password on two lines. The rehearsal VM uses one; the pilot does not. Why: the block must work with any provider, including IT's, where there are no passwords to use.

### Part B decisions

- **Decision (#399): the download cap is 1 GiB**, as `MAX_DOWNLOAD_BYTES` in `packages/contracts/src/files.ts`.
  - The agent refuses before any work:
    - for a folder or project, when the apparent size of its regular files (walked without following symlinks) is over the cap;
    - for a single file, when its size is over the cap.
  - The refusal is `FILE_TOO_LARGE`. The browser shows a Portikus message naming the limit and suggesting a subfolder, or leaving out `node_modules`.
  - The API counts the bytes it relays and cuts the stream at the cap plus a fixed 64 MiB allowance for zip overhead (`ZIP_OVERHEAD_BYTES`), in case an agent misbehaves.
  - Why 1 GiB:
    - It is far above any real student project without dependencies, and above most with them.
    - It moves in about 10 seconds on gigabit and about 90 seconds on 100 Mbit.
    - It is a tenth of the 10 GB root disk, where the zip is staged under `/var/tmp` (STATUS Epic 12a, #400). A capped download can no longer fill that disk.

- **Decision: `make configure-vm` syncs `infra/incus/` to `/var/lib/portikus/incus/`.**
  - The `image_builder` role, which already creates that directory, copies `infra/incus/workspace.sh` with owner `deploy` and mode 0755. Its checksum makes the copy idempotent.
  - `make build-workspace-image` keeps its rsync.

- **Decision: backups are pulled to the host and encrypted there with age.**
  - VM side, a new Ansible role `backup`:
    - sets `storage.backups_volume` to a dedicated Incus custom volume, `workspace-data/portikus-backups` (20 GiB), so exports never touch the 20 GiB OS disk;
    - installs `/usr/local/sbin/portikus-backup-export`, which:
      - runs `pg_dump -Fc portikus` to standard output;
      - for each workspace, for the `-home` and `-recovery` volumes in turn: makes a snapshot, runs `incus storage volume export --volume-only` on it into the backups volume, streams the file out, then deletes both the file and the snapshot.
  - Host side:
    - `infra/host/backup.sh` runs each step over SSH;
    - each stream is encrypted with `age -r <public key>`, using the key already in `infra/secrets/.sops.yaml`;
    - files are written to `/var/backups/portikus/<UTC timestamp>/` on the host (mode 0700), with a `MANIFEST` of workspace ids, volume names, sizes and SHA-256 sums;
    - 14 daily sets are kept.
  - A host systemd timer, `portikus-backup.timer`, runs it at 02:30. It is installed by `make backup-install-timer`, the way `publish-vm` installs its unit.
  - Docker volumes and root filesystems are not backed up. Why: Reset Docker and Rebuild recreate them, and SPEC.md section 17.3 already says user-installed system packages are not kept.
  - The backup directory lives outside the libvirt pool, so `make destroy-pilot` never touches it. ADR 0024 records all of this.

- **Decision: restore is `infra/host/restore.sh`, run as `make restore VM_IP=<target> BACKUP=<dir>`.** It:
  - stops the API and worker;
  - runs `pg_restore --clean --if-exists`;
  - imports each volume under its original name;
  - recreates each workspace instance that is missing, attaching the existing volumes;
  - starts the services;
  - checks a sample of files against the `MANIFEST`.

  Whether the controller can already adopt existing volumes when it recreates an instance is the task's first spike. If it cannot, the task adds the smallest controller change that can, with tests.

- **Decision: the rebuild exercise, the restore test and the load test run on a second libvirt VM, `portikus-rehearsal`, on this host, next to the live pilot.** No maintenance window is needed.
  - It has its own OpenTofu environment: `infra/tofu/environments/rehearsal-libvirt/`, with network `portikus-rehearsal` on `10.101.0.0/24`, a pool at `/var/lib/libvirt/images/portikus-rehearsal`, and its own local state.
  - It is sized by variables: 12 vCPUs and 24 GiB of RAM by default for the load test, and less for other uses.
  - It is never published. `publish-vm` refuses any environment other than `dev-libvirt`, because port 8443 belongs to the pilot.
  - It is configured with the pilot's own `PORTIKUS_PUBLIC_HOST` and port, so a restored database's issuer (`…:8443/dex`) matches, as it would in a real disaster recovery. The VM's own `/etc/hosts` resolves that name to loopback, and every smoke check runs on the VM.

- **Decision: the load target is SPEC.md section 25.2, "at least 25 concurrently active workspaces". The latency targets are section 25.1.**
  - A test run starts 25 workspaces within 60 seconds. It then holds 15 minutes of steady activity. Every 5 seconds, each workspace:
    - types into a terminal;
    - writes a file;
    - reads Git status;
    - hits a preview.
  - A stand-in process with about 150 MB resident per workspace takes the place of a coding agent, so no credentials or paid calls are used.
  - Pass criteria:
    - start p95 ≤ 10 s;
    - keystroke echo p95 ≤ 150 ms;
    - file event p95 ≤ 1 s;
    - Git refresh p95 ≤ 2 s;
    - `/health` ≤ 2 s throughout;
    - no failed operations.
  - It runs on the rehearsal VM, not on the live pilot, which has 4 vCPUs and 8 GiB and cannot hold 25 workspaces.
  - The result includes the measured footprint per workspace and the VM size that 25 need. Resizing the pilot is Todd's decision.

- **Decision: the threat model is `docs/THREAT-MODEL.md`.**
  - A builder writes it. security-reviewer reviews it against SPEC.md section 24. Todd signs it off.
  - It covers each trust zone in section 24.1, plus the new Dex boundary, and lists for each:
    - assets;
    - entry points;
    - threats;
    - controls, each with the test that proves it (the 12a suites);
    - accepted gaps, each with an issue number.

## Done

### Part A: sign-in

1. `make configure-vm` (with `PORTIKUS_IDP=dex` as the default) builds Dex at `dex_commit` and installs `/usr/local/bin/dex`. A second run rebuilds nothing. Changing `dex_commit` rebuilds and restarts `portikus-dex`. A failed build leaves the previous binary running.
2. `portikus-dex` is active and listens only on `127.0.0.1:5556`. Through Caddy, `/dex/.well-known/openid-configuration` answers with issuer `{{ portikus_public_url }}/dex`. `/dex*` is 404 when the provider is not `dex`, and `/mock-idp*` is 404 when it is not `mock`.
3. With `dex`:
   - `api.env` names the Dex issuer, client `portikus` and the generated secret, with scopes including `groups`;
   - `/etc/portikus/dex-client.secret` is root, mode 0600;
   - `/etc/portikus-dex/config.yaml` is `root:portikus-dex`, mode 0640;
   - the mock unit is disabled, and its env and secret files are gone.
4. `make users-add`:
   - asks for the password twice with no echo, which a test proves by driving the CLI under a pseudo-terminal (node-pty) and checking that the captured output never contains the password;
   - asks again on a mismatch and refuses passwords under 12 characters;
   - writes a cost-12 bcrypt hash, a stable `userId`, a file with mode 0600 and a directory with mode 0700;
   - writes atomically;
   - refuses a path inside a Git work tree and a file with looser permissions;
   - never puts the password in argv, the environment or any message.
5. `make users-check` rejects, each with a message naming the entry: a duplicate username, a duplicate email (in any case), a bad hash, a cost outside 10 to 16, a bad role, an unknown key, and a file with no administrator. `make configure-vm` and `make users-deploy` stop before Ansible runs when the check fails.
6. The rendered Dex config has one entry per user, with groups following the role. The users file is never on the VM. `make build-deb` fails if any packaged file contains `staticPasswords` or a bcrypt hash.
7. Through a real Dex:
   - a student and an administrator each sign in and get the right role;
   - a wrong password creates no session;
   - an email not in the file cannot sign in;
   - a disabled user is refused by Portikus;
   - the Portikus user row's subject equals `dexLocalSubject(userId)`.
8. The carry-over:
   - its dry run lists every user as linked, carried, new or left behind, and changes nothing;
   - `--apply` rewrites exactly the chosen rows, audits each one, and revokes all sessions and preview sessions once;
   - a second `--apply` changes nothing and revokes nothing;
   - it never touches rows outside `fromIssuers`, including `urn:portikus:sectest` and `urn:portikus:smoketest`;
   - all of this is proved by Vitest tests on a real test database, including a copy of the #302 case (two rows per email, both owning workspaces).
9. Sign-in rate limit (#398):
   - the 61st `GET /auth/login` in a minute from one address is a 429 with `RATE_LIMITED`, and another address is unaffected;
   - `/edge/signin-throttle` refuses the 31st check in 10 minutes;
   - the #398 `test.fails` marker in `apps/api/src/security/limits.test.ts` is removed and the test passes;
   - the route is classified in `apps/api/src/security/route-policy.ts`;
   - journald's limits are in place.
10. Settings shows the username as the "Sign-in name".
11. With `PORTIKUS_IDP=external`, the `PORTIKUS_OIDC_*` variables and `PORTIKUS_API_IP_ALLOW=<cidr>`, a run renders the drop-in, and `systemctl show portikus-api -p IPAddressAllow` includes the CIDR. No code or package change is involved.
12. A new CI job, `dex-signin`, does the following, and item 7 runs there:
    - builds Dex from the pinned commit with a cache, reading `dex_commit` out of `site.yml`;
    - renders the real Jinja template with the fixture `infra/tests/fixtures/users.sample.json` through `infra/tests/dex-render-test.yml`;
    - starts Dex on `http://127.0.0.1:5556/dex`;
    - runs `packages/auth/src/dex.integration.test.ts`, which drives `createOidcClient`, gets the login form, posts it, follows the redirects and calls `completeLogin`.
13. The smoke test:
    - with `dex`, checks items 2 and 3, a wrong-password refusal and the throttle through Caddy;
    - checks that no bcrypt hash appears in the journals of `portikus-dex`, `portikus-api` or `caddy`, or in the Ansible output;
    - runs its lifecycle block with SQL-made users, so it passes on a fresh VM with no mock;
    - does a full Dex sign-in when `PORTIKUS_SMOKE_SIGNIN_FILE` is given.
14. `make security-test`: the #408 `known_vuln` is replaced by real checks (mock inactive, the API's issuer is not the mock), and it passes on the pilot after the cutover.
15. Pilot cutover (task A6):
    - `pre-epic12b` snapshots and a `pg_dump` are taken first;
    - the dry run is reviewed;
    - `configure-vm` runs;
    - carol, alice and bob sign in with their new passwords and land in their original workspaces (same workspace id, label and files);
    - `make security-test` passes with no #408 marker.

### Part B: readiness

16. **#399.**
    - A folder or project over 1 GiB is refused before zipping with `FILE_TOO_LARGE`, and the browser shows the limit.
    - A single file over 1 GiB is refused.
    - The API cuts a lying agent's stream at the cap plus 64 MiB.
    - The #399 marker in `apps/api/src/security/hostile-agent.test.ts` is removed and the test passes.
    - A Playwright test covers the message.
17. **Incus sync.** After `make configure-vm`, `/var/lib/portikus/incus/workspace.sh` has the same SHA-256 as the repository's copy, with no image build. The smoke test checks this.
18. **Backup.**
    - `make backup` produces, on the host, an age-encrypted `pg_dump`, one encrypted export per `-home` and `-recovery` volume, and a `MANIFEST`.
    - It leaves no snapshot or export on the VM.
    - It runs on the live pilot while students are signed in, and workspace state, deadlines and settings are the same before and after (reusing the security suite's snapshot helper).
    - The timer runs nightly and keeps 14 sets.
19. **Restore.** `make restore` of the newest pilot backup onto the rehearsal VM:
    - brings back every user, workspace and project row;
    - brings back each workspace's home and recovery volumes, with file checksums matching the `MANIFEST`;
    - starts one restored workspace (as a SQL-made administrator) whose files and Git state match.
    - The steps are timed and written into the runbook.
20. **Rebuild exercise (STACK.md section 33, all 16 steps).** `make rebuild-exercise` on the rehearsal VM:
    - destroys it;
    - recreates it with OpenTofu, cloud-init and Ansible (Dex, with a rehearsal users file);
    - builds the image;
    - installs the newest release;
    - restores the pilot backup;
    - passes the full smoke test, lifecycle block included: sudo, nested Docker, the agent, a terminal, `claude --version` and `codex --version`, a test web application, an authenticated preview, and a full Dex sign-in;
    - reinstalls the previous release and passes `/health` and sign-in.

    Nothing in it is undocumented or done by hand.
21. **Load.** `make load-test VM_IP=<rehearsal> N=25` meets the item-level criteria in the decision above, and reports each figure and the footprint per workspace. A capacity preflight refuses to start when the VM cannot take N workspaces. The run cleans up only what it recorded.
22. **Docs.**
    - `docs/OPERATIONS.md` covers:
      - daily checks;
      - managing accounts (add, reset, remove, disable);
      - backup, and a restore drill;
      - upgrade and rollback;
      - Dex upgrades;
      - the IT-provider cutover;
      - incidents: a workspace that will not start, a full pool, Dex down, the VM down, a lost users file, a lost age key.
    - `infra/README.md` is brought up to date, and its "a real identity provider will not work end to end yet" paragraph is removed.
    - Todd reads and signs off the runbook (a Gate E condition).
23. **Threat model.** `docs/THREAT-MODEL.md` exists. Every section 24.1 zone and the Dex boundary have entries, every control cites a test, and every accepted gap has an issue. security-reviewer's findings are resolved or recorded, and Todd signs it off.

## Out of this epic

- A GitHub connector, an LDAP connector, or any other Dex connector.
- Self-service password change or reset. Static passwords cannot do it (BACKLOG item).
- The move to IT's identity provider itself.
- Encryption at rest for the student volumes on the VM (the SPEC.md section 24.9 gap stays documented).
- Off-site copies of backups.
- Merging the #302 duplicate accounts (Todd decides).
- The egress allow-list (#284).
- The accessibility review, which Gate E needs; see risk 13.
- The user-facing failure-case pass from the section 29 list.
- Resizing the pilot VM.

---

# Part 2: Tasks for parallel builders

Ownership rules:

- Each task owns only the files listed.
- In Part A, only A4 edits `infra/ansible/site.yml`, the `portikus` and `caddy` roles, `Makefile` (after A0) and `infra/README.md`.
- In Part B, `Makefile` is edited only by B1 and then B3, one after the other. B4 and B5 add fragments `mk/load.mk` and `mk/rehearsal.mk`, which B1's `-include mk/*.mk` line pulls in.
- The orchestrator writes `docs/STATUS.md` and `docs/BACKLOG.md` in a closing PR.

## Part A: sign-in, to be deployed alone

| Task | Agent | Files it owns | Depends on | Real host |
|---|---|---|---|---|
| **A0 Rehearsal VM environment** | infra | `infra/tofu/environments/rehearsal-libvirt/*`; `Makefile` (`TOFU_ENV ?= dev-libvirt` feeding `TOFU_DIR`; `rehearsal-up` and `rehearsal-destroy`, which name the rehearsal env explicitly; `publish-vm` refusing any env but `dev-libvirt`; `infra-check` validating both envs) | none | Yes: bring the VM up and down next to the pilot |
| **A1 Identity code** | builder | `packages/auth/src/dex-subject.ts`, `carry-over.ts`, `carry-over-main.ts`, their tests, and `index.ts`; `apps/api/src/routes/auth.ts` and `auth.test.ts` (`signInName` only); `packages/contracts/src/auth.ts`; `apps/web/src/settings/SettingsDialog.tsx`; `e2e/profile.spec.ts` | none | No |
| **A2 Users-file tool** | builder | `packages/users-file/**`; `pnpm-lock.yaml`; `.gitleaks.toml` (allow the fixture); `infra/tests/fixtures/users.sample.json` (a test password published on purpose) | none | No |
| **A3 Sign-in throttle and journald (#398)** | builder, then infra for the base role | `apps/api/src/signin-throttle.ts` and its test; `apps/api/src/server.ts`; `packages/config/src/index.ts`; `packages/contracts/src/workspace.ts` (`RATE_LIMITED`); `apps/api/src/security/route-policy.ts`; `apps/api/src/security/limits.test.ts`; `infra/ansible/roles/base/**` | none | No |
| **A4 Dex deployment** | infra | `infra/ansible/roles/dex/**`; `site.yml`; `roles/portikus/**` (provider switch, Dex secret, carry-over task, scopes, IP-allow drop-in); `roles/caddy/templates/Caddyfile.j2` (`/dex`, the `forward_auth` to `/edge/signin-throttle`, the 404 fallbacks); `infra/tests/caddy-preview-test.sh`; `infra/tests/dex-render-test.yml`; `Makefile` (`users-*`, `identity-carry-over-dry-run`, `PORTIKUS_IDP`, `PORTIKUS_USERS_FILE`, `PORTIKUS_API_IP_ALLOW`, the `build-deb` hash guard via `scripts/build-deb.sh`); `infra/README.md` "Identity provider"; `docs/adr/0023-dex-static-users.md`; `docs/adr/0008` (status line) | A0; builds against the A1, A2 and A3 contracts in parallel, and verifies with a local deb that contains them | Yes: rehearsal VM, bootstrap to smoke test |
| **A5 Sign-in tests** | tester, and infra for the shell | `.github/workflows/ci.yml` (`dex-signin` job); `packages/auth/src/dex.integration.test.ts`; `infra/tests/smoke-test.sh`; `infra/tests/security-test.sh` and `infra/tests/security/lib.sh` (#408) | A1, A2, A4 | Yes: rehearsal VM |
| **A6 Pilot cutover** | orchestrator with infra; no repo files | an operation, not code | the Part A PR merged to `main` by Todd, and its release published | Yes: the live pilot |

A1, A2, A3 and A0 run fully in parallel. A4 starts in parallel and opens its PR last. Then A5 follows.

Once security-reviewer and code-reviewer have reviewed Part A, the orchestrator opens the Part A PR to `main`. Why: the pilot must not run unreviewed code (the 12a ruling), and the release workflow publishes only from `main`.

Two interfaces are fixed here so tasks can build against each other without waiting:

- `GET /edge/signin-throttle` answers 204 or 429 and reads `X-Forwarded-For`; it counts every check, since Caddy already matched the path.
- The carry-over input JSON has the shape `{toIssuer, fromIssuers[], users[{email, username, userId}]}`, and the command's flags are `--input <path>` and `--apply`.

### A6 procedure, out of class hours

1. Run `dpkg -s portikus` on the pilot and record the version.
2. Take `pre-epic12b` Incus snapshots of each `-home` and `-recovery` volume, and a `pg_dump` to the host.
3. Todd runs `make users-add` for carol (administrator), alice and bob, using their current emails.
4. On the rehearsal VM, rehearse the cutover on a restored copy of the pilot database: run `make identity-carry-over-dry-run`, then `--apply`, and check with SQL that each chosen row now has the Dex issuer and still owns its workspace.
5. On the pilot, run `make identity-carry-over-dry-run`. Todd reads the report.
6. Run `make configure-vm PORTIKUS_USERS_FILE=…`.
7. Run `make smoke-test` and `make security-test`.
8. Todd signs in as carol, then alice and bob sign in.
9. If anything fails: run `make configure-vm PORTIKUS_IDP=mock` and restore the `pg_dump`. The snapshots are untouched.

## Part B: readiness, after Part A is on `main`

First sync the epic branch with `main`.

| Task | Agent | Files it owns | Depends on | Real host |
|---|---|---|---|---|
| **B1 Incus script sync** | infra | `infra/ansible/roles/image_builder/tasks/main.yml`; `Makefile` (the `-include mk/*.mk` line) | none | Yes: rehearsal VM, then the pilot's next `configure-vm` |
| **B2 Download cap (#399)** | builder | `packages/contracts/src/files.ts`; `apps/workspace-agent/src/projects.ts` and the agent's file-download path; `apps/api/src/routes/files.ts`; `apps/api/src/security/hostile-agent.test.ts`; the web download message; a new `e2e/download-cap.spec.ts` | none | No |
| **B3 Backup and restore** | infra (plus a builder if the controller needs to adopt existing volumes) | `infra/ansible/roles/backup/**`; `site.yml` (role line); `infra/host/backup.sh`, `infra/host/restore.sh`, `infra/host/systemd/portikus-backup.{service,timer}`; `Makefile` (`backup`, `backup-install-timer`, `restore`, and its shell tests in `infra-check`); `infra/tests/backup-scope-test.sh`; `docs/adr/0024-backups-pulled-to-host.md`; if needed, `apps/workspace-controller/**` | B1 (Makefile order); A0 | Yes: back up the live pilot, restore onto the rehearsal VM |
| **B4 Load and concurrency** | infra | `infra/tests/load-test.sh`, `infra/tests/load/*.mjs`, `mk/load.mk`, `docs/CAPACITY.md` (method and results) | A0, A5 (SQL-made users) | Yes: the rehearsal VM only |
| **B5 Rebuild-from-code exercise** | infra | `mk/rehearsal.mk` (`rebuild-exercise`); `infra/tests/rebuild-exercise.sh`; `infra/tests/smoke-test.sh` (restored-data and script-checksum checks) | A0, B1, B3 | Yes: the rehearsal VM |
| **B6 Deployment docs and runbook** | builder | `docs/OPERATIONS.md`; `infra/README.md`; `README.md` (pointers); `docs/OVERVIEW.md` ("Current state"); `docs/SPEC.md` section 29 (the Epic 12b line) | all other B tasks | No |
| **B7 Threat model** | builder writes, security-reviewer reviews | `docs/THREAT-MODEL.md` | Part A merged; can run alongside B1 to B5 | No |

B1, B2, B4 and B7 start together. B3 starts once B1 lands. B5 runs after B3. B6 comes last.

Then security-reviewer and code-reviewer review the epic head, fixes land, the orchestrator writes STATUS and BACKLOG, and the epic PR goes to `main`.

---

# Part 3: Real-host constraints

- The pilot is live with carol's, alice's and bob's workspaces, the #302 duplicate rows, and the snapshots `pre-epic10-11`. Nothing may destroy, stop, restart, rebuild, reset or restore a student workspace or volume.
- The only changes allowed on the pilot are A6's cutover, B1's `configure-vm`, and B3's backup runs. Each goes through Ansible or a Make target, out of class hours, and after `pre-epic12b` snapshots and a `pg_dump`.
- The cutover must leave each of the three workspaces reachable by its owner after sign-in: same workspace row, instance, label and volumes. Rehearse it on the rehearsal VM first, against a restored database.
- Snapshots taken for backups are deleted by the backup run. The `pre-epic10-11` and `pre-epic12b` snapshots are never deleted by any script.
- No `make smoke-test` lifecycle run on the pilot while student workspaces exist (it skips itself anyway). No load test on the pilot. `make security-test` is allowed (it is safe on a live system, per 12a).
- The rehearsal VM must:
  - never be published;
  - never share state files, pools or networks with `dev-libvirt`;
  - be destroyed when an exercise ends, because it holds restored student data;
  - not start while the host has less than its memory size free. The preflight checks `free`.
- Every destructive Make target that takes `TOFU_ENV` prints the VM name it is about to act on and refuses `dev-libvirt` unless the target's name says pilot.
- Record `dpkg -s portikus` before and after each pilot change. The pilot never stays on a package that has not been merged to `main`.

---

# Part 4: Risks and open questions

1. **How Todd tells students their new passwords.**
   - Recommended: Todd generates a random password for each student in a password manager (at least 16 characters), enters it with `make users-add`, and hands it over in person, or through a private message in the institution's learning system.
   - Never by plain email: the rows use `example.edu` addresses, and email is the weakest channel.
   - Tell students that Portikus cannot change the password for them; Todd resets it on request.
   - Add a BACKLOG item for self-service password change, which ends when IT's provider arrives.

2. **The users file is lost.**
   - Recommended, three layers:
     - the nightly backup (B3) copies it, age-encrypted, into each backup set;
     - while the VM exists, `make users-recover` can rebuild it from `/etc/portikus-dex/config.yaml` over SSH (root only). Every field is there: email, hash, username, name, userID and groups. This command goes to B3, or to A4 if it is cheap there;
     - if both are gone, re-add the users. They get new `userId`s, and running the carry-over with the Dex issuer added to `--from-issuer` moves each row to its new subject by email, audited.
   - No workspace is lost in any of these cases.

3. **Dex upgrades.**
   - Recommended: a PR bumps `dex_version` and `dex_commit` together, after reading the upstream release notes for configuration changes.
   - CI's `dex-signin` job builds and tests the new commit.
   - The rehearsal VM runs `make configure-vm`, then smoke.
   - On the pilot, the role rebuilds and restarts Dex. With memory storage, only sign-ins in flight at that second fail.
   - To roll back, revert the pin.
   - Check for new Dex releases monthly, as part of the SPEC.md section 24.12 routine in the runbook.

4. **Dex has no lockout.**
   - Covered by the per-address and overall limits on the password form (A3) and by long random passwords.
   - Where many students share one address behind campus NAT, raise `PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES`. It is a configuration value for exactly this reason.

5. **Email matching attaches a workspace to the wrong person if a file email is wrong.**
   - Mitigations:
     - the dry run shows each pairing, and Todd approves it;
     - only rows under the mock issuers are candidates;
     - every rewrite is audited;
     - the pre-cutover `pg_dump` undoes it.

6. **The #302 duplicates.**
   - The row under the current mock issuer with the newest sign-in wins, and the others are reported and left alone. They can no longer sign in.
   - Recommended: once the cutover is confirmed, Todd archives them from the admin page.

7. **IT's provider later.**
   - The settings swap is configuration only: `PORTIKUS_IDP=external`, the `PORTIKUS_OIDC_*` variables, scopes, group names, `PORTIKUS_API_IP_ALLOW`.
   - The accounts need a carry-over again. IT's subjects are not predictable, so ask IT for an export of email and subject and feed it to the same carry-over (a small `--subjects-file` input, added then).
   - Do not auto-link accounts by email at sign-in.

8. **Building Dex on the VM needs GitHub and the Go proxy, and about 1 GB of Go cache on a 20 GiB OS disk.**
   - The role clears the Dex build cache after a successful build. A failed build keeps the old binary. The smoke test checks free space on the OS disk.

9. **The pilot VM cannot run 25 active workspaces.**
   - B4 measures on the rehearsal VM and states the size needed.
   - Recommended: raise the pilot's `memory_mb` and `vcpus` before the pilot starts. That is an OpenTofu change with a VM reboot, in a window Todd chooses. The data disk is unchanged.

10. **Backups sit on the same physical disk as the VM.**
    - This protects against losing the VM or a mistake, not against losing the disk.
    - Recommended: record this as an accepted pilot gap in the threat model, and have Todd copy `/var/backups/portikus` to external storage weekly. Automating that is a later task.

11. **Losing the age private key makes every backup unreadable.**
    - Recommended: store `infra/secrets/age-key.txt` in Todd's password manager as well. The runbook's restore drill starts by decrypting a MANIFEST to prove the key works.

12. **Part A needs a merge to `main`, and therefore a review by Todd, before the rest of the epic.**
    - Recommended: accept two epic PRs, "12b part A" and then the rest. Why: the cutover closes the one open Gate C condition, and waiting for load and rebuild work keeps the administrator hole open longer.

13. **Gate E also needs an accessibility review, which this epic does not do.**
    - The Playwright a11y specs exist, but a review is a human pass.
    - Recommended: Todd decides between a short Epic 12c and folding it into B6's sign-off.

14. **Upstream Dex behavior that this brief relies on:** groups on static passwords, `preferredUsername`, the subject encoding, and login by email.
    - All four were checked against commit `11d2eeb` and Dex's documentation on 2026-09-22.
    - CI's `dex-signin` job pins them, so an upgrade that changes any of them fails in CI before it reaches the pilot.

15. **Signing out of Portikus does not end a Dex session.** Dex's password login keeps no browser session, so the next sign-in asks for the password again. That suits shared lab computers. The runbook notes it.
