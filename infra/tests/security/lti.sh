#!/usr/bin/env bash
# LTI launch, the frame policy and the instructor role through the real edge
# (docs/EPIC-13.md rulings 4, 5, 7, 9, 16, 17, 19, 25 and 26; SPEC.md 24).
#
# Sourced by infra/tests/security-test.sh.  Works with LTI on or off: with no
# platforms file the /lti routes must be 404, and the checks that need a
# registered platform say N/A.  With one, it starts real logins and posts
# forged tokens; nothing it does can create a user or a session.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- LTI launch, frames and the instructor role ---"

lti_file=/etc/portikus/lti-platforms.json
lti_platforms=$(sec_ssh "sudo cat ${lti_file} 2>/dev/null")

# lti_csp METHOD PATH -- every Content-Security-Policy header of the response, joined by |.
lti_csp() {
  local args=(-s --cacert "$SEC_CA" --max-time 20 -o /dev/null -D - -X "$1")
  [ "$1" = "GET" ] || args+=(-H "Origin: ${SEC_API}" --data "")
  sec_ssh "curl $(sec_quote "${args[@]}" "${SEC_API}$2")" \
    | tr -d '\r' | grep -i '^content-security-policy:' | sed 's/^[^:]*: *//' | paste -sd'|'
}

# ── Frames (ruling 17) ───────────────────────────────────────────
# Everything but /lti/* keeps exactly one policy, frame-ancestors 'none'.
for lti_path in / /admin /course /auth/me /health /courses "/workspaces/$(sec_ws_id a)"; do
  check_output "${lti_path} may not be framed" "frame-ancestors 'none'" lti_csp GET "$lti_path"
done

# Login and launch may be framed by anyone: framed, they only show a new-tab
# or refusal page and grant nothing.  Their forms may post only to us and
# the registered platforms.  The keyset is never framed.
lti_form_action="form-action 'self'"
if [ -n "$lti_platforms" ]; then
  lti_form_action="${lti_form_action} $(printf '%s' "$lti_platforms" | python3 -c '
import json, sys, urllib.parse
seen = []
for p in json.load(sys.stdin)["platforms"]:
    u = urllib.parse.urlsplit(p["authLoginUrl"])
    o = f"{u.scheme}://{u.netloc}"
    if o not in seen: seen.append(o)
print(" ".join(seen))')"
fi
# lti_policy METHOD PATH -- the frame-ancestors and form-action of the one
# policy header, from the API; two headers would mean Caddy added its own.
lti_policy() {
  local csp
  csp=$(lti_csp "$1" "$2")
  case "$csp" in *"|"*) echo "two policies: ${csp}"; return ;; esac
  printf '%s' "$csp" | grep -oE '(frame-ancestors|form-action) [^;]*' | paste -sd'|'
}
for lti_route in "GET /lti/login" "POST /lti/login" "POST /lti/launch"; do
  # shellcheck disable=SC2086  # method and path are two words on purpose
  check_output "${lti_route} may be framed by any page and posts only to us and the platforms" \
    "${lti_form_action}|frame-ancestors *" lti_policy ${lti_route}
done
check_output "GET /lti/jwks may not be framed" "${lti_form_action}|frame-ancestors 'none'" \
  lti_policy GET /lti/jwks

# ── CSRF (ruling 7) ──────────────────────────────────────────────
# Only POST /lti/login and POST /lti/launch skip the origin check.  a has a
# session, so a refusal here is the CSRF check and not a missing sign-in.
# (A bare /lti is not an API path: Caddy serves the web bundle there.)
for lti_path in /lti/jwks /lti/loginx /lti/launchx /lti/login/x; do
  check_output "a cross-site POST to ${lti_path} is refused by the origin check" "403" \
    sec_http a POST "$lti_path" -H "Origin: https://attacker.example"
done
for lti_path in /lti/login /lti/launch; do
  lti_status=$(sec_http a POST "$lti_path" -H "Origin: https://attacker.example" --data "state=x")
  if [ "$lti_status" != "403" ]; then
    sec_pass "a cross-site POST to ${lti_path} reaches the LTI handler (${lti_status})"
  else
    sec_fail "a cross-site POST to ${lti_path} reaches the LTI handler (got: 403)"
  fi
done

# ── Launches no platform signed (rulings 16 and 19) ──────────────
if [ -z "$lti_platforms" ]; then
  for lti_path in /lti/jwks /lti/login; do
    check_output "${lti_path} is 404 with LTI off" "404" sec_http - GET "$lti_path"
  done
  check_output "POST /lti/launch is 404 with LTI off" "404" sec_http - POST /lti/launch --data "state=x"
  sec_na "forged and replayed launches are refused" "no LMS is registered"
