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
#     or a VM that already holds workspace volumes or rows other than the
#     local administrator, before stopping anything; a restore leaves every workspace stopped, skips Dex's
#     accounts on a VM without Dex, and starts Dex again if loading fails;
#     a set without Dex's accounts makes the local administrator change its
#     password, since Dex still holds the VM's one-time password;
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
  *"config get storage.backups_volume"*) echo workspace-data/portikus-backups ;;
  *"storage volume get workspace-data portikus-backups size"*) echo 30GiB ;;
  *"storage volume get workspace-data ${HOME_VOL} size"*) echo "\${FAKE_HOME_SIZE:-100GiB}" ;;
  *"storage volume get workspace-data ${REC_VOL} size"*) echo 3GiB ;;
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
expect "every call but the staging volume's is in the portikus project" \
  "! grep -v -- '--project portikus' '$log' | grep -vE '^incus (config get storage.backups_volume|--project default storage volume (get|set) workspace-data portikus-backups size.*)\$' | grep -q ."
expect "a home larger than the staging volume grows it to the home plus 2 GiB, before the export" \
  "grep -n 'storage volume set workspace-data portikus-backups size=102GiB\$' '$log' | grep -q . && [ \$(grep -n 'portikus-backups size=' '$log' | cut -d: -f1) -lt \$(grep -n 'storage volume export' '$log' | cut -d: -f1) ]"
: >"$log"
run_export volume "$REC_VOL" >/dev/null
expect "a volume that fits never changes the staging volume" "! grep -q 'volume set' '$log'"
: >"$log"
FAKE_HOME_SIZE=1073741824000 run_export volume "$HOME_VOL" >/dev/null
expect "a size in bytes is read too, and rounded up" "grep -q 'portikus-backups size=1002GiB\$' '$log'"

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
: >"$log"
run_export dex-db >/dev/null
expect "dex-db is a pg_dump of Dex's database as postgres" "grep -qx 'runuser -u postgres -- pg_dump -Fc dex' '$log'"

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
  *"\$X has-dex") echo "\${FAKE_HAS_DEX:-1}" ;;
  *"\$X dex-db") printf 'PGDMP fake dex dump' ;;
  *"\$X counts") echo "users 3 workspaces 1 projects 6" ;;
  *"\$X workspaces") [ -n "\${FAKE_WORKSPACES_EMPTY:-}" ] && exit 0
    [ -z "\${FAKE_WORKSPACE_BYTES:-}" ] || { head -c "\$FAKE_WORKSPACE_BYTES" /dev/zero | tr '\\0' a; exit 0; }
    echo "\${FAKE_WORKSPACE:-11111111-2222-3333-4444-555555555555 ${INST}}" ;;
  *"\$X instances")
    echo "${INST}"
    [ -z "\${FAKE_MORE_INSTANCES:-}" ] || for i in \$(seq 1 "\$FAKE_MORE_INSTANCES"); do printf 'ws-%024x\\n' "\$i"; done ;;
  *"\$X idmap "*)
    [ -z "\${FAKE_IDMAP_BYTES:-}" ] || { printf '[%*s]\\n' "\$FAKE_IDMAP_BYTES" '' | tr ' ' 1; exit 0; }
    echo '[{"Isuid":true,"Hostid":1327680}]' ;;
  *"\$X volume "*)
    [ "\${cmd##* }" = "\${FAKE_VOLUME_FAILS:-}" ] && exit 1
    if [ -n "\${FAKE_VOLUME_FILE:-}" ] && { [ -z "\${FAKE_VOLUME_FILE_FOR:-}" ] || [ "\${cmd##* }" = "\$FAKE_VOLUME_FILE_FOR" ]; }; then
      cat "\$FAKE_VOLUME_FILE"; exit "\${FAKE_VOLUME_EXIT:-0}"
    fi
    cat "${work}/volume.tar.gz" ;;
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
      *"FROM users WHERE"*) echo "\${FAKE_ROWS:-0}" ;;
      *"column_name = 'must_change_password'"*) echo 1 ;;
    esac ;;
  *"systemctl cat portikus-dex"*) [ -n "\${FAKE_NO_DEX:-}" ] && echo no || echo yes ;;
  *pg_restore*)
    dump=\$(cat)
    [ -n "\${FAKE_DEX_RESTORE_FAILS:-}" ] && [[ "\$dump" == *"fake dex dump"* ]] && exit 1
    true ;;
  *) cat >/dev/null ;;
