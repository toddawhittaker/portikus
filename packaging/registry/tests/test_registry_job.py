"""Unit tests for packaging/registry/registry-job (issue #840, rulings S1, S5 and S7).

systemctl, mkfs, the mount check and the health probes are replaced by
FakeHost, so no test touches the host.
Run: python3 -m unittest discover -s packaging/registry/tests
"""

import importlib.machinery
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
_PATH = Path(__file__).resolve().parents[1] / "registry-job"
_loader = importlib.machinery.SourceFileLoader("registry_job", str(_PATH))
_spec = importlib.util.spec_from_loader("registry_job", _loader)
rj = importlib.util.module_from_spec(_spec)
_loader.exec_module(rj)

ID = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
ID2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
TOKEN = "dckr_pat_Secret-Token_0123456789"


class FakeStatvfs:
    def __init__(self, blocks, free, frsize=4096):
        self.f_blocks = blocks
        self.f_bfree = free
        self.f_frsize = frsize


class FakeHost:
    def __init__(self):
        self.calls = []
        self.mounted = True
        self.fail_unmount = False
        self.vfs = FakeStatvfs(1000, 900)
        self.up = {"hub": True, "ghcr": True}

    def systemctl(self, *args):
        self.calls.append(("systemctl",) + args)
        if args == ("stop", rj.MOUNT_UNIT):
            if self.fail_unmount:
                return 1
            self.mounted = False
        if args == ("start", rj.MOUNT_UNIT):
            self.mounted = True
        return 0

    def mkfs(self, image):
        self.calls.append(("mkfs", image))

    def is_mount(self, path):
        return self.mounted

    def statvfs(self, path):
        return self.vfs

    def registry_gid(self):
        return os.getgid()

    def registry_uid(self):
        return os.getuid()

    def answers(self, name):
        return self.up[name]

    def sleep(self, seconds):
        self.calls.append(("sleep", seconds))


def request_doc(request, file_id=ID):
    return {"id": file_id, "requestedAt": "2026-09-30T10:00:00.000Z", "requestedBy": USER, "request": request}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.jobs = root / "registry-jobs"
        self.config = root / "registry"
        self.mount = root / "mnt"
        for d in (self.jobs, self.config, self.mount):
            d.mkdir()
        (self.config / "events-token").write_text("t0ken\n")
        self.worker_env = root / "worker.env"
        self.worker_env.write_text("LOG_LEVEL=info\nREGISTRY_EVENTS_PORT=8799\n")
        self.host = FakeHost()
        self.helper = rj.Helper(
            host=self.host, jobs_dir=str(self.jobs), config_dir=str(self.config),
            mount_point=str(self.mount), image_file=str(root / "cache.img"),
            worker_env=str(self.worker_env))
        self.lock = str(root / "lock")

    def tearDown(self):
        self.tmp.cleanup()

    def write_request(self, request, file_id=ID, name=None, doc=None):
        path = self.jobs / (name or f"request-{file_id}.json")
        path.write_text(json.dumps(doc if doc is not None else request_doc(request, file_id)))
        os.chmod(path, 0o600)
        return path

    def status(self):
        return json.loads((self.jobs / "status.json").read_text())

    def systemctl_calls(self):
        return [c[1:] for c in self.host.calls if c[0] == "systemctl"]


