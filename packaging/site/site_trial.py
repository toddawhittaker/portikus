"""The trial of an address or sign-in change: snapshot, arm, keep, roll back, expire (SPEC.md section 5.1, ADR 0059).

TrialJobs is a mixin of Runner. A trial writes the new answers, reruns setup and waits for Keep; a
rollback, a failed setup or the transient timer puts the snapshot back. It calls the answer and setup
steps of SettingsJobs and the status updates of site_queue on the same Runner.
"""

import fcntl
import hashlib
import json
import math
import os
import re
import subprocess
import time

from site_common import (
    MAX_FILE_BYTES, JobFailed, RunnerBase, iso_seconds, journal, make_dir, now_iso, open_dir, read_at, read_file,
    remove_at, write_at,
)
from site_settings import SETUP_TIMEOUT
from site_values import UUID_RE, Refused, identity

SITE_JOB = "/usr/lib/portikus/site-job"
TRIAL_UNIT = "portikus-site-trial-"
# In the state directory: the Google key from before a trial that replaces it, or that there was none.
BEFORE_KEY = ("before-google-key.json", "before-google-key.none")
TRIAL_SECONDS = {"address": 15 * 60, "signin": 30 * 60}
# One `key: value` line of secrets.yaml as yaml.safe_dump writes it.
SECRET_VALUE_RE = re.compile(r"[a-z_]+:\s*(.+)", re.ASCII)


def key_secrets(raw):
    """The parts of a service-account key file a log line could show, so setup's log never does."""
    try:
        doc = json.loads(raw)
        lines = [line for line in doc["private_key"].splitlines() if len(line) >= 16 and "-----" not in line]
        return [doc["private_key_id"], *lines]
    except (TypeError, ValueError, KeyError, AttributeError):
        return []


def covers(names, host):
    """True when a certificate's names include host itself or a one-label wildcard over it."""
    host = host.lower()
    for name in names:
        if name == host:
            return True
        if name.startswith("*.") and "." in host and host.split(".", 1)[1] == name[2:]:
            return True
    return False


