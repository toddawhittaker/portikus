"""Unit tests for packaging/root-shell/root-shell (docs/adr/0051-root-shell.md).

The relay tests run the helper in a forked child against a socket pair, with a
plain /bin/sh in place of `login`; nothing here needs root or touches logind.
Run: python3 -B -m unittest discover -s packaging/root-shell/tests
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
_PATH = Path(__file__).resolve().parents[1] / "root-shell"
_loader = importlib.machinery.SourceFileLoader("root_shell", str(_PATH))
rs = importlib.util.module_from_spec(importlib.util.spec_from_loader("root_shell", _loader))
_loader.exec_module(rs)


def _no_real_loginctl(argv, **_):
    raise AssertionError("a test reached the real loginctl: %r" % (argv,))


def _no_real_kill(pid, session, _proc):
    raise AssertionError("a test tried to kill process %d of session %s" % (pid, session))


# A default left in place would end, inspect or kill the test runner's own logind session.
_REAL = {id(subprocess.run): _no_real_loginctl, id(rs.kill_in_session): _no_real_kill}
for _function in (rs.terminate_session, rs.session_service, rs.end_sessions, rs.prune_records, rs.session_over,
                  rs.transient_units, rs.kill_strays, rs.Shell.__init__):
    _function.__defaults__ = tuple(_REAL.get(id(d), d) for d in _function.__defaults__)


class FakeLogind:
    """loginctl show-session and terminate-session over a file, so a forked helper's calls are seen too."""

    def __init__(self, directory, live=None):
        self.calls_path = os.path.join(directory, "loginctl-calls")
        self.live_path = os.path.join(directory, "live-sessions")
        self.save(live or {})

    def save(self, live):
        Path(self.live_path).write_text("".join("%s %s\n" % item for item in live.items()))

    def live(self):
        return dict(line.split() for line in Path(self.live_path).read_text().splitlines())

    def calls(self):
        try:
            return Path(self.calls_path).read_text().splitlines()
        except FileNotFoundError:
            return []

    def __call__(self, argv, **_):
        with open(self.calls_path, "a") as f:
            f.write(" ".join(argv) + "\n")
        live = self.live()
        verb, session = argv[1], argv[2]
        if verb == "show-session" and argv[3:] == ["-P", "Service"] and session in live:
            return subprocess.CompletedProcess(argv, 0, live[session] + "\n")
        if verb in ("terminate-session", "kill-session") and session in live:
            del live[session]
            self.save(live)
            return subprocess.CompletedProcess(argv, 0, "")
        return subprocess.CompletedProcess(argv, 1, "")

SHELL = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
ACTOR = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
NAME = "Ada\nportikus-root-shell: forged line"


def open_body(**changes):
    value = {"shellId": SHELL, "actorId": ACTOR, "actorName": NAME, "address": "192.0.2.7", "cols": 80, "rows": 24}
    value.update(changes)
    for key in [k for k, v in value.items() if v is ...]:
        del value[key]
    return json.dumps(value).encode()


class FrameReaderTest(unittest.TestCase):
    def test_splits_frames_across_reads(self):
        reader = rs.FrameReader()
        data = rs.encode(rs.INPUT, b"ls\r") + rs.encode(rs.RESIZE, b'{"cols":1,"rows":2}')
        self.assertEqual(reader.feed(data[:3]), [])
        self.assertEqual(reader.feed(data[3:9]), [(rs.INPUT, b"ls\r")])
        self.assertEqual(reader.feed(data[9:]), [(rs.RESIZE, b'{"cols":1,"rows":2}')])

    def test_empty_body(self):
        self.assertEqual(rs.FrameReader().feed(rs.encode(rs.INPUT, b"")), [(rs.INPUT, b"")])

    def test_unknown_type_closes(self):
        for kind in (0x00, 0x05, rs.OUTPUT, rs.EXIT, rs.ERROR, 0xFF):
            with self.subTest(kind=kind), self.assertRaises(rs.ProtocolError) as e:
                rs.FrameReader().feed(struct.pack(">BI", kind, 0))
            self.assertEqual(e.exception.code, "unknown-type")

    def test_oversize_is_refused_from_the_header_alone(self):
        for kind, cap in ((rs.OPEN, 4096), (rs.RESIZE, 64), (rs.INPUT, 65536), (rs.END, 64)):
            with self.subTest(kind=kind):
                self.assertEqual(rs.FrameReader().feed(struct.pack(">BI", kind, cap)), [])
                with self.assertRaises(rs.ProtocolError) as e:
                    rs.FrameReader().feed(struct.pack(">BI", kind, cap + 1))
                self.assertEqual(e.exception.code, "too-large")

    def test_huge_length_is_refused(self):
        with self.assertRaises(rs.ProtocolError):
            rs.FrameReader().feed(b"\x02\xff\xff\xff\xff")


