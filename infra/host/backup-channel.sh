#!/usr/bin/env bash
# Host half of the backup channel (docs/adr/0039-backup-channel-and-host-held-key.md).
# portikus-backup-channel.timer runs it as root every 30 seconds.  Each run
# asks the VM for at most one claimed request, checks it, runs it, and sends
# the VM the result and a fresh status.  The VM never writes to the host.
#
# The VM is not trusted (ADR 0024): a request is parsed with a size cap and
# every value is checked against a strict pattern before it reaches a path or
# a command.  Anything else is reported failed and nothing runs.  Everything
# that talks to the VM runs as the operator's account, whose key the VM
# already trusts; only the restore steps read the private key, as root.
#
# Usage: backup-channel.sh --operator <user> --vm-name <name> <vm-ip>
#        backup-channel.sh --local
#   --operator  the account that runs the nightly backup and owns the sets
#   --vm-name   the VM's name in the OpenTofu state; its sets are <dir>/<name>
#   --local     serve the server this runs on, with no SSH: the requests come
#               from its own unprivileged worker, still untrusted, and the
#               sets are <dir>/local (an apt-installed host, ADR 0044)
#
# Environment:
#   PORTIKUS_BACKUP_DIR            one directory of sets per VM (default /var/backups/portikus)
#   PORTIKUS_BACKUP_RECIPIENTS     age recipients file, passed to backup.sh
#   PORTIKUS_BACKUP_KEY            private age key (default /etc/portikus-backup/age-key.txt)
#   PORTIKUS_BACKUP_NIGHTLY        nightly unit to report on, empty for none (default portikus-backup)
#   PORTIKUS_BACKUP_CHANNEL_STATE  state directory (default /var/lib/portikus-backup-channel)
#   PORTIKUS_BACKUP_CMD            backup.sh (default: portikus-backup beside this script)
#   PORTIKUS_RESTORE_COPY_CMD      restore-copy.sh (default: portikus-restore-copy beside this script)
#   PORTIKUS_BACKUP_MIN_AGE_DAYS   a delete never removes a set younger than this (default 14)
#   PORTIKUS_BACKUP_MIN_FREE_MB    a requested backup needs this much free space at least (default 1024)
#   PORTIKUS_BACKUP_MAX_REQUESTED  requested sets younger than the minimum age allowed at once (default 3)
#   PORTIKUS_BACKUP_KEEP_COMPLETE  a delete always keeps this many newest complete sets (default 3)
#   PORTIKUS_BACKUP_MIN_GAP_MINUTES  a requested backup waits this long after the last one (default 60)
set -euo pipefail
umask 077

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
BACKUP_DIR="${PORTIKUS_BACKUP_DIR:-/var/backups/portikus}"
RECIPIENTS="${PORTIKUS_BACKUP_RECIPIENTS:-}"
KEY="${PORTIKUS_BACKUP_KEY:-/etc/portikus-backup/age-key.txt}"
NIGHTLY="${PORTIKUS_BACKUP_NIGHTLY-portikus-backup}"
STATE="${PORTIKUS_BACKUP_CHANNEL_STATE:-/var/lib/portikus-backup-channel}"
BACKUP_CMD="${PORTIKUS_BACKUP_CMD:-${here}/portikus-backup}"
RESTORE_COPY_CMD="${PORTIKUS_RESTORE_COPY_CMD:-${here}/portikus-restore-copy}"
# The retention floor comes from the unit, never from a request (ADR 0039).
MIN_AGE_DAYS="${PORTIKUS_BACKUP_MIN_AGE_DAYS:-14}"
MIN_FREE_MB="${PORTIKUS_BACKUP_MIN_FREE_MB:-1024}"
MAX_REQUESTED="${PORTIKUS_BACKUP_MAX_REQUESTED:-3}"
[[ "$MIN_FREE_MB" =~ ^[0-9]{1,9}$ ]] || MIN_FREE_MB=1024
[[ "$MAX_REQUESTED" =~ ^[0-9]{1,3}$ ]] || MAX_REQUESTED=3
KEEP_COMPLETE="${PORTIKUS_BACKUP_KEEP_COMPLETE:-3}"
[[ "$MIN_AGE_DAYS" =~ ^[0-9]{1,4}$ ]] || MIN_AGE_DAYS=14
[[ "$KEEP_COMPLETE" =~ ^[0-9]{1,3}$ ]] || KEEP_COMPLETE=3
MIN_GAP_MINUTES="${PORTIKUS_BACKUP_MIN_GAP_MINUTES:-60}"
[[ "$MIN_GAP_MINUTES" =~ ^[0-9]{1,4}$ ]] || MIN_GAP_MINUTES=60
# A real request line is under 300 bytes.
PULL_MAX_BYTES=4096
HEARTBEAT_SECONDS=30

