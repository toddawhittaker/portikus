#!/usr/bin/env bash
# Downloads the newest portikus package from the public apt repository and
# checks it the way apt would: InRelease against the archive key, Packages
# against InRelease, and the .deb against Packages.  Prints its version.
#
# Usage: packaging/tests/fetch-published-deb.sh OUT.deb
# PORTIKUS_APT_BASE and PORTIKUS_ARCHIVE_KEY override the repository and its
# key, for scripts/tests/publish-apt-repo-test.sh.
set -euo pipefail

out="${1:?Usage: fetch-published-deb.sh OUT.deb}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base="${PORTIKUS_APT_BASE:-https://toddawhittaker.github.io/portikus/apt}"
key="${PORTIKUS_ARCHIVE_KEY:-$repo_root/packaging/portikus-archive-keyring.asc}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gpg --dearmor <"$key" >"$work/archive.gpg"
curl -fsS -o "$work/InRelease" "$base/dists/trixie/InRelease"
# Only the signed part counts: text around it is not covered by the signature.
gpgv --keyring "$work/archive.gpg" --output "$work/Release" "$work/InRelease"
curl -fsS -o "$work/Packages" "$base/dists/trixie/main/binary-amd64/Packages"
sum=$(awk '/^SHA256:/ { s = 1; next } /^[^ ]/ { s = 0 } s && $3 == "main/binary-amd64/Packages" { print $1; exit }' "$work/Release")
[ -n "$sum" ] || { echo "the signed Release lists no Packages checksum" >&2; exit 1; }
echo "$sum  $work/Packages" | sha256sum -c --quiet >&2

# One line per portikus entry: version, file name, SHA-256.  The file lists
# entries in file-name order, which is not version order.
best_version="" best_file="" best_sum=""
while read -r version file hash; do
	if [ -z "$best_version" ] || dpkg --compare-versions "$version" gt "$best_version"; then
		best_version=$version best_file=$file best_sum=$hash
	fi
done < <(awk '
	/^Package:/ { p = ($2 == "portikus"); v = f = s = "" }
	p && /^Version:/ { v = $2 }
	p && /^Filename:/ { f = $2 }
	p && /^SHA256:/ { s = $2 }
	p && /^$/ && v != "" { print v, f, s; p = 0 }
	END { if (p && v != "") print v, f, s }
' "$work/Packages")
[ -n "$best_version" ] || { echo "no portikus package in $base" >&2; exit 1; }

echo "Downloading $best_file" >&2
curl -fsS -o "$work/portikus.deb" "$base/$best_file"
echo "$best_sum  $work/portikus.deb" | sha256sum -c --quiet >&2
mv "$work/portikus.deb" "$out"
echo "$best_version"
