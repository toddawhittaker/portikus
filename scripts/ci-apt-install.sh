#!/usr/bin/env bash
# Installs the named packages on a CI runner, skipping any the image already
# has. It uses the image's package index first, because apt-get update stalls
# when Ubuntu's mirrors are slow; it refreshes the index only if that fails.
set -euo pipefail

missing=()
for pkg in "$@"; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
done
if [ ${#missing[@]} -eq 0 ]; then
  echo "Already installed: $*"
  exit 0
fi

install() {
  sudo apt-get install -y -o Acquire::Retries=3 --no-install-recommends "${missing[@]}"
}
install || { sudo apt-get update -o Acquire::Retries=3 && install; }
