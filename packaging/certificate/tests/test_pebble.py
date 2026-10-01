"""The certificate job against Pebble, Let's Encrypt's test ACME server, and a real Caddy (ADR 0046).

HTTP-01 with on-demand preview certificates and external account binding
(EAB) are tested only here, since the pilot cannot do either for real
(Epic 27 answers A2 and A4). A live Caddy plays the site with the Caddyfile
layout setup writes; systemctl's reload becomes `caddy reload --force`.

Skipped unless PEBBLE, PEBBLE_CHALLTESTSRV and CADDY name the binaries
(CI downloads pinned versions; see .github/workflows/ci.yml).
Run: PEBBLE=... PEBBLE_CHALLTESTSRV=... CADDY=... python3 -m unittest discover -s packaging/certificate/tests
"""

import contextlib
import http.server
import io
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

from helpers import cj

PEBBLE = os.environ.get("PEBBLE")
CHALLTESTSRV = os.environ.get("PEBBLE_CHALLTESTSRV")
CADDY = os.environ.get("CADDY")
SITE = "site.test"
SUFFIX = "preview.site.test"
KEY_ID = "kid-1"
# Obviously fake, but a valid 32-byte base64url HMAC key, as Pebble needs.
HMAC = "ZmFrZS1wZWJibGUtZWFiLWhtYWMta2V5LTAxMjM0NTY"
WRONG_HMAC = "ZmFrZS13cm9uZy1lYWItaG1hYy1rZXktOTg3NjU0MzI"
ID = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
ID2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"


def free_ports(count, kind=socket.SOCK_STREAM):
    """count different free ports. All are held open until all are chosen: ports chosen one at a
    time can repeat, which once sent the challenge to Pebble's own API port."""
    sockets = []
    try:
        for _ in range(count):
            s = socket.socket(socket.AF_INET, kind)
            sockets.append(s)
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in sockets]
    finally:
        for s in sockets:
            s.close()


def wait_for_port(port, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f"nothing listens on {port}")


class Ask(http.server.BaseHTTPRequestHandler):
    """The API's on-demand ask endpoint: yes for preview names, except ones starting evil-."""

    asked = []

    def do_GET(self):
        query = urllib.parse.urlsplit(self.path)
        domain = urllib.parse.parse_qs(query.query).get("domain", [""])[0]
        Ask.asked.append(domain)
        allowed = query.path == "/edge/certificate-ask" and domain.endswith("." + SUFFIX) \
            and not domain.startswith("evil-")
        self.send_response(200 if allowed else 403)
        self.end_headers()

    def log_message(self, *args):
        pass


