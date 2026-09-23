#!/usr/bin/env bash
# Checks what the backup and restore scripts may touch, with fakes for ssh,
# incus and runuser.  No VM involved (docs/adr/0024-backups-pulled-to-host.md).
#
#   - the VM-side export deletes only its own snapshot and temporary copy,
#     never a volume or a snapshot such as pre-epic10-11, and refuses any
#     volume that is not a workspace home or recovery volume;
#   - backup.sh sends the VM nothing but read commands, writes a complete
#     encrypted set or none at all, keeps each VM's sets in its own
#     directory, and prunes only that VM's old sets;
#   - a failed or empty listing never becomes a set that looks complete, and
#     one volume that fails to export does not stop the others;
#   - restore.sh verifies a set, and refuses the wrong VM, an older release,
#     or a VM that already holds workspace volumes or rows, before stopping
#     anything; a restore leaves every workspace stopped;
#   - neither script trusts what came from the VM: a lying VM or a doctored
#     set is refused before any of it reaches a file name or a command, and a
#     file name with a control character is left out of the checks rather
#     than refusing the set;
#   - restore.sh --remove deletes only the set's own instances and volumes,
#     never on the pilot.
#
# Usage: ./infra/tests/backup-scope-test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
export_cmd="${repo}/infra/host/portikus-backup-export"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v age-keygen >/dev/null || { echo "backup-scope-test: age is not installed"; exit 1; }

pass=0
fail=0
ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

INST=ws-0123456789abcdef01234567
HOME_VOL=${INST}-home
REC_VOL=${INST}-recovery
log="${work}/calls.log"
export FAKE_LOG="$log"

mkdir -p "${work}/bin"
# incus: logs every call; `list` shows every kind of volume there is.
cat >"${work}/bin/incus" <<EOF
#!/usr/bin/env bash
printf 'incus %s\n' "\$*" >>"\$FAKE_LOG"
case "\$*" in
  *"storage volume list"*)
    printf '%s\n' container,${INST} custom,${HOME_VOL} custom,${REC_VOL} \\
      custom,${INST}-docker custom,backup-${HOME_VOL} custom,portikus-backups image,abc ;;
  *"storage volume export"*) [ -n "\${FAKE_EXPORT_FAILS:-}" ] && exit 1; printf 'tarball' ;;
esac
exit 0
EOF
cat >"${work}/bin/runuser" <<'EOF'
#!/usr/bin/env bash
printf 'runuser %s\n' "$*" >>"$FAKE_LOG"
EOF
chmod +x "${work}/bin/incus" "${work}/bin/runuser"

run_export() { PATH="${work}/bin:${PATH}" bash "$export_cmd" "$@"; }

echo "--- VM-side export ---"
: >"$log"
run_export volume "$HOME_VOL" >"${work}/out"
expect "export streams the volume" "grep -qx tarball '${work}/out'"
expect "it snapshots the volume as portikus-backup" \
  "grep -q 'snapshot create workspace-data ${HOME_VOL} portikus-backup' '$log'"
expect "it exports the temporary copy, without snapshots" \
  "grep -q 'storage volume export workspace-data backup-${HOME_VOL} /dev/stdout --volume-only' '$log'"
expect "every volume delete names the temporary copy" \
  "! grep 'storage volume delete' '$log' | grep -v 'delete workspace-data backup-${HOME_VOL}\$'"
expect "every snapshot delete names portikus-backup" \
  "! grep 'snapshot delete' '$log' | grep -v 'snapshot delete workspace-data ${HOME_VOL} portikus-backup\$'"
expect "nothing names pre-epic10-11" "! grep -q pre-epic10-11 '$log'"
expect "every call is in the portikus project" "! grep -v -- '--project portikus' '$log' | grep -q ."

: >"$log"
if FAKE_EXPORT_FAILS=1 run_export volume "$HOME_VOL" >/dev/null 2>&1; then
  bad "a failed export exits nonzero"
else
  ok "a failed export exits nonzero"
