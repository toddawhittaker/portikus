#!/usr/bin/env bash
# The rebuild-from-code exercise (STACK.md section 33; docs/EPIC-12B.md,
# item 20 and task B5), on the rehearsal VM only.
#
# Usage: rebuild-exercise.sh <backup set dir>
#   Run it through `make rebuild-exercise`, which passes the settings below.
#
# Steps, each timed:
#   1. build the package from this checkout (it stands in for the newest
#      release, so the exercise tests what is about to ship), then reinstall
#      the dev dependencies that `make build-deb` prunes;
#   2. destroy the rehearsal VM and recreate it with OpenTofu and cloud-init;
#   3. converge it with Ansible, Dex included;
#   4. build and import the workspace image;
#   5. restore the backup set, and start one restored workspace to check it;
#   6. when the set was taken before the Dex cutover, carry its accounts
#      over to Dex (the dry run, then configure-vm);
#   7. run the full smoke test, with the restored-data checks, the lifecycle
#      block and a full Dex sign-in;
#   8. reinstall the previous package and check /health and a sign-in.
# The VM is destroyed at the end whatever happens, because it holds restored
# student data.
#
# Environment:
#   PREVIOUS_VERSION or PREVIOUS_DEB  the release, or the local package file,
#                               to roll back to; it must support the
#                               configured sign-in provider
#   PORTIKUS_USERS_FILE         the rehearsal Dex users file
#   PORTIKUS_SMOKE_SIGNIN_FILE  email and password (two lines, mode 0600) of
#                               a user in that file
#   PORTIKUS_BACKUP_IDENTITY    the age key that opens the set
#   PORTIKUS_PUBLIC_HOST, PORTIKUS_PUBLIC_PORT  as for the pilot
set -euo pipefail

SET="${1:?Usage: rebuild-exercise.sh <backup set dir>}"
SET=$(cd "$SET" && pwd)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${PORTIKUS_USERS_FILE:?PORTIKUS_USERS_FILE is required}"
: "${PORTIKUS_SMOKE_SIGNIN_FILE:?PORTIKUS_SMOKE_SIGNIN_FILE is required}"
: "${PORTIKUS_PUBLIC_HOST:?PORTIKUS_PUBLIC_HOST is required}"
: "${PORTIKUS_PUBLIC_PORT:?PORTIKUS_PUBLIC_PORT is required}"
PREVIOUS_VERSION="${PREVIOUS_VERSION:-}"
PREVIOUS_DEB="${PREVIOUS_DEB:-}"
if [ -n "$PREVIOUS_DEB" ]; then
  PREVIOUS_DEB=$(cd "$(dirname "$PREVIOUS_DEB")" && pwd)/$(basename "$PREVIOUS_DEB")
  PREVIOUS_ARG="PORTIKUS_DEB=${PREVIOUS_DEB}"
  previous_label=$(dpkg-deb -f "$PREVIOUS_DEB" Version)
elif [ -n "$PREVIOUS_VERSION" ]; then
  PREVIOUS_ARG="PORTIKUS_VERSION=${PREVIOUS_VERSION}"
  previous_label="$PREVIOUS_VERSION"
else
  echo "rebuild-exercise: set PREVIOUS_VERSION=<release> or PREVIOUS_DEB=<file> for the rollback step" >&2
  exit 2
