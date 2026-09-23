#!/usr/bin/env bash
# Cross-user files and terminals through the real edge (Epic 12a Done items
# 12 and 13, the Gate C file and terminal parts; SPEC.md 5.2, 24 and 30).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# a owns a project with a secret file and a terminal.  b, the administrator
# and an anonymous caller try to reach them through Caddy; b's workspace
# tries to reach a's agent, and a's agent token is offered to b's agent.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- Cross-user files and terminals ---"

xu_a=$(sec_ws_id a)
xu_b=$(sec_ws_id b)
xu_slug="sectest-files-${SEC_RUN_ID}"
xu_secret="sectest-secret-${SEC_RUN_ID}"

# The project is made through the API so it has a row, then the secret file
# is written straight into a's home as the student.
xu_status=$(sec_http a POST "/workspaces/${xu_a}/projects" \
  -H 'Content-Type: application/json' \
  --data "{\"name\":\"${xu_slug}\",\"source\":\"new\",\"gitInit\":false}")
xu_pid=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
check_output "a creates its own project (control)" "201" echo "$xu_status"
sec_exec a student "printf '%s\n' '${xu_secret}' > ~/projects/${xu_slug}/secret.txt" >/dev/null 2>&1

xu_status=$(sec_http a POST "/workspaces/${xu_a}/terminals" \
  -H 'Content-Type: application/json' --data '{}')
xu_tid=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
check_output "a opens its own terminal (control)" "201" echo "$xu_status"

# xu_body_clean -- the last body names neither a's project nor its secret.
xu_body_clean() {
  ! grep -q -e "$xu_secret" -e "$xu_slug" "$SEC_LAST_BODY" 2>/dev/null
}

# xu_expect LABEL STATUS KEY METHOD URL [curl args] -- the status matches and
# the body leaks nothing of a's.
xu_expect() {
  local label="$1" want="$2" got; shift 2
  got=$(sec_http "$@")
  if [ "$got" = "$want" ] && xu_body_clean; then
    sec_pass "$label"
  else
    sec_fail "$label (got: ${got}$(xu_body_clean || echo ', body names a'"'"'s data'))"
  fi
}

if [ -z "$xu_pid" ] || [ -z "$xu_tid" ]; then
  sec_fail "cross-user setup: a's project and terminal exist (project '${xu_pid}', terminal '${xu_tid}')"
