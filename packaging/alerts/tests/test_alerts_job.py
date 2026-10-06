"""Unit tests for packaging/alerts/alerts-job (ADR 0052, SPEC.md section 24).

Every squid and systemctl command goes to FakeRun, and the module's own `run`
is replaced so a command that slipped past it fails the test instead of
reaching this machine. Files live in a temporary tree laid out like a server.
Run: python3 -B -m unittest discover -s packaging/alerts/tests
"""

import contextlib
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
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
# The unit runs the job under UMask=0077; test under it too so no mode leans on the umask.
os.umask(0o077)
_PATH = Path(__file__).resolve().parents[1] / "alerts-job"
_loader = importlib.machinery.SourceFileLoader("alerts_job", str(_PATH))
aj = importlib.util.module_from_spec(importlib.util.spec_from_loader("alerts_job", _loader))
_loader.exec_module(aj)
REPO = Path(__file__).resolve().parents[3]


def _no_real_commands(argv, timeout=60):
    raise AssertionError(f"a test reached a real command: {argv!r}")


aj.run = _no_real_commands

JOB = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
JOB2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
# Obviously fake secrets, long enough to search for.
PASSWORD = "fake-smtp-password-0123456789"
TOKEN = "fake-ntfy-token-0123456789"
USER_KEY = "uFakeUserKey0123456789abcdefgh"
APP_TOKEN = "aFakeAppToken0123456789abcdefg"
WEBHOOK = "https://hooks.example.com/services/T000/B000/fake-webhook-secret"
NTFY = "https://ntfy.example.org/fake-secret-topic"
TEAMS = "https://teams.example.net/workflows/fake-teams-secret"
SECRETS = (PASSWORD, TOKEN, USER_KEY, APP_TOKEN, "fake-webhook-secret", "fake-secret-topic", "fake-teams-secret")


class FakeRun:
    """Plays squid -k parse and systemctl; `rc` sets an exit code per command."""

    def __init__(self):
        self.calls = []
        self.rc = {}

    def __call__(self, argv, timeout=60):
        self.calls.append(list(argv))
        if argv[0] == "squid":
            return self.rc.get("parse", 0)
        if argv[0] == "systemctl":
            return self.rc.get("reload", 0)
        raise AssertionError(f"unexpected command {argv!r}")

    def names(self):
        return ["parse" if c[0] == "squid" else "reload" for c in self.calls]


def full_settings():
    return {
        "version": 1,
        "smtp": {"host": "smtp.example.edu", "port": 587, "username": "portikus", "password": PASSWORD,
                 "from": "Portikus <portikus@example.edu>"},
        "alerts": {
            "email": {"to": ["ops@example.edu"]},
            "pushover": {"userKey": USER_KEY, "appToken": APP_TOKEN},
            "webhook": {"url": WEBHOOK},
            "ntfy": {"url": NTFY, "token": TOKEN},
            "teams": {"url": TEAMS},
        },
        "rootShellOpenedAlert": True,
    }


def update_from(settings, drop=()):
    """The update the page would send for settings, with the named secrets left out."""
    update = json.loads(json.dumps({k: settings[k] for k in ("smtp", "alerts", "rootShellOpenedAlert")}))
    for path in drop:
        block, key = path.rsplit(".", 1)
        target = update
        for part in block.split("."):
            target = target[part]
        del target[key]
    return update


class Host(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="alertsjob-")
        for path in ("/etc/portikus", "/etc/squid", aj.JOBS_DIR):
            os.makedirs(self.root + path)
        Path(self.root + aj.SQUID_CONF).write_text("include /etc/portikus/egress-proxy.d/*.conf\n")
        # Setup always leaves an alerts.conf, empty if need be.
        os.makedirs(self.root + aj.PROXY_DIR)
        Path(self.root + aj.PROXY_DIR, aj.PROXY_FILE).write_text(aj.render_proxy(aj.OFF))
        self.fake = FakeRun()
        self.runner = aj.Runner(root=self.root, run_=self.fake)
        self.journal = io.StringIO()
        self.addCleanup(shutil.rmtree, self.root)

    def path(self, absolute):
        return self.root + absolute

    def proxy(self, name=aj.PROXY_FILE):
        return os.path.join(self.path(aj.PROXY_DIR), name)

    def notify(self):
        return json.loads(Path(self.path(aj.NOTIFY_FILE)).read_text())

    def store(self, settings):
        Path(self.path(aj.NOTIFY_FILE)).write_text(json.dumps(settings))

    def request(self, settings, job_id=JOB, raw=None):
        path = os.path.join(self.path(aj.JOBS_DIR), f"request-{job_id}.json")
        doc = {"id": job_id, "requestedAt": "2026-10-05T12:00:00.000Z", "requestedBy": USER, "settings": settings}
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(raw if raw is not None else json.dumps(doc))
        return path

    def run_pending(self):
        with contextlib.redirect_stderr(self.journal):
            return self.runner.run_pending()

    def job_status(self, job_id=JOB):
        return json.loads(Path(self.path(aj.JOBS_DIR), job_id, "status.json").read_text())

    def assert_no_secret(self, text):
        for secret in SECRETS:
            self.assertNotIn(secret, text)


