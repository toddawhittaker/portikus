#!/usr/bin/env bash
# The container boundary (Epic 12a Done item 12, the Gate C container part;
# SPEC.md 24.4 and 24.5).
#
# Sourced by infra/tests/security-test.sh once workspaces a and b are running.
# a has no mount of b's volumes, the two ID maps do not overlap, root in a
# privileged inner Docker container is an unprivileged user on the VM, and
# symbolic links planted where the controller writes files, or on their
# parent directories, cannot steer those writes onto the VM.  The last two
# parts each restart a, which is this run's own, and put it back afterwards.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh
# shellcheck disable=SC2016  # the probe scripts expand inside the workspace

echo ""
echo "--- Container boundary ---"

ct_a=$(sec_instance a)
ct_b=$(sec_instance b)

# ── Volumes ──────────────────────────────────────────────────────

# Every disk device of an instance as "path source", sorted.
ct_devices() {
  sec_ssh "incus query '/1.0/instances/$1?project=${SEC_PROJECT}'" \
    | jq -r '.expanded_devices | to_entries[] | select(.value.type == "disk") | "\(.value.path) \(.value.source // "-")"' | sort
}
ct_devices_a=$(ct_devices "$ct_a")
check_output "a's home and Docker volumes are a's own" \
  "/home/student ${ct_a}-home|/var/lib/docker ${ct_a}-docker" \
  bash -c "grep -E '^/(home/student|var/lib/docker) ' <<<'${ct_devices_a}' | paste -sd'|'"
# Epic 10 gives each workspace its own recovery volume (ADR 0020).
check_output "a's recovery volume is a's own" \
  "/var/lib/portikus/recovery ${ct_a}-recovery" \
  bash -c "grep -E '^/var/lib/portikus/recovery ' <<<'${ct_devices_a}'"
# A source starting with / is a host bind mount from the profile, not a volume.
check_output "every storage volume attached to a is one of a's own" "0" \
  bash -c "awk '\$2 != \"-\" && substr(\$2, 1, 1) != \"/\" && index(\$2, \"${ct_a}-\") != 1' <<<'${ct_devices_a}' | wc -l"
check_output "no device of a names b's instance" "0" \
  bash -c "grep -c -F '${ct_b}' <<<'${ct_devices_a}'; true"
check_output "nothing mounted in a names b's instance" "0" \
  sec_exec a root "grep -c -F ${ct_b} /proc/self/mountinfo; true"

# ── ID maps ──────────────────────────────────────────────────────

# ct_idmap INSTANCE -- "first last" host ID ranges, one line per map entry.
ct_idmap() {
  sec_ssh "incus config get $1 volatile.idmap.current --project ${SEC_PROJECT}" \
    | jq -r '.[] | "\(.Hostid) \(.Hostid + .Maprange - 1)"'
}
ct_idmap_a=$(ct_idmap "$ct_a")
ct_idmap_b=$(ct_idmap "$ct_b")
ct_base_a=$(sec_ssh "incus config get ${ct_a} volatile.idmap.current --project ${SEC_PROJECT}" \
  | jq -r '[.[] | select(.Isuid and .Nsid == 0)][0].Hostid // empty')
echo "ID map a: $(echo "$ct_idmap_a" | paste -sd' ')  b: $(echo "$ct_idmap_b" | paste -sd' ')"
ct_overlaps() {
  local a1 a2 b1 b2 hits=0
  if [ -z "$ct_idmap_a" ] || [ -z "$ct_idmap_b" ]; then echo "missing"; return; fi
  while read -r a1 a2; do
    while read -r b1 b2; do
      [ "$a1" -le "$b2" ] && [ "$b1" -le "$a2" ] && hits=$((hits + 1))
    done <<<"$ct_idmap_b"
  done <<<"$ct_idmap_a"
  echo "$hits"
}
check_output "a's and b's ID map ranges do not overlap" "0" ct_overlaps
check "a's root maps to an unprivileged host ID" test "${ct_base_a:-0}" -ge 65536