else
  xu_file="/workspaces/${xu_a}/projects/${xu_pid}/file?path=secret.txt"
  xu_tree="/workspaces/${xu_a}/projects/${xu_pid}/tree"
  xu_download="/workspaces/${xu_a}/projects/${xu_pid}/download"

  # Controls: a reaches all of it, so a refusal below is about the caller.
  xu_read_a() { local s; s=$(sec_http a GET "$xu_file"); echo "$s $(cat "$SEC_LAST_BODY")"; }
  check_output "a reads its own secret file through the edge (control)" "200 ${xu_secret}" xu_read_a
  check_output "a downloads its own project through the edge (control)" "200" \
    sec_http a GET "$xu_download"

  # Done item 12: b gets 404, never 403, and learns nothing.
  xu_expect "b gets 404 on a's project list" 404 b GET "/workspaces/${xu_a}/projects"
  xu_expect "b gets 404 on a's file" 404 b GET "$xu_file"
  xu_expect "b gets 404 on a's file tree" 404 b GET "$xu_tree"
  xu_expect "b gets 404 on a's project download" 404 b GET "$xu_download"
  xu_expect "b gets 404 writing a's file" 404 b PUT "$xu_file" \
    -H 'Content-Type: text/plain' --data-binary 'overwritten-by-b'
  xu_expect "b gets 404 deleting a's file" 404 b DELETE "$xu_file"
  xu_expect "b gets 404 renaming a's project" 404 b PATCH "/workspaces/${xu_a}/projects/${xu_pid}" \
    -H 'Content-Type: application/json' --data '{"name":"taken-by-b"}'
  # Id mixing: b's own workspace with a's project id.
  xu_expect "b's workspace with a's project id is 404" 404 b GET \
    "/workspaces/${xu_b}/projects/${xu_pid}/file?path=secret.txt"
  xu_expect "b's workspace with a's project id is 404 on download" 404 b GET \
    "/workspaces/${xu_b}/projects/${xu_pid}/download"
  # The administrator does not see student files either (Epic 12a decisions).
  xu_expect "the administrator gets 404 on a's file" 404 admin GET "$xu_file"
  xu_expect "the administrator gets 404 on a's project list" 404 admin GET "/workspaces/${xu_a}/projects"
  xu_expect "the administrator gets 404 on a's project download" 404 admin GET "$xu_download"
  xu_expect "anonymous gets 401 on a's file" 401 - GET "$xu_file"
  check_output "a's secret file is unchanged after b's attempts" "${xu_secret}" \
    sec_exec a student "cat ~/projects/${xu_slug}/secret.txt"

  # Done item 13: terminal sockets through Caddy.
  xu_term="/workspaces/${xu_a}/terminals/${xu_tid}/ws"
  check_output "a opens its own terminal socket (control)" "101" \
    sec_ws_upgrade a "$xu_term" "$SEC_API"
  xu_not_opened() { # KEY URL
    local got
    got=$(sec_ws_upgrade "$1" "$2" "$SEC_API")
    [ -n "$got" ] && [ "$got" != "101" ]
  }
  check "b cannot open a's terminal socket" xu_not_opened b "$xu_term"
  check "the administrator cannot open a's terminal socket" xu_not_opened admin "$xu_term"
  check "anonymous cannot open a's terminal socket" xu_not_opened - "$xu_term"
  check "b cannot open a's terminal through b's own workspace id" xu_not_opened b \
    "/workspaces/${xu_b}/terminals/${xu_tid}/ws"
  xu_expect "b gets 404 closing a's terminal" 404 b DELETE "${xu_term%/ws}"
fi

# From workspace b, a's agent attach endpoint gives no HTTP answer at all:
# 000 means nothing accepted the connection.
xu_a_ip=$(sec_ws_ip a)
xu_ws_key=$(openssl rand -base64 16)
xu_attach="http://${xu_a_ip}:7400/terminals/${xu_tid:-x}/attach"
xu_upgrade_args="-s -o /dev/null -w %{http_code} --max-time 4 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: ${xu_ws_key}'"
check_output "b as student gets no answer from a's agent attach endpoint" "000" \
  sec_exec b student "curl ${xu_upgrade_args} ${xu_attach}; true"
check_output "b, inner Docker, gets no answer from a's agent port" "refused" \
  sec_docker_exec b "nc -z -w 3 ${xu_a_ip} 7400 && echo open || echo refused"

# a's token at b's agent: refused on the plain routes and the attach socket.
xu_b_ip=$(sec_ws_ip b)
sec_agent_header a
sec_agent_header b
xu_agent() { # HEADER-KEY PATH [curl args]
  local key="$1" path="$2"; shift 2
  sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H @${SEC_REMOTE_DIR}/${key}.agent $* http://${xu_b_ip}:7400${path}"
}
check_output "b's agent answers b's own token (control)" "200" xu_agent b /health
check_output "b's agent refuses a's token on /health" "401" xu_agent a /health
check_output "b's agent refuses a's token on /terminals" "401" xu_agent a /terminals
check_output "b's agent refuses a's token on /projects" "401" xu_agent a /projects
check_output "b's agent refuses a's token on a terminal attach upgrade" "401" \
  xu_agent a "/terminals/${xu_tid:-x}/attach" \
  "-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: ${xu_ws_key}'"

# Leave a's terminal closed; the project goes with the workspace at cleanup.
if [ -n "${xu_tid:-}" ]; then
  sec_http a DELETE "/workspaces/${xu_a}/terminals/${xu_tid}" >/dev/null
fi
