"""Which of the host's own addresses answer on each port, for the account running this.

Usage: python3 - PORT... <reach-probe.py, run as the account under test.
The port "own" is a listener this probe opens on every address, so a refusal
there is the firewall's and not a missing listener (SPEC.md 24.9).  Prints
one word per port: "none", "all", or the addresses that answered, comma-joined.
"""

import json
import socket
import subprocess
import sys


def local_addresses():
    found = ["127.0.0.1", "::1"]
    links = json.loads(subprocess.run(["ip", "-j", "addr", "show"], check=True, capture_output=True, text=True).stdout)
    for link in links:
        for addr in link.get("addr_info", []):
            # Link-local addresses need a scope and carry no service.
            if addr.get("scope") == "global" and addr["local"] not in found:
                found.append(addr["local"])
    return found


def answers(address, port):
    try:
        socket.create_connection((address, port), timeout=5).close()
        return True
    except OSError:
        return False


def main(ports):
    own = socket.socket(socket.AF_INET6)
    own.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    own.bind(("::", 0))
    own.listen(64)
    addresses = local_addresses()
    for port in ports:
        number = own.getsockname()[1] if port == "own" else int(port)
        open_on = [a for a in addresses if answers(a, number)]
        print("none" if not open_on else "all" if open_on == addresses else ",".join(open_on))


if __name__ == "__main__":
    main(sys.argv[1:])
