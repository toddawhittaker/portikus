#!/usr/bin/env bash
# Tests `portikus alert` and `portikus alert-failed` (STACK.md section 15)
# against a fake webhook and a fake Pushover on loopback: the bodies match
# packages/observability's, the request goes through the proxy named in
# api.env, nothing is sent when no channel is set, no secret reaches a
# command line, and a failing unit alerts once per 10 minutes.  Needs no VM
# and no root.  `make infra-check` runs it.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

work="$(mktemp -d)"
server=""
cleanup() {
  [ -z "${server}" ] || kill "${server}" 2>/dev/null
  rm -rf "${work}"
}
trap cleanup EXIT

# Records each request as one JSON line; a path holding "fail" gets a 500.
cat >"${work}/fake.py" <<'EOF'
import http.server, json, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        with open(sys.argv[1], "a") as log:
            log.write(json.dumps({"path": self.path, "type": self.headers.get("Content-Type"), "body": body}) + "\n")
        self.send_response(500 if "fail" in self.path else 200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[2], "w") as f:
    f.write(str(server.server_port))
server.serve_forever()
EOF
python3 "${work}/fake.py" "${work}/requests.log" "${work}/port" &
server=$!
for _ in $(seq 50); do [ -s "${work}/port" ] && break; sleep 0.1; done
port="$(cat "${work}/port")"
fake="http://127.0.0.1:${port}"

# The host command, with its fixed paths pointed at this test's files, and
# fake id and systemctl, so it runs as this user.
mkdir -p "${work}/bin"
cli="${work}/portikus"
sed -e "s|^ALERTS_ENV=.*|ALERTS_ENV=${work}/alerts.env|" \
  -e "s|^API_ENV=.*|API_ENV=${work}/api.env|" \
  -e "s|^ALERT_STAMPS=.*|ALERT_STAMPS=${work}/stamps|" \
  -e "s|^PUSHOVER_URL=.*|PUSHOVER_URL=${fake}/1/messages.json|" \
  "${REPO_ROOT}/packaging/bin/portikus" >"${cli}"
printf '#!/bin/sh\necho 0\n' >"${work}/bin/id"
printf '#!/bin/sh\necho signal\n' >"${work}/bin/systemctl"
# Logs every curl command line, to prove no secret is on one.
printf '#!/bin/sh\necho "$*" >>"%s/curl-args.log"\nexec %s "$@"\n' "${work}" "$(command -v curl)" >"${work}/bin/curl"
chmod +x "${work}/bin/"*
# No proxy from this machine's environment, only the one api.env names.
run() {
  env -u http_proxy -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    PATH="${work}/bin:${PATH}" sh "${cli}" "$@" >"${work}/out" 2>&1
}
requests() { [ -f "${work}/requests.log" ] && wc -l <"${work}/requests.log" || echo 0; }
last() { tail -n 1 "${work}/requests.log" | python3 -c "import json, sys; print(json.load(sys.stdin)$1)"; }

user_key=uTestUserKey
app_token=aTestAppToken
site="$(uname -n)"

echo
echo "--- nothing configured ---"
echo

run alert warning "Disk nearly full" "The thin pool is 91% full."
expect_eq "with no alerts.env it exits 0" 0 "$?"
check "and says nothing was sent" grep -q 'nothing sent' "${work}/out"
expect_eq "and sends no request" 0 "$(requests)"

printf 'ALERT_PUSHOVER_USER_KEY=\nALERT_PUSHOVER_APP_TOKEN=\nALERT_WEBHOOK_URL=\n' >"${work}/alerts.env"
run alert danger "Title" "Text"
expect_eq "with every channel empty it exits 0" 0 "$?"
expect_eq "and sends no request" 0 "$(requests)"

printf 'ALERT_PUSHOVER_USER_KEY=%s\nALERT_PUSHOVER_APP_TOKEN=\nALERT_WEBHOOK_URL=\n' "${user_key}" >"${work}/alerts.env"
run alert danger "Title" "Text"
expect_eq "a Pushover user key without its app token sends nothing" 0 "$(requests)"

echo
echo "--- arguments ---"
echo

run alert info "Title" "Text"
expect_eq "a tone other than warning or danger is refused" 2 "$?"
run alert warning "Title only"
expect_eq "a missing text is refused" 2 "$?"
run alert-failed "../etc/passwd"
expect_eq "alert-failed refuses a name that is not a unit's" 2 "$?"
expect_eq "and sends nothing" 0 "$(requests)"

echo
echo "--- webhook ---"
echo

printf 'ALERT_PUSHOVER_USER_KEY=\nALERT_PUSHOVER_APP_TOKEN=\nALERT_WEBHOOK_URL=%s/hook/s3cret?x=1&y=2\n' "${fake}" >"${work}/alerts.env"
: >"${work}/api.env"
title='Backup "nightly" failed'
text=$'Line one\nback\\slash and 100% done'
run alert warning "${title}" "${text}"
expect_eq "the webhook alert exits 0" 0 "$?"
expect_eq "one request is sent" 1 "$(requests)"
expect_eq "to the webhook's path and query" "/hook/s3cret?x=1&y=2" "$(last '["path"]')"
expect_eq "as JSON" "application/json" "$(last '["type"]')"
expect_eq "the body has exactly the worker's fields" "['at', 'site', 'text', 'title', 'tone']" \
  "$(last '["body"]' | python3 -c 'import json, sys; print(sorted(json.loads(sys.stdin.read())))')"