else
  read -r lti_issuer lti_client < <(printf '%s' "$lti_platforms" | python3 -c '
import json, sys
p = json.load(sys.stdin)["platforms"][0]
print(p["issuer"], p["clientId"])')
  lti_forged=$(sec_ssh_stdin "python3 - forge $(sec_quote "$SEC_API" "$lti_issuer" "$lti_client")" \
    <"${here}/lti-launch.py" 2>/dev/null)
  lti_field() {
    printf '%s' "$lti_forged" | python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1]))' "$1" 2>/dev/null
  }
  check_output "a real login for ${lti_issuer} is started (control)" "302" lti_field alg_none_login
  check_output "a launch with an unsigned token (alg none) is refused" "401 False" \
    echo "$(lti_field alg_none) $(lti_field alg_none_session)"
  check_output "a launch with a forged RS256 signature is refused" "401 False" \
    echo "$(lti_field bad_signature) $(lti_field bad_signature_session)"
  check_output "a launch without the state cookie is refused" "400" lti_field no_cookie
  check_output "a used state is refused the second time" "400" lti_field replayed_state
  lti_reasons() {
    sec_psql "SELECT DISTINCT metadata::jsonb->>'reason' FROM audit_events WHERE id > ${SEC_AUDIT_MAX:-0} AND action = 'auth.login' AND result = 'failed' AND metadata::jsonb->>'method' = 'lti' ORDER BY 1" | paste -sd' '
  }
  # A missing or used state is anyone's unauthenticated request, so only the
  # token refusals are audited.
  lti_audited() { lti_reasons | grep -qw alg_not_allowed && lti_reasons | grep -qwE 'bad_signature|keyset_unavailable'; }
  check "each token refusal is audited with its reason code" lti_audited
  # Ruling 9: no id_token reaches a log.  Every JWT header starts eyJ.
  check_output "no id_token in the API or Caddy journal since the run started" "0" \
    sec_ssh "sudo journalctl -u portikus-api -u caddy --since @${SEC_START_EPOCH} --no-pager -o cat | grep -c 'eyJ[A-Za-z0-9_-]\\{10,\\}\\.eyJ'"

  lti_mocks=$(printf '%s' "$lti_platforms" | python3 -c '
import json, sys
print(", ".join(p["name"] + " (" + p["issuer"] + ")" for p in json.load(sys.stdin)["platforms"] if p.get("mock")))')
  if [ -n "$lti_mocks" ]; then
    sec_warn "a mock LMS is registered: ${lti_mocks} can launch as anyone while it runs (make lti-mock-unregister)"
  else
    sec_pass "no mock LMS is registered"
  fi
fi

# ── The mock is never on the VM (ruling 25) ──────────────────────
check_output "the installed package holds no mock LMS file" "0" \
  sec_ssh "dpkg -L portikus | grep -c mock-lms"

# ── The instructor role (rulings 4 and 5) ────────────────────────
if sec_mint_user inst instructor; then
  for lti_path in /admin/users /admin/workspaces /admin/settings /admin/audit /admin/health \
    "/admin/workspaces/$(sec_ws_id a)"; do
    check_output "an instructor gets 403 from GET ${lti_path}" "403" sec_http inst GET "$lti_path"
  done
  check_output "an instructor gets 403 from PUT /admin/settings" "403" \
    sec_http inst PUT /admin/settings -H 'Content-Type: application/json' --data '{}'
  check_output "an instructor gets 403 disabling a user" "403" \
    sec_http inst POST "/admin/users/${SEC_USER_ID[a]}/disable"
  check_output "an instructor gets 403 archiving a workspace" "403" \
    sec_http inst POST "/admin/workspaces/$(sec_ws_id a)/archive"
  check_output "an instructor gets 404 on a student's workspace" "404" \
    sec_http inst GET "/workspaces/$(sec_ws_id a)"
  check_output "an instructor with no course sees an empty course list" "200 []" \
    echo "$(sec_http inst GET /courses) $(tr -d ' \n' <"$SEC_LAST_BODY")"
  check_output "an instructor gets 404 for a course they do not teach" "404" \
    sec_http inst GET "/courses/$(cat /proc/sys/kernel/random/uuid)/members"
  check_output "an administrator sees no course list" "200 []" \
    echo "$(sec_http admin GET /courses) $(tr -d ' \n' <"$SEC_LAST_BODY")"
fi
