#!/usr/bin/env python3
"""The current two-step sign-in code for a base32 secret, as an authenticator
app shows it (RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps; SPEC.md section
24.13).  The rehearsal scripts sign in as a Dex password account, which must
enrol a second factor and enter a code at each sign-in.

    python3 totp.py <secret-file      prints the code

The secret is read from standard input so it is in no command line.
"""
import base64
import hashlib
import hmac
import struct
import sys
import time


def code(secret, now=None):
    clean = secret.strip().rstrip("=").upper()
    key = base64.b32decode(clean + "=" * (-len(clean) % 8))
    step = int((time.time() if now is None else now) // 30)
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    return "%06d" % ((struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000)


if __name__ == "__main__":
    print(code(sys.stdin.read()))
