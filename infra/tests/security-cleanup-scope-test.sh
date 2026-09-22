#!/usr/bin/env bash
# Checks that the VM security suite's cleanup deletes only what the run
# recorded, and only rows owned by its own sectest users.
#
# The suite runs on the live pilot next to real student workspaces, so this
# runs sec_cleanup and sec_sweep from infra/tests/security/lib.sh with ssh
# stubbed out and asserts on the commands they would have sent.  No VM.
#
# Usage: ./infra/tests/security-cleanup-scope-test.sh
# shellcheck disable=SC2034  # the recorded arrays are read by lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
# shellcheck source=/dev/null
. "${here}/security/lib.sh"

log="${work}/commands.log"
count_reply=0

# Stubs for everything that would reach the VM.  SQL arrives on stdin.
sec_ssh() { printf 'ssh %s\n' "$*" >>"$log"; }
sec_ssh_stdin() {
  local sql
  sql=$(cat)
  printf 'sql %s\n' "$sql" >>"$log"
  case "$sql" in *"SELECT count(*)"*) echo "$count_reply" ;; esac
}

SEC_REMOTE_DIR="/tmp/portikus-sectest-0922120000"
ours_ws="11111111-1111-1111-1111-111111111111"
ours_instance="ws-111111111111111111111111"
theirs_ws="22222222-2222-2222-2222-222222222222"
theirs_instance="ws-222222222222222222222222"

pass=0
fail=0
ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
assert_logged() { if grep -qF -- "$2" "$log"; then ok "$1"; else bad "$1"; fi; }
assert_not_logged() { if grep -qF -- "$2" "$log"; then bad "$1"; else ok "$1"; fi; }
# Every line matching PATTERN also carries the sectest issuer guard.
assert_guarded() {
  local lines
  lines=$(grep -F -- "$2" "$log")
  if [ -n "$lines" ] && ! printf '%s\n' "$lines" | grep -vqF "oidc_issuer = 'urn:portikus:sectest'"; then
    ok "$1"
  else
    bad "$1"
  fi
}

reset() {
  : >"$log"
  sec_created_subjects=()
  sec_created_workspace_ids=()
  sec_created_instances=()
  sec_presence_pids=()
  count_reply=0
}

echo "--- security suite cleanup scope ---"
echo ""

# Case 1: the run made one workspace, its instance, and three users.
reset
sec_created_subjects=("sectest-0922120000-a" "sectest-0922120000-b" "sectest-0922120000-admin")
sec_created_workspace_ids=("$ours_ws")
sec_created_instances=("$ours_instance")
sec_cleanup >"${work}/out.txt"

assert_logged "deletes the workspace row it recorded" "DELETE FROM workspaces WHERE id IN ('${ours_ws}')"
assert_guarded "every workspace delete is limited to sectest owners" "DELETE FROM workspaces"
assert_guarded "every connection delete is limited to sectest owners" "DELETE FROM workspace_connections"
assert_guarded "every audit delete is limited to sectest rows" "DELETE FROM audit_events"
assert_guarded "every user delete is limited to the sectest issuer" "DELETE FROM users"
assert_logged "deletes only the users it recorded" \
  "oidc_subject IN ('sectest-0922120000-a','sectest-0922120000-b','sectest-0922120000-admin')"
assert_logged "keeps a user who still owns a workspace" \
  "NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)"
assert_logged "checks no row names the instance before destroying it" \
  "SELECT count(*) FROM workspaces WHERE incus_instance_name = '${ours_instance}'"
assert_logged "destroys the instance it recorded" "workspace.sh destroy ${ours_instance}"
assert_logged "removes its own remote directory" "rm -rf /tmp/portikus-sectest-0922120000"
assert_not_logged "leaves a workspace it did not record" "$theirs_ws"
assert_not_logged "leaves an instance it did not record" "$theirs_instance"
assert_not_logged "never names a mock account" "'alice'"
assert_not_logged "never deletes by owner alone" "owner_user_id IN ('"
assert_not_logged "never changes a setting" "settings"
if grep -q "Deleting workspace rows: ${ours_ws}" "${work}/out.txt"; then
  ok "prints what it is about to delete"
else
  bad "prints what it is about to delete"
fi

# Case 2: nothing recorded, nothing deleted.
reset
sec_cleanup >/dev/null
assert_not_logged "a run that recorded nothing deletes nothing" "DELETE"
assert_not_logged "a run that recorded nothing destroys nothing" "destroy"

# Case 3: an instance another row still names is not destroyed.
reset
sec_created_instances=("$ours_instance")
count_reply=1
sec_cleanup >/dev/null
assert_not_logged "an instance still named by a row survives" "destroy ${ours_instance}"

# Case 4: a recorded name that is not a workspace instance is not destroyed.
reset
sec_created_instances=("portikus-api")
sec_cleanup >/dev/null
assert_not_logged "a name that is not ws-<hex> is never destroyed" "destroy"

# Case 5: a remote directory outside the pattern is not removed.
reset
SEC_REMOTE_DIR="/tmp"
sec_cleanup >/dev/null
assert_not_logged "a remote directory outside the pattern is not removed" "rm -rf"
SEC_REMOTE_DIR="/tmp/portikus-sectest-0922120000"

# Case 6: the sweep takes only sectest subjects from the leftover list.
reset
sec_sweep "sectest-0921000000-a ${ours_ws} ${ours_instance}
alice ${theirs_ws} ${theirs_instance}" >/dev/null
assert_logged "the sweep removes a leftover sectest workspace" "DELETE FROM workspaces WHERE id IN ('${ours_ws}')"
assert_logged "the sweep destroys a leftover sectest instance" "destroy ${ours_instance}"
assert_not_logged "the sweep skips a subject that is not sectest" "$theirs_ws"
assert_not_logged "the sweep never destroys a non-sectest instance" "$theirs_instance"

# Case 7: the leftover query itself only looks under the sectest issuer.
if grep -F "LIKE 'sectest-%'" "${here}/security/lib.sh" | grep -qF "u.oidc_issuer = '\${SEC_ISSUER}'"; then
  ok "the leftover query is limited to the sectest issuer"
else
  bad "the leftover query is limited to the sectest issuer"
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
