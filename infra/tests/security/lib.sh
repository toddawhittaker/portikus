#!/usr/bin/env bash
# Shared helpers for the VM security suite (Epic 12a, infra/tests/security-test.sh).
#
# Sourcing this file defines functions and nothing else, so the cleanup scope
# test can load it with a stubbed ssh and no VM.
#
# The suite runs on a live pilot, so every helper that acts keeps to what the
# run itself created: users under the sectest issuer, and the two workspaces
# those users own.  Everything is recorded before it exists, so a run that
# dies half way still cleans up.
#
# Interface for the modules in this directory:
#   sec_mint_user KEY ROLE         a user and a one-hour session, KEY is a short name
#   sec_create_workspace KEY       POST /workspaces as KEY, wait until provisioned
#   sec_hold_presence KEY          keep KEY's workspace running with a presence socket
#   sec_http KEY|- METHOD URL [curl args]
#                                  a request through the real Caddy; prints the
#                                  status and leaves the body in $SEC_LAST_BODY
#   sec_ws_upgrade KEY|- URL ORIGIN [curl args]
#                                  a WebSocket upgrade; prints the status (101 = opened);
#                                  KEY names a cookie file in the run's remote directory
#   sec_exec KEY student|root CMD  CMD in KEY's workspace
#   sec_docker_exec KEY [--network host] CMD
#                                  CMD under sh in an inner Docker container of KEY's workspace
#   sec_ws_ip KEY, sec_agent_token KEY, sec_ws_id KEY, sec_instance KEY
#   check LABEL CMD..., check_output LABEL EXPECTED CMD..., known_vuln ISSUE LABEL CMD...
#   sec_warn LABEL                 a finding the operator allowed, listed in the summary
#   sec_na LABEL REASON            a check that cannot prove anything here, listed in the summary
# shellcheck disable=SC2034  # globals are read by the runner and the modules

SEC_ISSUER="urn:portikus:sectest"
SEC_PROJECT="portikus"
SEC_WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
SEC_SESSION_COOKIE="__Host-portikus_session"
SEC_CA="/etc/portikus/caddy-root.crt"
SEC_DOCKER_IMAGE="alpine:3"

# Two more idle workspaces fit when this much memory is available.  An idle
# workspace uses about 400 MiB; the profile's 4 GB is a cap, not a reservation.
SEC_MIN_MEM_MIB=3072
# Two new workspaces clone the image thinly; this leaves room for their writes.
SEC_MIN_POOL_FREE_GIB=10
SEC_MAX_POOL_META_PERCENT=80

# Everything the run creates, recorded before it is created.
sec_created_subjects=()
sec_created_workspace_ids=()
sec_created_instances=()
sec_presence_pids=()
declare -A SEC_USER_ID=() SEC_WS_ID=() SEC_INSTANCE=()

pass=0
fail=0
sec_known=()
sec_xpass=()
sec_warnings=()
sec_not_applicable=()

# ── Output and checks ────────────────────────────────────────────

sec_pass() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
sec_fail() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
sec_info() { printf '%s\n' "$*"; }

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then sec_pass "$label"; else sec_fail "$label"; fi
}

check_output() {
  local label="$1" expected="$2" actual; shift 2
  actual=$("$@" 2>/dev/null) || true
  if [ "$actual" = "$expected" ]; then
    sec_pass "$label"
  else
    sec_fail "$label (got: ${actual})"
  fi
}

# known_vuln ISSUE LABEL CMD... -- CMD asserts the secure behaviour.  It is
# expected to fail until issue ISSUE is fixed; when it passes, the marker is
# stale and the run fails so somebody removes it.
known_vuln() {
  local issue="$1" label="$2"; shift 2
  if "$@" >/dev/null 2>&1; then
    printf '\033[1;31mXPASS\033[0m #%s %s (fixed? remove the marker)\n' "$issue" "$label"
    sec_xpass+=("#${issue} ${label}")
    fail=$((fail + 1))
  else
    printf '\033[1;33mKNOWN-VULN\033[0m #%s %s\n' "$issue" "$label"
    sec_known+=("#${issue} ${label}")
  fi
}

