# 0024. Backups are pulled to the host and encrypted there with age

- **Status**: Accepted
- **Date**: 2026-09-23
- **References**: SPEC.md sections 17.3, 19, 24.9, 29 (Epic 12); STACK.md
  sections 20, 27 and 33; docs/EPIC-12B.md ("Part B decisions", task B3);
  ADR 0005, ADR 0020, ADR 0021

## Context

The pilot keeps everything that matters on one VM: the PostgreSQL database,
and each workspace's home and recovery volumes on the LVM thin pool. Losing
the VM, its data disk, or a careless command would lose every student's
work. Epic 12 needs a nightly backup and a restore that has actually been
tested.

Constraints:

- The pilot is live. A backup may only read from it: no stop, no restart,
  no change to a workspace.
- The VM's OS disk is 20 GiB, so a backup must not stage large files there.
- Nothing outside the storage adapter may depend on LVM (STACK.md section
  20), so the backup has to go through Incus, not through `lvcreate`.
- Backups hold student work, so they are encrypted at rest.
- The VM's workspace files are stored shifted to each instance's own ID
  map (the pilot's home volumes hold files owned by host IDs such as
  1262144 + 1000, not 1000).

## Decision

**What is backed up.** The database (`pg_dump -Fc`), and every workspace's
`-home` and `-recovery` volume, including archived workspaces. Docker
volumes and root filesystems are not: Reset Docker and Rebuild recreate
them, and SPEC.md section 17.3 already says user-installed system packages
are not kept. The Dex users file on the host
(`~/.config/portikus/users.json`) is copied into each set when it exists.

**Where it goes.** The host pulls everything over SSH as the `deploy` user
and writes it to `/var/backups/portikus/<UTC timestamp>/`. That directory
is outside the libvirt pool, so `make destroy-pilot` never touches it. A
set is written under `.partial-<timestamp>` and renamed into place only
when complete; a failed run leaves nothing.

**Who can read a set.** The sets hold every student's files, including
coding-agent logins (`~/.claude`, `~/.codex`) and `.env` files. The
directory is mode 0700 and every file 0600 (the script runs with umask
077), owned by the operator's account, which runs the backup. Only that
account and root can read them, and without the private age key their
contents are unreadable to both. The threat-model review asked for root
ownership; the operator's account was kept because it already holds the
SSH key the VM trusts, and the VM's `deploy` user has passwordless sudo,
so that account can read every student's files on the VM anyway. Running
the backup as root would mean giving root a second key to the VM.

**The VM is not trusted.** The host treats everything the VM sends as
hostile: a compromised VM must not be able to make the host write outside
the set or run a command. `backup.sh` checks every volume name, workspace
line, row count, package version and ID map against a strict pattern
before it reaches a file name or the MANIFEST. `restore.sh` checks every
MANIFEST line against the exact forms `backup.sh` writes, and every path
in a file index (relative, no `..` part, no control characters, Git
HEADs of 40 hex digits) before any of it reaches a command, and quotes
every value it sends to a remote shell. `infra/tests/backup-scope-test.sh`
feeds both scripts a lying VM and doctored sets and checks that they
refuse them.

**How volumes are read.** For each volume, the VM half
(`infra/host/portikus-backup-export`):

1. takes a snapshot named `portikus-backup`, which fixes one moment of a
   volume that a running workspace may be writing;
2. makes a thin copy of that snapshot, `backup-<volume>`, because Incus
   exports volumes, not snapshots;
3. streams `incus storage volume export --volume-only` of the copy to
   standard output;
4. deletes the copy and the snapshot, by those exact names, even when the
   export fails.

It never deletes anything else, and it refuses any name that is not
`ws-<24 hex>-home` or `ws-<24 hex>-recovery`. The `pre-epic10-11` and
`pre-epic12b` snapshots are never touched.

**The export command is sent, not installed.** `backup.sh` sends the VM
half, base64-encoded, with every SSH command. The VM needs nothing
installed for a backup, and the two halves cannot drift apart. This
differs from the brief, which had the Ansible role install the command; the
live pilot could then be backed up without applying a role to it first.

**Staging off the OS disk.** Incus stages every export as a file before
streaming it. The Ansible role `backup` creates a 20 GiB custom volume,
`workspace-data/portikus-backups`, in the default project, and points
`storage.backups_volume` at it. Until the role has run on a VM, Incus
stages on the OS disk under `/var/lib/incus/backups`; the pilot's first
backup (172 MB in all) fitted there easily, but a full class would not.

**Encryption.** Each stream is encrypted on the host with `age -R
<recipients file>`. `make backup` makes the key pair on first use:
`~/.config/portikus/backup-recipients.txt` (the public half, which is all
a backup needs) and `~/.config/portikus/backup-age-key.txt` (the private
half, mode 0600, needed only to restore). Neither is under
`/var/backups` or in a repository checkout. The private half belongs
offline: Todd stores it in his password manager and then deletes it from
the host, and a restore reads it from wherever `PORTIKUS_BACKUP_IDENTITY`
points. `make backup` makes a new pair only when both halves are missing,
so deleting the private half never produces a second, unrelated key. Until
Todd moves it, the private half sits in his home directory on the same
host as the backups; that is an accepted risk for as long as it takes him
to do so, because an attacker who can read it can also read the operator
account's SSH key to the VM. The repository's SOPS configuration
(`infra/secrets/.sops.yaml`) has no key yet, so this is a separate key
used only for backups. Nothing in a set is readable without the private
key, including the MANIFEST and the file lists.

