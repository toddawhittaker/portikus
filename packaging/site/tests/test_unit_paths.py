"""The site job's systemd unit lets it write every path it writes (ADR 0059).

The unit runs under ProtectSystem=strict, so a path left out of
ReadWritePaths= fails only on a server, as "Read-only file system". Each job
kind runs here on a temporary tree, and every file it adds, changes or removes
must sit under one of the unit's ReadWritePaths entries.
Run: python3 -B -m unittest discover -s packaging/site/tests
"""

import os
import re
from pathlib import Path

from test_provider_groups import GOOGLE, KEY, OLD_KEY
from test_site_job import JOB, JOB2, JOB3, REPO, Host, platform, site_common

UNIT = REPO / "packaging/systemd/portikus-site-job.service"
# debconf-set-selections, which the job runs, writes its answers here.
DEBCONF_DIR = "/var/cache/debconf"


def writable_paths():
    paths = []
    for line in UNIT.read_text().splitlines():
        if line.startswith("ReadWritePaths="):
            paths += [p.lstrip("-+") for p in line.split("=", 1)[1].split()]
    return paths


def under(path, roots):
    return any(path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


class UnitPaths(Host):
    def setUp(self):
        super().setUp()
        self.install()
        Path(self.path(site_common.API_ENV)).write_text("NODE_ENV=production\nPORT=3000\n")
        os.makedirs(self.path(os.path.dirname(site_common.DEX_KEY_FILE)))
        Path(self.path(site_common.DEX_KEY_FILE)).write_text(OLD_KEY)

    def tree(self):
        files = {}
        for top, dirs, names in os.walk(self.root):
            for name in dirs + names:
                path = os.path.join(top, name)
                st = os.lstat(path)
                files[path[len(self.root):]] = (st.st_ino, st.st_mtime_ns, st.st_size, st.st_mode)
        return files

    def test_every_path_the_job_writes_is_writable_under_the_unit(self):
        before = self.tree()
        self.play("proxy-hosts", hosts=["api.example.com"])
        self.play("lti-platforms", JOB2, platforms=[platform()])
        self.play("address", JOB3, host="new.example.edu", port=8443)
        self.play("keep", "3b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e", trialId=JOB3)
        signin = "4b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
        self.assertEqual(self.play("signin", signin, **GOOGLE, googleServiceAccountKey=KEY)["state"], "trial")
        self.assertEqual(Path(self.path(site_common.DEX_KEY_FILE)).read_text(), KEY)
        self.play("rollback", "5b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e", trialId=signin)
        after = self.tree()
        touched = {p for p in before.keys() | after.keys() if before.get(p) != after.get(p)}
        # A changed directory entry shows as a changed directory; the files inside say which.
        touched = {p for p in touched if not os.path.isdir(self.path(p))}
        self.assertIn(site_common.DEX_KEY_FILE, touched)
        roots = writable_paths()
        self.assertEqual(sorted(p for p in touched if not under(p, roots)), [])
        self.assertIn("debconf-set-selections", self.fake.names())
        self.assertTrue(under(DEBCONF_DIR, roots))

    def test_the_unit_keeps_the_strict_sandbox(self):
        self.assertRegex(UNIT.read_text(), re.compile(r"^ProtectSystem=strict$", re.M))
