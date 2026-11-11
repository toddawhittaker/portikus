#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. Usage: ci-apt-install.sh DEBS_DIR PACKAGE...
#
# DEBS_DIR is cached by the apt-install action. When it already holds .deb
# files, apt installs them as local files, which needs no network and no
# package index. Otherwise the packages and their missing dependencies are
# downloaded from kernel.org's Ubuntu mirror into DEBS_DIR first. Ubuntu's own
# mirrors are not tried: the runners' lookups of them can hang for longer than
# the step's timeout, and a miss happens about once per runner image.
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

if ! compgen -G "$debs_dir/*.deb" >/dev/null; then
  # The image's sources are copied with only the URIs swapped, so the suites
  # match the image and Signed-By still checks the Ubuntu archive key.
  # kernel.org's copy also carries the security pocket. The copy, its index
  # and the downloads live in a temporary folder that apt reads alone, so no
  # later apt call sees them.
  # apt downloads as the _apt user, which must be able to reach this folder;
  # /tmp is open to it, where the runner's home and work folders are not.
  mirror_dir=$(mktemp -d /tmp/apt-mirror.XXXXXX)
  trap 'sudo rm -rf "$mirror_dir"' EXIT
  chmod 755 "$mirror_dir"
  mkdir -p "$mirror_dir/sources" "$mirror_dir/lists" "$mirror_dir/archives"
  sed -E 's#^URIs:.*#URIs: https://mirrors.edge.kernel.org/ubuntu/#' \
    /etc/apt/sources.list.d/ubuntu.sources >"$mirror_dir/sources/mirror.sources"
  opts=(-o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$mirror_dir/sources"
    -o Dir::State::Lists="$mirror_dir/lists" -o Dir::Cache::archives="$mirror_dir/archives"
    -o Acquire::Retries=3)
  sudo apt-get "${opts[@]}" update
  sudo apt-get "${opts[@]}" install -y --no-install-recommends --download-only "${missing[@]}"
  sudo mv "$mirror_dir"/archives/*.deb "$debs_dir"/
  sudo chown "$(id -u):$(id -g)" "$debs_dir"/*.deb
fi

# apt, unlike a bare dpkg -i, orders the set so pre-dependencies such as
# systemd's are configured before the packages that need them. --no-download
# is left off because apt then rejects local .deb paths as "not absolute".
sudo apt-get install -y --no-install-recommends "$debs_dir"/*.deb
