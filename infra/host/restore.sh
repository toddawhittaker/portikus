#!/usr/bin/env bash
# Restore a backup set made by backup.sh onto a platform VM
# (docs/adr/0024-backups-pulled-to-host.md, "Restore").
#
# Usage:
#   restore.sh --check <set-dir>
#       decrypt and verify every file of the set; touches no VM
#   restore.sh [--start-check] --target-name <vm-name> <vm-ip> <set-dir>
#       load the database and import the workspace volumes onto a VM with no
#       workspace volumes, workspaces or projects and no users but the local
#       administrator, such as a freshly rebuilt pilot; the backup's database
#       replaces that account; every restored workspace is left stopped
#   restore.sh --remove --target-name <vm-name> <vm-ip> <set-dir>
#       after a rehearsal: delete the set's instances and volumes from the
#       VM and leave it an empty database; refuses the pilot
#   --target-name   the VM's hostname; the script refuses any other machine
#   --start-check   afterwards, start one restored workspace and check its
#                   files and Git HEADs from inside it, then stop it
#
# Everything in a set came from the VM, so it is checked against a strict
# form before it reaches a file name or a command.
#
# Environment:
#   PORTIKUS_BACKUP_IDENTITY  age identity (default ~/.config/portikus/backup-age-key.txt)
set -euo pipefail

IDENTITY="${PORTIKUS_BACKUP_IDENTITY:-${HOME}/.config/portikus/backup-age-key.txt}"
POOL=workspace-data
PROJECT=portikus
PILOT_NAME=portikus
# Files per volume compared with the backup's index after the import.
SAMPLE=20
# dexLocalSubject("local-admin") in packages/auth: the local administrator's subject.
LOCAL_ADMIN_SUBJECT=Cgtsb2NhbC1hZG1pbhIFbG9jYWw
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# Every line backup.sh writes, and nothing else.
MANIFEST_LINE='^(portikus-backup 1|created [0-9]{8}T[0-9]{6}Z|vm [0-9.]+|package [0-9A-Za-z.+~:-]+|counts users [0-9]+ workspaces [0-9]+ projects [0-9]+|workspace [0-9a-f-]{36} (ws-[0-9a-f]{24}|-)|file (db\.dump|dex\.dump|users\.json) [0-9]+ [0-9a-f]{64}|volume ws-[0-9a-f]{24}-(home|recovery) [0-9]+ [0-9a-f]{64} (-|\[[][{}":,A-Za-z0-9]*\])|failed ws-[0-9a-f]{24}-(home|recovery)|seconds [0-9]+)$'

info() { printf '[restore %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[restore] FAIL: %s\n' "$*" >&2; exit 1; }

mode=restore start_check=no target_name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check; shift ;;
    --remove) mode=remove; shift ;;
    --start-check) start_check=yes; shift ;;
    --target-name) target_name="${2:?--target-name needs a value}"; shift 2 ;;
    *) break ;;
  esac
done
if [ "$mode" = check ]; then
  SET="${1:?Usage: restore.sh --check <set-dir>}"
else
  VM="${1:?Usage: restore.sh [--remove] --target-name <vm-name> <vm-ip> <set-dir>}"
  SET="${2:?Usage: restore.sh [--remove] --target-name <vm-name> <vm-ip> <set-dir>}"
  [ -n "$target_name" ] || die "--target-name is required, so a restore cannot land on the wrong VM"
fi

[ -r "$IDENTITY" ] || die "no age identity at ${IDENTITY}; set PORTIKUS_BACKUP_IDENTITY"
[ -f "${SET}/MANIFEST.age" ] || die "${SET} is not a backup set (no MANIFEST.age)"
scratch=$(mktemp -d)
# Set once Dex is stopped, and once a restored workspace is held running.
dex_stopped=no ws_held=no
cleanup() {
  [ "$ws_held" = no ] || release
  # A restore that dies after stopping Dex must not leave sign-in down.
  [ "$dex_stopped" = no ] || vm sudo systemctl start portikus-dex || true
  rm -rf "$scratch"
}
trap cleanup EXIT
t0=$(date +%s)
step_start=$t0
step() {
  local now
  now=$(date +%s)
  info "$1 ($((now - step_start)) s)"
  step_start=$now
}

decrypt() { age -d -i "$IDENTITY" "${SET}/$1.age"; }

