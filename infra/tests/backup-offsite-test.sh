#!/usr/bin/env bash
# The off-server copy (infra/host/backup-offsite.sh, SPEC.md section 24.9),
# against a real sshd run as this account on 127.0.0.1, with real rsync, ssh
# and age.  It checks that:
#
#   - settings that are not user@host:path, or a path with quotes, "~",
#     "..", "." or a leading "-", are refused, and an empty target is off;
#   - nothing connects until the host key is pinned, and a wrong pin is
#     refused: no key is learned on first use;
#   - the newest set that is whole and has a valid MAC is copied, a newer
#     FAILED or unsigned one is not, and the copy is root-only on the target;
#   - a second run copies nothing; old sets and .partial- leftovers on the
#     target are pruned down to <keep>, and nothing else there, or outside
#     the path, is touched;
#   - public-key prints only the public half.
#
# Usage: ./infra/tests/backup-offsite-test.sh
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
offsite="${repo}/infra/host/backup-offsite.sh"
mac="${repo}/infra/host/portikus-backup-mac"
# shellcheck source=/dev/null
. "${here}/lib.sh"

for t in sshd rsync ssh-keygen age age-keygen python3; do
  command -v "$t" >/dev/null || [ -x "/usr/sbin/$t" ] || { echo "backup-offsite-test: $t is not installed"; exit 1; }
done
SSHD=$(command -v sshd || echo /usr/sbin/sshd)

work="$(mktemp -d)"
sshd_pid=""
cleanup() {
  [ -z "$sshd_pid" ] || kill "$sshd_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

conf="${work}/etc"
backups="${work}/backups"
sets="${backups}/local"
target="${work}/target/sets"
mkdir -p "$conf" "$sets" "$target" "${work}/sshd"
chmod 0700 "$conf"
key="${work}/age-key.txt"
age-keygen -o "$key" 2>/dev/null
recipient=$(age-keygen -y "$key")
export PORTIKUS_OFFSITE_DIR="$conf" PORTIKUS_BACKUP_DIR="$backups" PORTIKUS_BACKUP_KEY="$key"

# make_set NAME [unsigned|failed] -- a set as backup.sh leaves it.
make_set() {
  local d="${sets}/$1"
  mkdir -m 0700 "$d"
  printf 'created %s\n' "$1" | age -r "$recipient" -o "${d}/MANIFEST.age"
  head -c 4096 /dev/urandom >"${d}/home.age"
  case "${2:-}" in
    unsigned) ;;
    failed) python3 "$mac" sign "$key" "$d"; echo ws-x-home >"${d}/FAILED" ;;
    *) python3 "$mac" sign "$key" "$d" ;;
  esac
}

# A throwaway sshd that accepts only this account and the off-site key.
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
ssh-keygen -q -t ed25519 -N '' -f "${work}/sshd/host" >/dev/null
ssh-keygen -q -t ed25519 -N '' -f "${work}/sshd/other" >/dev/null
cat >"${work}/sshd/config" <<EOF
Port ${port}
ListenAddress 127.0.0.1
HostKey ${work}/sshd/host
PidFile ${work}/sshd/pid
AuthorizedKeysFile ${work}/sshd/authorized_keys
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
"$SSHD" -D -e -f "${work}/sshd/config" 2>"${work}/sshd/log" &
sshd_pid=$!
for _ in $(seq 50); do
  python3 -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2>/dev/null && break
  sleep 0.1
done

settings() { # TARGET [KEEP]
  printf 'target=%s\nport=%s\nkeep=%s\nbwlimit=0\n' "$1" "$port" "${2:-3}" >"${conf}/config"
}
pin() { echo "portikus-backup-offsite $(cut -d' ' -f1,2 "$1")" >"${conf}/known_hosts"; }
me=$(id -un)
good="${me}@127.0.0.1:${target}"

echo "== settings"
for bad_target in "127.0.0.1:${target}" "${me}@127.0.0.1" "${me}@127.0.0.1:${target}/../x" \
  "${me}@127.0.0.1:~/sets" "${me}@127.0.0.1:${target}'x" "${me}@127.0.0.1:-sets" \
  "${me}@127.0.0.1:${target}/./x" "${me}@bad_host:${target}" "${me}@127.0.0.1:/sets dir"; do
  settings "$bad_target"
  expect_eq "refused: ${bad_target}" 1 "$(bash "$offsite" check >/dev/null 2>&1; echo $?)"
