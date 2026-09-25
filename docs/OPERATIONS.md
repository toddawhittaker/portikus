# Operations runbook

This is the runbook for the one operator of the Portikus pilot. It says how
to deploy, manage accounts, back up and restore, and check the pilot. It
serves SPEC.md section 29, Epic 12 ("deployment documentation and a
runbook"), docs/archive/epics/EPIC-12B.md, task B6, and docs/archive/epics/EPIC-14.md, task T6. How
the infrastructure is built the first time is in `infra/README.md`. What each part of this runbook
rests on is in the ADRs (architecture decision records) it cites.

Names used throughout:

- **The host** is the Pop!_OS machine that runs libvirt, the virtual
  machine manager. Every `make` command runs here, from a checkout of the
  repository.
- **The pilot** is the platform VM `portikus`, at `10.100.0.120`. Its
  OpenTofu environment is `dev-libvirt`, the default `TOFU_ENV`. `make`
  reads the VM's address from the OpenTofu state, so never pass `VM_IP` by
  hand for the pilot.
- **The rehearsal VM** is `portikus-rehearsal`, a second VM on the same
  host for exercises that must not touch the pilot (`TOFU_ENV=rehearsal-libvirt`).
- **Out of class hours** means no student is working. Every change to the
  pilot happens then.

## Rules that hold for every pilot change

1. Fetch first: `git fetch origin` and check out `origin/main`. The pilot
   never runs a package that has not been merged to `main`.
2. Record `ssh deploy@10.100.0.120 dpkg -s portikus | grep Version` before
   and after the change.
3. Take snapshots and a database dump first (next section).
4. Change the pilot only through a Make target or Ansible, never by hand.
5. Never run the smoke test's lifecycle block or a load test on the pilot.
   `make security-test` is safe on the live pilot.
6. Nothing may destroy, stop, restart, rebuild, reset or restore a
   student's workspace or volume without the student knowing.

## Before a change: snapshots and a database dump

Take an Incus snapshot of each workspace's home, Docker and recovery volume, and
a `pg_dump` (a PostgreSQL export) of the platform database to the host.
Name the snapshots after the change, for example `pre-epic12b`.

```
ssh deploy@10.100.0.120 'for v in $(sudo incus storage volume list workspace-data --project portikus -f csv -c n | grep -E "^ws-.*-(home|docker|recovery)$"); do sudo incus storage volume snapshot create workspace-data "$v" pre-CHANGE --project portikus; done'
ssh deploy@10.100.0.120 'sudo runuser -u postgres -- pg_dump -Fc portikus' > ~/portikus-pre-CHANGE-$(date +%F).dump
```

No script ever deletes a `pre-...` snapshot. Delete old ones by hand once
the change has proved itself for a week or so. A fresh `make backup` is
also a good idea before any larger change.

To undo a bad change, install the previous package
(`make configure-vm PORTIKUS_VERSION=<old version>`) and, only if the
database itself is wrong, load the dump with `pg_restore --clean`.

## Deploying

```
git fetch origin && git checkout origin/main
nvm use
make build-deb
make configure-vm PORTIKUS_DEB=dist/deb/portikus_<version>_amd64.deb PORTIKUS_IDP=<provider>
make smoke-test PORTIKUS_IDP=<provider>
```

- `make build-deb` builds the control-plane Debian package into `dist/deb`.
- `make configure-vm` runs the whole Ansible play. With `PORTIKUS_DEB` it
  installs that local package. Without it, it installs the newest
  published release, and `PORTIKUS_VERSION=<version>` installs an older
  one, which is how a rollback works.
- Run `configure-vm` when no workspace is being created. A controller
  restart in the middle of a create used to leave the workspace in
  `error`. The worker now retries the create, but it is still better not
  to race it (docs/CAPACITY.md, "Limits observed").

`PORTIKUS_IDP` picks the sign-in provider: `dex` (the default, and what
the pilot uses), `entra`, `google`, `external` or `mock`. "Sign-in
providers", below, says how to set up each one. Pass the same value, and
the same provider settings, on every `configure-vm`; a different value
switches the site to another provider. Never use `mock` on a VM others
can reach: anyone could sign in as anyone.

**After a deploy that changes `infra/host/backup.sh`, run
`make backup-install-timer` on the host.** The nightly timer runs an
installed copy of the script, not the checkout. Epic 14 is such a change:
until the timer is reinstalled, the nightly set has no `dex.dump`, so it
cannot bring back Dex's accounts.

`make deploy-app` builds and installs the package without Ansible. It is
quicker for a small application fix, but it skips everything else, so
prefer `configure-vm`.

## Sign-in providers

A site has one sign-in provider (docs/archive/epics/EPIC-14.md, rulings 1 to 13).
Opening Portikus from a course (LTI) works alongside whichever it is.
Every provider speaks OpenID Connect (OIDC), and an account is always
keyed by the provider's issuer and its `sub` claim (the provider's
permanent ID for the person), never by email.

| Provider | `PORTIKUS_IDP` | Who may sign in | Role comes from | No role matched |
|---|---|---|---|---|
| Microsoft Entra ID | `entra` | the site's tenant | Entra app roles | refused |
| Google Workspace | `google` | the listed domains | grants in the Users view | student |
| Dex, its own passwords | `dex` | people an administrator added | grants in the Users view | student |
| Dex with LDAP or Active Directory | `dex` | people the user filter admits | directory groups, or grants | student |
| Dex in front of Entra or Google | `dex` | the tenant or domains | grants in the Users view | student |
| Another OIDC provider | `external` | whoever the provider signs in | the `groups` claim | refused |

A "grant" is the stored role an administrator sets with Make instructor
or Promote in the Users view (docs/archive/epics/EPIC-13-1.md). It lasts across
sign-ins.

Every setting below is an environment variable read by `make
configure-vm`. Keep secrets off the command line, where shell history
keeps them. Export them from a prompt instead:

```
read -rs PORTIKUS_OIDC_CLIENT_SECRET && export PORTIKUS_OIDC_CLIENT_SECRET
```

After changing provider, run `make smoke-test` and `make security-test`
with the same `PORTIKUS_IDP`. Then do one real sign-in, and issue a setup
code if the site has no administrator yet ("The first administrator",
below).

**The API reaches a provider by name, through the egress proxy.** Ansible
reads the provider's discovery document while it runs and allows the
hosts it names. Nobody types address ranges. See "The egress proxy",
below.

**Changing the provider of a site that already has accounts** gives
everyone a new, empty account, because the issuer changes. No tool
carries accounts from one provider to another (docs/archive/epics/EPIC-12B.md, risk
7). The mock-to-Dex carry-over the pilot used once, on 2026-09-23, was
removed with the users file, so a backup from before that date restores
accounts that only the mock can sign in to. Once the site uses any
other provider, every play run ends the sessions of the mock's accounts.

### Microsoft Entra ID

