# 0043. Blocked sites in open mode

- **Status**: Proposed
- **Date**: 2026-09-27
- **References**: SPEC.md sections 20.1, 23.1 and 24.9, issue #284, ADR 0038

## Context

ADR 0038 gives workspaces two egress modes: open, which reaches any public site, and allow-list, which reaches only listed names. An administrator asked to block a few sites without listing everything else. A third mode would double the states the helper, the page and the tests must handle, so this adds a list to open mode instead.

## Decision

**A list, not a mode.** Blocked sites are host names, checked like allow-list entries (no URL, wildcard or address), each with a label, at most 500. A name also blocks every name under it. The list applies only in open mode; allow-list mode ignores it, because it already refuses what it does not list, and the Network tab says so. Open mode with an empty list is exactly open mode as it was: no DNS redirect and no proxy.

**Storage.** A table of its own, `egress_blocked_entries` (migration 0030), rather than a new kind on `egress_entries`. The allow-list's code, limits and unique names stay as they were, and a name may be both allowed and blocked. Writes go through `POST`, `PUT` and `DELETE /admin/egress/blocked-sites`, raise the policy version like every egress write, and leave one audit row each (`egress.block_added`, `egress.block_updated`, `egress.block_removed`).

**No default list.** The table starts empty, so open mode stays exactly as it was until an administrator blocks something. We considered seeding the public DNS over HTTPS services, but a non-empty list changes every open-mode workspace's network at the site's first egress write: QUIC is dropped, only TLS or HTTP works on ports 443 and 80 (so `ssh.github.com:443` and similar tunnels stop), and all DNS goes through our resolver. That must be the administrator's choice. The DNS over HTTPS services (such as cloudflare-dns.com, dns.google, dns.quad9.net, one.one.one.one and doh.opendns.com) are a suggestion the administrator may add, since a tool that uses them looks names up past our resolver.

**Enforcement.** The worker sends `blocked` (sorted names, empty unless open mode) with the expanded policy; the helper's schema refuses blocked names in allow-list mode. In open mode with a non-empty list:

- The helper's table redirects workspace DNS to the gateway (TCP and UDP 53) to our dnsmasq on port 5300, and drops other DNS on 53 and 853, as in allow-list mode. It redirects TCP 80 and 443 to every address outside the denied private ranges to Squid, and drops UDP 443 so QUIC cannot pass Squid by address (clients fall back to TCP). Nothing else is dropped, and there is no names set.
- Our dnsmasq forwards every name to the upstream (`server=/#/<upstream>`) except the blocked ones, which go to the worker's counter and get NXDOMAIN.
- Squid refuses a blocked TLS name (`ssl_bump terminate`) or HTTP Host, and splices everything else. Its lists are three helper-written files: `names.txt` (allowed names), `blocked.txt` (blocked sites) and `open.txt`, which holds a single `.` while open mode has blocked sites and is empty otherwise. The `.` is a regular expression that matches every name, so one static Squid configuration serves both modes. Denied ranges are still terminated. Refusals reach the counter as before, and a spliced open-mode connection is never logged.
- Each workspace may hold at most 256 open connections to Squid, in either mode. A rule in the table's input chain counts them per source address (`ct count`) and resets the next one, so one workspace cannot exhaust the single Squid every workspace shares.
- Squid lets a WebSocket upgrade through (`http_upgrade_request_protocols`), as it would pass without the proxy.
- NAT is decided when a connection starts, so a connection opened before a block would survive it. When the blocked list changes, the helper deletes the conntrack entries of TCP connections from the workspace subnet to ports 80 and 443, the ones the table redirects (`conntrack -D -s <subnet> -p tcp --dport`, with the subnet from `egress.env`); a connection that bypassed the proxy (opened in plain open mode) is then judged again by the new table. A connection already going through Squid is not cut: Squid's reload keeps open sockets, so it runs until it closes, and only new connections meet the new list.
- Going from plain open mode to open mode with blocked sites, the helper writes dnsmasq's and Squid's files and restarts or reloads them before it loads the table. Nothing reaches them until the table redirects, and a Squid still reading empty lists would refuse, and count, every ordinary name for the first moments. Going from blocked sites to allow-list mode, Squid's files and reload come first, so Squid never splices an unlisted name on a listed address while its open switch is still on; dnsmasq follows the table, whose flush would drop what it learned. Any failure stops the rest and leaves the old table and `applied.json`, so the worker retries.
- Failures fail closed as in allow-list mode: at boot, a policy with blocked sites that cannot be loaded drops workspace forwarding. An `applied.json` written before this change has no `blocked` field and reads as none.

"Test a host" explains a block ("Blocked by your list: games.com (Games)"), from the same `explainHost` the renderers' tests use.

## Consequences

- While any site is blocked, all workspace web traffic on ports 80 and 443 passes through the workspace Squid, and all DNS through our dnsmasq. That costs some latency and makes both services load-bearing for every workspace, not only for allow-list sites. The page says so.
- Squid never decrypts anything. It reads only the TLS name or the HTTP Host.
- **Blocking is best effort against casual use,** not a control a determined student cannot pass. DNS services on other ports or reached as DNS over HTTPS that are not on the list, direct addresses, TLS with no name, and tunnels on ports other than 80 and 443 all get round it. Only allow-list mode stops a determined student. The Network tab says so.
- A blocked site reached by a hard-coded address with no TLS name, or with a false name, is not refused. That includes DNS over HTTPS by address, such as `https://1.1.1.1/dns-query`. Blocking by name cannot stop this; allow-list mode does.
- Our dnsmasq keeps `stop-dns-rebind`, so a public name that answers with a private address gets no answer; those addresses are unreachable anyway.
- A protocol other than TLS on port 443 no longer works while a site is blocked, because Squid expects TLS there.
- Only ports 80 and 443 are checked. A blocked site on another port is refused only through DNS.
- Because nothing is seeded, upgrading a site changes nothing for its workspaces.
- Blocking a site cuts the web connections on ports 80 and 443 that bypassed the proxy, which are judged again; clients reconnect. A connection to a newly blocked site that already goes through Squid keeps working until it closes, because Squid is reloaded, not restarted: a restart would cut every workspace's proxied connections. Connections on other ports carry on.
