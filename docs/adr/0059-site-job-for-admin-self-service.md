# 0059. One root site job applies the admin page's site changes: proxy hosts, LMS platforms, the site address and the sign-in provider

- **Status**: Accepted (Epic 43)
- **Date**: 2026-10-10
- **References**: SPEC.md sections 5.1, 5.2, 20.1, 21.12, 24.1, 24.8, 24.10, 24.11; ADRs 0025, 0026, 0027, 0030, 0031, 0046, 0052; issues #1250, #1220, #935, #1252

## Context

Four things an administrator needs today take the server's command line:
letting the API reach a new host on the internet, registering an LMS
platform for LTI launches, choosing the single sign-on provider, and
moving the site to a new host name or port. The API never runs as root,
so each change has to go through a root job, as the image, certificate
and alerts jobs already do (ADRs 0030, 0046, 0052).

Two of the four, the address and the sign-in provider, can lock people
out when they are wrong. They change the same install answers that
`dpkg-reconfigure portikus` changes, and only `portikus setup` can apply
those everywhere they reach (Caddy, Dex, Squid, `api.env`, the firewall
and the hosts entry).

## Decision

### One job, six request kinds

`site-job` is a root job started by `portikus-site-job.path` and
`.service`, built like the alerts job (ADR 0052): Python standard
library, the request file deleted first whatever the outcome, read with
`O_NOFOLLOW` as a regular file under a size cap, every field checked
again. It serves six kinds:

| Kind | Body | What it does |
|---|---|---|
| `proxy-hosts` | `hosts[]` | Writes the page's proxy host list and its Squid include, reloads Squid. |
| `lti-platforms` | `platforms[]` | Writes the page's platforms file and its Squid include, reloads Squid, restarts the API. |
| `address` | `host`, `port` | A trial: writes the install answers, reruns setup. |
| `signin` | `provider`, `entraTenantId?`, `googleDomains?`, `oidcIssuer?`, `clientId?`, `clientSecret` (string or null), `groupsClaim?`, `groups?{student, instructor, admin}` | A trial: writes the install answers and `secrets.yaml`, reruns setup. |
| `keep` | `trialId` | Ends a trial and keeps it. |
| `rollback` | `trialId` | Ends a trial and puts the old answers back. |

`provider` is `dex`, `entra`, `google` or `oidc`. A null `clientSecret`
keeps the stored one.

### Files

- **Request.** `/var/lib/portikus/site-jobs/request-<uuid>.json`, mode
  0600, `{version: 1, id, kind, requestedAt, ...body}`. The API writes it
  aside and renames it into place, and never reads one back, because a
  `signin` request may hold the client secret. `packages/contracts`
  `SiteJobRequest` is the schema.
- **Status.** `site-jobs/status/<id>.json`, `{id, kind, state, code,
  startedAt, finishedAt, trialEndsAt?}`. `state` is `running`, `trial`,
  `kept`, `reverted`, `done` or `failed`; the API shows a waiting request
  as `queued`. `code` is one of a fixed list (`SiteJobCode`), never a
  program's own text. `status/<id>.log` holds setup's output. Neither file
  ever holds a secret. A job queued or running for more than 45 minutes
  counts as dead and no longer blocks a new request.
- **View.** Setup writes `/etc/portikus/site-view.json`, mode 0644:
  `{version: 1, apt, host, port, previewSuffix, previewSuffixSetByHand,
  provider, entraTenantId, googleDomains, oidcIssuer, clientId,
  clientSecretSet, groupsClaim, groups, ldapHost?, certificateSource}`.
  `provider` may also be `ldap` here. The schema is strict and the secret
  appears only as the flag `clientSecretSet`, so no secret can be read
  through it. A missing file reads as "not available here".
- **Page-owned files.** `/etc/portikus/proxy-hosts.json` and
  `/etc/portikus/lti-platforms-admin.json`, root:portikus 0640, beside the
  operator's files. The operator's Squid list and
  `LTI_PLATFORMS_FILE` stay owned by Ansible and show read-only on the
  page.
