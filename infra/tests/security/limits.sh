#!/usr/bin/env bash
# Bounded resource limits (Epic 12a Done item 18; SPEC.md 19.1 and 24.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# a's cgroup limits match the profile, a bounded fork loop hits the process
# limit, busy loops fill a's CPUs for 20 seconds, a resource-guard throttle
# reaches a's cpu.max and leaves it again, and fallocate past each
# volume's size is refused for lack of space, and the platform services
# carry a negative OOM score adjustment.  Meanwhile the API and
# b's agent keep answering within two seconds.  The heavy tests run only
# with PORTIKUS_SECURITY_HEAVY=1 on an otherwise empty VM: memory past the
# limit while PostgreSQL and the API keep running; both workspaces burning
# CPU and disk while /health and a terminal echo stay quick; and Caddy and
# PostgreSQL killed outright and coming back on their own.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Bounded resource limits ---"

lim_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lim_site="${lim_here}/../../ansible/site.yml"
lim_var() { awk -v k="$1:" '$1 == k { gsub(/"/, "", $2); print $2; exit }' "$lim_site"; }
lim_cpu=$(lim_var workspace_cpu_limit)
lim_mem=$(lim_var workspace_memory_limit)
lim_pids=$(lim_var workspace_process_limit)
lim_root_gb=$(lim_var workspace_root_disk_quota | tr -dc 0-9)
lim_home_gib=$(lim_var portikus_workspace_home_size_gib)
lim_docker_gib=$(lim_var portikus_workspace_docker_size_gib)
echo "Profile (site.yml): ${lim_cpu} CPUs, ${lim_mem} memory, ${lim_pids} processes; root ${lim_root_gb} GB, home ${lim_home_gib} GiB, Docker ${lim_docker_gib} GiB"

# ── The container's cgroup, read on the VM ───────────────────────

lim_a=$(sec_instance a)
lim_cg="/sys/fs/cgroup/lxc.payload.portikus_${lim_a}"
lim_cgroup() { sec_ssh "cat ${lim_cg}/$1"; }
# Incus reads "4GB" as decimal gigabytes; the kernel rounds down to whole pages.
lim_mem_bytes=$(awk -v m="$lim_mem" 'BEGIN { n = m + 0; u = m; sub(/^[0-9.]+/, "", u)
  f["kB"] = 1e3; f["MB"] = 1e6; f["GB"] = 1e9; f["KiB"] = 1024; f["MiB"] = 1048576; f["GiB"] = 1073741824
  b = n * f[u]; printf "%d", b - b % 4096 }')
check_output "a's pids.max matches the profile" "$lim_pids" lim_cgroup pids.max
check_output "a's memory.max matches the profile" "$lim_mem_bytes" lim_cgroup memory.max
# limits.cpu is a CPU count, which Incus applies as a CPU set; no time quota is set.
lim_cpu_count() {
  lim_cgroup cpuset.cpus.effective | tr ',' '\n' \
    | awk -F- '{ n += ($2 == "" ? 1 : $2 - $1 + 1) } END { print n }'
}
check_output "a's CPU set has as many CPUs as the profile" "$lim_cpu" lim_cpu_count
check_output "a's cpu.max sets no time quota beyond the CPU count" "max 100000" lim_cgroup cpu.max
# Terminals run in the agent's cgroup, so an OOM kill must not stop the unit.
check_output "a's agent unit keeps running after an OOM kill (OOMPolicy=continue)" "continue" \
  sec_exec a root "systemctl show -p OOMPolicy --value portikus-workspace-agent"

# ── The platform is protected from the out-of-memory killer ──────

# Workspaces may together promise more memory than the VM has; when it runs
# out, the kernel must kill workspace processes first (docs/CAPACITY.md).
lim_platform_units="postgresql@17-main portikus-api portikus-worker portikus-controller caddy"
# Keyed on the provider, not on the unit running, so a crashed Dex fails.
if [ "$SEC_IDP" = dex ]; then lim_platform_units+=" portikus-dex"; fi
for lim_unit in $lim_platform_units; do
  check "${lim_unit} has a negative OOM score adjustment" \
    sec_ssh "p=\$(systemctl show -p MainPID --value ${lim_unit}); [ \"\$p\" -gt 0 ] && [ \"\$(cat /proc/\$p/oom_score_adj)\" -lt 0 ]"
