#!/usr/bin/env bash
# Bounded resource limits (Epic 12a Done item 18; SPEC.md 19.1 and 24.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# a's cgroup limits match the profile, a bounded fork loop hits the process
# limit, busy loops fill a's CPUs for 20 seconds, and fallocate past each
# volume's size is refused for lack of space, and the platform services
# carry a negative OOM score adjustment.  Meanwhile the API and
# b's agent keep answering within two seconds.  The heavy tests, memory past
# the limit while PostgreSQL and the API keep running, run only with
# PORTIKUS_SECURITY_HEAVY=1 on an otherwise empty VM.
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

# ── The platform is protected from the out-of-memory killer ──────

# Workspaces may together promise more memory than the VM has; when it runs
# out, the kernel must kill workspace processes first (docs/CAPACITY.md).
lim_platform_units="postgresql@17-main portikus-api portikus-worker portikus-controller caddy"
if sec_ssh "systemctl is-active --quiet portikus-dex"; then lim_platform_units+=" portikus-dex"; fi
for lim_unit in $lim_platform_units; do
  check "${lim_unit} has a negative OOM score adjustment" \
    sec_ssh "p=\$(systemctl show -p MainPID --value ${lim_unit}); [ \"\$p\" -gt 0 ] && [ \"\$(cat /proc/\$p/oom_score_adj)\" -lt 0 ]"
done
# A protected service that takes requests must not be able to take the VM
# with it; PostgreSQL is bounded by its own settings instead.
for lim_unit in ${lim_platform_units/postgresql@17-main/}; do
  check "${lim_unit} has a memory cap" \
    sec_ssh "[ \"\$(cat /sys/fs/cgroup/system.slice/${lim_unit}.service/memory.max)\" != max ]"
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
  # A protected service still dies at its own cap, so a flood against Dex
  # or the API cannot take the VM: a throwaway unit with Dex's settings.
  lim_capped() {
    sec_ssh "sudo systemd-run --wait --collect --unit=portikus-sectest-${SEC_RUN_ID}-cap \
      -p OOMScoreAdjust=-900 -p MemoryMax=256M python3 -c 'b = b\"x\" * (512 * 1048576)' 2>&1" \
      | grep -qx 'Finished with result: oom-kill'
  }
  check "heavy: a service with the platform's OOM adjustment is killed at its memory cap" lim_capped
fi

lim_watch=$(lim_watch_stop)
echo "Liveness while a was under pressure: ${lim_watch}"
check "the API and b's agent answered within two seconds throughout" lim_watch_ok "$lim_watch"
