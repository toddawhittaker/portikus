"""Unit tests for packaging/site/write-settings (SPEC.md section 21.12, ADR 0059).

postinst and the root site job both turn install answers into portikus.yaml
and secrets.yaml with it. The golden file holds what postinst's own writer made
before it moved here, except that a blank group name is no longer written.
Run: python3 -B -m unittest discover -s packaging/site/tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
WRITER = REPO / "packaging/site/write-settings"
KEYS = REPO / "packaging/debian/settings-keys"
GOLDEN = json.loads((HERE / "fixtures/write-settings-golden.json").read_text())["scenarios"]


def keys(kind):
    return [parts[1] for parts in (line.split() for line in KEYS.read_text().splitlines())
            if len(parts) == 3 and not parts[0].startswith("#") and parts[2] == kind]


def questions():
    return [parts[0] for parts in (line.split() for line in KEYS.read_text().splitlines())
            if len(parts) == 3 and not parts[0].startswith("#")]


class WriteSettings(unittest.TestCase):
    def setUp(self):
        self.etc = tempfile.mkdtemp(prefix="writesettings-")
        self.addCleanup(shutil.rmtree, self.etc)

    def lay_out(self, files):
        for name, text in files.items():
            path = Path(self.etc, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def write(self, answers, *flags):
        """postinst's call: every answer in the environment, as debconf gave it."""
        env = {"PATH": os.environ["PATH"], "PK_OWNED": "\n".join(keys("setting")),
               "PK_SECRET_KEYS": "\n".join(keys("secret"))}
        for question in questions():
            env["PK_" + question] = answers.get(question, "")
        done = subprocess.run([sys.executable, str(WRITER), "--etc", self.etc, *flags], env=env,
                              capture_output=True, text=True, check=True)
        return done.stdout

    def read(self):
        done = subprocess.run([sys.executable, str(WRITER), "--etc", self.etc, "--keys", str(KEYS), "read"],
                              capture_output=True, text=True, check=True)
        return json.loads(done.stdout)

    def files(self):
        out = {}
        for name in ("portikus.yaml", "secrets.yaml"):
            path = Path(self.etc, name)
            out[name] = {"text": path.read_text(), "mode": "%o" % (path.stat().st_mode & 0o777)}
        return out

    def test_the_same_bytes_as_postinst_wrote(self):
        for scenario in GOLDEN:
            with self.subTest(scenario["name"]):
                shutil.rmtree(self.etc)
                os.makedirs(self.etc)
                self.lay_out(scenario["before"])
                self.assertEqual(self.write(scenario["answers"]), scenario["stdout"])
                self.assertEqual(self.files(), scenario["after"])

    def test_read_back_and_written_again_changes_nothing(self):
        """The site job reads the answers back from portikus.yaml; written again unchanged, no byte moves."""
        for scenario in GOLDEN:
            if scenario["stdout"]:
                continue
            with self.subTest(scenario["name"]):
                shutil.rmtree(self.etc)
                os.makedirs(self.etc)
                self.lay_out(scenario["before"])
                self.write(scenario["answers"])
                before = self.files()
                self.assertEqual(self.write(self.read()["answers"]), "")
                self.assertEqual(self.files(), before)

    def test_read_names_set_secrets_but_never_their_values(self):
        self.lay_out({"portikus.yaml": "portikus_dex_upstream: oidc\nportikus_public_port: 8443\n"
                                       "portikus_preview_suffix: apps.example.edu\n",
                      "secrets.yaml": "portikus_dex_upstream_client_secret: fake-secret-value\n"
                                      "portikus_ldap_bind_password: ''\n"})
        out = self.read()
        self.assertEqual(out["answers"], {"provider": "oidc"})
        self.assertEqual(out["publicPort"], 8443)
        self.assertEqual(out["previewSuffix"], "apps.example.edu")
        self.assertEqual(out["secretsSet"], ["portikus_dex_upstream_client_secret"])
        self.assertNotIn("fake-secret-value", json.dumps(out))

    def test_the_public_port(self):
        answers = GOLDEN[0]["answers"]
        self.write(answers, "--public-port", "8443")
        self.assertIn("portikus_public_port: 8443\n", Path(self.etc, "portikus.yaml").read_text())
        self.write(answers)
        self.assertIn("portikus_public_port: 8443\n", Path(self.etc, "portikus.yaml").read_text())
        self.write(answers, "--public-port", "443")
        self.assertNotIn("portikus_public_port", Path(self.etc, "portikus.yaml").read_text())


if __name__ == "__main__":
    unittest.main()
