#!/usr/bin/python3
"""The workspace image job rehearsal (docs/EPIC-15.md task T6, ADR 0030).

Runs as root on a rehearsal VM that install-test.sh has just installed,
with the administrator's session jar that its first sign-in left in
/root/portikus-install-test/jar, and the image releases install-test.sh
serves (portikus_image_base_url and portikus_image_releases_url in
/etc/portikus/portikus.yaml).  It drives the job through the admin API, as
the Workspace image page does, and writes request files by hand only where
the point is that the root job refuses them.  The steps:

   1. the served releases: releases.json and the image setup installed,
      through the fetch and activate jobs setup ran itself;
   2. fetch the newest published image, and a second request is refused
      while it runs;
   3. a tampered download is refused: a SHA256SUMS changed after signing,
      and a file that does not match its signed checksum;
   4. build with Node 26 and Python 3.14 from uv;
   5. a broken recipe (Codex removed) fails its health check, and the image
      cannot be made the default, by the API or by a hand-written request;
   6. make default;
   7. a new workspace gets the new image, an old one keeps its image until
      it is rebuilt;
   8. roll back;
   9. bad hand-written requests are refused;
  10. with the path unit stopped a request waits; a job stopped mid-run is
      marked failed, and a retry succeeds;
  11. pruning keeps the default, the previous and the two newest candidates.

Never run it on a host with real users: it makes throwaway students,
rewrites the shipped recipe for one build and puts it back.
"""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid

JAR = "/root/portikus-install-test/jar"
JOBS = "/var/lib/portikus/image-jobs"
IMAGES = "/var/lib/portikus/images"
RECIPE = "/usr/share/portikus/workspace-image/portikus.yaml"
CA = "/etc/portikus/caddy-root.crt"
ISSUER = "urn:portikus:image-rehearsal"
COOKIE = "__Host-portikus_session"

results = []


class Stop(Exception):
    """A check that later steps depend on failed."""


def check(label, ok, detail="", stop=False):
    results.append((label, bool(ok)))
    mark = "PASS" if ok else "FAIL"
    print(f"{mark}  {label}" + (f" ({detail})" if detail and not ok else ""), flush=True)
    if stop and not ok:
        raise Stop(label)
    return bool(ok)


def heading(text):
    print(f"\n--- {text} ---", flush=True)


def sh(*argv, check_rc=True):
    done = subprocess.run(argv, capture_output=True, text=True)
    if check_rc and done.returncode != 0:
        raise RuntimeError(f"{argv[0]} exited {done.returncode}: {done.stderr.strip()[:300]}")
    return done.stdout


class Api:
    def __init__(self, host):
        self.base = f"https://{host}"

    def call(self, method, path, body=None, jar=JAR):
        argv = ["curl", "-s", "--cacert", CA, "-b", jar, "-X", method,
                "-w", "\n%{http_code}", f"{self.base}{path}"]
        if method != "GET":
            argv += ["-H", f"Origin: {self.base}"]
        if body is not None:
            argv += ["-H", "Content-Type: application/json", "--data-binary", json.dumps(body)]
        out = sh(*argv)
        text, _, code = out.rpartition("\n")
        try:
            data = json.loads(text) if text.strip() else None
        except ValueError:
            data = text
        return int(code), data

    def image(self):
        code, data = self.call("GET", "/admin/image")
        if code != 200:
            raise RuntimeError(f"GET /admin/image returned {code}: {data}")
        return data

    def job(self, body):
        return self.call("POST", "/admin/image/jobs", body)

    def wait(self, job_id, timeout, until=("succeeded", "failed", "refused")):
        deadline = time.time() + timeout
        view = None
        while time.time() < deadline:
            code, data = self.call("GET", f"/admin/image/jobs/{job_id}")
            if code == 200:
                view = data["job"]
                if view["state"] in until:
                    return view, data.get("log", [])
            time.sleep(5)
        raise RuntimeError(f"job {job_id} did not reach {until} in {timeout} s (last: {view})")