# sec_warn LABEL -- not a failure, because the operator chose it, but never
# silent: the summary lists it.
sec_warn() {
  printf '\033[1;33mWARN\033[0m  %s\n' "$1"
  sec_warnings+=("$1")
}

# sec_na LABEL REASON -- neither a pass nor a failure; the summary says why.
sec_na() {
  printf '\033[1;36mN/A\033[0m   %s (%s)\n' "$1" "$2"
  sec_not_applicable+=("$1: $2")
}

sec_summary() {
  local item
  echo ""
  if [ "${#sec_not_applicable[@]}" -gt 0 ]; then
    echo "Not applicable on this host (not counted as passed):"
    for item in "${sec_not_applicable[@]}"; do echo "  ${item}"; done
  fi
  if [ "${#sec_warnings[@]}" -gt 0 ]; then
    echo "Warnings (allowed on this VM by the operator):"
    for item in "${sec_warnings[@]}"; do echo "  ${item}"; done
  fi
  if [ "${#sec_known[@]}" -gt 0 ]; then
    echo "Expected failures (KNOWN-VULN):"
    for item in "${sec_known[@]}"; do echo "  ${item}"; done
  fi
  if [ "${#sec_xpass[@]}" -gt 0 ]; then
    echo "Marked checks that now pass (remove the marker):"
    for item in "${sec_xpass[@]}"; do echo "  ${item}"; done
  fi
  echo "--- Security results: ${pass} passed, ${fail} failed, ${#sec_known[@]} known, ${#sec_warnings[@]} warning(s) ---"
}

# ── Sign-in provider (#408) ──────────────────────────────────────

# With the mock provider on, anyone who reaches the site can sign in as
# anyone, administrators included.  Only PORTIKUS_IDP=mock allows that, and
# then as a warning.  Otherwise the mock must be off and the API must not
# name it as its issuer.
sec_check_idp() {
  local issuer
  if [ "$SEC_IDP" = "mock" ]; then
    if sec_ssh "systemctl is-active --quiet portikus-mock-idp" >/dev/null 2>&1; then
      sec_warn "mock sign-in on: anyone who reaches ${SEC_API} can sign in as anyone (PORTIKUS_IDP=mock, #408)"
    else
      sec_pass "mock sign-in is off"
    fi
    return 0
  fi
  check "the mock identity provider is not running" \
    sec_ssh "! systemctl is-active --quiet portikus-mock-idp"
  issuer=$(sec_ssh "sudo sed -n 's/^OIDC_ISSUER_URL=//p' /etc/portikus/api.env" 2>/dev/null)
  if [ -n "$issuer" ] && [[ "$issuer" != */mock-idp ]]; then
    sec_pass "the API's issuer is not the mock (${issuer})"
  else
    sec_fail "the API's issuer is not the mock (got: ${issuer:-none})"
  fi
}

# ── Transport ────────────────────────────────────────────────────

# -n keeps the remote command off this script's standard input.
sec_ssh() {
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${SEC_VM}" "$@"
}

sec_ssh_stdin() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${SEC_VM}" "$@"
}

# SQL goes on standard input, so tokens never show in a process list.
sec_psql() {
  printf '%s\n' "$1" | sec_ssh_stdin "sudo -u postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus"
}

# sql_in_list ITEM... prints 'a','b' for an SQL IN clause.  Every item the
# suite passes is a uuid or a sectest subject, never user input.
sec_sql_list() {
  local out="" item
  for item in "$@"; do out="${out}${out:+,}'${item}'"; done
  printf '%s' "$out"
}

# One argument string for the remote shell, each word quoted.
sec_quote() {
  local out="" arg
  for arg in "$@"; do out="${out}${out:+ }$(printf '%q' "$arg")"; done
  printf '%s' "$out"
}

