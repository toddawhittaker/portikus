#!/usr/bin/env bash
# CI probe only: samples memory, shared memory, and Chromium process limits every 2 s.
cg="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
while true; do
	ts=$(date +%T)
	mem=$(free -m | awk '/Mem:/ {print "used=" $3 " avail=" $7}')
	shmem=$(awk '/^Shmem:/ {s=$2} /^ShmemHugePages:/ {h=$2} END {print "ShmemMB=" int(s/1024) " ShmemHugeMB=" int(h/1024)}' /proc/meminfo)
	shm=$(df -m /dev/shm | awk 'NR==2 {print "shmUsedMB=" $3}')
	shm="$shm $(df -m "${TMPDIR:-/tmp}" | awk 'NR==2 {print "tmpUsedMB=" $3 " tmpSizeMB=" $2}')"
	n=0 fds=0 thr=0 maxfd=0 rss=0 maps=0 top=""
	for p in $(pgrep -f chrome-headless-shell); do
		n=$((n + 1))
		f=$(ls "/proc/$p/fd" 2>/dev/null | wc -l)
		fds=$((fds + f))
		if [ "$f" -gt "$maxfd" ]; then maxfd=$f; top=$p; fi
		t=$(awk '/^Threads/ {print $2}' "/proc/$p/status" 2>/dev/null)
		thr=$((thr + ${t:-0}))
		r=$(awk '/^VmRSS/ {print $2}' "/proc/$p/status" 2>/dev/null)
		rss=$((rss + ${r:-0}))
		m=$(wc -l < "/proc/$p/maps" 2>/dev/null)
		[ "${m:-0}" -gt "$maps" ] && maps=$m
	done
	detail=""
	if [ -n "$top" ] && [ "$maxfd" -gt 500 ]; then
		type=$(tr '\0' ' ' < "/proc/$top/cmdline" 2>/dev/null | grep -o -- '--type=[a-z-]*' | head -1)
		kinds=$(ls -l "/proc/$top/fd" 2>/dev/null | awk '{print $NF}' | sed 's/:.*//; s/ (deleted)//; s/[0-9]*$//' | sort | uniq -c | sort -rn | head -4 | tr -s ' \n' ' ')
		roll=$(awk '/^(Rss|Shared_Clean|Shared_Dirty|ShmemPmdMapped|AnonHugePages):/ {printf "%s%d ", $1, $2/1024}' "/proc/$top/smaps_rollup" 2>/dev/null)
		detail="top=$top${type:- browser} kinds=[$kinds] $roll"
	fi
	tasks=$(ps -eLf --no-headers | wc -l)
	echo "$ts $mem $shmem $shm chromeProcs=$n chromeFds=$fds maxProcFds=$maxfd chromeThreads=$thr chromeRssMB=$((rss / 1024)) maxMaps=$maps allTasks=$tasks cgPids=$(cat "$cg/pids.current" 2>/dev/null) $detail"
	sleep 2
done