class ValidationTest(unittest.TestCase):
    def check(self, doc, file_id=ID):
        return rj.validate_request(json.dumps(doc).encode(), file_id)

    def test_accepts_each_kind(self):
        for request in ({"kind": "clear"}, {"kind": "set-ghcr", "enabled": True},
                        {"kind": "set-hub-credential", "username": "portikus", "token": TOKEN},
                        {"kind": "remove-hub-credential"}):
            self.assertEqual(self.check(request_doc(request)), request)

    def test_refuses_unknown_kinds_and_extra_keys(self):
        bad = [
            {"kind": "rm"},
            {"kind": "clear", "path": "/"},
            {"kind": "set-ghcr"},
            {"kind": "set-ghcr", "enabled": "true"},
            {"kind": "set-ghcr", "enabled": 1},
            {"kind": "set-hub-credential", "username": "portikus"},
            {"kind": "set-hub-credential", "username": "Portikus", "token": TOKEN},
            {"kind": "set-hub-credential", "username": "abc", "token": TOKEN},
            {"kind": "set-hub-credential", "username": "portikus", "token": "short"},
            {"kind": "set-hub-credential", "username": "portikus", "token": "has space in it"},
            {"kind": "set-hub-credential", "username": "portikus", "token": "line\nbreak-0123"},
            {"kind": "set-hub-credential", "username": "portikus", "token": TOKEN, "extra": 1},
        ]
        for request in bad:
            with self.assertRaises(rj.Refused, msg=json.dumps(request)):
                self.check(request_doc(request))

    def test_refuses_a_bad_envelope(self):
        good = request_doc({"kind": "clear"})
        for doc in (
            {**good, "extra": 1},
            {k: v for k, v in good.items() if k != "requestedBy"},
            {**good, "requestedAt": "yesterday"},
            {**good, "requestedBy": "admin"},
            {**good, "request": "clear"},
            [good],
        ):
            with self.assertRaises(rj.Refused):
                self.check(doc)
        with self.assertRaises(rj.Refused):
            self.check(good, file_id=ID2)
        with self.assertRaises(rj.Refused):
            rj.validate_request(b"{not json", ID)
        with self.assertRaises(rj.Refused):
            rj.validate_request(b'{"id": "a", "id": "b"}', ID)


class RequestFileTest(Base):
    def test_a_request_is_deleted_before_it_is_applied(self):
        path = self.write_request({"kind": "clear"})
        seen = []
        real_mkfs = self.host.mkfs
        self.host.mkfs = lambda image: (seen.append(path.exists()), real_mkfs(image))
        self.assertEqual(self.helper.run_pending(self.lock), 0)
        self.assertEqual(seen, [False])
        self.assertEqual(list(self.jobs.glob("request-*")), [])

    def test_a_refused_request_is_deleted_and_nothing_runs(self):
        self.write_request({"kind": "rm", "path": "/"})
        self.write_request({"kind": "clear"}, doc={"id": ID2}, file_id=ID2)
        self.write_request({"kind": "clear"}, name="request-not-a-uuid.json")
        self.helper.run_pending(self.lock)
        self.assertEqual(list(self.jobs.glob("request-*")), [])
        self.assertEqual([c for c in self.host.calls if c[0] == "mkfs"], [])

    def test_a_symlink_or_hard_link_is_not_read(self):
        secret = Path(self.tmp.name) / "secret.json"
        secret.write_text(json.dumps(request_doc({"kind": "clear"})))
        (self.jobs / f"request-{ID}.json").symlink_to(secret)
        os.link(secret, self.jobs / f"request-{ID2}.json")
        self.helper.run_pending(self.lock)
        self.assertEqual([c for c in self.host.calls if c[0] == "mkfs"], [])
        self.assertTrue(secret.exists())
        self.assertEqual(list(self.jobs.glob("request-*")), [])

    def test_an_oversized_request_is_refused(self):
        self.write_request(None, doc={**request_doc({"kind": "clear"}), "pad": "x" * 5000})
        self.helper.run_pending(self.lock)
        self.assertEqual([c for c in self.host.calls if c[0] == "mkfs"], [])

    def test_the_log_names_only_the_kind(self):
        self.write_request({"kind": "set-hub-credential", "username": "portikus", "token": TOKEN})
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.helper.run_pending(self.lock)
        self.assertIn("applying set-hub-credential", err.getvalue())
        self.assertNotIn(TOKEN, err.getvalue())
        self.assertNotIn("portikus\"", err.getvalue())