# ── Setup ────────────────────────────────────────────────────────

# sec_init VM_IP [--sweep]
sec_init() {
  SEC_VM="${1:?Usage: security-test.sh <vm-ip> [--sweep]}"
  SEC_SWEEP=no
  [ "${2:-}" = "--sweep" ] && SEC_SWEEP=yes
  SEC_HEAVY="${PORTIKUS_SECURITY_HEAVY:-0}"
  if [ -n "${PORTIKUS_MOCK_IDP:-}" ]; then
    echo "security-test: PORTIKUS_MOCK_IDP was renamed: use PORTIKUS_IDP=mock" >&2
    exit 2
  fi
  SEC_IDP="${PORTIKUS_IDP:-dex}"
  case "$SEC_IDP" in
    dex | mock) ;;
    *) echo "security-test: PORTIKUS_IDP must be dex or mock (got: ${SEC_IDP})" >&2; exit 2 ;;
  esac
  SEC_RUN_ID="$(date -u +%m%d%H%M%S)"
  SEC_PUBLIC_HOST="${PORTIKUS_PUBLIC_HOST:-portikus.${SEC_VM}.nip.io}"
  SEC_PUBLIC_PORT="${PORTIKUS_PUBLIC_PORT:-443}"
  if [ "$SEC_PUBLIC_PORT" = "443" ]; then
    SEC_API="https://${SEC_PUBLIC_HOST}"
  else
    SEC_API="https://${SEC_PUBLIC_HOST}:${SEC_PUBLIC_PORT}"
  fi
  SEC_REMOTE_DIR="/tmp/portikus-sectest-${SEC_RUN_ID}"
  # Survives a workspace restart inside a; the container module uses it.
  SEC_REMOTE_VARDIR="/var/tmp/portikus-sectest-${SEC_RUN_ID}"
  SEC_LOCAL_DIR="$(mktemp -d)"
  SEC_LAST_BODY="${SEC_LOCAL_DIR}/last-body"
  SEC_START_EPOCH="$(date +%s)"
}

# Capacity, service state, leftovers.  Returns nonzero when the run must not
# create anything.
sec_preflight() {
  local version mem_kib pool meta size data free_gib leftovers
  echo "--- Portikus VM security suite ---"
  echo "Target: ${SEC_VM}  site: ${SEC_API}  run: ${SEC_RUN_ID}"
  sec_lock || return 1
  version=$(sec_ssh "dpkg-query -W -f='\${Version}' portikus" 2>/dev/null)
  echo "Deployed package: portikus ${version:-(not installed)}"
  if ! sec_ssh systemctl is-active portikus-api portikus-worker portikus-controller caddy >/dev/null 2>&1; then
    echo "preflight: a control-plane unit is not active; nothing was created." >&2
    return 1
  fi

  mem_kib=$(sec_ssh "awk '/^MemAvailable:/ {print \$2}' /proc/meminfo")
  echo "Memory available: $((mem_kib / 1024)) MiB (need ${SEC_MIN_MEM_MIB})"
  if [ "$((mem_kib / 1024))" -lt "$SEC_MIN_MEM_MIB" ]; then
    echo "preflight: not enough memory for two more workspaces; nothing was created." >&2
    return 1
  fi
  pool=$(sec_ssh "sudo lvs --noheadings --nosuffix --units g -o lv_size,data_percent,metadata_percent portikus-data/thinpool")
  read -r size data meta <<<"$pool"
  free_gib=$(awk -v s="$size" -v d="$data" 'BEGIN { printf "%d", s * (100 - d) / 100 }')
  echo "Thin pool: ${free_gib} GiB free, metadata ${meta}% (need ${SEC_MIN_POOL_FREE_GIB} GiB, under ${SEC_MAX_POOL_META_PERCENT}%)"
  if [ "$free_gib" -lt "$SEC_MIN_POOL_FREE_GIB" ] \
    || awk -v m="$meta" -v x="$SEC_MAX_POOL_META_PERCENT" 'BEGIN { exit !(m >= x) }'; then
    echo "preflight: the thin pool cannot take two more workspaces; nothing was created." >&2
    return 1
  fi

  leftovers=$(sec_psql "SELECT u.oidc_subject || ' ' || COALESCE(w.id::text, '-') || ' ' || COALESCE(w.incus_instance_name, '-') FROM users u LEFT JOIN workspaces w ON w.owner_user_id = u.id WHERE u.oidc_issuer = '${SEC_ISSUER}' AND u.oidc_subject LIKE 'sectest-%' ORDER BY 1")
  if [ -n "$leftovers" ]; then
    echo "Leftovers from an earlier run (subject, workspace, instance):"
    printf '%s\n' "$leftovers" | awk '{ print "  " $0 }'
    if [ "$SEC_SWEEP" = "yes" ]; then
      sec_sweep "$leftovers"
    else
      echo "Run again with --sweep to remove them."
    fi
  fi

  if [ "$SEC_HEAVY" = "1" ] && [ -n "$(sec_psql "SELECT 1 FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}' LIMIT 1")" ]; then
    echo "preflight: PORTIKUS_SECURITY_HEAVY=1 needs a VM with no other workspace; nothing was created." >&2
    return 1
  fi

  # Audit rows up to here existed before the run; the snapshot counts them.
  SEC_AUDIT_MAX=$(sec_psql "SELECT COALESCE(max(id), 0) FROM audit_events")
  sec_ssh "install -d -m 0700 ${SEC_REMOTE_DIR}"
}

