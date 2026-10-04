"""totp.py against the SHA-1 test vectors of RFC 6238, appendix B."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import totp  # noqa: E402

# The ASCII secret "12345678901234567890", base32-encoded.
SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


class TotpTest(unittest.TestCase):
    def test_rfc_6238_vectors(self):
        # The RFC prints eight digits; the last six are what apps show.
        for now, expected in [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"),
                              (2000000000, "279037"), (20000000000, "353130")]:
            self.assertEqual(totp.code(SECRET, now), expected, now)

    def test_secret_spacing_case_and_padding_do_not_matter(self):
        self.assertEqual(totp.code(" " + SECRET.lower() + "\n", 59), "287082")
        self.assertEqual(totp.code("GEZDGNBVGY3TQOJQ", 59), totp.code("GEZDGNBVGY3TQOJQ====", 59))


if __name__ == "__main__":
    unittest.main()
