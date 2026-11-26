# Portikus in the Kitestring lab: what it must support

**For:** Portikus's developers and their agents.
**From:** the Kitestring lab, which will host Portikus for a Franklin University class of about 24 students.
**Status:** the lab design is decided (2026-11-25). The Portikus VM is not built yet; the tunnel connector is.

This document lists what the lab's network looks like from Portikus's side and what Portikus needs to support it. Items marked **Required** block the deployment or break a security control. Items marked **Check** may already work; confirm and say so.

## 1. How traffic reaches Portikus

```
student browser
  → Cloudflare edge (TLS with Cloudflare's certificate; proxied DNS)
  → Cloudflare Tunnel, opened outbound by cloudflared
  → cloudflared container, 10.20.20.10 (EDGE VLAN)
  → Portikus VM, TCP 443 (LAB VLAN, 10.20.30.0/24), HTTPS
```

- **Names:**

  | Name | What |
  |---|---|
  | `portikus.kitestringlabs.org` | The application host |
  | `*.kitestringlabs.dev` | Student previews; preview suffix `kitestringlabs.dev` (for example `alice-5173.kitestringlabs.dev`) |

  `kitestringlabs.dev` is used for nothing but Portikus previews. The lab will apply to add it to the Public Suffix List (private section), so browsers treat each preview host as its own site.
- **DNS** for both zones is at Cloudflare, **proxied** (orange cloud) to the tunnel. The VM has no public address and no inbound port from the internet.
- **TLS** is in two legs:
  - Browsers get Cloudflare's free edge certificate, which covers both names because each is one level below its zone.
  - `cloudflared` then connects to the VM over HTTPS, sending the request's own host name as SNI (`matchSNItoHost`) and verifying the certificate. So Portikus still needs real certificates: Let's Encrypt through the Cloudflare DNS-01 challenge, a single name for the app host and a wildcard for the previews.
- **Host header:** `cloudflared` passes the browser's `Host` unchanged.
- **Sign-in:** Microsoft Entra ID through Portikus's own OpenID Connect sign-in. The lab may add Cloudflare Access (franklin.edu email) on `portikus.kitestringlabs.org`, but never on the preview names.
- **Outbound:** the LAB VLAN has full internet access. It cannot reach the lab's internal networks.

## 2. Requirements

### 2.1 Real client addresses from `CF-Connecting-IP`: **Required**

Every connection reaches Portikus from 10.20.20.10, the `cloudflared` container. Cloudflare puts the student's address in the `CF-Connecting-IP` request header.

Portikus needs:
1. **An option to take the client address from `CF-Connecting-IP`**, off by default. It must apply only to connections from a trusted-source list (CIDRs). The lab will set this to `10.20.20.10/32`. In Caddy, that is `trusted_proxies static <list>` with `client_ip_headers CF-Connecting-IP` in the `servers` block.
2. **Headers from other sources ignored.** Client-supplied copies of the header must not be trusted. Portikus already strips client `X-Forwarded-*` headers before setting trusted values; this must work the same way.
3. **The real address used everywhere Portikus uses a client address:**
   - Caddy's client IP and access logs
   - the `X-Forwarded-For` value Caddy sets for the API and the preview gateway
   - the audit log, sign-in records and the admin Logs tab
   - any rate limit or lockout keyed on address
4. **A setting in the installer and in `dpkg-reconfigure portikus`**, plus a preseed key.
5. **Tests** covering:
   - the header from a trusted source is used
   - the header from an untrusted source is ignored
   - WebSocket upgrades (terminals, events) keep the real address

### 2.2 Per-address connection limit in the host firewall: **Required**

`infra/ansible/roles/firewall/templates/nftables.conf.j2` refuses more than 8192 open web connections per source address. nftables sees `cloudflared`'s address on every connection, so this limit would apply to **all students together**.

With the option in 2.1 on, exempt the trusted-source addresses from that per-source limit. Moving the limit into Caddy or the API, keyed on the real address, would keep the protection. If that's not practical, document that it is lost behind a proxy.

The same applies to any other nftables or kernel control keyed on source address for ports 80 or 443.

### 2.3 Preview suffix on a separate domain: **Required (check first)**

The app host is `portikus.kitestringlabs.org` and the preview suffix is `kitestringlabs.dev`, a separate registrable domain. That is the stronger layout Portikus's `BROWSER-HANDLING.md` recommends. The default in `infra/ansible/site.yml` would be `preview.portikus.kitestringlabs.org`.

`site.yml` accepts a `PORTIKUS_PREVIEW_SUFFIX` override, and its checks pass:
- the suffix is not the app host
- the suffix is not the app host's parent