fi
expect "a failed export still removes its copy and snapshot" \
  "[ \$(grep -c 'delete' '$log') -ge 4 ] && grep -q 'snapshot delete workspace-data ${HOME_VOL} portikus-backup' '$log'"

for name in "${INST}-docker" "$INST" portikus-backups \
  "../${HOME_VOL}" "${HOME_VOL}/pre-epic10-11" "${HOME_VOL} x" ""; do
  : >"$log"
  if run_export volume "$name" >/dev/null 2>&1; then
    bad "refuses to export '${name}'"
  elif [ -s "$log" ]; then
    bad "refuses '${name}' before calling incus"
  else
    ok "refuses to export '${name}'"
  fi
done

run_export volumes >"${work}/out"
expect "volumes lists only home and recovery volumes" \
  "[ \"\$(tr '\n' ' ' <'${work}/out')\" = '${REC_VOL} ${HOME_VOL} ' ] || [ \"\$(tr '\n' ' ' <'${work}/out')\" = '${HOME_VOL} ${REC_VOL} ' ]"

: >"$log"
run_export db >/dev/null
expect "db is a pg_dump as postgres" "grep -qx 'runuser -u postgres -- pg_dump -Fc portikus' '$log'"

echo "--- host backup ---"
# A small volume export: one file, one Git repository, and two files whose
# names hold a tab and a newline.
python3 - "${work}/volume.tar.gz" <<'EOF'
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as t:
    for name, data in [("backup/index.yaml", b"name: x\n"),
                       ("backup/volume/projects/demo/a.txt", b"hello\n"),
                       ("backup/volume/projects/demo/tab\there.txt", b"tab\n"),
                       ("backup/volume/projects/demo/new\nline.txt", b"newline\n"),
                       ("backup/volume/projects/demo/.git/HEAD", b"ref: refs/heads/main\n"),
                       ("backup/volume/projects/demo/.git/refs/heads/main", b"1" * 40 + b"\n")]:
        info = tarfile.TarInfo(name); info.size = len(data)
        t.addfile(info, io.BytesIO(data))
EOF

# ssh: logs the remote command and answers like the VM would.  Like the real
# one, -n leaves it no standard input to wait on.
cat >"${work}/bin/ssh" <<EOF
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  case "\$1" in -n) exec </dev/null; shift ;; -o) shift 2 ;; deploy@*) shift; break ;; *) shift ;; esac
done
cmd="\$*"
printf 'ssh %s\n' "\$cmd" >>"\$FAKE_LOG"
X=" portikus-backup-export"
case "\$cmd" in
  hostname) echo "\${FAKE_HOSTNAME:-portikus-rehearsal}" ;;
  dpkg-query*) printf '%s' "\${FAKE_VERSION:-0.1.348+g001e10e}" ;;
  *"\$X volumes")
    [ -n "\${FAKE_VOLUMES_FAIL:-}" ] && exit 255
    [ -n "\${FAKE_VOLUMES_EMPTY:-}" ] && exit 0
    printf '%s\n' ${HOME_VOL} ${REC_VOL} \${FAKE_EXTRA_VOLUME:-} ;;
  *"\$X db") [ -n "\${FAKE_DB_FAILS:-}" ] && exit 1; printf 'PGDMP fake dump' ;;
  *"\$X counts") echo "users 3 workspaces 1 projects 6" ;;
  *"\$X workspaces") [ -n "\${FAKE_WORKSPACES_EMPTY:-}" ] && exit 0; echo "\${FAKE_WORKSPACE:-11111111-2222-3333-4444-555555555555 ${INST}}" ;;
  *"\$X instances") echo "${INST}" ;;
  *"\$X idmap "*) echo '[{"Isuid":true,"Hostid":1327680}]' ;;
  *"\$X volume "*) [ "\${cmd##* }" = "\${FAKE_VOLUME_FAILS:-}" ] && exit 1; cat "${work}/volume.tar.gz" ;;
  "incus image show"*) ;;
  "incus storage volume list"*) printf '%s\n' \${FAKE_EXISTING:-} ;;
  "incus storage volume file pull"*)
    path=\$(sed -E 's|^.* workspace-data ws-[0-9a-f]{24}-[a-z]+/(.*) - --project portikus\$|\1|' <<<"\$cmd")
    tar -xzOf "${work}/volume.tar.gz" "backup/volume/\${path}" ;;
  *psql*)
    sql=\$(cat)
    printf 'sql %s\n' "\$sql" >>"\$FAKE_LOG"
    case "\$sql" in
      *"'users '"*) echo "users 3 workspaces 1 projects 6" ;;
      *"FROM users) +"*) echo "\${FAKE_ROWS:-0}" ;;
    esac ;;
  *) cat >/dev/null ;;
