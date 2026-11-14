#!/usr/bin/env bash
# The Claude Code chat tab's socket, end to end, without a Claude login:
# create a chat tab, attach, receive the snapshot, change the permission
# mode, receive the settings event (SPEC.md 9.7, 10.2).
# Then the same for a Codex chat tab, with no Codex login: attach and receive
# the snapshot, the models, the five modes and settings naming codex
# (SPEC.md 10.8).
# No prompt is sent, so no account is needed; a real turn belongs to the
# pilot.
# Sourced by terminals.sh while alice's workspace is running.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one

echo ""
echo "Chat tab..."

CHAT_PROBE="/tmp/portikus-smoke-chat-probe.mjs"

# The probe (chat-probe.mjs) speaks the browser end of the socket.
ssh_cmd_stdin "cat > ${CHAT_PROBE}" <"${TESTS_DIR}/smoke/chat-probe.mjs"

# new_chat [AGENT] -- creates a chat tab for claude (the default) or codex.
new_chat() {
  vm_get alice "${API}/workspaces/${ws_id}/terminals" \
    "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
          -d '{\"kind\":\"chat\",\"agent\":\"${1:-claude}\"}'"
}

# chat_probe TERMINAL_ID [AGENT] -- prints the probe's lines; the shell checks them.
chat_probe() {
  printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
    | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt ${VM_NODE} ${CHAT_PROBE} \
          'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/terminals/${1}/chat' '${API}' 30000 ${2:-claude}" 2>&1
}

chat_response=$(new_chat)
chat_id=$(echo "$chat_response" | json_field id)
if [ -z "$chat_id" ]; then
  bad "POST /terminals for a chat returned no id: ${chat_response}"
else
  ok "POST /terminals for a chat returned id=${chat_id}"
  expect_eq "the new tab is a chat" "chat" "$(echo "$chat_response" | json_field kind)"
  check "tmux session pk-<id> runs the chat host" tmux_has_session "$chat_id"

  # tmux starts the host asynchronously; it makes the directory and listens a moment later.
  chat_socket_ready() {
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- test -S /run/portikus-terminals/chat/pk-${chat_id}.sock"
  }
  for _ in $(seq 1 30); do
    chat_socket_ready && break
    sleep 1
  done

  # The host's socket lives under the terminals unit's kept directory, so it
  # survives an agent restart; only the student may enter it.
  check_output "the chat socket directory is the student's, mode 700" "700 student" \
    ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- stat -c '%a %U' /run/portikus-terminals/chat"

  chat_lines=$(chat_probe "$chat_id") || true
  expect_eq "the chat socket sends the snapshot first" "snapshot" "$(head -n 1 <<<"$chat_lines")"
  expect_eq "set {mode: plan} comes back as a settings event" "settings-plan" \
    "$(grep -x settings-plan <<<"$chat_lines")"

  check_output "DELETE chat returns 204" "204" \
    http_status alice "${API}/workspaces/${ws_id}/terminals/${chat_id}" \
    "-X DELETE -H 'Origin: ${API}'"
  check "chat's tmux session is gone after delete" tmux_lacks_session "$chat_id"
fi
# The Codex chat tab. The host starts and sends these frames without a Codex
# sign-in, so the missing one on this VM must not fail the check.
codex_binary_present() {
  ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- test -x /opt/portikus/coding-agents/bin/codex"
}

if ! codex_binary_present; then
  skip "Codex chat tab (no Codex binary in the shared coding-agents folder)"
else
  codex_response=$(new_chat codex)
  codex_id=$(echo "$codex_response" | json_field id)
  if [ -z "$codex_id" ]; then
    bad "POST /terminals for a Codex chat returned no id: ${codex_response}"
  else
    ok "POST /terminals for a Codex chat returned id=${codex_id}"
    expect_eq "the new tab is a chat" "chat" "$(echo "$codex_response" | json_field kind)"
    expect_eq "the new tab is a Codex chat" "codex" "$(echo "$codex_response" | json_field agent)"
    check "tmux session pk-<id> runs the Codex chat host" tmux_has_session "$codex_id"

    codex_socket_ready() {
      ssh_cmd "incus exec ${ws_instance} --project ${PROJECT} -- test -S /run/portikus-terminals/chat/pk-${codex_id}.sock"
    }
    for _ in $(seq 1 30); do
      codex_socket_ready && break
      sleep 1
    done

    codex_lines=$(chat_probe "$codex_id" codex) || true
    expect_eq "the Codex chat socket sends the snapshot first" "snapshot" "$(head -n 1 <<<"$codex_lines")"
    expect_eq "the Codex chat sends its models" "models" "$(grep -x models <<<"$codex_lines")"
    expect_eq "the Codex chat sends its five modes" "modes-5" "$(grep -x modes-5 <<<"$codex_lines")"
    expect_eq "the Codex chat's settings name codex" "settings-codex" \
      "$(grep -x settings-codex <<<"$codex_lines")"

    check_output "DELETE Codex chat returns 204" "204" \
      http_status alice "${API}/workspaces/${ws_id}/terminals/${codex_id}" \
      "-X DELETE -H 'Origin: ${API}'"
    check "Codex chat's tmux session is gone after delete" tmux_lacks_session "$codex_id"
  fi
fi
ssh_cmd "rm -f ${CHAT_PROBE}" >/dev/null 2>&1 || true
