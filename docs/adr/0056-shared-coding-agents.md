# 0056. Claude Code and Codex live in a shared read-only folder, updated by the root image job

- **Status**: Accepted (Epic 40)
- **Date**: 2026-10-10
- **References**: SPEC.md sections 10.1, 22.4, 22.6 and 24.1; ADR 0030;
  issue #1215

## Context

Claude Code and Codex used to be installed in the workspace image with
npm, at versions the recipe pinned. A new version of either tool reached
students only after a new image, and a rebuilt image replaced every
student's system disk. Administrators wanted to move to a new Claude Code
or Codex without rebuilding anything and without interrupting open
sessions.

## Decision

1. **One shared folder.** `/var/lib/portikus/coding-agents` on the
   platform VM holds every installed version of both tools, owned by root.
   Every workspace sees it read-only at `/opt/portikus/coding-agents`
   through a `coding-agents` disk device on the workspace profile. Each
   tool has `<tool>/<version>/`, a `current` link and a `previous` link.
   `bin/claude` and `bin/codex` never change.
2. **Bind-mount the parent, not the link.** A bind mount of a `current`
   link would keep pointing at the version it had when the mount was made.
   Mounting the whole folder lets a rename of `current` show up at once in
   running workspaces. Open sessions keep the file they started with.
3. **Per-tool links.** The image has `/usr/local/bin/claude` and
   `/usr/local/bin/codex`, each a link to the matching `bin` link. They
   win over `/usr/bin` on the path. Each tool switches, and rolls back, on
   its own, so a bad Codex release does not hold back Claude Code.
4. **Extend the image job.** The root job of ADR 0030 gains
   `agents-update`, `agents-rollback {tool}` and `agents-seed`, under the
   same lock and request directory. The API still asks for a kind and a
   tool, never a version or a URL. This adds no new root unit.
5. **Verify, test, then switch.** Downloads are verified, unpacked safely
   into a staging folder, and health-checked as the student in a throwaway
   container. A tool that fails keeps its old version.
6. **D1. Claude Code installs from the `stable` channel.** It is the
   vendor's own recommendation for steady use.
7. **D2. Older images are repointed at each start.** The workspace
   controller writes the two `/usr/local/bin` links into a stopped
   workspace's file system with the Incus files API, so every workspace
   moves to the shared tools at its next start without an image rebuild.
   It uses the delete-then-write rule that already protects the other
   files it writes (SPEC.md 24.1), and a failure never stops a start.
8. **D3. Codex is checked by digest and checksum file, an accepted
   risk.** The job requires GitHub's release-asset SHA-256 to equal the
   hash in `codex-package_SHA256SUMS`, over a URL it builds itself. There
   is no sigstore or other signature check. Someone who can alter both the
   release asset and its checksum file in the vendor's GitHub repository
   could ship a bad Codex. Claude Code is stronger: its manifest is signed,
   and the job requires a pinned key fingerprint.
9. **Never older than current.** The stable pointer is unsigned, so an
   update that is offered an older version leaves the tool alone.
10. **Rollback is not sticky.** A rollback makes the old version current
    again. The next **Update coding agents** moves forward to the newest
    version, not back to the one that was rolled back from.
11. **Retention.** Keep three versions per tool, never `current` or
    `previous`, and keep a version a running process uses, but not past
    five folders per tool.

## Rejected

- **Keep installing in the image.** It ties every tool update to an image
  rebuild.
- **Let each student update their own copy.** The tools would differ
  between students, the updater needs a writable install that students
  control, and nothing would be verified by the platform.
- **A separate root unit for agent updates.** More moving parts; the image
  job already has the lock, the request directory and the health check.
- **Bind-mount `current` directly.** It freezes at the mounted version
  (decision 2).
- **Pick a version on the admin page.** It adds a free-text or list input
  to a root job for no need today; filed for later with course profiles
  (#1246).
- **Check Codex with sigstore.** More code and a new dependency on the
  root job for a risk the owner accepted (decision 8).

## Consequences

- The image no longer contains the tools. An image from 2026.10.2 on needs
  a Portikus package from Epic 40 or later, which creates and fills the
  folder at setup.
- A root-written folder is now executed by every workspace. The job's
  checks, the strict request and the read-only mount are the barrier
  (SPEC.md 24.1).
- The server needs outgoing access to the vendors' download hosts
  (docs/INSTALL.md).
- The folder is not backed up; it can be downloaded again.
- ADR 0030's statement that a rebuild installs pinned Claude Code and Codex
  no longer holds.