done
# A protected service that takes requests must not be able to take the VM
# with it; PostgreSQL is bounded by its own settings instead.
for lim_unit in ${lim_platform_units/postgresql@17-main/}; do
  check "${lim_unit} has a memory cap" \
    sec_ssh "m=\$(systemctl show -p MemoryMax --value ${lim_unit}) && [ -n \"\$m\" ] && [ \"\$m\" != infinity ]"
done

# ── The thin pool, reported only (Epic 12a risk 3) ───────────────

lim_pool=$(sec_ssh "sudo lvs --noheadings --nosuffix --units g --separator , -o lv_name,lv_size,pool_lv,data_percent portikus-data" | tr -d ' ')
lim_pool_size=$(awk -F, '$1 == "thinpool" { print $2 }' <<<"$lim_pool")
lim_pool_used=$(awk -F, '$1 == "thinpool" { print $4 }' <<<"$lim_pool")
lim_virtual=$(awk -F, '$3 == "thinpool" { s += $2 } END { printf "%.0f", s }' <<<"$lim_pool")
lim_free=$(awk -v s="$lim_pool_size" -v d="$lim_pool_used" 'BEGIN { printf "%.0f", s * (100 - d) / 100 }')
lim_quota=$((lim_root_gb + lim_home_gib + lim_docker_gib))
echo "Thin pool: ${lim_pool_size} GB, ${lim_free} GB free; volumes promise ${lim_virtual} GB ($(awk -v v="$lim_virtual" -v s="$lim_pool_size" 'BEGIN { printf "%.1f", v / s }') times the pool)"
if [ "${lim_free%.*}" -lt "$lim_quota" ]; then
  echo "WARNING: less free pool space than one full workspace quota (${lim_quota} GB)."
fi

# ── Liveness of everything else while a is under pressure ────────

# lim_watch_start / lim_watch_stop -- a loop on the VM asks the API's /health
# through the edge and b's agent every half second, each with a two-second limit.
# It ends on the stop file, when the run's directory is gone, or after 15
# minutes, so a run that dies never leaves it polling an address that may
# later belong to a student.
lim_b_ip=$(sec_ws_ip b)
sec_agent_header b
lim_watch_start() {
  sec_ssh "rm -f ${SEC_REMOTE_DIR}/watch.stop ${SEC_REMOTE_DIR}/watch.log; \
    nohup timeout 900 bash -c 'while [ -d ${SEC_REMOTE_DIR} ] && [ ! -f ${SEC_REMOTE_DIR}/watch.stop ]; do \
      echo api \$(curl -s -o /dev/null -w %{http_code} --max-time 2 --cacert ${SEC_CA} ${SEC_API}/health) \
               b \$(curl -s -o /dev/null -w %{http_code} --max-time 2 -H @${SEC_REMOTE_DIR}/b.agent http://${lim_b_ip}:7400/health); \
      sleep 0.5; done' >${SEC_REMOTE_DIR}/watch.log 2>&1 </dev/null &"
}
# lim_watch_count -- samples so far, to mark the start of a stretch.
lim_watch_count() { sec_ssh "wc -l < ${SEC_REMOTE_DIR}/watch.log"; }
# lim_watch_summary FROM -- "N samples, M slow or failed" from line FROM on.
lim_watch_summary() {
  sec_ssh "awk -v from=$1 'NR >= from { n++; if (\$2 != 200 || \$4 != 200) bad++ } END { printf \"%d samples, %d slow or failed\", n, bad }' ${SEC_REMOTE_DIR}/watch.log"
}
lim_watch_stop() {
  sec_ssh "touch ${SEC_REMOTE_DIR}/watch.stop"
  sleep 3
  lim_watch_summary 1
}
lim_watch_ok() { [[ "$1" =~ ^[1-9][0-9]*\ samples,\ 0\ slow ]]; }

lim_watch_start

# ── Processes ────────────────────────────────────────────────────