class Validation(unittest.TestCase):
    def test_host_names(self):
        for host in ("smtp.example.edu", "a", "x-1.example.com", "SMTP.Example.EDU"):
            self.assertEqual(aj.check_host(host, "invalid_smtp"), host)
        # A leading dot would allow every subdomain in a squid dstdomain list.
        for host in (".example.com", "example.com.", "..", "", "a..b", "-a.com", "a-.com", "a_b.com",
                     "1.2.3.4", "10.0.0.1", "2130706433", "x." * 127 + "com", "a" * 64 + ".com",
                     "a b.com", "a\n.com", "[::1]", 7):
            with self.assertRaises(aj.Refused, msg=repr(host)):
                aj.check_host(host, "invalid_smtp")

    def test_urls(self):
        for url in ("https://hooks.slack.com/services/T/B/X", "https://ntfy.sh/topic?x=1",
                    "https://ntfy.example.org:443/topic", "https://Discord.com/api/webhooks/1/x/slack"):
            self.assertEqual(aj.check_url(url, "invalid_webhook"), url)
        for url in ("http://hooks.slack.com/x", "https://hooks.slack.com:8443/x", "https://user:pw@host.com/x",
                    "https://user@host.com/x", "https://.evil.com/x", "https://evil.com./x", "https://1.2.3.4/x",
                    "https://[::1]/x", "https:///x", "https://a b.com/x", "https://host.com/a b",
                    "https://host.com/\n", "https://*.example.org/x", "ftp://host.com/",
                    "https://host.com:/x", "https://host.com:99999/x", "https://h.com/" + "a" * 500, None):
            with self.assertRaises(aj.Refused, msg=repr(url)):
                aj.check_url(url, "invalid_webhook")

    def test_a_whole_file(self):
        self.assertEqual(aj.validate_file(full_settings()), full_settings())
        self.assertEqual(aj.validate_file(aj.OFF), aj.OFF)
        legacy = {k: v for k, v in aj.OFF.items() if k != "rootShellOpenedAlert"}
        self.assertFalse(aj.validate_file(legacy)["rootShellOpenedAlert"])

    def test_refusals_carry_the_field_code(self):
        def refused(change, code):
            doc = full_settings()
            change(doc)
            with self.assertRaises(aj.Refused) as caught:
                aj.validate_file(doc)
            self.assertEqual(caught.exception.code, code)

        refused(lambda d: d["smtp"].update(port=25), "invalid_smtp")
        refused(lambda d: d["smtp"].update(port=True), "invalid_smtp")
        refused(lambda d: d["smtp"].update(port="587"), "invalid_smtp")
        refused(lambda d: d["smtp"].update(host=".example.edu"), "invalid_smtp")
        # A line break in From could add a mail header.
        refused(lambda d: d["smtp"].update(**{"from": "a@b.c\r\nBcc: x@y.z"}), "invalid_smtp")
        refused(lambda d: d["smtp"].update(**{"from": ""}), "invalid_smtp")
        refused(lambda d: d["smtp"].update(username="a\nb"), "invalid_smtp")
        refused(lambda d: d["smtp"].update(extra=1), "invalid_smtp")
        refused(lambda d: d.update(smtp=None), "email_needs_smtp")
        refused(lambda d: d["alerts"]["email"].update(to=[]), "invalid_email")
        refused(lambda d: d["alerts"]["email"].update(to=[f"a{i}@example.edu" for i in range(11)]), "invalid_email")
        refused(lambda d: d["alerts"]["email"].update(to=["not an address"]), "invalid_email")
        refused(lambda d: d["alerts"]["pushover"].update(userKey=""), "invalid_pushover")
        refused(lambda d: d["alerts"]["pushover"].update(appToken="a b"), "invalid_pushover")
        refused(lambda d: d["alerts"]["webhook"].update(url="http://x.com/"), "invalid_webhook")
        refused(lambda d: d["alerts"]["ntfy"].update(token="x" * 501), "invalid_ntfy")
        refused(lambda d: d["alerts"]["teams"].update(url="https://10.0.0.1/"), "invalid_teams")
        refused(lambda d: d.update(version=2), "invalid_request")
        refused(lambda d: d.update(rootShellOpenedAlert="yes"), "invalid_request")
        refused(lambda d: d.update(events={}), "invalid_request")
        refused(lambda d: d["alerts"].update(gotify=None), "invalid_request")

    def test_every_code_used_is_listed(self):
        used = set(re.findall(r'(?:Refused|JobFailed)\("([a-z_]+)"\)', _PATH.read_text()))
        used |= {f"invalid_{kind}" for kind in ("webhook", "teams")}
        self.assertLessEqual(used, set(aj.CODES))


