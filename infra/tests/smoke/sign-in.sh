#!/usr/bin/env bash
# The sign-in provider, Dex, and the password form's throttle.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

echo "--- Sign-in provider (Dex) ---"
echo ""

# One line per key of api.env, which only root and the API can read.
api_env() {
  ssh_cmd "sudo sed -n 's/^$1=//p' /etc/portikus/api.env"
}
discovered_issuer() {
  vm_get - "${API}/$1/.well-known/openid-configuration" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('issuer',''))" 2>/dev/null || true
}

# No bcrypt hash may reach a journal.
# shellcheck disable=SC2016  # the pattern is for grep on the VM
check_zero_lines "no bcrypt hash in the Dex, API or Caddy journals" \
  ssh_cmd 'sudo journalctl -u portikus-dex -u portikus-api -u caddy --no-pager -o cat | grep -E "[$]2[aby][$][0-9]{2}[$]"'

check "portikus-dex is active"                ssh_cmd systemctl is-active portikus-dex
dex_listeners() {
  ssh_cmd "ss -Hltn 'sport = :5556'" | awk '{ print $4 }' | sort -u | paste -sd' '
}
check_output "Dex listens on loopback only" "127.0.0.1:5556" dex_listeners
check_output "Dex discovery through Caddy reports the public issuer" "${API}/dex" \
  discovered_issuer dex
check_output "api.env names the Dex issuer" "${API}/dex" api_env OIDC_ISSUER_URL
check_output "api.env names the client portikus" "portikus" api_env OIDC_CLIENT_ID
check "api.env asks for the groups scope" \
  ssh_cmd "sudo grep -qE '^OIDC_SCOPES=(.* )?groups( |\$)' /etc/portikus/api.env"
# Compared on the VM, so the secret never leaves it.
# shellcheck disable=SC2016  # expanded by the shell on the VM
check "api.env holds the generated Dex client secret" \
  ssh_cmd 'sudo sh -c '\''test -s /etc/portikus/dex-client.secret && test "$(sed -n "s/^OIDC_CLIENT_SECRET=//p" /etc/portikus/api.env)" = "$(cat /etc/portikus/dex-client.secret)"'\'''
check_output "dex-client.secret is root, mode 0600" "root:root 600" \
  ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus/dex-client.secret"
check_output "the Dex config is root:portikus-dex, mode 0640" "root:portikus-dex 640" \
  ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus-dex/config.yaml"

# The local administrator (SPEC.md section 5.1).  The
# play made it, so --if-missing changes nothing and exits 10 while its
# one-time password is unchanged, 11 once it is spent.
check_output "the portikus command is root, mode 0755" "root:root 755" \
  ssh_cmd "stat -c '%U:%G %a' /usr/bin/portikus"
local_admin_status() {
  case "$(ssh_cmd "sudo portikus reset-admin --if-missing >/dev/null 2>&1; echo \$?")" in
    10 | 11) echo "10 or 11" ;;
    *) echo "another status" ;;
  esac
}
check_output "the local administrator exists (reset-admin --if-missing leaves it alone)" "10 or 11" \
  local_admin_status
# The password is compared on the VM, so it never leaves it.
# shellcheck disable=SC2016  # expanded by the shell on the VM
check "the one-time password file, if any, is root:root 0600 and in no journal" \
  ssh_cmd 'sudo sh -c '\''f=/etc/portikus/admin-password; test ! -e "$f" || { test "$(stat -c "%U:%G %a" "$f")" = "root:root 600" && ! journalctl --no-pager -o cat | grep -qFf "$f"; }'\'''
# The users file stays on the operator's machine, so the Dex config is
# the only place with a hash (docs/adr/0023).  /root/go holds the Dex
# source, whose examples carry sample hashes.
# shellcheck disable=SC2016  # the pattern is for grep on the VM
check_zero_lines "no bcrypt hash on the VM outside the Dex config" \
  ssh_cmd 'sudo grep -rlsE --exclude-dir=go "[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}" /etc /root /home /tmp /var/tmp | grep -vx /etc/portikus-dex/config.yaml'

# Each group of password posts comes from its own loopback address, so
# the per-address throttle counts only this run's attempts, and a rerun
# within ten minutes starts clean.  Caddy names that address to the API.
random_loopback() { echo "127.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"; }
SIGNIN_JAR="/tmp/portikus-smoke-dexsignin.jar"

# form_body EMAIL -- the password form's body, password on stdin.  Built
# here so the password is in no command line on either machine.
form_body() {
  python3 -c '
import sys, urllib.parse
password = sys.stdin.readline().rstrip("\n")
sys.stdout.write(urllib.parse.urlencode({"login": sys.argv[1], "password": password}))
' "$1"
}

# dex_form_url SOURCE -- a fresh cookie jar, then /auth/login through
# Caddy to Dex's password form.  Prints the form's URL, whose state Dex
# knows.  With an upstream connector Dex first shows a choice; the sed
# picks its own passwords, and changes nothing when there is no choice.
dex_form_url() {
  ssh_cmd "rm -f ${SIGNIN_JAR}; page=\$(${CURL} --interface $1 -c ${SIGNIN_JAR} -b ${SIGNIN_JAR} -L -o /dev/null -w '%{url_effective}' '${API}/auth/login') \
      && ${CURL} --interface $1 -c ${SIGNIN_JAR} -b ${SIGNIN_JAR} -L -o /dev/null -w '%{url_effective}' \"\$(printf '%s' \"\$page\" | sed 's|/dex/auth?|/dex/auth/local?|')\""
}

