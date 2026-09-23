#!/usr/bin/env bash
# Smoke test for the pilot infrastructure (STACK.md section 33).
#
# Run this after `make infra-apply && make configure-vm` to verify
# the acceptance criteria for Epic 1.  It connects to the platform VM
# over SSH and checks each subsystem.
#
# Every probe runs through the `check` helper so that a single failure
# is recorded as FAIL and the script continues to the end.
#
# Usage: ./infra/tests/smoke-test.sh <vm-ip>
# Environment:
#   PORTIKUS_IDP                dex (the default), mock or external: the sign-in
#                               provider the VM was configured with.
#   PORTIKUS_SMOKE_SIGNIN_FILE  with dex, a file of mode 0600 holding a test
#                               user's email and password on two lines; the
#                               run then does a full password sign-in.
#   PORTIKUS_PUBLIC_HOST, PORTIKUS_PUBLIC_PORT as the VM was configured.
#   PORTIKUS_SMOKE_RESTORED_SET a backup set just restored onto this VM (the
#                               rebuild exercise sets it).  Adds the
#                               restored-data and Incus script checks, and
#                               lets the lifecycle block run beside the
#                               restored workspaces.  Refused on the pilot.
#   PORTIKUS_BACKUP_IDENTITY    the age key that opens that set
#                               (default ~/.config/portikus/backup-age-key.txt).
#
# When the VM has a mock LMS registration (make lti-mock-register), the LTI
# block launches through it, and starts it on this host first if it is not
# already running (docs/EPIC-13.md, ruling 26).
set -uo pipefail

VM="${1:?Usage: smoke-test.sh <vm-ip>}"

if [ -n "${PORTIKUS_MOCK_IDP:-}" ]; then
  echo "smoke-test: PORTIKUS_MOCK_IDP was renamed: use PORTIKUS_IDP=mock" >&2
  exit 2
fi
IDP="${PORTIKUS_IDP:-dex}"
case "$IDP" in
  dex | mock | external) ;;
  *) echo "smoke-test: PORTIKUS_IDP must be dex, mock or external (got: ${IDP})" >&2; exit 2 ;;
esac
# The password is read into this shell only.  It reaches the VM on an ssh
# standard input, never in a command line.
SIGNIN_EMAIL=""
SIGNIN_PASSWORD=""
if [ -n "${PORTIKUS_SMOKE_SIGNIN_FILE:-}" ]; then
  if [ "$IDP" != "dex" ]; then
    echo "smoke-test: PORTIKUS_SMOKE_SIGNIN_FILE is for PORTIKUS_IDP=dex only" >&2
    exit 2
  fi
  if [ "$(stat -c %a "$PORTIKUS_SMOKE_SIGNIN_FILE" 2>/dev/null)" != "600" ]; then
    echo "smoke-test: ${PORTIKUS_SMOKE_SIGNIN_FILE} must exist with mode 0600" >&2
    exit 2
  fi
  { IFS= read -r SIGNIN_EMAIL; IFS= read -r SIGNIN_PASSWORD; } <"$PORTIKUS_SMOKE_SIGNIN_FILE"
  if [ -z "$SIGNIN_EMAIL" ] || [ -z "$SIGNIN_PASSWORD" ]; then
    echo "smoke-test: ${PORTIKUS_SMOKE_SIGNIN_FILE} must hold an email and a password on two lines" >&2
    exit 2
  fi
fi

RESTORED_SET="${PORTIKUS_SMOKE_RESTORED_SET:-}"
BACKUP_IDENTITY="${PORTIKUS_BACKUP_IDENTITY:-${HOME}/.config/portikus/backup-age-key.txt}"
if [ -n "$RESTORED_SET" ] && [ ! -f "${RESTORED_SET}/MANIFEST.age" ]; then
  echo "smoke-test: ${RESTORED_SET} is not a backup set (no MANIFEST.age)" >&2
  exit 2
fi

pass=0
fail=0

# -n keeps the remote command away from this script's standard input. Without
# it, ssh forwards our terminal as a pipe that never ends, and a remote incus
# command waits forever for a YAML config on it.
ssh_cmd() {
  ssh -n -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${VM}" "$@"
}

# Same connection, but for the two places that deliberately feed the remote
# command on standard input.
ssh_cmd_stdin() {
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "deploy@${VM}" "$@"
}

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s\n' "$label"
    fail=$((fail + 1))
  fi
}

# check_output LABEL EXPECTED CMD [ARGS...]
# Captures stdout from CMD, compares it to EXPECTED.
check_output() {
  local label="$1" expected="$2"; shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  if [ "$actual" = "$expected" ]; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (got: %s)\n' "$label" "$actual"
    fail=$((fail + 1))
  fi
}

# check_gt LABEL THRESHOLD CMD [ARGS...]
# Captures a numeric value from CMD and checks that it is greater than THRESHOLD.
check_gt() {
  local label="$1" threshold="$2"; shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  actual="${actual:-0}"
  if [ "$actual" -gt "$threshold" ] 2>/dev/null; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (got: %s)\n' "$label" "$actual"
    fail=$((fail + 1))
  fi
}

