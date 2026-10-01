"""Shared fixtures for the certificate job's tests: the module, a host tree and test certificates."""

import importlib.machinery
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
_PATH = Path(__file__).resolve().parents[1] / "certificate-job"
_loader = importlib.machinery.SourceFileLoader("certificate_job", str(_PATH))
_spec = importlib.util.spec_from_loader("certificate_job", _loader)
cj = importlib.util.module_from_spec(_spec)
_loader.exec_module(cj)

REPO = Path(__file__).resolve().parents[3]
SITE = "portikus.example.test"
SUFFIX = "preview.portikus.example.test"
WILDCARD = f"*.{SUFFIX}"


def openssl(*args, cwd):
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True)


class Certificates:
    """Test certificates made with openssl: a root, an intermediate, leaves, and Caddy-like ones."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="certjob-certs-")
        d = self.dir

        def key(name):
            openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", f"{name}.key", cwd=d)

        def ca(name, cn, signer=None):
            key(name)
            ext = os.path.join(d, f"{name}.ext")
            Path(ext).write_text("basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n")
            if signer is None:
                openssl("req", "-x509", "-new", "-key", f"{name}.key", "-subj", f"/CN={cn}", "-days", "3650",
                        "-out", f"{name}.crt", "-addext", "basicConstraints=critical,CA:TRUE",
                        "-addext", "keyUsage=critical,keyCertSign,cRLSign", cwd=d)
            else:
                openssl("req", "-new", "-key", f"{name}.key", "-subj", f"/CN={cn}", "-out", f"{name}.csr", cwd=d)
                openssl("x509", "-req", "-in", f"{name}.csr", "-CA", f"{signer}.crt", "-CAkey", f"{signer}.key",
                        "-CAcreateserial", "-days", "3650", "-extfile", ext, "-out", f"{name}.crt", cwd=d)

        def leaf(name, names, signer, self_signed=False):
            key(name)
            san = "subjectAltName=" + ",".join(f"DNS:{n}" for n in names)
            ext = os.path.join(d, f"{name}.ext")
            Path(ext).write_text(f"{san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n")
            if self_signed:
                openssl("req", "-x509", "-new", "-key", f"{name}.key", "-subj", f"/CN={names[0]}", "-days", "365",
                        "-addext", san, "-addext", "extendedKeyUsage=serverAuth", "-out", f"{name}.crt", cwd=d)
                return
            openssl("req", "-new", "-key", f"{name}.key", "-subj", f"/CN={names[0]}", "-out", f"{name}.csr", cwd=d)
            openssl("x509", "-req", "-in", f"{name}.csr", "-CA", f"{signer}.crt", "-CAkey", f"{signer}.key",
                    "-CAcreateserial", "-days", "365", "-extfile", ext, "-out", f"{name}.crt", cwd=d)

        ca("root", "Portikus Test Root")
        ca("inter", "Portikus Test Intermediate", signer="root")
        leaf("site", [SITE, WILDCARD], "inter")
        leaf("siteonly", [SITE], "inter")
        leaf("preview", [WILDCARD], "inter")
        leaf("other", ["elsewhere.test"], "inter")
        leaf("selfsigned", [SITE, WILDCARD], None, self_signed=True)
        key("stray")
        # What Caddy serves: its internal authority, and an ACME authority.
        ca("caddyroot", "Caddy Local Authority - 2026 ECC Root")
        leaf("internal", [SITE, WILDCARD, f"{cj.SAMPLE_PREVIEW_LABEL}.{SUFFIX}"], "caddyroot")
        leaf("internal2", [SITE, WILDCARD, f"{cj.SAMPLE_PREVIEW_LABEL}.{SUFFIX}"], "caddyroot")
        ca("acmeroot", "Pretend ACME Root")
        leaf("acme", [SITE, WILDCARD], "acmeroot")
        leaf("acme2", [SITE, WILDCARD], "acmeroot")

    def pem(self, name, kind="crt"):
        return Path(self.dir, f"{name}.{kind}").read_text()

    def chain(self, name):
        return self.pem(name) + self.pem("inter")


class HostTree:
    """A root directory laid out like a server: the job, state, status and Caddy directories."""

    def __init__(self, certs):
        self.root = tempfile.mkdtemp(prefix="certjob-root-")
        for path in (cj.JOBS_DIR, cj.STATE_DIR, cj.STATUS_DIR, "/etc/caddy", cj.CADDY_DATA + "/pki/authorities/local",
                     "/etc/ssl/certs"):
            os.makedirs(self.root + path, exist_ok=True)
        os.chmod(self.root + cj.STATE_DIR, 0o750)
        Path(self.root + cj.API_ENV).write_text(
            "# test\nPORT=3000\nPUBLIC_URL=https://portikus.example.test:8443\n"
            "PREVIEW_SUFFIX=preview.portikus.example.test\nOTHER=x=y\n")
        Path(self.root + cj.SYSTEM_CAS).write_text(certs.pem("root") + certs.pem("acmeroot"))
        Path(self.root + cj.CADDY_ROOT).write_text(certs.pem("caddyroot"))
        Path(self.root + cj.CADDYFILE).write_text("# test\n")

    def path(self, absolute):
        return self.root + absolute

    def state(self, name):
        return os.path.join(self.root + cj.STATE_DIR, name)
