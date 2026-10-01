#!/usr/bin/env bash
# Pull a backup of the platform VM to this host, encrypted with age
# (docs/adr/0024-backups-pulled-to-host.md).  It only reads from the VM:
# a pg_dump of the portikus database and of Dex's accounts, when Dex has a
# database, and an export of each workspace's home and recovery volume.
#
# Sets go to <backup dir>/<VM name>/<UTC timestamp>, so the rehearsal VM's
# sets never push out the pilot's.  The name comes from the caller, never
# from the VM, and the run stops unless the VM's hostname matches it.  A volume whose export fails is named
# on a "failed" line of the MANIFEST and in a plain FAILED file; the other
# volumes are still saved, and the run exits non-zero.
#
# Usage: backup.sh [--check-state] --vm-name <name> <vm-ip>
#        backup.sh --local
#   --check-state  compare workspaces, users and settings before and after,
#                  with the security suite's snapshot helper (repository only)
#   --vm-name      the VM's name in the OpenTofu state, such as portikus
#   --local        back up the server this runs on, as root, into
#                  <backup dir>/local (an apt-installed host, ADR 0044)
#
# Environment:
#   PORTIKUS_BACKUP_DIR         holds one directory of sets per VM (default /var/backups/portikus)
#   PORTIKUS_BACKUP_RECIPIENTS  age recipients file (default ~/.config/portikus/backup-recipients.txt,
#                               or /etc/portikus-backup/recipients.txt with --local)
#   PORTIKUS_BACKUP_MAC_KEY     signs the set (portikus-backup-mac): the MAC key file make backup-setup
#                               derives (default ~/.config/portikus/backup-mac-key.txt), or the age
#                               identity itself with --local (default /etc/portikus-backup/age-key.txt)
#   PORTIKUS_BACKUP_KEEP        complete sets, and incomplete ones, kept per VM (default 14)
#   PORTIKUS_BACKUP_MIN_AGE_DAYS   retention never removes a set younger than this (default 14)
#   PORTIKUS_BACKUP_MIN_FREE_MB    a run needs this much free space at least (default 1024)
#   PORTIKUS_BACKUP_KEEP_COMPLETE  retention always keeps this many newest complete sets (default 3)
#   PORTIKUS_BACKUP_MAX_INDEX_ENTRIES  files indexed per volume before the run stops (default 1000000)
#   PORTIKUS_BACKUP_LOCK_WAIT_SECONDS  how long to wait for another VM's run on this host (default 3600)
set -euo pipefail
umask 077

BACKUP_DIR="${PORTIKUS_BACKUP_DIR:-/var/backups/portikus}"
KEEP="${PORTIKUS_BACKUP_KEEP:-14}"
# The same retention floor as backup-channel.sh's delete (ADR 0039), so
# repeated requested backups cannot prune recent sets either.
MIN_AGE_DAYS="${PORTIKUS_BACKUP_MIN_AGE_DAYS:-14}"
KEEP_COMPLETE="${PORTIKUS_BACKUP_KEEP_COMPLETE:-3}"
MIN_FREE_MB="${PORTIKUS_BACKUP_MIN_FREE_MB:-1024}"
[[ "$MIN_AGE_DAYS" =~ ^[0-9]{1,4}$ ]] || MIN_AGE_DAYS=14
[[ "$KEEP_COMPLETE" =~ ^[0-9]{1,3}$ ]] || KEEP_COMPLETE=3
[[ "$MIN_FREE_MB" =~ ^[0-9]{1,9}$ ]] || MIN_FREE_MB=1024
MAX_INDEX_ENTRIES="${PORTIKUS_BACKUP_MAX_INDEX_ENTRIES:-1000000}"
[[ "$MAX_INDEX_ENTRIES" =~ ^[0-9]{1,9}$ ]] || MAX_INDEX_ENTRIES=1000000
LOCK_WAIT="${PORTIKUS_BACKUP_LOCK_WAIT_SECONDS:-3600}"
[[ "$LOCK_WAIT" =~ ^[0-9]{1,6}$ ]] || LOCK_WAIT=3600
# Counted against the run's byte budget for every file it writes (ADR 0039).
FILE_OVERHEAD=8192
# The longest path the index records; a longer one stops the run.
MAX_PATH_BYTES=4096
# Caps on what the VM may list; the contract allows 2000 instances.
MAX_INSTANCES=2000
MAX_VOLUMES=8000
# The VM half, sent with every command rather than installed on the VM.
EXPORT_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-export"
MAC_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-mac"
# shellcheck source=/dev/null
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-lib.sh"
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
# The VM is not trusted: everything it says must match one of these before
# it reaches a file name or the MANIFEST (restore.sh checks the same forms).
VOLUME_PATTERN='^ws-[0-9a-f]{24}-(home|recovery)$'
WORKSPACE_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (ws-[0-9a-f]{24}|-)$'
COUNTS_PATTERN='^users [0-9]+ workspaces [0-9]+ projects [0-9]+$'
VERSION_PATTERN='^[0-9A-Za-z.+~:-]+$'
HOSTNAME_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
IDMAP_PATTERN='^\[[][{}":,A-Za-z0-9]{0,4096}\]$'