class Merge(unittest.TestCase):
    def test_secrets_left_out_are_kept(self):
        stored = full_settings()
        drop = ("smtp.password", "alerts.pushover.userKey", "alerts.pushover.appToken", "alerts.webhook.url",
                "alerts.ntfy.url", "alerts.ntfy.token", "alerts.teams.url")
        self.assertEqual(aj.merge(update_from(stored, drop), stored), stored)

    def test_a_new_smtp_host_port_or_user_clears_the_password(self):
        stored = full_settings()
        for field, value in (("host", "smtp.elsewhere.org"), ("port", 465), ("username", "someone")):
            update = update_from(stored, ["smtp.password"])
            update["smtp"][field] = value
            self.assertEqual(aj.merge(update, stored)["smtp"]["password"], "", field)
        update = update_from(stored, ["smtp.password"])
        update["smtp"]["host"] = "SMTP.example.edu"
        self.assertEqual(aj.merge(update, stored)["smtp"]["password"], PASSWORD, "a host name's case is no change")

    def test_a_password_given_with_a_new_host_is_used(self):
        stored = full_settings()
        update = update_from(stored)
        update["smtp"].update(host="smtp.elsewhere.org", password="new-password")
        self.assertEqual(aj.merge(update, stored)["smtp"]["password"], "new-password")

    def test_a_new_ntfy_host_clears_the_token(self):
        stored = full_settings()
        update = update_from(stored, ["alerts.ntfy.token"])
        update["alerts"]["ntfy"]["url"] = "https://ntfy.elsewhere.org/topic"
        self.assertEqual(aj.merge(update, stored)["alerts"]["ntfy"],
                         {"url": "https://ntfy.elsewhere.org/topic", "token": ""})
        update["alerts"]["ntfy"]["url"] = "https://ntfy.example.org/another-topic"
        self.assertEqual(aj.merge(update, stored)["alerts"]["ntfy"]["token"], TOKEN)

    def test_nothing_stored_means_nothing_kept(self):
        for drop, code in (("smtp.password", None), ("alerts.pushover.userKey", "missing_secret"),
                           ("alerts.webhook.url", "missing_secret"), ("alerts.ntfy.url", "missing_secret"),
                           ("alerts.teams.url", "missing_secret")):
            update = update_from(full_settings(), [drop])
            if code is None:
                self.assertEqual(aj.merge(update, None)["smtp"]["password"], "")
                continue
            with self.assertRaises(aj.Refused, msg=drop) as caught:
                aj.merge(update, None)
            self.assertEqual(caught.exception.code, code)

    def test_a_channel_turned_off_forgets_its_secrets(self):
        stored = full_settings()
        update = update_from(stored)
        update["alerts"]["ntfy"] = None
        merged = aj.merge(update, stored)
        self.assertIsNone(merged["alerts"]["ntfy"])
        update["alerts"]["ntfy"] = {}
        with self.assertRaises(aj.Refused):
            aj.merge(update, merged)

    def test_the_update_is_checked_like_a_file(self):
        update = update_from(full_settings())
        update["smtp"]["port"] = 25
        with self.assertRaises(aj.Refused):
            aj.merge(update, None)
        update = update_from(full_settings())
        update["alerts"]["webhook"]["extra"] = 1
        with self.assertRaises(aj.Refused):
            aj.merge(update, None)
        update = update_from(full_settings())
        del update["rootShellOpenedAlert"]
        with self.assertRaises(aj.Refused):
            aj.merge(update, None)


