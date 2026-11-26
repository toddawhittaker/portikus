# Epic 76: Portikus behind the Kitestring lab's Cloudflare Tunnel

Branch `epic/76-kitestring-lab`, base commit `7fcd4177` (main after
Epic 75). Scope: the **Required** items 2.1 to 2.3 and the **Check**
items 2.4 and 2.5 of `docs/deployments/kitestring-lab.md`, with the
lab's answers in `docs/deployments/kitestring-lab-answers.md`. Closes
GitHub issue #1236 (previews on a separate registrable domain). This
file goes away at the fold.

## Rulings that apply

- **The job (Todd, 2026-11-26).** A fix-batch epic for the Required
  items, a look at the Check items, then the section 4 reply as its own
  document, `docs/deployments/kitestring-lab-reply.md`.
- **Testing (Todd, 2026-11-26).** Automated tests and the rehearsal VM
  use a stand-in for `cloudflared`. Real Cloudflare behavior is measured
  on the lab VM (10.20.30.30, reached with `ssh -J
  root@pve1.kitestringlabs.org`), which is the staging install until the
  class starts. No quick tunnel. The lab's Cloudflare account, firewall,
  switch and pve1 itself are look-don't-change; ask Todd for any change.
- **Proxy setting shape (orchestrator).** One setting, `trusted_proxies`:
  a list of CIDRs, empty by default (off). When set, Caddy trusts
  `CF-Connecting-IP` from those sources only. The header is fixed to
  `CF-Connecting-IP`; no generic header choice, since nobody needs one.
  Caddy sends the API and the preview gateway a single
  `X-Forwarded-For: {client_ip}`, so the API's `trustProxy: 127.0.0.1`
  keeps working unchanged.
- **Firewall (orchestrator).** With `trusted_proxies` set, the nftables
  per-source limit skips those sources. The API's per-address rate
  limits, now keyed on the real address, are the protection that
  remains; documented, not moved into Caddy.
- **Per-zone Cloudflare tokens (orchestrator).** The existing
  `cloudflare_api_token` covers the app host. A new optional
  `cloudflare_preview_api_token` covers the preview wildcard; empty
  means use the first token. Same in the installer, preseed,
  `dpkg-reconfigure` and the admin Certificate tab.
- **Embedded previews across sites (orchestrator, BROWSER-HANDLING.md
  section 7.2).** When the preview suffix is a different site from the
  app host, the bootstrap for an embedded grant sets its cookie
  `SameSite=None; Secure; Partitioned`, so it only works framed under
  the Portikus top-level site. A preview opened in its own tab keeps its
  `SameSite=Strict` cookie. Same-site layouts change nothing.
  Security-reviewer checks this.
- **Preview caching (orchestrator).** Caddy gives preview responses
  `Cache-Control: private` when the student's app sets none, and turns a
  `public` directive into `private`. Authenticated API responses
  already send `no-store`; hashed web assets stay cacheable.
- **WebSockets (orchestrator).** The API sends a WebSocket ping every 30
  seconds on every browser-facing socket (workspace, terminals, project
  events). The agent-side sockets do not cross Cloudflare and stay as
  they are.
- **100-second first byte (orchestrator).** The project zip download
  streams from the first byte instead of building a temporary file
  first. If zip extract can hold a request past 60 seconds at the 50 MiB
  upload limit, T4 stops and reports before changing its shape.
- **LTI on staging (Todd, 2026-11-26).** No real course until about
  January 2027, so T6 uses the repository's mock LMS (`make
  lti-mock-register`, ADR 0025). A browser on this host opens the mock's
  launch page, which posts across sites to `portikus.kitestringlabs.org`
  through the real tunnel. The mock's registration is removed from the
  lab VM when T6 ends, since the mock can launch as anyone.
- **HTTP/3 (orchestrator).** No new setting. Portikus does not depend on
  its own `Alt-Svc`; the reply says so.

## Tasks

| Task | Owner, model | Files it may touch | Starts after | Closes |
|---|---|---|---|---|
| T1 Caddy and firewall: `trusted_proxies` with `client_ip_headers CF-Connecting-IP`, single `X-Forwarded-For` to the API and preview gateway, nftables exemption, preview `Cache-Control`, live Caddy tests (trusted source used, untrusted ignored, WebSocket upgrade keeps the address) | infra, Opus low | `infra/ansible/roles/caddy/**`, `infra/ansible/roles/firewall/**`, `infra/tests/caddy-*.sh`, new `infra/tests/` stand-in proxy test | none | |
| T2 Installer settings and certificates: debconf questions, preseed, `dpkg-reconfigure` and `site.yml` for `trusted_proxies` and the preview suffix (settable, a bare registrable domain allowed); per-zone token in the certificate job | infra, Opus low | `packaging/debian/**`, `packaging/scripts/postinst`, `packaging/tests/**`, `packaging/certificate/**`, `packaging/site/**`, `infra/ansible/site.yml`, `infra/ansible/roles/portikus/templates/*.env.j2`; the `tls` import lines of `Caddyfile.j2` only after T1 merges | none | |
| T3 Previews on a separate site: partitioned embedded bootstrap cookie, suffix used everywhere (Host and Origin checks, CORS, workspace allow-lists and HMR host, the `PORTIKUS_PREVIEW_HOST_SUFFIX` name), unit and Playwright tests with a separate-site preview domain | builder, Opus low | `apps/api/src/routes/preview.ts`, `apps/api/src/preview/**`, `packages/auth/**`, `packages/config/**`, `apps/workspace-agent/agent-instructions.md`, `apps/web/src/preview/**`, `e2e/` preview specs and gateway stand-in | none | #1236 |
| T4 Long connections: API WebSocket pings, streamed zip download, zip extract timing | builder, Opus low | `apps/api/src/routes/{ws,terminals,project-events,files}.ts`, `apps/workspace-agent/src/{files-route,projects}.ts`, their tests | none | |
| T2b Admin Certificate tab: the optional preview-zone token | builder, Sonnet high | `apps/api/src/routes/admin-certificate.ts`, `apps/web/src/admin/` certificate screen, their tests and e2e | T2 | |
| T5 Rehearsal VM full smoke with the stand-in `cloudflared` and a separate-site preview suffix, including an LTI launch through the stand-in | infra, Opus low | `infra/tests/**` | T1, T2, T3, T4 | |
| T6 Lab staging: install the epic build on 10.20.30.30 with the lab preseed; measure WebSocket idle closes, the 100-second timeout, caching, and LTI form posts and the redirect back with the mock LMS, through the real tunnel; remove the mock registration after | infra, Opus low | none in the repo; findings in its report | T5, plus the lab VM built (in progress, 2026-11-26) and the Cloudflare token from Todd | |
| T7 Reply and install docs: `kitestring-lab-reply.md` (section 4 of the requirements), INSTALL.md "Behind a Cloudflare Tunnel" example, CAPACITY.md check for 24 students on 12 to 16 vCPUs and 24 GB, backup target on a local disk | builder, Sonnet high | `docs/deployments/kitestring-lab-reply.md`, `docs/INSTALL.md`, `docs/CAPACITY.md` | T6 | |
| T8 Fold | orchestrator | `docs/STATUS.md`, `docs/SPEC.md`, `docs/adr/`, this file | T7 and the fix round | |

Waves: T1, T2, T3, T4 at once; then T2b; then T5; then T6; then T7 and
the fold.

## Reviews

Security-reviewer (proxy trust, the partitioned cookie, the firewall
change), code-reviewer, and a11y-reviewer for the T2b screen, starting
when T1 to T4 have landed.
