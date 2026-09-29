"""Unit tests for packaging/image/image-job (docs/SPEC.md section 22.4, ADR 0030).

incus, curl, gpgv, distrobuilder and the rootfs tools are replaced by FakeHost,
which records every command, so no test touches the host.
Run: python3 -m unittest discover -s packaging/image/tests
"""

import contextlib
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
_PATH = Path(__file__).resolve().parents[1] / "image-job"
_loader = importlib.machinery.SourceFileLoader("image_job", str(_PATH))
_spec = importlib.util.spec_from_loader("image_job", _loader)
ij = importlib.util.module_from_spec(_spec)
_loader.exec_module(ij)

ID = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
ID2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
FP = {v: hashlib.sha256(v.encode()).hexdigest() for v in (
    "2026.09.10", "2026.09.11", "2026.09.12", "2026.09.13", "2026.09.14",
    "2026.09.12-local.202609280900", "2026.09.12-local.202609281000",
)}


def manifest_for(version, source="published", node="24", python="debian"):
    return {
        "schema": 1, "version": version, "recipeVersion": version.split("-")[0], "source": source,
        "builtAt": "2026-09-28T10:00:00Z", "fingerprint": None,
        "parameters": {"node": node, "python": python},
        "tools": {t: f"{t} 1.0" for t in ij.TOOLS},
        "packages": {"curl": "8.14.1-2", "git": "1:2.47.3-0"},
    }