def run_job(api, body, timeout=1800):
    """Ask for a job and wait for it; returns the finished view."""
    code, data = api.job(body)
    if code != 202:
        raise RuntimeError(f"POST /admin/image/jobs {body} returned {code}: {data}")
    view, log = api.wait(data["id"], timeout)
    print(f"      job {body} -> {view['state']}: {view.get('message') or view.get('step')}", flush=True)
    if view["state"] != "succeeded":
        print("      " + "\n      ".join(log[-15:]), flush=True)
    return view


def aliases():
    out = sh("incus", "--project", "portikus", "image", "alias", "list", "--format", "json")
    return {a["name"]: a["target"] for a in json.loads(out)}


def fingerprint(version):
    manifest = json.load(open(os.path.join(IMAGES, version, "manifest.json")))
    return manifest["fingerprint"]


def health(version):
    try:
        return json.load(open(os.path.join(IMAGES, version, "health.json")))
    except (OSError, ValueError):
        return None


def roles_file():
    return json.load(open(os.path.join(IMAGES, "aliases.json")))


def hand_request(request, file_id=None, raw=None):
    """Write a request file as the API would, but with any content."""
    file_id = file_id or str(uuid.uuid4())
    body = raw if raw is not None else json.dumps({
        "id": file_id,
        "requestedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "requestedBy": str(uuid.uuid4()),
        "request": request,
    })
    temp = os.path.join(JOBS, f".request-{file_id}.tmp")
    with open(temp, "w") as f:
        f.write(body)
    os.chown(temp, 0, os.stat(JOBS).st_gid)
    os.rename(temp, os.path.join(JOBS, f"request-{file_id}.json"))
    return file_id


def hand_status(file_id, timeout=120):
    path = os.path.join(JOBS, file_id, "status.json")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status = json.load(open(path))
            if status["state"] != "running":
                return status
        except (OSError, ValueError):
            pass
        time.sleep(2)
    return None


def setup_jobs():
    """The jobs that ran before the rehearsal, oldest first: setup's own first install."""
    jobs = []
    for name in os.listdir(JOBS):
        try:
            uuid.UUID(name)
            jobs.append(json.load(open(os.path.join(JOBS, name, "status.json"))) | {"id": name})
        except (ValueError, OSError):
            continue
    return sorted(jobs, key=lambda j: j.get("startedAt") or "")


def mint_student(host, name):
    """A student row and a one-hour session, with its cookie jar; as the smoke test does."""
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    subject = f"image-rehearsal-{name}-{secrets.token_hex(3)}"
    sql = (
        "WITH u AS (INSERT INTO users (oidc_issuer, oidc_subject, display_name, preferred_username, role, "
        "acceptable_use_version, acceptable_use_accepted_at) VALUES "
        f"('{ISSUER}', '{subject}', '{name}', '{name}', 'student', "
        "(SELECT COALESCE((SELECT acceptable_use_version FROM settings WHERE id = 1), 1)), now()) RETURNING id), "
        f"s AS (INSERT INTO sessions (id, user_id, expires_at) SELECT '{token_hash}', id, now() + interval '1 hour' FROM u) "
        "SELECT id FROM u"
    )
    done = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-X", "-q", "-t", "-A",
                           "-v", "ON_ERROR_STOP=1", "-d", "portikus"],
                          input=sql, capture_output=True, text=True, check=True)
    jar = f"/root/portikus-install-test/{name}.jar"
    with open(jar, "w") as f:
        f.write(f"#HttpOnly_{host}\tFALSE\t/\tTRUE\t0\t{COOKIE}\t{token}\n")
    os.chmod(jar, 0o600)
    return done.stdout.strip(), jar


