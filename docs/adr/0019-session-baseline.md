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
object id it prints. Git writes one dangling commit and no ref. On this
machine `git stash create -u` does not put untracked files in that commit
(the flag is only a message), so when untracked files or a root `.env` /
`.env.*` file are present the agent builds one more dangling commit: the
same tracked tree, with a parentless second parent that holds those files.
No ref is updated. A clean tree makes `stash create` print nothing, and the
baseline is HEAD. Object ids are SHA-1 (40 hex characters) or SHA-256 (64).

That `stash create` runs with empty command-line overrides for every
`filter.<name>.clean` and `filter.<name>.smudge` from `git config
--get-regexp`, and with `core.hooksPath=/dev/null`. The overrides are not
written into git config. A clean filter must not be able to move a branch.

If the directory is not a repository, or the command fails, the agent still
starts the CLI and reports a null baseline. Review reads, which the API task
relays, are `GET /projects/:slug/baseline-status?object=` and
`GET /projects/:slug/baseline-diff?object=&path=`. They compare the working
tree with that object and do not move refs. Paths in the parentless second
parent are not reported as session additions unless their content changed.

## Consequences

The snapshot needs no extra storage. `node_modules`, `.git`, `dist`, and
`.next` are not copied into the object. A later git prune can drop the
dangling object, and the review then has nothing to compare.
