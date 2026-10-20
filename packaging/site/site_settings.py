"""Writing the install answers and running setup (SPEC.md section 21.12, ADR 0059).

SettingsJobs is a mixin of Runner. It writes the answers through write-settings, records them for
`dpkg-reconfigure portikus` as debconf answers, runs portikus-setup.service and waits for the API.
run_setup also uses secret_values (site_trial) and append_log (site_queue) of the same Runner.
"""

import http.client
import json
import re
import subprocess
import sys
import time

from site_common import JobFailed, RunnerBase, journal, read_file

WRITE_SETTINGS = "/usr/lib/portikus/write-settings"
SETTINGS_KEYS = "/usr/share/portikus/settings-keys"
SETUP_UNIT = "portikus-setup.service"
# How long a trial waits for the restarted API to answer /health, and how often it asks.
HEALTH_WAIT = 60
HEALTH_INTERVAL = 2
# portikus-setup.service's own TimeoutStartSec, plus a margin.
SETUP_TIMEOUT = 91 * 60
LOG_LINE_LENGTH = 500

# The debconf questions a trial may change, with their template types.
QUESTION_TYPES = {
    "public_host": "string", "provider": "select", "entra_tenant_id": "string", "google_domains": "string",
    "oidc_issuer": "string", "client_id": "string", "oidc_groups_claim": "string", "student_group": "string",
    "instructor_group": "string", "admin_group": "string", "entra_role_source": "select",
    "google_admin_email": "string",
}
INVOCATION_RE = re.compile(r"[0-9a-f]{32}", re.ASCII)
# A setup log line that names a secret by its key keeps only the key.
SECRET_LINE_RE = re.compile(r"(?i)((secret|password|token)[A-Za-z_]*[\"']?\s*[:=]\s*).*")


def redact(text, secrets):
    """Setup's output for the page: no secret, no control character, bounded."""
    lines = []
    for line in text.splitlines():
        for secret in secrets:
            if secret:
                line = line.replace(secret, "[secret]")
        line = SECRET_LINE_RE.sub(r"\1[secret]", line)
        line = "".join(c for c in line if c == "\t" or (ord(c) >= 0x20 and not 0x7F <= ord(c) <= 0x9F))
        lines.append(line[:LOG_LINE_LENGTH])
    return lines


def api_port(path):
    """The API's loopback port from its settings file, or None."""
    for line in (read_file(path) or b"").decode("utf-8", "replace").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "PORT" and value.strip().isdigit():
            return int(value.strip())
    return None


def probe_health(port):
    """True when the API on loopback answers GET /health with 200; never through a proxy."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("GET", "/health")
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


class SettingsJobs(RunnerBase):
    def read_settings(self):
        """write-settings read: the answers portikus.yaml holds, which secrets are set, the port."""
        done = subprocess.run([sys.executable, "-I", self.write_settings, "--etc", self.etc, "--keys",
                               self.settings_keys, "read"], stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=60, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C.UTF-8"})
        if done.returncode != 0:
            journal("could not read the install answers")
            raise JobFailed("write_failed")
        return json.loads(done.stdout)

    def write_answers(self, answers, secret, port):
        """write-settings: the answers reach it through its environment, the client secret too."""
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C.UTF-8"}
        owned, secret_keys = [], []
        with open(self.settings_keys) as f:
            for line in f:
                parts = line.split()
                if len(parts) != 3 or parts[0].startswith("#"):
                    continue
                question, key, kind = parts
                (owned if kind == "setting" else secret_keys).append(key)
                env["PK_" + question] = answers.get(question, "") if kind == "setting" else ""
        env["PK_OWNED"] = "\n".join(owned)
        env["PK_SECRET_KEYS"] = "\n".join(secret_keys)
        if secret is not None:
            env["PK_client_secret"] = secret
        argv = [sys.executable, "-I", self.write_settings, "--etc", self.etc]
        if port is not None:
            argv += ["--public-port", str(port)]
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, env=env)
        if done.returncode != 0 or done.stdout.strip():
            journal("the install answers were not complete; nothing changed")
            raise JobFailed("write_failed")

    def set_debconf(self, values):
        """So `dpkg-reconfigure portikus` shows the page's answers. Never a secret."""
        if not values:
            return
        text = "".join(f"portikus portikus/{q} {QUESTION_TYPES[q]} {v}\n" for q, v in sorted(values.items()))
        if self.run(["debconf-set-selections"], stdin=text)[0] != 0:
            raise JobFailed("write_failed")

    def setup_running(self):
        rc, out = self.run(["systemctl", "show", "-P", "ActiveState", SETUP_UNIT])
        return rc == 0 and out.strip() in ("active", "activating", "reloading")

    def run_setup(self, log_id, secrets):
        """portikus-setup.service, as postinst starts it; its output goes to log_id's log."""
        # Starting a running unit only waits for that run, which read the answers before this change.
        waited = 0
        while self.setup_running() and waited < SETUP_TIMEOUT:
            time.sleep(5)
            waited += 5
        rc = self.run(["systemctl", "start", SETUP_UNIT], timeout=SETUP_TIMEOUT)[0]
        _, invocation = self.run(["systemctl", "show", "-P", "InvocationID", SETUP_UNIT])
        invocation = invocation.strip()
        if INVOCATION_RE.fullmatch(invocation):
            _, text = self.run(["journalctl", "--no-pager", "-o", "cat", f"_SYSTEMD_INVOCATION_ID={invocation}"],
                               timeout=120)
            self.append_log(log_id, redact(text, list(secrets) + self.secret_values()))
        return rc == 0

    def api_healthy(self):
        """Wait up to HEALTH_WAIT for the API that setup restarted to answer /health."""
        deadline = self.clock() + HEALTH_WAIT
        while True:
            port = api_port(self.api_env)
            if port is not None and self.health(port):
                return True
            if self.clock() >= deadline:
                return False
            self.sleep(HEALTH_INTERVAL)
