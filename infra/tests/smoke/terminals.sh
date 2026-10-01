#!/usr/bin/env bash
# Terminals in alice's workspace: the socket, tmux, reattach, presence,
# and the agent's reachability.
# Sourced by infra/tests/smoke-test.sh, which sets the globals and helpers used here.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one
# shellcheck disable=SC2034  # read by the files sourced after this one

# 14. The terminal transport end to end (SPEC.md 9.7, ADR 0009).
#     The workspace must be running, so this block opens the presence
#     socket again and later hands the workspace over to a terminal
#     socket to prove a terminal counts as presence on its own.
echo ""
echo "Terminal transport..."
open_socket
ws_state=$(wait_for_state running 60)

# The probe speaks the browser end of the pipe: it sends one line of
# input, then reads frames until the marker appears.  A carriage
# return is appended here so the shell runs the line.
ssh_cmd_stdin "cat > ${TERM_PROBE}" <<'TERMPROBE'
import fs from "node:fs";
// url, origin, input ("-" for none), marker ("-" for none),
// stop file ("-" for none), timeout in milliseconds.
const [url, origin, input, marker, stopFile, timeoutMs] = process.argv.slice(2);
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
ws.binaryType = "arraybuffer";
let screen = "";
let found = marker === "-";
// Wait for a frame of output before sending input. The first frame is now
// the agent's replay of the pane's history, not tmux's own drawing, so this
// no longer proves tmux is ready; what makes the input safe is the agent's
// queue, which holds it until tmux has drawn something.
let sent = input === "-";
function sendInput() {
	if (sent) return;
	sent = true;
	ws.send(JSON.stringify({ type: "input", data: `${input}\r` }));
}
// Fall back after a bounded wait in case the terminal prints nothing.
const sendTimer = setTimeout(sendInput, 5000);
ws.addEventListener("message", (event) => {
	clearTimeout(sendTimer);
	sendInput();
	screen +=
		typeof event.data === "string"
			? event.data
			: Buffer.from(event.data).toString("utf8");
	if (!found && screen.includes(marker)) {
		found = true;
		if (stopFile === "-") ws.close();
	}
});
ws.addEventListener("error", (event) => {
	console.error("socket error", event.message ?? "");
	process.exit(1);
});
ws.addEventListener("close", () => process.exit(found ? 0 : 1));
const poll =
	stopFile === "-"
		? null
		: setInterval(() => {
				if (fs.existsSync(stopFile)) ws.close();
			}, 500);
setTimeout(() => {
	if (poll) clearInterval(poll);
	clearTimeout(sendTimer);
	ws.close();
}, Number(timeoutMs));
TERMPROBE

# term_probe TERMINAL_ID INPUT MARKER STOP_FILE TIMEOUT_MS
term_probe() {
  printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
    | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt ${VM_NODE} ${TERM_PROBE} \
          'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/terminals/${1}/ws' '${API}' \
          '${2}' '${3}' '${4}' '${5}'"
}

# The tmux sessions the student user can see inside the workspace.
tmux_has_session() {
  ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'tmux -L portikus -N list-sessions -F \"#{session_name}\"'" 2>/dev/null \
    | grep -qx "pk-$1"
}
tmux_lacks_session() { ! tmux_has_session "$1"; }

# A browser navigating to the workspace page must get the bundle, while
# the JSON routes under the same prefix still answer as the API.
workspace_page_is_bundle() {
  vm_get alice "${API}/workspaces/${ws_id}" \
    "-H 'Sec-Fetch-Dest: document' -H 'Accept: text/html'" | grep -q '<div id="root">'
}
terminal_list_is_json() {
  vm_get alice "${API}/workspaces/${ws_id}/terminals" | grep -q '"terminals"'
}

new_terminal() {
  vm_get alice "${API}/workspaces/${ws_id}/terminals" \
    "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' -d '{}'"
}

term_response=$(new_terminal)
term_id=$(echo "$term_response" | json_field id)

if [ -z "$term_id" ]; then
  bad "POST /terminals returned no id: ${term_response}"
