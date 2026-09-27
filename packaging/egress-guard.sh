#!/bin/sh
# Runs after every egress helper run (ExecStopPost, ADR 0038), without Node.
# If the helper died before loading any table (a crash, a failed import,
# the memory cap, the start timeout), the missing table would leave the last
# allow-list open.  Then drop all workspace forwarding, unless applied.json
# is absent (a site that never applied a policy) or plainly records open mode.
# The arguments exist for the tests.
set -u
applied=${1:-/var/lib/portikus/egress-state/applied.json}
drop_all=${2:-/etc/portikus/egress-drop-all.nft}

nft list table inet portikus_egress >/dev/null 2>&1 && exit 0
[ -e "$applied" ] || [ -L "$applied" ] || exit 0

# The helper writes one line of JSON, and no value it holds can contain a
# quote, so open mode reads as exactly one "mode" key whose value is "open".
# Anything else, including a file that cannot be read, fails closed.
if [ -f "$applied" ] && [ -r "$applied" ] &&
  [ "$(wc -l <"$applied")" -eq 1 ] &&
  grep -q '^{.*}$' "$applied" &&
  [ "$(grep -o '"mode":' "$applied" | wc -l)" -eq 1 ] &&
  grep -q '"mode":"open"[,}]' "$applied"; then
  exit 0
fi
echo "egress helper left no table after an allow-list; dropping workspace forwarding" >&2
exec nft -f "$drop_all"
