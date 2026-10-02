#!/usr/bin/env bash
# Shared helpers for the shell tests under infra/tests.  Sourcing this file
# sets the pass and fail counters and defines functions, nothing else.
#
#   ok LABEL                          a PASS line
#   bad LABEL                         a FAIL line
#   check LABEL CMD...                PASS when CMD succeeds; its output is dropped
#   check_output LABEL EXPECTED CMD...  PASS when CMD prints EXPECTED
#   expect_eq LABEL EXPECTED ACTUAL   PASS when the two are equal, else both shown
#   image_file PATH                   a file's content from the workspace image definition
# Callers print their own summary from $pass and $fail.
# shellcheck disable=SC2034  # the counters are read by the scripts that source this

pass=0
fail=0

ok() { printf '\033[1;32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '\033[1;31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}

check_output() {
  local label="$1" expected="$2" actual; shift 2
  actual=$("$@" 2>/dev/null) || true
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    bad "$label (got: ${actual})"
  fi
}

expect_eq() { # LABEL EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    bad "$1"
    printf '      expected: %q\n      actual:   %q\n' "$2" "$3"
  fi
}

# The block scalar under the "- path: PATH" entry of portikus.yaml, with its
# four spaces of indentation removed.  Prints nothing when there is no entry.
image_file() {
  awk -v want="- path: $1" '
    $0 == want { found = 1; next }
    found && $0 == "  content: |-" { body = 1; next }
    body && $0 == "" { print ""; next }
    body && /^    / { sub(/^    /, ""); print; next }
    body { exit }
  ' "$(dirname "${BASH_SOURCE[0]}")/../workspace-image/portikus.yaml"
}
