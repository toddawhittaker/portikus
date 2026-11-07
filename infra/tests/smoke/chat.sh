#!/usr/bin/env bash
# The Claude Code chat tab's socket, end to end, without a Claude login:
# create a chat tab, attach, receive the snapshot, change the permission
# mode, receive the settings event (SPEC.md 9.7, 10.2; docs/EPIC-58.md).
# No prompt is sent, so no Claude account is needed; a real turn belongs to
# the rehearsal.
# Sourced by terminals.sh while alice's workspace is running.
# shellcheck disable=SC2154  # set by smoke-test.sh and the files sourced before this one

echo ""
echo "Chat tab..."

CHAT_PROBE="/tmp/portikus-smoke-chat-probe.mjs"

# The probe (chat-probe.mjs) speaks the browser end of the socket.
ssh_cmd_stdin "cat > ${CHAT_PROBE}" <"${TESTS_DIR}/smoke/chat-probe.mjs"

new_chat() {
  vm_get alice "${API}/workspaces/${ws_id}/terminals" \
    "-X POST -H 'Origin: ${API}' -H 'Content-Type: application/json' \
          -d '{\"kind\":\"chat\",\"agent\":\"claude\"}'"
}

# chat_probe TERMINAL_ID -- prints the probe's lines; the shell checks them.
chat_probe() {
  printf '%s=%s' "${SESSION_COOKIE_NAME}" "${alice_cookie}" \
    | ssh_cmd_stdin "NODE_EXTRA_CA_CERTS=/etc/portikus/caddy-root.crt ${VM_NODE} ${CHAT_PROBE} \
          'wss://${PUBLIC_AUTHORITY}/workspaces/${ws_id}/terminals/${1}/chat' '${API}' 30000" 2>&1
}

chat_response=$(new_chat)
chat_id=$(echo "$chat_response" | json_field id)
if [ -z "$chat_id" ]; then
  bad "POST /terminals for a chat returned no id: ${chat_response}"
else
  ok "POST /terminals for a chat returned id=${chat_id}"
  expect_eq "the new tab is a chat" "chat" "$(echo "$chat_response" | json_field kind)"
  check "tmux session pk-<id> runs the chat host" tmux_has_session "$chat_id"

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
ssh_cmd "rm -f ${CHAT_PROBE}" >/dev/null 2>&1 || true
