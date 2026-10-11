#!/usr/bin/env bash
# LTI launch, roster sync and Deep Linking through the mock LMS, when one is
# registered (ADR 0025, ADR 0058).
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

echo ""
echo "--- LTI launch ---"
echo ""
LTI_FILE=/etc/portikus/lti-platforms.json
LTI_LAUNCH_PY="${TESTS_DIR}/lti-launch.py"
# Caddy's internal authority on the VM, whose root the API and the launch driver trust.
CADDY_PKI=/var/lib/caddy/.local/share/caddy/pki/authorities/local
# lti_py ARGS... -- the launch driver, run on the VM, prints one JSON object.
lti_py() {
  ssh_cmd_stdin "python3 - $(printf '%q ' "$@")" <"$LTI_LAUNCH_PY"
}
# json_field JSON KEY -- one value, lists joined with commas.
json_field() {
  python3 -c 'import json, sys; v = json.loads(sys.argv[1]).get(sys.argv[2]); print(",".join(map(str, v)) if isinstance(v, list) else v)' "$1" "$2" 2>/dev/null
}
# json_fields JSON KEY... -- the values on one line, separated by spaces.
json_fields() {
  local json=$1 key out=()
  shift
  for key in "$@"; do out+=("$(json_field "$json" "$key")"); done
  echo "${out[*]}"
}

# Roster sync: the API asks the mock's token and roster endpoints through
# the egress proxy, as it would a real LMS (ADR 0027).
lti_roster_checks() {
  roster=$(lti_py roster "$mock_issuer" "$API" ivy cs101 "CS 101 Intro to Programming" sam "Sam Student")
  check_output "the mock's roster hook resets and changes a member's role" "204 204 204" \
    json_fields "$roster" reset promote demote
  check_output "roster sync gets a token and the roster through the egress proxy" "200 ok True" \
    json_fields "$roster" first first_result first_available
  check_gt "the synced roster lists people who never launched" 0 json_field "$roster" first_not_started
  check_output "a role changed in the LMS reaches the course on the next sync" "ok 1 instructor" \
    json_fields "$roster" promoted_result promoted_role_changed promoted_member_role
  check_output "the role changed back reaches the course too" "ok 1 student" \
    json_fields "$roster" demoted_result demoted_role_changed demoted_member_role
}

# The checks that need a running mock LMS.
lti_launch_checks() {
  check_output "the VM reaches the mock LMS keyset" "200" mock_probe

  student=$(lti_py launch "$mock_issuer" "$API" sam cs101)
  check_output "a student launch passes /lti/login, the mock and /lti/launch" "302 200 303" \
    json_fields "$student" login authorize launch
  check_output "the launch lands on / with a session" "/ True" \
    json_fields "$student" launch_location session
  check_output "the state cookie is named for its state, HttpOnly, Secure, SameSite=None, Path=/, 10 minutes" \
    "httponly;max-age=600;path=/;samesite=none;secure" json_field "$student" state_cookie
  check_output "/auth/me names the student role" "student" json_field "$student" role
  check_output "a student has no courses" "" json_field "$student" course_titles
  check_output "the student gets 403 from the admin routes" "403" json_field "$student" admin
  check_output "the same id_token and state are refused a second time" "400 False" \
    json_fields "$student" replay replay_session

  instructor=$(lti_py launch "$mock_issuer" "$API" ivy cs101)
  check_output "an instructor launch lands with a session" "303 True" \
    json_fields "$instructor" launch session
  check_output "/auth/me names the instructor role" "instructor" json_field "$instructor" role
  check_output "the instructor sees the course" "CS 101 Intro to Programming" \
    json_field "$instructor" course_titles
  lti_has_sam() { json_field "$instructor" member_names | tr ',' '\n' | grep -qx 'Sam Student'; }
  check "the course lists the student who launched before" lti_has_sam
  # Members carry their user id so an instructor can remove them, and a
  # roster status for people who never launched (ADR 0058); never an email.
  check_output "members carry only name, role, last launch, status, user id and workspace state" \
    "displayName,lastLaunchAt,role,status,userId,workspaceState" json_field "$instructor" member_fields
  check_output "the instructor gets 403 from the admin routes" "403" json_field "$instructor" admin

  # The proxy allows only GET and CONNECT, so the API's token POST to a
  # plain-http mock is refused (ADR 0027).
  if [ "$mock_scheme" = https ]; then
    lti_roster_checks
  else
    lti_skip_checks lti_roster_checks "roster sync needs an https mock LMS; the proxy refuses plain-HTTP POST"
  fi

  deep_link=$(lti_py deeplink "$mock_issuer" "$API" ivy cs101 "smoke-link-$(date +%s)")
  check_output "Deep Linking passes /lti/login, the mock and /lti/launch to the picker" "302 200 200 True" \
    json_fields "$deep_link" login authorize launch picker
  check_output "the Deep Linking picker signs nobody in" "False" json_field "$deep_link" session
  check_output "the signed response may post only back to the mock" "200 True True" \
    json_fields "$deep_link" signed return_form_action returns_to_mock
  check_output "the mock verifies the signed response and saves the link" "200 True True" \
    json_fields "$deep_link" saved saved_one listed

  # The accounts mock launches made stay; the operator decides what to do with them.
  echo "Accounts made by mock launches (issuer lti:${mock_issuer}):"
  ssh_cmd "sudo -u postgres psql -t -A -F ' ' -d portikus -c \"SELECT '  ' || display_name, role, created_at::date FROM users WHERE oidc_issuer = 'lti:${mock_issuer}' ORDER BY display_name\""
}

