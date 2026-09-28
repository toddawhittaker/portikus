#!/usr/bin/env bash
# Installs the package in Debian 13 containers with a preseed for each sign-in
# provider and storage kind, and checks what postinst writes (docs/EPIC-15.md,
# rulings 2 to 6 and 10, and the security invariants).
#
# Usage: packaging/tests/debconf-test.sh [path/to/portikus.deb]
# With no .deb it builds a small one from the same templates, config and
# postinst, which is all this test exercises.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="${DEBCONF_TEST_IMAGE:-portikus-debconf-test}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ $# -gt 0 ]; then
	cp "$1" "$work/portikus.deb"
else
	pkg="$work/pkg"
	mkdir -p "$pkg/DEBIAN"
	cp "$repo_root/packaging/debian/templates" "$repo_root/packaging/debian/config" \
		"$repo_root/packaging/scripts/postinst" "$pkg/DEBIAN/"
	cat >"$pkg/DEBIAN/control" <<EOF
Package: portikus
Version: 0.0.0+debconf-test
Architecture: all
Maintainer: Portikus <portikus@example.invalid>
Depends: debconf, python3-yaml, whiptail | dialog
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
      debconf whiptail python3-yaml util-linux adduser \
 && rm -rf /var/lib/apt/lists/*
EOF
fi

cp "$repo_root/packaging/tests/debconf-scenario.sh" "$work/"
failed=0
for scenario in dex-file entra-vg google-disk ldap-unconfirmed oidc-missing-secret reconfigure; do
	if docker run --rm -v "$work:/t:ro" "$image" bash /t/debconf-scenario.sh "$scenario"; then
		echo "PASS $scenario"
	else
		echo "FAIL $scenario"
		failed=1
	fi
done
exit "$failed"
