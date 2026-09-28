#!/usr/bin/env bash
# Backups on an apt-installed server, with no separate host
# (docs/adr/0044-backups-on-the-server.md).  Fakes stand in for incus,
# PostgreSQL's commands, systemctl and the portikus command; age is real.
#
#   - backup.sh --local runs the real export script on this machine, never
#     SSH, and writes a complete set under <dir>/local that restore.sh
#     --check opens; it refuses to run as anyone but root;
#   - backup-channel.sh --local asks the local portikus command for
#     requests, still refuses a malformed one, runs a backup and a restore
#     in local mode, and never uses SSH or another account;
#   - hand-copied sets are listed whatever their owner and modes, while a
#     symbolic link named like a set, a badly named directory and a linked
#     volume file are not, and a restore from a linked set is refused;
#   - restore-copy.sh --local unpacks the home inside the workspace as the
#     student, on this machine;
#   - the key helper hands out the key only on stdout, installs only a real
#     age identity, refuses to replace a different key without consent,
#     keeps its files root-only, and waits for a running backup.
#
# Usage: ./infra/tests/backup-local-test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v age-keygen >/dev/null || { echo "backup-local-test: age is not installed"; exit 1; }

pass=0
fail=0
ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

INST=ws-0123456789abcdef01234567
WS_ID=11111111-2222-3333-4444-555555555555
ID=0b6f5c3e-8d2a-4c1e-9f7a-1234567890ab

fakes="${work}/fake"
log="${fakes}/calls.log"
backups="${work}/backups"
sets="${backups}/local"
keydir="${work}/etc"
key="${keydir}/age-key.txt"
state="${work}/state"
mkdir -p "${work}/bin" "$fakes" "$keydir"
chmod 0700 "$keydir"
(umask 077 && age-keygen -o "$key" 2>/dev/null)
age-keygen -y "$key" >"${keydir}/recipients.txt"
export FAKE_DIR="$fakes"

# A home volume as Incus exports it: backup/volume/<files>.
mkdir -p "${work}/tree/backup/volume/project/.git/refs/heads"
echo "hello from the server" >"${work}/tree/backup/volume/project/notes.txt"
echo "ref: refs/heads/main" >"${work}/tree/backup/volume/project/.git/HEAD"
printf '%040d\n' 7 >"${work}/tree/backup/volume/project/.git/refs/heads/main"
tar -czf "${work}/home.tar.gz" -C "${work}/tree" backup

# ssh must never run on a local server.
cat >"${work}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$FAKE_DIR/calls.log"
exit 255
EOF
# id -u says root, for the scripts that insist on it.
cat >"${work}/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "-u" ] && [ -n "${FAKE_ROOT:-}" ]; then echo 0; else exec /usr/bin/id "$@"; fi
EOF
# incus: the workspace's volumes and instance, an export, and a student's shell.
cat >"${work}/bin/incus" <<EOF
#!/usr/bin/env bash
printf 'incus %s\n' "\$*" >>"\$FAKE_DIR/calls.log"
case "\$*" in
  *"storage volume list"*) printf '%s\n' custom,${INST}-home custom,${INST}-docker ;;
  *"list --format csv --columns ns"* | *"--format csv --columns ns"*) echo "${INST},RUNNING" ;;
  *"list --format csv --columns n"*) echo "${INST}" ;;
  *"storage volume export"*) cat "${work}/home.tar.gz" ;;
  *"config get storage.backups_volume"*) echo "" ;;
  *"volatile.idmap.last"*) echo '[{"Isuid":true,"Hostid":1000000,"Nsid":0,"Maprange":65536}]' ;;
  *" -- test -e "*) exit 1 ;;
  *" -- df "*) printf 'Avail\n%s\n' 1000000000 ;;
  *" -- tar "*) cat >"\$FAKE_DIR/stream" ;;
esac
exit 0
EOF
# runuser -u postgres -- ...: the database's answers.
cat >"${work}/bin/runuser" <<EOF
#!/usr/bin/env bash
printf 'runuser %s\n' "\$*" >>"\$FAKE_DIR/calls.log"
case "\$*" in
  *"pg_dump -Fc portikus"*) printf 'PGDMP fake dump' ;;
  *"pg_dump -Fc dex"*) printf 'PGDMP fake dex dump' ;;
  *"datname = 'dex'"*) echo 1 ;;
  *"'users '"*) echo "users 1 workspaces 1 projects 1" ;;
  *"FROM workspaces ORDER BY id"*) echo "${WS_ID} ${INST}" ;;
