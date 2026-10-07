#!/bin/sh
# Runs on the machine that holds a Portikus server's off-site copies, from
# that machine's own cron or timer, as the account the server copies into
# (SPEC.md section 24.9, ADR 0044).  The server may only add files to
# DIR/incoming; this script alone moves and removes sets, so a server that
# is broken into can neither delete nor replace a kept copy.
#
# Usage: portikus-offsite-prune DIR [KEEP]
#
# Each run:
#   - moves a set in DIR/incoming that has its <set>.done marker into DIR,
#     at most one set per UTC day: the first finished set of a day is kept,
#     and later ones from that day wait in incoming and are dropped once
#     they are a day old.  So a broken-into server can add at most one set
#     a day, and its junk cannot push the genuine copies out any faster.
#     A set already in DIR is never replaced: the second copy is dropped.
#     So is a set dated more than a day ahead of this clock, which would
#     otherwise never age out;
#   - drops sets in DIR/incoming that never finished and are more than
#     KEEP days old;
#   - drops a newly kept set that holds hard-linked files, which the
#     backup's rsync never makes, and warns when a newly kept set uses more
#     than twice the disk of the median kept set before it;
#   - empties incoming, finished sets waiting their day included, and
#     warns on stderr, when it uses more than twice the disk of the median
#     kept set (at least 1 GiB) or holds more than ten times its entries
#     (at least 100,000), or cannot be measured.  The median, not the
#     largest, so one huge set a broken-into server got kept cannot raise
#     the limit.  This bounds only the steady use of incoming between
#     runs: a filesystem quota on this account is the real limit on a
#     burst within the hour and on kept sets growing (docs/INSTALL.md);
#   - removes a set from DIR only when it is more than KEEP days old and
#     KEEP newer sets are there, so a server that stops sending leaves the
#     last KEEP sets in place.
# KEEP defaults to 7.  Outside incoming, nothing but set folders is touched.
set -eu
# find fails when the caller's directory is unreadable to this account.
cd /

die() { printf 'portikus-offsite-prune: %s\n' "$*" >&2; exit 1; }
warn() { printf 'portikus-offsite-prune: warning: %s\n' "$*" >&2; }

case $# in
  1 | 2) ;;
  *) die "usage: portikus-offsite-prune DIR [KEEP]" ;;
esac
dir=${1%/}
keep=${2:-7}
case "$keep" in
  '' | *[!0-9]*) die "KEEP must be a whole number of at least 1" ;;
esac
[ "$keep" -ge 1 ] || die "KEEP must be a whole number of at least 1"
[ -d "${dir}/incoming" ] || die "${dir}/incoming does not exist"

# Set names are UTC timestamps; without the T and Z they compare as numbers.
cutoff=$(date -u -d "-${keep} days" +%Y%m%d%H%M%S)
ahead=$(date -u -d '+1 day' +%Y%m%d%H%M%S)
dayago=$(date -u -d '-1 day' +%Y%m%d%H%M%S)
num() { printf '%s' "$1" | tr -d TZ; }
# A pattern, not grep, so a name with a newline in it cannot match.
is_set() {
  case "$1" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) return 0 ;;
  esac
  return 1
}
# A real folder, not a symlink the server left to point elsewhere.
is_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
# A finished set in incoming: a set folder with a plain-file marker.
is_finished() {
  is_set "${1##*/}" && is_dir "$1" && [ -f "${1}.done" ] && [ ! -L "${1}.done" ]
}
# remove PATH -- the server can send folders of mode 000, so open them
# first.  Neither command follows a symlink inside the tree, and a symlink
# at PATH itself is removed, not followed.
remove() {
  if is_dir "$1"; then
    chmod -R u+rwX -- "$1" 2>/dev/null || true
  fi
  rm -rf --one-file-system -- "$1" || warn "could not remove ${1}"
}
# kib PATH -- disk use in KiB; fails when du cannot read all of PATH.
kib() {
  _s=$(du -sxk -- "$1" 2>/dev/null) || return 1
  printf '%s\n' "${_s%%[!0-9]*}"
}
# entries PATH -- files and folders in PATH, itself included; fails like kib.
entries() {
  _n=$( (find "$1" -xdev -printf '\n' 2>/dev/null || echo fail) \
    | awk '/fail/ { f = 1 } END { print f ? "fail" : NR }')
  [ "$_n" != fail ] || return 1
  printf '%s\n' "$_n"
}
# median MEASURE -- MEASURE (kib or entries) of the median kept set; the
# lower middle of an even count, 0 with none.
median() {
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' -print \
    | while IFS= read -r d; do
        if is_set "${d##*/}"; then "$1" "$d" || true; fi
      done \
    | sort -n | awk '{ v[NR] = $1 } END { print NR ? v[int((NR + 1) / 2)] : 0 }'
}
# day_kept YYYYMMDD -- DIR already holds a set from that UTC day.
day_kept() {
  for e in "${dir}/${1}"T*Z; do
    is_set "$(basename "$e")" && is_dir "$e" && return 0
  done
  return 1
}