Confirm or provide all of the following:
- **Settable at install time.** The apt installer, `dpkg-reconfigure` and preseed let an administrator set the preview suffix. `packaging/tests/settings-keys-test.sh` suggests it is currently read-only there.
- **A bare registrable domain works as the suffix.** The suffix may be a registrable domain itself (`kitestringlabs.dev`), not a subdomain. Preview hosts are then `<label>-<port>.kitestringlabs.dev`.
- **Certificates across two zones.** The certificate job issues the app certificate in one Cloudflare zone and the preview wildcard in another. Either one token with DNS edit on both zones must work, or one token per zone. The lab may move `kitestringlabs.dev` to a separate Cloudflare account, so a token per zone is preferred.
- **The configured suffix is used everywhere:** the preview gateway, the Host and Origin checks, CORS, and the workspace templates (development-server host allow-lists, HMR WebSocket hosts).
- **Documented.** `INSTALL.md` shows this layout as a supported example: proxied DNS, behind a tunnel.

### 2.4 Behind Cloudflare's proxy: **Check**

Portikus has not been tested behind Cloudflare's proxy. Confirm each of the following, and change Portikus where needed:
- **Caching.**
  - Lab side: Cloudflare caches responses for static file extensions (`.js`, `.css`, images) by default unless the origin forbids it. The lab will add Cache Rules to bypass the cache on both zones.
  - Portikus side: as a second guard, send `Cache-Control: private, no-store` (or at least `private`) on every authenticated response, preview responses included. Student previews must never be served from a shared cache.
- **WebSockets.** Terminals and event streams run over WebSockets through Cloudflare. Cloudflare closes connections it considers idle, and occasionally drops long connections when it restarts edge servers. Confirm:
  - the server or client sends keep-alive pings well under 100 seconds apart
  - the UI reconnects cleanly, within the ten-minute grace period, without losing terminals
- **Response timeout.** Cloudflare returns error 524 if the origin sends no response headers within 100 seconds. Check that no request waits that long before its first byte, for example a large zip download that builds before streaming, or a slow API call.
- **Uploads.** The free plan limits request bodies to 100 MB. Portikus's largest upload (50 MiB) fits. Say if any other path sends more.
- **Redirects and origins.** The sign-in flow and the preview bootstrap redirect between `portikus.kitestringlabs.org` and `*.kitestringlabs.dev`, two different sites. Confirm the preview session bootstrap works cross-site: `SameSite` settings and any check on `Referer` or `Origin`.
- **HTTP/3.** Cloudflare speaks HTTP/3 to browsers; `cloudflared` speaks HTTP/1.1 or HTTP/2 to the VM. Confirm Portikus doesn't depend on its own `Alt-Svc` advertisement. If it is easy, make HTTP/3 on the origin a setting.
- **Command-line clients.** Students may `curl` their own previews or use tools that open them. The lab will keep Cloudflare's bot-blocking features off on `kitestringlabs.dev`. Say if Portikus relies on anything those features would change.

### 2.5 Health check: **Nice to have**

Name a URL that shows the platform is healthy without signing in, if one exists, so the lab can monitor it through the tunnel and from the management network.

## 3. What the lab provides

| Item | Value |
|---|---|
| VM | Debian 13 x86-64 on Proxmox VE 9, LAB VLAN, static address in 10.20.30.0/24 |
| CPU / memory | Sized for about 24 students per `docs/HOSTING.md` and `docs/CAPACITY.md`. The lab plans 12–16 vCPUs and 24 GB or more of RAM; say if that is short. |
| Student storage | A second empty virtual disk, on hard-disk ZFS storage |
| Nested containers | The VM is a full VM, not a container, so Incus and Docker inside it work as on any server |
| Outbound | Full internet access; no access to the lab's internal networks |
| Inbound | HTTPS on 443 from `cloudflared` (10.20.20.10) only. SSH from the management network and Tailscale only. No port 80, nothing from the internet |
| DNS and certificates | Cloudflare, zones `kitestringlabs.org` and `kitestringlabs.dev`; API token(s) limited to editing DNS in those zones, entered at install |
| Public address | None needed; the tunnel works from any connection, at home during staging and at the lab site later |

## 4. What to send back

- For each **Required** item: done (with the version or commit that has it), or why not and what to do instead.
- For each **Check** item: what you found.
- The exact install-time settings for this layout, as preseed values if possible:
  - app host `portikus.kitestringlabs.org`
  - preview suffix `kitestringlabs.dev`
  - client address from `CF-Connecting-IP`, trusting `10.20.20.10/32`
  - certificates through Cloudflare DNS, with the token arrangement for two zones
  - any HTTP/3 or keep-alive settings
