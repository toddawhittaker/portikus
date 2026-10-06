#!/usr/bin/python3
"""The root-shell helper on a real host (docs/adr/0051-root-shell.md).

Runs as root on a rehearsal VM with the package installed and setup run.
It plays the API: it connects to /run/portikus-root-shell.sock as the
portikus user with the portikus-root-shell group, and speaks the helper's
frames, taken from the installed helper itself.

  root-shell-rehearsal.py          the on state: who may connect, the PAM
                                   sign-in and its logind session, resize,
                                   hang-up on close (the administrator's
                                   tmux survives, and its record stays), the
                                   `end` frame ends the session, exit, and
                                   nothing typed or shown reaches the journal
  root-shell-rehearsal.py --hold   opens one shell with tmux in its session
                                   and keeps it open in the background,
                                   and leaves tmux behind a closed one, for
                                   the off switch to end
  root-shell-rehearsal.py --off    after setup with portikus_root_shell
                                   false: the socket is gone, api.env names
                                   none, and both sessions ended
  root-shell-rehearsal.py --api HOST JAR
                                   end to end through Caddy and the API, as
                                   the administrator whose signed-in cookie
                                   jar (curl's format) is JAR: the audit
                                   rows, a Caddy reload leaves the shell
                                   open, exit, and a shell the helper cannot
                                   give is refused cleanly

Never run it on a host with real users: it signs in as root and ends the
sessions it made.
"""

import grp
import importlib.machinery
import importlib.util
import json
import os
import pwd
import re
import base64
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import time
import uuid

HELPER = "/usr/lib/portikus/root-shell"
SOCKET = "/run/portikus-root-shell.sock"
RUN_DIR = "/run/portikus-root-shell"
GROUP = "portikus-root-shell"
API_ENV = "/etc/portikus/api.env"
HOLD = "/root/root-shell-rehearsal-hold.json"
CA = "/etc/portikus/caddy-root.crt"
ADDRESS = "192.0.2.77"
ACTOR = "6f1c2d3e-4a5b-4c6d-8e7f-a1b2c3d4e5f6"
# A newline in the name must not forge a journal line, and the name never appears there.
ACTOR_NAME = "Rehearsal Admin\nportikus-root-shell: forged"

_loader = importlib.machinery.SourceFileLoader("root_shell", HELPER)
rs = importlib.util.module_from_spec(importlib.util.spec_from_loader("root_shell", _loader))
_loader.exec_module(rs)

results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print(("PASS" if ok else "FAIL") + "  " + label + (" (%s)" % detail if detail and not ok else ""), flush=True)
    return bool(ok)


def heading(text):
    print("\n--- %s ---" % text, flush=True)


def sh(*argv):
    return subprocess.run(argv, capture_output=True, text=True).stdout


