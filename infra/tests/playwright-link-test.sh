#!/usr/bin/env bash
# Tests /etc/profile.d/portikus-playwright.sh from the workspace image: at
# login it links the image's pinned Playwright browser into the student's
# own Playwright folder and names it in a .links entry, so Playwright's
# cleanup keeps it (SPEC.md 21.7).  The file is embedded in the image
# definition, so the test extracts it and points it at a stand-in image
# folder.  Needs no VM.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

image_file /etc/profile.d/portikus-playwright.sh > "${work}/script.sh"
if ! grep -q /opt/ms-playwright "${work}/script.sh"; then
  echo "error: could not extract portikus-playwright.sh from portikus.yaml" >&2
  exit 1
fi
sed "s|/opt/ms-playwright|${work}/opt|g" "${work}/script.sh" > "${work}/profile.sh"

# The stand-in image folder: two browser builds and the version's browsers.json.
mkdir -p "${work}/opt/chromium_headless_shell-1243" "${work}/opt/ffmpeg-1011"
echo '{}' > "${work}/opt/browsers.json"

# Sources the script in a login-like sh with HOME set, and prints anything it wrote.
login() { # HOME [XDG_CACHE_HOME]
  env -i HOME="$1" ${2:+XDG_CACHE_HOME="$2"} PATH=/usr/bin:/bin sh -c ". '${work}/profile.sh'; echo status=\$?" 2>&1
}

home="${work}/home"
mkdir "${home}"
cache="${home}/.cache/ms-playwright"
expect_eq "a first login prints nothing and succeeds" "status=0" "$(login "${home}")"
expect_eq "the headless shell is linked from the image" \
  "${work}/opt/chromium_headless_shell-1243" "$(readlink "${cache}/chromium_headless_shell-1243")"
expect_eq "ffmpeg is linked from the image" "${work}/opt/ffmpeg-1011" "$(readlink "${cache}/ffmpeg-1011")"
expect_eq "the .links entry names the image folder" "${work}/opt" "$(cat "${cache}/.links/portikus-image")"

# A student's own copy of a build keeps its place, and a second login changes nothing.
rm "${cache}/ffmpeg-1011"
mkdir "${cache}/ffmpeg-1011"
expect_eq "a later login succeeds" "status=0" "$(login "${home}")"
check "a folder the student installed is left alone" test ! -L "${cache}/ffmpeg-1011"

# A new image moves the pin: the old link dangles and goes, the new one comes.
ln -s "${work}/opt/chromium_headless_shell-1200" "${cache}/chromium_headless_shell-1200"
ln -s "${work}/elsewhere" "${cache}/student-link"
login "${home}" > /dev/null
check "a link to a build the image no longer has is removed" test ! -L "${cache}/chromium_headless_shell-1200"
check "a dangling link the student made is kept" test -L "${cache}/student-link"

xdg="${work}/xdg"
expect_eq "XDG_CACHE_HOME moves the folder, as it does for Playwright" "status=0" "$(login "${home}" "${xdg}")"
check "the link is made under XDG_CACHE_HOME" test -L "${xdg}/ms-playwright/chromium_headless_shell-1243"

# An image without the browser leaves the home folder untouched.
rm "${work}/opt/browsers.json"
bare="${work}/bare"
mkdir "${bare}"
expect_eq "without the image's browser a login succeeds" "status=0" "$(login "${bare}")"
check "and creates nothing" test ! -e "${bare}/.cache"

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "${fail}" -eq 0 ]
