#!/usr/bin/env bash
# Restore one workspace's home from a backup set, for the backup channel
# (docs/adr/0039-backup-channel-and-host-held-key.md).  Runs as root, because
# only root can read the key; everything that talks to the VM runs as the
# operator's account.
#
# Usage:
#   restore-copy.sh --operator <user> --vm-name <name> copy <vm-ip> <set-dir> <instance> <dir>
#       stream the home into /home/student/<dir> inside the running
#       workspace, written by the student's own account (uid 1000)
#   restore-copy.sh --operator <user> --vm-name <name> import <vm-ip> <set-dir> <instance>
#       import the home volume as <instance>-home-import with the backup's
#       ID map, for the controller's replace-home swap
#
# "~" in messages is literal: they are shown to an administrator.
# shellcheck disable=SC2088
# A user-facing reason is the last "FAIL: " line on standard error.
#
# Environment:
#   PORTIKUS_BACKUP_KEY            private age key (default /etc/portikus-backup/age-key.txt)
#   PORTIKUS_RESTORE_CALL_TIMEOUT  seconds a short command on the VM may take (default 60)
set -euo pipefail
umask 077

KEY="${PORTIKUS_BACKUP_KEY:-/etc/portikus-backup/age-key.txt}"
# The VM is not trusted to answer: every remote call has a host-side time limit.
CALL_TIMEOUT="${PORTIKUS_RESTORE_CALL_TIMEOUT:-60}"
[[ "$CALL_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] || CALL_TIMEOUT=60
POOL=workspace-data
PROJECT=portikus
HOME_DIR=/home/student
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
RESTORE_DIR_PATTERN='^restored-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$'
HOSTNAME_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'
USER_PATTERN='^[a-z_][a-z0-9_-]{0,31}$'
IP_PATTERN='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
# Every line backup.sh writes, as restore.sh checks them.
MANIFEST_LINE='^(portikus-backup 1|created [0-9]{8}T[0-9]{6}Z|vm [0-9.]+|package [0-9A-Za-z.+~:-]+|counts users [0-9]+ workspaces [0-9]+ projects [0-9]+|workspace [0-9a-f-]{36} (ws-[0-9a-f]{24}|-)|file (db\.dump|dex\.dump|users\.json) [0-9]+ [0-9a-f]{64}|volume ws-[0-9a-f]{24}-(home|recovery) [0-9]+ [0-9a-f]{64} (-|\[[][{}":,A-Za-z0-9]*\])|failed ws-[0-9a-f]{24}-(home|recovery)|skipped [0-9]{1,7}|seconds [0-9]+)$'

die() { printf '[restore-copy] FAIL: %s\n' "$*" >&2; exit 1; }
info() { printf '[restore-copy] %s\n' "$*"; }

OPERATOR="" VM_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --operator) OPERATOR="${2:?--operator needs a value}"; shift 2 ;;
    --vm-name) VM_NAME="${2:?--vm-name needs a value}"; shift 2 ;;
    *) break ;;
  esac
done
MODE="${1:-}"
VM="${2:-}"
SET="${3:-}"
INSTANCE="${4:-}"
DIR="${5:-}"
case "$MODE" in copy | import) ;; *) die "usage: restore-copy.sh --operator U --vm-name N copy|import <vm-ip> <set-dir> <instance> [<dir>]" ;; esac
[[ "$OPERATOR" =~ $USER_PATTERN ]] || die "--operator is not a user name"
[[ "$VM_NAME" =~ $HOSTNAME_PATTERN ]] || die "--vm-name is not a hostname"
[[ "$VM" =~ $IP_PATTERN ]] || die "not an IPv4 address"
[[ "$INSTANCE" =~ $INSTANCE_PATTERN ]] || die "refused by the host: not an instance name"
STAMP=$(basename "$SET")
[[ "$STAMP" =~ $SET_PATTERN ]] || die "refused by the host: not a set name"
if [ "$MODE" = copy ]; then
  [[ "$DIR" =~ $RESTORE_DIR_PATTERN ]] || die "refused by the host: not a restore folder name"
  [ "$DIR" = "restored-${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2}-${STAMP:9:4}" ] \
    || die "refused by the host: the folder does not match the set"
fi
if [ -L "$SET" ] || [ ! -d "$SET" ]; then die "refused by the host: there is no set ${STAMP}"; fi

# Root-only, as backup-install-key installs it; anything looser is a mistake to stop on.
key_dir=$(dirname "$KEY")
if [ ! -f "$KEY" ] || [ -L "$KEY" ] || [ ! -s "$KEY" ]; then
  die "The restore key is not installed on the host (make backup-install-key)."
fi
if [ "$(stat -c '%u %a' "$KEY")" != "$(id -u) 600" ] || [ "$(stat -c '%u %a' "$key_dir")" != "$(id -u) 700" ]; then
  die "The restore key on the host is not root-only (0600 in a 0700 directory); nothing was restored."
fi

