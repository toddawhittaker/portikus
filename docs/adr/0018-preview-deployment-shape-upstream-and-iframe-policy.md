# 0018 — Preview deployment shape, Caddy upstream resolution, and iframe policy

## Status

Accepted, 2026-09-21.

## Context

`docs/BROWSER-HANDLING.md` section 28 leaves three decisions open for
Epic 8 (SPEC.md Epic 8): which deployment shape the embedded preview
session is built and tested for, how Caddy learns a preview request's
upstream without trusting request text, and which iframe sandbox and
Permissions Policy the Preview tab ships with. The design says an agent
may start without them but must not choose one silently.

## Decision

1. **Same-site deployment only.** Preview hosts live under
   `*.preview.<application host>` (design section 7.1). The embedded
   preview session is a host-only `__Host-` cookie with `SameSite=Strict`.
   The separate registrable preview domain with partitioned cookies
   (section 7.2) is documented as unsupported until a later task tests it
   in supported browsers.
2. **Trusted response header for the upstream.** Caddy's `forward_auth`
   calls the API's authorization endpoint over the service network. The
   API resolves the workspace and port from its own registry and returns
   the internal upstream in a response header, which Caddy copies into the
   reverse proxy's upstream. Stock Caddy, no custom module, no
   configuration reloads. The header is honoured only from the
   authorization endpoint, never from a client.
3. **Iframe policy as the design baseline** (section 12): `sandbox`
   allows scripts, same-origin, forms, modals, popups, downloads, and
   pointer lock; `allow` grants clipboard-write to self and denies camera,
   microphone, and geolocation; no `allow-top-navigation`. A Playwright
   test proves a typical course application works under it.

## Consequences

The pilot's nip.io hostname and Caddy's internal certificate authority
serve the same-site shape without new DNS. Institutions that want a
separate preview domain wait for a follow-up task and its browser
matrix; the residual related-domain risks of section 9.3 must be covered
by threat-model tests in this epic. The upstream lookup costs one
subrequest per request and WebSocket upgrade, which the design already
requires for authorization. Media-course applications that need camera
or microphone use Open in new tab.
