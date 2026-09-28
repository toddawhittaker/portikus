# 0039. Backup requests reach the host through a polling channel, and the host holds the restore key

- **Status**: Accepted (Epic 24)
- **Date**: 2026-09-27
- **References**: SPEC.md sections 24.9 and 24.11; ADRs 0024, 0030, 0040; issue #730

## Context

Epic 24 adds a Backups tab to the admin page: Back up now, delete an old
set or pre-change dump, and restore one workspace into a side copy or
replace its home. Backups live on the host, not the VM (ADR 0024), and the
host must stay out of the VM's reach: a compromised VM must not be able to
write to the host, read other backups, or run a command there.

Restoring needs the private age key. ADR 0024 said the private half belongs
offline, in Todd's password manager, and a restore reads it from wherever
the operator points. A restore started from a web page cannot wait for
someone to paste a key.

## Decision

**The host polls; the VM never calls the host.** A host timer,
`portikus-backup-channel.timer`, runs `portikus-backup-channel.service`
(root, oneshot) every 30 seconds. Each run:

1. sends any result the VM has not yet taken (kept in
   `/var/lib/portikus-backup-channel/pending.json`);
2. runs `ssh deploy@<VM> sudo portikus backup-channel pull`, which prints
   at most one claimed request as one JSON line (empty for none);