esac
EOF
chmod +x "${work}/bin/ssh"
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
chmod +x "${work}/bin/df"

age-keygen -o "${work}/key.txt" 2>/dev/null
age-keygen -y "${work}/key.txt" >"${work}/recipients.txt"
# The host's backup account signs with the derived MAC key, never the identity.
python3 "${repo}/infra/host/portikus-backup-mac" derive "${work}/key.txt" >"${work}/mac-key.txt"
export PORTIKUS_BACKUP_MAC_KEY="${work}/mac-key.txt"
sets="${work}/sets"
mine="${sets}/portikus-rehearsal"
mkdir -m 0700 "$sets" "$mine" "${sets}/portikus"
# Fifteen older sets and one directory that is not a set, for this VM; a set
# of another VM's, and one left at the top level by an older backup.sh.
for i in $(seq -w 1 15); do mkdir "${mine}/202601${i}T000000Z"; done
mkdir "${mine}/keep-me" "${sets}/portikus/20250101T000000Z" "${sets}/20250101T000000Z"

run_backup() {
  PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210
}
set_count() { find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | wc -l; }
all_sets() { find "$sets" -mindepth 1 | sort; }

: >"$log"
if run_backup >"${work}/backup.out" 2>&1; then ok "backup.sh completes against the fake VM"; else bad "backup.sh completes against the fake VM"; cat "${work}/backup.out"; fi
expect "the VM is sent only hostname, dpkg-query and the export script's read commands" \
  "! grep '^ssh ' '$log' | sed 's/^ssh //' | grep -vE '^(hostname|dpkg-query .*|sudo bash -c \"\\\$\\(echo [A-Za-z0-9+/=]+ \\| base64 -d\\)\" portikus-backup-export (volumes|db|has-dex|dex-db|counts|workspaces|instances|(idmap|volume) ws-[0-9a-f]{24}-(home|recovery)))\$'"
sent=$(grep -m1 -oE 'echo [A-Za-z0-9+/=]+ \| base64' "$log" | cut -d' ' -f2)
expect "the script it sends is the export script tested above" "[ \"\$(printf '%s' '$sent' | base64 -d | sha256sum)\" = \"\$(sha256sum <'$export_cmd')\" ]"
newest=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
expect "the set goes in the VM's own directory, named by hostname" "[ -n '$newest' ] && [ -f '${newest}/MANIFEST.age' ]"
expect "the set holds both dumps, both volumes, their indexes and the MANIFEST" \
  "[ -f '${newest}/db.dump.age' ] && [ -f '${newest}/dex.dump.age' ] && [ -f '${newest}/${HOME_VOL}.age' ] && [ -f '${newest}/${REC_VOL}.index.age' ] && [ -f '${newest}/MANIFEST.age' ]"
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
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210 >"${work}/refusal" 2>&1; then
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
# The disk floor (ADR 0039): no run starts without room for another set.
no_set "a run with less free space than the minimum is refused" PORTIKUS_BACKUP_MIN_FREE_MB=999999999
expect "the refusal says there is not enough free space" "grep -q 'FAIL: refused by the host: not enough free space' '${work}/refusal'"
big=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
# A sparse 200 GiB file makes the last set bigger than the fake 100 GiB free.
truncate -s 200G "${big}/huge"
no_set "a run with less free space than the last complete set is refused" PORTIKUS_BACKUP_MIN_FREE_MB=0
rm -f "${big}/huge"

# The VM names itself, and it is not trusted: a rooted rehearsal VM calling
# itself portikus must not write into, or prune, the pilot's sets.
before=$(all_sets)
if FAKE_HOSTNAME=portikus run_backup >"${work}/refusal" 2>&1; then
  bad "backup refuses a VM whose hostname is not the expected name"
