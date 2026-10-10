# 0046. Certificates from the admin page: Caddy as the only ACME client, a root job, and staging before live

- **Status**: Accepted (Epic 27)
- **Date**: 2026-09-30
- **References**: SPEC.md sections 20.1, 21.12, 22.4, 24.8, 24.10 and
  24.11; STACK.md section 12; ADR 0030; issue #804

## Context

Until now the installer chose the HTTPS certificate once: Let's Encrypt
through Cloudflare, files already on the server, or Caddy's own
certificate authority. Changing it meant `dpkg-reconfigure` and a setup
run, and only Cloudflare was supported for Let's Encrypt. Issue #804 asked
for a page where an administrator chooses and changes the certificate
without touching the server.

ACME (Automatic Certificate Management Environment) is the protocol Let's
Encrypt and ZeroSSL speak. It proves control of a name either by a DNS
record (DNS-01, which can issue a wildcard) or by a file served on port 80
(HTTP-01, one name at a time). Student previews live under
`*.preview.<site>`, so HTTP-01 needs Caddy's on-demand TLS, which asks
Portikus before it requests a certificate for each new preview name.

## Decision

1. **Caddy stays the only ACME client.** Caddy already requests and renews
   certificates through its built-in CertMagic library. The page only
   writes Caddy's configuration; renewal stays with Caddy.
2. **Setup always builds Caddy with nine DNS plugins**: Cloudflare,
   Route 53, DigitalOcean, OVH, Hetzner, Gandi, Porkbun, Google Cloud DNS
   and Azure. It builds them with xcaddy, as it builds Dex and
   distrobuilder, whatever certificate the installer chose.
3. **The page owns the certificate after install.** State lives in the
   root-owned `/etc/portikus/certificate/`. Setup writes it from the
   installer's answer only when it does not exist yet. A later setup run
   or `dpkg-reconfigure` never touches it. The installer now defaults to
   Caddy's internal authority. Caddy's site blocks import one snippet from
   that directory for their TLS settings.
4. **A request file and a root job**, copied from the image job (ADR
   0030). The unprivileged API writes a request file; a systemd path unit
   starts `certificate-job`, a root Python program using only the standard
   library. The job checks every request again and never trusts the API.
   It runs one job at a time and writes a status file and a log per job.
   An hourly check records the issuer, names and expiry in use, and the
   API turns that into expiry and renewal-failure notices for
   administrators.
5. **Secrets are write-only.** DNS credentials, the EAB (External Account
   Binding) HMAC key and an uploaded private key travel once, in the
   request file readable only by root and the API. The job deletes that
   file as soon as it has read it. The secrets are stored only in
   files under `/etc/portikus/certificate/secrets/` (root:caddy, 0640),
   which the snippet names with Caddy's `{file.…}` placeholders, read at
   run time. Caddy needs no restart and no environment file for a new
   secret; the installer's old Cloudflare environment file and its
   systemd drop-in are removed. Google Cloud DNS takes its
   service-account key as such a file. The secrets never appear in Caddy's saved
   configuration, a log, the journal, an audit row, a status file, a page
   or a process's arguments. The page shows only whether each is set.
6. **Never switch the live site and wait.** An ACME change first checks
   DNS and reachability. A throwaway second Caddy, with its admin endpoint
   off, its own storage seeded with a copy of the live ACME account, and
   its site on loopback, then gets a test certificate: from Let's Encrypt
   staging when the choice is Let's Encrypt, otherwise from the chosen
   authority itself, because ZeroSSL and custom authorities have no
   staging service. For Apply the throwaway also gets the real
   certificate. The job stops it at a deadline. Only on success does the
   job copy the certificates into the live storage, swap the snippet, run
   `caddy reload --force`, and check the served certificate on loopback
   for the site and a sample preview name. If that check fails, it puts
   the previous snippet and secrets back and reloads, which is instant. If
   the throwaway fails, the live site was never touched. Renew now works
   the same way, then reloads to the internal authority and back so Caddy
   reads the copied certificate; the live certificate is never deleted
   first. One earlier generation is kept for **Roll back**, and
   `portikus reset-certificate` recovers a site the page has made
   unreachable.
7. **HTTP-01 runs in the throwaway too.** Its tests and applies listen on
   127.0.0.1:8796, and the live port-80 block proxies
   `/.well-known/acme-challenge/*` there; the live Caddy still answers
   its own challenges first. Only the `caddy` account may answer on 8796.
   Preview names use on-demand TLS on the live Caddy, gated by an ask
   endpoint the API answers only from loopback: yes for the site, and for
   a preview name only when its port is a non-system listener in a
   running workspace, at most 10 new names per workspace per rolling hour
   (kept in memory, so an API restart resets the count). The cost is that
   every preview name is a separate certificate, and Let's Encrypt allows
   50 certificates per registered domain per week. A busy class can hit
   that limit; DNS-01 with one wildcard does not.

## Alternatives rejected

- **lego**: about 150 DNS providers, but a second renewer next to Caddy,
  with certificate files handed between them.
- **acme.sh**: the same second-renewer cost, plus shell scripts running as
  root with provider tokens.
- **certbot**: only about 15 official DNS plugins, so it adds nothing over
  Caddy.
- **acme-client (Node)**: the unprivileged API would hold the site's
  private key and repeat Caddy's work.
- **A prebuilt Caddy in the .deb**: adds a Go build to CI and packaging for
  no gain over building at setup.

## Consequences

- Setup takes a little longer and needs the Go module proxy for the Caddy
  build on every install.
- Only Cloudflare is tested end to end. The other eight providers have
  configuration tests only; HTTP-01 and EAB are tested against Pebble,
  Let's Encrypt's local test server.
- An installer answer no longer changes a running site's certificate,
  which surprises anyone used to `dpkg-reconfigure`; INSTALL.md says so.
- The API's trust bundle is the system authorities plus Caddy's internal
  root plus any uploaded chain, so a mode switch never breaks the API's
  own calls through Caddy. The accepted cost: the API trusts those roots
  for every outbound call it makes, not only calls to its own site.
- Every reload closes proxied WebSockets unless they have a
  `stream_close_delay`; setup sets one hour on the WebSocket routes, so
  a certificate change does not drop terminals, but a connection older
  than that hour after a reload is closed and the page reconnects.
- Changing the site's address stays out of scope (#935).

## Update, Epic 43

Changing the site's address is now done from the Site address tab (#935,
ADR 0059), as a 15-minute trial kept from the new address. It is allowed
when the certificate comes from Caddy's internal authority or ACME, and
refused for uploaded files that do not cover the new names.
