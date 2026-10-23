#!/usr/bin/env bash
# Recovery points on the real workspace agent (SPEC.md 15.8 and 24.6;
# ADR 0024 keeps coding-agent logins out of them).
#
# Sourced by infra/tests/security-test.sh once workspace a is running.  In a
# project of a's, a point is made through the edge; its archive on a's
# recovery volume must hold no Claude Code or Codex login, even where the
# project links to one.  The files are then changed and the point restored:
# every owner and mode must be as before.  The unit tests run the same code
# outside a workspace, without the agent's account and service settings.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- Recovery points ---"

rp_ws=$(sec_ws_id a)
rp_slug="sectest-recovery-${SEC_RUN_ID}"
rp_claude="sectest-claude-login-${SEC_RUN_ID}"
rp_codex="sectest-codex-login-${SEC_RUN_ID}"
rp_control="sectest-recovery-control-${SEC_RUN_ID}"
rp_dir="projects/${rp_slug}"

rp_status=$(sec_http a POST "/workspaces/${rp_ws}/projects" \
  -H 'Content-Type: application/json' \
  --data "{\"name\":\"${rp_slug}\",\"source\":\"new\",\"gitInit\":false}")
rp_pid=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
check_output "a creates a project for its recovery point (control)" "201" echo "$rp_status"

# The logins sit where the CLIs keep them; the project links to both, by
# folder, by file and by a relative path climbing out of the project.
sec_exec a student "set -e
  install -d -m 0700 ~/.claude ~/.codex
  (umask 077; printf '{\"token\":\"%s\"}\n' '${rp_claude}' >~/.claude/.credentials.json
   printf '{\"token\":\"%s\"}\n' '${rp_codex}' >~/.codex/auth.json)
  cd ~/${rp_dir}
  printf '%s\n' '${rp_control}' >control.txt
  mkdir private && printf 'inner\n' >private/inner.txt && chmod 0600 private/inner.txt && chmod 0750 private
  printf '#!/bin/sh\n' >run.sh && chmod 0755 run.sh
  printf 'read only\n' >readonly.txt && chmod 0444 readonly.txt
  printf 'open\n' >open.txt && chmod 0666 open.txt
  ln -s run.sh run-link
  ln -s ~/.claude .claude
  ln -s ~/.codex/auth.json codex-auth.json
  ln -s ../../.claude/.credentials.json claude-rel.json" >/dev/null 2>&1

# Path, owner, group, mode, type and link target of every entry.
rp_tree() {
  sec_exec a student "cd ~/${rp_dir} && find . -mindepth 1 -printf '%P %u:%g %m %y %l\n' | sort"
}
rp_seeded=$(rp_tree)
check "the project was seeded with its modes and links (control)" \
  grep -qx 'private/inner.txt student:student 600 f ' <<<"$rp_seeded"

rp_status=$(sec_http a POST "/workspaces/${rp_ws}/projects/${rp_pid}/recovery-points" \
  -H 'Content-Type: application/json' --data '{}')
rp_point=$(jq -r '.id // empty' "$SEC_LAST_BODY" 2>/dev/null)
check_output "a makes a recovery point through the edge (control)" "201" echo "$rp_status"

if [ -z "$rp_pid" ] || [ -z "$rp_point" ]; then
  bad "recovery setup: the project and its point exist (project '${rp_pid}', point '${rp_point}')"
else
  rp_archive="/var/lib/portikus/recovery/${rp_pid}/${rp_point}.tar.zst"
  rp_tar="${SEC_REMOTE_DIR}/recovery-point.tar"
  # The workspace has no zstd command; the agent compresses with Node's
  # zlib, so the platform's own Node decompresses a copy on the host.
  sec_exec a root "cat ${rp_archive}" \
    | sec_ssh_stdin "${SEC_NODE} -e 'process.stdin.pipe(require(\"node:zlib\").createZstdDecompress()).pipe(process.stdout)' >${rp_tar}"
  # rp_count TEXT -- how often TEXT occurs in the point's tar.
  rp_count() { sec_ssh "grep -a -c -F -- '$1' ${rp_tar}; true"; }
  check_output "the point's archive holds the project's own file (control)" "1" rp_count "$rp_control"
  check_output "the point holds no Claude Code login" "0" rp_count "$rp_claude"
  check_output "the point holds no Codex login" "0" rp_count "$rp_codex"
  check_output "the links to the logins are stored as links, never followed" \
    "l .claude|l claude-rel.json|l codex-auth.json" \
    sec_ssh "tar -tvf ${rp_tar} | awk '{ print substr(\$1, 1, 1), \$6 }' | grep -E ' (\\.claude|claude-rel\\.json|codex-auth\\.json)\$' | sort | paste -sd'|'"

  sec_exec a student "cd ~/${rp_dir} && chmod 0644 private/inner.txt && chmod 0777 private \
    && chmod 0600 run.sh && chmod 0600 open.txt && rm -f readonly.txt run-link" >/dev/null 2>&1
  if [ "$(rp_tree)" != "$rp_seeded" ]; then
    ok "the files were changed after the point (control)"
  else
    bad "the files were changed after the point (control)"
  fi

  rp_status=$(sec_http a POST "/workspaces/${rp_ws}/projects/${rp_pid}/recovery-points/${rp_point}/restore" \
    -H 'Content-Type: application/json' --data '{"skipSafetyPoint":true}')
  check_output "a restores the point through the edge" "204" echo "$rp_status"
  rp_restored=$(rp_tree)
  if [ "$rp_restored" = "$rp_seeded" ]; then
    ok "the restore brings back every owner, mode and link as seeded"
  else
    bad "the restore brings back every owner, mode and link as seeded"
    diff <(printf '%s\n' "$rp_seeded") <(printf '%s\n' "$rp_restored") | sed 's/^/  /'
  fi
fi
