# 0001. TypeScript monorepo managed with pnpm

- **Status**: Accepted
- **Date**: 2026-09-15
- **References**: STACK.md sections 1 and 2, SPEC.md section 29 (Epic 0)

## Context

Portikus is five processes — browser UI, control-plane API, worker, workspace
controller, and workspace agent — that share a large number of contracts across
process boundaries: lifecycle events, terminal and filesystem events, Git
status, preview metadata, and WebSocket messages. A change to any of those
contracts must reach every side at once.

Splitting these into separate repositories would make an atomic contract change
impossible and would require publishing internal packages to change a type.

## Decision

Use TypeScript in strict mode for every process, on the current Node.js LTS
(pinned in `.nvmrc`), in a single pnpm workspace monorepo. Apps live under
`apps/`, shared libraries under `packages/`, infrastructure under `infra/`.
Dependency versions are pinned exactly and `pnpm-lock.yaml` is committed.

## Consequences

- One TypeScript version, one lint and format configuration, one test runner.
- A contract change and every call site update land in one commit.
- Every check runs from the repository root, so CI and agents need one command
  set rather than one per project.
- The cost is repository-wide coupling: a bad dependency upgrade can break
  everything at once, and the checkout grows as the system grows. We accept
  that for P0; splitting later needs a concrete operational reason.
