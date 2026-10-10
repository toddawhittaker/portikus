"""Unit tests for packaging/site/site-job (ADR 0059, SPEC.md sections 21.12 and 24).

Every host command (squid, systemctl, systemd-run, journalctl,
debconf-set-selections and the platforms check) goes to FakeRun, and the
module's own `run` is replaced so a command that slipped past it fails the
test instead of reaching this machine. `systemctl start portikus-setup.service`
is the fake setup. write-settings is the real one, run on a temporary tree
laid out like a server.
Run: python3 -B -m unittest discover -s packaging/site/tests
"""

import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
# The unit runs the job under UMask=0077; test under it too so no mode leans on the umask.
os.umask(0o077)
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def _load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


sj = _load("site_job", REPO / "packaging/site/site-job")
aj = _load("alerts_job_for_site", REPO / "packaging/alerts/alerts-job")
values = sys.modules["site_values"]


def _no_real_commands(argv, timeout=60, stdin=None):
    raise AssertionError(f"a test reached a real command: {argv!r}")


sj.run = _no_real_commands
aj.run = _no_real_commands

JOB = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
JOB2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
JOB3 = "2b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
INVOCATION = "0123456789abcdef0123456789abcdef"
# Obviously fake secrets, long enough to search for.
SECRET = "fake-new-client-secret-0123456789"
STORED = "fake-stored-client-secret-0123456789"
FIXTURE = json.loads((HERE / "fixtures/values.json").read_text())["fields"]
START = 1_790_000_000.0


class FakeRun:
    """Plays the host's commands; `rc` sets an exit code per command name, `setup` one per setup run."""

    def __init__(self, host):
        self.host = host
        self.calls = []
        self.stdin = []
        self.rc = {}
        self.setup = []
        self.setup_output = f"TASK [dex] ok\nchanged: client {SECRET}\nportikus_dex_upstream_client_secret: {SECRET}\n"
        self.setup_state = "inactive"
        self.seen_config = []

    def name(self, argv):
        if argv[0] == "squid":
            return "parse"
        if argv[0] == sj.NODE:
            return "platforms-check"
        if argv[0] in ("systemd-run", "journalctl", "debconf-set-selections"):
            return argv[0]
        if argv[0] == "systemctl":
            if argv[1] == "start" and argv[2] == sj.SETUP_UNIT:
                return "setup"
            if argv[1] == "try-reload-or-restart":
                return "reload"
            if argv[1] == "try-restart" and argv[2] == sj.API_UNIT:
                return "api-restart"
            if argv[1:4] == ["show", "-P", "ActiveState"]:
                return "setup-state"
            if argv[1:4] == ["show", "-P", "InvocationID"]:
                return "invocation"
            if argv[1] in ("stop", "reset-failed", "is-active"):
                return "timer-" + argv[1]
        raise AssertionError(f"unexpected command {argv!r}")

    def __call__(self, argv, timeout=60, stdin=None):
        name = self.name(argv)
        self.calls.append((name, list(argv)))
        if stdin is not None:
            self.stdin.append(stdin)
        if name == "setup":
            self.seen_config.append(Path(self.host.path(sj.CONFIG_FILE)).read_text())
            return (self.setup.pop(0) if self.setup else 0), ""
        if name == "setup-state":
            return 0, self.setup_state + "\n"
        if name == "invocation":
            return 0, INVOCATION + "\n"
        if name == "journalctl":
            return 0, self.setup_output
        if name == "timer-is-active":
            return self.rc.get(name, 3), ""
        return self.rc.get(name, 0), ""

    def names(self):
        return [name for name, _ in self.calls]

    def argv(self, name):
        return [argv for n, argv in self.calls if n == name]


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now