class OrderTest(unittest.TestCase):
    def test_first_frame_must_be_open(self):
        for kind, body in ((rs.INPUT, b"x"), (rs.RESIZE, b'{"cols":1,"rows":1}'), (rs.END, b'{"reason":"x"}')):
            with self.subTest(kind=kind), self.assertRaises(rs.ProtocolError) as e:
                rs.Protocol().accept(kind, body)
            self.assertEqual(e.exception.code, "not-open")

    def test_open_only_once(self):
        protocol = rs.Protocol()
        protocol.accept(rs.OPEN, open_body())
        with self.assertRaises(rs.ProtocolError) as e:
            protocol.accept(rs.OPEN, open_body())
        self.assertEqual(e.exception.code, "already-open")

    def test_after_open(self):
        protocol = rs.Protocol()
        self.assertEqual(protocol.accept(rs.OPEN, open_body())[0], "open")
        self.assertEqual(protocol.accept(rs.INPUT, b"\x03"), ("input", b"\x03"))
        self.assertEqual(protocol.accept(rs.RESIZE, b'{"cols":120,"rows":40}'), ("resize", (120, 40)))
        self.assertEqual(protocol.accept(rs.END, b'{"reason":"session_ended"}'), ("end", "session_ended"))


class OpenValidationTest(unittest.TestCase):
    def test_valid(self):
        opened = rs.parse_open(open_body(address="2001:DB8::0001"))
        self.assertEqual(opened, {"shellId": SHELL, "actorId": ACTOR, "address": "2001:db8::1", "cols": 80, "rows": 24})
        self.assertNotIn("actorName", opened)

    def test_invalid(self):
        cases = {
            "not json": b"{",
            "not utf-8": b"\xff",
            "a list": b"[]",
            "missing field": open_body(rows=...),
            "extra field": json.loads(open_body()) | {"env": {"LD_PRELOAD": "x"}},
            "shell id not a uuid": open_body(shellId="../etc/passwd"),
            "shell id braces": open_body(shellId="{%s}" % SHELL),
            "actor id urn": open_body(actorId="urn:uuid:" + ACTOR),
            "actor id number": open_body(actorId=7),
            "name too long": open_body(actorName="x" * 257),
            "name not a string": open_body(actorName=None),
            "host name": open_body(address="example.com"),
            "address with newline": open_body(address="192.0.2.7\n"),
            "address option": open_body(address="-froot"),
            "address list": open_body(address=["192.0.2.7"]),
            "cols zero": open_body(cols=0),
            "rows too big": open_body(rows=1001),
            "cols bool": open_body(cols=True),
            "cols float": open_body(cols=80.0),
            "rows string": open_body(rows="24"),
        }
        for label, body in cases.items():
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            with self.subTest(label), self.assertRaises(rs.ProtocolError) as e:
                rs.parse_open(body)
            self.assertIn(e.exception.code, ("invalid-open",))

    def test_size_bounds(self):
        self.assertEqual(rs.parse_open(open_body(cols=1, rows=1000))["rows"], 1000)

    def test_resize(self):
        self.assertEqual(rs.parse_resize(b'{"cols":1000,"rows":1}'), (1000, 1))
        for body in (b'{"cols":0,"rows":1}', b'{"cols":1}', b'{"cols":1,"rows":1,"x":1}', b'{"cols":"1","rows":1}', b"7"):
            with self.subTest(body=body), self.assertRaises(rs.ProtocolError):
                rs.parse_resize(body)

    def test_end(self):
        self.assertEqual(rs.parse_end(b'{"reason":"session_ended"}'), "session_ended")
        for body in (b'{"reason":"a b"}', b'{"reason":"x\\n"}', b'{"reason":""}', b"{}", b'{"reason":1}'):
            with self.subTest(body=body), self.assertRaises(rs.ProtocolError):
                rs.parse_end(body)

    def test_login_argv_has_no_p_and_one_host_argument(self):
        self.assertEqual(rs.login_argv("192.0.2.7"), ["/bin/login", "-f", "root", "-h", "192.0.2.7"])


