#!/usr/bin/env bash
# The load and concurrency test (docs/EPIC-12B.md, B4; SPEC.md 25.1, 25.2).
#
# Usage: load-test.sh <vm-ip> [N] [--sweep]
#
# Makes N students as SQL rows with sessions, the way the security suite
# does, then runs infra/tests/load/driver.mjs on the VM: N workspaces start
# within the ramp and hold steady activity, and the driver reports latency
# percentiles, the footprint per workspace, and a pass or fail per criterion.
#
# It runs on the rehearsal VM only. It refuses the pilot, refuses while
# Ansible is converging the VM, and refuses when the VM cannot take N more
# workspaces. It deletes only the users it recorded and the workspaces they
# own, on any exit.
#
# Environment: LOAD_STEADY_SECONDS (900), LOAD_RAMP_SECONDS (48),
# LOAD_TICK_SECONDS (5), LOAD_RECOVERY_SECONDS (300), LOAD_OUT (directory for
# the results JSON), PORTIKUS_PUBLIC_HOST and PORTIKUS_PUBLIC_PORT.
set -uo pipefail

VM="${1:?Usage: load-test.sh <vm-ip> [N] [--sweep]}"
N="${2:-25}"
SWEEP=no
[ "${3:-}" = "--sweep" ] && SWEEP=yes
[[ "$N" =~ ^[1-9][0-9]*$ ]] || { echo "N must be a positive number, not '${N}'" >&2; exit 2; }

ISSUER="urn:portikus:loadtest"
WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
CA="/etc/portikus/caddy-root.crt"
PILOT_HOSTNAME="portikus"
RUN_ID="$(date -u +%m%d%H%M%S)"
REMOTE_DIR="/tmp/portikus-loadtest-${RUN_ID}"
LOCAL_OUT="${LOAD_OUT:-${TMPDIR:-/tmp}}"
RESULT="${LOCAL_OUT}/portikus-load-${RUN_ID}-n${N}.json"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_HOST="${PORTIKUS_PUBLIC_HOST:-portikus.${VM}.nip.io}"
PUBLIC_PORT="${PORTIKUS_PUBLIC_PORT:-443}"
if [ "$PUBLIC_PORT" = "443" ]; then API="https://${PUBLIC_HOST}"; else API="https://${PUBLIC_HOST}:${PUBLIC_PORT}"; fi

# Measured on the rehearsal VM (docs/CAPACITY.md): a steady workspace with the
# stand-in agent uses about 600 MiB; the reserve keeps the control plane clear.
MIB_PER_WORKSPACE="${LOAD_MIB_PER_WORKSPACE:-700}"
RESERVE_MIB=2048
GIB_PER_WORKSPACE=1
MIN_POOL_FREE_GIB=10
MAX_POOL_META_PERCENT=80

created_subjects=()
driver_pid=""

