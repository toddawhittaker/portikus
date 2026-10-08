#!/usr/bin/env bash
# The control plane: the packaged units, Caddy, sessions, request logging and
# the grace period setting, then alice's workspace is requested.  Sets
# run_lifecycle to yes when the workspace checks that follow may run.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# These checks run only when the portikus-api service is active (i.e.
# code has been deployed).  Everything goes through Caddy on the public
# host name, with a session cookie for each of three users, so the block
# also covers roles, ownership, CSRF, and the authenticated presence
# WebSocket.  The users are made in PostgreSQL with a session, as the
# security suite does, so the block needs no password and works with any
# upstream provider behind Dex.

echo ""
echo "--- Control plane ---"
echo ""

control_pass_start=$pass
control_fail_start=$fail

PROJECT="portikus"
# The package's bundled Node (docs/SPEC.md section 21.12).
VM_NODE=/usr/lib/portikus/node/bin/node
WS_PROBE="/tmp/portikus-ws-probe.mjs"
WS_STOP="/tmp/portikus-ws-stop"
TERM_PROBE="/tmp/portikus-term-probe.mjs"
TERM_STOP="/tmp/portikus-term-stop"

# Everything this run creates is recorded here and the cleanup below
# deletes nothing else.
created_workspace_ids=()
created_instance_names=()
created_user_subjects=()

# Users made in PostgreSQL live under their own issuer, with subjects no
# person has, so the cleanup can never reach a real account.
SMOKE_ISSUER="urn:portikus:smoketest"
SMOKE_RUN_ID="$(date -u +%m%d%H%M%S)"

# mint_user NAME DISPLAY_NAME ROLE -- a user row and a one-hour session,
# with the cookie written to NAME's jar as a browser sign-in would.  The token goes
# over ssh standard input, never in a command line.
mint_user() {
  local name="$1" display="$2" role="$3" subject token hash uid
  subject="smoke-${SMOKE_RUN_ID}-${name}"
  created_user_subjects+=("$subject")
  token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  hash=$(printf '%s' "$token" | sha256sum | awk '{ print $1 }')
  uid=$(printf '%s\n' "WITH u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role, acceptable_use_version, acceptable_use_accepted_at) VALUES ('${SMOKE_ISSUER}', '${subject}', '${display}', '${name}', '${role}', (SELECT COALESCE((SELECT acceptable_use_version FROM settings WHERE id = 1), 1)), now()) RETURNING id), s AS (INSERT INTO sessions (id, user_id, expires_at) SELECT '${hash}', id, now() + interval '1 hour' FROM u) SELECT id FROM u" \
    | ssh_cmd_stdin "sudo -u postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus" 2>/dev/null)
  if [ -z "$uid" ]; then
    bad "make ${role} ${subject} in PostgreSQL"
    return 1
  fi
  printf '#HttpOnly_%s\tFALSE\t/\tTRUE\t0\t%s\t%s\n' "$PUBLIC_HOST" "$SESSION_COOKIE_NAME" "$token" \
    | ssh_cmd_stdin "umask 077; cat > /tmp/portikus-smoke-${name}.jar"
}

# The session cookie value, read from the Netscape jar curl wrote.  The
# cookie is HttpOnly, so curl prefixes the domain field with "#HttpOnly_";
# that leaves the name in field 6 and the value in field 7 as usual.
session_cookie() {
  ssh_cmd "awk '\$6 == \"${SESSION_COOKIE_NAME}\" {print \$7}' /tmp/portikus-smoke-$1.jar"
}

# A field of a workspace JSON document, or "" when it is missing.
json_field() {
  python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true
}

workspace_state() {
  vm_get alice "${API}/workspaces/${ws_id}" | json_field state
}

# "set" or "null" for the shutdown deadline.
workspace_deadline() {
  vm_get alice "${API}/workspaces/${ws_id}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin).get('shutdownDeadline'); print('set' if d else 'null')" 2>/dev/null || true
}

# Rows in workspace_connections for this workspace.
connection_count() {
  ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM workspace_connections WHERE workspace_id = '${ws_id}'\"" 2>/dev/null || true
}

wait_for_state() {
  local want="$1" tries="$2" state=""
  for _ in $(seq 1 "$tries"); do
    state=$(workspace_state)
    if [ "$state" = "$want" ]; then break; fi
    sleep 1
  done
  echo "$state"
}