# Fork sleeping children until the kernel refuses, never more than the limit
# plus a margin, hold them a few seconds while the watch loop samples, then
# kill them all.  Prints "children error".  It runs as root in a, because a
# student login is held lower still by systemd's per-user task cap, and this
# is about the container's own limit.
lim_fork_py="import errno, os, signal, time
kids, err = [], 'none'
try:
    for _ in range(${lim_pids} + 200):
        pid = os.fork()
        if pid == 0:
            try:
                os.execv('/bin/sleep', ['sleep', '60'])
            finally:
                os._exit(1)
        kids.append(pid)
except OSError as e:
    err = errno.errorcode.get(e.errno, str(e.errno))
time.sleep(5)
for pid in kids:
    os.kill(pid, signal.SIGKILL)
for pid in kids:
    os.waitpid(pid, 0)
print(len(kids), err)"
lim_pids_hits() { lim_cgroup pids.events | awk '$1 == "max" { print $2 }'; }
lim_hits_before=$(lim_pids_hits)
lim_fork=$(printf '%s\n' "$lim_fork_py" | sec_ssh_stdin "incus exec ${lim_a} --project ${SEC_PROJECT} -- timeout 90 python3 -" 2>/dev/null)
lim_hits_after=$(lim_pids_hits)
echo "Fork loop in a: ${lim_fork:-no output} (children, error); container limit hits ${lim_hits_before:-?} before, ${lim_hits_after:-?} after"
check "a bounded fork loop in a is refused (EAGAIN)" test "${lim_fork##* }" = "EAGAIN"
check "the refusal came from a's container limit (pids.events max went up)" \
  test "${lim_hits_after:-0}" -gt "${lim_hits_before:-0}"

# ── CPU ──────────────────────────────────────────────────────────

# This fully loads the test workspace's CPUs for 20 seconds; run the suite outside class hours.
# One busy loop per CPU a has, as the student, for 20 seconds under timeout.
# a's cgroup CPU time over the stretch shows the loops really ran (control).
lim_cpu_usec() { lim_cgroup cpu.stat | awk '$1 == "usage_usec" { print $2 }'; }
lim_mark=$(lim_watch_count)
lim_usec_before=$(lim_cpu_usec)
lim_burn_start=$(date +%s%N)
sec_exec a student "for i in \$(seq ${lim_cpu}); do timeout 20 sh -c 'while :; do :; done' & done; wait" >/dev/null 2>&1
lim_burn_ns=$(($(date +%s%N) - lim_burn_start))
lim_usec_after=$(lim_cpu_usec)
lim_busy=$(awk -v u="$((${lim_usec_after:-0} - ${lim_usec_before:-0}))" -v ns="$lim_burn_ns" -v c="$lim_cpu" \
  'BEGIN { printf "%d", 100 * u * 1000 / (ns * c) }')
lim_cpu_watch=$(lim_watch_summary "$((${lim_mark:-0} + 1))")
echo "CPU loops in a: ${lim_busy}% of ${lim_cpu} CPUs over $((lim_burn_ns / 1000000000)) s; liveness meanwhile: ${lim_cpu_watch}"
check "a's busy loops kept its CPUs at least 80% busy (control)" test "$lim_busy" -ge 80
check "the API and b's agent answered within two seconds while a used all its CPUs" \
  lim_watch_ok "$lim_cpu_watch"

# ── CPU throttle (resource guard) ────────────────────────────────

# The database is the source of truth and the worker makes Incus match it
# each minute, so a throttle row written here must reach a's cgroup as a
# hard time slice, and clearing it must remove the quota again.  The row is
# the one the guard writes at the default 25% share.
lim_share=25
lim_allow_ms=$((lim_share * lim_cpu))
lim_throttle_json="{\"at\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\", \"averagePercent\": 100, \"thresholdPercent\": 80, \"windowMinutes\": 30, \"sharePercent\": ${lim_share}, \"allowance\": \"${lim_allow_ms}ms/100ms\"}"
lim_set_throttle() { sec_psql "UPDATE workspaces SET cpu_throttle = $1 WHERE id = '$(sec_ws_id a)'"; }
# lim_wait_cpu_max WANT -- the worker's tick is a minute; allow two.
lim_wait_cpu_max() {
  local i got
  for ((i = 0; i < 130; i += 5)); do
    got=$(lim_cgroup cpu.max)
    [ "$got" = "$1" ] && break
    sleep 5
  done
  echo "$got"
}
lim_set_throttle "'${lim_throttle_json}'::jsonb"
check_output "a throttled to ${lim_share}% of ${lim_cpu} CPUs gets cpu.max of its allowance" \
  "$((lim_allow_ms * 1000)) 100000" lim_wait_cpu_max "$((lim_allow_ms * 1000)) 100000"
