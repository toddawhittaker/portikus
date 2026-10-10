#!/usr/bin/env bash
# Prove that scripts/publish-apt-repo.sh builds a repository apt trusts with
# the published key, that apt refuses it without the key or once Release is
# tampered with, and that retention keeps the ten newest versions of the
# current major.minor line plus the newest version of each earlier line.
# Uses a throwaway key generated here; needs gpg, apt-ftparchive and docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# apt reads file: sources as the unprivileged _apt user.
chmod 755 "$WORK"

export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
# Backdate the key: apt's verifier rejects a signature made in the same second
# as the key's creation ("No binding signature at time ...").
gpg --batch --quiet --passphrase '' --faked-system-time "$(($(date +%s) - 120))" \
  --quick-gen-key "Portikus test <test@invalid>" ed25519 sign never
APT_SIGNING_KEY="$(gpg --batch --armor --export-secret-keys)"
export APT_SIGNING_KEY
gpgconf --kill all
unset GNUPGHOME

make_deb() {
  local dir="$WORK/build/$1"
  mkdir -p "$dir/DEBIAN" "$dir/usr/share/portikus"
  echo "$1" > "$dir/usr/share/portikus/version"
  printf 'Package: portikus\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@invalid>\nDescription: dummy\n' "$1" > "$dir/DEBIAN/control"
  dpkg-deb --root-owner-group -b "$dir" "$WORK/portikus_$1_amd64.deb" >/dev/null
}

# Eleven versions already published, then a twelfth: the two oldest go.
mkdir -p "$WORK/repo/pool/main/p/portikus"
for v in 0.1.9 0.1.10 0.1.11 0.1.12 0.1.13 0.1.14 0.1.15 0.1.16 0.1.17 0.1.18 0.1.19; do
  make_deb "$v"
  cp "$WORK/portikus_${v}_amd64.deb" "$WORK/repo/pool/main/p/portikus/"
done
make_deb 0.1.20
"$ROOT/scripts/publish-apt-repo.sh" "$WORK/repo" "$WORK/portikus_0.1.20_amd64.deb"

count="$(find "$WORK/repo/pool" -name '*.deb' | wc -l)"
[[ "$count" == 10 ]] || { echo "FAIL: expected 10 packages, found $count" >&2; exit 1; }
[[ ! -e "$WORK/repo/pool/main/p/portikus/portikus_0.1.9_amd64.deb" ]] || { echo "FAIL: 0.1.9 was not pruned" >&2; exit 1; }
[[ ! -e "$WORK/repo/pool/main/p/portikus/portikus_0.1.10_amd64.deb" ]] || { echo "FAIL: 0.1.10 was not pruned" >&2; exit 1; }
[[ -e "$WORK/repo/pool/main/p/portikus/portikus_0.1.11_amd64.deb" ]] || { echo "FAIL: 0.1.11 was pruned" >&2; exit 1; }
for f in dists/trixie/Release dists/trixie/InRelease dists/trixie/Release.gpg portikus-archive-keyring.asc portikus-archive-keyring.gpg; do
  [[ -s "$WORK/repo/$f" ]] || { echo "FAIL: $f missing" >&2; exit 1; }
done
echo "ok: pruned to ten versions, signatures and keys written"

# Valid-Until 30 days after Date, so a mirror cannot serve a stale index forever.
release_date="$(sed -n 's/^Date: //p' "$WORK/repo/dists/trixie/Release")"
valid_until="$(sed -n 's/^Valid-Until: //p' "$WORK/repo/dists/trixie/Release")"
[[ -n "$valid_until" ]] || { echo "FAIL: Release has no Valid-Until" >&2; exit 1; }
days=$(( ($(date -d "$valid_until" +%s) - $(date -d "$release_date" +%s)) / 86400 ))
[[ "$days" == 30 ]] || { echo "FAIL: Valid-Until is $days days after Date, not 30" >&2; exit 1; }
echo "ok: Valid-Until is 30 days after Date"

# fetch-published-deb.sh takes the highest version, not the first or last
# entry in Packages, and checks the signature and both hashes.
fetch() { # REPO -- prints the version it fetched
  PORTIKUS_APT_BASE="file://$1" PORTIKUS_ARCHIVE_KEY="$1/portikus-archive-keyring.asc" \
    "$ROOT/packaging/tests/fetch-published-deb.sh" "$WORK/fetched.deb" 2>/dev/null
}
got="$(fetch "$WORK/repo")"
[[ "$got" == 0.1.20 ]] || { echo "FAIL: fetched '$got' from 0.1.11 to 0.1.20, not 0.1.20" >&2; exit 1; }
[[ "$(dpkg-deb -f "$WORK/fetched.deb" Version)" == 0.1.20 ]] || { echo "FAIL: fetched .deb is not 0.1.20" >&2; exit 1; }
mkdir -p "$WORK/nine-ten/pool/main/p/portikus"
cp "$WORK/portikus_0.1.9_amd64.deb" "$WORK/portikus_0.1.10_amd64.deb" "$WORK/nine-ten/pool/main/p/portikus/"
"$ROOT/scripts/publish-apt-repo.sh" "$WORK/nine-ten" >/dev/null
got="$(fetch "$WORK/nine-ten")"
[[ "$got" == 0.1.10 ]] || { echo "FAIL: fetched '$got' from 0.1.9 and 0.1.10, not 0.1.10" >&2; exit 1; }
cp -r "$WORK/nine-ten" "$WORK/bad-deb"
printf 'x' >>"$WORK/bad-deb/pool/main/p/portikus/portikus_0.1.10_amd64.deb"
if fetch "$WORK/bad-deb" >/dev/null; then echo "FAIL: a .deb with the wrong hash was fetched" >&2; exit 1; fi
cp -r "$WORK/nine-ten" "$WORK/bad-sig"
sed -i 's/^Label: Portikus/Label: Evil/' "$WORK/bad-sig/dists/trixie/InRelease"
if fetch "$WORK/bad-sig" >/dev/null; then echo "FAIL: a tampered InRelease was accepted" >&2; exit 1; fi
# Unsigned text before the signed block names a forged Packages; only the
# signed Release may be trusted.
cp -r "$WORK/nine-ten" "$WORK/prepended"
dist="$WORK/prepended/dists/trixie"
printf 'x' >>"$WORK/prepended/pool/main/p/portikus/portikus_0.1.10_amd64.deb"
forged_deb="$(sha256sum "$WORK/prepended/pool/main/p/portikus/portikus_0.1.10_amd64.deb" | cut -d' ' -f1)"
sed -i "/^Filename: .*portikus_0.1.10_amd64.deb/,/^\$/ s/^SHA256: .*/SHA256: $forged_deb/" "$dist/main/binary-amd64/Packages"
forged_packages="$(sha256sum "$dist/main/binary-amd64/Packages" | cut -d' ' -f1)"
{ printf 'SHA256:\n %s 1 main/binary-amd64/Packages\n\n' "$forged_packages"; cat "$dist/InRelease"; } >"$WORK/InRelease.new"
mv "$WORK/InRelease.new" "$dist/InRelease"
if fetch "$WORK/prepended" >/dev/null; then echo "FAIL: unsigned text before InRelease was trusted" >&2; exit 1; fi
echo "ok: fetch-published-deb.sh takes the newest version and checks what it downloads"