# Reads a stream on stdin and copies it to stdout unchanged, writing its size
# and SHA-256 to argv[2].  With argv[1] = tar it also writes a JSON line per
# regular file (path, size, SHA-256) and per Git repository (HEAD commit)
# to argv[3], so a restore can be checked file by file.  The stream plus
# twice the index (plain here, encrypted later) may not pass argv[4] bytes,
# nor any member name argv[6] bytes, nor the tar argv[7] members: past any
# of them it writes the reason to argv[5] and exits 3.  Its memory stays
# small: tarfile's member list is cleared as it goes, and only the first
# bytes of Git HEAD and ref files are kept.
INDEXER='
import hashlib, json, sys, tarfile
mode, sum_path = sys.argv[1], sys.argv[2]
budget, over_path = int(sys.argv[4]), sys.argv[5]
max_path, max_entries = int(sys.argv[6]), int(sys.argv[7])
# "run: " stops the whole run; "volume: " fails only this volume.
def over(reason, scope="run"):
    with open(over_path, "w") as f:
        f.write(f"{scope}: {reason}")
    sys.exit(3)
# The Git tables only verify a restore, so past this they stop growing.
KEPT_MAX_ENTRIES, KEPT_MAX_BYTES = 100000, 64 << 20
kept_entries = kept_bytes = 0
def remember(table, key, value, replace=True):
    global kept_entries, kept_bytes
    if key in table:
        if replace:
            table[key] = value
        return
    size = len(str(key)) + len(value)
    if kept_entries >= KEPT_MAX_ENTRIES or kept_bytes + size > KEPT_MAX_BYTES:
        return
    kept_entries += 1
    kept_bytes += size
    table[key] = value
class Tee:
    def __init__(self):
        self.h, self.n, self.index = hashlib.sha256(), 0, 0
    def check(self):
        if self.n + 2 * self.index > budget:
            over("the run passed its byte budget")
    def read(self, size=-1):
        b = sys.stdin.buffer.read(size if size and size > 0 else 1 << 20)
        self.h.update(b); self.n += len(b)
        self.check()
        sys.stdout.buffer.write(b)
        return b
tee = Tee()
def record(index, entry):
    line = json.dumps(entry) + "\n"
    tee.index += len(line.encode(errors="surrogateescape"))
    tee.check()
    index.write(line)
