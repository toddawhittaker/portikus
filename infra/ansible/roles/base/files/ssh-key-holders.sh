#!/usr/bin/env bash
# Prints each named account that has at least one SSH public key in its
# authorized keys files, one per line.  Setup refuses to turn off password
# sign-in when it prints nothing, so the operator is never locked out.
#
#   ssh-key-holders.sh 'PATTERNS' ACCOUNT...
#
# PATTERNS is sshd's AuthorizedKeysFile list as `sshd -T` prints it: paths
# separated by spaces, relative ones under the account's home, with %h, %u
# and %% expanded as sshd does.  An unknown account is skipped.
set -euo pipefail

patterns="$1"
shift

# A key line, with or without options in front of it (sshd(8), "AUTHORIZED_KEYS FILE FORMAT").
key_re='(^|[[:space:]])(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[[:space:]]+AAAA'

for account in "$@"; do
  entry="$(getent passwd "${account}")" || continue
  home="$(cut -d: -f6 <<<"${entry}")"
  for pattern in ${patterns}; do
    [ "${pattern}" = none ] && continue
    path="${pattern//%%/$'\x01'}"
    path="${path//%h/${home}}"
    path="${path//%u/${account}}"
    path="${path//$'\x01'/%}"
    [ "${path#/}" = "${path}" ] && path="${home}/${path}"
    if grep -qE "${key_re}" "${path}" 2>/dev/null; then
      echo "${account}"
      break
    fi
  done
done
