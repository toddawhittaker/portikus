#!/usr/bin/env bash
# The workspace image and nested Docker, in a throwaway workspace
# (smoke-ws) that the cleanup trap destroys.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# These checks run only when the portikus workspace image is imported.
if ssh_cmd incus image info portikus --project portikus >/dev/null 2>&1; then
  echo "--- Workspace image and nested Docker ---"
  echo ""

  WS_NAME="smoke-ws"
  PROJECT="portikus"

  # Provision a workspace.
  echo "Creating workspace ${WS_NAME}..."
  if ! ssh_cmd bash "${WORKSPACE_SCRIPT}" create "${WS_NAME}" >/dev/null 2>&1; then
    bad "workspace creation"
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

  # 16b. Images land on the Docker volume, not the containerd store on the root disk (SPEC.md 16.2)
  check_output "docker uses overlay2 in /var/lib/docker" "overlay2 /var/lib/docker" \
    ws_student "docker info --format '{{.Driver}} {{.DockerRootDir}}'"
  # The classic store still caches small manifests there; alpine's layer (about 3.8 MB) must not be.
  check_zero_lines "no image layers under /var/lib/containerd" \
    ws_exec "find /var/lib/containerd -path '*content.v1.content/blobs/*' -type f -size +1M"

  # 17. CLI tools are installed
  check "codex --version"                       ws_student "codex --version"
  check "claude --version"                      ws_student "claude --version"
  # Both come from the shared folder the profile mounts, not the image
  # (SPEC.md section 10), whatever else is on the PATH.
  for tool in claude codex; do
    check "${tool} resolves into the shared coding-agents folder" \
      ws_student "case \$(readlink -f \$(command -v ${tool})) in /opt/portikus/coding-agents/${tool}/*) true ;; *) false ;; esac"
  done
  # Browser opens are brokered, and Codex does not look for updates on
  # startup (BROWSER-HANDLING.md 18 and 25.2). These do not log in.
  check "portikus-open is executable"           ws_exec "test -x /usr/local/bin/portikus-open"
  check "xdg-open wrapper is executable"        ws_exec "test -x /usr/local/bin/xdg-open"
  check_output "BROWSER is portikus-open in a login shell" \
    "BROWSER=/usr/local/bin/portikus-open" ws_student 'env | grep ^BROWSER='
  # Claude Code login must open nothing and offer the paste-code URL, even
  # with BROWSER set; this catches a new Claude Code that drifts
  # (BROWSER-HANDLING.md 19.2). It stops at the prompt and never logs in.
  # shellcheck disable=SC2016 # the workspace shell expands it
  claude_login_flow() {
    ws_student 'd=$(mktemp -d); echo "#!/bin/sh" > $d/o; echo "touch $d/opened" >> $d/o; chmod +x $d/o; BROWSER=$d/o CLAUDE_CONFIG_DIR=$d timeout 15 claude auth login </dev/null >$d/out 2>&1; if [ ! -e $d/opened ] && grep -q oauth%2Fcode%2Fcallback $d/out; then echo paste-code; fi; rm -rf $d'
  }
  check_output "Claude Code login offers the paste-code flow and opens no browser" \
    "paste-code" claude_login_flow
  # The student cannot mkdir under /run. systemd must create the broker
  # socket directory before the agent starts (BROWSER-HANDLING.md 18).
  check_output "workspace agent unit sets RuntimeDirectory=portikus" \
    "RuntimeDirectory=portikus" \
    ws_exec "grep -F -x 'RuntimeDirectory=portikus' /etc/systemd/system/portikus-workspace-agent.service"
  # Checks run in the agent's cgroup, so an out-of-memory kill of one
  # student process must not stop the agent's unit.
  check_output "workspace agent unit keeps running after an OOM kill (OOMPolicy=continue)" \
    "continue" ws_exec "systemctl show -p OOMPolicy --value portikus-workspace-agent"

  # 17aa. Terminals live in their own unit, so the agent can restart without
  # them and be shielded from a fork bomb (SPEC.md
  # 19.3).
  unit_prop() { ws_exec "systemctl show -p $2 --value $1"; }
  check_output "agent unit has no task cap of its own (TasksMax=infinity)" \
    "infinity" unit_prop portikus-workspace-agent TasksMax
  check_output "agent unit uses the terminals unit's tmux server" \
    "TMUX_EXTERNAL_SERVER=true" ws_exec "systemctl show -p Environment --value portikus-workspace-agent | tr ' ' '\n' | grep -x TMUX_EXTERNAL_SERVER=true"
  check_output "terminals unit is running" "active" unit_prop portikus-terminals ActiveState
  check_output "terminals unit runs as the student" "student" unit_prop portikus-terminals User
  check_output "terminals unit caps its tasks (TasksMax=1700)" "1700" unit_prop portikus-terminals TasksMax
  check_output "terminals unit keeps running after an OOM kill (OOMPolicy=continue)" \
    "continue" unit_prop portikus-terminals OOMPolicy
  check_output "terminals unit always restarts (Restart=always)" "always" unit_prop portikus-terminals Restart
  # A terminals restart must never restart the agent.
  check_output "agent unit Wants the terminals unit" "portikus-terminals.service" \
    ws_exec "systemctl show -p Wants --value portikus-workspace-agent | tr ' ' '\\n' | grep -x portikus-terminals.service"
  check "agent unit neither Requires nor BindsTo the terminals unit" \
    ws_exec "d=\$(systemctl show -p Requires -p BindsTo --value portikus-workspace-agent) && ! grep -q -F portikus-terminals <<<\"\$d\""
  term_main() { unit_prop portikus-terminals MainPID; }
  agent_main() { unit_prop portikus-workspace-agent MainPID; }
  check_output "the terminals unit's main process is tmux" "tmux: server" \
    ws_exec "ps -o comm= -p \$(systemctl show -p MainPID --value portikus-terminals)"
  check_output "the tmux server runs in the terminals unit's cgroup" \
    "0::/system.slice/portikus-terminals.service" \
    ws_exec "cat /proc/\$(systemctl show -p MainPID --value portikus-terminals)/cgroup"
  # A shell in a pane of the Portikus server, as the agent would start one.
  ws_student "tmux -L portikus -N new-session -d -s smoke-shell bash" >/dev/null 2>&1
  pane_pid() { ws_student "tmux -L portikus -N display-message -p -t smoke-shell '#{pane_pid}'"; }
  shell_pid=$(pane_pid)
  check_output "a pane's shell runs in the terminals unit's cgroup" \
    "0::/system.slice/portikus-terminals.service" ws_exec "cat /proc/${shell_pid:-0}/cgroup"
  # Shells get what they got before, less the agent's own settings.
  # HOME is the control that the environment was read at all.
  check_output "the tmux server has none of the agent's settings in its environment" "HOME=/home/student" \
    ws_exec "tr '\\0' '\\n' < /proc/\$(systemctl show -p MainPID --value portikus-terminals)/environ | grep -E '^(NODE_ENV|LOG_LEVEL|TMUX_EXTERNAL_SERVER|HOME)='"

  # 17ab0. /tmp and /dev/shm are capped tmpfs mounts, so a huge temporary
  # file fails for lack of space instead of using the workspace's memory.
  check_output "/tmp is a tmpfs" "tmpfs" ws_exec "findmnt -n -o FSTYPE /tmp"
  check_output "/tmp is capped at 512M" "536870912" ws_exec "df -B1 --output=size /tmp | tail -1 | tr -d ' '"
  check_output "/dev/shm is capped at 256M" "268435456" ws_exec "df -B1 --output=size /dev/shm | tail -1 | tr -d ' '"
  check "/dev/shm keeps nosuid and nodev after the remount" \
    ws_exec "findmnt -no OPTIONS /dev/shm | tr , '\\n' | grep -qx nosuid && findmnt -no OPTIONS /dev/shm | tr , '\\n' | grep -qx nodev"
  agent_before=$(agent_main)
  term_before=$(term_main)
  tmp_fill_refused() {
    local said
    said=$(ws_student "head -c 600M /dev/zero > /tmp/smoke-fill; rc=\$?; rm -f /tmp/smoke-fill; exit \$rc" 2>&1)
    [[ "$said" == *"No space left on device"* ]]
  }
  check "writing 600 MB to /tmp fails with No space left on device" tmp_fill_refused
  check_output "the agent kept running through the full /tmp (same main PID)" "$agent_before" agent_main
  check_output "the tmux server kept running through the full /tmp (same main PID)" "$term_before" term_main
  check "the pane's shell kept running through the full /tmp" ws_exec "kill -0 ${shell_pid:-0}"

  # 17ab1. The terminals unit comes back on its own and leaves an exit
  # record saying why it stopped.
  term_back_after() { # OLD_PID -- a new tmux server within ten seconds
    local i p
    for ((i = 0; i < 10; i++)); do
      sleep 1
      p=$(term_main)
      [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != "$1" ] && [ "$(unit_prop portikus-terminals ActiveState)" = active ] && return 0
    done
    return 1
  }
  check "no exit record while the terminals have not stopped this boot" \
    ws_exec "test -d /run/portikus-terminals && test ! -e /run/portikus-terminals/last-exit"
  term_before=$(term_main)
  ws_exec "kill -KILL ${term_before:-0}" >/dev/null 2>&1
  check "the terminals unit is back within ten seconds of a SIGKILL" term_back_after "$term_before"
  check_output "its exit record says it was killed by a signal" "signal" \
    ws_exec "cat /run/portikus-terminals/last-exit"
  term_before=$(term_main)
  ws_student "tmux -L portikus -N kill-server" >/dev/null 2>&1
  check "the terminals unit is back within ten seconds of tmux kill-server" term_back_after "$term_before"
  check_output "its exit record says it stopped cleanly" "success" \
    ws_exec "cat /run/portikus-terminals/last-exit"
  check_output "the agent kept running through both (same main PID)" "$agent_before" agent_main
  check_output "Codex update check is off" \
    "check_for_update_on_startup = false" \
    ws_exec "grep -F -x 'check_for_update_on_startup = false' /etc/codex/config.toml"
  check "gh --version"                          ws_student "gh --version"
  check "node --version"                        ws_student "node --version"
  check "python3 --version"                     ws_student "python3 --version"

  # 17a. The image turns off the Claude Code self-updater, which cannot
  # write the read-only shared coding-agents folder (SPEC.md 10).
  check_output "Claude Code auto-update off in a login shell" \
    "DISABLE_AUTOUPDATER=1" ws_student 'env | grep DISABLE_AUTOUPDATER'

  # 17ab. claude typed in a terminal clears tmux's history first, which the
  # agent turns into a cleared browser scrollback; a plain command keeps it.
  # A stand-in claude on PATH, in a throwaway tmux server.
  # shellcheck disable=SC2016  # expanded by the shell in the workspace
  agent_clear_probe='d=$(mktemp -d); printf "#!/bin/sh\necho FAKE-AGENT; sleep 30\n" > "$d/claude"; chmod +x "$d/claude"
