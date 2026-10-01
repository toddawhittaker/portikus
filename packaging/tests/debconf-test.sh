#!/usr/bin/env bash
# Installs the package in Debian 13 containers with a preseed for each sign-in
# provider and storage kind, and checks what postinst writes (docs/SPEC.md section 21.12,
# including its secrets rules).
#
# Usage: packaging/tests/debconf-test.sh [path/to/portikus.deb]
# With no .deb it builds a small one from the same templates, config and
# postinst, which is all this test exercises. The ui-* scenarios drive the
# whiptail screens in tmux, as a person would.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${DEBCONF_TEST_IMAGE:-portikus-debconf-test:2}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ $# -gt 0 ]; then
	cp "$1" "$work/portikus.deb"
else
	pkg="$work/pkg"
	mkdir -p "$pkg/DEBIAN"
	cp "$repo_root/packaging/debian/templates" "$repo_root/packaging/debian/config" \
		"$repo_root/packaging/scripts/postinst" "$pkg/DEBIAN/"
	mkdir -p "$pkg/usr/share/portikus"
	cp "$repo_root/packaging/debian/settings-keys" "$pkg/usr/share/portikus/"
	mkdir -p "$pkg/usr/share/portikus/ansible/roles/portikus/files"
	cp "$repo_root/infra/ansible/roles/portikus/files/worker-grants.sql" \
		"$pkg/usr/share/portikus/ansible/roles/portikus/files/"
	cat >"$pkg/DEBIAN/control" <<EOF
Package: portikus
Version: 0.0.0+debconf-test
Architecture: all
Maintainer: Portikus <portikus@example.invalid>
Depends: debconf, python3-yaml, whiptail | dialog, openssl
Description: Portikus debconf test package
EOF
	chmod 0755 "$pkg/DEBIAN/config" "$pkg/DEBIAN/postinst"
	dpkg-deb --root-owner-group --build "$pkg" "$work/portikus.deb" >/dev/null
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
	docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      debconf whiptail python3-yaml util-linux adduser openssl tmux \
 && rm -rf /var/lib/apt/lists/*
EOF
fi

cp "$repo_root/packaging/tests/debconf-scenario.sh" "$work/"
failed=0
for scenario in dex-file entra-vg google-disk ldap-unconfirmed oidc-missing-secret reconfigure no-debconf-keys unanswered unconfigured-secret setup-running worker-account tls-default seeded-certificate \
	ui-storage-default ui-cache-small-disk ui-cache-existing-file ui-host-short ui-host-full ui-summary-no ui-cert ui-reconfigure-seeded; do
	# The container's host name is what the web address question suggests.
	hostname=portikus
	[ "$scenario" != ui-host-full ] || hostname=lab.example.edu
	if docker run --rm --hostname "$hostname" -v "$work:/t:ro" "$image" bash /t/debconf-scenario.sh "$scenario"; then
		echo "PASS $scenario"
	else
		echo "FAIL $scenario"
		failed=1
	fi
done
exit "$failed"
