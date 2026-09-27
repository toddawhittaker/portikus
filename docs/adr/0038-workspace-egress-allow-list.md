# 0038. Workspace egress allow-list: our own resolver, a root-owned table, and Squid by name

- **Status**: Proposed (Epic 24, task T4; T5 adds the infrastructure facts)
- **Date**: 2026-09-27
- **References**: SPEC.md sections 20.1, 23 and 24; ADRs 0027, 0030; issue #284

## Context

Administrators want to limit what workspaces reach on the internet. The
rule must be by host name (`github.com` and its subdomains), because the
addresses of content delivery networks are shared and change often
(ADR 0027 rejected address lists for the same reason). It must not
decrypt anyone's traffic. It must take effect within seconds for every
running workspace, survive a reboot, and fail closed. Open mode, today's
behaviour, stays the default. The private-range deny list stays in force
in both modes.

## Decision

In allow-list mode, three layers each check the name:

1. **DNS.** A dnsmasq of our own, `portikus-egress-dns.service`, listens
   on the bridge gateway on port 5300, running as `nobody` with only
   `CAP_NET_ADMIN`. The firewall redirects workspace DNS (TCP and UDP 53
   to the gateway) to it. Each listed name is sent to the upstream
   (systemd-resolved at 127.0.0.53 by default) and every address it
   answers goes into the nftables set `names_v4` through dnsmasq's
   `nftset`. Every other name goes to the worker's counter on
   127.0.0.1:5399, which answers NXDOMAIN. `.incus` names still go to
   Incus's own dnsmasq. The file also sets `no-resolv` (so a stopped
   counter fails closed), `stop-dns-rebind` (so a listed name cannot put a
   private address in the set), and a 300-second cap on TTLs.
2. **The firewall.** A table of its own, `inet portikus_egress`, that
   Ansible's nftables configuration never touches. Its forward chain
   drops DNS and DNS over TLS to anywhere, then accepts TCP on the
   allowed ports only to `names_v4` and to the administrator's ranges,
   then drops everything else from the bridge, UDP and IPv6 included.
   The names set has no timeout (dnsmasq's add never refreshes one; T1
   proved it) and is capped at 65,535 entries, failing closed when full.
3. **TLS and HTTP names.** Connections to a `names_v4` address on 443 and
   80 are redirected to a workspace Squid on the gateway (3130 and 3129),
   which reads the TLS SNI or the HTTP `Host`, splices (never decrypts)
   only listed names, and refuses the rest. So an address shared by a CDN
   cannot reach an unlisted site on it. A redirect is rendered only for a
   port the policy allows, because redirected traffic skips the forward
   chain's port rule. Squid runs as its own system user,
   `portikus-wsproxy`, which owns nothing else and is the only reader of
   its certificate's key.

**Squid's own lookups.** Squid resolves the `Host` a workspace sends,
listed or not. Through Incus's dnsmasq that lookup would reach the
internet for any name, so a workspace could spell data into a name and
send it out through DNS. So in allow-list mode the table also has a nat
output rule: TCP and UDP 53 to the gateway from sockets owned by
`portikus-wsproxy` are sent (`dnat`) to our dnsmasq on port 5300, where an
unlisted name reaches only the counter. The rule matches the user, whose
id Ansible writes to `egress.env` as `EGRESS_PROXY_UID`, not the service's
cgroup: nft turns a cgroup path into an id when the rule loads, and a
restarted service gets a new cgroup, so the rule would silently stop
matching. The rule is rendered with the workspace DNS redirect, for every
mode in which our dnsmasq is the resolver.

