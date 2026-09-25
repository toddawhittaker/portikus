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
#   --check-state  compare workspaces, users and settings before and after,
#                  with the security suite's snapshot helper (repository only)
#   --vm-name      the VM's name in the OpenTofu state, such as portikus
#
# Environment:
#   PORTIKUS_BACKUP_DIR         holds one directory of sets per VM (default /var/backups/portikus)
#   PORTIKUS_BACKUP_RECIPIENTS  age recipients file (default ~/.config/portikus/backup-recipients.txt)
#   PORTIKUS_BACKUP_KEEP        complete sets, and incomplete ones, kept per VM (default 14)
set -euo pipefail
umask 077

BACKUP_DIR="${PORTIKUS_BACKUP_DIR:-/var/backups/portikus}"
RECIPIENTS="${PORTIKUS_BACKUP_RECIPIENTS:-${HOME}/.config/portikus/backup-recipients.txt}"
KEEP="${PORTIKUS_BACKUP_KEEP:-14}"
# The VM half, sent with every command rather than installed on the VM.
EXPORT_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-export"
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
# The VM is not trusted: everything it says must match one of these before
# it reaches a file name or the MANIFEST (restore.sh checks the same forms).
VOLUME_PATTERN='^ws-[0-9a-f]{24}-(home|recovery)$'
WORKSPACE_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (ws-[0-9a-f]{24}|-)$'
COUNTS_PATTERN='^users [0-9]+ workspaces [0-9]+ projects [0-9]+$'
VERSION_PATTERN='^[0-9A-Za-z.+~:-]+$'
HOSTNAME_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
IDMAP_PATTERN='^\[[][{}":,A-Za-z0-9]*\]$'

# Reads a stream on stdin and copies it to stdout unchanged, writing its size
# and SHA-256 to argv[2].  With argv[1] = tar it also writes a JSON line per
# regular file (path, size, SHA-256) and per Git repository (HEAD commit)
# to argv[3], so a restore can be checked file by file.
INDEXER='
import hashlib, json, sys, tarfile
mode, sum_path = sys.argv[1], sys.argv[2]
class Tee:
    def __init__(self):
        self.h, self.n = hashlib.sha256(), 0
    def read(self, size=-1):
        b = sys.stdin.buffer.read(size if size and size > 0 else 1 << 20)
        self.h.update(b); self.n += len(b); sys.stdout.buffer.write(b)
        return b
tee = Tee()
if mode == "tar":
    prefix = "backup/volume/"
    heads, refs = {}, {}
    with open(sys.argv[3], "w") as index, tarfile.open(fileobj=tee, mode="r|gz") as tar:
        for m in tar:
            if not m.isfile() or not m.name.startswith(prefix):
                continue
            path = m.name[len(prefix):]
            data = tar.extractfile(m)
            h = hashlib.sha256()
            small = b""
            while chunk := data.read(1 << 20):
                h.update(chunk)
                if len(small) < 65536:
                    small += chunk
            index.write(json.dumps({"f": path, "size": m.size, "sha256": h.hexdigest()}) + "\n")
            repo, sep, rest = path.rpartition(".git/")
            if not sep or (repo and not repo.endswith("/")):
                continue
            repo = repo.rstrip("/") or "."
            if rest == "HEAD":
                heads[repo] = small.decode(errors="replace").strip()
            elif rest.startswith("refs/heads/"):
                refs[(repo, rest)] = small.decode(errors="replace").strip()
            elif rest == "packed-refs":
                for line in small.decode(errors="replace").splitlines():
                    parts = line.split()
                    if len(parts) == 2 and not line.startswith(("#", "^")):
                        refs.setdefault((repo, parts[1]), parts[0])
        for repo, head in sorted(heads.items()):
            ref = head[5:].strip() if head.startswith("ref:") else None
            commit = refs.get((repo, ref)) if ref else head
            index.write(json.dumps({"git": repo, "ref": ref, "head": commit}) + "\n")
while tee.read():
    pass
sys.stdout.buffer.flush()
with open(sum_path, "w") as f:
    f.write(f"{tee.n} {tee.h.hexdigest()}\n")
'

info() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] FAIL: %s\n' "$*" >&2; exit 1; }
# must NAME PATTERN VALUE -- stop unless the VM's answer has the expected form.
must() { [[ "$3" =~ $2 ]] || die "the VM sent a ${1} that is not in the expected form; nothing was kept"; }
# lines TEXT -- TEXT one line at a time, and nothing at all when it is empty.
lines() { [ -z "$1" ] || printf '%s\n' "$1"; }

check_state=no
expected_name=
while [ $# -gt 0 ]; do
  case "$1" in
    --check-state) check_state=yes; shift ;;
    --vm-name) expected_name="${2:?--vm-name needs a value}"; shift 2 ;;
    *) break ;;
  esac
done
VM="${1:?Usage: backup.sh [--check-state] --vm-name <name> <vm-ip>}"
[ -n "$expected_name" ] || die "--vm-name is required, so one VM can never write into another's sets"
[[ "$expected_name" =~ $HOSTNAME_PATTERN ]] || die "--vm-name '${expected_name}' is not a hostname"

command -v age >/dev/null || die "age is not installed (make bootstrap-host)"
command -v python3 >/dev/null || die "python3 is not installed"
[ -r "$EXPORT_SCRIPT" ] || die "${EXPORT_SCRIPT} is missing"
[ -s "$RECIPIENTS" ] || die "no age recipients in ${RECIPIENTS} (make backup creates them)"
if [ ! -d "$BACKUP_DIR" ] || [ ! -w "$BACKUP_DIR" ]; then
  die "${BACKUP_DIR} is missing or not writable (make backup creates it)"
fi

