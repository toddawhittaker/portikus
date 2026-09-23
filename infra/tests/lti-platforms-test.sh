#!/usr/bin/env bash
# Tests the portikus role's LTI platforms-file guards and the API egress
# they derive (docs/EPIC-13.md, rulings 14 and 26), and the mock
# registration helper the Makefile uses.  Needs no VM.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLAYBOOK="${REPO_ROOT}/infra/tests/lti-platforms-load.yml"
HELPER="${REPO_ROOT}/infra/host/lti-mock-registration.py"

pass=0
fail=0
ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v ansible-playbook >/dev/null || {
  echo "error: ansible is needed (docs/WORKFLOW.md)" >&2
  exit 1
}

# load FILE — runs the guards; prints the result line, fails when they refuse.
load() {
  ansible-playbook "${PLAYBOOK}" -e "portikus_lti_platforms_file=$1" >"${work}/run.log" 2>&1 || return 1
  grep -o 'LTI-RESULT {.*}' "${work}/run.log" | head -1 | sed 's/^LTI-RESULT //; s/\\"/"/g'
}

accepts() { # LABEL FILE EXPECTED-RESULT
  local got
  if got="$(load "$2")" && [ "${got}" = "$3" ]; then ok "$1"; else no "$1 (got '${got:-refused}')"; fi
}

refuses() { # LABEL FILE
  if load "$2" >/dev/null; then no "$1"; else ok "$1"; fi
}

# platform NAME ISSUER KEYSET MOCK [EXTRA-JSON]
platform() {
  printf '{"name":"%s","issuer":"%s","clientId":"c1","authLoginUrl":"%s/auth","keysetUrl":"%s","deploymentIds":["d1"],"mock":%s%s}' \
    "$1" "$2" "$2" "$3" "$4" "${5:-}"
}

file() { # NAME PLATFORM-JSON...
  local name=$1
  shift
  local IFS=,
  printf '{"version":1,"platforms":[%s]}' "$*" >"${work}/${name}.json"
  echo "${work}/${name}.json"
}

echo "--- The platforms file guards ---"

accepts "no file means LTI is off" "${work}/absent.json" '{"on": false, "cidrs": []}'
accepts "the mock registration is accepted and its address allowed" \
  "$(file mock "$(platform mock-lms http://10.100.0.1:8765 http://10.100.0.1:8765/.well-known/jwks.json true)")" \
  '{"on": true, "cidrs": ["10.100.0.1/32"]}'
accepts "a hostname keyset is accepted and adds no address" \
  "$(file canvas "$(platform Canvas https://canvas.instructure.com https://sso.canvaslms.com/api/lti/security/jwks false)")" \
  '{"on": true, "cidrs": []}'
accepts "an IPv6 keyset address is allowed exactly" \
  "$(file v6 "$(platform v6 https://lms.example "https://[2001:db8::5]/jwks" false)")" \
  '{"on": true, "cidrs": ["2001:db8::5/128"]}'

refuses "http:// is refused without mock" \
  "$(file http "$(platform lms http://lms.example http://lms.example/jwks false)")"
refuses "a keyset over http:// is refused without mock" \
  "$(file httpkeys "$(platform lms https://lms.example http://lms.example/jwks false)")"
refuses "an unknown key is refused" \
  "$(file extra "$(platform lms https://lms.example https://lms.example/jwks false ',"secret":"x"')")"
refuses "a name over 60 characters is refused" \
  "$(file longname "$(platform "$(printf 'n%.0s' $(seq 61))" https://lms.example https://lms.example/jwks false)")"
refuses "two platforms with one name are refused" \
  "$(file dupname "$(platform a https://one.example https://one.example/jwks false)" \
    "$(platform a https://two.example https://two.example/jwks false)")"
refuses "the same issuer and client id twice is refused" \
  "$(file duppair "$(platform a https://one.example https://one.example/jwks false)" \
    "$(platform b https://one.example https://one.example/jwks false)")"
printf '{"version":1,"platforms":[{"name":"a","issuer":"https://x.example","clientId":"c","authLoginUrl":"https://x.example/a","keysetUrl":"https://x.example/k","deploymentIds":[]}]}' >"${work}/nodeploy.json"
refuses "a platform with no deployment id is refused" "${work}/nodeploy.json"
printf '{"version":2,"platforms":[]}' >"${work}/v2.json"
refuses "another version is refused" "${work}/v2.json"
printf '{"version":1,"platforms":[]}' >"${work}/empty.json"
refuses "a file with no platforms is refused" "${work}/empty.json"
printf '{"version":1,' >"${work}/broken.json"
refuses "a file that is not JSON is refused" "${work}/broken.json"

echo ""
echo "--- The mock registration helper ---"

reg="${work}/home/lti-platforms.json"
helper() { python3 "${HELPER}" --file "${reg}" "$@" >/dev/null; }
register() { helper register --url http://10.100.0.1:8765 --client-id portikus-mock --deployment-id mock-deployment-1; }

register && register
if [ "$(grep -c '"name": "mock-lms"' "${reg}")" = 1 ]; then
  ok "registering twice leaves one mock registration"
else
  no "registering twice leaves one mock registration"
fi
accepts "the helper writes a file the guards accept" "${reg}" '{"on": true, "cidrs": ["10.100.0.1/32"]}'

helper unregister
if [ ! -e "${reg}" ]; then ok "unregistering the only platform removes the file"; else no "unregistering the only platform removes the file"; fi

cp "$(file keep "$(platform Canvas https://canvas.instructure.com https://sso.canvaslms.com/jwks false)")" "${reg}"
register && helper unregister
accepts "unregistering keeps every other platform" "${reg}" '{"on": true, "cidrs": []}'

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
