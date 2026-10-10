"""Unit tests for the shared Claude Code and Codex folder: image-job's agents-update,
agents-rollback and agents-seed, and packaging/image/coding_agents.py (docs/SPEC.md section 22.4).

curl, gpgv and incus are replaced by FakeVendors, which serves made-up releases
from memory, so no test reaches the internet or the host.
Run: python3 -m unittest discover -s packaging/image/tests
"""

import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
_PATH = Path(__file__).resolve().parents[1] / "image-job"
_loader = importlib.machinery.SourceFileLoader("image_job_agents", str(_PATH))
_spec = importlib.util.spec_from_loader("image_job_agents", _loader)
ij = importlib.util.module_from_spec(_spec)
_loader.exec_module(ij)
ca = ij.coding_agents

ID = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
GOOD_STATUS = ("[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG BAA929FF1A7ECACE Anthropic\n"
               f"[GNUPG:] VALIDSIG {ca.CLAUDE_FINGERPRINT} 2026-10-01 1790872084 0 4 0 1 10 00 "
               f"{ca.CLAUDE_FINGERPRINT}\n")
# Any fingerprint but the pinned one.
OTHER_KEY = ca.CLAUDE_FINGERPRINT[::-1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tar_bytes(entries):
    """entries: (name, type, mode, data) with type one of tarfile's type flags."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, kind, mode, data in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.mode = mode
            info.uid = info.gid = 1001
            if kind == tarfile.REGTYPE:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = data
                tar.addfile(info)
    return out.getvalue()


def codex_entries(version):
    return [
        ("bin", tarfile.DIRTYPE, 0o755, None),
        ("bin/codex", tarfile.REGTYPE, 0o755, f"codex {version}".encode()),
        ("codex-path", tarfile.DIRTYPE, 0o755, None),
        ("codex-path/rg", tarfile.REGTYPE, 0o755, b"rg"),
        ("codex-resources", tarfile.DIRTYPE, 0o755, None),
        ("codex-resources/bwrap", tarfile.REGTYPE, 0o755, b"bwrap"),
        ("codex-package.json", tarfile.REGTYPE, 0o644, b"{}"),
    ]


class FakeVendors:
    """Plays curl (Claude Code's bucket and GitHub), gpgv and incus, recording each command."""

    def __init__(self):
        self.calls = []
        self.urls = {}
        self.gpgv = (0, GOOD_STATUS)
        self.aliases = {"portikus": "f" * 64}
        self.instances = set()
        self.unhealthy = set()
        self.launch_rc = 0
        # How many times systemctl answers nothing, as it does before systemd is up.
        self.booting = 0

    def publish_claude(self, version, binary=None, manifest_sha=None):
        binary = binary if binary is not None else f"claude {version}".encode()
        base = f"{ca.CLAUDE_BASE}/{version}"
        manifest = {"version": version, "platforms": {"linux-x64": {
            "binary": "claude", "checksum": manifest_sha or sha(binary), "size": len(binary)}}}
        self.urls[f"{ca.CLAUDE_BASE}/stable"] = f"{version}\n".encode()
        self.urls[f"{base}/manifest.json"] = json.dumps(manifest).encode()
        self.urls[f"{base}/manifest.json.sig"] = b"signature"
        self.urls[f"{base}/linux-x64/claude"] = binary
        return binary

    def publish_codex(self, version, entries=None, digest=None, sums_sha=None, served=None):
        package = tar_bytes(entries if entries is not None else codex_entries(version))
        base = f"{ca.CODEX_DOWNLOAD}/rust-v{version}"
        self.urls[ca.CODEX_LATEST] = json.dumps({"tag_name": f"rust-v{version}", "assets": [
            {"name": ca.CODEX_ASSET, "digest": f"sha256:{digest or sha(package)}"},
            {"name": ca.CODEX_SUMS, "digest": "sha256:" + "0" * 64},
        ]}).encode()
        # The real file lists the package twice, the same way both times.
        line = f"{sums_sha or sha(package)}  {ca.CODEX_ASSET}\n"
        self.urls[f"{base}/{ca.CODEX_SUMS}"] = (f"{'1' * 64}  other.tar.gz\n" + line + line).encode()
        self.urls[f"{base}/{ca.CODEX_ASSET}"] = served if served is not None else package
        return package

    def ran(self, word):
        return [c for c in self.calls if word in c]

    def downloads(self):
        return [c[-1] for c in self.calls if c[0] == "curl"]

    def __call__(self, argv, log=None, capture=False, timeout=None, env=None):
        self.calls.append(list(argv))
        tool = argv[0]
        if tool == "curl":
            dest, url = argv[argv.index("--output") + 1], argv[-1]
            if url not in self.urls:
                return 22, ""
            Path(dest).write_bytes(self.urls[url])
            return 0, ""
        if tool == "gpgv":
            return self.gpgv
        if tool == "incus":
            return self.incus(argv[3:])
        raise AssertionError(f"unexpected command {argv}")

    def incus(self, args):
        if args[:3] == ["image", "alias", "list"]:
            return 0, json.dumps([{"name": n, "target": t} for n, t in self.aliases.items()])
        if args[:1] == ["list"]:
            return 0, json.dumps([{"name": n} for n in sorted(self.instances)])
        if args[:1] == ["launch"]:
            if self.launch_rc == 0:
                self.instances.add(args[2])
            return self.launch_rc, ""
        if args[:1] == ["delete"]:
            self.instances.discard(args[-1])
            return 0, ""
        if args[:1] == ["exec"]:
            cmd = args[args.index("--") + 1:]
            if cmd[0] == "systemctl":
                if self.booting:
                    self.booting -= 1
                    return 1, ""
                return 0, "running\n"
            if self.booting:
                raise AssertionError("a check ran before the container finished booting")
            if cmd[0] == "env":
                tool, version = cmd[1].split("=")[1].split(":")[0].split("/")[-2:]
                return (1, "browser\n") if tool in self.unhealthy else (0, "paste-code\n")
            parts = cmd[0].split("/")
            tool, version = parts[4], parts[5]
            if tool in self.unhealthy:
                return 127, ""
            return 0, (f"{version} (Claude Code)\n" if tool == "claude" else f"codex-cli {version}\n")
        raise AssertionError(f"unexpected incus {args}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.jobs, self.images, self.store, self.proc = (root / n for n in ("jobs", "images", "agents", "proc"))
        for d in (self.jobs, self.images, self.proc):
            d.mkdir()
        self.lock = root / "lock"
        self.host = FakeVendors()
        self._run = ij.run
        ij.run = self.host
        self.journal = []
        self._journal = ij.journal
        ij.journal = self.journal.append
        self._free = ca.free_bytes
        ca.free_bytes = lambda path: 10 * 1024 ** 3
        self.runner = ij.Runner(str(self.jobs), str(self.images), str(root / "recipe"), "/keyring.gpg",
                                sleep=lambda s: None, agents_dir=str(self.store),
                                agents_keyring="/claude-code.gpg", proc_dir=str(self.proc))

    def tearDown(self):
        ij.run = self._run
        ij.journal = self._journal
        ca.free_bytes = self._free
        self.tmp.cleanup()

    def request(self, request, job_id=ID):
        doc = {"id": job_id, "requestedAt": "2026-10-10T12:00:00.000Z", "requestedBy": USER, "request": request}
        (self.jobs / f"request-{job_id}.json").write_text(json.dumps(doc))

    def go(self, request):
        self.request(request)
        self.assertEqual(self.runner.run_pending(str(self.lock)), 0)
        return json.loads((self.jobs / ID / "status.json").read_text())

    def install(self, tool, version, current=False, previous=False):
        """A version folder as a job leaves it, optionally linked as current or previous."""
        folder = self.store / tool / version
        entry = folder / ca.ENTRY[tool]
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_bytes(f"{tool} {version}".encode())
        for name, wanted in (("current", current), ("previous", previous)):
            if wanted:
                link = self.store / tool / name
                if link.is_symlink():
                    link.unlink()
                link.symlink_to(version)
        return entry

    def link(self, tool, name):
        path = self.store / tool / name
        return os.readlink(path) if path.is_symlink() else None

    def state_file(self):
        return json.loads((self.images / "coding-agents.json").read_text())


class ValidationTest(unittest.TestCase):
    def doc(self, request):
        return json.dumps({"id": ID, "requestedAt": "2026-10-10T12:00:00.000Z", "requestedBy": USER,
                           "request": request}).encode()

    def test_the_two_kinds_pass_with_exactly_their_fields(self):
        for request in ({"kind": "agents-update"}, {"kind": "agents-rollback", "tool": "claude"},
                        {"kind": "agents-rollback", "tool": "codex"}):
            with self.subTest(request=request):
                self.assertEqual(ij.validate_request(self.doc(request), ID)["request"], request)

    def test_versions_urls_and_unknown_tools_are_refused(self):
        for request in (
            {"kind": "agents-update", "version": "2.1.287"},
            {"kind": "agents-update", "url": "https://example.com/claude"},
            {"kind": "agents-update", "tool": "claude"},
            {"kind": "agents-rollback"},
            {"kind": "agents-rollback", "tool": "claude", "version": "2.1.287"},
            {"kind": "agents-rollback", "tool": "Claude"},
            {"kind": "agents-rollback", "tool": "node"},
            {"kind": "agents-rollback", "tool": "claude "},
            {"kind": "agents-rollback", "tool": None},
            {"kind": "agents-rollback", "tool": ["claude"]},
            {"kind": "agents_update"},
        ):
            with self.subTest(request=request):
                with self.assertRaises(ij.Refused):
                    ij.validate_request(self.doc(request), ID)


class UpdateTest(Base):
    def test_both_tools_are_verified_checked_and_switched(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        status = self.go({"kind": "agents-update"})
        self.assertEqual((status["state"], status["kind"], status["version"]),
                         ("succeeded", "agents-update", None))
        self.assertEqual(status["message"], "Claude Code switched to 2.1.300. Codex switched to 0.163.0.")
        for tool, new, old in (("claude", "2.1.300", "2.1.287"), ("codex", "0.163.0", "0.162.1")):
            self.assertEqual((self.link(tool, "current"), self.link(tool, "previous")), (new, old))
        self.assertEqual(os.readlink(self.store / "bin" / "claude"), "../claude/current/claude")
        self.assertEqual(os.readlink(self.store / "bin" / "codex"), "../codex/current/bin/codex")
        self.assertEqual((self.store / "bin" / "claude").read_bytes(), b"claude 2.1.300")
        self.assertEqual((self.store / "bin" / "codex").read_bytes(), b"codex 0.163.0")
        self.assertEqual(stat.S_IMODE(os.stat(self.store / "claude" / "2.1.300" / "claude").st_mode), 0o755)
        self.assertEqual(self.state_file()["claude"],
                         {"current": "2.1.300", "previous": "2.1.287", "kept": ["2.1.300", "2.1.287"]})
        self.assertEqual(self.state_file()["codex"]["current"], "0.163.0")
        self.assertEqual([p.name for p in self.store.iterdir() if p.name.startswith(".")], [])
        # Signed manifest, then the binary it names; GitHub's digest, then the release's checksum file.
        self.assertEqual(self.host.ran("gpgv")[0][:5],
                         ["gpgv", "--status-fd", "1", "--keyring", "/claude-code.gpg"])
        self.assertIn(f"{ca.CODEX_DOWNLOAD}/rust-v0.163.0/{ca.CODEX_ASSET}", self.host.downloads())

    def test_the_health_check_runs_each_candidate_by_path_as_the_student(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.go({"kind": "agents-update"})
        launches = self.host.ran("launch")
        self.assertEqual(len(launches), 1)
        self.assertEqual(launches[0][3:5], ["launch", "portikus"])
        self.assertEqual(launches[0][6:], ["--profile", "workspace"])
        self.assertRegex(launches[0][5], r"^imgcheck-[0-9a-f]{8}$")
        student = [c for c in self.host.ran("exec") if "--user" in c]
        commands = [c[c.index("--", 6) + 1:] for c in student]
        self.assertIn(["/opt/portikus/coding-agents/claude/2.1.300/claude", "--version"], commands)
        self.assertIn(["/opt/portikus/coding-agents/codex/0.163.0/bin/codex", "--version"], commands)
        login = [c for c in commands if c[0] == "env"][0]
        self.assertEqual(login[1], "PATH=/opt/portikus/coding-agents/claude/2.1.300:/usr/local/bin:/usr/bin:/bin")
        self.assertEqual(login[4], ij.CLAUDE_LOGIN_CHECK)
        for c in student:
            self.assertEqual(c[c.index("--user") + 1], "1000")
            self.assertEqual(c[c.index("--group") + 1], "1000")
        self.assertEqual(self.host.instances, set())

    def test_the_checks_wait_until_systemd_answers(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.booting = 3
        self.assertEqual(self.go({"kind": "agents-update"})["state"], "succeeded")
        self.assertEqual(len([c for c in self.host.ran("exec") if "systemctl" in c]), 4)

    def test_a_container_that_never_boots_fails_within_one_deadline(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.booting = 10 ** 6
        now = [0.0]
        self.runner.sleep = lambda s: now.__setitem__(0, now[0] + s + 10)
        with mock.patch.object(ij.time, "monotonic", lambda: now[0]):
            status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertIn("boot the container", status["message"])
        self.assertLess(len([c for c in self.host.ran("exec") if "systemctl" in c]), 40)
        self.assertEqual(self.host.instances, set())

    def test_a_tool_already_current_is_not_downloaded_again(self):
        self.install("claude", "2.1.300", current=True)
        self.install("codex", "0.163.0", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "succeeded")
        self.assertEqual(status["message"], "Claude Code is already at 2.1.300. Codex is already at 0.163.0.")
        self.assertEqual(self.host.downloads(), [f"{ca.CLAUDE_BASE}/stable", ca.CODEX_LATEST])
        self.assertEqual(self.host.ran("launch"), [])

    def test_an_older_offered_version_is_never_installed(self):
        # The stable pointer is unsigned, so an older signed release must not count as an update.
        self.install("claude", "2.1.300", current=True)
        self.install("codex", "0.163.0", current=True)
        self.host.publish_claude("2.1.299")
        self.host.publish_codex("0.99.9")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "succeeded")
        self.assertEqual(status["message"],
                         "Claude Code was left at 2.1.300: the vendor offered 2.1.299, which is older. "
                         "Codex was left at 0.163.0: the vendor offered 0.99.9, which is older.")
        self.assertEqual((self.link("claude", "current"), self.link("codex", "current")), ("2.1.300", "0.163.0"))
        self.assertEqual(ca.versions(str(self.store), "claude"), ["2.1.300"])
        self.assertEqual(self.host.downloads(), [f"{ca.CLAUDE_BASE}/stable", ca.CODEX_LATEST])
        self.assertEqual(self.host.ran("launch"), [])

    def test_an_older_kept_version_is_not_switched_back_to(self):
        self.install("claude", "2.1.287", previous=True)
        self.install("claude", "2.1.300", current=True)
        self.install("codex", "0.163.0", current=True)
        self.host.publish_claude("2.1.287")
        self.host.publish_codex("0.163.0")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "succeeded")
        self.assertEqual((self.link("claude", "current"), self.link("claude", "previous")), ("2.1.300", "2.1.287"))
        self.assertEqual(self.host.ran("launch"), [])

    def test_a_kept_version_is_checked_again_and_reused(self):
        self.install("claude", "2.1.300")
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.163.0", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "succeeded")
        self.assertNotIn(f"{ca.CLAUDE_BASE}/2.1.300/linux-x64/claude", self.host.downloads())
        self.assertEqual(len(self.host.ran("launch")), 1)
        self.assertEqual(self.link("claude", "current"), "2.1.300")

    def test_a_failed_kept_version_is_not_deleted(self):
        self.install("claude", "2.1.300")
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.163.0", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.unhealthy = {"claude"}
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertTrue((self.store / "claude" / "2.1.300").is_dir())
        self.assertEqual(self.link("claude", "current"), "2.1.287")

    def test_one_tool_failing_its_check_leaves_it_and_switches_the_other(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.unhealthy = {"claude"}
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["message"],
                         "Claude Code 2.1.300 failed its health check (claude --version, claude login flow) "
                         "and was not switched. Codex switched to 0.163.0.")
        self.assertEqual(self.link("claude", "current"), "2.1.287")
        self.assertIsNone(self.link("claude", "previous"))
        self.assertFalse((self.store / "claude" / "2.1.300").exists())
        self.assertEqual(self.link("codex", "current"), "0.163.0")
        self.assertEqual(self.state_file()["claude"]["kept"], ["2.1.287"])

    def assert_staging_error_switches_the_other(self, bad, good, err):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        with mock.patch.object(self.runner, f"stage_{bad}", side_effect=err):
            status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertIn(f"was not switched. {err}", status["message"])
        self.assertIsNone(self.link(bad, "previous"))
        self.assertEqual(self.link(good, "current"), {"claude": "2.1.300", "codex": "0.163.0"}[good])

    def test_an_os_error_staging_claude_still_switches_codex(self):
        self.assert_staging_error_switches_the_other("claude", "codex", OSError("disk full"))

    def test_a_tar_error_staging_codex_still_switches_claude(self):
        self.assert_staging_error_switches_the_other("codex", "claude", tarfile.TarError("truncated"))

    def test_a_container_that_cannot_start_switches_nothing(self):
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.162.1", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.launch_rc = 1
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertIn("start a container", status["message"])
        self.assertEqual((self.link("claude", "current"), self.link("codex", "current")), ("2.1.287", "0.162.1"))
        self.assertEqual(sorted(p.name for p in (self.store / "codex").iterdir()), ["0.162.1", "current"])

    def assert_nothing_installed(self, tool, version, message):
        status = json.loads((self.jobs / ID / "status.json").read_text())
        self.assertEqual(status["state"], "failed")
        self.assertIn(message, status["message"])
        self.assertFalse((self.store / tool / version).exists())
        self.assertEqual([p.name for p in self.store.iterdir() if p.name.startswith(".")], [])

    def test_a_bad_signature_leaves_claude_uninstalled_and_codex_switches(self):
        self.install("claude", "2.1.287", current=True)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.gpgv = (1, "[GNUPG:] BADSIG BAA929FF1A7ECACE\n")
        status = self.go({"kind": "agents-update"})
        self.assert_nothing_installed("claude", "2.1.300", "signature does not verify")
        self.assertNotIn(f"{ca.CLAUDE_BASE}/2.1.300/linux-x64/claude", self.host.downloads())
        self.assertIn("Codex switched to 0.163.0.", status["message"])
        self.assertEqual(self.link("claude", "current"), "2.1.287")

    def test_a_good_signature_from_another_key_is_refused(self):
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.host.gpgv = (0, GOOD_STATUS.replace(ca.CLAUDE_FINGERPRINT, OTHER_KEY))
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("claude", "2.1.300", "signature does not verify")

    def test_a_claude_binary_that_does_not_match_the_manifest_is_not_installed(self):
        self.host.publish_claude("2.1.300", manifest_sha="a" * 64)
        self.host.publish_codex("0.163.0")
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("claude", "2.1.300", "Claude Code binary's checksum does not match")

    def test_a_manifest_for_another_version_is_not_trusted(self):
        self.host.publish_claude("2.1.300")
        self.host.urls[f"{ca.CLAUDE_BASE}/stable"] = b"2.1.301\n"
        self.host.urls[f"{ca.CLAUDE_BASE}/2.1.301/manifest.json"] = \
            self.host.urls[f"{ca.CLAUDE_BASE}/2.1.300/manifest.json"]
        self.host.urls[f"{ca.CLAUDE_BASE}/2.1.301/manifest.json.sig"] = b"signature"
        self.host.publish_codex("0.163.0")
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("claude", "2.1.301", "names a different version")

    def test_a_malformed_stable_channel_is_refused(self):
        for text in (b"../2.1.300\n", b"2.1.300-beta\n", b"<html>\n", b""):
            with self.subTest(text=text):
                with self.assertRaises(ca.AgentError):
                    ca.claude_stable_version(text.decode())

    def test_a_codex_digest_that_disagrees_with_the_checksum_file_installs_nothing(self):
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0", sums_sha="b" * 64)
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("codex", "0.163.0", "does not match its checksum file")
        self.assertNotIn(f"{ca.CODEX_DOWNLOAD}/rust-v0.163.0/{ca.CODEX_ASSET}", self.host.downloads())

    def test_a_codex_package_that_does_not_match_its_digest_installs_nothing(self):
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0", served=b"tampered")
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("codex", "0.163.0", "Codex package's checksum does not match")

    def test_a_codex_package_with_a_link_installs_nothing(self):
        self.host.publish_claude("2.1.300")
        entries = codex_entries("0.163.0") + [("codex-path/sh", tarfile.SYMTYPE, 0o777, "/bin/sh")]
        self.host.publish_codex("0.163.0", entries=entries)
        self.go({"kind": "agents-update"})
        self.assert_nothing_installed("codex", "0.163.0", "link or special file")

    def test_codex_tags_that_are_not_plain_versions_are_refused(self):
        for tag in ("v0.163.0", "rust-v0.163.0-alpha.1", "rust-v../0.163.0", "rust-v0.163"):
            with self.subTest(tag=tag):
                listing = json.dumps({"tag_name": tag, "assets": [
                    {"name": ca.CODEX_ASSET, "digest": "sha256:" + "a" * 64}, {"name": ca.CODEX_SUMS}]})
                with self.assertRaises(ca.AgentError):
                    ca.codex_release(listing)

    def test_a_checksum_file_listing_the_package_two_ways_is_refused(self):
        text = f"{'a' * 64}  {ca.CODEX_ASSET}\n{'b' * 64}  {ca.CODEX_ASSET}\n"
        with self.assertRaises(ca.AgentError):
            ca.codex_sums_sha(text)

    def test_too_little_disk_space_is_refused_before_any_download(self):
        ca.free_bytes = lambda path: 2 * 1024 ** 3 - 1
        self.host.publish_claude("2.1.300")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "refused")
        self.assertIn("2 GiB", status["message"])
        self.assertEqual(self.host.downloads(), [])

    def test_a_host_with_no_default_image_is_refused(self):
        self.host.aliases = {}
        self.host.publish_claude("2.1.300")
        status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "refused")
        self.assertIn("no default workspace image", status["message"])
        self.assertEqual(self.host.downloads(), [])

    def test_the_update_prunes_but_keeps_a_version_in_use(self):
        old = self.install("claude", "2.1.1")
        for version in ("2.1.2", "2.1.3"):
            self.install("claude", version)
        self.install("claude", "2.1.287", current=True)
        self.install("codex", "0.163.0", current=True)
        (self.proc / "4242").mkdir()
        (self.proc / "4242" / "exe").symlink_to(old)
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        self.assertEqual(self.go({"kind": "agents-update"})["state"], "succeeded")
        self.assertEqual(ca.versions(str(self.store), "claude"), ["2.1.300", "2.1.287", "2.1.3", "2.1.1"])


class UnpackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dest = self.root / "dest"
        self.dest.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def unpack(self, entries):
        archive = self.root / "a.tar.gz"
        archive.write_bytes(tar_bytes(entries))
        ca.unpack(str(archive), str(self.dest))

    def test_unsafe_members_are_refused_and_nothing_is_written(self):
        good = [("bin", tarfile.DIRTYPE, 0o755, None), ("bin/codex", tarfile.REGTYPE, 0o755, b"x")]
        for bad in (
            ("bin/sh", tarfile.SYMTYPE, 0o777, "/bin/sh"),
            ("bin/rel", tarfile.SYMTYPE, 0o777, "../../etc/passwd"),
            ("bin/hard", tarfile.LNKTYPE, 0o644, "bin/codex"),
            ("/etc/cron.d/x", tarfile.REGTYPE, 0o644, b"x"),
            ("../escape", tarfile.REGTYPE, 0o644, b"x"),
            ("bin/../../escape", tarfile.REGTYPE, 0o644, b"x"),
            ("bin/null", tarfile.CHRTYPE, 0o666, None),
            ("bin/disk", tarfile.BLKTYPE, 0o666, None),
            ("bin/fifo", tarfile.FIFOTYPE, 0o666, None),
            ("bin/suid", tarfile.REGTYPE, 0o4755, b"x"),
            ("bin/sgid", tarfile.REGTYPE, 0o2755, b"x"),
        ):
            with self.subTest(member=bad[0], kind=bad[1]):
                with self.assertRaises(ca.AgentError):
                    self.unpack(good + [bad])
                self.assertEqual(list(self.dest.iterdir()), [])

    def test_member_and_size_caps(self):
        with mock.patch.object(ca, "MAX_MEMBERS", 3):
            with self.assertRaises(ca.AgentError):
                self.unpack([(f"f{i}", tarfile.REGTYPE, 0o644, b"x") for i in range(4)])
        with mock.patch.object(ca, "UNPACKED_MAX_BYTES", 10):
            with self.assertRaises(ca.AgentError):
                self.unpack([("a", tarfile.REGTYPE, 0o644, b"123456"), ("b", tarfile.REGTYPE, 0o644, b"123456")])
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_modes_and_owners_are_normalised(self):
        chowned = []
        with mock.patch("os.geteuid", return_value=0), \
                mock.patch("os.lchown", side_effect=lambda p, u, g: chowned.append((p, u, g))):
            self.unpack([
                ("bin", tarfile.DIRTYPE, 0o700, None),
                ("bin/codex", tarfile.REGTYPE, 0o700, b"x"),
                ("bin/open", tarfile.REGTYPE, 0o777, b"x"),
                ("bin/readable", tarfile.REGTYPE, 0o555, b"x"),
                ("notes.md", tarfile.REGTYPE, 0o600, b"x"),
                ("data.json", tarfile.REGTYPE, 0o666, b"x"),
            ])
        modes = {str(p.relative_to(self.dest)): stat.S_IMODE(p.stat().st_mode) for p in self.dest.rglob("*")}
        self.assertEqual(modes, {"bin": 0o755, "bin/codex": 0o755, "bin/open": 0o755, "bin/readable": 0o755,
                                 "notes.md": 0o644, "data.json": 0o644})
        self.assertEqual(stat.S_IMODE(self.dest.stat().st_mode), 0o755)
        self.assertEqual(sorted(p for p, _, _ in chowned),
                         sorted([str(p) for p in self.dest.rglob("*")] + [str(self.dest)]))
        self.assertTrue(all((u, g) == (0, 0) for _, u, g in chowned))


class FolderTest(Base):
    def test_a_switch_renames_a_new_relative_link_over_the_old_one(self):
        self.install("claude", "2.1.287", current=True)
        self.install("claude", "2.1.300")
        real_replace = os.replace
        seen = []

        def replace(src, dst):
            # The old link is still there at the moment the new one replaces it.
            seen.append((os.path.basename(src), os.path.basename(dst), os.path.lexists(dst), os.readlink(src)))
            real_replace(src, dst)

        with mock.patch("os.replace", side_effect=replace):
            ca.switch(str(self.store), "claude", "2.1.300")
        self.assertEqual([(d, existed, target) for _, d, existed, target in seen],
                         [("previous", False, "2.1.287"), ("current", True, "2.1.300")])
        self.assertTrue(all(src.startswith(".link-") for src, _, _, _ in seen))
        self.assertEqual(sorted(p.name for p in (self.store / "claude").iterdir()),
                         ["2.1.287", "2.1.300", "current", "previous"])

    def test_rollback_swaps_current_and_previous(self):
        self.install("claude", "2.1.287", previous=True)
        self.install("claude", "2.1.300", current=True)
        self.install("codex", "0.163.0", current=True)
        status = self.go({"kind": "agents-rollback", "tool": "claude"})
        self.assertEqual((status["state"], status["message"]), ("succeeded", "Claude Code switched back to 2.1.287."))
        self.assertEqual((self.link("claude", "current"), self.link("claude", "previous")), ("2.1.287", "2.1.300"))
        self.assertEqual(self.link("codex", "current"), "0.163.0")
        self.assertEqual(self.state_file()["claude"]["current"], "2.1.287")
        # No download and no health check: the previous version ran before.
        self.assertEqual((self.host.downloads(), self.host.ran("launch")), ([], []))

    def test_rollback_with_no_previous_is_refused(self):
        self.install("codex", "0.163.0", current=True)
        status = self.go({"kind": "agents-rollback", "tool": "codex"})
        self.assertEqual(status["state"], "refused")
        self.assertIn("Codex has no previous version", status["message"])
        self.assertEqual(self.link("codex", "current"), "0.163.0")

    def test_prune_keeps_three_and_never_current_previous_or_in_use(self):
        for version in ("2.1.1", "2.1.2", "2.1.3", "2.1.4"):
            self.install("claude", version)
        in_use = self.install("claude", "2.1.2")
        self.install("claude", "2.1.5", previous=True)
        self.install("claude", "2.1.6", current=True)
        (self.proc / "77").mkdir()
        (self.proc / "77" / "exe").symlink_to(in_use)
        (self.proc / "self").mkdir()
        (self.proc / "78").mkdir()  # a process that ended: no exe
        running = ca.running_files(str(self.proc))
        self.assertEqual(ca.prune(str(self.store), "claude", running), [("2.1.3", False), ("2.1.1", False)])
        self.assertEqual(ca.versions(str(self.store), "claude"), ["2.1.6", "2.1.5", "2.1.4", "2.1.2"])

    def test_prune_never_removes_an_old_current_or_previous(self):
        self.install("codex", "0.1.1", current=True)
        self.install("codex", "0.1.2", previous=True)
        for version in ("0.1.3", "0.1.4", "0.1.5"):
            self.install("codex", version)
        self.assertEqual(ca.prune(str(self.store), "codex", set()), [("0.1.4", False), ("0.1.3", False)])
        self.assertEqual(ca.versions(str(self.store), "codex"), ["0.1.5", "0.1.2", "0.1.1"])

    def test_versions_in_use_are_capped_at_five_folders(self):
        # A student running old binaries must not grow the folder without limit.
        running = set()
        for version in ("2.1.1", "2.1.2", "2.1.3", "2.1.4", "2.1.5", "2.1.6"):
            st = os.stat(self.install("claude", version))
            running.add((st.st_dev, st.st_ino))
        self.install("claude", "2.1.7", previous=True)
        self.install("claude", "2.1.8", current=True)
        # Previous is old too and must survive even at the cap.
        self.install("codex", "0.1.1", previous=True)
        self.install("codex", "0.1.9", current=True)
        removed = ca.prune(str(self.store), "claude", running)
        self.assertEqual(removed, [("2.1.1", True), ("2.1.2", True), ("2.1.3", True)])
        self.assertEqual(ca.versions(str(self.store), "claude"), ["2.1.8", "2.1.7", "2.1.6", "2.1.5", "2.1.4"])

    def test_recover_removes_staging_and_leaves_versions(self):
        self.install("claude", "2.1.287", current=True)
        staging = self.store / f".staging-{ID}" / "codex-0.163.0" / "bin"
        staging.mkdir(parents=True)
        (staging / "codex").write_bytes(b"half")
        (self.store / ".staging-seed-0a1b2c3d").mkdir()
        self.assertEqual(self.runner.run_recover(str(self.lock)), 0)
        self.assertEqual(sorted(p.name for p in self.store.iterdir()), ["claude"])
        self.assertEqual(self.link("claude", "current"), "2.1.287")

    def test_a_stopped_update_leaves_no_staging(self):
        self.host.publish_claude("2.1.300")
        self.host.publish_codex("0.163.0")
        with mock.patch.object(ij, "agents_health_check", side_effect=RuntimeError("boom")):
            status = self.go({"kind": "agents-update"})
        self.assertEqual(status["state"], "failed")
        self.assertEqual([p.name for p in self.store.iterdir() if p.name.startswith(".")], [])
        self.assertEqual(self.link("claude", "current"), None)


class SeedTest(Base):
    def setUp(self):
        super().setUp()
        self.claude_binary = b"claude seed"
        self.codex_package = tar_bytes(codex_entries("0.162.1"))
        self.host.urls[f"{ca.CLAUDE_BASE}/2.1.287/linux-x64/claude"] = self.claude_binary
        self.host.urls[f"{ca.CODEX_DOWNLOAD}/rust-v0.162.1/{ca.CODEX_ASSET}"] = self.codex_package
        self._seed = ca.SEED
        ca.SEED = {"claude": ("2.1.287", sha(self.claude_binary)), "codex": ("0.162.1", sha(self.codex_package))}

    def tearDown(self):
        ca.SEED = self._seed
        super().tearDown()

    def seed(self):
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            code = self.runner.run_agents_seed(str(self.lock))
        return code, out.getvalue().strip()

    def test_the_real_pins_are_well_formed(self):
        for tool, (version, pin) in self._seed.items():
            self.assertRegex(version, ca.VERSION_RE)
            self.assertRegex(pin, ca.SHA256_RE)

    def test_seed_installs_the_pins_once(self):
        self.assertEqual(self.seed(), (0, "changed"))
        self.assertEqual((self.link("claude", "current"), self.link("codex", "current")), ("2.1.287", "0.162.1"))
        self.assertEqual((self.store / "bin" / "claude").read_bytes(), self.claude_binary)
        self.assertEqual((self.store / "bin" / "codex").read_bytes(), b"codex 0.162.1")
        self.assertEqual(self.state_file()["codex"], {"current": "0.162.1", "previous": None, "kept": ["0.162.1"]})
        self.assertEqual([p.name for p in self.store.iterdir() if p.name.startswith(".")], [])
        self.assertEqual(self.host.ran("gpgv"), [])
        self.host.calls.clear()
        self.assertEqual(self.seed(), (0, "unchanged"))
        self.assertEqual(self.host.calls, [])

    def test_seed_leaves_a_tool_that_has_a_current_version(self):
        self.install("claude", "2.1.300", current=True)
        self.assertEqual(self.seed(), (0, "changed"))
        self.assertEqual(self.link("claude", "current"), "2.1.300")
        self.assertEqual(self.host.downloads(), [f"{ca.CODEX_DOWNLOAD}/rust-v0.162.1/{ca.CODEX_ASSET}"])

    def test_seed_refuses_a_download_that_does_not_match_its_pin(self):
        self.host.urls[f"{ca.CLAUDE_BASE}/2.1.287/linux-x64/claude"] = b"something else"
        self.assertEqual(self.seed()[0], 1)
        self.assertFalse((self.store / "claude" / "2.1.287").exists())
        self.assertIsNone(self.link("claude", "current"))
        self.assertTrue([m for m in self.journal if "checksum does not match" in m])

    def test_seed_refuses_with_too_little_disk_space(self):
        ca.free_bytes = lambda path: 1024 ** 3
        self.assertEqual(self.seed()[0], 1)
        self.assertEqual(self.host.downloads(), [])


if __name__ == "__main__":
    unittest.main()