if mode == "tar":
    prefix = "backup/volume/"
    heads, refs = {}, {}
    entries = 0
    with open(sys.argv[3], "w") as index, tarfile.open(fileobj=tee, mode="r|gz") as tar:
        for m in tar:
            # Stream mode keeps every member it has read; nothing here needs them.
            tar.members = []
            entries += 1
            if entries > max_entries:
                over(f"the volume has more than {max_entries} files", "volume")
            for name in (m.name, m.linkname):
                if len(name.encode(errors="surrogateescape")) > max_path + len(prefix):
                    over(f"a path is longer than {max_path} bytes", "volume")
            if not m.isfile() or not m.name.startswith(prefix):
                continue
            path = m.name[len(prefix):]
            repo, sep, rest = path.rpartition(".git/")
            is_git = bool(sep) and (not repo or repo.endswith("/"))
            if is_git and rest == "packed-refs":
                keep = 65536
            elif is_git and (rest == "HEAD" or rest.startswith("refs/heads/")):
                keep = 100
            else:
                keep = 0
            data = tar.extractfile(m)
            h = hashlib.sha256()
            small = b""
            while chunk := data.read(1 << 20):
                h.update(chunk)
                if len(small) < keep:
                    small = (small + chunk)[:keep]
            record(index, {"f": path, "size": m.size, "sha256": h.hexdigest()})
            if not is_git:
                continue
            repo = repo.rstrip("/") or "."
            if rest == "HEAD":
                remember(heads, repo, small.decode(errors="replace").strip())
            elif rest.startswith("refs/heads/"):
                remember(refs, (repo, rest), small.decode(errors="replace").strip())
            elif rest == "packed-refs":
                for line in small.decode(errors="replace").splitlines():
                    parts = line.split()
                    if len(parts) == 2 and not line.startswith(("#", "^")):
                        remember(refs, (repo, parts[1]), parts[0], replace=False)
        for repo, head in sorted(heads.items()):
            ref = head[5:].strip() if head.startswith("ref:") else None
            commit = refs.get((repo, ref)) if ref else head
            record(index, {"git": repo, "ref": ref, "head": commit})
while tee.read():
    pass
sys.stdout.buffer.flush()
with open(sum_path, "w") as f:
    f.write(f"{tee.n} {tee.h.hexdigest()}\n")
'

info() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] FAIL: %s\n' "$*" >&2; exit 1; }

# enough_free_space -- is there room in BACKUP_DIR for one more set: the
# newest complete set's size plus a fifth, and at least MIN_FREE_MB? The
# same check as in backup-channel.sh (ADR 0039).
enough_free_space() {
  local s newest="" size need avail
  for s in $(find "$HOST_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E "$SET_PATTERN" | sort -r); do
    [ -e "${HOST_DIR}/${s}/FAILED" ] || { newest=$s; break; }
  done
  need=$((MIN_FREE_MB * 1048576))
  if [ -n "$newest" ]; then
    size=$(du -sb "${HOST_DIR}/${newest}" | cut -f1)
    [ $((size * 6 / 5)) -le "$need" ] || need=$((size * 6 / 5))
  fi
  avail=$(df -B1 --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')
  [ "$avail" -ge "$need" ]
}
# must NAME PATTERN VALUE -- stop unless the VM's answer has the expected form.
must() { [[ "$3" =~ $2 ]] || die "the VM sent a ${1} that is not in the expected form; nothing was kept"; }
# lines TEXT -- TEXT one line at a time, and nothing at all when it is empty.
lines() { [ -z "$1" ] || printf '%s\n' "$1"; }
# bounded NAME MAX_BYTES MAX_LINES COMMAND... -- COMMAND's output, or stop
# the run when it fails or passes either cap, so no VM answer is read whole.
bounded() {
  local name=$1 max_bytes=$2 max_lines=$3 out rc LC_ALL=C
  shift 3
  out=$(set +o pipefail; "$@" | head -c $((max_bytes + 1)); exit "${PIPESTATUS[0]}") && rc=0 || rc=$?
  if [ "${#out}" -gt "$max_bytes" ] || [ "$(lines "$out" | wc -l)" -gt "$max_lines" ]; then
    die "the VM sent a ${name} longer than the host accepts; nothing was kept"
  fi
  [ "$rc" = 0 ] || die "the VM's ${name} failed; nothing was kept"
  printf '%s' "$out"
}

check_state=no
expected_name=
local_mode=no
while [ $# -gt 0 ]; do
  case "$1" in
    --check-state) check_state=yes; shift ;;
    --vm-name) expected_name="${2:?--vm-name needs a value}"; shift 2 ;;
    --local) local_mode=yes; shift ;;
    *) break ;;
  esac