class Proxy(unittest.TestCase):
    def test_hosts_by_port(self):
        settings = full_settings()
        self.assertEqual(aj.proxy_hosts(settings), {
            443: ["api.pushover.net", "hooks.example.com", "ntfy.example.org", "teams.example.net"],
            587: ["smtp.example.edu"],
        })
        settings["smtp"]["port"] = 465
        settings["alerts"]["teams"] = {"url": "https://Hooks.Example.com/other"}
        self.assertEqual(aj.proxy_hosts(settings)[443], ["api.pushover.net", "hooks.example.com", "ntfy.example.org"])
        self.assertEqual(aj.proxy_hosts(settings)[465], ["smtp.example.edu"])
        self.assertEqual(aj.proxy_hosts(aj.OFF), {})

    def test_render(self):
        lines = aj.render_proxy(full_settings()).splitlines()
        rules = [line for line in lines if not line.startswith("#")]
        self.assertEqual(rules, [
            "acl portikus_alerts_443 dstdomain -n api.pushover.net hooks.example.com ntfy.example.org teams.example.net",
            "acl portikus_alerts_443_port port 443",
            "http_access allow portikus_connect portikus_alerts_443 portikus_alerts_443_port",
            "acl portikus_alerts_587 dstdomain -n smtp.example.edu",
            "acl portikus_alerts_587_port port 587",
            "http_access allow portikus_connect portikus_alerts_587 portikus_alerts_587_port",
        ])
        self.assertEqual([line for line in aj.render_proxy(aj.OFF).splitlines() if not line.startswith("#")], [])
        self.assert_no_secret_in(aj.render_proxy(full_settings()))

    def assert_no_secret_in(self, text):
        for secret in SECRETS:
            self.assertNotIn(secret, text)


