#!/usr/bin/python3
"""Backups on an apt-installed server, rehearsed (docs/adr/0044-backups-on-the-server.md).

Runs as root on the rehearsal VM, one step per call, for install-test.sh.
The administrator's session jar is the one install-test.sh's first sign-in
left in /root/portikus-install-test/jar.  Steps:

  seed           a student with a workspace whose home holds a marker file,
                 and a Dex account; prints what must come back, as JSON
  backup-now     Back up now through the admin API; prints the new set
  download-key   the key through the admin API, checked, into a root-only
                 file; the key must appear in no log
  upload-key     that file through the admin API onto a server with its own
                 key: refused without consent, then replaced
  wait-set STAMP the Backups tab lists a set copied in by hand
  check-restored after `portikus restore`: sign in with the old password,
                 and the student, the Dex account, the workspace and the
                 marker are all back

Never run it on a host with real users: it makes a throwaway student.
"""

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time

DIR = "/root/portikus-install-test"
JAR = f"{DIR}/jar"
KEY_FILE = f"{DIR}/backup-key.txt"
CA = "/etc/portikus/caddy-root.crt"
COOKIE = "__Host-portikus_session"
ISSUER = "urn:portikus:backup-rehearsal"
POOL = "workspace-data"
PROJECT = "portikus"
DEX_EMAIL = "restore-check@example.edu"

failures = 0