# The container's cgroup root is its own, but the limit files stay the host's
# root's, unmapped inside, so the refusal must be for permission.
lim_root_refused_cpu_max() {
  local said
  said=$(sec_exec a root "test -r /sys/fs/cgroup/cpu.max && echo max 100000 > /sys/fs/cgroup/cpu.max" 2>&1) && return 1
  [[ "$said" == *"Permission denied"* ]]
}
check "root inside throttled a cannot write its own cpu.max (permission denied)" lim_root_refused_cpu_max
check_output "a's cpu.max is unchanged after root inside a tried to write it" \
  "$((lim_allow_ms * 1000)) 100000" lim_cgroup cpu.max
lim_set_throttle NULL
check_output "a's cpu.max returns to no quota once the throttle is cleared" \
  "max 100000" lim_wait_cpu_max "max 100000"

# ── Disk ─────────────────────────────────────────────────────────

# fallocate reserves blocks without writing them, so the thin pool is not used
# up (Epic 12a decisions).  The file goes whatever happens.  It prints what
# fallocate said, so a refusal for space can be told from any other failure.
lim_fallocate() { # KEY USER DIR SIZE
  sec_exec "$1" "$2" "f=$3/.sectest-fill-${SEC_RUN_ID}; fallocate -l $4 \$f 2>&1; rc=\$?; rm -f \$f; exit \$rc"
}
# lim_refused LABEL KEY USER DIR SIZE -- passes only on a refusal for space.
lim_refused() {
  local label="$1" said; shift
  said=$(lim_fallocate "$@" 2>&1 | tr '\n' ' ')
  if [[ "$said" == *"No space left on device"* ]]; then
    sec_pass "$label"
  else
    sec_fail "${label} (fallocate said: ${said:-nothing, so it succeeded})"
  fi
}
check "fallocate a little in a's home works (control)" lim_fallocate a student /home/student 64M
check "fallocate a little in a's Docker volume works (control)" lim_fallocate a root /var/lib/docker 64M
check "fallocate a little on a's root disk works (control)" lim_fallocate a root /var/tmp 64M
lim_refused "fallocate past a's home volume (${lim_home_gib} GiB) is refused for lack of space" \
  a student /home/student "$((lim_home_gib + 1))G"
lim_refused "fallocate past a's Docker volume (${lim_docker_gib} GiB) is refused for lack of space" \
  a root /var/lib/docker "$((lim_docker_gib + 1))G"
lim_refused "fallocate past a's root disk (${lim_root_gb} GB) is refused for lack of space" \
  a root /var/tmp "$((lim_root_gb + 1))G"

# ── Heavy: memory past the limit ─────────────────────────────────