class ClearTest(Base):
    def test_clear_stops_unmounts_remakes_mounts_and_starts(self):
        self.write_request({"kind": "clear"})
        self.helper.run_pending(self.lock)
        order = [c for c in self.host.calls if c[0] in ("systemctl", "mkfs")]
        self.assertEqual(order, [
            ("systemctl", "stop", "portikus-registry-ghcr.service"),
            ("systemctl", "stop", "portikus-registry-hub.service"),
            ("systemctl", "stop", rj.MOUNT_UNIT),
            ("mkfs", self.helper.image_file),
            ("systemctl", "start", rj.MOUNT_UNIT),
            ("systemctl", "start", "portikus-registry-hub.service"),
        ])
        status = self.status()
        self.assertEqual(status["lastClearReason"], "admin")
        self.assertIsNotNone(status["lastClearedAt"])

    def test_clear_starts_ghcr_when_it_is_on(self):
        (self.config / "ghcr-enabled").write_text("on\n")
        self.helper.clear("admin")
        self.assertIn(("start", "portikus-registry-ghcr.service"), self.systemctl_calls())

    def test_clear_waits_for_the_hub_cache_to_answer(self):
        answers = iter([False, False])
        self.host.answers = lambda name: next(answers, True) if name == "hub" else False
        self.helper.clear("admin")
        self.assertEqual([c for c in self.host.calls if c[0] == "sleep"], [("sleep", 1), ("sleep", 1)])
        self.assertTrue(self.status()["hubUp"])

    def test_no_mkfs_when_the_filesystem_stays_mounted(self):
        self.host.fail_unmount = True
        self.assertFalse(self.helper.clear("admin"))
        self.assertEqual([c for c in self.host.calls if c[0] == "mkfs"], [])
        self.assertIn(("start", "portikus-registry-hub.service"), self.systemctl_calls())

    def test_a_cache_turned_off_for_lack_of_disk_is_left_alone(self):
        (self.config / "cache-off").write_text("off\n")
        self.write_request({"kind": "set-hub-credential", "username": "portikus", "token": TOKEN})
        self.assertEqual(self.helper.run_pending(self.lock), 0)
        self.assertEqual([c for c in self.host.calls if c[0] in ("systemctl", "mkfs")], [])
        self.assertFalse((self.config / "hub-held").exists())

    def test_the_timer_clears_past_ninety_percent(self):
        self.host.vfs = FakeStatvfs(1000, 95)
        self.helper.run_status(self.lock)
        self.assertEqual(len([c for c in self.host.calls if c[0] == "mkfs"]), 1)
        self.assertEqual(self.status()["lastClearReason"], "full")

    def test_the_timer_leaves_a_cache_under_ninety_percent(self):
        self.host.vfs = FakeStatvfs(1000, 101)
        self.helper.run_status(self.lock)
        self.assertEqual([c for c in self.host.calls if c[0] == "mkfs"], [])


