"""The egress proxy's host list and the LMS platforms' includes (SPEC.md section 5.1, ADR 0052, ADR 0059).

The admin page owns proxy-hosts.json and lti-platforms-admin.json. This turns each into a Squid include,
swaps it in under the include folder's lock, has Squid parse it, and puts the old file back if that fails.
ProxyJobs is a mixin of Runner; it needs only what RunnerBase provides.
"""

import fcntl
import json
import os

from site_common import (
    LTI_ADMIN_FILE, MAX_FILE_BYTES, PROXY_HOSTS_FILE, SQUID_CONF, JobFailed, RunnerBase, journal, make_dir, open_dir,
    read_at, read_file, remove_at, write_at,
)
from site_values import Refused, _keys, check_hosts, check_platforms, keyset_clash, parse_json, url_host

ADMIN_CONF = "admin.conf"
LTI_CONF = "lti.conf"
# Shared with the alerts job: present from before a rule change until Squid has reloaded.
RELOAD_PENDING = "reload-pending"
SQUID_UNIT = "squid.service"
NODE = "/usr/lib/portikus/node/bin/node"
PLATFORMS_CHECK = "/usr/lib/portikus/api/node_modules/@portikus/auth/dist/lti/platforms-check-main.js"
API_UNIT = "portikus-api.service"


# ---- What the proxy allows ----

def render_include(acl, source, hosts):
    """CONNECT to port 443 of each host, after squid.conf's address denies (ADR 0027)."""
    lines = [f"# Written by the site job from {source} (ADR 0059); do not edit.",
             "# CONNECT only, port 443 only."]
    if hosts:
        lines += [f"acl {acl} dstdomain -n {' '.join(hosts)}",
                  f"acl {acl}_port port 443",
                  f"http_access allow portikus_connect {acl} {acl}_port"]
    return "\n".join(lines) + "\n"


def render_admin(hosts):
    return render_include("portikus_site_hosts", PROXY_HOSTS_FILE, sorted({h.lower() for h in hosts}))


def platform_hosts(platforms):
    hosts = set()
    for platform in platforms:
        hosts.add(url_host(platform["keysetUrl"]))
        if "authTokenUrl" in platform:
            hosts.add(url_host(platform["authTokenUrl"]))
    return sorted(hosts)


def render_lti(platforms):
    return render_include("portikus_site_lti", LTI_ADMIN_FILE, platform_hosts(platforms))


