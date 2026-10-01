"""Unit tests for packaging/certificate/certificate-job (docs/SPEC.md sections 21.12 and 24.8, ADR 0046).

systemctl, runuser, journalctl and `openssl s_client` are replaced by FakeRun,
which records every command; every other openssl command runs for real
against test certificates. No test touches the host.
Run: python3 -m unittest discover -s packaging/certificate/tests
"""

import contextlib
import glob
import io
import json
import os
import shutil
import stat
import time
import unittest
from pathlib import Path

from helpers import REPO, SITE, SUFFIX, WILDCARD, Certificates, HostTree, cj

ID = "0b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
ID2 = "1b8d7c1e-3f4a-4b5c-8d9e-0f1a2b3c4d5e"
USER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
SAMPLE = f"{cj.SAMPLE_PREVIEW_LABEL}.{SUFFIX}"
# Obviously fake secrets, long enough to be scrubbed.
TOKEN = "fake-cloudflare-token-0123456789"
TOKEN2 = "fake-cloudflare-token-9876543210"
HMAC = "ZmFrZS1lYWItaG1hYy1rZXktMDEyMzQ1Njc4OQ"
STAGING = cj.LE_STAGING
PRODUCTION = cj.LE_PRODUCTION

CERTS = None


def setUpModule():
    global CERTS
    CERTS = Certificates()


def tearDownModule():
    shutil.rmtree(CERTS.dir, ignore_errors=True)


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeRun:
    """Plays systemctl, runuser, journalctl and openssl s_client; other openssl commands run for real."""

    def __init__(self):
        self.calls = []
        self.served = {}
        self.rc = {}
        self.journal = ""
        self.on_reload = None

    def __call__(self, argv, log=None, capture=False, timeout=None, env=None, input=None):
        self.calls.append(list(argv))
        if argv[:2] == ["openssl", "s_client"]:
            name = argv[argv.index("-servername") + 1]
            return 0, self.served.get(name, "")
        if argv[0] == "openssl":
            return cj.run(argv, capture=capture, timeout=timeout, input=input)
        if argv[0] == "systemctl":
            if argv[1] in ("reload", "restart") and argv[2] == "caddy" and self.on_reload:
                self.on_reload(argv[1])
            return self.rc.get(argv[1], 0), ""
        if argv[0] == "runuser":
            return self.rc.get("validate", 0), ""
        if argv[0] == "journalctl":
            return 0, self.journal
        raise AssertionError(f"unexpected command {argv}")

    def serve(self, site_cert, preview_cert=None):
        self.served = {SITE: CERTS.pem(site_cert), SAMPLE: CERTS.pem(preview_cert or site_cert)}

    def ran(self, *prefix):
        return [c for c in self.calls if c[:len(prefix)] == list(prefix)]


def acme(directory=PRODUCTION, provider="cloudflare", fields=None, eab=None, mode="dns01"):
    settings = {"source": "acme", "directory": directory, "email": "admin@example.test"}
    if mode == "dns01":
        settings["challenge"] = {"mode": "dns01", "dns": {"provider": provider,
                                                          "fields": {"api_token": TOKEN} if fields is None else fields}}
    else:
        settings["challenge"] = {"mode": "http01"}
    if eab:
        settings["eab"] = eab
    return settings


def files(site="site", key="site", preview=None, chain=True):
    upload = {"certificate": CERTS.chain(site) if chain else CERTS.pem(site)}
    if key:
        upload["privateKey"] = CERTS.pem(key, "key")
    settings = {"source": "files", "site": upload}
    if preview:
        settings["preview"] = {"certificate": CERTS.chain(preview), "privateKey": CERTS.pem(preview, "key")}
    return settings


class JobTest(unittest.TestCase):
    def setUp(self):
        self.tree = HostTree(CERTS)
        self.fake = FakeRun()
        self.clock = Clock()
        self.runner = cj.Runner(root=self.tree.root, run_=self.fake, sleep=self.clock.sleep, clock=self.clock)
        self.throwaway_calls = []
        self.throwaway_error = None
        self.runner.issue_with_throwaway_caddy = self.fake_throwaway
        self.addCleanup(shutil.rmtree, self.tree.root, ignore_errors=True)
        self.first_install({"source": "internal"})
        self.fake.serve("internal")

    def first_install(self, settings):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = self.runner.run_first_install(io.StringIO(json.dumps(settings)))
        return code, out.getvalue().strip()

    def fake_throwaway(self, job, settings, names, base, seed=True):
        """Stands in for the throwaway Caddy: records the call and leaves certificates in its storage."""
        tls = Path(base, "tls.caddy").read_text()
        self.throwaway_calls.append({"directory": settings["directory"], "names": names, "seed": seed,
                                     "base": base, "tls": tls,
                                     "secrets": sorted(os.listdir(os.path.join(base, "secrets")))
                                     if os.path.isdir(os.path.join(base, "secrets")) else []})
        if self.throwaway_error:
            raise cj.JobFailed(self.throwaway_error)
        work = os.path.join(self.runner.state_dir, ".throwaway-test")
        for name in names:
            folder = os.path.join(work, "storage", "certificates", "acme-v02.example-directory", cj.storage_name(name))
            os.makedirs(folder)
            Path(folder, cj.storage_name(name) + ".crt").write_text(CERTS.pem("acme2"))
        return work

    def submit(self, request, job_id=ID):
        doc = {"id": job_id, "requestedAt": "2026-09-30T10:00:00.000Z", "requestedBy": USER, "request": request}
        path = Path(self.runner.jobs_dir, f"request-{job_id}.json")
        path.write_text(json.dumps(doc))
        os.chmod(path, 0o600)
        self.runner.run_pending()
        return self.status(job_id)

    def status(self, job_id=ID):
        return json.loads(Path(self.runner.jobs_dir, job_id, "status.json").read_text())

    def record(self, job_id=ID):
        return json.loads(Path(self.runner.jobs_dir, job_id, "request.json").read_text())

    def settings(self):
        return json.loads(Path(self.tree.state("settings.json")).read_text())

    def everything_written(self):
        """Every file the API, a log or the status can show, as one string."""
        text = ""
        for base in (self.runner.jobs_dir, self.runner.status_dir):
            for path in glob.glob(os.path.join(base, "**"), recursive=True):
                if os.path.isfile(path):
                    text += Path(path).read_text(errors="replace")
        for name in ("settings.json", "tls.caddy"):
            text += Path(self.tree.state(name)).read_text()
        return text


