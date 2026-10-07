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
#   - the target's prune moves finished sets in, at most one per UTC day,
#     drops future-dated and stale unfinished ones, removes a set only when
#     it is old and KEEP newer ones are there, so a flood of junk cannot
#     push out genuine copies faster than a day at a time, and touches
#     nothing else;
#   - when incoming takes more than twice the disk of the median kept set
#     (at least 1 GiB), holds more than 100,000 entries, or cannot be
#     measured, everything there is removed, finished sets waiting their
#     day, mode-000 folders and hidden or oddly named entries included,
#     without following a symlink, and a warning goes to stderr; one huge
#     kept set does not raise the limit, and keeping it warns too;
#   - the newest unfinished set named for the last day, while it changed
#     in the last 2 hours, is left out of that limit and only warned about,
#     as is every set before the first is kept; a second recent set and one stalled for over 2
#     hours or named over an hour ahead count as usual, junk is still
#     removed, and an unfinished set dated over a day ahead is dropped;
#   - a finished set holding hard links is not kept, and mode-000 folders
#     inside a kept set or an old one being removed do not stop the run.
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
  chmod -R u+rwX "$work" 2>/dev/null
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
# Seven finished sets from today at once, the flood a broken-into server
# could send.  Fixed times keep them on one UTC day whenever this runs.
today=$(date -u +%Y%m%d)
flood=()
for i in 1 2 3 4 5 6 7; do
  s="${today}T00000${i}Z"
  flood+=("$s")
  mkdir "${incoming}/${s}"
  : >"${incoming}/${s}.done"
done
# A second set for a day already kept, more than a day old.
late="${old:0:8}T235959Z"
mkdir "${incoming}/${late}"
: >"${incoming}/${late}.done"
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
check "only the first set of the flood moved in" test -d "${target}/${flood[0]}"
waiting=$(for s in "${flood[@]:1}"; do printf '%s\n%s.done\n' "$s" "$s"; done)
expect_eq "the rest of the flood waits in incoming; a stale unfinished set is dropped, a fresh one waits" \
  "$(printf '%s\n%s\n' "$fresh" "$waiting" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" "$(listing "$incoming")"
check "a later set from a kept day is dropped once a day old" \
  bash -c "test ! -e '${target}/${late}' && grep -q 'dropping ${late}: a set from that day is already kept' <<<'${out}'"
check "the sets from the last 3 days stay" \
  bash -c "test -d '${target}/${old}' && test -d '${target}/${newest}'"
check "sets older than 3 days with 3 newer ones are removed" \
  bash -c "test ! -e '${target}/$(stamp '-30 days')' && test ! -e '${target}/$(stamp '-10 days')'"
check "a future-dated set is dropped" test ! -e "${target}/${future}"
sh "$prune" "$target" 3 >/dev/null
check "a second run still adds none of the rest of the flood" \
  bash -c "test -d '${incoming}/${flood[1]}' && test ! -e '${target}/${flood[1]}'"
check "other names in the folder are untouched" \
  bash -c "test -f '${target}/notes.txt' && test -d '${target}/20260801T023000Z.old'"
check "nothing outside the folder is touched" test -d "${work}/target/20260101T000000Z"
# With no new sets arriving, old ones are kept rather than aged out.
quiet="${work}/quiet"
mkdir -p "${quiet}/incoming" "${quiet}/$(stamp '-40 days')" "${quiet}/$(stamp '-50 days')"
sh "$prune" "$quiet" 3 >/dev/null
expect_eq "fewer than KEEP sets: none is removed, however old" 2 "$(find "$quiet" -mindepth 1 -maxdepth 1 -name '2*' | wc -l)"
# Junk from a broken-into server pushes out genuine copies only one day at
# a time: they stay until KEEP newer sets have been accepted.
burst="${work}/burst"
g1=$(stamp '-5 days') g2=$(stamp '-4 days')
mkdir -p "${burst}/incoming" "${burst}/${g1}" "${burst}/${g2}"
junk() { # DAY-EXPRESSION COUNT -- COUNT finished sets dated on one day.
  local day i
  day=$(date -u -d "$1" +%Y%m%d)
  for i in $(seq "$2"); do
    mkdir "${burst}/incoming/${day}T00000${i}Z"
    : >"${burst}/incoming/${day}T00000${i}Z.done"
  done
}
kept() { find "$burst" -mindepth 1 -maxdepth 1 -name '2*' -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }
junk now 7
sh "$prune" "$burst" 3 >/dev/null
expect_eq "a burst of 7 sets in one day: one is accepted, the genuine copies stay" \
  "${g1} ${g2} ${today}T000001Z" "$(kept)"