# lti_skip_checks FUNCTION REASON -- one counted SKIP per check FUNCTION
# runs, by name.  The names come from running FUNCTION with every check and
# every call to the VM or the mock stubbed out, so the list cannot drift.
# shellcheck disable=SC2317  # the stubs are called by the function named in $1
lti_skip_checks() {
  local label
  while IFS= read -r label; do skip "${label} (${2})"; done < <(
    check() { printf '%s\n' "$1" >&3; }
    check_output() { printf '%s\n' "$1" >&3; }
    check_gt() { printf '%s\n' "$1" >&3; }
    lti_py() { :; }
    ssh_cmd() { :; }
    ssh_cmd_stdin() { :; }
    vm_get() { :; }
    curl() { :; }
    # Every check is listed, the roster ones included.
    mock_scheme=https
    "$1" 3>&1 >/dev/null 2>&1
  )
}

# lti_mock_tls DIR HOST -- a key and a one-day certificate for the mock at
# HOST in DIR, signed on the VM by Caddy's internal root, which the API and
# the launch driver already trust.  Only the rehearsal registers an https
# mock; its root key never leaves the VM.
lti_mock_tls() {
  local dir=$1 host=$2 san
  if [[ "$host" =~ ^[0-9.]+$ ]]; then san="IP:${host}"; else san="DNS:${host}"; fi
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=Portikus mock LMS" \
    -addext "subjectAltName=${san}" -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE" \
    -keyout "${dir}/mock.key" -out "${dir}/mock.csr" 2>/dev/null || return 1
  ssh_cmd_stdin "sudo openssl x509 -req -CA ${CADDY_PKI}/root.crt -CAkey ${CADDY_PKI}/root.key -days 1 \
    -set_serial 0x$(openssl rand -hex 16) -copy_extensions copy" <"${dir}/mock.csr" >"${dir}/mock.crt" 2>/dev/null \
    && [ -s "${dir}/mock.crt" ]
}

lti_stop_mock() {
  if [ -n "${mock_pid:-}" ]; then
    # setsid made it a process group of its own: pnpm, tsc's shell and node.
    kill -- "-${mock_pid}" 2>/dev/null
    wait "$mock_pid" 2>/dev/null
    mock_pid=""
  fi
  [ -z "${mock_dir:-}" ] || rm -rf "$mock_dir"
  mock_dir=""
}

check_output "api.env names the platforms file" "$LTI_FILE" api_env LTI_PLATFORMS_FILE
check_output "api.env names the tool key" "/etc/portikus/lti-tool-key.pem" api_env LTI_TOOL_KEY_FILE
check_output "the tool key is root:portikus, mode 0640" "root:portikus 640" \
  ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus/lti-tool-key.pem"
check "the tool key is RSA 2048" \
  ssh_cmd "sudo openssl pkey -in /etc/portikus/lti-tool-key.pem -noout -text | head -1 | grep -q '(2048 bit'"

