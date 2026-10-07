"""The internal authority on a public address (docs/SPEC.md section 24.10).

setup and the Certificate tab refuse Caddy's internal authority when the
site's name resolves outside the private ranges, unless root allowed it in
portikus.yaml; `portikus reset-certificate` always works, and the hourly
check reports the internal authority on a public address in status.json.
The resolver and systemctl are faked; no test looks up a name or touches the host.
Run: python3 -m unittest discover -s packaging/certificate/tests
"""

import contextlib
import io
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import unittest
from pathlib import Path

import test_certificate_job as base
from helpers import REPO, SITE, FakeResolver, cj

WAYS_OUT = ("portikus_allow_internal_ca_on_public_address: true", "sudo portikus reset-certificate")


def setUpModule():
    base.setUpModule()


def tearDownModule():
    base.tearDownModule()


class AddressScope(unittest.TestCase):
    def scope(self, host, *addresses):
        return cj.address_scope(host, FakeResolver(*addresses))[0]

    def test_private_only_when_every_address_is_private_or_unique_local(self):
        self.assertEqual(self.scope(SITE, "10.1.2.3"), "private")
        self.assertEqual(self.scope(SITE, "192.168.1.5", "fd00::5"), "private")
        self.assertEqual(self.scope(SITE, "172.20.0.1", "127.0.1.1"), "private")
        self.assertEqual(self.scope(SITE, "10.1.2.3", "203.0.113.7"), "public")
        self.assertEqual(self.scope(SITE, "2001:db8::1"), "public")
        # Shared address space and link-local are not private ranges.
        self.assertEqual(self.scope(SITE, "100.64.0.1"), "public")

    def test_unresolvable_loopback_or_link_local_only_is_unknown(self):
        self.assertEqual(self.scope(SITE), "unknown")
        self.assertEqual(self.scope(SITE, "127.0.1.1"), "unknown")
        self.assertEqual(self.scope(SITE, "::1", "127.0.0.1"), "unknown")
        self.assertEqual(self.scope(SITE, "fe80::1%eth0", "169.254.0.9"), "unknown")

    def test_an_address_literal_is_taken_as_is(self):
        resolver = FakeResolver("10.0.0.1")
        self.assertEqual(cj.address_scope("198.51.100.4", resolver), ("public", [cj.ipaddress.ip_address(
            "198.51.100.4")]))
        self.assertEqual(cj.address_scope("10.9.9.9", resolver)[0], "private")
        self.assertEqual(resolver.asked, [])


def dns_answer(query, records, rcode=0):
    """A recursive server's answer: the query's header and question, then records as (type, rdata)."""
    question = query[12:]
    header = query[:2] + bytes([0x81, 0x80 | rcode]) + b"\0\1" + len(records).to_bytes(2, "big") + b"\0\0\0\0"
    body = b""
    for rtype, rdata in records:
        # A pointer to the question's name, as servers compress it.
        body += b"\xc0\x0c" + rtype.to_bytes(2, "big") + b"\0\1\0\0\0\x3c" + len(rdata).to_bytes(2, "big") + rdata
    return header + question + body