Only people from one Entra tenant (one organisation's directory) can sign
in. Guests invited into that tenant are checked like anyone else. Their
role comes from an app role, which Entra sends in the ID token's `roles`
claim. Portikus checks the token's `tid` claim against the tenant and
does not call Entra's userinfo endpoint. One tenant per site is a ruling;
more would need its own security review (ruling 8).

In the Microsoft Entra admin center:

1. **App registrations, New registration.** Name it Portikus. For
   supported account types, choose "Accounts in this organizational
   directory only (Single tenant)". Add a redirect URI of platform **Web**:
   `https://<public host>:<port>/auth/callback` (leave out `:<port>` when
   it is 443).
2. On the registration's **Overview**, copy the **Application (client) ID**
   and the **Directory (tenant) ID**.
3. **Certificates & secrets, New client secret.** Copy its **Value**, not
   its ID. Note when it expires: sign-in stops working that day unless a
   new secret is deployed first.
4. **App roles, Create app role**, three times. Allowed member types:
   Users/Groups. The values must be exactly `Portikus.Student`,
   `Portikus.Instructor` and `Portikus.Administrator`.
5. **Enterprise applications, Portikus, Properties.** Set "Assignment
   required?" to **Yes**, so only assigned people can get a token.
6. **Users and groups, Add user/group.** Assign each person, or a group,
   one of the three roles. Assigning groups needs an Entra ID P1 licence
   or higher.

Then deploy:

```
read -rs PORTIKUS_OIDC_CLIENT_SECRET && export PORTIKUS_OIDC_CLIENT_SECRET
make configure-vm PORTIKUS_IDP=entra PORTIKUS_ENTRA_TENANT_ID=<tenant ID> \
  PORTIKUS_OIDC_CLIENT_ID=<application ID>
```

The play derives the issuer, `https://login.microsoftonline.com/<tenant
ID>/v2.0`, and refuses a tenant ID that is not a GUID or a client secret
shorter than 32 characters. Someone with no Portikus app role cannot sign
in at all, so assign the first administrator the role
`Portikus.Administrator`, or at least `Portikus.Student`, before they
claim the setup code. `PORTIKUS_OIDC_STUDENT_GROUP`,
`PORTIKUS_OIDC_INSTRUCTOR_GROUP` and `PORTIKUS_OIDC_ADMIN_GROUP` change
the three role values if a tenant already uses other names.

A refused sign-in shows the "not authorized" page and writes an
`auth.login` audit row with the result `denied` and the reason
`tenant_not_allowed`.

### Google Workspace

Only accounts from the listed Google Workspace domains can sign in.
Portikus checks the ID token's `hd` ("hosted domain") claim. A personal
Gmail account has none and is refused. Google sends no groups, so
everyone starts as a student, and an administrator uses Make instructor
or Promote in the Users view.

In the Google Cloud console, in a project owned by the organisation:

1. **Google Auth Platform** (formerly the OAuth consent screen). Choose
   the audience **Internal**, so only the organisation's accounts are
   offered.
2. **Clients, Create client.** Type: **Web application**. Add the
   authorised redirect URI `https://<public host>:<port>/auth/callback`.
3. Copy the client ID and the client secret.

Then deploy:

```
read -rs PORTIKUS_OIDC_CLIENT_SECRET && export PORTIKUS_OIDC_CLIENT_SECRET
make configure-vm PORTIKUS_IDP=google PORTIKUS_GOOGLE_DOMAINS=example.edu,students.example.edu \
  PORTIKUS_OIDC_CLIENT_ID=<client ID>
```

The sign-in sends the first domain to Google as a hint for its account
picker. The check at the callback is what counts. A refused sign-in is
audited with the reason `domain_not_allowed`. A whole domain is
admitted; a site that wants fewer people should put Dex in front
instead, or ask for a Google group check (docs/BACKLOG.md).

### LDAP and Active Directory

Dex checks the password against the directory and passes the person's
groups on. Portikus itself never talks to the directory. Dex's own
passwords stay on beside it, for guests, and Dex shows a choice page
first.

```
read -rs PORTIKUS_LDAP_BIND_PASSWORD && export PORTIKUS_LDAP_BIND_PASSWORD
export PORTIKUS_LDAP_USER_FILTER='(&(objectClass=user)(memberOf=CN=Portikus Users,OU=Groups,DC=example,DC=edu))'
make configure-vm PORTIKUS_IDP=dex PORTIKUS_DEX_UPSTREAM=ldap \
  PORTIKUS_LDAP_HOST=ldap.example.edu:636 PORTIKUS_LDAP_SCHEMA=ad \
  PORTIKUS_LDAP_BIND_DN='CN=svc-portikus,OU=Service,DC=example,DC=edu' \
  PORTIKUS_LDAP_USER_BASE_DN='OU=People,DC=example,DC=edu' \
  PORTIKUS_LDAP_GROUP_BASE_DN='OU=Groups,DC=example,DC=edu' \
  PORTIKUS_LDAP_IP_ALLOW=192.0.2.10/32,192.0.2.11/32
```

| Setting | What it is |
|---|---|
| `PORTIKUS_LDAP_HOST` | `host` or `host:port`. Always over TLS (LDAPS), port 636 by default. |
| `PORTIKUS_LDAP_SCHEMA` | `ad` or `openldap`. It picks the attribute names (below). |
| `PORTIKUS_LDAP_BIND_DN`, `PORTIKUS_LDAP_BIND_PASSWORD` | A read-only service account Dex searches with. |
| `PORTIKUS_LDAP_USER_BASE_DN` | Where people are searched for. |
| `PORTIKUS_LDAP_USER_FILTER` | **Required**, in parentheses. It is the only gate: without it every account in the directory could sign in. |
| `PORTIKUS_LDAP_GROUP_BASE_DN` | Optional. Where groups are searched for. Without it everyone signs in as a student. |
| `PORTIKUS_LDAP_ROOT_CA` | Optional. A CA certificate file on the machine that runs Ansible, when the directory's certificate is not signed by a public authority. |
| `PORTIKUS_LDAP_IP_ALLOW` | **Required.** The directory's addresses, as CIDRs. Dex's unit may reach only these; LDAP does not go through the egress proxy. |

The schema picks these attributes. People sign in with the username
attribute. Group members are matched by their full distinguished name
(DN) in the group's `member` attribute.

| Schema | Username | ID | Display name | Groups searched |
|---|---|---|---|---|
| `ad` | `sAMAccountName` | `sAMAccountName` | `displayName` | `(objectClass=group)` |
| `openldap` | `uid` | `entryUUID` | `cn` | `(objectClass=groupOfNames)` |

The ID becomes the person's Portikus identity, and their workspace hangs
off it. OpenLDAP's `entryUUID` is never reused, so a new person who is
later given an old username gets a new, empty account. Active Directory
has no text attribute like that: its `objectGUID` is binary, and Dex
v2.45.1 copies it into the token's subject as raw bytes, which fail to
encode for most accounts. So under AD the ID is the username, and **a
reused username inherits the old account, its workspace and its role.**
Disable a departed person's AD account; never delete it and give the
name to someone else. Under either schema, groups name their members by
DN, which a reused name shares, so also take a departed person out of
the Portikus groups. Before Epic 14's review the OpenLDAP ID was `uid`.
No site used LDAP then, but a site that did would find everyone's next
sign-in making a new, empty account.

The role comes from groups whose `cn` is `portikus-students`,
`portikus-instructors` or `portikus-administrators`. Change the names with
`PORTIKUS_OIDC_STUDENT_GROUP`, `PORTIKUS_OIDC_INSTRUCTOR_GROUP` and
`PORTIKUS_OIDC_ADMIN_GROUP`. Someone in none of them is a student. Group
search does not follow nested groups.

**User filters.** Admit only the people who should use Portikus, usually
the members of one group:

- Active Directory, enabled members of one group:
  `(&(objectClass=user)(memberOf=CN=Portikus Users,OU=Groups,DC=example,DC=edu)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`.
  The last part leaves out disabled accounts.
- Active Directory, members of a group or of any group nested inside it:
  use `memberOf:1.2.840.113556.1.4.1941:=` in place of `memberOf=`.
- OpenLDAP, members of one group (needs the `memberof` overlay):
  `(&(objectClass=inetOrgPerson)(memberOf=cn=portikus,ou=groups,dc=example,dc=edu))`.

Test a filter with `ldapsearch` from a machine that can reach the
directory before deploying it. Bad or missing settings stop the play
before anything on the VM changes.

### Standalone Dex

The default, for a site with no institutional provider. Dex runs on the
VM and keeps its own passwords in its PostgreSQL database, `dex`. Nothing
needs setting. A new site has nobody who can sign in, so the first
administrator creates their own account on `/setup` with the setup code
("The first administrator", below). After that, administrators manage
everyone from the Users view ("Managing users", below).

The Users view reaches Dex through Dex's gRPC API (a remote procedure
call interface) on `127.0.0.1:5557`. It accepts only a client
certificate signed by a small certificate authority that Ansible keeps in
`/etc/portikus/dex-grpc/`. The API's client key there is `root:portikus`,
mode 0640. The certificates last 825 days, and every `make configure-vm`
issues new ones when fewer than 30 days are left. A site that goes two
years without a deploy would find the Users view's Dex buttons failing;
a `make configure-vm` fixes it.

