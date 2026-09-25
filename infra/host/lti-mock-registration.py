#!/usr/bin/env python3
"""Add or remove the mock LMS registration in the LTI platforms file.

Used by `make lti-mock-register` and `make lti-mock-unregister`
(docs/archive/epics/EPIC-13.md, ruling 26).  Other registrations are left as they are.
Removing the last registration deletes the file, which turns LTI off.
"""
import argparse
import json
import os
import sys
import tempfile

NAME = "mock-lms"
# Must match packages/mock-lms/src/seed.ts; infra/tests/lti-platforms-test.sh checks it.
CLIENT_ID = "portikus-mock"
DEPLOYMENT_ID = "mock-deployment-1"


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": 1, "platforms": []}
    if data.get("version") != 1 or not isinstance(data.get("platforms"), list):
        sys.exit(f"{path}: not a version 1 LTI platforms file; fix it by hand first")
    return data


def save(path, data):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    # Written beside the target and renamed, so a failed write never leaves half a file.
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".lti-platforms.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["register", "unregister"])
    parser.add_argument("--file", required=True)
    parser.add_argument("--url", help="the mock's base URL as the VM reaches it")
    args = parser.parse_args()

    data = load(args.file)
    others = [p for p in data["platforms"] if p.get("name") != NAME]

    if args.action == "unregister":
        if len(others) == len(data["platforms"]):
            print(f"{args.file}: no {NAME} registration")
        if others:
            save(args.file, {**data, "platforms": others})
        elif os.path.exists(args.file):
            os.remove(args.file)
            print(f"{args.file}: removed; no LMS is registered, so LTI is off")
        return

    if not args.url:
        parser.error("register needs --url")
    mock = {
        "name": NAME,
        "issuer": args.url,
        "clientId": CLIENT_ID,
        "authLoginUrl": f"{args.url}/authorize",
        "keysetUrl": f"{args.url}/.well-known/jwks.json",
        "deploymentIds": [DEPLOYMENT_ID],
        "mock": True,
    }
    save(args.file, {**data, "platforms": others + [mock]})
    print(f"{args.file}: {NAME} registered at {args.url}")


if __name__ == "__main__":
    main()
