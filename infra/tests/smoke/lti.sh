#!/usr/bin/env bash
# LTI launch through the mock LMS, when one is registered.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

echo ""
echo "--- LTI launch ---"
echo ""
LTI_FILE=/etc/portikus/lti-platforms.json
LTI_LAUNCH_PY="${TESTS_DIR}/lti-launch.py"
# lti_py ARGS... -- the launch driver, run on the VM, prints one JSON object.
lti_py() {
  ssh_cmd_stdin "python3 - $*" <"$LTI_LAUNCH_PY"
}
# json_field JSON KEY -- one value, lists joined with commas.
json_field() {
  python3 -c 'import json, sys; v = json.loads(sys.argv[1]).get(sys.argv[2]); print(",".join(map(str, v)) if isinstance(v, list) else v)' "$1" "$2" 2>/dev/null
}

check_output "api.env names the platforms file" "$LTI_FILE" api_env LTI_PLATFORMS_FILE
check_output "api.env names the tool key" "/etc/portikus/lti-tool-key.pem" api_env LTI_TOOL_KEY_FILE
check_output "the tool key is root:portikus, mode 0640" "root:portikus 640" \
  ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus/lti-tool-key.pem"
check "the tool key is RSA 2048" \
  ssh_cmd "sudo openssl pkey -in /etc/portikus/lti-tool-key.pem -noout -text | head -1 | grep -q '(2048 bit'"

if ! ssh_cmd "sudo test -e ${LTI_FILE}"; then
  echo "No LMS is registered: LTI must be off."
  check_output "/lti/jwks is 404 with LTI off" "404" http_status - "${API}/lti/jwks"
  check_output "/lti/login is 404 with LTI off" "404" http_status - "${API}/lti/login"
  check_output "POST /lti/launch is 404 with LTI off" "404" \
    http_status - "${API}/lti/launch" "-X POST --data state=x"
