#!/usr/bin/env bash
# Feeds the host half of the backup channel a lying VM, with fakes for ssh,
# runuser, systemctl and journalctl and a real age key.  No VM involved
# (docs/adr/0039-backup-channel-and-host-held-key.md).
#
#   - a request of an unknown kind, extra or missing fields, a stamp, file,
#     instance or folder with "..", "/", a newline or shell syntax, an
#     oversized, malformed or multi-line document is reported "refused by the
#     host", and nothing runs: no backup, no delete, no decryption, no command
#     beyond pull and report reaches the VM;
#   - a delete never removes the newest complete set, a symbolic link, or
#     anything outside this VM's directory, and keeps the host's retention
#     floor (a minimum age and the newest complete sets);
#   - a restore into an instance whose home is not in the set, or onto a VM
#     with another hostname, is refused; a side copy runs as uid 1000 inside
#     the workspace, refuses an existing folder and a copy larger than the
#     free space, cuts a VM call that hangs, and is the only way decrypted
#     data leaves the host;
#   - the private key never reaches the VM, and counts as installed only when
#     it is owner-only in an owner-only directory;
#   - the status report has the contract's shape and stays under 256 KiB;
#   - a result the VM did not take is sent again on the next run.
#
# Usage: ./infra/tests/backup-channel-test.sh
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
channel="${repo}/infra/host/backup-channel.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v age-keygen >/dev/null || { echo "backup-channel-test: age is not installed"; exit 1; }

# shellcheck source=/dev/null
. "${here}/lib.sh"
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

VM_NAME=portikus
VM_IP=10.100.0.120
INST=ws-0123456789abcdef01234567
OTHER=ws-fedcba9876543210fedcba98
ID=0b6f5c3e-8d2a-4c1e-9f7a-1234567890ab
OLD=20260923T023000Z
GOOD=20260924T023000Z
NEWEST=20260926T023000Z
BROKEN=20260927T023000Z

backups="${work}/backups"
sets="${backups}/${VM_NAME}"
keydir="${work}/etc"
key="${keydir}/age-key.txt"
state="${work}/state"
fakes="${work}/fake"
log="${fakes}/calls.log"
mkdir -p "${work}/bin" "$fakes" "$keydir"
chmod 0700 "$keydir"
(umask 077 && age-keygen -o "$key" 2>/dev/null)
age-keygen -y "$key" >"${work}/recipients"
secret=$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "$key")

# ssh: logs each command; stdin it reads is kept under fake/stdin.N.
cat >"${work}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
f=$FAKE_DIR
while [ $# -gt 0 ] && [[ "$1" != deploy@* ]]; do shift; done
shift
cmd="$*"
printf 'ssh %s\n' "$cmd" >>"$f/calls.log"
n=$(wc -l <"$f/calls.log")
case "$cmd" in
  "sudo portikus backup-channel pull")
    [ -z "${FAKE_SSH_FAIL:-}" ] || exit 255
    cat "$f/pull" 2>/dev/null ;;
  "sudo portikus backup-channel report")
    [ -z "${FAKE_SSH_FAIL:-}" ] || exit 255
    cat >"$f/report.$n.json"
    cp "$f/report.$n.json" "$f/last-report.json"
    [ ! -e "$f/report-refuse" ] || { rm -f "$f/report-refuse"; exit 1; } ;;
  hostname) echo "${FAKE_HOSTNAME:-portikus}" ;;
  *"incus list"*) echo "${FAKE_INSTANCE_STATE:-ws-0123456789abcdef01234567,RUNNING}" ;;
  *" -- test -e "*)
    [ -z "${FAKE_HANG:-}" ] || exec sleep 30
    [ -n "${FAKE_DIR_EXISTS:-}" ] ;;
  *" -- df "*) printf 'Avail\n%s\n' "${FAKE_AVAIL:-1000000000}" ;;
  *" -- tar "* | *"storage volume import"*) cat >"$f/stream"; cp "$f/stream" "$f/stdin.$n" ;;
  *"storage volume show"*) [ -n "${FAKE_IMPORT_EXISTS:-}" ] ;;
  *) : ;;