# dex_signin SOURCE -- the whole browser flow: open the password form,
# post it (body on stdin), follow Dex back through the callback.  Prints
# the status of the last page.
dex_signin() {
  local form_url
  form_url=$(dex_form_url "$1") || return
  ssh_cmd_stdin "${CURL} --interface $1 -c ${SIGNIN_JAR} -b ${SIGNIN_JAR} -L -H 'Origin: ${API}' --data-binary @- -o /dev/null -w '%{http_code}' '${form_url}'"
}
signin_has_session() {
  ssh_cmd "awk '\$6 == \"${SESSION_COOKIE_NAME}\"' ${SIGNIN_JAR} | grep -q ."
}
signin_has_no_session() { ! signin_has_session; }

# Dex answers a refused password with its form again and status 401.
signin_source=$(random_loopback)
if [ -n "$SIGNIN_EMAIL" ]; then
  refused_label="a wrong password"
else
  refused_label="an account Dex does not know"
fi
refused_status=$(printf '%s\n' "wrong-$(openssl rand -hex 12)" \
  | form_body "${SIGNIN_EMAIL:-smoke-nobody@example.invalid}" | dex_signin "$signin_source" 2>/dev/null)
check_output "${refused_label} is refused at Dex's form" "401" echo "$refused_status"
check "${refused_label} gets no session" signin_has_no_session

if [ -n "$SIGNIN_EMAIL" ]; then
  echo ""
  echo "Signing in through Dex as the user in ${PORTIKUS_SMOKE_SIGNIN_FILE}..."
  printf '%s\n' "$SIGNIN_PASSWORD" | form_body "$SIGNIN_EMAIL" | dex_signin "$signin_source" >/dev/null 2>&1
  check "a full Dex password sign-in gets a session" signin_has_session
  signin_me() {
    ssh_cmd "${CURL} -b ${SIGNIN_JAR} '${API}/auth/me'" | python3 -c '
import json, sys
me = json.load(sys.stdin)
print(me.get("email", "").lower(), me.get("role", "") in ("student", "instructor", "administrator"))
' 2>/dev/null || true
  }
  check_output "/auth/me after the Dex sign-in names the user and a role" \
    "$(printf '%s' "$SIGNIN_EMAIL" | tr '[:upper:]' '[:lower:]') True" signin_me
  ssh_cmd "${CURL} -b ${SIGNIN_JAR} -X POST -H 'Origin: ${API}' -o /dev/null '${API}/auth/logout'" >/dev/null 2>&1 || true
else
  echo "No PORTIKUS_SMOKE_SIGNIN_FILE: skipping the full Dex password sign-in."
fi
ssh_cmd "rm -f ${SIGNIN_JAR}" >/dev/null 2>&1 || true

# The password form is limited per address (SPEC.md 5.3).  The limit is the
# packages/config default unless api.env raises it.
password_limit=$(api_env PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES)
password_limit="${password_limit:-30}"
throttle_source=$(random_loopback)
# A state Dex knows makes each post a real wrong password, which keeps its
# count.  A new login each time keeps the per-account limit of 10 from
# refusing first and giving the address count back (SPEC.md 24.13).
throttle_statuses() {
  local form_url
  form_url=$(dex_form_url "$throttle_source") || return
  ssh_cmd "for i in \$(seq 1 $((password_limit + 1))); do ${CURL} --interface ${throttle_source} -b ${SIGNIN_JAR} -o /dev/null -w '%{http_code}\n' -H 'Origin: ${API}' \
      --data \"login=smoke-throttle-\$i%40example.invalid&password=x\" '${form_url}'; done; rm -f ${SIGNIN_JAR}"
}
throttle_result() {
  throttle_statuses | awk -v n="$((password_limit + 1))" \
    'NR < n && $1 == 429 { early++ } NR == n { last = $1 } END { print (early ? "early 429" : "last " last) }'
}
check_output "the password form refuses attempt $((password_limit + 1)) from one address" \
  "last 429" throttle_result
check_output "the refusal is audited once for that address" "1" \
  ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE action = 'auth.throttled' AND metadata::jsonb->>'ip' = '${throttle_source}'\""

# The count lives in PostgreSQL, so a restart of the API hands out no fresh
# guesses (ADR 0053).  A restart drops every open socket, so the pilot,
# whose host name is portikus, is left alone.
api_ready() {
  ssh_cmd "for i in \$(seq 1 60); do test \"\$(${CURL} -o /dev/null -w '%{http_code}' '${API}/health')\" = 200 && exit 0; sleep 1; done; exit 1"
}
throttle_after_restart() {
  ssh_cmd "sudo systemctl restart portikus-api" >/dev/null 2>&1 || { echo "restart failed"; return; }
  api_ready || { echo "API not back"; return; }
  local form_url
  form_url=$(dex_form_url "$throttle_source") || return
  ssh_cmd "${CURL} --interface ${throttle_source} -b ${SIGNIN_JAR} -o /dev/null -w '%{http_code}' -H 'Origin: ${API}' \
      --data 'login=smoke-throttle-restart%40example.invalid&password=x' '${form_url}'; rm -f ${SIGNIN_JAR}"
}
if [ "$(ssh_cmd hostname 2>/dev/null || true)" = portikus ]; then
  echo "The pilot: skipping the check that the password count survives an API restart."
else
  check_output "the password count for that address survives an API restart" "429" \
    throttle_after_restart
fi

# The relay sits behind the API's cross-site check, so another site cannot
# sign a browser in to an account of its choosing (SPEC.md 24.13).
check_output "a password post from another site is refused" "403" \
  ssh_cmd "${CURL} --interface $(random_loopback) -o /dev/null -w '%{http_code}' -H 'Origin: https://elsewhere.example' \
      --data 'login=smoke-csrf%40example.invalid&password=x' '${API}/dex/auth/local/login?back=&state=smoke-csrf'"
