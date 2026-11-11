#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. Usage: ci-apt-install.sh DEBS_DIR PACKAGE...
#
# DEBS_DIR is cached by the apt-install action. When it already holds .deb
# files, apt installs them as local files, which needs no network and no
# package index, so a run survives Ubuntu's mirrors being unreachable.
# Otherwise apt downloads the packages and their missing dependencies into
# DEBS_DIR (using the image's package index first, because apt-get update
# stalls when the mirrors are slow) and the same step installs them.
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
  download() {
    sudo apt-get install -y -o Acquire::Retries=3 --no-install-recommends --download-only \
      -o Dir::Cache::archives="$debs_dir" "${missing[@]}"
  }
  download || { sudo apt-get update -o Acquire::Retries=3 && download; }
  # apt leaves a root-only lock and partial folder that the cache save cannot read.
  sudo rm -rf "$debs_dir/lock" "$debs_dir/partial"
  sudo chown -R "$(id -u):$(id -g)" "$debs_dir"
fi

# apt, unlike a bare dpkg -i, orders the set so pre-dependencies such as
# systemd's are configured before the packages that need them. --no-download
# is left off because apt then rejects local .deb paths as "not absolute".
sudo apt-get install -y --no-install-recommends "$debs_dir"/*.deb