3. checks it, runs it, and pipes a report to
   `ssh deploy@<VM> sudo portikus backup-channel report`: the request's
   result (`done` or `failed`, a one-line error, the new set's stamp) and
   a fresh status (the sets, the dumps, the nightly timer's next and last
   run, the last failure, what is running, and whether the key is
   installed). With no request it sends the status alone.

While a long request runs (a backup, a copy, an import), a background loop
sends a status every 30 seconds naming the request as running, so the VM
can tell a slow job from an interrupted one. The shapes are
`BackupChannelRequest` and `BackupChannelReport` in
`packages/contracts/src/backups.ts`.

**Everything that talks to the VM runs as the operator's account**
(`runuser -u <operator> -- ssh …`), so the VM trusts no new key, and new
sets stay owned by that account, as ADR 0024 set out. Back up now runs the
same `backup.sh` as the nightly timer, as that account. There is one
channel per host, for the VM the Makefile names; the rehearsal VM borrows
it for a rehearsal and the pilot gets it back afterwards.

**The VM is not trusted.** The request is read with a 4 KiB cap and parsed
strictly: one line, UTF-8, JSON with no duplicate keys, exactly the fields
`id`, `kind` and `args`, a UUID id, one of five kinds, exactly that kind's
arguments, each a string matching the contract's pattern, and a restore
folder equal to the one derived from the set's stamp. Each value is
checked again in the shell before use and quoted in every remote command.
Anything else is reported "refused by the host" and nothing runs. A delete
also refuses a symbolic link, anything outside this VM's own directory,
and the newest complete set. A restore also refuses an instance whose home
is not in the set's MANIFEST and a VM whose hostname is not the one in the
OpenTofu state, so decrypted data never goes to the wrong machine.
`infra/tests/backup-channel-test.sh` plays a lying VM and checks every
refusal.

**Deletes keep a host-side retention floor.** A compromised VM could ask
for backups until a set holding its poisoned data is the newest, then
delete every older set. So the host never deletes a set younger than
`PORTIKUS_BACKUP_MIN_AGE_DAYS` (default 14) and always keeps the newest
`PORTIKUS_BACKUP_KEEP_COMPLETE` (default 3) complete sets. Both come from
the channel unit's environment, never from a request; a refused delete
reads "refused by the host: retention floor (...)". The same floor holds
in `backup.sh`'s own retention step, with the values set in both the
nightly unit and the channel unit, so repeated requested backups cannot
prune those sets either. The host also refuses a requested backup within
`PORTIKUS_BACKUP_MIN_GAP_MINUTES` (default 60) of the end of the last one,
read from the channel's `last-run` file, with "refused by the host: a
backup ran N minutes ago". The nightly timer is not limited.

Because the floor keeps every young set, requested sets are capped so a
compromised VM cannot fill the host's disk. The channel writes a
`REQUESTED` file into each set it made on request (never anything from the
VM), and refuses a request while `PORTIKUS_BACKUP_MAX_REQUESTED` (default
3) such sets are younger than the minimum age. The minimum age defaults to
14 days, matching `PORTIKUS_BACKUP_KEEP`, so the floor never keeps fewer
nights than rotation used to. Every run, nightly or requested, also needs
free space in the backup directory of at least the newest complete set's
size plus a fifth, and at least `PORTIKUS_BACKUP_MIN_FREE_MB` (default
1024); otherwise it fails with "refused by the host: not enough free space"
before contacting the VM for data. Free space is measured after leftover
partial sets from a killed run are removed. The run then has a byte
budget: the free space less `PORTIKUS_BACKUP_MIN_FREE_MB`. Every stream
from the VM counts against it (before encryption, which adds well under
one percent), and a stream that passes it stops the whole run, not just
that volume, and keeps nothing. The run also skips any volume that is not
the home or recovery volume of an instance the VM listed: nothing is
fetched or written for it, so made-up volume names cannot pad a run, and
an orphaned volume left by a deleted workspace does not fail every
nightly backup. The run logs a warning with the count and at most three
names, and the set records the count in a plain `SKIPPED` file (and a
`skipped` MANIFEST line), which the Backups tab shows.

Every host-side write in a run is bounded, not only the streams. The
per-file index counts against the same budget, twice, because it exists
in plain and encrypted form at once; an export that fails still spends
the index it wrote, and its files are deleted at once. Any tar member name
or link target longer than 4096 bytes (plus the tar's own prefix), or more
than `PORTIKUS_BACKUP_MAX_INDEX_ENTRIES` (default 1,000,000) members of any
kind in one volume, fails only that volume: it is recorded in FAILED like
any failed export, the other volumes are kept, and the run's last FAIL
line, which the status report shows, names the volume and the reason.
Only the run-wide byte budget stops the whole run, so one student's
volume cannot stop everyone's backups. The indexer clears tarfile's member
list as it reads, keeps only the first 100 bytes of Git HEAD and ref
files, and keeps at most 100,000 Git entries or 64 MB in total, past
which it silently stops recording them, since they only verify a restore; and both units set `MemoryMax=1G`. SSH
to the VM uses a 30-second keepalive, so a hung connection ends the run.
Restore and the side copy accept the `skipped` MANIFEST line. Each file the run
writes also counts a fixed 8 KiB. Scratch files live in a
`.partial-scratch-*` directory beside the set, inside the budget, and
never in `/tmp`; the units also set `PrivateTmp=yes` and a 12-hour
`TimeoutStartSec`. Every answer from the VM is read with a byte cap and a
line cap: at most 2000 workspaces and 2000 instances (the contract's
limit), 8000 volumes, and an ID map of at most 4096 characters. A longer
answer stops the run. One host-wide lock covers the budget measurement
and the whole run, so backups of two VMs never spend the same free
space; a run waits up to an hour for it, then gives up.

**The private key is installed on the host, root-only,** as
`/etc/portikus-backup/age-key.txt` (file 0600, directory 0700, owner
root), by `make backup-install-key KEY=<path>`, which first checks that the
key matches the recipients file backups are encrypted to. Only the
channel's restore steps (`restore-copy.sh`) read it, as root; they refuse
a key file that is not in that root-only form. The operator's account
never gets it: no `LoadCredential`, no copy in its home. The status says
whether the key is installed, so the page can say why a restore cannot
start.

**A side copy runs as the student.** The host decrypts the home volume as
root and streams it over SSH to
`incus exec --user 1000 --group 1000 … -- tar -xz --strip-components=2
-C /home/student/<folder> backup/volume`, so the files are written by the
student's own account, bound by the student's permissions and quota.
Before that, and also as the student, it checks that the folder does not
exist and that the home's free space, less 5%, holds the sum of the file
sizes in the set's index. A copy that fails part way removes the folder it
made. An import for a replace goes to `<instance>-home-import` only, never
over the live home, with the backup's ID map, as `restore.sh` does
(ADR 0040 covers the swap).

## Consequences

- **Whoever takes the host can read every backup.** This supersedes ADR
  0024's "the private half belongs offline". Todd accepted it so that
  restores can start from the admin page; his password-manager copy stays
  the recovery copy. Root on the host could already read the VM's disk
  image, so the new exposure is the older sets, not the live data.
- The decrypted stream passes through the operator's SSH process, which
  that account could in principle read. It already has passwordless sudo
  on the VM and can read every student's live files, so this adds nothing.
- The VM can make the host decrypt a set only into a workspace the set
  holds, as that workspace's student, in a new folder. A rooted VM could
  keep that stream, but it already held those files when the set was made.
- A request waits up to 30 seconds before the host sees it. A request the
  host never finishes (the host rebooted mid-run) stays claimed until the
  VM marks it interrupted, 15 minutes after the host last said it was
  running.
- A report larger than 256 KiB drops its oldest sets until it fits.
- The rehearsal and the pilot share one channel unit, so a rehearsal of
  the channel points it away from the pilot until `make
  backup-install-timer` is run again.
