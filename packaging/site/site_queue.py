"""The job queue: request files in, status files out (SPEC.md section 5.1, ADR 0059).

QueueFiles is a mixin of Runner. The API writes request files; this lists them oldest first, takes
one and deletes it at once, and keeps status/<id>.json and status/<id>.log for the page to read.
"""

import json
import os
import re
import stat

from site_common import MAX_FILE_BYTES, RunnerBase, journal, make_dir, read_at, remove_at, write_at

MAX_REQUEST_BYTES = 512 * 1024
KEEP_JOBS = 50
LOG_LINES = 2000
REQUEST_NAME_RE = re.compile(r"request-(.*)\.json", re.ASCII | re.DOTALL)
STATUS_NAME_RE = re.compile(r"([0-9a-f-]{36})\.(json|log)", re.ASCII)


class QueueFiles(RunnerBase):
    # -- status files --

    def status_gid(self):
        try:
            return os.stat(self.jobs_dir).st_gid
        except OSError:
            return os.getegid()

    def status_fd(self):
        fd = make_dir(os.path.join(self.jobs_dir, "status"), 0o750)
        if self.own:
            os.fchown(fd, 0, self.jobs_gid)
        os.fchmod(fd, 0o750)
        return fd

    def write_status(self, record):
        fd = self.status_fd()
        try:
            write_at(fd, f"{record['id']}.json", json.dumps(record, indent=2) + "\n", 0o640, 0, self.jobs_gid,
                     self.own)
        finally:
            os.close(fd)

    def update_status(self, job_id, change):
        fd = self.status_fd()
        try:
            raw = read_at(fd, f"{job_id}.json", MAX_FILE_BYTES)
        finally:
            os.close(fd)
        try:
            record = json.loads(raw) if raw is not None else None
        except ValueError:
            record = None
        if not isinstance(record, dict):
            journal(f"the status of {job_id} is missing")
            return
        record.update(change)
        self.write_status(record)

    def append_log(self, job_id, lines):
        fd = self.status_fd()
        try:
            name = f"{job_id}.log"
            old = read_at(fd, name, MAX_FILE_BYTES * 4) or b""
            kept = (old.decode("utf-8", "replace").splitlines() + lines)[-LOG_LINES:]
            write_at(fd, name, "".join(line + "\n" for line in kept), 0o640, 0, self.jobs_gid, self.own)
        finally:
            os.close(fd)

    # -- requests --

    # jscpd:ignore-start -- each root job is a standalone script, so this stays a copy of the alerts job's.
    def pending(self, jobs_fd):
        names = []
        for name in os.listdir(jobs_fd):
            if REQUEST_NAME_RE.fullmatch(name):
                try:
                    st = os.stat(name, dir_fd=jobs_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                names.append((st.st_mtime_ns, name))
        return [name for _, name in sorted(names)]

    def take(self, jobs_fd, name):
        """Read one request file and delete it at once, whatever it holds. Returns (id, raw or None)."""
        raw = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=jobs_fd)
            try:
                st = os.fstat(fd)
                if stat.S_ISREG(st.st_mode) and st.st_uid == self.api_uid():
                    raw = os.read(fd, MAX_REQUEST_BYTES + 1)
            finally:
                os.close(fd)
        except OSError:
            pass
        # A signin request may hold the client secret, so it leaves the job directory before anything
        # else, and whatever it is, or the path unit would start this job again at once.
        try:
            remove_at(jobs_fd, name)
        except OSError:
            pass
        return REQUEST_NAME_RE.fullmatch(name).group(1), raw
    # jscpd:ignore-end

    def prune(self, keep_id):
        fd = self.status_fd()
        try:
            jobs = {}
            for name in os.listdir(fd):
                match = STATUS_NAME_RE.fullmatch(name)
                if match and match.group(1) != keep_id:
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    jobs[match.group(1)] = max(jobs.get(match.group(1), 0), st.st_mtime_ns)
            for job_id, _ in sorted(jobs.items(), key=lambda item: item[1])[:-KEEP_JOBS]:
                remove_at(fd, f"{job_id}.json")
                remove_at(fd, f"{job_id}.log")
        finally:
            os.close(fd)
