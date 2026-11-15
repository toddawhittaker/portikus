# 0077. One operation catalog, and an OpenAPI document built from it

- **Status**: Accepted (Epic 68)
- **Date**: 2026-11-15
- **References**: SPEC.md sections 5.2, 20.4, 24.13 and 27; STACK.md sections 5 and 35; ADR 0078, ADR 0079; issue #1221

## Context

Epic 68 lets an administrator or instructor give a program an API key.
Something must say which of the API's routes a key may run, how risky each
is, and who may run it. The same list must feed the scope check, the
Model Context Protocol (MCP) tools, and an OpenAPI document that issue
#1221 asked for. Two facts shape the choice. Routes here validate their
input by hand with `parseOr400`, so a route definition holds no schema a
tool could read. And `ROUTE_POLICY` already lists every route with its
access class, and a test proves it matches the registered routes.

## Decision

1. **A central catalog, not metadata on each route.** The catalog lives
   in `apps/api/src/catalog/`, with one file for each family of routes
   (people, workspaces, site, courses). Each record is keyed by
   `"METHOD url"`, the same key `ROUTE_POLICY` uses. No route file changes.
   Each record holds a stable name, a one-sentence description, a risk, an
   audience, whether it is a named MCP tool, and its Zod input schemas.
2. **Every route is classified.** A route is either an exposed operation
   or on `not-exposed.ts` with a reason. The coverage test reads
   `ROUTE_POLICY` and fails for any route that is neither, for a catalog
   key that names no route, for a duplicate name, for an audience that
   disagrees with the route's access class, and for a schema that does not
   convert to JSON Schema. A new route therefore cannot ship without
   someone deciding whether a key may run it.
3. **A never list.** Some routes are marked `never` and pinned by a test:
   the root shell, key management, password and second-factor changes,
   account linking, changing where reset links go, and any route whose
   request or answer carries a secret. No scope reaches them.
4. **Three risk levels.** `read` changes nothing, `change` can be undone or
   redone, and `destructive` cannot be undone or hands out a new way in
   (promoting an administrator, rebuilding a workspace, deleting a
   backup). A key's scope is one ordered level over these (ADR 0078).
5. **OpenAPI from the catalog, by hand.** The document is OpenAPI 3.1,
   built with Zod 4's own `z.toJSONSchema` and served at `/openapi.json`.
   It describes exposed operations only. No Zod-to-OpenAPI package is
   added (STACK.md section 5).

## Consequences

- One list answers three questions: what a key may run, what an MCP client
  sees, and what the document says. They cannot drift apart.
- Adding a route now takes a second edit, a catalog record or a
  not-exposed line. That is the point: the test makes the choice explicit.
- A record's schema is written beside the route's own `parseOr400` call,
  not shared with it. A parity test that runs each operation compares the
  catalog with what the route accepts; without it the two could differ.
- The document leaves out browser-only routes, so it is the keys'
  contract, not a map of the whole API.

## Alternatives rejected

- **Metadata on each route** (a `config` block read by a Fastify hook).
  It touches over a hundred route files, spreads one decision across all
  of them, and still could not name the schemas, because routes validate by
  hand. A central file is reviewed as one table.
- **A Zod-to-OpenAPI package** (`fastify-zod-openapi` and similar). It
  reads schemas off route definitions, which here do not hold them, and
  adds a dependency and a second schema dialect for what one function does.
- **Exposing every route and hiding the risky ones.** A new route would be
  open to keys by default. Not exposed by default fails safe.