class CredentialTest(Base):
    def test_set_writes_a_root_only_file_the_hub_config_and_clears(self):
        self.write_request({"kind": "set-hub-credential", "username": "portikus", "token": TOKEN})
        self.helper.run_pending(self.lock)
        cred = self.config / "hub-credential.json"
        self.assertEqual(stat.S_IMODE(cred.stat().st_mode), 0o600)
        self.assertEqual(len([c for c in self.host.calls if c[0] == "mkfs"]), 1)
        status = self.status()
        self.assertTrue(status["hubCredentialSet"])
        self.assertEqual(status["lastClearReason"], "credential")
        self.assertNotIn(TOKEN, (self.jobs / "status.json").read_text())
        self.helper.render("hub")
        hub = (self.config / "hub.yml").read_text()
        config = json.loads(hub.split("\n", 1)[1])
        self.assertEqual(config["proxy"], {"remoteurl": "https://registry-1.docker.io",
                                           "username": "portikus", "password": TOKEN})
        self.assertEqual(stat.S_IMODE((self.config / "hub.yml").stat().st_mode), 0o640)

    def test_a_failed_clear_after_a_credential_change_keeps_the_hub_cache_stopped(self):
        self.host.fail_unmount = True
        self.write_request({"kind": "set-hub-credential", "username": "portikus", "token": TOKEN})
        self.assertEqual(self.helper.run_pending(self.lock), 1)
        self.assertNotIn(("start", "portikus-registry-hub.service"), self.systemctl_calls())
        self.assertEqual(self.status()["lastClearError"], "could not unmount the cache")
        with self.assertRaises(SystemExit):
            self.helper.render("hub")
        # The timer's status run keeps the error; an admin clear that fails keeps the hold.
        self.helper.write_status()
        self.assertEqual(self.status()["lastClearError"], "could not unmount the cache")
        self.assertFalse(self.helper.clear("admin"))
        self.assertNotIn(("start", "portikus-registry-hub.service"), self.systemctl_calls())

        self.host.fail_unmount = False
        self.assertTrue(self.helper.clear("admin"))
        self.assertIn(("start", "portikus-registry-hub.service"), self.systemctl_calls())
        self.assertIsNone(self.status()["lastClearError"])
        self.helper.render("hub")

    def test_a_failed_admin_clear_records_the_error_but_starts_the_hub_cache(self):
        self.host.fail_unmount = True
        self.assertFalse(self.helper.clear("admin"))
        self.assertIn(("start", "portikus-registry-hub.service"), self.systemctl_calls())
        self.assertEqual(self.status()["lastClearError"], "could not unmount the cache")

    def test_remove_deletes_it_and_clears(self):
        (self.config / "hub-credential.json").write_text(json.dumps({"username": "portikus", "token": TOKEN}))
        self.write_request({"kind": "remove-hub-credential"})
        self.helper.run_pending(self.lock)
        self.assertFalse((self.config / "hub-credential.json").exists())
        self.assertEqual(len([c for c in self.host.calls if c[0] == "mkfs"]), 1)
        self.assertFalse(self.status()["hubCredentialSet"])
        self.helper.render("hub")
        self.assertNotIn("password", (self.config / "hub.yml").read_text())


class GhcrTest(Base):
    def test_on_and_off_round_trip(self):
        self.write_request({"kind": "set-ghcr", "enabled": True})
        self.helper.run_pending(self.lock)
        self.assertEqual((self.config / "ghcr-enabled").read_text(), "on\n")
        self.assertIn(("enable", "--now", "portikus-registry-ghcr.service"), self.systemctl_calls())
        self.assertTrue(self.status()["ghcrEnabled"])
        self.assertTrue(self.status()["ghcrUp"])
        self.assertIn(("start", "portikus-egress-apply.service"), self.systemctl_calls())

        self.write_request({"kind": "set-ghcr", "enabled": False}, file_id=ID2)
        self.helper.run_pending(self.lock)
        self.assertEqual((self.config / "ghcr-enabled").read_text(), "off\n")
        self.assertIn(("disable", "--now", "portikus-registry-ghcr.service"), self.systemctl_calls())
        self.assertFalse(self.status()["ghcrEnabled"])
        self.assertFalse(self.status()["ghcrUp"])

    def test_the_egress_helper_is_started_after_the_switch_on_and_off(self):
        self.helper.set_ghcr(False)
        calls = self.systemctl_calls()
        # Twice: the first may only wait for a run that read the old switch.
        self.assertEqual(calls[-2:], [("start", "portikus-egress-apply.service")] * 2)
        self.assertLess(calls.index(("disable", "--now", "portikus-registry-ghcr.service")), len(calls) - 2)


