"""Roles from provider groups through the root site job (SPEC.md sections 5.1 and 24.8).

Google group checks need a service-account key, sent once in the 0600 request
and written where Dex reads it; Entra can take roles from assigned groups.
The key must never reach a status file, a log, the journal, debconf or a
command's arguments, and a trial that is put back puts the old key back.
Run: python3 -B -m unittest discover -s packaging/site/tests
"""

import json
import os
import re
import stat
import unittest
from pathlib import Path

from test_site_job import JOB, JOB2, JOB3, REPO, Host, sj

PRIVATE_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ-not-a-real-key"
KEY = json.dumps({
    "type": "service_account", "project_id": "portikus-test", "private_key_id": "fake-private-key-id-0123",
    "private_key": f"-----BEGIN FAKE TEST KEY-----\n{PRIVATE_LINE}\n-----END FAKE TEST KEY-----\n",
    "client_email": "groups@portikus-test.iam.gserviceaccount.com",
    "token_uri": "https://oauth2.googleapis.com/token",
})
OLD_KEY = KEY.replace("fake-private-key-id-0123", "fake-older-key-id-4567")
GOOGLE = {"provider": "google", "googleDomains": ["example.edu"], "clientId": "123.apps.googleusercontent.com",
          "clientSecret": "fake-google-client-secret-0123", "googleAdminEmail": "groups-reader@example.edu",
          "groups": {"student": "students@example.edu", "instructor": "staff@example.edu",
                     "admin": "it-admins@example.edu"}}
ENTRA = {"provider": "entra", "entraTenantId": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "clientId": "portikus",
         "clientSecret": "fake-entra-client-secret-0123", "entraRoleSource": "groups",
         "groups": {"student": "0a1b2c3d-1111-4a5b-8c9d-000000000001",
                    "instructor": "0a1b2c3d-1111-4a5b-8c9d-000000000002",
                    "admin": "0a1b2c3d-1111-4a5b-8c9d-000000000003"}}