def wait_for(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def pids_of(pattern):
    return [int(p) for p in sh("pgrep", "-fx", pattern).split()]


def connect_as(user, groups):
    """A connection made by `user` with exactly `groups`, so SO_PEERCRED and the socket mode see that user."""
    ours, theirs = socket.socketpair()
    pid = os.fork()
    if pid == 0:
        try:
            ours.close()
            entry = pwd.getpwnam(user)
            os.setgroups([grp.getgrnam(g).gr_gid for g in groups])
            os.setgid(entry.pw_gid)
            os.setuid(entry.pw_uid)
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(SOCKET)
                socket.send_fds(theirs, [b"ok"], [sock.fileno()])
            except OSError as e:
                theirs.sendall(b"errno %d" % e.errno)
        finally:
            os._exit(0)
    theirs.close()
    message, fds, _, _ = socket.recv_fds(ours, 64, 1)
    os.waitpid(pid, 0)
    ours.close()
    if fds:
        return socket.socket(fileno=fds[0])
    raise OSError(int(message.split()[1]), "connect as %s" % user)


class Shell:
    """One root shell, opened the way the API opens it."""

    def __init__(self, sock=None, cols=80, rows=24, shell_id=None):
        self.sock = sock or connect_as("portikus", ["portikus", GROUP])
        self.id = shell_id or str(uuid.uuid4())
        self.buffer = b""
        self.output = b""
        self.exit = None
        self.errors = []
        self.send(rs.OPEN, json.dumps({"shellId": self.id, "actorId": ACTOR, "actorName": ACTOR_NAME,
                                       "address": ADDRESS, "cols": cols, "rows": rows}).encode())

    def send(self, kind, body):
        self.sock.sendall(rs.encode(kind, body))

    def type(self, text):
        self.send(rs.INPUT, text.encode())

    def pump(self, timeout):
        self.sock.settimeout(timeout)
        try:
            data = self.sock.recv(65536)
        except socket.timeout:
            return True
        except ConnectionResetError:
            # The helper exited with frames of ours still unread, as after a refusal.
            return False
        if not data:
            return False
        self.buffer += data
        while len(self.buffer) >= rs.HEADER.size:
            kind, length = rs.HEADER.unpack_from(self.buffer)
            if len(self.buffer) < rs.HEADER.size + length:
                break
            body = self.buffer[rs.HEADER.size:rs.HEADER.size + length]
            self.buffer = self.buffer[rs.HEADER.size + length:]
            if kind == rs.OUTPUT:
                self.output += body
            elif kind == rs.EXIT:
                self.exit = json.loads(body)
            elif kind == rs.ERROR:
                self.errors.append(json.loads(body)["code"])
        return True

    def expect(self, pattern, timeout=15):
        """The first match of the regular expression in what the shell printed, or None."""
        deadline = time.monotonic() + timeout
        while True:
            match = re.search(pattern, self.output)
            if match or time.monotonic() > deadline:
                return match
            if not self.pump(0.5):
                return re.search(pattern, self.output)

    def closed(self, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.pump(0.5):
                return True
        return False

    def ready(self):
        """Waits for root's prompt: login resets the terminal and drops anything typed before it."""
        return self.expect(rb"root@[^\r\n]*# ", 30) is not None

    def record(self):
        """The helper's record of this shell: login's process id and the session, as strings."""
        try:
            with open(os.path.join(RUN_DIR, self.id)) as f:
                return f.read().split()
        except OSError:
            return []

    def login_pid(self):
        fields = self.record()
        return int(fields[0]) if fields and fields[0].isdigit() else None

    def start_daemon(self):
        """A tmux session running a uniquely named sleep, in the shell's logind session."""
        marker = "sleep %d" % (3000000 + secrets.randbelow(900000))
        self.type("tmux new-session -d -s rs-%s '%s'; echo daemon-$((40+2))\r" % (self.id[:8], marker))
        self.expect(rb"daemon-42")
        wait_for(lambda: bool(pids_of(marker)), 5)
        return marker


def session_of(pid):
    return rs.session_of(pid) if pid else None


def session_props(session):
    text = sh("loginctl", "show-session", session, "-p", "Name", "-p", "Service", "-p", "RemoteHost", "-p", "TTY", "-p", "State")
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def unit_props(unit, *names):
    text = sh("systemctl", "show", unit, *("-p" + n for n in names))
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def api_env_socket():
    with open(API_ENV) as f:
        for line in f:
            if line.startswith("ROOT_SHELL_SOCKET="):
                return line.rstrip("\n").split("=", 1)[1]
    return None


def groups_of(pid):
    with open("/proc/%d/status" % pid) as f:
        for line in f:
            if line.startswith("Groups:"):
                return {int(g) for g in line.split()[1:]}
    return set()


def journal_since(since, *match):
    return sh("journalctl", "--no-pager", "-o", "cat", "--since", "@%d" % since, *match)


def end_leftovers(session, marker):
    for pid in pids_of(marker):
        os.kill(pid, 9)
    if session:
        subprocess.run(["loginctl", "terminate-session", session], capture_output=True)


def on_state():
    since = int(time.time()) - 1
    secret = "SECRET-" + secrets.token_hex(8)
    shown = "SHOWN-" + secrets.token_hex(8)
    gid = grp.getgrnam(GROUP).gr_gid

    heading("Setup")
    socket_unit = unit_props("portikus-root-shell.socket", "UnitFileState", "ActiveState")
    check("the socket unit is enabled and listening",
          socket_unit == {"UnitFileState": "enabled", "ActiveState": "active"}, str(socket_unit))
    st = os.stat(SOCKET)
    check("the socket is root:%s, mode 0660" % GROUP,
          st.st_uid == 0 and st.st_gid == gid and st.st_mode & 0o777 == 0o660, oct(st.st_mode))
    check("api.env names the socket", api_env_socket() == SOCKET, str(api_env_socket()))
    api = int(unit_props("portikus-api.service", "MainPID")["MainPID"])
    worker = int(unit_props("portikus-worker.service", "MainPID")["MainPID"])
    check("the API process has the group", api > 0 and gid in groups_of(api))
    check("the worker process does not", worker > 0 and gid not in groups_of(worker))
    check("no user is a member of the group", grp.getgrnam(GROUP).gr_mem == [])
    check("tmux is installed", shutil.which("tmux") is not None)
    try:
        with open("/etc/pam.d/remote") as f:
            pam = f.read()
    except OSError:
        pam = ""
    check("login -h has its own PAM service, login's stack", "session  include login" in pam)

    heading("Who may connect")
    try:
        connect_as("portikus-worker", ["portikus-worker"]).close()
        check("the worker cannot connect", False, "connected")
    except PermissionError:
        check("the worker cannot connect", True)
    shell = Shell(connect_as("nobody", ["nogroup", GROUP]))
    shell.closed()
    check("another user in the group is refused before any shell starts",
          shell.errors == ["peer-refused"] and shell.output == b"", str(shell.errors))

    heading("A PAM sign-in session")
    shell = Shell(cols=91, rows=33)
    check("the banner comes first", shell.expect(rb"Portikus root shell on this server") is not None)
    check("root's prompt follows", shell.ready())
    shell.type("echo rs-$((6*7))-ok; stty size\r")
    check("the shell runs commands at the size asked for", shell.expect(rb"rs-42-ok\r\n33 91") is not None)
    login = shell.login_pid()
    check("the helper recorded the login process id", login is not None and alive(login))
    check("its folder is root's alone", os.stat(RUN_DIR).st_mode & 0o777 == 0o700)
    check("the process is login", login is not None and rs.is_login(login))
    session = session_of(login)
    props = session_props(session) if session else {}
    # login uses the PAM service "remote" when given -h.
    check("login has its own logind session as root, remote host %s" % ADDRESS,
          props.get("Name") == "root" and props.get("Service") == "remote" and props.get("RemoteHost") == ADDRESS,
          str(props))
    tty = props.get("TTY", "")
    check("who lists it", bool(tty) and re.search(r"^root\s+%s\s.*\(%s\)" % (re.escape(tty), re.escape(ADDRESS)),
                                                  sh("who"), re.M) is not None, sh("who"))
    check("PAM wrote its own line", "session opened for user root" in journal_since(since, "_COMM=login"))
    shell.type("cat /proc/self/cgroup; awk '/^(NoNewPrivs|Seccomp):/' /proc/self/status\r")
    shell.type("echo loginuid-$(cat /proc/$$/loginuid)\r")
    check("pam_loginuid set the shell's login user id to root", shell.expect(rb"loginuid-0\r") is not None)
    check("the record names the session", session is not None and shell.record() == [str(login), session],
          str(shell.record()))
    check("the shell runs in the session's scope, not the helper's unit",
          shell.expect(rb"session-%s\.scope" % session.encode()) is not None if session else False)
    check("an ordinary root shell: no NoNewPrivileges and no seccomp filter",
          shell.expect(rb"NoNewPrivs:\s+0\r\nSeccomp:\s+0") is not None)
    shell.send(rs.RESIZE, b'{"cols":132,"rows":43}')
    shell.type("stty size\r")
    check("a resize reaches the terminal", shell.expect(rb"43 132") is not None)
    shell.type(": %s; echo %s\r" % (secret, shown))
    shell.expect(shown.encode())

    heading("Closing the pane hangs up")
    hup = "/run/root-shell-rehearsal-hup-%s" % shell.id
    marker = shell.start_daemon()
    check("a daemon started in the shell runs", bool(pids_of(marker)))
    # A foreground job, as an editor or a long command would be.
    job = "sh -c trap 'echo hup > %s; exit 129' HUP; while :; do sleep 0.2; done" % hup
    shell.type("sh -c \"trap 'echo hup > %s; exit 129' HUP; while :; do sleep 0.2; done\"\r" % hup)
    check("a foreground job runs", wait_for(lambda: bool(pids_of(job)), 5))
    shell.sock.close()
    check("the shell got SIGHUP", wait_for(lambda: os.path.exists(hup)))
    check("login ended", wait_for(lambda: not alive(login)))
    check("the administrator's tmux survives", bool(pids_of(marker)))
    check("its session is still there", session is not None and "State" in session_props(session))
    check("the record stays while the session lives, for the off switch",
          shell.record() == [str(login), session], str(shell.record()))
    check("the helper recorded the close",
          wait_for(lambda: "closed shell %s" % shell.id in journal_since(since, "-u", "portikus-root-shell@*"))
          and "(client)" in journal_since(since, "-u", "portikus-root-shell@*"))
    end_leftovers(session, marker)
    if os.path.exists(hup):
        os.unlink(hup)

    heading("The end frame ends the whole session")
    shell = Shell()
    shell.ready()
    login = shell.login_pid()
    session = session_of(login)
    marker = shell.start_daemon()
    check("a daemon started in the shell runs", bool(pids_of(marker)))
    shell.send(rs.END, b'{"reason":"session_ended"}')
    check("the helper closes the connection", shell.closed())
    check("the daemon was ended with the session", wait_for(lambda: not pids_of(marker)))
    check("the session is gone", wait_for(lambda: "State" not in session_props(session)) if session else False)
    check("the helper recorded why",
          wait_for(lambda: "(session_ended, session ended)" in journal_since(since, "-u", "portikus-root-shell@*")))
    check("its record is gone", shell.record() == [])
    end_leftovers(None, marker)

    heading("End behind a full input queue")
    shell = Shell()
    shell.ready()
    session = session_of(shell.login_pid())
    flood = "/run/root-shell-rehearsal-flood-%s" % shell.id
    shell.type("sleep 30\r")
    time.sleep(1)
    line = ("touch %s\n" % flood).encode()
    for _ in range(6):
        shell.send(rs.INPUT, line * (64000 // len(line)))
    started = time.monotonic()
    shell.send(rs.END, b'{"reason":"session_ended"}')
    check("end is seen while the shell is busy and 384,000 bytes wait", shell.closed(8) and time.monotonic() - started < 8)
    check("the session is gone", wait_for(lambda: "State" not in session_props(session)) if session else False)
    time.sleep(2)
    check("the waiting input never ran", not os.path.exists(flood))
    check("the administrator was told input was dropped", b"typed input was dropped" in shell.output)

    heading("A repeated shell id")
    first = Shell()
    first.ready()
    second = Shell(shell_id=first.id)
    second.closed()
    check("is refused before login starts", second.errors == ["duplicate-shell"] and second.output == b"", str(second.errors))
    check("and the first shell's record is untouched", first.record() and first.login_pid() is not None)
    first.type("exit\r")
    first.closed()

    heading("Exit")
    shell = Shell()
    shell.ready()
    shell.type("exit 7\r")
    check("the helper reports the exit and closes", shell.closed() and shell.exit is not None, str(shell.exit))
    check("no helper instance is left", wait_for(lambda: sh("systemctl", "list-units", "--no-legend", "portikus-root-shell@*") == ""))

    heading("Nothing typed or shown reaches the journal (ADR 0012)")
    unit_lines = journal_since(since, "-u", "portikus-root-shell@*")
    everything = journal_since(since)
    check("the helper's lines name the shell", "opened shell %s for actor %s from %s" % (shell.id, ACTOR, ADDRESS) in unit_lines)
    check("nothing typed is in the helper's lines", secret not in unit_lines and "rs-$((6*7))" not in unit_lines)
    check("nothing shown is in the helper's lines", shown not in unit_lines and "rs-42-ok" not in unit_lines)
    check("the administrator's name is never logged", "forged" not in unit_lines and "Rehearsal Admin" not in unit_lines)
    check("nothing typed or shown is anywhere in the journal", secret not in everything and shown not in everything)


def hold():
    closed = Shell()
    closed.ready()
    login = closed.login_pid()
    leftover = {"session": session_of(login), "marker": closed.start_daemon()}
    closed.sock.close()
    wait_for(lambda: not alive(login))
    shell = Shell()
    shell.ready()
    login = shell.login_pid()
    state = {"shellId": shell.id, "loginPid": login, "session": session_of(login), "marker": shell.start_daemon(),
             "leftover": leftover}
    with open(HOLD, "w") as f:
        json.dump(state, f)
    print(json.dumps(state))
    sys.stdout.flush()
    if os.fork():
        return
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    while shell.pump(60):
        pass
    os._exit(0)


def off_state():
    heading("The off switch")
    socket_unit = unit_props("portikus-root-shell.socket", "UnitFileState", "ActiveState")
    check("the socket unit is disabled and stopped",
          socket_unit["UnitFileState"] == "disabled" and socket_unit["ActiveState"] == "inactive", str(socket_unit))
    check("the socket file is gone", not os.path.exists(SOCKET))
    check("api.env names no socket", api_env_socket() == "", str(api_env_socket()))
    check("no helper instance runs", sh("systemctl", "list-units", "--no-legend", "portikus-root-shell@*") == "")
    check("no process-id file is left", not os.path.isdir(RUN_DIR) or os.listdir(RUN_DIR) == [])
    with open(HOLD) as f:
        held = json.load(f)
    check("the held shell's login ended", not alive(held["loginPid"]))
    check("its tmux was ended", wait_for(lambda: not pids_of(held["marker"]), 10))
    check("its session is gone", held["session"] is not None and "State" not in session_props(held["session"]))
    left = held["leftover"]
    check("tmux left behind a closed pane was ended", wait_for(lambda: not pids_of(left["marker"]), 10))
    check("that session is gone too", left["session"] is not None
          and wait_for(lambda: "State" not in session_props(left["session"]), 10))
    end_leftovers(held["session"], held["marker"])
    end_leftovers(left["session"], left["marker"])
    os.unlink(HOLD)


class Browser:
    """The Root shell tab's WebSocket, through Caddy, with the standard library only."""

    def __init__(self, host, cookies, cols=80, rows=24):
        raw = socket.create_connection(("127.0.0.1", 443), timeout=15)
        self.sock = ssl.create_default_context(cafile=CA).wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((
            "GET /admin/root-shell/ws?cols=%d&rows=%d HTTP/1.1\r\nHost: %s\r\nOrigin: https://%s\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\nCookie: %s\r\n\r\n" % (cols, rows, host, host, key, cookies)).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            data = self.sock.recv(4096)
            if not data:
                break
            head += data
        head, _, self.buffer = head.partition(b"\r\n\r\n")
        self.status = int(head.split(b" ", 2)[1]) if head.startswith(b"HTTP/") else 0
        self.output = b""
        self.messages = []
        self.close_code = None

    def send(self, opcode, payload):
        mask = secrets.token_bytes(4)
        n = len(payload)
        header = bytes([0x80 | opcode]) + (bytes([0x80 | n]) if n < 126 else struct.pack(">BH", 0x80 | 126, n))
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def type(self, text):
        self.send(0x1, json.dumps({"type": "input", "data": text}).encode())

    def close(self):
        self.send(0x8, struct.pack(">H", 1000))

    def pump(self, timeout):
        """Reads what has arrived; false once the connection is closed."""
        self.sock.settimeout(timeout)
        try:
            data = self.sock.recv(65536)
        except (socket.timeout, ssl.SSLWantReadError):
            return True
        except OSError:
            return False
        if not data:
            return False
        self.buffer += data
        while len(self.buffer) >= 2:
            opcode, n, at = self.buffer[0] & 0x0F, self.buffer[1] & 0x7F, 2
            if n == 126:
                n, at = struct.unpack(">H", self.buffer[2:4])[0], 4
            elif n == 127:
                n, at = struct.unpack(">Q", self.buffer[2:10])[0], 10
            if len(self.buffer) < at + n:
                break
            payload, self.buffer = self.buffer[at:at + n], self.buffer[at + n:]
            if opcode == 0x2:
                self.output += payload
            elif opcode == 0x1:
                self.messages.append(json.loads(payload))
            elif opcode == 0x8:
                self.close_code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                # Answered as a browser does, which completes the server's close.
                try:
                    self.send(0x8, payload[:2])
                except OSError:
                    pass
        return self.close_code is None

    def expect(self, pattern, timeout=15):
        deadline = time.monotonic() + timeout
        while not re.search(pattern, self.output) and time.monotonic() < deadline:
            if not self.pump(0.5):
                break
        return re.search(pattern, self.output) is not None

    def closed(self, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.pump(0.5):
                return True
        return False


def jar_cookies(jar):
    """The Cookie header for curl's cookie jar."""
    pairs = []
    with open(jar) as f:
        for line in f:
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            elif line.startswith("#") or not line.strip():
                continue
            fields = line.rstrip("\n").split("\t")
            if len(fields) == 7:
                pairs.append("%s=%s" % (fields[5], fields[6]))
    return "; ".join(pairs)


def audit_rows(shell_id):
    out = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-X", "-At", "-d", "portikus", "-c",
                          "SELECT action || ' ' || metadata::text FROM audit_events WHERE target = '%s' ORDER BY id"
                          % shell_id], capture_output=True, text=True, cwd="/").stdout
    return [(line.split(" ", 1)[0], json.loads(line.split(" ", 1)[1])) for line in out.splitlines() if " " in line]


def newest_record(before):
    names = [n for n in os.listdir(RUN_DIR) if not n.startswith(".") and n not in before] if os.path.isdir(RUN_DIR) else []
    return names[0] if len(names) == 1 else None


def through_the_api(host, jar):
    cookies = jar_cookies(jar)
    since = int(time.time()) - 1

    heading("The Root shell tab, through Caddy and the API")
    before = set(os.listdir(RUN_DIR)) if os.path.isdir(RUN_DIR) else set()
    tab = Browser(host, cookies, cols=100, rows=30)
    check("the API accepts the administrator's WebSocket", tab.status == 101, str(tab.status))
    check("the banner and root's prompt arrive", tab.expect(rb"Portikus root shell") and tab.expect(rb"root@[^\r\n]*# ", 30))
    shell_id = newest_record(before)
    check("the helper recorded one new shell", shell_id is not None)
    tab.type("echo api-$((6*7)); stty size\r")
    check("the shell runs commands at the tab's size", tab.expect(rb"api-42\r\n30 100"))
    with open(os.path.join(RUN_DIR, shell_id)) as f:
        login, session = (f.read().split() + [None, None])[:2]
    props = session_props(session) if session else {}
    check("a PAM sign-in session as root, service remote", props.get("Name") == "root" and props.get("Service") == "remote",
          str(props))
    rows = audit_rows(shell_id)
    check("the opened row is written first, with the address and user agent",
          rows[:1] and rows[0][0] == "admin.root_shell_opened" and rows[0][1].get("shellId") == shell_id
          and "address" in rows[0][1] and "userAgent" in rows[0][1], str(rows))

    heading("A Caddy reload leaves the shell open")
    tab.type("tmux new-session -d -s rs-reload 'sleep 600'; echo before-$((1+1))\r")
    tab.expect(rb"before-2")
    subprocess.run(["systemctl", "reload", "caddy"], check=True)
    time.sleep(3)
    tab.type("echo after-reload-$((2+2))\r")
    check("the shell still answers after `systemctl reload caddy`", tab.expect(rb"after-reload-4"))
    check("its login is still running", alive(int(login)))
    tab.type("tmux kill-session -t rs-reload\r")

    heading("Closing the tab")
    tab.close()
    tab.closed()
    check("login ended", wait_for(lambda: not alive(int(login))))
    check("the closed row follows, reason client, with a duration",
          wait_for(lambda: [r for r in audit_rows(shell_id) if r[0] == "admin.root_shell_closed"
                            and r[1].get("reason") == "client" and "durationSeconds" in r[1]]), str(audit_rows(shell_id)))

    heading("Exit")
    before = set(os.listdir(RUN_DIR))
    tab = Browser(host, cookies)
    tab.expect(rb"root@[^\r\n]*# ", 30)
    shell_id = newest_record(before)
    tab.type("exit\r")
    check("the tab is told the shell exited, then closed", tab.closed() and {"type": "exit"} in tab.messages, str(tab.messages))
    check("the closed row says exit",
          wait_for(lambda: [r for r in audit_rows(shell_id) if r[0] == "admin.root_shell_closed" and r[1].get("reason") == "exit"]))

    heading("A shell the helper cannot give is refused cleanly")
    subprocess.run(["systemctl", "stop", "portikus-root-shell.socket"], check=True)
    try:
        tab = Browser(host, cookies)
        check("the WebSocket is closed with no shell", tab.closed() and tab.output == b"",
              "status %s, close %s" % (tab.status, tab.close_code))
        print("      (status %s, close code %s, messages %s)" % (tab.status, tab.close_code, tab.messages), flush=True)
    finally:
        subprocess.run(["systemctl", "start", "portikus-root-shell.socket"], check=True)
    check("the API logged the refusal", "root shell helper unavailable" in journal_since(since, "-u", "portikus-api"))
    check("the API is still running", sh("systemctl", "is-active", "portikus-api").strip() == "active")
    anonymous = Browser(host, "")
    check("a WebSocket with no session is refused before any shell", anonymous.status in (401, 403), str(anonymous.status))

    heading("Nothing typed reaches the journal")
    everything = journal_since(since)
    check("not the typed commands, nor what the shell printed", "api-$((6*7))" not in everything and "after-reload-4" not in everything)


def main(args):
    if os.geteuid() != 0:
        print("run as root", file=sys.stderr)
        return 2
    if args == ["--hold"]:
        hold()
        return 0
    if args == ["--off"]:
        off_state()
    elif len(args) == 3 and args[0] == "--api":
        through_the_api(args[1], args[2])
    elif not args:
        on_state()
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
