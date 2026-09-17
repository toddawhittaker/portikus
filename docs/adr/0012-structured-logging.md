# 0012. Structured logging with pino and a runtime log level

- **Status**: Accepted
- **Date**: 2026-09-17
- **References**: STACK.md sections 13 and 15, SPEC.md sections 25.6 and 24.11

## Context

A smoke-test failure took an hour to trace because the API logged nothing
about the request that failed. Every service ran Fastify with logging off,
the API and the workspace agent each carried a small hand-written JSON
logger, the worker printed with `console.log`, no response with a 4xx status
was logged anywhere, and there was no way to ask for more detail without
editing code and redeploying.

## Decision

One shared logger package, `packages/observability`, built on pino, used by
the API, the worker, the workspace controller, the workspace agent, and the
mock identity provider. Each process creates exactly one root logger; every
line carries the service name, the level as a word, and an ISO timestamp.
Authorization and cookie headers and keys named `token`, `agent_token`,
`agentToken` or `clientSecret` are replaced with `[redacted]`, two to three
levels deep. That is a backstop, not a guarantee: the rule people keep is to
log named fields only, never a whole database row, config object or request
object (SPEC.md 24.11).

Fastify takes that logger as `loggerInstance`, and its own two lines per
request are turned off. Instead one hook writes a single line per response:
method, route, path without the query string, status, duration, request id,
and the signed-in user and workspace when they are known. When the response
is a JSON error body, the hook reads the code and message out of it and puts
them on the same line, so every 4xx and 5xx is visible without touching the
place that produced it.

Each service reads its starting level from `LOG_LEVEL` in the environment.
The single `settings` row gains a `log_level` column that overrides that
level everywhere while the system runs; null means each service keeps its
own environment value. An administrator sets it on the `/admin` page. The
API relays the level to running workspace agents, and the worker relays it
to the controller, because those are the processes that already hold the
credentials for each hop. Health checks log at debug, so routine polling
does not bury real traffic. Development uses `pino-pretty`; everywhere else
the output is JSON for the journal. `pino-pretty` is a development
dependency and is not in the Debian package, so `NODE_ENV=development` on a
VM would fail at startup; Ansible pins production.

Test coverage is measured in CI with a floor of 80 percent of lines and 70
percent of branches overall, and 85 percent of lines in the API and the
workspace agent.

## Consequences

Tracing a failed request now takes one `journalctl` command, and turning on
debug takes a form on the admin page rather than a deployment. The cost is a
new runtime dependency in every service, one more column of shared state,
and a rule people have to keep: hold no long-lived child loggers, because a
child copies the level it was created with and would ignore the switch.
Pushing the level out to agents and the controller is best effort; an agent
that restarts inside a running workspace keeps the environment level until
the next change. Metrics and tracing are not part of this decision; they
arrive with Epic 11.
