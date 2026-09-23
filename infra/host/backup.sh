#!/usr/bin/env bash
# Pull a backup of the platform VM to this host, encrypted with age
# (docs/adr/0024-backups-pulled-to-host.md).  It only reads from the VM:
# a pg_dump, and an export of each workspace's home and recovery volume.
#
# Usage: backup.sh [--check-state] <vm-ip>
#   --check-state  compare workspaces, users and settings before and after,
#                  with the security suite's snapshot helper (repository only)
#
# Environment:
#   PORTIKUS_BACKUP_DIR         where sets go (default /var/backups/portikus)
#   PORTIKUS_BACKUP_RECIPIENTS  age recipients file (default ~/.config/portikus/backup-recipients.txt)
#   PORTIKUS_BACKUP_KEEP        complete sets kept (default 14)
#   PORTIKUS_USERS_FILE         the Dex users file, copied into the set when present
set -euo pipefail
umask 077

BACKUP_DIR="${PORTIKUS_BACKUP_DIR:-/var/backups/portikus}"
RECIPIENTS="${PORTIKUS_BACKUP_RECIPIENTS:-${HOME}/.config/portikus/backup-recipients.txt}"
KEEP="${PORTIKUS_BACKUP_KEEP:-14}"
USERS_FILE="${PORTIKUS_USERS_FILE:-${HOME}/.config/portikus/users.json}"
# The VM half, sent with every command rather than installed on the VM.
EXPORT_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-export"
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
# The VM is not trusted: everything it says must match one of these before
# it reaches a file name or the MANIFEST (restore.sh checks the same forms).
VOLUME_PATTERN='^ws-[0-9a-f]{24}-(home|recovery)$'
WORKSPACE_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} (ws-[0-9a-f]{24}|-)$'
COUNTS_PATTERN='^users [0-9]+ workspaces [0-9]+ projects [0-9]+$'
VERSION_PATTERN='^[0-9A-Za-z.+~:-]+$'
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

check_state=no
if [ "${1:-}" = "--check-state" ]; then check_state=yes; shift; fi
VM="${1:?Usage: backup.sh [--check-state] <vm-ip>}"

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

# One run at a time; the lock goes with the process.
exec {lock}>"${BACKUP_DIR}/.lock"
flock -n "$lock" || die "another backup is running"

started=$(date +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="${BACKUP_DIR}/.partial-${stamp}"
scratch=$(mktemp -d)
# A set is renamed into place only when complete; anything else is removed.
trap 'rm -rf "$scratch" "$work"' EXIT
# Leftovers of a run that was killed; the lock proves none is live.
find "$BACKUP_DIR" -maxdepth 1 -name '.partial-*' -exec rm -rf {} +
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

# must NAME PATTERN VALUE -- stop unless the VM's answer has the expected form.
must() { [[ "$3" =~ $2 ]] || die "the VM sent a ${1} that is not in the expected form; nothing was kept"; }

version=$(vm "dpkg-query -W -f='\${Version}' portikus")
must "package version" "$VERSION_PATTERN" "$version"
counts=$(remote_export counts)
must "row count" "$COUNTS_PATTERN" "$counts"
mapfile -t workspaces < <(remote_export workspaces)
{
  echo "portikus-backup 1"
  echo "created ${stamp}"
  echo "vm ${VM}"
  echo "package ${version}"
  echo "counts ${counts}"
  for ws in "${workspaces[@]}"; do
    must "workspace line" "$WORKSPACE_PATTERN" "$ws"
    echo "workspace ${ws}"
  done
} >"$manifest"

# pull NAME MODE COMMAND... -- stream COMMAND's output from the VM into NAME.age.
pull() {
  local name=$1 mode=$2 sum
  shift 2
  sum="${scratch}/${name}.sum"
  remote_export "$@" \
    | python3 -c "$INDEXER" "$mode" "$sum" "${scratch}/${name}.index" \
    | age -R "$RECIPIENTS" -o "${work}/${name}.age"
  local status=("${PIPESTATUS[@]}")
  [ "${status[*]}" = "0 0 0" ] || die "${name}: the pipeline failed (ssh, index, age: ${status[*]})"
}

info "database"
pull db.dump plain db
echo "file db.dump $(cat "${scratch}/db.dump.sum")" >>"$manifest"

mapfile -t volumes < <(remote_export volumes)
for vol in "${volumes[@]}"; do
  must "volume name" "$VOLUME_PATTERN" "$vol"
done
for vol in "${volumes[@]}"; do
  info "volume ${vol}"
  pull "$vol" tar volume "$vol"
  idmap=$(remote_export idmap "$vol")
  [ -z "$idmap" ] || must "volume ID map" "$IDMAP_PATTERN" "$idmap"
  age -R "$RECIPIENTS" -o "${work}/${vol}.index.age" "${scratch}/${vol}.index"
  echo "volume ${vol} $(cat "${scratch}/${vol}.sum") ${idmap:--}" >>"$manifest"
done

if [ -f "$USERS_FILE" ]; then
  age -R "$RECIPIENTS" -o "${work}/users.json.age" "$USERS_FILE"
  echo "file users.json $(wc -c <"$USERS_FILE") $(sha256sum "$USERS_FILE" | cut -d' ' -f1)" >>"$manifest"
fi

echo "seconds $(($(date +%s) - started))" >>"$manifest"
age -R "$RECIPIENTS" -o "${work}/MANIFEST.age" "$manifest"
mv "$work" "${BACKUP_DIR}/${stamp}"

if [ "$check_state" = yes ]; then
  sec_snapshot_others >"${scratch}/state-after"
  if ! diff -u "${scratch}/state-before" "${scratch}/state-after"; then
    die "workspaces, users or settings changed during the backup (the set is kept)"
  fi
  info "workspaces, users and settings are the same before and after"
fi

# Retention: the newest complete sets stay; nothing else in the directory is touched.
mapfile -t sets < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$SET_PATTERN" | sort -r)
for old in "${sets[@]:$KEEP}"; do
  info "removing old set ${old}"
  rm -rf "${BACKUP_DIR:?}/${old}"
done

info "set ${BACKUP_DIR}/${stamp}: ${#volumes[@]} volumes, $(du -sh "${BACKUP_DIR}/${stamp}" | cut -f1), $(($(date +%s) - started)) s"