junk '-1 day' 3
sh "$prune" "$burst" 3 >/dev/null
expect_eq "a second day of junk: one more is accepted; only the copy with 3 newer sets goes" \
  "${g2} $(date -u -d '-1 day' +%Y%m%d)T000001Z ${today}T000001Z" "$(kept)"
expect_eq "the rest of the older burst is dropped from incoming" "" \
  "$(find "${burst}/incoming" -name "$(date -u -d '-1 day' +%Y%m%d)T*" -printf x)"
junk '-2 days' 1
sh "$prune" "$burst" 3 >/dev/null
expect_eq "with 3 newer sets accepted, the last genuine copy goes" \
  "$(date -u -d '-2 days' +%Y%m%d)T000001Z $(date -u -d '-1 day' +%Y%m%d)T000001Z ${today}T000001Z" "$(kept)"

echo "== the quota on incoming"
quota="${work}/quota"
inq="${quota}/incoming"
outside="${work}/outside"
mkdir -p "$inq" "${outside}/inner"
echo precious >"${outside}/inner/file"
yesterday=$(stamp '-1 day')
for s in "$(stamp '-3 days')" "$(stamp '-2 days')" "$yesterday"; do
  mkdir "${quota}/${s}"
  echo small >"${quota}/${s}/home.age"
done
# A huge set the server got finished on a new day, to inflate the limit.
huge="${today}T000001Z"
mkdir "${inq}/${huge}"
fallocate -l 600M "${inq}/${huge}/home.age"
: >"${inq}/${huge}.done"
# A second set from today waits in incoming with its marker.
waits="${today}T000002Z"
mkdir "${inq}/${waits}"
echo small >"${inq}/${waits}/home.age"
: >"${inq}/${waits}.done"
fresh_unfinished=$(stamp '-1 minute')
mkdir "${inq}/${fresh_unfinished}" "${inq}/odd name" "${inq}/.hidden" "${inq}/${today}T000003Z.done" "${inq}/ro"
echo x >"${inq}/ro/file"
chmod 0500 "${inq}/ro"
echo x >"${inq}/junk"
ln -s "$outside" "${inq}/link"
ln -s "$outside" "${inq}/$(stamp '-3 hours')"
: >"${inq}/$(stamp '-3 hours').done"
quota_listing() { listing "$inq"; }
sh "$prune" "$quota" 3 >"${work}/quota.out" 2>"${work}/quota.err"
expect_eq "prune with junk under the limit succeeds" 0 "$?"
check "a huge new set is kept" test -d "${quota}/${huge}"
check "and keeping it warns on stderr" grep -q "${huge} uses .* more than twice the median" "${work}/quota.err"
check "under the limit, nothing warns about incoming" bash -c "! grep -q 'over its limit' '${work}/quota.err'"
check "under the limit, the junk and the fresh unfinished set stay" \
  bash -c "test -f '${inq}/junk' && test -d '${inq}/odd name' && test -d '${inq}/${fresh_unfinished}'"
# Twice the largest kept set would allow this; twice the median does not.
fallocate -l 1100M "${inq}/junk"
sh "$prune" "$quota" 3 >"${work}/quota.out" 2>"${work}/quota.err"
expect_eq "prune over the limit succeeds" 0 "$?"
check "over the limit warns on stderr" grep -q "emptying .*incoming: it uses .* over its limit of 1048576 KiB" "${work}/quota.err"
expect_eq "incoming is emptied but for the set still uploading, the finished set waiting its day included" "$fresh_unfinished" "$(quota_listing)"
check "the symlinks were not followed" test -f "${outside}/inner/file"
check "the kept sets are untouched" bash -c "test -d '${quota}/${huge}' && test -d '${quota}/${yesterday}'"
check "nothing warns on a second run" bash -c "sh '${prune}' '${quota}' 3 2>&1 >/dev/null | grep -c . | grep -qx 0"
# Many finished sets from one day, each small, together over the limit.
for i in $(seq 10 21); do
  mkdir "${inq}/${today}T0000${i}Z"
  fallocate -l 100M "${inq}/${today}T0000${i}Z/home.age"
  : >"${inq}/${today}T0000${i}Z.done"
