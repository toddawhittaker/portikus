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
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# shellcheck source=/dev/null
. "${here}/smoke/cleanup.sh"

log="${work}/commands.log"
WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
WS_PROBE="/tmp/ws-probe"
WS_STOP="/tmp/ws-stop"
TERM_PROBE="/tmp/term-probe"
TERM_STOP="/tmp/term-stop"

# Stubs for everything cleanup_lifecycle reaches outside itself.
ssh_cmd() { printf '%s\n' "$*" >>"$log"; }
set_global_grace() { printf 'set_global_grace %s\n' "$*" >>"$log"; }

# shellcheck source=/dev/null
. "${here}/lib.sh"

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
cleanup_lifecycle >"${work}/output.txt"

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
cleanup_lifecycle >/dev/null

assert_not_logged "a run that created nothing issues no DELETE" "DELETE FROM"
assert_not_logged "a run that created nothing destroys no instance" "destroy"

# Case 3: several ids are quoted one by one.
: >"$log"
created_workspace_ids=("a-id" "b-id")
created_instance_names=()
created_user_subjects=()
cleanup_lifecycle >/dev/null
assert_logged "quotes each recorded id in the IN clause" \
  "DELETE FROM workspaces WHERE id IN ('a-id','b-id')"

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