body() { last '["body"]' | python3 -c "import json, sys; print(json.loads(sys.stdin.read())$1)"; }
expect_eq "title is kept with its quotes" "${title}" "$(body '["title"]')"
expect_eq "text is the title, a newline, then the text" "${title}"$'\n'"${text}" "$(body '["text"]')"
expect_eq "tone" "warning" "$(body '["tone"]')"
expect_eq "site is the host name" "${site}" "$(body '["site"]')"
check "at is an ISO time in UTC, as toISOString writes it" \
  python3 -c "import re, sys; sys.exit(not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z', sys.argv[1]))" "$(body '["at"]')"

printf 'ALERT_WEBHOOK_URL=%s/fail\n' "${fake}" >"${work}/alerts.env"
run alert warning "Title" "Text"
expect_eq "a webhook answering 500 makes it fail" 1 "$?"
check "and says the webhook alert could not be sent" grep -q 'webhook alert could not be sent' "${work}/out"

echo
echo "--- through the proxy ---"
echo

# The fake answers as the proxy, so the request arrives in absolute form.
printf 'ALERT_WEBHOOK_URL=http://hooks.example.invalid/services/T0/B0\n' >"${work}/alerts.env"
printf 'NODE_ENV=production\nOUTBOUND_PROXY_URL=%s\n' "${fake}" >"${work}/api.env"
run alert danger "Title" "Text"
expect_eq "with OUTBOUND_PROXY_URL in api.env it exits 0" 0 "$?"
expect_eq "and the request reaches the proxy for the webhook's host" \
  "http://hooks.example.invalid/services/T0/B0" "$(last '["path"]')"

echo
echo "--- Pushover ---"
echo

printf 'ALERT_PUSHOVER_USER_KEY=%s\nALERT_PUSHOVER_APP_TOKEN=%s\nALERT_WEBHOOK_URL=%s/hook\n' \
  "${user_key}" "${app_token}" "${fake}" >"${work}/alerts.env"
: >"${work}/api.env"
before="$(requests)"
run alert danger "Worker stopped" "It restarts by itself."
expect_eq "with both channels it exits 0" 0 "$?"
expect_eq "and sends two requests" $((before + 2)) "$(requests)"
form="$(sed -n "$((before + 1))p" "${work}/requests.log")"
pushover() { printf '%s' "${form}" | python3 -c "import json, sys, urllib.parse; r = json.load(sys.stdin); print($1)"; }
expect_eq "Pushover first, at its messages path" "/1/messages.json" "$(pushover 'r["path"]')"
expect_eq "as a form" "application/x-www-form-urlencoded" "$(pushover 'r["type"]')"
expect_eq "with the worker's fields" "['message', 'priority', 'timestamp', 'title', 'token', 'user']" \
  "$(pushover 'sorted(urllib.parse.parse_qs(r["body"]))')"
form_field() { pushover "urllib.parse.parse_qs(r[\"body\"])[\"$1\"][0]"; }
expect_eq "the app token" "${app_token}" "$(form_field token)"
expect_eq "the user key" "${user_key}" "$(form_field user)"
expect_eq "the message ends with the site" $'It restarts by itself.\n('"${site}"')' "$(form_field message)"
expect_eq "danger is high priority" 1 "$(form_field priority)"
check "no secret was on a curl command line" \
  sh -c "[ -s '${work}/curl-args.log' ] && ! grep -qe '${user_key}' -e '${app_token}' -e s3cret '${work}/curl-args.log'"

echo
echo "--- alert-failed ---"
echo

printf 'ALERT_WEBHOOK_URL=%s/hook\n' "${fake}" >"${work}/alerts.env"
before="$(requests)"
run alert-failed portikus-worker.service
expect_eq "a failed unit sends one alert" $((before + 1)) "$(requests)"
expect_eq "as danger" danger "$(body '["tone"]')"
expect_eq "named for the unit and the host" "portikus-worker.service failed on ${site}" "$(body '["title"]')"
check "with systemd's reason in the text" sh -c "tail -n 1 '${work}/requests.log' | grep -q '(signal)'"
check "and a stamp" test -f "${work}/stamps/portikus-worker.service"
run alert-failed portikus-worker.service
expect_eq "a second failure within 10 minutes exits 0" 0 "$?"
expect_eq "and sends nothing" $((before + 1)) "$(requests)"
check "and says so" grep -q 'not sending another' "${work}/out"
run alert-failed postgresql@17-main.service
expect_eq "another unit still alerts" $((before + 2)) "$(requests)"
touch -d '11 minutes ago' "${work}/stamps/portikus-worker.service"
run alert-failed portikus-worker.service
expect_eq "after 10 minutes the unit alerts again" $((before + 3)) "$(requests)"

echo
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