done
sh "$prune" "$quota" 3 >"${work}/quota.out" 2>"${work}/quota.err"
expect_eq "prune with many finished same-day sets succeeds" 0 "$?"
check "and warns that incoming is over its limit" grep -q "over its limit" "${work}/quota.err"
expect_eq "none of them is kept and incoming is emptied but for the set still uploading" "$fresh_unfinished" "$(quota_listing)"
check "no new set moved in" test ! -e "${quota}/${today}T000010Z"
chmod -R u+rwX "$quota"
rm -rf "$quota"
# A mode-000 folder hides its size from du; that counts as over the limit.
locked="${work}/locked"
mkdir -p "${locked}/incoming/hidden"
fallocate -l 1100M "${locked}/incoming/hidden/big"
chmod 000 "${locked}/incoming/hidden"
sh "$prune" "$locked" 3 >/dev/null 2>"${work}/locked.err"
expect_eq "prune with an unreadable folder in incoming succeeds" 0 "$?"
check "and warns that it is emptying incoming" grep -q "emptying" "${work}/locked.err"
expect_eq "and the folder is removed" "" "$(listing "${locked}/incoming")"
rm -rf "$locked"
# Many empty files take no blocks but use up the target's inodes.
many="${work}/many"
mkdir -p "${many}/incoming/files"
(cd "${many}/incoming/files" && seq 100005 | xargs touch)
sh "$prune" "$many" 3 >/dev/null 2>"${work}/many.err"
expect_eq "prune with 100,005 empty files in incoming succeeds" 0 "$?"
check "and warns about the entry count" grep -q "entries, over its limit of 100000" "${work}/many.err"
expect_eq "and incoming is emptied" "" "$(listing "${many}/incoming")"
rm -rf "$many"

echo "== a set still uploading"
# A first set over the 1 GiB floor, with no kept set to size it by.
first="${work}/first set"
big1=$(stamp '-20 minutes')
mkdir -p "${first}/incoming/${big1}"
fallocate -l 1100M "${first}/incoming/${big1}/home.age"
for run in 1 2 3; do
  sh "$prune" "$first" 3 >/dev/null 2>"${work}/first.err"
  expect_eq "run ${run}: prune with a large first set uploading succeeds" 0 "$?"
  check "run ${run}: the large first set survives" test -f "${first}/incoming/${big1}/home.age"
done
check "and no run warns about it while no set is kept" bash -c "! grep -q 'still uploading' '${work}/first.err'"
fallocate -l 1100M "${first}/incoming/junk"
sh "$prune" "$first" 3 >/dev/null 2>"${work}/first.err"
check "junk beside it over the floor is removed" test ! -e "${first}/incoming/junk"
check "and the set is not" test -f "${first}/incoming/${big1}/home.age"
: >"${first}/incoming/${big1}.done"
sh "$prune" "$first" 3 >/dev/null 2>&1
check "once finished, the first set is kept" test -f "${first}/${big1}/home.age"
chmod -R u+rwX "$first"
rm -rf "$first"
# With kept sets, only the newest unfinished set that is still changing is spared.
up="${work}/up dir"
mkdir -p "${up}/incoming"
for s in "$(stamp '-3 days')" "$(stamp '-2 days')" "$(stamp '-1 day')"; do
  mkdir "${up}/${s}"
  echo small >"${up}/${s}/home.age"