ssh_vm() { ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${VM}" "$@"; }
ssh_vm_stdin() { ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${VM}" "$@"; }
psql_vm() { printf '%s\n' "$1" | ssh_vm_stdin "sudo -u postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus"; }

sql_list() {
  local out="" item
  for item in "$@"; do out="${out}${out:+,}'${item}'"; done
  printf '%s' "$out"
}

# Instances and workspace ids owned by the given subjects under the load issuer.
owned_rows() {
  psql_vm "SELECT w.id || ' ' || COALESCE(w.incus_instance_name, '-') FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer = '${ISSUER}' AND u.oidc_subject IN ($(sql_list "$@"))"
}

# Space the thin pool has handed out, in GiB. The difference over a run is
# what its workspaces wrote; summing their volumes would count the image
# blocks the root volumes share.
pool_used_gib() {
  ssh_vm "sudo lvs --noheadings --nosuffix --units g -o lv_size,data_percent portikus-data/thinpool" \
    | awk '{ printf "%.2f", $1 * $2 / 100 }'
}

preflight() {
  local host version mem_mib need_mib pool size data meta free_gib need_gib leftovers
  echo "--- Portikus load test ---"
  echo "Target: ${VM}  site: ${API}  N=${N}  run: ${RUN_ID}"
  exec {LOCK_FD}>>"${TMPDIR:-/tmp}/portikus-loadtest-${VM}.lock"
  flock -n "$LOCK_FD" || { echo "preflight: another load run against ${VM} is live; nothing was created." >&2; return 1; }

  host=$(ssh_vm hostname) || { echo "preflight: ${VM} does not answer SSH." >&2; return 1; }
  if [ "$host" = "$PILOT_HOSTNAME" ]; then
    echo "preflight: ${VM} is the pilot (${host}); the load test runs on the rehearsal VM only." >&2
    return 1
  fi
  if pgrep -af ansible-playbook | grep -q "PORTIKUS_VM_IP=${VM} " || [ -n "$(ssh_vm "pgrep -f '[a]nsible' ; true")" ]; then
    echo "preflight: Ansible is converging ${VM}; try again when it has finished." >&2
    return 1
  fi
  # A restore stops the API, and a rebuild replaces the VM.
  if pgrep -af 'restore\.sh|rebuild-exercise' | grep -q -- "${VM}"; then
    echo "preflight: a restore or rebuild is running against ${VM}; try again when it has finished." >&2
    return 1
  fi
  if [ -n "$(ssh_vm "pgrep -f '[/]tmp/portikus-loadtest-[0-9]' ; true")" ]; then
    echo "preflight: a load driver is already running on ${VM}." >&2
    return 1
  fi
  version=$(ssh_vm "dpkg-query -W -f='\${Version}' portikus" 2>/dev/null)
  echo "VM: ${host}, $(ssh_vm nproc) vCPUs, package portikus ${version:-(not installed)}"
  if ! ssh_vm systemctl is-active portikus-api portikus-worker portikus-controller caddy >/dev/null 2>&1; then
    echo "preflight: a control-plane unit is not active; nothing was created." >&2
    return 1
  fi

  leftovers=$(psql_vm "SELECT u.oidc_subject FROM users u WHERE u.oidc_issuer = '${ISSUER}' AND u.oidc_subject LIKE 'loadtest-%' ORDER BY 1")
  if [ -n "$leftovers" ]; then
    echo "Leftover load-test users from an earlier run: $(echo "$leftovers" | wc -l)"
    if [ "$SWEEP" = "yes" ]; then
      mapfile -t created_subjects <<<"$leftovers"
      cleanup
      created_subjects=()
    else
      echo "preflight: run again with --sweep (make load-test SWEEP=1) to remove them first." >&2
      return 1
    fi
  fi

  # Capacity: memory for N active workspaces plus a reserve, and thin-pool room.
  mem_mib=$(( $(ssh_vm "awk '/^MemAvailable:/ {print \$2}' /proc/meminfo") / 1024 ))
  need_mib=$(( N * MIB_PER_WORKSPACE + RESERVE_MIB ))
  echo "Memory available: ${mem_mib} MiB (need ${need_mib} for ${N} workspaces)"
  pool=$(ssh_vm "sudo lvs --noheadings --nosuffix --units g -o lv_size,data_percent,metadata_percent portikus-data/thinpool")
  read -r size data meta <<<"$pool"
  free_gib=$(awk -v s="$size" -v d="$data" 'BEGIN { printf "%d", s * (100 - d) / 100 }')
  need_gib=$(( N * GIB_PER_WORKSPACE + MIN_POOL_FREE_GIB ))
  POOL_BEFORE=$(pool_used_gib)
  echo "Thin pool: ${free_gib} GiB free, metadata ${meta}% (need ${need_gib} GiB, under ${MAX_POOL_META_PERCENT}%)"
  if [ "$mem_mib" -lt "$need_mib" ]; then
    echo "preflight: the VM cannot take ${N} active workspaces; nothing was created." >&2
    return 1
  fi
  if [ "$free_gib" -lt "$need_gib" ] || awk -v m="$meta" -v x="$MAX_POOL_META_PERCENT" 'BEGIN { exit !(m >= x) }'; then
    echo "preflight: the thin pool cannot take ${N} more workspaces; nothing was created." >&2
    return 1
  fi
}

# Users are recorded before they exist, so a run that dies still removes them.
mint_users() {
  local i key subject token hash values="" tokens=()
  for ((i = 1; i <= N; i++)); do
    key=$(printf '%02d' "$i")
    subject="loadtest-${RUN_ID}-${key}"
    created_subjects+=("$subject")
    token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
    hash=$(printf '%s' "$token" | sha256sum | awk '{print $1}')
    values="${values}${values:+,}('${subject}', '${hash}')"
    tokens+=("{\"key\":\"${key}\",\"token\":\"${token}\"}")
  done
  psql_vm "WITH v(subject, hash) AS (VALUES ${values}), u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role) SELECT '${ISSUER}', subject, 'Load test ' || subject, subject, 'student' FROM v RETURNING id, oidc_subject) INSERT INTO sessions (id, user_id, expires_at) SELECT v.hash, u.id, now() + interval '3 hours' FROM u JOIN v ON v.subject = u.oidc_subject" >/dev/null \
    || { echo "Could not create the load-test users." >&2; return 1; }
  echo "Created ${N} student users under ${ISSUER}."
  STUDENTS_JSON="[$(IFS=,; echo "${tokens[*]}")]"
}

run_driver() {
  local config
  ssh_vm "install -d -m 0700 ${REMOTE_DIR}" || return 1
  tar -C "${HERE}/load" -cf - http.mjs student.mjs driver.mjs | ssh_vm_stdin "tar -C ${REMOTE_DIR} -xf -" || return 1
  config=$(printf '{"api":"%s","students":%s,"rampSeconds":%s,"steadySeconds":%s,"tickSeconds":%s,"recoverySeconds":%s,"sampleSeconds":15,"previewPort":5173,"stopFile":"%s/stop","resultFile":"%s/result.json"}' \
    "$API" "$STUDENTS_JSON" "${LOAD_RAMP_SECONDS:-48}" "${LOAD_STEADY_SECONDS:-900}" \
    "${LOAD_TICK_SECONDS:-5}" "${LOAD_RECOVERY_SECONDS:-300}" "$REMOTE_DIR" "$REMOTE_DIR")
  # The configuration holds the session tokens, so it goes on standard input.
  printf '%s' "$config" | ssh_vm_stdin "cd ${REMOTE_DIR} && NODE_EXTRA_CA_CERTS=${CA} node driver.mjs" &
  driver_pid=$!
  wait "$driver_pid"
  DRIVER_STATUS=$?
  driver_pid=""
  mkdir -p "$LOCAL_OUT"
  ssh_vm "cat ${REMOTE_DIR}/result.json" >"$RESULT" 2>/dev/null || rm -f "$RESULT"
}

report_disk() {
  local after
  after=$(pool_used_gib) || return 0
  awk -v a="$after" -v b="$POOL_BEFORE" -v n="$N" \
    'BEGIN { printf "Thin pool: the run wrote %.2f GiB, %.2f GiB per workspace\n", a - b, (a - b) / n }'
}

# Deletes the recorded users, the workspaces they own and those instances.
cleanup() {
  local rows ws_ids=() instances=() ws_list subj_list owned instance i
  [ -n "$driver_pid" ] && ssh_vm "touch ${REMOTE_DIR}/stop" 2>/dev/null
  if [ -n "$driver_pid" ]; then
    for ((i = 0; i < 30; i++)); do kill -0 "$driver_pid" 2>/dev/null || break; sleep 1; done
    kill "$driver_pid" 2>/dev/null
  fi
  [ "${#created_subjects[@]}" -gt 0 ] || return 0

  echo ""
  echo "Cleaning up ${#created_subjects[@]} load-test user(s) and what they own. Nothing else is deleted."
  subj_list=$(sql_list "${created_subjects[@]}")
  owned="SELECT id FROM users WHERE oidc_issuer = '${ISSUER}' AND oidc_subject IN (${subj_list})"
  rows=$(owned_rows "${created_subjects[@]}")
  while read -r i instance; do
    [ -n "$i" ] || continue
    ws_ids+=("$i")
    [ "$instance" != "-" ] && instances+=("$instance")
  done <<<"$rows"

  # Instances first, so a failed run never leaves an instance no row names.
  for instance in "${instances[@]}"; do
    if [[ ! "$instance" =~ ^ws-[0-9a-f]{24}$ ]]; then
      echo "Not destroying ${instance}: not a workspace instance name."
      continue
    fi
    if [ "$(psql_vm "SELECT count(*) FROM workspaces WHERE incus_instance_name = '${instance}' AND owner_user_id NOT IN (${owned})")" != "0" ]; then
      echo "Not destroying ${instance}: another user's workspace row names it."
      continue
    fi
    ssh_vm "bash ${WORKSPACE_SCRIPT} destroy ${instance}" >/dev/null 2>&1 || echo "Could not destroy ${instance}."
  done
  [ "${#instances[@]}" -gt 0 ] && echo "Destroyed ${#instances[@]} instance(s) and their volumes."
  if [ "${#ws_ids[@]}" -gt 0 ]; then
    ws_list=$(sql_list "${ws_ids[@]}")
    psql_vm "DELETE FROM audit_events WHERE target IN (SELECT id::text FROM projects WHERE workspace_id IN (${ws_list}) AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id IN (${owned})))" >/dev/null
    psql_vm "DELETE FROM workspace_connections WHERE workspace_id IN (${ws_list}) AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id IN (${owned}))" >/dev/null
    psql_vm "DELETE FROM audit_events WHERE target IN (${ws_list}) AND target IN (SELECT id::text FROM workspaces WHERE owner_user_id IN (${owned}))" >/dev/null
    psql_vm "DELETE FROM workspaces WHERE id IN (${ws_list}) AND owner_user_id IN (${owned})" >/dev/null
    echo "Deleted ${#ws_ids[@]} workspace row(s)."
  fi
  psql_vm "DELETE FROM audit_events WHERE target IN (SELECT id::text FROM users WHERE oidc_issuer = '${ISSUER}' AND oidc_subject IN (${subj_list}))" >/dev/null
  psql_vm "DELETE FROM users u WHERE u.oidc_issuer = '${ISSUER}' AND u.oidc_subject IN (${subj_list}) AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)" >/dev/null
  echo "Deleted the load-test users."
  if [[ "$REMOTE_DIR" =~ ^/tmp/portikus-loadtest-[0-9]+$ ]]; then ssh_vm "rm -rf ${REMOTE_DIR}" 2>/dev/null; fi
  created_subjects=()
}

trap cleanup EXIT
trap 'exit 130' INT TERM

preflight || { trap - EXIT; exit 1; }
mint_users || exit 1
DRIVER_STATUS=3
run_driver
report_disk
[ -f "$RESULT" ] && echo "Results: ${RESULT}"
case "$DRIVER_STATUS" in
  0) echo "--- Load test PASSED at N=${N} ---" ;;
  1) echo "--- Load test FAILED at N=${N}: a criterion was not met ---" ;;
  2) echo "--- Load test stopped early ---" ;;
  *) echo "--- Load test did not complete (driver status ${DRIVER_STATUS}) ---" ;;
esac
exit "$DRIVER_STATUS"