# The same forms as packages/contracts/src/backups.ts.
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
DUMP_PATTERN='^portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump$'
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
RESTORE_DIR_PATTERN='^restored-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}$'
UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
HOSTNAME_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'
USER_PATTERN='^[a-z_][a-z0-9_-]{0,31}$'
IP_PATTERN='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'

# Reads the file pull wrote and prints one tab-separated line:
#   none | ok KIND ID STAMP INSTANCE FILE DIR | refused ID-or-- REASON
# with "-" for an argument the kind does not take.
PARSE_REQUEST='
import json, re, sys
MAX = int(sys.argv[2])
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
PAT = {
    "stamp": re.compile(r"[0-9]{8}T[0-9]{6}Z"),
    "file": re.compile(r"portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump"),
    "instance": re.compile(r"ws-[0-9a-f]{24}"),
    "dir": re.compile(r"restored-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}"),
}
ARGS = {
    "backup": [],
    "delete_set": ["stamp"],
    "delete_dump": ["file"],
    "restore_copy": ["stamp", "instance", "dir"],
    "import_home": ["stamp", "instance"],
}
def refuse(reason, rid="-"):
    print(f"refused\t{rid}\t{reason}")
    sys.exit(0)
def unique(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)
raw = open(sys.argv[1], "rb").read()
if not raw.strip():
    print("none")
    sys.exit(0)
if len(raw) > MAX:
    refuse("the request is too large")
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError:
    refuse("the request is not UTF-8")
if text.endswith("\n"):
    text = text[:-1]
if "\n" in text or "\r" in text:
    refuse("the request is more than one line")
try:
    req = json.loads(text, object_pairs_hook=unique)
except (ValueError, RecursionError):
    refuse("the request is not JSON")
if not isinstance(req, dict):
    refuse("the request is not an object")
rid = req.get("id")
if not (isinstance(rid, str) and UUID.fullmatch(rid)):
    refuse("the request has no valid id")
if set(req) != {"id", "kind", "args"}:
    refuse("the request has unknown or missing fields", rid)
kind, args = req["kind"], req["args"]
if not (isinstance(kind, str) and kind in ARGS):
    refuse("unknown kind", rid)
if not isinstance(args, dict) or set(args) != set(ARGS[kind]):
    refuse("wrong arguments for " + kind, rid)
for name in ARGS[kind]:
    v = args[name]
    if not (isinstance(v, str) and PAT[name].fullmatch(v)):
        refuse(name + " is not in the expected form", rid)
if kind == "restore_copy":
    s = args["stamp"]
    if args["dir"] != f"restored-{s[0:4]}-{s[4:6]}-{s[6:8]}-{s[9:13]}":
        refuse("dir does not match the set", rid)
print("\t".join(["ok", kind, rid] + [args.get(n, "-") for n in ("stamp", "instance", "file", "dir")]))
'

# Prints the report document (BackupChannelReport) to stdout.
#   argv: host_dir vm state_dir running nightly_file request_file max_bytes
BUILD_REPORT='
import json, os, re, stat, sys, time
from datetime import datetime, timezone
host_dir, vm, state, running, nightly_file, request_file, max_bytes = sys.argv[1:8]
SET = re.compile(r"[0-9]{8}T[0-9]{6}Z")
DUMP = re.compile(r"portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump")
VOLFILE = re.compile(r"(ws-[0-9a-f]{24})-(home|recovery)\.age")
FAILED = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
def iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).isoformat(timespec="seconds")
def one_line(s, n):
    s = "".join(c if 32 <= ord(c) < 127 else " " for c in s).strip()
    return s[:n]