# "<bytes> <sha256>" of standard input, as backup.sh records it.
size_sum() {
  python3 -c 'import hashlib, sys
h, n = hashlib.sha256(), 0
for b in iter(lambda: sys.stdin.buffer.read(1 << 20), b""):
    h.update(b); n += len(b)
print(n, h.hexdigest())'
}

# check_index IN OUT -- paths in an index come from a student's home.  An
# absolute path or a ".." part cannot come from an export, so the set is
# refused.  A name with a control character is legal, so it is only left out
# of OUT, the copy of the index the checks sample.
check_index() {
  python3 - "$1" "$2" <<'EOF'
import json, sys
def relative(p):
    return isinstance(p, str) and p and not p.startswith("/") and ".." not in p.split("/")
def plain(p):
    return not any(ord(c) < 32 or ord(c) == 127 for c in p)
with open(sys.argv[2], "w") as out:
    for n, line in enumerate(open(sys.argv[1]), 1):
        r = json.loads(line)
        ok = (("f" in r and relative(r["f"]) and len(r.get("sha256", "")) == 64)
              or ("git" in r and (r["git"] == "." or relative(r["git"]))
                  and (r["head"] is None or (isinstance(r["head"], str) and len(r["head"]) == 40 and r["head"].isalnum()))))
        if not ok:
            sys.exit(f"index line {n} is not in the expected form")
        if plain(r.get("f", r.get("git"))):
            out.write(line)
EOF
}

# ── 1. Prove the key works and every file is whole ────────────────
manifest="${scratch}/MANIFEST"
decrypt MANIFEST >"$manifest" || die "cannot decrypt the MANIFEST with ${IDENTITY}"
n=0
while IFS= read -r line; do
  n=$((n + 1))
  [[ "$line" =~ $MANIFEST_LINE ]] || die "MANIFEST line ${n} is not in the expected form; refusing the set"
done <"$manifest"
head -1 "$manifest" | grep -qx 'portikus-backup 1' || die "unknown MANIFEST format"
grep -q '^file db\.dump ' "$manifest" || die "the MANIFEST lists no database dump"
backup_version=$(awk '$1 == "package" { print $2 }' "$manifest")
info "set $(basename "$SET"): package ${backup_version}, $(awk '$1 == "counts"' "$manifest")"

mapfile -t volumes < <(awk '$1 == "volume" { print $2 }' "$manifest")
mapfile -t instances < <(awk '$1 == "workspace" && $3 != "-" { print $3 }' "$manifest")
while read -r kind name size sum _; do
  case "$kind" in file | volume) ;; *) continue ;; esac
  got=$(decrypt "$name" | size_sum)
  [ "$got" = "$size $sum" ] || die "${name}: ${got}, the MANIFEST says ${size} ${sum}"
  if [ "$kind" = volume ]; then
    decrypt "${name}.index" >"${scratch}/${name}.index.raw"
    check_index "${scratch}/${name}.index.raw" "${scratch}/${name}.index" \
      || die "${name}.index is not in the expected form; refusing the set"
  fi
done <"$manifest"
step "every file decrypts and matches the MANIFEST"
mapfile -t failed < <(awk '$1 == "failed" { print $2 }' "$manifest")
if [ "${#failed[@]}" -gt 0 ]; then
  info "incomplete set: ${failed[*]} failed to export at backup time"
  # Restoring it would give those workspaces empty volumes without a word.
  [ "$mode" != restore ] || die "a restore needs a complete set; use an older one. Nothing was changed"
fi
[ "$mode" = check ] && exit 0

# ── 2. The right VM ───────────────────────────────────────────────
vm() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "deploy@${VM}" "$@"; }
vm_in() { ssh -o BatchMode=yes -o ConnectTimeout=15 "deploy@${VM}" "$@"; }
psql_vm() { printf '%s\n' "$1" | vm_in "sudo runuser -u postgres -- psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus"; }

actual_name=$(vm hostname)
[ "$actual_name" = "$target_name" ] || die "${VM} is '${actual_name}', not '${target_name}'; nothing was changed"

# Mock, Entra and Google sites run no Dex, so a set's Dex accounts have nowhere to go.
dex_installed() { vm "if systemctl cat portikus-dex.service >/dev/null 2>&1; then echo yes; else echo no; fi"; }

start_services() {
  # The API first: its start runs the migrations the worker's queries need.
  vm sudo systemctl start portikus-api
  for _ in $(seq 1 60); do
    vm "curl -sf --max-time 3 http://127.0.0.1:3000/health >/dev/null" && break
    sleep 2
  done
  vm "curl -sf --max-time 3 http://127.0.0.1:3000/health >/dev/null" || die "the API did not become healthy"
  vm sudo systemctl start portikus-worker
}