# The disconnect grace period is a live platform setting an administrator
# changes through the API (SPEC.md section 6.4), so the test shortens it the
# same way, as carol, instead of editing a file and restarting the worker.
admin_grace() {
  vm_get carol "${API}/admin/settings" | json_field shutdownGraceSeconds
}

# set_global_grace SECONDS -- prints the value the API reports back.
set_global_grace() {
  vm_get carol "${API}/admin/settings" \
    "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":$1}'" \
    | json_field shutdownGraceSeconds
}

# set_user_grace USER_ID SECONDS -- prints the value the API reports back.
set_user_grace() {
  vm_get carol "${API}/admin/users/$1/settings" \
    "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":$2}'" \
    | json_field shutdownGraceSeconds
}

# shellcheck source=/dev/null
. "${TESTS_DIR}/smoke/cleanup.sh"

# 0. The control plane came from the Debian package, not a build on the VM.
check "portikus package is installed"  ssh_cmd dpkg -s portikus
check "no pnpm on the VM"              ssh_cmd "! command -v pnpm"
check "no built app tree on the VM"    ssh_cmd test ! -e /var/lib/portikus/app

# 1. Units are active and the controller stays private.
check "portikus-api is active"        ssh_cmd systemctl is-active portikus-api
check "portikus-worker is active"     ssh_cmd systemctl is-active portikus-worker
check "portikus-controller is active" ssh_cmd systemctl is-active portikus-controller
check "controller /health returns 200" \
  ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health) = 200"
check "controller rejects unauthenticated requests" \
  ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/instances) = 401"

# 2. Caddy serves the site over TLS and the API through it.
check "caddy is active"                       ssh_cmd systemctl is-active caddy
check_output "https / returns 200"      "200" http_status - "${API}/"
check_output "/health through Caddy"    "200" http_status - "${API}/health"
redirects_to_https() {
  local status
  status=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' 'http://${PUBLIC_HOST}/'")
  case "$status" in 30*) return 0 ;; *) return 1 ;; esac
}
check "http redirects to https"               redirects_to_https
check "HSTS header on /" \
  site_header_matches 'strict-transport-security: max-age=31536000; includeSubDomains'
check "frame-ancestors header on /" \
  site_header_matches "content-security-policy: frame-ancestors 'none'"

# 3. The provider was checked above, before this block.

# 4. Nothing works without a session.
check_output "/auth/me is 401 anonymously"    "401" http_status - "${API}/auth/me"
check_output "POST /workspaces is 401 anonymously" "401" \
  http_status - "${API}/workspaces" "-X POST -H 'Origin: ${API}'"

# 4a. Routes without a session are limited per address (SPEC.md 24.13).
#     The limit is the packages/config default unless api.env raises it.
#     /lti/jwks answers 404 on a site with no LMS, so only a 429 before the
#     limit fails the check.
anonymous_limit=$(api_env ANONYMOUS_REQUEST_LIMIT_PER_MINUTE)
anonymous_limit="${anonymous_limit:-600}"
anonymous_source=$(random_loopback)
anonymous_result() {
  ssh_cmd "for i in \$(seq 1 $((anonymous_limit + 1))); do ${CURL} --interface ${anonymous_source} -o /dev/null -w '%{http_code}\n' '${API}/lti/jwks'; done" |
    awk -v n="$((anonymous_limit + 1))" \
      'NR < n && $1 == 429 { early++ } NR == n { last = $1 } END { print (early ? "early 429" : "last " last) }'
}
check_output "request $((anonymous_limit + 1)) to /lti/jwks from one address is refused" \
  "last 429" anonymous_result

# 4b. Anything already on the VM belongs to somebody else.  List it and
#     leave it alone.  The lifecycle checks are skipped while it is there,
#     because they shorten the platform grace period and would stop it.
echo ""
echo "Looking for workspaces that exist before this run..."
existing_workspaces=$(ssh_cmd "sudo -u postgres psql -t -A -F' ' -d portikus -c \"SELECT COALESCE(u.oidc_subject, '(unknown)'), w.id, w.incus_instance_name FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id ORDER BY 1\"" 2>/dev/null || true)
skip_lifecycle=no
if [ -n "$existing_workspaces" ]; then
  skip_lifecycle=yes
  echo "These workspaces already exist and this run will not touch them:"
  echo "$existing_workspaces" | awk '{ print "  " $0 }'
  # On a restored rehearsal copy every restored workspace is stopped, and
  # this run's own users cannot be handed one, so the lifecycle still runs.
  if [ -n "$RESTORED_SET" ] && [ "${#restored_ids[@]}" -gt 0 ]; then
    unrestored=$(echo "$existing_workspaces" | awk '{ print $2 }' | grep -cvxF -f <(printf '%s\n' "${restored_ids[@]}") || true)
    if [ "$unrestored" = 0 ]; then
      skip_lifecycle=no
      echo "They are all from the restored set, so the lifecycle checks run beside them."
    fi
  fi
