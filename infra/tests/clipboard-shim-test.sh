#!/usr/bin/env bash
# Tests the clipboard shim the workspace image installs as /usr/local/bin/xclip
# (issue #125).  The shim is embedded in the image definition, so the test
# extracts it, links it under its other names, and runs it with /bin/sh.
# Needs no VM: everything happens in a temporary directory.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
YAML="${REPO_ROOT}/infra/workspace-image/portikus.yaml"

pass=0
fail=0

expect() { # LABEL EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s\n      expected: %q\n      actual:   %q\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# Pull the shim out of the image definition: the block scalar that follows
# the /usr/local/bin/xclip entry, with its four spaces of indentation removed.
awk '
  $0 == "- path: /usr/local/bin/xclip" { found = 1; next }
  found && $0 == "  content: |-" { body = 1; next }
  body && $0 == "" { print ""; next }
  body && /^    / { sub(/^    /, ""); print; next }
  body { exit }
' "${YAML}" > "${work}/xclip"

if ! head -n 1 "${work}/xclip" | grep -q '^#!/bin/sh$'; then
  echo "error: could not extract the clipboard shim from ${YAML}" >&2
  exit 1
fi

chmod +x "${work}/xclip"
ln -s xclip "${work}/xsel"
ln -s xclip "${work}/pbcopy"

# What the browser must receive for the text "hi": ESC ] 5 2 ; c ; aGk= BEL.
osc_hi="$(printf '\033]52;c;aGk=\a')"

# setsid detaches the shim from this terminal, which is how it runs under the
# smoke test: with no /dev/tty it must fall back to standard output.
run() { setsid "$@"; }

echo
echo "--- clipboard shim ---"
echo

expect "xclip -selection clipboard copies"  "${osc_hi}" "$(printf hi | run "${work}/xclip" -selection clipboard)"
expect "xclip -i copies"                    "${osc_hi}" "$(printf hi | run "${work}/xclip" -i)"
expect "xclip with no flags copies"         "${osc_hi}" "$(printf hi | run "${work}/xclip")"
expect "xclip -d :0 still copies"           "${osc_hi}" "$(printf hi | run "${work}/xclip" -d :0)"
expect "xsel --clipboard --input copies"    "${osc_hi}" "$(printf hi | run "${work}/xsel" --clipboard --input)"
expect "pbcopy copies"                      "${osc_hi}" "$(printf hi | run "${work}/pbcopy")"

printf hi > "${work}/hi.txt"
expect "xclip reads a file argument"        "${osc_hi}" "$(run "${work}/xclip" "${work}/hi.txt" < /dev/null)"

expect "xclip -o prints nothing"            "" "$(printf hi | run "${work}/xclip" -o)"
expect "xsel -o prints nothing"             "" "$(printf hi | run "${work}/xsel" -o)"
expect "xsel with no flags prints nothing"  "" "$(printf hi | run "${work}/xsel")"
expect "xsel -b prints nothing"             "" "$(printf hi | run "${work}/xsel" -b)"

printf hi | run "${work}/xclip" -selection clipboard > /dev/null
expect "a copy exits 0" 0 $?
run "${work}/xclip" -o < /dev/null > /dev/null
expect "a read exits 0" 0 $?

# Input is capped at 1 MiB: 1048576 bytes encode to 1398104 base64 characters,
# and the escape adds 7 leading and 1 trailing byte.
capped="$(head -c 2097152 /dev/zero | tr '\0' 'a' | run "${work}/xclip" -selection clipboard | wc -c)"
expect "input is capped at 1 MiB" 1398112 "${capped}"

# The value the smoke test compares against, so the two cannot drift apart.
expect "smoke test prefix" "G101MjtjO2FH" \
  "$(printf hi | run "${work}/xclip" -selection clipboard | base64 | cut -c1-12)"

echo
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "${fail}" -eq 0 ]
