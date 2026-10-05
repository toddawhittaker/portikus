#!/usr/bin/env bash
# Copy the newest complete backup set off an apt-installed server, with
# rsync over SSH, to the target the operator names (SPEC.md section 24.9,
# ADR 0044).  The sets are already encrypted with age, so the target never
# needs the key.  portikus-backup-offsite.timer runs `push` as root.
#
# Usage: portikus-backup-offsite push | public-key | check
#   push        copy the newest complete set to the target, if it is not
#               there yet, then keep only the newest <keep> sets there
#   public-key  make the dedicated SSH key when there is none, and print its
#               public half for the target's authorized_keys
#   check       exit non-zero, with the reason, when the settings are invalid
#
# Settings, written by setup's backup role into <dir>/config as key=value:
#   target   user@host:path, empty when the off-site copy is off
#   port     the target's SSH port
#   keep     sets kept on the target
#   bwlimit  rsync's --bwlimit in KiB per second, 0 for none
# <dir>/known_hosts pins the target's host key; without it nothing connects.
#
# Only names of the set form, and their .partial- leftovers, are ever
# removed on the target, and only inside the configured path.
#
# Environment (for the tests; the unit sets none):
#   PORTIKUS_OFFSITE_DIR  settings and SSH key (default /etc/portikus/backup-offsite)
#   PORTIKUS_BACKUP_DIR   holds local/<set> (default /var/backups/portikus)
#   PORTIKUS_BACKUP_KEY   the age identity sets are checked with (default /etc/portikus-backup/age-key.txt)
set -euo pipefail
umask 077

here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
DIR="${PORTIKUS_OFFSITE_DIR:-/etc/portikus/backup-offsite}"
SETS="${PORTIKUS_BACKUP_DIR:-/var/backups/portikus}/local"
AGE_KEY="${PORTIKUS_BACKUP_KEY:-/etc/portikus-backup/age-key.txt}"
MAC_CMD="${here}/portikus-backup-mac"
SSH_KEY="${DIR}/id_ed25519"
KNOWN_HOSTS="${DIR}/known_hosts"
# The pinned key is looked up under this name, whatever the host and port.
HOST_ALIAS=portikus-backup-offsite
SET_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
USER_PATTERN='^[a-z_][a-z0-9_.-]{0,31}$'
HOST_PATTERN='^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$'
# No quotes, spaces or "~", so the path is safe inside single quotes on the target.
PATH_PATTERN='^[A-Za-z0-9._/+-]{1,1024}$'

info() { printf '[backup-offsite] %s\n' "$*"; }
die() { printf '[backup-offsite] FAIL: %s\n' "$*" >&2; exit 1; }

