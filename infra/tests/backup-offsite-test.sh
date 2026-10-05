#!/usr/bin/env bash
# The off-server copy (infra/host/backup-offsite.sh and offsite-prune.sh,
# SPEC.md section 24.9), against a real sshd run as this account on
# 127.0.0.1, with real rsync, rrsync, ssh and age.  It checks that:
#
#   - settings that are not user@host:path, or a path with quotes, "~",
#     "..", "." or a leading "-", are refused, and an empty target is off;
#   - public-key prints the restricted authorized_keys line and never the
#     private key;
#   - nothing connects until the host key is pinned, and a wrong pin is
#     refused: no key is learned on first use;
#   - a key that opens a shell on the target is refused before anything is
#     copied;
#   - the newest set that is whole and has a valid MAC arrives in incoming
#     with its marker, a newer FAILED or unsigned one does not, and a second
#     run sends nothing;
#   - with the server's key, nothing on the target can be listed, deleted
#     or reached outside incoming, and a second copy of a set already there
#     does not replace it;
#   - the target's prune moves finished sets in, drops future-dated and
#     stale unfinished ones, removes a set only when it is old and KEEP
#     newer ones are there, and touches nothing else.
#
# Usage: ./infra/tests/backup-offsite-test.sh
# shellcheck disable=SC2154  # pass and fail come from lib.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
offsite="${repo}/infra/host/backup-offsite.sh"
prune="${repo}/infra/host/offsite-prune.sh"
mac="${repo}/infra/host/portikus-backup-mac"
# shellcheck source=/dev/null
. "${here}/lib.sh"

for t in sshd rsync rrsync ssh-keygen age age-keygen python3; do
  command -v "$t" >/dev/null || [ -x "/usr/sbin/$t" ] || { echo "backup-offsite-test: $t is not installed"; exit 1; }
done
SSHD=$(command -v sshd || echo /usr/sbin/sshd)