class Requests(Host):
    def test_round_trip(self):
        self.request(update_from(full_settings()))
        self.assertEqual(self.run_pending(), 0)
        self.assertEqual(self.notify(), full_settings())
        self.assertEqual(list(self.notify()["alerts"]), list(aj.KINDS))
        self.assertEqual(stat.S_IMODE(os.stat(self.path(aj.NOTIFY_FILE)).st_mode), 0o640)
        self.assertEqual(os.listdir(self.path(aj.JOBS_DIR)), [JOB])
        status = self.job_status()
        self.assertEqual(status["state"], "succeeded")
        self.assertIsNone(status["code"])
        self.assertEqual(status["channels"], list(aj.KINDS))
        self.assertEqual(status["hosts"], ["api.pushover.net", "hooks.example.com", "ntfy.example.org",
                                           "smtp.example.edu", "teams.example.net"])
        self.assertEqual(status["requestedBy"], USER)
        self.assertIsNotNone(status["finishedAt"])
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(full_settings()))
        self.assertEqual(self.fake.names(), ["parse", "reload"])
        self.assertEqual(self.fake.calls[0], ["squid", "-k", "parse", "-f", aj.SQUID_CONF])
        self.assertEqual(self.fake.calls[1], ["systemctl", "try-reload-or-restart", "squid.service"])
        self.assertFalse(os.path.exists(self.proxy(aj.PROXY_OLD)))
        self.assert_no_secret(json.dumps(status) + self.journal.getvalue() + Path(self.proxy()).read_text())

    def test_secrets_kept_across_requests(self):
        self.request(update_from(full_settings()))
        self.run_pending()
        self.request(update_from(full_settings(), ["smtp.password", "alerts.ntfy.token"]), JOB2)
        self.run_pending()
        self.assertEqual(self.notify(), full_settings())
        self.assertEqual(self.job_status(JOB2)["state"], "succeeded")

    def test_same_hosts_change_no_proxy_rule(self):
        self.request(update_from(full_settings()))
        self.run_pending()
        self.fake.calls.clear()
        update = update_from(full_settings())
        update["rootShellOpenedAlert"] = False
        self.request(update, JOB2)
        self.run_pending()
        self.assertFalse(self.notify()["rootShellOpenedAlert"])
        self.assertEqual(self.fake.calls, [])

    def test_a_refused_request_is_deleted_and_changes_nothing(self):
        self.store(aj.OFF)
        before = Path(self.path(aj.NOTIFY_FILE)).read_text()
        update = update_from(full_settings())
        update["smtp"]["host"] = ".example.edu"
        path = self.request(update)
        self.run_pending()
        self.assertFalse(os.path.exists(path))
        self.assertEqual(Path(self.path(aj.NOTIFY_FILE)).read_text(), before)
        self.assertEqual(self.job_status()["state"], "refused")
        self.assertEqual(self.job_status()["code"], "invalid_smtp")
        self.assert_no_secret(self.journal.getvalue() + json.dumps(self.job_status()))

    def test_malformed_requests(self):
        cases = {
            JOB: "{not json",
            JOB2: json.dumps({"id": JOB, "requestedAt": "2026-10-05T12:00:00.000Z", "requestedBy": USER,
                              "settings": update_from(full_settings())}),
        }
        for job_id, raw in cases.items():
            self.request(None, job_id, raw=raw)
        self.run_pending()
        for job_id in cases:
            self.assertEqual(self.job_status(job_id)["state"], "refused")
            self.assertEqual(self.job_status(job_id)["code"], "invalid_request")
        self.assertFalse(os.path.exists(self.path(aj.NOTIFY_FILE)))

    def test_a_link_is_never_followed_and_still_deleted(self):
        target = Path(self.root, "target.json")
        target.write_text(json.dumps({"id": JOB, "requestedAt": "2026-10-05T12:00:00.000Z",
                                      "requestedBy": USER, "settings": update_from(full_settings())}))
        link = os.path.join(self.path(aj.JOBS_DIR), f"request-{JOB}.json")
        os.symlink(target, link)
        self.run_pending()
        self.assertFalse(os.path.lexists(link))
        self.assertTrue(target.exists())
        self.assertEqual(self.job_status()["code"], "invalid_request")

    def test_an_oversized_request_or_bad_name(self):
        self.request(None, raw=" " * (aj.MAX_REQUEST_BYTES + 1))
        odd = os.path.join(self.path(aj.JOBS_DIR), "request-../x.json".replace("/", "_"))
        Path(odd).write_text("{}")
        os.mkdir(os.path.join(self.path(aj.JOBS_DIR), f"request-{JOB2}.json"))
        self.run_pending()
        self.assertEqual(self.job_status()["code"], "invalid_request")
        self.assertEqual(sorted(os.listdir(self.path(aj.JOBS_DIR))), sorted([JOB, JOB2]))

    def test_a_proxy_that_refuses_the_rules_puts_the_old_ones_back(self):
        self.request(update_from(full_settings()))
        self.run_pending()
        good = Path(self.proxy()).read_text()
        before = Path(self.path(aj.NOTIFY_FILE)).read_text()
        self.fake.calls.clear()
        self.fake.rc["parse"] = 1
        update = update_from(full_settings())
        update["alerts"]["teams"]["url"] = "https://teams.elsewhere.net/x"
        self.request(update, JOB2)
        self.run_pending()
        self.assertEqual(Path(self.proxy()).read_text(), good)
        self.assertEqual(Path(self.path(aj.NOTIFY_FILE)).read_text(), before)
        self.assertEqual(self.fake.names(), ["parse"])
        self.assertEqual(self.job_status(JOB2)["state"], "failed")
        self.assertEqual(self.job_status(JOB2)["code"], "proxy_config_rejected")
        self.assertEqual(sorted(os.listdir(self.path(aj.PROXY_DIR))), [aj.PROXY_FILE])

    def test_a_first_rule_set_refused_leaves_an_empty_file(self):
        self.fake.rc["parse"] = 1
        self.request(update_from(full_settings()))
        self.run_pending()
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(aj.OFF))
        self.assertEqual(self.job_status()["code"], "proxy_config_rejected")

    def test_a_failed_reload_is_reported(self):
        self.fake.rc["reload"] = 1
        self.request(update_from(full_settings()))
        self.run_pending()
        self.assertEqual(self.job_status()["state"], "failed")
        self.assertEqual(self.job_status()["code"], "proxy_reload_failed")
        self.assertEqual(self.notify(), full_settings())

    def test_a_failed_reload_is_retried_on_the_next_run(self):
        self.fake.rc["reload"] = 1
        self.request(update_from(full_settings()))
        self.run_pending()
        self.assertTrue(os.path.exists(self.proxy(aj.RELOAD_PENDING)))
        # The files now match, so only the marker says Squid still runs the old rules.
        self.fake.calls.clear()
        self.fake.rc["reload"] = 0
        self.run_pending()
        self.assertEqual(self.fake.names(), ["reload"])
        self.assertFalse(os.path.exists(self.proxy(aj.RELOAD_PENDING)))
        self.fake.calls.clear()
        self.run_pending()
        self.assertEqual(self.fake.calls, [])

    def test_a_run_killed_before_the_reload_is_finished_by_the_next(self):
        # As a run killed between writing alerts.conf and reloading Squid leaves it.
        self.store(full_settings())
        Path(self.proxy()).write_text(aj.render_proxy(full_settings()))
        Path(self.proxy(aj.RELOAD_PENDING)).write_text("")
        code, out = Seed.seed(self, {})
        self.assertEqual(code, 0)
        self.assertIn("alerts.conf unchanged", out)
        self.assertEqual(self.fake.names(), ["reload"])
        self.assertFalse(os.path.exists(self.proxy(aj.RELOAD_PENDING)))

    def test_a_refused_rule_change_leaves_no_marker(self):
        self.fake.rc["parse"] = 1
        self.request(update_from(full_settings()))
        self.run_pending()
        self.assertFalse(os.path.exists(self.proxy(aj.RELOAD_PENDING)))
        self.fake.rc["parse"] = 0
        self.fake.calls.clear()
        self.run_pending()
        self.assertEqual(self.fake.calls, [])

    def test_a_marker_from_earlier_survives_a_refused_change(self):
        Path(self.proxy(aj.RELOAD_PENDING)).write_text("")
        # The run's first reload fails too, so Squid still owes one when the change is refused.
        self.fake.rc.update(parse=1, reload=1)
        self.request(update_from(full_settings()))
        self.run_pending()
        self.assertTrue(os.path.exists(self.proxy(aj.RELOAD_PENDING)))

    def test_a_cut_short_run_is_finished_from_notify_json(self):
        self.store(full_settings())
        Path(self.proxy()).write_text("# half a swap\n")
        Path(self.proxy(aj.PROXY_OLD)).write_text("# old\n")
        Path(self.proxy(aj.PROXY_NEW)).write_text("# new\n")
        self.run_pending()
        self.assertEqual(sorted(os.listdir(self.path(aj.PROXY_DIR))), [aj.PROXY_FILE])
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(full_settings()))
        self.assertEqual(self.fake.names(), ["parse", "reload"])

    def test_old_jobs_are_pruned(self):
        for i in range(aj.KEEP_JOBS + 3):
            os.mkdir(os.path.join(self.path(aj.JOBS_DIR), f"{i:08x}-0000-4000-8000-000000000000"))
        self.run_pending()
        self.assertEqual(len(os.listdir(self.path(aj.JOBS_DIR))), aj.KEEP_JOBS)