else
  check_output "the platforms file is root:portikus, mode 0640" "root:portikus 640" \
    ssh_cmd "sudo stat -c '%U:%G %a' ${LTI_FILE}"
  lti_platforms=$(ssh_cmd "sudo cat ${LTI_FILE}")
  # The keyset holds the tool key's public half and nothing private.
  jwks_shape() {
    vm_get - "${API}/lti/jwks" | python3 -c '
import json, sys
keys = json.load(sys.stdin)["keys"]
print(len(keys), keys[0]["kty"], keys[0]["alg"], "d" in keys[0], len(keys[0]["kid"]) == 43)'
  }
  check_output "/lti/jwks serves one public RS256 key with a thumbprint kid" "1 RSA RS256 False True" jwks_shape
  # Only the registered platforms may frame /lti/*; Caddy adds nothing there.
  lti_origins=$(printf '%s' "$lti_platforms" | python3 -c '
import json, sys, urllib.parse
seen = []
for p in json.load(sys.stdin)["platforms"]:
    u = urllib.parse.urlsplit(p["authLoginUrl"])
    o = f"{u.scheme}://{u.netloc}"
    if o not in seen: seen.append(o)
print(" ".join(seen))')
  # Framed, login and launch only show a new-tab or refusal page, so any
  # page may frame them; the login form may post only to us and the
  # registered platforms (docs/archive/epics/EPIC-13.md, ruling 17).
  lti_directive() { # PATH DIRECTIVE
    ssh_cmd "${CURL} -D - -o /dev/null '${API}$1'" \
      | tr -d '\r' | grep -i '^content-security-policy:' | grep -o "$2 [^;]*" | paste -sd'|'
  }
  check_output "/lti/login may be framed by any page" "frame-ancestors *" \
    lti_directive /lti/login frame-ancestors
  check_output "the /lti/login form posts only to us and the registered platforms" \
    "form-action 'self' ${lti_origins}" lti_directive /lti/login form-action
  check_output "/lti/jwks may not be framed" "frame-ancestors 'none'" \
    lti_directive /lti/jwks frame-ancestors

  mock_issuer=$(printf '%s' "$lti_platforms" | python3 -c '
import json, sys
print(next((p["issuer"] for p in json.load(sys.stdin)["platforms"] if p.get("mock") and p["name"] == "mock-lms"), ""))')
  if [ -z "$mock_issuer" ]; then
    echo "No mock LMS is registered: skipping the launch checks."
  else
    printf '\033[1;33mWARN\033[0m  the mock LMS is registered (mock-lms at %s): it can launch as anyone while it runs. Remove it with make lti-mock-unregister.\n' "$mock_issuer"
    mock_pid=""
    if [ "$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 '${mock_issuer}/.well-known/jwks.json'")" != "200" ]; then
      # Not running: start it here for this run, on the address it was registered with.
      mock_host=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname)' "$mock_issuer")
      mock_port=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).port)' "$mock_issuer")
      echo "Starting the mock LMS on ${mock_host}:${mock_port} for this run..."
      repo_root="$(cd "${TESTS_DIR}/../.." && pwd)"
      setsid pnpm --silent --dir "${repo_root}/packages/mock-lms" start -- --tool-url "$API" --port "$mock_port" \
        --bind 127.0.0.1 --bind "$mock_host" --issuer "$mock_issuer" >/dev/null 2>&1 &
      mock_pid=$!
      for _ in $(seq 1 60); do
        [ "$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 2 '${mock_issuer}/.well-known/jwks.json'")" = "200" ] && break
        sleep 1
      done
    fi
    check_output "the VM reaches the mock LMS keyset" "200" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 '${mock_issuer}/.well-known/jwks.json'"

    student=$(lti_py launch "$mock_issuer" "$API" sam cs101)
    check_output "a student launch passes /lti/login, the mock and /lti/launch" "302 200 303" \
      echo "$(json_field "$student" login) $(json_field "$student" authorize) $(json_field "$student" launch)"
    check_output "the launch lands on / with a session" "/ True" \
      echo "$(json_field "$student" launch_location) $(json_field "$student" session)"
    check_output "the state cookie is named for its state, HttpOnly, Secure, SameSite=None, Path=/, 10 minutes" \
      "httponly;max-age=600;path=/;samesite=none;secure" json_field "$student" state_cookie
    check_output "/auth/me names the student role" "student" json_field "$student" role
    check_output "a student has no courses" "" json_field "$student" course_titles
    check_output "the student gets 403 from the admin routes" "403" json_field "$student" admin
    check_output "the same id_token and state are refused a second time" "400 False" \
      echo "$(json_field "$student" replay) $(json_field "$student" replay_session)"

    instructor=$(lti_py launch "$mock_issuer" "$API" ivy cs101)
    check_output "an instructor launch lands with a session" "303 True" \
      echo "$(json_field "$instructor" launch) $(json_field "$instructor" session)"
    check_output "/auth/me names the instructor role" "instructor" json_field "$instructor" role
    check_output "the instructor sees the course" "CS 101 Intro to Programming" \
      json_field "$instructor" course_titles
    lti_has_sam() { json_field "$instructor" member_names | tr ',' '\n' | grep -qx 'Sam Student'; }
    check "the course lists the student who launched before" lti_has_sam
    # Epic 13 ruling 23 is amended: members carry their user id for removal (#506).
    check_output "members carry only name, role, last launch, user id and workspace state" \
      "displayName,lastLaunchAt,role,userId,workspaceState" json_field "$instructor" member_fields
    check_output "the instructor gets 403 from the admin routes" "403" json_field "$instructor" admin

    # The accounts mock launches made stay; the operator decides what to do with them.
    echo "Accounts made by mock launches (issuer lti:${mock_issuer}):"
    ssh_cmd "sudo -u postgres psql -t -A -F ' ' -d portikus -c \"SELECT '  ' || display_name, role, created_at::date FROM users WHERE oidc_issuer = 'lti:${mock_issuer}' ORDER BY display_name\""

    if [ -n "$mock_pid" ]; then
      # setsid made it a process group of its own: pnpm, tsc's shell and node.
      kill -- "-${mock_pid}" 2>/dev/null
      wait "$mock_pid" 2>/dev/null
    fi
  fi
fi
