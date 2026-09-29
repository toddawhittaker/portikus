#!/usr/bin/env bash
# Captures the install screens shown in docs/INSTALL.md as PNGs under
# docs/images/install, by running `apt install portikus` on the released
# package from a local repository. Needs Docker, dpkg-scanpackages, python3
# with Pillow, the DejaVu Sans Mono font, and optipng.
#
# Usage: packaging/tests/capture-install-screens.sh [path/to/portikus.deb]
# With no .deb it downloads the newest one from the public apt repository.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$repo_root/docs/images/install"
image="${DEBCONF_TEST_IMAGE:-portikus-debconf-test:2}"
apt_repo=https://toddawhittaker.github.io/portikus/apt
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ $# -gt 0 ]; then
	cp "$1" "$work/portikus.deb"
else
	file=$(curl -fsSL "$apt_repo/dists/trixie/main/binary-amd64/Packages" |
		awk '/^Filename:/ {f = $2} END {print f}')
	echo "Downloading $file"
	curl -fsSL -o "$work/portikus.deb" "$apt_repo/$file"
fi
(cd "$work" && dpkg-scanpackages . /dev/null >Packages 2>/dev/null)
# apt reads the repository as its unprivileged _apt user.
chmod 0755 "$work"
chmod 0644 "$work/portikus.deb" "$work/Packages"

# debconf-test.sh builds the image when it is missing.
docker image inspect "$image" >/dev/null 2>&1 || {
	echo "Run packaging/tests/debconf-test.sh once to build $image." >&2
	exit 1
}

cp "$repo_root/packaging/tests/debconf-scenario.sh" "$work/"
mkdir -m 0777 "$work/out"
docker run --rm --hostname portikus.example.edu -e LANG=C.UTF-8 \
	-v "$work:/t:ro" -v "$work/out:/out" "$image" bash /t/debconf-scenario.sh capture

mkdir -p "$out"
for ans in "$work"/out/*.ans; do
	png="$out/$(basename "$ans" .ans).png"
	python3 "$repo_root/packaging/tests/render-terminal.py" "$ans" "$png"
	optipng -quiet -o5 "$png"
	echo "$png"
done
