#!/usr/bin/env bash
# Tests how the portikus role reads the LTI platforms file and the proxy
# entries it derives (docs/archive/epics/EPIC-14.md, ruling 28), and the mock
# registration helper the Makefile uses.  Needs no VM.  The file's rules
# are tested with the API's own parser in packages/auth.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLAYBOOK="${REPO_ROOT}/infra/tests/lti-platforms-load.yml"
TASKS="${REPO_ROOT}/infra/ansible/roles/portikus/tasks/lti.yml"
HELPER="${REPO_ROOT}/infra/host/lti-mock-registration.py"
SEED="${REPO_ROOT}/packages/mock-lms/src/seed.ts"

pass=0
fail=0
ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
check() { if "${@:2}"; then ok "$1"; else no "$1"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

command -v ansible-playbook >/dev/null || {
  echo "error: ansible is needed (docs/WORKFLOW.md)" >&2
  exit 1
}

# load FILE — reads the file as the role does; prints the result line, fails when it refuses.
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

# platform NAME ISSUER KEYSET MOCK
platform() {
  printf '{"name":"%s","issuer":"%s","clientId":"c1","authLoginUrl":"%s/auth","keysetUrl":"%s","deploymentIds":["d1"],"mock":%s}' \
    "$1" "$2" "$2" "$3" "$4"
}

file() { # NAME PLATFORM-JSON...
  local name=$1
  shift
  local IFS=,
  printf '{"version":1,"platforms":[%s]}' "$*" >"${work}/${name}.json"
  echo "${work}/${name}.json"
}

echo "--- Reading the platforms file and deriving the egress proxy entries ---"

accepts "no file means LTI is off" "${work}/absent.json" '{"on": false, "egress": []}'
accepts "the mock registration's keyset address and port are allowed" \
  "$(file mock "$(platform mock-lms http://10.100.0.1:8765 http://10.100.0.1:8765/.well-known/jwks.json true)")" \
  '{"on": true, "egress": ["10.100.0.1:8765"]}'
accepts "a hostname keyset is allowed by name on 443" \
  "$(file canvas "$(platform Canvas https://canvas.instructure.com https://sso.canvaslms.com/api/lti/security/jwks false)")" \
  '{"on": true, "egress": ["sso.canvaslms.com:443"]}'
refuses "an IPv6 keyset address is refused" \
  "$(file v6 "$(platform v6 https://lms.example "https://[2001:db8::5]/jwks" false)")"
accepts "a keyset host shared by two platforms is allowed once" \
  "$(file shared "$(platform a https://one.example https://192.0.2.7/jwks false)" \
    "$(platform b https://two.example https://192.0.2.7/jwks false)")" \
  '{"on": true, "egress": ["192.0.2.7:443"]}'
# The API's parser refuses a malformed file at install; reading must not trip on it first.
printf '{"version":1,"platforms":[{"name":"a"},"x"]}' >"${work}/malformed.json"
accepts "a malformed file is left for the API's parser" "${work}/malformed.json" '{"on": true, "egress": []}'
printf '{"version":1,' >"${work}/broken.json"
refuses "a file that is not JSON is refused" "${work}/broken.json"

echo ""
echo "--- Installing and removing the file on the VM ---"

install_rules() {
  python3 - "${TASKS}" <<'PY'
import sys, yaml
tasks = yaml.safe_load(open(sys.argv[1]))
copy = next(t for t in tasks if "ansible.builtin.copy" in t)
remove = next(t for t in tasks if t.get("ansible.builtin.file", {}).get("state") == "absent")
assert "portikus_lti_platforms_check_script" in copy["ansible.builtin.copy"]["validate"]
assert copy["when"] == "portikus_lti_platforms is not none"
assert remove["when"] == "portikus_lti_platforms is none"
assert copy["notify"] == remove["notify"]
PY
}
check "the file is installed through the API's check and removed when absent" install_rules

echo ""
echo "--- The mock registration helper ---"

reg="${work}/home/lti-platforms.json"
helper() { python3 "${HELPER}" --file "${reg}" "$@" >/dev/null; }
register() { helper register --url http://10.100.0.1:8765; }

register && register
check "registering twice leaves one mock registration" [ "$(grep -c '"name": "mock-lms"' "${reg}")" = 1 ]
accepts "the helper's file allows the mock's address" "${reg}" '{"on": true, "egress": ["10.100.0.1:8765"]}'

helper unregister
check "unregistering the only platform removes the file" [ ! -e "${reg}" ]

cp "$(file keep "$(platform Canvas https://canvas.instructure.com https://sso.canvaslms.com/jwks false)")" "${reg}"
register && helper unregister
accepts "unregistering keeps every other platform" "${reg}" '{"on": true, "egress": ["sso.canvaslms.com:443"]}'

# The mock LMS signs as this registration, so the two must agree.
ids_match() {
  local client deployment
  client="$(sed -n 's/^CLIENT_ID = "\(.*\)"$/\1/p' "${HELPER}")"
  deployment="$(sed -n 's/^DEPLOYMENT_ID = "\(.*\)"$/\1/p' "${HELPER}")"
  [ -n "${client}" ] && [ -n "${deployment}" ] &&
    grep -q "CLIENT_ID = \"${client}\"" "${SEED}" &&
    grep -q "DEPLOYMENT_ID = \"${deployment}\"" "${SEED}"
}
check "the helper's client and deployment ids match the mock LMS seed" ids_match

echo ""
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