# Retention cases, each in a fresh repository seeded straight into the pool.
retention_case() {
  local name="$1" expected="$2"
  shift 2
  local repo="$WORK/retention-$name" pool v kept
  pool="$repo/pool/main/p/portikus"
  mkdir -p "$pool"
  for v in "$@"; do
    [[ -e "$WORK/portikus_${v}_amd64.deb" ]] || make_deb "$v"
    cp "$WORK/portikus_${v}_amd64.deb" "$pool/"
  done
  "$ROOT/scripts/publish-apt-repo.sh" "$repo" >/dev/null
  kept="$(find "$pool" -name '*.deb' -printf '%f\n' | sed 's/^portikus_//; s/_amd64\.deb$//' | sort -V | tr '\n' ' ')"
  [[ "$kept" == "$expected " ]] || { echo "FAIL: $name kept '$kept', expected '$expected'" >&2; exit 1; }
  echo "ok: retention $name"
}
retention_case fewer-than-ten "0.1.1 0.1.2 0.1.3" 0.1.3 0.1.1 0.1.2
retention_case two-lines \
  "0.1.12 0.2.3 0.2.4 0.2.5 0.2.6 0.2.7 0.2.8 0.2.9 0.2.10 0.2.11 0.2.12" \
  0.1.9 0.1.10 0.1.11 0.1.12 0.2.1 0.2.2 0.2.3 0.2.4 0.2.5 0.2.6 0.2.7 0.2.8 0.2.9 0.2.10 0.2.11 0.2.12
retention_case three-lines \
  "0.1.12 0.2.12 1.0.1 1.0.2 1.0.3" \
  0.1.11 0.1.12 0.2.11 0.2.12 1.0.1 1.0.2 1.0.3
retention_case build-suffix \
  "0.1.676+g83ee824 0.2.1+gaaaaaaa" \
  0.1.675+g1111111 0.1.676+g83ee824 0.2.1+gaaaaaaa

cp -r "$WORK/repo" "$WORK/tampered"
sed -i 's/^Label: Portikus/Label: Evil/' "$WORK/tampered/dists/trixie/Release" "$WORK/tampered/dists/trixie/InRelease"

docker run --rm -i -v "$WORK:/w:ro" mirror.gcr.io/library/debian:trixie bash -euo pipefail <<'INNER'
export DEBIAN_FRONTEND=noninteractive
rm -f /etc/apt/sources.list.d/*
cp /w/repo/portikus-archive-keyring.gpg /usr/share/keyrings/
echo "deb [signed-by=/usr/share/keyrings/portikus-archive-keyring.gpg] file:/w/repo trixie main" > /etc/apt/sources.list.d/portikus.list
apt-get update -o APT::Update::Error-Mode=any >/tmp/out 2>&1 || { cat /tmp/out; echo "FAIL: signed repo refused"; exit 1; }
apt-get install -y portikus >/dev/null
[ "$(cat /usr/share/portikus/version)" = 0.1.20 ] || { echo "FAIL: wrong version installed"; exit 1; }
echo "ok: apt update and apt install portikus (0.1.20) with the published key"

echo "deb [signed-by=/usr/share/keyrings/portikus-archive-keyring.gpg] file:/w/tampered trixie main" > /etc/apt/sources.list.d/portikus.list
rm -rf /var/lib/apt/lists/*
if apt-get update -o APT::Update::Error-Mode=any >/tmp/out 2>&1; then cat /tmp/out; echo "FAIL: tampered Release accepted"; exit 1; fi
grep -qiE "signature|not signed|BADSIG" /tmp/out || { cat /tmp/out; echo "FAIL: unexpected error"; exit 1; }
echo "ok: tampered Release and InRelease refused"

echo "deb file:/w/repo trixie main" > /etc/apt/sources.list.d/portikus.list
rm -f /usr/share/keyrings/portikus-archive-keyring.gpg
rm -rf /var/lib/apt/lists/*
if apt-get update -o APT::Update::Error-Mode=any >/tmp/out 2>&1; then cat /tmp/out; echo "FAIL: repo accepted without the key"; exit 1; fi
echo "ok: repository refused without the key"
INNER
echo "PASS"