class Seed(Host):
    def seed(self, given):
        out = io.StringIO()
        with contextlib.redirect_stderr(self.journal):
            code = self.runner.run_seed(io.StringIO(json.dumps(given)), out)
        return code, out.getvalue()

    def test_from_secrets_yaml(self):
        code, out = self.seed({"pushoverUserKey": USER_KEY, "pushoverAppToken": APP_TOKEN, "webhookUrl": WEBHOOK})
        self.assertEqual(code, 0)
        self.assertIn("notify.json created from secrets.yaml", out)
        self.assertIn("alerts.conf changed", out)
        settings = self.notify()
        self.assertEqual(settings["alerts"]["pushover"], {"userKey": USER_KEY, "appToken": APP_TOKEN})
        self.assertEqual(settings["alerts"]["webhook"], {"url": WEBHOOK})
        self.assertIs(settings["rootShellOpenedAlert"], False)
        self.assertIsNone(settings["smtp"])
        self.assertIn("dstdomain -n api.pushover.net hooks.example.com", Path(self.proxy()).read_text())
        self.assert_no_secret(out + self.journal.getvalue())

    def test_from_alerts_env(self):
        Path(self.path(aj.ALERTS_ENV)).write_text(
            f"# old\nALERT_PUSHOVER_USER_KEY={USER_KEY}\nALERT_PUSHOVER_APP_TOKEN={APP_TOKEN}\nALERT_WEBHOOK_URL=\n")
        code, out = self.seed({"pushoverUserKey": "", "pushoverAppToken": "", "webhookUrl": ""})
        self.assertEqual(code, 0)
        self.assertIn("notify.json created from alerts.env", out)
        self.assertEqual(self.notify()["alerts"]["pushover"], {"userKey": USER_KEY, "appToken": APP_TOKEN})
        self.assertIsNone(self.notify()["alerts"]["webhook"])

    def test_nothing_set_writes_everything_off(self):
        os.remove(self.proxy())
        code, out = self.seed({})
        self.assertEqual(code, 0)
        self.assertEqual(self.notify(), aj.OFF)
        self.assertIn("alerts.conf changed", out)
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(aj.OFF))

    def test_the_page_owns_an_existing_file(self):
        self.store(full_settings())
        before = Path(self.path(aj.NOTIFY_FILE)).read_text()
        code, out = self.seed({"webhookUrl": "https://other.example.com/x"})
        self.assertEqual(code, 0)
        self.assertIn("notify.json kept", out)
        self.assertEqual(Path(self.path(aj.NOTIFY_FILE)).read_text(), before)
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(full_settings()))
        code, out = self.seed({})
        self.assertIn("alerts.conf unchanged", out)

    def test_bad_values_write_nothing(self):
        for given in ({"pushoverUserKey": USER_KEY}, {"webhookUrl": "https://hooks.example.com:8443/x"},
                      {"webhookUrl": 3}, {"other": ""}):
            code, _ = self.seed(given)
            self.assertEqual(code, 2, given)
            self.assertFalse(os.path.exists(self.path(aj.NOTIFY_FILE)))
        self.assert_no_secret(self.journal.getvalue())


