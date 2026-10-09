#!/usr/bin/env bash
# Checks that the package enables its services on a first install and on a
# reinstall after apt remove, and leaves them alone on an upgrade, so an
# administrator's systemctl disable holds (docs/SPEC.md section 21.12).
# Runs the real preinst and postinst's enable_units with a fake systemctl.
# Usage: packaging/tests/enable-units-test.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="$repo_root/packaging/scripts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

fail() {
	echo "enable-units: $1" >&2
	failures=$((failures + 1))
}

mark=$(sed -n 's/^REINSTALL_MARK=//p' "$scripts/postinst")
[ "$mark" = "$(sed -n 's/^REINSTALL_MARK=//p' "$scripts/preinst")" ] \
	|| fail "preinst and postinst name different marks"
local_mark="$work/state/${mark##*/}"
sed "s|$mark|$local_mark|" "$scripts/preinst" >"$work/preinst"

# postinst's unit list, mark and enable_units, lifted out, with systemctl logging its calls.
{
	sed -n '/^UNITS=/p' "$scripts/postinst"
	echo "REINSTALL_MARK=$local_mark"
	cat <<'SH'
systemctl() { echo "$*" >>"$CALLS"; }
SH
	sed -n '/^enable_units() {/,/^}/p' "$scripts/postinst" | sed "s|/run/systemd/system|$work/systemd|"
	cat <<'SH'
enable_units "$1"
SH
} >"$work/enable.sh"
grep -q '^enable_units() {' "$work/enable.sh" || fail "postinst has no enable_units"

# Present while systemd runs; a chroot or image build has none.
mkdir "$work/systemd"

# One dpkg run: preinst ARGS, then postinst configure with PREVIOUS.
dpkg_run() { # PREVIOUS PREINST-ARGS...
	local previous=$1
	shift
	: >"$work/calls"
	sh "$work/preinst" "$@"
	CALLS="$work/calls" sh "$work/enable.sh" "$previous"
	grep -c '^enable ' "$work/calls" || true
}

[ "$(dpkg_run "" install)" = 3 ] || fail "a first install did not enable the three services"
[ "$(dpkg_run 0.1.1 upgrade 0.1.1)" = 0 ] || fail "an upgrade enabled the services again"
[ "$(dpkg_run 0.1.1 install 0.1.1)" = 3 ] || fail "a reinstall after apt remove did not enable them"
[ ! -e "$local_mark" ] || fail "postinst left the reinstall mark behind"
[ "$(dpkg_run 0.1.2 upgrade 0.1.2)" = 0 ] || fail "the upgrade after a reinstall enabled them"

rmdir "$work/systemd"
[ "$(dpkg_run 0.1.2 install 0.1.2)" = 0 ] || fail "a reinstall without systemd running enabled the services"
[ ! -e "$local_mark" ] || fail "a reinstall without systemd running left the reinstall mark behind"
mkdir "$work/systemd"
[ "$(dpkg_run 0.1.3 upgrade 0.1.3)" = 0 ] || fail "the upgrade after a reinstall without systemd enabled them"

[ "$failures" = 0 ] || exit 1
echo "enable-units: ok"