# One run at a time against a VM.  The local lock is released when this
# process exits, however it exits.  A run from another machine shows on the
# VM as a process under its remote directory, and that blocks too, so a
# sweep never removes a live run's users and workspaces.
sec_lock() {
  local lockfile="${TMPDIR:-/tmp}/portikus-sectest-${SEC_VM}.lock" live
  exec {SEC_LOCK_FD}>>"$lockfile"
  if ! flock -n "$SEC_LOCK_FD"; then
    echo "preflight: another security run against ${SEC_VM} holds ${lockfile}; nothing was created or swept." >&2
    return 1
  fi
  # The brackets keep the pattern from matching this command's own shell.
  live=$(sec_ssh "pgrep -af '[/]tmp/portikus-sectest-[0-9]'; true")
  if [ -n "$live" ]; then
    echo "preflight: another security run is live on the VM; nothing was created or swept:" >&2
    printf '%s\n' "$live" | awk '{ print "  " $0 }' >&2
    return 1
  fi
}

# sec_sweep LINES -- LINES are "subject workspace-id instance" from the
# preflight query, which already kept to the sectest issuer.  The rows are
# recorded as if this run had made them and removed by the normal cleanup.
sec_sweep() {
  local subject ws instance
  while read -r subject ws instance; do
    case "$subject" in sectest-*) ;; *) continue ;; esac
    sec_created_subjects+=("$subject")
    [ "$ws" != "-" ] && sec_created_workspace_ids+=("$ws")
    [ "$instance" != "-" ] && sec_created_instances+=("$instance")
  done <<<"$1"
  echo "Sweeping earlier sectest rows, instances and directories..."
  sec_cleanup
  # sec_lock proved no run is live, so every run directory is a leftover.
  sec_ssh "sudo find /tmp /var/tmp -maxdepth 1 -regextype posix-extended -regex '/(var/)?tmp/portikus-sectest-[0-9]+' -exec rm -rf {} +" 2>/dev/null || true
  sec_created_subjects=()
  sec_created_workspace_ids=()
  sec_created_instances=()
}

# ── Snapshot of everything the run must not touch ────────────────