def workspace(api, jar, ws_id=None, timeout=300, want=("stopped", "running")):
    if ws_id is None:
        code, data = api.call("POST", "/workspaces", jar=jar)
        if code not in (200, 201, 202):
            raise RuntimeError(f"POST /workspaces returned {code}: {data}")
        ws_id = data["id"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, data = api.call("GET", f"/workspaces/{ws_id}", jar=jar)
        if code == 200 and data["state"] in want and not data.get("pendingOperation") and data.get("imageVersion"):
            return data
        time.sleep(3)
    raise RuntimeError(f"workspace {ws_id} did not settle in {timeout} s")


def base_image(instance):
    return sh("incus", "--project", "portikus", "config", "get", instance, "volatile.base_image").strip()


def steps(args):
    api = Api(args.public_host)
    first = args.recipe_version

    heading("1. The served releases")
    view = api.image()
    check(f"setup made {first} the default", view["default"] == first, view["default"])
    check("the image store has the default's manifest", os.path.exists(os.path.join(IMAGES, first, "manifest.json")))
    check("portikus-image-job.path is active",
          sh("systemctl", "is-active", "portikus-image-job.path", check_rc=False).strip() == "active")
    before = setup_jobs()
    shape = [(j.get("kind"), j.get("version"), j.get("state")) for j in before]
    check(f"setup ran two jobs, a fetch then an activate of {first}, and both succeeded",
          shape == [("fetch", first, "succeeded"), ("activate", first, "succeeded")], shape)
    for job in before:
        code, data = api.call("GET", f"/admin/image/jobs/{job['id']}")
        check(f"the admin API shows setup's {job.get('kind')} job as succeeded",
              code == 200 and data["job"]["state"] == "succeeded", f"{code} {data}")
    current = view.get("job") or {}
    check("the page's current job is setup's activate",
          bool(before) and current.get("id") == before[-1]["id"] and current.get("state") == "succeeded", current)

    heading("2. Fetch the newest published image")
    code, data = api.job({"kind": "fetch"})
    check("POST fetch returns 202", code == 202, f"{code} {data}")
    busy, busy_body = api.job({"kind": "fetch", "version": "2026.09.16"})
    check("a second request while one waits or runs is refused (409)", busy == 409, f"{busy} {busy_body}")
    fetched, _ = api.wait(data["id"], 1800)
    print(f"      fetch -> {fetched['state']} {fetched['version']}: {fetched.get('message') or ''}")
    check("the fetch succeeded", fetched["state"] == "succeeded", fetched.get("message"), stop=True)
    check("it took the newest in releases.json, 2026.09.13", fetched["version"] == "2026.09.13", fetched["version"])
    check("2026.09.13 passed its health check", (health("2026.09.13") or {}).get("result") == "passed")
    check("the fetch did not change the default", api.image()["default"] == first)

    heading("3. A tampered download is refused")
    for version, why in (("2026.09.14", "signature"), ("2026.09.15", "checksum")):
        before = set(aliases())
        job = run_job(api, {"kind": "fetch", "version": version})
        check(f"{version} ({why} tampered) fails", job["state"] == "failed", job["state"])
        check(f"{version}'s message names the {why}", why in (job.get("message") or ""), job.get("message"))
        check(f"nothing was imported for {version}",
              f"portikus-{version}" not in aliases() and set(aliases()) == before)
        check(f"no work directory is left for {version}",
              not [n for n in os.listdir(IMAGES) if n.startswith(".work-")])

    # A workspace on the old default, before any default changes.
    student_a = mint_student(args.public_host, "imgrehearsala")
    ws_a = workspace(api, student_a[1])
    old_fp = fingerprint(first)
    check("workspace A starts on the setup image", ws_a["imageVersion"] == old_fp, ws_a["imageVersion"])

    heading("4. Build with Node 26 and Python 3.14 from uv")
    built = run_job(api, {"kind": "build", "node": "26", "python": "uv-3.14"}, timeout=150 * 60)
    check("the build succeeded", built["state"] == "succeeded", built.get("message"), stop=True)
    local = built["version"]
    manifest = json.load(open(os.path.join(IMAGES, local, "manifest.json")))
    check(f"its version is local ({local})", "-local." in (local or ""))
    check("the manifest says Node 26", (manifest["tools"].get("node") or "").startswith("v26."), manifest["tools"].get("node"))
    check("the manifest records the build choices",
          manifest["parameters"] == {"node": "26", "python": "uv-3.14"} and manifest["source"] == "local")
    names = [c["name"] for c in (health(local) or {}).get("checks", [])]
    check("its health check passed, python3.14 included",
          (health(local) or {}).get("result") == "passed" and "python3.14 --version" in names, names)
    code, diff = api.call("GET", f"/admin/image/diff?from={first}&to={local}")
    check("the admin diff against the default answers", code == 200 and isinstance(diff, dict), code)

    heading("5. A broken recipe fails its health check and cannot become the default")
    saved = RECIPE + ".rehearsal-saved"
    shutil.copy2(RECIPE, saved)
    try:
        text = open(RECIPE).read()
        cut = text.replace(' \\\n      "@openai/codex@${codex_version}"', "")
        check("the recipe was stripped of Codex", cut != text)
        with open(RECIPE, "w") as f:
            f.write(cut)
        broken = run_job(api, {"kind": "build", "node": "24", "python": "debian"}, timeout=150 * 60)
    finally:
        shutil.move(saved, RECIPE)
    bad = broken["version"]
    check("the broken build fails", broken["state"] == "failed" and bool(bad), broken["state"], stop=True)
    check("its message is the health check", "health check failed" in (broken.get("message") or ""), broken.get("message"))
    failed = [c["name"] for c in (health(bad) or {}).get("checks", []) if not c["ok"]]
    check("the failed check is codex", failed == ["codex --version"], failed)
    code, data = api.job({"kind": "activate", "version": bad})
    check("the API refuses to make it the default (409 IMAGE_NOT_HEALTHY)",
          code == 409 and "IMAGE_NOT_HEALTHY" in json.dumps(data), f"{code} {data}")
    status = hand_status(hand_request({"kind": "activate", "version": bad}))
    check("the root job refuses a hand-written activate",
          status is not None and status["state"] == "refused" and "health check" in (status.get("message") or ""), status)
    check("the default did not move", api.image()["default"] == first)
    check("the shipped recipe is back", open(RECIPE).read() == text)

    heading("6. Make default")
    job = run_job(api, {"kind": "activate", "version": local})
    roles = roles_file()
    check("activate succeeded", job["state"] == "succeeded", job.get("message"), stop=True)
    check(f"{local} is the default, {first} the previous",
          roles == {"default": local, "previous": first}, roles)
    check("the portikus alias points at it", aliases().get("portikus") == fingerprint(local))

    heading("7. New and old workspaces")
    student_b = mint_student(args.public_host, "imgrehearsalb")
    ws_b = workspace(api, student_b[1])
    new_fp = fingerprint(local)
    check("a new workspace gets the new image", ws_b["imageVersion"] == new_fp, ws_b["imageVersion"])
    check("Incus agrees for the new workspace", base_image(ws_b["incusInstanceName"]) == new_fp)
    ws_a = workspace(api, student_a[1], ws_a["id"])
    check("the old workspace keeps its image", ws_a["imageVersion"] == old_fp, ws_a["imageVersion"])
    check("Incus agrees for the old workspace", base_image(ws_a["incusInstanceName"]) == old_fp)
    code, data = api.call("POST", f"/admin/workspaces/{ws_a['id']}/rebuild", {"resetDocker": False})
    check("rebuild of the old workspace is accepted (202)", code == 202, f"{code} {data}")
    deadline = time.time() + 600
    while time.time() < deadline:
        ws_a = workspace(api, student_a[1], ws_a["id"], timeout=600)
        if ws_a["imageVersion"] == new_fp:
            break
        time.sleep(5)
    check("after the rebuild the old workspace is on the new image", ws_a["imageVersion"] == new_fp, ws_a["imageVersion"])
    check("Incus agrees after the rebuild", base_image(ws_a["incusInstanceName"]) == new_fp)

    heading("8. Roll back")
    job = run_job(api, {"kind": "rollback"})
    roles = roles_file()
    check("rollback succeeded", job["state"] == "succeeded", job.get("message"), stop=True)
    check(f"{first} is the default again, {local} the previous",
          roles == {"default": first, "previous": local}, roles)
    check("the portikus alias points back", aliases().get("portikus") == old_fp)
    check("the rebuilt workspace keeps its image", workspace(api, student_a[1], ws_a["id"])["imageVersion"] == new_fp)

    heading("9. Bad hand-written requests are refused")
    cases = [
        ("an unknown kind", {"kind": "reboot"}, None),
        ("a Node choice off the list", {"kind": "build", "node": "18", "python": "debian"}, None),
        ("a Python choice off the list", {"kind": "build", "node": "24", "python": "3.12"}, None),
        ("a version with shell in it", {"kind": "fetch", "version": "2026.09.13; touch /tmp/pwned"}, None),
        ("a malformed version", {"kind": "activate", "version": "latest"}, None),
        ("an extra field", {"kind": "rollback", "command": "id"}, None),
        ("a file that is not JSON", None, "{not json"),
    ]
    for label, request, raw in cases:
        file_id = hand_request(request, raw=raw)
        status = hand_status(file_id)
        check(f"{label} is refused", status is not None and status["state"] == "refused", status)
    mismatched = str(uuid.uuid4())
    status = hand_status(hand_request({"kind": "rollback"}, file_id=mismatched,
                                      raw=json.dumps({"id": str(uuid.uuid4()), "requestedAt": "2026-09-28T00:00:00.000Z",
                                                      "requestedBy": str(uuid.uuid4()), "request": {"kind": "rollback"}})))
    check("an id that does not match its file name is refused", status is not None and status["state"] == "refused", status)
    hand_request({"kind": "rollback"}, file_id="not-a-uuid")
    time.sleep(10)
    check("a request whose name is not a job id is dropped, with no job directory",
          not os.path.exists(os.path.join(JOBS, "request-not-a-uuid.json")) and not os.path.exists(os.path.join(JOBS, "not-a-uuid")))
    check("nothing ran for them: /tmp/pwned does not exist", not os.path.exists("/tmp/pwned"))
    check("the burst of requests left the path unit active",
          sh("systemctl", "is-active", "portikus-image-job.path", check_rc=False).strip() == "active")
    check("the default did not move", roles_file() == {"default": first, "previous": local})
    current = api.image()["job"]
    check("the page's current job is a refused one it can show", current is not None and current["state"] == "refused", current)

    heading("10. The path unit stopped, and a job stopped mid-run")
    sh("systemctl", "stop", "portikus-image-job.path")
    try:
        code, data = api.job({"kind": "fetch", "version": "2026.09.16"})
        check("with the path unit stopped the API still takes a request (202)", code == 202, f"{code} {data}")
        time.sleep(20)
        code, waiting = api.call("GET", f"/admin/image/jobs/{data['id']}")
        check("the request waits as queued while the path unit is stopped",
              code == 200 and waiting["job"]["state"] == "queued", waiting)
    finally:
        sh("systemctl", "start", "portikus-image-job.path")
    view, _ = api.wait(data["id"], 1800)
    check("started again, the path unit runs the waiting fetch", view["state"] == "succeeded", view)

    code, data = api.job({"kind": "fetch", "version": "2026.09.17"})
    check("fetch 2026.09.17 is accepted", code == 202, f"{code} {data}", stop=True)
    api.wait(data["id"], 300, until=("running",))
    time.sleep(3)
    sh("systemctl", "stop", "portikus-image-job.service")
    view, _ = api.wait(data["id"], 120)
    check("a job stopped mid-run is marked failed",
          view["state"] == "failed" and "stopped before it finished" in (view.get("message") or ""), view)
    check("no work directory is left after the stop",
          not [n for n in os.listdir(IMAGES) if n.startswith(".work-")])
    retry = run_job(api, {"kind": "fetch", "version": "2026.09.17"})
    check("a retry of the stopped fetch succeeds", retry["state"] == "succeeded", retry.get("message"))

    heading("11. Prune")
    known = {n[len("portikus-"):] for n in aliases() if n.startswith("portikus-") and n != "portikus-previous"}
    on_disk = {n for n in os.listdir(IMAGES) if n[:1].isdigit()}
    print(f"      images now: {sorted(known)}; store: {sorted(on_disk)}")
    keep = {first, local, "2026.09.13", "2026.09.16", "2026.09.17"}
    check(f"the broken build {bad} was pruned from Incus", bad not in known)
    check("and from the image store", bad not in on_disk)
    check("the default, the previous, the two newest candidates and the new one are kept",
          known == keep and on_disk == keep, sorted(known))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--recipe-version", required=True)
    args = parser.parse_args()
    try:
        steps(args)
    except Stop as err:
        print(f"\nStopped: {err} failed, and later steps depend on it.")
    except RuntimeError as err:
        check(f"no step stops on an error ({err})", False)
    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    print(f"\n--- Image rehearsal: {passed} passed, {failed} failed ---")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
