# 0051. Administrators get a root shell in the admin area

- **Status**: Accepted (Epic 35)
- **Date**: 2026-10-05
- **References**: SPEC.md sections 20.3, 24.1, 24.11, 24.13; ADRs 0012, 0030, 0044, 0052; issue #1063

## Context

Administrators want a root shell on the server from the admin page,
without SSH (Secure Shell). Issue #1063 listed hard requirements for
this: a second factor or a code enrolled on the host, a password
prompt, per-shell limits, idle timeouts and address restrictions.
Todd's rulings of 2026-10-05 override those requirements. What #1063
asked for and is kept: a privileged helper outside the API (the API
never runs as root), audit rows for open, close and duration but never
contents, journal lines from the helper, and a banner.

## Decision

1. **On by default.** Every signed-in administrator can open a root
   shell. There is no step-up check, no password prompt, no address
   restriction and no per-shell or site-wide limit. An operator turns
   the feature off with `portikus_root_shell: false` in `portikus.yaml`.
   Setup then runs `systemctl disable --now` on the socket, stops every
   helper instance, ends the logind sessions led by the `login`
   processes the helper started (`loginctl terminate-session`), and
   leaves `ROOT_SHELL_SOCKET` empty in `api.env`, and the web
   app hides the tab. The helper records the process id of each
   `login` child it starts in its journal line and in one file per
   shell under `/run/portikus-root-shell/`, removed when the shell
   closes; setup reads those files to find the sessions. The package's `prerm` script also stops the socket
   and its instances. An upgrade turns the feature on for existing
   sites.
2. **A helper outside the API.** The API never runs as root. A
   per-connection root helper, `portikus-root-shell@.service` (Python
   standard library), sits behind `/run/portikus-root-shell.sock`, with
   `Accept=yes`, `RemoveOnStop=yes`, mode 0660 and `SocketGroup=` set to
   a dedicated group, `portikus-root-shell`. Only `portikus-api.service`
   joins that group, through `SupplementaryGroups=`, as ADR 0036 does
   for `systemd-journal`. The helper also reads the peer's credentials
   (`SO_PEERCRED`) and refuses any user other than `portikus`. The
   worker cannot connect.

   The helper unit has no sandboxing, no `RuntimeMaxSec`,
   `CollectMode=inactive-or-failed` and `Environment=TERM=xterm-256color`.
   It deliberately does not copy the backup-key unit's hardening: the
   shell inherits the unit's mount namespace, `NoNewPrivileges`, seccomp
   filter, capability set and `PrivateTmp`, and a root shell must be an
   ordinary root shell.
3. **Transport.** Each pane is its own browser WebSocket to the API,
   its own connection to the socket and its own helper instance. On the
   socket, each frame is a 1-byte type and a 4-byte big-endian length,
   then the body. The types are `open` (JSON `{shellId, actorId,
   actorName, address, cols, rows}`, no secret), `input` (bytes),
   `resize` (JSON `{cols, rows}`), `output` (bytes), `exit` (JSON
   `{status}`), `error` (JSON `{code}`) and `end` (API to helper, JSON
   `{reason}`, described in decision 5). The API translates these to
   and from the browser frames of SPEC.md section 9.7, so the browser's
   frame decoder is unchanged. Browser frames keep section 9.7's caps.
   There is no reconnect and no platform tmux: closing the socket ends
   the shell.

   The helper enforces these limits:
   - Each type has a size cap, checked against the length before the
     body is read: `open` 4 KiB, `resize` 64 bytes, `end` 64 bytes, `input` 64 KiB.
   - The first frame must be `open`, and `open` comes only once. An
     unknown type closes the connection.
   - `cols` and `rows` are integers from 1 to 1000.
   - `address` is checked with Python's `ipaddress` module and passed to
     `login` as the single `-h` argument, never through a shell.
   - `shellId` and `actorId` are UUIDs.
   - `actorName` never goes into a process argument, utmp, or a raw log
     line, because a newline in it could forge journal lines.
   - No environment variable comes from a frame, and `login` never gets
     `-p`.
4. **A real sign-in session.** The helper runs
   `login -f root -h <address>` on a pseudo-terminal (PTY), with the
   PTY's terminal end as descriptors 0, 1 and 2 (`pty.fork` or
   `os.login_tty`) and no other inherited descriptor. That makes a PAM
   (Pluggable Authentication Modules) session that behaves like SSH: a
   logind scope, entries in `who`, `last` and wtmp, and PAM's own
   journal line. Closing the socket sends the shell SIGHUP, and a tmux
   the administrator started survives. The helper's own standard error
   carries only fixed codes, never exception text, so nothing the shell
   writes reaches the helper's journal; the real-host check proves this
   with `journalctl -u 'portikus-root-shell@*'`.
