#!/usr/bin/env bash
# Bounded resource limits (Epic 12a Done item 18; SPEC.md 19.1 and 24.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# a's cgroup limits match the profile, a bounded fork loop hits the process
# limit, and fallocate past each volume's size fails.  Meanwhile the API and
# b's agent keep answering within two seconds.  The heavy tests, memory past
# the limit, run only with PORTIKUS_SECURITY_HEAVY=1 on an otherwise empty VM.
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
lim_b_ip=$(sec_ws_ip b)
sec_agent_header b
lim_watch_start() {
  sec_ssh "rm -f ${SEC_REMOTE_DIR}/watch.stop ${SEC_REMOTE_DIR}/watch.log; \
    nohup bash -c 'while [ ! -f ${SEC_REMOTE_DIR}/watch.stop ]; do \
      echo api \$(curl -s -o /dev/null -w %{http_code} --max-time 2 --cacert ${SEC_CA} ${SEC_API}/health) \
               b \$(curl -s -o /dev/null -w %{http_code} --max-time 2 -H @${SEC_REMOTE_DIR}/b.agent http://${lim_b_ip}:7400/health); \
      sleep 0.5; done' >${SEC_REMOTE_DIR}/watch.log 2>&1 </dev/null &"
}
# Prints "N samples, M slow or failed".
lim_watch_stop() {
  sec_ssh "touch ${SEC_REMOTE_DIR}/watch.stop; sleep 3; \
    awk '{ n++ } \$2 != 200 || \$4 != 200 { bad++ } END { printf \"%d samples, %d slow or failed\", n, bad }' ${SEC_REMOTE_DIR}/watch.log"
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

# ── Disk ─────────────────────────────────────────────────────────

# fallocate reserves blocks without writing them, so the thin pool is not used
# up (Epic 12a decisions).  The file goes whatever happens.
lim_fallocate() { # KEY USER DIR SIZE
  sec_exec "$1" "$2" "f=$3/.sectest-fill-${SEC_RUN_ID}; fallocate -l $4 \$f; rc=\$?; rm -f \$f; exit \$rc" >/dev/null 2>&1
}
check "fallocate a little in a's home works (control)" lim_fallocate a student /home/student 64M
lim_refuses() { ! lim_fallocate "$@"; }
check "fallocate past a's home volume (${lim_home_gib} GiB) fails" lim_refuses a student /home/student "$((lim_home_gib + 1))G"
check "fallocate past a's Docker volume (${lim_docker_gib} GiB) fails" lim_refuses a root /var/lib/docker "$((lim_docker_gib + 1))G"
check "fallocate past a's root disk (${lim_root_gb} GB) fails" lim_refuses a root /var/tmp "$((lim_root_gb + 1))G"

# ── Heavy: memory past the limit ─────────────────────────────────

if [ "$SEC_HEAVY" = "1" ]; then
  # Repeating a byte writes every page, so the memory is really used.
  lim_over=$(awk -v b="$lim_mem_bytes" 'BEGIN { printf "%d", b / 1048576 + 512 }')
  lim_refuses_mem() {
    ! sec_exec a student "timeout 120 python3 -c 'b = b\"x\" * (${lim_over} * 1048576); print(len(b))'" >/dev/null 2>&1
  }
  check "heavy: allocating ${lim_over} MiB in a is stopped by the memory limit" lim_refuses_mem
fi

lim_watch=$(lim_watch_stop)
echo "Liveness while a was under pressure: ${lim_watch}"
check "the API and b's agent answered within two seconds throughout" lim_watch_ok "$lim_watch"
