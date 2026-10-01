# Sourced by the backup scripts beside it, never run (ADR 0024, ADR 0044).
# shellcheck shell=bash
#
# vm CMD and vm_in CMD run CMD on deploy@$VM, vm_in with standard input.
# OPERATOR, when set, is the account whose SSH key the VM trusts; empty
# means the caller's own.  VM_CALL_TIMEOUT bounds every vm call in seconds
# (0, the default, means no limit).  use_local_vm runs the same commands on
# this machine instead.

# A hung connection is cut after a minute without an answer from sshd,
# however long the remote command itself runs.
PORTIKUS_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
VM_CALL_TIMEOUT=0
# Never taken from the environment: only a caller's own option sets it.
OPERATOR=""

# with_limit SECONDS CMD... -- CMD, killed after SECONDS; 0 means no limit.
with_limit() {
  local t=$1
  shift
  if [ "$t" = 0 ]; then "$@"; else timeout -k 5 "$t" "$@"; fi
}

# vm_ssh SECONDS [-n] CMD... -- ssh to the VM within SECONDS.
vm_ssh() {
  local t=$1 ssh_cmd=(ssh)
  shift
  if [ "${1:-}" = -n ]; then ssh_cmd+=(-n); shift; fi
  ssh_cmd+=("${PORTIKUS_SSH_OPTS[@]}" "deploy@${VM}")
  if [ -n "${OPERATOR:-}" ]; then
    with_limit "$t" runuser -u "$OPERATOR" -- "${ssh_cmd[@]}" "$@"
  else
    with_limit "$t" "${ssh_cmd[@]}" "$@"
  fi
}
vm() { vm_ssh "$VM_CALL_TIMEOUT" -n "$@"; }
# vm_stream SECONDS CMD -- a stream from standard input, with its own time limit.
vm_stream() { local t=$1; shift; vm_ssh "$t" "$@"; }
vm_in() { vm_stream 0 "$@"; }

# shellcheck disable=SC2317
use_local_vm() {
  # The same commands as over SSH, run here; this is already root, so sudo is a no-op.
  sudo() { "$@"; }
  export -f sudo
  vm() { with_limit "$VM_CALL_TIMEOUT" bash -c "$*" </dev/null; }
  vm_stream() { local t=$1; shift; with_limit "$t" bash -c "$*"; }
}

# "<bytes> <sha256>" of standard input, as backup.sh records it; with a file
# argument, standard input also goes on to standard output and the sum to it.
# shellcheck disable=SC2120
size_sum() {
  python3 -c 'import hashlib, sys
h, n = hashlib.sha256(), 0
out = sys.stdout.buffer if len(sys.argv) > 1 else None
for b in iter(lambda: sys.stdin.buffer.read(1 << 20), b""):
    h.update(b); n += len(b)
    if out: out.write(b)
line = f"{n} {h.hexdigest()}\n"
if out:
    out.flush()
    open(sys.argv[1], "w").write(line)
else:
    sys.stdout.write(line)' "$@"
}