**What a set holds.**

- `MANIFEST.age`: the package version, the row counts of users, workspaces
  and projects, every workspace id with its instance name, and for each
  file and volume its size, SHA-256 and the ID map it was shifted to.
- `db.dump.age`: the `pg_dump`.
- `<volume>.age`: the Incus export of each volume.
- `<volume>.index.age`: one line per regular file (path, size, SHA-256),
  and the HEAD commit of every Git repository found, taken from the export
  stream as it passes, so the VM is read only once.
- `users.json.age`, when the users file exists.

**Schedule and retention.** A host systemd timer, `portikus-backup.timer`,
runs the backup at 02:30 host time every night. The service runs as the
operator's account, whose SSH key reaches the VM. It is not `Persistent`:
a host that was off at 02:30 must not start a backup during the next
day's class. The 14 newest complete sets are kept; older sets are deleted
after a successful run, and nothing else in the directory is touched.
`make backup-install-timer` installs the scripts under `/usr/local/sbin`
and the units under `/etc/systemd/system`, the same way `publish-vm`
installs its unit, so the timer does not depend on a checkout.

**Restore.** `make restore TOFU_ENV=rehearsal-libvirt BACKUP=<set>`
(`infra/host/restore.sh`) refuses the pilot's OpenTofu environment, and
the script refuses any VM whose hostname is not the one in the state. It:

1. decrypts the MANIFEST and checks every file's size and SHA-256 before it
   touches the VM (`restore.sh --check <set>` does only this, and is the
   first step of a restore drill: it proves the key works);
2. checks the target: its hostname, a package at least as new as the
   backup's (migrations only run forward), a workspace image, and none of
   the set's volumes already there;
3. stops `portikus-api` and `portikus-worker`; the controller stays up;
4. runs `pg_restore --create --clean --if-exists`, which drops and
   recreates the whole database, so no table a newer release added can
   survive and confuse the migrations;
5. imports each volume under its original name and sets its
   `volatile.idmap.last` to the ID map recorded at backup time, so Incus
   shifts the files to the new instance's map at first start;
6. recreates each missing workspace instance through the controller's own
   `POST /instances`. The controller's create already adopts volumes that
   exist and makes only the missing ones (a fresh Docker volume, and a
   recovery volume where the backup had none), so no controller change was
   needed;
7. starts the services and waits for `/health`;
8. compares the row counts with the MANIFEST, and pulls a sample of 20
   files per volume with `incus storage volume file pull` and compares
   their SHA-256 with the index;
9. with `START_CHECK=1`, starts the restored workspace with the most Git
   repositories (by adding a presence row, as a browser socket would),
   checks from inside it that `/home/student` belongs to the student, that
   the sampled files match, and that every repository's `git rev-parse
   HEAD` matches the backup, then removes the presence row so the grace
   period stops it again.

On failure the API and worker stay stopped, and the script says so.

**After a rehearsal.** A restore onto the rehearsal VM leaves real student
data there. `make restore ... REMOVE=1` (`restore.sh --remove`) deletes
exactly the set's instances and their home, recovery and Docker volumes,
and replaces the database with an empty one; it refuses a VM named
`portikus`. The rehearsal VM is also destroyed when an exercise ends
(docs/EPIC-12B.md, Part 3).

## Consequences

- A lost or broken VM costs at most one day of work, as long as the host
  and its disk survive. The backups sit on the same physical disk as the
  VM, so they do not protect against losing that disk. That is an accepted
  pilot gap: Todd copies `/var/backups/portikus` to external storage weekly
  by hand, and off-site copies are later work (docs/EPIC-12B.md, risk 10).
- Losing the private age key makes every set unreadable. Todd keeps it in
  his password manager (risk 11), and the restore drill starts with
  `restore.sh --check`, which proves the key still opens the newest set.
- A backup of a running workspace is crash-consistent: it is what the disk
  held at the snapshot, like pulling the power. Files mid-write may be
  partial; Git repositories survive this well.
- The backup run itself takes a snapshot and a thin copy, which cost thin
  pool space only for blocks that change during the run.
- A restore target must not already hold the set's workspaces. Restoring
  onto the live pilot is not what `make restore` is for: a real disaster
  recovery restores onto a rebuilt pilot by running `restore.sh` with
  `--target-name portikus` directly.
- Setting `volatile.idmap.last` by hand relies on Incus shifting a volume
  whose recorded map differs from the instance's. The rehearsal restore
  proved it with Incus 7.4; an Incus upgrade that changes this would show
  up as files owned by `nobody` in the start check.