class Dns(unittest.TestCase):
    def serve_once(self, answer):
        """A one-shot DNS server on loopback; returns its port and the query it got."""
        server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        server.bind(("127.0.0.1", 0))
        self.addCleanup(server.close)
        got = []

        def reply():
            query, peer = server.recvfrom(512)
            got.append(query)
            server.sendto(b"\0\0stray", peer)  # a reply to some other query is ignored
            server.sendto(answer(query), peer)

        thread = threading.Thread(target=reply, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        return server.getsockname()[1], got

    def test_a_records_after_a_cname(self):
        cname = b"\3www\7example\4test\0"
        port, got = self.serve_once(lambda q: dns_answer(q, [(5, cname), (1, bytes([203, 0, 113, 7]))]))
        self.assertEqual(cj.dns_query("127.0.0.1", "portikus.example.test", 1, timeout=5, port=port),
                         ["203.0.113.7"])
        self.assertIn(b"\x08portikus\x07example\x04test\x00\x00\x01\x00\x01", got[0])

    def test_aaaa_records(self):
        address = cj.ipaddress.ip_address("2001:db8::7").packed
        port, _ = self.serve_once(lambda q: dns_answer(q, [(28, address)]))
        self.assertEqual(cj.dns_query("127.0.0.1", SITE, 28, timeout=5, port=port), ["2001:db8::7"])

    def test_no_such_name_is_no_address(self):
        port, _ = self.serve_once(lambda q: dns_answer(q, [], rcode=3))
        self.assertEqual(cj.dns_query("127.0.0.1", SITE, 1, timeout=5, port=port), [])

    def test_a_server_failure_raises(self):
        port, _ = self.serve_once(lambda q: dns_answer(q, [], rcode=2))
        with self.assertRaises(OSError):
            cj.dns_query("127.0.0.1", SITE, 1, timeout=5, port=port)

    def test_upstream_servers_skip_resolveds_stub_and_its_hosts_file(self):
        work = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, work)
        upstream, system = os.path.join(work, "upstream"), os.path.join(work, "system")
        Path(system).write_text("nameserver 127.0.0.53\noptions edns0\n")
        self.assertEqual(cj.nameservers((upstream, system)), ["127.0.0.53"])
        Path(upstream).write_text("# resolved\nnameserver 10.101.0.1\nnameserver 127.0.0.53\nnameserver fe80::1%eth0\n")
        self.assertEqual(cj.nameservers((upstream, system)), ["10.101.0.1", "fe80::1"])


