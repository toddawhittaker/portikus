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

Take an Incus snapshot of each workspace's home and recovery volume, and
a `pg_dump` (a PostgreSQL export) of the platform database to the host.
Name the snapshots after the change, for example `pre-epic12b`.

```
ssh deploy@10.100.0.120 'for v in $(sudo incus storage volume list workspace-data --project portikus -f csv -c n | grep -E "^ws-.*-(home|recovery)$"); do sudo incus storage volume snapshot create workspace-data "$v" pre-CHANGE --project portikus; done'
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

- `users-add` asks for the email, display name and role (`student` or
  `administrator`), then the password twice without showing it. Passwords
  need at least 12 characters. The first user must be an administrator.
- Generate each password in the password manager (16 characters or more)
  and hand it over in person or by a private message in the learning
  system. Never by plain email.
- Students cannot change their own password. To reset one, run
  `make users-add` for that user again, then `make users-deploy`.
- `users-remove` and `users-add` only change the file. Nothing reaches the
  VM until `make users-deploy` (or `make configure-vm`).
- `users-deploy` ends the Portikus sessions and preview sessions of every
  user who was removed, whose password changed, or who went from
  administrator to student. It writes one `auth.sessions_revoked` audit
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
2. Take `pre-epic12b` snapshots of each `-home` and `-recovery` volume and
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

- `/auth/login` and `/auth/callback`: 60 a minute per address.
- Dex password posts: 30 per 10 minutes per address, and 300 per 10
  minutes for everyone together. Caddy asks the API before each post
  reaches Dex. Attempts one address has already had refused do not count
  toward the shared 300, so one address cannot lock out the class.

A refusal answers 429 with `RATE_LIMITED` and writes one `auth.throttled`
audit event per address per window. The counts live in the API's memory,
so restarting `portikus-api` clears them.

If many students share one address behind a campus network, raise the
limits through `SIGNIN_START_LIMIT_PER_MINUTE` and
`PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES` in the API's environment file,
`/etc/portikus/api.env`.

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

TODO: task B5, the rebuild-from-code exercise, has not run yet. This
section will record the steps and how long each took, from an empty
rehearsal VM to a restored, working pilot copy.

| Step | Time |
|---|---|
| TODO | TODO |
