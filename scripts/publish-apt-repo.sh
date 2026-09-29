#!/usr/bin/env bash
# Build a signed static apt repository (suite trixie, component main, amd64)
# for GitHub Pages or a local rehearsal (docs/SPEC.md section 21.13).
#
# Usage: APT_SIGNING_KEY="<ASCII-armored private key>" \
#          scripts/publish-apt-repo.sh <repo-dir> [new.deb ...]
#
# <repo-dir> may already hold pool/main/p/portikus/*.deb from earlier runs;
# the new packages are added, only the newest ten versions are kept, and the
# indexes, Release, InRelease, Release.gpg and the public key are rewritten.
# The key comes from the environment, never the command line, and is imported
# into a throwaway GNUPGHOME that is removed on exit.
set -euo pipefail

KEEP=10
SUITE=trixie
COMPONENT=main
ARCH=amd64

if [[ $# -lt 1 ]]; then
  echo "usage: APT_SIGNING_KEY=... $0 <repo-dir> [new.deb ...]" >&2
  exit 2
fi
if [[ -z "${APT_SIGNING_KEY:-}" ]]; then
  echo "error: APT_SIGNING_KEY is not set" >&2
  exit 1
fi
for tool in apt-ftparchive dpkg-deb gpg; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

REPO="$1"
shift
POOL="$REPO/pool/$COMPONENT/p/portikus"
DIST="$REPO/dists/$SUITE"
mkdir -p "$POOL" "$DIST/$COMPONENT/binary-$ARCH"

for deb in "$@"; do
  [[ "$(dpkg-deb -f "$deb" Package)" == portikus ]] || { echo "error: $deb is not the portikus package" >&2; exit 1; }
  cp "$deb" "$POOL/"
done

# Keep the newest $KEEP versions, ordered the way dpkg orders them.
mapfile -t debs < <(find "$POOL" -maxdepth 1 -name '*.deb' -printf '%p\n')
mapfile -t ordered < <(
  for deb in "${debs[@]}"; do
    printf '%s %s\n' "$(dpkg-deb -f "$deb" Version)" "$deb"
  done | sort -k1,1 -V -r
)
for ((i = KEEP; i < ${#ordered[@]}; i++)); do
  old="${ordered[$i]#* }"
  echo "pruning $(basename "$old")"
  rm -f "$old"
done

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null
FPR="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
[[ -n "$FPR" ]] || { echo "error: APT_SIGNING_KEY holds no secret key" >&2; exit 1; }

(
  cd "$REPO"
  apt-ftparchive packages "pool/$COMPONENT" > "dists/$SUITE/$COMPONENT/binary-$ARCH/Packages"
  gzip -9nkf "dists/$SUITE/$COMPONENT/binary-$ARCH/Packages"
  apt-ftparchive \
    -o "APT::FTPArchive::Release::Origin=Portikus" \
    -o "APT::FTPArchive::Release::Label=Portikus" \
    -o "APT::FTPArchive::Release::Suite=$SUITE" \
    -o "APT::FTPArchive::Release::Codename=$SUITE" \
    -o "APT::FTPArchive::Release::Components=$COMPONENT" \
    -o "APT::FTPArchive::Release::Architectures=$ARCH" \
    release "dists/$SUITE" > "dists/$SUITE/Release.tmp"
  mv "dists/$SUITE/Release.tmp" "dists/$SUITE/Release"
)

gpg --batch --yes --local-user "$FPR" --clearsign -o "$DIST/InRelease" "$DIST/Release"
gpg --batch --yes --local-user "$FPR" --armor --detach-sign -o "$DIST/Release.gpg" "$DIST/Release"
gpg --batch --yes --armor --export "$FPR" > "$REPO/portikus-archive-keyring.asc"
gpg --batch --yes --export "$FPR" > "$REPO/portikus-archive-keyring.gpg"

echo "apt repository ready in $REPO (signed by $FPR)"