esac
EOF
chmod +x "${work}/bin/ssh"

age-keygen -o "${work}/key.txt" 2>/dev/null
age-keygen -y "${work}/key.txt" >"${work}/recipients.txt"
sets="${work}/sets"
mine="${sets}/portikus-rehearsal"
mkdir -m 0700 "$sets" "$mine" "${sets}/portikus"
# Fifteen older sets and one directory that is not a set, for this VM; a set
# of another VM's, and one left at the top level by an older backup.sh.
for i in $(seq -w 1 15); do mkdir "${mine}/202601${i}T000000Z"; done
mkdir "${mine}/keep-me" "${sets}/portikus/20250101T000000Z" "${sets}/20250101T000000Z"

run_backup() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    PORTIKUS_USERS_FILE="${work}/no-users.json" bash "${repo}/infra/host/backup.sh" 10.101.0.210
}
set_count() { find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | wc -l; }
all_sets() { find "$sets" -mindepth 1 | sort; }

: >"$log"
if run_backup >"${work}/backup.out" 2>&1; then ok "backup.sh completes against the fake VM"; else bad "backup.sh completes against the fake VM"; cat "${work}/backup.out"; fi
expect "the VM is sent only hostname, dpkg-query and the export script's read commands" \
  "! grep '^ssh ' '$log' | sed 's/^ssh //' | grep -vE '^(hostname|dpkg-query .*|sudo bash -c \"\\\$\\(echo [A-Za-z0-9+/=]+ \\| base64 -d\\)\" portikus-backup-export (volumes|db|counts|workspaces|instances|(idmap|volume) ws-[0-9a-f]{24}-(home|recovery)))\$'"
sent=$(grep -m1 -oE 'echo [A-Za-z0-9+/=]+ \| base64' "$log" | cut -d' ' -f2)
expect "the script it sends is the export script tested above" "[ \"\$(printf '%s' '$sent' | base64 -d | sha256sum)\" = \"\$(sha256sum <'$export_cmd')\" ]"
newest=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
expect "the set goes in the VM's own directory, named by hostname" "[ -n '$newest' ] && [ -f '${newest}/MANIFEST.age' ]"
expect "the set holds the dump, both volumes, their indexes and the MANIFEST" \
  "[ -f '${newest}/db.dump.age' ] && [ -f '${newest}/${HOME_VOL}.age' ] && [ -f '${newest}/${REC_VOL}.index.age' ] && [ -f '${newest}/MANIFEST.age' ]"
expect "a complete set has no FAILED file" "[ ! -e '${newest}/FAILED' ]"
expect "nothing in the set is readable without the key" "! grep -rq 'PGDMP' '$newest'"
expect "the set directory is private" "[ \"\$(stat -c %a '$newest')\" = 700 ]"
expect "fourteen sets are kept" "[ \$(set_count) = 14 ]"
expect "the oldest sets are the ones removed" "[ ! -d '${mine}/20260101T000000Z' ] && [ ! -d '${mine}/20260102T000000Z' ] && [ -d '${mine}/20260103T000000Z' ]"
expect "a directory that is not a set is left alone" "[ -d '${mine}/keep-me' ]"
expect "another VM's sets are left alone" "[ -d '${sets}/portikus/20250101T000000Z' ]"
expect "a set from before per-VM directories is left alone" "[ -d '${sets}/20250101T000000Z' ]"
age -d -i "${work}/key.txt" "${newest}/${HOME_VOL}.index.age" >"${work}/index" 2>/dev/null
expect "the index records the file's checksum" "grep -q \"\\\"f\\\": \\\"projects/demo/a.txt\\\".*\$(printf 'hello\n' | sha256sum | cut -d' ' -f1)\" '${work}/index'"
expect "the index records the Git HEAD" "grep -q '\"git\": \"projects/demo\".*\"head\": \"1111111111111111111111111111111111111111\"' '${work}/index'"

