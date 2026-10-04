#!/usr/bin/env bash
# SSH to the VM and the smoke test's own checks; ok, bad, check and
# check_output come from infra/tests/lib.sh.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh

# -n keeps the remote command away from this script's standard input. Without
# it, ssh forwards our terminal as a pipe that never ends, and a remote incus
# command waits forever for a YAML config on it.
ssh_cmd() {
  ssh -n "${ssh_mux_opts[@]}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "${SSH_USER}@${VM}" "$@"
}

# Same connection, but for the two places that deliberately feed the remote
# command on standard input.
ssh_cmd_stdin() {
  ssh "${ssh_mux_opts[@]}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "${SSH_USER}@${VM}" "$@"
}

# check_gt LABEL THRESHOLD CMD [ARGS...]
# Captures a numeric value from CMD and checks that it is greater than THRESHOLD.
check_gt() {
  local label="$1" threshold="$2"; shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  actual="${actual:-0}"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then
    ok "$label"
  else
    bad "$label (got: ${actual})"
  fi
}

# check_zero_lines LABEL CMD [ARGS...]
# Passes when CMD produces zero lines of output.
check_zero_lines() {
  local label="$1"; shift
  local count
  count=$("$@" 2>/dev/null | wc -l) || true
  if [ "${count:-1}" -eq 0 ] 2>/dev/null; then
    ok "$label"
  else
    bad "$label (${count} lines)"
  fi
}

# workspace_ip INSTANCE — the address on the workspace bridge.  A running
# workspace also holds a docker0 address, so pick the bridge NIC by name.
# Callers have set PROJECT.
workspace_ip() {
  ssh_cmd "incus list $1 --project ${PROJECT} -c4 --format csv" \
    | tr -d '"' | awk '/eth0/ { print $1; exit }'
}