esac
EOF
cat >"${work}/bin/dpkg-query" <<'EOF'
#!/usr/bin/env bash
printf '0.1.700'
EOF
cat >"${work}/bin/df" <<'EOF'
#!/usr/bin/env bash
printf 'Avail\n%s\n' 107374182400
EOF
# The local portikus command: pull prints the waiting request, report keeps the document.
cat >"${work}/bin/portikus" <<'EOF'
#!/usr/bin/env bash
printf 'portikus %s\n' "$*" >>"$FAKE_DIR/calls.log"
case "$*" in
  "backup-channel pull") cat "$FAKE_DIR/pull" 2>/dev/null ;;
  "backup-channel report") cat >"$FAKE_DIR/last-report.json" ;;
esac
EOF
cat >"${work}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  is-active*) exit 3 ;;
  *) : ;;
esac
EOF
cat >"${work}/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
:
EOF
# Stand-ins the channel starts, which log how they were called.
cat >"${work}/bin/fake-backup" <<'EOF'
#!/usr/bin/env bash
printf 'backup %s\n' "$*" >>"$FAKE_DIR/calls.log"
mkdir -p "$PORTIKUS_BACKUP_DIR/local/20260928T120000Z"
EOF
cat >"${work}/bin/fake-restore-copy" <<'EOF'
#!/usr/bin/env bash
printf 'restore-copy %s\n' "$*" >>"$FAKE_DIR/calls.log"
EOF
chmod +x "${work}/bin/"*

echo "--- backup.sh --local ---"
# The real script beside the real export, as the package installs them.
lib="${work}/lib"
mkdir -p "$lib"
cp "${repo}/infra/host/backup.sh" "${lib}/portikus-backup"
cp "${repo}/infra/host/portikus-backup-export" "${lib}/portikus-backup-export"
mkdir -p "$sets"
chmod 0700 "$backups"
run_backup() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$backups" \
    PORTIKUS_BACKUP_RECIPIENTS="${keydir}/recipients.txt" \
    bash "${lib}/portikus-backup" "$@" >"${work}/out" 2>&1
}
: >"$log"
FAKE_ROOT=1 run_backup --local
rc=$?
stamp=$(find "$sets" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | head -1)
expect "a local backup succeeds" "[ $rc = 0 ]"
expect "it writes one set under <dir>/local" "[ -n '$stamp' ] && [ -f '${sets}/${stamp}/MANIFEST.age' ]"
expect "it never uses SSH" "! grep -q '^ssh ' '$log'"
expect "the export ran here, reading the volume through incus" "grep -q 'storage volume export workspace-data backup-${INST}-home' '$log'"
expect "the database was dumped here as postgres" "grep -q 'runuser -u postgres -- pg_dump -Fc portikus' '$log'"
age -d -i "$key" "${sets}/${stamp}/MANIFEST.age" >"${work}/manifest" 2>/dev/null
expect "the MANIFEST names this machine by its loopback address" "grep -qx 'vm 127.0.0.1' '${work}/manifest'"
expect "the MANIFEST lists the home volume with its ID map" "grep -q '^volume ${INST}-home [0-9]* [0-9a-f]\{64\} \[' '${work}/manifest'"
expect "the Docker volume is not backed up" "! grep -q docker '${work}/manifest' && [ ! -e '${sets}/${stamp}/${INST}-docker.age' ]"
PORTIKUS_BACKUP_IDENTITY="$key" bash "${repo}/infra/host/restore.sh" --check "${sets}/${stamp}" >"${work}/check" 2>&1
expect "restore.sh --check opens the set with the server's key" "[ $? = 0 ]"
: >"$log"
run_backup --local
expect "a local backup refuses to run as anyone but root" "[ $? != 0 ] && grep -q 'must run as root' '${work}/out' && [ ! -s '$log' ]"
FAKE_ROOT=1 run_backup --local --vm-name portikus
expect "--local takes no VM name" "[ $? != 0 ] && grep -q 'takes no other option' '${work}/out'"