- **Squid includes.** `/etc/portikus/egress-proxy.d/admin.conf` for proxy
  hosts and `lti.conf` for platform hosts, written by swap, parse and roll
  back as in ADR 0052. The alerts job and the site job take one shared
  lock before changing any Squid include.

### Value rules

Every free-text value reaches a root Ansible run, so the job refuses
`{`, `}` and control characters (C0, DEL and C1) in every field, and then
checks each field against its own pattern. The API checks the same rules
first with the schemas in `packages/contracts/src/site.ts`.

- **Proxy hosts.** Host names only, by the ADR 0052 label rule: no IP
  addresses, no ports, no URLs. Each gets port 443 and CONNECT only. At
  most 50.
- **LMS platforms.** The platforms-file version 1 shape (ADR 0025), plus
  the optional `authTokenUrl`. HTTPS only, `mock: true` refused, and an
  issuer and client ID pair already in the operator's file refused. The
  keyset and token URLs must use the default port; their hosts go into
  Squid on 443 only. At most 20.
- **Address.** A lowercase host name with at least one dot. The port is
  443 or 1024 to 65535, except the loopback ports Portikus's own
  services use (`SITE_RESERVED_PORTS`: 3000, 3001, 3128, 3129, 3130,
  3199, 5000, 5001, 5300, 5398, 5399, 5432, 5556, 5557, 7400, 8792 and
  8796).
- **Sign-in.** The debconf questions' rules: a tenant ID is a GUID,
  Google domains are host names, the issuer is an `https://` address,
  the groups claim has no spaces or quotes, a client secret is at least
  16 characters. Each provider needs its own fields; `dex` needs none
  and takes no secret.

### Secrets

The client secret goes only to `secrets.yaml`, never to debconf, a
status file, a log, an audit row or a process argument. When the issuer,
the tenant or the client ID changes, the stored secret is cleared unless
a new one arrives in the same request (the ADR 0052 rule), so a changed
provider never receives an old secret.

### Trials

- **One at a time.** An `address` or `signin` request is refused with
  `trial_open` while a trial is open, and with `busy` while setup is
  running. The API refuses the same cases first.
- **Deadline.** Opening a trial starts a transient systemd timer that runs
  `site-job expire <id>` at `trialEndsAt`: 15 minutes for `address`, 30
  for `signin`. An expired trial is put back (`reverted`,
  `trial_expired`).
- **Failure.** When setup fails during a trial, the job puts the old
  answers back and reruns setup (`reverted`, `setup_failed`).
- **Apt installs only.** `address` and `signin` work only where
  `/etc/portikus/portikus.yaml` exists; elsewhere the job refuses with
  `not_apt_install` and the page says the settings are unavailable.

### API settings

`SITE_JOBS_DIR` (unset turns the site routes off), `SITE_VIEW_FILE`,
`PROXY_HOSTS_FILE` and `LTI_ADMIN_PLATFORMS_FILE`, each defaulting to the
path above; e2e points them at temporary files.

### Audit

`site.job_requested` (actor the administrator, metadata the kind and a
secret-free summary: host names, platform names, issuers and client IDs,
the provider, and only whether a client secret was sent) and
`site.job_finished` (actor `site-job`, metadata kind, state and code),
written once per job.

### Rulings

Number 15 is not here: the workspace agent's own log is decided in ADR 0060.

- **1. Sign-in by setup, not Dex's API.** The `signin` job writes the
  install answers and reruns setup, as a trial. Dex's gRPC connector API
  is not used.
- **2. Providers on the page.** Entra, Google, generic OIDC and "Dex
  passwords only". LDAP shows read-only and is set with
  `dpkg-reconfigure portikus`. Switching from LDAP to another provider
  on the page is allowed; the settings writer drops the LDAP keys.
- **3. Test, then Keep.** A sign-in trial is applied, then checked with
  **Test sign-in**, then kept with **Keep**. Keep is offered only after a
  passing test, or at once for "Dex passwords only". An unkept trial is
  put back after 30 minutes. The local administrator's Dex password
  always works (ADR 0031). The confirmation dialog says students cannot
  sign in while a bad trial is open.
