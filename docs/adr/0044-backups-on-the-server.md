# 0044. An apt-installed server backs itself up, keeps its key, and hands the key over through a root socket

- **Status**: Accepted (Epic 15, task T7)
- **Date**: 2026-09-28
- **References**: SPEC.md sections 20.1, 24.9 and 24.11; STACK.md sections
  13 and 15; SPEC.md section 29 (Epic 15); ADRs 0012, 0024, 0030, 0039 and 0040

## Context

Backups were built for a Portikus VM on a separate host (ADRs 0024 and
0039). The host pulls sets over SSH as the operator, and a host timer runs
the Backups tab's requests. A server installed with `apt install
portikus` has no outer host, so it took no nightly backup, and a request
from the tab waited forever.

Todd's rulings for this task:

1. On an apt-installed server the nightly backup and the backup channel
   run on the server itself, from timers setup installs. No SSH to itself
   and no `deploy` account. The VM-plus-host path keeps working for the
   development VM and the pilot.
2. The age private key stays on the server, and one-click restore stays.
   Whoever owns the server can already read the live workspaces; the
   encryption exists so the sets can be copied elsewhere, off the server,
   safely. Setup makes the key when there is none.
3. The Backups tab gets **Download backup key**: administrator-only,
   behind a dialog that says what the key unlocks and to store it off the
   server, audited on every download, never logged, sent `Cache-Control:
   no-store` as `portikus-backup-key.txt`. The tab shows "Backup key not
   yet downloaded" until the first download.
4. It gets **Upload backup key**, for rebuilding a server from an off-site
   copy. The upload must be a real age identity, is audited, and replacing
   a different key needs an explicit confirmation, because that key is
   then gone.
5. No browser upload of backup sets. An administrator copies sets in with
   rsync or scp; the tab lists and restores them, and they get every check
   a set from the VM gets.
6. Copying sets off the server stays manual but is documented as the real
   backup.

The one open design question was how the API, which runs unprivileged as
`portikus`, reads and writes a root-owned key.

## Decision

**The same scripts, in a local mode.** `backup.sh`, `backup-channel.sh`,
`restore-copy.sh` and `restore.sh` take `--local`. In that mode the
commands they would have sent over SSH run on this machine, as root, in
`bash -c`, so each script keeps one list of commands for both paths. The
channel asks the local `portikus backup-channel pull` for a request and
passes its report to `portikus backup-channel report`. Everything that
was true of a request from a VM stays true of a request from the local
worker: the worker is unprivileged, so its request is parsed with the same
size cap, fixed kinds and strict patterns, and "refused by the host"
covers it the same way. The sets go to `/var/backups/portikus/local/`,
whatever the server is called, so sets copied from one server to its
replacement land in the same place. The retention floor, the byte budget
and every other bound of ADR 0039 apply unchanged.

The package ships the scripts in `/usr/lib/portikus/backup/`, with
`portikus-backup.service`, `portikus-backup-channel.service` (both root)
and the host's two timer files. Setup's `backup` role enables them only
when it runs on the server itself (`ansible_connection` is `local`), so
the pilot, configured from the workstation, keeps being backed up by its
host. The role installs `age`, makes the key pair in
`/etc/portikus-backup/` (directory 0700, key and recipients files 0600,
root) when there is no key, and writes the recipients file from the key.

**The key stays root-only, and a root helper behind a socket hands it
over.** `portikus-backup-key.socket` listens on
`/run/portikus-backup-key.sock`, owner root, group `portikus`, mode 0660,
with `Accept=yes`. Each connection starts one
`portikus-backup-key@.service`, a root shell script
(`/usr/lib/portikus/backup/portikus-backup-key`) with the connection as
its standard input and output. It reads one verb line:

- `status`: whether a key is installed, its public half, and the public
  half last downloaded, with the time;
- `export`: the key file. It records nothing, because the download can
  still fail on its way to the browser;
- `mark-downloaded <public half>`: a record that the administrator now
  holds the installed key. The API sends it only once the download's
  reply has been sent in full, and the helper refuses it for any key but
  the installed one;
- `import` and `import-replace`: an uploaded file of at most 4 KiB,
  refused unless its only line that is not a comment or blank is an
  `AGE-SECRET-KEY-1…` identity that `age-keygen -y` accepts. The same key
  is accepted as unchanged and brings the recipients file back in line. A
  different key is refused with `exists` unless the verb is
  `import-replace`. A replace takes the backup lock, so it never lands in
  the middle of a backup. It keeps the old key as
  `age-key.txt.replaced-<unix time>`, root-only, by a hard link that
  never overwrites an earlier one, then writes the recipients file and the
  new key, each by an atomic rename. An upload is never recorded as a
  download: nothing shows the uploader kept a copy, so the reminder stays
  until a real download.

The service unit has no capabilities, no network, a read-only file
system except `/etc/portikus-backup` and the backup lock, and a 30-second
limit. It writes only one-line messages to the journal, naming the key by
its public half; the key itself goes only to the socket.

The API's three routes (`GET /admin/backups/key`, `POST
/admin/backups/key/download`, `POST /admin/backups/key`) are
administrator-only and CSRF-checked like every other admin write, and are
404 when `BACKUP_KEY_SOCKET` is unset, as on the pilot, whose key its host
holds. The download is audited as `backup.key_downloaded` before the key
leaves the API, and marked downloaded only after the reply has gone; the
upload is audited as `backup.key_uploaded` with result `ok` or `refused`;
both record only public halves. The key passes through
the API's memory for one request and is never written to a file, a log
line or the database. The "not yet downloaded" reminder is the helper's
own record, compared with the key installed now, so it comes back if
setup ever makes a new key.

**A whole-server restore is a command, not a button.** `sudo portikus
restore <set>` runs `restore.sh --local` with the installed key. It
refuses a server that already has workspaces, projects or users other
than the local administrator, as `make restore` always has, pauses the
two backup timers while it replaces the database, and `--check` proves the
key opens a set without touching anything. The tab's per-workspace
restores (ADR 0040) work on any listed set, hand-copied ones included. A
button that replaces the database the page itself runs on, and signs its
own user out, was left out: rebuilding a server is an operator's job at a
shell, and the rebuild guide already has them there.

### Authenticated sets

Encryption to a public key does not show who made a set: anyone who knows
the recipient can encrypt one, and a whole-server restore runs the set's
database dump through `pg_restore` as the database superuser. Each set is
therefore signed.

- **The scheme.** `backup.sh` writes `MANIFEST.mac` beside the set's
  `MANIFEST.age`: the line `portikus-backup-mac 1 <hex>`, an HMAC-SHA256
  of the bytes `portikus-backup-set 1\n` followed by `MANIFEST.age`. Its
  key is SHA-256 of `portikus-backup-mac-v1\n` followed by the age
  identity's `AGE-SECRET-KEY-1…` line. `infra/host/portikus-backup-mac`
  does the work, in Python's standard library.
- **What it covers.** The MANIFEST lists the size and SHA-256 of the
  database dumps, of each volume and, from this change, of each volume's
  index. So a verified MANIFEST vouches for every file the restores use.
  The plain `FAILED`, `SKIPPED` and `REQUESTED` files are not covered;
  they only change what the tab shows.
- **Where it is checked.** `restore.sh`, `restore-copy.sh` and the
  channel's listing check the MAC before they decrypt or read anything
  else. Then the MANIFEST's line forms are still checked, as defence in
  depth. `restore-copy.sh` now also checks the index and the streamed
  volume against the MANIFEST, removing its copy or its import when they
  differ. A decrypted MANIFEST over 4 MiB is refused, and `backup.sh`
  never writes one; 4 MiB, not 1, because the contract allows 2,000
  workspaces, whose lines can pass 1 MiB.
- **Old sets.** A set made before this change has no MAC. The tab shows it
  as not verified and the channel refuses it. Root can restore it with
  `portikus restore --unverified` (or `restore.sh --unverified`), which
  warns; a wrong MAC is refused even then. Whoever holds the key can also
  sign an old set they trust.
- **Where the key is.** On an apt-installed server `backup.sh --local`
  runs as root and signs with the identity itself. On a separate host the
  nightly backup runs as the operator, who does not hold the private key,
  so `make backup-setup` and `make backup-install-key` derive the MAC key
  into `~/.config/portikus/backup-mac-key.txt`, with the recipient it is
  for. That file can sign sets but not decrypt them, and `backup.sh`
  refuses to start when it is for another recipient than the one it
  encrypts to.

Why a MAC and not a signature: a separate signing key pair would be a
second secret to generate, back up and restore with, and the ruling was
that the one downloaded key file must be enough to rebuild. Deriving the
MAC key from the age identity keeps that true. The cost is that anyone
with the private key can also sign; they can already read every set.

### What a compromised API or worker can and cannot do

Both run as the unprivileged `portikus` account, and either can reach the
key socket.

It can:

- download the backup key. Each export is a root-side journal line
  naming the key's public half; a compromised API can skip its own audit
  row but not that line. With the key it can read any copy of a set and
  sign a set of its own;
- replace the key with one it made, after which new sets are encrypted to
  that key. The old key stays on the server as
  `age-key.txt.replaced-<unix time>`, so the older sets can still be read
  and restored by root;
- ask for backups, deletions of old sets and per-workspace restores, all
  within the channel's fixed kinds, patterns and retention floor (ADR
  0039);
- send `mark-downloaded` itself and so clear the reminder. The reminder
  is a prompt for an honest administrator, not a control.

It cannot:

- read or write `/etc/portikus-backup` or `/var/backups/portikus`, so it
  cannot plant a set on the server or read one there directly;
- run a whole-server restore, which only root starts, at a shell;
- restore a set without a valid MAC, or ask for `--unverified`;
- delete the key or a replaced key.

A set it signs with a stolen key would still need someone with root to
copy it onto the server and restore it; the MAC protects sets from
someone who holds only the public key, such as whoever can write to the
off-site copy.

### Why a socket and not group read

The simpler option was to make the key readable by the `portikus` group
and let the API read the file. An upload would still need a root helper,
because the API must not hold a writable key, so the group read would
have saved only the download. It would also have let a compromised API
process read the key silently, with no record anywhere the attacker could
not erase. Through the socket, every handout is a root-side journal line
and a root-owned record, the key file keeps the exact root-only form the
channel and `restore-copy.sh` already insist on, and one small helper
serves all three routes.

### Why a socket and not a path unit like the image job

The image job (ADR 0030) is a queue: the API drops a request file and
polls for a result, which suits jobs that take minutes. A download needs
the key back within the request. Through files, the key would sit on
disk a second time, in a directory the API can read, until someone
removed it. The socket answers in the same request and keeps the key off
the disk.

## Consequences

- An apt-installed server has nightly backups and a working Backups tab
  with no second machine. They sit on the server's own disk, so they
  protect against mistakes and a broken workspace, not against losing the
  server; docs/INSTALL.md and docs/OPERATIONS.md say that copying the
  encrypted sets elsewhere is the real backup, that the copy's target
  never needs the key, and how to rebuild from it.
- Whoever takes the server can read every set on it and download the key.
  That is ruling 2: they could already read the live workspaces. The key
  matters for copies kept elsewhere, which is why the tab keeps reminding
  until it has been downloaded once.
- The worker shares the API's account, so it too could ask the socket for
  the key. A separate group for the API alone would not change that,
  because processes of one account can already reach each other.
- Replacing the key keeps the old one on the server, root-only, so sets
  encrypted to it can still be restored from a shell with
  `PORTIKUS_BACKUP_IDENTITY` pointing at the kept file. The tab cannot use
  it: its listing checks sets against the installed key only.
- Every restore refuses a set without a valid MAC; sets from before MACs
  need root's `--unverified`.
- `restore-copy.sh`, the channel and the key helper each check the key's
  form in shell; `packaging/backup/backup-key` is covered by
  `infra/tests/backup-local-test.sh`, the routes by
  `apps/api/src/routes/admin-backup-key.test.ts` and the authorization
  matrix, and the whole path, including a rebuild from an off-site copy,
  by `make install-test`.
- ADR 0024's host-pull design and ADR 0039's channel stand for a VM with a
  separate host. This record adds the local mode beside them; it
  supersedes neither.
