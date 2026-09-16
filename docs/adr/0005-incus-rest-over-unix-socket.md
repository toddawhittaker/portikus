# 0005. Incus REST API over unix socket

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: STACK.md §9, §24; SPEC.md §24, §25.7

## Context

The workspace controller must talk to Incus to create, start, stop, and
list workspace instances. The Incus daemon exposes a REST API over a local
unix socket and also accepts CLI commands. We need to choose which
interface to use and how to expose it to the rest of the control plane.

## Decision

The controller uses the Incus REST API over the local unix socket
(`/var/run/incus/unix.socket`) via Node's built-in `node:http` module
with the `socketPath` option. The controller is the only process with
access to the socket. The API and worker reach the controller through a
narrow HTTP interface on `127.0.0.1` authenticated with a bearer token
checked using `timingSafeEqual`.

**Rejected alternatives:**

- Spawning the `incus` CLI: requires shell escaping, loses structured
  JSON errors, and adds one process spawn per operation.
- undici with a socket dispatcher: ties the socket transport to undici's
  dispatcher API, which has broken across major versions and conflicts
  with Node's built-in global fetch.

## Consequences

- Zero runtime dependencies for the Incus integration.
- Structured JSON responses with typed error codes from the Incus API.
- The controller is the only trust boundary between the platform and
  Incus; every other process goes through its validated HTTP interface.
- We must handle the Incus async-operation protocol (202, wait, poll)
  ourselves rather than relying on a client library.