class ProxyJobs(RunnerBase):
    # -- the egress proxy's includes: swap, parse, roll back (ADR 0052) --

    def proxy_fd(self):
        return make_dir(self.proxy_dir, 0o755)

    def squid_locked(self):
        """The alerts job takes the same lock on the include folder before it changes alerts.conf."""
        fd = self.proxy_fd()
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd

    def squid_parses(self):
        if not os.path.exists(self.squid_conf):
            return True
        return self.run(["squid", "-k", "parse", "-f", SQUID_CONF])[0] == 0

    def put_back(self, dir_fd, name, old):
        if old is None:
            remove_at(dir_fd, name)
        else:
            write_at(dir_fd, name, old, 0o644, 0, 0, self.own)

    def reload_proxy(self):
        if os.path.exists(self.squid_conf) \
                and self.run(["systemctl", "try-reload-or-restart", SQUID_UNIT])[0] != 0:
            raise JobFailed("proxy_reload_failed")

    def apply_include(self, name, content, commit=None):
        """Put content in force as include `name`, then commit() the page file, then reload Squid.

        Squid reads the include only on a reload, so it never runs a file that
        does not parse; a failed parse or commit puts the old file back.
        Returns True when the include changed. The caller holds the Squid lock.
        """
        dir_fd = self.proxy_fd()
        try:
            old = read_at(dir_fd, name, MAX_FILE_BYTES)
            changed = old is None or old.decode("utf-8", "replace") != content
            pending = read_at(dir_fd, RELOAD_PENDING, 0) is not None
            if changed and not pending:
                write_at(dir_fd, RELOAD_PENDING, "", 0o644, 0, 0, self.own)
            try:
                if changed:
                    write_at(dir_fd, name, content, 0o644, 0, 0, self.own)
                    if not self.squid_parses():
                        self.put_back(dir_fd, name, old)
                        raise JobFailed("proxy_config_rejected")
                if commit is not None:
                    try:
                        commit()
                    except (OSError, JobFailed):
                        if changed:
                            self.put_back(dir_fd, name, old)
                        raise JobFailed("write_failed")
            except JobFailed:
                if changed and not pending:
                    remove_at(dir_fd, RELOAD_PENDING)
                raise
            if changed or pending:
                self.reload_proxy()
                remove_at(dir_fd, RELOAD_PENDING)
            return changed
        finally:
            os.close(dir_fd)

    # -- page-owned files --

    def write_page_file(self, path, doc):
        fd = open_dir(os.path.dirname(path))
        try:
            write_at(fd, os.path.basename(path), json.dumps(doc, indent=2) + "\n", 0o640, 0, self.api_gid(),
                     self.own)
        finally:
            os.close(fd)

    def stored_hosts(self):
        raw = read_file(self.proxy_hosts_file)
        if raw is None:
            return []
        try:
            doc = parse_json(raw)
            _keys(doc, ["version", "hosts"])
            if doc["version"] != 1:
                raise Refused("invalid_request")
            return check_hosts(doc["hosts"])
        except Refused:
            journal("proxy-hosts.json is not a valid page file; reading it as empty")
            return []

    def stored_platforms(self):
        raw = read_file(self.lti_admin_file)
        if raw is None:
            return []
        try:
            doc = parse_json(raw)
            _keys(doc, ["version", "platforms"])
            if doc["version"] != 1:
                raise Refused("invalid_request")
            return check_platforms(doc["platforms"])
        except Refused:
            journal("lti-platforms-admin.json is not a valid page file; reading it as empty")
            return []

    def operator_platforms(self):
        """The platforms in the operator's file, which wins on a clash."""
        raw = read_file(self.lti_operator_file)
        try:
            doc = parse_json(raw) if raw is not None else {}
        except Refused:
            journal("the operator's LTI platforms file is not JSON; no platform is reserved")
            return []
        platforms = doc.get("platforms") if isinstance(doc, dict) else None
        return [p for p in platforms or [] if isinstance(p, dict)] if isinstance(platforms, list) else []

    def sync(self):
        """Bring admin.conf and lti.conf in line with the page files, as after a run cut short or a restore."""
        lock = self.squid_locked()
        try:
            changed = self.apply_include(ADMIN_CONF, render_admin(self.stored_hosts()))
            return self.apply_include(LTI_CONF, render_lti(self.stored_platforms())) or changed
        finally:
            os.close(lock)

    def do_proxy_hosts(self, body):
        hosts = body["hosts"]
        lock = self.squid_locked()
        try:
            self.apply_include(ADMIN_CONF, render_admin(hosts),
                               lambda: self.write_page_file(self.proxy_hosts_file, {"version": 1, "hosts": hosts}))
        finally:
            os.close(lock)
        journal(f"proxy hosts now {', '.join(hosts) or 'none'}")
        return {"state": "done"}

    def do_lti_platforms(self, body):
        platforms = body["platforms"]
        operator = self.operator_platforms()
        reserved = {(p.get("issuer"), p.get("clientId")) for p in operator}
        keysets = {}
        for p in operator:
            keysets.setdefault(p.get("issuer"), set()).add(p.get("keysetUrl"))
        if any((p["issuer"], p["clientId"]) in reserved or keyset_clash(p, keysets) for p in platforms):
            raise Refused("operator_platform")
        check_name = "." + os.path.basename(self.lti_admin_file) + ".check"
        etc_fd = open_dir(os.path.dirname(self.lti_admin_file))
        try:
            if platforms:
                write_at(etc_fd, check_name, json.dumps({"version": 1, "platforms": platforms}, indent=2) + "\n",
                         0o640, 0, self.api_gid(), self.own)
                check = os.path.join(os.path.dirname(self.lti_admin_file), check_name)
                if self.run([NODE, PLATFORMS_CHECK, check])[0] != 0:
                    remove_at(etc_fd, check_name)
                    raise Refused("invalid_value")

            def commit():
                if platforms:
                    os.rename(check_name, os.path.basename(self.lti_admin_file),
                              src_dir_fd=etc_fd, dst_dir_fd=etc_fd)
                else:
                    # The platforms file needs at least one platform, so none is no file.
                    remove_at(etc_fd, os.path.basename(self.lti_admin_file))

            lock = self.squid_locked()
            try:
                self.apply_include(LTI_CONF, render_lti(platforms), commit)
            finally:
                os.close(lock)
                remove_at(etc_fd, check_name)
        finally:
            os.close(etc_fd)
        journal(f"LMS platforms now {', '.join(p['name'] for p in platforms) or 'none'}")
        # The API reads the platforms only when it starts (ADR 0059).
        if self.run(["systemctl", "try-restart", API_UNIT])[0] != 0:
            raise JobFailed("api_restart_failed")
        return {"state": "done"}