done
if [ "$local_mode" = yes ]; then
  if [ "$check_state" = yes ] || [ -n "$expected_name" ]; then die "--local takes no other option"; fi
  RECIPIENTS="${PORTIKUS_BACKUP_RECIPIENTS:-/etc/portikus-backup/recipients.txt}"
  MAC_KEY="${PORTIKUS_BACKUP_MAC_KEY:-/etc/portikus-backup/age-key.txt}"
  # The MANIFEST's vm line keeps its address form.
  VM=127.0.0.1
  expected_name=local
else
  RECIPIENTS="${PORTIKUS_BACKUP_RECIPIENTS:-${HOME}/.config/portikus/backup-recipients.txt}"
  MAC_KEY="${PORTIKUS_BACKUP_MAC_KEY:-${HOME}/.config/portikus/backup-mac-key.txt}"
  VM="${1:?Usage: backup.sh [--check-state] --vm-name <name> <vm-ip>}"
fi
[ -n "$expected_name" ] || die "--vm-name is required, so one VM can never write into another's sets"
[[ "$expected_name" =~ $HOSTNAME_PATTERN ]] || die "--vm-name '${expected_name}' is not a hostname"

command -v age >/dev/null || die "age is not installed (make bootstrap-host)"
command -v python3 >/dev/null || die "python3 is not installed"
[ -r "$EXPORT_SCRIPT" ] || die "${EXPORT_SCRIPT} is missing"
[ -s "$RECIPIENTS" ] || die "no age recipients in ${RECIPIENTS} (make backup creates them)"
[ -r "$MAC_SCRIPT" ] || die "${MAC_SCRIPT} is missing"
[ -r "$MAC_KEY" ] || die "no key to sign the set with at ${MAC_KEY} (make backup-setup derives it)"
# A set signed with another key would not verify on restore, so stop before any work.
mac_recipient=$(python3 "$MAC_SCRIPT" recipient "$MAC_KEY") || die "cannot read the signing key ${MAC_KEY}"
grep -qxF "$mac_recipient" "$RECIPIENTS" \
  || die "the signing key ${MAC_KEY} is not for the recipients in ${RECIPIENTS}; nothing was kept"
if [ ! -d "$BACKUP_DIR" ] || [ ! -w "$BACKUP_DIR" ]; then
  die "${BACKUP_DIR} is missing or not writable (make backup creates it)"
fi

if [ "$local_mode" = yes ]; then
  [ "$(id -u)" = 0 ] || die "--local must run as root"
  use_local_vm
fi
# Base64 keeps the script intact through the remote shell, whatever it is.
export_b64=$(base64 -w0 "$EXPORT_SCRIPT")
remote_export() { vm "sudo bash -c \"\$(echo ${export_b64} | base64 -d)\" portikus-backup-export $*"; }

if [ "$local_mode" = yes ]; then
  vm_name=local
else
  vm_name=$(bounded hostname 64 1 vm hostname)
  must "hostname" "$HOSTNAME_PATTERN" "$vm_name"
  [ "$vm_name" = "$expected_name" ] || die "${VM} calls itself '${vm_name}', not '${expected_name}'; nothing was kept"
fi
HOST_DIR="${BACKUP_DIR}/${expected_name}"
install -d -m 0700 "$HOST_DIR"