if [ "$mode" = remove ]; then
  [ "$actual_name" != "$PILOT_NAME" ] || die "--remove never runs on the pilot"
  vm sudo systemctl stop portikus-api portikus-worker
  # The set's volumes, and all three volumes of each of its instances.
  doomed=("${volumes[@]}")
  for inst in "${instances[@]}"; do
    [[ "$inst" =~ $INSTANCE_PATTERN ]] || die "bad instance name ${inst}"
    vm "incus delete --force ${inst} --project ${PROJECT} 2>/dev/null || true"
    info "removed instance ${inst}"
    doomed+=("${inst}-home" "${inst}-recovery" "${inst}-docker")
  done
  for vol in $(printf '%s\n' "${doomed[@]}" | sort -u); do
    vm "incus storage volume delete ${POOL} ${vol} --project ${PROJECT} 2>/dev/null || true"
  done
  info "removed ${#volumes[@]} imported volumes and the instances' own volumes"
  # The restored rows go with a fresh, empty database.
  vm "sudo runuser -u postgres -- dropdb --if-exists portikus && sudo runuser -u postgres -- createdb -O portikus portikus"
  if grep -q '^file dex\.dump ' "$manifest" && [ "$(dex_installed)" = yes ]; then
    # Dex makes its tables again when it starts on the empty database.
    dex_stopped=yes
    vm "sudo systemctl stop portikus-dex && sudo runuser -u postgres -- dropdb --if-exists dex && sudo runuser -u postgres -- createdb -O portikus-dex dex"
    vm sudo systemctl start portikus-dex
    dex_stopped=no
  fi
  start_services
  step "the set's workspaces and the restored database are gone from ${target_name}"
  exit 0
fi

# ── 3. A VM that can take the set ─────────────────────────────────
target_version=$(vm "dpkg-query -W -f='\${Version}' portikus")
# Migrations only run forward, so the target must be at least as new.
dpkg --compare-versions "$target_version" ge "$backup_version" \
  || die "${target_name} runs portikus ${target_version}, older than the backup's ${backup_version}"
vm "incus image show portikus --project ${PROJECT} >/dev/null" \
  || die "${target_name} has no workspace image; run make build-workspace-image first"
# A restore replaces the whole database, so the target must hold nothing a
# restore could destroy: a freshly configured VM has no workspace volumes, no
# workspaces or projects, and no users but the local administrator the play
# made.  This is what keeps it off a live pilot.
existing=$(vm "incus storage volume list ${POOL} --project ${PROJECT} --format csv --columns n")
if grep -qE '^ws-' <<<"$existing"; then
  die "${target_name} already has workspace volumes ($(grep -cE '^ws-' <<<"$existing")); restore only onto a VM without any. Nothing was changed"
fi
rows=$(psql_vm "SELECT (SELECT count(*) FROM users WHERE NOT (oidc_subject = '${LOCAL_ADMIN_SUBJECT}' AND preferred_username = 'admin')) + (SELECT count(*) FROM workspaces) + (SELECT count(*) FROM projects)") \
  || die "cannot count the rows on ${target_name}; nothing was changed"
[ "$rows" = 0 ] || die "${target_name} already has ${rows:-unknown} users, workspaces and projects besides the local administrator; restore only onto an empty VM. Nothing was changed"
info "target ${target_name} (${VM}), portikus ${target_version}"

# ── 4. Database ───────────────────────────────────────────────────
# The controller stays up: it recreates the instances below.
vm sudo systemctl stop portikus-api portikus-worker
info "portikus-api and portikus-worker stopped; they stay stopped if the restore fails"
# --create --clean drops and recreates the whole database, so no table a
# newer release added survives to confuse the migrations.
decrypt db.dump | vm_in "sudo runuser -u postgres -- pg_restore --create --clean --if-exists --exit-on-error -d postgres"
# Stopped, or every workspace running at backup time starts at once.  The
# sessions go too, so a cookie stolen before the backup does not work here.
psql_vm "BEGIN; UPDATE workspaces SET state = 'stopped', desired_state = 'stopped'; DELETE FROM preview_sessions; DELETE FROM sessions; COMMIT;"
step "database restored, every workspace marked stopped, every session ended"
# Dex's accounts (docs/archive/epics/EPIC-14.md ruling 19), with Dex stopped so the
# database can be replaced; a set from before Dex had storage has none.
if grep -q '^file dex\.dump ' "$manifest"; then
  if [ "$(dex_installed)" = yes ]; then
    dex_stopped=yes
    vm sudo systemctl stop portikus-dex
    decrypt dex.dump | vm_in "sudo runuser -u postgres -- pg_restore --create --clean --if-exists --exit-on-error -d postgres"
    vm sudo systemctl start portikus-dex
    dex_stopped=no
    step "Dex's accounts restored"
  else
    info "the set holds Dex's accounts, but ${target_name} runs no Dex; skipped them"
  fi