esac
EOF
# runuser -u USER -- CMD...: records the user and runs CMD as this user.
cat >"${work}/bin/runuser" <<'EOF'
#!/usr/bin/env bash
printf 'runuser %s\n' "$2" >>"$FAKE_DIR/calls.log"
shift 3
exec "$@"
EOF
cat >"${work}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "is-active --quiet portikus-backup.service") [ -n "${FAKE_NIGHTLY_ACTIVE:-}" ] ;;
  *"portikus-backup.timer"*) echo "Mon 2026-09-28 02:30:00 UTC" ;;
  *"portikus-backup.service"*)
    echo "ActiveState=${FAKE_NIGHTLY_ACTIVE:+active}"
    echo "Result=${FAKE_NIGHTLY_RESULT:-success}"
    echo "ExecMainStartTimestamp=@1790475000"
    echo "ExecMainExitTimestamp=@1790475600" ;;
esac
EOF
cat >"${work}/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "[backup] volume ws-0123456789abcdef01234567-home"
echo "[backup] FAIL: 1 of 2 volumes failed to export"
EOF
# The backup: logs how it was called and makes a new set.
cat >"${work}/bin/fake-backup" <<'EOF'
#!/usr/bin/env bash
printf 'backup %s dir=%s\n' "$*" "$PORTIKUS_BACKUP_DIR" >>"$FAKE_DIR/calls.log"
echo "${PORTIKUS_BACKUP_MIN_AGE_DAYS:-unset} ${PORTIKUS_BACKUP_KEEP_COMPLETE:-unset}" >"$FAKE_DIR/floor"
[ -z "${FAKE_BACKUP_FAILS:-}" ] || { echo "[backup] FAIL: vm said no" >&2; exit 1; }
mkdir -p "$PORTIKUS_BACKUP_DIR/portikus/20260928T120000Z"
EOF
# df: fixed free space, so no test depends on this host's disk.  It reports
# FAKE_FREE_BYTES (default 100 GiB) less the size of FAKE_USED_FILE, if any.
cat >"${work}/bin/df" <<'EOF'
#!/usr/bin/env bash
free=${FAKE_FREE_BYTES:-107374182400}
if [ -n "${FAKE_USED_FILE:-}" ] && [ -e "$FAKE_USED_FILE" ]; then
  free=$((free - $(stat -c %s "$FAKE_USED_FILE")))
fi
printf 'Avail\n%s\n' "$free"
EOF
chmod +x "${work}/bin/"*
export FAKE_DIR="$fakes"

# A tarball as an Incus volume export holds it: backup/volume/<files>.
mkdir -p "${work}/tree/backup/volume/project"
echo "hello from the backup" >"${work}/tree/backup/volume/project/notes.txt"
tar -czf "${work}/home.tar.gz" -C "${work}/tree" backup
enc() { age -r "$(cat "${work}/recipients")" -o "$2"; }

# make_set STAMP [FAILED] -- a set holding INST's home and recovery volumes.
make_set() {
  local d="${sets}/$1"
  mkdir -p "$d"
  {
    echo "portikus-backup 1"
    echo "created $1"
    echo "vm ${VM_IP}"
    echo "package 0.1.600"
    echo "counts users 2 workspaces 1 projects 1"
    echo "workspace 11111111-2222-3333-4444-555555555555 ${INST}"
    echo "file db.dump 10 $(printf '0%.0s' {1..64})"
    echo "volume ${INST}-home $(stat -c %s "${work}/home.tar.gz") $(sha256sum <"${work}/home.tar.gz" | cut -d' ' -f1) [{\"Isuid\":true,\"Hostid\":1000000,\"Nsid\":0,\"Maprange\":65536}]"
    echo "volume ${INST}-recovery 100 $(printf 'b%.0s' {1..64}) -"
    [ -z "${SET_SKIPPED:-}" ] || echo "skipped ${SET_SKIPPED}"
    echo "seconds 5"
  } | enc - "${d}/MANIFEST.age"
  enc - "${d}/${INST}-home.age" <"${work}/home.tar.gz"
  printf '{"f": "project/notes.txt", "size": 22, "sha256": "%s"}\n' "$(printf 'c%.0s' {1..64})" | enc - "${d}/${INST}-home.index.age"
  echo x | enc - "${d}/${INST}-recovery.age"
  echo x | enc - "${d}/db.dump.age"
  [ -z "${2:-}" ] || echo "${OTHER}-home" >"${d}/FAILED"
  python3 "${repo}/infra/host/portikus-backup-mac" sign "$key" "$d"
}