# One run per VM at a time; the lock goes with the process.
exec {lock}>"${HOST_DIR}/.lock"
flock -n "$lock" || die "another backup of ${vm_name} is running"
# And one run per host, so two VMs never spend the same free space.
exec {host_lock}>"${BACKUP_DIR}/.lock"
flock -w "$LOCK_WAIT" "$host_lock" || die "another backup on this host ran for over ${LOCK_WAIT} seconds; nothing was kept"

started=$(date +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="${HOST_DIR}/.partial-${stamp}"
# Scratch lives beside the set, inside the budget, never in /tmp.
scratch="${HOST_DIR}/.partial-scratch-${stamp}"
# A set is renamed into place only when complete; anything else is removed.
trap 'rm -rf "$scratch" "$work"' EXIT
# Leftovers of a run that was killed; the lock proves none is live.
find "$HOST_DIR" -maxdepth 1 -name '.partial-*' -exec rm -rf {} +
enough_free_space || die "refused by the host: not enough free space"
# The run's byte budget: what is free now, less the floor it must leave.
budget=$(( $(df -B1 --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ') - MIN_FREE_MB * 1048576 ))
# The MANIFEST, its encrypted copy, its MAC, FAILED and SKIPPED.
used=$((5 * FILE_OVERHEAD))
install -d -m 0700 "$work" "$scratch"
manifest="${scratch}/MANIFEST"

if [ "$check_state" = yes ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  . "${here}/../tests/security/lib.sh"
  # The helper reads these three.
  # shellcheck disable=SC2034
  SEC_VM="$VM" SEC_START_EPOCH="$started"
  # shellcheck disable=SC2034
  SEC_AUDIT_MAX=$(sec_psql "SELECT COALESCE(max(id), 0) FROM audit_events")
  sec_snapshot_others >"${scratch}/state-before"
fi

# Each listing is read with $(...), not through a pipe, so a failed listing
# stops the run instead of reading as an empty one.
version=$(bounded "package version" 256 1 vm "dpkg-query -W -f='\${Version}' portikus")
must "package version" "$VERSION_PATTERN" "$version"
counts=$(bounded "row count" 256 1 remote_export counts)
must "row count" "$COUNTS_PATTERN" "$counts"
workspace_list=$(bounded "workspace listing" $((MAX_INSTANCES * 64)) "$MAX_INSTANCES" remote_export workspaces)
volume_list=$(bounded "volume listing" $((MAX_VOLUMES * 40)) "$MAX_VOLUMES" remote_export volumes)
instance_list=$(bounded "instance listing" $((MAX_INSTANCES * 28)) "$MAX_INSTANCES" remote_export instances)
mapfile -t workspaces < <(lines "$workspace_list")
mapfile -t volumes < <(lines "$volume_list")
mapfile -t instances < <(lines "$instance_list")
for ws in "${workspaces[@]}"; do
  must "workspace line" "$WORKSPACE_PATTERN" "$ws"
done
declare -A listed_instance=() listed_volume=() workspace_instance=()
for inst in "${instances[@]}"; do
  [[ "$inst" =~ $INSTANCE_PATTERN ]] && listed_instance[$inst]=1
done
for ws in "${workspaces[@]}"; do
  workspace_instance[${ws#* }]=1
done
# Only the volumes of a listed instance are exported, so made-up names
# cannot pad the run; an orphaned volume is skipped, not fatal.
kept_volumes=()
skipped=()
for vol in "${volumes[@]}"; do
  must "volume name" "$VOLUME_PATTERN" "$vol"
  listed_volume[$vol]=1
  if [ -n "${listed_instance[${vol%-*}]:-}" ]; then
    kept_volumes+=("$vol")
  else
    skipped+=("$vol")
  fi
done
volumes=("${kept_volumes[@]}")
if [ "${#skipped[@]}" -gt 0 ]; then
  printf '[backup] WARNING: skipped %s volumes of no listed instance, such as %s\n' \
    "${#skipped[@]}" "$(printf '%s ' "${skipped[@]:0:3}")" >&2
fi
if [ "${#workspaces[@]}" != "$(awk '{ print $4 }' <<<"$counts")" ]; then
  die "the VM listed ${#workspaces[@]} workspaces but counted $(awk '{ print $4 }' <<<"$counts"); nothing was kept"
fi
# A workspace row gets its instance name before the instance exists, so only
# a workspace whose instance is there must have a home volume in the listing.
for inst in "${!listed_instance[@]}"; do
  if [ -n "${workspace_instance[$inst]:-}" ] && [ -z "${listed_volume[${inst}-home]:-}" ]; then
    die "workspace instance ${inst} exists but the volume listing has no ${inst}-home; nothing was kept"
  fi
done
{
  echo "portikus-backup 1"
  echo "created ${stamp}"
  echo "vm ${VM}"
  echo "package ${version}"
  echo "counts ${counts}"
  for ws in "${workspaces[@]}"; do
    echo "workspace ${ws}"
  done
  [ "${#skipped[@]}" -eq 0 ] || echo "skipped ${#skipped[@]}"
} >"$manifest"
# In plain text too, so the admin page can show it without the key.
[ "${#skipped[@]}" -eq 0 ] || echo "${#skipped[@]}" >"${work}/SKIPPED"

# pull NAME MODE COMMAND... -- stream COMMAND's output from the VM into NAME.age.
pull() {
  local name=$1 mode=$2
  shift 2
  pull_error="the export failed"
  # .sum, .index, .age and .index.age.
  used=$((used + 4 * FILE_OVERHEAD))
  if ! remote_export "$@" \
    | python3 -c "$INDEXER" "$mode" "${scratch}/${name}.sum" "${scratch}/${name}.index" \
      "$((budget - used))" "${scratch}/over" "$MAX_PATH_BYTES" "$MAX_INDEX_ENTRIES" \
    | age -R "$RECIPIENTS" -o "${work}/${name}.age"; then
    local reason=""
    if [ -e "${scratch}/over" ]; then
      reason=$(head -c 200 "${scratch}/over")
      rm -f "${scratch}/over"
      # The byte budget stops the whole run; the trap removes the partial set.
      [[ "$reason" != run:* ]] || die "${name}: ${reason#run: }; nothing was kept"
      pull_error=${reason#volume: }
    fi
    # A failed export still spent its index against the budget.
    [ ! -e "${scratch}/${name}.index" ] || used=$((used + 2 * $(stat -c %s "${scratch}/${name}.index")))
    rm -f "${work}/${name}.age" "${scratch}/${name}.index" "${scratch}/${name}.sum"
    return 1
  fi
  local index_bytes=0
  [ ! -e "${scratch}/${name}.index" ] || index_bytes=$(stat -c %s "${scratch}/${name}.index")
  used=$((used + $(cut -d' ' -f1 "${scratch}/${name}.sum") + 2 * index_bytes))
}

info "database"
pull db.dump plain db || die "db.dump: the pipeline failed (ssh, index or age)"
echo "file db.dump $(cat "${scratch}/db.dump.sum")" >>"$manifest"
# Dex's accounts replace the users file's encrypted copy (docs/archive/epics/EPIC-14.md ruling 23).
has_dex=$(bounded "Dex database check" 8 1 remote_export has-dex)
must "Dex database check" '^[01]$' "$has_dex"
if [ "$has_dex" = 1 ]; then
  info "Dex database"
  pull dex.dump plain dex-db || die "dex.dump: the pipeline failed (ssh, index or age)"
  echo "file dex.dump $(cat "${scratch}/dex.dump.sum")" >>"$manifest"
fi

failed=()
failed_why=()
for vol in "${volumes[@]}"; do
  info "volume ${vol}"
  if ! pull "$vol" tar volume "$vol"; then
    printf '[backup] FAIL: %s: %s; carrying on with the other volumes\n' "$vol" "$pull_error" >&2
    failed+=("$vol")
    failed_why+=("${vol}: ${pull_error}")
    echo "failed ${vol}" >>"$manifest"
    continue
  fi
  idmap=$(bounded "volume ID map" 4200 1 remote_export idmap "$vol")
  [ -z "$idmap" ] || must "volume ID map" "$IDMAP_PATTERN" "$idmap"
  age -R "$RECIPIENTS" -o "${work}/${vol}.index.age" "${scratch}/${vol}.index"
  # The index's own size and checksum, so the MAC covers it too.
  index_sum="$(stat -c %s "${scratch}/${vol}.index") $(sha256sum "${scratch}/${vol}.index" | cut -d' ' -f1)"
  rm -f "${scratch}/${vol}.index"
  echo "volume ${vol} $(cat "${scratch}/${vol}.sum") ${idmap:--}" >>"$manifest"
  echo "index ${vol} ${index_sum}" >>"$manifest"
done

echo "seconds $(($(date +%s) - started))" >>"$manifest"
age -R "$RECIPIENTS" -o "${work}/MANIFEST.age" "$manifest"
[ "$(stat -c %s "$manifest")" -le 4194304 ] || die "the MANIFEST passed 4 MiB, which restores refuse; nothing was kept"
python3 "$MAC_SCRIPT" sign "$MAC_KEY" "$work" || die "could not sign the set; nothing was kept"
# Also in plain text, so retention can tell an incomplete set without the key.
if [ "${#failed[@]}" -gt 0 ]; then printf '%s\n' "${failed[@]}" >"${work}/FAILED"; fi
# -T: a set of the same second is never nested inside another.
mv -T "$work" "${HOST_DIR}/${stamp}"

if [ "$check_state" = yes ]; then
  sec_snapshot_others >"${scratch}/state-after"
  if ! diff -u "${scratch}/state-before" "${scratch}/state-after"; then
    die "workspaces, users or settings changed during the backup (the set is kept)"
  fi
  info "workspaces, users and settings are the same before and after"
fi

# Retention, in this VM's directory only: the newest KEEP complete sets
# stay, and the newest KEEP incomplete sets newer than the oldest of those.
# Complete sets are counted apart, so nights of failed exports never push
# out the last good copy of a volume, and cannot fill the disk either.
# The floor wins over KEEP: a set younger than MIN_AGE_DAYS, or among the
# newest KEEP_COMPLETE complete sets, is never removed.
now=$(date +%s)
mapfile -t sets < <(find "$HOST_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$SET_PATTERN" | sort -r)
complete=0
incomplete=0
for set in "${sets[@]}"; do
  if [ ! -e "${HOST_DIR}/${set}/FAILED" ] && { [ "$complete" -lt "$KEEP" ] || [ "$complete" -lt "$KEEP_COMPLETE" ]; }; then
    complete=$((complete + 1))
    continue
  fi
  if [ "$complete" -lt "$KEEP" ] && [ "$incomplete" -lt "$KEEP" ]; then
    incomplete=$((incomplete + 1))
    continue
  fi
  set_epoch=$(date -u -d "${set:0:4}-${set:4:2}-${set:6:2}T${set:9:2}:${set:11:2}:${set:13:2}Z" +%s)
  if [ $((now - set_epoch)) -lt $((MIN_AGE_DAYS * 86400)) ]; then
    continue
  fi
  info "removing old set ${set}"
  rm -rf "${HOST_DIR:?}/${set}"
done

info "set ${HOST_DIR}/${stamp}: ${#volumes[@]} volumes, $(du -sh "${HOST_DIR}/${stamp}" | cut -f1), $(($(date +%s) - started)) s"
if [ "${#failed[@]}" -gt 0 ]; then
  # The first three reasons, so the status report says why.
  why=$(printf '%s; ' "${failed_why[@]:0:3}")
  die "${#failed[@]} of ${#volumes[@]} volumes failed to export (${why%; }); the set is kept and marked incomplete"
fi
