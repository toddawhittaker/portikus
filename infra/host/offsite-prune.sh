#!/bin/sh
# Runs on the machine that holds a Portikus server's off-site copies, from
# that machine's own cron or timer, as the account the server copies into
# (SPEC.md section 24.9, ADR 0044).  The server may only add files to
# DIR/incoming; this script alone moves and removes sets, so a server that
# is broken into cannot wipe the copies.
#
# Usage: portikus-offsite-prune DIR [KEEP]
#
# Each run:
#   - moves every set in DIR/incoming that has its <set>.done marker into
#     DIR.  A set already in DIR is never replaced: the second copy is
#     dropped.  So is a set dated more than a day ahead of this clock,
#     which would otherwise never age out;
#   - drops sets in DIR/incoming that never finished and are more than
#     KEEP days old;
#   - removes a set from DIR only when it is more than KEEP days old and
#     KEEP newer sets are there.  A flood of new sets therefore cannot push
#     out recent ones, and a server that stops sending leaves the last KEEP
#     sets in place.
# KEEP defaults to 7.  Nothing but set folders and their markers is touched.
set -eu

die() { printf 'portikus-offsite-prune: %s\n' "$*" >&2; exit 1; }

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
num() { printf '%s' "$1" | tr -d TZ; }
is_set() { printf '%s\n' "$1" | grep -Eqx '[0-9]{8}T[0-9]{6}Z'; }
# A real folder, not a symlink the server left to point elsewhere.
is_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }

for marker in "${dir}"/incoming/*.done; do
  [ -e "$marker" ] || [ -L "$marker" ] || continue
  name=$(basename "$marker" .done)
  rm -f -- "$marker"
  is_set "$name" || continue
  is_dir "${dir}/incoming/${name}" || continue
  if [ -e "${dir}/${name}" ] || [ -L "${dir}/${name}" ]; then
    echo "dropping a second copy of ${name}; the first is kept"
    rm -rf -- "${dir}/incoming/${name}"
  elif [ "$(num "$name")" -gt "$ahead" ]; then
    echo "dropping ${name}: it is dated in the future"
    rm -rf -- "${dir}/incoming/${name}"
  else
    mv -- "${dir}/incoming/${name}" "${dir}/${name}"
    # Read-only, so a slip on this machine does not change it either.
    chmod -R a-w -- "${dir}/${name}"
    echo "added ${name}"
  fi
done

for d in "${dir}"/incoming/*; do
  name=$(basename "$d")
  if is_set "$name" && is_dir "$d" && [ "$(num "$name")" -lt "$cutoff" ]; then
    echo "dropping ${name}: it never finished arriving"
    rm -rf -- "$d"
  fi
done

newer=0
for d in $(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -Ex '[0-9]{8}T[0-9]{6}Z' | sort -r); do
  if [ "$newer" -ge "$keep" ] && [ "$(num "$d")" -lt "$cutoff" ]; then
    echo "removing ${d}"
    chmod -R u+w -- "${dir}/${d}"
    rm -rf -- "${dir:?}/${d}"
  fi
  newer=$((newer + 1))
done
