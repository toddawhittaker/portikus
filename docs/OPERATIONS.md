# Operations runbook

This is the runbook for the one operator of the Portikus pilot. It says how
to deploy, manage accounts, back up and restore, and check the pilot. It
serves SPEC.md section 29, Epic 12 ("deployment documentation and a
runbook"), and docs/EPIC-12B.md, task B6. How the infrastructure is built
the first time is in `infra/README.md`. What each part of this runbook
rests on is in the ADRs (architecture decision records) it cites.

Names used throughout:

- **The host** is the Pop!_OS machine that runs libvirt, the virtual
  machine manager. Every `make` command runs here, from a checkout of the
  repository.
- **The pilot** is the platform VM `portikus`, at `10.100.0.120`. Its
  OpenTofu environment is `dev-libvirt`, the default `TOFU_ENV`. `make`
  reads the VM's address from the OpenTofu state, so never pass `VM_IP` by
  hand for the pilot.
- **The rehearsal VM** is `portikus-rehearsal`, a second VM on the same
  host for exercises that must not touch the pilot (`TOFU_ENV=rehearsal-libvirt`).
- **Out of class hours** means no student is working. Every change to the
  pilot happens then.

## Rules that hold for every pilot change

1. Fetch first: `git fetch origin` and check out `origin/main`. The pilot
   never runs a package that has not been merged to `main`.
2. Record `ssh deploy@10.100.0.120 dpkg -s portikus | grep Version` before
   and after the change.
3. Take snapshots and a database dump first (next section).
4. Change the pilot only through a Make target or Ansible, never by hand.
5. Never run the smoke test's lifecycle block or a load test on the pilot.
   `make security-test` is safe on the live pilot.
6. Nothing may destroy, stop, restart, rebuild, reset or restore a
   student's workspace or volume without the student knowing.

## Before a change: snapshots and a database dump

Take an Incus snapshot of each workspace's home, Docker and recovery volume, and
a `pg_dump` (a PostgreSQL export) of the platform database to the host.
Name the snapshots after the change, for example `pre-epic12b`.

```
ssh deploy@10.100.0.120 'for v in $(sudo incus storage volume list workspace-data --project portikus -f csv -c n | grep -E "^ws-.*-(home|docker|recovery)$"); do sudo incus storage volume snapshot create workspace-data "$v" pre-CHANGE --project portikus; done'
ssh deploy@10.100.0.120 'sudo runuser -u postgres -- pg_dump -Fc portikus' > ~/portikus-pre-CHANGE-$(date +%F).dump
```

No script ever deletes a `pre-...` snapshot. Delete old ones by hand once
the change has proved itself for a week or so. A fresh `make backup` is
also a good idea before any larger change.

To undo a bad change, install the previous package
(`make configure-vm PORTIKUS_VERSION=<old version>`) and, only if the
database itself is wrong, load the dump with `pg_restore --clean`.

## Deploying

```
git fetch origin && git checkout origin/main
nvm use
make build-deb
make configure-vm PORTIKUS_DEB=dist/deb/portikus_<version>_amd64.deb PORTIKUS_IDP=<provider>
make smoke-test PORTIKUS_IDP=<provider>
```

- `make build-deb` builds the control-plane Debian package into `dist/deb`.
- `make configure-vm` runs the whole Ansible play. With `PORTIKUS_DEB` it
  installs that local package. Without it, it installs the newest
  published release, and `PORTIKUS_VERSION=<version>` installs an older
  one, which is how a rollback works.
- Run `configure-vm` when no workspace is being created. A controller
  restart in the middle of a create used to leave the workspace in
  `error`. The worker now retries the create, but it is still better not
  to race it (docs/CAPACITY.md, "Limits observed").

`PORTIKUS_IDP` picks the sign-in provider (ADR 0023):

- `dex`, the default: Dex runs on the VM and accounts come from the users
  file on the host.
- `mock`: the test provider, where anyone who reaches the site can sign in
  as anyone, the administrator included.
- `external`: a real provider such as the institution's, named by the
  `PORTIKUS_OIDC_*` settings (`infra/README.md`, "An external provider").

**Because `dex` is the default, pass `PORTIKUS_IDP=mock` explicitly on
every `configure-vm` and `smoke-test` while the pilot is still on the
mock.** Leaving it out runs the Dex cutover. After the cutover, leave it
out or pass `dex`.

`make deploy-app` builds and installs the package without Ansible. It is
quicker for a small application fix, but it skips everything else, so
prefer `configure-vm`.

## Managing users

Dex accounts live in a users file on the host,
`~/.config/portikus/users.json`, mode 0600, in a directory with mode 0700.
It holds each user's email, display name, role, a fixed random id, and a
bcrypt hash of the password, never the password itself. The tool refuses a
file inside a Git work tree or with looser permissions. The file is never
copied to the VM; Ansible renders the Dex entries from it. Keep a copy in
your password manager. Each nightly backup also holds an encrypted copy.

```
make users-add USERNAME=alice      # create or update; asks for the password twice
make users-remove USERNAME=alice
make users-list                    # never shows hashes
make users-check                   # validate the file
make users-deploy                  # apply the file to Dex on the VM
```

- `users-add` asks for the email, display name and role (`student`,
  `instructor` or `administrator`), then the password twice without showing it. Passwords
  need at least 12 characters. The first user must be an administrator.
- Generate each password in the password manager (16 characters or more)
  and hand it over in person or by a private message in the learning
  system. Never by plain email.
- Students cannot change their own password. To reset one, run
  `make users-add` for that user again, then `make users-deploy`.
- `users-remove` and `users-add` only change the file. Nothing reaches the
  VM until `make users-deploy` (or `make configure-vm`).
- `users-deploy` ends the Portikus sessions and preview sessions of every
  user who was removed, whose password changed, or whose role changed. It writes one `auth.sessions_revoked` audit
  event. To stop someone at once, disable the account in `/admin`.

If the users file is lost, restore it from the newest backup set
(`users.json.age`), or re-add the users. Re-added users get new ids; a
carry-over with the Dex issuer as a source moves each account to its new
id by email (docs/EPIC-12B.md, risk 2). No workspace is lost either way.

## The Dex cutover (task A6)

This moves the pilot from the mock provider to Dex. It has not been run on
the pilot yet. Do it out of class hours, and only once the Part A code is
merged to `main` and published.

1. Record `dpkg -s portikus` on the pilot.
2. Take `pre-epic12b` snapshots of each `-home`, `-docker` and `-recovery` volume and
   a `pg_dump` to the host, as above.
3. Run `make users-add` for carol (administrator), alice and bob, using the
   emails their accounts already have (`carol@example.edu` and so on).
   Real addresses can be set later; the next sign-in updates the email.
4. Rehearse on the rehearsal VM first:
   - `make rehearsal-up`, `make configure-vm TOFU_ENV=rehearsal-libvirt`
     with the pilot's `PORTIKUS_PUBLIC_HOST` and port, and `PORTIKUS_IDP=mock`;
   - restore the newest pilot backup onto it (see "Restore");
   - `make identity-carry-over-dry-run TOFU_ENV=rehearsal-libvirt`, and
     read the report;
   - `make configure-vm TOFU_ENV=rehearsal-libvirt` (Dex, which applies
     the carry-over);
   - check with SQL that each chosen row now has the Dex issuer and still
     owns its workspace;
   - `make rehearsal-destroy`.
5. On the pilot, run `make identity-carry-over-dry-run`. It changes
   nothing. Read the report: each account is "already linked", "would
   carry", "new" (gets an account at first sign-in), or "left behind" (an
   older duplicate from #302, which is not touched). Check that each
   pairing is the right person.
6. Run `make configure-vm PORTIKUS_USERS_FILE=~/.config/portikus/users.json`
   (the default path, so the variable can be left out). It carries the
   accounts over, signs everyone out once, and switches the API to Dex.
7. Run `make smoke-test` and `make security-test`. The security suite must
   pass with no #408 marker.
8. Sign in as carol, then have alice and bob sign in. Each must land in
   the same workspace, with the same label, projects and files.
9. Record `dpkg -s portikus` again.
10. If anything fails: run `make configure-vm PORTIKUS_IDP=mock` and load
    the `pg_dump`. The snapshots are untouched.

After the cutover, archive the left-behind #302 duplicates from the admin
page once the three students have signed in.

**Signing out of Portikus does not end a Dex session, and none is needed.**
Dex's password login keeps no browser session, so the next sign-in always
asks for the password again. That suits shared lab computers: the next
person at the machine cannot sign in as the last one.

## The sign-in throttle

Dex has no lockout, so the API slows repeated sign-ins from one address
(#398, `apps/api/src/signin-throttle.ts`):

- Sign-in starts: 150 a minute per address. These are `/auth/login`,
  `/auth/callback`, and every GET under `/dex/auth`. One sign-in makes
  about five, so one address can complete about 30 sign-ins a minute,
  enough for a lab behind one campus address.
- Dex password posts: 30 per 10 minutes per address, and 300 per 10
  minutes for everyone together. Caddy asks the API before each post
  reaches Dex. Attempts one address has already had refused do not count
  toward the shared 300, so one address cannot lock out the class.

Caddy also lets only the Dex paths a sign-in uses reach Dex: `/dex/auth*`,
`/dex/token`, `/dex/userinfo`, `/dex/keys`, `/dex/.well-known/*`,
`/dex/static/*`, `/dex/theme/*` and `/dex/callback*`. Anything else under
`/dex` is a 404, a URI longer than 1024 bytes is a 414, and a method other
than GET on `/dex/auth` is a 405, apart from the password post.

A refusal answers 429 with `RATE_LIMITED` and writes one `auth.throttled`
audit event per address per window. The counts live in the API's memory,
so restarting `portikus-api` clears them.

If many students share one address behind a campus network, raise the
limits with `SIGNIN_START_LIMIT_PER_MINUTE` and
`PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES`. Set them in a systemd drop-in, not
in `/etc/portikus/api.env`: Ansible rewrites `api.env` on every
`make configure-vm`, and it leaves a drop-in alone. On the VM:

```sh
sudo systemctl edit portikus-api
```

In the editor, add the values you need, then save:

```ini
[Service]
Environment=SIGNIN_START_LIMIT_PER_MINUTE=300
Environment=PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES=60
```

Then run `sudo systemctl restart portikus-api`. A value in an
`EnvironmentFile` beats a drop-in's `Environment=`. That is not a problem
here, because `api.env` does not set these two variables. Check the result
with `sudo systemctl show portikus-api -p DropInPaths`. To go back to the
defaults, delete `/etc/systemd/system/portikus-api.service.d/override.conf`,
then run `sudo systemctl daemon-reload` and restart the API. Do not use
`systemctl revert`: it would also delete the `10-idp-egress.conf` drop-in
that Ansible writes for an external provider.
This was tested on the rehearsal VM on 2026-09-23. With a start limit of
400, 160 starts from one address in a minute all got through, where the
default refuses the last 10.

## Signing in from a learning management system (LTI 1.3)

A learning management system (LMS), such as Canvas or Moodle, can open
Portikus from a course. LTI 1.3 (Learning Tools Interoperability) is the
standard for this. The LMS signs a token that names the person, their
role and the course. Portikus checks it and signs the person in with no
second password. Students land in their own workspace. Instructors,
teaching assistants and course designers land in their own workspace too,
and also get a read-only **Course** page. The design is in ADR 0025 and
`docs/EPIC-13.md`.

LTI is off until at least one LMS is registered. Every `/lti/*` route then
answers 404.

### What Portikus tells the LMS

Use the public URL of the site, shown here as `https://<site>`, for the
pilot `https://portikus.192.168.10.48.nip.io:8443`.

| What the LMS asks for | Value |
|---|---|
| Login initiation URL | `https://<site>/lti/login` |
| Redirect URI and target link URI | `https://<site>/lti/launch` for the redirect, `https://<site>/` for the target link |
| Public keyset URL (JWKS, the tool's public keys) | `https://<site>/lti/jwks` |

**Canvas.** An administrator opens Admin, Developer Keys, and adds an
**LTI Key**. Set:

- Redirect URIs: `https://<site>/lti/launch`.
- Target Link URI: `https://<site>/`.
- OpenID Connect Initiation Url: `https://<site>/lti/login`.
- JWK Method: **Public JWK URL**, with `https://<site>/lti/jwks`.
- Placement: Course Navigation (or Link Selection), with the privacy level
  at least "Public" so the name is sent.
- Turn the key on, and note its client id (the number under Details).
  Add the tool to the account or course by that client id, and note the
  deployment id Canvas shows for it.
- Ask Canvas to **open in a new window**: in the placement's settings, set
  the window target to `_blank` (in the configuration JSON,
  `"windowTarget": "_blank"`).

For Canvas cloud, the platform values are always the issuer
`https://canvas.instructure.com`, the auth login URL
`https://sso.canvaslms.com/api/lti/authorize_redirect`, and the keyset URL
`https://sso.canvaslms.com/api/lti/security/jwks`.

**Moodle.** An administrator opens Site administration, Plugins, Activity
modules, External tool, **Manage tools**, and configures a tool manually:

- Tool URL: `https://<site>/`.
- LTI version: **LTI 1.3**.
- Public key type: **Keyset URL**, with Public keyset `https://<site>/lti/jwks`.
- Initiate login URL: `https://<site>/lti/login`.
- Redirection URI(s): `https://<site>/lti/launch`.
- Default launch container: **New window**.
- Under Privacy, share the launcher's name (and email if wanted) with the tool.

After saving, the tool's "View configuration details" shows the platform
ID (the issuer), client ID, deployment ID, public keyset URL and
authentication request URL. Those go in the platforms file.

"Open in a new window" matters. Inside a frame, the browser often blocks
the cookie the launch needs. Portikus then shows a page with an **Open
Portikus in a new tab** button, which works, but costs the student a click.

### The platforms file

The registered platforms live in `~/.config/portikus/lti-platforms.json`
on the host (Makefile `PORTIKUS_LTI_PLATFORMS_FILE`). It holds no secret.

```json
{ "version": 1,
  "platforms": [
    { "name": "Canvas",
      "issuer": "https://canvas.instructure.com",
      "clientId": "10000000000001",
      "authLoginUrl": "https://sso.canvaslms.com/api/lti/authorize_redirect",
      "keysetUrl": "https://sso.canvaslms.com/api/lti/security/jwks",
      "deploymentIds": ["1:8865aa05b4b79b64a91a86042e43af5ea8ae79eb"],
      "mock": false } ] }
```

- `name` is 1 to 60 characters and unique. It shows on the Course page and
  in audit rows.
- `issuer`, `authLoginUrl` and `keysetUrl` must be HTTPS.
- `deploymentIds` lists every deployment id the LMS may send. Re-adding
  the tool in the LMS can make a new one.
- Each issuer and client id pair appears once. Unknown keys and an empty
  `platforms` list are refused.

Apply it with `make configure-vm` (out of class hours, after "Before a
change"). Ansible copies the file to `/etc/portikus/lti-platforms.json`
and checks it with the API's own parser before installing it, so a bad
file stops the run with the problem named. To turn LTI off, delete the
file and run `make configure-vm` again.

### Egress to the LMS

The API may only reach the addresses it is allowed to (the API unit's IP
allow list). Portikus fetches each platform's keyset to check signatures.
When the keyset URL uses an IP address, Ansible allows that address by
itself. When it uses a hostname, as every cloud LMS does, name the
addresses with `PORTIKUS_API_IP_ALLOW`:

```
make configure-vm PORTIKUS_API_IP_ALLOW=198.51.100.0/24
```

Every range added here is a place the API can send requests to, so a
compromised API could reach it too. Use the narrowest range the LMS
publishes for its keyset host. A cloud LMS's addresses change, so a
narrow range can go stale, and launches then fail with
`keyset_unavailable`. Allowing `0.0.0.0/0` makes launches reliable but
removes the API's egress limit altogether; do it only as a recorded
decision in the threat model.

### Roles and the Course page

- LTI gives `instructor` for the LMS membership roles Instructor,
  TeachingAssistant and ContentDeveloper (and their sub-roles), and for an
  Administrator role. Everything else, including an institution-level
  Instructor, gives `student`. LTI never gives `administrator`.
- The role is refreshed on every launch, and a change is audited.
- A Dex account can be an instructor too: `make users-add` offers the
  role, and Dex gives it the group `portikus-instructors`. `make
  users-deploy` ends a user's sessions whenever their role changes.
- An instructor sees a **Course** link in the header. The Course page lists
  everyone who has opened Portikus from that course, with name, role, last
  launch and whether their workspace is running. It is read-only. An
  instructor cannot see anyone else's files and is refused on every
  administrator page.
- Someone removed from the course in the LMS stays on the Course page.
- An LTI user and a Dex user are separate accounts, even with the same
  email.

### When a launch fails

The student sees a refusal page. The reason is in the `auth.login` audit
rows on the admin page (method `lti`, with a reason code such as
`unknown_deployment` or `keyset_unavailable`), and in the API log:

```
sudo journalctl -u portikus-api -o cat --since -1h | grep -i lti
```

A missing state cookie or a framed launch is only in the log, not the
audit. The usual fix for `unknown_deployment` is to add the new deployment
id to the file. For `keyset_unavailable`, check the egress allow list.

### Trying it with the mock LMS

A mock LMS runs on the host, never on the VM. It listens on `127.0.0.1`
and the host's address on the VM network (`10.100.0.1`), port 8765, so
only this host and the VM can reach it. Anyone who can reach it can launch
as anyone, so it is trusted only while it is registered.

1. In one terminal, start it and leave it running:

   ```
   make mock-lms
   ```

2. In another, register it. This adds a `mock-lms` entry to the platforms
   file and applies only the LTI tasks:

   ```
   make lti-mock-register
   ```

3. Open http://127.0.0.1:8765 on the host. Pick a person, a course and
   whether to launch inside a frame, then launch. Launch as Sam Student,
   then as Ivy Instructor, and open the Course page.
4. When done, stop trusting it, then stop `make mock-lms` with Ctrl-C:

   ```
   make lti-mock-unregister
   ```

While the mock is registered, `make security-test` prints a warning
naming it, and the smoke test reports it. Users created by mock launches
stay in the database, under the issuer `lti:http://10.100.0.1:8765`.

## Backups

A backup is pulled from the VM to the host and encrypted there with age, a
small file-encryption tool (ADR 0024). It only reads from the VM: a
`pg_dump`, and an Incus export of each workspace's home and recovery
volume, each taken from a short-lived snapshot. It is safe on the live
pilot.

- **When.** Nightly at 02:30 host time, by the host timer
  `portikus-backup.timer`. Install or update it with
  `make backup-install-timer` (rerun after `backup.sh` changes). The timer
  does not catch up: a host that was off at 02:30 skips that night, so a
  backup never starts during class. `make backup` runs one by hand.
- **Where.** `/var/backups/portikus/<hostname>/<timestamp>`, mode 0700,
  for example `/var/backups/portikus/portikus/20260924T023000Z`. Each set
  holds the database dump, one file per volume, a per-file index, the
  users file, and a `MANIFEST`, all encrypted. The 14 newest complete sets
  per VM are kept. The directory is outside the libvirt pool, so
  `make destroy-pilot` never touches it.
- **A failed set.** If a volume's export fails, the others are still saved,
  the set gets a `FAILED` file, and the run exits non-zero. Check
  `systemctl status portikus-backup.service` on the host.
- **The key.** `make backup-setup` (run by `make backup`) makes the age key
  pair once: the public half at `~/.config/portikus/backup-recipients.txt`
  and the private half at `~/.config/portikus/backup-age-key.txt`. Backing
  up needs only the public half. **Keep the private key in your password
  manager and remove it from the host.** Without it no backup can be read,
  and on the host it would open every backup to anyone who takes the host.
  A restore reads it from wherever `PORTIKUS_BACKUP_IDENTITY` points.
- **Off-host copy, weekly.** The sets sit on the same physical disk as the
  VM, so they protect against losing the VM or a mistake, not against
  losing the disk. Once a week, copy `/var/backups/portikus` to external
  storage. Automating this is a later task.

What is not backed up: Docker volumes and container root filesystems.
Reset Docker and Rebuild recreate them, and SPEC.md section 17.3 says
packages a student installs are not kept.

## Restore

Start every restore drill by proving the key still opens the newest set.
This touches no VM:

```
PORTIKUS_BACKUP_IDENTITY=<path to the private key> \
  bash infra/host/restore.sh --check /var/backups/portikus/portikus/<timestamp>
```

**Onto the rehearsal VM** (a drill, or the cutover rehearsal):

```
make rehearsal-up
make configure-vm TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=<as the pilot>
make restore TOFU_ENV=rehearsal-libvirt BACKUP=/var/backups/portikus/portikus/<timestamp> START_CHECK=1
```

`make restore` refuses the pilot's environment and any VM whose hostname
is not the one in the state. It refuses a target that already has any
workspace volume, user, workspace or project, so it can never overwrite a
live VM. It loads the database, imports each volume under its original
name, and leaves every restored workspace stopped. `START_CHECK=1` then
starts one workspace, checks its files and Git commits from inside it, and
stops it. When the exercise is over, run
`make restore TOFU_ENV=rehearsal-libvirt BACKUP=<same set> REMOVE=1` and
then `make rehearsal-destroy`.

**Onto an empty VM, for a real disaster recovery.** If the pilot is lost:

1. Rebuild it from code (`make infra-apply`, `make configure-vm` with the
   usual settings and the users file, and `make build-workspace-image`).
   It comes up with an empty database and no workspace volumes.
2. Check the set with `restore.sh --check` as above.
3. Run `restore.sh` directly, since `make restore` refuses the pilot:

   ```
   PORTIKUS_BACKUP_IDENTITY=<key> bash infra/host/restore.sh --start-check \
     --target-name portikus 10.100.0.120 /var/backups/portikus/portikus/<timestamp>
   ```

4. Run `make smoke-test` and `make security-test`, and sign in as an
   administrator to check that the workspaces are listed.
5. Tell the students their workspaces are back. They start them as usual.

The rebuilt pilot keeps the same public host name and port, so the
database's recorded Dex issuer still matches.

## The rehearsal VM

`TOFU_ENV=rehearsal-libvirt` selects the rehearsal VM: `portikus-rehearsal`,
on its own network `10.101.0.0/24`, with its own disk pool and its own
OpenTofu state under `~/.local/state/portikus/rehearsal-libvirt/`. It
shares nothing with the pilot.

- `make rehearsal-up` creates or updates it and waits for it. It refuses
  when the host has less free memory than the VM needs.
  `REHEARSAL_VCPUS`, `REHEARSAL_MEMORY_MB` and `REHEARSAL_DATA_DISK_GB`
  size it (12 vCPUs and 24 GiB by default, for the load test).
- Pass `TOFU_ENV=rehearsal-libvirt` to every target aimed at it.
- Configure it with the pilot's `PORTIKUS_PUBLIC_HOST` and port, so a
  restored database's issuer matches. The VM resolves that name to itself.
- **It is never published.** `make publish-vm` refuses it, because port
  8443 belongs to the pilot.
- **Destroy it after every exercise** with `make rehearsal-destroy`,
  because it holds restored student data.

## Capacity and resizing

docs/CAPACITY.md has the load test results, the cost of each workspace,
the size the pilot needs, how memory pressure is handled, and the steps
for resizing the pilot. In short: for 25 active workspaces and 100
provisioned ones, the pilot needs 8 vCPUs, 16 GiB of memory and a 200 GiB
data disk. Resizing is done in a window you choose, after a backup.

### Host hardware for a class of about 24

The 16 GiB figure is a floor, not a comfortable size. It was worked out
from a load test that used a 150 MB stand-in for the coding agent, and a
real agent, a dev server and a Docker container can double a workspace's
memory (docs/CAPACITY.md, "The size the pilot needs"). Give the pilot VM
24 to 32 GiB of memory and 12 or more vCPUs, so a whole class can build
at once without waiting on each other.

The host needs room for that VM, its own operating system, the nightly
backups, and the rehearsal VM (24 GiB by default) so that a restore drill
or load test does not mean stopping the class.

| | Minimum | Recommended |
|---|---|---|
| CPU | 8 cores, 16 threads | 12 to 16 cores |
| Memory | 32 GB | 64 GB |
| Disk | 1 TB NVMe SSD | 2 TB NVMe SSD |
| Network | Wired gigabit | Wired gigabit |

- **Memory.** 32 GB runs the pilot but not the rehearsal VM beside it.
  64 GB runs both, and leaves room for language servers if the editor
  work in docs/BACKLOG.md ("Course profiles and a language-aware
  editor") goes ahead; those add roughly 100 to 500 MB per active
  student.
- **Disk.** The VM takes a 20 GiB system disk and a 200 GiB data disk.
  The host also keeps the 14 newest backup sets under
  `/var/backups/portikus/`, which grow with student files and Docker
  images. NVMe matters because many students running `npm install` or
  Docker builds at once are limited mostly by disk speed.
- **Virtualisation.** Hardware virtualisation (KVM) must be on in the
  BIOS or UEFI (infra/README.md).
- **Off-host backups.** An external drive or network storage for the
  off-host copy of the backups, which is still a manual step (see
  "Backups" above).

A desktop or small tower workstation is enough; server hardware is not
needed at this size. Before a class starts, confirm the size you chose by
running the load test on the rehearsal VM at that size:
`make rehearsal-up REHEARSAL_VCPUS=<n> REHEARSAL_MEMORY_MB=<MiB>`, then
`make load-test TOFU_ENV=rehearsal-libvirt N=25`.

To rent a host instead of buying one, docs/HOSTING.md compares providers
and prices for this size, dated 2026-09-23.

**Never run `make infra-apply` for the pilot from a checkout older than
the one that grew the data disk.** An older checkout replaces a data disk
whose size changed, so it would plan to swap the grown disk for an empty
100 GiB one. Always read the plan before typing `yes`.

## Security test and load test

- **`make security-test`** runs the VM security suite through the real
  edge. It makes its own users and two workspaces, touches nothing else,
  checks every other workspace and setting is unchanged, and cleans up.
  It is allowed on the live pilot at any quiet time, and should run after
  every deploy. `SWEEP=1` removes the leftovers of a run that was killed.
  `PORTIKUS_SECURITY_HEAVY=1` adds tests that push a workspace past its
  memory limit; run those only on a VM with no other workspace, which in
  practice means the rehearsal VM.
- **`make load-test TOFU_ENV=rehearsal-libvirt N=25`** runs the load test
  (`infra/tests/load-test.sh`). **Never on the pilot.** The script refuses
  the pilot, a VM Ansible or a restore is using, and a VM without memory
  or disk room for N workspaces. It removes only the users and workspaces
  it made. Destroy the rehearsal VM afterwards if it held restored data.

## Logs

The platform never logs secrets, prompts, source code or terminal bytes
(ADR 0012). On the VM (`ssh deploy@10.100.0.120`):

| Unit | What it is |
|---|---|
| `portikus-api` | The API: requests, sign-in, audit write errors |
| `portikus-worker` | Starts, stops, creates, recovery points, health samples |
| `portikus-controller` | The only process that talks to Incus |
| `portikus-dex` | Dex sign-in |
| `caddy` | The edge and preview gateway |
| `postgresql` | The database |
| `incus` | Containers and storage |

```
sudo journalctl -u portikus-api -u portikus-worker -u portikus-controller -o cat --since -1h
```

The journal is capped at 2 GB. On the host, the nightly backup logs to
`journalctl -u portikus-backup.service`.

## Routine checks

**Daily, during the pilot:**

- The admin page's Health tab shows no "Worker not reporting", and the
  storage pool and memory are under 80 percent.
- Last night's backup finished:
  `systemctl status portikus-backup.service` on the host, and the newest
  set under `/var/backups/portikus/portikus/` has no `FAILED` file.

**Weekly:**

- Copy `/var/backups/portikus` to external storage.
- Run `restore.sh --check` on the newest set to prove the key still works.
- Look for workspaces in `error` on the admin page.
- Run `make security-test` on the pilot.

**Monthly** (SPEC.md section 24.12):

- Check for new Dex releases. An upgrade is a pull request that bumps
  `dex_version` and `dex_commit` in `infra/ansible/site.yml` together,
  after reading the release notes. CI's Dex sign-in job tests it, then
  the rehearsal VM runs `configure-vm` and the smoke test before the
  pilot does. To roll back, revert the pin.
- Check that unattended upgrades are applying Debian security updates on
  the VM (`sudo journalctl -u unattended-upgrades`), which the `base` role
  sets up.
- Delete `pre-...` snapshots that are no longer needed.

## Rebuild from code (B5)

**The one-command exercise.** `make rebuild-exercise` runs the whole
STACK.md section 33 exercise on the rehearsal VM and destroys the VM at
the end, even when a step fails:

```
make rebuild-exercise BACKUP=/var/backups/portikus/portikus/<timestamp> \
  PREVIOUS_VERSION=<release to roll back to> \
  PORTIKUS_USERS_FILE=<rehearsal users file> \
  PORTIKUS_SMOKE_SIGNIN_FILE=<file with a test user's email and password>
```

Run it from a shell in the `libvirt` group, like `make rehearsal-up`.
It does these steps in order:

1. It builds the package from the checkout.
2. It rebuilds the VM from code, and builds the workspace image.
3. It restores the set.
4. It carries mock accounts over to Dex, if the set holds any.
5. It runs the smoke test with the restored-data checks.
6. It rolls back to the previous package, then checks `/health` and a
   Dex sign-in.

It prints a timing table at the end, and keeps a log of each step under
`/tmp/portikus-rebuild-exercise.*`.

`PREVIOUS_DEB=<file>` rolls back to a local package instead of a release.
The previous package must support Dex. At the time of writing, no
published release does, so the run below used a local build of the
previous epic head.

The run on 2026-09-23 restored the pilot's set `20260923T045452Z` and
rolled back to `0.1.366+g1acca31`. Every step passed:

| Step | Time |
|---|---|
| Build the package, reinstall dev dependencies | 10 s |
| Destroy the old VM | 1 s |
| Create the VM (OpenTofu, cloud-init) | 52 s |
| Converge with Ansible | 4 min 40 s |
| Build the workspace image | 2 min 53 s |
| Restore the set, start one workspace | 56 s |
| Carry 3 mock accounts over to Dex | 57 s |
| Smoke test (231 passed, lifecycle block included) | 6 min 21 s |
| Roll back, check `/health` and a Dex sign-in | 56 s |
| Destroy the VM | 2 s |
| **Total** | **17 min 48 s** |

**The step-by-step runs.** Earlier the same day, the rehearsal VM was rebuilt twice from the repository,
from nothing to a working platform, with package `0.1.367+gc543a49` (the
Epic 12b head after PR #468). The pilot's newest backup was then restored
into the second rebuild. Every step was a Make target. No step was done
by hand on the VM.

**First rebuild, ending with the smoke test:**

| Step | Command | Time |
|---|---|---|
| Destroy the old VM | `make rehearsal-destroy` | 3 s |
| Create the VM (OpenTofu, cloud-init) | `make rehearsal-up` | 47 s |
| Converge it (Ansible, Dex built from source) | `make configure-vm TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=dex PORTIKUS_DEB=<package> PORTIKUS_USERS_FILE=<file>` | 5 min 12 s |
| Build the workspace image | `make build-workspace-image TOFU_ENV=rehearsal-libvirt` | 2 min 32 s |
| Smoke test, with a full Dex sign-in | `make smoke-test TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=dex PORTIKUS_SMOKE_SIGNIN_FILE=<file>` | 6 min 10 s |
| **From an empty host to a green smoke test** | | **14 min 41 s** |

The smoke test passed all 209 checks. That includes the lifecycle block:
sudo, nested Docker, `claude --version` and `codex --version`, reaching an
application port in a workspace, the preview edge, Reset Docker and
Rebuild, and a full Dex password sign-in. Building the package beforehand
(`make build-deb`) took 12 s.

**Second rebuild, then the restore drill:**

| Step | Command | Time |
|---|---|---|
| Destroy, create, converge, build the image | as above | 8 min 48 s |
| Prove the key opens the set | `restore.sh --check <set>` | 1 s |
| Restore the pilot's newest set | `make restore TOFU_ENV=rehearsal-libvirt BACKUP=<set> START_CHECK=1` | 55 s |
| Show the account pairings | `make identity-carry-over-dry-run TOFU_ENV=rehearsal-libvirt PORTIKUS_USERS_FILE=<file>` | under 1 min |
| Carry the accounts over to Dex | `make configure-vm` as above | 48 s |
| **From an empty host to restored students signing in** | | **about 10 min 30 s** |

The set was `/var/backups/portikus/20260923T045452Z`, the pilot's newest
complete set. It holds 3 users, 3 workspaces and 6 projects, from package
`0.1.348+g001e10e`. It predates the per-VM directories, so it sits
directly under `/var/backups/portikus/`, not under `portikus/`. Inside
the 55 seconds, the restore:

- checked every file against the MANIFEST (under 1 s);
- loaded the database, marked every workspace stopped, and ended every
  session (2 s);
- imported the three home volumes (9 s);
- recreated the three instances (18 s);
- started the services (4 s);
- matched the row counts, and matched 43 sampled files against the
  backup's checksums (9 s);
- started carol's workspace, and checked that her home belongs to the
  student and that the sampled files and 3 Git commits match (13 s).

What was checked afterwards:

- Each of the three users has their workspace row, instance and home,
  recovery and Docker volumes.
- The `sessions` and `preview_sessions` tables were empty.
- alice's and bob's workspaces also started, in 7 s and 4 s, each with
  the home owned by the student.
- The restored rows came from the mock provider. The carry-over moved
  carol, alice and bob to their Dex identities by email, and wrote one
  `user.identity_changed` audit row each. alice then signed in through
  Dex with her password, and got her original user row and her original
  workspace (same id and label). She could start and stop it through the
  API, and bob's workspace answered 404 to her.

**A restore needs one extra step while old backups hold mock accounts.**
A backup taken before the Dex cutover holds users under the mock issuer.
After restoring one onto a VM that signs in through Dex, run
`make identity-carry-over-dry-run`, read it, then `make configure-vm`
again, so the carry-over links the accounts. Without it, a student who
signs in gets a new, empty account. Backups taken after the cutover
already hold Dex identities and need no carry-over.

**Removing an account ends its sessions (checked on a real VM).** With
`a5smoke` signed in and its cookie held, the account was removed from a
copy of the users file (`make users-remove`), and `make users-deploy
TOFU_ENV=rehearsal-libvirt` deployed the copy in 12 s. The held cookie
then got 401 from `/auth/me`, a new sign-in with the old password was
refused, and an `auth.sessions_revoked` audit row recorded
`{"reason": "users-deploy", "usernames": ["a5smoke"], "count": 1}`.
alice's session stayed valid. The original users file was then deployed
again (12 s), and the rehearsal VM was destroyed.

**Load test on the rebuilt VM.** `make load-test TOFU_ENV=rehearsal-libvirt
N=25` ran on the first rebuild. It took 19 min 20 s in all. Start p95 was
12.6 s, down from 77 s before the worker started workspaces in parallel,
still over the 10 s target. Every other criterion passed, with no failed
operation (`docs/CAPACITY.md`, "Rerun after parallel starts").

The smoke test's lifecycle block normally skips itself while other
people's workspaces exist. `make rebuild-exercise` sets
`PORTIKUS_SMOKE_RESTORED_SET`, which lets the block run beside the
restored workspaces, and only on a VM that is not named `portikus`.