t() { tmux -L smoke-886 -f /dev/null "$@"; }
h() { t display-message -p -t s "#{history_size}"; }
t new-session -d -s s -x 80 -y 24 bash -l
sleep 1; t send-keys -t s "PATH=$d:\$PATH; seq 1 200" Enter
sleep 2; before=$(h); t send-keys -t s "true" Enter
sleep 1; plain=$(h); t send-keys -t s "claude" Enter
sleep 2; after=$(h); t kill-server; rm -rf "$d"
echo "$before $plain $after" >&2
[ "$before" -gt 0 ] && [ "$plain" -ge "$before" ] && [ "$after" = 0 ] && echo cleared'
  check_output "claude typed in a terminal starts with empty scrollback" "cleared" \
    ws_student "$agent_clear_probe"
  check_output "a script gets the plain claude, not the clearing function" "file" \
    ws_student 'type -t claude'

  # 17aa. A student's own git init starts on main.
  check_output "system git init.defaultBranch is main" "main" \
    ws_exec "git config --system init.defaultBranch"
  # shellcheck disable=SC2016  # expanded by the shell in the workspace
  check_output "a new repository starts on main" "main" \
    ws_student 'd=$(mktemp -d) && git -C "$d" init -q && git -C "$d" symbolic-ref --short HEAD; rm -rf "$d"'

  # 17ab. The clipboard shim turns a copy into an OSC 52 escape, because
  # a workspace has no X display.  There is no terminal here,
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
  for storage_pv in ${STORAGE_PVS}; do
    check "${storage_pv} absent"                ws_exec test ! -e "${storage_pv}"
  done

  # 19. Management network is unreachable from workspace.  The VM's default
  # gateway is the host on the management network, whichever one this VM is on.
  mgmt_gateway=$(ssh_cmd "ip -4 route show default" | awk '{ print $3; exit }')
  if [ -n "$mgmt_gateway" ]; then
    check "the VM itself reaches ${mgmt_gateway} (control)" ssh_cmd "ping -c1 -W2 ${mgmt_gateway}"
    check "management network (${mgmt_gateway}) blocked" ws_exec "! ping -c1 -W2 ${mgmt_gateway}"
  else
    bad "management network: the VM has no default gateway to probe"
  fi

  # 20. SSH to VM bridge address blocked from workspace
  check "SSH to VM bridge blocked"              ws_exec '! timeout 3 bash -c "echo >/dev/tcp/10.200.0.1/22" 2>/dev/null'

  # 20a. Docker Hub pulls go through the cache on the gateway (ADR 0045).
  # The controller writes the mirror into daemon.json before each start;
  # workspace.sh does not, so this sets it.  After the first pull fills the
  # cache, a second pull downloads almost nothing on the VM's uplink.
  if ssh_cmd test -d /etc/portikus/registry; then
    ws_exec 'python3 -c "import json; p=\"/etc/docker/daemon.json\"; c=json.load(open(p)); c[\"registry-mirrors\"]=[\"http://10.200.0.1:5000\"]; json.dump(c, open(p, \"w\"))" && systemctl restart docker' >/dev/null 2>&1
    check_output "the workspace's Docker uses the cache as its mirror" "[http://10.200.0.1:5000/]" \
      ws_student "docker info --format '{{.RegistryConfig.Mirrors}}'"
    uplink_rx() {
      ssh_cmd "cat /sys/class/net/\$(ip route show default | awk '{print \$5; exit}')/statistics/rx_bytes"
    }
    ws_student "docker pull -q redis:7-alpine" >/dev/null 2>&1
    check "the cache holds what the workspace pulled" \
      ssh_cmd "sudo test -d /var/lib/portikus-registry/hub/docker/registry/v2/repositories/library/redis"
    ws_student "docker rmi -f redis:7-alpine" >/dev/null 2>&1
    rx_before=$(uplink_rx)
    check "a second pull of redis:7-alpine succeeds" ws_student "docker pull -q redis:7-alpine"
    rx_after=$(uplink_rx)
    # The image is about 17 MB compressed; the cache serves it from the VM.
    second_pull_mib() { echo $(((${rx_after:-0} - ${rx_before:-0}) / 1048576)); }
    check_output "the second pull downloaded under 4 MiB from the internet" "yes" \
      bash -c "[ $(second_pull_mib) -ge 0 ] && [ $(second_pull_mib) -lt 4 ] && echo yes"
  fi

  # 20b. The portikus and nobody accounts cannot reach into a
  # workspace's Docker volume on the host, mounted or not, nor the seed.
  # Each path is walked with stat, one part at a time, to the first entry
  # inside the volume; custom/ or an Incus directory above it must refuse them.
  # shellcheck disable=SC2016  # expanded on the VM
  s4_open_paths() {
    ssh_cmd_stdin "sudo bash -s" <<'EOF'
custom=/var/lib/incus/storage-pools/workspace-data/custom
n=0
for vol in "$custom"/*; do
  [ -d "$vol" ] || continue
  target=$(find "$vol" -mindepth 1 -maxdepth 1 -print -quit)
  target=${target:-$vol}
  n=$((n + 1))
  for user in portikus nobody; do
    path="" refused="" denier=""
    IFS=/ read -ra parts <<<"${target#/}"
    for part in "${parts[@]}"; do
      path="$path/$part"
      if ! runuser -u "$user" -- stat "$path" >/dev/null 2>&1; then refused=$path; break; fi
    done
    if [ -z "$refused" ] && [ "$target" != "$vol" ]; then echo "open: $user reaches $target"; fi
    # The refusal must come from custom/ or an Incus directory above it, not the volume itself.
    if [ -n "$refused" ]; then
      denier=${refused%/*}
      case "$custom/" in
        "$denier"/*) case "$denier" in /var/lib/incus|/var/lib/incus/*) ;; *) echo "open: $user is refused only at $denier, outside Incus" ;; esac ;;
        *) echo "open: $user passes custom/ and is refused only at $denier" ;;
      esac
    fi
    if [ "$target" = "$vol" ] && runuser -u "$user" -- ls "$vol" >/dev/null 2>&1 && [ -n "$(ls -A "$vol")" ]; then echo "open: $user lists $vol"; fi
  done
done
[ "$n" -gt 0 ] || echo "open: no custom volume found under $custom"
EOF
  }
  check_zero_lines "portikus and nobody cannot stat into the workspace volumes" s4_open_paths

  # 21. Persistence across stop/start
  echo ""
  echo "Testing stop/start persistence..."
  if ! ws_student "echo smoke-persistence-marker > ~/projects/.smoke-marker" >/dev/null 2>&1; then
    bad "write persistence marker"
  fi
  # An older agent wrote this import line; the agent removes only that line
  # at its next start and keeps the student's own.
  ws_student 'mkdir -p ~/.claude && printf "@~/.codex/AGENTS.md\nsmoke-own-rule\n" > ~/.claude/CLAUDE.md' >/dev/null 2>&1 || true
  ssh_cmd "incus stop ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  ssh_cmd "incus start ${WS_NAME} --project ${PROJECT}" >/dev/null 2>&1 || true
  sleep 5

  check "projects marker survives restart"      ws_student "cat ~/projects/.smoke-marker"
  check "Docker images survive restart"         ws_student "docker images -q"
  # Wait until the agent listens, which is after it tidies the files.
  # shellcheck disable=SC2016  # expanded by the shell in the workspace
  check "the old import line is gone and the student's rule stays" \
    ws_student 'for i in $(seq 1 30); do ss -Hltn "sport = :7400" | grep -q . && break; sleep 1; done; [ "$(cat ~/.claude/CLAUDE.md)" = smoke-own-rule ]'
  # /run is cleared on stop, so an old exit record cannot explain anything.
  check "no exit record after the workspace restarts" \
    ws_exec "test -d /run/portikus-terminals && test ! -e /run/portikus-terminals/last-exit"

else
  echo "Workspace image not imported; skipping the workspace image checks."
fi

echo ""