class TrialJobs(RunnerBase):
    def secret_values(self):
        """Every value secrets.yaml holds, and held before the trial, so setup's log never shows one."""
        found = []
        for path in (self.etc + "/secrets.yaml", self.state_dir + "/before-secrets.yaml"):
            raw = read_file(path) or b""
            for line in raw.decode("utf-8", "replace").splitlines():
                match = SECRET_VALUE_RE.fullmatch(line.strip())
                value = match.group(1).strip().strip("'\"") if match else ""
                if len(value) >= 4:
                    found.append(value)
        for path in (self.dex_key_file, self.state_dir + "/" + BEFORE_KEY[0]):
            raw = read_file(path)
            if raw is not None:
                found += key_secrets(raw)
        # Longest first, so a secret that holds another is hidden whole.
        return sorted(set(found), key=len, reverse=True)

    # -- the open trial --

    def state_fd(self):
        return make_dir(self.state_dir, 0o700)

    def trial_locked(self, wait):
        """The one lock every trial step takes; None when another holds it and wait is false."""
        fd = self.state_fd()
        try:
            fcntl.flock(fd, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return None
        return fd

    def read_trial(self, state_fd):
        raw = read_at(state_fd, "trial.json", MAX_FILE_BYTES)
        if raw is None:
            return None
        try:
            trial = json.loads(raw)
        except ValueError:
            return None
        return trial if isinstance(trial, dict) and UUID_RE.fullmatch(str(trial.get("id"))) else None

    def write_trial(self, state_fd, trial):
        write_at(state_fd, "trial.json", json.dumps(trial) + "\n", 0o600, 0, 0, self.own)

    def snapshot(self, state_fd):
        etc_fd = open_dir(self.etc)
        try:
            for name in ("portikus.yaml", "secrets.yaml"):
                data = read_at(etc_fd, name, MAX_FILE_BYTES)
                remove_at(state_fd, "before-" + name)
                if data is not None:
                    write_at(state_fd, "before-" + name, data, 0o600, 0, 0, self.own)
        finally:
            os.close(etc_fd)

    def snapshot_key(self, state_fd):
        """The Google key a trial is about to replace, or a marker that there was none."""
        for name in BEFORE_KEY:
            remove_at(state_fd, name)
        data = read_file(self.dex_key_file)
        if data is None:
            write_at(state_fd, BEFORE_KEY[1], "", 0o600, 0, 0, self.own)
        else:
            write_at(state_fd, BEFORE_KEY[0], data, 0o600, 0, 0, self.own)

    def install_key(self, key):
        fd = open_dir(os.path.dirname(self.dex_key_file))
        try:
            write_at(fd, os.path.basename(self.dex_key_file), key, 0o640, 0, self.dex_gid(), self.own)
        finally:
            os.close(fd)

    def restore(self, state_fd):
        etc_fd = open_dir(self.etc)
        try:
            for name, mode in (("portikus.yaml", 0o644), ("secrets.yaml", 0o600)):
                data = read_at(state_fd, "before-" + name, MAX_FILE_BYTES)
                if data is not None:
                    write_at(etc_fd, name, data, mode, 0, 0, self.own)
                elif name == "secrets.yaml":
                    remove_at(etc_fd, name)
        finally:
            os.close(etc_fd)
        key = read_at(state_fd, BEFORE_KEY[0], MAX_FILE_BYTES)
        if key is not None:
            self.install_key(key)
        elif read_at(state_fd, BEFORE_KEY[1], 0) is not None:
            fd = open_dir(os.path.dirname(self.dex_key_file))
            try:
                remove_at(fd, os.path.basename(self.dex_key_file))
            finally:
                os.close(fd)

    def config_hash(self):
        """portikus.yaml's SHA-256; write-settings writes the same bytes from the same answers."""
        raw = read_file(self.config_file)
        return None if raw is None else hashlib.sha256(raw).hexdigest()

    def forget(self, state_fd):
        for name in ("trial.json", "before-portikus.yaml", "before-secrets.yaml", *BEFORE_KEY):
            remove_at(state_fd, name)

    def arm(self, trial_id, seconds, stage):
        """A transient timer that runs `site-job expire <id>`; False when systemd would not start it.

        The setup stage's timer stands in while setup runs, should this job die;
        the trial stage's replaces it once the trial opens. Each has its own
        unit name, so arming one never collides with the other's running expire.
        """
        unit = f"{TRIAL_UNIT}{trial_id}-{stage}"
        self.disarm(trial_id)
        self.run(["systemctl", "reset-failed", unit + ".service"])
        # A wall-clock time, since every daemon-reload, which setup does, restarts an --on-active
        # countdown. A time already past never fires, so it is a few seconds ahead at least.
        when = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(math.ceil(self.clock() + max(5, seconds))))
        rc = self.run(["systemd-run", f"--unit={unit}", f"--on-calendar={when}",
                       "--timer-property=AccuracySec=1s", "--description=Portikus site trial deadline",
                       SITE_JOB, "expire", trial_id])[0]
        if rc != 0:
            journal(f"could not start the deadline timer for trial {trial_id}")
        return rc == 0

    def disarm(self, trial_id):
        for stage in ("setup", "trial"):
            self.run(["systemctl", "stop", f"{TRIAL_UNIT}{trial_id}-{stage}.timer"])

    def revert(self, state_fd, trial, code):
        """Put the answers from before trial back and rerun setup. Returns its status change.

        A trial with no hash died while writing its answers, so the snapshot is the last good state.
        """
        if "config" in trial and trial["config"] != self.config_hash():
            return self.supersede(state_fd, trial)
        trial_secrets = self.secret_values()
        self.restore(state_fd)
        try:
            self.set_debconf(trial.get("old") or {})
        except JobFailed:
            journal(f"could not put the debconf answers of trial {trial['id']} back; portikus.yaml is back")
        ok = self.run_setup(trial["id"], trial_secrets)
        self.forget(state_fd)
        self.disarm(trial["id"])
        change = {"state": "reverted", "code": code} if ok else {"state": "failed", "code": "setup_failed"}
        change.update(finishedAt=now_iso(self.clock), trialEndsAt=None)
        self.update_status(trial["id"], change)
        journal(f"trial {trial['id']} put back: {change['code']}" + ("" if ok else "; setup failed again"))
        return change

    def supersede(self, state_fd, trial):
        """Someone else's answers now hold, so putting the snapshot back would undo them."""
        self.forget(state_fd)
        self.disarm(trial["id"])
        change = {"state": "failed", "code": "trial_superseded", "finishedAt": now_iso(self.clock),
                  "trialEndsAt": None}
        self.update_status(trial["id"], change)
        journal(f"trial {trial['id']} forgotten: portikus.yaml was changed outside it")
        return change

    def end_overdue(self, state_fd, trial):
        """Recover a trial no job is working on: put it back if overdue or cut short, else rearm its timer."""
        ends = iso_seconds(trial.get("endsAt"))
        if trial.get("state") != "trial":
            self.revert(state_fd, trial, "setup_failed")
        # The timer fires within a second of the deadline; a reboot loses it.
        elif ends is None or ends <= self.clock() + 5:
            self.revert(state_fd, trial, "trial_expired")
        elif self.run(["systemctl", "is-active", "--quiet", f"{TRIAL_UNIT}{trial['id']}-trial.timer"])[0] != 0:
            self.arm(trial["id"], ends - self.clock(), "trial")

    def recover(self):
        lock = self.trial_locked(wait=False)
        if lock is None:
            return
        try:
            trial = self.read_trial(lock)
            if trial is not None:
                self.end_overdue(lock, trial)
        finally:
            os.close(lock)

    def open_trial(self, job_id, kind, prepare):
        """Write the new answers, rerun setup and open a trial that Keep ends (ADR 0059)."""
        if not os.path.isfile(self.config_file):
            raise Refused("not_apt_install")
        lock = self.trial_locked(wait=False)
        if lock is None:
            raise Refused("busy")
        try:
            if self.read_trial(lock) is not None:
                raise Refused("trial_open")
            if self.setup_running():
                raise Refused("busy")
            current = self.read_settings()
            changes, port, secret, key = prepare(current)
            before = current["answers"]
            old = {q: before.get(q, "") for q, v in changes.items() if before.get(q, "") != v}
            new = {q: changes[q] for q in old}
            self.snapshot(lock)
            if key is not None:
                self.snapshot_key(lock)
            trial = {"id": job_id, "kind": kind, "state": "running", "old": old}
            self.write_trial(lock, trial)
            # Should this job die during setup, the timer still puts the old answers back.
            if not self.arm(job_id, SETUP_TIMEOUT + TRIAL_SECONDS[kind], "setup"):
                self.forget(lock)
                raise JobFailed("write_failed")
            try:
                self.set_debconf(new)
                self.write_answers({**before, **changes}, secret, port)
                if key is not None:
                    self.install_key(key)
                trial["config"] = self.config_hash()
                self.write_trial(lock, trial)
            except (OSError, JobFailed, subprocess.SubprocessError):
                self.restore(lock)
                try:
                    self.set_debconf(old)
                except JobFailed:
                    journal("could not put the debconf answers back; portikus.yaml is back")
                self.forget(lock)
                self.disarm(job_id)
                raise JobFailed("write_failed")
            if not self.run_setup(job_id, [secret] if secret else []):
                return self.revert(lock, trial, "setup_failed")
            # Keep is pressed on the API's page, so a trial with the API down could only expire.
            if not self.api_healthy():
                journal(f"trial {job_id} ({kind}): the API did not answer /health after setup")
                return self.revert(lock, trial, "api_unhealthy")
            ends = self.clock() + TRIAL_SECONDS[kind]
            trial.update(state="trial", endsAt=now_iso(lambda: ends))
            self.write_trial(lock, trial)
            if not self.arm(job_id, TRIAL_SECONDS[kind], "trial"):
                return self.revert(lock, trial, "write_failed")
            journal(f"trial {job_id} ({kind}) open until {trial['endsAt']}")
            return {"state": "trial", "trialEndsAt": trial["endsAt"]}
        finally:
            os.close(lock)

    def do_address(self, job_id, body):
        host, port = body["host"], body["port"]

        def prepare(current):
            # The site must never be a preview host (SPEC.md 14.3); with no suffix set by hand it is preview.<host>.
            suffix = (current.get("previewSuffix") or "").lower()
            if suffix and (host == suffix or host.endswith("." + suffix)):
                raise Refused("invalid_value")
            self.check_certificate(host, current)
            return {"public_host": host}, port, None, None

        return self.open_trial(job_id, "address", prepare)

    def check_certificate(self, host, current):
        """Uploaded certificate files must cover the new names; the internal authority and ACME issue them."""
        raw = read_file(self.certificate_settings)
        try:
            settings = json.loads(raw) if raw is not None else None
        except ValueError:
            settings = None
        if not isinstance(settings, dict):
            if current["answers"].get("tls") == "files":
                raise Refused("certificate_not_covering")
            return
        if settings.get("source") != "files":
            return
        names = []
        for part in ("site", "preview"):
            certificate = (settings.get(part) or {}).get("certificate") or {}
            names += [n for n in certificate.get("names") or [] if isinstance(n, str)]
        sample = None if current.get("previewSuffix") else f"x.preview.{host}"
        if not covers(names, host) or (sample and not covers(names, sample)):
            raise Refused("certificate_not_covering")

    def do_signin(self, job_id, body):
        provider = body["provider"]
        secret = body["clientSecret"]

        def prepare(current):
            answers = current["answers"]
            changes = {"provider": provider}
            key = None
            if provider == "entra":
                source = body.get("entraRoleSource", "appRoles")
                changes.update(entra_tenant_id=body["entraTenantId"], client_id=body["clientId"],
                               entra_role_source=source)
                if source == "groups":
                    changes.update({f"{role}_group": name for role, name in body["groups"].items()})
            elif provider == "google":
                admin = body.get("googleAdminEmail", "")
                changes.update(google_domains=" ".join(body["googleDomains"]), client_id=body["clientId"],
                               google_admin_email=admin)
                if admin:
                    changes.update({f"{role}_group": name for role, name in body["groups"].items()})
                    key = body.get("googleServiceAccountKey")
                    # Without a key every Google sign-in would fail.
                    if key is None and read_file(self.dex_key_file) is None:
                        raise Refused("missing_secret")
            elif provider == "oidc":
                changes.update(oidc_issuer=body["oidcIssuer"], client_id=body["clientId"])
                # Left out means keep what is stored; write-settings drops a blank group.
                if "groupsClaim" in body:
                    changes["oidc_groups_claim"] = body["groupsClaim"]
                if "groups" in body:
                    changes.update({f"{role}_group": name for role, name in body["groups"].items()})
            if provider != "dex" and secret is None:
                # A changed provider never receives an old secret (ADR 0059).
                stored = "portikus_dex_upstream_client_secret" in current["secretsSet"]
                if not stored or identity(answers) != identity({**answers, **changes}):
                    raise Refused("missing_secret")
            return changes, None, secret, key

        return self.open_trial(job_id, "signin", prepare)

    def do_keep(self, body):
        lock = self.trial_locked(wait=True)
        try:
            trial = self.read_trial(lock)
            if trial is None or trial["id"] != body["trialId"] or trial.get("state") != "trial":
                raise Refused("no_open_trial")
            self.forget(lock)
            self.disarm(trial["id"])
            self.update_status(trial["id"], {"state": "kept", "code": None, "finishedAt": now_iso(self.clock),
                                             "trialEndsAt": None})
            journal(f"trial {trial['id']} kept")
            return {"state": "done"}
        finally:
            os.close(lock)

    def do_rollback(self, body):
        lock = self.trial_locked(wait=True)
        try:
            trial = self.read_trial(lock)
            if trial is None or trial["id"] != body["trialId"] or trial.get("state") != "trial":
                raise Refused("no_open_trial")
            change = self.revert(lock, trial, "rolled_back")
            return {"state": "done"} if change["state"] == "reverted" else {"state": "failed", "code": change["code"]}
        finally:
            os.close(lock)

    def run_expire(self, trial_id):
        lock = self.trial_locked(wait=True)
        try:
            trial = self.read_trial(lock)
            if trial is None or trial["id"] != trial_id:
                journal(f"trial {trial_id} is no longer open")
                return 0
            self.jobs_gid = self.status_gid()
            self.end_overdue(lock, trial)
            return 0
        finally:
            os.close(lock)

    def open_trial_id(self):
        fd = self.state_fd()
        try:
            trial = self.read_trial(fd)
        finally:
            os.close(fd)
        return trial["id"] if trial else None
