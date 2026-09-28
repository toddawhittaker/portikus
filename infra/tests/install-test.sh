#!/usr/bin/env bash
# The install test (docs/EPIC-15.md ruling 20 and task T5), on the rehearsal
# VM only.  It installs Portikus the way docs/INSTALL.md tells an operator
# to, from nothing to a claimed administrator and a green smoke test:
#
#   1. make a throwaway signing key in a temporary GNUPGHOME;
#   2. build the package from this checkout, trusting that key instead of
#      the archive key, and a second, higher version of the same contents
#      for the upgrade;
#   3. publish the first version to a local signed apt repository, and sign
#      workspace image releases and a releases.json, all served from this
#      host on the rehearsal network;
#   4. create a fresh Debian 13 rehearsal VM;
#   5. on it: fetch the key, add the repository, preseed the answers,
#      apt install portikus, and follow setup to its end;
#   6. sign in as the local administrator with /etc/portikus/admin-password,
#      choose a new password and accept the acceptable-use statement;
#   7. run the smoke test, with a full Dex sign-in as that administrator;
#   8. publish the second version, apt upgrade, follow setup again, and
#      check the keyring, the services and a sign-in;
#   9. with IMAGE_JOBS=1, the workspace image rehearsal
#      (image-job-rehearsal.py, docs/EPIC-15.md task T6);
#  10. destroy the VM.
#
# Usage: install-test.sh   (through `make install-test`)
# Environment:
#   IMAGE_JOBS=1         also run the workspace image rehearsal (about 90 min)
#   KEEP_VM=1            leave the VM running at the end, for debugging
#   INSTALL_TEST_PORT    the port this host serves on (default 8780)
#   REHEARSAL_IMAGE_DIR  incus.tar.xz, rootfs.squashfs and manifest.json of
#                        the recipe's VERSION.  Default: a cache filled once
#                        from the newest CI build of the image (gh run download).
#
# The real signing key is never read: every signature here is the throwaway
# key's, and the package built here must never be published.
set -euo pipefail

# Nested makes see only what M passes: a VM_IP from the caller could be the pilot's.
unset MAKEFLAGS MFLAGS VM_IP PORTIKUS_DEB PORTIKUS_USERS_FILE

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REHEARSAL_NAME=portikus-rehearsal
PORT="${INSTALL_TEST_PORT:-8780}"
PUBLIC_HOST=rehearsal.portikus.thewhittakers.org
ADMIN_EMAIL="admin@${PUBLIC_HOST}"
RECIPE_VERSION=$(cat "${ROOT}/infra/workspace-image/VERSION")
CACHE="${XDG_CACHE_HOME:-${HOME}/.cache}/portikus"
IMAGE_DIR="${REHEARSAL_IMAGE_DIR:-${CACHE}/rehearsal-image/${RECIPE_VERSION}}"
# Beside the image cache, so the releases can hard-link its 900 MB rootfs.
SERVE="${CACHE}/install-test-serve"
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/portikus-install-test.XXXXXX")
KEYHOME=$(mktemp -d "${TMPDIR:-/tmp}/portikus-install-test-gpg.XXXXXX")
M=(make -C "$ROOT" --no-print-directory TOFU_ENV=rehearsal-libvirt)
# The image rehearsal builds twice in the VM, so its root disk is larger than
# the rehearsal default of 20 GiB.
export TF_VAR_os_disk_size_bytes=$((64 * 1024 * 1024 * 1024))

names=() seconds=() results=()
T0=$(date +%s)
IP=""
HOST_IP=""

table() {
  echo ""
  echo "--- Install test ---"
  local i
  for i in "${!names[@]}"; do
    printf '  %-58s %6s s  %s\n' "${names[$i]}" "${seconds[$i]}" "${results[$i]}"
  done
  printf '  %-58s %6s s\n' "total" "$(($(date +%s) - T0))"
  echo "Logs: ${LOGS}"
}