class DnsProviderFields(unittest.TestCase):
    def test_fields_match_the_contract(self):
        """The job's table must equal packages/contracts' DNS_PROVIDER_FIELDS, through T3's JSON fixture."""
        fixture = REPO / "packages" / "contracts" / "fixtures" / "dns-provider-fields.json"
        self.assertEqual(json.loads(fixture.read_text()), cj.DNS_PROVIDER_FIELDS)


class Snippets(unittest.TestCase):
    base = "/etc/portikus/certificate"

    def blocks(self, settings):
        text = cj.snippets(settings, self.base)
        global_, rest = text.split("(portikus_tls_site)")
        site, preview = rest.split("(portikus_tls_preview)")
        return global_.split("(portikus_tls_global)")[1], site, preview

    def test_internal(self):
        global_, site, preview = self.blocks({"source": "internal"})
        self.assertEqual(global_, " {\n}\n\n")
        self.assertEqual(site, " {\n\ttls internal\n}\n\n")
        self.assertEqual(preview, " {\n\ttls internal\n}\n")

    def test_files_without_a_preview_wildcard_use_the_site_files_twice(self):
        _, site, preview = self.blocks({"source": "files", "site": {"certificate": "x"}})
        line = f"tls {self.base}/files/site.crt {self.base}/files/site.key"
        self.assertIn(line, site)
        self.assertIn(line, preview)

    def test_files_with_a_preview_wildcard(self):
        _, site, preview = self.blocks({"source": "files", "site": {"certificate": "x"},
                                        "preview": {"certificate": "y"}})
        self.assertIn(f"tls {self.base}/files/site.crt {self.base}/files/site.key", site)
        self.assertIn(f"tls {self.base}/files/preview.crt {self.base}/files/preview.key", preview)

    def test_http01_is_on_demand_for_previews_and_asks_the_api(self):
        global_, site, preview = self.blocks(acme(mode="http01"))
        self.assertIn("\t\t\tdir https://acme-v02.api.letsencrypt.org/directory\n", site)
        self.assertIn("\t\t\temail admin@example.test\n", site)
        self.assertIn("disable_tlsalpn_challenge", site)
        self.assertNotIn("on_demand", site)
        self.assertIn("\t\ton_demand\n", preview)
        # The Caddyfile passes the API's ask URL as the argument.
        self.assertEqual(global_, " {\n\ton_demand_tls {\n\t\task {args[0]}\n\t}\n}\n\n")
        self.assertNotIn("dns ", site + preview)

    def test_eab_names_its_secret_file(self):
        text = cj.snippets(acme(eab={"keyId": "kid-1", "hmacKey": HMAC}), self.base)
        self.assertIn(f"\t\t\teab kid-1 {{file.{self.base}/secrets/eab_hmac_key}}\n", text)
        self.assertNotIn(HMAC, text)

    def test_every_dns_provider(self):
        for provider, fields in cj.DNS_PROVIDER_FIELDS.items():
            with self.subTest(provider=provider):
                values = {n: f"plain-{n}" for n in fields["plain"]}
                values.update({n: f"secret-value-{n}" for n in fields["secret"]})
                global_, site, preview = self.blocks(acme(provider=provider, fields=values))
                self.assertIn(f"\t\t\tdns {provider} {{\n", site)
                for name in fields["plain"]:
                    self.assertIn(f"\t\t\t\t{name} plain-{name}\n", site)
                for name in fields["secret"]:
                    self.assertNotIn(f"secret-value-{name}", site + preview)
                    if (provider, name) in cj.PATH_SECRET_FIELDS:
                        self.assertIn(f"\t\t\t\tgcp_application_default {self.base}/secrets/{provider}_{name}.json\n",
                                      site)
                    else:
                        self.assertIn(f"\t\t\t\t{name} {{file.{self.base}/secrets/{provider}_{name}}}\n", site)
                # The preview block gets the same issuer, so a DNS-01 wildcard covers previews.
                self.assertEqual(site.strip(), preview.strip())
                self.assertNotIn("on_demand", global_ + site + preview)

    def test_a_secret_never_reaches_the_snippet(self):
        """A secret with braces or spaces would inject directives; it only ever goes to a file."""
        evil = "x }\n\ttls internal {"
        self.assertNotIn("tls internal", cj.snippets(acme(fields={"api_token": evil},
                                                          eab={"keyId": "k", "hmacKey": "h"}), self.base))