reset() {
  rm -rf "$backups" "$state" "$fakes"
  mkdir -p "$sets/dumps" "$fakes"
  chmod 0700 "$backups" "$sets"
  make_set "$OLD"
  make_set "$GOOD"
  make_set "$NEWEST"
  make_set "$BROKEN" failed
  echo dump >"${sets}/dumps/portikus-pre-epic24.dump"
  echo dump >"${sets}/dumps/portikus-pre-older.dump"
  touch -d '2026-09-20' "${sets}/dumps/portikus-pre-older.dump"
  : >"$log"
  unset FAKE_SSH_FAIL FAKE_HOSTNAME FAKE_INSTANCE_STATE FAKE_DIR_EXISTS FAKE_AVAIL FAKE_IMPORT_EXISTS
  unset FAKE_NIGHTLY_ACTIVE FAKE_NIGHTLY_RESULT FAKE_BACKUP_FAILS FAKE_HANG
}

run_channel() {
  PATH="${work}/bin:${PATH}" \
    PORTIKUS_BACKUP_DIR="$backups" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients" \
    PORTIKUS_BACKUP_KEY="$key" PORTIKUS_BACKUP_CHANNEL_STATE="$state" \
    PORTIKUS_BACKUP_CMD="${work}/bin/fake-backup" PORTIKUS_RESTORE_COPY_CMD="${repo}/infra/host/restore-copy.sh" \
    PORTIKUS_BACKUP_MIN_AGE_DAYS="${MIN_AGE-0}" PORTIKUS_BACKUP_KEEP_COMPLETE="${KEEP-1}" \
    bash "$channel" --operator "$(id -un)" --vm-name "$VM_NAME" "$VM_IP" >"${work}/out" 2>&1
}

# pull LINE -- what the VM answers to pull.
pull() { printf '%s\n' "$1" >"${fakes}/pull"; }

# field EXPR -- a Python expression over the last report, as r.
field() { python3 -c "import json; r = json.load(open('${fakes}/last-report.json')); print($1)"; }

# Everything the VM was asked besides pull and report.
vm_commands() { grep '^ssh ' "$log" | grep -v 'backup-channel \(pull\|report\)$' || true; }
nothing_ran() {
  [ -z "$(vm_commands)" ] && ! grep -q '^backup ' "$log" \
    && [ -d "${sets}/${OLD}" ] && [ -d "${sets}/${GOOD}" ] && [ -d "${sets}/${NEWEST}" ] \
    && [ -f "${sets}/dumps/portikus-pre-epic24.dump" ] && [ ! -e "${fakes}/stream" ]
}
refused() { [ "$(field "r['request']['state']")" = failed ] && field "r['request']['error']" | grep -q '^refused by the host'; }