class PeerTest(unittest.TestCase):
    def test_only_the_named_user(self):
        self.assertTrue(rs.peer_allowed(103, 103))
        self.assertFalse(rs.peer_allowed(0, 103))
        self.assertFalse(rs.peer_allowed(1000, 103))
        self.assertFalse(rs.peer_allowed(103, None))

    def test_reads_the_peer_uid(self):
        a, b = socket.socketpair()
        with a, b:
            self.assertEqual(rs.peer_uid(a), os.getuid())


class EndSessionsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="root-shell-test-")
        self.run_dir = os.path.join(self.dir, "run")
        self.proc = os.path.join(self.dir, "proc")
        os.makedirs(self.run_dir)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def process(self, pid, comm, cgroup, sessionid="4294967295", state=None):
        os.makedirs(os.path.join(self.proc, str(pid)))
        Path(self.proc, str(pid), "comm").write_text(comm + "\n")
        Path(self.proc, str(pid), "cgroup").write_text(cgroup + "\n")
        Path(self.proc, str(pid), "sessionid").write_text(sessionid)
        if state is not None:
            Path(self.proc, str(pid), "stat").write_text("%d (%s) %s 1 %d %d 0 -1\n" % (pid, comm, state, pid, pid))

    def test_kills_what_left_a_root_shell_session_but_keeps_its_audit_id(self):
        # Sessions 7 and 9 are root shells; 9 has ended because its last process left the scope.
        logind = FakeLogind(self.dir, {"7": "remote", "6": "login"})
        self.record(1, "10 7\n")
        self.record(2, "11 9\n")
        self.record(3, "12 6\n")  # a console sign-in: never ours
        self.process(20, "sleep", "0::/system.slice/run-u3.scope", "7")  # systemd-run --scope from shell 7
        self.process(21, "nohup", "0::/system.slice/run-u4.scope", "9")
        self.process(22, "bash", "0::/user.slice/user-0.slice/session-6.scope", "6")
        self.process(23, "cron", "0::/system.slice/cron.service")
        self.process(24, "sshd", "0::/user.slice/user-0.slice/session-77.scope", "77")
        killed = []
        ended = rs.end_sessions(self.run_dir, self.proc, logind,
                                kill=self.recording_kill(killed))
        self.assertEqual(sorted(killed), [(20, "7"), (21, "9")])
        self.assertEqual(ended, 2)
        self.assertEqual([c for c in logind.calls() if "terminate-session" in c], ["loginctl terminate-session 7"])
        self.assertEqual(os.listdir(self.run_dir), [])

    def test_a_session_name_that_is_no_audit_id_matches_no_process(self):
        self.process(20, "sleep", "0::/system.slice/run-u3.scope", "4294967295")
        self.assertEqual(rs.session_pids("c4", self.proc), [])
        self.assertEqual(rs.session_pids("4294967295", self.proc), [])

    def test_prune_keeps_an_ended_session_whose_processes_left_its_scope(self):
        logind = FakeLogind(self.dir, {})
        kept = self.record(1, "10 9\n")
        self.record(2, "11 8\n")
        self.process(21, "nohup", "0::/system.slice/run-u4.scope", "9")
        rs.prune_records(self.run_dir, logind, self.proc)
        self.assertEqual(os.listdir(self.run_dir), [kept])

    def test_lists_running_systemd_run_units(self):
        def systemctl(argv, **_):
            self.assertEqual(argv[:2], ["systemctl", "list-units"])
            return subprocess.CompletedProcess(argv, 0, "run-u12.service loaded active running /bin/sleep 900\n"
                                                         "run-r3f.timer loaded active waiting /bin/true\n")
        self.assertEqual(rs.transient_units(systemctl), ["run-u12.service", "run-r3f.timer"])

    def record(self, n, text):
        name = "%da8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" % n
        Path(self.run_dir, name).write_text(text)
        return name

    def test_ends_only_live_remote_sessions_and_forgets_every_record(self):
        logind = FakeLogind(self.dir, {"c4": "remote", "c5": "login", "c7": "remote", "8": "remote"})
        self.process(13, "login", "0::/user.slice/user-0.slice/session-c7.scope")
        self.process(14, "bash", "0::/user.slice/user-0.slice/session-8.scope")
        self.record(1, "10 c4\n")  # a shell's leftover tmux: ended
        self.record(2, "11 c5\n")  # a console sign-in: never ours
        self.record(3, "12 c6\n")  # already gone
        self.record(4, "13\n")  # login had not joined its session when recorded: found from its PID
        self.record(5, "14\n")  # the PID now belongs to another process
        self.record(6, "15 ../x\n")
        starting = self.record(7, "")  # its helper has not started login yet
        Path(self.run_dir, "not-a-shell").write_text("10 c4\n")
        self.assertEqual(rs.end_sessions(self.run_dir, self.proc, logind), 2)
        self.assertEqual([c for c in logind.calls() if "kill-session" in c],
                         ["loginctl kill-session c4 --signal=SIGKILL", "loginctl kill-session c7 --signal=SIGKILL"])
        self.assertEqual([c for c in logind.calls() if "terminate-session" in c],
                         ["loginctl terminate-session c4", "loginctl terminate-session c7"])
        self.assertEqual(logind.live(), {"c5": "login", "8": "remote"})
        self.assertEqual(sorted(os.listdir(self.run_dir)), sorted(["not-a-shell", starting]))

    def test_no_directory(self):
        self.assertEqual(rs.end_sessions(os.path.join(self.dir, "none"), self.proc, FakeLogind(self.dir)), 0)

    def test_prune_forgets_only_records_of_ended_sessions(self):
        logind = FakeLogind(self.dir, {"c4": "remote"})
        alive = self.record(1, "10 c4\n")
        self.record(2, "11 c5\n")
        starting = self.record(3, "12\n")
        rs.prune_records(self.run_dir, logind)
        self.assertEqual(sorted(os.listdir(self.run_dir)), sorted([alive, starting]))
        self.assertFalse([c for c in logind.calls() if "terminate-session" in c])

    def test_record_round_trip(self):
        self.assertTrue(rs.create_record(self.run_dir, SHELL))
        self.assertFalse(rs.create_record(self.run_dir, SHELL))
        self.assertEqual(rs.read_record(self.run_dir, SHELL), (None, None))
        rs.write_record(self.run_dir, SHELL, 42)
        self.assertEqual(rs.read_record(self.run_dir, SHELL), (42, None))
        rs.write_record(self.run_dir, SHELL, 42, "c9")
        self.assertEqual(rs.read_record(self.run_dir, SHELL), (42, "c9"))
        self.assertEqual(os.listdir(self.run_dir), [SHELL])
        self.assertEqual(os.stat(os.path.join(self.run_dir, SHELL)).st_mode & 0o777, 0o600)
        rs.forget_record(self.run_dir, SHELL)
        with self.assertRaises(FileNotFoundError):
            rs.write_record(self.run_dir, SHELL, 42)

    def test_a_record_is_never_seen_half_written(self):
        rs.create_record(self.run_dir, SHELL)
        rs.write_record(self.run_dir, SHELL, 42)
        old = os.stat(os.path.join(self.run_dir, SHELL)).st_ino
        rs.write_record(self.run_dir, SHELL, 42, "c9")
        # A new file renamed over the old one: a reader holds either whole.
        self.assertNotEqual(os.stat(os.path.join(self.run_dir, SHELL)).st_ino, old)

    def test_revocation_also_kills_what_left_the_session(self):
        logind = FakeLogind(self.dir, {"7": "remote"})
        self.process(20, "sleep", "0::/system.slice/run-u3.scope", "7")
        self.process(21, "sleep", "0::/system.slice/run-u4.scope", "8")
        killed = []
        a, b = socket.socketpair()
        with a, b:
            shell = rs.Shell(a, run=logind, proc=self.proc,
                             kill=self.recording_kill(killed))
            shell.session = "7"
            self.assertTrue(shell.end_session())
        self.assertEqual(killed, [(20, "7")])
        self.assertEqual(logind.live(), {})


    def recording_kill(self, killed):
        """A kill that notes its target and takes it out of the fake /proc, as a real one does."""
        def kill(pid, session, proc):
            killed.append((pid, session))
            shutil.rmtree(os.path.join(proc, str(pid)))
            return True
        return kill

    def forking_kill(self, children):
        """A kill that removes its target, which first forked a child into the session while it had children left."""
        killed = []
        spawned = iter(children)

        def kill(pid, session, proc):
            killed.append(pid)
            shutil.rmtree(os.path.join(self.proc, str(pid)))
            child = next(spawned, None)
            if child is not None:
                self.process(child, "sh", "0::/system.slice/run-u5.scope", session)
            return True
        return kill, killed

    def test_kill_strays_repeats_until_a_forking_process_has_no_child_left(self):
        self.process(20, "sh", "0::/system.slice/run-u3.scope", "7")
        kill, killed = self.forking_kill([30, 31, 32])
        self.assertEqual(rs.kill_strays("7", self.proc, kill), (4, 0))
        self.assertEqual(killed, [20, 30, 31, 32])
        self.assertEqual(rs.session_pids("7", self.proc), [])

    def test_end_sessions_keeps_the_record_while_a_stray_survives_every_round(self):
        logind = FakeLogind(self.dir, {})
        kept = self.record(1, "10 7\n")
        self.process(20, "sh", "0::/system.slice/run-u3.scope", "7")
        attempts = []
        with contextlib.redirect_stderr(io.StringIO()) as journal:
            ended = rs.end_sessions(self.run_dir, self.proc, logind,
                                    kill=lambda pid, session, proc: attempts.append(pid) or False)
        self.assertEqual(attempts, [20] * rs.KILL_ROUNDS)
        self.assertEqual(ended, 0)
        self.assertEqual(os.listdir(self.run_dir), [kept])
        self.assertIn("1 processes of session 7 survived", journal.getvalue())

    def test_end_sessions_forgets_the_record_once_a_forking_stray_is_gone(self):
        logind = FakeLogind(self.dir, {})
        self.record(1, "10 7\n")
        self.process(20, "sh", "0::/system.slice/run-u3.scope", "7")
        kill, killed = self.forking_kill([30, 31])
        self.assertEqual(rs.end_sessions(self.run_dir, self.proc, logind, kill=kill), 1)
        self.assertEqual(killed, [20, 30, 31])
        self.assertEqual(os.listdir(self.run_dir), [])

    def closing_shell(self, logind, session):
        """A Shell whose login has exited, at the point close() decides on its record."""
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        shell = rs.Shell(a, run_dir=self.run_dir, run=logind, proc=self.proc,
                         kill=lambda pid, session, proc: False)
        shell.protocol.opened = json.loads(open_body())
        shell.protocol.opened["address"] = "192.0.2.7"
        shell.pid, shell.status, shell.session, shell.started = 10, 0, session, time.monotonic()
        rs.create_record(self.run_dir, SHELL)
        rs.write_record(self.run_dir, SHELL, 10, session)
        return shell

    def test_close_keeps_the_record_while_a_process_carries_the_session_in_its_proc(self):
        # Gone from logind, but a process that left its scope still carries the audit id.  An id no real
        # process is likely to carry, so a check of the real /proc would wrongly call the session over.
        logind = FakeLogind(self.dir, {})
        self.process(20, "nohup", "0::/system.slice/run-u4.scope", "987654321")
        other = self.record(2, "11 987654321\n")
        with contextlib.redirect_stderr(io.StringIO()):
            self.closing_shell(logind, "987654321").close("client")
        self.assertEqual(sorted(os.listdir(self.run_dir)), sorted([SHELL, other]))

    def test_close_keeps_the_record_when_a_stray_survives_the_end(self):
        logind = FakeLogind(self.dir, {"7": "remote"})
        self.process(20, "sh", "0::/system.slice/run-u3.scope", "7")
        with contextlib.redirect_stderr(io.StringIO()) as journal:
            self.closing_shell(logind, "7").close("end:session_ended")
        self.assertEqual(os.listdir(self.run_dir), [SHELL])
        self.assertIn("1 processes of session 7 survived", journal.getvalue())

    def test_a_zombie_is_no_survivor_and_does_not_keep_the_record(self):
        # login killed by terminate-session but not yet reaped by the helper; a ") S" in a name must not hide the state.
        logind = FakeLogind(self.dir, {"7": "remote"})
        self.process(10, "login) S", "0::/user.slice/user-0.slice/session-7.scope", "7", state="Z")
        self.process(11, "sh", "0::/system.slice/run-u3.scope", "7", state="Z")
        self.assertEqual(rs.session_pids("7", self.proc), [])
        with contextlib.redirect_stderr(io.StringIO()) as journal:
            self.closing_shell(logind, "7").close("end:exit")
        self.assertEqual(os.listdir(self.run_dir), [])
        self.assertNotIn("survived", journal.getvalue())

    def test_a_live_stray_beside_a_zombie_still_survives(self):
        self.process(10, "login", "0::/user.slice/user-0.slice/session-7.scope", "7", state="Z")
        self.process(20, "sh", "0::/system.slice/run-u3.scope", "7", state="S")
        attempts = []
        with contextlib.redirect_stderr(io.StringIO()) as journal:
            result = rs.kill_strays("7", self.proc, lambda pid, session, proc: attempts.append(pid) or False)
        self.assertEqual(result, (0, 1))
        self.assertEqual(attempts, [20] * rs.KILL_ROUNDS)
        self.assertIn("1 processes of session 7 survived", journal.getvalue())