elif [ "$(all_sets)" != "$before" ] || [ -e "${sets}/portikus/.lock" ]; then
  bad "backup refuses a VM whose hostname is not the expected name (it wrote something)"
elif ! grep -q "calls itself 'portikus'" "${work}/refusal"; then
  bad "backup refuses a VM whose hostname is not the expected name (refused for another reason: $(tail -1 "${work}/refusal"))"
else
  ok "backup refuses a VM whose hostname is not the expected name"
fi
if PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
  bash "${repo}/infra/host/backup.sh" 10.101.0.210 >/dev/null 2>&1; then
  bad "backup requires --vm-name"
else
  ok "backup requires --vm-name"
fi

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
expect "the run says which volume failed" "grep -q 'failed to export (${HOME_VOL}: the export failed)' '${work}/backup.out'"
expect "an incomplete set does not count toward the fourteen" "[ \$(set_count) = 15 ] && [ -d '${mine}/20260103T000000Z' ]"

# A VM whose export fails every night: incomplete sets are capped at the
# newest fourteen too, and the last complete set is never removed.
flaky="${sets}/portikus-flaky"
mkdir -m 0700 "$flaky" "${flaky}/20250101T000000Z"
for i in $(seq -w 1 20); do mkdir "${flaky}/202601${i}T000000Z" && echo x >"${flaky}/202601${i}T000000Z/FAILED"; done
FAKE_HOSTNAME=portikus-flaky FAKE_VOLUME_FAILS="$HOME_VOL" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" \
  PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
  bash "${repo}/infra/host/backup.sh" --vm-name portikus-flaky 10.101.0.210 >/dev/null 2>&1
flaky_incomplete=$(find "$flaky" -mindepth 2 -maxdepth 2 -name FAILED | wc -l)
expect "only the newest fourteen incomplete sets are kept" "[ '$flaky_incomplete' = 14 ]"
expect "the oldest incomplete sets are the ones removed" "[ ! -d '${flaky}/20260107T000000Z' ] && [ -d '${flaky}/20260108T000000Z' ]"
expect "the only complete set is kept, however old" "[ -d '${flaky}/20250101T000000Z' ]"

# The retention floor (ADR 0039): a compromised VM that requests backup
# after backup cannot prune young sets, nor go below the kept count.
floor_run() {
  env "$@" FAKE_HOSTNAME=portikus-floor PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" \
    PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" PORTIKUS_BACKUP_KEEP=1 \
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-floor 10.101.0.210 >/dev/null 2>&1
}
ago() { date -u -d "-$1 days" +%Y%m%dT%H%M%SZ; }
floor="${sets}/portikus-floor"
mkdir -m 0700 "$floor"
young1=$(ago 1) young5=$(ago 5) old30=$(ago 30)
mkdir "${floor}/${young1}" "${floor}/${young5}" "${floor}/${old30}"
for _ in 1 2 3; do sleep 1; floor_run; done
expect "repeated backups never remove a set younger than the minimum age" "[ -d '${floor}/${young1}' ] && [ -d '${floor}/${young5}' ]"
expect "an old set beyond the floor is still pruned" "[ ! -d '${floor}/${old30}' ]"
rm -rf "$floor"
mkdir -m 0700 "$floor"
old10=$(ago 10) old20=$(ago 20) old40=$(ago 40)
mkdir "${floor}/${old10}" "${floor}/${old20}" "${floor}/${old40}"
sleep 1
floor_run PORTIKUS_BACKUP_MIN_AGE_DAYS=0
expect "the newest three complete sets are kept even with KEEP at one" \
  "[ -d '${floor}/${old10}' ] && [ -d '${floor}/${old20}' ] && [ ! -d '${floor}/${old40}' ] && [ \$(find '$floor' -mindepth 1 -maxdepth 1 -type d | wc -l) = 3 ]"

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
# shellcheck disable=SC2034  # read inside expect's eval
restore_sql=$(grep -A2 'pg_restore' "$log" | grep '^sql ' | head -1)
expect "restore marks every workspace stopped right after pg_restore" \
  "[[ \"\$restore_sql\" == *\"UPDATE workspaces SET state = 'stopped', desired_state = 'stopped';\"* ]]"