# no_set LABEL ENV... -- the backup fails and leaves the directory as it was.
no_set() {
  local label=$1 before
  shift
  before=$(all_sets)
  if env "$@" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    PORTIKUS_USERS_FILE="${work}/no-users.json" bash "${repo}/infra/host/backup.sh" 10.101.0.210 >"${work}/refusal" 2>&1; then
    bad "$label"
  elif [ "$(all_sets)" != "$before" ]; then
    bad "${label} (it left a set or a partial directory)"
  else
    ok "$label"
  fi
}
no_set "a failed database dump fails the backup and leaves no set" FAKE_DB_FAILS=1
no_set "a failed volume listing fails the backup and leaves no set" FAKE_VOLUMES_FAIL=1
no_set "an empty volume listing, while a workspace's instance exists, leaves no set" FAKE_VOLUMES_EMPTY=1
expect "the refusal names the workspace with no home volume" "grep -q 'no ${HOME_VOL}' '${work}/refusal'"
no_set "a workspace listing that disagrees with the row count leaves no set" FAKE_WORKSPACES_EMPTY=1

# Only the home volume's export fails.  Set names have one-second resolution.
sleep 1
: >"$log"
if FAKE_VOLUME_FAILS="$HOME_VOL" run_backup >"${work}/backup.out" 2>&1; then
  bad "a failed volume export makes the run exit non-zero"
else
  ok "a failed volume export makes the run exit non-zero"
fi

partial=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
expect "the other volumes are still exported after one fails" "grep -q 'portikus-backup-export volume ${REC_VOL}' '$log'"
expect "the set is kept, with the other volume and without the failed one" \
  "[ -f '${partial}/${REC_VOL}.age' ] && [ ! -e '${partial}/${HOME_VOL}.age' ] && [ -f '${partial}/MANIFEST.age' ]"
expect "the set's FAILED file names the failed volume" "[ \"\$(cat '${partial}/FAILED' 2>/dev/null)\" = '${HOME_VOL}' ]"
age -d -i "${work}/key.txt" "${partial}/MANIFEST.age" >"${work}/partial-manifest" 2>/dev/null
expect "the MANIFEST records the failure" "grep -qx 'failed ${HOME_VOL}' '${work}/partial-manifest' && ! grep -q '^volume ${HOME_VOL}' '${work}/partial-manifest'"
expect "the run says which volume failed" "grep -q 'failed to export (${HOME_VOL})' '${work}/backup.out'"
expect "an incomplete set does not count toward the fourteen" "[ \$(set_count) = 15 ] && [ -d '${mine}/20260103T000000Z' ]"

echo "--- restore ---"
run_restore() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_IDENTITY="${work}/key.txt" bash "${repo}/infra/host/restore.sh" "$@"
}
if run_restore --check "$newest" >"${work}/check.out" 2>&1; then
  ok "--check verifies a good set, whose index has names with a tab and a newline"
else
  bad "--check verifies a good set, whose index has names with a tab and a newline"; cat "${work}/check.out"
fi
cp -r "$newest" "${work}/broken"
age -R "${work}/recipients.txt" -o "${work}/broken/db.dump.age" <<<"not the dump"
if run_restore --check "${work}/broken" >/dev/null 2>&1; then bad "--check refuses a set whose file does not match"; else ok "--check refuses a set whose file does not match"; fi
if run_restore --check "$partial" >"${work}/check.out" 2>&1 && grep -q "incomplete set: ${HOME_VOL}" "${work}/check.out"; then
  ok "--check accepts an incomplete set and names the failed volume"