else
  ok "POST /terminals returned id=${term_id}"

  check "tmux session pk-<id> runs in the workspace" tmux_has_session "$term_id"

  # A terminal carries what the shell prints back over the socket.
  # The marker is typed in two quoted halves, so it only appears whole
  # in the command's output and never in the echo of the typing.
  mark_a="MARK-${RANDOM}"
  mark_b="${RANDOM}"
  mark="${mark_a}${mark_b}"
  check "terminal socket carries input and output" \
    term_probe "$term_id" "echo ${mark_a}\"${mark_b}\"" "$mark" - 30000
  # Terminal bytes never reach a platform log, so the Logs tab cannot
  # show them (ADR 0012, docs/adr/0036).
  check_zero_lines "the terminal's output is in no platform journal" \
    ssh_cmd "sudo journalctl -u portikus-api -u portikus-worker -u portikus-controller --since '10 min ago' --no-pager -o cat | grep -F '${mark}'"
  logs_count_mark() {
    vm_get carol "${API}/admin/logs?level=error,warn,info,debug&q=${mark_a}" \
      | python3 -c 'import json, sys; print(len(json.load(sys.stdin)["lines"]))'
  }
  check_output "the Logs tab finds no line with the terminal's input or output" "0" logs_count_mark

  # Every login shell reads /etc/profile.d/portikus.sh, which the
  # controller writes at start, so a terminal knows the preview suffix
  # (issue #263).  The typed command holds only the variable name, so the
  # suffix can only appear once the shell has expanded it.
  # shellcheck disable=SC2016  # the shell inside the workspace expands it
  check "terminal shell knows the preview host suffix" \
    term_probe "$term_id" 'echo $PORTIKUS_PREVIEW_HOST_SUFFIX' \
    "$PREVIEW_SUFFIX" - 30000

  # The workspace runs in the deployment's default zone unless the
  # student picked another (issue #287). The typed command holds only
  # the variable name, so the zone can only appear once the shell has
  # expanded it.
  # shellcheck disable=SC2016  # the shell inside the workspace expands it
  check "terminal shell runs in the default timezone" \
    term_probe "$term_id" 'echo $TZ' "America/New_York" - 30000

  # The controller writes both agents' system instructions from the
  # package's template at every start (issue #933). The agent tree is
  # bind-mounted, so the template is visible inside the workspace.
  check "Claude Code's system instructions are the package template" \
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- sh -c 'cmp -s /opt/portikus/workspace-agent/agent-instructions.md /etc/claude-code/CLAUDE.md && [ \"\$(stat -c %U:%a /etc/claude-code/CLAUDE.md)\" = root:644 ]'"
  check "Codex's prompt carries the platform instructions" \
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'cd /tmp && codex debug prompt-input hi' | grep -q portikus-open"

  # A student who changes the zone gets it in the next terminal they
  # open, without restarting the workspace: the agent puts TZ in the new
  # tmux session's environment (issue #287).  The abbreviation is worked
  # out on the VM so the check does not hard-code daylight saving.
  chosen_zone="America/Los_Angeles"
  chosen_abbrev=$(ssh_cmd "TZ=${chosen_zone} date +%Z")
  # The answer carries the whole list of zone names as well as the
  # settings, and that list always holds the chosen zone, so the check
  # looks for the settings field rather than the bare name.
  set_zone() {
    vm_get alice "${API}/me/settings" \
      "-X PUT -H 'Origin: ${API}' -H 'Content-Type: application/json' \
            -d '{\"timezone\":\"${chosen_zone}\"}'" \
      | grep -q "\"timezone\":\"${chosen_zone}\""
  }
  check "a student can change the workspace timezone" set_zone

  zone_term_id=$(new_terminal | json_field id)
  if [ -z "$zone_term_id" ]; then
    bad "POST /terminals for the zone check returned no id"
  else
    check "a terminal opened after the change runs in the chosen zone" \
      term_probe "$zone_term_id" "date +%Z" "$chosen_abbrev" - 30000
  fi

  # Reattaching inside the grace period redraws the same tmux screen,
  # so the marker written a moment ago is still on it (SPEC.md 9.2).
  check "reattached terminal shows the earlier output" \
    term_probe "$term_id" - "$mark" - 20000

  # Two sockets share one tmux session, so output caused by one
  # reaches the other (SPEC.md 9.5).
  mark2_a="MARK-${RANDOM}"
  mark2_b="${RANDOM}"
  mark2="${mark2_a}${mark2_b}"
  term_probe "$term_id" - "$mark2" - 30000 >/dev/null 2>&1 &
  watcher_pid=$!
  sleep 3
  term_probe "$term_id" "echo ${mark2_a}\"${mark2_b}\"" "$mark2" - 30000 >/dev/null 2>&1
  check "second socket on the same terminal sees new output" wait "$watcher_pid"

  # The tmux server lives in its own unit, so an agent restart keeps the
  # terminal and reattaching replays it (issue #610).
  echo ""
  echo "Restarting the workspace agent..."
  in_ws() { ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- $*"; }
  agent_listening() {
    local i
    for ((i = 0; i < 30; i++)); do
      in_ws "ss -Hltn sport = :7400" 2>/dev/null | grep -q . && return 0
      sleep 1
    done
    return 1
  }
  in_ws systemctl restart portikus-workspace-agent >/dev/null 2>&1
  check "the agent listens again after a restart" agent_listening
  check "the terminal's tmux session survived the agent restart" tmux_has_session "$term_id"
  check "reattaching after the agent restart replays the terminal" \
    term_probe "$term_id" - "$mark2" - 30000

  # A tutorial's tmux kill-server reaches the student's own tmux, not
  # the Portikus server, because the shell has no TMUX (issue #620).
  kill_a="KILL-${RANDOM}"
  kill_b="${RANDOM}"
  check "tmux kill-server typed in a terminal runs" \
    term_probe "$term_id" "tmux kill-server; echo ${kill_a}\"${kill_b}\"" "${kill_a}${kill_b}" - 30000
  check "the terminal's tmux session survived tmux kill-server" tmux_has_session "$term_id"

  # A broken ~/.tmux.conf and a ~/.bashrc that exits still let a new
  # terminal open; the shell skips the .bashrc and says so (issue #620).
  in_ws su -l student -c "'cp ~/.bashrc ~/.bashrc.smoke && echo exit >> ~/.bashrc \
        && echo \"set -g default-command exit\" > ~/.tmux.conf'" >/dev/null 2>&1
  broken_id=$(new_terminal | json_field id)
  if [ -z "$broken_id" ]; then
    bad "POST /terminals with a broken ~/.bashrc returned no id"
  else
    broken_a="BASHRC-${RANDOM}"
    broken_b="${RANDOM}"
    check "a terminal opens with a broken ~/.bashrc and says it skipped it" \
      term_probe "$broken_id" - "made the shell exit" - 30000
    check "that terminal's shell runs commands" \
      term_probe "$broken_id" "echo ${broken_a}\"${broken_b}\"" "${broken_a}${broken_b}" - 30000
    http_status alice "${API}/workspaces/${ws_id}/terminals/${broken_id}" \
      "-X DELETE -H 'Origin: ${API}'" >/dev/null
  fi
  in_ws su -l student -c "'mv ~/.bashrc.smoke ~/.bashrc; rm -f ~/.tmux.conf'" >/dev/null 2>&1

  # A terminal socket counts as presence on its own (SPEC.md 6.4):
  # hold one open, drop the presence socket, and the workspace stays up.
  echo ""
  echo "Checking that a terminal socket alone keeps the workspace up..."
  ssh_cmd "rm -f ${TERM_STOP}"
  term_probe "$term_id" - - "${TERM_STOP}" 120000 >/dev/null 2>&1 &
  term_hold_pid=$!
  sleep 3
  close_socket
  check_output "terminal socket is the only connection row" "1" connection_count
  check_output "terminal socket keeps the deadline clear" "null" workspace_deadline
  sleep 25
  check_output "still running 25s on the terminal socket alone" "running" workspace_state
  ssh_cmd "touch ${TERM_STOP}"
  wait "$term_hold_pid" || true
  sleep 2

  # The agent answers only with the per-workspace token, and only to
  # the VM: peers on the bridge are cut off (SPEC.md 23.3, 23.5).
  echo ""
  echo "Checking agent reachability..."
  agent_ip=$(workspace_ip "${ws_instance}")
  agent_token=$(ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT agent_token FROM workspaces WHERE id = '${ws_id}'\"" 2>/dev/null || true)
  if [ -n "$agent_ip" ] && [ -n "$agent_token" ]; then
    check_output "agent /health without a token is 401" "401" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${agent_ip}:7400/health"
    check_output "agent /health with the workspace token is 200" "200" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Authorization: Bearer ${agent_token}' http://${agent_ip}:7400/health"
  else
    bad "no agent address or token for the workspace"
  fi

  if [ -n "${WS_NAME:-}" ] && [ -n "$agent_ip" ]; then
    check "another workspace cannot reach the agent" \
      ws_exec "! curl -s --max-time 5 -o /dev/null http://${agent_ip}:7400/health"
  fi

  # The preview gateway has to open the student's own application port,
  # and only the VM may do it (BROWSER-HANDLING 10 and 16.3). A throwaway
  # listener on a port nothing else uses proves both halves.
  if [ -n "$agent_ip" ]; then
    echo ""
    echo "Checking application-port reachability..."
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- su -l student -c 'setsid nohup python3 -m http.server 8111 --bind 0.0.0.0 >/dev/null 2>&1 < /dev/null &'" >/dev/null 2>&1 || true
    sleep 2
    check_output "the VM can reach an application port in the workspace" "200" \
      ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${agent_ip}:8111/"
    if [ -n "${WS_NAME:-}" ]; then
      check "another workspace cannot reach that port" \
        ws_exec "! curl -s --max-time 5 -o /dev/null http://${agent_ip}:8111/"
    fi
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- pkill -f 'http.server 8111'" >/dev/null 2>&1 || true
  fi

  check "workspace page serves the web bundle to a browser" workspace_page_is_bundle
  check "terminal list under the same prefix is still JSON" terminal_list_is_json

  # Deleting a terminal ends its tmux session (SPEC.md 9.3).
  echo ""
  echo "Deleting the terminal..."
  check_output "DELETE terminal returns 204" "204" \
    http_status alice "${API}/workspaces/${ws_id}/terminals/${term_id}" \
    "-X DELETE -H 'Origin: ${API}'"
  check "tmux session is gone after delete" tmux_lacks_session "$term_id"

  # A terminal still open when the workspace stops is marked ended by
  # the worker (SPEC.md 9.7).
  second_id=$(new_terminal | json_field id)
  http_status alice "${API}/workspaces/${ws_id}/stop" "-X POST -H 'Origin: ${API}'" >/dev/null
  wait_for_state stopped 60 >/dev/null
  if [ -n "$second_id" ]; then
    check "open terminal is marked ended when the workspace stops" \
      ssh_cmd "sudo -u postgres psql -t -A -d portikus -c \"SELECT ended_at IS NOT NULL FROM terminals WHERE id = '${second_id}'\" | grep -qx t"
  else
    bad "second POST /terminals returned no id"
  fi
fi
