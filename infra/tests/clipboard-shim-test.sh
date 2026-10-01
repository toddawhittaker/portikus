#!/usr/bin/env bash
# Tests the clipboard shim the workspace image installs as /usr/local/bin/xclip
# (issue #125).  The shim is embedded in the image definition, so the test
# extracts it, links it under its other names, and runs it with /bin/sh.
# Needs no VM: everything happens in a temporary directory.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

image_file /usr/local/bin/xclip > "${work}/xclip"

if ! head -n 1 "${work}/xclip" | grep -q '^#!/bin/sh$'; then
  echo "error: could not extract the clipboard shim from portikus.yaml" >&2
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

expect_eq "xclip -selection clipboard copies"  "${osc_hi}" "$(printf hi | run "${work}/xclip" -selection clipboard)"
expect_eq "xclip -i copies"                    "${osc_hi}" "$(printf hi | run "${work}/xclip" -i)"
expect_eq "xclip with no flags copies"         "${osc_hi}" "$(printf hi | run "${work}/xclip")"
expect_eq "xclip -d :0 still copies"           "${osc_hi}" "$(printf hi | run "${work}/xclip" -d :0)"
expect_eq "xsel --clipboard --input copies"    "${osc_hi}" "$(printf hi | run "${work}/xsel" --clipboard --input)"
expect_eq "pbcopy copies"                      "${osc_hi}" "$(printf hi | run "${work}/pbcopy")"

printf hi > "${work}/hi.txt"
expect_eq "xclip reads a file argument"        "${osc_hi}" "$(run "${work}/xclip" "${work}/hi.txt" < /dev/null)"

# A selection name is a value, not a file.  With a file called "clipboard" in
# the working directory, "xclip -selection clipboard" must still copy stdin.
mkdir -p "${work}/cwd"
printf 'from the file' > "${work}/cwd/clipboard"
printf 'from the file' > "${work}/cwd/100"
printf 'from the file' > "${work}/cwd/copy.log"
expect_eq "xclip -selection clipboard ignores a file of that name" "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -selection clipboard)"
expect_eq "xclip -sel abbreviation ignores a file of that name"    "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -sel clipboard)"
expect_eq "xsel -t value is not a file"                            "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xsel" -i -t 100)"
expect_eq "xsel -l value is not a file"                            "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xsel" -i -l copy.log)"
# xclip's -t, -l and -d take a value too, and a file of that name in the
# working directory must not be copied instead of stdin.
printf 'from the file' > "${work}/cwd/1"
printf 'from the file' > "${work}/cwd/UTF8_STRING"
printf 'from the file' > "${work}/cwd/:0"
expect_eq "xclip -t value is not a file"                           "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -t UTF8_STRING)"
expect_eq "xclip -target value is not a file"                      "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -target UTF8_STRING)"
expect_eq "xclip -l value is not a file"                           "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -selection clipboard -l 1)"
expect_eq "xclip -loops value is not a file"                       "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -loops 1)"
expect_eq "xclip -d value is not a file"                           "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -d :0)"
expect_eq "xclip -display value is not a file"                     "${osc_hi}" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xclip" -display :0)"
# xsel keeps its own meanings: -d is delete, and -t and -l take values.
expect_eq "xsel -d is not an xclip display option"                 "" \
  "$(cd "${work}/cwd" && printf hi | run "${work}/xsel" -d :0)"

# A trailing option with no value must not break the loop.
expect_eq "xclip -selection with no value still copies"            "${osc_hi}" \
  "$(printf hi | run "${work}/xclip" -selection)"

expect_eq "xclip -o prints nothing"            "" "$(printf hi | run "${work}/xclip" -o)"
expect_eq "xsel -o prints nothing"             "" "$(printf hi | run "${work}/xsel" -o)"
# Real xsel copies when stdin is not a terminal, even with no -i, so the shim
# must too: "echo hi | xsel -b" is how many programs put text on the clipboard.
expect_eq "xsel with piped stdin copies"       "${osc_hi}" "$(printf hi | run "${work}/xsel")"
expect_eq "xsel -b with piped stdin copies"    "${osc_hi}" "$(printf hi | run "${work}/xsel" -b)"

# With a terminal on stdin and no flags, xsel reads the selection instead, and
# this shim cannot read one, so it must print nothing.  That needs a real
# terminal, which setsid cannot give us; script provides one.
if command -v script > /dev/null 2>&1; then
  tty_out="$(script -qec "'${work}/xsel' -b" /dev/null < /dev/null 2>/dev/null | tr -d '\r\n')"
  expect_eq "xsel -b on a terminal prints nothing" "" "${tty_out}"
else
  echo "SKIP  xsel -b on a terminal prints nothing (script is not installed)"
fi

printf hi | run "${work}/xclip" -selection clipboard > /dev/null
expect_eq "a copy exits 0" 0 $?
run "${work}/xclip" -o < /dev/null > /dev/null
expect_eq "a read exits 0" 0 $?

# Input is capped at 1 MiB: 1048576 bytes encode to 1398104 base64 characters,
# and the escape adds 7 leading and 1 trailing byte.
capped="$(head -c 2097152 /dev/zero | tr '\0' 'a' | run "${work}/xclip" -selection clipboard | wc -c)"
expect_eq "input is capped at 1 MiB" 1398112 "${capped}"

# The value the smoke test compares against, so the two cannot drift apart.
expect_eq "smoke test prefix" "G101MjtjO2FH" \
  "$(printf hi | run "${work}/xclip" -selection clipboard | base64 | cut -c1-12)"

echo
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "${fail}" -eq 0 ]