work="$(mktemp -d)"
sshd_pid=""
cleanup() {
  [ -z "$sshd_pid" ] || kill "$sshd_pid" 2>/dev/null
  chmod -R u+w "$work" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

conf="${work}/etc"
backups="${work}/backups"
sets="${backups}/local"
target="${work}/target/sets"
incoming="${target}/incoming"
mkdir -p "$conf" "$sets" "$incoming" "${work}/sshd"
chmod 0700 "$conf"
key="${work}/age-key.txt"
age-keygen -o "$key" 2>/dev/null
recipient=$(age-keygen -y "$key")
export PORTIKUS_OFFSITE_DIR="$conf" PORTIKUS_OFFSITE_STATE="${work}/state" \
  PORTIKUS_BACKUP_DIR="$backups" PORTIKUS_BACKUP_KEY="$key"

# stamp DATE -- a set name for a date(1) expression, such as "-2 days".
stamp() { date -u -d "$1" +%Y%m%dT%H%M%SZ; }

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

settings() { # TARGET
  printf 'target=%s\nport=%s\nbwlimit=0\n' "$1" "$port" >"${conf}/config"
}
pin() { echo "portikus-backup-offsite $(cut -d' ' -f1,2 "$1")" >"${conf}/known_hosts"; }
listing() { find "$1" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }
me=$(id -un)
good="${me}@127.0.0.1:${target}"

echo "== settings"
for bad_target in "127.0.0.1:${target}" "${me}@127.0.0.1" "${me}@127.0.0.1:${target}/../x" \
  "${me}@127.0.0.1:~/sets" "${me}@127.0.0.1:${target}'x" "${me}@127.0.0.1:-sets" \
  "${me}@127.0.0.1:${target}/./x" "${me}@bad_host:${target}" "${me}@127.0.0.1:/sets dir"; do
  settings "$bad_target"
  expect_eq "refused: ${bad_target}" 1 "$(bash "$offsite" check >/dev/null 2>&1; echo $?)"
done
printf 'target=%s\nport=70000\nbwlimit=0\n' "$good" >"${conf}/config"
expect_eq "port 70000 is refused" 1 "$(bash "$offsite" check >/dev/null 2>&1; echo $?)"
settings "$good"
check "a good target is accepted" bash "$offsite" check
settings ""
out=$(bash "$offsite" push 2>&1)
expect_eq "an empty target is off" "0 [backup-offsite] off: portikus_backup_offsite is empty" "$? ${out}"
expect_eq "public-key needs a target" 1 "$(bash "$offsite" public-key >/dev/null 2>&1; echo $?)"

echo "== the key"
settings "${good}/"
line=$(bash "$offsite" public-key)
expect_eq "public-key prints the restricted line for <path>/incoming" \
  "restrict,command=\"rrsync -wo -no-del -munge ${incoming}\" $(cat "${conf}/id_ed25519.pub")" "$line"
check "public-key never prints the private key" bash -c "! grep -q PRIVATE <<<'${line}'"
expect_eq "the private key is root-only (0600)" 600 "$(stat -c %a "${conf}/id_ed25519")"
expect_eq "public-key keeps the key it made" "$line" "$(bash "$offsite" public-key)"
settings "$good"
# First the bare key, as an operator who skipped the restriction would add it.
cp "${conf}/id_ed25519.pub" "${work}/sshd/authorized_keys"

old=$(stamp '-2 days')
newest=$(stamp '-1 day')
make_set "$old"
make_set "$newest"
make_set "$(stamp '-12 hours')" failed
make_set "$(stamp '-6 hours')" unsigned

echo "== host key pinning"
out=$(bash "$offsite" push 2>&1)
expect_eq "no pin: the push fails" 1 "$?"
check "no pin: the message says how to pin" grep -q 'not pinned' <<<"$out"
check "no pin: nothing reached the target" test -z "$(ls -A "$incoming")"
check "a malformed pin is refused" bash -c "echo 'portikus-backup-offsite nonsense' >'${conf}/known_hosts'; ! bash '${offsite}' check"
pin "${work}/sshd/other.pub"
expect_eq "a wrong pin: the push fails" 1 "$(bash "$offsite" push >/dev/null 2>&1; echo $?)"
check "a wrong pin: nothing reached the target" test -z "$(ls -A "$incoming")"
check "a wrong pin: known_hosts learned nothing" test "$(wc -l <"${conf}/known_hosts")" = 1

echo "== an unrestricted key"
pin "${work}/sshd/host.pub"
out=$(bash "$offsite" push 2>&1)
expect_eq "a key that opens a shell: the push fails" 1 "$?"
check "and the message says to use the restricted line" grep -q 'opens a shell' <<<"$out"
check "and nothing reached the target or the home folder" \
  bash -c "test -z \"\$(ls -A '${incoming}')\" && test ! -e ~/'${newest}'"
printf '%s\n' "$line" >"${work}/sshd/authorized_keys"

echo "== the copy"
out=$(bash "$offsite" push 2>&1)
rc=$?
expect_eq "the push succeeds" 0 "$rc"
[ "$rc" = 0 ] || printf '%s\n' "$out"
expect_eq "only the newest whole, signed set arrives, with its marker" \
  "${newest} ${newest}.done" "$(listing "$incoming")"
check "the copy is the same bytes" diff -r "${sets}/${newest}" "${incoming}/${newest}"
check "the copy still verifies" python3 "$mac" verify "$key" "${incoming}/${newest}"
expect_eq "the copied folder is 0700" 700 "$(stat -c %a "${incoming}/${newest}")"
expect_eq "the copied files are 0600" 600 "$(stat -c %a "${incoming}/${newest}/home.age")"
check "the unsigned set is named as skipped" grep -q 'skipping' <<<"$out"
expect_eq "nothing outside incoming changed" incoming "$(listing "$target")"
out=$(bash "$offsite" push 2>&1)
check "a second push sends nothing" grep -q 'already sent' <<<"$out"

echo "== the target's prune"
expect_eq "prune refuses a missing incoming folder" 1 "$(sh "$prune" "${work}/target" 3 >/dev/null 2>&1; echo $?)"
expect_eq "prune refuses KEEP 0" 1 "$(sh "$prune" "$target" 0 >/dev/null 2>&1; echo $?)"
check "prune runs" sh "$prune" "$target" 3
expect_eq "the finished set moved in and its marker is gone" "${newest} incoming" "$(listing "$target")"
check "and it is read-only" test ! -w "${target}/${newest}/home.age"

echo "== what the server's key cannot do"
ssh_key=(ssh -F /dev/null -i "${conf}/id_ed25519" -p "$port" -o IdentitiesOnly=yes -o BatchMode=yes
  -o "UserKnownHostsFile=${conf}/known_hosts" -o HostKeyAlias=portikus-backup-offsite)
remote="${me}@127.0.0.1"
check "no shell: rm -rf is refused" bash -c "! $(printf '%q ' "${ssh_key[@]}") '${remote}' 'rm -rf ${target}/${newest}'"
check "no listing or reading" bash -c "! rsync -e '${ssh_key[*]}' '${remote}:' '${work}/stolen/' 2>/dev/null"
mkdir -p "${work}/empty"
check "no --delete" bash -c "! rsync -r --delete -e '${ssh_key[*]}' '${work}/empty/' '${remote}:' 2>/dev/null"
check "no .. out of incoming" bash -c "! rsync -e '${ssh_key[*]}' '${key}' '${remote}:../${newest}/home.age' 2>/dev/null"
echo forged >"${work}/forged"
rsync -e "${ssh_key[*]}" "${work}/forged" "${remote}:${target}/${newest}/home.age" 2>/dev/null
check "an absolute path to the set does not reach it" diff -r "${sets}/${newest}" "${target}/${newest}"
rm -rf "${incoming:?}"/*
# A replacement set, marked whole, as a broken-into server would send it.
mkdir -p "${work}/fake/${newest}"
echo forged >"${work}/fake/${newest}/home.age"
: >"${work}/fake/${newest}.done"
rsync -r -e "${ssh_key[*]}" "${work}/fake/" "${remote}:" 2>/dev/null
out=$(sh "$prune" "$target" 3)
check "prune drops a second copy of a set it holds" grep -q "second copy of ${newest}" <<<"$out"
check "and the first copy is untouched" diff -r "${sets}/${newest}" "${target}/${newest}"
expect_eq "and incoming is empty again" "" "$(listing "$incoming")"

echo "== pruning"
for s in "$(stamp '-30 days')" "$(stamp '-20 days')" "$(stamp '-10 days')" "$old"; do
  mkdir "${target}/${s}"
done
# Eight fresh sets at once, the flood a broken-into server could send.
flood=()
for h in 1 2 3 4 5 6 7 8; do
  s=$(stamp "-${h} minutes")
  flood+=("$s")
  mkdir "${incoming}/${s}"
  : >"${incoming}/${s}.done"
done
future=$(stamp '+3 days')
mkdir "${incoming}/${future}"
: >"${incoming}/${future}.done"
stale=$(stamp '-9 days')
fresh=$(stamp '-2 minutes 30 seconds')
mkdir "${incoming}/${stale}" "${incoming}/${fresh}"
echo keep >"${target}/notes.txt"
mkdir "${target}/20260801T023000Z.old" "${work}/target/20260101T000000Z"
out=$(sh "$prune" "$target" 3)
expect_eq "prune with a flood succeeds" 0 "$?"
check "the flood moved in" bash -c "cd '${target}' && ls -d ${flood[*]}"
check "the sets from the last 3 days stay, however many newer ones came" \
  bash -c "test -d '${target}/${old}' && test -d '${target}/${newest}'"
check "sets older than 3 days with 3 newer ones are removed" \
  bash -c "test ! -e '${target}/$(stamp '-30 days')' && test ! -e '${target}/$(stamp '-10 days')'"
check "a future-dated set is dropped" test ! -e "${target}/${future}"
expect_eq "a stale unfinished set is dropped, a fresh one waits" "$fresh" "$(listing "$incoming")"
check "other names in the folder are untouched" \
  bash -c "test -f '${target}/notes.txt' && test -d '${target}/20260801T023000Z.old'"
check "nothing outside the folder is touched" test -d "${work}/target/20260101T000000Z"
# With no new sets arriving, old ones are kept rather than aged out.
quiet="${work}/quiet"
mkdir -p "${quiet}/incoming" "${quiet}/$(stamp '-40 days')" "${quiet}/$(stamp '-50 days')"
sh "$prune" "$quiet" 3 >/dev/null
expect_eq "fewer than KEEP sets: none is removed, however old" 2 "$(find "$quiet" -mindepth 1 -maxdepth 1 -name '2*' | wc -l)"

echo "== failures"
settings "${me}@127.0.0.1:${work}/target/missing"
printf 'restrict,command="rrsync -wo -no-del -munge %s/incoming" %s\n' "${work}/target/missing" \
  "$(cat "${conf}/id_ed25519.pub")" >"${work}/sshd/authorized_keys"
rm -rf "${work}/state"
out=$(bash "$offsite" push 2>&1)
expect_eq "a missing incoming folder fails the run" 1 "$?"
check "and says what to check" grep -q 'incoming exists' <<<"$out"

echo
echo "backup-offsite-test: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
