#!/usr/bin/env bash
# Projects in alice's workspace: create, rename, download, discovery, archive.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 15. Project management end to end (SPEC.md 7).
#     Every request goes through Caddy as alice, and every effect is
#     confirmed inside the container, because a project is a database
#     row and a directory under ~/projects that have to agree.
echo ""
echo "Project management..."

# Project work needs the workspace up, and the shortened grace period
# would stop it part-way through, so hold the presence socket open.
open_socket
ws_state=$(wait_for_state running 60)
check_output "workspace is running for the project checks" "running" \
  echo "$ws_state"

PROJECTS_URL="${API}/workspaces/${ws_id}/projects"
PROJECTS_DIR="/home/student/projects"
ZIP_ON_VM="/tmp/portikus-smoke-project.zip"
ZIP_HEADERS="/tmp/portikus-smoke-project.headers"

# Run a command as the student user inside alice's workspace.
alice_student() {
  local escaped="${*//\'/\'\\\'\'}"
  ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c '${escaped}'"
}

# One field of the project with the given slug in a project list body.
# JSON booleans print as true or false; an absent project prints nothing.
project_field() {
  python3 -c '
import json, sys

slug, field = sys.argv[1], sys.argv[2]
for project in json.load(sys.stdin).get("projects", []):
    if project.get("slug") == slug:
        value = project.get(field)
        if value is True:
            print("true")
        elif value is False:
            print("false")
        elif value is not None:
            print(value)
        break
' "$1" "$2" 2>/dev/null || true
}

active_field() { vm_get alice "${PROJECTS_URL}" | project_field "$1" "$2"; }
archived_field() {
  vm_get alice "${PROJECTS_URL}?state=archived" | project_field "$1" "$2"
}

# The recorded working directory of one terminal.
terminal_cwd() {
  vm_get alice "${API}/workspaces/${ws_id}/terminals" | python3 -c '
import json, sys

wanted = sys.argv[1]
for terminal in json.load(sys.stdin).get("terminals", []):
    if terminal.get("id") == wanted:
        print(terminal.get("cwd", ""))
        break
' "$1" 2>/dev/null || true
}