# STEP NAME CMD... -- run one step into its own log, time it, stop on failure.
# The step runs in a subshell outside any condition, so errexit holds in it:
# any failed command fails the step.  It cannot set this shell's variables.
step() {
  local name="$1" start rc log
  shift
  start=$(date +%s)
  log="${LOGS}/$((${#names[@]} + 1))-${name//[^A-Za-z0-9.+-]/-}.log"
  echo "[$(date +%H:%M:%S)] ${name}..."
  set +e
  (set -e; "$@") >"$log" 2>&1
  rc=$?
  set -e
  names+=("$name")
  seconds+=("$(($(date +%s) - start))")
  if [ "$rc" -ne 0 ]; then
    results+=("FAILED")
    echo "[$(date +%H:%M:%S)] ${name} failed (exit ${rc}); the end of ${log}:"
    tail -25 "$log"
    return "$rc"
  fi
  results+=("ok")
}

finish() {
  local rc=$?
  trap - EXIT
  [ ! -s "${LOGS}/server.pid" ] || kill "$(cat "${LOGS}/server.pid")" 2>/dev/null || true
  set +e
  gpgconf --homedir "$KEYHOME" --kill all >/dev/null 2>&1
  rm -rf "$KEYHOME"
  if [ -n "${KEEP_VM:-}" ]; then
    echo "KEEP_VM is set: the rehearsal VM stays at ${IP:-<no address>}; remove it with make rehearsal-destroy."
  else
    step "destroy the rehearsal VM" destroy_vm || rc=1
    set +e
  fi
  table
  if [ "$rc" -eq 0 ]; then echo "Install test passed."; else echo "Install test FAILED."; fi
  exit "$rc"
}

# OpenTofu asks before it applies or destroys; the targets refuse any state
# that holds the pilot, so the answer is always yes here.
destroy_vm() { echo yes | "${M[@]}" rehearsal-destroy; }
create_vm() { echo yes | "${M[@]}" rehearsal-up; }

vm() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "deploy@${IP}" "$@"; }
vm_stdin() { ssh -o BatchMode=yes -o ConnectTimeout=15 "deploy@${IP}" "$@"; }

preflight() {
  command -v gh >/dev/null || { echo "gh is required to fetch the CI image"; return 1; }
  local want have
  want=$(tr -d '[:space:]v' <"${ROOT}/.nvmrc")
  have=$(node --version 2>/dev/null | sed 's/^v//; s/\..*//')
  [ "$have" = "$want" ] || { echo "node ${have:-missing} is not the .nvmrc major ${want}; run nvm use"; return 1; }
  # A VM someone kept is theirs to remove; the test starts from nothing.
  if virsh -c qemu:///system dominfo "$REHEARSAL_NAME" >/dev/null 2>&1; then
    echo "${REHEARSAL_NAME} already exists; remove it with make rehearsal-destroy first"
    return 1
  fi
}

# ── 1 to 3: key, packages, repository, image releases ─────────────

make_key() {
  chmod 700 "$KEYHOME"
  gpg --homedir "$KEYHOME" --batch --passphrase '' --quick-gen-key \
    'Portikus install test throwaway key <install-test@example.invalid>' ed25519 sign never
  gpg --homedir "$KEYHOME" --batch --armor --export >"${LOGS}/rehearsal-key.asc"
  gpg --homedir "$KEYHOME" --batch --export >"${LOGS}/rehearsal-key.gpg"
  gpg --homedir "$KEYHOME" --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }' >"${LOGS}/rehearsal-key.fpr"
  echo "throwaway key $(cat "${LOGS}/rehearsal-key.fpr")"
}