target="" port=22 keep=7 bwlimit=0 fingerprint=""
read_config() {
  local k v
  [ -r "${DIR}/config" ] || die "no settings in ${DIR}/config; run: sudo portikus setup"
  while IFS='=' read -r k v; do
    case "$k" in
      target) target=$v ;;
      port) port=$v ;;
      keep) keep=$v ;;
      bwlimit) bwlimit=$v ;;
    esac
  done <"${DIR}/config"
  [ -n "$target" ] || return 0
  if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "portikus_backup_offsite_port '${port}' is not a port number"
  fi
  if ! [[ "$keep" =~ ^[0-9]{1,3}$ ]] || [ "$keep" -lt 1 ]; then
    die "portikus_backup_offsite_keep '${keep}' must be a whole number from 1 to 999"
  fi
  [[ "$bwlimit" =~ ^[0-9]{1,9}$ ]] || die "portikus_backup_offsite_bwlimit '${bwlimit}' must be KiB per second, 0 for none"
  user=${target%%@*}
  rest=${target#*@}
  host=${rest%%:*}
  rpath=${rest#*:}
  if [ "$user" = "$target" ] || [ "$host" = "$rest" ] || ! [[ "$user" =~ $USER_PATTERN ]] \
    || ! [[ "$host" =~ $HOST_PATTERN ]] || ! [[ "$rpath" =~ $PATH_PATTERN ]]; then
    die "portikus_backup_offsite '${target}' is not user@host:path (letters, digits and . _ / + - only)"
  fi
  case "/${rpath}/" in
    */../* | */./* | //) die "portikus_backup_offsite's path must name a directory, without . or .. parts" ;;
  esac
  [[ "$rpath" != -* ]] || die "portikus_backup_offsite's path must not start with -"
  if [ -e "$KNOWN_HOSTS" ]; then
    fingerprint=$(ssh-keygen -lf "$KNOWN_HOSTS" 2>/dev/null) \
      || die "portikus_backup_offsite_host_key is not an SSH public key, such as the target's /etc/ssh/ssh_host_ed25519_key.pub"
  fi
}

ssh_opts() {
  printf '%s\n' -F /dev/null -i "$SSH_KEY" -p "$port" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=${KNOWN_HOSTS}" -o GlobalKnownHostsFile=/dev/null \
    -o "HostKeyAlias=${HOST_ALIAS}" -o UpdateHostKeys=no -o ConnectTimeout=30 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4
}

# remote CMD -- CMD in the configured path on the target.
remote() {
  local opts
  mapfile -t opts < <(ssh_opts)
  # shellcheck disable=SC2029 # the path is checked and quoted for the target's shell
  ssh "${opts[@]}" "${user}@${host}" "cd -- '${rpath}' && $1"
}

# remote_names -- the set names and .partial- leftovers in the target path.
remote_names() {
  local out
  out=$(remote 'ls -1a' | head -c 1048576) \
    || die "cannot list ${target}: check that the path exists, the key is in the target's authorized_keys, and the host key is right (journalctl -u portikus-backup-offsite.service)"
  printf '%s\n' "$out" | grep -E "^(\.partial-)?[0-9]{8}T[0-9]{6}Z$" || true
}

# newest_complete -- the newest local set that is whole and genuine.
newest_complete() {
  local s
  for s in $(find "$SETS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E "$SET_PATTERN" | sort -r); do
    [ ! -e "${SETS}/${s}/FAILED" ] || continue
    # A set copied in by hand must not push genuine ones out of the target.
    if python3 "$MAC_CMD" verify "$AGE_KEY" "${SETS}/${s}" >/dev/null 2>&1; then
      printf '%s\n' "$s"
      return 0
    fi
    info "skipping ${s}: its MAC does not verify with the installed key" >&2
  done
}

push() {
  read_config
  if [ -z "$target" ]; then
    info "off: portikus_backup_offsite is empty"
    return 0
  fi
  [ -s "$KNOWN_HOSTS" ] \
    || die "the host key of ${host} is not pinned, so nothing was copied. On the target, run: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub; set portikus_backup_offsite_host_key in /etc/portikus/portikus.yaml to the contents of that .pub file, and run: sudo portikus setup"
  [ -r "$SSH_KEY" ] || die "no SSH key at ${SSH_KEY}; run: sudo portikus setup"
  [ -r "$AGE_KEY" ] || die "no backup key at ${AGE_KEY} to check sets with"
  command -v rsync >/dev/null || die "rsync is not installed; run: sudo portikus setup"

  local newest names opts kept=0 n old=()
  newest=$(newest_complete)
  if [ -z "$newest" ]; then
    info "no complete set in ${SETS} yet; nothing to copy"
    return 0
  fi
  names=$(remote_names)
  if grep -qx "$newest" <<<"$names"; then
    info "${newest} is already on ${target}"
  else
    info "copying ${newest} to ${target}"
    mapfile -t opts < <(ssh_opts)
    # Into a .partial- folder renamed when whole, so the target never holds
    # a half set under a set's name; a later run resumes a broken copy.
    rsync -rtp --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --bwlimit="$bwlimit" --timeout=600 \
      -e "ssh ${opts[*]}" \
      "${SETS}/${newest}/" "${user}@${host}:${rpath}/.partial-${newest}/" \
      || die "rsync of ${newest} to ${target} failed; the next run resumes it"
    remote "[ ! -e '${newest}' ] && mv -- '.partial-${newest}' '${newest}'" \
      || die "could not rename .partial-${newest} to ${newest} on ${target}"
    names=$(remote_names)
  fi

  # Newest first: keep <keep> sets; every older set and every leftover goes.
  while read -r n; do
    [ -n "$n" ] || continue
    if [ "$kept" -lt "$keep" ]; then kept=$((kept + 1)); else old+=("$n"); fi
  done < <(grep -E "$SET_PATTERN" <<<"$names" | sort -r)
  while read -r n; do [ -z "$n" ] || old+=("$n"); done < <(grep -E '^\.partial-' <<<"$names" || true)
  if [ "${#old[@]}" -gt 0 ]; then
    info "removing from ${target}: ${old[*]}"
    remote "rm -rf -- $(printf "'%s' " "${old[@]}")" || die "could not remove old sets from ${target}"
  fi
  info "${target} holds ${kept} sets"
}

public_key() {
  [ -d "$DIR" ] || die "${DIR} is missing; run: sudo portikus setup"
  if [ ! -e "$SSH_KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "portikus-backup-offsite@$(hostname)" -f "$SSH_KEY" >/dev/null
  fi
  cat "${SSH_KEY}.pub"
}

case "${1:-}" in
  push) push ;;
  public-key) public_key ;;
  check)
    read_config
    [ -z "$fingerprint" ] || info "pinned host key: ${fingerprint}"
    ;;
  *) die "usage: portikus-backup-offsite push | public-key | check" ;;
esac