echo "--- backup-channel.sh --local ---"
# Keep the real set to copy around.
cp -r "${sets}/${stamp}" "${work}/keep-set"
run_channel() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$backups" PORTIKUS_BACKUP_KEY="$key" \
    PORTIKUS_BACKUP_CHANNEL_STATE="$state" PORTIKUS_BACKUP_NIGHTLY="" \
    PORTIKUS_BACKUP_CMD="${work}/bin/fake-backup" PORTIKUS_RESTORE_COPY_CMD="${work}/bin/fake-restore-copy" \
    PORTIKUS_BACKUP_MIN_AGE_DAYS=0 PORTIKUS_BACKUP_KEEP_COMPLETE=1 \
    bash "${repo}/infra/host/backup-channel.sh" "$@" >"${work}/out" 2>&1
}
pull() { printf '%s\n' "$1" >"${fakes}/pull"; }
field() { python3 -c "import json; r = json.load(open('${fakes}/last-report.json')); print($1)"; }

: >"$log"
pull ""
run_channel --local
expect "with no request, a local run reports the status" "[ $? = 0 ] && [ \"\$(field \"r['status']['vm']\")\" = local ]"
expect "it lists the set in <dir>/local" "[ \"\$(field \"[s['stamp'] for s in r['status']['sets']]\")\" = \"['${stamp}']\" ]"
expect "it asked the local portikus command, not SSH" "grep -qx 'portikus backup-channel pull' '$log' && ! grep -q '^ssh ' '$log'"

: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"backup\",\"args\":{}}"
run_channel --local
expect "a requested backup runs backup.sh --local, as root" "grep -qx 'backup --local' '$log' && ! grep -q '^runuser ' '$log'"
expect "and reports it done" "[ \"\$(field \"r['request']['state']\")\" = done ]"

: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${stamp}\",\"instance\":\"${INST}\",\"dir\":\"restored-${stamp:0:4}-${stamp:4:2}-${stamp:6:2}-${stamp:9:4}\"}}"
run_channel --local
expect "a requested restore runs restore-copy.sh --local on this machine" \
  "grep -q '^restore-copy --local copy 127.0.0.1 ${sets}/${stamp} ${INST} restored-' '$log'"

for bad_request in \
  "{\"id\":\"${ID}\",\"kind\":\"shell\",\"args\":{}}" \
  "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"../../etc\"}}" \
  "{\"id\":\"${ID}\",\"kind\":\"restore_copy\",\"args\":{\"stamp\":\"${stamp}\",\"instance\":\"${INST}; rm -rf /\",\"dir\":\"x\"}}"; do
  : >"$log"
  pull "$bad_request"
  run_channel --local
  expect "a malformed request from the worker is refused and runs nothing: ${bad_request:0:60}" \
    "[ \"\$(field \"r['request']['state']\")\" = failed ] && ! grep -qE '^(backup|restore-copy|incus) ' '$log'"
done
run_channel --local --vm-name portikus 127.0.0.1
expect "--local takes no VM name or address" "[ $? != 0 ] && grep -q 'takes no other option' '${work}/out'"

echo "--- hand-copied sets ---"
# An administrator copied these in by hand: a set with loose modes and
# another owner's name, a link named like a set, and a badly named directory.
copied=20260915T023000Z
cp -r "${work}/keep-set" "${sets}/${copied}"
chmod -R a+rX "${sets}/${copied}"
ln -s "${sets}/${copied}" "${sets}/20260916T023000Z"
cp -r "${work}/keep-set" "${sets}/not-a-set"
# A set whose volume file is a link: its instance must not be listed.
linked=20260917T023000Z
mkdir "${sets}/${linked}"
cp "${work}/keep-set/MANIFEST.age" "${sets}/${linked}/"
ln -s "${work}/keep-set/${INST}-home.age" "${sets}/${linked}/${INST}-home.age"
: >"$log"
pull ""
run_channel --local
expect "a hand-copied set is listed with its instance" \
  "[ \"\$(field \"[s['instances'] for s in r['status']['sets'] if s['stamp'] == '${copied}']\")\" = \"[['${INST}']]\" ]"
expect "a link named like a set and a badly named directory are not listed" \
  "[ \"\$(field \"sorted({s['stamp'] for s in r['status']['sets']} & {'20260916T023000Z', 'not-a-set', '${copied}'})\")\" = \"['${copied}']\" ]"
expect "a linked volume file is not counted as an instance" \
  "[ \"\$(field \"[s['instances'] for s in r['status']['sets'] if s['stamp'] == '${linked}']\")\" = '[[]]' ]"
: >"$log"
pull "{\"id\":\"${ID}\",\"kind\":\"delete_set\",\"args\":{\"stamp\":\"20260916T023000Z\"}}"
run_channel --local
expect "deleting the link is refused and removes nothing" \
  "[ \"\$(field \"r['request']['state']\")\" = failed ] && [ -L '${sets}/20260916T023000Z' ] && [ -d '${sets}/${copied}' ]"

