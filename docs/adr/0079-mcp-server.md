# 0079. An MCP server on the API, on the version 2 SDK, with named tools and a find and run pair

- **Status**: Accepted (Epic 68)
- **Date**: 2026-11-15
- **References**: SPEC.md sections 20.4, 24.1 and 24.13; STACK.md sections 4 and 35; ADR 0077, ADR 0078

## Context

Claude Code and Codex use tools through the Model Context Protocol (MCP).
Epic 68 lets them run the operations an API key allows. The SDK
(`@modelcontextprotocol/server`) has a version 1 and a version 2. Version 1
pulls in Express, a web framework this API does not otherwise run. Version
2's `createMcpHandler` takes a Web `Request` and returns a Web `Response`.
The MCP specification makes OAuth optional, and both clients accept a fixed
`Authorization` header and then do not start OAuth.

## Decision

1. **Version 2 of the SDK**, `@modelcontextprotocol/server` 2.4.0 pinned
   exactly. Todd chose version 2 for future support (2026-11-15).
2. **Our own bridge.** A file under 50 lines turns a Fastify request and its
   already-parsed body into a Web `Request`, calls `handler.fetch`, and
   writes the `Response` back. `@modelcontextprotocol/node` needs the raw
   request body, which Fastify has already read, and
   `@modelcontextprotocol/fastify` builds a separate app with its own
   routing and sign-in. Neither fits one app with one auth plugin.
3. **A fresh server for each request.** The server is built per request
   from the key's owner and scope, so it lists only the tools they may run
   and keeps no session. A Portikus restart or a second API process loses
   nothing.
4. **A static bearer key, not OAuth.** `/mcp` accepts API keys only. A bad
   or missing key gets 401 with `WWW-Authenticate: Bearer` and no
   `resource_metadata`, and the site serves no `/.well-known/oauth-*`
   document, so a client does not start an OAuth flow. Any `Origin` but the
   site's own is refused.
5. **Named tools plus two general ones.** The catalog marks the common
   operations (38) as named tools, such as `workspaces_stop` (the
   operation's name with an underscore for the dot, which every client
   accepts). Every other operation is reached with `find_operation`, which
   searches the operations this key may run and returns their input
   schemas, and `run_operation`, which runs one by name. Tools carry `readOnlyHint` and
   `destructiveHint` from the operation's risk.
6. **The in-process runner.** A tool call runs the route with `app.inject`,
   with the caller's own key and address and a path built only from the
   catalog's pattern, so the route's validation, role and course checks and
   audit run unchanged. There is no internal identity that skips them.
7. **Bounded results.** Compact JSON, capped near 50,000 characters, with
   errors as `isError` and a code and message.
8. **Results are data.** Names, titles, messages and log text come from
   users, so a model could read them as orders. The server sends
   instructions saying they are data, never instructions, and repeats the
   sentence in each tool's description.
9. **Refusals mirror HTTP.** `run_operation` answers an unknown name with
   `NOT_AVAILABLE_TO_API_KEYS` and a bad path value (`.`, `..`, or
   anything with `/`) with `VALIDATION_FAILED`, and passes a route's own
   codes through. A call refused before it reaches a route writes an
   `api_key.used` row with the attempted name.

## Consequences

- A client holds one key and one header. Revoking the key ends the tools.
- The runner cannot do anything a key could not do over HTTP, and each run
  writes the usual `api_key.used` row (ADR 0078).
- A new major SDK release is a deliberate upgrade, not an accident.
- The bridge is ours to keep working when the SDK or Fastify changes.
- No resources, prompts or OAuth now. A later epic may add them.

## Alternatives rejected

- **One tool for each operation** (about 100). Every client turn would
  carry the whole list, which costs students' usage and crowds the model's
  choice. Thirty-eight named tools cover common work; the pair covers the
  rest on demand.
- **OAuth.** More moving parts (a metadata document, a consent screen,
  token refresh) than a handful of staff need, for no extra safety over a
  revocable, expiring, scoped key.
- **Version 1 of the SDK.** It would add Express and an older API.