else
  bad "--check accepts an incomplete set and names the failed volume"
fi

refused_before_stop() { # LABEL SET ENV...
  local label=$1 set=$2
  shift 2
  : >"$log"
  if env "$@" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_IDENTITY="${work}/key.txt" \
    bash "${repo}/infra/host/restore.sh" --target-name portikus-rehearsal 10.101.0.210 "$set" >/dev/null 2>&1; then
    bad "$label"
  elif grep -qE 'systemctl|pg_restore|import|UPDATE' "$log"; then
    bad "${label} (it acted first)"
  else
    ok "$label"
  fi
}
refused_before_stop "restore refuses a VM with another hostname, such as the pilot" "$newest" FAKE_HOSTNAME=portikus
refused_before_stop "restore refuses a VM on an older release" "$newest" FAKE_VERSION=0.1.300
refused_before_stop "restore refuses a VM that already has the set's volumes" "$newest" FAKE_EXISTING="$HOME_VOL"
refused_before_stop "restore refuses a VM that has any other workspace volume" "$newest" FAKE_EXISTING="ws-ffffffffffffffffffffffff-docker"
refused_before_stop "restore refuses a VM that has users, workspaces or projects" "$newest" FAKE_ROWS=2
refused_before_stop "restore refuses an incomplete set" "$partial"
if run_restore 10.101.0.210 "$newest" >/dev/null 2>&1; then bad "restore requires --target-name"; else ok "restore requires --target-name"; fi

: >"$log"
if run_restore --target-name portikus-rehearsal 10.101.0.210 "$newest" >"${work}/restore.out" 2>&1; then
  ok "restore completes onto an empty VM"
else
  bad "restore completes onto an empty VM"; cat "${work}/restore.out"
fi
expect "restore marks every workspace stopped right after pg_restore" \
  "grep -A2 'pg_restore' '$log' | grep -q \"UPDATE workspaces SET state = 'stopped', desired_state = 'stopped'\$\""
expect "restore samples the plainly named file" "grep -q 'file pull .*projects/demo/a.txt' '$log'"
expect "restore leaves the names with a tab or a newline out of the sample" "! grep -qE 'tab|line\\.txt' '$log'"

echo "--- hostile input ---"
lying_vm() { # LABEL ENV...
  local label=$1 before_sets
  shift
  before_sets=$(all_sets)
  if env "$@" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    PORTIKUS_USERS_FILE="${work}/no-users.json" bash "${repo}/infra/host/backup.sh" 10.101.0.210 >"${work}/refusal" 2>&1; then
    bad "$label"
  elif [ "$(all_sets)" != "$before_sets" ] || [ -e "${work}/evil" ]; then
    bad "${label} (it wrote something)"
  elif ! grep -q 'not in the expected form' "${work}/refusal"; then
    bad "${label} (refused for another reason: $(tail -1 "${work}/refusal"))"
  else
    ok "$label"
  fi
}
lying_vm "backup refuses a volume name that climbs out of the set" FAKE_EXTRA_VOLUME="../../evil"
lying_vm "backup refuses a volume name with shell characters" FAKE_EXTRA_VOLUME="${HOME_VOL};touch"
lying_vm "backup refuses a workspace line that is not an id and a name" FAKE_WORKSPACE='x; rm -rf /'
lying_vm "backup refuses a hostname that climbs out of the backup directory" FAKE_HOSTNAME='../evil'
# shellcheck disable=SC2016  # the command substitution is the attack
lying_vm "backup refuses a forged package version" FAKE_VERSION='1.0 $(touch evil)'