expect "restore ends every session and preview session in the same transaction" \
  "[[ \"\$restore_sql\" == 'sql BEGIN; '*'DELETE FROM preview_sessions; DELETE FROM sessions; COMMIT;' ]]"
expect "restore loads Dex's accounts with Dex stopped, then starts it" \
  "grep -A2 'systemctl stop portikus-dex' '$log' | grep -q 'pg_restore' && grep -q 'systemctl start portikus-dex' '$log'"
# The protobuf IDTokenSubject{user_id: "local-admin", conn_id: "local"}, as
# packages/auth's dexLocalSubject encodes it, worked out here independently.
# shellcheck disable=SC2034  # read inside expect's eval
admin_subject=$(python3 -c 'import base64; print(base64.urlsafe_b64encode(b"\x0a\x0blocal-admin\x12\x05local").decode().rstrip("="))')
expect "restore counts every user but the local administrator, found by its Dex subject and username" \
  "grep -q \"^sql SELECT (SELECT count(\\*) FROM users WHERE NOT (oidc_subject = '\${admin_subject}' AND preferred_username = 'admin')) + (SELECT count(\\*) FROM workspaces) + (SELECT count(\\*) FROM projects)\$\" '$log'"
expect "restore samples the plainly named file" "grep -q 'file pull .*projects/demo/a.txt' '$log'"
expect "restore leaves the names with a tab or a newline out of the sample" "! grep -qE 'tab|line\\.txt' '$log'"

: >"$log"
if FAKE_NO_DEX=1 run_restore --target-name portikus-rehearsal 10.101.0.210 "$newest" >"${work}/restore.out" 2>&1 \
  && grep -q 'runs no Dex; skipped' "${work}/restore.out"; then
  ok "restore onto a VM without Dex skips Dex's accounts and finishes"
else
  bad "restore onto a VM without Dex skips Dex's accounts and finishes"; cat "${work}/restore.out"
fi
expect "without Dex, restore never stops or starts it" "! grep -qE 'systemctl (stop|start) portikus-dex' '$log'"
: >"$log"
if FAKE_DEX_RESTORE_FAILS=1 run_restore --target-name portikus-rehearsal 10.101.0.210 "$newest" >/dev/null 2>&1; then
  bad "restore fails when Dex's accounts cannot be loaded"
else
  ok "restore fails when Dex's accounts cannot be loaded"
fi
expect "a failed Dex load still starts Dex again" \
  "grep -A10 'systemctl stop portikus-dex' '$log' | grep -q 'systemctl start portikus-dex'"
expect "a set with Dex's accounts leaves the local administrator's flag alone" \
  "! grep -q 'must_change_password = true' '$log'"

# A set without Dex's accounts, onto a VM whose Dex holds a fresh one-time password.
sleep 1
FAKE_HAS_DEX=0 run_backup >/dev/null 2>&1
no_dex=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
: >"$log"
if [ ! -e "${no_dex}/dex.dump.age" ] \
  && run_restore --target-name portikus-rehearsal 10.101.0.210 "$no_dex" >"${work}/restore.out" 2>&1; then
  ok "restore of a set without Dex's accounts completes"
else
  bad "restore of a set without Dex's accounts completes"; cat "${work}/restore.out"
fi
expect "without Dex's accounts, restore makes the local administrator change its password" \
  "grep -qx \"sql UPDATE users SET must_change_password = true WHERE oidc_subject = '\${admin_subject}' AND preferred_username = 'admin'\" '$log'"