class RenderTest(Base):
    def config_for(self, name):
        self.helper.render(name)
        text = (self.config / f"{name}.yml").read_text()
        return json.loads(text.split("\n", 1)[1])

    def test_hub_listens_on_the_gateway_only_with_no_access_log_or_debug(self):
        config = self.config_for("hub")
        self.assertEqual(config["http"]["addr"], "10.200.0.1:5000")
        self.assertNotIn("debug", config["http"])
        self.assertEqual(config["log"]["accesslog"], {"disabled": True})
        self.assertIn(config["log"]["level"], ("warn", "error"))
        self.assertEqual(config["storage"]["filesystem"]["rootdirectory"], str(self.mount / "hub"))
        self.assertEqual(stat.S_IMODE((self.mount / "hub").stat().st_mode), 0o700)

    def test_ghcr_serves_tls_on_5001(self):
        config = self.config_for("ghcr")
        self.assertEqual(config["http"]["addr"], "10.200.0.1:5001")
        self.assertEqual(config["http"]["tls"]["certificate"], str(self.config / "ghcr.crt"))
        self.assertEqual(config["proxy"], {"remoteurl": "https://ghcr.io"})

    def test_notifications_carry_the_token_to_the_workers_port(self):
        endpoint = self.config_for("hub")["notifications"]["endpoints"][0]
        self.assertEqual(endpoint["url"], "http://127.0.0.1:8799/registry/events")
        self.assertEqual(endpoint["headers"], {"X-Portikus-Registry-Token": ["t0ken"]})
        self.assertIn("application/octet-stream", endpoint["ignore"]["mediatypes"])

    def test_ghcr_notifications_name_their_registry(self):
        endpoint = self.config_for("ghcr")["notifications"]["endpoints"][0]
        self.assertEqual(endpoint["url"], "http://127.0.0.1:8799/registry/events?registry=ghcr.io")
        self.assertEqual(endpoint["headers"], {"X-Portikus-Registry-Token": ["t0ken"]})

    def test_the_default_port_without_one_in_worker_env(self):
        self.worker_env.write_text("LOG_LEVEL=info\n")
        endpoint = self.config_for("hub")["notifications"]["endpoints"][0]
        self.assertEqual(endpoint["url"], "http://127.0.0.1:8792/registry/events")

    def test_no_notifications_without_a_token(self):
        (self.config / "events-token").unlink()
        self.assertNotIn("notifications", self.config_for("hub"))

    def test_render_refuses_while_unmounted(self):
        self.host.mounted = False
        with self.assertRaises(SystemExit):
            self.helper.render("hub")

    def test_render_refuses_a_planted_link(self):
        (self.mount / "hub").symlink_to(self.tmp.name)
        with self.assertRaises(SystemExit):
            self.helper.render("hub")

    def test_unknown_cache(self):
        with self.assertRaises(SystemExit):
            self.helper.render("quay")


class StatusTest(Base):
    def test_status_matches_the_contract(self):
        status = self.helper.write_status()
        self.assertEqual(set(status), {"sizeBytes", "usedBytes", "hubUp", "ghcrEnabled", "ghcrUp",
                                       "hubCredentialSet", "lastClearedAt", "lastClearReason", "lastClearError",
                                       "updatedAt"})
        self.assertEqual(status["sizeBytes"], 1000 * 4096)
        self.assertEqual(status["usedBytes"], 100 * 4096)
        self.assertEqual(stat.S_IMODE((self.jobs / "status.json").stat().st_mode), 0o644)
        self.assertRegex(status["updatedAt"], rj.DATETIME_RE)

    def test_status_while_unmounted(self):
        self.host.mounted = False
        self.host.up["hub"] = False
        status = self.helper.write_status()
        self.assertEqual((status["sizeBytes"], status["usedBytes"], status["hubUp"]), (0, 0, False))

    def test_status_keeps_the_last_clear(self):
        self.helper.clear("admin")
        first = self.status()["lastClearedAt"]
        self.helper.write_status()
        self.assertEqual(self.status()["lastClearedAt"], first)


if __name__ == "__main__":
    unittest.main()