class Validation(JobTest):
    """The job refuses everything the zod schemas refuse; it never trusts the API (Epic 27 R7)."""

    def refused(self, raw, message=None):
        path = Path(self.runner.jobs_dir, f"request-{ID}.json")
        path.write_bytes(raw if isinstance(raw, bytes) else json.dumps(raw).encode())
        before = Path(self.tree.state("tls.caddy")).read_text()
        self.runner.run_pending()
        status = self.status()
        self.assertEqual(status["state"], "refused", status)
        if message:
            self.assertIn(message, status["message"])
        self.assertFalse(path.exists())
        self.assertEqual(Path(self.tree.state("tls.caddy")).read_text(), before)
        self.assertEqual(self.fake.ran("systemctl", "reload"), [])
        shutil.rmtree(Path(self.runner.jobs_dir, ID))
        return status

    def doc(self, request, **over):
        return {"id": ID, "requestedAt": "2026-09-30T10:00:00.000Z", "requestedBy": USER, "request": request,
                **over}

    def test_request_file_shapes(self):
        self.refused(b"not json", "not valid JSON")
        self.refused(b'{"id": "a", "id": "b"}', "not valid JSON")
        self.refused({**self.doc({"kind": "check"}), "extra": 1}, "missing or extra")
        self.refused(self.doc({"kind": "check"}, id=ID2), "does not match")
        self.refused(self.doc({"kind": "check"}, requestedAt="yesterday"), "requestedAt")
        self.refused(self.doc({"kind": "check"}, requestedBy="admin"), "requestedBy")
        self.refused(self.doc(["check"]), "not an object")

    def test_kinds(self):
        self.assertIsNone(self.refused(self.doc({"kind": "reset"}), "unknown kind")["kind"])
        self.refused(self.doc({"kind": "format-disk"}), "unknown kind")
        for kind in ("renew", "rollback", "check"):
            self.assertEqual(self.refused(self.doc({"kind": kind, "settings": {}}), "extra")["kind"], kind)
        self.refused(self.doc({"kind": "apply"}), "missing or extra")
        self.refused(self.doc({"kind": "test", "settings": {"source": "internal"}}), "ACME settings only")

    def test_settings(self):
        bad = [
            ({"source": "letsencrypt"}, "unknown certificate source"),
            ({"source": "internal", "x": 1}, "missing or extra"),
            (dict(acme(), directory="http://acme.example/dir"), "directory"),
            (dict(acme(), directory="https://acme.example/dir }"), "directory"),
            (dict(acme(), directory="https://" + "a" * 500), "directory"),
            (dict(acme(), email="not-an-email"), "email"),
            (dict(acme(), email="a..b@example.test"), "email"),
            (dict(acme(), extra=True), "missing or extra"),
            (acme(eab={"keyId": "kid 1"}), "EAB key ID"),
            (acme(eab={"keyId": "kid", "hmacKey": "bad key!"}), "HMAC"),
            (acme(eab={"keyId": "kid", "other": "x"}), "missing or extra"),
            (dict(acme(), challenge={"mode": "tls-alpn"}), "challenge mode"),
            (dict(acme(), challenge={"mode": "dns01"}), "missing or extra"),
            (dict(acme(), challenge={"mode": "http01", "dns": {}}), "missing or extra"),
            (acme(provider="bind"), "unknown DNS provider"),
            (acme(provider="route53", fields={"access_key_id": "AKIA"}), "missing or extra"),
            (acme(fields={"api_token": TOKEN, "zone_token": TOKEN}), "missing or extra"),
            (acme(provider="porkbun", fields={"api_key": "key with space"}), "api_key"),
            (acme(provider="porkbun", fields={"api_key": "key}"}), "api_key"),
            (acme(fields={"api_token": "two\nlines"}), "one line"),
            (acme(fields={"api_token": "x" * 1025}), "one line"),
            (acme(fields={"api_token": ""}), "one line"),
            (acme(provider="googleclouddns", fields={"gcp_project": "p", "service_account_json": "[1]"}),
             "service account"),
            (acme(provider="googleclouddns", fields={"gcp_project": "p", "service_account_json": "{"}),
             "service account"),
            # An external account makes Google's library read local files and send them out.
            (acme(provider="googleclouddns", fields={"gcp_project": "p", "service_account_json": json.dumps(
                {"type": "external_account", "credential_source": {"file": "/etc/shadow"},
                 "token_url": "https://evil.example.test"})}), "service account"),
            (acme(provider="googleclouddns", fields={"gcp_project": "p", "service_account_json": json.dumps(
                {"type": "service_account", "project_id": "p", "private_key_id": "i", "client_email": "a@b.test",
                 "private_key": "k", "credential_source": "x"})}), "service account"),
            (acme(provider="googleclouddns", fields={"gcp_project": "p", "service_account_json": json.dumps(
                {"type": "service_account", "client_email": "a@b.test", "private_key": "k"})}),
             "service account"),
            ({"source": "files"}, "missing or extra"),
            ({"source": "files", "site": {"certificate": "plain text"}}, "PEM"),
            ({"source": "files", "site": {"certificate": "-----BEGIN " + "A" * 70000}}, "PEM"),
            ({"source": "files", "site": {"certificate": CERTS.pem("site"), "privateKey": "nope"}}, "PEM"),
        ]
        for settings, message in bad:
            with self.subTest(settings=json.dumps(settings)[:80]):
                status = self.refused(self.doc({"kind": "apply", "settings": settings}), message)
                self.assertEqual(status["kind"], "apply")
                self.assertNotIn(TOKEN, json.dumps(status))

    def test_a_request_file_another_account_wrote_is_refused(self):
        self.runner.host.api_uid = os.geteuid() + 1
        status = self.refused(self.doc({"kind": "check"}), "regular file the API wrote")
        self.assertIsNone(status["kind"])

    def test_a_linked_request_file_is_refused_and_removed(self):
        target = Path(self.tree.root, "elsewhere.json")
        target.write_text(json.dumps(self.doc({"kind": "check"})))
        Path(self.runner.jobs_dir, f"request-{ID}.json").symlink_to(target)
        self.runner.run_pending()
        self.assertEqual(self.status()["state"], "refused")
        self.assertFalse(os.path.lexists(Path(self.runner.jobs_dir, f"request-{ID}.json")))
        self.assertTrue(target.exists())

    def test_a_job_directory_that_exists_already_drops_the_request(self):
        os.mkdir(Path(self.runner.jobs_dir, ID))
        Path(self.runner.jobs_dir, f"request-{ID}.json").write_text(json.dumps(self.doc({"kind": "check"})))
        with contextlib.redirect_stderr(io.StringIO()):
            self.runner.run_pending()
        self.assertEqual(os.listdir(Path(self.runner.jobs_dir, ID)), [])
        self.assertFalse(Path(self.runner.jobs_dir, f"request-{ID}.json").exists())

    def test_a_crashing_job_still_removes_its_request_and_fails(self):
        def crash(job, request):
            raise RuntimeError(f"boom {TOKEN}")
        self.runner.apply = crash
        with contextlib.redirect_stderr(io.StringIO()):
            status = self.submit({"kind": "apply", "settings": acme()})
        self.assertEqual(status["state"], "failed")
        self.assertFalse(Path(self.runner.jobs_dir, f"request-{ID}.json").exists())
        self.assertNotIn(TOKEN, self.everything_written())

    def test_a_request_file_with_a_bad_name_is_dropped(self):
        Path(self.runner.jobs_dir, "request-..%2f.json").write_text("{}")
        self.runner.run_pending()
        self.assertEqual(os.listdir(self.runner.jobs_dir), [])

    def test_a_second_request_waiting_while_one_ran_is_refused(self):
        late = Path(self.runner.jobs_dir, f"request-{ID2}.json")

        def arrives(_):
            late.write_text(json.dumps({"id": ID2, "requestedAt": "2026-09-30T10:00:00Z", "requestedBy": USER,
                                        "request": {"kind": "check"}}))
            os.utime(late, ns=(1, 1))
        self.fake.on_reload = arrives
        self.assertEqual(self.submit({"kind": "apply", "settings": {"source": "internal"}})["state"], "succeeded")
        self.assertEqual(self.status(ID2)["state"], "refused")
        self.assertIn("another certificate job", self.status(ID2)["message"])