class Restore(Host):
    def restore(self, text):
        out = io.StringIO()
        with contextlib.redirect_stderr(self.journal):
            return self.runner.run_restore(io.StringIO(text), out), out.getvalue()

    def test_a_backup_replaces_the_file(self):
        self.store(aj.OFF)
        code, out = self.restore(json.dumps(full_settings()))
        self.assertEqual((code, out), (0, "notify.json restored\n"))
        self.assertEqual(self.notify(), full_settings())
        self.assertEqual(Path(self.proxy()).read_text(), aj.render_proxy(full_settings()))
        self.assertEqual(self.fake.names(), ["parse", "reload"])

    def test_a_doctored_file_is_refused(self):
        self.store(aj.OFF)
        bad = full_settings()
        bad["alerts"]["webhook"]["url"] = "https://.evil.example/x"
        for text in (json.dumps(bad), "{", json.dumps({**aj.OFF, "extra": 1})):
            code, _ = self.restore(text)
            self.assertEqual(code, 2)
        self.assertEqual(self.notify(), aj.OFF)


class Contracts(unittest.TestCase):
    """Paths other files name must be the job's own."""

    def test_the_api_reads_the_file_the_job_writes(self):
        config = (REPO / "packages/config/src/index.ts").read_text()
        self.assertIn(f'.default("{aj.NOTIFY_FILE}")', config.split("NOTIFY_FILE:", 1)[1].split("),", 1)[0] + ")")

    def test_the_units_and_setup_agree(self):
        path_unit = (REPO / "packaging/systemd/portikus-alerts-job.path").read_text()
        self.assertIn(f"PathExistsGlob={aj.JOBS_DIR}/request-*.json", path_unit)
        defaults = (REPO / "infra/ansible/roles/egress_proxy/defaults/main.yml").read_text()
        self.assertIn(f"egress_proxy_include_dir: {aj.PROXY_DIR}\n", defaults)
        portikus_defaults = (REPO / "infra/ansible/roles/portikus/defaults/main.yml").read_text()
        self.assertIn(f"portikus_alerts_jobs_dir: {aj.JOBS_DIR}\n", portikus_defaults)


if __name__ == "__main__":
    unittest.main()
