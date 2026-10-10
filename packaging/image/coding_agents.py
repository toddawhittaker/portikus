"""The shared Claude Code and Codex folder that image-job manages (docs/SPEC.md section 22.4).

Every workspace mounts /var/lib/portikus/coding-agents read-only at
/opt/portikus/coding-agents, so switching a `current` link here moves every
workspace at once. This module holds the folder's layout, the checks on what
is downloaded and the safe unpack; image-job holds the downloads, the
health check and the job around them. Standard library only, run as root.

    bin/claude -> ../claude/current/claude          (never changes)
    bin/codex  -> ../codex/current/bin/codex        (never changes)
    claude/<v>/claude      claude/current -> <v>    claude/previous -> <v>
    codex/<v>/bin/codex    codex/current -> <v>     codex/previous -> <v>
    .staging-<id>/         (0700, only while a job runs)
"""

import json
import os
import posixpath
import re
import secrets
import shutil
import stat
import tarfile

STORE = "/var/lib/portikus/coding-agents"
KEYRING = "/usr/share/portikus/keyrings/claude-code.gpg"
# The Claude Code release key's primary fingerprint; gpgv must report it, not only "good".
CLAUDE_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"

CLAUDE_BASE = "https://downloads.claude.ai/claude-code-releases"
CODEX_LATEST = "https://api.github.com/repos/openai/codex/releases/latest"
CODEX_DOWNLOAD = "https://github.com/openai/codex/releases/download"
CODEX_ASSET = "codex-package-x86_64-unknown-linux-musl.tar.gz"
CODEX_SUMS = "codex-package_SHA256SUMS"

# What setup installs on a host with no `current` yet; the pin is the trust here.
SEED = {
    "claude": ("2.1.287", "3920489a5109cff5786a1a392c25277408ff22bc796d5edb9c16a60e5a1718f0"),
    "codex": ("0.162.1", "a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3"),
}

TOOLS = ("claude", "codex")
NAMES = {"claude": "Claude Code", "codex": "Codex"}
# The executable inside a version folder, and what bin/<tool> points at.
ENTRY = {"claude": "claude", "codex": "bin/codex"}

# [0-9] and re.ASCII, because \d also matches other scripts' digits.
VERSION_RE = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}", re.ASCII)
SHA256_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)

KEEP = 3
MIN_FREE_BYTES = 2 * 1024 ** 3
# Caps well above today's sizes (a 233 MiB binary, a 155 MiB archive of 54 files unpacking to 432 MiB).
SMALL_MAX_BYTES = 1024 * 1024
LISTING_MAX_BYTES = 8 * 1024 * 1024
BINARY_MAX_BYTES = 512 * 1024 * 1024
UNPACKED_MAX_BYTES = 2 * 1024 ** 3
MAX_MEMBERS = 1000


class AgentError(Exception):
    """A step that failed for one tool; the message is shown to the admin."""


def version_key(version):
    return tuple(int(part) for part in version.split("."))


# ---- What the vendors publish ----

def claude_stable_version(text):
    version = text.strip()
    if not VERSION_RE.fullmatch(version):
        raise AgentError("The Claude Code stable channel did not name a version.")
    return version


def check_signature(status_text):
    """True when gpgv's status output has a valid signature from the pinned key."""
    for line in status_text.splitlines():
        fields = line.split()
        if fields[:2] == ["[GNUPG:]", "VALIDSIG"] and len(fields) >= 12 and fields[-1] == CLAUDE_FINGERPRINT:
            return True
    return False


def claude_binary_sha(manifest_text, version):
    """The linux-x64 binary's SHA-256 from a manifest whose signature already verified."""
    try:
        manifest = json.loads(manifest_text)
        entry = manifest["platforms"]["linux-x64"]
        sha, size = entry["checksum"], entry["size"]
    except (ValueError, KeyError, TypeError):
        raise AgentError("The Claude Code manifest has no linux-x64 binary.")
    if manifest.get("version") != version:
        raise AgentError("The Claude Code manifest names a different version.")
    if entry.get("binary") != "claude" or not isinstance(sha, str) or not SHA256_RE.fullmatch(sha):
        raise AgentError("The Claude Code manifest's linux-x64 entry is malformed.")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= BINARY_MAX_BYTES:
        raise AgentError("The Claude Code binary is larger than the job accepts.")
    return sha


