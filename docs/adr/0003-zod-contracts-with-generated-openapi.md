# 0003. Zod schemas are the single source of API contracts

- **Status**: Accepted
- **Date**: 2026-09-15
- **References**: STACK.md section 5, SPEC.md sections 5.2 and 27

## Context

Contracts cross four process boundaries in Portikus: browser, API,
workspace controller, and workspace agent. A TypeScript type alone gives no
runtime validation, and a hand-written OpenAPI document drifts from the code it
claims to describe. Student code is untrusted, so every request body reaching
the control plane must be validated at runtime, not just type-checked.

tRPC would remove the duplication but would couple the external API to
TypeScript function calls, which blocks a future CLI, instructor tooling, or
non-TypeScript client.

## Decision

Define every HTTP body, WebSocket payload, agent protocol message, and
configuration object as a Zod schema in `packages/contracts` (configuration in
`packages/config`). The TypeScript type is inferred from the schema, never
written separately. The API validates with the same schema it publishes, and
the OpenAPI document is generated from those schemas rather than written by
hand. Use REST for durable resource operations and WebSockets for event
streams. No tRPC, no GraphQL.

## Consequences

- One definition produces the runtime validator, the static type, and the
  published schema, so the three cannot drift.
- Non-TypeScript clients get a real OpenAPI document.
- The cost is that contracts must be expressible in Zod and that the generated
  OpenAPI is only as good as the schema annotations we write.
