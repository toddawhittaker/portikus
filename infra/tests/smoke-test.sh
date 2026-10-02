#!/usr/bin/env bash
# Smoke test for a Portikus VM (STACK.md section 13, "Infrastructure smoke
# tests").
#
# Run this after an install or a deploy.  It connects to the platform VM
# over SSH and checks each subsystem, one file per area under smoke/.
# Every probe records PASS or FAIL and the run continues to the end.
#
# Usage: ./infra/tests/smoke-test.sh <vm-ip>
# Environment:
#   PORTIKUS_SMOKE_SIGNIN_FILE  a file of mode 0600 holding a test
#                               user's email and password on two lines; the
#                               run then does a full password sign-in.
#   PORTIKUS_PUBLIC_HOST, PORTIKUS_PUBLIC_PORT as the VM was configured.
#   PORTIKUS_SMOKE_RESTORED_SET a backup set just restored onto this VM (the
#                               rebuild exercise sets it).  Adds the
#                               restored-data and Incus script checks, and
#                               lets the lifecycle block run beside the
#                               restored workspaces.  Refused on the pilot.
#   PORTIKUS_BACKUP_IDENTITY    the age key that opens that set
#                               (default ~/.config/portikus/backup-age-key.txt).
#   PORTIKUS_SSH_USER           the account to SSH in as (default deploy).  It
#                               needs passwordless sudo and the incus-admin
#                               group (the play's portikus_operator_user).
#
# When the VM has a mock LMS registration (make lti-mock-register), the LTI
# block launches through it, and starts it on this host first if it is not
# already running (ADR 0025).
# shellcheck disable=SC2034  # the sourced files read these globals
# shellcheck disable=SC1090,SC1091  # the sourced files are checked on their own
# shellcheck disable=SC2154  # pass, fail and run_lifecycle are set by the sourced files
set -uo pipefail

VM="${1:?Usage: smoke-test.sh <vm-ip>}"
SSH_USER="${PORTIKUS_SSH_USER:-deploy}"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The password is read into this shell only.  It reaches the VM on an ssh
# standard input, never in a command line.
SIGNIN_EMAIL=""
SIGNIN_PASSWORD=""
if [ -n "${PORTIKUS_SMOKE_SIGNIN_FILE:-}" ]; then
  if [ "$(stat -c %a "$PORTIKUS_SMOKE_SIGNIN_FILE" 2>/dev/null)" != "600" ]; then
    echo "smoke-test: ${PORTIKUS_SMOKE_SIGNIN_FILE} must exist with mode 0600" >&2
    exit 2
  fi
  { IFS= read -r SIGNIN_EMAIL; IFS= read -r SIGNIN_PASSWORD; } <"$PORTIKUS_SMOKE_SIGNIN_FILE"
  if [ -z "$SIGNIN_EMAIL" ] || [ -z "$SIGNIN_PASSWORD" ]; then
    echo "smoke-test: ${PORTIKUS_SMOKE_SIGNIN_FILE} must hold an email and a password on two lines" >&2
    exit 2
  fi
fi

RESTORED_SET="${PORTIKUS_SMOKE_RESTORED_SET:-}"
BACKUP_IDENTITY="${PORTIKUS_BACKUP_IDENTITY:-${HOME}/.config/portikus/backup-age-key.txt}"
if [ -n "$RESTORED_SET" ] && [ ! -f "${RESTORED_SET}/MANIFEST.age" ]; then
  echo "smoke-test: ${RESTORED_SET} is not a backup set (no MANIFEST.age)" >&2
  exit 2
fi

. "${TESTS_DIR}/lib.sh"
. "${TESTS_DIR}/smoke/helpers.sh"

echo "--- Portikus pilot smoke test ---"
echo "Target: ${VM}"
echo ""

# The restored-data run also lets the lifecycle block work beside other
# people's workspaces, which is only safe on a copy, never on the pilot.
if [ -n "$RESTORED_SET" ]; then
  vm_hostname=$(ssh_cmd hostname 2>/dev/null || true)
  if [ -z "$vm_hostname" ] || [ "$vm_hostname" = portikus ]; then
    echo "smoke-test: PORTIKUS_SMOKE_RESTORED_SET is for a rehearsal copy; ${VM} is '${vm_hostname:-unreachable}'" >&2
    exit 2
  fi
fi

# One trap for the whole run: the control plane checks' cleanup when they
# ran, the smoke-ws workspace when it was made, and the copied Incus script.
cleanup_all() {
  if declare -F cleanup_lifecycle >/dev/null; then
    cleanup_lifecycle
  fi
  if [ -n "${WS_NAME:-}" ]; then
    echo ""
    echo "Destroying ${WS_NAME}..."
    ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
  fi
  ssh_cmd rm -f /tmp/portikus-smoke-workspace.sh >/dev/null 2>&1 || true
}
trap cleanup_all EXIT

. "${TESTS_DIR}/smoke/host.sh"
. "${TESTS_DIR}/smoke/registry-cache.sh"
. "${TESTS_DIR}/smoke/workspace-image.sh"
. "${TESTS_DIR}/smoke/restored-data.sh"
. "${TESTS_DIR}/smoke/site.sh"
. "${TESTS_DIR}/smoke/preview-edge.sh"
. "${TESTS_DIR}/smoke/egress-proxy.sh"
. "${TESTS_DIR}/smoke/workspace-egress.sh"
. "${TESTS_DIR}/smoke/resilience.sh"

if ! ssh_cmd systemctl is-active portikus-api >/dev/null 2>&1; then
  echo "portikus-api not active; skipping the control plane checks."
  if [ -n "$RESTORED_SET" ]; then
    bad "the lifecycle checks were skipped on the restored VM (portikus-api is not active)"
  fi
else
  . "${TESTS_DIR}/smoke/sign-in.sh"
  . "${TESTS_DIR}/smoke/lti.sh"
  . "${TESTS_DIR}/smoke/control-plane.sh"
  if [ "$run_lifecycle" = yes ]; then
    . "${TESTS_DIR}/smoke/lifecycle.sh"
    . "${TESTS_DIR}/smoke/terminals.sh"
    . "${TESTS_DIR}/smoke/projects.sh"
    . "${TESTS_DIR}/smoke/recovery.sh"
    . "${TESTS_DIR}/smoke/boundaries.sh"
  fi
  . "${TESTS_DIR}/smoke/health-and-logout.sh"
fi

. "${TESTS_DIR}/smoke/workspace-agent.sh"

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