def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""
kv = {}
for line in read(nightly_file).splitlines():
    k, _, v = line.partition("=")
    kv[k] = v
def unix(v):
    m = re.fullmatch(r"@([0-9]+)", v or "")
    return int(m.group(1)) if m else None
runs = []
n_start, n_end = unix(kv.get("ExecMainStartTimestamp")), unix(kv.get("ExecMainExitTimestamp"))
nightly_active = kv.get("ActiveState") in ("active", "activating", "deactivating", "reloading")
if n_start and n_end and n_end >= n_start and not nightly_active:
    runs.append((n_start, n_end, "success" if kv.get("Result") == "success" else "failed"))
parts = read(os.path.join(state, "last-run")).split()
if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit() and parts[2] in ("success", "failed"):
    runs.append((int(parts[0]), int(parts[1]), parts[2]))
last_run = None
if runs:
    s, e, r = max(runs)
    last_run = {"startedAt": iso(s), "endedAt": iso(e), "result": r}
last_failure = None
at, _, reason = read(os.path.join(state, "last-failure")).partition(" ")
if at.isdigit():
    last_failure = {"at": iso(at), "reason": one_line(reason, 300) or "failed"}
next_run = kv.get("NextRun")
next_run = iso(next_run) if next_run and next_run.isdigit() else None
if running == "" and nightly_active:
    running = "nightly"

def lstat(p):
    try:
        return os.lstat(p)
    except OSError:
        return None
def size_of(top):
    total = 0
    for root, dirs, files in os.walk(top):
        for n in files + dirs:
            st = lstat(os.path.join(root, n))
            if st and stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total
sets = []
st = lstat(host_dir)
if st and stat.S_ISDIR(st.st_mode):
    names = sorted((e.name for e in os.scandir(host_dir) if e.is_dir(follow_symlinks=False) and SET.fullmatch(e.name)), reverse=True)[:60]
    for name in names:
        top = os.path.join(host_dir, name)
        instances = sorted({m.group(1) for e in os.scandir(top) if e.is_file(follow_symlinks=False) and (m := VOLFILE.fullmatch(e.name))})[:2000]
        fpath = os.path.join(top, "FAILED")
        fst = lstat(fpath)
        failed = []
        if fst and stat.S_ISREG(fst.st_mode) and fst.st_size <= 1 << 20:
            failed = [l for l in read(fpath).splitlines() if FAILED.fullmatch(l)][:4000]
        skipped = 0
        sst = lstat(os.path.join(top, "SKIPPED"))
        if sst and stat.S_ISREG(sst.st_mode) and sst.st_size <= 16:
            text = read(os.path.join(top, "SKIPPED")).strip()
            skipped = int(text) if text.isdigit() and len(text) <= 7 else 0
        sets.append({"stamp": name, "complete": fst is None, "sizeBytes": size_of(top), "instances": instances, "failedVolumes": failed, "skippedVolumes": skipped})
dumps = []
ddir = os.path.join(host_dir, "dumps")
st = lstat(ddir)
if st and stat.S_ISDIR(st.st_mode):
    for e in os.scandir(ddir):
        if e.is_file(follow_symlinks=False) and DUMP.fullmatch(e.name):
            s = e.stat(follow_symlinks=False)
            dumps.append((s.st_mtime, e.name, s.st_size))
    dumps = [{"file": n, "sizeBytes": z, "modifiedAt": iso(m)} for m, n, z in sorted(dumps, reverse=True)[:200]]
request = None
if request_file:
    request = json.loads(read(request_file))
status = {
    "vm": vm,
    "reportedAt": iso(time.time()),
    "nextRunAt": next_run,
    "lastRun": last_run,
    "lastFailure": last_failure,
    "running": running or None,
    "keyInstalled": os.environ.get("CH_KEY_INSTALLED") == "yes",
    "sets": sets,
    "dumps": dumps,
}
doc = {"request": request, "status": status}
# The VM refuses a larger document; the oldest sets go first.
while len(json.dumps(doc)) > int(max_bytes) and (status["sets"] or status["dumps"]):
    (status["sets"] or status["dumps"]).pop()
print(json.dumps(doc))
'

