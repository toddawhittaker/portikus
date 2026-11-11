#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. Usage: ci-apt-install.sh DEBS_DIR PACKAGE...
#
# DEBS_DIR is cached by the apt-install action. When it already holds .deb
# files, apt installs them as local files, which needs no network and no
# package index, so a run survives Ubuntu's mirrors being unreachable.
# Otherwise apt downloads the packages and their missing dependencies into
# DEBS_DIR (using the image's package index first, because apt-get update
# stalls when the mirrors are slow, then a fresh index, then a fallback
# mirror, or that mirror at once when Ubuntu's hosts do not resolve) and the
# same step installs them.
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
  # Any extra arguments are apt options placed before the install command.
  download() {
    sudo apt-get "$@" install -y --no-install-recommends --download-only \
      -o Dir::Cache::archives="$debs_dir" "${missing[@]}"
  }
  # Short limits on Ubuntu's own mirrors, so a hang leaves time for the fallback
  # inside the step's five-minute timeout.
  ubuntu_opts=(-o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10)
  # apt's own name lookups can stall for minutes, so check every mirror host
  # named in the image's sources first, each within five seconds.
  ubuntu_resolves() {
    local host
    while read -r host; do
      timeout 5 getent hosts "$host" >/dev/null || { echo "Cannot resolve $host"; return 1; }
    done < <(sed -nE 's#^URIs:[[:space:]]*[a-z]+://([^/[:space:]]+).*#\1#p' \
      /etc/apt/sources.list.d/ubuntu.sources | sort -u)
  }
  # When the runner cannot resolve Ubuntu's own mirrors, download from
  # kernel.org's copy, which also carries the security pocket. The image's
  # sources are copied with only the URIs swapped, so Signed-By still checks
  # the Ubuntu archive key. The copy and its index live in a temporary folder
  # that apt reads alone, so no later apt call sees them.
  download_from_mirror() {
    mirror_dir=$(mktemp -d)
    # apt's download user must be able to reach the index folder.
    chmod 755 "$mirror_dir"
    trap 'sudo rm -rf "$mirror_dir"' EXIT
    mkdir -p "$mirror_dir/sources" "$mirror_dir/lists"
    sed -E 's#^URIs:.*#URIs: https://mirrors.edge.kernel.org/ubuntu/#' \
      /etc/apt/sources.list.d/ubuntu.sources >"$mirror_dir/sources/mirror.sources"
    local opts=(-o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$mirror_dir/sources"
      -o Dir::State::Lists="$mirror_dir/lists")
    sudo apt-get "${opts[@]}" -o Acquire::Retries=3 update && download "${opts[@]}" -o Acquire::Retries=3
  }
  if ubuntu_resolves; then
    download "${ubuntu_opts[@]}" ||
      { sudo apt-get "${ubuntu_opts[@]}" update && download "${ubuntu_opts[@]}"; } ||
      download_from_mirror
  else
    download_from_mirror
  fi
  # apt leaves a root-only lock and partial folder that the cache save cannot read.
  sudo rm -rf "$debs_dir/lock" "$debs_dir/partial"
  sudo chown -R "$(id -u):$(id -g)" "$debs_dir"
fi

# apt, unlike a bare dpkg -i, orders the set so pre-dependencies such as
# systemd's are configured before the packages that need them. --no-download
# is left off because apt then rejects local .deb paths as "not absolute".
sudo apt-get install -y --no-install-recommends "$debs_dir"/*.deb
