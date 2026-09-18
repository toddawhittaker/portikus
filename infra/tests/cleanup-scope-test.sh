#!/usr/bin/env bash
# Checks that the smoke test's cleanup deletes only what the run recorded.
#
# The smoke test destroys workspaces, and on the pilot the mock accounts
# belong to a real person, so this runs the cleanup function with a stubbed
# ssh_cmd and asserts on the commands it would have sent.  No VM involved.
#
# Usage: ./infra/tests/cleanup-scope-test.sh
# The variables below look unused here: the cleanup function sourced from the
# smoke test reads them.
# shellcheck disable=SC2034
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
smoke="${here}/smoke-test.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The cleanup function sits inside a conditional block, so sourcing the whole
# smoke test would run it against a VM.  Take the marked region instead.
sed -n '/# >>> smoke-cleanup-begin/,/# <<< smoke-cleanup-end/p' "$smoke" \
  >"${work}/cleanup.sh"
if ! grep -q 'cleanup_epic34()' "${work}/cleanup.sh"; then
  echo "cleanup-scope-test: the smoke-cleanup markers no longer bracket cleanup_epic34" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "${work}/cleanup.sh"

log="${work}/commands.log"
WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
WS_PROBE="/tmp/ws-probe"
WS_STOP="/tmp/ws-stop"
TERM_PROBE="/tmp/term-probe"
TERM_STOP="/tmp/term-stop"

# Stubs for everything cleanup_epic34 reaches outside itself.
ssh_cmd() { printf '%s\n' "$*" >>"$log"; }
set_global_grace() { printf 'set_global_grace %s\n' "$*" >>"$log"; }

pass=0
fail=0

ok() {
  printf '\033[1;32mPASS\033[0m  %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf '\033[1;31mFAIL\033[0m  %s\n' "$1"
  fail=$((fail + 1))
}

assert_logged() {
  if grep -qF -- "$2" "$log"; then ok "$1"; else bad "$1"; fi
}
assert_not_logged() {
  if grep -qF -- "$2" "$log"; then bad "$1"; else ok "$1"; fi
}

echo "--- smoke test cleanup scope ---"
echo ""

# Case 1: the run created one workspace, one instance, and one user row.
# A second workspace and two more users exist and must survive.
: >"$log"
created_workspace_ids=("ours-ws-id")
created_instance_names=("ws-ours")
created_user_subjects=("alice")
orig_grace=900
cleanup_epic34 >"${work}/output.txt"

assert_logged "deletes the workspace row it created" \
  "DELETE FROM workspaces WHERE id IN ('ours-ws-id')"
assert_logged "deletes the connection rows of that workspace" \
  "DELETE FROM workspace_connections WHERE workspace_id IN ('ours-ws-id')"
assert_logged "destroys the instance it created" \
  "bash /var/lib/portikus/incus/workspace.sh destroy ws-ours"
assert_logged "deletes only the user row it created" \
  "u.oidc_subject IN ('alice')"
assert_logged "restores the original grace period" "set_global_grace 900"

assert_not_logged "never deletes by workspace owner" "owner_user_id IN ("
assert_not_logged "never deletes every mock user's workspaces" \
  "oidc_subject IN ('alice','bob','carol')"
assert_not_logged "leaves a workspace it did not create" "theirs-ws-id"
assert_not_logged "leaves an instance it did not create" "ws-theirs"

# A user who still owns a workspace is not deleted at all.
assert_logged "keeps a user who still owns a workspace" \
  "NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)"

# The operator sees what is about to go.
if grep -q "Deleting workspace rows: ours-ws-id" "${work}/output.txt" \
  && grep -q "Destroying Incus instances: ws-ours" "${work}/output.txt"; then
  ok "prints what it is about to delete"
else
  bad "prints what it is about to delete"
fi

# Case 2: the run created nothing, so nothing is deleted.
: >"$log"
created_workspace_ids=()
created_instance_names=()
created_user_subjects=()
orig_grace=""
cleanup_epic34 >/dev/null

assert_not_logged "a run that created nothing issues no DELETE" "DELETE FROM"
assert_not_logged "a run that created nothing destroys no instance" "destroy"

# Case 3: several ids are quoted one by one.
: >"$log"
created_workspace_ids=("a-id" "b-id")
created_instance_names=()
created_user_subjects=()
cleanup_epic34 >/dev/null
assert_logged "quotes each recorded id in the IN clause" \
  "DELETE FROM workspaces WHERE id IN ('a-id','b-id')"

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
