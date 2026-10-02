#!/usr/bin/env bash
# Tests that the pilot and rehearsal VMs have fixed MAC addresses in their
# committed variables, so a destroyed and recreated VM gets the
# same DHCP address.  Needs tofu, no VM and no state.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENVS="${REPO_ROOT}/infra/tofu/environments"

# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# mac ENV -- the default of the environment's mac_address, read from the file.
# Not `tofu console`: CI's tofu wrapper does not pass it stdin, so it hangs.
mac() {
  sed -n '/^variable "mac_address"/,/^}/s/^ *default *= *"\(.*\)"$/\1/p' "${ENVS}/$1/variables.tf"
}

pilot="$(mac dev-libvirt)"
rehearsal="$(mac rehearsal-libvirt)"

if [ "${pilot}" = "52:54:00:f6:44:35" ]; then
  ok "the pilot keeps its MAC address 52:54:00:f6:44:35"
else
  bad "the pilot's MAC address is '${pilot}', not 52:54:00:f6:44:35"
fi

if [[ "${rehearsal}" =~ ^52:54:00(:[0-9a-f]{2}){3}$ ]] && [ "${rehearsal}" != "${pilot}" ]; then
  ok "the rehearsal VM has its own fixed MAC address ${rehearsal}"
else
  bad "the rehearsal VM's MAC address is '${rehearsal}'"
fi

# An empty TF_VAR_mac_address, as the Makefile once exported after a destroy,
# must be refused rather than let libvirt pick a new address.
# Only variables.tf is copied, so no provider, libvirt or state is needed.
mkdir -p "${work}/dev-libvirt"
cp "${ENVS}/dev-libvirt/variables.tf" "${work}/dev-libvirt/"
plan_dev() {
  (cd "${work}/dev-libvirt" && TF_VAR_ssh_public_key="ssh-ed25519 test" \
    timeout 120 tofu plan -input=false -lock=false -no-color -state="${work}/none.tfstate" </dev/null 2>&1)
}
if plan_dev >/dev/null; then
  ok "the committed MAC address passes validation"
else
  bad "the committed MAC address fails validation"
fi
empty="$(TF_VAR_mac_address='' plan_dev)"
if [[ "${empty}" == *'mac_address must be'* ]]; then
  ok "an empty mac_address is refused"
else
  bad "an empty mac_address is accepted"
fi

if grep -q 'TF_VAR_mac_address' "${REPO_ROOT}/Makefile"; then
  bad "the Makefile sets TF_VAR_mac_address, which would override the fixed address"
else
  ok "the Makefile leaves the MAC address to the committed variables"
fi

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