class Host(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="sitejob-")
        self.addCleanup(shutil.rmtree, self.root)
        for path in ("/etc/portikus/certificate", "/etc/squid", sj.JOBS_DIR, sj.PROXY_DIR):
            os.makedirs(self.path(path))
        Path(self.path(sj.SQUID_CONF)).write_text("include /etc/portikus/egress-proxy.d/*.conf\n")
        Path(self.path(sj.PROXY_DIR), "alerts.conf").write_text("# alerts\n")
        self.fake = FakeRun(self)
        self.clock = Clock()
        self.runner = sj.Runner(root=self.root, run_=self.fake, clock=self.clock,
                                write_settings=str(REPO / "packaging/site/write-settings"),
                                settings_keys=str(REPO / "packaging/debian/settings-keys"))
        self.journal = io.StringIO()

    def path(self, absolute):
        return self.root + absolute

    def install(self, config=None, secrets=None):
        """An apt install's settings, as postinst wrote them."""
        Path(self.path(sj.CONFIG_FILE)).write_text(config if config is not None else (
            "portikus_admin_email: admin@example.edu\nportikus_dex_upstream: none\n"
            "portikus_public_host: portikus.example.edu\nportikus_storage: file\n"
            "portikus_storage_size: 100\nportikus_tls: internal\n"))
        if secrets is not None:
            Path(self.path("/etc/portikus/secrets.yaml")).write_text(secrets)

    def request(self, kind, job_id=JOB, raw=None, **body):
        doc = {"version": 1, "id": job_id, "kind": kind, "requestedAt": "2026-10-10T12:00:00.000Z", **body}
        path = os.path.join(self.path(sj.JOBS_DIR), f"request-{job_id}.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(raw if raw is not None else json.dumps(doc))
        return path

    def run_pending(self):
        with contextlib.redirect_stderr(self.journal):
            return self.runner.run_pending()

    def play(self, kind, job_id=JOB, **body):
        self.request(kind, job_id, **body)
        self.run_pending()
        return self.status(job_id)

    def expire(self, job_id=JOB):
        with contextlib.redirect_stderr(self.journal):
            return self.runner.run_expire(job_id)

    def status(self, job_id=JOB):
        return json.loads(Path(self.path(sj.JOBS_DIR), "status", f"{job_id}.json").read_text())

    def log(self, job_id=JOB):
        path = Path(self.path(sj.JOBS_DIR), "status", f"{job_id}.log")
        return path.read_text() if path.exists() else ""

    def config(self):
        return Path(self.path(sj.CONFIG_FILE)).read_text()

    def secrets(self):
        path = Path(self.path("/etc/portikus/secrets.yaml"))
        return path.read_text() if path.exists() else ""

    def include(self, name):
        path = Path(self.path(sj.PROXY_DIR), name)
        return path.read_text() if path.exists() else None

    def everything_written(self):
        """Every byte the job left where the API, the journal or a process listing could see it."""
        status_dir = Path(self.path(sj.JOBS_DIR), "status")
        files = "".join(p.read_text() for p in status_dir.iterdir()) if status_dir.exists() else ""
        argv = json.dumps([argv for _, argv in self.fake.calls])
        return files + self.journal.getvalue() + argv + "".join(self.fake.stdin)


def platform(**over):
    return {"name": "Canvas", "issuer": "https://canvas.example.edu", "clientId": "abc",
            "authLoginUrl": "https://canvas.example.edu/login", "keysetUrl": "https://keys.example.edu/jwks",
            "deploymentIds": ["1"], "mock": False, **over}


OIDC = {"provider": "oidc", "oidcIssuer": "https://login.example.edu/realms/main", "clientId": "portikus-dex",
        "clientSecret": SECRET, "groups": {"student": "students", "instructor": "staff", "admin": "it admins"}}


class ValueRules(unittest.TestCase):
    """The job agrees with packages/contracts/src/site.ts on every value in the shared fixture."""

    CHECKS = {
        "proxyHost": values.check_proxy_host,
        "siteHost": values.check_site_host,
        "sitePort": values.check_port,
        "httpsUrl": lambda v: values.check_https_url(v, False),
        "keysetUrl": lambda v: values.check_https_url(v, True),
        "identifier": values.check_identifier,
        "groupName": values.check_group,
        "tenantId": values.check_tenant,
        "oidcIssuer": values.check_oidc_issuer,
        "groupsClaim": values.check_groups_claim,
        "clientSecret": values.check_client_secret,
        "platformName": values.check_platform_name,
    }

    def test_every_fixture_field_has_a_check(self):
        self.assertEqual(set(FIXTURE), set(self.CHECKS))

    def test_good_values_pass_and_bad_ones_are_refused(self):
        for field, cases in FIXTURE.items():
            for value in cases["good"]:
                with self.subTest(field=field, good=value):
                    self.CHECKS[field](value)
            for value in cases["bad"]:
                with self.subTest(field=field, bad=value):
                    with self.assertRaises(values.Refused):
                        self.CHECKS[field](value)

    def test_a_template_expression_is_refused_in_every_text_field(self):
        for field, check in self.CHECKS.items():
            if field == "sitePort":
                continue
            with self.subTest(field=field):
                with self.assertRaises(values.Refused):
                    check("{{ 7*7 }}")

    def test_reserved_ports_have_their_own_code(self):
        for port in values.RESERVED_PORTS:
            with self.assertRaises(values.Refused) as caught:
                values.check_port(port)
            self.assertEqual(caught.exception.code, "reserved_port")

    def test_reserved_ports_match_the_contract(self):
        source = (REPO / "packages/contracts/src/site.ts").read_text()
        block = re.search(r"SITE_RESERVED_PORTS[^=]*=\s*\[([^\]]*)\]", source).group(1)
        self.assertEqual(tuple(int(p) for p in re.findall(r"\d+", block)), values.RESERVED_PORTS)

    def test_codes_match_the_contract(self):
        source = (REPO / "packages/contracts/src/site.ts").read_text()
        block = re.search(r"SiteJobCode = z\.enum\(\[([^\]]*)\]", source).group(1)
        self.assertEqual(tuple(re.findall(r'"([a-z_]+)"', block)), sj.CODES)

    def test_every_code_used_is_listed(self):
        source = (REPO / "packaging/site/site-job").read_text() + (REPO / "packaging/site/site_values.py").read_text()
        used = set(re.findall(r'(?:Refused|JobFailed)\("([a-z_]+)"', source))
        used |= set(re.findall(r'"code": "([a-z_]+)"', source))
        self.assertTrue(used <= set(sj.CODES), used - set(sj.CODES))


class Requests(Host):
    def test_refusals_by_kind(self):
        cases = [
            ("proxy-hosts", {"hosts": ["{{ 7*7 }}"]}, "invalid_value"),
            ("proxy-hosts", {"hosts": ["10.0.0.1"]}, "invalid_value"),
            ("proxy-hosts", {"hosts": [f"h{i}.example.com" for i in range(51)]}, "too_many"),
            ("proxy-hosts", {"hosts": ["a.example.com", "a.example.com"]}, "duplicate"),
            ("proxy-hosts", {"hosts": [], "extra": 1}, "invalid_request"),
            ("lti-platforms", {"platforms": [platform(mock=True)]}, "mock_platform"),
            ("lti-platforms", {"platforms": [platform(name="{{ 7*7 }}")]}, "invalid_value"),
            ("lti-platforms", {"platforms": [platform(keysetUrl="https://keys.example.edu:8443/jwks")]},
             "invalid_value"),
            ("lti-platforms", {"platforms": [platform(issuer="http://canvas.example.edu")]}, "invalid_value"),
            ("lti-platforms", {"platforms": [platform(name=f"p{i}", clientId=f"c{i}") for i in range(21)]},
             "too_many"),
            ("lti-platforms", {"platforms": [platform(), platform(clientId="other")]}, "duplicate"),
            ("lti-platforms", {"platforms": [platform(name="b"), platform(name="c")]}, "duplicate"),
            ("lti-platforms", {"platforms": [platform(extra=1)]}, "invalid_request"),
            ("address", {"host": "{{ 7*7 }}.example.edu", "port": 443}, "invalid_value"),
            ("address", {"host": "portikus.example.edu", "port": 3128}, "reserved_port"),
            ("address", {"host": "portikus.example.edu", "port": 80}, "invalid_value"),
            ("signin", {"provider": "ldap", "clientSecret": None}, "invalid_value"),
            ("signin", {"provider": "dex", "clientSecret": SECRET}, "invalid_value"),
            ("signin", {"provider": "oidc", "clientId": "a", "clientSecret": None}, "invalid_value"),
            ("signin", {**OIDC, "groups": {"student": "{{ 7*7 }}", "instructor": "i", "admin": "a"}},
             "invalid_value"),
            ("signin", {**OIDC, "groupsClaim": "{{ 7*7 }}"}, "invalid_value"),
            ("signin", {**OIDC, "oidcIssuer": "https://169.254.169.254/latest"}, "invalid_value"),
            ("signin", {**OIDC, "oidcIssuer": "https://login.example.edu:22"}, "invalid_value"),
            ("lti-platforms", {"platforms": [platform(), platform(name="b", clientId="other",
                                                                 keysetUrl="https://evil.example.com/jwks")]},
             "duplicate"),
            ("signin", {"provider": "dex"}, "invalid_request"),
            ("keep", {"trialId": "not-a-uuid"}, "invalid_request"),
            ("rollback", {"trialId": JOB}, "no_open_trial"),
            ("keep", {"trialId": JOB}, "no_open_trial"),
        ]
        for index, (kind, body, code) in enumerate(cases):
            job_id = f"{index:08x}-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
            with self.subTest(kind=kind, body=body):
                status = self.play(kind, job_id, **body)
                self.assertEqual((status["kind"], status["state"], status["code"]), (kind, "failed", code))
                self.assertIsNotNone(status["finishedAt"])
        self.assertNotIn("parse", self.fake.names())
        self.assertFalse(os.path.exists(self.path(sj.PROXY_HOSTS_FILE)))

    def test_a_malformed_head_is_refused(self):
        for index, raw in enumerate([
            json.dumps({"version": 2, "id": JOB, "kind": "proxy-hosts", "requestedAt": "2026-10-10T12:00:00Z",
                        "hosts": []}),
            json.dumps({"version": 1, "id": JOB2, "kind": "proxy-hosts", "requestedAt": "2026-10-10T12:00:00Z",
                        "hosts": []}),
            json.dumps({"version": 1, "id": JOB, "kind": "proxy-hosts", "requestedAt": "yesterday", "hosts": []}),
            '{"version": 1, "version": 1, "id": "%s", "kind": "proxy-hosts", "requestedAt": '
            '"2026-10-10T12:00:00Z", "hosts": []}' % JOB,
        ]):
            with self.subTest(index=index):
                shutil.rmtree(Path(self.path(sj.JOBS_DIR), "status"), ignore_errors=True)
                self.request("proxy-hosts", raw=raw)
                self.run_pending()
                if index == 3:
                    # A duplicate key leaves no kind to name, so only the journal hears of it.
                    self.assertFalse(Path(self.path(sj.JOBS_DIR), "status", f"{JOB}.json").exists())
                else:
                    self.assertEqual(self.status()["code"], "invalid_request")

    def test_a_request_is_deleted_whatever_it_holds(self):
        path = self.request("proxy-hosts", raw="not json")
        self.run_pending()
        self.assertFalse(os.path.exists(path))
        self.assertIn("invalid_request", self.journal.getvalue())

    def test_a_link_is_never_followed(self):
        target = Path(self.root, "elsewhere.json")
        target.write_text("{}")
        os.symlink(target, os.path.join(self.path(sj.JOBS_DIR), f"request-{JOB}.json"))
        self.run_pending()
        self.assertTrue(target.exists())
        self.assertFalse(os.path.lexists(os.path.join(self.path(sj.JOBS_DIR), f"request-{JOB}.json")))

    def test_status_files_are_readable_by_the_jobs_group_only(self):
        self.play("proxy-hosts", hosts=["api.example.com"])
        status = Path(self.path(sj.JOBS_DIR), "status", f"{JOB}.json")
        self.assertEqual(stat.S_IMODE(status.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(status.parent.stat().st_mode), 0o750)

    def test_status_matches_the_contract_shape(self):
        status = self.play("proxy-hosts", hosts=[])
        self.assertEqual(set(status), {"id", "kind", "state", "code", "startedAt", "finishedAt", "trialEndsAt"})


class ProxyHosts(Host):
    def test_hosts_reach_the_proxy_on_443_by_connect(self):
        status = self.play("proxy-hosts", hosts=["api.example.com", "Files.Example.org"])
        self.assertEqual((status["state"], status["code"]), ("done", None))
        conf = self.include(sj.ADMIN_CONF)
        self.assertIn("acl portikus_site_hosts dstdomain -n api.example.com files.example.org\n", conf)
        self.assertIn("acl portikus_site_hosts_port port 443\n", conf)
        self.assertIn("http_access allow portikus_connect portikus_site_hosts portikus_site_hosts_port\n", conf)
        page = Path(self.path(sj.PROXY_HOSTS_FILE))
        self.assertEqual(json.loads(page.read_text()), {"version": 1, "hosts": ["api.example.com", "Files.Example.org"]})
        self.assertEqual(stat.S_IMODE(page.stat().st_mode), 0o640)
        self.assertEqual(self.fake.names(), ["parse", "reload"])
        self.assertFalse(os.path.exists(os.path.join(self.path(sj.PROXY_DIR), sj.RELOAD_PENDING)))

    def test_an_empty_list_allows_nothing(self):
        self.play("proxy-hosts", hosts=["api.example.com"])
        self.play("proxy-hosts", JOB2, hosts=[])
        self.assertNotIn("acl", self.include(sj.ADMIN_CONF))

    def test_a_rejected_include_rolls_back(self):
        self.play("proxy-hosts", hosts=["api.example.com"])
        before = self.include(sj.ADMIN_CONF)
        self.fake.rc["parse"] = 1
        status = self.play("proxy-hosts", JOB2, hosts=["other.example.com"])
        self.assertEqual((status["state"], status["code"]), ("failed", "proxy_config_rejected"))
        self.assertEqual(self.include(sj.ADMIN_CONF), before)
        self.assertEqual(json.loads(Path(self.path(sj.PROXY_HOSTS_FILE)).read_text())["hosts"], ["api.example.com"])
        self.assertEqual(self.fake.names()[-1], "parse")
        self.assertFalse(os.path.exists(os.path.join(self.path(sj.PROXY_DIR), sj.RELOAD_PENDING)))

    def test_a_first_include_that_is_rejected_leaves_none(self):
        self.fake.rc["parse"] = 1
        self.play("proxy-hosts", hosts=["api.example.com"])
        self.assertIsNone(self.include(sj.ADMIN_CONF))

    def test_a_failed_reload_is_retried_by_the_next_run(self):
        self.fake.rc["reload"] = 1
        status = self.play("proxy-hosts", hosts=["api.example.com"])
        self.assertEqual(status["code"], "proxy_reload_failed")
        self.assertTrue(os.path.exists(os.path.join(self.path(sj.PROXY_DIR), sj.RELOAD_PENDING)))
        self.fake.rc["reload"] = 0
        self.play("proxy-hosts", JOB2, hosts=["api.example.com"])
        self.assertEqual(self.fake.names()[-1], "reload")
        self.assertFalse(os.path.exists(os.path.join(self.path(sj.PROXY_DIR), sj.RELOAD_PENDING)))

    def test_a_hand_edit_is_put_back_by_the_next_job(self):
        self.play("proxy-hosts", hosts=["api.example.com"])
        Path(self.path(sj.PROXY_DIR), sj.ADMIN_CONF).write_text("http_access allow all\n")
        self.play("proxy-hosts", JOB2, hosts=["api.example.com"])
        self.assertEqual(self.include(sj.ADMIN_CONF), sj.render_admin(["api.example.com"]))

    def test_sync_brings_the_includes_in_line_with_the_page_files(self):
        self.play("proxy-hosts", hosts=["api.example.com"])
        Path(self.path(sj.PROXY_DIR), sj.ADMIN_CONF).unlink()
        Path(self.path(sj.LTI_ADMIN_FILE)).write_text(json.dumps({"version": 1, "platforms": [platform()]}))
        with contextlib.redirect_stderr(self.journal):
            self.assertTrue(self.runner.sync())
        self.assertIn("api.example.com", self.include(sj.ADMIN_CONF))
        self.assertIn("keys.example.edu", self.include(sj.LTI_CONF))
        with contextlib.redirect_stderr(self.journal):
            self.assertFalse(self.runner.sync())

    def test_a_broken_page_file_syncs_as_empty(self):
        Path(self.path(sj.PROXY_HOSTS_FILE)).write_text('{"version": 1, "hosts": ["{{ 7*7 }}"]}')
        with contextlib.redirect_stderr(self.journal):
            self.runner.sync()
        self.assertNotIn("acl", self.include(sj.ADMIN_CONF))
        self.assertIn("not a valid page file", self.journal.getvalue())


class SharedSquidLock(Host):
    def test_the_job_waits_for_the_alerts_job_lock(self):
        alerts = aj.Runner(root=self.root, run_=lambda argv, timeout=60: 0)
        held = alerts.locked()
        done = threading.Event()

        def job():
            self.play("proxy-hosts", hosts=["api.example.com"])
            done.set()

        thread = threading.Thread(target=job)
        thread.start()
        time.sleep(0.3)
        self.assertFalse(done.is_set())
        self.assertNotIn("parse", self.fake.names())
        os.close(held)
        thread.join(5)
        self.assertTrue(done.is_set())
        self.assertEqual(self.status()["state"], "done")

    def test_both_jobs_lock_the_same_folder(self):
        self.assertEqual(aj.PROXY_DIR, sj.PROXY_DIR)
        self.assertEqual(aj.RELOAD_PENDING, sj.RELOAD_PENDING)
        held = self.runner.squid_locked()
        try:
            probe = os.open(self.path(aj.PROXY_DIR), os.O_RDONLY | os.O_DIRECTORY)
            with self.assertRaises(BlockingIOError):
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.close(probe)
        finally:
            os.close(held)


class LtiPlatforms(Host):
    def test_platforms_are_checked_written_and_their_hosts_allowed(self):
        status = self.play("lti-platforms", platforms=[platform(authTokenUrl="https://token.example.edu/token")])
        self.assertEqual((status["state"], status["code"]), ("done", None))
        page = Path(self.path(sj.LTI_ADMIN_FILE))
        self.assertEqual(json.loads(page.read_text())["platforms"][0]["authTokenUrl"], "https://token.example.edu/token")
        self.assertEqual(stat.S_IMODE(page.stat().st_mode), 0o640)
        self.assertIn("dstdomain -n keys.example.edu token.example.edu\n", self.include(sj.LTI_CONF))
        self.assertIn("port 443\n", self.include(sj.LTI_CONF))
        self.assertEqual(self.fake.names(), ["platforms-check", "parse", "reload", "api-restart"])
        check = self.fake.argv("platforms-check")[0]
        self.assertEqual(check[1], sj.PLATFORMS_CHECK)
        self.assertFalse(any(name.endswith(".check") for name in os.listdir(self.path(sj.ETC))))

    def test_the_api_parser_refusing_changes_nothing(self):
        self.fake.rc["platforms-check"] = 1
        status = self.play("lti-platforms", platforms=[platform()])
        self.assertEqual(status["code"], "invalid_value")
        self.assertFalse(os.path.exists(self.path(sj.LTI_ADMIN_FILE)))
        self.assertIsNone(self.include(sj.LTI_CONF))
        self.assertFalse(any(name.endswith(".check") for name in os.listdir(self.path(sj.ETC))))

    def test_an_operator_pair_is_refused(self):
        Path(self.path(sj.LTI_OPERATOR_FILE)).write_text(json.dumps({"version": 1, "platforms": [
            {"name": "Mock", "issuer": "https://canvas.example.edu", "clientId": "abc", "mock": True}]}))
        status = self.play("lti-platforms", platforms=[platform()])
        self.assertEqual(status["code"], "operator_platform")
        self.assertEqual(self.fake.names(), [])

    def test_an_operator_issuer_with_another_keyset_is_refused(self):
        Path(self.path(sj.LTI_OPERATOR_FILE)).write_text(json.dumps({"version": 1, "platforms": [
            {"name": "Canvas", "issuer": "https://canvas.example.edu", "clientId": "operator",
             "keysetUrl": "https://keys.example.edu/jwks", "mock": False}]}))
        status = self.play("lti-platforms", platforms=[platform(keysetUrl="https://evil.example.com/jwks")])
        self.assertEqual(status["code"], "operator_platform")
        self.assertEqual(self.fake.names(), [])
        # Another client of the same platform, with the same keyset, is no impersonation.
        self.assertEqual(self.play("lti-platforms", JOB2, platforms=[platform()])["state"], "done")

    def test_none_left_removes_the_file(self):
        self.play("lti-platforms", platforms=[platform()])
        status = self.play("lti-platforms", JOB2, platforms=[])
        self.assertEqual(status["state"], "done")
        self.assertFalse(os.path.exists(self.path(sj.LTI_ADMIN_FILE)))
        self.assertNotIn("acl", self.include(sj.LTI_CONF))
        self.assertEqual(self.fake.names()[-1], "api-restart")

    def test_a_failed_api_restart_is_reported(self):
        self.fake.rc["api-restart"] = 1
        status = self.play("lti-platforms", platforms=[platform()])
        self.assertEqual((status["state"], status["code"]), ("failed", "api_restart_failed"))

    def test_a_rejected_include_keeps_the_old_platforms(self):
        self.play("lti-platforms", platforms=[platform()])
        before = Path(self.path(sj.LTI_ADMIN_FILE)).read_text()
        self.fake.rc["parse"] = 1
        status = self.play("lti-platforms", JOB2, platforms=[platform(keysetUrl="https://new.example.edu/jwks")])
        self.assertEqual(status["code"], "proxy_config_rejected")
        self.assertEqual(Path(self.path(sj.LTI_ADMIN_FILE)).read_text(), before)
        self.assertNotIn("new.example.edu", self.include(sj.LTI_CONF))


class Trials(Host):
    def setUp(self):
        super().setUp()
        self.install(secrets="portikus_alert_pushover_user_key: u1\n")

    def debconf(self):
        return "".join(self.fake.stdin)

    def test_off_an_apt_install_nothing_is_tried(self):
        os.unlink(self.path(sj.CONFIG_FILE))
        status = self.play("address", host="new.example.edu", port=8443)
        self.assertEqual(status["code"], "not_apt_install")
        self.assertEqual(self.fake.names(), [])

    def test_a_signin_trial_writes_the_answers_and_reruns_setup(self):
        before_config, before_secrets = self.config(), self.secrets()
        status = self.play("signin", **OIDC)
        self.assertEqual((status["state"], status["code"]), ("trial", None))
        self.assertEqual(status["trialEndsAt"], sj.now_iso(lambda: START + 30 * 60))
        self.assertIsNone(status["finishedAt"])
        self.assertIn("portikus_dex_upstream: oidc\n", self.fake.seen_config[0])
        self.assertIn("portikus_dex_upstream_issuer: https://login.example.edu/realms/main\n", self.config())
        self.assertIn("portikus_oidc_admin_group: it admins\n", self.config())
        self.assertIn(f"portikus_dex_upstream_client_secret: {SECRET}\n", self.secrets())
        self.assertIn("portikus_alert_pushover_user_key: u1\n", self.secrets())
        self.assertIn("portikus portikus/provider select oidc\n", self.debconf())
        self.assertIn("portikus portikus/admin_group string it admins\n", self.debconf())
        # The deadline timer stands in during setup, then the trial's own replaces it.
        units = [argv[1] for argv in self.fake.argv("systemd-run")]
        self.assertEqual(units, [f"--unit=portikus-site-trial-{JOB}-setup", f"--unit=portikus-site-trial-{JOB}-trial"])
        self.assertEqual(self.fake.argv("systemd-run")[1][2], "--on-active=1800s")
        self.assertEqual(self.fake.argv("systemd-run")[1][-3:], [sj.SITE_JOB, "expire", JOB])
        state = Path(self.path(sj.STATE_DIR))
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
        self.assertEqual((state / "before-portikus.yaml").read_text(), before_config)
        self.assertEqual((state / "before-secrets.yaml").read_text(), before_secrets)

    def test_a_signin_without_groups_keeps_the_stored_ones_and_never_writes_a_blank(self):
        # The API refuses an empty group name and stops (packages/config), so no trial may write one.
        bare = {k: v for k, v in OIDC.items() if k != "groups"}
        self.play("signin", **bare)
        self.assertNotIn("_group: ''", self.config())
        self.assertNotIn("portikus portikus/admin_group string \n", self.debconf())
        self.play("rollback", JOB2, trialId=JOB)
        self.install(config=self.config().replace("portikus_dex_upstream: none\n", "portikus_dex_upstream: none\n"
                                                  "portikus_oidc_admin_group: it admins\n"))
        self.play("signin", JOB3, **bare)
        self.assertIn("portikus_oidc_admin_group: it admins\n", self.config())

    def test_no_secret_reaches_status_log_journal_debconf_or_arguments(self):
        self.play("signin", **OIDC)
        self.assertIn("TASK [dex] ok", self.log())
        self.assertIn("portikus_dex_upstream_client_secret: [secret]", self.log())
        self.assertNotIn(SECRET, self.everything_written())
        self.play("rollback", JOB2, trialId=JOB)
        self.assertNotIn(SECRET, self.everything_written())

    def test_a_stored_secret_in_setup_output_is_hidden_too(self):
        self.install(secrets=f"portikus_alert_pushover_app_token: '{STORED}'\n")
        self.fake.setup_output = f"fatal: the token {STORED} was refused\n"
        self.play("address", host="new.example.edu", port=443)
        self.assertIn("fatal: the token [secret] was refused", self.log())
        self.assertNotIn(STORED, self.everything_written())

    def test_keep_ends_the_trial(self):
        self.play("signin", **OIDC)
        config = self.config()
        status = self.play("keep", JOB2, trialId=JOB)
        self.assertEqual((status["state"], status["code"]), ("done", None))
        trial = self.status(JOB)
        self.assertEqual((trial["state"], trial["code"], trial["trialEndsAt"]), ("kept", None, None))
        self.assertIsNotNone(trial["finishedAt"])
        self.assertEqual(self.config(), config)
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])
        self.assertIn(["systemctl", "stop", f"portikus-site-trial-{JOB}-trial.timer"], self.fake.argv("timer-stop"))
        # Kept means the deadline does nothing.
        self.clock.now += 3600
        self.expire()
        self.assertEqual(self.config(), config)

    def test_a_rollback_puts_the_old_answers_back(self):
        before_config, before_secrets = self.config(), self.secrets()
        self.play("signin", **OIDC)
        status = self.play("rollback", JOB2, trialId=JOB)
        self.assertEqual((status["state"], status["code"]), ("done", None))
        self.assertEqual((self.config(), self.secrets()), (before_config, before_secrets))
        self.assertEqual(self.fake.seen_config[-1], before_config)
        self.assertIn("portikus portikus/provider select dex\n", self.debconf())
        trial = self.status(JOB)
        self.assertEqual((trial["state"], trial["code"]), ("reverted", "rolled_back"))
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])

    def test_an_unkept_trial_expires(self):
        before = self.config()
        self.play("address", host="new.example.edu", port=8443)
        self.assertIn("portikus_public_port: 8443\n", self.config())
        self.assertIn("portikus_public_host: new.example.edu\n", self.config())
        self.assertEqual(self.status()["trialEndsAt"], sj.now_iso(lambda: START + 15 * 60))
        # A timer that fires early waits on.
        self.clock.now += 60
        self.expire()
        self.assertEqual(self.status()["state"], "trial")
        self.clock.now += 15 * 60
        self.expire()
        self.assertEqual(self.config(), before)
        trial = self.status()
        self.assertEqual((trial["state"], trial["code"]), ("reverted", "trial_expired"))
        self.assertEqual(self.fake.names().count("setup"), 2)

    def test_a_failed_setup_puts_the_old_answers_back(self):
        before = self.config()
        self.fake.setup = [1, 0]
        status = self.play("address", host="new.example.edu", port=443)
        self.assertEqual((status["state"], status["code"]), ("reverted", "setup_failed"))
        self.assertEqual(self.config(), before)
        self.assertEqual(self.fake.seen_config[-1], before)
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])

    def test_setup_failing_twice_is_a_failure(self):
        self.fake.setup = [1, 1]
        status = self.play("address", host="new.example.edu", port=443)
        self.assertEqual((status["state"], status["code"]), ("failed", "setup_failed"))

    def test_only_one_trial_at_a_time(self):
        self.play("signin", **OIDC)
        status = self.play("address", JOB2, host="new.example.edu", port=443)
        self.assertEqual(status["code"], "trial_open")
        self.assertEqual(self.fake.names().count("setup"), 1)
        # Proxy hosts are not a trial and go ahead.
        self.assertEqual(self.play("proxy-hosts", JOB3, hosts=[])["state"], "done")

    def test_a_running_setup_is_busy(self):
        self.fake.setup_state = "activating"
        status = self.play("address", host="new.example.edu", port=443)
        self.assertEqual(status["code"], "busy")
        self.assertNotIn("setup", self.fake.names())

    def test_a_held_trial_lock_is_busy(self):
        held = self.runner.trial_locked(wait=True)
        try:
            status = self.play("signin", **OIDC)
        finally:
            os.close(held)
        self.assertEqual(status["code"], "busy")
        self.assertNotIn(SECRET, self.secrets())

    def test_keep_needs_the_open_trial(self):
        self.play("signin", **OIDC)
        status = self.play("keep", JOB2, trialId=JOB3)
        self.assertEqual(status["code"], "no_open_trial")
        self.assertEqual(self.status(JOB)["state"], "trial")

    def test_a_changed_provider_never_receives_the_old_secret(self):
        self.install(config=self.config().replace("portikus_dex_upstream: none", "portikus_dex_upstream: oidc\n"
                                                  "portikus_dex_upstream_issuer: https://old.example.edu\n"
                                                  "portikus_dex_upstream_client_id: portikus-dex"),
                     secrets=f"portikus_dex_upstream_client_secret: {STORED}\n")
        before = self.config()
        status = self.play("signin", **{**OIDC, "clientSecret": None})
        self.assertEqual(status["code"], "missing_secret")
        self.assertEqual(self.config(), before)
        # The same issuer and client keep the stored secret.
        status = self.play("signin", JOB2, **{**OIDC, "oidcIssuer": "https://old.example.edu", "clientSecret": None})
        self.assertEqual(status["state"], "trial")
        self.assertIn(STORED, self.secrets())

    def test_dex_passwords_only_drops_the_client_secret(self):
        self.install(config=self.config().replace("portikus_dex_upstream: none", "portikus_dex_upstream: oidc"),
                     secrets=f"portikus_dex_upstream_client_secret: {STORED}\n")
        status = self.play("signin", provider="dex", clientSecret=None)
        self.assertEqual(status["state"], "trial")
        self.assertIn("portikus_dex_upstream: none\n", self.config())
        self.assertNotIn(STORED, self.secrets())

    def test_switching_from_ldap_drops_its_keys(self):
        self.install(config=self.config().replace("portikus_dex_upstream: none", "portikus_dex_upstream: ldap\n"
                                                  "portikus_ldap_host: ldap.example.edu"),
                     secrets="portikus_ldap_bind_password: fake-bind-password\n")
        self.play("signin", **OIDC)
        self.assertNotIn("ldap", self.config())
        self.assertNotIn("fake-bind-password", self.secrets())

    def test_a_dead_job_is_recovered_by_the_next_run(self):
        state_fd = self.runner.state_fd()
        self.runner.snapshot(state_fd)
        self.runner.write_trial(state_fd, {"id": JOB, "kind": "signin", "state": "running", "old": {}})
        os.close(state_fd)
        Path(self.path(sj.CONFIG_FILE)).write_text("portikus_public_host: half.example.edu\n")
        record = {"id": JOB, "kind": "signin", "state": "running", "code": None, "startedAt": "x",
                  "finishedAt": None, "trialEndsAt": None}
        self.runner.write_status(record)
        self.run_pending()
        self.assertIn("portikus.example.edu", self.config())
        self.assertEqual((self.status()["state"], self.status()["code"]), ("reverted", "setup_failed"))

    def test_a_reboot_rearms_the_timer_or_expires_the_trial(self):
        self.play("signin", **OIDC)
        runs = len(self.fake.argv("systemd-run"))
        self.clock.now += 60
        self.run_pending()
        self.assertEqual(len(self.fake.argv("systemd-run")), runs + 1)
        self.assertEqual(self.fake.argv("systemd-run")[-1][2], f"--on-active={30 * 60 - 60}s")
        self.clock.now += 3600
        self.run_pending()
        self.assertEqual(self.status()["code"], "trial_expired")

    def test_uploaded_files_must_cover_the_new_names(self):
        settings = {"source": "files", "site": {"certificate": {"names": ["portikus.example.edu"]}}, "preview": None}
        Path(self.path(sj.CERTIFICATE_SETTINGS)).write_text(json.dumps(settings))
        status = self.play("address", host="new.example.edu", port=443)
        self.assertEqual(status["code"], "certificate_not_covering")
        settings["site"]["certificate"]["names"] = ["new.example.edu", "*.preview.new.example.edu"]
        Path(self.path(sj.CERTIFICATE_SETTINGS)).write_text(json.dumps(settings))
        self.assertEqual(self.play("address", JOB2, host="new.example.edu", port=443)["state"], "trial")

    def test_a_hand_set_preview_suffix_needs_no_new_wildcard(self):
        self.install(config=self.config() + "portikus_preview_suffix: apps.example.edu\n")
        Path(self.path(sj.CERTIFICATE_SETTINGS)).write_text(json.dumps(
            {"source": "files", "site": {"certificate": {"names": ["new.example.edu"]}}}))
        self.assertEqual(self.play("address", host="new.example.edu", port=443)["state"], "trial")
        self.assertIn("portikus_preview_suffix: apps.example.edu\n", self.config())

    def test_the_site_is_never_under_a_hand_set_preview_suffix(self):
        self.install(config=self.config() + "portikus_preview_suffix: apps.example.edu\n")
        before = self.config()
        for index, host in enumerate(["apps.example.edu", "portikus.apps.example.edu"]):
            job_id = f"{index:08x}-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
            self.assertEqual(self.play("address", job_id, host=host, port=443)["code"], "invalid_value")
        self.assertEqual(self.config(), before)
        self.assertNotIn("setup", self.fake.names())

    def test_the_internal_authority_and_acme_need_no_check(self):
        Path(self.path(sj.CERTIFICATE_SETTINGS)).write_text('{"source": "acme"}')
        self.assertEqual(self.play("address", host="new.example.edu", port=443)["state"], "trial")

    def test_port_443_removes_a_hand_set_port(self):
        self.install(config=self.config() + "portikus_public_port: 8443\n")
        self.play("address", host="portikus.example.edu", port=443)
        self.assertNotIn("portikus_public_port", self.config())

    # ---- portikus.yaml changed outside the trial ----

    def rewrite_answers(self, **changes):
        """What postinst does on an upgrade, a reinstall or dpkg-reconfigure: write-settings from the answers."""
        answers = self.runner.read_settings()["answers"]
        self.runner.write_answers({**answers, **changes}, None, None)

    def test_a_reconfigure_during_a_trial_is_never_undone(self):
        self.play("address", host="new.example.edu", port=8443)
        self.rewrite_answers(public_host="other.example.edu")
        reconfigured = self.config()
        self.clock.now += 15 * 60
        self.expire()
        self.assertEqual(self.config(), reconfigured)
        trial = self.status()
        self.assertEqual((trial["state"], trial["code"], trial["trialEndsAt"]), ("failed", "trial_superseded", None))
        self.assertEqual(self.fake.names().count("setup"), 1)
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])
        self.assertIn(["systemctl", "stop", f"portikus-site-trial-{JOB}-trial.timer"], self.fake.argv("timer-stop"))

    def test_a_rollback_after_a_reconfigure_reports_it(self):
        self.play("signin", **OIDC)
        self.rewrite_answers(provider="dex")
        reconfigured = self.config()
        status = self.play("rollback", JOB2, trialId=JOB)
        self.assertEqual((status["state"], status["code"]), ("failed", "trial_superseded"))
        self.assertEqual(self.config(), reconfigured)

    def test_an_upgrade_that_writes_the_same_answers_keeps_the_trial(self):
        before = self.config()
        self.play("address", host="new.example.edu", port=8443)
        trial_config = self.config()
        self.rewrite_answers()
        self.assertEqual(self.config(), trial_config)
        self.clock.now += 15 * 60
        self.expire()
        self.assertEqual(self.config(), before)
        self.assertEqual(self.status()["code"], "trial_expired")

    def test_a_reinstall_with_other_answers_over_leftovers_is_never_undone(self):
        self.play("signin", **OIDC)
        # apt remove leaves /etc/portikus and the trial state; the reinstall writes its own answers.
        self.rewrite_answers(provider="dex", public_host="reinstalled.example.edu")
        reinstalled = self.config()
        self.clock.now += 3600
        self.run_pending()
        self.assertEqual(self.config(), reinstalled)
        self.assertEqual((self.status()["state"], self.status()["code"]), ("failed", "trial_superseded"))
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])

    def test_a_failing_debconf_changes_nothing(self):
        before = self.config()
        self.fake.rc["debconf-set-selections"] = 1
        status = self.play("signin", **OIDC)
        self.assertEqual(status["code"], "write_failed")
        self.assertEqual(self.config(), before)
        self.assertNotIn("setup", self.fake.names())
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])


if __name__ == "__main__":
    unittest.main()