# doctored NAME -- a copy of the good set, for one test to spoil.
doctored() { rm -rf "${work:?}/$1"; cp -r "$newest" "${work}/$1"; printf '%s' "${work}/$1"; }
# The refusal has to be the form check, not some other failure.
refuse_set() { # LABEL SET
  if run_restore --check "$2" >"${work}/refusal" 2>&1; then
    bad "$1"
  elif grep -q 'not in the expected form' "${work}/refusal"; then
    ok "$1"
  else
    bad "${1} (refused for another reason: $(tail -1 "${work}/refusal"))"
  fi
}
age -d -i "${work}/key.txt" "${newest}/MANIFEST.age" >"${work}/manifest.txt"
d=$(doctored m1)
{ cat "${work}/manifest.txt"; echo "file ../../evil 1 $(printf x | sha256sum | cut -d' ' -f1)"; } \
  | age -R "${work}/recipients.txt" -o "${d}/MANIFEST.age"
refuse_set "restore refuses a MANIFEST that names a file outside the set" "$d"
d=$(doctored m2)
sed "s|^volume ${HOME_VOL} \([0-9]*\) \([0-9a-f]*\) .*|volume ${HOME_VOL} \1 \2 x';touch evil'|" "${work}/manifest.txt" \
  | age -R "${work}/recipients.txt" -o "${d}/MANIFEST.age"
refuse_set "restore refuses an ID map with shell characters" "$d"
d=$(doctored m3)
{ cat "${work}/manifest.txt"; echo "workspace 11111111-2222-3333-4444-555555555555 ws-x;reboot"; } \
  | age -R "${work}/recipients.txt" -o "${d}/MANIFEST.age"
refuse_set "restore refuses an instance name that is not one" "$d"
d=$(doctored m4)
printf '%s\n' '{"f": "../../etc/shadow", "size": 1, "sha256": "'"$(printf x | sha256sum | cut -d' ' -f1)"'"}' \
  | age -R "${work}/recipients.txt" -o "${d}/${HOME_VOL}.index.age"
refuse_set "restore refuses an index path that climbs out of the volume" "$d"
d=$(doctored m5)
# shellcheck disable=SC2016  # the command substitution is the attack
printf '%s\n' '{"git": "projects/x", "ref": null, "head": "$(reboot)"}' \
  | age -R "${work}/recipients.txt" -o "${d}/${HOME_VOL}.index.age"
refuse_set "restore refuses a Git HEAD that is not a commit id" "$d"

echo "--- restore --remove ---"
: >"$log"
if run_restore --remove --target-name portikus 10.101.0.210 "$newest" >/dev/null 2>&1 \
  || FAKE_HOSTNAME=portikus run_restore --remove --target-name portikus 10.101.0.210 "$newest" >/dev/null 2>&1; then
  bad "--remove refuses the pilot"
elif grep -qE 'delete|dropdb|systemctl' "$log"; then
  bad "--remove refuses the pilot (it acted first)"
else
  ok "--remove refuses the pilot"
fi
: >"$log"
if run_restore --remove --target-name portikus-rehearsal 10.101.0.210 "$newest" >/dev/null 2>&1; then
  ok "--remove completes on the rehearsal VM"
else
  bad "--remove completes on the rehearsal VM"
fi
expect "--remove deletes only the set's instance and its three volumes" \
  "[ \$(grep -c 'delete' '$log') = 4 ] && ! grep 'delete' '$log' | grep -v '${INST}'"
expect "--remove leaves an empty database" "grep -q 'dropdb --if-exists portikus' '$log'"

# A set whose workspace had no instance name still lists its volumes.
sleep 1
FAKE_WORKSPACE="11111111-2222-3333-4444-555555555555 -" run_backup >/dev/null 2>&1
orphan=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
: >"$log"
run_restore --remove --target-name portikus-rehearsal 10.101.0.210 "$orphan" >/dev/null 2>&1
expect "--remove deletes every volume on a volume line, not only those of named instances" \
  "grep -q 'volume delete workspace-data ${HOME_VOL} ' '$log' && grep -q 'volume delete workspace-data ${REC_VOL} ' '$log'"

echo ""
echo "--- backup scope: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
