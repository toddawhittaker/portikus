# 0016. Automatic task merges with epic-level review

- **Status**: Accepted
- **Date**: 2026-09-18
- **References**: SPEC.md §29; STACK.md §31; CLAUDE.md "Review and merge rules"

## Context

An epic splits into many small task pull requests. Waiting for a human to
review and merge each one interrupted the orchestrator between every task,
even though the change a task pull request makes is checked again anyway
once the epic is reviewed as a whole. Reviewing every task pull request by
hand also duplicated the review the epic pull request already gets: the
same lines were read twice, once small and once in context.

## Decision

A task pull request into an epic branch is merged by the merger agent as
soon as its continuous integration run is green, one at a time, squash
merge, branch deleted after. No person reviews a task pull request. The
user's review happens once, at the epic level: after every task pull
request has landed, security-reviewer (when the epic touches auth, the
preview gateway, the workspace agent, file APIs, Incus, or nested Docker)
and code-reviewer run over the epic branch's head, findings are fixed or
deferred through further task pull requests that are also merged by merger
without review, and a confirmation review follows. Only then does the
orchestrator open the epic pull request into `main`, which the user reviews
and merges. `.claude/settings.json` grants agents permission to run
`gh pr merge` and read-only `gh` calls, which is what makes merger's
automatic merges possible without a person approving each one.

## Consequences

Task pull requests land as soon as their checks pass, so a batch of small
changes clears in the time continuous integration takes, not in the time it
takes a person to read each one, and the bookkeeping is done by a cheap
model instead of the orchestrator. The cost is that a bad task pull request
reaches the epic branch before any human has seen it; the epic-level review
and the full local test battery are what catch it, and `main` stays
protected because only an epic pull request, reviewed and merged by the
user, ever changes it.
