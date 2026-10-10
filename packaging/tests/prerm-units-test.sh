#!/usr/bin/env bash
# Checks that prerm stops every unit the package ships and disables every
# path, timer and socket, so apt remove leaves no unit running or watching
# and no link dangling (docs/SPEC.md section 21.12).
# Usage: packaging/tests/prerm-units-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prerm="$root/scripts/prerm"
failures=0

# The words of one multi-line `systemctl <verb> ... || true` command in prerm.
command_words() {
	sed -n "/systemctl $1 /,/|| true/p" "$prerm" | tr -d "\\\\" | tr -s '[:space:]' '\n'
}
stopped=$(command_words stop)
disabled=$(command_words disable)

for path in "$root"/systemd/portikus-*; do
	unit=$(basename "$path")
	case "$unit" in
	*@.service) pattern="'${unit%.service}*.service'" ;;
	*) pattern="$unit" ;;
	esac
	grep -qxF -- "$pattern" <<<"$stopped" || {
		echo "prerm-units: prerm does not stop $unit" >&2
		failures=$((failures + 1))
	}
	case "$unit" in
	*.path | *.timer | *.socket)
		grep -qxF -- "$unit" <<<"$disabled" || {
			echo "prerm-units: prerm does not disable $unit" >&2
			failures=$((failures + 1))
		}
		;;
	esac
done

[ "$failures" -eq 0 ] || exit 1
echo "prerm-units: ok"