# The report's shape, with the patterns of packages/contracts/src/backups.ts.
CHECK_SHAPE='
import json, re, sys
raw = open(sys.argv[1]).read()
assert len(raw.encode()) <= 262144, "over 256 KiB"
r = json.loads(raw)
assert set(r) == {"request", "status"}
s = r["status"]
assert set(s) == {"vm", "reportedAt", "nextRunAt", "lastRun", "lastFailure", "running", "keyInstalled", "sets", "dumps"}, set(s)
ts = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)")
assert re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", s["vm"])
assert ts.fullmatch(s["reportedAt"])
assert s["nextRunAt"] is None or ts.fullmatch(s["nextRunAt"])
assert isinstance(s["keyInstalled"], bool)
assert len(s["sets"]) <= 60 and len(s["dumps"]) <= 200
for x in s["sets"]:
    assert set(x) == {"stamp", "complete", "sizeBytes", "instances", "failedVolumes", "skippedVolumes", "verified"}
    assert isinstance(x["skippedVolumes"], int) and x["skippedVolumes"] >= 0
    assert isinstance(x["verified"], bool)
    assert re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", x["stamp"]) and isinstance(x["complete"], bool)
    assert isinstance(x["sizeBytes"], int) and x["sizeBytes"] >= 0
    assert all(re.fullmatch(r"ws-[0-9a-f]{24}", i) for i in x["instances"])
    assert all(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", v) for v in x["failedVolumes"])
for d in s["dumps"]:
    assert set(d) == {"file", "sizeBytes", "modifiedAt"} and ts.fullmatch(d["modifiedAt"])
    assert re.fullmatch(r"portikus-pre-[a-z0-9][a-z0-9-]{0,62}\.dump", d["file"])
if s["lastRun"] is not None:
    assert set(s["lastRun"]) == {"startedAt", "endedAt", "result"} and s["lastRun"]["result"] in ("success", "failed")
if s["lastFailure"] is not None:
    assert set(s["lastFailure"]) == {"at", "reason"} and len(s["lastFailure"]["reason"]) <= 300
assert s["running"] is None or s["running"] == "nightly" or re.fullmatch(r"[0-9a-f-]{36}", s["running"])
q = r["request"]
if q is not None:
    assert set(q) == {"id", "state", "error", "stamp"} and q["state"] in ("done", "failed")
    assert q["error"] is None or len(q["error"]) <= 500
'
shape_ok() { python3 -c "$CHECK_SHAPE" "${fakes}/last-report.json"; }

echo "--- status only ---"
reset
pull ""
run_channel
rc=$?
expect "with no request the run exits cleanly" "[ $rc = 0 ]"
expect "it reports once, with no request" "[ \"\$(field \"r['request']\")\" = None ]"
expect "the report has the contract's shape" shape_ok
expect "it lists the four sets, newest first" "[ \"\$(field \"[s['stamp'] for s in r['status']['sets']]\")\" = \"['${BROKEN}', '${NEWEST}', '${GOOD}', '${OLD}']\" ]"
expect "a set with a FAILED file is incomplete and names the volume" "[ \"\$(field \"(r['status']['sets'][0]['complete'], r['status']['sets'][0]['failedVolumes'])\")\" = \"(False, ['${OTHER}-home'])\" ]"
echo 2 >"${sets}/${NEWEST}/SKIPPED"
run_channel
expect "a set's SKIPPED count is reported, and 0 without one" "[ \"\$(field \"[s['skippedVolumes'] for s in r['status']['sets']]\")\" = '[0, 2, 0, 0]' ]"
rm -f "${sets}/${NEWEST}/SKIPPED"
expect "instances come from the volume file names" "[ \"\$(field \"r['status']['sets'][1]['instances']\")\" = \"['${INST}']\" ]"
expect "dumps are listed newest first" "[ \"\$(field \"[d['file'] for d in r['status']['dumps']]\")\" = \"['portikus-pre-epic24.dump', 'portikus-pre-older.dump']\" ]"
expect "the next nightly run is reported" "[ \"\$(field \"r['status']['nextRunAt']\")\" = 2026-09-28T02:30:00+00:00 ]"
expect "the last nightly run is reported" "[ \"\$(field \"r['status']['lastRun']['result']\")\" = success ]"
expect "the key counts as installed when owner-only" "[ \"\$(field \"r['status']['keyInstalled']\")\" = True ]"
expect "every VM command ran as the operator" "! grep '^runuser' '$log' | grep -vqx \"runuser \$(id -un)\""

reset
pull ""
chmod 0644 "$key"
run_channel
expect "a key readable by others does not count as installed" "[ \"\$(field \"r['status']['keyInstalled']\")\" = False ]"
chmod 0600 "$key"
chmod 0755 "$keydir"
run_channel
expect "a key in an open directory does not count as installed" "[ \"\$(field \"r['status']['keyInstalled']\")\" = False ]"
chmod 0700 "$keydir"

reset
pull ""
FAKE_NIGHTLY_ACTIVE=1 FAKE_NIGHTLY_RESULT=exit-code run_channel
expect "a running nightly backup is reported as running" "[ \"\$(field \"r['status']['running']\")\" = nightly ]"
FAKE_NIGHTLY_RESULT=exit-code run_channel
expect "a failed nightly becomes the last failure, with its FAIL line" \
  "field \"r['status']['lastFailure']['reason']\" | grep -q '1 of 2 volumes failed'"

reset
pull ""
# Enough instance names to push the report past 256 KiB.
for i in $(seq 10 69); do
  d="${sets}/2025$(printf '%02d' $((i % 12 + 1)))$(printf '%02d' $((i % 28 + 1)))T0000${i}Z"
  mkdir -p "$d"
  for j in $(seq 1 160); do : >"${d}/ws-$(printf '%024x' $((i * 1000 + j)))-home.age"; done
done
run_channel
expect "at most 60 sets are reported, and the report stays under 256 KiB" shape_ok

echo "--- a lying VM: the request is refused and nothing runs ---"
lie() {
  local name=$1 line=$2
  reset
  pull "$line"
  run_channel
  if refused && nothing_ran && shape_ok; then ok "$name"; else bad "$name"; cat "${work}/out"; fi
}
lie "an unknown kind" "{\"id\":\"${ID}\",\"kind\":\"shell\",\"args\":{}}"
lie "a VM-side kind the host does not run" "{\"id\":\"${ID}\",\"kind\":\"delete_snapshot\",\"args\":{\"volume\":\"${INST}-home\",\"snapshot\":\"pre-x\"}}"
lie "an extra top-level field" "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{},\"cmd\":\"rm -rf /\"}"
lie "an extra argument" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${OLD}\",\"path\":\"/\"}}"
lie "a missing argument" "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST}\"}}"
lie "a stamp with .." "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"..\"}}"
lie "a stamp with a slash" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${OLD}/../${GOOD}\"}}"
lie "a stamp with a newline" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${OLD}\\n\"}}"
lie "a stamp with shell syntax" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"\$(touch ${work}/pwned)\"}}"
lie "a stamp that is not a string" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":[\"${OLD}\"]}}"
lie "a dump file with .." "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"portikus-pre-x/../../../${GOOD}.dump\"}}"
lie "a dump file that is not a pre-change dump" "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"MANIFEST.age\"}}"
lie "an instance with shell syntax" "{\"id\":\"${ID}\",\"kind\":\"import_home\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST};reboot\"}}"
lie "an instance with upper-case hex" "{\"id\":\"${ID}\",\"kind\":\"import_home\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"ws-0123456789ABCDEF01234567\"}}"
lie "a restore folder that does not match the set" "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST}\",\"dir\":\"restored-2026-09-26-0230\"}}"
lie "a restore folder with a path" "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST}\",\"dir\":\"../../root/.ssh\"}}"
lie "a restore of an instance the set does not hold" "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${OTHER}\",\"dir\":\"restored-2026-09-24-0230\"}}"
lie "an import of an instance the set does not hold" "{\"id\":\"${ID}\",\"kind\":\"import_home\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${OTHER}\"}}"
lie "a restore from a set that does not exist" "{\"id\":\"${ID}\",\"kind\":\"import_home\",\"args\":{\"stamp\":\"20200101T000000Z\",\"instance\":\"${INST}\"}}"
lie "a delete of the newest complete set" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${NEWEST}\"}}"
lie "a delete of a set that does not exist" "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"20200101T000000Z\"}}"
lie "a delete of a dump that does not exist" "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"portikus-pre-nope.dump\"}}"
expect "no shell syntax from the VM ever ran" "[ ! -e '${work}/pwned' ]"

# No usable id: nothing to report failed, so only the status goes back.
lie_no_id() {
  local name=$1
  reset
  cp "$2" "${fakes}/pull"
  run_channel
  if [ "$(field "r['request']")" = None ] && nothing_ran && grep -q 'refused a request' "${work}/out"; then ok "$name"; else bad "$name"; cat "${work}/out"; fi
}
printf 'not json at all\n' >"${work}/p1"
lie_no_id "malformed JSON is refused" "${work}/p1"
printf '{"id":"not-a-uuid","kind":"backup","args":{}}\n' >"${work}/p2"
lie_no_id "an id that is not a UUID is refused" "${work}/p2"
python3 -c "print('{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{},\"pad\":\"' + 'x' * 5000 + '\"}')" >"${work}/p3"
lie_no_id "an oversized request is refused" "${work}/p3"
python3 -c "print('[' * 3000 + ']' * 3000)" >"${work}/p4"
lie_no_id "a deeply nested document is refused" "${work}/p4"
printf '"\xff\xfe"\n' >"${work}/p5"
lie_no_id "a request that is not UTF-8 is refused" "${work}/p5"
printf '{"id":"%s","kind":"delete_set","args":{"stamp":"%s","stamp":"../.."}}\n' "$ID" "$OLD" >"${work}/p6"
lie_no_id "a duplicated key is refused" "${work}/p6"
printf '{"id":"%s","kind":"backup","args":{}}\n{"id":"%s","kind":"backup","args":{}}\n' "$ID" "$ID" >"${work}/p7"
lie_no_id "two requests on two lines are refused" "${work}/p7"

echo "--- symbolic links and sets outside this VM's directory ---"
reset
ln -s "${sets}/${GOOD}" "${sets}/20260101T000000Z"
pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"20260101T000000Z\"}}"
run_channel
expect "a set that is a symbolic link is not deleted, nor what it points to" "refused && [ -d '${sets}/${GOOD}/' ] && [ -L '${sets}/20260101T000000Z' ]"
reset
ln -s "${work}/recipients" "${sets}/dumps/portikus-pre-link.dump"
pull "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"portikus-pre-link.dump\"}}"
run_channel
expect "a dump that is a symbolic link is not deleted" "refused && [ -L '${sets}/dumps/portikus-pre-link.dump' ] && [ -f '${work}/recipients' ]"
reset
mkdir -p "${backups}/portikus-rehearsal/${OLD}"
pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${OLD}\"}}"
run_channel
expect "a delete touches only this VM's directory" "[ -d '${backups}/portikus-rehearsal/${OLD}' ] && [ ! -e '${sets}/${OLD}' ]"

echo "--- the kinds that run ---"
reset
pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${GOOD}\"}}"
run_channel
expect "an older complete set is deleted, and only it" "[ ! -e '${sets}/${GOOD}' ] && [ -d '${sets}/${OLD}' ] && [ -d '${sets}/${NEWEST}' ] && [ -d '${sets}/${BROKEN}' ]"
expect "the result is done, and the VM ran nothing" "[ \"\$(field \"r['request']['state']\")\" = done ] && [ -z \"\$(vm_commands)\" ]"
expect "the fresh status no longer lists it" "! field \"[s['stamp'] for s in r['status']['sets']]\" | grep -q '${GOOD}'"

reset
pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"${BROKEN}\"}}"
run_channel
expect "an incomplete set newer than the newest complete one can be deleted" "[ ! -e '${sets}/${BROKEN}' ] && [ \"\$(field \"r['request']['state']\")\" = done ]"

reset
pull "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"portikus-pre-epic24.dump\"}}"
run_channel
expect "a dump is deleted, and only it" "[ ! -e '${sets}/dumps/portikus-pre-epic24.dump' ] && [ -f '${sets}/dumps/portikus-pre-older.dump' ] && [ \"\$(field \"r['request']['state']\")\" = done ]"

reset
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
run_channel
expect "a backup runs backup.sh as the operator for this VM's name" \
  "grep -qx 'backup --vm-name ${VM_NAME} ${VM_IP} dir=${backups}' '$log' && grep -B1 '^backup ' '$log' | grep -qx \"runuser \$(id -un)\""
expect "its result names the new set" "[ \"\$(field \"(r['request']['state'], r['request']['stamp'])\")\" = \"('done', '20260928T120000Z')\" ]"
expect "it becomes the last run" "[ \"\$(field \"r['status']['lastRun']['result']\")\" = success ]"
expect "the backup gets the host's retention floor, not the VM's" "[ \"\$(cat '${fakes}/floor')\" = '0 1' ]"
# A compromised VM must not queue backups back to back (ADR 0039).
: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
run_channel
expect "a second requested backup within the gap is refused" \
  "[ \"\$(field \"r['request']['error']\")\" = 'refused by the host: a backup ran 0 minutes ago' ] && ! grep -q '^backup ' '$log'"
echo "$(( $(date +%s) - 7200 )) $(( $(date +%s) - 3660 )) success" >"${state}/last-run"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
run_channel
expect "a requested backup after the gap runs" "[ \"\$(field \"r['request']['state']\")\" = done ] && grep -q '^backup ' '$log'"
expect "the channel marks the set it made as requested" "[ -f '${sets}/20260928T120000Z/REQUESTED' ]"

# The retention floor keeps young sets, so a VM may ask for only a few (ADR 0039).
ago_stamp() { date -u -d "-$1 days" +%Y%m%dT%H%M%SZ; }
reset
for d in 1 2; do st=$(ago_stamp "$d"); make_set "$st"; touch "${sets}/${st}/REQUESTED"; done
old_req=$(ago_stamp 20)
make_set "$old_req"
touch "${sets}/${old_req}/REQUESTED"
: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
MIN_AGE=14 run_channel
expect "two young requested sets, and an old one, still allow a request" "[ \"\$(field \"r['request']['state']\")\" = done ] && grep -q '^backup ' '$log'"
rm -f "${state}/last-run"
: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
MIN_AGE=14 run_channel
expect "a fourth request with three young requested sets is refused" \
  "[ \"\$(field \"r['request']['error']\")\" = 'refused by the host: 3 requested backups in the last 14 days' ] && ! grep -q '^backup ' '$log'"

reset
: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
PORTIKUS_BACKUP_MIN_FREE_MB=999999999 run_channel
expect "a requested backup without enough free space is refused" \
  "[ \"\$(field \"r['request']['error']\")\" = 'refused by the host: not enough free space' ] && ! grep -q '^backup ' '$log'"

reset
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
FAKE_BACKUP_FAILS=1 run_channel
expect "a failed backup reports its FAIL line and becomes the last failure" \
  "[ \"\$(field \"(r['request']['state'], r['request']['error'])\")\" = \"('failed', 'vm said no')\" ] && field \"r['status']['lastFailure']['reason']\" | grep -q 'vm said no'"

reset
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
FAKE_NIGHTLY_ACTIVE=1 run_channel
expect "a backup is refused while the nightly one runs" "[ \"\$(field \"r['request']['state']\")\" = failed ] && ! grep -q '^backup ' '$log'"

echo "--- the host's retention floor ---"
ago() { date -u -d "-$1 days" +%Y%m%dT%H%M%SZ; }
floor_refused() { refused && field "r['request']['error']" | grep -q '^refused by the host: retention floor ('; }
del() { pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"$1\"}}"; }
reset
del "$OLD"
KEEP=3 run_channel
expect "one of the newest three complete sets is kept" "floor_refused && [ -d '${sets}/${OLD}' ]"
reset
young=$(ago 2)
make_set "$young"
make_set "$(ago 1)"
del "$young"
MIN_AGE=7 run_channel
expect "a set younger than the minimum age is kept" "floor_refused && [ -d '${sets}/${young}' ]"
# With the unit's defaults (7 days, 3 sets) and four old complete sets, only the oldest can go.
reset
rm -rf "${sets:?}/${OLD}" "${sets:?}/${GOOD}" "${sets:?}/${NEWEST}" "${sets:?}/${BROKEN}"
oldest=$(ago 40)
third=$(ago 20)
for st in "$oldest" "$(ago 30)" "$third" "$(ago 10)"; do make_set "$st"; done
del "$oldest"
MIN_AGE='' KEEP='' run_channel
expect "with the defaults an old set beyond the newest three is deleted" "[ \"\$(field \"r['request']['state']\")\" = done ] && [ ! -e '${sets}/${oldest}' ]"
del "$third"
MIN_AGE='' KEEP='' run_channel
expect "with the defaults the third newest complete set is kept" "floor_refused && [ -d '${sets}/${third}' ]"

echo "--- side copy ---"
copy_req="{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST}\",\"dir\":\"restored-2026-09-24-0230\"}}"
reset
pull "$copy_req"
run_channel
expect "a side copy is done" "[ \"\$(field \"r['request']['state']\")\" = done ]"
expect "it checks the VM's hostname first" "vm_commands | head -1 | grep -qx 'ssh hostname'"
expect "every command inside the workspace runs as uid and gid 1000" \
  "! vm_commands | grep 'incus exec' | grep -v -- '--user 1000 --group 1000 --cwd /home/student' | grep -q ."
expect "it extracts into the derived folder as the student" \
  "vm_commands | grep -q -- '--user 1000 --group 1000 --cwd /home/student --env HOME=/home/student -- tar -xz --strip-components=2 -C /home/student/restored-2026-09-24-0230 backup/volume'"
expect "the workspace receives the decrypted home" "cmp -s '${fakes}/stream' '${work}/home.tar.gz'"
reset
rm -rf "${sets:?}/${GOOD}"
SET_SKIPPED=2 make_set "$GOOD"
pull "$copy_req"
run_channel
expect "a side copy from a set that skipped volumes is done" \
  "[ \"\$(field \"r['request']['state']\")\" = done ] && cmp -s '${fakes}/stream' '${work}/home.tar.gz'"
expect "the private key never reaches the VM" "! grep -rq '${secret}' '${fakes}'"

reset
pull "$copy_req"
FAKE_DIR_EXISTS=1 run_channel
expect "an existing folder is refused, with its message" \
  "[ \"\$(field \"r['request']['error']\")\" = '~/restored-2026-09-24-0230 already exists. Rename or delete it, then try again.' ] && [ ! -e '${fakes}/stream' ] && ! vm_commands | grep -q -- '-- mkdir'"

reset
pull "$copy_req"
# shellcheck disable=SC2034 # read inside the expect string
started=$(date +%s)
FAKE_HANG=1 PORTIKUS_RESTORE_CALL_TIMEOUT=2 run_channel
expect "a VM call that hangs is cut by the host's time limit and nothing is copied" \
  "[ \$((\$(date +%s) - started)) -lt 20 ] && field \"r['request']['error']\" | grep -q 'could not check' && [ ! -e '${fakes}/stream' ]"

reset
pull "$copy_req"
FAKE_AVAIL=22 run_channel
expect "a copy larger than the free space less 5% is refused" \
  "field \"r['request']['error']\" | grep -q 'not enough room' && [ ! -e '${fakes}/stream' ]"

reset
pull "$copy_req"
FAKE_INSTANCE_STATE="${INST},STOPPED" run_channel
expect "a stopped workspace is refused" "field \"r['request']['error']\" | grep -q 'not running' && [ ! -e '${fakes}/stream' ]"

reset
pull "$copy_req"
FAKE_HOSTNAME=portikus-rehearsal run_channel
expect "a VM with another hostname gets nothing" "refused && [ ! -e '${fakes}/stream' ] && [ \"\$(vm_commands)\" = 'ssh hostname' ]"

reset
pull "$copy_req"
chmod 0640 "$key"
run_channel
expect "a key that is not owner-only is not used" "field \"r['request']['error']\" | grep -q 'not root-only' && [ -z \"\$(vm_commands)\" ]"
chmod 0600 "$key"

echo "--- import for replace home ---"
import_req="{\"id\":\"${ID}\",\"kind\":\"import_home\",\"args\":{\"stamp\":\"${GOOD}\",\"instance\":\"${INST}\"}}"
reset
pull "$import_req"
run_channel
expect "an import is done" "[ \"\$(field \"r['request']['state']\")\" = done ]"
expect "it imports as <instance>-home-import, never over the live home" \
  "vm_commands | grep -qx 'ssh sudo incus storage volume import workspace-data /dev/stdin ${INST}-home-import --project portikus -q' && ! vm_commands | grep -q 'volume import workspace-data /dev/stdin ${INST}-home '"
expect "it sets the backup's ID map, quoted" "vm_commands | grep -q 'volume set workspace-data ${INST}-home-import --project portikus volatile.idmap.last=\\\\\\[\\\\{'"
expect "the import receives the decrypted volume" "cmp -s '${fakes}/stream' '${work}/home.tar.gz'"
reset
pull "$import_req"
FAKE_IMPORT_EXISTS=1 run_channel
expect "a leftover import is replaced, by its exact name" "vm_commands | grep -qx 'ssh sudo incus storage volume delete workspace-data ${INST}-home-import --project portikus'"
# A genuine MAC and MANIFEST beside a home that is not the one it lists (ADR 0044).
reset
echo "not the home" | enc - "${sets}/${GOOD}/${INST}-home.age"
pull "$import_req"
run_channel
expect "an import of a home its MANIFEST does not list is refused before anything is imported" \
  "refused && field \"r['request']['error']\" | grep -q 'not the one its MANIFEST lists' && ! vm_commands | grep -q 'volume import' && [ ! -s '${fakes}/stream' ] && ! vm_commands | grep -q 'volatile.idmap.last'"
expect "and its checked copy is gone" "[ -z \"\$(find '${sets}' -name '.restore-copy.*')\" ]"
reset
rm "${sets}/${GOOD}/MANIFEST.mac"
pull "$import_req"
run_channel
expect "an import from a set with no MAC is refused before the VM is asked anything" \
  "field \"r['request']['error']\" | grep -q 'not verified' && [ -z \"\$(vm_commands)\" ]"

echo "--- a result the VM did not take ---"
reset
pull "{\"id\":\"${ID}\",\"kind\":\"delete_dump\",\"args\":{\"file\":\"portikus-pre-epic24.dump\"}}"
touch "${fakes}/report-refuse"
run_channel
expect "a report the VM refused keeps the result for later" "[ -s '${state}/pending.json' ]"
pull ""
: >"$log"
run_channel
expect "the next run sends it first, then pulls" \
  "[ ! -e '${state}/pending.json' ] && grep '^ssh' '$log' | head -2 | tr '\n' ' ' | grep -q 'report ssh sudo portikus backup-channel pull'"
expect "and the result reached the VM" "grep -l '\"state\": \"done\"' '${fakes}'/report.*.json | grep -q ."

reset
pull "$copy_req"
FAKE_SSH_FAIL=1 run_channel
expect "an unreachable VM runs nothing" "[ ! -e '${fakes}/stream' ] && grep -q 'could not pull' '${work}/out'"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
