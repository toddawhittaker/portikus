#!/usr/bin/env bash
# Tests the claude and codex shell functions in the workspace image's
# /etc/profile.d/portikus-agents.sh: typed by hand in a
# terminal they clear it first, and scripts and pipes get the plain command.
# The file is embedded in the image definition, so the test extracts it and
# runs it with stand-ins for clear, claude and codex.  Needs no VM.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

if ! command -v script > /dev/null 2>&1; then
  echo "error: script (util-linux) is needed to give the shell a terminal" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

image_file /etc/profile.d/portikus-agents.sh > "${work}/profile.sh"

if ! grep -q 'command claude' "${work}/profile.sh"; then
  echo "error: could not extract portikus-agents.sh from portikus.yaml" >&2
  exit 1
fi

# Stand-ins: clear leaves a mark, each agent prints its arguments and exits 7.
mkdir "${work}/bin"
printf '#!/bin/sh\necho cleared >> "%s/cleared"\n' "${work}" > "${work}/bin/clear"
for agent in claude codex; do
  printf '#!/bin/sh\necho "%s:$*"\nexit 7\n' "${agent}" > "${work}/bin/${agent}"
done
chmod +x "${work}/bin/"*
export PATH="${work}/bin:${PATH}"

# Runs LINE in bash with the profile loaded, and prints what it wrote and
# whether clear ran.  MODE is tty (interactive on a terminal), notty
# (interactive, no terminal) or script (not interactive).
run() { # MODE LINE
  rm -f "${work}/cleared"
  local inner=". '${work}/profile.sh'; $2; echo \"status=\$?\""
  local out
  case "$1" in
    tty) out="$(script -qec "bash --norc --noprofile -i -c $(printf '%q' "${inner}")" /dev/null < /dev/null 2>/dev/null)" ;;
    notty) out="$(bash --norc --noprofile -i -c "${inner}" < /dev/null 2>/dev/null)" ;;
    script) out="$(bash --norc --noprofile -c "${inner}" < /dev/null 2>/dev/null)" ;;
  esac
  out="$(printf '%s' "${out}" | tr -d '\r' | grep -E '^(claude|codex|status|type)' | tr '\n' ' ')"
  if [ -e "${work}/cleared" ]; then out="${out}cleared"; else out="${out}kept"; fi
  printf '%s' "${out}"
}

expect_eq "claude typed on a terminal clears first and passes arguments" \
  "claude:-p hi there status=7 cleared" "$(run tty 'claude -p "hi there"')"
expect_eq "codex typed on a terminal clears first" \
  "codex:resume status=7 cleared" "$(run tty 'codex resume')"
expect_eq "claude piped keeps the scrollback" \
  "claude:--version status=0 kept" "$(run notty 'claude --version | cat')"
expect_eq "a script runs the plain claude" \
  "claude:--version status=7 kept" "$(run script 'claude --version')"
# shellcheck disable=SC2016  # expanded by the shell under test
expect_eq "a script sees no claude function" \
  "type=file status=0 kept" "$(run script 'echo type=$(type -t claude)')"
expect_eq "a plain command on a terminal keeps the scrollback" \
  "status=0 kept" "$(run tty 'true')"

# /bin/sh also reads profile.d in a login shell; it must load cleanly and
# define nothing.
sh_out="$(sh -c ". '${work}/profile.sh'; command -v claude" 2>&1)"
expect_eq "sh loads the file and keeps the plain claude" "${work}/bin/claude" "${sh_out}"

echo
echo "--- Results: ${pass} passed, ${fail} failed ---"
[ "${fail}" -eq 0 ]