mock_issuer=""
mock_scheme=""
mock_pid=""
mock_dir=""
if ! ssh_cmd "sudo test -e ${LTI_FILE}"; then
  echo "No LMS is registered: LTI must be off."
  check_output "/lti/jwks is 404 with LTI off" "404" http_status - "${API}/lti/jwks"
  check_output "/lti/login is 404 with LTI off" "404" http_status - "${API}/lti/login"
  check_output "POST /lti/launch is 404 with LTI off" "404" \
    http_status - "${API}/lti/launch" "-X POST --data state=x"
  lti_skip_checks lti_launch_checks "no mock LMS registered"
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
  # registered platforms (ADR 0025).
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
  mock_url_part() { # ATTRIBUTE -- one part of the issuer URL, empty when it has none.
    python3 -c 'import sys, urllib.parse; print(getattr(urllib.parse.urlsplit(sys.argv[1]), sys.argv[2]) or "")' "$mock_issuer" "$1"
  }
  mock_scheme=$(mock_url_part scheme)
  # Caddy's root on the VM signs the mock a certificate only on the rehearsal
  # VM, as its own OpenTofu state names it (make smoke-test passes it).
  on_rehearsal=no
  if [ -n "${PORTIKUS_REHEARSAL_VM_IP:-}" ] && [ "$VM" = "$PORTIKUS_REHEARSAL_VM_IP" ]; then on_rehearsal=yes; fi
  # The issuer is quoted for the remote shell; the probe prints the HTTP status.
  mock_keyset_url=$(printf %q "${mock_issuer}/.well-known/jwks.json")
  mock_probe() {
    ssh_cmd "curl -s --cacert /etc/portikus/caddy-root.crt -o /dev/null -w '%{http_code}' --max-time 5 ${mock_keyset_url}"
  }
  mock_status=""
  [ -n "$mock_issuer" ] && mock_status=$(mock_probe)
  mock_ready=1
  if [ -z "$mock_issuer" ]; then
    mock_ready=0
    lti_skip_checks lti_launch_checks "no mock LMS registered"
  elif [ "$mock_status" != "200" ] && ! command -v pnpm >/dev/null 2>&1; then
    bad "pnpm not found: run nvm use and corepack enable"
    mock_ready=0
    lti_skip_checks lti_launch_checks "the mock LMS cannot start without pnpm"
  else
    printf '\033[1;33mWARN\033[0m  the mock LMS is registered (mock-lms at %s): it can launch as anyone while it runs. Remove it with make lti-mock-unregister.\n' "$mock_issuer"
    if [ "$mock_scheme" != https ] && [ "$on_rehearsal" = yes ]; then
      bad "the rehearsal's mock LMS is registered over plain http, so roster sync cannot run; register it again with make lti-mock-register TOFU_ENV=rehearsal-libvirt"
    fi
    if [ "$mock_status" != "200" ]; then
      # Not running: start it here for this run, on the address it was registered with.
      mock_host=$(mock_url_part hostname)
      mock_port=$(mock_url_part port)
      mock_dir=$(mktemp -d)
      # The tool's keyset from the VM, so the mock verifies roster and Deep
      # Linking requests without reaching the site from this host.
      mock_args=(--tool-url "$API" --port "$mock_port" --bind 127.0.0.1 --bind "$mock_host"
        --issuer "$mock_issuer" --tool-keys-file "${mock_dir}/tool-jwks.json")
      vm_get - "${API}/lti/jwks" >"${mock_dir}/tool-jwks.json"
      if [ "$mock_scheme" = https ]; then
        if [ "$on_rehearsal" != yes ]; then
          bad "an https mock LMS gets a certificate from the VM's Caddy root only on the rehearsal VM (${PORTIKUS_REHEARSAL_VM_IP:-none in its state}), and ${VM} is not it; run make smoke-test TOFU_ENV=rehearsal-libvirt"
          mock_ready=0
        elif lti_mock_tls "$mock_dir" "$mock_host"; then
          mock_args+=(--tls-cert "${mock_dir}/mock.crt" --tls-key "${mock_dir}/mock.key")
        else
          bad "Caddy's internal root on the VM could not sign the mock LMS certificate (is ${CADDY_PKI}/root.key there?)"
          mock_ready=0
        fi
      fi
      if [ "$mock_ready" = 1 ]; then
        echo "Starting the mock LMS at ${mock_issuer} for this run..."
        repo_root="$(cd "${TESTS_DIR}/../.." && pwd)"
        setsid pnpm --silent --dir "${repo_root}/packages/mock-lms" start -- "${mock_args[@]}" \
          >"${mock_dir}/mock.log" 2>&1 &
        mock_pid=$!
        for _ in $(seq 1 60); do
          if ! kill -0 "$mock_pid" 2>/dev/null; then
            bad "the mock LMS exited before it answered: $(tail -n 5 "${mock_dir}/mock.log" | tr '\n' ' ')"
            mock_pid=""
            mock_ready=0
            break
          fi
          [ "$(mock_probe)" = "200" ] && break
          sleep 1
        done
      fi
      [ "$mock_ready" = 1 ] || lti_skip_checks lti_launch_checks "the mock LMS did not start"
    fi
  fi
  if [ "$mock_ready" = 1 ]; then
    lti_launch_checks
  fi
  lti_stop_mock
fi