class FirstInstall(JobTest):
    def test_internal_is_seeded_once(self):
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertEqual(self.first_install(acme()), (0, "unchanged"))
        self.assertEqual(self.settings(), {"source": "internal"})

    def test_an_old_letsencrypt_preseed_seeds_cloudflare(self):
        shutil.rmtree(self.runner.state_dir)
        os.mkdir(self.runner.state_dir, 0o750)
        self.assertEqual(self.first_install(acme()), (0, "changed"))
        view = self.settings()
        self.assertEqual(view["challenge"], {"mode": "dns01", "provider": "cloudflare", "fields": {},
                                             "secretsSet": {"api_token": True}})
        secret = Path(self.tree.state("secrets/cloudflare_api_token"))
        self.assertEqual(secret.read_text(), TOKEN)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(Path(self.tree.state("secrets")).stat().st_mode), 0o750)
        self.assertNotIn(TOKEN, Path(self.tree.state("tls.caddy")).read_text() + json.dumps(view))
        self.assertFalse(os.path.exists(self.tree.state("secrets.env")))

    def test_refused_settings_write_nothing(self):
        shutil.rmtree(self.runner.state_dir)
        os.mkdir(self.runner.state_dir, 0o750)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.first_install({"source": "acme"})[0], 2)
        self.assertEqual(os.listdir(self.runner.state_dir), [])


