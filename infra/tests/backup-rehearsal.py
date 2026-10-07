#!/usr/bin/python3
"""Backups on an apt-installed server, rehearsed (docs/adr/0044-backups-on-the-server.md).

Runs as root on the rehearsal VM, one step per call, for install-test.sh.
The administrator's session jar is the one install-test.sh's first sign-in
left in /root/portikus-install-test/jar.  Steps:

  seed           a student with a workspace whose home holds a marker file
                 and a folder of chosen owners and modes, and a Dex account;
                 prints what must come back, as JSON
  backup-now     Back up now through the admin API; prints the new set
  download-key   the key through the admin API, checked, into a root-only
                 file; the key must appear in no log
  upload-key     that file through the admin API onto a server with its own
                 key: refused without consent, then replaced
  wait-set STAMP the Backups tab lists a set copied in by hand, as verified
                 (with --unverified, as not verified)
  side-copy      restore the set into a side copy in the running workspace
                 (ADR 0040): the marker and the folder's modes come back,
                 owned by the student
  replace-home   change the live home, then Replace home from that side
                 copy: owners, modes and the marker are as seeded again
  check-restored after `portikus restore`: sign in with the old password and
                 second factor, and the student, the Dex account, the
                 workspace, the marker and the folder's owners and modes are
                 all back

Never run it on a host with real users: it makes a throwaway student.
"""

import argparse
import glob
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
HOME_DIR = "/home/student"
STUDENT_UID = "1000"
# Made in the student's home by seed; each restore mode must bring it back
# with these modes.  Every entry but root-owned.txt is the student's.
TREE_SCRIPT = """set -e
umask 022
rm -rf modes
mkdir modes
cd modes
printf 'private\\n' >private.txt && chmod 0600 private.txt
printf 'shared\\n' >shared.txt && chmod 0664 shared.txt
printf '#!/bin/sh\\necho hi\\n' >run.sh && chmod 0755 run.sh
mkdir group-dir && printf 'g\\n' >group-dir/note.txt && chmod 0640 group-dir/note.txt && chmod 2775 group-dir
mkdir readonly && printf 'ro\\n' >readonly/inside.txt && chmod 0444 readonly/inside.txt && chmod 0555 readonly
ln -s private.txt link
cd .. && chmod 0750 modes
"""

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


def student_api(host, student):
    """A one-hour session for the student, minted in the database, and its jar."""
    token = secrets.token_urlsafe(32)
    psql(f"INSERT INTO sessions (id, user_id, expires_at) VALUES "
         f"('{hashlib.sha256(token.encode()).hexdigest()}', '{student}', now() + interval '1 hour')")
    jar = f"{DIR}/student.jar"
    with open(jar, "w") as f:
        f.write(f"#HttpOnly_{host}\tFALSE\t/\tTRUE\t0\t{COOKIE}\t{token}\n")
    os.chmod(jar, 0o600)
    return Api(host, jar)


def in_workspace(instance, script, as_student=True):
    """Run a shell script in the workspace's home, as the student or as its root."""
    user = ["--user", STUDENT_UID, "--group", STUDENT_UID] if as_student else []
    return sh("incus", "exec", instance, "--project", PROJECT, *user, "--cwd", HOME_DIR,
              "--env", f"HOME={HOME_DIR}", "--", "sh", "-c", script)


def start_workspace(as_student, workspace):
    """Start the workspace and wait until it runs; the restore modes need it up."""
    code, _ = as_student.call("POST", f"/workspaces/{workspace}/start")
    must("the student starts the workspace", code in (200, 202), str(code))
    deadline = time.time() + 300
    state = None
    while time.time() < deadline:
        code, view = as_student.call("GET", f"/workspaces/{workspace}")
        state = view.get("state") if code == 200 else code
        if state == "running":
            break
        time.sleep(3)
    must("the workspace runs", state == "running", str(state))
    # Held up for the rest of the rehearsal, so no idle stop lands mid-restore.
    until = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3 * 3600))
    as_student.call("PUT", f"/workspaces/{workspace}/keep-running", {"until": until})


def tree(instance, root):
    """Each entry of the seeded folder and the marker under ROOT, as
    path -> [uid, gid, mode, type, link target or sha256]."""
    listing = in_workspace(instance, f"cd {root} && find modes restore-marker.txt "
                           "-printf '%p\\t%U\\t%G\\t%m\\t%y\\t%l\\n'", as_student=False)
    sums = in_workspace(instance, f"cd {root} && find modes restore-marker.txt -type f -exec sha256sum {{}} +",
                        as_student=False)
    digest = {path: value for value, path in (line.split("  ", 1) for line in sums.splitlines())}
    entries = {}
    for line in listing.splitlines():
        path, uid, gid, mode, kind, target = line.split("\t")
        entries[path] = [uid, gid, mode, kind, target if kind == "l" else digest.get(path, "")]
    return entries