done
second=$(stamp '-30 minutes')
newest_up=$(stamp '-10 minutes')
mkdir "${up}/incoming/${newest_up}"
fallocate -l 1100M "${up}/incoming/${newest_up}/home.age"
sh "$prune" "$up" 3 >/dev/null 2>"${work}/up.err"
expect_eq "prune with a large set uploading beside kept sets succeeds" 0 "$?"
check "the uploading set survives" test -f "${up}/incoming/${newest_up}/home.age"
check "and the run warns that it is four times the median" grep -q "${newest_up} is still uploading" "${work}/up.err"
check "and does not empty incoming" bash -c "! grep -q emptying '${work}/up.err'"
mkdir "${up}/incoming/${second}"
fallocate -l 1100M "${up}/incoming/${second}/home.age"
sh "$prune" "$up" 3 >/dev/null 2>"${work}/up.err"
check "a second recently written set is not spared and goes over the limit" \
  bash -c "test ! -e '${up}/incoming/${second}' && grep -q 'emptying' '${work}/up.err'"
check "the newest one still survives" test -f "${up}/incoming/${newest_up}/home.age"
# A folder named ahead of the clock, kept touched, as a broken-into server could.
ahead_up=$(stamp '+3 hours')
mkdir "${up}/incoming/${ahead_up}" "${up}/incoming/99991231T000000Z"
fallocate -l 1100M "${up}/incoming/${ahead_up}/home.age"
sh "$prune" "$up" 3 >"${work}/up.out" 2>"${work}/up.err"
check "an unfinished set dated over a day ahead is dropped" \
  bash -c "test ! -e '${up}/incoming/99991231T000000Z' && grep -q 'dropping 99991231T000000Z: it is dated in the future' '${work}/up.out'"
check "a set named over an hour ahead is not spared and goes over the limit" \
  bash -c "test ! -e '${up}/incoming/${ahead_up}' && grep -q 'emptying' '${work}/up.err'"
check "the genuine newest set is still spared" test -f "${up}/incoming/${newest_up}/home.age"
# Three hours on, the newest set has not changed for over 2 hours.
mkdir "${work}/later"
real_date=$(command -v date)
cat >"${work}/later/date" <<EOF
#!/usr/bin/env bash
a=("\$@")
for i in "\${!a[@]}"; do
  if [ "\${a[i]}" = -d ]; then a[i+1]="\${a[i+1]} +3 hours"; exec ${real_date} "\${a[@]}"; fi
done
exec ${real_date} -d '+3 hours' "\$@"
EOF
chmod +x "${work}/later/date"
PATH="${work}/later:${PATH}" sh "$prune" "$up" 3 >/dev/null 2>"${work}/up.err"
expect_eq "prune with a stalled set succeeds" 0 "$?"
check "a set stalled for over 2 hours is removed when over the limit" \
  bash -c "test ! -e '${up}/incoming/${newest_up}' && grep -q 'emptying' '${work}/up.err'"
rm -rf "$up"
# Hard links and mode-000 folders inside finished and old sets.
odd="${work}/odd"
opened=$(stamp '-2 days')
linked=$(stamp '-3 days')
mkdir -p "${odd}/incoming/${opened}/locked" "${odd}/incoming/${linked}"
echo x >"${odd}/incoming/${opened}/locked/file"
chmod 000 "${odd}/incoming/${opened}/locked"
echo x >"${odd}/incoming/${linked}/a"
ln "${odd}/incoming/${linked}/a" "${odd}/incoming/${linked}/b"
: >"${odd}/incoming/${opened}.done"
: >"${odd}/incoming/${linked}.done"
sh "$prune" "$odd" 3 >/dev/null 2>"${work}/odd.err"
expect_eq "prune with mode-000 folders and hard links in finished sets succeeds" 0 "$?"
check "a set with a mode-000 folder is kept, readable and read-only" \
  bash -c "test -r '${odd}/${opened}/locked/file' && test ! -w '${odd}/${opened}/locked'"
check "a set with hard links is not kept" test ! -e "${odd}/${linked}"
check "and dropping it warns" grep -q "dropping ${linked}: it holds hard-linked" "${work}/odd.err"
expect_eq "and incoming is empty" "" "$(listing "${odd}/incoming")"
aged=$(stamp '-10 days')
mkdir -p "${odd}/${aged}/locked"
chmod 000 "${odd}/${aged}/locked"
sh "$prune" "$odd" 1 >/dev/null
expect_eq "prune removing an old set with a mode-000 folder succeeds" 0 "$?"
check "and the old set is gone" test ! -e "${odd}/${aged}"
chmod -R u+rwX "$odd"
rm -rf "$odd"

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
