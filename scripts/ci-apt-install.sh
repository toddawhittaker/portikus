#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. Usage: ci-apt-install.sh DEBS_DIR PACKAGE...
#
# DEBS_DIR is cached by the apt-install action. When it is empty, the packages
# and their missing dependencies are first downloaded into it from kernel.org's
# Ubuntu mirror. Ubuntu's own mirrors are never tried: the runners' lookups of
# them can hang for longer than the step's timeout, and a miss happens about
# once per runner image. The install itself reads only the files in DEBS_DIR,
# so a cache hit needs no network.
set -euo pipefail

debs_dir=$1
shift
mkdir -p "$debs_dir"

missing=()
for pkg in "$@"; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
done
if [ ${#missing[@]} -eq 0 ]; then
  echo "Already installed: $*"
  exit 0
fi

# apt reads and downloads files as its _apt user, which cannot enter the
# runner's home folder, where DEBS_DIR lives, but can enter /tmp.
work=$(mktemp -d /tmp/ci-apt.XXXXXX)
trap 'sudo rm -rf "$work"' EXIT
chmod 755 "$work"
mkdir -p "$work/sources" "$work/lists" "$work/archives" "$work/debs"

if ! compgen -G "$debs_dir/*.deb" >/dev/null; then
  # The image's sources are copied with only the URIs swapped, so the suites
  # match the image and Signed-By still checks the Ubuntu archive key.
  # kernel.org's copy also carries the security pocket.
  sed -E 's#^URIs:.*#URIs: https://mirrors.edge.kernel.org/ubuntu/#' \
    /etc/apt/sources.list.d/ubuntu.sources >"$work/sources/mirror.sources"
  mirror=(-o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$work/sources"
    -o Dir::State::Lists="$work/lists" -o Dir::Cache::archives="$work/archives"
    -o Acquire::Retries=3)
  sudo apt-get "${mirror[@]}" update
  sudo apt-get "${mirror[@]}" install -y --no-install-recommends --download-only "${missing[@]}"
  sudo mv "$work"/archives/*.deb "$debs_dir"/
  sudo chown "$(id -u):$(id -g)" "$debs_dir"/*.deb
fi

# No sources and an empty index, so apt resolves dependencies only from these
# files and what is installed, and never reaches for a mirror. apt, unlike a
# bare dpkg -i, orders the set so pre-dependencies such as systemd's are
# configured first. --no-download is left off because apt then rejects local
# .deb paths as "not absolute".
cp "$debs_dir"/*.deb "$work/debs"/
rm -f "$work/sources"/*
sudo rm -rf "$work/lists" && mkdir "$work/lists"
sudo apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$work/sources" \
  -o Dir::State::Lists="$work/lists" install -y --no-install-recommends "$work"/debs/*.deb