build_packages() {
  (cd "$ROOT" && PORTIKUS_ARCHIVE_KEYRING="${LOGS}/rehearsal-key.asc" bash scripts/build-deb.sh) || return
  # build-deb prunes devDependencies, which this checkout still needs.
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  local v1 v2 work
  v1=$(cat "${ROOT}/dist/deb/VERSION")
  v2="${v1}+upgrade"
  cp "${ROOT}/dist/deb/portikus_${v1}_amd64.deb" "${LOGS}/v1.deb"
  # The upgrade is the same contents under a higher version.
  work=$(mktemp -d)
  dpkg-deb -R "${LOGS}/v1.deb" "${work}/root"
  sed -i "s/^Version: .*/Version: ${v2}/" "${work}/root/DEBIAN/control"
  dpkg-deb --root-owner-group -Zxz -b "${work}/root" "${LOGS}/v2.deb"
  rm -rf "$work"
  echo "$v1" >"${LOGS}/v1.version"
  echo "$v2" >"${LOGS}/v2.version"
  # The package must trust the throwaway key, not the archive key.
  dpkg-deb --fsys-tarfile "${LOGS}/v2.deb" | tar -xO ./usr/share/keyrings/portikus-archive-keyring.gpg \
    | gpg --batch --show-keys --with-colons | awk -F: '$1 == "fpr" { print $10; exit }' \
    | grep -qx "$(cat "${LOGS}/rehearsal-key.fpr")"
}

publish() { # DEB...
  APT_SIGNING_KEY="$(gpg --homedir "$KEYHOME" --batch --armor --export-secret-keys)" \
    bash "${ROOT}/scripts/publish-apt-repo.sh" "${SERVE}/apt" "$@"
}

# The CI image of the recipe's VERSION, cached once: CI keeps it a day.
fetch_image() {
  if [ -s "${IMAGE_DIR}/rootfs.squashfs" ] && [ -s "${IMAGE_DIR}/incus.tar.xz" ] && [ -s "${IMAGE_DIR}/manifest.json" ]; then
    echo "using the image in ${IMAGE_DIR}"
  else
    [ -z "${REHEARSAL_IMAGE_DIR:-}" ] || { echo "${IMAGE_DIR} lacks the image files"; return 1; }
    local run
    run=$(gh run list -R toddawhittaker/portikus --workflow workspace-image.yml --status success \
      --limit 20 --json databaseId -q '.[].databaseId' | while read -r id; do
        gh api "repos/toddawhittaker/portikus/actions/runs/${id}/artifacts" \
          -q '.artifacts[] | select(.name == "workspace-image" and (.expired | not)) | .name' | grep -q . && { echo "$id"; break; }
      done)
    [ -n "$run" ] || { echo "no unexpired CI image artifact; give REHEARSAL_IMAGE_DIR=<dir>"; return 1; }
    rm -rf "${IMAGE_DIR}.partial"
    mkdir -p "${IMAGE_DIR}.partial"
    gh run download "$run" -R toddawhittaker/portikus -n workspace-image -D "${IMAGE_DIR}.partial"
    (cd "${IMAGE_DIR}.partial" && sha256sum -c SHA256SUMS)
    rm -rf "$IMAGE_DIR"
    mv "${IMAGE_DIR}.partial" "$IMAGE_DIR"
  fi
  python3 - "${IMAGE_DIR}/manifest.json" "$RECIPE_VERSION" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("schema") == 1 and m.get("version") == sys.argv[2], f"the cached manifest is not schema 1 for {sys.argv[2]}"
PY
}

# release VERSION [good|bad-signature|bad-checksum] -- one signed image release.
# Each version gets its own metadata, so Incus gives it its own fingerprint.
release() {
  local v="$1" kind="${2:-good}" d m
  d="${SERVE}/images/image-${v}"
  mkdir -p "$d"
  ln "${IMAGE_DIR}/rootfs.squashfs" "${d}/rootfs.squashfs" 2>/dev/null || cp "${IMAGE_DIR}/rootfs.squashfs" "${d}/rootfs.squashfs"
  m=$(mktemp -d)
  tar -xJf "${IMAGE_DIR}/incus.tar.xz" -C "$m"
  sed -i "s/${RECIPE_VERSION//./\\.}/${v}/g" "${m}/metadata.yaml"
  tar -cJf "${d}/incus.tar.xz" -C "$m" .
  rm -rf "$m"
  python3 - "${IMAGE_DIR}/manifest.json" "$v" >"${d}/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["version"] = m["recipeVersion"] = sys.argv[2]
json.dump(m, sys.stdout, indent=2)
PY
  (cd "$d" && sha256sum incus.tar.xz rootfs.squashfs manifest.json >SHA256SUMS)
  gpg --homedir "$KEYHOME" --batch --yes --armor --detach-sign -o "${d}/SHA256SUMS.asc" "${d}/SHA256SUMS"
  case "$kind" in
    # Changed after signing: gpgv must refuse it.
    bad-signature) sed -i "/manifest.json/s/^[0-9a-f]*/$(printf '%064d' 0)/" "${d}/SHA256SUMS" ;;
    # Signed, but the file is not the one signed: the checksum must refuse it.
    bad-checksum) printf ' ' >>"${d}/manifest.json" ;;
  esac
}