else
  echo "None."
fi

# 5. Sign alice, bob, and carol in as users this run makes in PostgreSQL.
echo ""
echo "Making alice, bob, and carol under ${SMOKE_ISSUER}, run ${SMOKE_RUN_ID}..."
mint_user alice "Alice Student" student
mint_user bob "Bob Student" student
mint_user carol "Carol Administrator" administrator
alice_me=$(vm_get alice "${API}/auth/me")
alice_name=$(echo "$alice_me" | json_field displayName)
alice_id=$(echo "$alice_me" | json_field id)
check_output "alice is signed in" "Alice Student" echo "$alice_name"
check "/auth/me carries alice's user id"      test -n "$alice_id"

# 5b. The API logs one structured line per request, and a refused request
#     is logged server side with its status (ADR 0012, SPEC.md 25.6).  This
#     runs after a real authenticated request, because /health is logged at
#     debug on purpose and so leaves nothing behind at the default level.
api_journal_has() {
  ssh_cmd "sudo journalctl -u portikus-api --since '5 min ago' --no-pager | grep -q -- '$1'"
}
check "api logs one line per request" api_journal_has '"msg":"request"'
# Authentication runs before routing, so an anonymous request to an unknown
# route is refused with 401 rather than reaching the 404 handler.
check_output "an anonymous request to an unknown route is refused with 401" "401" \
  ssh_cmd "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${API_PORT}/no-such-route"
# A 401 without a session is routine (a signed-out browser polling), so it
# is logged at info, not warn (docs/adr/0036).  journald can lag a moment.
api_journal_has_info_401() {
  for _ in $(seq 1 3); do
    if api_journal_has '"level":"info".*"status":401.*"code":"UNAUTHORIZED"'; then return 0; fi
    sleep 1
  done
  return 1
}
check "the refused anonymous request is logged at info" api_journal_has_info_401

# 5c. Shorten the grace period for the lifecycle checks below.  The original
#     value is recorded here and put back by cleanup_lifecycle.  The platform
#     value applies to every workspace, so it is left alone when somebody
#     else's workspace is on this VM.
check_output "a student is refused the admin settings" "403" \
  http_status bob "${API}/admin/settings"
# The Logs tab reads that refusal back from the journal (docs/adr/0036):
# an info line from the API with the 403 and the path, since a 4xx is not
# a warning.
logs_show_bob_403() {
  for _ in $(seq 1 5); do
    if vm_get carol "${API}/admin/logs?level=info&service=api" | python3 -c '
import json, sys
lines = json.load(sys.stdin)["lines"]
sys.exit(0 if any(l["line"].get("status") == 403 and l["line"].get("path") == "/admin/settings" for l in lines) else 1)
' 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
check "the Logs tab shows the student's refused request as an info line" logs_show_bob_403
if [ "$skip_lifecycle" = "no" ]; then
  orig_grace=$(admin_grace)
  check "read the platform grace period as carol" test -n "$orig_grace"
  check_output "admin sets the grace period to 20s" "20" set_global_grace 20
fi

# 6. Provision alice's workspace.  The request carries no body: the owner
#    comes from the session, and the Origin header satisfies the CSRF check.
echo ""
ws_response=""
ws_id=""
if [ "$skip_lifecycle" = "no" ]; then
  echo "Provisioning a workspace for alice..."
  ws_response=$(vm_get alice "${API}/workspaces" "-X POST -H 'Origin: ${API}'")
  ws_id=$(echo "$ws_response" | json_field id)
fi

run_lifecycle=no
if [ "$skip_lifecycle" = "yes" ]; then
  echo "A workspace this run did not create is already on this VM."
  echo "Skipping the lifecycle, terminal, and project checks, and leaving it alone."
  echo "Run them against a VM nobody is using."
  # After a restore, the lifecycle block is the point of the run.
  if [ -n "$RESTORED_SET" ]; then
    bad "the lifecycle checks were skipped on the restored VM"
  fi
elif [ -z "$ws_id" ]; then
  bad "POST /workspaces returned no id: ${ws_response}"
else
  run_lifecycle=yes
fi