# 15.1 Create a project (SPEC.md 7.2).
proj_response=$(vm_get alice "${PROJECTS_URL}" \
  "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
       -d '{\"name\": \"Smoke Project\", \"source\": \"new\"}'")
proj_id=$(echo "$proj_response" | json_field id)

if [ -z "$proj_id" ]; then
  bad "POST /projects returned no id: ${proj_response}"
else
  ok "POST /projects returned id=${proj_id}"

  proj_slug=$(echo "$proj_response" | json_field slug)
  proj_path=$(echo "$proj_response" | json_field path)
  check_output "created project has slug smoke-project" "smoke-project" \
    echo "$proj_slug"
  check_output "created project path is under ~/projects" \
    "${PROJECTS_DIR}/smoke-project" echo "$proj_path"
  check "project directory exists in the workspace" \
    alice_student "test -d ${PROJECTS_DIR}/smoke-project"
  check "project directory is a git repository" \
    alice_student "test -d ${PROJECTS_DIR}/smoke-project/.git"

  # 15.2 A terminal opened on the project starts in its directory (SPEC.md 9.4).
  proj_term_response=$(vm_get alice "${API}/workspaces/${ws_id}/terminals" \
    "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"projectId\": \"${proj_id}\"}'")
  proj_term_id=$(echo "$proj_term_response" | json_field id)
  proj_term_cwd=$(echo "$proj_term_response" | json_field cwd)
  check_output "terminal on the project starts in the project directory" \
    "${PROJECTS_DIR}/smoke-project" echo "$proj_term_cwd"

  # 15.3 The listing reports what the agent sees on disk.
  check_output "project is listed as a git repository" "true" \
    active_field smoke-project isGitRepo
  check_output "project is not listed as missing" "false" \
    active_field smoke-project missing

  # 15.4 Renaming moves the directory and rewrites terminal paths.
  rename_response=$(vm_get alice "${PROJECTS_URL}/${proj_id}" \
    "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"name\": \"Smoke Renamed\"}'")
  renamed_slug=$(echo "$rename_response" | json_field slug)
  check_output "rename gives the slug smoke-renamed" "smoke-renamed" \
    echo "$renamed_slug"
  check "old project directory is gone" \
    alice_student "! test -e ${PROJECTS_DIR}/smoke-project"
  check "renamed project directory exists" \
    alice_student "test -d ${PROJECTS_DIR}/smoke-renamed"
  if [ -n "$proj_term_id" ]; then
    check_output "rename rewrites the terminal working directory" \
      "${PROJECTS_DIR}/smoke-renamed" terminal_cwd "$proj_term_id"
  else
    bad "POST /terminals with a projectId returned no id"
  fi

  # 15.5 Download is a zip named after the slug (SPEC.md 7.3).  unzip is
  #      in the workspace image but not promised on the VM, so the
  #      archive is pushed back into the container and tested there.
  dl_status=$(ssh_cmd "${CURL} -b /tmp/portikus-smoke-alice.jar \
        -D ${ZIP_HEADERS} -o ${ZIP_ON_VM} -w '%{http_code}' \
        '${PROJECTS_URL}/${proj_id}/download'")
  check_output "download returns 200" "200" echo "$dl_status"
  # A failure leaves a JSON error in the body; show it, or the run only
  # says 400 and the reason stays on the VM.
  if [ "$dl_status" != "200" ]; then
    printf '      download body: %s\n' "$(ssh_cmd "head -c 400 ${ZIP_ON_VM}")"
  fi
  check "download is served as application/zip" \
    ssh_cmd "grep -qi 'content-type: application/zip' ${ZIP_HEADERS}"
  check "download is named smoke-renamed.zip" \
    ssh_cmd "grep -qi 'filename=\"smoke-renamed.zip\"' ${ZIP_HEADERS}"
  ssh_cmd "incus file push ${ZIP_ON_VM} ${ws_instance}/tmp/smoke-download.zip --project ${PROJECT}" \
    >/dev/null 2>&1 || true
  check "downloaded archive passes unzip -t" \
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- unzip -t /tmp/smoke-download.zip"

  # 15.5b An image shown inline carries the sandbox policy, so an SVG
  #       opened on its own cannot run script (SPEC.md 24.3).
  alice_student "printf '<svg xmlns=\"http://www.w3.org/2000/svg\"/>' > ${PROJECTS_DIR}/smoke-renamed/smoke.svg" \
    >/dev/null 2>&1 || true
  inline_csp() {
    ssh_cmd "${CURL} -I -b /tmp/portikus-smoke-alice.jar \
          '${PROJECTS_URL}/${proj_id}/file?path=smoke.svg&inline=1'" \
      | grep -qi '^content-security-policy: *sandbox;'
  }
  check "an inline file is served with a sandbox Content-Security-Policy" inline_csp

  # 15.6 Anything Git-enabled under ~/projects becomes a project; a
  #      plain directory does not (plan, Discovery).
  alice_student "mkdir -p ${PROJECTS_DIR}/hand-made && git -C ${PROJECTS_DIR}/hand-made init -q" \
    >/dev/null 2>&1 || true
  alice_student "mkdir -p ${PROJECTS_DIR}/plain-dir" >/dev/null 2>&1 || true
  check_output "a git repository made by hand is discovered" "discovered" \
    active_field hand-made source
  check_output "a plain directory is not a project" "" \
    active_field plain-dir slug

  # 15.7 Archiving hides the project but keeps the directory (SPEC.md 7.4).
  vm_get alice "${PROJECTS_URL}/${proj_id}" \
    "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"state\": \"archived\"}'" >/dev/null
  check_output "archived project leaves the active list" "" \
    active_field smoke-renamed slug
  check_output "archived project is in the archived list" "smoke-renamed" \
    archived_field smoke-renamed slug
  check "archived project keeps its directory" \
    alice_student "test -d ${PROJECTS_DIR}/smoke-renamed"

  vm_get alice "${PROJECTS_URL}/${proj_id}" \
    "-X PATCH -H 'Origin: ${API}' -H 'Content-Type: application/json' \
         -d '{\"state\": \"active\"}'" >/dev/null
  check_output "unarchived project is active again" "smoke-renamed" \
    active_field smoke-renamed slug

  # 15.8 Leave ~/projects as the run found it.  There is no delete route,
  #      so the rows go with the workspace the cleanup function removes.
  if [ -n "$proj_term_id" ]; then
    check_output "DELETE project terminal returns 204" "204" \
      http_status alice "${API}/workspaces/${ws_id}/terminals/${proj_term_id}" \
      "-X DELETE -H 'Origin: ${API}'"
  fi
  alice_student "rm -rf ${PROJECTS_DIR}/smoke-renamed ${PROJECTS_DIR}/hand-made ${PROJECTS_DIR}/plain-dir" \
    >/dev/null 2>&1 || true
  ssh_cmd "rm -f ${ZIP_ON_VM} ${ZIP_HEADERS}" >/dev/null 2>&1 || true
fi