make_releases() {
  fetch_image || return
  rm -rf "${SERVE}/images"
  release "$RECIPE_VERSION"
  # Two published releases the newest-fetch sees, then ones the image
  # rehearsal fetches by version: two tampered, and two for pruning.
  release 2026.09.13
  release 2026.09.14 bad-signature
  release 2026.09.15 bad-checksum
  release 2026.09.16
  release 2026.09.17
  # The shape of GitHub's releases API, which the image job reads.
  printf '[{"tag_name":"v0.1.1"},{"tag_name":"image-2026.09.13"},{"tag_name":"image-%s"}]\n' "$RECIPE_VERSION" \
    >"${SERVE}/images/releases.json"
  local d
  for d in "${SERVE}"/images/image-*; do
    if gpgv --keyring "${LOGS}/rehearsal-key.gpg" "${d}/SHA256SUMS.asc" "${d}/SHA256SUMS" 2>/dev/null; then s=good; else s=BAD; fi
    if (cd "$d" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1); then c=good; else c=BAD; fi
    echo "$(basename "$d"): signature ${s}, checksums ${c}"
  done
}

make_repo() {
  rm -rf "${SERVE}/apt"
  publish "${LOGS}/v1.deb"
}

# ── 4: the VM, and the server on its network ───────────────────────

