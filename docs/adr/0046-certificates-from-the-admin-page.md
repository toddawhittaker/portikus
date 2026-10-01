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
   root-owned files Caddy can read and appear in Caddy's configuration as
   environment placeholders. They never appear in Caddy's saved
   configuration, a log, the journal, an audit row, a status file, a page
   or a process's arguments. The page shows only whether each is set.
6. **Staging first, then live, with an automatic restore.** An ACME change
   first checks DNS and reachability, then has a throwaway second Caddy,
   with its own storage, get a certificate from the staging service (for
   Let's Encrypt) or from the chosen authority (ZeroSSL and custom
   authorities have no staging service). Only then does it change the live
   site. If the live certificate does not appear in time, the job puts back
   the previous settings and secrets and reloads Caddy. One earlier
   generation is kept for **Roll back**, and `portikus reset-certificate`
   recovers a site the page has made unreachable.
7. **HTTP-01 previews use on-demand TLS, gated by an ask endpoint.** Before
   Caddy requests a certificate for a preview name, it asks the API, which
   says yes only for the site and names under the preview suffix. The cost
   is that every new preview name is a separate certificate, and Let's
   Encrypt allows 50 certificates per registered domain per week. A busy
   class with many preview names can hit that limit; DNS-01 with one
   wildcard does not.

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
- Changing the site's address stays out of scope (#935).