elif [ "$(dex_installed)" = yes ]; then
  # Dex still holds this VM's one-time password for the local administrator,
  # so the restored row must not let that password skip the change.  A set
  # from before migration 0019 has no such column and no such row.
  has_flag=$(psql_vm "SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'must_change_password'")
  if [ "$has_flag" = 1 ]; then
    psql_vm "UPDATE users SET must_change_password = true WHERE oidc_subject = '${LOCAL_ADMIN_SUBJECT}' AND preferred_username = 'admin'"
    step "no Dex accounts in the set; the local administrator must change its password at next sign-in"
  fi
fi

# ── 5. Volumes ────────────────────────────────────────────────────
for vol in "${volumes[@]}"; do
  decrypt "$vol" | vm_in "incus storage volume import ${POOL} /dev/stdin ${vol} --project ${PROJECT} -q"
  idmap=$(awk -v v="$vol" '$1 == "volume" && $2 == v { print $5 }' "$manifest")
  # The files keep the IDs of the old instance's map; telling Incus which map
  # that was lets it shift them to the new instance's map on first start.
  if [ "$idmap" != "-" ]; then
    vm "incus storage volume set ${POOL} ${vol} --project ${PROJECT} volatile.idmap.last=$(printf '%q' "$idmap")"
  fi
  info "imported ${vol}"
done
step "volumes imported"

# ── 6. Instances ─────────────────────────────────────────────────
# The controller's create adopts volumes that already exist and makes only
# the missing ones: a fresh Docker volume, and recovery where there was none.
vm_in "sudo bash -s" <<'EOF'
set -euo pipefail
token=$(cat /etc/portikus/controller.token)
. <(grep -E '^WORKSPACE_(HOME|DOCKER|RECOVERY)_SIZE_GIB=[0-9]+$' /etc/portikus/worker.env)
runuser -u postgres -- psql -X -q -t -A -F ' ' -d portikus -c \
  "SELECT incus_instance_name, COALESCE(quota_config->>'homeGiB', ''), COALESCE(quota_config->>'dockerGiB', ''), COALESCE(quota_config->>'recoveryGiB', '') FROM workspaces WHERE incus_instance_name IS NOT NULL ORDER BY 1" \
| while read -r name home docker recovery; do
  home=${home:-$WORKSPACE_HOME_SIZE_GIB} docker=${docker:-$WORKSPACE_DOCKER_SIZE_GIB} recovery=${recovery:-$WORKSPACE_RECOVERY_SIZE_GIB}
  if ! [[ "$name" =~ ^ws-[0-9a-f]{24}$ && "$home$docker$recovery" =~ ^[0-9]+$ ]]; then
    echo "skipped a row that is not in the expected form: ${name}" >&2
    continue
  fi
  if incus info "$name" --project portikus </dev/null >/dev/null 2>&1; then continue; fi
  body=$(printf '{"name":"%s","homeGiB":%s,"dockerGiB":%s,"recoveryGiB":%s}' "$name" "$home" "$docker" "$recovery")
  curl -sf --max-time 300 -H @<(printf 'Authorization: Bearer %s\n' "$token") \
    -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:3001/instances </dev/null >/dev/null
  echo "recreated ${name}"
done
EOF
step "instances recreated"

# ── 7. Services ──────────────────────────────────────────────────
start_services
step "services started and healthy"

# ── 8. Checks ────────────────────────────────────────────────────
want=$(awk '$1 == "counts" { $1 = ""; print substr($0, 2) }' "$manifest")
got=$(psql_vm "SELECT 'users ' || (SELECT count(*) FROM users) || ' workspaces ' || (SELECT count(*) FROM workspaces) || ' projects ' || (SELECT count(*) FROM projects)")
[ "$got" = "$want" ] || die "rows: ${got}, the backup had ${want}"
info "rows match: ${got}"