PORTIKUS_BACKUP_IDENTITY="$key" bash "${repo}/infra/host/restore.sh" --check "${sets}/${copied}" >"${work}/out" 2>&1
expect "a whole-server restore checks a hand-copied set and opens it" "[ $? = 0 ]"
for linked_set in "${sets}/20260916T023000Z" "${sets}/${linked}"; do
  PORTIKUS_BACKUP_IDENTITY="$key" bash "${repo}/infra/host/restore.sh" --check "$linked_set" >"${work}/out" 2>&1
  rc=$?
  expect "a whole-server restore refuses a set that is or holds a link: ${linked_set##*/}" \
    "[ $rc != 0 ] && grep -q 'symbolic link' '${work}/out'"
done

echo "--- restore-copy.sh --local ---"
run_copy() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_KEY="$key" \
    bash "${repo}/infra/host/restore-copy.sh" "$@" >"${work}/out" 2>&1
}
dir="restored-${copied:0:4}-${copied:4:2}-${copied:6:2}-${copied:9:4}"
: >"$log"
run_copy --local copy 127.0.0.1 "${sets}/${copied}" "$INST" "$dir"
expect "a side copy from a hand-copied set succeeds" "[ $? = 0 ]"
expect "the home arrives inside the workspace, unpacked as the student" \
  "cmp -s '${fakes}/stream' '${work}/home.tar.gz' && grep -q 'incus exec ${INST} --project portikus --user 1000 --group 1000 .* -- tar -xz' '$log'"
expect "nothing used SSH or another account" "! grep -qE '^(ssh|runuser) ' '$log'"
: >"$log"
run_copy --local copy 127.0.0.1 "${sets}/20260916T023000Z" "$INST" "restored-2026-09-16-0230"
expect "a side copy from a linked set is refused before any command" \
  "[ $? != 0 ] && grep -q 'no set' '${work}/out' && ! grep -q '^incus ' '$log'"
: >"$log"
run_copy --local copy 127.0.0.1 "${sets}/${linked}" "$INST" "restored-2026-09-17-0230"
expect "a side copy from a set whose volume is a link is refused" \
  "[ $? != 0 ] && ! grep -q -- ' -- tar ' '$log'"
run_copy --local --operator root copy 127.0.0.1 "${sets}/${copied}" "$INST" "$dir"
expect "--local takes no operator" "[ $? != 0 ] && grep -q 'takes no --operator' '${work}/out'"

echo "--- restore.sh --local ---"
PATH="${work}/bin:${PATH}" bash "${repo}/infra/host/restore.sh" --local "${sets}/${copied}" >"${work}/out" 2>&1
expect "a whole-server restore refuses to run as anyone but root" "[ $? != 0 ] && grep -q 'must run as root' '${work}/out'"
FAKE_ROOT=1 PATH="${work}/bin:${PATH}" bash "${repo}/infra/host/restore.sh" --local --target-name x "${sets}/${copied}" >"${work}/out" 2>&1
expect "and takes no target name" "[ $? != 0 ] && grep -q 'takes only --start-check' '${work}/out'"

echo "--- the backup key helper ---"
helper="${repo}/packaging/backup/backup-key"
hdir="${work}/helper"
lockfile="${work}/backups-lock"
run_helper() { # VERB [INPUT FILE]
  local input=${2:-/dev/null}
  { printf '%s\n' "$1"; cat "$input"; } | PORTIKUS_BACKUP_KEY_DIR="$hdir" PORTIKUS_BACKUP_LOCK="$lockfile" \
    bash "$helper" >"${work}/answer" 2>"${work}/helper-err"
}
fresh_helper() {
  rm -rf "$hdir"
  install -d -m 0700 "$hdir"
  (umask 077 && age-keygen -o "${hdir}/age-key.txt" 2>/dev/null)
  age-keygen -y "${hdir}/age-key.txt" >"${hdir}/recipients.txt"
}
fresh_helper
server_recipient=$(cat "${hdir}/recipients.txt")
server_secret=$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "${hdir}/age-key.txt")
(umask 077 && age-keygen -o "${work}/offsite.txt" 2>/dev/null)
offsite_recipient=$(age-keygen -y "${work}/offsite.txt")
offsite_secret=$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "${work}/offsite.txt")