class QueueTest(unittest.TestCase):
    def setUp(self):
        self.ours, self.theirs = socket.socketpair()
        self.shell = rs.Shell(self.ours, run=_no_real_loginctl)

    def tearDown(self):
        self.ours.close()
        self.theirs.close()

    def sent(self):
        self.theirs.setblocking(False)
        try:
            return self.theirs.recv(65536)
        except BlockingIOError:
            return b""

    def test_input_is_queued_whole_or_dropped_until_the_queue_drains(self):
        frames = [bytes([65 + i]) * rs.CAPS[rs.INPUT] for i in range(4)]
        for frame in frames:
            self.shell.queue(frame)
        self.assertEqual(bytes(self.shell.pending), b"".join(frames))
        self.assertEqual(self.sent(), b"")
        self.shell.queue(b"E" * 10)
        self.assertEqual(self.sent(), rs.encode(rs.OUTPUT, rs.DROPPED_NOTICE))
        self.assertIn(b"256 KiB", rs.DROPPED_NOTICE)
        # Partly drained is not enough: a later line would run with the dropped one missing.
        del self.shell.pending[:rs.CAPS[rs.INPUT]]
        self.shell.queue(b"F\n")
        self.assertEqual(bytes(self.shell.pending), b"".join(frames[1:]))
        self.assertEqual(self.sent(), b"", "one notice per overflow")
        self.shell.pending.clear()
        self.shell.queue(b"G\n")
        self.assertEqual(bytes(self.shell.pending), b"G\n")


