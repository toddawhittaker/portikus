#!/usr/bin/env bash
# Checks that postinst makes the shared coding-agents folder's bin links
# before it restarts any service, so a workspace that starts while setup is
# still downloading the tools gets its claude and codex links (SPEC.md
# section 10.1).
# Usage: packaging/tests/agents-links-order-test.sh [POSTINST]
set -euo pipefail

postinst="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/postinst}"

links=$(grep -n '"\$IMAGE_JOB" agents-links' "$postinst" | head -1 | cut -d: -f1 || true)
restart=$(grep -nE 'systemctl (try-)?restart' "$postinst" | head -1 | cut -d: -f1 || true)
[ -n "$links" ] || { echo "agents-links-order: postinst never runs image-job agents-links" >&2; exit 1; }
[ -n "$restart" ] || { echo "agents-links-order: postinst restarts no service" >&2; exit 1; }
[ "$links" -lt "$restart" ] || {
	echo "agents-links-order: postinst restarts a service (line $restart) before it makes the links (line $links)" >&2
	exit 1
}
echo "agents-links-order: ok"