run_helper status
expect "status: installed, its recipient, never handed out" \
  "[ \"\$(head -1 '${work}/answer')\" = ok ] && python3 -c \"import json,sys; d=json.loads(open('${work}/answer').read().split('\\n')[1]); sys.exit(0 if d == {'installed': True, 'recipient': '${server_recipient}', 'handedOutRecipient': None, 'handedOutAt': None} else 1)\""
run_helper export
expect "export: ok with the recipient, then the key file" \
  "[ \"\$(head -1 '${work}/answer')\" = 'ok ${server_recipient}' ] && grep -qx '${server_secret}' '${work}/answer'"
expect "the key never reaches standard error, the journal" "! grep -q AGE-SECRET-KEY '${work}/helper-err' && grep -q 'handed the backup key for ${server_recipient}' '${work}/helper-err'"
run_helper status
expect "the handout is recorded against that recipient" "grep -q '\"handedOutRecipient\":\"${server_recipient}\"' '${work}/answer'"

printf 'not a key\n' >"${work}/junk"
printf '%s\n%s\n' "$offsite_secret" "$server_secret" >"${work}/two"
printf '%s\nextra text\n' "$offsite_secret" >"${work}/extra"
printf '%s\n' "$offsite_recipient" >"${work}/public"
head -c 5000 /dev/zero | tr '\0' '#' >"${work}/big"
printf '\n%s\n' "$offsite_secret" >>"${work}/big"
for input in junk two extra public big; do
  run_helper import-replace "${work}/${input}"
  expect "import refuses ${input} and keeps the key" \
    "grep -qE '^error (invalid|too-large)\$' '${work}/answer' && grep -qx '${server_secret}' '${hdir}/age-key.txt' && [ \"\$(cat '${hdir}/recipients.txt')\" = '${server_recipient}' ]"
done
expect "no upload is left behind" "[ -z \"\$(find '$hdir' -name '.upload.*')\" ]"

run_helper import "${work}/offsite.txt"
expect "a different key is refused without consent" "[ \"\$(cat '${work}/answer')\" = 'error exists' ] && grep -qx '${server_secret}' '${hdir}/age-key.txt'"
exec {held}>>"$lockfile"
flock -n "$held"
run_helper import-replace "${work}/offsite.txt"
expect "a replace waits while a backup holds the lock" "[ \"\$(cat '${work}/answer')\" = 'error busy' ] && grep -qx '${server_secret}' '${hdir}/age-key.txt'"
exec {held}>&-
tr '\n' '\r' <"${work}/offsite.txt" | sed 's/\r/\r\n/g' >"${work}/offsite-crlf.txt"
run_helper import-replace "${work}/offsite-crlf.txt"
expect "with consent it replaces the key and the recipients together" \
  "[ \"\$(cat '${work}/answer')\" = 'ok installed ${offsite_recipient} ${server_recipient}' ] && grep -qx '${offsite_secret}' '${hdir}/age-key.txt' && [ \"\$(cat '${hdir}/recipients.txt')\" = '${offsite_recipient}' ]"
expect "the installed key and recipients are owner-only" \
  "[ \"\$(stat -c %a '${hdir}/age-key.txt')\" = 600 ] && [ \"\$(stat -c %a '${hdir}/recipients.txt')\" = 600 ]"
expect "the installed key still opens what the uploader's key encrypted" \
  "echo secret | age -r '${offsite_recipient}' | age -d -i '${hdir}/age-key.txt' | grep -qx secret"
run_helper status
expect "the upload counts as the admin holding the key" "grep -q '\"handedOutRecipient\":\"${offsite_recipient}\"' '${work}/answer'"
run_helper import "${work}/offsite.txt"
expect "the same key again is unchanged" "[ \"\$(cat '${work}/answer')\" = 'ok unchanged ${offsite_recipient}' ]"

rm -rf "$hdir"
install -d -m 0700 "$hdir"
run_helper export
expect "with no key, export answers no-key" "[ \"\$(cat '${work}/answer')\" = 'error no-key' ]"
run_helper import "${work}/offsite.txt"
expect "onto a server with no key, an upload installs without consent" "[ \"\$(cat '${work}/answer')\" = 'ok installed ${offsite_recipient} -' ]"
run_helper 'rm -rf /'
expect "an unknown verb is refused" "[ \"\$(cat '${work}/answer')\" = 'error unknown-verb' ]"
rm -rf "$hdir"
ln -s "$keydir" "$hdir"
run_helper export
expect "a key directory that is a link is refused" "[ \"\$(cat '${work}/answer')\" = 'error no-key-dir' ]"
rm -f "$hdir"

echo ""
echo "--- backup local: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