# check_zero_lines LABEL CMD [ARGS...]
# Passes when CMD produces zero lines of output.
check_zero_lines() {
  local label="$1"; shift
  local count
  count=$("$@" 2>/dev/null | wc -l) || true
  if [ "${count:-1}" -eq 0 ] 2>/dev/null; then
    printf '\033[1;32mPASS\033[0m  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '\033[1;31mFAIL\033[0m  %s (%s lines)\n' "$label" "$count"
    fail=$((fail + 1))
  fi
}

# workspace_ip INSTANCE — the address on the workspace bridge.  A running
# workspace also holds a docker0 address, so pick the bridge NIC by name.
# Callers are inside blocks that have set PROJECT.
workspace_ip() {
  ssh_cmd "incus list $1 --project ${PROJECT} -c4 --format csv" \
    | tr -d '"' | awk '/eth0/ { print $1; exit }'
}

echo "--- Portikus pilot smoke test ---"
echo "Target: ${VM}"
echo ""

# The restored-data run also lets the lifecycle block work beside other
# people's workspaces, which is only safe on a copy, never on the pilot.
if [ -n "$RESTORED_SET" ]; then
  vm_hostname=$(ssh_cmd hostname 2>/dev/null || true)
  if [ -z "$vm_hostname" ] || [ "$vm_hostname" = portikus ]; then
    echo "smoke-test: PORTIKUS_SMOKE_RESTORED_SET is for a rehearsal copy; ${VM} is '${vm_hostname:-unreachable}'" >&2
    exit 2
  fi
fi

# 1. SSH reachability
check "SSH to platform VM"                    ssh_cmd true

# 2. Incus is running
check "Incus daemon is active"                ssh_cmd systemctl is-active incus

# 3. LVM volume group exists
check "LVM volume group portikus-data"        ssh_cmd sudo vgs portikus-data

# 4. LVM thin pool exists
check "LVM thin pool thinpool"                ssh_cmd sudo lvs portikus-data/thinpool

# 5. Incus storage pool exists
check "Incus storage pool workspace-data"     ssh_cmd incus storage show workspace-data

# 6. Incus network exists
check "Incus network portikus-ws"             ssh_cmd incus network show portikus-ws

# 7. Incus project exists
check "Incus project portikus"                ssh_cmd incus project show portikus

# 8. Workspace profile exists
check "Incus workspace profile"               ssh_cmd incus profile show workspace --project portikus

# 9. nftables is loaded
check "nftables is active"                    ssh_cmd systemctl is-active nftables

# 10. IP forwarding is enabled
# shellcheck disable=SC2016  # expansion is intentionally remote-side
check "IPv4 forwarding"                       ssh_cmd 'test "$(/usr/sbin/sysctl -n net.ipv4.ip_forward)" = 1'

# 11. Data disk is a PV
check "Data disk is an LVM PV"               ssh_cmd sudo pvs /dev/vdb

# 12. configure-vm keeps the VM's Incus script in step with the repository
#     (docs/EPIC-12B.md, item 17).
repo_script_sum=$(sha256sum "$(dirname "$0")/../incus/workspace.sh" | cut -d' ' -f1)
vm_script_sum=$(ssh_cmd "sha256sum /var/lib/portikus/incus/workspace.sh" 2>/dev/null | cut -d' ' -f1)
if [ -n "$repo_script_sum" ] && [ "$vm_script_sum" = "$repo_script_sum" ]; then
  printf '\033[1;32mPASS\033[0m  %s\n' "the VM's workspace.sh matches this checkout's"
  pass=$((pass + 1))
else
  printf '\033[1;31mFAIL\033[0m  %s\n' "the VM's workspace.sh (${vm_script_sum:-missing}) differs from this checkout's; run make configure-vm from this checkout"
  fail=$((fail + 1))
fi

echo ""
echo "--- Epic 1 results: ${pass} passed, ${fail} failed ---"
echo ""

# ── Epic 2: Workspace image and nested Docker ────────────────────
# These checks run only when the portikus workspace image is imported.
if ssh_cmd incus image info portikus --project portikus >/dev/null 2>&1; then
  echo "--- Epic 2: workspace image checks ---"
  echo ""

  WS_NAME="smoke-ws"
  PROJECT="portikus"
  WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"

  # Clean up on exit regardless of success or failure.  The cleanup
  # function is extended by the Epic 3 block if it runs, so that a
  # single trap covers both.
  cleanup_all() {
    echo ""
    echo "Destroying ${WS_NAME}..."
    ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
  }
  trap cleanup_all EXIT

  # Provision a workspace.
  echo "Creating workspace ${WS_NAME}..."
  if ! ssh_cmd bash "${WORKSPACE_SCRIPT}" create "${WS_NAME}" >/dev/null 2>&1; then
    printf '\033[1;31mFAIL\033[0m  workspace creation\n'
    fail=$((fail + 1))
    echo ""
    echo "--- Results: ${pass} passed, ${fail} failed ---"
    exit 1
  fi

  # Helper: run a command inside the workspace.
  # The command string is single-quoted for the remote shell so that
  # multi-word commands are passed correctly through ssh.
  ws_exec() {
    local escaped="${*//\'/\'\\\'\'}"
    ssh_cmd "incus exec ${WS_NAME} --project ${PROJECT} -- bash -c '${escaped}'"
  }

  # Helper: run a command as the student user inside the workspace.
  # The command string is single-quoted for the remote shell so that
  # multi-word commands (e.g. "sudo -n true") are passed as one argument
  # to su -c.
  ws_student() {
    local escaped="${*//\'/\'\\\'\'}"
    ssh_cmd "incus exec ${WS_NAME} --project ${PROJECT} -- su -l student -c '${escaped}'"
  }

  # Give the container a moment to finish booting.
  sleep 5

  # 12. systemd is running with no failed units
  check "systemd is-system-running"             ws_exec systemctl is-system-running
  check_zero_lines "no failed systemd units"    ws_exec systemctl --failed --no-legend --no-pager

  # 13. /home/student is owned by student and contains projects/
  check_output "/home/student owned by student" "student" ws_exec stat -c '%U' /home/student
  check "/home/student/projects exists"         ws_exec test -d /home/student/projects

  # 14. Passwordless sudo
  check "student passwordless sudo"             ws_student "sudo -n true"

  # 15. Nested Docker works
  check "docker hello-world"                    ws_student "docker run --rm hello-world"

  # 16. Docker runs with remapped UIDs (not root-mapped)
  uid_map_second_field() {
    ws_student "docker run --rm alpine cat /proc/self/uid_map" 2>/dev/null | awk '{print $2}'
  }
  check_gt "Docker UID base is not 0" 0        uid_map_second_field

  # 17. CLI tools are installed
  check "codex --version"                       ws_student "codex --version"
  check "claude --version"                      ws_student "claude --version"
  # Browser opens are brokered, and Codex does not look for updates on
  # startup (BROWSER-HANDLING.md 18 and 25.2). These do not log in.
  check "portikus-open is executable"           ws_exec "test -x /usr/local/bin/portikus-open"
  check "xdg-open wrapper is executable"        ws_exec "test -x /usr/local/bin/xdg-open"
  check_output "BROWSER is portikus-open in a login shell" \
    "BROWSER=/usr/local/bin/portikus-open" ws_student 'env | grep ^BROWSER='
  # The student cannot mkdir under /run. systemd must create the broker
  # socket directory before the agent starts (BROWSER-HANDLING.md 18).
  check_output "workspace agent unit sets RuntimeDirectory=portikus" \
    "RuntimeDirectory=portikus" \
    ws_exec "grep -F -x 'RuntimeDirectory=portikus' /etc/systemd/system/portikus-workspace-agent.service"
  check_output "Codex update check is off" \
    "check_for_update_on_startup = false" \
    ws_exec "grep -F -x 'check_for_update_on_startup = false' /etc/codex/config.toml"
  check "gh --version"                          ws_student "gh --version"
  check "node --version"                        ws_student "node --version"
  check "python3 --version"                     ws_student "python3 --version"

  # 17a. The image turns off the Claude Code self-updater, which cannot
  # write the system-wide npm prefix (SPEC.md 10, issue #127).
  check_output "Claude Code auto-update off in a login shell" \
    "DISABLE_AUTOUPDATER=1" ws_student 'env | grep DISABLE_AUTOUPDATER'

  # 17ab. The clipboard shim turns a copy into an OSC 52 escape, because
  # a workspace has no X display (issue #125).  There is no terminal here,
  # so the shim falls back to stdout and we read the escape from there.
  # The first 12 base64 characters cover ESC ] 5 2 ; c ; and the start of
  # the encoded text.
  check_output "xclip writes an OSC 52 clipboard escape" \
    "G101MjtjO2FH" ws_student 'printf hi | xclip -selection clipboard | base64 | cut -c1-12'
  check_output "xsel is the same shim" \
    "/usr/local/bin/xclip" ws_exec readlink -f /usr/local/bin/xsel
  check_output "pbcopy is the same shim" \
    "/usr/local/bin/xclip" ws_exec readlink -f /usr/local/bin/pbcopy

  # 17b. The image ships populated apt lists, so a student can install a
  # package, and be told about a missing one, without running apt update.
  apt_list_count() {
    ws_exec "ls /var/lib/apt/lists | wc -l"
  }
  check_gt "apt lists are populated" 0         apt_list_count
  check "apt install needs no update first"     ws_student "timeout 60 sudo apt-get install -y --dry-run btop"
  check "command-not-found suggests a package"  ws_student 'timeout 30 bash -ic nslookup 2>&1 | grep -q "apt install"'

  # 18. Security: no Incus API socket, no host data disk
  check "/dev/incus absent"                     ws_exec test ! -e /dev/incus
  check "/dev/vdb absent"                       ws_exec test ! -e /dev/vdb

  # 19. Management network is unreachable from workspace.  The VM's default
  # gateway is the host on the management network, whichever one this VM is on.
  mgmt_gateway=$(ssh_cmd "ip -4 route show default" | awk '{ print $3; exit }')
  if [ -n "$mgmt_gateway" ]; then
    check "the VM itself reaches ${mgmt_gateway} (control)" ssh_cmd "ping -c1 -W2 ${mgmt_gateway}"
    check "management network (${mgmt_gateway}) blocked" ws_exec "! ping -c1 -W2 ${mgmt_gateway}"
  else
    printf '\033[1;31mFAIL\033[0m  management network: the VM has no default gateway to probe\n'
    fail=$((fail + 1))
  fi

  # 20. SSH to VM bridge address blocked from workspace
  check "SSH to VM bridge blocked"              ws_exec '! timeout 3 bash -c "echo >/dev/tcp/10.200.0.1/22" 2>/dev/null'

  # 21. Persistence across stop/start
  echo ""
  echo "Testing stop/start persistence..."
  if ! ws_student "echo smoke-persistence-marker > ~/projects/.smoke-marker" >/dev/null 2>&1; then
    printf '\033[1;31mFAIL\033[0m  write persistence marker\n'
    fail=$((fail + 1))
  fi
  ssh_cmd "incus stop ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  ssh_cmd "incus start ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  sleep 5

  check "projects marker survives restart"      ws_student "cat ~/projects/.smoke-marker"
  check "Docker images survive restart"         ws_student "docker images -q"

else
  echo "Workspace image not imported; skipping Epic 2 checks."
fi

echo ""

# ── Epic 12b: restored data (docs/EPIC-12B.md, items 19 and 20) ──
# Only when PORTIKUS_SMOKE_RESTORED_SET names the set restored onto this VM.
# Everything read from the set is matched against a strict form before it
# reaches a command, as restore.sh does.
restored_ids=()
if [ -n "$RESTORED_SET" ]; then
  echo "--- Epic 12b: restored data from $(basename "$RESTORED_SET") ---"
  echo ""
  psql_vm() { ssh_cmd "sudo -u postgres psql -q -t -A -d portikus -c \"$1\""; }
  restored_file_sum() { # VOLUME PATH
    ssh_cmd "incus storage volume file pull workspace-data $(printf '%q' "$1/$2") - --project portikus" | sha256sum | cut -d' ' -f1
  }
  restored_fail() {
    printf '\033[1;31mFAIL\033[0m  %s\n' "$1"
    fail=$((fail + 1))
  }
  # restored_sample INDEX -- three files spread evenly through the backup's
  # file list, as restore.sh samples, each from the middle of its stretch so
  # the first file (often .bash_history, which a started workspace may
  # change) is not picked.  Only plain relative paths are used.
  restored_sample() {
    python3 - "$1" <<'EOF_SAMPLE'
import json, re, sys
files = [r for r in map(json.loads, open(sys.argv[1])) if "f" in r
         and re.fullmatch(r"[A-Za-z0-9._@+/-]+", r["f"]) and not r["f"].startswith("/")
         and ".." not in r["f"].split("/") and re.fullmatch(r"[0-9a-f]{64}", r.get("sha256", ""))]
step = max(1, len(files) // 3)
for r in files[step // 2::step][:3]:
    print(r["sha256"], r["f"])
EOF_SAMPLE
  }

  restore_tmp=$(mktemp -d)
  if ! age -d -i "$BACKUP_IDENTITY" "${RESTORED_SET}/MANIFEST.age" >"${restore_tmp}/MANIFEST"; then
    restored_fail "decrypt the MANIFEST of ${RESTORED_SET} with ${BACKUP_IDENTITY}"
  else
    # Every workspace row, including one whose instance was never created.
    while read -r _ id instance; do
      if ! [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        restored_fail "a MANIFEST workspace line is not in the expected form"
        continue
      fi
      restored_ids+=("$id")
      if [ "$instance" = "-" ]; then
        check_output "restored workspace ${id} is there, with no instance yet" "1" \
          psql_vm "SELECT count(*) FROM workspaces WHERE id = '${id}' AND incus_instance_name IS NULL"
      elif [[ "$instance" =~ ^ws-[0-9a-f]{24}$ ]]; then
        check_output "restored workspace ${id} keeps instance ${instance}" "$instance" \
          psql_vm "SELECT incus_instance_name FROM workspaces WHERE id = '${id}'"
        check "restored instance ${instance} exists" \
          ssh_cmd "incus info ${instance} --project portikus"
      else
        restored_fail "the MANIFEST instance for ${id} is not in the expected form"
      fi
    done < <(awk '$1 == "workspace"' "${restore_tmp}/MANIFEST")
    [ "${#restored_ids[@]}" -gt 0 ] || restored_fail "the MANIFEST lists no workspace"

    while read -r _ volume _; do
      if ! [[ "$volume" =~ ^ws-[0-9a-f]{24}-(home|recovery)$ ]]; then
        restored_fail "a MANIFEST volume line is not in the expected form"
        continue
      fi
      check "restored volume ${volume} exists" \
        ssh_cmd "incus storage volume show workspace-data ${volume} --project portikus"
      if ! age -d -i "$BACKUP_IDENTITY" "${RESTORED_SET}/${volume}.index.age" >"${restore_tmp}/index"; then
        restored_fail "decrypt the file list of ${volume}"
        continue
      fi
      sampled=0
      while read -r sum path; do
        sampled=$((sampled + 1))
        check_output "restored ${volume}: sampled file ${sampled} matches the backup" "$sum" \
          restored_file_sum "$volume" "$path"
      done < <(restored_sample "${restore_tmp}/index")
      # A home always holds files, so an empty sample means the check is broken.
      if [ "$sampled" -eq 0 ] && [[ "$volume" == *-home ]]; then
        restored_fail "no file of ${volume} could be sampled from the backup"
      fi
    done < <(awk '$1 == "volume"' "${restore_tmp}/MANIFEST")

    projects=$(awk '$1 == "counts" && $6 == "projects" { print $7 }' "${restore_tmp}/MANIFEST")
    if [[ "$projects" =~ ^[0-9]+$ ]]; then
      check "at least the backup's ${projects} projects are on the VM" \
        test "$(psql_vm 'SELECT count(*) FROM projects')" -ge "$projects"
    else
      restored_fail "the MANIFEST has no counts line"
    fi

    # restore.sh ends every sign-in; nothing made before the backup survives.
    created=$(awk '$1 == "created" { print $2 }' "${restore_tmp}/MANIFEST")
    if [[ "$created" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
      at="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}+00"
      check_output "no session from before the backup survived" "0" \
        psql_vm "SELECT count(*) FROM sessions WHERE created_at < '${at}'"
      check_output "no preview session from before the backup survived" "0" \
        psql_vm "SELECT count(*) FROM preview_sessions WHERE created_at < '${at}'"
    else
      restored_fail "the MANIFEST has no created line"
    fi
  fi
  rm -rf "$restore_tmp"
  echo ""
fi

# ── Epic 3 and 4: authenticated control-plane lifecycle ──────────
# These checks run only when the portikus-api service is active (i.e.
# code has been deployed).  Everything goes through Caddy on the public
# host name, with a session cookie for each of three users, so the block
# also covers Epic 4: roles, ownership, CSRF, and the authenticated presence
# WebSocket.  With the mock provider the users sign in through it.  With any
# other provider they are made in PostgreSQL with a session, as the security
# suite does, so the block needs no password and works with IT's provider too
# (docs/EPIC-12B.md, "Other Part A decisions").
PUBLIC_HOST="${PORTIKUS_PUBLIC_HOST:-portikus.${VM}.nip.io}"
# The default name only works where Caddy was told to serve it, so say so
# rather than letting every HTTPS check fail for a reason nobody can see.
if [ -z "${PORTIKUS_PUBLIC_HOST:-}" ]; then
  printf '\033[1;33mWARN\033[0m  PORTIKUS_PUBLIC_HOST is unset: the HTTPS checks will use %s. If Caddy on this VM serves a different name, set PORTIKUS_PUBLIC_HOST and run again.\n' "${PUBLIC_HOST}"
fi
# The port Caddy serves the site on. It is 8443 on the pilot host, because
# another service there owns 443.
PUBLIC_PORT="${PORTIKUS_PUBLIC_PORT:-443}"
if [ "${PUBLIC_PORT}" = "443" ]; then
  PUBLIC_AUTHORITY="${PUBLIC_HOST}"
else
  PUBLIC_AUTHORITY="${PUBLIC_HOST}:${PUBLIC_PORT}"
fi
API="https://${PUBLIC_AUTHORITY}"
# The API's loopback port, used where a request has to reach the API itself
# rather than whatever Caddy decides to serve for that path.
API_PORT="${PORTIKUS_API_PORT:-3000}"
# Caddy signs with its own internal authority, so every request has to
# trust the root certificate the Ansible caddy role copied here.
CURL="curl -s --cacert /etc/portikus/caddy-root.crt"
# The session cookie is named for the __Host- prefix, which browsers only
# accept on a secure, host-scoped, path-/ cookie.
SESSION_COOKIE_NAME="__Host-portikus_session"

# http_status USER URL [EXTRA_CURL_ARGS]
# USER is a mock user whose cookie jar is sent, or "-" for anonymous.
# EXTRA_CURL_ARGS is one string, quoted for the remote shell.
http_status() {
  local user="$1" url="$2" extra="${3:-}" jar=""
  [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
  ssh_cmd "${CURL} ${jar} ${extra} -o /dev/null -w '%{http_code}' '${url}'"
}

# vm_get USER URL [EXTRA_CURL_ARGS] — prints the response body.
vm_get() {
  local user="$1" url="$2" extra="${3:-}" jar=""
  [ "$user" = "-" ] || jar="-b /tmp/portikus-smoke-${user}.jar"
  ssh_cmd "${CURL} ${jar} ${extra} '${url}'"
}

# A response header of the site root matches the given grep pattern.
site_header_matches() {
  ssh_cmd "${CURL} -I '${API}/'" | grep -qi -- "$1"
}

# --- Epic 8: the preview edge (BROWSER-HANDLING 7.1, 10, 12) ---------
# These checks need only Caddy, not a preview session, so they run whether
# or not the control plane is up.
echo "--- Epic 8: preview edge ---"

PREVIEW_SUFFIX="${PORTIKUS_PREVIEW_SUFFIX:-preview.${PUBLIC_HOST}}"
PREVIEW_HOST="smoke-5173.${PREVIEW_SUFFIX}"
if [ "${PUBLIC_PORT}" = "443" ]; then
  PREVIEW_AUTHORITY="${PREVIEW_HOST}"
else
  PREVIEW_AUTHORITY="${PREVIEW_HOST}:${PUBLIC_PORT}"
fi
# The VM resolves the application host to loopback but knows nothing about
# preview names, so point curl at loopback by hand.
PREVIEW_RESOLVE="--resolve ${PREVIEW_HOST}:${PUBLIC_PORT}:127.0.0.1"

preview_status() { # PATH [EXTRA_CURL_ARGS]
  ssh_cmd "${CURL} ${PREVIEW_RESOLVE} ${2:-} -o /dev/null -w '%{http_code}' 'https://${PREVIEW_AUTHORITY}$1'"
}

# A wildcard certificate from the internal authority covers every preview
# name, so curl's verification succeeds without -k.
check "wildcard TLS is served for a preview host" \
  ssh_cmd "${CURL} ${PREVIEW_RESOLVE} -o /dev/null 'https://${PREVIEW_AUTHORITY}/__portikus/nothing'"
check_output "an unknown reserved path is 404 from Caddy" "404" \
  preview_status /__portikus/nothing
check "the preview host is not the application site" \
  ssh_cmd "! ${CURL} ${PREVIEW_RESOLVE} -I 'https://${PREVIEW_AUTHORITY}/' | grep -qi frame-ancestors"
unauthorized_preview_is_refused() {
  [ "$(preview_status /)" != "200" ]
}
check "an unauthorized preview request is never served" unauthorized_preview_is_refused
echo ""

if ! ssh_cmd systemctl is-active portikus-api >/dev/null 2>&1; then
  echo "portikus-api not active; skipping Epic 3 and 4 checks."
  if [ -n "$RESTORED_SET" ]; then
    printf '\033[1;31mFAIL\033[0m  %s\n' "the lifecycle checks were skipped on the restored VM (portikus-api is not active)"
    fail=$((fail + 1))
  fi
else
  # ── Epic 12b: the sign-in provider (docs/EPIC-12B.md, Part A) ──
  echo "--- Epic 12b: sign-in provider (${IDP}) ---"
  echo ""

  # One line per key of api.env, which only root and the API can read.
  api_env() {
    ssh_cmd "sudo sed -n 's/^$1=//p' /etc/portikus/api.env"
  }
  discovered_issuer() {
    vm_get - "${API}/$1/.well-known/openid-configuration" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('issuer',''))" 2>/dev/null || true
  }

  # Whatever the provider, no bcrypt hash may reach a journal.
  # shellcheck disable=SC2016  # the pattern is for grep on the VM
  check_zero_lines "no bcrypt hash in the Dex, API or Caddy journals" \
    ssh_cmd 'sudo journalctl -u portikus-dex -u portikus-api -u caddy --no-pager -o cat | grep -E "[$]2[aby][$][0-9]{2}[$]"'

  if [ "$IDP" != "mock" ]; then
    check "mock identity provider unit is inactive" \
      ssh_cmd '! systemctl is-active portikus-mock-idp'
    check "mock identity provider unit is disabled" \
      ssh_cmd '! systemctl is-enabled portikus-mock-idp'
    check "the mock's env and secret files are gone" \
      ssh_cmd 'sudo test ! -e /etc/portikus/mock-idp.env -a ! -e /etc/portikus/mock-client.secret'
    check_output "/mock-idp is 404 through Caddy" "404" \
      http_status - "${API}/mock-idp/.well-known/openid-configuration"
  fi
  if [ "$IDP" != "dex" ]; then
    check "Dex unit is inactive" ssh_cmd '! systemctl is-active portikus-dex'
    check_output "/dex is 404 through Caddy" "404" \
      http_status - "${API}/dex/.well-known/openid-configuration"
  fi

  if [ "$IDP" = "mock" ]; then
    # The mock identity provider answers through Caddy with the right issuer.
    check "portikus-mock-idp is active"           ssh_cmd systemctl is-active portikus-mock-idp
    check_output "mock discovery reports the public issuer" "${API}/mock-idp" \
      discovered_issuer mock-idp
    # A foreign redirect_uri must not be honoured, or an attacker could have
    # the authorization code delivered to a site they control.
    check_output "mock /authorize refuses a foreign redirect_uri" "400" \
      http_status - "${API}/mock-idp/authorize?client_id=portikus-dev&response_type=code&scope=openid&state=smoke&redirect_uri=https%3A%2F%2Fattacker.example%2Fcallback"
  fi

  if [ "$IDP" = "dex" ]; then
    check "portikus-dex is active"                ssh_cmd systemctl is-active portikus-dex
    dex_listeners() {
      ssh_cmd "ss -Hltn 'sport = :5556'" | awk '{ print $4 }' | sort -u | paste -sd' '
    }
    check_output "Dex listens on loopback only" "127.0.0.1:5556" dex_listeners
    check_output "Dex discovery through Caddy reports the public issuer" "${API}/dex" \
      discovered_issuer dex
    check_output "api.env names the Dex issuer" "${API}/dex" api_env OIDC_ISSUER_URL
    check_output "api.env names the client portikus" "portikus" api_env OIDC_CLIENT_ID
    check "api.env asks for the groups scope" \
      ssh_cmd "sudo grep -qE '^OIDC_SCOPES=(.* )?groups( |\$)' /etc/portikus/api.env"
    # Compared on the VM, so the secret never leaves it.
    # shellcheck disable=SC2016  # expanded by the shell on the VM
    check "api.env holds the generated Dex client secret" \
      ssh_cmd 'sudo sh -c '\''test -s /etc/portikus/dex-client.secret && test "$(sed -n "s/^OIDC_CLIENT_SECRET=//p" /etc/portikus/api.env)" = "$(cat /etc/portikus/dex-client.secret)"'\'''
    check_output "dex-client.secret is root, mode 0600" "root:root 600" \
      ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus/dex-client.secret"
    check_output "the Dex config is root:portikus-dex, mode 0640" "root:portikus-dex 640" \
      ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus-dex/config.yaml"
    # The users file stays on the operator's machine, so the Dex config is
    # the only place with a hash (docs/adr/0023).  /root/go holds the Dex
    # source and module cache, whose examples carry sample hashes.
    # shellcheck disable=SC2016  # the pattern is for grep on the VM
    check_zero_lines "no bcrypt hash on the VM outside the Dex config" \
      ssh_cmd 'sudo grep -rlsE --exclude-dir=go "[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}" /etc /root /home /tmp /var/tmp | grep -vx /etc/portikus-dex/config.yaml'

    # Each group of password posts comes from its own loopback address, so
    # the per-address throttle counts only this run's attempts, and a rerun
    # within ten minutes starts clean.  Caddy names that address to the API.
    random_loopback() { echo "127.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"; }
    SIGNIN_JAR="/tmp/portikus-smoke-dexsignin.jar"

    # form_body EMAIL -- the password form's body, password on stdin.  Built
    # here so the password is in no command line on either machine.
    form_body() {
      python3 -c '
import sys, urllib.parse
password = sys.stdin.readline().rstrip("\n")
sys.stdout.write(urllib.parse.urlencode({"login": sys.argv[1], "password": password}))
' "$1"
    }

    # dex_signin SOURCE -- the whole browser flow through Caddy: /auth/login
    # to Dex's form, post it (body on stdin), follow Dex back through the
    # callback.  Prints the status of the last page.
    dex_signin() {
      ssh_cmd_stdin "rm -f ${SIGNIN_JAR}; page=\$(${CURL} --interface $1 -c ${SIGNIN_JAR} -b ${SIGNIN_JAR} -L -o /dev/null -w '%{url_effective}' '${API}/auth/login') \
        && ${CURL} --interface $1 -c ${SIGNIN_JAR} -b ${SIGNIN_JAR} -L --data-binary @- -o /dev/null -w '%{http_code}' \"\$page\""
    }
    signin_has_session() {
      ssh_cmd "awk '\$6 == \"${SESSION_COOKIE_NAME}\"' ${SIGNIN_JAR} | grep -q ."
    }
    signin_has_no_session() { ! signin_has_session; }

    # Dex answers a refused password with its form again and status 401.
    signin_source=$(random_loopback)
    if [ -n "$SIGNIN_EMAIL" ]; then
      refused_label="a wrong password"
    else
      refused_label="an account Dex does not know"
    fi
    refused_status=$(printf '%s\n' "wrong-$(openssl rand -hex 12)" \
      | form_body "${SIGNIN_EMAIL:-smoke-nobody@example.invalid}" | dex_signin "$signin_source" 2>/dev/null)
    check_output "${refused_label} is refused at Dex's form" "401" echo "$refused_status"
    check "${refused_label} gets no session" signin_has_no_session

    if [ -n "$SIGNIN_EMAIL" ]; then
      echo ""
      echo "Signing in through Dex as the user in ${PORTIKUS_SMOKE_SIGNIN_FILE}..."
      printf '%s\n' "$SIGNIN_PASSWORD" | form_body "$SIGNIN_EMAIL" | dex_signin "$signin_source" >/dev/null 2>&1
      check "a full Dex password sign-in gets a session" signin_has_session
      signin_me() {
        ssh_cmd "${CURL} -b ${SIGNIN_JAR} '${API}/auth/me'" | python3 -c '
import json, sys
me = json.load(sys.stdin)
print(me.get("email", "").lower(), me.get("role", "") in ("student", "instructor", "administrator"))
' 2>/dev/null || true
      }
      check_output "/auth/me after the Dex sign-in names the user and a role" \
        "$(printf '%s' "$SIGNIN_EMAIL" | tr '[:upper:]' '[:lower:]') True" signin_me
      ssh_cmd "${CURL} -b ${SIGNIN_JAR} -X POST -H 'Origin: ${API}' -o /dev/null '${API}/auth/logout'" >/dev/null 2>&1 || true
    else
      echo "No PORTIKUS_SMOKE_SIGNIN_FILE: skipping the full Dex password sign-in."
    fi
    ssh_cmd "rm -f ${SIGNIN_JAR}" >/dev/null 2>&1 || true

    # The password form is limited per address (#398).  The limit is the
    # packages/config default unless api.env raises it.
    password_limit=$(api_env PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES)
    password_limit="${password_limit:-30}"
    throttle_source=$(random_loopback)
    throttle_statuses() {
      ssh_cmd "for i in \$(seq 1 $((password_limit + 1))); do ${CURL} --interface ${throttle_source} -o /dev/null -w '%{http_code}\n' \
        --data 'login=smoke-throttle%40example.invalid&password=x' '${API}/dex/auth/local/login?back=&state=smoke-throttle'; done"
    }
    throttle_result() {
      throttle_statuses | awk -v n="$((password_limit + 1))" \
        'NR < n && $1 == 429 { early++ } NR == n { last = $1 } END { print (early ? "early 429" : "last " last) }'
    }
    check_output "the password form refuses attempt $((password_limit + 1)) from one address" \
      "last 429" throttle_result
    check_output "the refusal is audited once for that address" "1" \
      ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE action = 'auth.throttled' AND metadata::jsonb->>'ip' = '${throttle_source}'\""
  fi

  # ── Epic 13: LTI launch (docs/EPIC-13.md) ──────────────────────
  echo ""
  echo "--- Epic 13: LTI launch ---"
  echo ""
  LTI_FILE=/etc/portikus/lti-platforms.json
  LTI_LAUNCH_PY="$(dirname "${BASH_SOURCE[0]}")/lti-launch.py"
  # lti_py ARGS... -- the launch driver, run on the VM, prints one JSON object.
  lti_py() {
    ssh_cmd_stdin "python3 - $*" <"$LTI_LAUNCH_PY"
  }
  # json_field JSON KEY -- one value, lists joined with commas.
  json_field() {
    python3 -c 'import json, sys; v = json.loads(sys.argv[1]).get(sys.argv[2]); print(",".join(map(str, v)) if isinstance(v, list) else v)' "$1" "$2" 2>/dev/null
  }

  check_output "api.env names the platforms file" "$LTI_FILE" api_env LTI_PLATFORMS_FILE
  check_output "api.env names the tool key" "/etc/portikus/lti-tool-key.pem" api_env LTI_TOOL_KEY_FILE
  check_output "the tool key is root:portikus, mode 0640" "root:portikus 640" \
    ssh_cmd "sudo stat -c '%U:%G %a' /etc/portikus/lti-tool-key.pem"
  check "the tool key is RSA 2048" \
    ssh_cmd "sudo openssl pkey -in /etc/portikus/lti-tool-key.pem -noout -text | head -1 | grep -q '(2048 bit'"

  if ! ssh_cmd "sudo test -e ${LTI_FILE}"; then
    echo "No LMS is registered: LTI must be off."
    check_output "/lti/jwks is 404 with LTI off" "404" http_status - "${API}/lti/jwks"
    check_output "/lti/login is 404 with LTI off" "404" http_status - "${API}/lti/login"
    check_output "POST /lti/launch is 404 with LTI off" "404" \
      http_status - "${API}/lti/launch" "-X POST --data state=x"
  else
    check_output "the platforms file is root:portikus, mode 0640" "root:portikus 640" \
      ssh_cmd "sudo stat -c '%U:%G %a' ${LTI_FILE}"
    lti_platforms=$(ssh_cmd "sudo cat ${LTI_FILE}")
    # The keyset holds the tool key's public half and nothing private.
    jwks_shape() {
      vm_get - "${API}/lti/jwks" | python3 -c '
import json, sys
keys = json.load(sys.stdin)["keys"]
print(len(keys), keys[0]["kty"], keys[0]["alg"], "d" in keys[0], len(keys[0]["kid"]) == 43)'
    }
    check_output "/lti/jwks serves one public RS256 key with a thumbprint kid" "1 RSA RS256 False True" jwks_shape
    # Only the registered platforms may frame /lti/*; Caddy adds nothing there.
    lti_origins=$(printf '%s' "$lti_platforms" | python3 -c '
import json, sys, urllib.parse
seen = []
for p in json.load(sys.stdin)["platforms"]:
    u = urllib.parse.urlsplit(p["authLoginUrl"])
    o = f"{u.scheme}://{u.netloc}"
    if o not in seen: seen.append(o)
print(" ".join(seen))')
    # Framed, login and launch only show a new-tab or refusal page, so any
    # page may frame them; the login form may post only to us and the
    # registered platforms (docs/EPIC-13.md, ruling 17).
    lti_directive() { # PATH DIRECTIVE
      ssh_cmd "${CURL} -D - -o /dev/null '${API}$1'" \
        | tr -d '\r' | grep -i '^content-security-policy:' | grep -o "$2 [^;]*" | paste -sd'|'
    }
    check_output "/lti/login may be framed by any page" "frame-ancestors *" \
      lti_directive /lti/login frame-ancestors
    check_output "the /lti/login form posts only to us and the registered platforms" \
      "form-action 'self' ${lti_origins}" lti_directive /lti/login form-action
    check_output "/lti/jwks may not be framed" "frame-ancestors 'none'" \
      lti_directive /lti/jwks frame-ancestors

    mock_issuer=$(printf '%s' "$lti_platforms" | python3 -c '
import json, sys
print(next((p["issuer"] for p in json.load(sys.stdin)["platforms"] if p.get("mock") and p["name"] == "mock-lms"), ""))')
    if [ -z "$mock_issuer" ]; then
      echo "No mock LMS is registered: skipping the launch checks."
    else
      printf '\033[1;33mWARN\033[0m  the mock LMS is registered (mock-lms at %s): it can launch as anyone while it runs. Remove it with make lti-mock-unregister.\n' "$mock_issuer"
      mock_pid=""
      if [ "$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 '${mock_issuer}/.well-known/jwks.json'")" != "200" ]; then
        # Not running: start it here for this run, on the address it was registered with.
        mock_host=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname)' "$mock_issuer")
        mock_port=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).port)' "$mock_issuer")
        echo "Starting the mock LMS on ${mock_host}:${mock_port} for this run..."
        repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
        setsid pnpm --silent --dir "${repo_root}/packages/mock-lms" start -- --tool-url "$API" --port "$mock_port" \
          --bind 127.0.0.1 --bind "$mock_host" --issuer "$mock_issuer" >/dev/null 2>&1 &
        mock_pid=$!
        for _ in $(seq 1 60); do
          [ "$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 2 '${mock_issuer}/.well-known/jwks.json'")" = "200" ] && break
          sleep 1
        done
      fi
      check_output "the VM reaches the mock LMS keyset" "200" \
        ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 '${mock_issuer}/.well-known/jwks.json'"

      student=$(lti_py launch "$mock_issuer" "$API" sam cs101)
      check_output "a student launch passes /lti/login, the mock and /lti/launch" "302 200 303" \
        echo "$(json_field "$student" login) $(json_field "$student" authorize) $(json_field "$student" launch)"
      check_output "the launch lands on / with a session" "/ True" \
        echo "$(json_field "$student" launch_location) $(json_field "$student" session)"
      check_output "the state cookie is named for its state, HttpOnly, Secure, SameSite=None, Path=/, 10 minutes" \
        "httponly;max-age=600;path=/;samesite=none;secure" json_field "$student" state_cookie
      check_output "/auth/me names the student role" "student" json_field "$student" role
      check_output "a student has no courses" "" json_field "$student" course_titles
      check_output "the student gets 403 from the admin routes" "403" json_field "$student" admin
      check_output "the same id_token and state are refused a second time" "400 False" \
        echo "$(json_field "$student" replay) $(json_field "$student" replay_session)"

      instructor=$(lti_py launch "$mock_issuer" "$API" ivy cs101)
      check_output "an instructor launch lands with a session" "303 True" \
        echo "$(json_field "$instructor" launch) $(json_field "$instructor" session)"
      check_output "/auth/me names the instructor role" "instructor" json_field "$instructor" role
      check_output "the instructor sees the course" "CS 101 Intro to Programming" \
        json_field "$instructor" course_titles
      lti_has_sam() { json_field "$instructor" member_names | tr ',' '\n' | grep -qx 'Sam Student'; }
      check "the course lists the student who launched before" lti_has_sam
      check_output "members carry only name, role, last launch and workspace state" \
        "displayName,lastLaunchAt,role,workspaceState" json_field "$instructor" member_fields
      check_output "the instructor gets 403 from the admin routes" "403" json_field "$instructor" admin

      # The accounts mock launches made stay; the operator decides what to do with them.
      echo "Accounts made by mock launches (issuer lti:${mock_issuer}):"
      ssh_cmd "sudo -u postgres psql -t -A -F ' ' -d portikus -c \"SELECT '  ' || display_name, role, created_at::date FROM users WHERE oidc_issuer = 'lti:${mock_issuer}' ORDER BY display_name\""

      if [ -n "$mock_pid" ]; then
        # setsid made it a process group of its own: pnpm, tsc's shell and node.
        kill -- "-${mock_pid}" 2>/dev/null
        wait "$mock_pid" 2>/dev/null
      fi
    fi
  fi

  echo ""
  echo "--- Epic 3 and 4: authenticated lifecycle checks ---"
  echo ""

  epic3_pass_start=$pass
  epic3_fail_start=$fail

  PROJECT="portikus"
  WORKSPACE_SCRIPT="/var/lib/portikus/incus/workspace.sh"
  WS_PROBE="/tmp/portikus-ws-probe.mjs"
  WS_STOP="/tmp/portikus-ws-stop"
  TERM_PROBE="/tmp/portikus-term-probe.mjs"
  TERM_STOP="/tmp/portikus-term-stop"

  # Everything this run creates is recorded here and the cleanup below
  # deletes nothing else.  On the pilot the mock accounts belong to a real
  # person, whose workspace and volumes must survive the test.
  created_workspace_ids=()
  created_instance_names=()
  created_user_subjects=()

  # Log a mock user in: follow /auth/login to the provider's account list,
  # then request the same page with the chosen account, which redirects
  # back through the callback and sets the session cookie.
  login_as() {
    local user="$1"
    local jar="/tmp/portikus-smoke-${user}.jar" page
    ssh_cmd "rm -f ${jar}"
    page=$(ssh_cmd "${CURL} -c ${jar} -b ${jar} -L -o /dev/null -w '%{url_effective}' '${API}/auth/login'")
    ssh_cmd "${CURL} -c ${jar} -b ${jar} -L -o /dev/null -w '%{http_code}' '${page}&user=${user}'"
  }

  # Users made in PostgreSQL live under their own issuer, with subjects no
  # person has, so the cleanup can never reach a real account.
  SMOKE_ISSUER="urn:portikus:smoketest"
  SMOKE_RUN_ID="$(date -u +%m%d%H%M%S)"

  # mint_user NAME DISPLAY_NAME ROLE -- a user row and a one-hour session,
  # with the cookie written to NAME's jar as login_as would.  The token goes
  # over ssh standard input, never in a command line.
  mint_user() {
    local name="$1" display="$2" role="$3" subject token hash uid
    subject="smoke-${SMOKE_RUN_ID}-${name}"
    created_user_subjects+=("$subject")
    token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
    hash=$(printf '%s' "$token" | sha256sum | awk '{ print $1 }')
    uid=$(printf '%s\n' "WITH u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role) VALUES ('${SMOKE_ISSUER}', '${subject}', '${display}', '${name}', '${role}') RETURNING id), s AS (INSERT INTO sessions (id, user_id, expires_at) SELECT '${hash}', id, now() + interval '1 hour' FROM u) SELECT id FROM u" \
      | ssh_cmd_stdin "sudo -u postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -d portikus" 2>/dev/null)
    if [ -z "$uid" ]; then
      printf '\033[1;31mFAIL\033[0m  make %s %s in PostgreSQL\n' "$role" "$subject"
      fail=$((fail + 1))
      return 1
    fi
    printf '#HttpOnly_%s\tFALSE\t/\tTRUE\t0\t%s\t%s\n' "$PUBLIC_HOST" "$SESSION_COOKIE_NAME" "$token" \
      | ssh_cmd_stdin "umask 077; cat > /tmp/portikus-smoke-${name}.jar"
  }

  # The session cookie value, read from the Netscape jar curl wrote.  The
  # cookie is HttpOnly, so curl prefixes the domain field with "#HttpOnly_";
  # that leaves the name in field 6 and the value in field 7 as usual.
  session_cookie() {
    ssh_cmd "awk '\$6 == \"${SESSION_COOKIE_NAME}\" {print \$7}' /tmp/portikus-smoke-$1.jar"
  }

  # A field of a workspace JSON document, or "" when it is missing.
  json_field() {
    python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || true
  }

  workspace_state() {
    vm_get alice "${API}/workspaces/${ws_id}" | json_field state
  }

  # "set" or "null" for the shutdown deadline.
  workspace_deadline() {
    vm_get alice "${API}/workspaces/${ws_id}" \
      | python3 -c "import sys,json; d=json.load(sys.stdin).get('shutdownDeadline'); print('set' if d else 'null')" 2>/dev/null || true
  }

  # Rows in workspace_connections for this workspace.
  connection_count() {
    ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM workspace_connections WHERE workspace_id = '${ws_id}'\"" 2>/dev/null || true
  }

  wait_for_state() {
    local want="$1" tries="$2" state=""
    for _ in $(seq 1 "$tries"); do
      state=$(workspace_state)
      if [ "$state" = "$want" ]; then break; fi
      sleep 1
    done
    echo "$state"
  }

  # The disconnect grace period is a live platform setting an administrator
  # changes through the API (SPEC.md section 6.4), so the test shortens it the
  # same way, as carol, instead of editing a file and restarting the worker.
  admin_grace() {
    vm_get carol "${API}/admin/settings" | json_field shutdownGraceSeconds
  }

  # set_global_grace SECONDS -- prints the value the API reports back.
  set_global_grace() {
    vm_get carol "${API}/admin/settings" \
      "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":$1}'" \
      | json_field shutdownGraceSeconds
  }

  # set_user_grace USER_ID SECONDS -- prints the value the API reports back.
  set_user_grace() {
    vm_get carol "${API}/admin/users/$1/settings" \
      "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":$2}'" \
      | json_field shutdownGraceSeconds
  }

  # >>> smoke-cleanup-begin (extracted by infra/tests/cleanup-scope-test.sh)
  # sql_in_list ITEM... prints 'a','b' for an SQL IN clause.
  sql_in_list() {
    local out="" item
    for item in "$@"; do
      out="${out}${out:+,}'${item}'"
    done
    printf '%s' "$out"
  }

  # Clean up Epic 3 and 4 resources.  Only what this run recorded is
  # deleted: an earlier version removed every workspace owned by a mock
  # account, and on the pilot an operator signs in as one of them.
  cleanup_epic34() {
    echo ""
    echo "Cleaning up Epic 3 and 4 smoke resources..."
    # Put the administrator's grace period back while carol can still sign in.
    if [ -n "${orig_grace:-}" ]; then
      set_global_grace "${orig_grace}" >/dev/null 2>&1 || true
    fi

    local ws_count=${#created_workspace_ids[@]}
    local user_count=${#created_user_subjects[@]}
    local instance_count=${#created_instance_names[@]}
    echo "This run created ${ws_count} workspace row(s), ${instance_count} Incus instance(s) and ${user_count} user row(s). Nothing else is deleted."

    if [ "$ws_count" -gt 0 ]; then
      local ws_list
      ws_list=$(sql_in_list "${created_workspace_ids[@]}")
      echo "Deleting workspace rows: ${created_workspace_ids[*]}"
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspace_connections WHERE workspace_id IN (${ws_list})\"" 2>/dev/null || true
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM audit_events WHERE target IN (${ws_list})\"" 2>/dev/null || true
      # Archiving a project audits against the project id, which no longer
      # resolves once the workspace cascade removes the project row.
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM audit_events WHERE target IN (SELECT id::text FROM projects WHERE workspace_id IN (${ws_list}))\"" 2>/dev/null || true
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM workspaces WHERE id IN (${ws_list})\"" 2>/dev/null || true
    fi

    if [ "$user_count" -gt 0 ]; then
      local user_list
      user_list=$(sql_in_list "${created_user_subjects[@]}")
      echo "Deleting user rows this run created: ${created_user_subjects[*]}"
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE oidc_subject IN (${user_list}))\"" 2>/dev/null || true
      # A user who still owns a workspace stays: that workspace is not ours.
      ssh_cmd "sudo -u postgres psql -d portikus -c \"DELETE FROM users u WHERE u.oidc_subject IN (${user_list}) AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_user_id = u.id)\"" 2>/dev/null || true
    fi

    if [ "$instance_count" -gt 0 ]; then
      echo "Destroying Incus instances: ${created_instance_names[*]}"
      local instance
      for instance in "${created_instance_names[@]}"; do
        ssh_cmd "bash ${WORKSPACE_SCRIPT} destroy ${instance}" 2>/dev/null || true
      done
    fi

    ssh_cmd "rm -f /tmp/portikus-smoke-*.jar /tmp/portikus-smoke-project.* ${WS_PROBE} ${WS_STOP} ${TERM_PROBE} ${TERM_STOP}" 2>/dev/null || true
  }
  # <<< smoke-cleanup-end

  # Wrap both cleanups so a single trap covers Epic 2 and Epic 3 and 4.  The
  # trap is set here as well, because the Epic 2 block is skipped when the
  # workspace image is missing and then nothing else would arm it.
  cleanup_all() {
    cleanup_epic34
    if [ -n "${WS_NAME:-}" ]; then
      echo ""
      echo "Destroying ${WS_NAME}..."
      ssh_cmd bash "${WORKSPACE_SCRIPT}" destroy "${WS_NAME}" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_all EXIT

  # 0. The control plane came from the Debian package, not a build on the VM.
  check "portikus package is installed"  ssh_cmd dpkg -s portikus
  check "no pnpm on the VM"              ssh_cmd "! command -v pnpm"
  check "no built app tree on the VM"    ssh_cmd test ! -e /var/lib/portikus/app

  # 1. Units are active and the controller stays private.
  check "portikus-api is active"        ssh_cmd systemctl is-active portikus-api
  check "portikus-worker is active"     ssh_cmd systemctl is-active portikus-worker
  check "portikus-controller is active" ssh_cmd systemctl is-active portikus-controller
  check "controller /health returns 200" \
    ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health) = 200"
  check "controller rejects unauthenticated requests" \
    ssh_cmd "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/instances) = 401"

  # 2. Caddy serves the site over TLS and the API through it.
  check "caddy is active"                       ssh_cmd systemctl is-active caddy
  check_output "https / returns 200"      "200" http_status - "${API}/"
  check_output "/health through Caddy"    "200" http_status - "${API}/health"
  redirects_to_https() {
    local status
    status=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' 'http://${PUBLIC_HOST}/'")
    case "$status" in 30*) return 0 ;; *) return 1 ;; esac
  }
  check "http redirects to https"               redirects_to_https
  check "HSTS header on /" \
    site_header_matches 'strict-transport-security: max-age=31536000'
  check "frame-ancestors header on /" \
    site_header_matches "content-security-policy: frame-ancestors 'none'"

  # 3. The provider was checked above, before this block.

  # 4. Nothing works without a session.
  check_output "/auth/me is 401 anonymously"    "401" http_status - "${API}/auth/me"
  check_output "POST /workspaces is 401 anonymously" "401" \
    http_status - "${API}/workspaces" "-X POST -H 'Origin: ${API}'"

  # 4b. Anything already on the VM belongs to somebody else.  List it and
  #     leave it alone, and remember which mock user rows were already there.
  #     POST /workspaces is idempotent, so on a VM where a mock account
  #     already has a workspace the test would be handed that workspace and
  #     later destroy it; the lifecycle checks are skipped instead.  They are
  #     also skipped for a workspace belonging to anyone else, because they
  #     shorten the platform grace period and would stop it.
  echo ""
  echo "Looking for workspaces that exist before this run..."
  existing_workspaces=$(ssh_cmd "sudo -u postgres psql -t -A -F' ' -d portikus -c \"SELECT COALESCE(u.oidc_subject, '(unknown)'), w.id, w.incus_instance_name FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id ORDER BY 1\"" 2>/dev/null || true)
  skip_lifecycle=no
  if [ -n "$existing_workspaces" ]; then
    skip_lifecycle=yes
    echo "These workspaces already exist and this run will not touch them:"
    echo "$existing_workspaces" | awk '{ print "  " $0 }'
    # On a restored rehearsal copy every restored workspace is stopped, and
    # this run's own users cannot be handed one, so the lifecycle still runs.
    if [ -n "$RESTORED_SET" ] && [ "$IDP" != mock ] && [ "${#restored_ids[@]}" -gt 0 ]; then
      unrestored=$(echo "$existing_workspaces" | awk '{ print $2 }' | grep -cvxF -f <(printf '%s\n' "${restored_ids[@]}") || true)
      if [ "$unrestored" = 0 ]; then
        skip_lifecycle=no
        echo "They are all from the restored set, so the lifecycle checks run beside them."
      fi
    fi
  else
    echo "None."
  fi

  # 5. Sign alice, bob, and carol in: through the mock when it is on,
  #    otherwise as users this run makes in PostgreSQL.
  echo ""
  if [ "$IDP" = "mock" ]; then
    existing_users=$(ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT oidc_subject FROM users WHERE oidc_subject IN ('alice','bob','carol')\"" 2>/dev/null || true)
    echo "Logging in as alice, bob, and carol through the mock provider..."
    for mock_user in alice bob carol; do
      login_as "$mock_user" >/dev/null 2>&1 || true
      if ! echo "$existing_users" | grep -qx "$mock_user"; then
        created_user_subjects+=("$mock_user")
      fi
    done
  else
    echo "Making alice, bob, and carol under ${SMOKE_ISSUER}, run ${SMOKE_RUN_ID}..."
    mint_user alice "Alice Student" student
    mint_user bob "Bob Student" student
    mint_user carol "Carol Administrator" administrator
  fi
  alice_me=$(vm_get alice "${API}/auth/me")
  alice_name=$(echo "$alice_me" | json_field displayName)
  alice_id=$(echo "$alice_me" | json_field id)
  check_output "alice is signed in" "Alice Student" echo "$alice_name"
  check "/auth/me carries alice's user id"      test -n "$alice_id"

  # 5b. The API logs one structured line per request, and a refused request
  #     is logged server side with its status (ADR 0012, SPEC.md 25.6).  This
  #     runs after a real authenticated request, because /health is logged at
  #     debug on purpose and so leaves nothing behind at the default level.
  api_journal_has() {
    ssh_cmd "sudo journalctl -u portikus-api --since '5 min ago' --no-pager | grep -q -- '$1'"
  }
  check "api logs one line per request" api_journal_has '"msg":"request"'
  # Authentication runs before routing, so an anonymous request to an unknown
  # route is refused with 401 rather than reaching the 404 handler.
  check_output "an anonymous request to an unknown route is refused with 401" "401" \
    ssh_cmd "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${API_PORT}/no-such-route"
  # One line must carry the warn level, the 401, and the code, and journald can
  # lag a moment behind the response.
  api_journal_has_warn_401() {
    for _ in $(seq 1 3); do
      if api_journal_has '"level":"warn".*"status":401.*"code":"UNAUTHORIZED"'; then return 0; fi
      sleep 1
    done
    return 1
  }
  check "the refused request is logged at warn" api_journal_has_warn_401

  # 5c. Shorten the grace period for the lifecycle checks below.  The original
  #     value is recorded here and put back by cleanup_epic34.  The platform
  #     value applies to every workspace, so it is left alone when somebody
  #     else's workspace is on this VM.
  check_output "a student is refused the admin settings" "403" \
    http_status bob "${API}/admin/settings"
  if [ "$skip_lifecycle" = "no" ]; then
    orig_grace=$(admin_grace)
    check "read the platform grace period as carol" test -n "$orig_grace"
    check_output "admin sets the grace period to 20s" "20" set_global_grace 20
  fi

  # 6. Provision alice's workspace.  The request carries no body: the owner
  #    comes from the session, and the Origin header satisfies the CSRF check.
  echo ""
  ws_response=""
  ws_id=""
  if [ "$skip_lifecycle" = "no" ]; then
    echo "Provisioning a workspace for alice..."
    ws_response=$(vm_get alice "${API}/workspaces" "-X POST -H 'Origin: ${API}'")
    ws_id=$(echo "$ws_response" | json_field id)
  fi

  if [ "$skip_lifecycle" = "yes" ]; then
    echo "A workspace this run did not create is already on this VM."
    echo "Skipping the lifecycle, terminal, and project checks, and leaving it alone."
    echo "Run them against a VM nobody is using."
    # After a restore, the lifecycle block is the point of the run.
    if [ -n "$RESTORED_SET" ]; then
      printf '\033[1;31mFAIL\033[0m  %s\n' "the lifecycle checks were skipped on the restored VM"
      fail=$((fail + 1))
    fi
  elif [ -z "$ws_id" ]; then
    printf '\033[1;31mFAIL\033[0m  POST /workspaces returned no id: %s\n' "$ws_response"
    fail=$((fail + 1))
  else
    created_workspace_ids+=("$ws_id")
    printf '\033[1;32mPASS\033[0m  POST /workspaces returned id=%s\n' "$ws_id"
    pass=$((pass + 1))

    # Poll until the workspace reaches "stopped" (provisioned).
    echo "Waiting for workspace to reach stopped state..."
    ws_state=""
    for _ in $(seq 1 60); do
      ws_state=$(workspace_state)
      if [ "$ws_state" = "stopped" ]; then break; fi
      sleep 2
    done
    check_output "workspace reaches stopped after provision" "stopped" echo "$ws_state"

    ws_instance=$(vm_get alice "${API}/workspaces/${ws_id}" | json_field incusInstanceName)
    if [ -n "$ws_instance" ]; then
      created_instance_names+=("$ws_instance")
      check "Incus instance exists and is Stopped" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
    fi

    # 7. Install the presence WebSocket client on the VM.  It sends one
    #    heartbeat, waits for the first server message, and stays open until
    #    the stop file appears, which is how the test controls the session.
    ssh_cmd_stdin "cat > ${WS_PROBE}" <<'PROBE'
import fs from "node:fs";
const [url, origin, stopFile] = process.argv.slice(2);
// The session cookie arrives on standard input so that it never appears
// in a command line or a process list.
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
let sawMessage = false;
ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "heartbeat" })));
ws.addEventListener("message", () => {
	if (!sawMessage) {
		sawMessage = true;
		console.log("message");
	}
});
ws.addEventListener("error", (event) => {
	console.error("socket error", event.message ?? "");
	process.exit(1);
});
ws.addEventListener("close", () => process.exit(sawMessage ? 0 : 1));
const poll = setInterval(() => {
	if (fs.existsSync(stopFile)) {
		clearInterval(poll);
		ws.close();
	}
}, 500);
// Safety net: never leave the probe running if the test dies.
setTimeout(() => ws.close(), 300000);
PROBE

    alice_cookie=$(session_cookie alice)
    probe_log=$(mktemp)

    open_socket() {
      ssh_cmd "rm -f ${WS_STOP}"
      printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
        | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt node ${WS_PROBE} \
        'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/ws' '${API}' '${WS_STOP}'" >"$probe_log" 2>&1 &
      probe_pid=$!
      sleep 3
    }

    close_socket() {
      ssh_cmd "touch ${WS_STOP}"
      wait "$probe_pid" || true
      sleep 2
    }

    # 8. Starts on connect: opening the socket makes the workspace run.
    echo ""
    echo "Opening the presence WebSocket..."
    open_socket
    check "socket received a workspace message"   grep -q message "$probe_log"
    check_output "one connection row while open" "1" connection_count

    echo "Waiting for workspace to reach running state..."
    ws_state=$(wait_for_state running 60)
    check_output "workspace reaches running after connect" "running" echo "$ws_state"

    if [ -n "$ws_instance" ]; then
      check "Incus instance is Running" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: RUNNING'"
    fi

    # 9. Stays up during grace: close the socket, wait 10 s, still running.
    echo ""
    echo "Closing the socket to test the grace period..."
    close_socket
    check_output "no connection rows after close" "0" connection_count
    sleep 10
    check_output "still running 10s after disconnect" "running" echo "$(workspace_state)"
    check_output "shutdown deadline is set" "set" echo "$(workspace_deadline)"

    # 10. Reconnect cancels the deadline.
    echo ""
    echo "Reconnecting to cancel the shutdown deadline..."
    open_socket
    ws_deadline=""
    for _ in $(seq 1 6); do
      ws_deadline=$(workspace_deadline)
      if [ "$ws_deadline" = "null" ]; then break; fi
      sleep 1
    done
    check_output "reconnect clears deadline" "null" echo "$ws_deadline"

    # Still running after 25 s (grace was 20 s — it would have stopped).
    sleep 25
    check_output "still running 25s after reconnect" "running" echo "$(workspace_state)"

    # 10b. Zero means indefinite: a disconnected workspace keeps running and
    #      no deadline is ever armed.
    echo ""
    echo "Setting the platform grace period to 0 (never stop)..."
    check_output "admin sets the grace period to 0" "0" set_global_grace 0
    close_socket
    sleep 25
    check_output "still running 25s after disconnect at grace 0" "running" \
      echo "$(workspace_state)"
    check_output "no shutdown deadline at grace 0" "null" echo "$(workspace_deadline)"

    # 10c. A per-user override beats the global value and applies at once, even
    #      though alice disconnected before it was set.  60 s first, so the
    #      deadline is visible in the future; 10 s then puts it in the past and
    #      the workspace stops on that sweep.
    echo ""
    echo "Giving alice an override while the platform value stays 0..."
    check_output "admin sets alice's override to 60" "60" set_user_grace "$alice_id" 60
    ws_deadline=""
    for _ in $(seq 1 10); do
      ws_deadline=$(workspace_deadline)
      if [ "$ws_deadline" = "set" ]; then break; fi
      sleep 1
    done
    check_output "alice's override arms a deadline" "set" echo "$ws_deadline"
    check_output "still running on the 60s override" "running" echo "$(workspace_state)"

    check_output "admin shortens alice's override to 10" "10" set_user_grace "$alice_id" 10
    check_output "workspace stops once the override expires" "stopped" \
      echo "$(wait_for_state stopped 60)"

    # Back to where this test started: no override, platform value 20 s.
    check_output "admin clears alice's override" "200" \
      http_status carol "${API}/admin/users/${alice_id}/settings" \
      "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"shutdownGraceSeconds\":null}'"
    check_output "admin sets the grace period back to 20s" "20" set_global_grace 20

    echo ""
    echo "Reconnecting before the grace expiry check..."
    open_socket
    check_output "workspace runs again after reconnect" "running" \
      echo "$(wait_for_state running 60)"

    # 11. Stops after grace: close the socket and wait.
    echo ""
    echo "Closing the socket to let the grace period expire..."
    close_socket
    ws_state=$(wait_for_state stopped 60)
    check_output "workspace stops after grace expires" "stopped" echo "$ws_state"

    if [ -n "$ws_instance" ]; then
      check "Incus instance is Stopped after grace" \
        ssh_cmd "incus info ${ws_instance} --project ${PROJECT} 2>/dev/null | grep -q 'Status: STOPPED'"
    fi

    check "audit_events has workspace.stop" \
      ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE action = 'workspace.stop'\" | grep -qv '^0$'"

    # 12. Explicit start then stop through the API.
    echo ""
    echo "Testing explicit start/stop..."
    http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
    check_output "explicit start reaches running" "running" echo "$(wait_for_state running 60)"

    http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
    check_output "explicit stop reaches stopped" "stopped" echo "$(wait_for_state stopped 60)"

    # 13. Persistence across an API-driven stop and start.
    if [ -n "$ws_instance" ]; then
      echo ""
      echo "Re-running persistence check on ${ws_instance}..."
      http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
      ws_state=$(wait_for_state running 60)

      if [ "$ws_state" = "running" ]; then
        sleep 5
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'echo epic3-persist > ~/projects/.epic3-marker'" 2>/dev/null || true
        http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
        wait_for_state stopped 60 >/dev/null
        http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
        wait_for_state running 60 >/dev/null
        sleep 5
        check "persistence marker survives restart (Epic 2 re-check)" \
          ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'cat ~/projects/.epic3-marker'" 2>/dev/null
      fi
    fi

    # 14. Epic 5: the terminal transport end to end (SPEC.md 9.7, ADR 0009).
    #     The workspace must be running, so this block opens the presence
    #     socket again and later hands the workspace over to a terminal
    #     socket to prove a terminal counts as presence on its own.
    echo ""
    echo "Epic 5: terminal transport..."
    open_socket
    ws_state=$(wait_for_state running 60)

    # The probe speaks the browser end of the pipe: it sends one line of
    # input, then reads frames until the marker appears.  A carriage
    # return is appended here so the shell runs the line.
    ssh_cmd_stdin "cat > ${TERM_PROBE}" <<'TERMPROBE'