before=$(median kib)
for marker in "${dir}"/incoming/*.done; do
  [ -e "$marker" ] || [ -L "$marker" ] || continue
  name=${marker##*/}
  name=${name%.done}
  # Anything but a plain file is not a marker; rm -f would fail on a folder.
  if ! is_finished "${dir}/incoming/${name}"; then
    remove "$marker"
    continue
  fi
  if [ -e "${dir}/${name}" ] || [ -L "${dir}/${name}" ]; then
    echo "dropping a second copy of ${name}; the first is kept"
    remove "${dir}/incoming/${name}"
    remove "$marker"
  elif [ "$(num "$name")" -gt "$ahead" ]; then
    echo "dropping ${name}: it is dated in the future"
    remove "${dir}/incoming/${name}"
    remove "$marker"
  elif day_kept "${name%%T*}"; then
    # The marker stays, so the next run looks at it again.
    if [ "$(num "$name")" -lt "$dayago" ]; then
      echo "dropping ${name}: a set from that day is already kept"
      remove "${dir}/incoming/${name}"
      remove "$marker"
    else
      echo "not adding ${name}: a set from that day is already kept"
    fi
  else
    rm -f -- "$marker"
    mv -- "${dir}/incoming/${name}" "${dir}/${name}"
    # Open first: the server can send folders of mode 000.
    chmod -R u+rwX -- "${dir}/${name}" || warn "could not open ${name}"
    # A hard link hides disk use from du; a failed search drops the set too.
    links=$(find "${dir}/${name}" ! -type d -links +1 -print -quit 2>/dev/null) || links=unreadable
    if [ -n "$links" ]; then
      warn "dropping ${name}: it holds hard-linked or unreadable files"
      remove "${dir}/${name}"
      continue
    fi
    # Read-only, so a slip on this machine does not change it either.
    chmod -R a-w -- "${dir}/${name}" || warn "could not make ${name} read-only"
    echo "added ${name}"
    if size=$(kib "${dir}/${name}") && [ "$before" -gt 0 ] && [ "$size" -gt $((2 * before)) ]; then
      warn "${name} uses ${size} KiB, more than twice the median kept set (${before} KiB)"
    fi
  fi
done

for d in "${dir}"/incoming/*; do
  name=$(basename "$d")
  if is_set "$name" && is_dir "$d" && [ "$(num "$name")" -lt "$cutoff" ]; then
    echo "dropping ${name}: it never finished arriving"
    remove "$d"
  fi
done

max_kib=$((2 * $(median kib)))
[ "$max_kib" -ge 1048576 ] || max_kib=1048576
max_entries=$((10 * $(median entries)))
[ "$max_entries" -ge 100000 ] || max_entries=100000
over=""
# Each measurement is tried twice: rsync renaming a file mid-walk can fail one.
if ! used=$(kib "${dir}/incoming") && ! used=$(kib "${dir}/incoming"); then
  over="its disk use cannot be measured"
elif [ "$used" -gt "$max_kib" ]; then
  over="it uses ${used} KiB, over its limit of ${max_kib} KiB"
elif ! count=$(entries "${dir}/incoming") && ! count=$(entries "${dir}/incoming"); then
  over="its entries cannot be counted"
elif [ "$count" -gt "$max_entries" ]; then
  over="it holds ${count} entries, over its limit of ${max_entries}"
fi
if [ -n "$over" ]; then
  warn "emptying ${dir}/incoming: ${over}"
  # The dot patterns catch hidden names; any left unmatched fail the test below.
  for e in "${dir}"/incoming/* "${dir}"/incoming/.[!.]* "${dir}"/incoming/..?*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    remove "$e"
  done
fi

newer=0
for d in $(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -Ex '[0-9]{8}T[0-9]{6}Z' | sort -r); do
  if [ "$newer" -ge "$keep" ] && [ "$(num "$d")" -lt "$cutoff" ]; then
    echo "removing ${d}"
    chmod -R u+rwX -- "${dir}/${d}" || warn "could not open ${d}"
    rm -rf -- "${dir:?}/${d}" || warn "could not remove ${d}"
  fi
  newer=$((newer + 1))
done
