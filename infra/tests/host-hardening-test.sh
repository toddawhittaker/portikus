#!/usr/bin/env bash
# Static tests of the host hardening (docs/SPEC.md sections 24.1 and 24.4):
# the SSH lock-out guard's key finder, the sshd drop-in as sshd itself reads
# it, the kernel settings, and the external port check against listeners on
# loopback.  Needs no VM and no root.  `make infra-check` runs it; the
# rehearsal VM applies the same files for real.
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
. "${REPO_ROOT}/infra/tests/lib.sh"

BASE="${REPO_ROOT}/infra/ansible/roles/base"
holders="${BASE}/files/ssh-key-holders.sh"
port_check="${REPO_ROOT}/scripts/external-port-check.sh"

work="$(mktemp -d)"
listeners=()
cleanup() {
  [ "${#listeners[@]}" -eq 0 ] || kill "${listeners[@]}" 2>/dev/null
  rm -rf "${work}"
}
trap cleanup EXIT

me="$(id -un)"
# Not a real key: the finder looks only for a key type and the AAAA that starts every key.
key='AAAAnot-a-real-key'

echo
echo "--- SSH key holders ---"
echo

mkdir -p "${work}/keys"
expect_eq "an account with no key file holds no key" "" \
  "$(bash "${holders}" "${work}/keys/%u" "${me}")"

printf '# only a comment\n\n' >"${work}/keys/${me}"
expect_eq "a file with only comments holds no key" "" \
  "$(bash "${holders}" "${work}/keys/%u" "${me}")"

printf 'from="192.0.2.1",no-pty ssh-ed25519 %s me@laptop\n' "${key}" >"${work}/keys/${me}"
expect_eq "a key with options in front counts" "${me}" \
  "$(bash "${holders}" "${work}/keys/%u" "${me}")"

printf 'ecdsa-sha2-nistp256 %s\n' "${key}" >"${work}/keys/${me}"
expect_eq "an ECDSA key counts" "${me}" \
  "$(bash "${holders}" "${work}/keys/%u" "${me}")"

expect_eq "the second file in the list is read" "${me}" \
  "$(bash "${holders}" "none ${work}/missing/%u ${work}/keys/%u" "${me}")"

expect_eq "%% stands for a literal percent sign" "" \
  "$(bash "${holders}" "${work}/keys/%%u" "${me}")"

expect_eq "an unknown account is skipped" "${me}" \
  "$(bash "${holders}" "${work}/keys/%u" no-such-account-portikus "${me}")"

echo
echo "--- sshd drop-in ---"
echo

python3 - "${BASE}/tasks/ssh.yml" "${work}/dropin.conf" "${work}/expected" <<'PY'
import sys, yaml
tasks = yaml.safe_load(open(sys.argv[1]))
copy = next(t["ansible.builtin.copy"] for t in tasks if "ansible.builtin.copy" in t)
open(sys.argv[2], "w").write(copy["content"])
check = next(t["ansible.builtin.assert"] for t in tasks if "ansible.builtin.assert" in t)
lines = [c.split("'")[1] for c in check["that"]]
open(sys.argv[3], "w").write("\n".join(lines) + "\n")
PY

for setting in "PasswordAuthentication no" "KbdInteractiveAuthentication no" \
  "PermitRootLogin prohibit-password" "MaxAuthTries 3" "LoginGraceTime 30"; do
  check "the drop-in sets ${setting}" grep -qx "${setting}" "${work}/dropin.conf"
done

# sshd parses the drop-in as its whole configuration, with a throwaway host
# key, and must print the very lines the role then asserts.
if [ -x /usr/sbin/sshd ] && command -v ssh-keygen >/dev/null; then
  ssh-keygen -q -t ed25519 -N '' -f "${work}/hostkey"
  check "sshd -t accepts the drop-in" /usr/sbin/sshd -t -f "${work}/dropin.conf" -h "${work}/hostkey"
  /usr/sbin/sshd -T -f "${work}/dropin.conf" -h "${work}/hostkey" >"${work}/effective" 2>"${work}/sshd.err"
  while read -r line; do
    check "sshd -T reports '${line}'" grep -qx "${line}" "${work}/effective"
  done <"${work}/expected"
else
  echo "SKIP  sshd is not installed here; the rehearsal VM runs sshd -t"
fi

echo
echo "--- Kernel settings ---"
echo

sysctl_file="${BASE}/files/90-portikus-hardening.conf"
for setting in "kernel.kptr_restrict = 2" "kernel.dmesg_restrict = 1" \
  "kernel.unprivileged_bpf_disabled = 1" "net.core.bpf_jit_harden = 2" \
  "kernel.yama.ptrace_scope = 1" "kernel.kexec_load_disabled = 1" \
  "fs.protected_hardlinks = 1" "fs.protected_symlinks = 1" \
  "fs.protected_fifos = 1" "fs.protected_regular = 2" "kernel.io_uring_disabled = 1"; do
  check "sets ${setting}" grep -qx "${setting}" "${sysctl_file}"
done
expect_eq "leaves user namespaces on, which every workspace needs" "" \
  "$(grep -E '^(user\.max_user_namespaces|kernel\.unprivileged_userns_clone|kernel\.apparmor_restrict_unprivileged_userns)' "${sysctl_file}")"
expect_eq "every setting says why in a comment just above it" "" \
  "$(awk '/^[a-z]/ && prev !~ /^#/ && prev !~ /^[a-z]/ {print} {prev=$0}' "${sysctl_file}")"
expect_eq "every line is a comment, blank, or key = value" "" \
  "$(grep -vE '^(#.*|[a-z0-9_.]+ = [0-9]+|)$' "${sysctl_file}")"

echo
echo "--- External port check ---"
echo

# Two listeners on loopback in a high range nothing else here uses.
listen() {
  python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); time.sleep(120)' "$1" &
  listeners+=("$!")
}
base_port=$(( 40000 + RANDOM % 20000 ))
listen "${base_port}"
listen "$(( base_port + 5 ))"
sleep 0.5
range="${base_port}-$(( base_port + 9 ))"

ALLOWED_PORTS="${base_port} $(( base_port + 5 ))" bash "${port_check}" --no-nmap --ports "${range}" 127.0.0.1 >"${work}/out"
expect_eq "passes when only allowed ports answer" "0" "$?"

ALLOWED_PORTS="${base_port}" bash "${port_check}" --no-nmap --ports "${range}" 127.0.0.1 >"${work}/out"
expect_eq "fails when another port answers" "1" "$?"
check "names the port that should not answer" grep -q "FAIL  tcp/$(( base_port + 5 )) answers" "${work}/out"

ALLOWED_PORTS="${base_port}" bash "${port_check}" --no-nmap --ports "$(( base_port + 1 ))-$(( base_port + 4 ))" 127.0.0.1 >"${work}/out"
expect_eq "fails when nothing answers, since nothing was proved" "3" "$?"

bash "${port_check}" --ports 1-x 127.0.0.1 >/dev/null 2>&1
expect_eq "refuses a bad port range" "2" "$?"
bash "${port_check}" >/dev/null 2>&1
expect_eq "refuses a missing host" "2" "$?"

echo
echo "Host hardening: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