class Apply(JobTest):
    def test_internal(self):
        self.fake.serve("internal")
        status = self.submit({"kind": "apply", "settings": {"source": "internal"}})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(self.fake.ran("systemctl", "reload", "caddy"), [["systemctl", "reload", "caddy"]])
        self.assertEqual(len(self.fake.ran("runuser")), 1)
        self.assertTrue(os.path.isfile(self.tree.state("previous/settings.json")))
        self.assertEqual(self.throwaway_calls, [])

    def test_dns01_issues_away_from_the_live_site_then_switches(self):
        snippet_at_reload = []
        self.fake.on_reload = lambda verb: snippet_at_reload.append(Path(self.tree.state("tls.caddy")).read_text())
        self.fake.serve("acme")
        status = self.submit({"kind": "apply", "settings": acme()})
        self.assertEqual(status["state"], "succeeded", status)
        # Let's Encrypt production is tested against staging first, from an empty storage.
        self.assertEqual([(c["directory"], c["seed"]) for c in self.throwaway_calls],
                         [(STAGING, False), (PRODUCTION, True)])
        self.assertEqual(self.throwaway_calls[1]["names"], [SITE, WILDCARD])
        # The throwaway reads the new generation's own secret, never the live one.
        self.assertIn(".new/secrets/cloudflare_api_token", self.throwaway_calls[1]["tls"])
        self.assertEqual(self.throwaway_calls[1]["secrets"], ["cloudflare_api_token"])
        copied = Path(self.runner.caddy_data, "certificates", "acme-v02.example-directory", SITE, f"{SITE}.crt")
        self.assertEqual(copied.read_text(), CERTS.pem("acme2"))
        self.assertTrue(Path(self.runner.caddy_data, "certificates", "acme-v02.example-directory",
                             f"wildcard_.{SUFFIX}").is_dir())
        # The snippet changed only at the one reload, after the certificates were in storage.
        self.assertEqual(len(snippet_at_reload), 1)
        self.assertIn(f"{{file.{self.runner.state_dir}/secrets/cloudflare_api_token}}", snippet_at_reload[0])
        self.assertEqual(self.record(), {"kind": "apply", "settings": self.settings()})
        self.assertEqual(self.settings()["challenge"]["secretsSet"], {"api_token": True})
        self.assertNotIn(TOKEN, self.everything_written())

    def test_a_custom_directory_is_not_tested_separately(self):
        self.fake.serve("acme")
        status = self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual([c["directory"] for c in self.throwaway_calls], ["https://acme.example.test/dir"])

    def test_a_failed_issuance_leaves_the_live_site_alone(self):
        before = {n: Path(self.tree.state(n)).read_text() for n in ("settings.json", "tls.caddy")}
        self.throwaway_error = f"No certificate was obtained. Caddy said: HTTP 403 invalid token {TOKEN}"
        self.runner.issue_with_throwaway_caddy = self.fake_throwaway
        status = self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")})
        self.assertEqual(status["state"], "failed")
        self.assertFalse(status["restored"])
        self.assertIn("[secret]", status["message"])
        self.assertNotIn(TOKEN, json.dumps(status))
        self.assertEqual(self.fake.ran("systemctl", "reload"), [])
        self.assertEqual({n: Path(self.tree.state(n)).read_text() for n in before}, before)
        self.assertFalse(os.path.exists(self.tree.state(".new")))
        self.assertNotIn(TOKEN, self.everything_written())

    def test_a_failed_apply_puts_the_previous_state_back(self):
        before = {n: Path(self.tree.state(n)).read_text() for n in ("settings.json", "tls.caddy")}
        previous_before = os.path.exists(self.tree.state("previous"))
        # Caddy keeps serving the internal certificate, never the new one.
        self.fake.serve("internal")
        status = self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")})
        self.assertEqual(status["state"], "failed", status)
        self.assertTrue(status["restored"])
        self.assertIn("previous certificate is back in use", status["message"])
        self.assertEqual({n: Path(self.tree.state(n)).read_text() for n in before}, before)
        self.assertFalse(os.path.exists(self.tree.state("secrets/cloudflare_api_token")))
        self.assertEqual(os.path.exists(self.tree.state("previous")), previous_before)
        self.assertEqual(len(self.fake.ran("systemctl", "reload", "caddy")), 2)
        self.assertFalse(os.path.exists(self.tree.state(".before")))

    def test_caddy_refusing_the_configuration_restores_without_reloading_it(self):
        self.fake.rc["validate"] = 1
        status = self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")})
        self.assertEqual(status["state"], "failed")
        self.assertTrue(status["restored"])
        self.assertEqual(self.settings(), {"source": "internal"})

    def test_http01_is_obtained_by_the_live_caddy_with_a_longer_wait(self):
        self.fake.serve("internal")
        self.fake.on_reload = lambda verb: self.fake.serve("acme")
        status = self.submit({"kind": "apply", "settings": acme(mode="http01")})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(self.throwaway_calls, [])
        # The sample preview name is never asked for: under HTTP-01 that would issue it a certificate.
        self.assertEqual([c for c in self.fake.ran("openssl", "s_client") if SAMPLE in c], [])
        self.assertIn("on_demand_tls", Path(self.tree.state("tls.caddy")).read_text())

    def test_http01_failure_waits_the_longer_time_then_restores(self):
        start = self.clock.now
        status = self.submit({"kind": "apply", "settings": acme(mode="http01")})
        self.assertEqual(status["state"], "failed")
        self.assertTrue(status["restored"])
        self.assertGreaterEqual(self.clock.now - start, cj.HTTP01_TIMEOUT)

    def test_blank_secrets_keep_the_stored_ones_for_the_same_provider(self):
        self.fake.serve("acme")
        self.assertEqual(self.submit({"kind": "apply", "settings": acme(eab={"keyId": "kid", "hmacKey": HMAC})},
                                     ID)["state"], "succeeded")
        self.fake.serve("acme2")
        status = self.submit({"kind": "apply", "settings": acme(fields={}, eab={"keyId": "kid"})}, ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(Path(self.tree.state("secrets/cloudflare_api_token")).read_text(), TOKEN)
        self.assertEqual(Path(self.tree.state("secrets/eab_hmac_key")).read_text(), HMAC)
        self.assertEqual(self.record(ID2)["settings"]["eab"], {"keyId": "kid", "hmacKeySet": True})

    def test_a_blank_secret_is_not_kept_for_another_provider_or_eab_key(self):
        self.fake.serve("acme")
        self.submit({"kind": "apply", "settings": acme(eab={"keyId": "kid", "hmacKey": HMAC})}, ID)
        status = self.submit({"kind": "apply", "settings": acme(provider="hetzner", fields={})}, ID2)
        self.assertEqual(status["state"], "refused")
        self.assertIn("hetzner secret api_token is not set", status["message"])
        shutil.rmtree(Path(self.runner.jobs_dir, ID2))
        status = self.submit({"kind": "apply", "settings": acme(fields={}, eab={"keyId": "other"})}, ID2)
        self.assertIn("EAB HMAC key is not set", status["message"])

    def test_google_writes_its_json_to_a_file(self):
        account = json.dumps({"type": "service_account", "project_id": "proj-1", "private_key_id": "fake-id",
                              "client_email": "dns@proj-1.example.test",
                              "private_key": "fake-private-key-material-0123456789"})
        self.fake.serve("acme")
        status = self.submit({"kind": "apply", "settings": acme(
            provider="googleclouddns", fields={"gcp_project": "proj-1", "service_account_json": account})})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(Path(self.tree.state("secrets/googleclouddns_service_account_json.json")).read_text(), account)
        self.assertIn(f"gcp_application_default {self.runner.state_dir}/secrets/googleclouddns_service_account_json.json",
                      Path(self.tree.state("tls.caddy")).read_text())
        self.assertNotIn("fake-private-key-material", self.everything_written())


class Uploads(JobTest):
    """openssl checks each upload and names the check that failed (Epic 27 R9)."""

    def apply_files(self, settings, job_id=ID):
        return self.submit({"kind": "apply", "settings": settings}, job_id)

    def test_a_good_upload_is_put_in_force(self):
        self.fake.serve("site")
        status = self.apply_files(files())
        self.assertEqual(status["state"], "succeeded", status)
        view = self.settings()
        self.assertEqual(view["site"]["privateKeySet"], True)
        self.assertEqual(view["site"]["certificate"]["names"], [SITE, WILDCARD])
        self.assertIsNone(view["preview"])
        key = Path(self.tree.state("files/site.key"))
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o640)
        self.assertNotIn(CERTS.pem("site", "key"), self.everything_written())
        # The API trusts the uploaded chain too (Epic 27 R14), and restarts once for it.
        self.assertIn(CERTS.pem("inter"), Path(self.runner.trust_bundle).read_text())
        self.assertEqual(len(self.fake.ran("systemctl", "try-restart", "portikus-api.service")), 1)

    def test_a_separate_preview_wildcard(self):
        self.fake.serve("siteonly", "preview")
        status = self.apply_files(files("siteonly", "siteonly", preview="preview"))
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(self.settings()["preview"]["certificate"]["names"], [WILDCARD])

    def test_a_self_signed_certificate_is_its_own_root(self):
        self.fake.serve("selfsigned")
        self.assertEqual(self.apply_files(files("selfsigned", "selfsigned", chain=False))["state"], "succeeded")

    def check_refused(self, settings, check):
        status = self.apply_files(settings)
        self.assertEqual(status["state"], "refused", status)
        self.assertIn(f"check '{check}' failed", status["message"])
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertFalse(glob.glob(self.tree.state(".upload-*")))
        return status

    def test_each_failed_check_is_named(self):
        cases = [
            (dict(files(), site={"certificate": "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
                                 "privateKey": CERTS.pem("site", "key")}), "certificate-readable"),
            (dict(files(), site={"certificate": CERTS.chain("site"), "privateKey": "-----BEGIN PRIVATE KEY-----\n"}),
             "key-readable"),
            (files("site", "stray"), "key-matches"),
            (files("site", "site", chain=False), "chain-complete"),
            (files("other", "other"), "names-cover"),
            (files("siteonly", "siteonly"), "names-cover"),
        ]
        for settings, check in cases:
            with self.subTest(check=check):
                self.check_refused(settings, check)
                shutil.rmtree(Path(self.runner.jobs_dir, ID))

    def test_an_expired_certificate(self):
        self.clock.now += 400 * 86400
        self.check_refused(files(), "dates-valid")

    def test_a_missing_key_with_nothing_stored(self):
        self.check_refused(files(key=None), "key-readable")

    def test_a_blank_key_keeps_the_stored_one(self):
        self.fake.serve("site")
        self.assertEqual(self.apply_files(files(), ID)["state"], "succeeded")
        status = self.apply_files(files(key=None), ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(Path(self.tree.state("files/site.key")).read_text(), CERTS.pem("site", "key"))


class Test(JobTest):
    def test_lets_encrypt_is_tested_against_staging_and_nothing_live_changes(self):
        before = Path(self.tree.state("tls.caddy")).read_text()
        status = self.submit({"kind": "test", "settings": acme()})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual([(c["directory"], c["seed"]) for c in self.throwaway_calls], [(STAGING, False)])
        self.assertIn("staging", status["message"])
        self.assertEqual(Path(self.tree.state("tls.caddy")).read_text(), before)
        self.assertEqual(self.fake.ran("systemctl"), [])
        self.assertFalse(os.path.exists(self.tree.state(".new")))
        self.assertEqual(self.record()["settings"]["challenge"]["secretsSet"], {"api_token": True})
        self.assertNotIn(TOKEN, self.everything_written())

    def test_another_directory_is_tested_against_itself(self):
        status = self.submit({"kind": "test", "settings": acme(directory="https://acme.zerossl.com/v2/DV90")})
        self.assertEqual(self.throwaway_calls[0]["directory"], "https://acme.zerossl.com/v2/DV90")
        self.assertIn("real certificate", status["message"])

    def test_http01_cannot_be_tested_apart_from_the_live_site(self):
        status = self.submit({"kind": "test", "settings": acme(mode="http01")})
        self.assertEqual(status["state"], "refused")
        self.assertIn("port 80", status["message"])


class Rollback(JobTest):
    def test_rollback_swaps_the_generations(self):
        self.fake.serve("site")
        self.submit({"kind": "apply", "settings": files()}, ID)
        self.fake.serve("internal")
        status = self.submit({"kind": "rollback"}, ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertEqual(json.loads(Path(self.tree.state("previous/settings.json")).read_text())["source"], "files")
        self.assertTrue(os.path.isfile(self.tree.state("previous/files/site.key")))

    def test_a_failed_rollback_keeps_both_generations(self):
        self.fake.serve("site")
        self.submit({"kind": "apply", "settings": files()}, ID)
        status = self.submit({"kind": "rollback"}, ID2)
        self.assertEqual(status["state"], "failed", status)
        self.assertTrue(status["restored"])
        self.assertEqual(self.settings()["source"], "files")
        self.assertEqual(json.loads(Path(self.tree.state("previous/settings.json")).read_text()),
                         {"source": "internal"})

    def test_rollback_without_a_previous_generation_is_refused(self):
        shutil.rmtree(self.tree.state("previous"), ignore_errors=True)
        status = self.submit({"kind": "rollback"})
        self.assertEqual(status["state"], "refused")
        self.assertIn("no previous certificate", status["message"])


class Renew(JobTest):
    def live_cert(self, ca_dir, name, text):
        folder = Path(self.runner.caddy_data, "certificates", ca_dir, cj.storage_name(name))
        folder.mkdir(parents=True, exist_ok=True)
        Path(folder, cj.storage_name(name) + ".crt").write_text(text)

    def apply_dns01(self):
        self.fake.serve("acme")
        self.assertEqual(self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")},
                                     ID)["state"], "succeeded")
        self.throwaway_calls.clear()
        self.fake.calls.clear()

    def test_dns01_renews_through_the_throwaway_and_reloads_away_and_back(self):
        self.apply_dns01()
        self.live_cert("acme-v02.example-directory", SITE, "old")
        snippets = []
        self.fake.on_reload = lambda verb: (snippets.append(Path(self.tree.state("tls.caddy")).read_text()),
                                            self.fake.serve("acme2"))
        status = self.submit({"kind": "renew"}, ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual([(c["directory"], c["seed"], c["base"]) for c in self.throwaway_calls],
                         [("https://acme.example.test/dir", True, self.runner.state_dir)])
        self.assertIn("tls internal", snippets[0])
        self.assertIn("dns cloudflare", snippets[1])
        self.assertIn("dns cloudflare", Path(self.tree.state("tls.caddy")).read_text())
        self.assertEqual(Path(self.runner.caddy_data, "certificates", "acme-v02.example-directory", SITE,
                              f"{SITE}.crt").read_text(), CERTS.pem("acme2"))

    def test_a_renewal_caddy_does_not_serve_puts_the_old_certificate_back(self):
        self.apply_dns01()
        self.live_cert("acme-v02.example-directory", SITE, "old")
        status = self.submit({"kind": "renew"}, ID2)
        self.assertEqual(status["state"], "failed", status)
        self.assertTrue(status["restored"])
        self.assertEqual(Path(self.runner.caddy_data, "certificates", "acme-v02.example-directory", SITE,
                              f"{SITE}.crt").read_text(), "old")
        self.assertIn("dns cloudflare", Path(self.tree.state("tls.caddy")).read_text())
        self.assertEqual(self.fake.ran("systemctl", "restart", "caddy")[-1], ["systemctl", "restart", "caddy"])

    def test_internal_restarts_caddy_to_issue_again(self):
        self.live_cert("local", SITE, "old")
        self.fake.on_reload = lambda verb: self.fake.serve("internal2")
        status = self.submit({"kind": "renew"})
        self.assertEqual(status["state"], "succeeded", status)
        self.assertFalse(Path(self.runner.caddy_data, "certificates", "local", SITE).exists())
        self.assertEqual(self.throwaway_calls, [])

    def test_files_and_http01_are_refused(self):
        self.fake.serve("site")
        self.submit({"kind": "apply", "settings": files()}, ID)
        status = self.submit({"kind": "renew"}, ID2)
        self.assertEqual(status["state"], "refused")
        self.assertIn("upload a new one", status["message"])


class Check(JobTest):
    def test_status_file(self):
        self.fake.serve("internal")
        ok = {"level": "info", "ts": 1790000000.5, "logger": "tls.renew", "msg": "certificate renewed successfully",
              "identifier": SITE, "issuer": "acme"}
        local = {"level": "info", "ts": 1790000100, "logger": "tls.obtain", "msg": "certificate obtained successfully",
                 "identifier": SITE, "issuer": "local"}
        failed = {"level": "error", "ts": 1790000200, "logger": "tls.renew",
                  "msg": "could not get certificate from issuer", "identifier": SITE, "issuer": "acme",
                  "error": f"HTTP 403: Invalid access token {TOKEN}"}
        retry = {"level": "error", "ts": 1790000201, "logger": "tls.renew", "msg": "will retry",
                 "error": f"[{SITE}] Obtain: {TOKEN}"}
        canceled = {"level": "error", "ts": 1790000300, "logger": "tls.obtain",
                    "msg": "could not get certificate from issuer", "error": "context canceled"}
        self.fake.journal = "\n".join(json.dumps({"MESSAGE": json.dumps(e)})
                                      for e in (ok, local, failed, retry, canceled)) + "\nnot json\n"
        Path(self.tree.state("secrets")).mkdir(exist_ok=True)
        Path(self.tree.state("secrets/cloudflare_api_token")).write_text(TOKEN)
        self.assertEqual(self.runner.run_check(), 0)
        status = json.loads(Path(self.runner.status_dir, "status.json").read_text())
        self.assertEqual(status["source"], "internal")
        self.assertEqual(status["settings"], {"source": "internal"})
        self.assertFalse(status["previousAvailable"])
        self.assertEqual(status["site"]["name"], SITE)
        self.assertIn("Caddy Local Authority", status["site"]["issuer"])
        self.assertEqual(status["preview"]["name"], SAMPLE)
        self.assertEqual(status["lastRenewal"]["ok"], False)
        self.assertEqual(status["lastRenewal"]["at"], "2026-09-21T14:16:40Z")
        self.assertEqual(status["lastRenewal"]["name"], SITE)
        self.assertIn("Invalid access token [secret]", status["lastRenewal"]["message"])
        self.assertNotIn(TOKEN, json.dumps(status))
        self.assertEqual(stat.S_IMODE(os.stat(Path(self.runner.status_dir, "status.json")).st_mode), 0o644)
        self.assertEqual(Path(self.runner.status_dir, "root.crt").read_text(), CERTS.pem("caddyroot"))

    def test_the_trust_bundle_restarts_the_api_only_when_it_changes(self):
        self.runner.run_check()
        self.fake.calls.clear()
        self.runner.run_check()
        self.assertEqual(self.fake.ran("systemctl", "try-restart"), [])
        bundle = Path(self.runner.trust_bundle).read_text()
        self.assertIn(CERTS.pem("root"), bundle)
        self.assertIn(CERTS.pem("caddyroot"), bundle)
        Path(self.runner.caddy_root).write_text(CERTS.pem("acmeroot"))
        self.runner.run_check()
        self.assertEqual(len(self.fake.ran("systemctl", "try-restart", "portikus-api.service")), 1)

    def test_a_check_request(self):
        status = self.submit({"kind": "check"})
        self.assertEqual(status["state"], "succeeded")
        self.assertTrue(Path(self.runner.status_dir, "status.json").exists())

    def test_check_skips_while_a_job_holds_the_lock(self):
        fd = self.runner.locked(blocking=True)
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(self.runner.run_check(), 0)
        finally:
            os.close(fd)
        self.assertFalse(Path(self.runner.status_dir, "status.json").exists())


class Scrubbing(unittest.TestCase):
    def test_every_form_of_a_secret_is_scrubbed(self):
        secret = "fake/token+with=odd&chars\"0123"
        message = (f"raw {secret} json {json.dumps(secret)} url {__import__('urllib.parse').parse.quote(secret, safe='')}"
                   f" plus {__import__('urllib.parse').parse.quote_plus(secret)}")
        out = cj.scrub(message, [secret])
        self.assertNotIn("odd", out)
        self.assertEqual(out.count("[secret]"), 4)

    def test_lines_of_a_multi_line_secret_are_scrubbed(self):
        key = CERTS.pem("site", "key")
        line = key.splitlines()[1]
        self.assertNotIn(line, cj.scrub(f"bad key: {line}", cj.secret_words(key)))

    def test_authorization_headers_are_scrubbed_even_unknown(self):
        out = cj.scrub('request failed: Authorization: Bearer abc.def-123 "authorization":"Basic Zm9vOmJhcg=="', [])
        self.assertNotIn("abc.def-123", out)
        self.assertNotIn("Zm9vOmJhcg", out)
        self.assertIn("Authorization: Bearer [secret]", out)

    def test_short_values_are_left_alone(self):
        self.assertEqual(cj.scrub("a b c", ["a"]), "a b c")


class ThrowawayCaddy(JobTest):
    def test_caddy_is_stopped_at_the_deadline_and_its_error_is_scrubbed(self):
        fake_caddy = Path(self.tree.root, "fake-caddy")
        line = json.dumps({"level": "error", "ts": 1790000000, "logger": "tls.obtain",
                           "msg": "could not get certificate from issuer", "identifier": SITE,
                           "error": f"HTTP 403: Invalid access token {TOKEN}"})
        pid_file = Path(self.tree.root, "caddy.pid")
        fake_caddy.write_text(f"#!/bin/sh\necho $$ > {pid_file}\necho '{line}' >&2\nexec sleep 1000\n")
        fake_caddy.chmod(0o755)
        runner = cj.Runner(root=self.tree.root, run_=self.fake, caddy=str(fake_caddy), timeouts={"issue": 1})
        jobs_fd = os.open(runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), runner.host)
        job.secrets = [TOKEN]
        new = runner.state(".new")
        runner.build_generation(new, acme(), {("cloudflare", "api_token"): TOKEN}, None, {}, base=new)
        with self.assertRaises(cj.JobFailed) as caught:
            runner.issue_with_throwaway_caddy(job, acme(), [SITE, WILDCARD], new)
        job.close()
        os.close(jobs_fd)
        self.assertIn("Invalid access token", str(caught.exception))
        self.assertIn("live site is unchanged", str(caught.exception))
        self.assertNotIn(TOKEN, cj.scrub(str(caught.exception), job.secrets))
        self.assertNotIn(TOKEN, Path(runner.jobs_dir, ID, "log.txt").read_text())
        pid = int(pid_file.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertEqual(glob.glob(runner.state(".throwaway-*")), [])

    def test_the_throwaway_never_runs_as_root(self):
        runner = cj.Runner(root=self.tree.root, run_=self.fake, caddy="/bin/false")
        runner.host.root = True
        runner.host.caddy_uid = -1
        jobs_fd = os.open(runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), cj.Host())
        try:
            with self.assertRaises(cj.JobFailed) as caught:
                runner.issue_with_throwaway_caddy(job, acme(), [SITE], runner.state_dir)
        finally:
            job.close()
            os.close(jobs_fd)
        self.assertIn("caddy account", str(caught.exception))

    def test_a_log_line_with_a_token_is_scrubbed_before_it_is_written(self):
        jobs_fd = os.open(self.runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), self.runner.host)
        job.secrets = [TOKEN]
        job.line(f"caddy: HTTP 403 for token {TOKEN} with Authorization: Bearer {TOKEN2}")
        job.close()
        os.close(jobs_fd)
        log = Path(self.runner.jobs_dir, ID, "log.txt").read_text()
        self.assertNotIn(TOKEN, log)
        self.assertNotIn(TOKEN2, log)

    def test_the_throwaway_configuration(self):
        captured = {}
        fake_caddy = Path(self.tree.root, "fake-caddy")
        fake_caddy.write_text("#!/bin/sh\ncp \"$3\" \"$(dirname \"$3\")/../captured\"\nexec sleep 1000\n")
        fake_caddy.chmod(0o755)
        runner = cj.Runner(root=self.tree.root, run_=self.fake, caddy=str(fake_caddy), timeouts={"issue": 1})
        os.makedirs(os.path.join(runner.caddy_data, "acme", "account"))
        Path(runner.caddy_data, "acme", "account", "key").write_text("account")
        jobs_fd = os.open(runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), runner.host)
        original_rmtree = shutil.rmtree

        def keep(path, *args, **kwargs):
            if os.path.basename(path).startswith(".throwaway-"):
                captured["config"] = Path(path, "Caddyfile").read_text()
                captured["account"] = os.path.exists(os.path.join(path, "storage", "acme", "account", "key"))
            return original_rmtree(path, *args, **kwargs)
        cj.shutil.rmtree = keep
        try:
            with self.assertRaises(cj.JobFailed):
                runner.issue_with_throwaway_caddy(job, acme(), [SITE, WILDCARD], runner.state_dir)
        finally:
            cj.shutil.rmtree = original_rmtree
            job.close()
            os.close(jobs_fd)
        config = captured["config"]
        self.assertTrue(captured["account"])
        for line in ("admin off", "persist_config off", "default_bind 127.0.0.1", "auto_https disable_redirects",
                     f"https://{SITE}, https://{WILDCARD} {{", "import portikus_tls_site"):
            self.assertIn(line, config)
        self.assertNotIn(TOKEN, config)


