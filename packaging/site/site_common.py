"""What every part of the site job shares: the host's paths, its status codes, and the
file and command helpers. The job classes of the other site_*.py modules build on RunnerBase.

Python standard library only, as the other root jobs (ADR 0030).
"""

import datetime
import grp
import os
import pwd
import shutil
import stat
import subprocess
import sys
import time

ETC = "/etc/portikus"
# Setup writes the API's settings here; PORT is the loopback port it listens on.
API_ENV = ETC + "/api.env"
CONFIG_FILE = ETC + "/portikus.yaml"
PROXY_HOSTS_FILE = ETC + "/proxy-hosts.json"
LTI_ADMIN_FILE = ETC + "/lti-platforms-admin.json"
LTI_OPERATOR_FILE = ETC + "/lti-platforms.json"
CERTIFICATE_SETTINGS = ETC + "/certificate/settings.json"
# The egress proxy includes every *.conf here. The alerts job owns alerts.conf.
PROXY_DIR = ETC + "/egress-proxy.d"
SQUID_CONF = "/etc/squid/squid.conf"
JOBS_DIR = "/var/lib/portikus/site-jobs"
# Root only: the open trial and the settings files it would put back, secrets.yaml included.
STATE_DIR = "/var/lib/portikus/site-state"
API_USER = "portikus"
API_GROUP = "portikus"
# infra/ansible/roles/dex/defaults/main.yml dex_google_key_path; a test keeps the two equal.
DEX_KEY_FILE = "/etc/portikus-dex/google-service-account.json"
DEX_GROUP = "portikus-dex"
MAX_FILE_BYTES = 512 * 1024


# Every code a status file or the journal may carry; packages/contracts SiteJobCode.
CODES = (
    "invalid_request", "invalid_value", "too_many", "duplicate", "operator_platform", "mock_platform",
    "reserved_port", "certificate_not_covering", "not_apt_install", "missing_secret", "trial_open", "busy",
    "no_open_trial", "proxy_config_rejected", "proxy_reload_failed", "api_restart_failed", "setup_failed",
    "trial_expired", "rolled_back", "write_failed", "trial_superseded", "api_unhealthy",
)


class JobFailed(Exception):
    """A valid request that could not be put in force; `code` is one of CODES."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def now_iso(clock=time.time):
    stamp = datetime.datetime.fromtimestamp(clock(), datetime.timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_seconds(text):
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def journal(message):
    print(f"site-job: {message}", file=sys.stderr, flush=True)


# ---- Commands ----

def run(argv, timeout=60, stdin=None):
    """Run argv without a shell; returns (exit code, standard output). 124 on a timeout, 127 when it cannot start."""
    try:
        done = subprocess.run(argv, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              stdin=None if stdin is not None else subprocess.DEVNULL, text=True,
                              errors="replace", timeout=timeout,
                              env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except subprocess.TimeoutExpired:
        return 124, ""
    except OSError:
        return 127, ""
    if done.returncode != 0 and done.stderr:
        # Squid's, debconf's and the platforms check's own error lines hold no secret.
        for line in done.stderr.strip().splitlines()[-3:]:
            journal(f"{os.path.basename(argv[0])}: {line[:300]}")
    return done.returncode, done.stdout


# ---- Files ----

# jscpd:ignore-start -- each job is a standalone root script, so this stays a copy.
def write_at(dir_fd, name, data, mode, uid, gid, own):
    """Write name inside dir_fd atomically (temporary file, then rename), never following a link."""
    temp = f".{name}.tmp"
    try:
        os.unlink(temp, dir_fd=dir_fd)
    except FileNotFoundError:
        pass
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=dir_fd)
    try:
        if own:
            os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        os.write(fd, data.encode() if isinstance(data, str) else data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def read_at(dir_fd, name, limit):
    """A regular file's bytes inside dir_fd, or None for anything else, a link included."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, limit + 1)
        return data if len(data) <= limit else None
    finally:
        os.close(fd)


def remove_at(dir_fd, name):
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(name, dir_fd=dir_fd)
    else:
        os.unlink(name, dir_fd=dir_fd)
# jscpd:ignore-end


def open_dir(path):
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def make_dir(path, mode):
    try:
        os.mkdir(path, mode)
    except FileExistsError:
        pass
    return open_dir(path)


def read_file(path, limit=MAX_FILE_BYTES):
    try:
        fd = open_dir(os.path.dirname(path))
    except OSError:
        return None
    try:
        return read_at(fd, os.path.basename(path), limit)
    finally:
        os.close(fd)


class RunnerBase:
    """The paths, the command runner, the clock and the owner rules every job class uses."""

    def __init__(self, root="", run_=None, clock=time.time):
        self.root = root
        self.etc = root + ETC
        self.api_env = root + API_ENV
        self.config_file = root + CONFIG_FILE
        self.proxy_hosts_file = root + PROXY_HOSTS_FILE
        self.lti_admin_file = root + LTI_ADMIN_FILE
        self.lti_operator_file = root + LTI_OPERATOR_FILE
        self.certificate_settings = root + CERTIFICATE_SETTINGS
        self.proxy_dir = root + PROXY_DIR
        self.squid_conf = root + SQUID_CONF
        self.jobs_dir = root + JOBS_DIR
        self.state_dir = root + STATE_DIR
        self.dex_key_file = root + DEX_KEY_FILE
        # Looked up at call time, so a test that replaces the module's run catches every command.
        self.run = run_ if run_ is not None else (lambda argv, timeout=60, stdin=None: run(argv, timeout, stdin))
        self.clock = clock
        self.own = os.geteuid() == 0
        self.jobs_gid = os.getegid()

    def api_gid(self):
        if not self.own:
            return os.getegid()
        try:
            return grp.getgrnam(API_GROUP).gr_gid
        except KeyError:
            journal(f"the {API_GROUP} group is missing; reinstall the portikus package")
            raise JobFailed("write_failed")

    def dex_gid(self):
        if not self.own:
            return os.getegid()
        try:
            return grp.getgrnam(DEX_GROUP).gr_gid
        except KeyError:
            journal(f"the {DEX_GROUP} group is missing; run setup once with Dex before uploading a key")
            raise JobFailed("write_failed")

    def api_uid(self):
        if not self.own:
            return os.geteuid()
        try:
            return pwd.getpwnam(API_USER).pw_uid
        except KeyError:
            return None