def codex_release(listing_text):
    """(version, the package's GitHub digest) from the latest-release JSON."""
    try:
        release = json.loads(listing_text)
        tag = release["tag_name"]
        assets = release["assets"]
    except (ValueError, KeyError, TypeError):
        raise AgentError("The Codex release list is not what GitHub sends.")
    if not isinstance(tag, str) or not tag.startswith("rust-v") or not VERSION_RE.fullmatch(tag[6:]):
        raise AgentError("The latest Codex release is not a plain rust-v<version> tag.")
    names = {}
    for asset in assets if isinstance(assets, list) else []:
        if isinstance(asset, dict) and isinstance(asset.get("name"), str):
            names[asset["name"]] = asset
    digest = names.get(CODEX_ASSET, {}).get("digest")
    if CODEX_SUMS not in names or not isinstance(digest, str) or not digest.startswith("sha256:") \
            or not SHA256_RE.fullmatch(digest[7:]):
        raise AgentError("The latest Codex release has no package with a SHA-256 digest and checksum file.")
    return tag[6:], digest[7:]


def codex_sums_sha(sums_text):
    """The package's SHA-256 in codex-package_SHA256SUMS. A file may list it twice, but only one way."""
    found = set()
    for line in sums_text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](\S+)", line, re.ASCII)
        if not match:
            raise AgentError("The Codex checksum file is malformed.")
        if match.group(2) == CODEX_ASSET:
            found.add(match.group(1))
    if len(found) != 1:
        raise AgentError("The Codex checksum file does not list the package exactly once.")
    return found.pop()


# ---- Unpacking ----

def unpack(archive, dest):
    """Unpack a gzip tar into dest, refusing anything but plain files and folders.

    Every member is checked before any is written, so a refused archive
    leaves dest empty. tarfile's "data" filter is a second guard.
    """
    with tarfile.open(archive, "r:gz") as tar:
        members = []
        total = 0
        for member in tar:
            if len(members) >= MAX_MEMBERS:
                raise AgentError("The archive has more files than the job accepts.")
            name = member.name
            clean = posixpath.normpath(name)
            if not name or name.startswith("/") or clean == ".." or clean.startswith("../") \
                    or ".." in name.split("/"):
                raise AgentError(f"The archive holds an unsafe path: {name[:100]}")
            if not (member.isreg() or member.isdir()):
                raise AgentError(f"The archive holds a link or special file: {name[:100]}")
            if member.mode & (stat.S_ISUID | stat.S_ISGID):
                raise AgentError(f"The archive holds a setuid or setgid file: {name[:100]}")
            total += member.size
            if total > UNPACKED_MAX_BYTES:
                raise AgentError("The archive unpacks to more than the job accepts.")
            members.append(member)
        tar.extractall(dest, members=members, filter="data")
    normalise(dest)


def normalise(root):
    """root:root, and 0755 for folders and executables, 0644 for the rest."""
    as_root = os.geteuid() == 0
    for path, dirs, files in os.walk(root):
        for name in [*dirs, *files]:
            full = os.path.join(path, name)
            st = os.lstat(full)
            if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                raise AgentError("The unpacked files hold a link or special file.")
            if as_root:
                os.lchown(full, 0, 0)
            executable = stat.S_ISDIR(st.st_mode) or st.st_mode & 0o111
            os.chmod(full, 0o755 if executable else 0o644)
    if as_root:
        os.lchown(root, 0, 0)
    os.chmod(root, 0o755)


# ---- The folder ----

def tool_dir(store, tool):
    return os.path.join(store, tool)


def ensure_store(store):
    """Create the folder and its tool folders, root 0755, refusing a planted link."""
    for path in (store, *(tool_dir(store, t) for t in TOOLS), os.path.join(store, "bin")):
        try:
            os.mkdir(path, 0o755)
        except FileExistsError:
            pass
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise AgentError(f"{path} is not a folder.")
        os.chmod(path, 0o755)


