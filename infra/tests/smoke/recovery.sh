#!/usr/bin/env bash
# Recovery points, Reset Docker and Rebuild on alice's workspace.  Reset and
# rebuild are destructive, so they only ever name the instance this run made.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 15b. Recovery points, Reset Docker and Rebuild (SPEC.md 15,
#      16.4, 17.2). Reset and rebuild are destructive, so they only ever
#      name the instance this run created; this block sits inside the
#      branch that runs only when no other workspace is on the VM.
echo ""
echo "Recovery points, Reset Docker and Rebuild..."
RECOVERY_ROOT="/var/lib/portikus/recovery"
RS_DIR="${PROJECTS_DIR}/recovery-smoke"
RS_GIT="git -c user.name=Smoke -c user.email=smoke@example.invalid"

run_owns_instance() {
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

if [ -z "$ws_instance" ] || ! run_owns_instance; then
  bad "Epic 10: no instance created by this run to test on"
else
  # Grace 0 keeps the workspace up while the worker stops and starts it
  # for an operation. cleanup_lifecycle restores the original value.
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
