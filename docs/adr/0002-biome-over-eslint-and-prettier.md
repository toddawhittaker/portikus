# 0002. Biome instead of ESLint plus Prettier

- **Status**: Accepted
- **Date**: 2026-09-15
- **References**: STACK.md section 14, SPEC.md section 29 (Epic 0)

## Context

The repository needs one linting and formatting standard that humans and coding
agents both follow. The usual choice, ESLint plus Prettier, means two tools, two
configuration files, a plugin set per framework, and a shared-config dependency
tree that needs maintenance of its own. It is also slow enough that agents are
tempted to skip it.

## Decision

Use Biome as the single linter and formatter for all TypeScript, JavaScript,
JSON, and config files, configured in `biome.json` at the repository root.
`pnpm lint` checks; `pnpm lint:fix` and `pnpm format` rewrite.

If a library ever needs an ESLint-specific rule that materially improves safety,
add ESLint narrowly for that rule rather than replacing Biome.

## Consequences

- One tool, one configuration file, and a lint pass fast enough to run on every
  save and in every agent loop.
- Fewer dependencies to audit and upgrade.
- The cost is a smaller rule catalogue than the ESLint ecosystem, and no
  plugin for rules that only exist as ESLint plugins today. We accept the gap
  and will add ESLint narrowly if a specific rule earns it.
