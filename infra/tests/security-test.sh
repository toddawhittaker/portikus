#!/usr/bin/env bash
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# VM security suite (Epic 12a; SPEC.md sections 23, 24 and 30 Gate C).
#
# Safe to run on the live pilot.  It makes its own users in PostgreSQL and
# two workspaces through the API, probes only those, and removes only them.
# Before and after, it snapshots every other workspace and the settings; any
# difference fails the run.  See infra/README.md, "Security test".
#
# Usage: ./infra/tests/security-test.sh <vm-ip> [--sweep]
#   --sweep  also remove sectest users and workspaces an earlier run left.
# Environment: PORTIKUS_PUBLIC_HOST, PORTIKUS_PUBLIC_PORT as for the smoke
# test; PORTIKUS_IDP as the VM was configured (dex, mock or external);
# PORTIKUS_SECURITY_HEAVY=1 turns on the heavy limit tests, which need
# a VM with no other workspace.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${here}/security/lib.sh"

sec_init "$@"
if ! sec_preflight; then
  rm -rf "$SEC_LOCAL_DIR"
  exit 1
fi

snapshot_before="${SEC_LOCAL_DIR}/before"
snapshot_after="${SEC_LOCAL_DIR}/after"
sec_snapshot_others >"$snapshot_before"
# The fingerprint lets two runs be compared without keeping the snapshot.
echo "Snapshot of everything else: $(wc -l <"$snapshot_before") line(s), fingerprint $(sha256sum <"$snapshot_before" | cut -c1-16)."

finish() {
  trap - EXIT INT TERM
  sec_cleanup
  echo ""
  sec_snapshot_others >"$snapshot_after"
  if diff -u "$snapshot_before" "$snapshot_after"; then
    sec_pass "every other workspace, user and setting is unchanged"
  else
    sec_fail "every other workspace, user and setting is unchanged (diff above)"
  fi
  local left
  left=$(sec_psql "SELECT count(*) FROM users WHERE oidc_issuer = '${SEC_ISSUER}' AND oidc_subject LIKE 'sectest-${SEC_RUN_ID}-%'")
  check_output "no user row of this run is left" "0" echo "$left"
  left=$(sec_ssh "incus list --project ${SEC_PROJECT} -c n --format csv" | grep -xF -f <(printf '%s\n' "${sec_created_instances[@]:-none}") | paste -sd' ')
  check_output "no instance of this run is left" "" echo "$left"
  left=$(sec_ssh "ls -d ${SEC_REMOTE_DIR} ${SEC_REMOTE_VARDIR} 2>/dev/null; true" | paste -sd' ')
  check_output "no directory of this run is left on the VM" "" echo "$left"
  sec_summary
  echo "Run took $(($(date +%s) - SEC_START_EPOCH)) s."
  rm -rf "$SEC_LOCAL_DIR"
  if [ "$fail" -eq 0 ]; then exit 0; else exit 1; fi
}
trap finish EXIT
trap 'exit 130' INT TERM

echo ""
echo "--- Setting up this run's users and workspaces ---"
sec_mint_user a student || exit 1
sec_mint_user b student || exit 1
sec_mint_user admin administrator || exit 1
sec_create_workspace a || exit 1
sec_create_workspace b || exit 1
sec_hold_presence a || exit 1
sec_hold_presence b || exit 1

# Controls: the helpers can succeed, so a refusal the modules see means something.
check_output "a reads its own workspace through the edge (control)" "200" \
  sec_http a GET "/workspaces/$(sec_ws_id a)"
check_output "a opens its own presence socket through the edge (control)" "101" \
  sec_ws_upgrade a "/workspaces/$(sec_ws_id a)/ws" "$SEC_API"

# With the mock provider on, anyone who reaches the site can sign in as an
# administrator (issue #408).  That is allowed only where the operator says
# so with PORTIKUS_IDP=mock, and then it is a warning; otherwise the mock must
# be off and the API must not trust it.
sec_check_idp

# Modules run in this order; one that is not there yet is skipped.  The
# network module goes last because it briefly claims b's address from a.
for module in cross-user container preview-edge lti limits network; do
  if [ -f "${here}/security/${module}.sh" ]; then
    # shellcheck source=/dev/null
    . "${here}/security/${module}.sh"
  fi
done
