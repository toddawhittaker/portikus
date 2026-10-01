# 0045. Shared Docker pull storage: a pull-through cache and LVM-thin seed snapshots

- **Status**: Accepted (Epic 26)
- **Date**: 2026-09-30
- **References**: SPEC.md sections 16.2, 16.4, 16.6, 20.1, 23.6 and 24.5;
  STACK.md section 2; ADRs 0021, 0030 and 0038; issue #840

## Context

Every workspace has its own Docker daemon and Docker volume (SPEC.md
section 16.1). Thirty students who each pull `python:3.12` download it
thirty times, hit Docker Hub's anonymous limit of 100 pulls an hour per
address (the whole site shares one address), and store thirty unpacked
copies. Issue #840 asked for shared storage.

A spike on the rehearsal VM measured the options:

- An LVM-thin copy of a 2.7 GB Docker volume holding four images takes
  0.7 seconds and no pool space. With `security.shifted=true` on the
  volume, the first start takes about 0.9 seconds with an idmapped mount;
  without it, Incus rewrites ownership and the first start takes 6.8
  seconds.
- Debian's `docker-registry` 2.8 in proxy mode works as a Docker Hub
  mirror over plain HTTP. A second pull of `redis:7` downloaded nothing.
  The first fetch downloads about twice the bytes. Registry 2.8 has no
  size cap and a fixed 7-day expiry.
- ghcr.io can be cached only by pretending to be ghcr.io: a second proxy
  with a certificate for `ghcr.io` from an internal certificate authority
  and a hosts entry. That breaks push, private images and non-Docker tools.

## Decision

Build both.

1. **A pull-through cache** for Docker Hub on the workspace gateway, port
   5000, on its own fixed-size loop-file filesystem, sized at install.
   It saves bandwidth, time and the Hub rate limit. It does not save disk,
   because each workspace still unpacks its own copy.
2. **A global seed volume**, copied as an LVM-thin snapshot into a new
   workspace, a Reset Docker and an admin rebuild with Reset Docker. The
   copy shares blocks with the seed until written, so it saves disk. A
   volume is never replaced behind a student's back; only those three
   moments take the current seed.
3. **A ghcr.io cache on port 5001, on by default.** Todd ruled on
   2026-09-30 (migration 0033) that it is on: students push images from
   GitHub Actions to the real ghcr.io and only pull public images in
   workspaces, which the cache serves. An administrator can turn it off,
   and the page lists what breaks while it is on.
4. **The egress policy gates the cache by name** (SPEC.md section 23.6),
   so a workspace that may not reach Docker Hub cannot reach it through
   the cache either.
5. **Usage is aggregate only**: pull events from the registry's webhook
   and an inventory from each workspace's agent, shown as counts.

The security rulings S1 to S8, the accepted overcommit (SEC1) and the
shared-cache availability note (SEC5) are in SPEC.md section 24.5.

## Alternatives rejected

- **Cache only, no seed.** Leaves every workspace with a full unpacked
  copy of common images; the disk cost stays.
- **Seed only, no cache.** Images outside the seed still come from Docker
  Hub once per workspace, under the shared rate limit.
- **A seed without `security.shifted`.** Works, but the first start of
  each copy rewrites ownership: about 7 seconds and extra disk.
- **A newer registry, Harbor or a caching proxy in front** (for a size cap
  or to hide `/v2/_catalog`). More moving parts and not in Debian; Caddy
  in front was already ruled out for workspace traffic in ADR 0038.
- **ghcr.io cache off by default** (the spike's advice). Rejected by Todd
  for the reason in item 3.
- **Swapping existing workspaces to a newer seed.** Would replace a
  student's Docker data without asking.

## Consequences

- One capped file on the server holds the cache; when it passes 90
  percent the helper clears it all. One student can cause that, which
  costs everyone only download time (SEC5).
- Seed copies overcommit the thin pool by up to the seed cap per
  workspace. The controller's refusal to fill the pool past 90 percent is
  the guard; no admission check was added (SEC1).
- While the ghcr.io cache is on, `docker push` to ghcr.io, private
  ghcr.io images and non-Docker tools talking to ghcr.io do not work from
  workspaces.
- If the cache stops, Docker falls back to Docker Hub directly. A
  dropped connection rather than a refused one stalls a pull for about 15
  seconds first.
- The seed records the image version it was built on, because its
  Docker data must suit the workspace image's Docker version.