# Every workspace not owned by a sectest user (row and the Incus status of its
# instance), every other user's role, disabled flag and grace override, and
# the settings row.  Instances no workspace row names, such as another
# builder's scratch instance, are not workspaces and are left out.
#
# Also the rows a careless delete could take: the audit rows that existed
# before the run (counted by id, so new ones written meanwhile do not
# count), and the presence connections and sessions of other users that
# existed at the start.  Sessions are listed only if they expire at least
# two hours after the start, so one expiring meanwhile is not a difference.
# A student who signs out during the run does show here; run outside class
# hours.
sec_snapshot_others() {
  local theirs start="to_timestamp(${SEC_START_EPOCH})"
  theirs=$(sec_psql "SELECT w.incus_instance_name FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}' AND w.incus_instance_name IS NOT NULL")
  sec_psql "SELECT 'workspace ' || w.id || ' ' || COALESCE(w.incus_instance_name, '-') || ' state=' || w.state || ' desired=' || w.desired_state || ' deadline=' || COALESCE(w.shutdown_deadline::text, '-') FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}' ORDER BY w.id"
  sec_psql "SELECT 'user ' || id || ' role=' || role || ' disabled=' || COALESCE(disabled_at::text, '-') || ' grace=' || COALESCE(shutdown_grace_seconds::text, '-') FROM users WHERE oidc_issuer <> '${SEC_ISSUER}' ORDER BY id"
  sec_psql "SELECT 'settings ' || row_to_json(s)::text FROM settings s ORDER BY id"
  sec_psql "SELECT 'audit rows up to id ${SEC_AUDIT_MAX:-0}: ' || count(*) FROM audit_events WHERE id <= ${SEC_AUDIT_MAX:-0}"
  sec_psql "SELECT 'connection ' || c.id || ' workspace ' || c.workspace_id FROM workspace_connections c JOIN workspaces w ON w.id = c.workspace_id JOIN users u ON u.id = w.owner_user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}' AND c.connected_at < ${start} ORDER BY c.id"
  sec_psql "SELECT 'sessions user ' || s.user_id || ': ' || count(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.oidc_issuer <> '${SEC_ISSUER}' AND s.created_at < ${start} AND s.expires_at > ${start} + interval '2 hours' GROUP BY s.user_id ORDER BY s.user_id"
  sec_ssh "incus list --project ${SEC_PROJECT} -c ns --format csv" \
    | awk -F, -v keep="${theirs//$'\n'/ }" \
      'BEGIN { n = split(keep, a, " "); for (i = 1; i <= n; i++) theirs[a[i]] = 1 }
       ($1 in theirs) { print "incus " $1 " " $2 }' | sort
}

# ── Users, workspaces, presence ──────────────────────────────────

# sec_mint_user KEY ROLE -- ROLE is student or administrator.
sec_mint_user() {
  local key="$1" role="$2" subject token hash uid
  subject="sectest-${SEC_RUN_ID}-${key}"
  sec_created_subjects+=("$subject")
  token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  hash=$(printf '%s' "$token" | sha256sum | awk '{print $1}')
  uid=$(sec_psql "WITH u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role) VALUES ('${SEC_ISSUER}', '${subject}', 'Security test ${key}', '${subject}', '${role}') RETURNING id), s AS (INSERT INTO sessions (id, user_id, expires_at) SELECT '${hash}', id, now() + interval '1 hour' FROM u) SELECT id FROM u")
  if [ -z "$uid" ]; then
    sec_fail "mint ${role} user ${subject}"
    return 1
  fi
  SEC_USER_ID[$key]="$uid"
  printf 'Cookie: %s=%s\n' "$SEC_SESSION_COOKIE" "$token" \
    | sec_ssh_stdin "umask 077; cat > ${SEC_REMOTE_DIR}/${key}.cookie"
  printf '%s=%s' "$SEC_SESSION_COOKIE" "$token" >"${SEC_LOCAL_DIR}/${key}.cookie"
  echo "Minted ${role} ${subject} (${uid})"
}

sec_ws_id() { printf '%s' "${SEC_WS_ID[$1]:-}"; }
sec_instance() { printf '%s' "${SEC_INSTANCE[$1]:-}"; }

