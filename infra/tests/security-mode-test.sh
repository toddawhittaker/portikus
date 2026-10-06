#!/usr/bin/env bash
# Checks how the security suite picks its target: a VM over SSH, or the
# platform host itself when installed straight from the package (SPEC.md
# 24.1). No VM; the host's routes are stubbed.
#
# Usage: ./infra/tests/security-mode-test.sh
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
# shellcheck source=/dev/null
. "${here}/security/lib.sh"

check_output "an address selects VM mode" "vm" sec_mode 10.100.0.120
check_output "local selects plain-host mode" "host" sec_mode local

env_file="${work}/api.env"
printf '# test\nPORT=3000\nPUBLIC_URL=https://portikus.example.org\n' >"$env_file"
check_output "PUBLIC_URL without a port gives port 443" "portikus.example.org 443" sec_public_url_parts "$env_file"
printf 'PUBLIC_URL="https://pilot.example.org:8443/"\n' >"$env_file"
check_output "PUBLIC_URL with a port and quotes gives that port" "pilot.example.org 8443" sec_public_url_parts "$env_file"
printf 'PORT=3000\n' >"$env_file"
check_output "no PUBLIC_URL gives nothing" "" sec_public_url_parts "$env_file"
check_output "a missing file gives nothing" "" sec_public_url_parts "${work}/absent"
# api.env is root:portikus 0640, and the suite runs as an operator with sudo.
if [ "$(id -u)" != 0 ]; then
  printf 'PUBLIC_URL=https://hidden.example.org\n' >"$env_file"
  chmod 000 "$env_file"
  check_output "an unreadable api.env is read through sudo" "via-sudo.example.org 443" \
    bash -c "$(declare -f sec_public_url_parts sec_read_root_file); sudo() { echo 'PUBLIC_URL=https://via-sudo.example.org'; }; sec_public_url_parts '$env_file'"
  chmod 600 "$env_file"
fi

# The package pins the site's name to loopback in /etc/hosts, which is no
# address a workspace can be tested against.
check_output "a loopback answer gives way to this host's address" "203.0.113.10" sec_site_address_or 203.0.113.10 127.0.0.1
check_output "a public answer is kept" "198.51.100.7" sec_site_address_or 203.0.113.10 198.51.100.7
check_output "no answer gives this host's address" "203.0.113.10" sec_site_address_or 203.0.113.10 ""

# sec_init in plain-host mode, with the host's route stubbed.
ip() { echo "1.1.1.1 via 203.0.113.254 dev eth0 src 203.0.113.10 uid 0"; }
printf 'PUBLIC_URL=https://portikus.example.org\n' >"$env_file"
(
  unset PORTIKUS_PUBLIC_HOST PORTIKUS_PUBLIC_PORT
  SEC_API_ENV="$env_file" sec_init local >/dev/null
  rm -rf "$SEC_LOCAL_DIR"
  echo "${SEC_MODE} ${SEC_VM} ${SEC_API}"
) >"${work}/host-init"
check_output "plain-host mode targets this host's own address and the configured site" \
  "host 203.0.113.10 https://portikus.example.org" cat "${work}/host-init"

(
  unset PORTIKUS_PUBLIC_HOST
  PORTIKUS_PUBLIC_PORT=8443 sec_init 10.100.0.120 --sweep >/dev/null
  rm -rf "$SEC_LOCAL_DIR"
  echo "${SEC_MODE} ${SEC_VM} ${SEC_SWEEP} ${SEC_API}"
) >"${work}/vm-init"
check_output "VM mode is unchanged: the address and the nip.io site name" \
  "vm 10.100.0.120 yes https://portikus.10.100.0.120.nip.io:8443" cat "${work}/vm-init"

printf 'PORT=3000\n' >"$env_file"
(
  unset PORTIKUS_PUBLIC_HOST PORTIKUS_PUBLIC_PORT
  SEC_API_ENV="$env_file" sec_init local
) >/dev/null 2>&1
check_output "plain-host mode refuses to start without a configured site" "2" echo "$?"

# In plain-host mode a command runs locally, never over SSH.
ssh() { echo "ssh was called"; }
SEC_MODE=host
check_output "plain-host sec_ssh runs the command locally" "local a b" sec_ssh "echo local" "a b"
check_output "plain-host sec_ssh_stdin passes standard input" "from stdin" \
  bash -c "$(declare -f sec_ssh_stdin); SEC_MODE=host; echo 'from stdin' | sec_ssh_stdin cat"
# The cleanup runs from an EXIT trap, where a bare return would report the
# status of the command before the trap instead of the one just run.
check_output "plain-host sec_ssh keeps a failure inside an EXIT trap" "1 1" \
  bash -c "$(declare -f sec_ssh sec_ssh_stdin); SEC_MODE=host
    t() { sec_ssh false; a=\$?; sec_ssh_stdin false </dev/null; echo \"\$a \$?\"; }
    trap t EXIT; true"
SEC_MODE=vm SEC_VM=10.100.0.120
check_output "VM mode sec_ssh still goes over SSH" "ssh was called" sec_ssh true

echo "--- security mode: ${pass} passed, ${fail} failed ---"
[ "$fail" -eq 0 ]