vm() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "deploy@${VM}" "$@"; }
# Base64 keeps the script intact through the remote shell, whatever it is.
export_b64=$(base64 -w0 "$EXPORT_SCRIPT")
remote_export() { vm "sudo bash -c \"\$(echo ${export_b64} | base64 -d)\" portikus-backup-export $*"; }

vm_name=$(vm hostname)
must "hostname" "$HOSTNAME_PATTERN" "$vm_name"
[ "$vm_name" = "$expected_name" ] || die "${VM} calls itself '${vm_name}', not '${expected_name}'; nothing was kept"
HOST_DIR="${BACKUP_DIR}/${expected_name}"
install -d -m 0700 "$HOST_DIR"

# One run per VM at a time; the lock goes with the process.
exec {lock}>"${HOST_DIR}/.lock"
flock -n "$lock" || die "another backup of ${vm_name} is running"

started=$(date +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="${HOST_DIR}/.partial-${stamp}"
scratch=$(mktemp -d)
# A set is renamed into place only when complete; anything else is removed.
trap 'rm -rf "$scratch" "$work"' EXIT
# Leftovers of a run that was killed; the lock proves none is live.
find "$HOST_DIR" -maxdepth 1 -name '.partial-*' -exec rm -rf {} +
install -d -m 0700 "$work"
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
version=$(vm "dpkg-query -W -f='\${Version}' portikus")
must "package version" "$VERSION_PATTERN" "$version"
counts=$(remote_export counts)
must "row count" "$COUNTS_PATTERN" "$counts"
workspace_list=$(remote_export workspaces)
volume_list=$(remote_export volumes)
instance_list=$(remote_export instances)
mapfile -t workspaces < <(lines "$workspace_list")
mapfile -t volumes < <(lines "$volume_list")
mapfile -t instances < <(lines "$instance_list")
for ws in "${workspaces[@]}"; do
  must "workspace line" "$WORKSPACE_PATTERN" "$ws"
done
for vol in "${volumes[@]}"; do
  must "volume name" "$VOLUME_PATTERN" "$vol"
done
if [ "${#workspaces[@]}" != "$(awk '{ print $4 }' <<<"$counts")" ]; then
  die "the VM listed ${#workspaces[@]} workspaces but counted $(awk '{ print $4 }' <<<"$counts"); nothing was kept"
fi
# A workspace row gets its instance name before the instance exists, so only
# a workspace whose instance is there must have a home volume in the listing.
for inst in "${instances[@]}"; do
  [[ "$inst" =~ $INSTANCE_PATTERN ]] || continue
  if grep -q " ${inst}\$" <<<"$workspace_list" && ! grep -qx "${inst}-home" <<<"$volume_list"; then
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
} >"$manifest"

# pull NAME MODE COMMAND... -- stream COMMAND's output from the VM into NAME.age.
pull() {
  local name=$1 mode=$2
  shift 2
  if ! remote_export "$@" \
    | python3 -c "$INDEXER" "$mode" "${scratch}/${name}.sum" "${scratch}/${name}.index" \
    | age -R "$RECIPIENTS" -o "${work}/${name}.age"; then
    rm -f "${work}/${name}.age"
    return 1
  fi
}

info "database"
pull db.dump plain db || die "db.dump: the pipeline failed (ssh, index or age)"
echo "file db.dump $(cat "${scratch}/db.dump.sum")" >>"$manifest"
# Dex's accounts replace the users file's encrypted copy (docs/EPIC-14.md ruling 23).
has_dex=$(remote_export has-dex)
must "Dex database check" '^[01]$' "$has_dex"
if [ "$has_dex" = 1 ]; then
  info "Dex database"
  pull dex.dump plain dex-db || die "dex.dump: the pipeline failed (ssh, index or age)"
  echo "file dex.dump $(cat "${scratch}/dex.dump.sum")" >>"$manifest"
fi

failed=()
for vol in "${volumes[@]}"; do
  info "volume ${vol}"
  if ! pull "$vol" tar volume "$vol"; then
    printf '[backup] FAIL: %s: the export failed; carrying on with the other volumes\n' "$vol" >&2
    failed+=("$vol")
    echo "failed ${vol}" >>"$manifest"
    continue
  fi
  idmap=$(remote_export idmap "$vol")
  [ -z "$idmap" ] || must "volume ID map" "$IDMAP_PATTERN" "$idmap"
  age -R "$RECIPIENTS" -o "${work}/${vol}.index.age" "${scratch}/${vol}.index"
  echo "volume ${vol} $(cat "${scratch}/${vol}.sum") ${idmap:--}" >>"$manifest"
done

echo "seconds $(($(date +%s) - started))" >>"$manifest"
age -R "$RECIPIENTS" -o "${work}/MANIFEST.age" "$manifest"
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
mapfile -t sets < <(find "$HOST_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$SET_PATTERN" | sort -r)
complete=0
incomplete=0
for set in "${sets[@]}"; do
  if [ "$complete" -lt "$KEEP" ] && [ ! -e "${HOST_DIR}/${set}/FAILED" ]; then
    complete=$((complete + 1))
    continue
  fi
  if [ "$complete" -lt "$KEEP" ] && [ "$incomplete" -lt "$KEEP" ]; then
    incomplete=$((incomplete + 1))
    continue
  fi
  info "removing old set ${set}"
  rm -rf "${HOST_DIR:?}/${set}"
done

info "set ${HOST_DIR}/${stamp}: ${#volumes[@]} volumes, $(du -sh "${HOST_DIR}/${stamp}" | cut -f1), $(($(date +%s) - started)) s"
if [ "${#failed[@]}" -gt 0 ]; then
  die "${#failed[@]} of ${#volumes[@]} volumes failed to export (${failed[*]}); the set is kept and marked incomplete"
fi