import fs from "node:fs";
// url, origin, input ("-" for none), marker ("-" for none),
// stop file ("-" for none), timeout in milliseconds.
const [url, origin, input, marker, stopFile, timeoutMs] = process.argv.slice(2);
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
ws.binaryType = "arraybuffer";
let screen = "";
let found = marker === "-";
// Wait for a frame of output before sending input. The first frame is now
// the agent's replay of the pane's history, not tmux's own drawing, so this
// no longer proves tmux is ready; what makes the input safe is the agent's
// queue, which holds it until tmux has drawn something.
let sent = input === "-";
function sendInput() {
	if (sent) return;
	sent = true;
	ws.send(JSON.stringify({ type: "input", data: `${input}\r` }));
}
// Fall back after a bounded wait in case the terminal prints nothing.
const sendTimer = setTimeout(sendInput, 5000);
ws.addEventListener("message", (event) => {
	clearTimeout(sendTimer);
	sendInput();
	screen +=
		typeof event.data === "string"
			? event.data
			: Buffer.from(event.data).toString("utf8");
	if (!found && screen.includes(marker)) {
		found = true;
		if (stopFile === "-") ws.close();
	}
});
ws.addEventListener("error", (event) => {
	console.error("socket error", event.message ?? "");
	process.exit(1);
});
ws.addEventListener("close", () => process.exit(found ? 0 : 1));
const poll =
	stopFile === "-"
		? null
		: setInterval(() => {
				if (fs.existsSync(stopFile)) ws.close();
			}, 500);