@unittest.skipUnless(PEBBLE and CHALLTESTSRV and CADDY, "PEBBLE, PEBBLE_CHALLTESTSRV and CADDY are not set")
class Pebble(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="certjob-pebble-")
        cls.procs = []
        d = cls.dir
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                        "-keyout", f"{d}/listener.key", "-out", f"{d}/listener.crt", "-subj", "/CN=pebble",
                        "-days", "30", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
                       check=True, capture_output=True)
        names = ("acme", "management", "http", "tls", "challtest", "https", "ask", "challenge")
        cls.ports = dict(zip(names, free_ports(len(names))))
        cls.ports["dns"] = free_ports(1, socket.SOCK_DGRAM)[0]
        Path(d, "pebble.json").write_text(json.dumps({"pebble": {
            "listenAddress": f"127.0.0.1:{cls.ports['acme']}",
            "managementListenAddress": f"127.0.0.1:{cls.ports['management']}",
            "certificate": f"{d}/listener.crt",
            "privateKey": f"{d}/listener.key",
            "httpPort": cls.ports["http"],
            "tlsPort": cls.ports["tls"],
            "ocspResponderURL": "",
            "externalAccountBindingRequired": True,
            "externalAccountMACKeys": {KEY_ID: HMAC},
        }}))
        cls.start([CHALLTESTSRV, "-defaultIPv4", "127.0.0.1", "-defaultIPv6", "",
                   "-dnsserver", f"127.0.0.1:{cls.ports['dns']}", "-http01", "", "-https01", "", "-tlsalpn01", "",
                   "-doh", "", "-management", f"127.0.0.1:{cls.ports['challtest']}"])
        cls.start([PEBBLE, "-config", f"{d}/pebble.json", "-dnsserver", f"127.0.0.1:{cls.ports['dns']}"],
                  env={"PEBBLE_VA_NOSLEEP": "1", "PEBBLE_WFE_NONCEREJECT": "0"})
        wait_for_port(cls.ports["acme"])
        cls.directory = f"https://127.0.0.1:{cls.ports['acme']}/dir"
        # Pebble's roots, which the job's chain check needs among the system authorities.
        context = ssl.create_default_context(cafile=f"{d}/listener.crt")
        url = f"https://127.0.0.1:{cls.ports['management']}/roots/0"
        for _ in range(50):
            try:
                with urllib.request.urlopen(url, context=context) as answer:
                    cls.pebble_root = answer.read().decode()
                break
            except OSError:
                time.sleep(0.1)
        cls.ask = http.server.ThreadingHTTPServer(("127.0.0.1", cls.ports["ask"]), Ask)
        threading.Thread(target=cls.ask.serve_forever, daemon=True).start()

    @classmethod
    def start(cls, argv, env=None):
        with open(os.path.join(cls.dir, os.path.basename(argv[0]) + ".log"), "wb") as log:
            cls.procs.append(subprocess.Popen(argv, stdout=log, stderr=log, env={**os.environ, **(env or {})}))

    @classmethod
    def tearDownClass(cls):
        cls.ask.shutdown()
        for proc in cls.procs:
            proc.terminate()
            proc.wait()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="certjob-root-", dir=self.dir)
        for path in (cj.JOBS_DIR, cj.STATE_DIR, cj.STATUS_DIR, "/etc/caddy", cj.CADDY_DATA, "/etc/ssl/certs"):
            os.makedirs(self.root + path)
        Path(self.root + cj.API_ENV).write_text(f"PUBLIC_URL=https://{SITE}:{self.ports['https']}\n"
                                                f"PREVIEW_SUFFIX={SUFFIX}\nPORT={self.ports['ask']}\n")
        Path(self.root + cj.SYSTEM_CAS).write_text(Path(self.dir, "listener.crt").read_text() + self.pebble_root)
        self.socket = os.path.join(self.root, "admin.sock")
        self.caddyfile = self.root + cj.CADDYFILE
        state = self.root + cj.STATE_DIR
        # The layout setup writes (infra/ansible/roles/caddy/templates/Caddyfile.j2), on test ports.
        Path(self.caddyfile).write_text(f"""import {state}/tls.caddy

{{
	admin unix/{self.socket}
	http_port {self.ports['http']}
	https_port {self.ports['https']}
	default_bind 127.0.0.1
	skip_install_trust
	storage file_system {{
		root {self.root + cj.CADDY_DATA}
	}}
	import portikus_tls_global http://127.0.0.1:{self.ports['ask']}/edge/certificate-ask
}}

# As setup's port-80 block: challenges the live Caddy is not solving go to the throwaway.
http://{SITE} {{
	handle /.well-known/acme-challenge/* {{
		reverse_proxy 127.0.0.1:{self.ports['challenge']}
	}}
}}

https://{SITE} {{
	import portikus_tls_site
	respond "site"
}}

https://*.{SUFFIX} {{
	import portikus_tls_preview
	respond "preview"
}}
""")
        self.env = {"PATH": os.environ["PATH"], "HOME": self.root, "XDG_DATA_HOME": self.root,
                    "XDG_CONFIG_HOME": self.root, "SSL_CERT_FILE": f"{self.dir}/listener.crt"}
        self.runner = cj.Runner(root=self.root, run_=self.run_, caddy=CADDY,
                                test_env={"SSL_CERT_FILE": f"{self.dir}/listener.crt"},
                                test_http_port=self.ports["challenge"], timeouts={"issue": 30, "serve": 20})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.runner.run_first_install(io.StringIO('{"source": "internal"}')), 0)
        self.live_log = open(os.path.join(self.root, "live.log"), "wb")
        self.live = subprocess.Popen([CADDY, "run", "--config", self.caddyfile, "--adapter", "caddyfile"],
                                     stdout=subprocess.DEVNULL, stderr=self.live_log, env=self.env)
        wait_for_port(self.ports["https"])

    def tearDown(self):
        if self.live.poll() is None:
            self.live.terminate()
            self.live.wait()
            self.live_log.close()

    def run_(self, argv, log=None, capture=False, timeout=None, env=None, input=None):
        """systemctl and runuser as a test can do them; everything else for real."""
        if argv[0] == "runuser":
            return cj.run(argv[argv.index("--") + 1:], log=log, timeout=timeout, env=self.env)
        if argv[:3] in (["systemctl", "reload", "caddy"], ["systemctl", "restart", "caddy"]):
            return cj.run([CADDY, "reload", "--config", self.caddyfile, "--adapter", "caddyfile",
                           "--address", f"unix/{self.socket}", "--force"], log=log, timeout=timeout, env=self.env)
        if argv[0] in ("systemctl", "journalctl"):
            return 0, ""
        return cj.run(argv, log=log, capture=capture, timeout=timeout, env=env, input=input)

    def settings(self, hmac):
        return {"source": "acme", "directory": self.directory, "email": "admin@site.test",
                "eab": {"keyId": KEY_ID, "hmacKey": hmac}, "challenge": {"mode": "http01"}}

    def submit(self, settings, job_id):
        doc = {"id": job_id, "requestedAt": "2026-09-30T10:00:00Z", "requestedBy": USER,
               "request": {"kind": "apply", "settings": settings}}
        Path(self.runner.jobs_dir, f"request-{job_id}.json").write_text(json.dumps(doc))
        self.runner.run_pending()
        status = json.loads(Path(self.runner.jobs_dir, job_id, "status.json").read_text())
        return status

    def served(self, name):
        return self.runner.served(self.ports["https"], name)

    def test_the_throwaway_caddy_obtains_by_http01_with_eab(self):
        # Pebble validates against the live Caddy, which passes the challenge to the throwaway.
        new = self.runner.state(".new")
        settings = self.settings(HMAC)
        self.runner.build_generation(new, settings, {("eab", "hmacKey"): HMAC}, None, {}, base=new)
        jobs_fd = os.open(self.runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), self.runner.host)
        try:
            certificates = self.runner.issue_with_throwaway_caddy(job, settings, [SITE], new)
        finally:
            job.close()
            os.close(jobs_fd)
        files = certificates[next(iter(certificates))]
        info = cj.certificate_info(cj.run, files[f"{SITE}.crt"].decode())
        self.assertIn("Pebble", info["issuer"])
        self.assertEqual(info["names"], [SITE])
        self.assertIn(f"{SITE}.json", files)
        # Nothing live changed.
        self.assertEqual(json.loads(Path(self.runner.state("settings.json")).read_text()), {"source": "internal"})
        self.assertEqual([p for p in Path(self.root + cj.CADDY_DATA).glob(f"certificates/*/{SITE}")
                          if p.parent.name != "local"], [])
        self.assertNotIn(HMAC, Path(self.runner.jobs_dir, ID, "log.txt").read_text())

    def test_http01_apply_with_eab_and_on_demand_previews(self):
        # A wrong EAB key: Pebble refuses the account in the throwaway, and nothing live changes.
        started = time.monotonic()
        status = self.submit(self.settings(WRONG_HMAC), ID)
        self.assertEqual(status["state"], "failed", status)
        self.assertFalse(status["restored"])
        # A definitive refusal ends the throwaway at once rather than at its deadline.
        self.assertIn("urn:ietf:params:acme:error", status["message"])
        self.assertLess(time.monotonic() - started, 15)
        self.assertIn(cj.INTERNAL_ISSUER, self.served(SITE)["issuer"])
        self.assertEqual(json.loads(Path(self.runner.state("settings.json")).read_text()), {"source": "internal"})

        status = self.submit(self.settings(HMAC), ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertIn("Pebble", self.served(SITE)["issuer"])
        # A preview name gets its own certificate on its first handshake, after the API said yes.
        preview = self.served(f"good-3000.{SUFFIX}")
        self.assertIsNotNone(preview)
        self.assertIn("Pebble", preview["issuer"])
        self.assertEqual(preview["names"], [f"good-3000.{SUFFIX}"])
        self.assertIn(f"good-3000.{SUFFIX}", Ask.asked)
        # One the API refuses gets none.
        self.assertIsNone(self.served(f"evil-1.{SUFFIX}"))
        self.assertIn(f"evil-1.{SUFFIX}", Ask.asked)
        # The secret never reached Caddy's saved configuration, the job's files or its status.
        for path in Path(self.root).rglob("*"):
            if path.is_file() and "secrets" not in path.parts:
                self.assertNotIn(HMAC.encode(), path.read_bytes(), path)
                self.assertNotIn(WRONG_HMAC.encode(), path.read_bytes(), path)


if __name__ == "__main__":
    unittest.main()