# ── Root in a privileged inner Docker container ──────────────────

# A privileged container with the workspace's / bind-mounted writes a file
# and keeps a marker process alive; the VM must see that process, and the
# file through the container's own mount namespace, as a's shifted root.
ct_marker="/var/tmp/sectest-root-${SEC_RUN_ID}"
ct_sleep=$((70000 + RANDOM % 9999))
sec_exec a student "docker run -d --rm --name sectest-priv-${SEC_RUN_ID} --privileged -v /:/host ${SEC_DOCKER_IMAGE} \
  sh -c 'touch /host${ct_marker} && exec sleep ${ct_sleep}'" >/dev/null 2>&1
sleep 2
check_output "root in a privileged inner container created the file as root inside a" "0" \
  sec_exec a root "stat -c %u ${ct_marker}"
ct_vm_uid_of_sleep() {
  sec_ssh "ps -eo uid=,args= | awk '\$2 == \"sleep\" && \$3 == \"${ct_sleep}\" { print \$1; exit }'"
}
# An empty base would match an empty answer, so the two checks need it.
ct_base_known() { [ -n "$ct_base_a" ]; }
check "a's shifted root ID is known (control)" ct_base_known
check_output "on the VM, that container's root runs as a's shifted root (${ct_base_a:-unknown})" \
  "${ct_base_a:-unknown}" ct_vm_uid_of_sleep
# The file as the VM sees it through the running container's mount namespace.
ct_vm_uid_of_file() {
  local pid
  pid=$(sec_ssh "incus info ${ct_a} --project ${SEC_PROJECT}" | awk '/^PID:/ { print $2; exit }')
  [ -n "$pid" ] || return 1
  sec_ssh "sudo stat -c %u /proc/${pid}/root${ct_marker}"
}
check_output "on the VM, the file belongs to a's shifted root (${ct_base_a:-unknown})" \
  "${ct_base_a:-unknown}" ct_vm_uid_of_file
check_output "the VM has no file at the marker path" "absent" \
  sec_ssh "test -e ${ct_marker} && echo present || echo absent"
sec_exec a student "docker rm -f sectest-priv-${SEC_RUN_ID}" >/dev/null 2>&1
sec_exec a root "rm -f ${ct_marker}" >/dev/null 2>&1

# ── Symbolic links where the controller pushes files ─────────────

# The controller writes these on every start (apps/workspace-controller,
# provider.ts).  Root in a replaces each with a link to a path that exists on
# the VM as well, then a restarts.  Nothing may appear on the VM.
ct_pushed=(/etc/hostname /etc/timezone /etc/profile.d/portikus.sh /etc/portikus/agent.token)
ct_escape_dir="/etc/portikus"
ct_plant=""
ct_vm_absent=""
for ct_i in "${!ct_pushed[@]}"; do
  ct_target="${ct_escape_dir}/sectest-${SEC_RUN_ID}-${ct_i}"
  ct_plant="${ct_plant} cp -a ${ct_pushed[$ct_i]} ${ct_pushed[$ct_i]}.sectest && ln -sfn ${ct_target} ${ct_pushed[$ct_i]} &&"
  ct_vm_absent="${ct_vm_absent} ${ct_target}"
done
check "root in a plants links at every path the controller pushes" \
  sec_exec a root "${ct_plant} true"

ct_restart_a() {
  local status i state seen_down=no
  status=$(sec_http a POST "/workspaces/$(sec_ws_id a)/restart")
  case "$status" in 2??) ;; *) return 1 ;; esac
  for ((i = 0; i < 240; i += 2)); do
    state=$(sec_ws_state a)
    [ "$state" != "running" ] && seen_down=yes
    [ "$seen_down" = "yes" ] && [ "$state" = "running" ] && break
    sleep 2
  done
  [ "$state" = "running" ] || return 1
  sec_agent_header a
  for ((i = 0; i < 60; i += 2)); do
    [ "$(sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H @${SEC_REMOTE_DIR}/a.agent http://$(sec_ws_ip a):7400/health")" = "200" ] && return 0
    sleep 2
  done
  return 1
}
echo "Restarting workspace a with the links in place..."
check "a restarts with the links in place and its agent answers" ct_restart_a
check_output "the restart created nothing on the VM" "" \
  sec_ssh "sudo ls -d ${ct_vm_absent} 2>/dev/null; true"