def ensure_bin_links(store):
    """Make bin/claude and bin/codex once. Returns whether either was made."""
    made = False
    for tool in TOOLS:
        target = f"../{tool}/current/{ENTRY[tool]}"
        path = os.path.join(store, "bin", tool)
        if os.path.islink(path) and os.readlink(path) == target:
            continue
        set_link(os.path.join(store, "bin"), tool, target)
        made = True
    return made


def set_link(directory, name, target):
    """Point name at target by renaming a new link over it, so it never goes missing."""
    temp = f".link-{secrets.token_hex(4)}"
    os.symlink(target, os.path.join(directory, temp))
    os.replace(os.path.join(directory, temp), os.path.join(directory, name))


def read_link(store, tool, name):
    """The version current or previous points at, or None when missing, malformed or dangling."""
    path = os.path.join(tool_dir(store, tool), name)
    try:
        target = os.readlink(path)
    except OSError:
        return None
    if not VERSION_RE.fullmatch(target) or not os.path.isdir(os.path.join(tool_dir(store, tool), target)):
        return None
    return target


def versions(store, tool):
    """Every version folder of a tool, newest first."""
    try:
        names = os.listdir(tool_dir(store, tool))
    except FileNotFoundError:
        return []
    found = [n for n in names if VERSION_RE.fullmatch(n)
             and stat.S_ISDIR(os.lstat(os.path.join(tool_dir(store, tool), n)).st_mode)]
    return sorted(found, key=version_key, reverse=True)


def switch(store, tool, version):
    """Make version current, keeping the old current as previous."""
    old = read_link(store, tool, "current")
    if old == version:
        return
    if old:
        set_link(tool_dir(store, tool), "previous", old)
    set_link(tool_dir(store, tool), "current", version)


def rollback(store, tool):
    """Swap current and previous; returns the version now current."""
    current, previous = read_link(store, tool, "current"), read_link(store, tool, "previous")
    if not current or not previous:
        raise AgentError(f"{NAMES[tool]} has no previous version to roll back to.")
    set_link(tool_dir(store, tool), "current", previous)
    set_link(tool_dir(store, tool), "previous", current)
    return previous


def remove_version(store, tool, version):
    shutil.rmtree(os.path.join(tool_dir(store, tool), version), ignore_errors=True)


def running_files(proc_dir="/proc"):
    """(device, inode) of every running program, including those inside workspaces.

    The host's /proc shows container processes too; their exe link names the
    container's path, so only the file's identity is compared, never the path.
    """
    found = set()
    for pid in os.listdir(proc_dir):
        if not pid.isdigit():
            continue
        try:
            st = os.stat(os.path.join(proc_dir, pid, "exe"))
        except OSError:
            continue
        found.add((st.st_dev, st.st_ino))
    return found


def in_use(store, tool, version, running):
    for path, _, files in os.walk(os.path.join(tool_dir(store, tool), version)):
        for name in files:
            st = os.lstat(os.path.join(path, name))
            if (st.st_dev, st.st_ino) in running:
                return True
    return False


def prune(store, tool, running):
    """Keep KEEP versions, never current, previous or one a process runs. Returns those removed."""
    protected = {read_link(store, tool, "current"), read_link(store, tool, "previous")} - {None}
    others = [v for v in versions(store, tool) if v not in protected]
    removed = []
    for version in others[max(0, KEEP - len(protected)):]:
        if not in_use(store, tool, version, running):
            remove_version(store, tool, version)
            removed.append(version)
    return removed


def state(store):
    """The body of images/coding-agents.json, without updatedAt."""
    return {
        tool: {
            "current": read_link(store, tool, "current"),
            "previous": read_link(store, tool, "previous"),
            "kept": versions(store, tool),
        }
        for tool in TOOLS
    }


def free_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def remove_staging(store):
    try:
        names = os.listdir(store)
    except FileNotFoundError:
        return
    for name in names:
        if name.startswith(".staging-"):
            shutil.rmtree(os.path.join(store, name), ignore_errors=True)