done
settings "$good" 0
expect_eq "keep 0 is refused" 1 "$(bash "$offsite" check >/dev/null 2>&1; echo $?)"
printf 'target=%s\nport=70000\nkeep=3\nbwlimit=0\n' "$good" >"${conf}/config"
expect_eq "port 70000 is refused" 1 "$(bash "$offsite" check >/dev/null 2>&1; echo $?)"
settings "$good"
check "a good target is accepted" bash "$offsite" check
settings ""
out=$(bash "$offsite" push 2>&1)
expect_eq "an empty target is off" "0 [backup-offsite] off: portikus_backup_offsite is empty" "$? ${out}"

echo "== the key"
settings "$good"
pub=$(bash "$offsite" public-key)
check "public-key prints an ed25519 public key" grep -q '^ssh-ed25519 ' <<<"$pub"
check "public-key never prints the private key" bash -c "! grep -q PRIVATE <<<'${pub}'"
expect_eq "the private key is root-only (0600)" 600 "$(stat -c %a "${conf}/id_ed25519")"
expect_eq "public-key keeps the key it made" "$pub" "$(bash "$offsite" public-key)"
cp "${conf}/id_ed25519.pub" "${work}/sshd/authorized_keys"

make_set 20261001T023000Z
make_set 20261002T023000Z
make_set 20261003T023000Z failed
make_set 20261004T023000Z unsigned

echo "== host key pinning"
out=$(bash "$offsite" push 2>&1)
expect_eq "no pin: the push fails" 1 "$?"
check "no pin: the message says how to pin" grep -q 'not pinned' <<<"$out"
check "no pin: nothing reached the target" test -z "$(ls -A "$target")"
pin "${work}/sshd/other.pub"
check "a malformed pin is refused" bash -c "echo 'portikus-backup-offsite nonsense' >'${conf}/known_hosts'; ! bash '${offsite}' check"
pin "${work}/sshd/other.pub"
expect_eq "a wrong pin: the push fails" 1 "$(bash "$offsite" push >/dev/null 2>&1; echo $?)"
check "a wrong pin: nothing reached the target" test -z "$(ls -A "$target")"
check "a wrong pin: known_hosts learned nothing" test "$(wc -l <"${conf}/known_hosts")" = 1

echo "== the copy"
pin "${work}/sshd/host.pub"
out=$(bash "$offsite" push 2>&1)
rc=$?
expect_eq "the push succeeds" 0 "$rc"
[ "$rc" = 0 ] || printf '%s\n' "$out"
expect_eq "only the newest whole, signed set is copied" 20261002T023000Z "$(ls -A "$target")"
check "the copy is the same bytes" diff -r "${sets}/20261002T023000Z" "${target}/20261002T023000Z"
check "the copy still verifies" python3 "$mac" verify "$key" "${target}/20261002T023000Z"
expect_eq "the copied folder is 0700" 700 "$(stat -c %a "${target}/20261002T023000Z")"
expect_eq "the copied files are 0600" 600 "$(stat -c %a "${target}/20261002T023000Z/home.age")"
check "the unsigned set is named as skipped" grep -q 'skipping 20261004T023000Z' <<<"$out"

out=$(bash "$offsite" push 2>&1)
check "a second push copies nothing" grep -q 'already on' <<<"$out"

echo "== pruning"
for s in 20260901T023000Z 20260902T023000Z 20260903T023000Z 20260904T023000Z; do mkdir "${target}/${s}"; done
mkdir "${target}/.partial-20260905T023000Z"
echo keep >"${target}/notes.txt"
mkdir "${target}/20260801T023000Z.old" "${work}/target/20260101T000000Z"
make_set 20261005T023000Z
out=$(bash "$offsite" push 2>&1)
expect_eq "the push with pruning succeeds" 0 "$?"
expect_eq "the target keeps the newest three sets and everything else" \
  "20260801T023000Z.old 20260904T023000Z 20261002T023000Z 20261005T023000Z notes.txt" \
  "$(find "$target" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
check "a .partial- leftover is removed" test ! -e "${target}/.partial-20260905T023000Z"
check "nothing outside the path is touched" test -d "${work}/target/20260101T000000Z"

echo "== failures"
settings "${me}@127.0.0.1:${work}/target/missing"
make_set 20261006T023000Z
out=$(bash "$offsite" push 2>&1)
expect_eq "a missing target path fails the run" 1 "$?"
check "and says what to check" grep -q 'cannot list' <<<"$out"

echo
echo "backup-offsite-test: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
