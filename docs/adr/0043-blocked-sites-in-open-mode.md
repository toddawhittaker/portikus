# 0043. Blocked sites in open mode

- **Status**: Proposed
- **Date**: 2026-09-27
- **References**: SPEC.md sections 20.1, 23.1 and 24.9, issue #284, ADR 0038

## Context

ADR 0038 gives workspaces two egress modes: open, which reaches any public site, and allow-list, which reaches only listed names. An administrator asked to block a few sites without listing everything else. A third mode would double the states the helper, the page and the tests must handle, so this adds a list to open mode instead.

## Decision

**A list, not a mode.** Blocked sites are host names, checked like allow-list entries (no URL, wildcard or address), each with a label, at most 500. A name also blocks every name under it. The list applies only in open mode; allow-list mode ignores it, because it already refuses what it does not list, and the Network tab says so. Open mode with an empty list is exactly open mode as it was: no DNS redirect and no proxy.

**Storage.** A table of its own, `egress_blocked_entries` (migration 0030), rather than a new kind on `egress_entries`. The allow-list's code, limits and unique names stay as they were, and a name may be both allowed and blocked. Writes go through `POST`, `PUT` and `DELETE /admin/egress/blocked-sites`, raise the policy version like every egress write, and leave one audit row each (`egress.block_added`, `egress.block_updated`, `egress.block_removed`).

**The default list.** The migration seeds the public DNS over HTTPS services once (`EGRESS_DEFAULT_BLOCKED_SITES` in `packages/contracts`: cloudflare-dns.com, dns.adguard-dns.com, dns.google, dns.nextdns.io, dns.quad9.net, doh.cleanbrowsing.org, doh.opendns.com, one.one.one.one), so a tool cannot look a blocked name up past our resolver. Each was checked to answer DNS over HTTPS queries. They are ordinary rows the administrator may remove, marked "default" on the page. They are rows and not a constant with a "removed" flag, because a row needs no second piece of state. Like any policy, they take effect with the administrator's first egress change: until then the worker applies nothing (ADR 0038), and the page says so.

**Enforcement.** The worker sends `blocked` (sorted names, empty unless open mode) with the expanded policy; the helper's schema refuses blocked names in allow-list mode. In open mode with a non-empty list:

- The helper's table redirects workspace DNS to the gateway (TCP and UDP 53) to our dnsmasq on port 5300, and drops other DNS on 53 and 853, as in allow-list mode. It redirects TCP 80 and 443 to every address outside the denied private ranges to Squid, and drops UDP 443 so QUIC cannot pass Squid by address (clients fall back to TCP). Nothing else is dropped, and there is no names set.
- Our dnsmasq forwards every name to the upstream (`server=/#/<upstream>`) except the blocked ones, which go to the worker's counter and get NXDOMAIN.
- Squid refuses a blocked TLS name (`ssl_bump terminate`) or HTTP Host, and splices everything else. Its lists are three helper-written files: `names.txt` (allowed names), `blocked.txt` (blocked sites) and `open.txt`, which holds a single `.` while open mode has blocked sites and is empty otherwise. The `.` is a regular expression that matches every name, so one static Squid configuration serves both modes. Denied ranges are still terminated. Refusals reach the counter as before, and a spliced open-mode connection is never logged.
- Failures fail closed as in allow-list mode: at boot, a policy with blocked sites that cannot be loaded drops workspace forwarding. An `applied.json` written before this change has no `blocked` field and reads as none.

"Test a host" explains a block ("Blocked by your list: games.com (Games)"), from the same `explainHost` the renderers' tests use.

## Consequences

- While any site is blocked, all workspace web traffic on ports 80 and 443 passes through the workspace Squid, and all DNS through our dnsmasq. That costs some latency and makes both services load-bearing for every workspace, not only for allow-list sites. The page says so.
- Squid never decrypts anything. It reads only the TLS name or the HTTP Host.
- A blocked site reached by a hard-coded address with no TLS name, or with a false name, is not refused. That includes DNS over HTTPS by address, such as `https://1.1.1.1/dns-query`. Blocking by name cannot stop this; allow-list mode does.
- Our dnsmasq keeps `stop-dns-rebind`, so a public name that answers with a private address gets no answer; those addresses are unreachable anyway.
- A protocol other than TLS on port 443 no longer works while a site is blocked, because Squid expects TLS there.
- Only ports 80 and 443 are checked. A blocked site on another port is refused only through DNS.
- Because the seeded list is not empty, a site's first egress change after this migration also turns on the proxy path in open mode, unless the administrator removes the defaults.