class Reset(JobTest):
    def test_reset_puts_internal_back_and_keeps_the_old_settings(self):
        self.fake.serve("acme")
        self.submit({"kind": "apply", "settings": acme(directory="https://acme.example.test/dir")})
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.runner.run_reset(out), 0)
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertIn("tls internal", Path(self.tree.state("tls.caddy")).read_text())
        self.assertFalse(os.path.exists(self.tree.state("secrets/cloudflare_api_token")))
        previous = json.loads(Path(self.tree.state("previous/settings.json")).read_text())
        self.assertEqual(previous["challenge"]["provider"], "cloudflare")
        self.assertEqual(Path(self.tree.state("previous/secrets/cloudflare_api_token")).read_text(), TOKEN)
        self.assertIn("/var/lib/portikus/certificate/root.crt", out.getvalue())
        reset_jobs = [json.loads(Path(p).read_text()) for p in glob.glob(os.path.join(self.runner.jobs_dir, "*",
                                                                                     "status.json"))]
        reset_jobs = [s for s in reset_jobs if s["kind"] == "reset"]
        self.assertEqual(len(reset_jobs), 1)
        self.assertEqual(reset_jobs[0]["state"], "succeeded")
        record = json.loads(Path(self.runner.jobs_dir, reset_jobs[0]["id"], "request.json").read_text())
        self.assertEqual(record, {"kind": "reset", "settings": {"source": "internal"}})
        self.assertEqual(self.fake.ran("systemctl", "reload", "caddy")[-1], ["systemctl", "reload", "caddy"])
        self.assertNotIn(TOKEN, self.everything_written())
        # The page can roll back to what the reset replaced.
        self.fake.serve("acme")
        self.assertEqual(self.submit({"kind": "rollback"}, ID2)["state"], "succeeded")
        self.assertEqual(self.settings()["source"], "acme")

    def test_reset_restarts_a_caddy_that_will_not_reload(self):
        self.fake.rc["reload"] = 1
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.runner.run_reset(io.StringIO()), 0)
        self.assertEqual(len(self.fake.ran("systemctl", "restart", "caddy")), 1)

    def test_the_host_command_runs_the_reset_as_root_only(self):
        script = (REPO / "packaging" / "bin" / "portikus").read_text()
        self.assertIn('exec "${CERTIFICATE_JOB}" reset', script)
        self.assertIn("CERTIFICATE_JOB=/usr/lib/portikus/certificate-job", script)
        if os.geteuid() != 0:
            done = __import__("subprocess").run(["sh", str(REPO / "packaging" / "bin" / "portikus"),
                                                 "reset-certificate"], capture_output=True, text=True)
            self.assertEqual(done.returncode, 1)
            self.assertIn("must run as root", done.stderr)


