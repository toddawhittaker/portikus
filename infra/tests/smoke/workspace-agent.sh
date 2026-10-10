#!/usr/bin/env bash
# The workspace agent in smoke-ws.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# Static checks only: the unit runs inside the container, the tree the
# workspace profile bind-mounts is there and not writable by the
# student, and the agent turns away a request that carries no token.
# The terminal flow is checked elsewhere.
#
# These reuse the workspace workspace-image.sh created, so they are
# skipped whenever that block did not run.
if [ -n "${WS_NAME:-}" ]; then
  echo ""
  echo "--- Workspace agent ---"
  echo ""

  check "workspace agent unit is active" \
    ws_exec systemctl is-active portikus-workspace-agent
  check "workspace agent runs as the student user" \
    ws_exec "systemctl show portikus-workspace-agent -p User | grep -qx User=student"
  check "agent start script is present" \
    ws_exec test -x /opt/portikus/workspace-agent/bin/workspace-agent
  check "agent tree is not writable by student" \
    ws_student "! test -w /opt/portikus/workspace-agent/bin/workspace-agent"

  # The shared Claude Code and Codex folder (SPEC.md section 10) is
  # read-only for everyone in the workspace, container root included, and
  # nothing in it on the server is writable by others or setuid.
  check "student cannot write the coding-agents folder" \
    ws_student "! touch /opt/portikus/coding-agents/.smoke 2>/dev/null"
  check "container root cannot write the coding-agents folder" \
    ws_exec "! touch /opt/portikus/coding-agents/.smoke 2>/dev/null"
  check "container root cannot remount the coding-agents folder read-write" \
    ws_exec "! mount -o remount,rw /opt/portikus/coding-agents 2>/dev/null && findmnt -n -o OPTIONS /opt/portikus/coding-agents | grep -q '^ro,'"
  check "the server's coding-agents folder exists" \
    ssh_cmd "test -d /var/lib/portikus/coding-agents/bin"
  check_zero_lines "nothing in the server's coding-agents folder is group- or world-writable" \
    ssh_cmd "sudo find /var/lib/portikus/coding-agents ! -type l -perm /022 || echo find-failed"
  check_zero_lines "nothing in the server's coding-agents folder is setuid or setgid" \
    ssh_cmd "sudo find /var/lib/portikus/coding-agents -perm /6000 || echo find-failed"

  # The API dials the agent over the workspace bridge, so probe the same way.
  ws_ip=$(workspace_ip "${WS_NAME}")
  if [ -n "$ws_ip" ]; then
    check_output "agent /health without a token is 401" "401" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${ws_ip}:7400/health"
  else
    bad "workspace has no bridge address"
  fi
else
  echo "No smoke-ws workspace; skipping the workspace agent checks."
fi
