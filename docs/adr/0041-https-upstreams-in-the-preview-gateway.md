# 0041. HTTPS upstreams in the preview gateway

- **Status**: Proposed (Epic 24, task T16; T17 builds the Caddy half)
- **Date**: 2026-09-27
- **References**: SPEC.md sections 14.5 and 24.7; BROWSER-HANDLING.md sections 10, 11.1 and 16.3; ADR 0018; issue #283

## Context

Some development servers serve HTTPS on their port, for example
`vite --https`, often with a self-signed certificate. The preview gateway
(Caddy) spoke only plain HTTP to the workspace, so such a port showed a
broken frame. Step 1 of issue #283 made the failure honest: the workspace
agent now tries a TLS handshake once per new student listener and reports
`protocolHint: "https"` when it completes, and the API answered such a port
with a 503 page.

## Decision

The gateway speaks TLS to a port the agent found speaking TLS.

- `/preview/authorize` answers every authorized request with a second
  trusted header beside `X-Portikus-Upstream`:
  `X-Portikus-Upstream-Scheme: https` when the listening registry's hint for
  that port is `https`, and `X-Portikus-Upstream-Scheme: http` otherwise
  (including `unknown`). The value comes only from the registry. The API
  never reads a copy of the header from the request.
- Caddy strips any client-sent `X-Portikus-Upstream-Scheme`, as it strips a
  forged `X-Portikus-Upstream`, copies the header from `forward_auth`, and
  uses a second `reverse_proxy` with a TLS transport and certificate checks
  off only when the header says `https` (T17). The header rules of the plain
  proxy are shared, not copied. WebSocket upgrades use the same hop.
- The API's framing probe (`apps/api/src/preview/embeddable.ts`) asks such a
  port over HTTPS, also with certificate checks off, at the same registry
  target.
- The step 1 page and the Preview tab's "speaking HTTPS" notice are removed.

## Why certificate checks are off on this hop

The upstream is a student's own development server on the workspace's
private address, reached only after authorization, at a target named by the
registry (BROWSER-HANDLING.md section 16.3). Its certificate is normally
self-signed and names `localhost`, so a check would fail for every real
case. The TLS on this hop protects nothing the bridge network does not; it
exists because the student's server insists on it. The browser still sees
only the platform's certificate.

## Consequences

- A student can preview `vite --https` and similar servers, hot reload
  included, without changing their setup.
- The target of the TLS hop is still only the registry's, so turning checks
  off cannot be used to reach anything a plain preview could not.
- A port whose TLS handshake the agent missed is proxied over HTTP and fails
  as before; restarting the server gives the agent a new listener to probe.
