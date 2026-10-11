#!/usr/bin/env bash
# Checks that apt remove leaves no Portikus unit running or watching and no
# link dangling, and that purge leaves nothing setup wrote into systemd
# (docs/SPEC.md section 21.12):
#   - prerm stops every unit the package ships and disables every path,
#     timer and socket;
#   - postrm's lists of what setup writes into /etc/systemd/system match the
#     Ansible roles, so a unit a role gains cannot be forgotten;
#   - the real postrm, run with a fake systemctl on a fake /etc, stops and
#     disables setup's units and drops the alert drop-ins on remove, and
#     deletes the rest on purge, never touching Caddy or PostgreSQL.
# Usage: packaging/tests/prerm-units-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
roles="$root/../infra/ansible/roles"
prerm="$root/scripts/prerm"
postrm="$root/scripts/postrm"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

fail() {
	echo "prerm-units: $1" >&2
	failures=$((failures + 1))
}

# ── prerm and the package's own units ────────────────────────────

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
	grep -qxF -- "$pattern" <<<"$stopped" || fail "prerm does not stop $unit"
	case "$unit" in
	*.path | *.timer | *.socket)
		grep -qxF -- "$unit" <<<"$disabled" || fail "prerm does not disable $unit"
		;;
	esac
done

# ── postrm's lists against the Ansible roles ─────────────────────

# One postrm list, one entry per line; a list may open and close on one line.
postrm_list() {
	awk -v name="$1" '
		index($0, name "=\047") == 1 { on = 1; $0 = substr($0, length(name) + 3) }
		on { done = /\047$/; sub(/\047$/, ""); print; if (done) on = 0 }
	' "$postrm"
}
setup_units=$(postrm_list SETUP_UNITS)
boot_units=$(postrm_list SETUP_BOOT_UNITS)
alert_dropins=$(postrm_list SETUP_ALERT_DROPINS)
other_dropins=$(postrm_list SETUP_DROPINS)
if [ -z "$setup_units" ] || [ -z "$boot_units" ] || [ -z "$alert_dropins" ] || [ -z "$other_dropins" ]; then
	fail "postrm lacks SETUP_UNITS, SETUP_BOOT_UNITS, SETUP_ALERT_DROPINS or SETUP_DROPINS"
fi

# Every path a role names under /etc/systemd/system, as ROLE<TAB>PATH, with a
# `{{ item }}` path expanded from its task's loop; and the drop-ins whose
# content names portikus-alert@, as alert<TAB>PATH.
role_paths() {
	awk '
		FNR == 1 { want_loop = 0; in_loop = 0; split(FILENAME, p, "/"); role = p[length(p) - 2] }
		in_loop && /^[[:space:]]*- / {
			item = $0; sub(/^[[:space:]]*- /, "", item); gsub(/["\047]/, "", item)
			print role "\t" item; next
		}
		in_loop { in_loop = 0; want_loop = 0 }
		want_loop && /^[[:space:]]*loop:/ { in_loop = 1; next }
		/\/etc\/systemd\/system\// {
			path = $0; sub(/.*\/etc\/systemd\/system\//, "", path); sub(/["\047][[:space:]]*$/, "", path)
			if (path ~ /\{\{ item \}\}/) { want_loop = 1; next }
			last = path; print role "\t" path
		}
		/OnFailure=portikus-alert@/ { print "alert\t" last }
	' "$roles"/*/tasks/*.yml
}
role_paths >"$work/role-paths"

# A role variable in a path, from the role defaults.
resolve() { # ROLE PATH
	local name value
	case "$2" in
	*'{{ '*' }}'*)
		name=${2#*'{{ '}
		name=${name%%' }}'*}
		value=$(sed -n "s/^$name: *['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\} *\$/\1/p" "$roles/$1/defaults/main.yml")
		[ -n "$value" ] || fail "no default for $name in the $1 role"
		echo "${2%%'{{ '*}$value${2#*' }}'}"
		;;
	*) echo "$2" ;;
	esac
}

: >"$work/written"
: >"$work/alerts"
while IFS=$'\t' read -r role path; do
	path=$(resolve "$role" "$path")
	case "$role:$path" in
	alert:*) echo "$path" >>"$work/alerts" ;;
	# A drop-in directory, which purge removes only when empty.
	*:*.d) ;;
	# Setup's mask on Debian's registry, which postrm keeps on purge on purpose.
	registry_cache:docker-registry.service) ;;
	*) echo "$path" >>"$work/written" ;;
	esac
done <"$work/role-paths"
sort -u -o "$work/written" "$work/written"
sort -u -o "$work/alerts" "$work/alerts"
grep -q 'portikus-dex.service' "$work/written" || fail "found no unit in the roles; the search is broken"
printf '%s\n' "$setup_units" "$boot_units" "$alert_dropins" "$other_dropins" | sort -u >"$work/listed"

while read -r path; do
	grep -qxF -- "$path" "$work/listed" || fail "setup writes /etc/systemd/system/$path, which postrm does not list"
done <"$work/written"
while read -r path; do
	grep -qxF -- "$path" "$work/written" || fail "postrm lists $path, which no role writes"
done <"$work/listed"
[ "$(printf '%s\n' "$alert_dropins" | sort -u)" = "$(cat "$work/alerts")" ] \
	|| fail "SETUP_ALERT_DROPINS is not exactly the drop-ins that name portikus-alert@: $(paste -sd' ' "$work/alerts")"