echo "--- hostile input ---"
lying_vm() { # LABEL ENV...
  local label=$1 before_sets
  shift
  before_sets=$(all_sets)
  if env "$@" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210 >"${work}/refusal" 2>&1; then
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

echo "--- the run's byte budget ---"
# refused_run LABEL PATTERN ENV... -- the run fails with PATTERN and keeps nothing.
refused_run() {
  local label=$1 pattern=$2 before_sets
  shift 2
  before_sets=$(all_sets)
  if env "$@" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210 >"${work}/refusal" 2>&1; then
    bad "$label"
  elif [ "$(all_sets)" != "$before_sets" ]; then
    bad "${label} (it kept something)"
  elif ! grep -q "$pattern" "${work}/refusal"; then
    bad "${label} (refused for another reason: $(tail -1 "${work}/refusal"))"
  else
    ok "$label"
  fi
}
sleep 1
: >"$log"
fake="ws-aaaaaaaaaaaaaaaaaaaaaaaa"
if FAKE_EXTRA_VOLUME="${fake}-home ${fake}-recovery" run_backup >"${work}/backup.out" 2>&1; then
  ok "volumes of no listed instance do not stop the run"
else
  bad "volumes of no listed instance do not stop the run ($(tail -1 "${work}/backup.out"))"
fi
skipset=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
expect "the set completes with the real volumes" \
  "[ ! -e '${skipset}/FAILED' ] && [ -f '${skipset}/${HOME_VOL}.age' ] && [ -f '${skipset}/${REC_VOL}.age' ]"
expect "nothing is asked for or written for the made-up volumes" \
  "! grep -q '${fake}' '$log' && ! ls '$skipset' | grep -q '${fake}'"
expect "the skip is counted in the set and warned about" \
  "[ \"\$(cat '${skipset}/SKIPPED')\" = 2 ] && grep -q 'WARNING: skipped 2 volumes' '${work}/backup.out'"
if run_restore --check "$skipset" >"${work}/check.out" 2>&1; then
  ok "--check accepts a set that skipped volumes"
else
  bad "--check accepts a set that skipped volumes ($(tail -1 "${work}/check.out"))"
fi
if run_restore --target-name portikus-rehearsal 10.101.0.210 "$skipset" >"${work}/restore.out" 2>&1; then
  ok "a set that skipped volumes restores onto an empty VM"
else
  bad "a set that skipped volumes restores onto an empty VM ($(tail -1 "${work}/restore.out"))"
fi
sleep 1
# Leave the run a budget of 16 MiB, and stream a 64 MiB volume that does
# not compress.
mkdir -p "${work}/big/backup/volume"
head -c 64M /dev/urandom >"${work}/big/backup/volume/noise"
tar -czf "${work}/big.tar.gz" -C "${work}/big" backup
rm -rf "${work}/big"
sleep 1
budget_env=(PORTIKUS_BACKUP_MIN_FREE_MB=100 FAKE_FREE_BYTES=$((116 * 1048576)))
before_bytes=$(du -sb "$mine" | cut -f1)
refused_run "a VM streaming past the run's budget stops the whole run and keeps nothing" "passed its byte budget" \
  "${budget_env[@]}" FAKE_VOLUME_FILE="${work}/big.tar.gz"
expect "the partial set is removed" "! find '$mine' -maxdepth 1 -name '.partial-*' | grep -q ."
expect "the run left the disk as it found it" "[ \$(du -sb '$mine' | cut -f1) -le $before_bytes ]"
# A killed run's 64 MiB leftover is cleared before free space is measured.
partial_dir="${mine}/.partial-20260101T000000Z"
mkdir -p "$partial_dir"
truncate -s 64M "${partial_dir}/leftover"
sleep 1
# 110 MiB free once the leftover is gone, 46 MiB while it is there.
if env PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
  PORTIKUS_BACKUP_MIN_FREE_MB=100 FAKE_FREE_BYTES=$((110 * 1048576)) FAKE_USED_FILE="${partial_dir}/leftover" \
  bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210 >"${work}/backup.out" 2>&1; then
  ok "a leftover partial set does not cause a false free-space refusal"
else
  bad "a leftover partial set does not cause a false free-space refusal ($(tail -1 "${work}/backup.out"))"
fi

# The index counts too (ADR 0039).  A tarball of many empty files with long
# paths compresses to little, but its index would be megabytes.
python3 - "${work}/paths.tar.gz" "${work}/longpath.tar.gz" <<'PY'
import io, sys, tarfile
def build(out, names):
    with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as t:
        for n in names:
            t.addfile(tarfile.TarInfo("backup/volume/" + n), io.BytesIO(b""))
build(sys.argv[1], [f"{i:06d}/" + "d" * 3900 for i in range(3000)])
build(sys.argv[2], ["x" * 5000])
PY
tmp_probe="${work}/tmp-probe"
mkdir -p "$tmp_probe"
sleep 1
refused_run "an index bigger than the budget stops the run and keeps nothing" "passed its byte budget" \
  "${budget_env[@]}" FAKE_VOLUME_FILE="${work}/paths.tar.gz" TMPDIR="$tmp_probe"
expect "the budgeted run leaves no partial set or scratch" "! find '$mine' -maxdepth 1 -name '.partial-*' | grep -q ."
sleep 1
# volume_failed LABEL REASON ENV... -- only the home volume fails, for
# REASON, which the run's last line names; the other volume is kept.
volume_failed() {
  local label=$1 reason=$2 s
  shift 2
  if env "$@" FAKE_VOLUME_FILE_FOR="$HOME_VOL" PATH="${work}/bin:${PATH}" PORTIKUS_BACKUP_DIR="$sets" \
    PORTIKUS_BACKUP_RECIPIENTS="${work}/recipients.txt" \
    bash "${repo}/infra/host/backup.sh" --vm-name portikus-rehearsal 10.101.0.210 >"${work}/backup.out" 2>&1; then
    bad "${label} (the run succeeded)"
    return
  fi
  s=$(find "$mine" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort | tail -1)
  if [ "$(cat "${s}/FAILED" 2>/dev/null)" != "$HOME_VOL" ] || [ ! -f "${s}/${REC_VOL}.age" ] || [ -e "${s}/${HOME_VOL}.age" ]; then
    bad "${label} (the set is not the other volume alone, marked failed)"
  elif ! tail -1 "${work}/backup.out" | grep -q "${HOME_VOL}: ${reason}"; then
    bad "${label} (the reason is missing: $(tail -1 "${work}/backup.out"))"
  else
    ok "$label"
  fi
}
volume_failed "a path longer than 4096 bytes fails only that volume" "a path is longer than 4096 bytes" \
  FAKE_VOLUME_FILE="${work}/longpath.tar.gz" TMPDIR="$tmp_probe"
expect "a run writes nothing to the temporary directory" "[ -z \"\$(ls -A '$tmp_probe')\" ]"
# A tar of directories with 20,000-byte names: every member is checked, not
# only regular files under backup/volume, before tarfile keeps any of them.
python3 - "${work}/longdirs.tar.gz" "${work}/manydirs.tar.gz" <<'PY'
import sys, tarfile
def build(out, names):
    with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as t:
        for n in names:
            i = tarfile.TarInfo(n)
            i.type = tarfile.DIRTYPE
            t.addfile(i)
build(sys.argv[1], [f"elsewhere/{i}" + "d" * 20000 for i in range(200)])
build(sys.argv[2], [f"elsewhere/{i}" for i in range(50)])
PY
sleep 1
volume_failed "a directory name of 20,000 bytes outside the volume fails that volume" "a path is longer than 4096 bytes" \
  FAKE_VOLUME_FILE="${work}/longdirs.tar.gz"
sleep 1
volume_failed "directories count toward the member cap, which fails only that volume" "the volume has more than 10 files" \
  FAKE_VOLUME_FILE="${work}/manydirs.tar.gz" PORTIKUS_BACKUP_MAX_INDEX_ENTRIES=10
# Exports that fail after streaming a large index still spend the budget,
# so a VM cannot repeat them to use more than the budget.  Each index is
# about 12 MB, counted twice; five volumes would need about 120 MB.
sleep 1
refused_run "failed exports still count their index against the budget" "passed its byte budget" \
  PORTIKUS_BACKUP_MIN_FREE_MB=100 FAKE_FREE_BYTES=$((160 * 1048576)) FAKE_VOLUME_FILE="${work}/paths.tar.gz" FAKE_VOLUME_EXIT=1 \
  FAKE_MORE_INSTANCES=2 FAKE_EXTRA_VOLUME="$(printf 'ws-%024x-home ws-%024x-home ws-%024x-recovery' 1 2 2)"
sleep 1

# The Git tables have a total cap (ADR 0039): 1500 repositories with 64 KiB
# packed-refs each would keep over a million refs; the run completes under a 250 MB limit
# on the indexer's address space.
python3 - "${work}/repos.tar.gz" <<'PY'
import io, sys, tarfile
g = "." + "git"
line = ("1" * 40 + " refs/heads/b{}\n")
with tarfile.open(sys.argv[1], "w:gz") as t:
    for r in range(1500):
        data = "".join(line.format(f"{r}-{i}") for i in range(1200)).encode()[:65536]
        info = tarfile.TarInfo(f"backup/volume/r{r}/{g}/packed-refs")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
PY
cat >"${work}/bin/python3" <<EOF
#!/usr/bin/env bash
ulimit -v \${FAKE_PYTHON_KB:-unlimited}
exec $(command -v python3) "\$@"
EOF
chmod +x "${work}/bin/python3"
sleep 1
if FAKE_PYTHON_KB=250000 FAKE_VOLUME_FILE="${work}/repos.tar.gz" run_backup >"${work}/backup.out" 2>&1; then
  ok "many repositories with large packed-refs stay under the memory limit and the run completes"
else
  bad "many repositories with large packed-refs stay under the memory limit and the run completes ($(tail -1 "${work}/backup.out"))"
fi
rm -f "${work}/bin/python3"

echo "--- what the VM may list ---"
sleep 1
refused_run "more than 2000 instances are refused" "instance listing longer than the host accepts" FAKE_MORE_INSTANCES=2000
sleep 1
refused_run "an oversized workspace listing is refused" "workspace listing longer than the host accepts" \
  FAKE_WORKSPACE_BYTES=200000
sleep 1
refused_run "an oversized ID map is refused" "ID map longer than the host accepts" FAKE_IDMAP_BYTES=5000

echo "--- one run per host ---"
flock "${sets}/.lock" sleep 20 &
holder=$!
sleep 1
refused_run "a run waits for another VM's run on this host, then gives up" "another backup on this host" \
  PORTIKUS_BACKUP_LOCK_WAIT_SECONDS=1
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null

# doctored NAME -- a copy of the good set under its own name, for one test to spoil.
doctored() {
  rm -rf "${work:?}/$1"
  mkdir "${work}/$1"
  cp -r "$newest" "${work}/$1/"
  printf '%s' "${work}/$1/$(basename "$newest")"
}
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
# The form checks stay behind the MAC: these sets are spoiled by someone
# holding the key, who can sign them, so the checks are what must refuse.
signed() { python3 "${repo}/infra/host/portikus-backup-mac" sign "${work}/key.txt" "$1"; }
# with_manifest DIR -- encrypt standard input as DIR's MANIFEST and sign it.
with_manifest() { age -R "${work}/recipients.txt" -o "${1}/MANIFEST.age" && signed "$1"; }
# with_index DIR -- standard input becomes the home volume's index, listed in the MANIFEST.
with_index() {
  cat >"${work}/new-index"
  age -R "${work}/recipients.txt" -o "${1}/${HOME_VOL}.index.age" "${work}/new-index"
  sed "s|^index ${HOME_VOL} .*|index ${HOME_VOL} $(stat -c %s "${work}/new-index") $(sha256sum <"${work}/new-index" | cut -d' ' -f1)|" \
    "${work}/manifest.txt" | with_manifest "$1"
}
d=$(doctored m1)
{ cat "${work}/manifest.txt"; echo "file ../../evil 1 $(printf x | sha256sum | cut -d' ' -f1)"; } | with_manifest "$d"
refuse_set "restore refuses a MANIFEST that names a file outside the set" "$d"
d=$(doctored m2)
sed "s|^volume ${HOME_VOL} \([0-9]*\) \([0-9a-f]*\) .*|volume ${HOME_VOL} \1 \2 x';touch evil'|" "${work}/manifest.txt" | with_manifest "$d"
refuse_set "restore refuses an ID map with shell characters" "$d"
d=$(doctored m3)
{ cat "${work}/manifest.txt"; echo "workspace 11111111-2222-3333-4444-555555555555 ws-x;reboot"; } | with_manifest "$d"
refuse_set "restore refuses an instance name that is not one" "$d"
d=$(doctored m4)
printf '%s\n' '{"f": "../../etc/shadow", "size": 1, "sha256": "'"$(printf x | sha256sum | cut -d' ' -f1)"'"}' | with_index "$d"
refuse_set "restore refuses an index path that climbs out of the volume" "$d"
d=$(doctored m5)
# shellcheck disable=SC2016  # the command substitution is the attack
printf '%s\n' '{"git": "projects/x", "ref": null, "head": "$(reboot)"}' | with_index "$d"
refuse_set "restore refuses a Git HEAD that is not a commit id" "$d"

echo "--- authenticated sets (ADR 0044) ---"
# refuse_forged LABEL SET PATTERN -- refused by PATTERN, before anything on the VM changes.
refuse_forged() {
  : >"$log"
  if run_restore --target-name portikus-rehearsal 10.101.0.210 "$2" >"${work}/refusal" 2>&1; then
    bad "$1"
  elif grep -q "$3" "${work}/refusal" && ! grep -qE 'systemctl|pg_restore|import' "$log"; then
    ok "$1"
  else
    bad "${1} (refused for another reason: $(tail -1 "${work}/refusal"))"
  fi
}
expect "a host backup signs its set with the MAC key derived from the identity" \
  "python3 '${repo}/infra/host/portikus-backup-mac' verify '${work}/key.txt' '$newest'"
d=$(doctored f1)
# What anyone with the public recipient can do: a MANIFEST of their own.
sed 's/^counts .*/counts users 1 workspaces 1 projects 1/' "${work}/manifest.txt" \
  | age -R "${work}/recipients.txt" -o "${d}/MANIFEST.age"
refuse_forged "a restore refuses a set whose MANIFEST someone without the key changed" "$d" 'failed verification'
d=$(doctored f2)
age-keygen -o "${work}/attacker.txt" 2>/dev/null
age -R "${work}/recipients.txt" -o "${d}/MANIFEST.age" "${work}/manifest.txt"
python3 "${repo}/infra/host/portikus-backup-mac" sign "${work}/attacker.txt" "$d"
refuse_forged "a restore refuses a forged set signed with another key" "$d" 'failed verification'
d=$(doctored f3)
rm "${d}/MANIFEST.mac"
refuse_forged "a restore refuses a set with no MAC" "$d" 'has no MAC'
d=$(doctored f4)
age -R "${work}/recipients.txt" -o "${d}/${HOME_VOL}.index.age" <<<'{"f": "a", "size": 1, "sha256": "'"$(printf x | sha256sum | cut -d' ' -f1)"'"}'
refuse_forged "a restore refuses a genuine MANIFEST beside an index it does not list" "$d" 'the MANIFEST says'
# A genuine set, untouched, renamed to look like a newer night's.
d=$(doctored f5)
mv "$d" "$(dirname "$d")/20991231T023000Z"
refuse_forged "a restore refuses a genuine set renamed to another time" "$(dirname "$d")/20991231T023000Z" 'named for another time'
# The signing key must be for the recipients, or no set would verify.
age-keygen -o "${work}/other.txt" 2>/dev/null
python3 "${repo}/infra/host/portikus-backup-mac" derive "${work}/other.txt" >"${work}/other-mac.txt"
: >"$log"
no_set "a backup refuses a signing key for other recipients, before any work" PORTIKUS_BACKUP_MAC_KEY="${work}/other-mac.txt"
expect "and says why, having asked the VM nothing" "grep -q 'not for the recipients' '${work}/refusal' && [ ! -s '$log' ]"

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
