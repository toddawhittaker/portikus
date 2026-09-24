# 0027. API egress by hostname through a Squid forward proxy

- **Status**: Proposed
- **Date**: 2026-09-24
- **References**: SPEC.md sections 23 and 24; STACK.md sections 15 and 29;
  docs/EPIC-14.md rulings 25 to 29; ADR 0025

## Context

The API's systemd unit may reach only loopback and the workspace bridge
(`IPAddressAllow`), so a compromised API cannot reach the internet. It
must still reach its sign-in provider and each LMS's keyset. Until now an
operator added the provider's address ranges by hand
(`PORTIKUS_API_IP_ALLOW`). That works for an address that does not move.
Entra ID, Google and cloud LMS keysets are served from content delivery
networks whose addresses change without notice and are shared with other
sites, so a range is either stale or far too wide.

## Decision

Squid, from Debian, runs on `127.0.0.1:3128` as a forward proxy. It allows
only `CONNECT` to port 443 of hostnames in a list Ansible writes, refuses
any destination that resolves to a private, loopback or link-local
address unless that exact address is listed, and caches nothing. Ansible
builds the list from the provider's discovery document, the LMS keyset
URLs and an operator's extra hosts.

The API unit keeps its `IPAddressAllow` for loopback and the workspace
bridge. The API passes a proxy-aware `fetch` (undici's `ProxyAgent`) to
`openid-client` and to `jose`'s remote keyset, and to nothing else. Dex
uses the same proxy through `HTTPS_PROXY` for an upstream connector.
`PORTIKUS_API_IP_ALLOW` is removed.

## Consequences

- A request that skips the proxy fails, because the unit still denies
  every other address. The proxy decides by name; TLS stays end to end,
  so Squid never sees a token.
- One more service on the host. If it stops, SSO sign-ins and LMS
  launches stop; the smoke test checks it.
- Rejected: nftables sets filled from DNS answers (a CDN address serves
  many sites, and answers rotate faster than a set is refreshed);
  allowing `0.0.0.0/0` (removes the limit); a Caddy forward-proxy plugin
  (a custom Caddy build); tinyproxy (smaller, but its host filter is a
  regular expression and its CONNECT handling is less proven); and
  setting `HTTPS_PROXY` for the whole API process (the agent client's
  workspace addresses would need a `NO_PROXY` list, which Node does not
  read as address ranges).