- **4. Address as a guided switch.** Plan, pre-flight, trial. Keep must be
  pressed from the new address. An unkept trial is put back after 15
  minutes.
- **5. Certificates.** An address change is allowed when the certificate
  comes from Caddy's internal authority or ACME, and refused
  (`certificate_not_covering`) for uploaded files that do not cover the
  new names.
- **6. Preview suffix.** It follows the host as `preview.<host>`, unless it
  was set by hand in `portikus.yaml`; a hand-set suffix is kept and the
  page says so. Editing the suffix is left out (#1236).
- **7. Recovery.** When the new address is unreachable after Keep, the way
  back is `sudo dpkg-reconfigure portikus`, plus editing
  `portikus_public_port` in `portikus.yaml`. The guides say so.
- **8. Running workspaces** keep the old preview suffix until their next
  start. The page lists them and nothing is restarted.
- **9. Page-owned files** live beside the operator's, as described above.
  The operator's list and file stay owned by Ansible and show read-only.
- **10. API restart.** The `lti-platforms` job restarts the API so it reads
   page-registered platforms; `routes/lti.ts` is not changed. The page
   warns before saving that root shells end and sockets reconnect.
- **11. Page platforms.** HTTPS only, no mock, no pair already in the
   operator's file, keyset and token hosts into Squid on 443 only, at
   most 20, and the optional `authTokenUrl` (https only).
- **12. Page proxy hosts.** Host names only, port 443, CONNECT only, no IP
   addresses, at most 50, the ADR 0052 host-name rule.
- **13. Users paging.** The Users list is paged on the server by offset,
   after the markers are computed over all accounts. Search, the role,
   state, image and archived filters, and the sort run on the server.
   Pages hold 50 rows. A request with no `limit` returns the whole list,
   for the Audit and Logs pickers and `?image=older`. The poll for an
   operation's end uses `?pending=1`. Bulk actions act on the selected
   rows of the current page.
- **14. Admin linking.** The administrator picks both accounts, and the API
   reuses `linkAccounts` and `unlinkAccount` with all their refusals.
   Unlink works on any link, including one whose SSO account is now
   disabled or an administrator. The `user.linked` and `user.unlinked`
   audit rows carry the administrator as actor and `by: "administrator"`,
   and the SSO account's holder gets a notification.
- **16. Tabs.** Two new admin tabs: Sign-in (`/admin/signin`, with the
   single sign-on and LMS groups) and Site address (`/admin/address`).
   Page proxy hosts are a group in the Network tab. The tabs always show;
   off apt installs the address and sign-on parts say they are
   unavailable.
- **17. Test result.** A test sign-in writes a `settings.signin_tested`
   audit row (result, mapped role and connector; no email), and the page
   reads the newest. A test sign-in never creates a user, a session or a
   role.

## Consequences

- **Amends ADR 0031.** Its consequence "Setting up SSO in the admin area
  can manage Dex connectors only, through Dex's API" no longer holds: the
  admin area sets the provider through the install answers and setup, as
  a trial, and Dex's API is not used for connectors.
- A compromised API can widen its own outbound reach to any page proxy
  host or platform host. This is accepted for the reasons in ADR 0052:
  each change is audited, and the API already reaches the internet
  through any workspace in open mode.
- Page-registered platforms are a new trust root for LTI launches. Only
  administrators can add them, each change is audited, and the operator's
  file still wins on a clash.
- Saving LMS platforms restarts the API, which ends every root shell and
  makes every socket reconnect.
- After a page change, `dpkg-reconfigure portikus` shows the page's
  values, because both write the same answers.

## Rejected

- **Dex's gRPC connector API** for the provider: setup must change Squid,
  Caddy and `api.env` too, and a connector added through the API is lost
  on the next setup run.
- **Plan-only pages** that print the commands to run: they leave the
  change on the command line, which is the problem.
- **Letting the API write the install answers**: it would need root.
- **Applying an address or sign-in change with no trial**: one mistake
  locks everyone out until someone signs in to the server.
