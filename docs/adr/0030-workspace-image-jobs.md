# 0030. Workspace image jobs run in a path-activated root unit

- **Status**: Proposed
- **Date**: 2026-09-24
- **References**: SPEC.md sections 21.7, 21.8, 22 and 24.1;
  SPEC.md section 22.4

## Context

Administrators want to update the workspace image, or rebuild it with
current packages and a chosen Node and Python, from the admin area.
Downloading, building and importing an image need root on the host. The
API runs as an unprivileged user with `NoNewPrivileges`, and a
compromised API must not become root.

## Decision

The API writes a request file into a directory it shares with root. A
systemd path unit starts a root oneshot service that moves the request
aside, accepts only a fixed set of kinds (fetch, build, activate,
rollback), fixed dropdown choices and a strictly shaped version, and runs
the job. The job writes its status and log where the API can read them,
and writes each image's manifest and health result where the API cannot
write. An image becomes the default only after the job's own health check
has passed; the previous default is kept for a one-step rollback.

## Consequences

- The most a compromised API can do is ask for one of a few fixed jobs.
- One job at a time; progress is polled from files, not streamed.
- Setup's first install runs the same fetch and activate, through
  `image-job first-install <version>` under the same lock, so the first
  image passes the same checks and has a health result. Once the host has
  a default image, setup leaves it to the admin page.
- Rejected: sudo from the API (blocked by `NoNewPrivileges`, and a wider
  door); a polkit rule letting the API start the unit over D-Bus (one
  more daemon on a minimal host); free-text versions or package lists
  (arbitrary code as root).

## Update, Epic 40

The job also updates Claude Code and Codex in a shared folder, outside the
image (ADR 0056). That supersedes the recipe pinning those versions: an
image rebuild no longer installs or changes them.