def check(label, ok, detail=""):
    global failures
    print(("PASS  " if ok else "FAIL  ") + label + (f" ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        failures += 1
    return ok


def must(label, ok, detail=""):
    if not check(label, ok, detail):
        sys.exit(1)


def sh(*argv, stdin=None):
    done = subprocess.run(argv, input=stdin, capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"{argv[0]} exited {done.returncode}: {done.stderr.strip()[:300]}")
    return done.stdout


def psql(sql, db="portikus"):
    return sh("runuser", "-u", "postgres", "--", "psql", "-X", "-q", "-t", "-A",
              "-v", "ON_ERROR_STOP=1", "-d", db, stdin=sql).strip()


class Api:
    def __init__(self, host, jar=JAR):
        self.base = f"https://{host}"
        self.jar = jar

    def call(self, method, path, body=None, headers_file=None, out_file=None):
        argv = ["curl", "-s", "--cacert", CA, "-b", self.jar, "-c", self.jar, "-X", method,
                "-w", "\n%{http_code}", f"{self.base}{path}"]
        if method != "GET":
            argv += ["-H", f"Origin: {self.base}"]
        if headers_file:
            argv += ["-D", headers_file]
        if out_file:
            argv += ["-o", out_file]
        if body is not None:
            argv += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
        out = sh(*argv, stdin=json.dumps(body) if body is not None else None)
        text, _, code = out.rpartition("\n")
        try:
            data = json.loads(text) if text.strip() else None
        except ValueError:
            data = text
        return int(code), data

    def backups(self):
        code, data = self.call("GET", "/admin/backups")
        if code != 200:
            raise RuntimeError(f"GET /admin/backups returned {code}")
        return data


def audit_count(action, result="ok"):
    return int(psql(f"SELECT count(*) FROM audit_events WHERE action = '{action}' AND result = '{result}'"))


def journal_has_key():
    """Whether any line of the whole journal holds an age secret key."""
    done = subprocess.run(["journalctl", "--no-pager", "-o", "cat"], capture_output=True)
    return b"AGE-SECRET-KEY-" in done.stdout


def seed(args):
    api = Api(args.public_host)
    token = secrets.token_urlsafe(32)
    subject = f"backup-rehearsal-{secrets.token_hex(3)}"
    student = psql(
        "WITH u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role, "
        "acceptable_use_version, acceptable_use_accepted_at) VALUES "
        f"('{ISSUER}', '{subject}', 'Restore Student', 'restorestudent', 'student', "
        "(SELECT COALESCE((SELECT acceptable_use_version FROM settings WHERE id = 1), 1)), now()) RETURNING id), "
        f"s AS (INSERT INTO sessions (id, user_id, expires_at) SELECT '{hashlib.sha256(token.encode()).hexdigest()}', "
        "id, now() + interval '1 hour' FROM u) SELECT id FROM u")
    jar = f"{DIR}/student.jar"
    with open(jar, "w") as f:
        f.write(f"#HttpOnly_{args.public_host}\tFALSE\t/\tTRUE\t0\t{COOKIE}\t{token}\n")
    os.chmod(jar, 0o600)
    as_student = Api(args.public_host, jar)
    code, ws = as_student.call("POST", "/workspaces")
    must("the student makes a workspace", code in (200, 201, 202), f"{code} {ws}")
    deadline = time.time() + 300
    while time.time() < deadline:
        code, view = as_student.call("GET", f"/workspaces/{ws['id']}")
        if code == 200 and view["state"] == "stopped" and view.get("incusInstanceName"):
            break
        time.sleep(3)
    instance = psql(f"SELECT incus_instance_name FROM workspaces WHERE id = '{ws['id']}'")
    must("the workspace is provisioned", instance.startswith("ws-"), instance)

    marker = f"restore me {secrets.token_hex(16)}\n"
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        f.write(marker)
    sh("incus", "storage", "volume", "file", "push", f.name, POOL,
       f"{instance}-home/restore-marker.txt", "--project", PROJECT)
    os.unlink(f.name)

    code, made = api.call("POST", "/admin/dex-users", {
        "name": "Restore Check", "email": DEX_EMAIL, "username": "restorecheck", "role": "student"})
    must("the administrator makes a Dex account", code in (200, 201), f"{code} {made}")
    print(json.dumps({"student": student, "subject": subject, "workspace": ws["id"],
                      "instance": instance, "marker": hashlib.sha256(marker.encode()).hexdigest()}))


def backup_now(args):
    api = Api(args.public_host)
    deadline = time.time() + 180
    data = api.backups()
    # The channel reports every 30 seconds, so the nightly run can still show as running for a while.
    while (data["host"] is None or data["hostStale"] or data["host"]["running"]) and time.time() < deadline:
        time.sleep(5)
        data = api.backups()
    must("the server's backup channel reports to the tab, with nothing running",
         data["host"] is not None and not data["hostStale"] and not data["host"]["running"])
    check("the tab shows this server's sets, under local", data["host"]["vm"] == "local", data["host"]["vm"])
    check("the tab says the restore key is installed", data["host"]["keyInstalled"])
    code, request = api.call("POST", "/admin/backups/run")
    must("Back up now is accepted", code == 202, f"{code} {request}")
    deadline = time.time() + 1800
    state = None
    while time.time() < deadline:
        data = api.backups()
        mine = next((r for r in data["requests"] if r["id"] == request["id"]), None)
        state = mine and mine["state"]
        if state in ("done", "failed"):
            break
        time.sleep(10)
    must("Back up now completes", state == "done", f"{state}: {mine and mine['error']}")
    stamp = (mine.get("result") or {}).get("stamp")
    new = [s for s in data["host"]["sets"] if s["stamp"] == stamp]
    must("the set it made is listed, complete", len(new) == 1 and new[0]["complete"], f"{stamp} {json.dumps(new)}")
    print(stamp)


def download_key(args):
    api = Api(args.public_host)
    code, status = api.call("GET", "/admin/backups/key")
    must("the key routes answer on an apt-installed server", code == 200, f"{code} {status}")
    check("setup made a key that has not been downloaded", status["installed"] and not status["downloaded"], json.dumps(status))
    recipients = open("/etc/portikus-backup/recipients.txt").read().strip()
    check("its public half is the recipients file backups use", status["recipient"] == recipients)
    before = audit_count("backup.key_downloaded")
    os.makedirs(DIR, mode=0o700, exist_ok=True)
    headers = f"{DIR}/download-headers"
    old = os.umask(0o077)
    try:
        code, _ = api.call("POST", "/admin/backups/key/download", headers_file=headers, out_file=KEY_FILE)
    finally:
        os.umask(old)
    must("the download answers 200", code == 200, str(code))
    head = open(headers).read().lower()
    check("the download is never cached", "cache-control: no-store" in head)
    check("it downloads as portikus-backup-key.txt",
          'content-disposition: attachment; filename="portikus-backup-key.txt"' in head)
    derived = sh("age-keygen", "-y", KEY_FILE).strip()
    must("the file is the server's key", derived == recipients)
    check("the key file here is root-only", oct(os.stat(KEY_FILE).st_mode & 0o777) == "0o600")
    check("the download is in the audit log", audit_count("backup.key_downloaded") == before + 1)
    code, status = api.call("GET", "/admin/backups/key")
    check("the reminder is gone after the download", code == 200 and status["downloaded"], json.dumps(status))
    check("the key is in no journal line", not journal_has_key())


def upload_key(args):
    api = Api(args.public_host)
    uploaded = sh("age-keygen", "-y", KEY_FILE).strip()
    code, status = api.call("GET", "/admin/backups/key")
    must("the new server has a key of its own", code == 200 and status["installed"], f"{code} {status}")
    check("which is not the old server's", status["recipient"] != uploaded)
    check("and has not been downloaded", not status["downloaded"])
    key = open(KEY_FILE).read()
    code, data = api.call("POST", "/admin/backups/key", {"key": "not a key", "replace": True})
    check("a file that is not a key is refused", code == 400, f"{code} {data}")
    code, data = api.call("POST", "/admin/backups/key", {"key": key, "replace": False})
    check("replacing a different key without consent is refused", code == 409 and data["code"] == "BACKUP_KEY_EXISTS", f"{code} {data}")
    before = audit_count("backup.key_uploaded")
    code, data = api.call("POST", "/admin/backups/key", {"key": key, "replace": True})
    must("with consent the old server's key is installed", code == 200 and data["outcome"] == "installed", f"{code} {data}")
    check("the upload is in the audit log", audit_count("backup.key_uploaded") == before + 1)
    check("the recipients file now names the uploaded key",
          open("/etc/portikus-backup/recipients.txt").read().strip() == uploaded)
    st = os.stat("/etc/portikus-backup/age-key.txt")
    check("the installed key is root-only", st.st_uid == 0 and oct(st.st_mode & 0o777) == "0o600")
    check("and counts as downloaded", data["key"]["downloaded"])
    check("the key is in no journal line", not journal_has_key())


def wait_set(args):
    api = Api(args.public_host)
    deadline = time.time() + 180
    listed = None
    while time.time() < deadline:
        data = api.backups()
        listed = next((s for s in (data["host"] or {}).get("sets", []) if s["stamp"] == args.stamp), None)
        if listed:
            break
        time.sleep(5)
    must("the tab lists the set copied in by hand", listed is not None)
    check("as complete, with the student's workspace", listed["complete"] and len(listed["instances"]) >= 1, json.dumps(listed))


def signin(host, password_file):
    """The local administrator's Dex sign-in, as install-test.sh does it; returns a jar."""
    jar = f"{DIR}/restored.jar"
    if os.path.exists(jar):
        os.unlink(jar)
    base = f"https://{host}"
    c = ["curl", "-s", "--cacert", CA, "-c", jar, "-b", jar]
    page = sh(*c, "-L", "-o", "/dev/null", "-w", "%{url_effective}", f"{base}/auth/login")
    page = sh(*c, "-L", "-o", "/dev/null", "-w", "%{url_effective}", page.replace("/dex/auth?", "/dex/auth/local?"))
    sh(*c, "-L", "-o", "/dev/null", "--data-urlencode", f"login=admin@{host}",
       "--data-urlencode", f"password@{password_file}", page)
    return jar


def check_restored(args):
    expect = json.load(open(args.expect))
    jar = signin(args.public_host, args.password_file)
    api = Api(args.public_host, jar)
    code, me = api.call("GET", "/auth/me")
    check("the old administrator password signs in again (Dex's accounts came back)",
          code == 200 and me.get("role") == "administrator", f"{code} {me}")
    code, users = api.call("GET", "/admin/users")
    check("the Users view answers for the restored administrator", code == 200, str(code))
    check("the student's account is back",
          psql(f"SELECT count(*) FROM users WHERE id = '{expect['student']}' AND oidc_subject = '{expect['subject']}'") == "1")
    check("the Dex account is back, in Portikus and in Dex",
          psql(f"SELECT count(*) FROM users WHERE email = '{DEX_EMAIL}'") == "1"
          and psql(f"SELECT count(*) FROM password WHERE email = '{DEX_EMAIL}'", db="dex") == "1")
    # --start-check started it, and the grace period stops it again later.
    row = psql(f"SELECT incus_instance_name || ' ' || state FROM workspaces WHERE id = '{expect['workspace']}'")
    check("the workspace is back, with its instance", row.split(" ")[0] == expect["instance"], row)
    check("its instance exists again", expect["instance"] in sh("incus", "list", "--project", PROJECT, "--format", "csv", "--columns", "n"))
    pulled = subprocess.run(["incus", "storage", "volume", "file", "pull", POOL,
                             f"{expect['instance']}-home/restore-marker.txt", "-", "--project", PROJECT],
                            capture_output=True)
    check("the marker file in the student's home is back, byte for byte",
          pulled.returncode == 0 and hashlib.sha256(pulled.stdout).hexdigest() == expect["marker"])
    check("no session from before the backup survived",
          psql(f"SELECT count(*) FROM sessions WHERE user_id = '{expect['student']}'") == "0")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=["seed", "backup-now", "download-key", "upload-key", "wait-set", "check-restored"])
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--stamp")
    parser.add_argument("--expect")
    parser.add_argument("--password-file")
    args = parser.parse_args()
    {"seed": seed, "backup-now": backup_now, "download-key": download_key, "upload-key": upload_key,
     "wait-set": wait_set, "check-restored": check_restored}[args.step](args)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