if [ "$SEC_HEAVY" = "1" ]; then
  # Repeating a byte writes every page, so the memory is really used.
  lim_over=$(awk -v b="$lim_mem_bytes" 'BEGIN { printf "%d", b / 1048576 + 512 }')
  lim_refuses_mem() {
    ! sec_exec a student "timeout 120 python3 -c 'b = b\"x\" * (${lim_over} * 1048576); print(len(b))'" >/dev/null 2>&1
  }
  lim_oom_kills() { lim_cgroup memory.events | awk '$1 == "oom_kill" { print $2 }'; }
  lim_main_pids() { sec_ssh "systemctl show -p MainPID --value postgresql@17-main portikus-api | grep . | paste -sd' '"; }
  lim_pids_before=$(lim_main_pids)
  lim_kills_before=$(lim_oom_kills)
  lim_mark=$(lim_watch_count)
  check "heavy: allocating ${lim_over} MiB in a is stopped by the memory limit" lim_refuses_mem
  lim_kills_after=$(lim_oom_kills)
  lim_mem_watch=$(lim_watch_summary "$((${lim_mark:-0} + 1))")
  echo "Memory past the limit in a: OOM kills in a's cgroup ${lim_kills_before:-?} before, ${lim_kills_after:-?} after; PostgreSQL and API main PIDs ${lim_pids_before} before, $(lim_main_pids) after; liveness meanwhile: ${lim_mem_watch}"
  check "heavy: the kill came from a's own memory limit (memory.events oom_kill went up)" \
    test "${lim_kills_after:-0}" -gt "${lim_kills_before:-0}"
  check_output "heavy: PostgreSQL and the API kept running (same main PIDs)" "$lim_pids_before" lim_main_pids
  check "heavy: the API and b's agent answered within two seconds while a ran out of memory" \
    lim_watch_ok "$lim_mem_watch"
  # The same allocation from a tmux pane inside the agent's cgroup, where the
  # agent starts terminals: only the program dies, the agent and tmux stay.
  # setpriv, not su, so PAM does not move tmux into a login session's cgroup.
  lim_tmux="setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/student tmux -L sectest-oom"
  lim_agent_pid() { sec_exec a root "systemctl show -p MainPID --value portikus-workspace-agent"; }
  lim_agent_before=$(lim_agent_pid)
  lim_kills_before=$(lim_oom_kills)
  sec_exec a root "echo \$\$ > /sys/fs/cgroup/system.slice/portikus-workspace-agent.service/cgroup.procs \
    && ${lim_tmux} new-session -d -s oom bash \
    && ${lim_tmux} send-keys -t oom 'python3 -c \"b = b\\\"x\\\" * (${lim_over} * 1048576)\"; echo sectest-done' Enter" >/dev/null 2>&1
  lim_pane_done() {
    local i
    for ((i = 0; i < 120; i += 2)); do
      sec_exec a root "${lim_tmux} capture-pane -p -t oom" 2>/dev/null | grep -qx sectest-done && return 0
      sleep 2
    done
    return 1
  }
  check "heavy: the allocation in a's terminal pane finished" lim_pane_done
  check "heavy: it was an OOM kill (memory.events oom_kill went up)" \
    test "$(lim_oom_kills)" -gt "${lim_kills_before:-0}"
  check_output "heavy: a's agent kept running (same main PID)" "$lim_agent_before" lim_agent_pid
  check "heavy: a's tmux session survived the OOM kill" sec_exec a root "${lim_tmux} has-session -t oom"
  sec_exec a root "${lim_tmux} kill-server" >/dev/null 2>&1 || true
  # A protected service still dies at its own cap, so a flood against Dex
  # or the API cannot take the VM: a throwaway unit with Dex's settings.
  # The output is captured first: grep -q would close the pipe early, and
  # pipefail would count that against ssh.
  lim_capped() {
    local said
    said=$(sec_ssh "sudo systemd-run --wait --collect --unit=portikus-sectest-${SEC_RUN_ID}-cap \
      -p OOMScoreAdjust=-900 -p MemoryMax=256M python3 -c 'b = b\"x\" * (512 * 1048576)' 2>&1")
    [[ "$said" == *"Finished with result: oom-kill"* ]]
  }
  check "heavy: a service with the platform's OOM adjustment is killed at its memory cap" lim_capped
fi

lim_watch=$(lim_watch_stop)
echo "Liveness while a was under pressure: ${lim_watch}"
check "the API and b's agent answered within two seconds throughout" lim_watch_ok "$lim_watch"

# ── Heavy: two busy workspaces and the platform (docs/CAPACITY.md) ──

