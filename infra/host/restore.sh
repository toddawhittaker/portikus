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
#   restore.sh --local [--start-check] <set-dir>
#       the same restore onto the server this runs on, as root, with the
#       key installed at /etc/portikus-backup/age-key.txt (`portikus
#       restore`, an apt-installed host, ADR 0044)
#   --target-name   the VM's hostname; the script refuses any other machine
#   --start-check   afterwards, start one restored workspace and check its
#                   files and Git HEADs from inside it, then stop it
#   --unverified    root only: accept a set that has no MAC, as sets made
#                   before MACs have none; one whose MAC is wrong is never
#                   accepted
#
# A set is accepted only when its MAC shows it was made with this key
# (portikus-backup-mac, ADR 0044), since anyone with the public recipient
# can encrypt one.  Everything in it is still checked against a strict form
# before it reaches a file name or a command.
#
# Environment:
#   PORTIKUS_BACKUP_IDENTITY  age identity (default ~/.config/portikus/backup-age-key.txt,
#                             or /etc/portikus-backup/age-key.txt with --local)
set -euo pipefail

POOL=workspace-data
PROJECT=portikus
PILOT_NAME=portikus
# Files per volume compared with the backup's index after the import.
SAMPLE=20
# dexLocalSubject("local-admin") in packages/auth: the local administrator's subject.
LOCAL_ADMIN_SUBJECT=Cgtsb2NhbC1hZG1pbhIFbG9jYWw
INSTANCE_PATTERN='^ws-[0-9a-f]{24}$'
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# backup.sh never writes a larger one.
MANIFEST_MAX=4194304
MAC_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-mac"
# shellcheck source=/dev/null
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/portikus-backup-lib.sh"

info() { printf '[restore %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[restore] FAIL: %s\n' "$*" >&2; exit 1; }

mode=restore start_check=no target_name="" local_mode=no unverified=no
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check; shift ;;
    --unverified) unverified=yes; shift ;;
    --remove) mode=remove; shift ;;
    --start-check) start_check=yes; shift ;;
    --target-name) target_name="${2:?--target-name needs a value}"; shift 2 ;;
    --local) local_mode=yes; shift ;;
    *) break ;;
  esac
done
IDENTITY="${PORTIKUS_BACKUP_IDENTITY:-${HOME}/.config/portikus/backup-age-key.txt}"
if [ "$local_mode" = yes ]; then
  IDENTITY="${PORTIKUS_BACKUP_IDENTITY:-/etc/portikus-backup/age-key.txt}"
  if [ "$mode" != restore ] || [ -n "$target_name" ]; then die "--local takes only --start-check and --unverified"; fi
  [ "$(id -u)" = 0 ] || die "--local must run as root"
  SET="${1:?Usage: restore.sh --local [--start-check] <set-dir>}"
  VM=127.0.0.1
elif [ "$mode" = check ]; then
  SET="${1:?Usage: restore.sh --check <set-dir>}"
else
  VM="${1:?Usage: restore.sh [--remove] --target-name <vm-name> <vm-ip> <set-dir>}"
  SET="${2:?Usage: restore.sh [--remove] --target-name <vm-name> <vm-ip> <set-dir>}"
  [ -n "$target_name" ] || die "--target-name is required, so a restore cannot land on the wrong VM"
fi

[ -r "$IDENTITY" ] || die "no age identity at ${IDENTITY}; set PORTIKUS_BACKUP_IDENTITY"
[ -f "${SET}/MANIFEST.age" ] || die "${SET} is not a backup set (no MANIFEST.age)"
# A set may have been copied in by hand; nothing in it may lead elsewhere.
if [ -L "$SET" ] || [ -n "$(find "$SET" -type l -print -quit)" ]; then
  die "${SET} is or holds a symbolic link; refusing the set"
fi
# Before anything in the set is decrypted or read.
mac_rc=0
python3 "$MAC_SCRIPT" verify "$IDENTITY" "$SET" || mac_rc=$?
case "$mac_rc" in
  0) info "the set's MAC matches: it was made with this key" ;;
  3)
    [ "$unverified" = yes ] \
      || die "${SET} has no MAC, so nothing shows it was made with this key. A set made before MACs has none; if you know where this one came from, run the restore again as root with --unverified. Nothing was changed"
    [ "$(id -u)" = 0 ] || die "--unverified runs only as root"
    printf '[restore] WARNING: %s has no MAC. It is restored only because --unverified was given: anyone who knows the public recipient could have made it.\n' "$SET" >&2
    ;;
  4) die "${SET} failed verification: it was not made with this key, or it was changed after it was made. Refusing the set; nothing was changed" ;;
  5) die "${SET} is named for another time than it was made: its MANIFEST gives a different creation time. Refusing the set; nothing was changed" ;;
  *) die "could not check the set's MAC with ${IDENTITY}; nothing was changed" ;;