check_output "the pushed files are present inside a after the restart" "4" \
  sec_exec a root "n=0; for p in ${ct_pushed[*]}; do [ -s \"\$(readlink -f \$p)\" ] && n=\$((n + 1)); done; echo \$n"

# Put a back as it was, keeping what the restart just pushed (the agent token
# is new): each link is replaced by the file it points to.
ct_restore=""
for ct_path in "${ct_pushed[@]}"; do
  ct_restore="${ct_restore} if [ -L ${ct_path} ]; then t=\$(readlink -f ${ct_path}); rm -f ${ct_path}; mv \"\$t\" ${ct_path}; fi; rm -f ${ct_path}.sectest;"
done
sec_exec a root "${ct_restore} true" >/dev/null 2>&1

# ── Symbolic links on the parent directories ─────────────────────

# Root in a turns /etc/portikus and /etc/profile.d into links to a directory
# that exists, empty and writable by anyone, at the same path on the VM.  If
# the controller's pushes followed a link on the VM's side, they would land
# there.  The copies inside a keep a working, so the restart itself succeeds.
ct_dirs=(/etc/portikus /etc/profile.d)
ct_dir_plant=""
ct_dir_restore=""
for ct_dir in "${ct_dirs[@]}"; do
  ct_target="${SEC_REMOTE_VARDIR}/$(basename "$ct_dir")"
  ct_dir_plant="${ct_dir_plant} mkdir -p ${ct_target} && cp -a ${ct_dir}/. ${ct_target}/ \
    && mv ${ct_dir} ${ct_dir}.sectest && ln -s ${ct_target} ${ct_dir} &&"
  # The restart pushed a new agent token into the link's target; keep it.
  ct_dir_restore="${ct_dir_restore} if [ -L ${ct_dir} ]; then rm -f ${ct_dir} \
    && mv ${ct_dir}.sectest ${ct_dir} && cp -a ${ct_target}/. ${ct_dir}/; fi;"
done
ct_dir_restore="${ct_dir_restore} rm -rf ${SEC_REMOTE_VARDIR};"
sec_ssh "install -d -m 0755 ${SEC_REMOTE_VARDIR} && install -d -m 1777 ${SEC_REMOTE_VARDIR}/portikus ${SEC_REMOTE_VARDIR}/profile.d"
check "root in a turns the pushed files' directories into links" \
  sec_exec a root "${ct_dir_plant} true"
echo "Restarting workspace a with the directory links in place..."
check "a restarts with the directory links in place and its agent answers" ct_restart_a
check_output "the restart wrote nothing into the matching directories on the VM" "" \
  sec_ssh "sudo find ${SEC_REMOTE_VARDIR} -mindepth 2; true"
check_output "the pushed files reached a through its links" "2" \
  sec_exec a root "n=0; for p in /etc/portikus/agent.token /etc/profile.d/portikus.sh; do [ -s \"\$(readlink -f \$p)\" ] && n=\$((n + 1)); done; echo \$n"
sec_exec a root "${ct_dir_restore} true" >/dev/null 2>&1
ct_restored() {
  sec_exec a root "test ! -L /etc/portikus && test ! -L /etc/profile.d && test -s /etc/portikus/agent.token \
    && test -s /etc/profile.d/portikus.sh && test ! -e /etc/portikus.sectest && test ! -e /etc/profile.d.sectest" || return 1
  sec_agent_header a
  [ "$(sec_ssh "curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H @${SEC_REMOTE_DIR}/a.agent http://$(sec_ws_ip a):7400/health")" = "200" ]
}
check "a is restored: real directories, pushed files present, agent answers" ct_restored
sec_ssh "sudo rm -rf ${SEC_REMOTE_VARDIR}" 2>/dev/null
