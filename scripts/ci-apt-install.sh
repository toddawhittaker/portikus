#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. Usage: ci-apt-install.sh DEBS_DIR PACKAGE...
#
# DEBS_DIR is cached by the apt-install action. When it is empty, the packages
# and their missing dependencies are first downloaded into it from kernel.org's
# Ubuntu mirror. If that mirror cannot be reached, the download is tried once
# more from the MIT mirror, which carries the same suites and is signed by the
# same Ubuntu archive key. Ubuntu's own mirrors are never tried: the runners'
# lookups of them can hang for longer than the step's timeout, and a miss
# happens about once per runner image. The install itself reads only the files
# in DEBS_DIR, so a cache hit needs no network.
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

# Downloads the missing packages and their dependencies from the mirror at
# URI into $work/archives, retrying a failed file "retries" more times. Every
# step is chained with || return 1 because errexit is off inside a function
# that is the condition of an if.
download_from() {
  local uri=$1 retries=$2
  # The image's sources are copied with only the URIs swapped, so the suites
  # match the image and Signed-By still checks the Ubuntu archive key. Both
  # mirrors also carry the security pocket. A previous attempt's lists and
  # partial downloads are cleared so the retry starts clean.
  sudo rm -rf "$work/sources" "$work/lists" "$work/archives"
  mkdir -p "$work/sources" "$work/lists" "$work/archives"
  sed -E "s#^URIs:.*#URIs: $uri#" \
    /etc/apt/sources.list.d/ubuntu.sources >"$work/sources/mirror.sources"
  # apt asks one host for its index files one after another, so a hung mirror
  # costs up to four files times (retries + 1) times the timeout; the timeout
  # keeps that bounded. Error-Mode=any makes update exit non-zero when any
  # index fails to download (by default it only warns and exits 0).
  local mirror=(-o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts="$work/sources"
    -o Dir::State::Lists="$work/lists" -o Dir::Cache::archives="$work/archives"
    -o Acquire::Retries="$retries" -o Acquire::https::Timeout=10 -o APT::Update::Error-Mode=any)
  sudo apt-get "${mirror[@]}" update || return 1
  sudo apt-get "${mirror[@]}" install -y --no-install-recommends --download-only "${missing[@]}" || return 1
}

if ! compgen -G "$debs_dir/*.deb" >/dev/null; then
  primary=https://mirrors.edge.kernel.org/ubuntu/
  fallback=https://mirrors.mit.edu/ubuntu/
  # The first mirror gets one retry because a second mirror follows; the last
  # one gets three.
  if ! download_from "$primary" 1; then
    echo "Download from $primary failed; trying $fallback" >&2
    download_from "$fallback" 3 || {
      echo "Could not download packages from $primary or $fallback" >&2
      exit 1
    }
  fi
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