sec_ws_state() {
  sec_psql "SELECT state FROM workspaces WHERE id = '$(sec_ws_id "$1")'"
}

sec_wait_state() { # KEY STATE SECONDS
  local i
  for ((i = 0; i < $3; i += 2)); do
    [ "$(sec_ws_state "$1")" = "$2" ] && return 0
    sleep 2
  done
  return 1
}

sec_create_workspace() {
  local key="$1" status id instance
  status=$(sec_http "$key" POST /workspaces)
  id=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
  instance=$(jq -r '.incusInstanceName // empty' "$SEC_LAST_BODY" 2>/dev/null)
  [ -n "$id" ] && sec_created_workspace_ids+=("$id")
  [ -n "$instance" ] && sec_created_instances+=("$instance")
  if [ "$status" != "201" ] || [ -z "$id" ] || [ -z "$instance" ]; then
    sec_fail "POST /workspaces for ${key} created a new workspace (status ${status})"
    return 1
  fi
  SEC_WS_ID[$key]="$id"
  SEC_INSTANCE[$key]="$instance"
  echo "Workspace ${key}: ${id} (${instance}); waiting for provisioning..."
  if ! sec_wait_state "$key" stopped 240; then
    sec_fail "workspace ${key} provisioned (state $(sec_ws_state "$key"))"
    return 1
  fi
}

# The presence client runs on the VM and reads the cookie on standard input.
SEC_PRESENCE_JS='import fs from "node:fs";
const [url, origin, stopFile] = process.argv.slice(2);
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
ws.addEventListener("open", () => {
	ws.send(JSON.stringify({ type: "heartbeat" }));
	setInterval(() => ws.send(JSON.stringify({ type: "heartbeat" })), 20000);
});
ws.addEventListener("error", () => process.exit(1));
ws.addEventListener("close", () => process.exit(0));
setInterval(() => { if (fs.existsSync(stopFile)) ws.close(); }, 500);
setTimeout(() => ws.close(), 20 * 60 * 1000);'

sec_hold_presence() {
  local key="$1" ws_id instance i
  ws_id=$(sec_ws_id "$key"); instance=$(sec_instance "$key")
  [ -n "$ws_id" ] || return 1
  if ! sec_ssh test -f "${SEC_REMOTE_DIR}/presence.mjs"; then
    printf '%s\n' "$SEC_PRESENCE_JS" | sec_ssh_stdin "cat > ${SEC_REMOTE_DIR}/presence.mjs"
  fi
  sec_ssh_stdin "NODE_EXTRA_CA_CERTS=${SEC_CA} node ${SEC_REMOTE_DIR}/presence.mjs \
    '${SEC_API/https/wss}/workspaces/${ws_id}/ws' '${SEC_API}' '${SEC_REMOTE_DIR}/stop-all'" \
    <"${SEC_LOCAL_DIR}/${key}.cookie" >/dev/null 2>&1 &
  sec_presence_pids+=("$!")
  echo "Holding presence for ${key}; waiting for it to run..."
  if ! sec_wait_state "$key" running 180; then
    sec_fail "workspace ${key} reaches running on presence"
    return 1
  fi
  # Running in the database comes before the agent answers.
  for ((i = 0; i < 60; i += 2)); do
    sec_agent_header "$key"
    [ "$(sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H @${SEC_REMOTE_DIR}/${key}.agent http://$(sec_ws_ip "$key"):7400/health" 2>/dev/null)" = "200" ] && break
    sleep 2
  done
  sec_exec "$key" root "systemctl is-system-running --wait >/dev/null 2>&1; true" >/dev/null 2>&1
  echo "Workspace ${key} is running (${instance})."
}

sec_agent_header() {
  printf 'Authorization: Bearer %s\n' "$(sec_agent_token "$1")" \
    | sec_ssh_stdin "umask 077; cat > ${SEC_REMOTE_DIR}/$1.agent"
}