class InternalOnPublic(base.JobTest):
    def allow(self):
        Path(self.runner.allow_internal_on_public).write_text("")

    def empty_state(self):
        shutil.rmtree(self.runner.state_dir)
        os.mkdir(self.runner.state_dir, 0o750)

    def first_install_internal(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = self.first_install({"source": "internal"})
        return result, err.getvalue()

    def status_file(self):
        return json.loads(Path(self.runner.status_dir, "status.json").read_text())

    def test_first_install_refuses_a_public_name(self):
        self.empty_state()
        self.resolver.addresses = ["203.0.113.7"]
        (code, _), said = self.first_install_internal()
        self.assertEqual(code, 2)
        self.assertEqual(os.listdir(self.runner.state_dir), [])
        self.assertEqual(self.fake.calls, [])
        for way in (*WAYS_OUT, "sudo dpkg-reconfigure portikus"):
            self.assertIn(way, said)
        self.assertIn("203.0.113.7", said)

    def test_first_install_takes_a_private_or_unknown_name_or_the_flag(self):
        for addresses, allowed in ((["10.0.0.5"], False), ([], False), (["127.0.1.1"], False),
                                   (["203.0.113.7"], True)):
            with self.subTest(addresses=addresses, allowed=allowed):
                self.empty_state()
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(self.runner.allow_internal_on_public)
                if allowed:
                    self.allow()
                self.resolver.addresses = addresses
                self.assertEqual(self.first_install_internal()[0], (0, "changed"))

    def test_first_install_of_acme_never_looks_the_name_up(self):
        self.empty_state()
        self.resolver.addresses = ["203.0.113.7"]
        self.resolver.asked.clear()
        self.assertEqual(self.first_install(base.acme()), (0, "changed"))
        self.assertEqual(self.resolver.asked, [])
        self.assertIsNone(self.status_file()["internalOnPublic"])

    def test_apply_refuses_a_public_name_and_names_the_ways_out(self):
        self.fake.serve("acme")
        self.assertEqual(self.submit({"kind": "apply", "settings": base.acme()})["state"], "succeeded")
        self.resolver.addresses = ["203.0.113.7"]
        status = self.submit({"kind": "apply", "settings": {"source": "internal"}}, base.ID2)
        self.assertEqual(status["state"], "refused", status)
        self.assertEqual(status["kind"], "apply")
        for way in (*WAYS_OUT, "choose ACME or upload certificate files here"):
            self.assertIn(way, status["message"])
        self.assertEqual(self.settings()["source"], "acme")

    def test_apply_with_the_flag_succeeds(self):
        self.fake.serve("acme")
        self.submit({"kind": "apply", "settings": base.acme()})
        self.resolver.addresses = ["203.0.113.7"]
        self.allow()
        self.fake.serve("internal")
        status = self.submit({"kind": "apply", "settings": {"source": "internal"}}, base.ID2)
        self.assertEqual(status["state"], "succeeded", status)
        self.assertEqual(self.settings(), {"source": "internal"})

    def test_rollback_to_internal_on_a_public_name_is_refused(self):
        self.fake.serve("acme")
        self.submit({"kind": "apply", "settings": base.acme()})
        self.resolver.addresses = ["203.0.113.7"]
        status = self.submit({"kind": "rollback"}, base.ID2)
        self.assertEqual(status["state"], "refused", status)
        self.assertIn(WAYS_OUT[0], status["message"])
        self.assertEqual(self.settings()["source"], "acme")

    def test_a_request_file_cannot_carry_the_flag(self):
        key = "portikus_allow_internal_ca_on_public_address"
        self.resolver.addresses = ["203.0.113.7"]
        for request in ({"kind": "apply", "settings": {"source": "internal", key: True}},
                        {"kind": "apply", "settings": {"source": "internal"}, key: True}):
            with self.subTest(request=request):
                status = self.submit(request, str(cj.uuid.uuid4()))
                self.assertEqual(status["state"], "refused")
                self.assertRegex(status["message"], re.compile("missing or extra fields"))
        self.assertFalse(os.path.exists(self.runner.allow_internal_on_public))

    def test_reset_always_works_on_a_public_name(self):
        self.fake.serve("acme")
        self.submit({"kind": "apply", "settings": base.acme()})
        self.resolver.addresses = ["203.0.113.7"]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.runner.run_reset(io.StringIO()), 0)
        self.assertEqual(self.settings(), {"source": "internal"})
        self.assertEqual(self.status_file()["internalOnPublic"]["addresses"], ["203.0.113.7"])

    def test_reset_works_before_any_state_exists(self):
        self.empty_state()
        self.resolver.addresses = ["203.0.113.7"]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.runner.run_reset(io.StringIO()), 0)
        self.assertEqual(self.settings(), {"source": "internal"})

    def test_the_hourly_check_reports_the_internal_authority_on_a_public_name(self):
        self.resolver.addresses = ["198.51.100.4", "10.0.0.2"]
        self.allow()
        self.runner.run_check()
        found = self.status_file()["internalOnPublic"]
        self.assertEqual(found["addresses"], ["198.51.100.4"])
        since = os.stat(self.tree.state("settings.json")).st_mtime
        self.assertEqual(found["since"], cj.iso(cj.datetime.datetime.fromtimestamp(since, cj.datetime.timezone.utc)))
        # The name moves to a private address, or stops resolving: no report.
        for addresses in (["10.0.0.2"], [], ["127.0.1.1"]):
            self.resolver.addresses = addresses
            self.runner.run_check()
            self.assertIsNone(self.status_file()["internalOnPublic"], addresses)


class Settings(unittest.TestCase):
    def test_setup_writes_the_file_the_job_reads(self):
        defaults = (REPO / "infra" / "ansible" / "roles" / "caddy" / "defaults" / "main.yml").read_text()
        self.assertIn(f"caddy_allow_internal_on_public_file: {cj.ALLOW_INTERNAL_ON_PUBLIC}\n", defaults)
        site = (REPO / "infra" / "ansible" / "site.yml").read_text()
        self.assertIn("    portikus_allow_internal_ca_on_public_address: false\n", site)


if __name__ == "__main__":
    unittest.main()
