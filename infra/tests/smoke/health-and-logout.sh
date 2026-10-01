#!/usr/bin/env bash
# The Health series, then alice signs out.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 17b. The Health series has the controller's host rates once the worker
#      has taken two samples a minute apart (SPEC.md 25.6).
series_has_rates() {
  vm_get carol "${API}/admin/health/series?range=1h" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["platform"]
keys = ("cpuPercent", "netRxBytesPerSecond", "netTxBytesPerSecond", "diskReadBytesPerSecond", "diskWriteBytesPerSecond")
sys.exit(0 if any(all(r.get(k) is not None for k in keys) for r in rows) else 1)
' 2>/dev/null
}
wait_series_rates() {
  for _ in $(seq 1 30); do
    series_has_rates && return 0
    sleep 5
  done
  return 1
}
check "the Health series has host rates after two samples" wait_series_rates
check_output "a student is refused the Health series" "403" \
  http_status bob "${API}/admin/health/series?range=1h"

# 18. Logging out ends the session.
echo ""
echo "Logging alice out..."
http_status alice "${API}/auth/logout" "-X POST -H 'Origin: ${API}'" >/dev/null
check_output "/auth/me is 401 after logout" "401" http_status alice "${API}/auth/me"

echo ""
echo "--- Control plane results: $((pass - control_pass_start)) passed, $((fail - control_fail_start)) failed ---"