# Writes the addresses to files, because a step cannot set this shell's variables.
vm_address() {
  IP=$("${M[@]}" -s rehearsal-address)
  [ -n "$IP" ] || { echo "no rehearsal VM address in the OpenTofu state"; return 1; }
  # A new VM has a new host key, and may reuse an old address.
  ssh-keygen -R "$IP" >/dev/null 2>&1 || true
  ssh-keyscan -T 10 "$IP" 2>/dev/null >>"${HOME}/.ssh/known_hosts"
  [ "$(vm hostname)" = "$REHEARSAL_NAME" ] || { echo "${IP} is not ${REHEARSAL_NAME}"; return 1; }
  HOST_IP=$(ip -4 route get "$IP" | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  [ -n "$HOST_IP" ] || { echo "no host address toward ${IP}"; return 1; }
  echo "$IP" >"${LOGS}/vm.ip"
  echo "$HOST_IP" >"${LOGS}/host.ip"
  echo "VM ${IP}, served from ${HOST_IP}:${PORT}"
}

start_server() {
  python3 -m http.server "$PORT" --bind "$HOST_IP" --directory "$SERVE" >"${LOGS}/http-server.log" 2>&1 &
  echo $! >"${LOGS}/server.pid"
  local i
  for i in $(seq 1 20); do
    vm "curl -fsS -o /dev/null http://${HOST_IP}:${PORT}/apt/dists/trixie/InRelease" && return 0
    sleep 1
  done
  echo "the VM cannot reach http://${HOST_IP}:${PORT}/"
  return 1
}

# ── 5: the operator's install (docs/INSTALL.md) ────────────────────

add_repository() {
  local fpr
  fpr=$(cat "${LOGS}/rehearsal-key.fpr")
  # A fresh Debian 13 has no gpg, which the fingerprint check needs.
  vm "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl gpg"
  vm "sudo curl -fsSL -o /usr/share/keyrings/portikus-archive-keyring.gpg http://${HOST_IP}:${PORT}/apt/portikus-archive-keyring.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/portikus-archive-keyring.gpg] http://${HOST_IP}:${PORT}/apt trixie main' | sudo tee /etc/apt/sources.list.d/portikus.list"
  vm "gpg --show-keys --with-colons /usr/share/keyrings/portikus-archive-keyring.gpg" | awk -F: '$1 == "fpr" { print $10; exit }' | grep -qx "$fpr" \
    || { echo "the fetched key is not ${fpr}"; return 1; }
  vm "sudo apt-get update" | tee "${LOGS}/apt-update.txt"
  grep -q "${HOST_IP}:${PORT}/apt trixie InRelease" "${LOGS}/apt-update.txt"
}

install_package() {
  # Keys debconf does not own, as an operator's hand edit (docs/INSTALL.md,
  # "Changing your answers"): the local image server, and the SSH account
  # the smoke test uses.  portikus_public_host is here too only because the
  # config script fails on a file that holds no key it owns (a known bug in
  # packaging/debian/config, import_config_file, being fixed separately).
  vm_stdin "sudo install -d -m 0755 /etc/portikus && sudo tee /etc/portikus/portikus.yaml >/dev/null" <<EOF
portikus_public_host: ${PUBLIC_HOST}
portikus_operator_user: deploy
portikus_image_base_url: http://${HOST_IP}:${PORT}/images
portikus_image_releases_url: http://${HOST_IP}:${PORT}/images/releases.json
EOF
  vm_stdin "sudo debconf-set-selections" <<EOF
portikus portikus/public_host string ${PUBLIC_HOST}
portikus portikus/admin_email string ${ADMIN_EMAIL}
portikus portikus/tls select internal
portikus portikus/provider select dex
portikus portikus/storage select /dev/vdb
portikus portikus/storage_confirm boolean true
EOF
  vm "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y portikus 2>&1" | tee "${LOGS}/apt-install.txt"
  grep -q "Portikus setup is running in the background" "${LOGS}/apt-install.txt" \
    || { echo "postinst did not start setup"; return 1; }
  vm "dpkg-query -W -f '\${Version}' portikus" | grep -qx "$(cat "${LOGS}/v1.version")"
}

# follow_setup LABEL -- portikus setup --follow, and proof it returned when the unit ended.
follow_setup() {
  local rc=0 returned started ended
  vm "sudo portikus setup --follow" >"${LOGS}/setup-$1.txt" 2>&1 || rc=$?
  returned=$(date +%s)
  tail -5 "${LOGS}/setup-$1.txt"
  # systemd unloads a finished oneshot and forgets its times; the journal keeps them.
  read -r started ended < <(vm "sudo journalctl -u portikus-setup.service -o short-unix --no-pager" \
    | awk '/Starting portikus-setup/ { s = $1 } /portikus-setup.service: (Deactivated successfully|Failed with result)/ { e = $1 } END { printf "%d %d\n", s, e }')
  echo "setup ran $((ended - started)) s; --follow exited ${rc}, $((returned - ended)) s after the unit ended"
  echo "$1 $((ended - started)) $((returned - ended))" >>"${LOGS}/setup-times.txt"
  [ "$rc" -eq 0 ] || return 1
  [ "$(vm "systemctl show -p ActiveState --value portikus-setup.service")" = inactive ] || return 1
  # Returned within a few seconds of the end, not at a timeout.
  [ "$started" -gt 0 ] && [ "$ended" -ge "$started" ] && [ $((returned - ended)) -lt 30 ] || return 1
  # Only the first run makes the one-time password.
  [ "$1" != install ] || grep -q 'sudo cat /etc/portikus/admin-password' "${LOGS}/setup-$1.txt"
}

# ── 6: the first sign-in (docs/INSTALL.md, "First sign-in") ───────

# Signs in through Caddy and Dex with the one-time password, which never
# leaves the VM, then chooses the new password given on standard input and
# accepts the acceptable-use statement.  The session jar stays root-only on
# the VM for the image rehearsal.
first_signin() {
  local signin="${LOGS}/admin-signin" script="${LOGS}/first-signin.sh"
  (umask 077 && { echo "$ADMIN_EMAIL"; openssl rand -base64 24 | tr -d '\n'; echo; } >"$signin")
  cat >"$script" <<EOF
set -euo pipefail
umask 077
t=/root/portikus-install-test
rm -rf "\$t"; mkdir "\$t"
cat >"\$t/new"
tr -d '\n' </etc/portikus/admin-password >"\$t/current"
A='https://${PUBLIC_HOST}'
C="curl -s --cacert /etc/portikus/caddy-root.crt -c \$t/jar -b \$t/jar"
page=\$(\$C -L -o /dev/null -w '%{url_effective}' "\$A/auth/login")
page=\$(\$C -L -o /dev/null -w '%{url_effective}' "\$(printf '%s' "\$page" | sed 's|/dex/auth?|/dex/auth/local?|')")
\$C -L -o /dev/null --data-urlencode 'login=${ADMIN_EMAIL}' --data-urlencode "password@\$t/current" "\$page"
me=\$(\$C "\$A/auth/me")
echo "after the one-time password: \$(printf '%s' "\$me" | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m["role"], "mustChangePassword", m["mustChangePassword"])')"
printf '%s' "\$me" | python3 -c 'import json,sys; m=json.load(sys.stdin); sys.exit(0 if m["role"] == "administrator" and m["mustChangePassword"] else 1)'
test "\$(\$C -o /dev/null -w '%{http_code}' "\$A/admin/users")" = 403
python3 -c 'import json,sys; print(json.dumps({"currentPassword": open(sys.argv[1]).read(), "newPassword": open(sys.argv[2]).read()}))' "\$t/current" "\$t/new" >"\$t/body"
code=\$(\$C -o /dev/null -w '%{http_code}' -X POST -H "Origin: \$A" -H 'Content-Type: application/json' --data-binary @"\$t/body" "\$A/me/password")
rm -f "\$t/body" "\$t/current" "\$t/new"
echo "POST /me/password: \$code"
test "\$code" = 204 || test "\$code" = 200
version=\$(\$C "\$A/me/acceptable-use" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
code=\$(\$C -o /dev/null -w '%{http_code}' -X POST -H "Origin: \$A" -H 'Content-Type: application/json' -d "{\"version\":\$version}" "\$A/me/acceptable-use")
echo "POST /me/acceptable-use: \$code"
\$C "\$A/auth/me" | python3 -c 'import json,sys; m=json.load(sys.stdin); print("now: mustChangePassword", m["mustChangePassword"], "mustAcceptUse", m.get("mustAcceptUse")); sys.exit(1 if m["mustChangePassword"] or m.get("mustAcceptUse") else 0)'
test "\$(\$C -o /dev/null -w '%{http_code}' "\$A/admin/users")" = 200
EOF
  scp -q -o BatchMode=yes "$script" "deploy@${IP}:/tmp/first-signin.sh"
  sed -n 2p "$signin" | tr -d '\n' | vm_stdin "sudo bash /tmp/first-signin.sh; rc=\$?; rm -f /tmp/first-signin.sh; exit \$rc"
}

smoke() {
  "${M[@]}" smoke-test PORTIKUS_PUBLIC_HOST="$PUBLIC_HOST" PORTIKUS_PUBLIC_PORT=443 \
    PORTIKUS_SMOKE_SIGNIN_FILE="${LOGS}/admin-signin" 2>&1 | tee "${LOGS}/smoke.txt"
  grep -qE '[0-9]+ passed, 0 failed' "${LOGS}/smoke.txt"
}

# ── 8: the upgrade ─────────────────────────────────────────────────

upgrade() {
  local before after
  # An old time on the key file shows whether the upgrade writes it again.
  vm "sudo touch -d 2000-01-01 /usr/share/keyrings/portikus-archive-keyring.gpg"
  before=$(vm "stat -c '%Y %i' /usr/share/keyrings/portikus-archive-keyring.gpg")
  publish "${LOGS}/v2.deb"
  vm "sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1" | tee "${LOGS}/apt-upgrade.txt"
  vm "dpkg-query -W -f '\${Version}' portikus" | grep -qx "$(cat "${LOGS}/v2.version")"
  grep -q "Portikus setup is running in the background" "${LOGS}/apt-upgrade.txt" \
    || { echo "the upgrade did not start setup"; return 1; }
  after=$(vm "stat -c '%Y %i' /usr/share/keyrings/portikus-archive-keyring.gpg")
  echo "keyring mtime and inode before the upgrade: ${before}; after: ${after}"
  echo "owned by: $(vm "dpkg -S /usr/share/keyrings/portikus-archive-keyring.gpg")"
  echo "conffiles: $(vm "cat /var/lib/dpkg/info/portikus.conffiles 2>/dev/null | tr '\n' ' '")"
  echo "keyring ${before} -> ${after}" >"${LOGS}/keyring-upgrade.txt"
}

after_upgrade() {
  vm "sudo portikus status"
  local s
  for s in portikus-api portikus-worker portikus-controller; do
    [ "$(vm "systemctl is-active ${s}")" = active ] || { echo "${s} is not active"; return 1; }
  done
  vm "curl -fsS --cacert /etc/portikus/caddy-root.crt -o /dev/null https://${PUBLIC_HOST}/health"
  # The chosen password still signs in after the upgrade.
  sed -n 2p "${LOGS}/admin-signin" | tr -d '\n' | vm_stdin "
    set -e; umask 077; t=\$(mktemp -d); trap 'rm -rf \"\$t\"' EXIT; cat >\"\$t/pw\"
    A='https://${PUBLIC_HOST}'
    C=\"curl -s --cacert /etc/portikus/caddy-root.crt -c \$t/jar -b \$t/jar\"
    page=\$(\$C -L -o /dev/null -w '%{url_effective}' \"\$A/auth/login\")
    \$C -L -o /dev/null --data-urlencode 'login=${ADMIN_EMAIL}' --data-urlencode \"password@\$t/pw\" \"\$page\"
    test \"\$(\$C -o /dev/null -w '%{http_code}' \"\$A/admin/users\")\" = 200"
}

# ── 9: the workspace image rehearsal ───────────────────────────────

image_jobs() {
  scp -q -o BatchMode=yes "${ROOT}/infra/tests/image-job-rehearsal.py" "deploy@${IP}:/tmp/image-job-rehearsal.py"
  vm "sudo python3 /tmp/image-job-rehearsal.py --public-host ${PUBLIC_HOST} --recipe-version ${RECIPE_VERSION}"
}

trap finish EXIT
echo "Install test on ${REHEARSAL_NAME}. Logs: ${LOGS}"
step "check this host is ready" preflight
step "make a throwaway signing key" make_key
step "build the package and its upgrade, trusting that key" build_packages
step "sign the image releases and releases.json" make_releases
step "publish the package to a local apt repository" make_repo
step "create a fresh Debian 13 VM (OpenTofu, cloud-init)" create_vm
step "check the new VM and its address" vm_address
IP=$(cat "${LOGS}/vm.ip")
HOST_IP=$(cat "${LOGS}/host.ip")
step "serve the repository and images to the VM" start_server
step "fetch the key and add the repository" add_repository
step "preseed and apt install portikus" install_package
step "follow setup to its end (portikus setup --follow)" follow_setup install
step "sign in with the one-time password and change it" first_signin
step "smoke test, with the administrator's Dex sign-in" smoke
step "apt upgrade to the second version" upgrade
step "follow the upgrade's setup" follow_setup upgrade
step "services, /health and sign-in after the upgrade" after_upgrade
if [ -n "${IMAGE_JOBS:-}" ]; then
  step "workspace image rehearsal (image-job-rehearsal.py)" image_jobs
fi
