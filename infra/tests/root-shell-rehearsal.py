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
import secrets
import shutil
import socket
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

    def __init__(self, sock=None, cols=80, rows=24):
        self.sock = sock or connect_as("portikus", ["portikus", GROUP])
        self.id = str(uuid.uuid4())
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
    check("the daemon in its session was ended", not pids_of(held["marker"]))
    check("its session is gone", held["session"] is not None and "State" not in session_props(held["session"]))
    left = held["leftover"]
    check("tmux left behind a closed pane was ended", not pids_of(left["marker"]))
    check("that session is gone too", left["session"] is not None and "State" not in session_props(left["session"]))
    end_leftovers(held["session"], held["marker"])
    end_leftovers(left["session"], left["marker"])
    os.unlink(HOLD)


def main(args):
    if os.geteuid() != 0:
        print("run as root", file=sys.stderr)
        return 2
    if args == ["--hold"]:
        hold()
        return 0
    if args == ["--off"]:
        off_state()
    elif not args:
        on_state()
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