def frames_from(sock, until, timeout=10):
    """Reads frames until `until(frames)` is true or the socket closes."""
    reader_buffer = b""
    frames = []
    sock.settimeout(timeout)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not until(frames):
        try:
            data = sock.recv(65536)
        except socket.timeout:
            break
        if not data:
            break
        reader_buffer += data
        while len(reader_buffer) >= 5:
            kind, length = struct.unpack_from(">BI", reader_buffer)
            if len(reader_buffer) < 5 + length:
                break
            frames.append((kind, reader_buffer[5:5 + length]))
            reader_buffer = reader_buffer[5 + length:]
    return frames


def output(frames):
    return b"".join(body for kind, body in frames if kind == rs.OUTPUT)


class RelayTest(unittest.TestCase):
    """The helper's loop with /bin/sh standing in for login."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="root-shell-relay-")
        self.run_dir = os.path.join(self.dir, "run")
        self.stderr = os.path.join(self.dir, "stderr")
        self.client, server = socket.socketpair()
        script = os.path.join(self.dir, "shell.sh")
        name = self._testMethodName
        # login's vhangup() leaves the terminal with no open end for a moment.
        gap = "exec 0<&- 1>&- 2>&-; sleep 0.5; exec 0<>/dev/tty 1>&0 2>&0\n" if "gap" in name else ""
        # A shell busy with a command, reading nothing typed.
        busy = "sleep 30\n" if "busy" in name else ""
        # The session outlives the shell, as when the administrator's tmux runs in it.
        self.logind = FakeLogind(self.dir, {"c9": "remote"} if "lives" in name else {})
        # Prints its size, then echoes lines; records a hang-up in a file.  A
        # hung-up terminal can read as empty before SIGHUP arrives, so empty
        # input does not end the loop, or the shell could exit untrapped.
        Path(script).write_text(
            "trap 'echo hup > %s/hup; exit 129' HUP\n"
            "touch %s/started\n" % (self.dir, self.dir) +
            gap + busy +
            "stty size\n"
            "while :; do\n"
            "  read -r line || { sleep 0.05; continue; }\n"
            "  case $line in size) stty size ;; quit) exit 3 ;; *) echo \"got:$line\" ;; esac\n"
            "done\n")
        self.pid = os.fork()
        if self.pid == 0:
            self.client.close()
            fd = os.open(self.stderr, os.O_WRONLY | os.O_CREAT, 0o600)
            os.dup2(fd, 2)
            signal.signal(signal.SIGTERM, rs.stop)
            try:
                rs.serve(server, os.getuid(), self.run_dir, lambda _address: ["/bin/sh", script], b"BANNER\r\n",
                         session_for=lambda _pid: "c9", run=self.logind)
            finally:
                os._exit(0)
        server.close()

    def tearDown(self):
        self.client.close()
        if self.pid is not None:
            os.waitpid(self.pid, 0)
        shutil.rmtree(self.dir)

    def send(self, kind, body):
        self.client.sendall(rs.encode(kind, body))

    def wait_helper(self):
        os.waitpid(self.pid, 0)
        self.pid = None

    def journal(self):
        return Path(self.stderr).read_text()

    def test_open_input_resize_and_exit(self):
        self.send(rs.OPEN, open_body(cols=91, rows=33))
        frames = frames_from(self.client, lambda f: b"33 91" in output(f))
        self.assertTrue(output(frames).startswith(b"BANNER\r\n"))
        self.assertEqual(os.listdir(self.run_dir), [SHELL])
        login_pid = int(Path(self.run_dir, SHELL).read_text().split()[0])
        self.assertEqual(oct(os.stat(self.run_dir).st_mode & 0o777), "0o700")
        self.send(rs.RESIZE, b'{"cols":120,"rows":40}')
        self.send(rs.INPUT, b"size\nsecret-typed-text\nquit\n")
        frames = frames_from(self.client, lambda f: any(k == rs.EXIT for k, _ in f))
        self.assertIn(b"40 120", output(frames))
        self.assertIn(b"got:secret-typed-text", output(frames))
        self.assertEqual(frames[-1], (rs.EXIT, b'{"status":3}'))
        self.wait_helper()
        self.assertEqual(os.listdir(self.run_dir), [])
        journal = self.journal()
        self.assertIn("opened shell %s for actor %s from 192.0.2.7, login pid %d" % (SHELL, ACTOR, login_pid), journal)
        self.assertRegex(journal, r"closed shell %s .* after \d+ seconds \(exit\)" % SHELL)
        self.assertNotIn("secret", journal)
        self.assertNotIn("forged", journal)
        self.assertNotIn("Ada", journal)

    def test_a_gap_with_the_terminal_closed_is_not_the_end(self):
        self.send(rs.OPEN, open_body())
        frames = frames_from(self.client, lambda f: b"24 80" in output(f))
        self.assertIn(b"24 80", output(frames))
        self.send(rs.INPUT, b"quit\n")
        frames = frames_from(self.client, lambda f: any(k == rs.EXIT for k, _ in f))
        self.assertEqual(frames[-1], (rs.EXIT, b'{"status":3}'))

    def test_close_hangs_up_the_shell(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.client.shutdown(socket.SHUT_RDWR)
        self.wait_helper()
        self.assertEqual(Path(self.dir, "hup").read_text(), "hup\n")
        self.assertEqual(os.listdir(self.run_dir), [])
        self.assertRegex(self.journal(), r"closed shell .*\(client\)")

    def test_stop_hangs_up_and_records_the_reason(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        os.kill(self.pid, signal.SIGTERM)
        self.wait_helper()
        self.assertEqual(Path(self.dir, "hup").read_text(), "hup\n")
        self.assertEqual(os.listdir(self.run_dir), [])
        self.assertRegex(self.journal(), r"closed shell .*\(stopped\)")

    def test_input_after_the_shell_ends_reports_its_exit(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.send(rs.INPUT, b"quit\n")
        self.send(rs.INPUT, b"late\n" * 1000)
        frames = frames_from(self.client, lambda f: any(k == rs.EXIT for k, _ in f))
        self.assertEqual(frames[-1], (rs.EXIT, b'{"status":3}'))
        self.wait_helper()
        self.assertRegex(self.journal(), r"closed shell .*\(exit\)")

    def terminated(self):
        return [c.split()[-1] for c in self.logind.calls() if "terminate-session" in c]

    def test_end_frame_ends_the_session_that_lives_then_hangs_up(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.send(rs.END, b'{"reason":"session_ended"}')
        self.wait_helper()
        self.assertEqual(self.terminated(), ["c9"])
        self.assertRegex(self.journal(), r"closed shell .*session c9, .*\(session_ended, session ended\)")
        self.assertTrue(Path(self.dir, "hup").exists())
        self.assertEqual(os.listdir(self.run_dir), [])

    def test_close_keeps_the_record_while_the_session_lives(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.client.shutdown(socket.SHUT_RDWR)
        self.wait_helper()
        self.assertEqual(self.terminated(), [])
        pid, session = rs.read_record(self.run_dir, SHELL)
        self.assertEqual(session, "c9")
        self.assertIsNotNone(pid)
        # The off switch then reaches it.
        self.assertEqual(rs.end_sessions(self.run_dir, os.path.join(self.dir, "proc"), self.logind), 1)
        self.assertEqual(self.terminated(), ["c9"])

    def test_end_behind_a_full_queue_is_still_seen_while_the_shell_is_busy(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"BANNER" in output(f))
        line = b"touch %s/ran\n" % self.dir.encode()
        frame = line * (64000 // len(line))
        for _ in range(6):
            self.send(rs.INPUT, frame)
        self.send(rs.END, b'{"reason":"session_ended"}')
        deadline = time.monotonic() + 3
        while "terminate-session c9" not in " ".join(self.logind.calls()) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn("terminate-session c9", " ".join(self.logind.calls()), "end waited for the busy shell")
        self.wait_helper()
        self.assertRegex(self.journal(), r"\(session_ended, session not found\)")
        time.sleep(0.5)
        self.assertFalse(Path(self.dir, "ran").exists(), "queued input ran after end")

    def test_close_behind_a_full_queue_is_still_seen_while_the_shell_is_busy(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"BANNER" in output(f))
        for _ in range(6):
            self.send(rs.INPUT, b"x" * 64000)
        started = time.monotonic()
        self.client.shutdown(socket.SHUT_RDWR)
        self.wait_helper()
        # Hang-up and its grace periods, well short of the busy shell's 30 seconds.
        self.assertLess(time.monotonic() - started, 2 * rs.HANGUP_GRACE + 3)
        self.assertRegex(self.journal(), r"closed shell .*\(client\)")

    def test_repeated_shell_id_is_refused_before_login_starts(self):
        os.makedirs(self.run_dir, mode=0o700)
        Path(self.run_dir, SHELL).write_text("4242 c1\n")
        self.send(rs.OPEN, open_body())
        frames = frames_from(self.client, lambda f: bool(f))
        self.wait_helper()
        self.assertEqual(frames, [(rs.ERROR, b'{"code":"duplicate-shell"}')])
        self.assertFalse(Path(self.dir, "started").exists())
        self.assertEqual(Path(self.run_dir, SHELL).read_text(), "4242 c1\n")

    def test_protocol_error_answers_a_fixed_code(self):
        self.send(rs.INPUT, b"rm -rf /")
        frames = frames_from(self.client, lambda f: bool(f))
        self.assertEqual(frames, [(rs.ERROR, b'{"code":"not-open"}')])
        self.wait_helper()
        self.assertFalse(os.path.exists(self.run_dir))
        self.assertIn("refused a connection: not-open", self.journal())
        self.assertNotIn("rm -rf", self.journal())

    def test_invalid_open_starts_nothing(self):
        self.send(rs.OPEN, open_body(address="10.0.0.1 -p"))
        frames = frames_from(self.client, lambda f: bool(f))
        self.assertEqual(frames, [(rs.ERROR, b'{"code":"invalid-open"}')])
        self.wait_helper()
        self.assertFalse(os.path.exists(self.run_dir))


class PeerRefusedTest(unittest.TestCase):
    def test_another_user_is_refused_before_any_frame(self):
        client, server = socket.socketpair()
        stderr = tempfile.NamedTemporaryFile()
        pid = os.fork()
        if pid == 0:
            client.close()
            os.dup2(stderr.fileno(), 2)
            try:
                rs.serve(server, os.getuid() + 1, "/nonexistent", lambda _a: ["/bin/false"])
            finally:
                os._exit(0)
        server.close()
        with client:
            client.sendall(rs.encode(rs.OPEN, open_body()))
            frames = frames_from(client, lambda f: bool(f))
        os.waitpid(pid, 0)
        self.assertEqual(frames, [(rs.ERROR, b'{"code":"peer-refused"}')])
        self.assertIn(b"refused a connection: peer-refused", Path(stderr.name).read_bytes())


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    unittest.main()