dropins=$(printf '%s\n' "$alert_dropins" "$other_dropins")
units=$(printf '%s\n' "$setup_units" "$boot_units")
while read -r path; do
	grep -qxF -- "$path" "$work/listed" || continue
	case "$path" in
	*/*) grep -qxF -- "$path" <<<"$dropins" || fail "$path is a drop-in but listed as a unit" ;;
	*) grep -qxF -- "$path" <<<"$units" || fail "$path is a unit but listed as a drop-in" ;;
	esac
done <"$work/written"

# ── the real postrm on a fake /etc ───────────────────────────────

# postrm with every /etc and /run/systemd path moved under ROOT, and a
# systemctl that logs its calls.
fake_postrm() { # ROOT
	{
		echo '#!/bin/sh'
		# shellcheck disable=SC2016 # expanded inside the fake postrm
		echo 'systemctl() { echo "$*" >>"$CALLS"; }'
		sed "1d; s|/etc/|$1/etc/|g; s|/run/systemd|$1/run/systemd|g" "$postrm"
	} >"$1/postrm"
}

# A host as setup leaves it: every listed file, an admin's own drop-in, the
# registry mask, and the package's enable links.
make_host() { # ROOT
	local r=$1 file
	mkdir -p "$r/run/systemd/system" "$r/etc/portikus" "$r/etc/portikus-workspace-proxy" \
		"$r/etc/systemd/system/multi-user.target.wants"
	while read -r file; do
		mkdir -p "$r/etc/systemd/system/$(dirname "$file")"
		echo "# setup" >"$r/etc/systemd/system/$file"
	done <"$work/listed"
	echo "# an administrator's" >"$r/etc/systemd/system/caddy.service.d/50-local.conf"
	ln -s /dev/null "$r/etc/systemd/system/docker-registry.service"
	ln -s /usr/lib/systemd/system/portikus-api.service "$r/etc/systemd/system/multi-user.target.wants/portikus-api.service"
	ln -s ../portikus-storage-attach.service "$r/etc/systemd/system/multi-user.target.wants/portikus-storage-attach.service"
	ln -s /usr/lib/systemd/system/caddy.service "$r/etc/systemd/system/multi-user.target.wants/caddy.service"
	echo "x: 1" >"$r/etc/portikus/portikus.yaml"
	echo key >"$r/etc/portikus-workspace-proxy/bump.key"
}

host="$work/host"
mkdir "$host"
make_host "$host"
fake_postrm "$host"
calls="$work/calls"

: >"$calls"
CALLS="$calls" sh "$host/postrm" remove
etc="$host/etc/systemd/system"
while read -r unit; do
	grep -qxF -- "stop $unit" "$calls" || fail "remove does not stop $unit"
	grep -qxF -- "disable $unit" "$calls" || fail "remove does not disable $unit"
	[ -e "$etc/$unit" ] || fail "remove deleted $unit, which purge should"
done <<<"$setup_units"
# Remove keeps data and configuration, so the storage Incus needs at boot stays attached.
while read -r unit; do
	! grep -E " $unit\$" "$calls" >&2 || fail "remove stopped or disabled $unit"
	[ -e "$etc/$unit" ] || fail "remove deleted $unit"
	[ -L "$etc/multi-user.target.wants/$unit" ] || fail "remove dropped the enable link of $unit"
done <<<"$boot_units"
while read -r dropin; do
	[ ! -e "$etc/$dropin" ] || fail "remove left $dropin"
done <<<"$alert_dropins"
while read -r dropin; do
	[ -e "$etc/$dropin" ] || fail "remove deleted $dropin, which purge should"
done <<<"$other_dropins"
grep -qx 'daemon-reload' "$calls" || fail "remove does not reload systemd"
! grep -E 'caddy|postgresql|squid\.service|nftables|docker-registry' "$calls" >&2 \
	|| fail "remove stopped or disabled another package's unit"
[ ! -e "$etc/multi-user.target.wants/portikus-api.service" ] || fail "remove left the API's enable link"
[ -L "$etc/multi-user.target.wants/caddy.service" ] || fail "remove dropped Caddy's enable link"
[ -e "$host/etc/portikus/portikus.yaml" ] || fail "remove deleted /etc/portikus"

: >"$calls"
CALLS="$calls" sh "$host/postrm" purge
while read -r unit; do
	grep -qxF -- "disable $unit" "$calls" || fail "purge does not disable $unit"
done <<<"$boot_units"
while read -r file; do
	[ ! -e "$etc/$file" ] || fail "purge left $file"
done <"$work/listed"
for dir in squid.service.d postgresql@.service.d system-postgresql.slice.d nftables.service.d system.slice.d; do
	[ ! -e "$etc/$dir" ] || fail "purge left the empty $dir"
done
[ -e "$etc/caddy.service.d/50-local.conf" ] || fail "purge deleted an administrator's Caddy drop-in"
[ -L "$etc/docker-registry.service" ] || fail "purge unmasked Debian's docker-registry.service"
[ ! -e "$host/etc/portikus" ] || fail "purge left /etc/portikus"
[ ! -e "$host/etc/portikus-workspace-proxy" ] || fail "purge left the workspace proxy's key"
grep -qx 'daemon-reload' "$calls" || fail "purge does not reload systemd"

# Without systemd running, as in a chroot: disable, but never stop or reload.
chroot_host="$work/chroot"
mkdir "$chroot_host"
make_host "$chroot_host"
rmdir "$chroot_host/run/systemd/system"
fake_postrm "$chroot_host"
: >"$calls"
CALLS="$calls" sh "$chroot_host/postrm" remove
! grep -E '^(stop|daemon-reload)' "$calls" >&2 || fail "remove without systemd running stopped units or reloaded"
grep -qx 'disable portikus-dex.service' "$calls" || fail "remove without systemd running did not disable Dex"

[ "$failures" -eq 0 ] || exit 1
echo "prerm-units: ok"