esac
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
set +o pipefail
decrypt MANIFEST | head -c $((MANIFEST_MAX + 1)) >"$manifest"
decrypt_rc=${PIPESTATUS[0]}
set -o pipefail
[ "$(stat -c %s "$manifest")" -le "$MANIFEST_MAX" ] || die "the MANIFEST is larger than 4 MiB; refusing the set"
[ "$decrypt_rc" = 0 ] || die "cannot decrypt the MANIFEST with ${IDENTITY}"
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
declare -A index_sums=()
while read -r vol size sum; do
  index_sums[$vol]="$size $sum"
done < <(awk '$1 == "index" { print $2, $3, $4 }' "$manifest")
while read -r kind name size sum _; do
  case "$kind" in file | volume) ;; *) continue ;; esac
  got=$(decrypt "$name" | size_sum)
  [ "$got" = "$size $sum" ] || die "${name}: ${got}, the MANIFEST says ${size} ${sum}"
  if [ "$kind" = volume ]; then
    decrypt "${name}.index" >"${scratch}/${name}.index.raw"
    # A set made before index lines has none to compare.
    if [ -n "${index_sums[$name]:-}" ]; then
      got=$(size_sum <"${scratch}/${name}.index.raw")
      [ "$got" = "${index_sums[$name]}" ] || die "${name}.index: ${got}, the MANIFEST says ${index_sums[$name]}"
    fi
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
# A set copied back in by hand is not one this server's channel made, so
# its marker must not count against the requested-backup limit (ADR 0039).
[ "$local_mode" = no ] || rm -f "${SET}/REQUESTED"

# ── 2. The right VM ───────────────────────────────────────────────
[ "$local_mode" = no ] || use_local_vm
psql_vm() { printf '%s\n' "$1" | vm_in "sudo runuser -u postgres -- psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus"; }

if [ "$local_mode" = yes ]; then
  actual_name=$(hostname) target_name=$actual_name
else
  actual_name=$(vm hostname)
  [ "$actual_name" = "$target_name" ] || die "${VM} is '${actual_name}', not '${target_name}'; nothing was changed"
fi

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
  # The restored tables carry the old server's grants, if any; the worker's
  # role gets its own after the migrations.  A release without the file
  # still makes the role a member of portikus.
  vm "f=/usr/share/portikus/ansible/roles/portikus/files/worker-grants.sql; [ ! -f \$f ] || (cd / && sudo runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d portikus -f \$f)" \
    || die "could not set the worker's database privileges"
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
# Dex's accounts (ADR 0028), with Dex stopped so the
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

# The key that seals second factors (SPEC.md section 24.13), written while
# the API is stopped so it starts able to check the restored accounts'
# codes.  The key travels on standard input, never in a command line.
if grep -q '^file second-factor\.key ' "$manifest"; then
  put_key=$(base64 -w0 <<'EOF'
set -euo pipefail
key=$(head -c 200 | tr -d '[:space:]')
[[ "$key" =~ ^[0-9a-f]{64}$ ]] || { echo "the set's second-factor key is not 64 hex characters" >&2; exit 1; }
umask 077
printf '%s\n' "$key" >/etc/portikus/second-factor.key.new
chown root:root /etc/portikus/second-factor.key.new
chmod 0600 /etc/portikus/second-factor.key.new
mv /etc/portikus/second-factor.key.new /etc/portikus/second-factor.key
if grep -q '^SECOND_FACTOR_KEY=' /etc/portikus/api.env; then
  sed -i "s/^SECOND_FACTOR_KEY=.*/SECOND_FACTOR_KEY=${key}/" /etc/portikus/api.env
else
  printf 'SECOND_FACTOR_KEY=%s\n' "$key" >>/etc/portikus/api.env
fi
EOF
)
  decrypt second-factor.key | vm_in "sudo bash -c \"\$(echo ${put_key} | base64 -d)\"" \
    || die "could not put the second-factor key back"
  step "second-factor key restored"
else
  info "the set holds no second-factor key; accounts with a second factor need it reset"
fi

# The alert channels (ADR 0052).  The job checks the file as strictly as an
# admin page request and puts the egress proxy's alert hosts in line; the
# secrets travel on standard input, never in a command line.
if grep -q '^file notify\.json ' "$manifest"; then
  decrypt notify.json | vm_in "sudo /usr/lib/portikus/alerts-job restore" \
    || die "could not put the notification settings back"
  step "notification settings restored"
else
  info "the set holds no notification settings; set the alert channels on the admin page"
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
  # As the container's root: a home may hold files the student cannot read.
  while read -r sum path; do
    got=$(vm "incus exec ${instance} --project ${PROJECT} -- sha256sum $(printf '%q' "/home/student/${path}")" | cut -d' ' -f1)
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