# sample VOL -- up to SAMPLE regular files spread through the index, as "sha256 path".
sample() {
  python3 - "${scratch}/$1.index" "$SAMPLE" <<'EOF'
import json, sys
files = [r for r in map(json.loads, open(sys.argv[1])) if "f" in r]
step = max(1, len(files) // int(sys.argv[2]))
for r in files[::step][: int(sys.argv[2])]:
    print(r["sha256"], r["f"])
EOF
}

checked=0
for vol in "${volumes[@]}"; do
  while read -r sum path; do
    got=$(vm "incus storage volume file pull ${POOL} $(printf '%q' "${vol}/${path}") - --project ${PROJECT}" | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sum" ] || die "${vol}: ${path} does not match the backup"
    checked=$((checked + 1))
  done < <(sample "$vol")
done
step "${checked} sampled files match the backup's checksums"

if [ "$start_check" = yes ]; then
  # The workspace whose home has the most Git repositories shows the most.
  home=$(for vol in "${volumes[@]}"; do
    # An if, not &&: a last volume that is not a home would fail the loop under pipefail.
    if [[ "$vol" == *-home ]]; then echo "$(grep -c '"git"' "${scratch}/${vol}.index" || true) ${vol}"; fi
  done | sort -rn | awk 'NR == 1 { print $2 }')
  [ -n "$home" ] || die "no home volume to start"
  instance=${home%-home}
  ws=$(psql_vm "SELECT id FROM workspaces WHERE incus_instance_name = '${instance}' AND archived_at IS NULL")
  [[ "$ws" =~ $UUID_PATTERN ]] || die "no active workspace row for ${instance}"
  # What a browser's presence socket does (apps/api/src/routes/presence.ts).
  conn=$(psql_vm "WITH c AS (INSERT INTO workspace_connections (workspace_id) VALUES ('${ws}') RETURNING id) UPDATE workspaces SET desired_state = 'running', last_active_connection_at = now(), updated_at = now() WHERE id = '${ws}' RETURNING (SELECT id FROM c)")
  [[ "$conn" =~ $UUID_PATTERN ]] || die "could not add a presence row for ${ws}"
  release() {
    ws_held=no
    psql_vm "DELETE FROM workspace_connections WHERE id = '${conn}'; UPDATE workspaces SET desired_state = 'stopped', updated_at = now() WHERE id = '${ws}'" || true
  }
  # However the check ends, the workspace is let go so it stops again.
  ws_held=yes
  state=""
  for _ in $(seq 1 90); do
    psql_vm "UPDATE workspace_connections SET last_seen_at = now() WHERE id = '${conn}'"
    state=$(psql_vm "SELECT state FROM workspaces WHERE id = '${ws}'")
    [ "$state" = running ] && break
    sleep 2
  done
  [ "$state" = running ] || die "workspace ${ws} did not start (state ${state})"
  step "workspace ${ws} (${instance}) started"
  in_ws() { vm "incus exec ${instance} --project ${PROJECT} --user 1000 --group 1000 --env HOME=/home/student -- $1"; }
  owner=$(in_ws "stat -c %u:%g /home/student")
  bad=0
  [ "$owner" = "1000:1000" ] || { echo "  /home/student is owned by ${owner} inside the workspace, not the student"; bad=$((bad + 1)); }
  while read -r sum path; do
    got=$(in_ws "sha256sum $(printf '%q' "/home/student/${path}")" | cut -d' ' -f1)
    [ "$got" = "$sum" ] || { echo "  differs: ${path}"; bad=$((bad + 1)); }
  done < <(sample "$home")
  repos=0
  while read -r head repo; do
    got=$(in_ws "git -C $(printf '%q' "/home/student/${repo}") rev-parse HEAD" 2>/dev/null || true)
    [ "$got" = "$head" ] || { echo "  Git HEAD differs: ${repo} (${got:-unreadable}, backup ${head})"; bad=$((bad + 1)); }
    repos=$((repos + 1))
  done < <(python3 -c 'import json, sys; [print(r["head"], r["git"]) for r in map(json.loads, open(sys.argv[1])) if "git" in r and r["head"]]' "${scratch}/${home}.index")
  # Stop it again rather than leave restored student work running.
  release
  [ "$bad" -eq 0 ] || die "${bad} files or repositories differ inside the started workspace"
  step "inside ${instance}: home owned by the student, sampled files and ${repos} Git HEADs match; stopping it"
fi

info "restore complete in $(($(date +%s) - t0)) s"
