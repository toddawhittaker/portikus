# 0019 — Session baseline is a dangling git stash object

## Status

Accepted, 2026-09-21.

## Context

SPEC.md section 10.9 requires a review baseline before a Portikus-launched
coding agent runs. It has to be independent of HEAD, because the project may
already be dirty, and it must not change history, the index, branches, tags,
or the stash (section 12.5). Copying the tree out of the repository would be
a second backup beside recovery points, which section 10.9 says not to add.

## Decision

The workspace agent runs `git stash create` in the project and keeps the
object id it prints. Git writes one dangling commit and no ref. If the
directory is not a repository, or the command fails, the agent still starts
the CLI and reports a null baseline. Review reads, which the API task relays,
are `GET /projects/:slug/baseline-status?object=` and
`GET /projects/:slug/baseline-diff?object=&path=`. They compare the working
tree with that object and do not move refs.

## Consequences

The snapshot needs no extra storage. `git stash create` records tracked
content, so a file that was already untracked can show up as added. A later
git prune can drop the dangling object, and the review then has nothing to
compare.
