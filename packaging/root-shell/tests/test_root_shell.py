"""Unit tests for packaging/root-shell/root-shell (docs/adr/0051-root-shell.md).

The relay tests run the helper in a forked child against a socket pair, with a
plain /bin/sh in place of `login`; nothing here needs root or touches logind.
Run: python3 -B -m unittest discover -s packaging/root-shell/tests
"""

import importlib.machinery
import importlib.util
import json
import os
import shutil
import signal
import socket
import struct
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
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.dir)

    def process(self, pid, comm, cgroup):
        os.makedirs(os.path.join(self.proc, str(pid)))
        Path(self.proc, str(pid), "comm").write_text(comm + "\n")
        Path(self.proc, str(pid), "cgroup").write_text(cgroup + "\n")

    def fake_run(self, argv, **_):
        self.calls.append(argv)
        return type("Done", (), {"returncode": 0})()

    def test_ends_recorded_login_sessions_only(self):
        self.process(10, "login", "0::/user.slice/user-0.slice/session-c4.scope")
        self.process(11, "bash", "0::/user.slice/user-0.slice/session-7.scope")
        self.process(12, "login", "0::/system.slice/portikus-root-shell@1.service")
        Path(self.run_dir, SHELL).write_text("10\n")
        Path(self.run_dir, ACTOR).write_text("11\n")
        Path(self.run_dir, "3a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d").write_text("12\n")
        Path(self.run_dir, "4a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d").write_text("99\n")
        Path(self.run_dir, "not-a-shell").write_text("10\n")
        Path(self.run_dir, "5a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d").write_text("x\n")
        self.assertEqual(rs.end_sessions(self.run_dir, self.proc, self.fake_run), 1)
        self.assertEqual(self.calls, [["loginctl", "terminate-session", "c4"]])
        self.assertEqual(os.listdir(self.run_dir), ["not-a-shell"])

    def test_no_directory(self):
        self.assertEqual(rs.end_sessions(os.path.join(self.dir, "none"), self.proc, self.fake_run), 0)


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
        # Prints its size, then echoes lines; records a hang-up in a file.
        Path(script).write_text(
            "trap 'echo hup > %s/hup; exit 129' HUP\n"
            "stty size\n"
            "while read -r line; do\n"
            "  case $line in size) stty size ;; quit) exit 3 ;; *) echo \"got:$line\" ;; esac\n"
            "done\n" % self.dir)
        self.pid = os.fork()
        if self.pid == 0:
            self.client.close()
            fd = os.open(self.stderr, os.O_WRONLY | os.O_CREAT, 0o600)
            os.dup2(fd, 2)
            signal.signal(signal.SIGTERM, rs.stop)
            ended = os.path.join(self.dir, "ended")

            # Never the real loginctl: the test runner's own logind session would end.
            def terminate(session):
                Path(ended).write_text(session)
                return True

            try:
                rs.serve(server, os.getuid(), self.run_dir, lambda _address: ["/bin/sh", script], b"BANNER\r\n",
                         session_for=lambda _pid: "c9", terminate=terminate)
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
        login_pid = int(Path(self.run_dir, SHELL).read_text())
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

    def test_end_frame_looks_for_the_session_then_hangs_up(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.send(rs.END, b'{"reason":"session_ended"}')
        self.wait_helper()
        self.assertEqual(Path(self.dir, "ended").read_text(), "c9")
        self.assertRegex(self.journal(), r"closed shell .*\(session_ended, session ended\)")
        self.assertTrue(Path(self.dir, "hup").exists())

    def test_close_without_end_leaves_the_session(self):
        self.send(rs.OPEN, open_body())
        frames_from(self.client, lambda f: b"24 80" in output(f))
        self.client.shutdown(socket.SHUT_RDWR)
        self.wait_helper()
        self.assertFalse(Path(self.dir, "ended").exists())

    def test_repeated_shell_id_keeps_the_other_shells_file(self):
        os.makedirs(self.run_dir, mode=0o700)
        Path(self.run_dir, SHELL).write_text("4242\n")
        self.send(rs.OPEN, open_body())
        self.wait_helper()
        self.assertEqual(Path(self.run_dir, SHELL).read_text(), "4242\n")

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