setTimeout(() => {
	if (poll) clearInterval(poll);
	clearTimeout(sendTimer);
	ws.close();
}, Number(timeoutMs));
TERMPROBE

    # term_probe TERMINAL_ID INPUT MARKER STOP_FILE TIMEOUT_MS
    term_probe() {
      printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
        | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt node ${TERM_PROBE} \
          'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/terminals/${1}/ws' '${API}' \
          '${2}' '${3}' '${4}' '${5}'"
    }

    # The tmux sessions the student user can see inside the workspace.
    tmux_has_session() {
      ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'tmux list-sessions -F \"#{session_name}\"'" 2>/dev/null \
        | grep -qx "pk-$1"
    }
    tmux_lacks_session() { ! tmux_has_session "$1"; }

    # A browser navigating to the workspace page must get the bundle, while
    # the JSON routes under the same prefix still answer as the API.
    workspace_page_is_bundle() {
      vm_get alice "${API}/workspaces/${ws_id}" \
        "-H 'Sec-Fetch-Dest: document' -H 'Accept: text/html'" | grep -q '<div id="root">'
    }
    terminal_list_is_json() {
      vm_get alice "${API}/workspaces/${ws_id}/terminals" | grep -q '"terminals"'
    }

    new_terminal() {
      vm_get alice "${API}/workspaces/${ws_id}/terminals" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{}'"
    }

    term_response=$(new_terminal)
    term_id=$(echo "$term_response" | json_field id)

    if [ -z "$term_id" ]; then
      printf '\033[1;31mFAIL\033[0m  POST /terminals returned no id: %s\n' "$term_response"
      fail=$((fail + 1))
    else
      printf '\033[1;32mPASS\033[0m  POST /terminals returned id=%s\n' "$term_id"
      pass=$((pass + 1))

      check "tmux session pk-<id> runs in the workspace" tmux_has_session "$term_id"

      # A terminal carries what the shell prints back over the socket.
      # The marker is typed in two quoted halves, so it only appears whole
      # in the command's output and never in the echo of the typing.
      mark_a="MARK-${RANDOM}"
      mark_b="${RANDOM}"
      mark="${mark_a}${mark_b}"
      check "terminal socket carries input and output" \
        term_probe "$term_id" "echo ${mark_a}\"${mark_b}\"" "$mark" - 30000

      # Every login shell reads /etc/profile.d/portikus.sh, which the
      # controller writes at start, so a terminal knows the preview suffix
      # (issue #263).  The typed command holds only the variable name, so the
      # suffix can only appear once the shell has expanded it.
      # shellcheck disable=SC2016  # the shell inside the workspace expands it
      check "terminal shell knows the preview host suffix" \
        term_probe "$term_id" 'echo $PORTIKUS_PREVIEW_HOST_SUFFIX' \
        "$PREVIEW_SUFFIX" - 30000

      # The workspace runs in the deployment's default zone unless the
      # student picked another (issue #287). The typed command holds only
      # the variable name, so the zone can only appear once the shell has
      # expanded it.
      # shellcheck disable=SC2016  # the shell inside the workspace expands it
      check "terminal shell runs in the default timezone" \
        term_probe "$term_id" 'echo $TZ' "America/New_York" - 30000

      # A student who changes the zone gets it in the next terminal they
      # open, without restarting the workspace: the agent puts TZ in the new
      # tmux session's environment (issue #287).  The abbreviation is worked
      # out on the VM so the check does not hard-code daylight saving.
      chosen_zone="America/Los_Angeles"
      chosen_abbrev=$(ssh_cmd "TZ=${chosen_zone} date +%Z")
      # The answer carries the whole list of zone names as well as the
      # settings, and that list always holds the chosen zone, so the check
      # looks for the settings field rather than the bare name.
      set_zone() {
        vm_get alice "${API}/me/settings" \
          "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' \
            -d '{\"timezone\":\"${chosen_zone}\"}'" \
          | grep -q "\"timezone\":\"${chosen_zone}\""
      }
      check "a student can change the workspace timezone" set_zone

      zone_term_id=$(new_terminal | json_field id)
      if [ -z "$zone_term_id" ]; then
        printf '\033[1;31mFAIL\033[0m  POST /terminals for the zone check returned no id\n'
        fail=$((fail + 1))
      else
        check "a terminal opened after the change runs in the chosen zone" \
          term_probe "$zone_term_id" "date +%Z" "$chosen_abbrev" - 30000
      fi

      # Reattaching inside the grace period redraws the same tmux screen,
      # so the marker written a moment ago is still on it (SPEC.md 9.2).
      check "reattached terminal shows the earlier output" \
        term_probe "$term_id" - "$mark" - 20000

      # Two sockets share one tmux session, so output caused by one
      # reaches the other (SPEC.md 9.5).
      mark2_a="MARK-${RANDOM}"
      mark2_b="${RANDOM}"
      mark2="${mark2_a}${mark2_b}"
      term_probe "$term_id" - "$mark2" - 30000 >/dev/null 2>&1 &
      watcher_pid=$!
      sleep 3
      term_probe "$term_id" "echo ${mark2_a}\"${mark2_b}\"" "$mark2" - 30000 >/dev/null 2>&1
      check "second socket on the same terminal sees new output" wait "$watcher_pid"

      # A terminal socket counts as presence on its own (SPEC.md 6.4):
      # hold one open, drop the presence socket, and the workspace stays up.
      echo ""
      echo "Checking that a terminal socket alone keeps the workspace up..."
      ssh_cmd "rm -f ${TERM_STOP}"
      term_probe "$term_id" - - "${TERM_STOP}" 120000 >/dev/null 2>&1 &
      term_hold_pid=$!
      sleep 3
      close_socket
      check_output "terminal socket is the only connection row" "1" connection_count
      check_output "terminal socket keeps the deadline clear" "null" workspace_deadline
      sleep 25
      check_output "still running 25s on the terminal socket alone" "running" workspace_state
      ssh_cmd "touch ${TERM_STOP}"
      wait "$term_hold_pid" || true
      sleep 2

      # The agent answers only with the per-workspace token, and only to
      # the VM: peers on the bridge are cut off (SPEC.md 23.3, 23.5).
      echo ""
      echo "Checking agent reachability..."
      agent_ip=$(workspace_ip "${ws_instance}")
      agent_token=$(ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT agent_token FROM workspaces WHERE id = '${ws_id}'\"" 2>/dev/null || true)
      if [ -n "$agent_ip" ] && [ -n "$agent_token" ]; then
        check_output "agent /health without a token is 401" "401" \
          ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${agent_ip}:7400/health"
        check_output "agent /health with the workspace token is 200" "200" \
          ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Authorization: Bearer ${agent_token}' http://${agent_ip}:7400/health"
      else
        printf '\033[1;31mFAIL\033[0m  no agent address or token for the workspace\n'
        fail=$((fail + 1))
      fi

      if [ -n "${WS_NAME:-}" ] && [ -n "$agent_ip" ]; then
        check "another workspace cannot reach the agent" \
          ws_exec "! curl -s --max-time 5 -o /dev/null http://${agent_ip}:7400/health"
      fi

      # The preview gateway has to open the student's own application port,
      # and only the VM may do it (BROWSER-HANDLING 10 and 16.3). A throwaway
      # listener on a port nothing else uses proves both halves.
      if [ -n "$agent_ip" ]; then
        echo ""
        echo "Checking application-port reachability..."
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'setsid nohup python3 -m http.server 8111 --bind 0.0.0.0 >/dev/null 2>&1 < /dev/null &'" >/dev/null 2>&1 || true
        sleep 2
        check_output "the VM can reach an application port in the workspace" "200" \
          ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${agent_ip}:8111/"
        if [ -n "${WS_NAME:-}" ]; then
          check "another workspace cannot reach that port" \
            ws_exec "! curl -s --max-time 5 -o /dev/null http://${agent_ip}:8111/"
        fi
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- pkill -f 'http.server 8111'" >/dev/null 2>&1 || true
      fi

      check "workspace page serves the web bundle to a browser" workspace_page_is_bundle
      check "terminal list under the same prefix is still JSON" terminal_list_is_json

      # Deleting a terminal ends its tmux session (SPEC.md 9.3).
      echo ""
      echo "Deleting the terminal..."
      check_output "DELETE terminal returns 204" "204" \
        http_status alice "${API}/workspaces/${ws_id}/terminals/${term_id}" \
        "-X DELETE -H 'Origin: ${API}'"
      check "tmux session is gone after delete" tmux_lacks_session "$term_id"

      # A terminal still open when the workspace stops is marked ended by
      # the worker (SPEC.md 9.7).
      second_id=$(new_terminal | json_field id)
      http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
      wait_for_state stopped 60 >/dev/null
      if [ -n "$second_id" ]; then
        check "open terminal is marked ended when the workspace stops" \
          ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT ended_at IS NOT NULL FROM terminals WHERE id = '${second_id}'\" | grep -qx t"
      else
        printf '\033[1;31mFAIL\033[0m  second POST /terminals returned no id\n'
        fail=$((fail + 1))
      fi
    fi

    # 15. Epic 6: project management end to end (SPEC.md 7, plan wave 3).
    #     Every request goes through Caddy as alice, and every effect is
    #     confirmed inside the container, because a project is a database
    #     row and a directory under ~/projects that have to agree.
    echo ""
    echo "Epic 6: project management..."

    # Project work needs the workspace up, and the shortened grace period
    # would stop it part-way through, so hold the presence socket open.
    open_socket
    ws_state=$(wait_for_state running 60)
    check_output "workspace is running for the project checks" "running" \
      echo "$ws_state"

    PROJECTS_URL="${API}/workspaces/${ws_id}/projects"
    PROJECTS_DIR="/home/student/projects"
    ZIP_ON_VM="/tmp/portikus-smoke-project.zip"
    ZIP_HEADERS="/tmp/portikus-smoke-project.headers"

    # Run a command as the student user inside alice's workspace.
    alice_student() {
      local escaped="${*//\'/\'\\\'\'}"
      ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c '${escaped}'"
    }

    # One field of the project with the given slug in a project list body.
    # JSON booleans print as true or false; an absent project prints nothing.
    project_field() {
      python3 -c '
import json, sys

slug, field = sys.argv[1], sys.argv[2]
for project in json.load(sys.stdin).get("projects", []):
    if project.get("slug") == slug:
        value = project.get(field)
        if value is True:
            print("true")
        elif value is False:
            print("false")
        elif value is not None:
            print(value)
        break
' "$1" "$2" 2>/dev/null || true
    }

    active_field() { vm_get alice "${PROJECTS_URL}" | project_field "$1" "$2"; }
    archived_field() {
      vm_get alice "${PROJECTS_URL}?state=archived" | project_field "$1" "$2"
    }

    # The recorded working directory of one terminal.
    terminal_cwd() {
      vm_get alice "${API}/workspaces/${ws_id}/terminals" | python3 -c '
import json, sys

wanted = sys.argv[1]
for terminal in json.load(sys.stdin).get("terminals", []):
    if terminal.get("id") == wanted:
        print(terminal.get("cwd", ""))
        break
' "$1" 2>/dev/null || true
    }

    # 15.1 Create a project (SPEC.md 7.2).
    proj_response=$(vm_get alice "${PROJECTS_URL}" \
      "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
       -d '{\"name\": \"Smoke Project\", \"source\": \"new\"}'")
    proj_id=$(echo "$proj_response" | json_field id)

    if [ -z "$proj_id" ]; then
      printf '\033[1;31mFAIL\033[0m  POST /projects returned no id: %s\n' "$proj_response"
      fail=$((fail + 1))
    else
      printf '\033[1;32mPASS\033[0m  POST /projects returned id=%s\n' "$proj_id"
      pass=$((pass + 1))

      proj_slug=$(echo "$proj_response" | json_field slug)
      proj_path=$(echo "$proj_response" | json_field path)
      check_output "created project has slug smoke-project" "smoke-project" \
        echo "$proj_slug"
      check_output "created project path is under ~/projects" \
        "${PROJECTS_DIR}/smoke-project" echo "$proj_path"
      check "project directory exists in the workspace" \
        alice_student "test -d ${PROJECTS_DIR}/smoke-project"
      check "project directory is a git repository" \
        alice_student "test -d ${PROJECTS_DIR}/smoke-project/.git"

      # 15.2 A terminal opened on the project starts in its directory (SPEC.md 9.4).
      proj_term_response=$(vm_get alice "${API}/workspaces/${ws_id}/terminals" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"projectId\": \"${proj_id}\"}'")
      proj_term_id=$(echo "$proj_term_response" | json_field id)
      proj_term_cwd=$(echo "$proj_term_response" | json_field cwd)
      check_output "terminal on the project starts in the project directory" \
        "${PROJECTS_DIR}/smoke-project" echo "$proj_term_cwd"

      # 15.3 The listing reports what the agent sees on disk.
      check_output "project is listed as a git repository" "true" \
        active_field smoke-project isGitRepo
      check_output "project is not listed as missing" "false" \
        active_field smoke-project missing

      # 15.4 Renaming moves the directory and rewrites terminal paths.
      rename_response=$(vm_get alice "${PROJECTS_URL}/${proj_id}" \
        "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"name\": \"Smoke Renamed\"}'")
      renamed_slug=$(echo "$rename_response" | json_field slug)
      check_output "rename gives the slug smoke-renamed" "smoke-renamed" \
        echo "$renamed_slug"
      check "old project directory is gone" \
        alice_student "! test -e ${PROJECTS_DIR}/smoke-project"
      check "renamed project directory exists" \
        alice_student "test -d ${PROJECTS_DIR}/smoke-renamed"
      if [ -n "$proj_term_id" ]; then
        check_output "rename rewrites the terminal working directory" \
          "${PROJECTS_DIR}/smoke-renamed" terminal_cwd "$proj_term_id"
      else
        printf '\033[1;31mFAIL\033[0m  POST /terminals with a projectId returned no id\n'
        fail=$((fail + 1))
      fi

      # 15.5 Download is a zip named after the slug (SPEC.md 7.3).  unzip is
      #      in the workspace image but not promised on the VM, so the
      #      archive is pushed back into the container and tested there.
      dl_status=$(ssh_cmd "${CURL} -b /tmp/portikus-smoke-alice.jar \
        -D ${ZIP_HEADERS} -o ${ZIP_ON_VM} -w '%{http_code}' \
        '${PROJECTS_URL}/${proj_id}/download'")
      check_output "download returns 200" "200" echo "$dl_status"
      # A failure leaves a JSON error in the body; show it, or the run only
      # says 400 and the reason stays on the VM.
      if [ "$dl_status" != "200" ]; then
        printf '      download body: %s\n' "$(ssh_cmd "head -c 400 ${ZIP_ON_VM}")"
      fi
      check "download is served as application/zip" \
        ssh_cmd "grep -qi 'content-type: application/zip' ${ZIP_HEADERS}"
      check "download is named smoke-renamed.zip" \
        ssh_cmd "grep -qi 'filename=\"smoke-renamed.zip\"' ${ZIP_HEADERS}"
      ssh_cmd "incus file push ${ZIP_ON_VM} ${ws_instance}/tmp/smoke-download.zip --project ${PROJECT}" \
        >/dev/null 2>&1 || true
      check "downloaded archive passes unzip -t" \
        ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- unzip -t /tmp/smoke-download.zip"

      # 15.6 Anything Git-enabled under ~/projects becomes a project; a
      #      plain directory does not (plan, Discovery).
      alice_student "mkdir -p ${PROJECTS_DIR}/hand-made && git -C ${PROJECTS_DIR}/hand-made init -q" \
        >/dev/null 2>&1 || true
      alice_student "mkdir -p ${PROJECTS_DIR}/plain-dir" >/dev/null 2>&1 || true
      check_output "a git repository made by hand is discovered" "discovered" \
        active_field hand-made source
      check_output "a plain directory is not a project" "" \
        active_field plain-dir slug

      # 15.7 Archiving hides the project but keeps the directory (SPEC.md 7.4).
      vm_get alice "${PROJECTS_URL}/${proj_id}" \
        "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"state\": \"archived\"}'" >/dev/null
      check_output "archived project leaves the active list" "" \
        active_field smoke-renamed slug
      check_output "archived project is in the archived list" "smoke-renamed" \
        archived_field smoke-renamed slug
      check "archived project keeps its directory" \
        alice_student "test -d ${PROJECTS_DIR}/smoke-renamed"

      vm_get alice "${PROJECTS_URL}/${proj_id}" \
        "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"state\": \"active\"}'" >/dev/null
      check_output "unarchived project is active again" "smoke-renamed" \
        active_field smoke-renamed slug

      # 15.8 Leave ~/projects as the run found it.  There is no delete route,
      #      so the rows go with the workspace the cleanup function removes.
      if [ -n "$proj_term_id" ]; then
        check_output "DELETE project terminal returns 204" "204" \
          http_status alice "${API}/workspaces/${ws_id}/terminals/${proj_term_id}" \
          "-X DELETE -H 'Origin: ${API}'"
      fi
      alice_student "rm -rf ${PROJECTS_DIR}/smoke-renamed ${PROJECTS_DIR}/hand-made ${PROJECTS_DIR}/plain-dir" \
        >/dev/null 2>&1 || true
      ssh_cmd "rm -f ${ZIP_ON_VM} ${ZIP_HEADERS}" >/dev/null 2>&1 || true
    fi

    # 15b. Epic 10: recovery points, Reset Docker and Rebuild (SPEC.md 15,
    #      16.4, 17.2). Reset and rebuild are destructive, so they only ever
    #      name the instance this run created; this block sits inside the
    #      branch that runs only when no other workspace is on the VM.
    echo ""
    echo "Epic 10: recovery points, Reset Docker and Rebuild..."
    RECOVERY_ROOT="/var/lib/portikus/recovery"
    RS_DIR="${PROJECTS_DIR}/recovery-smoke"
    RS_GIT="git -c user.name=Smoke -c user.email=smoke@example.invalid"

    epic10_owns_instance() {
      local name
      for name in "${created_instance_names[@]}"; do
        [ "$name" = "$ws_instance" ] && return 0
      done
      return 1
    }

    # Run as root inside alice's workspace.
    alice_root() {
      local escaped="${*//\'/\'\\\'\'}"
      ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c '${escaped}'"
    }

    # "<state> <pendingOperation>", with "none" when no operation is pending.
    op_status() {
      vm_get alice "${API}/workspaces/${ws_id}" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('state'), d.get('pendingOperation') or 'none')" 2>/dev/null || true
    }

    # The API only records the operation. The worker stops the workspace,
    # waits for the Incus operation to finish, clears the pending operation
    # and starts it again. A rebuild first waits for its before-rebuild
    # points, which the recovery sweep makes once a minute.
    wait_for_operation() {
      local status=""
      for _ in $(seq 1 120); do
        status=$(op_status)
        if [ "$status" = "running none" ]; then break; fi
        sleep 2
      done
      echo "$status"
    }

    # HEAD, every ref, the stash, the reflog and the index bytes, hashed.
    rs_git_state() {
      alice_student "cd ${RS_DIR} && { git rev-parse HEAD; git for-each-ref; git stash list; git reflog; sha256sum .git/index; } | sha256sum"
    }

    # The project has a point made for the given reason.
    rs_has_point_reason() {
      vm_get alice "${PROJECTS_URL}/${rs_id}/recovery-points" \
        | python3 -c "import sys,json; sys.exit(0 if any(p['reason'] == sys.argv[1] for p in json.load(sys.stdin)['points']) else 1)" "$1"
    }

    # One audit action for this workspace has a row with result ok.
    audited_ok() {
      ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE target = '${ws_id}' AND action = '$1' AND result = 'ok'\" | grep -qv '^0$'"
    }

    if [ -z "$ws_instance" ] || ! epic10_owns_instance; then
      printf '\033[1;31mFAIL\033[0m  Epic 10: no instance created by this run to test on\n'
      fail=$((fail + 1))
    else
      # Grace 0 keeps the workspace up while the worker stops and starts it
      # for an operation. cleanup_epic34 restores the original value.
      set_global_grace 0 >/dev/null

      check_output "recovery volume is mounted, uid 1000, mode 0700" "1000 700" \
        alice_root "mountpoint -q ${RECOVERY_ROOT} && stat -c \"%u %a\" ${RECOVERY_ROOT}"

      rs_response=$(vm_get alice "${PROJECTS_URL}" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"name\": \"Recovery Smoke\", \"source\": \"new\"}'")
      rs_id=$(echo "$rs_response" | json_field id)
      alice_student "cd ${RS_DIR} && echo one > notes.txt && echo SECRET=smoke > .env && git add notes.txt && ${RS_GIT} commit -qm smoke-one" \
        >/dev/null 2>&1 || true

      git_before=$(rs_git_state)
      check "read the project's Git state" test -n "$git_before"
      rp_response=$(vm_get alice "${PROJECTS_URL}/${rs_id}/recovery-points" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{}'")
      rp_id=$(echo "$rp_response" | json_field id)
      check "POST recovery-points returns a point" test -n "$rp_id"
      check_output "making a point leaves Git untouched" "$git_before" rs_git_state
      check_output "the archive is mode 0600" "600" \
        alice_root "stat -c %a ${RECOVERY_ROOT}/${rs_id}/${rp_id}.tar.zst"

      # Delete everything in the project, then restore the point.
      alice_student "cd ${RS_DIR} && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +" \
        >/dev/null 2>&1 || true
      check "the project is empty before the restore" \
        alice_student "test -z \"\$(ls -A ${RS_DIR})\""
      check_output "restore returns 204" "204" \
        http_status alice "${PROJECTS_URL}/${rs_id}/recovery-points/${rp_id}/restore" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{}'"
      check_output "restore brings the files back" "one" \
        alice_student "cat ${RS_DIR}/notes.txt"
      check "restore brings back Git-ignored files" \
        alice_student "test -f ${RS_DIR}/.env"
      check_output "restore brings git log back" "smoke-one" \
        alice_student "git -C ${RS_DIR} log -1 --format=%s"
      check "a before-restore point was made" \
        rs_has_point_reason before-restore
      check "the restore is audited" \
        ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT count(*) FROM audit_events WHERE target = '${rs_id}' AND action = 'recovery.restored'\" | grep -qv '^0$'"

      # Reset Docker: images go, projects and recovery points stay.
      echo ""
      echo "Reset Docker..."
      alice_student "docker run --rm hello-world" >/dev/null 2>&1 || true
      check_gt "docker has an image before the reset" 0 \
        alice_student "docker images -q | wc -l"
      alice_student "echo epic10 > ~/projects/.epic10-marker" >/dev/null 2>&1 || true
      check_output "POST reset-docker returns 202" "202" \
        http_status alice "${API}/workspaces/${ws_id}/reset-docker" "-X POST -H 'Origin: ${API}'"
      check_output "workspace is running again after Reset Docker" "running none" \
        wait_for_operation
      # "docker info" first, so a daemon that is still starting is not an empty list.
      check_output "docker images is empty after Reset Docker" "0" \
        alice_student "for i in \$(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker images -q | wc -l"
      check "projects marker survives Reset Docker" \
        alice_student "test -f ~/projects/.epic10-marker"
      check "recovery point survives Reset Docker" \
        alice_root "test -f ${RECOVERY_ROOT}/${rs_id}/${rp_id}.tar.zst"
      check "Reset Docker is audited" audited_ok workspace.docker_reset

      # Rebuild: the root filesystem is replaced, home is kept.
      echo ""
      echo "Rebuild..."
      alice_root "echo epic10 > /etc/portikus-epic10-marker" >/dev/null 2>&1 || true
      alice_student "echo epic10 > ~/.epic10-home-marker" >/dev/null 2>&1 || true
      check "the /etc marker is there before the rebuild" \
        alice_root "test -f /etc/portikus-epic10-marker"
      check_output "a student is refused the rebuild" "403" \
        http_status alice "${API}/admin/workspaces/${ws_id}/rebuild" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"resetDocker\":false}'"
      check_output "POST rebuild as the administrator returns 202" "202" \
        http_status carol "${API}/admin/workspaces/${ws_id}/rebuild" \
        "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{\"resetDocker\":false}'"
      check_output "workspace is running again after the rebuild" "running none" \
        wait_for_operation
      check "the rebuild drops the /etc marker" \
        alice_root "test ! -e /etc/portikus-epic10-marker"
      check "the rebuild keeps the home marker" \
        alice_student "test -f ~/.epic10-home-marker"
      check_output "recovery volume is still uid 1000, mode 0700" "1000 700" \
        alice_root "stat -c \"%u %a\" ${RECOVERY_ROOT}"
      check "a before-rebuild point was made" \
        rs_has_point_reason before-rebuild
      check "the rebuild is audited" audited_ok workspace.rebuilt

      alice_student "rm -rf ${RS_DIR} ~/projects/.epic10-marker ~/.epic10-home-marker" \
        >/dev/null 2>&1 || true
      set_global_grace 20 >/dev/null
    fi

    # Hand the workspace back stopped, which is how the next block finds it.
    close_socket
    http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
    wait_for_state stopped 60 >/dev/null

    # 16. Authorization: one student cannot see another's workspace, and
    #     only an administrator can list them all.
    echo ""
    echo "Checking authorization boundaries..."
    check_output "bob gets 404 on alice's workspace" "404" \
      http_status bob "${API}/workspaces/${ws_id}"
    admin_list_has_workspace() {
      vm_get carol "${API}/admin/workspaces" | grep -q "${ws_id}"
    }
    check "carol lists alice's workspace"         admin_list_has_workspace
    check_output "alice is refused the admin list" "403" \
      http_status alice "${API}/admin/workspaces"

    # 17. Security: portikus is not an Incus admin, and the control-plane
    #     ports are unreachable from inside a workspace.
    echo ""
    echo "Checking security boundaries..."
    check "portikus user not in incus-admin" \
      ssh_cmd '! id portikus 2>/dev/null | grep -q incus-admin'

    if [ -n "$ws_instance" ]; then
      http_status alice "${API}/workspaces/${ws_id}/start" "-X POST -H 'Origin: ${API}'" >/dev/null
      ws_state=$(wait_for_state running 60)
      sleep 3

      # 80 and 443 are the Caddy edge: a workspace must not be able to
      # reach the sign-in page from inside the bridge.  One exec covers
      # every port, because the shortened grace period would stop the
      # workspace part-way through five separate probes.
      port_probe=$(ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- bash -c 'for p in 80 443 3000 3001 3002; do if timeout 1 bash -c \"echo >/dev/tcp/10.200.0.1/\$p\" 2>/dev/null; then echo \"\$p open\"; else echo \"\$p blocked\"; fi; done'" 2>/dev/null)
      port_result() { echo "$port_probe" | awk -v p="$1" '$1 == p { print $2 }'; }
      for port in 80 443 3000 3001 3002; do
        check_output "port ${port} unreachable from workspace" "blocked" port_result "${port}"
      done

      http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
    fi

    rm -f "$probe_log"
  fi

  # 18. Logging out ends the session.
  echo ""
  echo "Logging alice out..."
  http_status alice "${API}/auth/logout" "-X POST -H 'Origin: ${API}'" >/dev/null
  check_output "/auth/me is 401 after logout" "401" http_status alice "${API}/auth/me"

  echo ""
  echo "--- Epic 3 and 4 results: $((pass - epic3_pass_start)) passed, $((fail - epic3_fail_start)) failed ---"
fi

# ── Epic 5: workspace agent ──────────────────────────────────────
# Static checks only: the unit runs inside the container, the tree the
# workspace profile bind-mounts is there and not writable by the
# student, and the agent turns away a request that carries no token.
# The terminal flow is checked elsewhere.
#
# These reuse the workspace the Epic 2 block created, so they are
# skipped whenever that block did not run.
if [ -n "${WS_NAME:-}" ]; then
  echo ""
  echo "--- Epic 5: workspace agent checks ---"
  echo ""

  check "workspace agent unit is active" \
    ws_exec systemctl is-active portikus-workspace-agent
  check "workspace agent runs as the student user" \
    ws_exec "systemctl show portikus-workspace-agent -p User | grep -qx User=student"
  check "agent start script is present" \
    ws_exec test -x /opt/portikus/workspace-agent/bin/workspace-agent
  check "agent tree is not writable by student" \
    ws_student "! test -w /opt/portikus/workspace-agent/bin/workspace-agent"

  # The API dials the agent over the workspace bridge, so probe the same way.
  ws_ip=$(workspace_ip "${WS_NAME}")
  if [ -n "$ws_ip" ]; then
    check_output "agent /health without a token is 401" "401" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${ws_ip}:7400/health"
  else
    printf '\033[1;31mFAIL\033[0m  workspace has no bridge address\n'
    fail=$((fail + 1))
  fi
else
  echo "No Epic 2 workspace; skipping Epic 5 checks."
fi

echo ""
echo "--- Results: ${pass} passed, ${fail} failed ---"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