# Writes a request result (the "request" part of the report) to argv[1].
WRITE_RESULT='
import json, sys
path, rid, state, error, stamp = sys.argv[1:6]
error = "".join(c if 32 <= ord(c) < 127 else " " for c in error).strip()[:500]
json.dump({"id": rid, "state": state, "error": error or None, "stamp": stamp or None}, open(path, "w"))
'

info() { printf '[backup-channel] %s\n' "$*"; }
die() { printf '[backup-channel] FAIL: %s\n' "$*" >&2; exit 1; }

OPERATOR="" VM_NAME="" LOCAL=no
while [ $# -gt 0 ]; do
  case "$1" in
    --operator) OPERATOR="${2:?--operator needs a value}"; shift 2 ;;
    --vm-name) VM_NAME="${2:?--vm-name needs a value}"; shift 2 ;;
    --local) LOCAL=yes; shift ;;
    *) break ;;
  esac
done
if [ "$LOCAL" = yes ]; then
  if [ -n "$OPERATOR$VM_NAME" ] || [ $# -gt 0 ]; then die "--local takes no other option"; fi
  OPERATOR=root VM_NAME=local VM=127.0.0.1
else
  VM="${1:?Usage: backup-channel.sh --operator <user> --vm-name <name> <vm-ip>}"
fi
[[ "$OPERATOR" =~ $USER_PATTERN ]] || die "--operator '${OPERATOR}' is not a user name"
[[ "$VM_NAME" =~ $HOSTNAME_PATTERN ]] || die "--vm-name '${VM_NAME}' is not a hostname"
[[ "$VM" =~ $IP_PATTERN ]] || die "'${VM}' is not an IPv4 address"
command -v python3 >/dev/null || die "python3 is not installed"
HOST_DIR="${BACKUP_DIR}/${VM_NAME}"

install -d -m 0700 "$STATE"
exec {lock}>"${STATE}/lock"
# A long job holds the lock; the next timer run has nothing to do.
flock -n "$lock" || { info "another channel run is active"; exit 0; }
scratch=$(mktemp -d)
heartbeat=""
cleanup() {
  [ -z "$heartbeat" ] || kill "$heartbeat" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
vm() { runuser -u "$OPERATOR" -- ssh -n "${SSH_OPTS[@]}" "deploy@${VM}" "$@"; }
vm_in() { runuser -u "$OPERATOR" -- ssh "${SSH_OPTS[@]}" "deploy@${VM}" "$@"; }
# as_operator CMD... -- CMD as the account that owns the sets: root on a local server.
as_operator() { runuser -u "$OPERATOR" -- "$@"; }
if [ "$LOCAL" = yes ]; then
  # The same commands as over SSH, run here; this is already root, so sudo is a no-op.
  sudo() { "$@"; }
  export -f sudo
  vm() { bash -c "$*" </dev/null; }
  vm_in() { bash -c "$*"; }
  as_operator() { "$@"; }
fi

# The key counts as installed only in the root-only form backup-install-key makes.
key_installed() {
  local dir
  dir=$(dirname "$KEY")
  [ -f "$KEY" ] && [ ! -L "$KEY" ] && [ -s "$KEY" ] \
    && [ "$(stat -c '%u %a' "$KEY")" = "$(id -u) 600" ] \
    && [ "$(stat -c '%u %a' "$dir")" = "$(id -u) 700" ]
}

# The nightly unit's state as systemctl prints it, plus NextRun in Unix seconds.
nightly_state() {
  [ -n "$NIGHTLY" ] || return 0
  systemctl show "${NIGHTLY}.service" --timestamp=unix \
    -p ActiveState -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp 2>/dev/null || true
  local next
  next=$(systemctl show "${NIGHTLY}.timer" -p NextElapseUSecRealtime --value 2>/dev/null || true)
  [ -z "$next" ] || echo "NextRun=$(date -d "$next" +%s 2>/dev/null || true)"
}

nightly_active() {
  [ -n "$NIGHTLY" ] && systemctl is-active --quiet "${NIGHTLY}.service"
}

# A failed nightly run becomes the last failure once, with its last FAIL line.
record_nightly_failure() {
  local result start end previous reason
  result=$(sed -n 's/^Result=//p' "${scratch}/nightly")
  start=$(sed -n 's/^ExecMainStartTimestamp=@//p' "${scratch}/nightly")
  end=$(sed -n 's/^ExecMainExitTimestamp=@//p' "${scratch}/nightly")
  [[ "$start" =~ ^[0-9]+$ && "$end" =~ ^[0-9]+$ ]] || return 0
  if [ "$result" = success ] || [ "$end" -lt "$start" ]; then return 0; fi
  previous=$(cut -d' ' -f1 "${STATE}/last-failure" 2>/dev/null || echo 0)
  [[ "$previous" =~ ^[0-9]+$ ]] || previous=0
  [ "$end" -gt "$previous" ] || return 0
  reason=$(journalctl -u "${NIGHTLY}.service" -o cat --since "@${start}" --no-pager 2>/dev/null \
    | sed -n 's/^\[backup\] FAIL: //p' | tail -1 || true)
  printf '%s %s\n' "$end" "nightly backup: ${reason:-failed (${result})}" >"${STATE}/last-failure"
}

# report RUNNING [REQUEST-FILE] -- send the VM a report; fails if it is not taken.
report() {
  local out="${scratch}/report.$$.${RANDOM}.json"
  if key_installed; then export CH_KEY_INSTALLED=yes; else export CH_KEY_INSTALLED=no; fi
  python3 -c "$BUILD_REPORT" "$HOST_DIR" "$VM_NAME" "$STATE" "$1" "${scratch}/nightly" "${2:-}" 262144 >"$out"
  vm_in sudo portikus backup-channel report <"$out" >/dev/null
}

# finish ID STATE ERROR STAMP -- keep the result until the VM has taken it.
finish() {
  python3 -c "$WRITE_RESULT" "${STATE}/pending.json" "$1" "$2" "$3" "$4"
  info "request $1: $2${3:+: $3}"
  report "" "${STATE}/pending.json" || die "could not report request $1; the next run retries"
  rm -f "${STATE}/pending.json"
}

start_heartbeat() {
  (
    trap - EXIT
    # Its orphaned sleep must not hold the run lock after the job ends.
    exec {lock}>&-
    while sleep "$HEARTBEAT_SECONDS"; do report "$1" || true; done
  ) &
  heartbeat=$!
}
stop_heartbeat() {
  [ -z "$heartbeat" ] || { kill "$heartbeat" 2>/dev/null || true; wait "$heartbeat" 2>/dev/null || true; }
  heartbeat=""
}

list_sets() {
  [ -d "$HOST_DIR" ] || return 0
  find "$HOST_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | { grep -E "$SET_PATTERN" || true; } | sort -r
}

newest_complete_set() {
  local s
  for s in $(list_sets); do
    [ -e "${HOST_DIR}/${s}/FAILED" ] || { echo "$s"; return 0; }
  done
}

# newest_complete_sets N -- the N newest complete sets, newest first.
newest_complete_sets() {
  local s n=0
  for s in $(list_sets); do
    [ "$n" -lt "$1" ] || return 0
    [ -e "${HOST_DIR}/${s}/FAILED" ] || { echo "$s"; n=$((n + 1)); }
  done
}

# enough_free_space -- is there room in BACKUP_DIR for one more set: the
# newest complete set's size plus a fifth, and at least MIN_FREE_MB? The
# same check as in backup.sh (ADR 0039).
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

# young_requested_sets -- how many sets this channel made on request are
# younger than the minimum age.  REQUESTED is written here, never by the VM.
young_requested_sets() {
  local s n=0 now
  now=$(date +%s)
  for s in $(list_sets); do
    [ -e "${HOST_DIR}/${s}/REQUESTED" ] || continue
    [ $((now - $(stamp_epoch "$s"))) -ge $((MIN_AGE_DAYS * 86400)) ] || n=$((n + 1))
  done
  echo "$n"
}

# stamp_epoch STAMP -- seconds since the epoch for a set name.
stamp_epoch() {
  local s=$1
  date -u -d "${s:0:4}-${s:4:2}-${s:6:2}T${s:9:2}:${s:11:2}:${s:13:2}Z" +%s
}

# last_fail FILE -- the text of the last "FAIL: " line a script wrote.
last_fail() { sed -n 's/^\[[a-z -]*\] FAIL: //p' "$1" | tail -1; }

# Each job sets these three.
job_state="" job_error="" job_stamp=""
job_fail() { job_state=failed job_error=$1; }

run_backup() {
  local id=$1 before after start end err="${scratch}/backup.err"
  local env=(PORTIKUS_BACKUP_DIR="$BACKUP_DIR" PORTIKUS_BACKUP_MIN_AGE_DAYS="$MIN_AGE_DAYS" PORTIKUS_BACKUP_KEEP_COMPLETE="$KEEP_COMPLETE" PORTIKUS_BACKUP_MIN_FREE_MB="$MIN_FREE_MB")
  [ -z "${PORTIKUS_BACKUP_MAX_INDEX_ENTRIES:-}" ] || env+=(PORTIKUS_BACKUP_MAX_INDEX_ENTRIES="$PORTIKUS_BACKUP_MAX_INDEX_ENTRIES")
  local last_end ago
  [ -z "$RECIPIENTS" ] || env+=(PORTIKUS_BACKUP_RECIPIENTS="$RECIPIENTS")
  if nightly_active; then job_fail "A backup is already running."; return; fi
  # A compromised VM must not queue backups back to back (ADR 0039).
  last_end=$(awk '{print $2}' "${STATE}/last-run" 2>/dev/null || true)
  if [[ "$last_end" =~ ^[0-9]{1,12}$ ]]; then
    ago=$(( ($(date +%s) - last_end) / 60 ))
    if [ "$ago" -lt "$MIN_GAP_MINUTES" ]; then
      job_fail "refused by the host: a backup ran ${ago} minutes ago"
      return
    fi
  fi
  # The floor keeps young sets, so cap how many of them a VM can ask for.
  if [ "$(young_requested_sets)" -ge "$MAX_REQUESTED" ]; then
    job_fail "refused by the host: ${MAX_REQUESTED} requested backups in the last ${MIN_AGE_DAYS} days"
    return
  fi
  if ! enough_free_space; then
    job_fail "refused by the host: not enough free space"
    return
  fi
  before=$(list_sets)
  start=$(date +%s)
  info "request ${id}: backup of ${VM_NAME}"
  local target=(--vm-name "$VM_NAME" "$VM")
  [ "$LOCAL" = no ] || target=(--local)
  if as_operator env "${env[@]}" nice -n 10 ionice -c 3 "$BACKUP_CMD" "${target[@]}" 2>"$err"; then
    job_state="done"
  else
    job_fail "$(last_fail "$err")"
    [ -n "$job_error" ] || job_error="the backup failed"
  fi
  cat "$err" >&2
  end=$(date +%s)
  after=$(list_sets)
  job_stamp=$(comm -13 <(sort <<<"$before") <(sort <<<"$after") | sort -r | head -1)
  [[ "$job_stamp" =~ $SET_PATTERN ]] || job_stamp=""
  [ -z "$job_stamp" ] || : >"${HOST_DIR}/${job_stamp}/REQUESTED"
  if [ "$job_state" = "done" ]; then
    echo "${start} ${end} success" >"${STATE}/last-run"
  else
    echo "${start} ${end} failed" >"${STATE}/last-run"
    printf '%s %s\n' "$end" "backup requested from the admin page: ${job_error}" >"${STATE}/last-failure"
  fi
}

run_delete_set() {
  local stamp=$1 dir="${HOST_DIR}/${1}"
  [[ "$stamp" =~ $SET_PATTERN ]] || { job_fail "refused by the host: not a set name"; return; }
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then job_fail "refused by the host: there is no set ${stamp}"; return; fi
  if [ "$stamp" = "$(newest_complete_set)" ]; then
    job_fail "refused by the host: ${stamp} is the newest complete set"
    return
  fi
  if newest_complete_sets "$KEEP_COMPLETE" | grep -qx "$stamp"; then
    job_fail "refused by the host: retention floor (the newest ${KEEP_COMPLETE} complete sets are kept)"
    return
  fi
  if [ $(( $(date +%s) - $(stamp_epoch "$stamp") )) -lt $((MIN_AGE_DAYS * 86400)) ]; then
    job_fail "refused by the host: retention floor (sets younger than ${MIN_AGE_DAYS} days are kept)"
    return
  fi
  rm -rf -- "$dir"
  job_state="done"
}

run_delete_dump() {
  local file=$1 dumps="${HOST_DIR}/dumps"
  [[ "$file" =~ $DUMP_PATTERN ]] || { job_fail "refused by the host: not a dump name"; return; }
  if [ -L "$dumps" ] || [ -L "${dumps}/${file}" ] || [ ! -f "${dumps}/${file}" ]; then
    job_fail "refused by the host: there is no dump ${file}"
    return
  fi
  rm -f -- "${dumps}/${file}"
  job_state="done"
}

# run_restore MODE STAMP INSTANCE [DIR] -- MODE is copy or import.
run_restore() {
  local mode=$1 stamp=$2 instance=$3 dir=${4:-} err="${scratch}/restore.err"
  [[ "$stamp" =~ $SET_PATTERN && "$instance" =~ $INSTANCE_PATTERN ]] \
    || { job_fail "refused by the host: not a set or instance name"; return; }
  if [ "$mode" = copy ] && ! [[ "$dir" =~ $RESTORE_DIR_PATTERN ]]; then
    job_fail "refused by the host: not a restore folder name"
    return
  fi
  local target=(--operator "$OPERATOR" --vm-name "$VM_NAME")
  [ "$LOCAL" = no ] || target=(--local)
  if PORTIKUS_BACKUP_KEY="$KEY" "$RESTORE_COPY_CMD" "${target[@]}" \
    "$mode" "$VM" "${HOST_DIR}/${stamp}" "$instance" ${dir:+"$dir"} 2>"$err"; then
    job_state="done"
  else
    job_fail "$(last_fail "$err")"
    [ -n "$job_error" ] || job_error="the restore failed"
  fi
  cat "$err" >&2
}

nightly_state >"${scratch}/nightly"
record_nightly_failure

# A result the VM has not taken yet goes before anything new is claimed.
if [ -s "${STATE}/pending.json" ]; then
  report "" "${STATE}/pending.json" || die "could not reach ${VM}"
  rm -f "${STATE}/pending.json"
fi

# Plain pipefail would make an oversized answer look like a failed ssh.
set +o pipefail
vm sudo portikus backup-channel pull | head -c $((PULL_MAX_BYTES + 1)) >"${scratch}/pull"
pull_rc=${PIPESTATUS[0]}
set -o pipefail
pulled_bytes=$(stat -c %s "${scratch}/pull")
if [ "$pull_rc" != 0 ] && [ "$pulled_bytes" -le "$PULL_MAX_BYTES" ]; then
  die "could not pull from ${VM} (ssh exit ${pull_rc})"
fi

IFS=$'\t' read -r verdict f1 f2 f3 f4 f5 f6 < <(python3 -c "$PARSE_REQUEST" "${scratch}/pull" "$PULL_MAX_BYTES")
case "$verdict" in
  none)
    report "" || die "could not report to ${VM}"
    exit 0
    ;;
  refused)
    printf '[backup-channel] refused a request from the VM: %s\n' "$f2" >&2
    if [[ "$f1" =~ $UUID_PATTERN ]]; then
      finish "$f1" failed "refused by the host: ${f2}" ""
    else
      report "" || die "could not report to ${VM}"
    fi
    exit 0
    ;;
  ok) ;;
  *) die "could not read the request" ;;
esac

kind=$f1 id=$f2 stamp=$f3 instance=$f4 file=$f5 dir=$f6
# Checked once more here, so this file alone shows no unchecked value is used.
[[ "$id" =~ $UUID_PATTERN ]] || die "request id is not in the expected form"

case "$kind" in
  backup | restore_copy | import_home) start_heartbeat "$id" ;;
esac
case "$kind" in
  backup) run_backup "$id" ;;
  delete_set) run_delete_set "$stamp" ;;
  delete_dump) run_delete_dump "$file" ;;
  restore_copy) run_restore copy "$stamp" "$instance" "$dir" ;;
  import_home) run_restore import "$stamp" "$instance" ;;
  *) job_fail "refused by the host: unknown kind" ;;
esac
stop_heartbeat
# The run may have changed the nightly's state or the key; report it fresh.
nightly_state >"${scratch}/nightly"
finish "$id" "$job_state" "$job_error" "$job_stamp"
