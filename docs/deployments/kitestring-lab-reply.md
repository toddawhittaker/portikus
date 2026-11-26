# Portikus in the Kitestring lab: reply to the requirements

**For:** the Kitestring lab, in reply to `docs/deployments/kitestring-lab.md`
(a snapshot of the lab's requirements) and its answers in
`docs/deployments/kitestring-lab-answers.md`.
**From:** Portikus's developers, Epic 76.

This reply follows section 4 of the requirements: the Required items, the
Check items, and the exact install settings. Everything marked "measured"
was measured on the lab VM (10.20.30.30) through the real tunnel, with the
lab's Cloudflare Cache Rules on, running Portikus `0.1.1900+ga95d2b79`.
That is the build at the head of the Epic 76 branch. The release that
carries the epic has a later number; install that one for the class.

Three things in this reply are still being finished in the same epic and
are not in the measured build. Each is marked "in this epic" below: the
recovery-point create becoming a background operation, the message inside
a Safari frame, and cache headers for the web app's own files.

## 1. Required items

| Item | Result |
|---|---|
| 2.1 Real client addresses from `CF-Connecting-IP` | **Done.** See below. |
| 2.2 Per-address connection limit | **Done.** See below. |
| 2.3 Preview suffix on a separate domain | **Done.** See below. |

### 2.1 Client addresses

A new setting, `trusted_proxies`, is a list of networks. It is empty by
default, which keeps today's behavior. When it is set, Caddy believes
`CF-Connecting-IP` only on connections from those networks, and ignores
the header from every other source. The header name is fixed; there is no
choice of header.

Caddy then sends the API and the preview gateway a single
`X-Forwarded-For` holding the real address. Everything downstream is
unchanged and now sees the student's address: Caddy's access log, the
audit log, sign-in records, the admin Logs tab, and every rate limit and
lockout that is keyed on address. WebSocket upgrades (terminals, events)
keep the real address.

Measured through the tunnel, with `trusted_proxies` set to `10.20.20.10/32`:

- The address Cloudflare puts in `CF-Connecting-IP` reached the log, taken
  from the `cloudflared` container.
- A client that sends its own `CF-Connecting-IP` through Cloudflare is
  refused by Cloudflare itself (403) before it reaches the lab.
- A forged header sent straight to the VM from any other address is
  ignored.

**Warning.** List only addresses that nobody else can send from. A listed
address skips the per-address connection limit (next item), and its
`CF-Connecting-IP` is believed. Anyone who can open connections from a
listed address can claim to be any visitor.

### 2.2 Connection limit

The nftables limit of 8192 open web connections per source address is
skipped for the addresses in `trusted_proxies`, and only for those. Without
this, all students together would share one limit, because every connection
comes from `cloudflared`. The protection that remains for those sources is
the API's own per-address rate limits, which now use the real address. We
did not move the connection limit into Caddy or the API. That means a
single student can open many connections through the tunnel without this
firewall limit stopping them; the rate limits and Cloudflare are the
guards. Nothing else in the firewall is keyed on the source address of
ports 80 or 443.

### 2.3 Preview suffix on a separate domain

- **Settable at install time.** The apt installer, `dpkg-reconfigure
  portikus` and a preseed set the preview suffix and `trusted_proxies`.
  Both questions are asked at debconf priority medium, so a default
  interactive install does not stop on them. A preseed or `dpkg-reconfigure
  portikus` reaches them.
- **A bare registrable domain works.** `kitestringlabs.dev` is accepted as
  the suffix. Preview hosts are `<label>-<port>.kitestringlabs.dev`.
  The suffix may not be the app host or a domain above it.
- **The suffix is used everywhere:** the preview gateway, the Host and
  Origin checks, CORS, the workspace development-server host allow-lists
  and the HMR (hot reload) WebSocket host.
- **Two zones, certificates.** One Cloudflare token with DNS edit on both
  zones worked. A second, optional setting, `cloudflare_preview_api_token`,
  gives the preview wildcard its own token; empty means the first token
  covers both. Measured: the same token entered in both settings also
  worked, which exercises the per-zone path. Moving `kitestringlabs.dev` to
  another Cloudflare account later means changing one token on the admin
  Certificate page, with no code change.
- **Documented.** `docs/INSTALL.md`, "Behind a Cloudflare Tunnel".

## 2. Check items

### 2.4 Behind Cloudflare's proxy

**Caching.** Measured: `cf-cache-status` was `DYNAMIC` on every response
we looked at. That is with the lab's Cache Rules on, so it shows the rules
work, not what Portikus would do without them. Portikus's own second guard,
which we checked separately:

| Responses | `Cache-Control` from Portikus |
|---|---|
| API | `private, no-store` |
| Student previews | `private` (Caddy adds it when the student's app sends none, and turns a `public` into `private`) |
| Gateway pages | `no-store` |

In this epic: the web app's hashed files will be sent `immutable` and
`index.html` `no-cache`. Until then they carry no cache header, and the
lab's cache bypass is what keeps them from being stored.

**WebSockets.** The API now sends a ping every 30 seconds on every
browser-facing socket (workspace, terminal, project events). Measured: the
workspace, terminal and project-events sockets stayed open for 6 minutes
idle with no closes. We did not force Cloudflare to drop a connection. If
one drops, the page reconnects, and the workspace stays up for the
ten-minute disconnect grace period (SPEC.md section 6.4), so terminals
keep running.

**Response timeout (the 100 seconds).** Measured on a project of 200,000
files and 880 MB:

- The zip download now streams from the first byte. The size check took
  9.5 s, the first byte arrived after 9.5 to 14.3 s, and the 941 MB zip was
  valid.
- Cloning a project and restoring a backup answer `202` at once and finish
  as background operations (55 s and 116 s in these runs).
- Creating a recovery point on a very large project can still run long.
  In this epic it moves to the same background pattern.

**Uploads.** The largest upload is 50 MiB (file upload and zip extract),
under the free plan's 100 MB. We know of no other request body that comes
near it: the rest are small JSON requests. Downloads, such as the zip, are
responses, which this limit does not cover.

**Redirects and origins.** Sign-in and the preview bootstrap move between
two different sites.

- Preview in its own tab: its cookie is `SameSite=Strict`, as before.
- Embedded preview: when the preview suffix is a different site from the
  app host, the cookie is set `SameSite=None; Secure; Partitioned`. It
  works only while the preview is framed by the Portikus page.
- LTI: measured with the repository's mock LMS. A top-level launch works
  across sites through the tunnel. Inside an LMS frame Portikus shows
  "Open Portikus in a new tab", and that tab completes the launch.
  Portikus refuses to run inside a frame by design (`frame-ancestors
  'none'`), so this is expected for every LMS. The mock's registration was
  removed from the lab VM afterwards.
- Safari: real Safari (on an iPad) refuses the partitioned cookie for the
  embedded preview. The same preview opened in its own tab works. In this
  epic the message inside the frame says so and offers "Open in new tab".
  Known limit: cookies that a student's own app sets inside a cross-site
  frame are blocked or partitioned by the browser, in Safari most strictly.
  Portikus cannot change that.

**HTTP/3.** Measured with Chromium: it uses HTTP/3 to Cloudflare, and falls
back to HTTP/2 when QUIC is turned off. Portikus does not depend on its own
`Alt-Svc` advertisement and needs no HTTP/3 setting.

**Command-line clients.** Portikus does not use any Cloudflare bot or
challenge feature and does not depend on anything those features change.
We measured the tunnel with browsers only and did not run `curl` through
it, so keep bot-blocking off on `kitestringlabs.dev` as planned.

### 2.5 Health check

`GET https://portikus.kitestringlabs.org/health` answers without signing
in, with `{"status":"ok","service":"api",...}` and the API's uptime. A
monitor through the tunnel sees that the API is up. It does not show the
state of Incus, the database or the workspaces; the administrator Health
tab does.

## 3. Asks for the lab

1. **Turn off Cloudflare Web Analytics** (the injected beacon) on both
   names. Portikus's Content Security Policy blocks the beacon script, so
   it only fills the browser console with errors.
2. **Keep `kitestringlabs.org` free of untrusted pages.** The partitioned
   cookie is keyed on the app host's registrable domain. A page that a
   student or any other untrusted person controls on `kitestringlabs.org`
   or its subdomains could frame a preview in the same partition. Only
   Portikus and pages you control should live there. `kitestringlabs.dev`
   is the right place for untrusted content.
3. **Resetting a cross-site preview clears only partitioned storage.**
   The preview reset expires the partitioned cookies set inside the
   Portikus frame. The same preview host's cookies from being opened in
   its own tab are a separate store and stay until reset there.

## 4. Settings for this layout

As preseed answers (`docs/INSTALL.md`, "Unattended installs"). The two
tokens are secrets; the lab enters its own, and they are removed from the
answer store once written.

```
portikus portikus/public_host string portikus.kitestringlabs.org
portikus portikus/preview_suffix string kitestringlabs.dev
portikus portikus/trusted_proxies string 10.20.20.10/32
portikus portikus/admin_email string <administrator's email>
portikus portikus/tls select letsencrypt
portikus portikus/acme_email string <email for Let's Encrypt notices>
portikus portikus/cloudflare_api_token password <token>
# Only when kitestringlabs.dev is in a different Cloudflare account:
#portikus portikus/cloudflare_preview_api_token password <token for kitestringlabs.dev>
portikus portikus/provider select dex
portikus portikus/storage_confirm boolean true
```

- **Token arrangement.** While both zones are in one account, one token
  with Zone Read and DNS Edit on both zones is enough and the second line
  stays out. After a move, give each zone its own token on the admin
  **Certificate** page, which owns the tokens from then on.
- **HTTP/3 and keep-alive.** No settings. The 30-second WebSocket ping is
  fixed.
- **Student storage and backups.** Mount the backup disk before the
  install, by its ID, at `/var/backups/portikus/local` (see "Behind a
  Cloudflare Tunnel" in `docs/INSTALL.md`). There is no setting for it.
- **Signing in.** The administrator signs in with the email address, not a
  username.
- **Time.** On the lab VM (16 cores) the install took about 13 minutes.

## 5. Capacity

Twenty-four students on 16 cores and 32 GB fit by the figures in
`docs/CAPACITY.md`, with a wide margin on memory. See that document,
"Twenty-four students on 16 cores and 32 GB".