sec_agent_token() {
  sec_psql "SELECT agent_token FROM workspaces WHERE id = '$(sec_ws_id "$1")'"
}

# The address on the workspace bridge; a running workspace also has docker0.
sec_ws_ip() {
  sec_ssh "incus list $(sec_instance "$1") --project ${SEC_PROJECT} -c4 --format csv" \
    | tr -d '"' | awk '/eth0/ { print $1; exit }'
}

# ── Requests through the real edge ───────────────────────────────

# sec_http KEY|- METHOD URL [curl args...]
sec_http() {
  local key="$1" method="$2" url="$3" args=() extra
  shift 3
  [[ "$url" == /* ]] && url="${SEC_API}${url}"
  args=(-s --cacert "$SEC_CA" --max-time 20 -o "${SEC_REMOTE_DIR}/body")
  if [ "$method" = "HEAD" ]; then args+=(-I); else args+=(-X "$method"); fi
  [ "$key" != "-" ] && args+=(-H "@${SEC_REMOTE_DIR}/${key}.cookie")
  extra="$*"
  case "$method" in
    GET | HEAD) ;;
    *) [[ "$extra" == *[Oo]rigin:* ]] || args+=(-H "Origin: ${SEC_API}") ;;
  esac
  args+=("$@" -w '%{http_code}' "$url")
  sec_ssh "curl $(sec_quote "${args[@]}"); echo; cat ${SEC_REMOTE_DIR}/body 2>/dev/null; rm -f ${SEC_REMOTE_DIR}/body" \
    | { IFS= read -r status; cat >"$SEC_LAST_BODY"; printf '%s' "$status"; }
}

# sec_ws_upgrade KEY|- URL ORIGIN [curl args] -- ORIGIN "-" sends none.
sec_ws_upgrade() {
  local key="$1" url="$2" origin="$3" args=()
  shift 3
  [[ "$url" == /* ]] && url="${SEC_API}${url}"
  url="${url/#wss:/https:}"
  args=(-s --cacert "$SEC_CA" --http1.1 --max-time 4 -o /dev/null -w '%{http_code}'
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
    -H "Sec-WebSocket-Key: $(openssl rand -base64 16)")
  [ "$key" != "-" ] && args+=(-H "@${SEC_REMOTE_DIR}/${key}.cookie")
  [ "$origin" != "-" ] && args+=(-H "Origin: ${origin}")
  sec_ssh "curl $(sec_quote "${args[@]}" "$@" "$url")"
}

# ── Commands inside the suite's own workspaces ───────────────────

sec_exec() {
  local key="$1" user="$2" cmd="$3" instance
  instance=$(sec_instance "$key")
  # Only the run's own workspaces, never anybody else's.
  [[ " ${sec_created_instances[*]} " == *" ${instance} "* ]] || return 99
  case "$user" in
    root) sec_ssh "incus exec ${instance} --project ${SEC_PROJECT} -- bash -c $(printf '%q' "$cmd")" ;;
    student) sec_ssh "incus exec ${instance} --project ${SEC_PROJECT} -- su -l student -c $(printf '%q' "$cmd")" ;;
    *) return 98 ;;
  esac
}

# sec_docker_exec KEY [--network host] CMD -- CMD runs under sh in Alpine.
sec_docker_exec() {
  local key="$1" net=""
  shift
  if [ "$1" = "--network" ]; then net="--network $2"; shift 2; fi
  sec_exec "$key" student "docker run --rm ${net} ${SEC_DOCKER_IMAGE} sh -c $(printf '%q' "$1")"
}

# ── Cleanup ──────────────────────────────────────────────────────

# Deletes only what this run recorded, and even then only rows owned by a
# sectest user and instances no other row names.
sec_cleanup() {
  local ws_list subj_list owned pid instance i
  echo ""
  echo "Cleaning up: ${#sec_created_workspace_ids[@]} workspace row(s), ${#sec_created_instances[@]} instance(s), ${#sec_created_subjects[@]} user(s). Nothing else is deleted."

  # Stop files end the presence clients and the liveness loop on the VM.
  if [[ "${SEC_REMOTE_DIR:-}" =~ ^/tmp/portikus-sectest-[0-9]+$ ]]; then
    sec_ssh "test -d ${SEC_REMOTE_DIR} && touch ${SEC_REMOTE_DIR}/stop-all ${SEC_REMOTE_DIR}/watch.stop; true" 2>/dev/null || true
  fi
  if [ "${#sec_presence_pids[@]}" -gt 0 ]; then
    for pid in "${sec_presence_pids[@]}"; do
      for ((i = 0; i < 10; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill "$pid" 2>/dev/null || true
    done
    sec_presence_pids=()
  fi

  owned="SELECT id FROM users WHERE oidc_issuer = '${SEC_ISSUER}'"
  if [ "${#sec_created_workspace_ids[@]}" -gt 0 ]; then
    ws_list=$(sec_sql_list "${sec_created_workspace_ids[@]}")
    echo "Deleting workspace rows: ${sec_created_workspace_ids[*]}"
    sec_psql "DELETE FROM audit_events WHERE target IN (SELECT id::text FROM projects WHERE workspace_id IN (${ws_list}) AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id IN (${owned})))" >/dev/null 2>&1 || true
    sec_psql "DELETE FROM workspace_connections WHERE workspace_id IN (${ws_list}) AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id IN (${owned}))" >/dev/null 2>&1 || true
    sec_psql "DELETE FROM audit_events WHERE target IN (${ws_list}) AND target IN (SELECT id::text FROM workspaces WHERE owner_user_id IN (${owned}))" >/dev/null 2>&1 || true
    sec_psql "DELETE FROM workspaces WHERE id IN (${ws_list}) AND owner_user_id IN (${owned})" >/dev/null 2>&1 || true
  fi

  for instance in "${sec_created_instances[@]}"; do
    if [[ ! "$instance" =~ ^ws-[0-9a-f]{24}$ ]]; then
      echo "Not destroying ${instance}: not a workspace instance name."
      continue
    fi
    if [ "$(sec_psql "SELECT count(*) FROM workspaces WHERE incus_instance_name = '${instance}'")" != "0" ]; then
      echo "Not destroying ${instance}: a workspace row still names it."
      continue
    fi
    echo "Destroying Incus instance ${instance}"
    sec_ssh "bash ${SEC_WORKSPACE_SCRIPT} destroy ${instance}" >/dev/null 2>&1 || true
  done

  if [ "${#sec_created_subjects[@]}" -gt 0 ]; then
    subj_list=$(sec_sql_list "${sec_created_subjects[@]}")
    echo "Deleting user rows: ${sec_created_subjects[*]}"
    # Rows about these users go; what they did to anything else stays on record.
    sec_psql "DELETE FROM audit_events WHERE target IN (SELECT id::text FROM users WHERE oidc_issuer = '${SEC_ISSUER}' AND oidc_subject IN (${subj_list}))" >/dev/null 2>&1 || true
    # A user who still owns a workspace stays, and so does its session.
    sec_psql "DELETE FROM users u WHERE u.oidc_issuer = '${SEC_ISSUER}' AND u.oidc_subject IN (${subj_list}) AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)" >/dev/null 2>&1 || true
  fi

  if [[ "${SEC_REMOTE_DIR:-}" =~ ^/tmp/portikus-sectest-[0-9]+$ ]]; then
    sec_ssh "rm -rf ${SEC_REMOTE_DIR}" 2>/dev/null || true
  fi
  # Root may have written here if a link was followed on the VM, hence sudo.
  if [[ "${SEC_REMOTE_VARDIR:-}" =~ ^/var/tmp/portikus-sectest-[0-9]+$ ]]; then
    sec_ssh "sudo rm -rf ${SEC_REMOTE_VARDIR}" 2>/dev/null || true
  fi
}
