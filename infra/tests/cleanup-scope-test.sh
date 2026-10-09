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

# Stubs for everything cleanup_lifecycle reaches outside itself.  The
# settle query answers "busy" as many times as stub_busy_file holds lines,
# then 0; a destroy of stub_failing_instance fails.  A file, because the
# query runs in a subshell.
stub_busy_file="${work}/busy"
: >"$stub_busy_file"
stub_failing_instance=""
ssh_cmd() {
  printf '%s\n' "$*" >>"$log"
  case "$*" in
    *"SELECT count(*) FROM workspaces"*)
      if [ -s "$stub_busy_file" ]; then
        sed -i 1d "$stub_busy_file"
        echo 1
      else
        echo 0
      fi
      ;;
    *"destroy ${stub_failing_instance:-no-such-instance}") return 1 ;;
  esac
}
sleep() { printf 'sleep %s\n' "$*" >>"$log"; }
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

# Case 4: a stop still under way is waited out before the rows and the
# instance go, so Incus can report the instance to the destroy.
: >"$log"
created_workspace_ids=("ours-ws-id")
created_instance_names=("ws-ours")
created_user_subjects=()
printf 'busy\nbusy\n' >"$stub_busy_file"
cleanup_lifecycle >/dev/null
settle_line=$(grep -nF "SELECT count(*) FROM workspaces" "$log" | tail -1 | cut -d: -f1)
delete_line=$(grep -nF "DELETE FROM workspaces" "$log" | cut -d: -f1)
destroy_line=$(grep -nF "destroy ws-ours" "$log" | cut -d: -f1)
if [ "$(grep -cF "SELECT count(*) FROM workspaces" "$log")" -eq 3 ] \
  && [ "${settle_line:-0}" -lt "${delete_line:-0}" ] && [ "${delete_line:-0}" -lt "${destroy_line:-0}" ]; then
  ok "waits for the workspace to settle before deleting its row and destroying it"
else
  bad "waits for the workspace to settle before deleting its row and destroying it"
fi
assert_logged "a running workspace asked to stop counts as unsettled" \
  "desired_state = 'stopped' AND state = 'running'"

# Case 5: a failed destroy fails the cleanup and names what was left.
: >"$log"
created_workspace_ids=()
created_instance_names=("ws-ours" "ws-second")
stub_failing_instance="ws-ours"
if cleanup_lifecycle >"${work}/output.txt" 2>&1; then
  bad "a failed destroy fails the cleanup"
else
  ok "a failed destroy fails the cleanup"
fi
assert_logged "a failed destroy does not stop the next one" "destroy ws-second"
if grep -q "left behind: ws-ours\$" "${work}/output.txt"; then
  ok "names the instance left behind"
else
  bad "names the instance left behind"
fi
stub_failing_instance=""

# Case 6: a clean destroy succeeds.
: >"$log"
created_instance_names=("ws-ours")
if cleanup_lifecycle >/dev/null 2>&1; then
  ok "a clean destroy leaves the cleanup successful"
else
  bad "a clean destroy leaves the cleanup successful"
fi

# ── workspace.sh destroy, with a fake incus ──────────────────────

# The destroy the cleanup calls must fail when Incus cannot list instances
# or volumes, never read that as "nothing there" and leave something behind.
# FAKE_INCUS_FAIL names the listing that fails: instances or volumes.
fake_bin="${work}/bin"
mkdir -p "$fake_bin"
cat >"${fake_bin}/incus" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_INCUS_LOG"
if [ "$1" = query ]; then
  case "$2" in
    /1.0/instances\?*)
      [ "${FAKE_INCUS_FAIL:-}" = instances ] && exit 1
      printf '[\n\t"/1.0/instances/ws-ours?project=portikus"\n]\n'
      ;;
    /1.0/storage-pools/*)
      [ "${FAKE_INCUS_FAIL:-}" = volumes ] && exit 1
      printf '[\n\t"/1.0/storage-pools/workspace-data/volumes/custom/ws-ours-home?project=portikus",\n\t"/1.0/storage-pools/workspace-data/volumes/custom/ws-ours-docker?project=portikus"\n]\n'
      ;;
  esac
fi
EOF
chmod +x "${fake_bin}/incus"
incus_log="${work}/incus.log"

# destroy_with FAIL -- runs the destroy against the fake; returns its status.
destroy_with() {
  : >"$incus_log"
  PATH="${fake_bin}:${PATH}" FAKE_INCUS_LOG="$incus_log" FAKE_INCUS_FAIL="$1" \
    bash "${here}/../incus/workspace.sh" destroy ws-ours >"${work}/destroy.txt" 2>&1
}

if destroy_with ""; then ok "destroy succeeds when Incus answers"; else bad "destroy succeeds when Incus answers"; fi
if grep -qx "delete --force ws-ours --project portikus" "$incus_log" \
  && grep -qx "storage volume delete workspace-data ws-ours-home --project portikus" "$incus_log" \
  && grep -qx "storage volume delete workspace-data ws-ours-docker --project portikus" "$incus_log" \
  && ! grep -q "ws-ours-recovery --project" "$incus_log"; then
  ok "destroy deletes the instance and the listed volumes, and skips the unlisted one"
else
  bad "destroy deletes the instance and the listed volumes, and skips the unlisted one"
fi

if destroy_with instances; then
  bad "a failed instance listing fails the destroy"
else
  ok "a failed instance listing fails the destroy"
fi
if grep -q "does not exist" "${work}/destroy.txt"; then
  bad "a failed instance listing is not read as a missing instance"
else
  ok "a failed instance listing is not read as a missing instance"
fi

if destroy_with volumes; then
  bad "a failed volume listing fails the destroy"
else
  ok "a failed volume listing fails the destroy"
fi
if grep -q "volume .* does not exist" "${work}/destroy.txt"; then
  bad "a failed volume listing is not read as a missing volume"
else
  ok "a failed volume listing is not read as a missing volume"
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