### Dex in front of Entra or Google, for guests

When a site has Entra or Google but also needs accounts for people
outside it, Dex sits in front. Guests get Dex passwords; everyone else
chooses Microsoft or Google on Dex's choice page. Dex, not Portikus, is
registered with the provider:

- Register the app as for direct Entra or Google, but with the redirect
  URI `https://<public host>:<port>/dex/callback`.
- Entra app roles are not used, and Google sends no groups. Everyone
  starts as a student, and roles come from grants in the Users view.
  Portikus does not ask Dex for groups here: Dex's Microsoft connector
  would pass on every group the person belongs to, including Microsoft
  365 groups any student can create and name after the administrators'
  group. A play that sets `PORTIKUS_OIDC_SCOPES` with `groups` under
  either connector stops with an error. Because a student could still add
  `groups` to the sign-in address themselves, the play also leaves the
  API's `OIDC_GROUPS_CLAIM` empty here, and the API then takes no role
  from any groups in the token.

```
read -rs PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET && export PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
make configure-vm PORTIKUS_IDP=dex PORTIKUS_DEX_UPSTREAM=microsoft \
  PORTIKUS_ENTRA_TENANT_ID=<tenant ID> PORTIKUS_DEX_UPSTREAM_CLIENT_ID=<application ID>
```

For Google, use `PORTIKUS_DEX_UPSTREAM=google` and
`PORTIKUS_GOOGLE_DOMAINS` in place of the tenant ID. Dex holds sign-in to
the tenant or the domains itself. It reaches Microsoft or Google through
the egress proxy. The Users view manages only the Dex (guest) accounts.

### Another OIDC provider: Okta, Keycloak and others

Any provider that speaks OIDC and can put group names in a `groups` claim
works as `external`. Register a client with the redirect URI
`https://<public host>:<port>/auth/callback`, then:

```
read -rs PORTIKUS_OIDC_CLIENT_SECRET && export PORTIKUS_OIDC_CLIENT_SECRET
make configure-vm PORTIKUS_IDP=external PORTIKUS_OIDC_ISSUER=https://idp.example.edu \
  PORTIKUS_OIDC_CLIENT_ID=portikus
```

- The client secret must be at least 32 characters.
- The group names default to `portikus-students`,
  `portikus-instructors` and `portikus-administrators`; the
  `PORTIKUS_OIDC_*_GROUP` settings change them.
- The scopes default to `openid profile email`. Set
  `PORTIKUS_OIDC_SCOPES` if the provider needs another scope before it
  sends groups.
- Someone in none of the groups cannot sign in.
- The API calls this provider's userinfo endpoint, so its host is on the
  allow list too.

### Shibboleth, and why not SAML

Portikus speaks only OIDC. A campus that signs people in with Shibboleth
or another SAML (Security Assertion Markup Language) identity provider
uses the Shibboleth identity provider's own OIDC support:

1. Install the **OIDC OP** plugin on the Shibboleth identity provider
   (version 4.1 or later).
2. Register Portikus as an OIDC relying party, with a client ID, a client
   secret of 32 characters or more, and the redirect URI
   `https://<public host>:<port>/auth/callback`.
3. Release `sub`, `email` and `name`, and a `groups` claim holding the
   three Portikus group names, for example from `isMemberOf` or
   `eduPersonEntitlement`.
4. Configure Portikus as "Another OIDC provider", above.

Why not SAML directly: one sign-in protocol keeps the security-sensitive
code, its tests and its identity rule in one place. SAML would add XML
signature checking, a common source of sign-in bypasses, for sites that
can already turn OIDC on. Dex does have a SAML connector, but its own
documentation warns that it is not maintained, so it is not built
(ruling 7).

### First checks with a real provider