5. **When a shell ends.** On socket close, on shell exit, or when the
   API's once-a-second re-check fails. A shell continues only while
   `loadSession` returns a session, `sessionGate` returns nothing, and
   the session's role is `administrator`. So sign-out, demotion, a
   disabled account and the 12-hour limit on provider roles each end
   it. The workspace terminal re-check ignores role, so the root-shell
   pipe adds that check. If the re-check cannot run because the
   database fails, the shell ends after about 60 consecutive failed
   checks; do database maintenance inside tmux.

   On any end the API first closes the helper connection, then drops
   all further browser input and calls `terminate()` on the browser
   socket. It does not call `close()`, because the WebSocket close
   handshake can take 30 seconds and keeps delivering input meanwhile.
   When the reason is `session_ended` (revocation: sign-out, role loss,
   a disabled account, the 12-hour limit, or the failed database
   re-check), the API sends an `end` frame before closing the helper
   connection. On `end`, and only then, the helper ends that shell's
   logind session, found from the process id of the `login` child it
   started. Every other close only hangs up (SIGHUP), so an
   administrator's own tmux survives an ordinary pane close. Processes
   that deliberately escape the logind session (for example with
   `setsid nohup`) are ended only by the off switch; the operations
   guide says so.

   Two flood guards stay: root-shell sockets count toward the 60
   terminal sockets per user (SPEC.md section 24.13), and systemd's
   default of 64 connections on the socket.
6. **Records.** The API generates a shell id for each shell. It writes
   the audit row `admin.root_shell_opened` (shell id, address and user
   agent) first, and refuses the shell if that write fails. It then
   sends the shell id in the `open` frame. On close it writes
   `admin.root_shell_closed` (shell id, `durationSeconds` and a reason:
   `exit`, `client`, `session_ended` or `api_stopped`). The helper's
   journal lines (shell id, actor id, address, process id, duration) and
   PAM's lines record each shell too. If the API crashes, an opened row
   has no closed row, and the journal line is then the record. A banner
   in the shell and a fixed strip on the page say that nothing typed is
   recorded and that opening and closing are audited. Nothing typed or
   shown is ever recorded (ADR 0012).
7. **Optional alert on open.** When the `rootShellOpenedAlert` setting
   in `notify.json` is on (ADR 0052), the API sends every administrator a
   warning-tone site alert, "Root shell opened by <name>", through the
   existing forwarding. The setting is off by default, and the helper
   never sends an alert of its own.

## Accepted risk

A stolen administrator session, an XSS (cross-site scripting) bug in the
Portikus web app, or a compromised API process each now equals root on
the host. XSS here includes injection from any content an administrator
views: student display names, project and file names in admin tables,
the Logs and Audit tabs, and the administrator's own workspace, where
coding agents run untrusted code. Root on the host means every student's files, the database, the signing,
backup and second-factor keys, and Incus. The remaining barriers are the
session rules, the WebSocket origin check, the content security policy
`script-src 'self'`, the second-factor gate at sign-in for Dex-password
accounts, and the 12-hour provider-role limit. A compromised API can
turn the open alert off or open shells without it. That changes
nothing, because a compromised API is already root through the socket,
and the helper's and PAM's journal lines still record each shell. Todd
accepts this risk for in-browser administration.

## Consequences

- Anything that restarts the API ends every root shell, including the
  one that ran it: `apt upgrade portikus` or
  `systemctl restart portikus-api` typed in a root shell would cut dpkg
  off midway. Run upgrades inside tmux. A Caddy reload also closes root
  shells older than one hour, as it does workspace terminals.
- Reloading the page or leaving the admin area ends the shells. No
  layout is saved.

## Rejected

- Cockpit, or SSH only: Todd chose administration inside Portikus.
- A second factor or a code enrolled on the host: ruled out, and
  inconsistent for SSO administrators, who have no Portikus password.
- Address ranges, an idle timeout and a hard time cap: ruled out.
- A Node helper with node-pty: a native module running as root, and
  heavier per pane.
- One root daemon serving every shell: shared state and a larger blast
  radius.
- D-Bus or polkit calls from the API (`systemd-run --pty`): rejected in
  ADR 0030.
- Plain bash in the service's cgroup: closing a pane would kill the
  administrator's own tmux.