scratch=$(mktemp -d)
created=no
cleanup() {
  # Only a folder this run made is removed, so a retry does not see a collision.
  [ "$created" = no ] || in_ws rm -rf --one-file-system "${HOME_DIR}/${DIR}" || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# regular NAME -- the set's file NAME, refused unless it is a plain file.
regular() {
  local f="${SET}/$1"
  if [ -L "$f" ] || [ ! -f "$f" ]; then return 1; fi
}
decrypt() { age -d -i "$KEY" "${SET}/$1.age"; }

VOL="${INSTANCE}-home"
regular MANIFEST.age || die "refused by the host: the set has no MANIFEST"
decrypt MANIFEST >"${scratch}/MANIFEST" || die "The restore key cannot open this set's MANIFEST."
while IFS= read -r line; do
  [[ "$line" =~ $MANIFEST_LINE ]] || die "refused by the host: the set's MANIFEST is not in the expected form"
done <"${scratch}/MANIFEST"
head -1 "${scratch}/MANIFEST" | grep -qx 'portikus-backup 1' || die "refused by the host: unknown MANIFEST format"
idmap=$(awk -v v="$VOL" '$1 == "volume" && $2 == v { print $5 }' "${scratch}/MANIFEST")
[ -n "$idmap" ] || die "refused by the host: set ${STAMP} does not hold ${VOL}"
regular "${VOL}.age" || die "refused by the host: set ${STAMP} does not hold ${VOL}"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
vm() { timeout -k 5 "$CALL_TIMEOUT" runuser -u "$OPERATOR" -- ssh -n "${SSH_OPTS[@]}" "deploy@${VM}" "$@"; }
# vm_in SECONDS CMD -- a stream from standard input, with its own time limit.
vm_in() { local t=$1; shift; timeout -k 5 "$t" runuser -u "$OPERATOR" -- ssh "${SSH_OPTS[@]}" "deploy@${VM}" "$@"; }
# The stream's limit: 10 minutes plus 1 second per 5 MB of the encrypted volume, at most 6 hours.
stream_seconds() {
  local size t
  size=$(stat -c %s "${SET}/${VOL}.age")
  t=$((600 + size / 5000000))
  [ "$t" -le 21600 ] || t=21600
  echo "$t"
}
q() { printf '%q' "$1"; }
# in_ws CMD... -- run CMD in the workspace as the student, never as root.
in_ws() {
  vm "sudo incus exec $(q "$INSTANCE") --project ${PROJECT} --user 1000 --group 1000 --cwd ${HOME_DIR} --env HOME=${HOME_DIR} -- $(printf '%q ' "$@")"
}

# Decrypted data goes only to the VM the state names.
actual=$(vm hostname) || die "could not reach ${VM}"
[ "$actual" = "$VM_NAME" ] || die "refused by the host: ${VM} calls itself something other than ${VM_NAME}"

if [ "$MODE" = copy ]; then
  regular "${VOL}.index.age" || die "refused by the host: set ${STAMP} has no index for ${VOL}"
  # The copy's size is the sum of the index's file sizes.
  need=$(decrypt "${VOL}.index" | python3 -c '
import json, sys
total = 0
for n, line in enumerate(sys.stdin, 1):
    r = json.loads(line)
    if "f" in r:
        if not (isinstance(r.get("size"), int) and r["size"] >= 0):
            sys.exit(f"index line {n} is not in the expected form")
        total += r["size"]
    elif "git" not in r:
        sys.exit(f"index line {n} is not in the expected form")
print(total)') || die "refused by the host: the set's index for ${VOL} is not in the expected form"

  state=$(vm "sudo incus list $(q "$INSTANCE") --project ${PROJECT} --format csv --columns ns") || die "could not ask ${VM} about ${INSTANCE}"
  grep -qx "${INSTANCE},RUNNING" <<<"$state" || die "The workspace is not running. Start it, then try again."

  # test answers 1 for "absent"; anything else (a time limit, a lost connection) is not an answer.
  rc=0
  in_ws test -e "${HOME_DIR}/${DIR}" -o -L "${HOME_DIR}/${DIR}" || rc=$?
  case "$rc" in
    0) die "~/${DIR} already exists. Rename or delete it, then try again." ;;
    1) ;;
    *) die "could not check ~/${DIR} in the workspace; nothing was copied" ;;
  esac
  avail=$(in_ws df -B1 --output=avail "$HOME_DIR" | tail -1 | tr -d ' ')
  [[ "$avail" =~ ^[0-9]+$ ]] || die "could not read the free space in the workspace's home"
  # Room for the copy and 5% of the free space to spare.
  if [ "$need" -gt $((avail - avail / 20)) ]; then
    die "There is not enough room in this workspace's home for the copy."
  fi

  in_ws mkdir "${HOME_DIR}/${DIR}" || die "~/${DIR} could not be made. Rename or delete anything by that name, then try again."
  created=yes
  info "copying ${VOL} from set ${STAMP} into ~/${DIR} (${need} bytes)"
  decrypt "$VOL" | vm_in "$(stream_seconds)" "sudo incus exec $(q "$INSTANCE") --project ${PROJECT} --user 1000 --group 1000 --cwd ${HOME_DIR} --env HOME=${HOME_DIR} -- tar -xz --strip-components=2 -C $(q "${HOME_DIR}/${DIR}") backup/volume" \
    || die "The copy into ~/${DIR} failed part way; nothing was kept."
  created=no
  info "copied ${VOL} from set ${STAMP} into ~/${DIR}"
  exit 0
fi

IMPORT="${INSTANCE}-home-import"
# A leftover of an interrupted import is replaced; Incus refuses to delete one in use.
if vm "sudo incus storage volume show ${POOL} $(q "$IMPORT") --project ${PROJECT} >/dev/null 2>&1"; then
  vm "sudo incus storage volume delete ${POOL} $(q "$IMPORT") --project ${PROJECT}" \
    || die "${IMPORT} already exists and could not be removed"
fi
info "importing ${VOL} from set ${STAMP} as ${IMPORT}"
decrypt "$VOL" | vm_in "$(stream_seconds)" "sudo incus storage volume import ${POOL} /dev/stdin $(q "$IMPORT") --project ${PROJECT} -q" \
  || die "The import of the backed-up home failed."
if [ "$idmap" != "-" ]; then
  vm "sudo incus storage volume set ${POOL} $(q "$IMPORT") --project ${PROJECT} volatile.idmap.last=$(q "$idmap")" \
    || die "could not record the backup's ID map on ${IMPORT}"
fi
info "imported ${IMPORT}"
