#!/usr/bin/env bash
# Tests that Claude Code login in a workspace offers the paste-code URL and
# opens no browser (issue #848, BROWSER-HANDLING.md 19.2).  The image's
# managed settings are extracted from the image definition.  When `claude` is
# installed here, the settings are also tried on it; the smoke test tries them
# on the image's own Claude Code.  Needs no VM and never logs in.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

image_file /etc/claude-code/managed-settings.json > "${work}/settings.json"

echo
echo "--- Claude Code login ---"
echo

expect_eq "managed settings set BROWSER to empty" "''" \
  "$(python3 -c 'import json,sys; print(repr(json.load(open(sys.argv[1]))["env"]["BROWSER"]))' "${work}/settings.json" 2>&1)"

if command -v claude > /dev/null; then
  # An opener that records a call, so an open the settings failed to stop shows.
  printf '#!/bin/sh\ntouch "%s/opened"\n' "${work}" > "${work}/opener"
  chmod +x "${work}/opener"
  mkdir "${work}/config"
  cp "${work}/settings.json" "${work}/config/settings.json"
  env -u DISPLAY -u WAYLAND_DISPLAY -u SSH_CONNECTION \
    BROWSER="${work}/opener" CLAUDE_CONFIG_DIR="${work}/config" \
    timeout 10 claude auth login < /dev/null > "${work}/out" 2>&1
  expect_eq "claude auth login opens no browser" "no" "$([ -e "${work}/opened" ] && echo yes || echo no)"
  expect_eq "claude auth login prints the paste-code URL" "yes" \
    "$(grep -q 'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' "${work}/out" && echo yes || echo no)"
  expect_eq "claude auth login asks for the code" "yes" \
    "$(grep -q 'Paste code here' "${work}/out" && echo yes || echo no)"
else
  echo "SKIP  claude is not installed here; the smoke test tries the image's Claude Code"
fi

echo
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "${fail}" -eq 0 ]
