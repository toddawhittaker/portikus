#!/usr/bin/env bash
# The control plane checks' cleanup.  Defines functions and nothing else, so
# infra/tests/cleanup-scope-test.sh can load it with a stubbed ssh_cmd.
# shellcheck disable=SC2154  # set by smoke-test.sh and control-plane.sh

# sql_in_list ITEM... prints 'a','b' for an SQL IN clause.
sql_in_list() {
  local out="" item
  for item in "$@"; do
    out="${out}${out:+,}'${item}'"
  done
  printf '%s' "$out"
}

# Waits up to two minutes for the worker to finish any start or stop of these
# workspaces.  Mid-stop, Incus can fail to report the instance at all, and
# the destroy would then skip it and leave it behind.
wait_for_settled_workspaces() {
  local ws_list=$1 busy waited=0
  while :; do
    busy=$(ssh_cmd "sudo -u postgres psql -d portikus -Atc \"SELECT count(*) FROM workspaces WHERE id IN (${ws_list}) AND (state IN ('provisioning', 'starting', 'stopping') OR (desired_state = 'stopped' AND state = 'running'))\"" 2>/dev/null)
    case "$busy" in
      0) return 0 ;;
      '' | *[!0-9]*)
        echo "Could not read the workspaces' state; destroying without waiting."
        return 0
        ;;
    esac
    if [ "$waited" -ge 120 ]; then
      echo "The workspaces were still starting or stopping after ${waited} s; destroying anyway."
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# Only what this run recorded is deleted; the VM may hold real accounts.
# Fails when an instance it created could not be destroyed.
cleanup_lifecycle() {
  echo ""
  echo "Cleaning up the control plane smoke resources..."
  # Put the administrator's grace period back while carol can still sign in.
  if [ -n "${orig_grace:-}" ]; then
    set_global_grace "${orig_grace}" >/dev/null 2>&1 || true
  fi

  local ws_count=${#created_workspace_ids[@]}
  local user_count=${#created_user_subjects[@]}
  local instance_count=${#created_instance_names[@]}
  echo "This run created ${ws_count} workspace row(s), ${instance_count} Incus instance(s) and ${user_count} user row(s). Nothing else is deleted."

  if [ "$ws_count" -gt 0 ]; then
    local ws_list
    ws_list=$(sql_in_list "${created_workspace_ids[@]}")
    wait_for_settled_workspaces "$ws_list"
    echo "Deleting workspace rows: ${created_workspace_ids[*]}"
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspace_connections WHERE workspace_id IN (${ws_list})\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM audit_events WHERE target IN (${ws_list})\"" 2>/dev/null || true
    # Archiving a project audits against the project id, which no longer
    # resolves once the workspace cascade removes the project row.
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM audit_events WHERE target IN (SELECT id::text FROM projects WHERE workspace_id IN (${ws_list}))\"" 2>/dev/null || true
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspaces WHERE id IN (${ws_list})\"" 2>/dev/null || true
  fi

  if [ "$user_count" -gt 0 ]; then
    local user_list
    user_list=$(sql_in_list "${created_user_subjects[@]}")
    echo "Deleting user rows this run created: ${created_user_subjects[*]}"
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE oidc_subject IN (${user_list}))\"" 2>/dev/null || true
    # A user who still owns a workspace stays: that workspace is not ours.
    ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM users u WHERE u.oidc_subject IN (${user_list}) AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)\"" 2>/dev/null || true
  fi

  local left=()
  if [ "$instance_count" -gt 0 ]; then
    echo "Destroying Incus instances: ${created_instance_names[*]}"
    local instance
    for instance in "${created_instance_names[@]}"; do
      ssh_cmd "bash ${WORKSPACE_SCRIPT} destroy ${instance}" || left+=("$instance")
    done
  fi

  ssh_cmd "rm -f /tmp/portikus-smoke-*.jar /tmp/portikus-smoke-project.* ${WS_PROBE} ${WS_STOP} ${TERM_PROBE} ${TERM_STOP}" 2>/dev/null || true

  if [ "${#left[@]}" -gt 0 ]; then
    echo "Cleanup failed: the destroy reported an error, so these instances or their volumes may be left behind: ${left[*]}"
    return 1
  fi
}