class ProviderGroups(Host):
    def setUp(self):
        super().setUp()
        self.install()
        Path(self.path(sj.API_ENV)).write_text("NODE_ENV=production\nPORT=3000\n")
        os.makedirs(self.path(os.path.dirname(sj.DEX_KEY_FILE)))

    def key_file(self):
        return Path(self.path(sj.DEX_KEY_FILE))

    def debconf(self):
        return "".join(self.fake.stdin)

    def test_the_key_path_is_the_one_dex_reads(self):
        defaults = (REPO / "infra/ansible/roles/dex/defaults/main.yml").read_text()
        config_dir = re.search(r"^dex_config_dir: (\S+)$", defaults, re.M).group(1)
        key_path = re.search(r'^dex_google_key_path: "\{\{ dex_config_dir \}\}(/\S+)"$', defaults, re.M).group(1)
        self.assertEqual(config_dir + key_path, sj.DEX_KEY_FILE)

    def test_google_groups_install_the_key_for_dex_alone(self):
        status = self.play("signin", **GOOGLE, googleServiceAccountKey=KEY)
        self.assertEqual((status["state"], status["code"]), ("trial", None))
        self.assertEqual(self.key_file().read_text(), KEY)
        self.assertEqual(stat.S_IMODE(self.key_file().stat().st_mode), 0o640)
        config = self.config()
        self.assertIn("portikus_google_admin_email: groups-reader@example.edu\n", config)
        self.assertIn("portikus_oidc_admin_group: it-admins@example.edu\n", config)
        self.assertIn("portikus portikus/google_admin_email string groups-reader@example.edu\n", self.debconf())
        self.assertIn("portikus portikus/student_group string students@example.edu\n", self.debconf())

    def test_the_key_never_reaches_a_view_a_log_or_an_argument(self):
        self.fake.setup_output = f"TASK [dex] ok\nkey line {PRIVATE_LINE}\nid fake-private-key-id-0123\n"
        self.play("signin", **GOOGLE, googleServiceAccountKey=KEY)
        self.play("rollback", JOB2, trialId=JOB)
        written = self.everything_written() + self.config() + self.secrets()
        for part in (PRIVATE_LINE, "fake-private-key-id-0123", "BEGIN FAKE TEST KEY"):
            self.assertNotIn(part, written)
        self.assertIn("key line [secret]", self.log())
        # The request file holding it is gone, and the trial's copy with it.
        self.assertEqual([n for n in os.listdir(self.path(sj.JOBS_DIR)) if n.startswith("request-")], [])
        self.assertEqual(os.listdir(self.path(sj.STATE_DIR)), [])

    def test_group_checks_without_a_key_are_refused(self):
        before = self.config()
        status = self.play("signin", **GOOGLE)
        self.assertEqual((status["state"], status["code"]), ("failed", "missing_secret"))
        self.assertEqual(self.config(), before)
        self.assertFalse(self.key_file().exists())
        self.assertNotIn("setup", self.fake.names())

    def test_a_stored_key_is_kept_when_none_is_sent(self):
        self.key_file().write_text(OLD_KEY)
        status = self.play("signin", **GOOGLE)
        self.assertEqual(status["state"], "trial")
        self.assertEqual(self.key_file().read_text(), OLD_KEY)

    def test_a_rollback_puts_the_old_key_back(self):
        self.key_file().write_text(OLD_KEY)
        self.play("signin", **GOOGLE, googleServiceAccountKey=KEY)
        self.assertEqual(self.key_file().read_text(), KEY)
        self.play("rollback", JOB2, trialId=JOB)
        self.assertEqual(self.key_file().read_text(), OLD_KEY)

    def test_a_rollback_removes_a_key_that_was_not_there(self):
        self.play("signin", **GOOGLE, googleServiceAccountKey=KEY)
        self.play("rollback", JOB2, trialId=JOB)
        self.assertFalse(self.key_file().exists())

    def test_a_failed_setup_puts_the_old_key_back(self):
        self.key_file().write_text(OLD_KEY)
        self.fake.setup = [1, 0]
        status = self.play("signin", **GOOGLE, googleServiceAccountKey=KEY)
        self.assertEqual((status["state"], status["code"]), ("reverted", "setup_failed"))
        self.assertEqual(self.key_file().read_text(), OLD_KEY)

    def test_google_without_an_administrator_writes_no_groups(self):
        plain = {k: v for k, v in GOOGLE.items() if k not in ("googleAdminEmail", "groups")}
        status = self.play("signin", **plain)
        self.assertEqual(status["state"], "trial")
        self.assertNotIn("_group", self.config())
        self.assertNotIn("portikus_google_admin_email", self.config())
        self.assertFalse(self.key_file().exists())

    def test_refused_group_and_key_values(self):
        cases = {
            "capital group email": {**GOOGLE, "groups": {**GOOGLE["groups"], "admin": "IT@example.edu"}},
            "group name, not email": {**GOOGLE, "groups": {**GOOGLE["groups"], "student": "students"}},
            "administrator not an email": {**GOOGLE, "googleAdminEmail": "admin"},
            "no groups": {k: v for k, v in GOOGLE.items() if k != "groups"},
            "user credential": {**GOOGLE, "googleServiceAccountKey": KEY.replace("service_account", "authorized_user")},
            "foreign token address": {**GOOGLE, "googleServiceAccountKey": KEY.replace(
                "oauth2.googleapis.com", "tokens.example.com")},
            "entra groups by name": {**ENTRA, "groups": {**ENTRA["groups"], "admin": "Portikus.Administrator"}},
            "unknown entra source": {**ENTRA, "entraRoleSource": "claims"},
        }
        for job, (name, body) in zip((JOB, JOB2, JOB3) * 3, cases.items()):
            with self.subTest(name):
                Path(self.path(sj.JOBS_DIR), "status", f"{job}.json").unlink(missing_ok=True)
                status = self.play("signin", job, **body)
                self.assertEqual((status["state"], status["code"]), ("failed", "invalid_value"))
        self.assertFalse(self.key_file().exists())
        self.assertNotIn("setup", self.fake.names())

    def test_entra_groups_write_the_object_ids(self):
        status = self.play("signin", **ENTRA)
        self.assertEqual(status["state"], "trial")
        config = self.config()
        self.assertIn("portikus_entra_role_source: groups\n", config)
        self.assertIn("portikus_oidc_student_group: 0a1b2c3d-1111-4a5b-8c9d-000000000001\n", config)
        self.assertIn("portikus portikus/entra_role_source select groups\n", self.debconf())

    def test_entra_app_roles_keep_the_play_defaults(self):
        roles = {k: v for k, v in ENTRA.items() if k not in ("entraRoleSource", "groups")}
        status = self.play("signin", **roles)
        self.assertEqual(status["state"], "trial")
        self.assertNotIn("portikus_entra_role_source", self.config())
        self.assertNotIn("_group", self.config())


if __name__ == "__main__":
    unittest.main()