**Who changes what.** The worker sees the settings' `egress_version`
ahead of the applied version, expands the presets, and sends the policy
to the controller's `PUT /egress-policy`. The controller only writes a
request file and waits up to 30 seconds for the answer. A root helper,
`/usr/lib/portikus/controller/dist/egress-apply-main.js`, started by a
systemd path unit (ADR 0030's pattern), moves the request into its own
directory, reads it without following links, caps its size at 256 KiB,
and checks every field with the same schema the controller used
(`EgressApplyPolicy` in `packages/contracts`), plus the denied ranges from
its own root-owned configuration `/etc/portikus/egress.env`. A name that
passes that check can hold only letters, digits, hyphens and dots, so no
newline, space, slash or `#` reaches dnsmasq, nft or Squid. The helper
then applies, in this order: the table (one `nft -f` transaction), our
dnsmasq's configuration and a restart (or a stop in open mode), Squid's
names file and a reload. It controls only those two services, only with
`reload`, `restart` and `stop`. It writes `applied.json` only after every
step worked, and a `status.json` the controller reads.

**Keeping and flushing learned addresses.** Each change reloads the rules
and the range and port sets, but keeps `names_v4` unless a name was
removed, the mode changed, or the previous request failed; then the set
is flushed. Clients heal on their next lookup, within the 300-second TTL
cap.

**Boot.** The same helper runs once at boot, after `nftables.service` and
before `incus.service`. Finding no table, it loads the last applied
policy and queues our dnsmasq with `--no-block`, since the bridge does not
exist yet. If that allow-list does not load, or `applied.json` cannot be
read, it loads a table that drops all forwarded workspace traffic. A site
that never applied a policy loads nothing and stays open, as today. A
pending request is taken before anything else, so a failed run never
leaves it for the path unit to start the helper again at once, and at
boot every service call is only queued (`--no-block`): our dnsmasq starts
after Incus, which waits for the helper, so waiting would hang until the
start timeout.

**A guard without Node.** If the helper cannot run at all (a crash, a
failed import, the memory cap, the timeout), the table would stay missing
and a last allow-list would come back open. The helper unit's
`ExecStopPost=` runs `/usr/lib/portikus/egress-guard.sh`, a short shell
script, after every run however it ended. When the table is missing and
`applied.json` exists but does not plainly record open mode (one line,
exactly one `"mode"` key, set to `"open"`), it loads
`/etc/portikus/egress-drop-all.nft`, which Ansible renders from the same
bridge variable as everything else; a unit test checks it matches the
helper's own drop-all table. Anything it cannot read fails closed.

**Blocked names.** The worker's counter answers NXDOMAIN on
127.0.0.1:5399 (UDP and TCP) and hears Squid's refusals as name-only UDP
lines on 127.0.0.1:5398. Only dnsmasq and Squid talk to it, so it never
learns which workspace asked; counts are site-wide by construction. It
keeps at most 2,000 names a day (the rest count as "(other names)"), 30
days in all, never stores an address, and drops reverse lookups, which
would spell one. A plain-HTTP `Host` Squid refuses is also looked up by
Squid itself, so such a name is counted under both sources.

## Consequences

- Allow-list mode fails closed at every layer: a stopped dnsmasq means no
  DNS, a stopped Squid means no web traffic, a full set adds nothing, and
  a failed boot load drops all forwarding.
- Removing a name can cut a client off for up to five minutes, until its
  cached answer expires and it looks up again.
- SSH and other ports keep only the address check, so an unlisted service
  that shares an address with a listed one is reachable on those ports.
  Few CDNs serve anything but 80 and 443.
- Encrypted Client Hello hides the real SNI behind a provider's public
  name, which Squid refuses unless listed.
- The controller keeps `NoNewPrivileges` and no network capabilities; the
  most it can do is ask for a policy that passes the helper's checks.
- An Incus upgrade reruns the egress security checks, since the ACL
  change (the gateway carved out of the drops for 3129, 3130 and 5300)
  depends on how Incus orders its rules.
- While `nftables.service` is stopped, the host's input chain is gone.
  The Incus ACL still drops TCP, UDP and ICMP to the gateway except the
  redirect targets, but not other IP protocols, so for that time a
  workspace can reach the host over, say, SCTP or GRE if something
  listens. Accepted: a stop is short and deliberate, and nothing on the
  VM listens on those protocols.

Rejected:

- **Setting `raw.dnsmasq` on Incus's own dnsmasq.** One fewer service,
  but T1 found that Incus drops dnsmasq's AppArmor profile whenever
  `raw.dnsmasq` is set, leaving an unconfined resolver that parses every
  workspace's DNS and holds `CAP_NET_ADMIN`. Each change also restarted
  Incus's dnsmasq, DHCP included.
- **`CAP_NET_ADMIN` for the controller.** Little safer in practice, and
  it gives neither the boot-time load ordered before Incus nor the
  service restarts.
- **Incus network ACLs rendered from resolved addresses** (the first idea
  in #284). Stale for CDNs, and an ACL cannot test a set that dnsmasq
  fills; Incus also puts every drop before every allow.
- **A timeout on the names set.** dnsmasq's add never refreshes an
  element's timer, so busy addresses would drop out on a fixed schedule.
- **One Squid for the API and the workspaces.** Untrusted workspace
  traffic must not be able to slow the proxy that every sign-in depends
  on, and the two allow lists have different owners.