class FakeHost:
    """Plays incus, curl, gpgv, distrobuilder and the rootfs tools, recording each command."""

    def __init__(self):
        self.calls = []
        self.aliases = {}
        self.instances = set()
        self.urls = {}
        self.gpgv_rc = 0
        self.exec_results = {}
        self.distrobuilder_rc = 0
        self.chroot_rc = 0
        self.dev_link = False

    def publish(self, version, corrupt=None, manifest=None):
        base = f"{ij.DEFAULT_BASE_URL}/image-{version}"
        files = {
            "incus.tar.xz": f"meta {version}".encode(),
            "rootfs.squashfs": f"rootfs {version}".encode(),
            "manifest.json": json.dumps(manifest or manifest_for(version)).encode(),
        }
        sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items())
        if corrupt:
            files[corrupt] = b"tampered"
        for name, data in files.items():
            self.urls[f"{base}/{name}"] = data
        self.urls[f"{base}/SHA256SUMS"] = sums.encode()
        self.urls[f"{base}/SHA256SUMS.asc"] = b"signature"

    def names(self):
        return [" ".join(c) for c in self.calls]

    def ran(self, word):
        return [c for c in self.calls if word in c]

    def __call__(self, argv, log=None, capture=False, timeout=None, env=None):
        self.calls.append(list(argv))
        tool = argv[0]
        if tool == "incus":
            return self.incus(argv[1:])
        if tool == "curl":
            dest, url = argv[argv.index("--output") + 1], argv[-1]
            if url not in self.urls:
                return 22, ""
            Path(dest).write_bytes(self.urls[url])
            return 0, ""
        if tool == "gpgv":
            return self.gpgv_rc, ""
        if tool == "distrobuilder":
            self.env = env
            out = Path(argv[3])
            if self.distrobuilder_rc == 0:
                out.mkdir(parents=True)
                (out / "incus.tar.xz").write_bytes(b"meta")
                (out / "rootfs.squashfs").write_bytes(env["PORTIKUS_IMAGE_VERSION"].encode())
            return self.distrobuilder_rc, ""
        if tool == "unsquashfs":
            root = Path(argv[argv.index("-d") + 1])
            (root / "proc").mkdir(parents=True)
            if self.dev_link:
                (root / "dev").symlink_to("/dev")
            else:
                (root / "dev").mkdir()
            return 0, ""
        if tool == "dpkg-query":
            return 0, "curl\t8.14.1-2\nlibc6:amd64\t2.41-12\n"
        if tool in ("mount", "umount", "mknod"):
            return 0, ""
        if tool == "chroot":
            return self.chroot_rc, f"{argv[-2]} version 9.9\n"
        raise AssertionError(f"unexpected command {argv}")

    def incus(self, args):
        if args[:2] == ["--project", "portikus"]:
            args = args[2:]
        if args[:3] == ["image", "alias", "list"]:
            return 0, json.dumps([{"name": n, "target": t} for n, t in self.aliases.items()])
        if args[:2] == ["image", "import"]:
            name = args[args.index("--alias") + 1]
            self.aliases[name] = FP.get(name[len("portikus-"):]) or hashlib.sha256(name.encode()).hexdigest()
            return 0, ""
        if args[:2] == ["image", "delete"]:
            fp = self.aliases[args[2]]
            self.aliases = {n: t for n, t in self.aliases.items() if t != fp}
            return 0, ""
        if args[:3] == ["image", "alias", "create"]:
            self.aliases[args[3]] = args[4]
            return 0, ""
        if args[:3] == ["query", "-X", "PUT"]:
            name = args[-1].split("/")[-1].split("?")[0]
            self.aliases[name] = json.loads(args[4])["target"]
            return 0, ""
        if args[:1] == ["list"]:
            return 0, json.dumps([{"name": n} for n in sorted(self.instances)])
        if args[:1] == ["launch"]:
            self.instances.add(args[2])
            return 0, ""
        if args[:1] == ["delete"]:
            self.instances.discard(args[-1])
            return 0, ""
        if args[:1] == ["exec"]:
            cmd = args[args.index("--") + 1:]
            if cmd[0] == "systemctl":
                return 0, "running\n"
            default = {"node": "v24.8.0\n", "python3.14": "Python 3.14.7\n"}.get(cmd[0], f"{cmd[0]} ok\n")
            return self.exec_results.get(cmd[0], (0, default))
        raise AssertionError(f"unexpected incus {args}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.jobs = root / "image-jobs"
        self.images = root / "images"
        self.recipe = root / "recipe"
        for d in (self.jobs, self.images, self.recipe):
            d.mkdir()
        (self.recipe / "VERSION").write_text("2026.09.12\n")
        (self.recipe / "portikus.yaml").write_text("image: {}\n")
        self.lock = root / "lock"
        self.host = FakeHost()
        self._run = ij.run
        ij.run = self.host
        self._config = ij.CONFIG_FILE
        ij.CONFIG_FILE = str(root / "no-config.yaml")
        self.journal = []
        self._journal = ij.journal
        ij.journal = self.journal.append
        self.runner = ij.Runner(str(self.jobs), str(self.images), str(self.recipe), "/keyring.gpg",
                                sleep=lambda s: None)

    def tearDown(self):
        ij.run = self._run
        ij.CONFIG_FILE = self._config
        ij.journal = self._journal
        self.tmp.cleanup()

    def request(self, request, job_id=ID, **overrides):
        doc = {"id": job_id, "requestedAt": "2026-09-28T12:00:00.000Z", "requestedBy": USER, "request": request}
        doc.update(overrides)
        path = self.jobs / f"request-{job_id}.json"
        path.write_text(json.dumps(doc))
        return path

    def raw_request(self, text, job_id=ID):
        (self.jobs / f"request-{job_id}.json").write_text(text)

    def go(self):
        self.assertEqual(self.runner.run_pending(str(self.lock)), 0)

    def status(self, job_id=ID):
        return json.loads((self.jobs / job_id / "status.json").read_text())

    def log(self, job_id=ID):
        return (self.jobs / job_id / "log.txt").read_text()

    def put_image(self, version, health="passed", alias=True):
        d = self.images / version
        d.mkdir(exist_ok=True)
        (d / "manifest.json").write_text(json.dumps(manifest_for(version)))
        if health:
            (d / "health.json").write_text(json.dumps({"result": health, "checkedAt": "2026-09-28T10:00:00Z",
                                                       "checks": []}))
        if alias:
            self.host.aliases[f"portikus-{version}"] = FP[version]

    def set_default(self, version, previous=None):
        self.host.aliases["portikus"] = FP[version]
        if previous:
            self.host.aliases["portikus-previous"] = FP[previous]

    def aliases_file(self):
        return json.loads((self.images / "aliases.json").read_text())


class ValidationTest(unittest.TestCase):
    def doc(self, request, **top):
        base = {"id": ID, "requestedAt": "2026-09-28T12:00:00.000Z", "requestedBy": USER, "request": request}
        base.update(top)
        return json.dumps(base).encode()

    def refused(self, raw):
        with self.assertRaises(ij.Refused):
            ij.validate_request(raw, ID)

    def test_each_valid_kind_passes(self):
        for request in (
            {"kind": "fetch"},
            {"kind": "fetch", "version": "2026.09.12"},
            {"kind": "fetch", "version": "2026.09.12-local.202609281200"},
            {"kind": "build", "node": "24", "python": "debian"},
            {"kind": "build", "node": "26", "python": "uv-3.14"},
            {"kind": "activate", "version": "2026.09.12"},
            {"kind": "rollback"},
        ):
            with self.subTest(request=request):
                self.assertEqual(ij.validate_request(self.doc(request), ID)["request"], request)

    def test_unknown_kinds(self):
        for kind in ("shell", "", "FETCH", "fetch ", None, 1, ["fetch"], {"kind": "fetch"}):
            with self.subTest(kind=kind):
                self.refused(self.doc({"kind": kind}))
        self.refused(self.doc({}))

    def test_extra_or_missing_fields_per_kind(self):
        for request in (
            {"kind": "fetch", "node": "24"},
            {"kind": "fetch", "version": "2026.09.12", "force": True},
            {"kind": "build", "node": "24"},
            {"kind": "build", "python": "debian"},
            {"kind": "build", "node": "24", "python": "debian", "version": "2026.09.12"},
            {"kind": "build", "node": "24", "python": "debian", "packages": ["curl"]},
            {"kind": "activate"},
            {"kind": "activate", "version": "2026.09.12", "node": "24"},
            {"kind": "rollback", "version": "2026.09.12"},
        ):
            with self.subTest(request=request):
                self.refused(self.doc(request))

    def test_bad_choices(self):
        for node, python in (("22", "debian"), ("25", "debian"), (26, "debian"), ("26 ", "debian"),
                             ("26; reboot", "debian"), (None, "debian"), ("24", "uv-3.13"),
                             ("24", "3.14"), ("24", "uv"), ("24", ""), ("24", ["debian"]), ("24", "DEBIAN")):
            with self.subTest(node=node, python=python):
                self.refused(self.doc({"kind": "build", "node": node, "python": python}))

    def test_bad_versions(self):
        for version in ("2026.9.12", "26.09.12", "2026.09", "2026.09.", "2026.09.12-local.1",
                        "2026.09.12-local.2026092812000", "2026.09.12-local.20260928120", "2026.09.12-LOCAL.202609281200",
                        "2026.09.12\n", " 2026.09.12", "2026.09.12 ", "../2026.09.12", "2026.09.12/..",
                        "2026.09.12;reboot", "$(reboot)", "２０２６.09.12", "2026.09.1٢",
                        "", None, 2026.0912, ["2026.09.12"]):
            for kind in ("fetch", "activate"):
                with self.subTest(version=version, kind=kind):
                    self.refused(self.doc({"kind": kind, "version": version}))

    def test_bad_envelopes(self):
        self.refused(b"not json")
        self.refused(b"\xff\xfe")
        self.refused(b"[]")
        self.refused(json.dumps({"id": ID, "requestedAt": "2026-09-28T12:00:00Z", "requestedBy": USER}).encode())
        self.refused(self.doc({"kind": "rollback"}, extra=1))
        self.refused(self.doc({"kind": "rollback"}, id=ID2))
        self.refused(self.doc({"kind": "rollback"}, requestedAt="yesterday"))
        self.refused(self.doc({"kind": "rollback"}, requestedBy="admin"))
        self.refused(self.doc("rollback"))
        dup = ('{"id":"%s","requestedAt":"2026-09-28T12:00:00Z","requestedBy":"%s",'
               '"request":{"kind":"rollback","kind":"fetch"}}' % (ID, USER))
        self.refused(dup.encode())


class RefusalTest(Base):
    def assert_refused_and_nothing_ran(self, job_id=ID):
        status = self.status(job_id)
        self.assertEqual(status["state"], "refused")
        self.assertIsNotNone(status["finishedAt"])
        self.assertIn("refused", status["message"])
        self.assertIn("Refused", self.log(job_id))
        self.assertTrue([m for m in self.journal if m.startswith(f"refused request {job_id}")])
        self.assertEqual(self.host.calls, [])
        self.assertEqual(list(self.jobs.glob("request-*.json")), [])

    def test_unknown_kind_is_refused_and_nothing_runs(self):
        self.request({"kind": "shell", "command": "reboot"})
        self.go()
        self.assert_refused_and_nothing_ran()
        self.assertIsNone(self.status()["kind"])
        self.assertFalse((self.jobs / ID / "request.json").exists())

    def test_bad_choice_is_refused_with_its_kind(self):
        self.request({"kind": "build", "node": "22", "python": "debian"})
        self.go()
        self.assert_refused_and_nothing_ran()
        self.assertEqual(self.status()["kind"], "build")

    def test_extra_field_is_refused(self):
        self.request({"kind": "rollback", "version": "2026.09.12"})
        self.go()
        self.assert_refused_and_nothing_ran()

    def test_malformed_version_is_refused(self):
        self.request({"kind": "activate", "version": "2026.09.12;reboot"})
        self.go()
        self.assert_refused_and_nothing_ran()

    def test_a_file_name_that_is_not_a_job_id_is_dropped(self):
        (self.jobs / "request-abc.json").write_text("{}")
        self.go()
        self.assertEqual(os.listdir(self.jobs), [])
        self.assertEqual(self.host.calls, [])

    def test_a_symlinked_request_is_refused_without_reading_it(self):
        secret = Path(self.tmp.name) / "secret"
        secret.write_text(json.dumps({"id": ID, "requestedAt": "2026-09-28T12:00:00Z",
                                      "requestedBy": USER, "request": {"kind": "rollback"}}))
        (self.jobs / f"request-{ID}.json").symlink_to(secret)
        self.go()
        self.assert_refused_and_nothing_ran()
        self.assertTrue(secret.exists())

    def test_a_directory_named_like_a_request_is_ignored_without_looping(self):
        (self.jobs / f"request-{ID}.json").mkdir()
        self.go()
        self.assertFalse((self.jobs / ID).exists())
        self.assertEqual(self.host.calls, [])

    def test_a_planted_job_directory_is_never_written_through(self):
        target = Path(self.tmp.name) / "elsewhere"
        target.mkdir()
        (self.jobs / ID).symlink_to(target)
        self.request({"kind": "rollback"})
        self.go()
        self.assertEqual(os.listdir(target), [])
        self.assertEqual(self.host.calls, [])

    def test_job_files_are_group_readable_only(self):
        self.request({"kind": "shell"})
        self.go()
        self.assertEqual(stat.S_IMODE((self.jobs / ID).stat().st_mode), 0o750)
        for name in ("status.json", "log.txt"):
            self.assertEqual(stat.S_IMODE((self.jobs / ID / name).stat().st_mode), 0o640)
            self.assertEqual((self.jobs / ID / name).stat().st_gid, self.jobs.stat().st_gid)


class FetchTest(Base):
    def test_fetch_downloads_verifies_imports_and_checks_health(self):
        self.put_image("2026.09.11")
        self.set_default("2026.09.11")
        self.host.publish("2026.09.12")
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        status = self.status()
        self.assertEqual((status["state"], status["kind"], status["version"]), ("succeeded", "fetch", "2026.09.12"))
        self.assertIsNotNone(status["finishedAt"])
        manifest = json.loads((self.images / "2026.09.12" / "manifest.json").read_text())
        self.assertEqual(manifest["fingerprint"], FP["2026.09.12"])
        self.assertEqual(manifest["source"], "published")
        health = json.loads((self.images / "2026.09.12" / "health.json").read_text())
        self.assertEqual(health["result"], "passed")
        self.assertEqual([c["name"] for c in health["checks"]],
                         ["node --version", "python3 --version", "git --version", "docker info",
                          "claude --version", "codex --version"])
        # It never makes itself the default.
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.11"])
        self.assertEqual(self.aliases_file(), {"default": "2026.09.11", "previous": None})
        request = json.loads((self.jobs / ID / "request.json").read_text())
        self.assertEqual(request["request"], {"kind": "fetch", "version": "2026.09.12"})
        self.assertFalse(list(self.jobs.glob("request-*.json")))
        self.assertFalse([p for p in self.images.iterdir() if p.name.startswith(".")])
        # The signature is checked with the shipped keyring before anything big is downloaded.
        names = self.host.names()
        gpgv = next(i for i, n in enumerate(names) if n.startswith("gpgv"))
        self.assertIn("--keyring /keyring.gpg", names[gpgv])
        self.assertTrue(all("rootfs.squashfs" not in n for n in names[:gpgv]))
        self.assertTrue(any("image import" in n and "--alias portikus-2026.09.12" in n for n in names))
        self.assertEqual(self.host.instances, set())

    def test_the_health_container_uses_the_workspace_profile_and_is_deleted(self):
        self.host.publish("2026.09.12")
        self.host.instances.add("imgcheck-deadbeef")  # left by a crashed run
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        launch = self.host.ran("launch")[0]
        self.assertEqual(launch[4], "portikus-2026.09.12")
        self.assertTrue(launch[5].startswith("imgcheck-"))
        self.assertEqual(launch[-2:], ["--profile", "workspace"])
        self.assertEqual(self.host.instances, set())

    def test_fetch_without_a_version_takes_the_newest_published(self):
        self.host.urls[ij.DEFAULT_RELEASES_URL] = json.dumps([
            {"tag_name": "v0.1.700"}, {"tag_name": "image-2026.09.9"}, {"tag_name": "image-2026.09.12"},
            {"tag_name": "image-2026.09.10"}, {"tag_name": "image-2026.09.99-local.202609281200"},
            {"tag_name": "image-../../x"},
        ]).encode()
        self.host.publish("2026.09.12")
        self.request({"kind": "fetch"})
        self.go()
        self.assertEqual(self.status()["version"], "2026.09.12")
        self.assertEqual(self.status()["state"], "succeeded")

    def test_a_bad_signature_imports_nothing(self):
        self.host.publish("2026.09.12")
        self.host.gpgv_rc = 1
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("signature", self.status()["message"])
        self.assertFalse(self.host.ran("import"))
        self.assertFalse((self.images / "2026.09.12").exists())

    def test_a_bad_checksum_imports_nothing(self):
        self.host.publish("2026.09.12", corrupt="rootfs.squashfs")
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("checksum", self.status()["message"])
        self.assertFalse(self.host.ran("import"))

    def test_an_old_style_manifest_imports_nothing(self):
        self.host.publish("2026.09.12", manifest={"version": "2026.09.12", "source": "published"})
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertFalse(self.host.ran("import"))

    def test_a_failed_health_check_is_recorded_and_the_job_fails(self):
        self.host.publish("2026.09.12")
        self.host.exec_results["codex"] = (127, "")
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertIn("codex --version", self.status()["message"])
        health = json.loads((self.images / "2026.09.12" / "health.json").read_text())
        self.assertEqual(health["result"], "failed")
        self.assertEqual([c["ok"] for c in health["checks"]], [True, True, True, True, True, False])
        self.assertEqual(self.host.instances, set())

    def test_a_node_version_that_does_not_match_the_parameters_fails_health(self):
        self.host.publish("2026.09.12", manifest=manifest_for("2026.09.12", node="26"))
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        health = json.loads((self.images / "2026.09.12" / "health.json").read_text())
        self.assertFalse(health["checks"][0]["ok"])

    def test_the_default_image_is_never_refetched(self):
        self.put_image("2026.09.12")
        self.set_default("2026.09.12")
        self.host.publish("2026.09.12")
        self.request({"kind": "fetch", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertFalse(self.host.ran("curl"))

    def test_update_to_the_latest_when_it_is_already_the_default_succeeds(self):
        self.host.urls[ij.DEFAULT_RELEASES_URL] = json.dumps([{"tag_name": "image-2026.09.12"}]).encode()
        for previous in (False, True):
            with self.subTest(previous=previous):
                self.host.aliases.clear()
                self.put_image("2026.09.11")
                self.put_image("2026.09.12")
                if previous:
                    self.set_default("2026.09.11", previous="2026.09.12")
                else:
                    self.set_default("2026.09.12")
                job_id = ID if not previous else ID2
                self.request({"kind": "fetch"}, job_id=job_id)
                self.go()
                status = self.status(job_id)
                self.assertEqual((status["state"], status["message"]), ("succeeded", "Already up to date"))
                self.assertEqual(status["version"], "2026.09.12")
                self.assertFalse([c for c in self.host.ran("curl") if "image-2026.09.12" in c[-1]])

    def test_the_download_url_comes_from_portikus_yaml(self):
        config = Path(self.tmp.name) / "portikus.yaml"
        config.write_text("portikus_image_base_url: http://10.100.0.1:8000/images/\n")
        ij.CONFIG_FILE = str(config)
        self.request({"kind": "fetch", "version": "2026.09.12"})
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML is not installed")
        self.go()
        self.assertIn("http://10.100.0.1:8000/images/image-2026.09.12/SHA256SUMS", self.host.ran("curl")[0])


class BuildTest(Base):
    def test_build_passes_the_parameters_and_versions_it_local(self):
        self.request({"kind": "build", "node": "26", "python": "uv-3.14"})
        self.host.exec_results["node"] = (0, "v26.1.0\n")
        self.go()
        status = self.status()
        self.assertEqual(status["state"], "succeeded", self.log())
        self.assertRegex(status["version"], r"^2026\.09\.12-local\.[0-9]{12}$")
        env = self.host.env
        self.assertEqual((env["PORTIKUS_NODE_MAJOR"], env["PORTIKUS_PYTHON"]), ("26", "uv-3.14"))
        self.assertEqual((env["PORTIKUS_CLAUDE_VERSION"], env["PORTIKUS_CODEX_VERSION"]), ("latest", "latest"))
        self.assertEqual(env["PORTIKUS_IMAGE_VERSION"], status["version"])
        build = self.host.ran("distrobuilder")[0]
        self.assertEqual(build[1:3], ["build-incus", str(self.recipe / "portikus.yaml")])
        self.assertIn(f"image.serial={status['version']}", build)
        manifest = json.loads((self.images / status["version"] / "manifest.json").read_text())
        self.assertEqual(manifest["source"], "local")
        self.assertEqual(manifest["recipeVersion"], "2026.09.12")
        self.assertEqual(manifest["parameters"], {"node": "26", "python": "uv-3.14"})
        self.assertEqual(manifest["packages"], {"curl": "8.14.1-2", "libc6:amd64": "2.41-12"})
        self.assertEqual(manifest["tools"]["node"], "node version 9.9")
        self.assertRegex(manifest["fingerprint"], r"^[0-9a-f]{64}$")
        health = json.loads((self.images / status["version"] / "health.json").read_text())
        self.assertIn("python3.14 --version", [c["name"] for c in health["checks"]])
        self.assertEqual(health["result"], "passed")

    def test_a_failed_build_imports_nothing(self):
        self.host.distrobuilder_rc = 1
        self.request({"kind": "build", "node": "24", "python": "debian"})
        self.go()
        self.assertEqual(self.status()["state"], "failed")
        self.assertFalse(self.host.ran("import"))
        self.assertFalse([p for p in self.images.iterdir() if p.name.startswith(".")])


class ActivateTest(Base):
    def test_activate_refuses_an_image_with_no_health_result(self):
        self.put_image("2026.09.12", health=None)
        self.request({"kind": "activate", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "refused")
        self.assertNotIn("portikus", self.host.aliases)
        self.assertFalse([c for c in self.host.calls if "PUT" in c or "create" in c])

    def test_activate_refuses_a_failed_image_even_from_a_hand_written_request(self):
        self.put_image("2026.09.11")
        self.set_default("2026.09.11")
        self.put_image("2026.09.12", health="failed")
        self.request({"kind": "activate", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "refused")
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.11"])

    def test_activate_moves_the_default_and_keeps_the_old_one_as_previous(self):
        self.put_image("2026.09.11")
        self.put_image("2026.09.12")
        self.set_default("2026.09.11")
        self.request({"kind": "activate", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "succeeded")
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.12"])
        self.assertEqual(self.host.aliases["portikus-previous"], FP["2026.09.11"])
        self.assertEqual(self.aliases_file(), {"default": "2026.09.12", "previous": "2026.09.11"})
        # The default alias is moved in place, never deleted and recreated.
        self.assertTrue(any("PUT" in c and c[-1].startswith("/1.0/images/aliases/portikus?") for c in self.host.calls))
        self.assertFalse([c for c in self.host.calls if c[3:6] == ["image", "alias", "delete"]])

    def test_activate_refuses_the_current_default(self):
        self.put_image("2026.09.12")
        self.set_default("2026.09.12")
        self.request({"kind": "activate", "version": "2026.09.12"})
        self.go()
        self.assertEqual(self.status()["state"], "refused")


class RollbackTest(Base):
    def test_rollback_swaps_default_and_previous(self):
        self.put_image("2026.09.11")
        self.put_image("2026.09.12")
        self.set_default("2026.09.12", previous="2026.09.11")
        self.request({"kind": "rollback"})
        self.go()
        self.assertEqual(self.status()["state"], "succeeded")
        self.assertEqual(self.status()["version"], "2026.09.11")
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.11"])
        self.assertEqual(self.host.aliases["portikus-previous"], FP["2026.09.12"])
        self.assertEqual(self.aliases_file(), {"default": "2026.09.11", "previous": "2026.09.12"})

    def test_rollback_with_no_previous_is_refused(self):
        self.put_image("2026.09.12")
        self.set_default("2026.09.12")
        self.request({"kind": "rollback"})
        self.go()
        self.assertEqual(self.status()["state"], "refused")
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.12"])


class PruneTest(Base):
    def test_keeps_default_previous_the_two_newest_candidates_and_the_new_image(self):
        for v in ("2026.09.10", "2026.09.11", "2026.09.12-local.202609280900",
                  "2026.09.12-local.202609281000", "2026.09.13", "2026.09.14"):
            self.put_image(v)
        self.set_default("2026.09.11", previous="2026.09.10")
        # Only on disk, never imported: removed like any old candidate.
        (self.images / "2026.09.09").mkdir()
        job = type("J", (), {"line": lambda self, t: None})()
        self.runner.prune(job, keep="2026.09.12-local.202609280900")
        kept = {p.name for p in self.images.iterdir() if p.is_dir()}
        self.assertEqual(kept, {"2026.09.10", "2026.09.11", "2026.09.14", "2026.09.13",
                                "2026.09.12-local.202609280900"})
        deleted = [c[-1] for c in self.host.calls if c[3:5] == ["image", "delete"]]
        self.assertEqual(deleted, ["portikus-2026.09.12-local.202609281000"])
        self.assertEqual(self.aliases_file(), {"default": "2026.09.11", "previous": "2026.09.10"})

    def test_never_deletes_an_image_the_default_alias_points_at(self):
        for v in ("2026.09.10", "2026.09.11", "2026.09.12", "2026.09.13", "2026.09.14"):
            self.put_image(v)
        # Two versioned names for the default's image: 2026.09.10 is a candidate by name only.
        self.host.aliases["portikus-2026.09.11"] = FP["2026.09.10"]
        self.host.aliases["portikus"] = FP["2026.09.10"]
        job = type("J", (), {"line": lambda self, t: None})()
        self.runner.prune(job, keep="2026.09.14")
        self.assertFalse([c for c in self.host.calls if c[3:5] == ["image", "delete"]])
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.10"])
        self.assertTrue((self.images / "2026.09.10").exists())

    def test_version_order(self):
        versions = ["2026.09.12-local.202609281000", "2026.10.1", "2026.09.12", "2026.09.9",
                    "2026.09.12-local.202609280900"]
        self.assertEqual(sorted(versions, key=ij.version_key),
                         ["2026.09.9", "2026.09.12", "2026.09.12-local.202609280900",
                          "2026.09.12-local.202609281000", "2026.10.1"])

    def test_a_work_directory_with_a_mount_under_it_is_left_alone(self):
        work = self.images / ".work-x"
        (work / "root" / "dev").mkdir(parents=True)
        original = ij.mounts_under
        ij.mounts_under = lambda path: [str(work / "root" / "dev")]
        try:
            ij.safe_rmtree(str(work))
        finally:
            ij.mounts_under = original
        self.assertTrue(work.exists())


class QueueTest(Base):
    def test_one_job_at_a_time_through_the_lock(self):
        self.request({"kind": "rollback"})
        held = os.open(self.lock, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.go()
        finally:
            os.close(held)
        # Left for the job holding the lock; nothing ran.
        self.assertTrue((self.jobs / f"request-{ID}.json").exists())
        self.assertEqual(self.host.calls, [])

    def test_a_second_waiting_request_is_refused(self):
        self.put_image("2026.09.11")
        self.put_image("2026.09.12")
        self.set_default("2026.09.12", previous="2026.09.11")
        first = self.request({"kind": "rollback"})
        second = self.request({"kind": "rollback"}, job_id=ID2)
        os.utime(first, ns=(1, 1))
        os.utime(second, ns=(2, 2))
        self.go()
        self.assertEqual(self.status(ID)["state"], "succeeded")
        self.assertEqual(self.status(ID2)["state"], "refused")
        self.assertIn("another image job", self.status(ID2)["message"])
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.11"])

    def test_a_request_after_the_last_finished_runs(self):
        self.put_image("2026.09.11")
        self.put_image("2026.09.12")
        self.set_default("2026.09.12", previous="2026.09.11")
        self.request({"kind": "rollback"})
        original = self.runner.execute

        def execute_then_queue(job, doc):
            original(job, doc)
            if job.id == ID2:
                return
            later = self.request({"kind": "rollback"}, job_id=ID2)
            future = time.time_ns() + 10**9
            os.utime(later, ns=(future, future))

        self.runner.execute = execute_then_queue
        self.go()
        self.assertEqual(self.status(ID2)["state"], "succeeded")
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.12"])

    def test_an_interrupted_job_is_marked_failed(self):
        (self.jobs / ID).mkdir()
        (self.jobs / ID / "status.json").write_text(json.dumps({
            "id": ID, "kind": "build", "state": "running", "step": "Building", "version": None,
            "message": None, "startedAt": "2026-09-28T12:00:00.000Z", "finishedAt": None}))
        (self.images / ".work-leftover").mkdir()
        self.assertEqual(self.runner.run_recover(str(self.lock)), 0)
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIsNotNone(status["finishedAt"])
        self.assertFalse((self.images / ".work-leftover").exists())

    def test_recover_keeps_only_the_newest_twenty_jobs(self):
        ids = [f"{n:08x}-3f4a-4b5c-8d9e-0f1a2b3c4d5e" for n in range(25)]
        for n, job_id in enumerate(ids):
            d = self.jobs / job_id
            d.mkdir()
            (d / "log.txt").write_text("x")
            os.utime(d, ns=(10**9 * (n + 1), 10**9 * (n + 1)))
        (self.jobs / "not-a-job").mkdir()
        (self.jobs / "request-x.json").write_text("{}")
        self.assertEqual(self.runner.run_recover(str(self.lock)), 0)
        left = {p.name for p in self.jobs.iterdir()}
        self.assertEqual(left, set(ids[5:]) | {"not-a-job", "request-x.json"})

    def test_an_unexpected_error_never_leaves_running(self):
        self.request({"kind": "rollback"})
        ij_alias_map = ij.alias_map
        ij.alias_map = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.go()
        finally:
            ij.alias_map = ij_alias_map
        self.assertEqual(self.status()["state"], "failed")
        self.assertNotIn("boom", self.status()["message"])


class FirstInstallTest(Base):
    def install(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.runner.run_first_install("2026.09.12", str(self.lock))
        return code, out.getvalue().strip()

    def jobs_by_kind(self):
        found = {}
        for d in self.jobs.iterdir():
            status = json.loads((d / "status.json").read_text())
            found[status["kind"]] = status
        return found

    def test_a_host_with_no_default_fetches_checks_and_activates(self):
        self.host.publish("2026.09.12")
        self.assertEqual(self.install(), (0, "changed"))
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.12"])
        self.assertNotIn("portikus-previous", self.host.aliases)
        self.assertEqual(self.aliases_file(), {"default": "2026.09.12", "previous": None})
        health = json.loads((self.images / "2026.09.12" / "health.json").read_text())
        self.assertEqual(health["result"], "passed")
        # Incus holds the image; the store keeps only its manifest and health.
        self.assertEqual({p.name for p in self.images.iterdir()}, {"2026.09.12", "aliases.json"})
        self.assertEqual({p.name for p in (self.images / "2026.09.12").iterdir()}, {"manifest.json", "health.json"})
        jobs = self.jobs_by_kind()
        self.assertEqual({k: s["state"] for k, s in jobs.items()}, {"fetch": "succeeded", "activate": "succeeded"})

    def test_a_host_with_a_default_is_left_to_the_admin_page(self):
        self.put_image("2026.09.13")
        self.set_default("2026.09.13")
        self.host.publish("2026.09.12")
        self.assertEqual(self.install(), (0, "unchanged"))
        self.assertEqual(self.host.aliases["portikus"], FP["2026.09.13"])
        self.assertFalse(self.host.ran("curl"))
        self.assertEqual(list(self.jobs.iterdir()), [])

    def test_a_failed_download_fails_and_sets_no_default(self):
        self.assertEqual(self.install(), (1, ""))
        self.assertNotIn("portikus", self.host.aliases)
        self.assertEqual({k: s["state"] for k, s in self.jobs_by_kind().items()}, {"fetch": "failed"})

    def test_an_unhealthy_image_is_not_made_the_default(self):
        self.host.publish("2026.09.12")
        self.host.exec_results["codex"] = (127, "")
        self.assertEqual(self.install()[0], 1)
        self.assertNotIn("portikus", self.host.aliases)

    def test_the_command_line_takes_only_a_published_version(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in (["first-install"], ["first-install", "../x"],
                         ["first-install", "2026.09.12-local.202609281200"], ["first-install", "2026.09.12", "x"]):
                self.assertEqual(ij.main(["image-job", *argv]), 2)


class ManifestTest(Base):
    def test_manifest_shape_and_missing_tools(self):
        squash = self.images / "rootfs.squashfs"
        squash.write_bytes(b"x")
        self.host.chroot_rc = 1
        m = ij.manifest_from_squashfs(str(squash), "2026.09.12", "2026.09.12", "published", "24", "debian")
        self.assertEqual(set(m), {"schema", "version", "recipeVersion", "source", "builtAt", "fingerprint",
                                  "parameters", "tools", "packages"})
        self.assertEqual(m["tools"], {t: None for t in ij.TOOLS})
        self.assertRegex(m["builtAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        # /dev in the chroot is a fresh tmpfs, never the host's.
        mounts = [c for c in self.host.calls if c[0] == "mount"]
        self.assertTrue(all("--bind" not in c and "/dev" != c[-2] for c in mounts))
        self.assertFalse([p for p in self.images.iterdir() if p.name.startswith(".manifest-")])

    def test_an_image_whose_dev_is_a_link_is_never_mounted_over(self):
        squash = self.images / "rootfs.squashfs"
        squash.write_bytes(b"x")
        self.host.dev_link = True
        with self.assertRaises(ij.JobFailed):
            ij.manifest_from_squashfs(str(squash), "2026.09.12", "2026.09.12", "published", "24", "debian")
        self.assertFalse([c for c in self.host.calls if c[0] in ("mount", "chroot")])


class UnitFileTest(unittest.TestCase):
    """Settings of portikus-image-job.service that the rehearsal VM showed matter."""

    def setUp(self):
        unit = (_PATH.parents[1] / "systemd" / "portikus-image-job.service").read_text()
        self.settings = dict(line.split("=", 1) for line in unit.splitlines()
                             if "=" in line and not line.lstrip().startswith("#"))

    def test_the_sandbox_lets_distrobuilder_set_its_build_hostname(self):
        # ProtectHostname's filter refuses sethostname(), and distrobuilder then stops
        # with "Failed to set hostname: Operation not permitted".
        self.assertNotIn("ProtectHostname", self.settings)

    def test_a_burst_of_requests_cannot_hit_the_start_limit(self):
        # With the default limit, six quick requests failed the path unit, and no
        # later request ran until it was restarted by hand.
        self.assertEqual(self.settings.get("StartLimitIntervalSec"), "0")


if __name__ == "__main__":
    unittest.main()
