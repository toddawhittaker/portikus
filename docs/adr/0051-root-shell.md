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
   Setup then disables the socket, stops running shells and leaves
   `ROOT_SHELL_SOCKET` empty in `api.env`, and the web app hides the
   tab. An upgrade turns the feature on for existing sites.
2. **A helper outside the API.** The API never runs as root. A
   per-connection root helper, `portikus-root-shell@.service` (Python
   standard library), sits behind `/run/portikus-root-shell.sock`,
   owned `root:portikus` with mode 0660, `Accept=yes` and
   `RemoveOnStop=yes`. The helper checks nothing beyond those file
   permissions. The worker runs as `portikus-worker`, which is not in
   the `portikus` group, so it cannot connect.
3. **Transport.** Each pane is its own browser WebSocket to the API,
   its own connection to the socket and its own helper instance. On the
   socket, each frame is a 1-byte type and a 4-byte big-endian length,
   then the body. The types are `open` (JSON `{actorId, actorName,
   address, cols, rows}`, no secret), `input` (bytes), `resize` (JSON
   `{cols, rows}`), `output` (bytes), `exit` (JSON `{status}`) and
   `error` (JSON `{code}`). The API translates these to and from the
   browser frames of SPEC.md section 9.7, so the browser's frame decoder
   is unchanged. Size caps are those of section 9.7: 64 KiB for an input
   frame and 1 MiB for any browser frame. There is no reconnect and no
   platform tmux: closing the socket ends the shell.
4. **A real sign-in session.** The helper runs
   `login -f root -h <address>` on a pseudo-terminal (PTY). That makes
   a PAM (Pluggable Authentication Modules) session that behaves like
   SSH: a logind scope, entries in `who`, `last` and wtmp, and PAM's own
   journal line. Closing the socket sends the shell SIGHUP, and a tmux
   the administrator started survives.
5. **When a shell ends.** On socket close, on shell exit, or when the
   API's once-a-second session re-check finds the session gone: sign-out,
   role loss, a disabled account, or the 12-hour limit on provider
   roles. Two flood guards stay: root-shell sockets count toward the 60
   terminal sockets per user (SPEC.md section 24.13), and systemd's
   default of 64 connections on the socket.
6. **Records.** Audit rows `admin.root_shell_opened` (address and user
   agent) and `admin.root_shell_closed` (`durationSeconds` and a reason:
   `exit`, `client`, `session_ended` or `api_stopped`). Journal lines
   from the helper (actor, address, process id, duration) and from PAM.
   A banner in the shell and a fixed strip on the page say that nothing
   typed is recorded and that opening and closing are audited. Nothing
   typed or shown is ever recorded (ADR 0012).
7. **Optional alert on open.** When the `rootShellOpenedAlert` setting
   in `notify.json` is on (ADR 0052), the API sends every administrator a
   warning-tone site alert, "Root shell opened by <name>", through the
   existing forwarding. The setting is off by default, and the helper
   never sends an alert of its own.

## Accepted risk

A stolen administrator session, an XSS (cross-site scripting) bug in the
Portikus web app, or a compromised API process each now equals root on
the host. That means every student's files, the database, the signing,
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