The imitation tokens in the tests prove Portikus's own checks, not how a
real provider behaves (docs/archive/epics/EPIC-14.md, "Unverified until a real tenant
exists"). The first time a site uses Entra, Google or Active Directory,
check these, and record the results in docs/STATUS.md:

- Entra puts `roles` in the ID token for this registration, and `tid`
  for a guest (B2B) account.
- The allow list the play built covers every host the sign-in uses,
  including key rotation: a sign-in a day or two later still works.
- Google sends `hd` for every Workspace account and honours the hint.
- Linking a course account (Settings, Profile) forces a password prompt
  at Entra or Google.
- Dex's `microsoft` and `google` connectors, and the LDAP connector
  against real Active Directory.

## Managing users

Under Dex, administrators manage accounts in the Users view of `/admin`
(docs/archive/epics/EPIC-14.md rulings 21 to 24, ADR 0028). Dex keeps them in its
PostgreSQL database, `dex`, and the nightly backup holds them as
`dex.dump`.

- **Add user…** takes an email, a username and a role: student,
  instructor or administrator. Portikus makes a 20-character password and
  shows it once, with a Copy button. Give it to the person privately, in
  person or by a private message in the learning system, never by plain
  email. The account exists in Portikus straight away, so an instructor
  or administrator role is a stored grant from the start.
- **Reset password** makes a new password, shows it once, and ends the
  account's sessions and preview sessions. People cannot change their own
  password, so a reset is how a forgotten one is replaced.
- **Remove** deletes the Dex password and disables the account, which
  ends its sessions. The workspace stays; archive it from the same page
  when it is no longer needed.
- To change someone's email or username, remove them and add them again.
  The new account starts with a new, empty workspace.
- To stop someone at once without removing them, **Disable** the account.

These buttons appear only when the provider is Dex. With an upstream
connector they manage only Dex's own (guest) accounts; people from the
directory, Microsoft or Google are managed there. Under any provider,
**Make instructor**, **Remove instructor**, **Promote** and **Demote** set
or clear a stored grant. None of them ends sessions; the next request
reads the new role.

Portikus never stores or logs a generated password. Each action writes an
audit row (`dex_user.created`, `dex_user.password_reset`,
`dex_user.removed`) with no password, hash or email in it.

**The users file is retired.** Before Epic 14, Dex's accounts lived in a
users file on the host and `make users-*` managed them. The first `make
configure-vm` of a release with Epic 14 imports that file once, when it
exists (`PORTIKUS_USERS_FILE`, by default
`~/.config/portikus/users.json`) and Dex's storage holds no passwords. It
keeps each password's hash and user ID, so every account keeps its `sub`
and its workspace, and an administrator or instructor in the file becomes
a stored grant. A later run prints "Dex already holds N passwords;
nothing imported." The pilot's import ran on 2026-09-24. Once the nightly
backup holds `dex.dump`, delete the file, so a later play on an empty
Dex cannot bring old passwords back.

## The first administrator

A new site has no administrator. Nobody becomes one just by signing in
first. Instead, when no enabled administrator exists, the end of `make
configure-vm` prints a one-time **setup code** and the address
`https://<public host>:<port>/setup` (ADR 0028). The code is 16
characters, works once, and expires after an hour. Only its hash is
stored.

- **Under Entra, Google, LDAP or another OIDC provider**, sign in, open
  `/setup`, and enter the code. The account is an administrator from the
  next request.
- **Under standalone Dex**, nobody can sign in yet, so `/setup` shows a
  form that creates the first account instead: email, username, the
  password twice, and the code. Then sign in normally.
- A course (LTI) account cannot claim a code. Under Entra, the person
  needs a Portikus app role before they can sign in at all.
- A wrong code gets one generic answer. Ten tries per address in ten
  minutes are allowed.

To issue a new code by hand, because the hour passed or because every
administrator is gone, run the same command the play runs. A new code
replaces any unused one:

```
ssh deploy@10.100.0.120 'sudo runuser -u portikus -- env DATABASE_URL="postgresql://portikus@/portikus?host=/var/run/postgresql" node /usr/lib/portikus/api/node_modules/@portikus/auth/dist/setup-code-main.js'
```

Only root on the VM can run it, and root already owns the site, so this
is also the recovery path. Issuing and claiming are audited
(`setup.code_issued`, `setup.code_claimed`), never with the code in the
row. Epic 15 will wrap the command as `portikus setup-code`.

## The Dex cutover and the storage move

The pilot moved from the mock provider to Dex on 2026-09-23 (task A6,
docs/archive/epics/EPIC-12B.md). Its accounts moved into Dex's storage on 2026-09-24
(Epic 14). Both kept every account, `sub` and workspace. docs/STATUS.md
records each run and its snapshots and dump.

A move like these follows the same steps:

1. Record `dpkg -s portikus` on the pilot.
2. Take `pre-<change>` snapshots of each `-home`, `-docker` and
   `-recovery` volume and a `pg_dump` to the host ("Before a change").
3. Rehearse on the rehearsal VM with the pilot's newest backup restored
   ("Restore"), and check with SQL that every account still owns its
   workspace.
4. Run `make configure-vm` on the pilot with the usual settings.
5. Check the same SQL on the pilot. Run `make smoke-test` and `make
   security-test`, and have people sign in.
6. Record `dpkg -s portikus` again.
7. If anything fails, install the previous package with its own play
   (check out the matching commit, then `make configure-vm
   PORTIKUS_DEB=<previous package>`), and load the `pg_dump`. The
   snapshots are untouched.

**Signing out of Portikus does not end a Dex session, and none is needed.**
Dex's password login keeps no browser session, so the next sign-in always
asks for the password again. That suits shared lab computers: the next
person at the machine cannot sign in as the last one. Entra, Google and
Dex's `microsoft` and `google` connectors are different: the provider
keeps its own session, so on a shared computer people must also sign out
of Microsoft or Google.

## The egress proxy

The API may reach only loopback and the workspace bridge; its systemd unit
denies every other address. It reaches its sign-in provider and each
LMS's keyset through Squid, a forward proxy on `127.0.0.1:3128`, which
allows only named hosts (ADR 0027). Dex uses the same proxy for a
`microsoft` or `google` connector. Nothing else goes through it; the
workspaces have their own egress rules.

- **What it allows.** A host name is reached only over HTTPS (a
  `CONNECT` tunnel) on port 443, or on the port listed with it, and never
  at a private, loopback or link-local address. An IPv4 address listed
  with a port is allowed exactly, plain HTTP included. Any other address
  given directly, IPv4 or IPv6, is refused; names are matched as
  written, never through reverse DNS. Squid caches nothing and never
  sees inside the TLS connection.
- **Where the list comes from.** Every `make configure-vm` rebuilds it
  from the provider's discovery document (fetched while the play runs),
  the keyset URL of every registered LMS, and
  `PORTIKUS_EGRESS_EXTRA_HOSTS`. Under Dex or the mock, the site's own
  name is allowed at `127.0.0.1` only, because the API reaches its issuer
  through Caddy on the same VM. The play prints the list, and it is in
  `/etc/squid/squid.conf` on the VM.
- **Adding a host.** List it with its port if that is not 443, separated
  by commas, and run the play again:
  `make configure-vm PORTIKUS_EGRESS_EXTRA_HOSTS=keys.example.edu,192.0.2.10:8443`.
  Each host added is a place a compromised API could send requests, so
  add only what a sign-in or launch needs.
- **`PORTIKUS_API_IP_ALLOW` is gone.** A play that still sets it stops
  with a message naming `PORTIKUS_EGRESS_EXTRA_HOSTS`, and the play
  deletes the old `10-idp-egress.conf` drop-in.
- **When it fails.** If Squid stops, SSO sign-ins through Entra, Google
  or another outside provider, and every LMS launch, stop too; Dex's own
  passwords and LDAP do not use it. systemd restarts it after a failure.
  Refusals are in `/var/log/squid/access.log` as `TCP_DENIED/403` with
  the host that was refused:

  ```
  ssh deploy@10.100.0.120 'systemctl status squid; sudo tail -20 /var/log/squid/access.log'
  ```

  The smoke test checks that the proxy runs, listens on loopback only,
  reaches the site's issuer and refuses an unlisted host. The security
  test's egress module checks that the API's own user, under the API
  unit's address rules, cannot reach the internet directly.

## The sign-in throttle

Dex has no lockout, so the API slows repeated sign-ins from one address
(#398, `apps/api/src/signin-throttle.ts`):

- Sign-in starts: 150 a minute per address. These are `/auth/login`,
  `/auth/callback`, and every GET under `/dex/auth`. One sign-in makes
  about five, so one address can complete about 30 sign-ins a minute,
  enough for a lab behind one campus address.
- Dex password posts, to Dex's own form or the LDAP connector's: 30 per
  10 minutes per address, and 300 per 10 minutes for everyone together.
  Caddy asks the API before each post reaches Dex. Attempts one address has already had refused do not count
  toward the shared 300, so one address cannot lock out the class.

Caddy also lets only the Dex paths a sign-in uses reach Dex: `/dex/auth*`,
`/dex/token`, `/dex/userinfo`, `/dex/keys`, `/dex/.well-known/*`,
`/dex/static/*`, `/dex/theme/*` and `/dex/callback*`. Anything else under
`/dex` is a 404, a URI longer than 1024 bytes is a 414, and a method other
than GET on `/dex/auth` is a 405, apart from the two password forms.

A refusal answers 429 with `RATE_LIMITED` and writes one `auth.throttled`
audit event per address per window. The counts live in the API's memory,
so restarting `portikus-api` clears them.

If many students share one address behind a campus network, raise the
limits with `SIGNIN_START_LIMIT_PER_MINUTE` and
`PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES`. Set them in a systemd drop-in, not
in `/etc/portikus/api.env`: Ansible rewrites `api.env` on every
`make configure-vm`, and it leaves a drop-in alone. On the VM:

```sh
sudo systemctl edit portikus-api
```

In the editor, add the values you need, then save:

```ini
[Service]
Environment=SIGNIN_START_LIMIT_PER_MINUTE=300
Environment=PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES=60
```

Then run `sudo systemctl restart portikus-api`. A value in an
`EnvironmentFile` beats a drop-in's `Environment=`. That is not a problem
here, because `api.env` does not set these two variables. Check the result
with `sudo systemctl show portikus-api -p DropInPaths`. To go back to the
defaults, delete `/etc/systemd/system/portikus-api.service.d/override.conf`,
then run `sudo systemctl daemon-reload` and restart the API. Do not use
`systemctl revert`: it deletes every drop-in, including any a later
release adds.
This was tested on the rehearsal VM on 2026-09-23. With a start limit of
400, 160 starts from one address in a minute all got through, where the
default refuses the last 10.

## Signing in from a learning management system (LTI 1.3)

A learning management system (LMS), such as Canvas or Moodle, can open
Portikus from a course. LTI 1.3 (Learning Tools Interoperability) is the
standard for this. The LMS signs a token that names the person, their
role and the course. Portikus checks it and signs the person in with no
second password. Students land in their own workspace. Instructors,
teaching assistants and course designers land in their own workspace too,
and also get a read-only **Course** page. The design is in ADR 0025 and
`docs/archive/epics/EPIC-13.md`.

LTI is off until at least one LMS is registered. Every `/lti/*` route then
answers 404.

### What Portikus tells the LMS

Use the public URL of the site, shown here as `https://<site>`, for the
pilot `https://portikus.192.168.10.48.nip.io:8443`.

| What the LMS asks for | Value |
|---|---|
| Login initiation URL | `https://<site>/lti/login` |
| Redirect URI and target link URI | `https://<site>/lti/launch` for the redirect, `https://<site>/` for the target link |
| Public keyset URL (JWKS, the tool's public keys) | `https://<site>/lti/jwks` |

**Canvas.** An administrator opens Admin, Developer Keys, and adds an
**LTI Key**. Set:

- Redirect URIs: `https://<site>/lti/launch`.
- Target Link URI: `https://<site>/`.
- OpenID Connect Initiation Url: `https://<site>/lti/login`.
- JWK Method: **Public JWK URL**, with `https://<site>/lti/jwks`.
- Placement: Course Navigation (or Link Selection), with the privacy level
  at least "Public" so the name is sent.
- Turn the key on, and note its client id (the number under Details).
  Add the tool to the account or course by that client id, and note the
  deployment id Canvas shows for it.
- Custom Fields: `username=$Canvas.user.loginId`, so each student's
  workspace is named after their login (see "The workspace name" below).
- Ask Canvas to **open in a new window**: in the placement's settings, set
  the window target to `_blank` (in the configuration JSON,
  `"windowTarget": "_blank"`).

For Canvas cloud, the platform values are always the issuer
`https://canvas.instructure.com`, the auth login URL
`https://sso.canvaslms.com/api/lti/authorize_redirect`, and the keyset URL
`https://sso.canvaslms.com/api/lti/security/jwks`.

**Moodle.** An administrator opens Site administration, Plugins, Activity
modules, External tool, **Manage tools**, and configures a tool manually:

- Tool URL: `https://<site>/`.
- LTI version: **LTI 1.3**.
- Public key type: **Keyset URL**, with Public keyset `https://<site>/lti/jwks`.
- Initiate login URL: `https://<site>/lti/login`.
- Redirection URI(s): `https://<site>/lti/launch`.
- Default launch container: **New window**.
- Under Privacy, share the launcher's name (and email if wanted) with the tool.
- Custom parameters: `username=$User.username`, so each student's
  workspace is named after their login (see "The workspace name" below).

After saving, the tool's "View configuration details" shows the platform
ID (the issuer), client ID, deployment ID, public keyset URL and
authentication request URL. Those go in the platforms file.

**The workspace name.** A student's workspace name starts every preview
address and the terminal prompt. LTI 1.3 has no standard username, so
Portikus reads the `preferred_username` claim if the LMS sends one, else
the custom parameter `username` set above. Without either, the name is
made from the LMS's user ID, which is often a long opaque string. The name
is fixed when the workspace is created, so add the custom parameter before
students first launch.

"Open in a new window" matters. Inside a frame, the browser often blocks
the cookie the launch needs. Portikus then shows a page with an **Open
Portikus in a new tab** button, which works, but costs the student a click.

### The platforms file

The registered platforms live in `~/.config/portikus/lti-platforms.json`
on the host (Makefile `PORTIKUS_LTI_PLATFORMS_FILE`). It holds no secret.

```json
{ "version": 1,
  "platforms": [
    { "name": "Canvas",
      "issuer": "https://canvas.instructure.com",
      "clientId": "10000000000001",
      "authLoginUrl": "https://sso.canvaslms.com/api/lti/authorize_redirect",
      "keysetUrl": "https://sso.canvaslms.com/api/lti/security/jwks",
      "deploymentIds": ["1:8865aa05b4b79b64a91a86042e43af5ea8ae79eb"],
      "mock": false } ] }
```

- `name` is 1 to 60 characters and unique. It shows on the Course page and
  in audit rows.
- `issuer`, `authLoginUrl` and `keysetUrl` must be HTTPS.
- `deploymentIds` lists every deployment id the LMS may send. Re-adding
  the tool in the LMS can make a new one.
- Each issuer and client id pair appears once. Unknown keys and an empty
  `platforms` list are refused.

Apply it with `make configure-vm` (out of class hours, after "Before a
change"). Ansible copies the file to `/etc/portikus/lti-platforms.json`
and checks it with the API's own parser before installing it, so a bad
file stops the run with the problem named. To turn LTI off, delete the
file and run `make configure-vm` again.

### Egress to the LMS

Portikus fetches each platform's keyset to check a launch's signature. It
reaches the keyset through the egress proxy, and Ansible adds the host of
every keyset URL in the platforms file to the proxy's allow list, so a
cloud LMS needs nothing more. A keyset URL that names an IP address, such
as the mock LMS's, is allowed at that address and port only. If a launch
fails with `keyset_unavailable`, see "The egress proxy".

### Roles and the Course page

- LTI gives `instructor` for the LMS membership roles Instructor,
  TeachingAssistant and ContentDeveloper (and their sub-roles), and for
  Administrator under the institution, system or membership vocabularies.
  A bare `Administrator` short form gives `student`, as does everything
  else, including an institution-level Instructor. LTI never gives `administrator`.
- The role is refreshed on every launch, and a change is audited.
- An SSO account can be an instructor too: from its provider's groups or
  app roles, or from **Make instructor** in the Users view, which stores
  a grant that later sign-ins do not overwrite.
- An instructor sees a **Course** link in the header. The Course page lists
  everyone who has opened Portikus from that course, with name, role, last
  launch and whether their workspace is running. An instructor can remove
  one member, which deletes only that membership row; a later launch from
  the LMS adds it back. An instructor cannot see anyone else's files and
  is refused on every administrator page.
- Someone removed from the course in the LMS, and not also removed from
  the Course page by the instructor, stays there with their old last-launch
  time.
- An LTI user and an SSO user are separate accounts, even with the same
  email, unless someone links them (see "Linking a course account to an
  SSO account", below).

### When a launch fails

The student sees a refusal page. The reason is in the `auth.login` audit
rows on the admin page (method `lti`, with a reason code such as
`unknown_deployment` or `keyset_unavailable`), and in the API log:

```
sudo journalctl -u portikus-api -o cat --since -1h | grep -i lti
```

A missing state cookie or a framed launch is only in the log, not the
audit. The usual fix for `unknown_deployment` is to add the new deployment
id to the file. For `keyset_unavailable`, check the egress allow list.

### Trying it with the mock LMS

A mock LMS runs on the host, never on the VM. It listens on port 8765 at
`127.0.0.1`, the host's address on the VM network (`10.100.0.1`), and the
host's LAN address (`HOST_IP`, the address in the public site's name),
and registers itself at the LAN address. A platform's URLs must be
reachable both by the user's browser, which is redirected to its login
page, and by the API on the VM, which fetches its keyset. A real LMS on
the internet meets that; the mock must use an address the browser can
reach, so `10.100.0.1` would work only from a browser on this host.
Override it with `MOCK_LMS_HOST`. Anyone who can reach the mock can launch
as anyone, so it is trusted only while it is registered.

1. In one terminal, start it and leave it running:

   ```
   make mock-lms
   ```

2. In another, register it. This adds a `mock-lms` entry to the platforms
   file and applies only the LTI tasks:

   ```
   make lti-mock-register
   ```

3. Open `http://<HOST_IP>:8765` (for the pilot, http://192.168.10.48:8765). Pick a person, a course and
   whether to launch inside a frame, then launch. Launch as Sam Student,
   then as Ivy Instructor, and open the Course page.
4. When done, stop trusting it, then stop `make mock-lms` with Ctrl-C:

   ```
   make lti-mock-unregister
   ```

While the mock is registered, `make security-test` prints a warning
naming it, and the smoke test reports it. Users created by mock launches
stay in the database, under the issuer `lti:http://<MOCK_LMS_HOST>:8765`.

## Linking a course account to an SSO account

A person who signs in both by an LTI launch and through single sign-on
(SSO) can link the two from Settings, Profile, so every later launch lands
in the SSO account. The design is `docs/archive/epics/EPIC-13-1.md` and ADR 0026. There
is no operator step to make linking available; it works once both an LMS
and the OIDC provider are configured.

- **The course account's workspace is archived, not deleted**, when it
  links, and unarchived automatically if the person unlinks. If it stays
  linked, an administrator who needs the old files back can unarchive it
  by hand from the account's page in the Users view, the same **Unarchive**
  button used for any other archived workspace; the account itself stays
  retired (it cannot sign in), only its workspace becomes reachable again.
- **A role grant is separate from the provider's role.** Each sign-in
  sets the role the provider gives (`provider_role`), from its groups or
  app roles. Promote and Make instructor in the Users view set a stored
  grant (`granted_role`) that a later sign-in cannot overwrite; the
  account gets the higher of the two. A grant change does not end
  sessions; the next request reads the new role. To see which is in play,
  open the account in the Users view: the Role column says, for example,
  "Administrator (from SSO)" for a provider role and "Administrator
  (granted)" for a stored grant.
- **Under Microsoft Entra ID, roles come from app roles**, which Entra
  sends in the `roles` claim however many groups a person is in. Entra's
  group object IDs and its overage claim are not used (docs/BACKLOG.md).
- **Bulk actions and instructor member removal need no operator step.**
  The Users view's ticked-row Disable, Enable, Archive and Unarchive call
  the same single-row routes as clicking each one, so nothing here differs
  operationally. An instructor removing someone from their Course page
  writes an audit row (`course.member_removed`) and does not touch the
  account or its workspace; a later launch adds the membership back.

## Backups

A backup is pulled from the VM to the host and encrypted there with age, a
small file-encryption tool (ADR 0024). It only reads from the VM: a
`pg_dump` of the platform database and of Dex's `dex` database, and an
Incus export of each workspace's home and recovery
volume, each taken from a short-lived snapshot. It is safe on the live
pilot.

- **When.** Nightly at 02:30 host time, by the host timer
  `portikus-backup.timer`. Install or update it with
  `make backup-install-timer` (rerun after `backup.sh` changes). The timer
  does not catch up: a host that was off at 02:30 skips that night, so a
  backup never starts during class. `make backup` runs one by hand.
- **Where.** `/var/backups/portikus/<hostname>/<timestamp>`, mode 0700,
  for example `/var/backups/portikus/portikus/20260924T023000Z`. Each set
  holds the database dump, Dex's accounts (`dex.dump`, when Dex is the
  provider), one file per volume, a per-file index, and a `MANIFEST`, all
  encrypted. The 14 newest complete sets
  per VM are kept. The directory is outside the libvirt pool, so
  `make destroy-pilot` never touches it.
- **A failed set.** If a volume's export fails, the others are still saved,
  the set gets a `FAILED` file, and the run exits non-zero. Check
  `systemctl status portikus-backup.service` on the host.
- **The key.** `make backup-setup` (run by `make backup`) makes the age key
  pair once: the public half at `~/.config/portikus/backup-recipients.txt`
  and the private half at `~/.config/portikus/backup-age-key.txt`. Backing
  up needs only the public half. **Keep the private key in your password
  manager and remove it from the host.** Without it no backup can be read,
  and on the host it would open every backup to anyone who takes the host.
  A restore reads it from wherever `PORTIKUS_BACKUP_IDENTITY` points.
- **Off-host copy, weekly.** The sets sit on the same physical disk as the
  VM, so they protect against losing the VM or a mistake, not against
  losing the disk. Once a week, copy `/var/backups/portikus` to external
  storage. Automating this is a later task.

What is not backed up: Docker volumes and container root filesystems.
Reset Docker and Rebuild recreate them, and SPEC.md section 17.3 says
packages a student installs are not kept.

## Restore

Start every restore drill by proving the key still opens the newest set.
This touches no VM:

```
PORTIKUS_BACKUP_IDENTITY=<path to the private key> \
  bash infra/host/restore.sh --check /var/backups/portikus/portikus/<timestamp>
```

**Onto the rehearsal VM** (a drill, or the cutover rehearsal):

```
make rehearsal-up
make configure-vm TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=<as the pilot>
make restore TOFU_ENV=rehearsal-libvirt BACKUP=/var/backups/portikus/portikus/<timestamp> START_CHECK=1
```

`make restore` refuses the pilot's environment and any VM whose hostname
is not the one in the state. It refuses a target that already has any
workspace volume, user, workspace or project, so it can never overwrite a
live VM. It loads the database, imports each volume under its original
name, and leaves every restored workspace stopped. `START_CHECK=1` then
starts one workspace, checks its files and Git commits from inside it, and
stops it. When the exercise is over, run
`make restore TOFU_ENV=rehearsal-libvirt BACKUP=<same set> REMOVE=1` and
then `make rehearsal-destroy`.

**Onto an empty VM, for a real disaster recovery.** If the pilot is lost:

1. Rebuild it from code (`make infra-apply`, `make configure-vm` with the
   usual provider settings, and `make build-workspace-image`). It comes
   up with an empty database and no workspace volumes. Ignore the setup
   code the play prints; the restored database has its administrators.
2. Check the set with `restore.sh --check` as above.
3. Run `restore.sh` directly, since `make restore` refuses the pilot:

   ```
   PORTIKUS_BACKUP_IDENTITY=<key> bash infra/host/restore.sh --start-check \
     --target-name portikus 10.100.0.120 /var/backups/portikus/portikus/<timestamp>
   ```

   With a `dex.dump` in the set, the restore also loads Dex's accounts,
   with Dex stopped, so everyone keeps their password.
4. Run `make smoke-test` and `make security-test`, and sign in as an
   administrator to check that the workspaces are listed.
5. Tell the students their workspaces are back. They start them as usual.

The rebuilt pilot keeps the same public host name and port, so the
database's recorded Dex issuer still matches.

## The rehearsal VM

`TOFU_ENV=rehearsal-libvirt` selects the rehearsal VM: `portikus-rehearsal`,
on its own network `10.101.0.0/24`, with its own disk pool and its own
OpenTofu state under `~/.local/state/portikus/rehearsal-libvirt/`. It
shares nothing with the pilot.

- `make rehearsal-up` creates or updates it and waits for it. It refuses
  when the host has less free memory than the VM needs.
  `REHEARSAL_VCPUS`, `REHEARSAL_MEMORY_MB` and `REHEARSAL_DATA_DISK_GB`
  size it (12 vCPUs and 24 GiB by default, for the load test).
- Pass `TOFU_ENV=rehearsal-libvirt` to every target aimed at it.
- Configure it with the pilot's `PORTIKUS_PUBLIC_HOST` and port, so a
  restored database's issuer matches. The VM resolves that name to itself.
- **It is never published.** `make publish-vm` refuses it, because port
  8443 belongs to the pilot.
- **Destroy it after every exercise** with `make rehearsal-destroy`,
  because it holds restored student data.

## Capacity and resizing

docs/CAPACITY.md has the load test results, the cost of each workspace,
the size the pilot needs, how memory pressure is handled, and the steps
for resizing the pilot. In short: for 25 active workspaces and 100
provisioned ones, the pilot needs 8 vCPUs, 16 GiB of memory and a 200 GiB
data disk. Resizing is done in a window you choose, after a backup.

### Host hardware for a class of about 24

The 16 GiB figure is a floor, not a comfortable size. It was worked out
from a load test that used a 150 MB stand-in for the coding agent, and a
real agent, a dev server and a Docker container can double a workspace's
memory (docs/CAPACITY.md, "The size the pilot needs"). Give the pilot VM
24 to 32 GiB of memory and 12 or more vCPUs, so a whole class can build
at once without waiting on each other.

The host needs room for that VM, its own operating system, the nightly
backups, and the rehearsal VM (24 GiB by default) so that a restore drill
or load test does not mean stopping the class.

| | Minimum | Recommended |
|---|---|---|
| CPU | 8 cores, 16 threads | 12 to 16 cores |
| Memory | 32 GB | 64 GB |
| Disk | 1 TB NVMe SSD | 2 TB NVMe SSD |
| Network | Wired gigabit | Wired gigabit |

- **Memory.** 32 GB runs the pilot but not the rehearsal VM beside it.
  64 GB runs both, and leaves room for language servers if the editor
  work in docs/BACKLOG.md ("Course profiles and a language-aware
  editor") goes ahead; those add roughly 100 to 500 MB per active
  student.
- **Disk.** The VM takes a 20 GiB system disk and a 200 GiB data disk.
  The host also keeps the 14 newest backup sets under
  `/var/backups/portikus/`, which grow with student files and Docker
  images. NVMe matters because many students running `npm install` or
  Docker builds at once are limited mostly by disk speed.
- **Virtualisation.** Hardware virtualisation (KVM) must be on in the
  BIOS or UEFI (infra/README.md).
- **Off-host backups.** An external drive or network storage for the
  off-host copy of the backups, which is still a manual step (see
  "Backups" above).

A desktop or small tower workstation is enough; server hardware is not
needed at this size. Before a class starts, confirm the size you chose by
running the load test on the rehearsal VM at that size:
`make rehearsal-up REHEARSAL_VCPUS=<n> REHEARSAL_MEMORY_MB=<MiB>`, then
`make load-test TOFU_ENV=rehearsal-libvirt N=25`.

To rent a host instead of buying one, docs/HOSTING.md compares providers
and prices for this size, dated 2026-09-23.

**Never run `make infra-apply` for the pilot from a checkout older than
the one that grew the data disk.** An older checkout replaces a data disk
whose size changed, so it would plan to swap the grown disk for an empty
100 GiB one. Always read the plan before typing `yes`.

## Security test and load test

- **`make security-test`** runs the VM security suite through the real
  edge. It makes its own users and two workspaces, touches nothing else,
  checks every other workspace and setting is unchanged, and cleans up.
  It is allowed on the live pilot at any quiet time, and should run after
  every deploy. `SWEEP=1` removes the leftovers of a run that was killed.
  `PORTIKUS_SECURITY_HEAVY=1` adds tests that push a workspace past its
  memory limit; run those only on a VM with no other workspace, which in
  practice means the rehearsal VM.
- **`make load-test TOFU_ENV=rehearsal-libvirt N=25`** runs the load test
  (`infra/tests/load-test.sh`). **Never on the pilot.** The script refuses
  the pilot, a VM Ansible or a restore is using, and a VM without memory
  or disk room for N workspaces. It removes only the users and workspaces
  it made. Destroy the rehearsal VM afterwards if it held restored data.

## Logs

The platform never logs secrets, prompts, source code or terminal bytes
(ADR 0012). On the VM (`ssh deploy@10.100.0.120`):

| Unit | What it is |
|---|---|
| `portikus-api` | The API: requests, sign-in, audit write errors |
| `portikus-worker` | Starts, stops, creates, recovery points, health samples |
| `portikus-controller` | The only process that talks to Incus |
| `portikus-dex` | Dex sign-in |
| `caddy` | The edge and preview gateway |
| `postgresql` | The database |
| `incus` | Containers and storage |

```
sudo journalctl -u portikus-api -u portikus-worker -u portikus-controller -o cat --since -1h
```

The journal is capped at 2 GB. On the host, the nightly backup logs to
`journalctl -u portikus-backup.service`.

## Routine checks

**Daily, during the pilot:**

- The admin page's Health tab shows no "Worker not reporting", and the
  storage pool and memory are under 80 percent.
- Last night's backup finished:
  `systemctl status portikus-backup.service` on the host, and the newest
  set under `/var/backups/portikus/portikus/` has no `FAILED` file.

**Weekly:**

- Copy `/var/backups/portikus` to external storage.
- Run `restore.sh --check` on the newest set to prove the key still works.
- Look for workspaces in `error` on the admin page.
- Run `make security-test` on the pilot.

**Monthly** (SPEC.md section 24.12):

- Check for new Dex releases. An upgrade is a pull request that bumps
  `dex_version` and `dex_commit` in `infra/ansible/site.yml` together,
  after reading the release notes. CI's Dex sign-in job tests it, then
  the rehearsal VM runs `configure-vm` and the smoke test before the
  pilot does. To roll back, revert the pin.
- Check that unattended upgrades are applying Debian security updates on
  the VM (`sudo journalctl -u unattended-upgrades`), which the `base` role
  sets up.
- Delete `pre-...` snapshots that are no longer needed.
- Under Entra, Google or a Dex `microsoft` or `google` connector, check
  when the client secret expires, and deploy a new one before then.

## Rebuild from code (B5)

**The one-command exercise.** `make rebuild-exercise` runs the whole
STACK.md section 33 exercise on the rehearsal VM and destroys the VM at
the end, even when a step fails:

```
make rebuild-exercise BACKUP=/var/backups/portikus/portikus/<timestamp> \
  PREVIOUS_VERSION=<release to roll back to> \
  PORTIKUS_SMOKE_SIGNIN_FILE=<file with a Dex user's email and password>
```

The set must hold `dex.dump`, the Dex accounts database that backups
carry since Epic 14. The sign-in file names a Dex user in that set: the
email on the first line and the password on the second, mode 0600. The
exercise never imports a users file, because the accounts an import
creates would make `restore.sh` refuse the VM.

Run it from a shell in the `libvirt` group, like `make rehearsal-up`.
It does these steps in order:

1. It builds the package from the checkout.
2. It rebuilds the VM from code, converges it with Dex, and builds the
   workspace image.
3. It restores the set, Dex's accounts included, and starts one restored
   workspace to check it.
4. It runs the smoke test with the restored-data checks, the lifecycle
   block and a full Dex sign-in.
5. It rolls back to the previous package, then checks `/health` and a
   Dex sign-in.

It prints a timing table at the end, and keeps a log of each step under
`/tmp/portikus-rebuild-exercise.*`.

`PREVIOUS_DEB=<file>` rolls back to a local package instead of a release.
The previous package must support Dex. At the time of writing, no
published release does, so the run below used a local build of the
previous epic head.

The run below is from before Epic 14, when the exercise still carried
mock accounts over to Dex; it has not been repeated since.

The run on 2026-09-23 restored the pilot's set `20260923T045452Z` and
rolled back to `0.1.366+g1acca31`. Every step passed:

| Step | Time |
|---|---|
| Build the package, reinstall dev dependencies | 10 s |
| Destroy the old VM | 1 s |
| Create the VM (OpenTofu, cloud-init) | 52 s |
| Converge with Ansible | 4 min 40 s |
| Build the workspace image | 2 min 53 s |
| Restore the set, start one workspace | 56 s |
| Carry 3 mock accounts over to Dex | 57 s |
| Smoke test (231 passed, lifecycle block included) | 6 min 21 s |
| Roll back, check `/health` and a Dex sign-in | 56 s |
| Destroy the VM | 2 s |
| **Total** | **17 min 48 s** |

The runs below took place on 2026-09-23, before Epic 14, when Dex's
accounts still came from the users file.

**The step-by-step runs.** Earlier the same day, the rehearsal VM was rebuilt twice from the repository,
from nothing to a working platform, with package `0.1.367+gc543a49` (the
Epic 12b head after PR #468). The pilot's newest backup was then restored
into the second rebuild. Every step was a Make target. No step was done
by hand on the VM.

**First rebuild, ending with the smoke test:**

| Step | Command | Time |
|---|---|---|
| Destroy the old VM | `make rehearsal-destroy` | 3 s |
| Create the VM (OpenTofu, cloud-init) | `make rehearsal-up` | 47 s |
| Converge it (Ansible, Dex built from source) | `make configure-vm TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=dex PORTIKUS_DEB=<package> PORTIKUS_USERS_FILE=<file>` | 5 min 12 s |
| Build the workspace image | `make build-workspace-image TOFU_ENV=rehearsal-libvirt` | 2 min 32 s |
| Smoke test, with a full Dex sign-in | `make smoke-test TOFU_ENV=rehearsal-libvirt PORTIKUS_IDP=dex PORTIKUS_SMOKE_SIGNIN_FILE=<file>` | 6 min 10 s |
| **From an empty host to a green smoke test** | | **14 min 41 s** |

The smoke test passed all 209 checks. That includes the lifecycle block:
sudo, nested Docker, `claude --version` and `codex --version`, reaching an
application port in a workspace, the preview edge, Reset Docker and
Rebuild, and a full Dex password sign-in. Building the package beforehand
(`make build-deb`) took 12 s.

**Second rebuild, then the restore drill:**

| Step | Command | Time |
|---|---|---|
| Destroy, create, converge, build the image | as above | 8 min 48 s |
| Prove the key opens the set | `restore.sh --check <set>` | 1 s |
| Restore the pilot's newest set | `make restore TOFU_ENV=rehearsal-libvirt BACKUP=<set> START_CHECK=1` | 55 s |
| Show the account pairings | `make identity-carry-over-dry-run` (since removed) | under 1 min |
| Carry the accounts over to Dex | `make configure-vm` as above | 48 s |
| **From an empty host to restored students signing in** | | **about 10 min 30 s** |

The set was `/var/backups/portikus/20260923T045452Z`, the pilot's newest
complete set. It holds 3 users, 3 workspaces and 6 projects, from package
`0.1.348+g001e10e`. It predates the per-VM directories, so it sits
directly under `/var/backups/portikus/`, not under `portikus/`. Inside
the 55 seconds, the restore:

- checked every file against the MANIFEST (under 1 s);
- loaded the database, marked every workspace stopped, and ended every
  session (2 s);
- imported the three home volumes (9 s);
- recreated the three instances (18 s);
- started the services (4 s);
- matched the row counts, and matched 43 sampled files against the
  backup's checksums (9 s);
- started carol's workspace, and checked that her home belongs to the
  student and that the sampled files and 3 Git commits match (13 s).

What was checked afterwards:

- Each of the three users has their workspace row, instance and home,
  recovery and Docker volumes.
- The `sessions` and `preview_sessions` tables were empty.
- alice's and bob's workspaces also started, in 7 s and 4 s, each with
  the home owned by the student.
- The restored rows came from the mock provider. The carry-over moved
  carol, alice and bob to their Dex identities by email, and wrote one
  `user.identity_changed` audit row each. alice then signed in through
  Dex with her password, and got her original user row and her original
  workspace (same id and label). She could start and stop it through the
  API, and bob's workspace answered 404 to her.

**Backups from before the Dex cutover hold mock accounts.** A set taken
before 2026-09-23 holds users under the mock issuer. The carry-over that
linked them to Dex was removed with the users file, so after such a
restore a student who signs in through Dex gets a new, empty account.
Sets taken since hold Dex identities.

**Removing an account ends its sessions.** Under Epic 14 this is the
Users view's Remove, which disables the account through the same path as
Disable. Route tests and the Playwright tests of the Dex user dialogs
check it (docs/STATUS.md, Epic 14 T3).

**Load test on the rebuilt VM.** `make load-test TOFU_ENV=rehearsal-libvirt
N=25` ran on the first rebuild. It took 19 min 20 s in all. Start p95 was
12.6 s, down from 77 s before the worker started workspaces in parallel,
still over the 10 s target. Every other criterion passed, with no failed
operation (`docs/CAPACITY.md`, "Rerun after parallel starts").

The smoke test's lifecycle block normally skips itself while other
people's workspaces exist. `make rebuild-exercise` sets
`PORTIKUS_SMOKE_RESTORED_SET`, which lets the block run beside the
restored workspaces, and only on a VM that is not named `portikus`.
