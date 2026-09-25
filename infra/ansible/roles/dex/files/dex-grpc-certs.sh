#!/usr/bin/env bash
# The certificates for Dex's gRPC API (docs/archive/epics/EPIC-14.md ruling 20): a small
# certificate authority, a server certificate for 127.0.0.1 that Dex serves,
# and a client certificate the API presents.  Dex accepts only clients the
# authority signed.  Safe to repeat: it issues nothing while every file is
# there and more than RENEW_DAYS from expiry, and prints "changed" otherwise.
#
# Usage: dex-grpc-certs.sh DIR RENEW_DAYS DEX_GROUP API_GROUP
set -euo pipefail

dir=$1 renew_days=$2 dex_group=$3 api_group=$4
days=825
umask 077
mkdir -p "$dir"
chmod 0755 "$dir"
cd "$dir"

valid() {
  [ -s "$1" ] && openssl x509 -in "$1" -noout -checkend $((renew_days * 86400)) >/dev/null
}

# issue NAME EXTENSIONS -- a P-256 key and a certificate signed by the authority.
issue() {
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$1.key.new" -out "$1.csr" -subj "/CN=portikus-dex-$1" 2>/dev/null
  printf '%s\n' "$2" >"$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$days" -out "$1.crt.new" -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}

changed=no
if ! valid ca.crt || [ ! -s ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout ca.key -out ca.crt -days 3650 -subj "/CN=portikus-dex-grpc-ca" 2>/dev/null
  rm -f server.crt client.crt
  changed=yes
fi
if ! valid server.crt || ! valid client.crt; then
  issue server "subjectAltName=IP:127.0.0.1
extendedKeyUsage=serverAuth"
  issue client "extendedKeyUsage=clientAuth"
  for name in server client; do
    mv "$name.key.new" "$name.key"
    mv "$name.crt.new" "$name.crt"
  done
  changed=yes
fi

chown root:root ca.key ca.crt server.crt client.crt
chmod 0600 ca.key
chmod 0644 ca.crt server.crt client.crt
chown "root:${dex_group}" server.key
chmod 0640 server.key
# The API's group exists only once the package is installed; until then the
# key stays root's, and the next run hands it over.
if getent group "$api_group" >/dev/null; then
  chown "root:${api_group}" client.key
  chmod 0640 client.key
else
  chown root:root client.key
  chmod 0600 client.key
fi
[ "$changed" = no ] || echo changed