def same_tree(label, got, want, owner=None):
    """Compare two trees; with OWNER, every entry must be owned by it rather than as seeded."""
    if owner is not None:
        want = {path: [owner, owner, *rest] for path, (_, _, *rest) in want.items()}
    wrong = sorted(set(got) ^ set(want)) + sorted(p for p in set(got) & set(want) if got[p] != want[p])
    check(label, not wrong, "; ".join(f"{p}: got {got.get(p)}, want {want.get(p)}" for p in wrong[:6]))


def seed(args):
    api = Api(args.public_host)
    subject = f"backup-rehearsal-{secrets.token_hex(3)}"
    student = psql(
        "INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role, "
        "acceptable_use_version, acceptable_use_accepted_at) VALUES "
        f"('{ISSUER}', '{subject}', 'Restore Student', 'restorestudent', 'student', "
        "(SELECT COALESCE((SELECT acceptable_use_version FROM settings WHERE id = 1), 1)), now()) RETURNING id")
    as_student = student_api(args.public_host, student)
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

    start_workspace(as_student, ws["id"])
    in_workspace(instance, TREE_SCRIPT)
    in_workspace(instance, "printf 'root\\n' >modes/root-owned.txt && chmod 0640 modes/root-owned.txt",
                 as_student=False)
    seeded = tree(instance, HOME_DIR)
    must("the seeded folder holds a root-owned file beside the student's",
         seeded.get("modes/root-owned.txt", [])[:2] == ["0", "0"]
         and seeded.get("modes/private.txt", [])[:3] == [STUDENT_UID, STUDENT_UID, "600"],
         json.dumps(seeded))

    code, made = api.call("POST", "/admin/dex-users", {
        "name": "Restore Check", "email": DEX_EMAIL, "username": "restorecheck", "role": "student"})
    must("the administrator makes a Dex account", code in (200, 201), f"{code} {made}")
    print(json.dumps({"student": student, "subject": subject, "workspace": ws["id"],
                      "instance": instance, "marker": hashlib.sha256(marker.encode()).hexdigest(),
                      "tree": seeded}))


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
    mine = wait_request(api, request["id"], "Back up now completes")
    stamp = (mine.get("result") or {}).get("stamp")
    new = [s for s in api.backups()["host"]["sets"] if s["stamp"] == stamp]
    must("the set it made is listed, complete", len(new) == 1 and new[0]["complete"], f"{stamp} {json.dumps(new)}")
    print(stamp)


def wait_request(api, request_id, label, timeout=1800):
    """Wait for a request on the Backups tab to finish; stops unless it is done."""
    deadline = time.time() + timeout
    mine = None
    while time.time() < deadline:
        mine = next((r for r in api.backups()["requests"] if r["id"] == request_id), None)
        if mine and mine["state"] in ("done", "failed"):
            break
        time.sleep(10)
    must(label, mine is not None and mine["state"] == "done", json.dumps(mine))
    return mine


def side_copy(args):
    expect = json.load(open(args.expect))
    api = Api(args.public_host)
    start_workspace(student_api(args.public_host, expect["student"]), expect["workspace"])
    code, request = api.call("POST", "/admin/backups/restores",
                             {"stamp": args.stamp, "workspaceId": expect["workspace"]})
    must("a side copy is accepted", code == 202, f"{code} {request}")
    wait_request(api, request["id"], "the side copy completes")
    folder = psql(f"SELECT args->>'dir' FROM backup_requests WHERE id = '{request['id']}'")
    got = tree(expect["instance"], f"{HOME_DIR}/{folder}")
    check("the marker is in the copy, byte for byte",
          got.get("restore-marker.txt", [""])[-1] == expect["marker"], json.dumps(got.get("restore-marker.txt")))
    # The student's own account writes the copy (ADR 0040), so it owns every entry.
    same_tree(f"~/{folder} keeps every mode and content, owned by the student",
              got, expect["tree"], owner=STUDENT_UID)