fi
[ -f "${SET}/MANIFEST.age" ] || { echo "rebuild-exercise: ${SET} is not a backup set" >&2; exit 2; }
signin_email=$(sed -n 1p "$PORTIKUS_SMOKE_SIGNIN_FILE")
[[ "$signin_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] \
  || { echo "rebuild-exercise: the first line of ${PORTIKUS_SMOKE_SIGNIN_FILE} is not an email address" >&2; exit 2; }

AUTHORITY="${PORTIKUS_PUBLIC_HOST}:${PORTIKUS_PUBLIC_PORT}"
REHEARSAL_NAME=portikus-rehearsal
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/portikus-rebuild-exercise.XXXXXX")
M=(make -C "$ROOT" --no-print-directory TOFU_ENV=rehearsal-libvirt
  "PORTIKUS_USERS_FILE=${PORTIKUS_USERS_FILE}" PORTIKUS_IDP=dex
  "PORTIKUS_PUBLIC_HOST=${PORTIKUS_PUBLIC_HOST}" "PORTIKUS_PUBLIC_PORT=${PORTIKUS_PUBLIC_PORT}")

names=() seconds=() results=()
T0=$(date +%s)

table() {
  echo ""
  echo "--- Rebuild exercise: $(basename "$SET"), rollback to ${previous_label} ---"
  local i
  for i in "${!names[@]}"; do
    printf '  %-52s %6s s  %s\n' "${names[$i]}" "${seconds[$i]}" "${results[$i]}"
  done
  printf '  %-52s %6s s\n' "total" "$(($(date +%s) - T0))"
  echo "Logs: ${LOGS}"
}

# STEP NAME CMD... -- run one step into its own log, time it, stop on failure.
# The command runs with errexit off, so a function returns on its own errors.
step() {
  local name="$1" start rc=0 log
  shift
  start=$(date +%s)
  log="${LOGS}/$((${#names[@]} + 1))-${name//[^A-Za-z0-9.+-]/-}.log"
  echo "[$(date +%H:%M:%S)] ${name}..."
  "$@" >"$log" 2>&1 || rc=$?
  names+=("$name")
  seconds+=("$(($(date +%s) - start))")
  if [ "$rc" -ne 0 ]; then
    results+=("FAILED")
    echo "[$(date +%H:%M:%S)] ${name} failed (exit ${rc}); the end of ${log}:"
    tail -25 "$log"
    return "$rc"
  fi
  results+=("ok")
}

# The VM holds restored student data, so it goes whatever happened.
finish() {
  local rc=$?
  trap - EXIT
  set +e
  step "destroy the rehearsal VM" destroy_vm
  table
  if [ "$rc" -eq 0 ]; then echo "Rebuild exercise passed."; else echo "Rebuild exercise FAILED."; fi
  exit "$rc"
}
trap finish EXIT

# OpenTofu asks before it applies or destroys; the targets refuse any state
# that holds the pilot, so the answer is always yes here.
destroy_vm() { echo yes | "${M[@]}" rehearsal-destroy; }
create_vm() { echo yes | "${M[@]}" rehearsal-up; }

vm_ip() { "${M[@]}" -s rehearsal-address; }
vm() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "deploy@$(vm_ip)" "$@"; }
psql_vm() { vm "sudo -u postgres psql -q -t -A -d portikus -c \"$1\""; }

# A rebuilt VM has a new host key, and may get an address used before.
forget_old_key() {
  local ip
  ip=$(vm_ip)
  [ -n "$ip" ] || { echo "no rehearsal VM address in the OpenTofu state"; return 1; }
  ssh-keygen -R "$ip" >/dev/null 2>&1 || true
  ssh-keyscan -T 10 "$ip" 2>/dev/null >>"${HOME}/.ssh/known_hosts"
  [ "$(vm hostname)" = "$REHEARSAL_NAME" ] || { echo "${ip} is not ${REHEARSAL_NAME}"; return 1; }
}

build_package() {
  "${M[@]}" build-deb || return
  # build-deb prunes devDependencies, which the users check needs.
  (cd "$ROOT" && pnpm install --frozen-lockfile)
}

new_deb() { echo "${ROOT}/dist/deb/portikus_$(cat "${ROOT}/dist/deb/VERSION")_amd64.deb"; }

carry_over_if_needed() {
  local mock_rows
  mock_rows=$(psql_vm "SELECT count(*) FROM users WHERE oidc_issuer LIKE '%/mock-idp'") || return
  if [ "$mock_rows" = 0 ]; then
    echo "The set was taken after the Dex cutover; no carry-over is needed."
    return 0
  fi
  echo "${mock_rows} accounts are under the mock provider; carrying them over."
  "${M[@]}" identity-carry-over-dry-run || return
  "${M[@]}" configure-vm "PORTIKUS_DEB=$(new_deb)"
}

smoke() {
  PORTIKUS_SMOKE_RESTORED_SET="$SET" "${M[@]}" smoke-test \
    "PORTIKUS_SMOKE_SIGNIN_FILE=${PORTIKUS_SMOKE_SIGNIN_FILE}"
}

# A full Dex password sign-in through Caddy.  The password reaches the VM on
# ssh's standard input only.
signin_status() {
  sed -n 2p "$PORTIKUS_SMOKE_SIGNIN_FILE" | tr -d '\n' \
    | ssh -o BatchMode=yes -o ConnectTimeout=15 "deploy@$(vm_ip)" "
      set -e; umask 077; t=\$(mktemp -d); cat >\"\$t/pw\"
      A='https://${AUTHORITY}'
      C=\"curl -s --cacert /etc/portikus/caddy-root.crt -c \$t/jar -b \$t/jar\"
      form=\$(\$C -L -o /dev/null -w '%{url_effective}' \"\$A/auth/login\")
      \$C -L -o /dev/null --data-urlencode 'login=${signin_email}' --data-urlencode \"password@\$t/pw\" \"\$form\"
      \$C -o /dev/null -w '%{http_code}' \"\$A/auth/me\"
      rm -rf \"\$t\""
}

rollback() {
  "${M[@]}" configure-vm "$PREVIOUS_ARG" || return
  local installed health me
  installed=$(vm "dpkg-query -W -f '\${Version}' portikus") || return
  echo "installed after the rollback: ${installed}"
  [ "$installed" = "$previous_label" ] || { echo "expected ${previous_label}"; return 1; }
  health=$(vm "curl -s --cacert /etc/portikus/caddy-root.crt -o /dev/null -w '%{http_code}' https://${AUTHORITY}/health")
  echo "/health: ${health}"
  me=$(signin_status)
  echo "Dex sign-in, then /auth/me: ${me}"
  [ "$health" = 200 ] && [ "$me" = 200 ]
}

echo "Rebuild exercise on ${REHEARSAL_NAME}, restoring $(basename "$SET"). Logs: ${LOGS}"
step "build the package and reinstall dev dependencies" build_package
step "destroy the old rehearsal VM" destroy_vm
step "create the VM (OpenTofu, cloud-init)" create_vm
step "check the new VM is ${REHEARSAL_NAME}" forget_old_key
step "converge with Ansible (configure-vm)" "${M[@]}" configure-vm "PORTIKUS_DEB=$(new_deb)"
step "build the workspace image" "${M[@]}" build-workspace-image
step "restore the set and start one workspace" "${M[@]}" restore "BACKUP=${SET}" START_CHECK=1
step "carry accounts over to Dex if needed" carry_over_if_needed
step "smoke test with the restored-data checks" smoke
step "roll back to ${previous_label}, /health and sign-in" rollback