if [ "$SEC_HEAVY" = "1" ]; then
  # The platform's slice outweighs each workspace ten to one, so while a and
  # b fill every CPU they have and write to disk, /health through the edge
  # and a terminal echo in b through the API must stay quick.  This only
  # contends the platform when the workspaces' CPUs cover the VM's, as on
  # the pilot's 4 vCPUs; on a bigger VM it measures the quiet case.
  lim_bound_ms=1000
  lim_burn_s=45
  echo "VM CPUs: $(sec_ssh nproc); CPUs a and b burn: $((2 * lim_cpu)); bound for /health and a terminal echo: ${lim_bound_ms} ms"
  # The marker is typed in two quoted halves, so only the command's output
  # holds it whole, never the echo of the typing.  Prints "max median" in ms.
  lim_echo_js='import fs from "node:fs";
const [url, origin, rounds] = process.argv.slice(2);
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
ws.binaryType = "arraybuffer";
let screen = "", round = -1, want = "", sentAt = 0;
const times = [];
function next() {
	round++;
	if (round >= Number(rounds)) {
		times.sort((x, y) => x - y);
		console.log(`${Math.round(times.at(-1))} ${Math.round(times[times.length >> 1])}`);
		process.exit(0);
	}
	screen = "";
	want = `E${round}Q${round}Z`;
	sentAt = performance.now();
	ws.send(JSON.stringify({ type: "input", data: `echo E${round}Q"${round}Z"\r` }));
}
ws.addEventListener("message", (event) => {
	if (round === -1 && sentAt === 0) {
		sentAt = 1;
		setTimeout(next, 1000);
		return;
	}
	screen += typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
	if (want && screen.includes(want)) {
		want = "";
		times.push(performance.now() - sentAt);
		setTimeout(next, 250);
	}
});
ws.addEventListener("error", () => process.exit(1));
setTimeout(() => process.exit(1), 60000);'
  printf '%s\n' "$lim_echo_js" | sec_ssh_stdin "cat > ${SEC_REMOTE_DIR}/echo.mjs"
  lim_b_tid=""
  if [ "$(sec_http b POST "/workspaces/$(sec_ws_id b)/terminals" -H 'Content-Type: application/json' --data '{}')" = "201" ]; then
    lim_b_tid=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
  fi
  lim_echo() {
    sec_ssh_stdin "NODE_EXTRA_CA_CERTS=${SEC_CA} node ${SEC_REMOTE_DIR}/echo.mjs \
      '${SEC_API/https/wss}/workspaces/$(sec_ws_id b)/terminals/${lim_b_tid}/ws' '${SEC_API}' 10" \
      <"${SEC_LOCAL_DIR}/b.cookie" 2>/dev/null
  }
  # Twenty requests half a second apart; prints "max failed", max in ms.
  lim_health() {
    sec_ssh "for i in \$(seq 20); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 5 --cacert ${SEC_CA} ${SEC_API}/health; sleep 0.5; done" \
      | awk '$1 != 200 { bad++ } { t = $2 * 1000; if (t > max) max = t } END { printf "%d %d", max, bad }'
  }
  # lim_quick "MAX ..." -- the first figure is within the bound.
  lim_quick() { [ -n "$1" ] && [ "${1%% *}" -le "$lim_bound_ms" ]; }
  lim_usec() { sec_ssh "cat /sys/fs/cgroup/lxc.payload.portikus_$(sec_instance "$1")/cpu.stat" | awk '$1 == "usage_usec" { print $2 }'; }
  lim_calm_health=$(lim_health)
  lim_calm_echo=$(lim_echo)
  echo "Quiet: /health max ${lim_calm_health% *} ms (${lim_calm_health#* } failed); terminal echo in b max and median ${lim_calm_echo:-none} ms"
  check "heavy: a terminal echo in b works while the VM is quiet (control)" test -n "$lim_calm_echo"
  # One busy loop per CPU and a direct-I/O write loop in each workspace.
  lim_burn="f=\$HOME/.sectest-burn-${SEC_RUN_ID}; for i in \$(seq ${lim_cpu}); do timeout ${lim_burn_s} sh -c 'while :; do :; done' & done; \
    timeout ${lim_burn_s} sh -c \"while :; do dd if=/dev/zero of=\$f bs=1M count=512 oflag=direct 2>/dev/null; done\"; rm -f \$f; wait"
  lim_a_before=$(lim_usec a); lim_b_before=$(lim_usec b)
  lim_burn_start=$(date +%s%N)
  sec_exec a student "$lim_burn" >/dev/null 2>&1 &
  lim_burn_a=$!
  sec_exec b student "$lim_burn" >/dev/null 2>&1 &
  lim_burn_b=$!
  sleep 5
  lim_busy_health=$(lim_health)
  lim_busy_echo=$(lim_echo)
  wait "$lim_burn_a" "$lim_burn_b"
  lim_burn_ns=$(($(date +%s%N) - lim_burn_start))
  lim_pct() { awk -v u="$1" -v ns="$lim_burn_ns" -v c="$lim_cpu" 'BEGIN { printf "%d", 100 * u * 1000 / (ns * c) }'; }
  lim_a_busy=$(lim_pct "$(($(lim_usec a) - ${lim_a_before:-0}))")
  lim_b_busy=$(lim_pct "$(($(lim_usec b) - ${lim_b_before:-0}))")
  echo "Busy: a ${lim_a_busy}% and b ${lim_b_busy}% of ${lim_cpu} CPUs each; /health max ${lim_busy_health% *} ms (${lim_busy_health#* } failed); terminal echo in b max and median ${lim_busy_echo:-none} ms"
  check "heavy: a and b kept their CPUs at least 70% busy (control)" \
    test "$lim_a_busy" -ge 70 -a "$lim_b_busy" -ge 70
  check "heavy: every /health answered 200 while a and b were busy" test "${lim_busy_health#* }" = 0
  check "heavy: /health answered within ${lim_bound_ms} ms while a and b were busy" lim_quick "$lim_busy_health"
  check "heavy: a terminal echo in b came back within ${lim_bound_ms} ms while a and b were busy" \
    lim_quick "$lim_busy_echo"
  [ -n "$lim_b_tid" ] && sec_http b DELETE "/workspaces/$(sec_ws_id b)/terminals/${lim_b_tid}" >/dev/null

  # ── Heavy: Caddy and PostgreSQL come back on their own ─────────

  # Killing Caddy drops every connection, including the suite's presence
  # sockets, so presence is held again afterwards.
  # lim_back_in SECONDS CMD... -- seconds until CMD succeeds, or "never".
  lim_back_in() {
    local limit="$1" i; shift
    for ((i = 1; i <= limit; i++)); do
      sleep 1
      if "$@" >/dev/null 2>&1; then echo "$i"; return 0; fi
    done
    echo never
  }
  lim_edge_ok() {
    [ "$(sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 2 --cacert ${SEC_CA} ${SEC_API}/health")" = 200 ]
  }
  lim_db_ok() { [ "$(sec_http a GET "/workspaces/$(sec_ws_id a)")" = 200 ]; }
  lim_main_pid() { sec_ssh "systemctl show -p MainPID --value $1"; }
  lim_pid_before=$(lim_main_pid caddy)
  sec_ssh "sudo systemctl kill -s KILL caddy"
  lim_took=$(lim_back_in 20 lim_edge_ok)
  echo "Caddy killed: the site answered again after ${lim_took} s"
  check "heavy: the site answers within 15 s of Caddy being killed" test "$lim_took" != never -a "${lim_took/never/99}" -le 15
  check "heavy: Caddy runs as a new process" test "$(lim_main_pid caddy)" != "$lim_pid_before"
  lim_pid_before=$(lim_main_pid postgresql@17-main)
  sec_ssh "sudo systemctl kill -s KILL postgresql@17-main"
  lim_took=$(lim_back_in 40 lim_db_ok)
  echo "PostgreSQL killed: the API read the database again after ${lim_took} s"
  check "heavy: the API reads the database within 30 s of PostgreSQL being killed" test "$lim_took" != never -a "${lim_took/never/99}" -le 30
  check "heavy: PostgreSQL runs as a new process" test "$(lim_main_pid postgresql@17-main)" != "$lim_pid_before"
  check "heavy: the API, worker and controller are all active afterwards" \
    sec_ssh systemctl is-active portikus-api portikus-worker portikus-controller
  sec_hold_presence a
  sec_hold_presence b
fi
