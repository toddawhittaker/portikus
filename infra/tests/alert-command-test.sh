#!/usr/bin/env bash
# Tests the shell side of `portikus alert` and `portikus alert-failed`
# (STACK.md section 15): the arguments it refuses, the worker's account and
# settings it runs the sender with, nothing sent before setup, and one alert
# per unit per 10 minutes.  The payloads themselves are the worker's
# (apps/worker/src/alert-command.test.ts); one end-to-end check here runs the
# built alert-main.js against a fake webhook when `pnpm build` has made it.
# Needs no VM and no root.  `make infra-check` runs it.
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

# The host command, with its fixed paths pointed at this test's files, and
# fake id and systemctl, so it runs as this user.  The fake systemd-run logs
# its arguments, loads the environment files it is given, and runs the rest.
mkdir -p "${work}/bin"
cli="${work}/portikus"
main="${REPO_ROOT}/apps/worker/dist/alert-main.js"
sed -e "s|^WORKER_ENV=.*|WORKER_ENV=${work}/worker.env|" \
  -e "s|^WORKER_OVERRIDE_ENV=.*|WORKER_OVERRIDE_ENV=${work}/worker.override.env|" \
  -e "s|^ALERT_STAMPS=.*|ALERT_STAMPS=${work}/stamps|" \
  -e "s|^NODE=.*|NODE=$(command -v node || echo node)|" \
  -e "s|^ALERT_MAIN=.*|ALERT_MAIN=${main}|" \
  "${REPO_ROOT}/packaging/bin/portikus" >"${cli}"
printf '#!/bin/sh\necho 0\n' >"${work}/bin/id"
printf '#!/bin/sh\necho signal\n' >"${work}/bin/systemctl"
cat >"${work}/bin/systemd-run" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >"${work}/systemd-run.args"
while [ \$# -gt 0 ]; do
  case "\$1" in
    -p) f=\${2#EnvironmentFile=}; f=\${f#-}; [ ! -f "\$f" ] || { set -a; . "\$f"; set +a; }; shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "\$@"
EOF
chmod +x "${work}/bin/"*
run() {
  env -u http_proxy -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    PATH="${work}/bin:${PATH}" sh "${cli}" "$@" >"${work}/out" 2>&1
}
site="$(uname -n)"

echo
echo "--- arguments ---"
echo

run alert info "Title" "Text"
expect_eq "a tone other than warning or danger is refused" 2 "$?"
run alert warning "Title only"
expect_eq "a missing text is refused" 2 "$?"
run alert-failed "../etc/passwd"
expect_eq "alert-failed refuses a name that is not a unit's" 2 "$?"
check "and runs no sender" test ! -e "${work}/systemd-run.args"

echo
echo "--- before setup ---"
echo

run alert warning "Disk nearly full" "The thin pool is 91% full."
expect_eq "with no worker.env it exits 0" 0 "$?"
check "and says nothing was sent" grep -q 'nothing sent' "${work}/out"
check "and runs no sender" test ! -e "${work}/systemd-run.args"

echo
echo "--- the sender ---"
echo

: >"${work}/worker.env"
title='Backup "nightly" failed'
run alert warning "${title}" "Two words"
expect_eq "it runs the worker's sender as the worker, with the worker's settings and the group that reads notify.json" \
  "--wait --pipe --quiet --collect --uid=portikus-worker -p SupplementaryGroups=portikus-notify -p EnvironmentFile=${work}/worker.env -p EnvironmentFile=-${work}/worker.override.env" \
  "$(head -n 11 "${work}/systemd-run.args" | tr '\n' ' ' | sed 's/ $//')"
expect_eq "with the tone, title and text as three arguments" \
  "${main} warning ${title} Two words" "$(tail -n 4 "${work}/systemd-run.args" | tr '\n' ' ' | sed 's/ $//')"
check "and no secret on a command line, only file names" bash -c "! grep -q ALERT_ '${work}/systemd-run.args'"

echo
echo "--- alert-failed ---"
echo

rm -f "${work}/systemd-run.args"
run alert-failed portikus-worker.service
check "a failed unit sends one alert" test -e "${work}/systemd-run.args"
check "as danger, named for the unit and the host, with systemd's reason" \
  bash -c "a=\$(tr '\n' '|' <'${work}/systemd-run.args'); case \$a in *'|danger|portikus-worker.service failed on ${site}|'*'(signal)'*) exit 0 ;; esac; exit 1"
check "and a stamp" test -f "${work}/stamps/portikus-worker.service"
rm -f "${work}/systemd-run.args"
run alert-failed portikus-worker.service
expect_eq "a second failure within 10 minutes exits 0" 0 "$?"
check "and sends nothing" test ! -e "${work}/systemd-run.args"
check "and says so" grep -q 'not sending another' "${work}/out"
run alert-failed postgresql@17-main.service
check "another unit still alerts" test -e "${work}/systemd-run.args"
rm -f "${work}/systemd-run.args"
touch -d '11 minutes ago' "${work}/stamps/portikus-worker.service"
run alert-failed portikus-worker.service
check "after 10 minutes the unit alerts again" test -e "${work}/systemd-run.args"

echo
echo "--- end to end ---"
echo

if [ ! -f "${main}" ] || ! command -v node >/dev/null; then
  echo "SKIP  the end-to-end check needs node and ${main}; run pnpm build first"
else
  # A fake egress proxy: records each tunnel request as one line and refuses
  # it, as Squid refuses a host it does not list.
  cat >"${work}/fake.py" <<'EOF'
import http.server, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        with open(sys.argv[1], "a") as log:
            log.write(self.path + "\n")
        self.send_response(403)
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
  fake="http://127.0.0.1:$(cat "${work}/port")"
  # The proxy comes from worker.env and the channel from notify.json (ADR
  # 0052).  The worker's own tests check the bodies.
  printf 'NODE_ENV=production\nOUTBOUND_PROXY_URL=%s\nNOTIFY_FILE=%s\n' "${fake}" "${work}/notify.json" >"${work}/worker.env"
  run alert danger "${title}" "It restarts by itself."
  expect_eq "with no notify.json the alert exits 0" 0 "$?"
  check "and says nothing was sent" grep -q 'nothing sent' "${work}/out"
  printf '{"version":1,"smtp":null,"alerts":{"email":null,"pushover":null,"webhook":{"url":"https://hooks.example.invalid/services/T0"},"ntfy":null,"teams":null}}\n' >"${work}/notify.json"
  run alert danger "${title}" "It restarts by itself."
  expect_eq "a refused webhook makes it fail" 1 "$?"
  check "and says the webhook alert could not be sent" grep -q 'webhook alert could not be sent' "${work}/out"
  expect_eq "the request reached the proxy for the webhook's host from notify.json" \
    "hooks.example.invalid:443" "$(head -n 1 "${work}/requests.log")"
  check "and no secret path reached the proxy" bash -c "! grep -q services '${work}/requests.log'"
  printf '{"version":1' >"${work}/notify.json"
  run alert warning "Title" "Text"
  expect_eq "a broken notify.json makes it fail" 1 "$?"
  check "and names the file" grep -q "${work}/notify.json" "${work}/out"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
