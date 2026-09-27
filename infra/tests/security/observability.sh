#!/usr/bin/env bash
# The admin Logs tab and Health series (docs/adr/0036; SPEC.md 24.11 and 25.6).
#
# Sourced by infra/tests/security-test.sh.  Only administrators read the
# logs and the series; only the API process may read the journal; the
# journalctl on the VM supports what the reader asks of it; and a line that
# holds a credential is shown redacted.  It writes one probe line into the
# API's journal, marked with this run's id.
# shellcheck disable=SC2154  # pass, fail and the SEC_ globals come from lib.sh

echo ""
echo "--- Admin logs and health series ---"

# ── Who may read (ADR 0036) ──────────────────────────────────────
for obs_path in "/admin/logs" "/admin/logs/counts?range=1h" "/admin/health/series?range=1h"; do
  check_output "a student gets 403 on ${obs_path%%\?*}" "403" sec_http a GET "$obs_path"
  check_output "anonymous gets 401 on ${obs_path%%\?*}" "401" sec_http - GET "$obs_path"
done
check_output "the administrator reads /admin/logs (control)" "200" sec_http admin GET "/admin/logs"

# ── Who may read the journal ─────────────────────────────────────
obs_gid=$(sec_ssh "getent group systemd-journal | cut -d: -f3")

# obs_groups UNIT -- the supplementary group ids of the unit's main process.
obs_groups() {
  sec_ssh "pid=\$(systemctl show -p MainPID --value $1); test \"\$pid\" -gt 0 && awk '/^Groups:/ { \$1 = \"\"; print }' /proc/\$pid/status"
}
obs_has_journal_group() { obs_groups "$1" | tr ' ' '\n' | grep -qx "$obs_gid"; }
obs_lacks_journal_group() {
  local groups
  groups=$(obs_groups "$1") || return 1
  ! printf '%s\n' "$groups" | tr ' ' '\n' | grep -qx "$obs_gid"
}
check "the systemd-journal group exists" test -n "$obs_gid"
check "the API process has the systemd-journal group" obs_has_journal_group portikus-api
check "the worker process does not have the systemd-journal group" obs_lacks_journal_group portikus-worker
# The group comes from the API's unit only, never from the portikus user.
check_output "the portikus user alone reads no API journal line" "0" \
  sec_ssh "sudo -u portikus journalctl --unit=portikus-api.service -n 5 --no-pager -o cat 2>/dev/null | wc -l"

# ── What journalctl on this VM supports (ADR 0036) ───────────────
# The reader filters levels with --grep, which needs journalctl built with PCRE2.
check "journalctl --grep matches the API's warn lines" \
  sec_ssh "sudo journalctl --unit=portikus-api.service --grep='\"level\":\"(warn)\"' -n 1 --no-pager -o cat | grep -q '\"level\":\"warn\"'"
# Older pages continue with --reverse and --after-cursor: after the newest
# entry's cursor comes the second newest.
obs_reverse_after_cursor() {
  sec_ssh "sudo python3 -c '
import json, subprocess
base = [\"journalctl\", \"--unit=portikus-api.service\", \"--output=json\", \"--no-pager\", \"--reverse\"]
two = [json.loads(l)[\"__CURSOR\"] for l in subprocess.run(base + [\"-n\", \"2\"], capture_output=True, text=True, check=True).stdout.splitlines()]
after = subprocess.run(base + [\"-n\", \"1\", \"--after-cursor=\" + two[0]], capture_output=True, text=True, check=True).stdout.splitlines()
raise SystemExit(0 if len(two) == 2 and [json.loads(l)[\"__CURSOR\"] for l in after] == [two[1]] else 1)
'"
}
check "journalctl --reverse --after-cursor continues with older entries" obs_reverse_after_cursor

# The same paging through the API: page two is older than page one and shares no line.
obs_pages_are_ordered() {
  local first second cursor
  sec_http admin GET "/admin/logs?level=info&service=api" >/dev/null || return 1
  first=$(cat "$SEC_LAST_BODY")
  cursor=$(printf '%s' "$first" | python3 -c 'import json, sys; print(json.load(sys.stdin)["nextCursor"] or "")')
  [ -n "$cursor" ] || return 1
  sec_http admin GET "/admin/logs?level=info&service=api&cursor=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$cursor")" >/dev/null || return 1
  second=$(cat "$SEC_LAST_BODY")
  python3 - "$first" "$second" <<'PY'
import json, sys
a, b = (json.loads(x)["lines"] for x in sys.argv[1:3])
ok = a and b and max(l["at"] for l in b) <= min(l["at"] for l in a) \
    and not {l["cursor"] for l in a} & {l["cursor"] for l in b}
raise SystemExit(0 if ok else 1)
PY
}
check "the Logs tab's second page is older than the first and shares no line" obs_pages_are_ordered

# ── Redaction (ADR 0036) ─────────────────────────────────────────
# A line in the API's own journal carrying a bearer token, a cookie, a token
# field and a URL with a password.  journald names the unit from the sending
# process's cgroup, so the writer joins the API's cgroup first, and stays
# alive a moment: journald drops the unit of a sender that already exited.
obs_probe="sectest-${SEC_RUN_ID}-redaction"
obs_secret="SECPROBE${SEC_RUN_ID}"
obs_line=$(printf '{"level":"warn","time":"%s","service":"api","msg":"%s","headers":{"authorization":"Bearer %s-auth","cookie":"portikus_session=%s-cookie"},"token":"%s-token","note":"sent Bearer %s-inline","url":"https://sectest:%s-password@example.invalid/x"}' \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$obs_probe" "$obs_secret" "$obs_secret" "$obs_secret" "$obs_secret" "$obs_secret")
printf '%s\n' "$obs_line" | sec_ssh_stdin "sudo sh -c 'echo \$\$ > /sys/fs/cgroup/system.slice/portikus-api.service/cgroup.procs && { cat; sleep 2; } | systemd-cat --identifier=portikus-api'" >/dev/null 2>&1

obs_probe_page() {
  local _
  for _ in 1 2 3 4 5; do
    sec_http admin GET "/admin/logs?level=warn&service=api&q=${obs_probe}" >/dev/null
    if python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1]))["lines"] else 1)' "$SEC_LAST_BODY" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
if obs_probe_page; then
  sec_pass "the Logs tab shows the probe line from the API's journal"
  check_output "the probe line shows no bearer token, cookie, token or password" "0" \
    grep -c "$obs_secret" "$SEC_LAST_BODY"
  check_output "the probe line's credentials are replaced by [redacted]" "5" \
    python3 -c '
import json, sys
line = json.load(open(sys.argv[1]))["lines"][0]["line"]
text = json.dumps(line)
print(text.count("[redacted]"))' "$SEC_LAST_BODY"
else
  sec_fail "the Logs tab shows the probe line from the API's journal"
fi

# No session cookie of this run appears anywhere on the first pages of every level.
obs_no_cookie_values() {
  local key value
  sec_http admin GET "/admin/logs?level=error,warn,info,debug" >/dev/null || return 1
  for key in a b admin; do
    value=$(cut -d= -f2- "${SEC_LOCAL_DIR}/${key}.cookie")
    [ -n "$value" ] || return 1
    ! grep -qF "$value" "$SEC_LAST_BODY" || return 1
  done
}
check "no session cookie of this run appears in the Logs tab" obs_no_cookie_values