def replace_home(args):
    expect = json.load(open(args.expect))
    api = Api(args.public_host)
    instance, workspace = expect["instance"], expect["workspace"]
    start_workspace(student_api(args.public_host, expect["student"]), workspace)
    # Changed after the backup, so only the replace can put them back.
    in_workspace(instance, "chmod 0644 modes/private.txt && chown 1000:1000 modes/root-owned.txt "
                 "&& rm modes/shared.txt && printf 'changed\\n' >restore-marker.txt", as_student=False)
    copy = psql("SELECT id || ' ' || (args->>'dir') FROM backup_requests WHERE kind = 'restore_copy' "
                f"AND state = 'done' AND workspace_id = '{workspace}' ORDER BY finished_at DESC LIMIT 1")
    must("a finished side copy to replace from", copy != "", copy)
    copy_id, folder = copy.split(" ")
    code, data = api.call("POST", f"/admin/backups/restores/{copy_id}/replace-home")
    must("Replace home is accepted", code == 202, f"{code} {data}")
    deadline = time.time() + 1800
    row = ""
    while time.time() < deadline:
        row, desired = psql("SELECT coalesce(pending_operation, '-') || ' ' || state || ' ' || coalesce(error_code, '-') "
                            f"|| '|' || desired_state FROM workspaces WHERE id = '{workspace}'").split("|")
        # The replace ends stopped; the next sweep starts it if it should run (ADR 0021).
        restarting = row == "- stopped -" and desired in ("running", "restarting")
        if row.startswith("- ") and not row.startswith(("- stopping", "- starting")) and not restarting:
            break
        time.sleep(10)
    must("Replace home finishes with the workspace running again", row == "- running -", row)
    got = tree(instance, HOME_DIR)
    same_tree("the replaced home has every owner, mode and content as seeded", got, expect["tree"])
    check("the side copy made after the set is gone with the old home",
          in_workspace(instance, f"test -e {folder} && echo kept || echo gone", as_student=False).strip() == "gone")
    volumes = sh("incus", "storage", "volume", "list", POOL, "--project", PROJECT, "--format", "csv", "--columns", "n")
    check("the old home is kept beside it", f"{instance}-home-replaced-" in volumes)


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
    own = status["recipient"]
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
    check("an upload is not a download: the reminder stays", not data["key"]["downloaded"], json.dumps(data["key"]))
    kept = glob.glob("/etc/portikus-backup/age-key.txt.replaced-*")
    must("the replaced key is kept beside it", len(kept) == 1, str(kept))
    st = os.stat(kept[0])
    check("root-only", st.st_uid == 0 and oct(st.st_mode & 0o777) == "0o600")
    check("and it is the key this server made", sh("age-keygen", "-y", kept[0]).strip() == own)
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
    if args.unverified:
        check("and as not verified: no MAC shows this key made it", listed.get("verified") is False, json.dumps(listed))
    else:
        check("and as verified: its MAC shows this key made it", listed.get("verified") is True, json.dumps(listed))


def signin(host, password_file):
    """The local administrator's Dex sign-in, as install-test.sh does it; returns a jar."""
    jar = f"{DIR}/restored.jar"
    if os.path.exists(jar):
        os.unlink(jar)
    base = f"https://{host}"
    c = ["curl", "-s", "--cacert", CA, "-c", jar, "-b", jar]
    page = sh(*c, "-L", "-o", "/dev/null", "-w", "%{url_effective}", f"{base}/auth/login")
    page = sh(*c, "-L", "-o", "/dev/null", "-w", "%{url_effective}", page.replace("/dex/auth?", "/dex/auth/local?"))
    sh(*c, "-L", "-o", "/dev/null", "-H", f"Origin: {base}", "--data-urlencode", f"login=admin@{host}",
       "--data-urlencode", f"password@{password_file}", page)
    return jar


def check_restored(args):
    expect = json.load(open(args.expect))
    jar = signin(args.public_host, args.password_file)
    api = Api(args.public_host, jar)
    code, me = api.call("GET", "/auth/me")
    check("the old administrator password signs in again (Dex's accounts came back)",
          code == 200 and me.get("role") == "administrator", f"{code} {me}")
    # totp.py sits beside this script on the VM (install-test.sh copies both to /tmp).
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import totp
    with open(args.totp_file) as f:
        code, _ = api.call("POST", "/me/second-factor/verify", {"code": totp.code(f.read())})
    check("the old second factor is back and passes", code == 204, str(code))
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
    start_workspace(student_api(args.public_host, expect["student"]), expect["workspace"])
    same_tree("the restored home has every owner, mode and content as seeded",
              tree(expect["instance"], HOME_DIR), expect["tree"])


def main():
    steps = {"seed": seed, "backup-now": backup_now, "download-key": download_key, "upload-key": upload_key,
             "wait-set": wait_set, "side-copy": side_copy, "replace-home": replace_home,
             "check-restored": check_restored}
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=list(steps))
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--stamp")
    parser.add_argument("--expect")
    parser.add_argument("--password-file")
    parser.add_argument("--totp-file", help="check-restored: the old administrator's second-factor secret")
    parser.add_argument("--unverified", action="store_true", help="wait-set: expect the set not verified")
    args = parser.parse_args()
    steps[args.step](args)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
