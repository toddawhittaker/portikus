# 0008. Server-side sessions and an in-repo mock identity provider

- **Status**: Accepted
- **Date**: 2026-09-16
- **References**: STACK.md §8, §12, §27; SPEC.md §5, §24

## Context

SPEC §5 requires login through OpenID Connect (OIDC), roles from group claims,
deny by default, and sessions that can be revoked at once. The pilot has no
identity provider to point at, and the VM has no container runtime, because ADR
0007 packages the control plane as Node only. Yet tests, continuous
integration, and the VM all need something to log in against.

## Decision

Login uses the Authorization Code flow with PKCE (proof key for code exchange)
through the `openid-client` library. A session is a row in Postgres, keyed by
an opaque token in an HttpOnly, SameSite=Lax cookie; deleting the row revokes
it at once, and each session has an absolute lifetime. The session secret is
generated on the VM like the controller token. Cross-site request forgery is
blocked by checking `Sec-Fetch-Site` and `Origin`, with no library.

The test identity provider is a mock OIDC server in `packages/auth`. Tests run
it in process, Playwright runs it as a process, and the Debian package ships it
as a fourth systemd unit, disabled by default and switched on only by the
Ansible flag `portikus_mock_idp`. Caddy, with its internal certificate
authority, fronts the VM so a browser can finish the redirect.

**Rejected:** Dex needs a container runtime, and its static-password connector
cannot emit the group claims the role mapping needs. Keycloak is a Java server
far heavier than the pilot needs. Signed cookies holding the whole session
cannot be revoked at once, which SPEC §5.3 requires.

## Consequences

Moving to a real identity provider is configuration only: the `PORTIKUS_OIDC_*`
values and `PORTIKUS_MOCK_IDP=false`. The mock is a production hazard,
mitigated by loopback binding, the disabled unit, and the flag. The real client
secret travels through the environment until SOPS (STACK §27) is wired up, a
known gap. Every route and WebSocket upgrade needs a session, so the smoke test
logs in first.