class Recover(JobTest):
    def test_a_lost_job_is_failed_and_a_half_applied_change_is_put_back(self):
        jobs_fd = os.open(self.runner.jobs_dir, os.O_RDONLY | os.O_DIRECTORY)
        job = cj.Job(jobs_fd, ID, os.getgid(), self.runner.host, self.clock)
        job.kind = "apply"
        job.status("running", "Reloading Caddy")
        job.close()
        os.close(jobs_fd)
        # The job stopped between installing the new generation and checking it.
        self.runner.snapshot(self.tree.state(".before"))
        Path(self.tree.state("settings.json")).write_text('{"source": "files"}')
        with contextlib.redirect_stderr(io.StringIO()):
            self.runner.run_recover()
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertTrue(status["restored"])
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertFalse(os.path.exists(self.tree.state(".before")))
        self.assertEqual(self.fake.ran("systemctl", "reload", "caddy"), [["systemctl", "reload", "caddy"]])

    def test_old_job_directories_are_dropped(self):
        for index in range(cj.KEEP_JOBS + 3):
            job_id = f"{index:08x}-0000-4000-8000-000000000000"
            os.mkdir(os.path.join(self.runner.jobs_dir, job_id))
            os.utime(os.path.join(self.runner.jobs_dir, job_id), ns=(index, index))
        self.runner.run_recover()
        self.assertEqual(len(os.listdir(self.runner.jobs_dir)), cj.KEEP_JOBS)


class Units(unittest.TestCase):
    def test_the_package_ships_the_job_and_its_units(self):
        nfpm = (REPO / "packaging" / "nfpm.yaml").read_text()
        for src, dst in (("packaging/certificate/certificate-job", "/usr/lib/portikus/certificate-job"),
                         ("packaging/systemd/portikus-certificate-job.path", "portikus-certificate-job.path"),
                         ("packaging/systemd/portikus-certificate-job.service", "portikus-certificate-job.service"),
                         ("packaging/systemd/portikus-certificate-check.service",
                          "portikus-certificate-check.service"),
                         ("packaging/systemd/portikus-certificate-check.timer", "portikus-certificate-check.timer")):
            self.assertIn(f"src: ./{src}", nfpm)
            self.assertIn(dst, nfpm)
        path = (REPO / "packaging" / "systemd" / "portikus-certificate-job.path").read_text()
        self.assertIn(f"PathExistsGlob={cj.JOBS_DIR}/request-*.json", path)
        timer = (REPO / "packaging" / "systemd" / "portikus-certificate-check.timer").read_text()
        self.assertIn("OnCalendar=hourly", timer)


if __name__ == "__main__":
    unittest.main()
