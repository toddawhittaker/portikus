#!/usr/bin/env bash
# CI probe only: samples memory, shared memory, and Chromium process limits every 2 s.
cg="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)"
while true; do
	ts=$(date +%T)
	mem=$(free -m | awk '/Mem:/ {print "used=" $3 " avail=" $7}')
	swap=$(free -m | awk '/Swap:/ {print "swapUsed=" $3}')
	shm=$(df -m /dev/shm | awk 'NR==2 {print "shmUsedMB=" $3}')
	n=0 fds=0 thr=0 maxfd=0 rss=0 maps=0
	for p in $(pgrep -f chrome-headless-shell); do
		n=$((n + 1))
		f=$(ls "/proc/$p/fd" 2>/dev/null | wc -l)
		fds=$((fds + f))
		[ "$f" -gt "$maxfd" ] && maxfd=$f
		t=$(awk '/^Threads/ {print $2}' "/proc/$p/status" 2>/dev/null)
		thr=$((thr + ${t:-0}))
		r=$(awk '/^VmRSS/ {print $2}' "/proc/$p/status" 2>/dev/null)
		rss=$((rss + ${r:-0}))
		m=$(wc -l < "/proc/$p/maps" 2>/dev/null)
		[ "${m:-0}" -gt "$maps" ] && maps=$m
	done
	tasks=$(ps -eLf --no-headers | wc -l)
	echo "$ts $mem $swap $shm chromeProcs=$n chromeFds=$fds maxProcFds=$maxfd chromeThreads=$thr chromeRssMB=$((rss / 1024)) maxMaps=$maps allTasks=$tasks cgPids=$(cat "$cg/pids.current" 2>/dev/null) cgMemMB=$(($(cat "$cg/memory.current" 2>/dev/null || echo 0) / 1048576))"
	sleep 2
done
