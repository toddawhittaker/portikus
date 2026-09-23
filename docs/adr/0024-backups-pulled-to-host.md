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
and writes it to `/var/backups/portikus/<VM name>/<UTC timestamp>/`.
Each VM has its own directory, so backups of the rehearsal VM
(`portikus-rehearsal`) never push the pilot's (`portikus`) out of
retention. The name comes from the OpenTofu state, never from the VM:
`make backup` and the timer pass it as `--vm-name`, and `backup.sh` stops
before writing anything unless the VM's own hostname matches it. A rooted
rehearsal VM that renamed itself `portikus` therefore cannot write into,
or prune, the pilot's sets. That directory is outside the libvirt pool, so `make
destroy-pilot` never touches it. A set is written under
`.partial-<timestamp>` and renamed into place only once it is written; a
run that fails before then leaves nothing.

Sets made before the per-VM directories sit directly under
`/var/backups/portikus/`. They stay readable (`restore.sh` takes any set
directory), but retention no longer looks at them. To bring one under
retention, move it into the directory of the VM it came from (the
MANIFEST's `vm` line gives that VM's address); otherwise delete it by hand
once newer sets exist. No script moves them, because the host holds only
the public key and cannot read a MANIFEST to tell whose set it is.

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
and the VM's hostname against a strict pattern before it reaches a file
name or the MANIFEST. `restore.sh` checks every MANIFEST line against the
exact forms `backup.sh` writes, and every path in a file index (relative,
no `..` part, Git HEADs of 40 hex digits) before any of it reaches a
command, and quotes every value it sends to a remote shell. A file name
with a control character, such as a tab or a newline, is legal in a
student's home, so it does not refuse the set; it is only left out of the
files the restore checks sample. `infra/tests/backup-scope-test.sh`
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
streaming it. The Ansible role `backup` creates a custom volume,
`workspace-data/portikus-backups`, in the default project, and points
`storage.backups_volume` at it. Exports run one at a time, so the volume
only has to hold the largest one. Its size is the home quota plus the
recovery quota plus 2 GiB for tar and gzip overhead, read from
`portikus_workspace_home_size_gib` and
`portikus_workspace_recovery_size_gib` in `site.yml` (30 GiB today). The
role grows an existing smaller volume and never shrinks one. Before each
export, the VM half also grows it to that volume's size plus 2 GiB when it
is smaller, because an administrator can raise one home quota up to 1024
GiB. The volume is thin, so its size costs pool space only while an export
is staged. Until the role has run on a VM, Incus
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
- `FAILED`, only when a volume failed to export: the failed volume names
  in plain text, so retention can tell an incomplete set without the key.
  The MANIFEST names them too, on `failed` lines.

**What makes a set trustworthy.** Every listing the VM sends (workspaces,
volumes and instances) is read whole before anything is written, so a
listing that fails stops the run instead of reading as an empty one. The
run also stops when the workspace listing disagrees with the row count,
or when a workspace's Incus instance exists but the volume listing has no
`-home` volume for it. A workspace whose instance does not exist yet may
have no volumes, because the API names the instance when it adds the row,
before the worker creates it.

**One volume does not stop the rest.** When one volume's export fails,
for example because the pool runs short of space, the run records
it, carries on with the other volumes, keeps the set, and exits non-zero
at the end so the timer shows the failure. A failed database dump still
stops the run and keeps nothing.

**Schedule and retention.** A host systemd timer, `portikus-backup.timer`,
runs the backup at 02:30 host time every night. The service runs as the
operator's account, whose SSH key reaches the VM. It is not `Persistent`:
a host that was off at 02:30 must not start a backup during the next
day's class. Retention works in each VM's directory on its own. The 14
newest complete sets are kept, and so are the 14 newest incomplete sets
newer than the oldest of them; everything else is deleted at the end of a
run. Complete and incomplete sets are counted apart, so nights of failed
exports never push out the last good copy of a volume, and cannot fill the
disk either.
Nothing else in the directory is touched.
`make backup-install-timer` installs the scripts under `/usr/local/sbin`
and the units under `/etc/systemd/system`, the same way `publish-vm`
installs its unit, so the timer does not depend on a checkout.

**Restore.** `make restore TOFU_ENV=rehearsal-libvirt BACKUP=<set>`
(`infra/host/restore.sh`) refuses the pilot's OpenTofu environment, and
the script refuses any VM whose hostname is not the one in the state. It:

1. decrypts the MANIFEST and checks every file's size and SHA-256 before it
   touches the VM (`restore.sh --check <set>` does only this, and is the
   first step of a restore drill: it proves the key works);
2. refuses an incomplete set (one with `failed` lines), because restoring
   it would give those workspaces empty volumes; then checks the target:
   its hostname, a package at least as new as the backup's (migrations
   only run forward), a workspace image, no workspace volumes at all, and
   no users, workspaces or projects. A restore replaces the whole
   database, so this is what keeps it off a live VM. A freshly rebuilt
   pilot passes, because it has none of them;
3. stops `portikus-api` and `portikus-worker`; the controller stays up;
4. runs `pg_restore --create --clean --if-exists`, which drops and
   recreates the whole database, so no table a newer release added can
   survive and confuse the migrations. In one transaction it then marks
   every workspace stopped, in both its state and its desired state, so
   the restored workspaces do not all start at once, and deletes every
   sign-in session and preview session, so a cookie stolen before the
   backup does not work on the restored VM. Everyone signs in again after
   a restore;
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
   period stops it again. An exit trap removes the row however the check
   ends.

On failure the API and worker stay stopped, and the script says so.

**After a rehearsal.** A restore onto the rehearsal VM leaves real student
data there. `make restore ... REMOVE=1` (`restore.sh --remove`) deletes
exactly the set's instances, their home, recovery and Docker volumes, and
every volume named on the MANIFEST's `volume` lines, and replaces the
database with an empty one; it refuses a VM named
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
- A restore target must hold no workspace volumes and no users,
  workspaces or projects, so a restore can never overwrite a live VM.
  `make restore` also refuses the pilot's OpenTofu environment. A real
  disaster recovery restores onto a rebuilt pilot by running `restore.sh`
  with `--target-name portikus` directly, which the empty-target check
  allows. The rehearsal VM must be emptied (`REMOVE=1`, or a rebuild)
  before a restore drill on it.
- A volume that keeps failing to export makes every nightly set
  incomplete. The 14 newest are kept beside the last complete set, so a
  failure that lasts more than two weeks loses the older incomplete sets;
  the failed timer is what should make someone act first.
- Setting `volatile.idmap.last` by hand relies on Incus shifting a volume
  whose recorded map differs from the instance's. The rehearsal restore
  proved it with Incus 7.4; an Incus upgrade that changes this would show
  up as files owned by `nobody` in the start check.
