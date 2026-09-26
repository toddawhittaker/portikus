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
make configure-vm PORTIKUS_DEB=dist/deb/portikus_<version>_amd64.deb
make smoke-test
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

Every site signs in through Dex. `PORTIKUS_DEX_UPSTREAM` connects an
institution's provider to it: `none` (the default, and what the pilot
uses), `entra`, `google`, `ldap` or `oidc`. "Sign-in providers", below,
says how to set up each one. Pass the same connector settings on every
`configure-vm`. `PORTIKUS_IDP=mock` replaces Dex with the in-repo test
provider; never use it on a VM others can reach: anyone could sign in as
anyone.

**After a deploy that changes `infra/host/backup.sh`, run
`make backup-install-timer` on the host.** The nightly timer runs an
installed copy of the script, not the checkout. Epic 14 is such a change:
until the timer is reinstalled, the nightly set has no `dex.dump`, so it
cannot bring back Dex's accounts.

**Epic 14.2 must be deployed with `make configure-vm PORTIKUS_DEB=...`,
not `make deploy-app` or a plain `apt upgrade`.** From this release the
API checks that Dex's gRPC server certificate names `localhost`, and only
the play reissues that certificate. The API also refuses to start while
api.env still holds the retired direct-provider settings
(`OIDC_PROVIDER`, `OIDC_ALLOWED_TENANT`, `OIDC_ALLOWED_DOMAINS`), which
only the play removes. A package-only install leaves sign-in broken.

`make deploy-app` builds and installs the package without Ansible. It is
quicker for a small application fix, but it skips everything else, so
prefer `configure-vm`.

## Sign-in providers

Every site signs people in through Dex, the small OpenID Connect (OIDC)
provider that runs on the VM beside the API (ADR 0031, SPEC.md section
5.1). Opening Portikus from a course (LTI) works beside it. Dex's own
passwords are always on. An institution's provider is added to Dex as
one **connector** (an upstream source of people), chosen with
`PORTIKUS_DEX_UPSTREAM`; a site has at most one. An account is always
keyed by Dex's issuer and the `sub` claim Dex gives (a permanent ID for
the person), never by email.

| Provider | `PORTIKUS_DEX_UPSTREAM` | Who may sign in | Role comes from | No role matched |
|---|---|---|---|---|
| Dex's own passwords only | `none` (the default) | people an administrator added | grants in the Users view | student |
| Microsoft Entra ID | `entra` | the site's tenant, with a Portikus app role | Entra app roles | refused by Dex |
| Google Workspace | `google` | the listed domains | grants in the Users view | student |
| LDAP or Active Directory | `ldap` | people the user filter admits | directory groups, or grants | student |
| Another OIDC provider | `oidc` | members of one of the three groups | the provider's groups claim | refused by Dex |

Dex's own passwords, the local administrator among them, work beside
every connector. Dex's sign-in page then offers two buttons: "Log in with
Email" for its own passwords, and one for the connector ("Microsoft",
"Google", "LDAP" or "Active Directory", or "Single sign-on").

A "grant" is the stored role an administrator sets with Make instructor
or Promote in the Users view (docs/archive/epics/EPIC-13-1.md). It lasts
across sign-ins.

**Someone Dex refuses never reaches Portikus.** They see Dex's own error
page, and the refusal is in Dex's log (`journalctl -u portikus-dex`), not
in Portikus's audit table.

`PORTIKUS_IDP` is `dex` (the default) or `mock`, the in-repo test
provider used by development and CI, where anyone can sign in as anyone.
The old values `entra`, `google` and `external` were removed with Epic
14.2, and `PORTIKUS_DEX_UPSTREAM=microsoft` was replaced by `entra`; a
play that still uses any of them stops before it changes anything, with
a message pointing here. The settings `PORTIKUS_OIDC_ISSUER`,
`PORTIKUS_OIDC_CLIENT_ID` and `PORTIKUS_OIDC_CLIENT_SECRET` are no longer
read: the API's client is always the one the play makes in Dex.

Every setting below is an environment variable read by `make
configure-vm`. Keep secrets off the command line, where shell history
keeps them. Export them from a prompt instead:

```
read -rs PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET && export PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
```

Every connector that speaks OIDC (`entra`, `google` and `oidc`) is
registered with the provider as Dex, not as Portikus, with the redirect
URI `https://<public host>:<port>/dex/callback` (leave out `:<port>` when
it is 443). Its client ID and secret go in
`PORTIKUS_DEX_UPSTREAM_CLIENT_ID` and `PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET`;
the secret must be at least 16 characters.

After changing the connector, run `make smoke-test` and `make
security-test`, then do one real sign-in with the connector and one as
the local administrator ("The local administrator", below).

**Dex reaches a provider by name, through the egress proxy.** Ansible
reads the connector's discovery document while it runs and allows the
hosts it names. Nobody types address ranges. The API itself reaches no
provider. See "The egress proxy", below.

**Changing the issuer of a site that already has accounts** gives
everyone a new, empty account. Adding, changing or removing a Dex
connector does not change the issuer, which is always Dex's, but a
person who signed in through one connector gets a new account when they
sign in through another. No tool carries accounts from one to another
(docs/archive/epics/EPIC-12B.md, risk 7). The mock-to-Dex carry-over the
pilot used once, on 2026-09-23, was removed with the users file, so a
backup from before that date restores accounts that only the mock can
sign in to. Once the site uses Dex, every play run ends the sessions of
the mock's accounts.

### Microsoft Entra ID

Only people from one Entra tenant (one organisation's directory) who hold
one of the three Portikus app roles can sign in. Guests invited into that
tenant are checked like anyone else. Dex uses its generic `oidc`
connector, held to the tenant's own issuer,
`https://login.microsoftonline.com/<tenant ID>/v2.0`, so a token from any
other tenant fails validation. It reads the ID token's `roles` claim as
the person's groups and refuses anyone with none of the three app roles.
It never calls Microsoft Graph, so no Graph permission and no
administrator consent is needed. One tenant per site.

In the Microsoft Entra admin center:

1. **App registrations, New registration.** Name it Portikus. For
   supported account types, choose "Accounts in this organizational
   directory only (Single tenant)". Add a redirect URI of platform **Web**:
   `https://<public host>:<port>/dex/callback`.
2. On the registration's **Overview**, copy the **Application (client) ID**
   and the **Directory (tenant) ID**.
3. **Certificates & secrets, New client secret.** Copy its **Value**, not
   its ID. Note when it expires: sign-in stops working that day unless a
   new secret is deployed first.
4. **App roles, Create app role**, three times. Allowed member types:
   Users/Groups. The values must be exactly `Portikus.Student`,
   `Portikus.Instructor` and `Portikus.Administrator`.
5. **Token configuration, Add optional claim**, token type ID, `email`.
   Dex needs an `email` claim in the ID token and refuses a sign-in
   without one. Entra sends it only for accounts with a mailbox unless
   this optional claim is added, so add it whenever some accounts have no
   mailbox. This step has not yet been tried against a real tenant.
6. **Enterprise applications, Portikus, Properties.** Set "Assignment
   required?" to **Yes**, so only assigned people can get a token.
7. **Users and groups, Add user/group.** Assign each person, or a group,
   one of the three roles. Assigning groups needs an Entra ID P1 licence
   or higher. **Assign a role only to a group whose membership
   administrators control**: never a group people can join themselves,
   and never a dynamic group built from attributes users can edit, or a
   student could give themselves a role.

Then deploy:

```
read -rs PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET && export PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
make configure-vm PORTIKUS_DEX_UPSTREAM=entra PORTIKUS_ENTRA_TENANT_ID=<tenant ID> \
  PORTIKUS_DEX_UPSTREAM_CLIENT_ID=<application ID>
```

The play refuses a tenant ID that is not a GUID. `PORTIKUS_OIDC_STUDENT_GROUP`,
`PORTIKUS_OIDC_INSTRUCTOR_GROUP` and `PORTIKUS_OIDC_ADMIN_GROUP` change
the three app role values if a tenant already uses other names. Grants
in the Users view still raise a role. The first Entra administrator can
be given the `Portikus.Administrator` app role, or promoted by the local
administrator after their first sign-in.

### Google Workspace

Only accounts from the listed Google Workspace domains can sign in; Dex's
`google` connector checks the domain. A personal Gmail account is
refused. Google sends no groups here, so everyone starts as a student,
and an administrator uses Make instructor or Promote in the Users view.

In the Google Cloud console, in a project owned by the organisation:

1. **Google Auth Platform** (formerly the OAuth consent screen). Choose
   the audience **Internal**, so only the organisation's accounts are
   offered.
2. **Clients, Create client.** Type: **Web application**. Add the
   authorised redirect URI `https://<public host>:<port>/dex/callback`.
3. Copy the client ID and the client secret.

Then deploy:

```
read -rs PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET && export PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
make configure-vm PORTIKUS_DEX_UPSTREAM=google PORTIKUS_GOOGLE_DOMAINS=example.edu,students.example.edu \
  PORTIKUS_DEX_UPSTREAM_CLIENT_ID=<client ID>
```

A whole domain is admitted. Portikus does not ask Dex for groups under
Google, and a play that sets `PORTIKUS_OIDC_SCOPES` with `groups` stops
with an error, because a groups claim here could only come from somewhere
a student controls. A Google group check would need a Google service
account and the Admin SDK, which is not built.

### LDAP and Active Directory

Dex checks the password against the directory and passes the person's
groups on. Portikus itself never talks to the directory.

```
read -rs PORTIKUS_LDAP_BIND_PASSWORD && export PORTIKUS_LDAP_BIND_PASSWORD
export PORTIKUS_LDAP_USER_FILTER='(&(objectClass=user)(memberOf=CN=Portikus Users,OU=Groups,DC=example,DC=edu))'
make configure-vm PORTIKUS_DEX_UPSTREAM=ldap \
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

### Dex's own passwords only

The default, for a site with no institutional provider. Dex runs on the
VM and keeps its own passwords in its PostgreSQL database, `dex`. Nothing
needs setting. The first person to sign in is the local administrator
("The local administrator", below), who then adds everyone else from the
Users view ("Managing users", below).

The Users view reaches Dex through Dex's gRPC API (a remote procedure
call interface) on `127.0.0.1:5557`. It accepts only a client
certificate signed by a small certificate authority that Ansible keeps in
`/etc/portikus/dex-grpc/`. The API's client key there is `root:portikus`,
mode 0640. The certificates last 825 days, and every `make configure-vm`
issues new ones when fewer than 30 days are left. A site that goes two
years without a deploy would find the Users view's Dex buttons, Settings,
Password and `portikus reset-admin` failing; a `make configure-vm` fixes
it.

### Another OIDC provider: Okta, Keycloak and others

Any provider that speaks OIDC and can put group names in a claim works
through Dex's generic `oidc` connector. Its button on Dex's page reads
"Sign in with Single sign-on". Register a client for Dex with the
redirect URI `https://<public host>:<port>/dex/callback`, then:

```
read -rs PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET && export PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET
make configure-vm PORTIKUS_DEX_UPSTREAM=oidc PORTIKUS_DEX_UPSTREAM_ISSUER=https://idp.example.edu \
  PORTIKUS_DEX_UPSTREAM_CLIENT_ID=portikus
```

- The issuer must be an `https` URL.
- The group names default to `portikus-students`,
  `portikus-instructors` and `portikus-administrators`. **If the
  provider uses other names, set `PORTIKUS_OIDC_STUDENT_GROUP`,
  `PORTIKUS_OIDC_INSTRUCTOR_GROUP` and `PORTIKUS_OIDC_ADMIN_GROUP`**:
  Dex admits only people in one of the three, and passes on only those.
- `PORTIKUS_OIDC_UPSTREAM_GROUPS_CLAIM` names the claim that holds the
  groups (default `groups`).
- Dex asks for `openid profile email`. `PORTIKUS_OIDC_UPSTREAM_EXTRA_SCOPES`
  adds more, separated by commas; Okta, for one, sends groups only when
  asked for a `groups` scope.
- Dex calls the provider's userinfo endpoint, so its host is on the allow
  list too.
- The provider must send the `email_verified` claim, true, or Dex's
  generic connector refuses the sign-in. Portikus itself keys accounts on
  the issuer and subject, and shows the email only for display.
- **The groups claim must contain only groups whose membership a student
  cannot create or join**, so not GitLab groups and not self-service
  Microsoft 365 groups, or a student could make themselves an
  administrator.
- For Microsoft Entra use `PORTIKUS_DEX_UPSTREAM=entra`; the play refuses
  a `login.microsoftonline.com` issuer here.

### Shibboleth, and why not SAML

Portikus speaks only OIDC. A campus that signs people in with Shibboleth
or another SAML (Security Assertion Markup Language) identity provider
uses the Shibboleth identity provider's own OIDC support:

1. Install the **OIDC OP** plugin on the Shibboleth identity provider
   (version 4.1 or later).
2. Register Dex as an OIDC relying party, with a client ID, a client
   secret of 16 characters or more, and the redirect URI
   `https://<public host>:<port>/dex/callback`.
3. Release `sub`, `email` and `name`, and a `groups` claim holding the
   three Portikus group names, for example from `isMemberOf` or
   `eduPersonEntitlement`.
4. Configure it as "Another OIDC provider", above.

Why not SAML directly: one sign-in protocol keeps the security-sensitive
code, its tests and its identity rule in one place. SAML would add XML
signature checking, a common source of sign-in bypasses, for sites that
can already turn OIDC on. Dex does have a SAML connector, but its own
documentation warns that it is not maintained, so it is not built
(docs/archive/epics/EPIC-14.md ruling 7).

### First checks with a real provider

The tests prove the connectors against imitation tokens from the in-repo
mock provider, not how a real provider behaves. The first time a site
uses Entra, Google, another OIDC provider or Active Directory, check
these, and record the results in docs/STATUS.md:

- Entra's ID token carries `roles`, `name` and `email` for this
  registration, and a guest (B2B) account's token comes from the tenant's
  issuer.
- Someone with no Portikus app role (Entra) or in none of the three groups
  (another OIDC provider) is refused on Dex's page.
- The allow list the play built covers every host the sign-in uses,
  including key rotation: a sign-in a day or two later still works.
- Linking a course account (Settings, Profile) forces a password prompt
  at the provider.
- Dex's sign-in page reads well with its two choices, "Log in with Email"
  and the institution's.
- The LDAP connector against real Active Directory.

## Managing users

Administrators manage Dex's own accounts in the Users view of `/admin`
(docs/archive/epics/EPIC-14.md rulings 21 to 24, ADR 0028). Dex keeps them
in its PostgreSQL database, `dex`, and the nightly backup holds them as
`dex.dump`.

- **Add user…** takes a name, an email, a username and a role: student,
  instructor or administrator. Portikus makes a 20-character password and
  shows it once, with a Copy button. Give it to the person privately, in
  person or by a private message in the learning system, never by plain
  email. The account exists in Portikus straight away, so an instructor
  or administrator role is a stored grant from the start. The person must
  choose their own password when they first sign in; until then every
  page sends them to **Set a new password**.
- **Reset password** makes a new password, shows it once, and ends the
  account's sessions and preview sessions. It too must be changed at the
  next sign-in.
- **Settings, Password** lets anyone with a Dex password change it: the
  current password, then a new one of at least 15 characters. A change
  ends the account's other sessions. Ten wrong current passwords from one
  address in ten minutes are allowed; the eleventh is refused for a while.
- **Remove** deletes the Dex password and disables the account, which
  ends its sessions. The workspace stays; archive it from the same page
  when it is no longer needed.
- To change someone's email or username, remove them and add them again.
  The new account starts with a new, empty workspace.
- To stop someone at once without removing them, **Disable** the account.

With a connector, these buttons manage only Dex's own accounts; people
from the directory, Microsoft, Google or the other provider are managed
there. Under any connector, **Make instructor**, **Remove instructor**,
**Promote** and **Demote** set or clear a stored grant. None of them ends
sessions; the next request reads the new role.

Portikus never stores or logs a password. Each action writes an audit row
(`dex_user.created`, `dex_user.password_reset`, `dex_user.removed`,
`user.password_changed`) with no password, hash or email in it.

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

## The local administrator

Every site has one local administrator: a Dex password with the username
`admin`, the display name "Local administrator" and the administrator
role (ADR 0031). Nobody becomes an administrator by signing in first. It
works whatever connector the site uses, so it is the way in when the
institution's sign-in is broken.

**Made by the play.** The first `make configure-vm` creates it with a
random one-time password and prints only:

```
Made the local administrator, admin@<public host>.  Read the local administrator's one-time password with: sudo cat /etc/portikus/admin-password
```

The password is in `/etc/portikus/admin-password`, owned by root with
mode 0600, and nowhere else: not in the play's output, the journal, a log
or the audit table. Dex stores only its hash. The email is
`admin@<public host>` unless `PORTIKUS_ADMIN_EMAIL` names another; it is
set only when the account is created, so changing it later changes
nothing (to change it, remove the account in the Users view and run
`sudo portikus reset-admin --email <new address>`). Creation fails, and
says so, if another Dex password already has that email.

**First sign-in.** Read the file, open the site, choose "Log in with
Email" on Dex's page, and sign in with that email and the password.
Portikus shows only **Set a new password** until a new one is chosen;
every other page, WebSocket and preview is refused until then. Once it is
changed, the one-time password no longer works, and the next play run
deletes the file. While it is still unchanged, every play run prints the
"Read … with" line again.

**Recovery.** If every administrator is locked out, or the institution's
sign-in is down, run on the VM:

```
ssh deploy@10.100.0.120 'sudo portikus reset-admin'
```

It gives the local administrator a new one-time password in the same
file, re-enables the account, gives the administrator role back, and ends
every session of that account; the next sign-in must set a new password
again. If the account or its Dex password was removed, it makes them
again with the same identity, so the same account and workspace come
back. It must run as root, on a Dex site.

The play runs `portikus reset-admin --if-missing`, which does nothing to
an account that exists, even one an administrator removed in the Users
view. The command's exit status:

| Status | Meaning |
|---|---|
| 0 | a new one-time password is in the file |
| 10 | `--if-missing`: the account exists and its one-time password is still unchanged |
| 11 | `--if-missing`: the account exists and has chosen its own password |
| 1 | it failed: not root, no Dex on this site, Dex unreachable, or the email already taken |
| 2 | bad arguments or missing settings |

Each run that changes something writes `local_admin.created` or
`local_admin.reset`, with the actor `host:root` and no password or email.

The local administrator has only a password; Dex has no second factor for
its own accounts. Keep the password long and private, and use the
institution's sign-in for everyday administration.

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
person at the machine cannot sign in as the last one. The `entra`,
`google` and `oidc` connectors are different: the provider keeps its own
session, so on a shared computer people must also sign out of Microsoft,
Google or the other provider.

## The egress proxy

The API may reach only loopback and the workspace bridge; its systemd unit
denies every other address. It reaches each LMS's keyset through Squid,
a forward proxy on `127.0.0.1:3128`, which allows only named hosts (ADR
0027). The API reaches no sign-in provider: its one issuer is Dex, on the
same VM. Dex uses the same proxy for an `entra`, `google` or `oidc`
connector. Nothing else goes through it; the workspaces have their own
egress rules.

- **What it allows.** A host name is reached only over HTTPS (a
  `CONNECT` tunnel) on port 443, or on the port listed with it, and never
  at a private, loopback or link-local address. An IPv4 address listed
  with a port is allowed exactly, plain HTTP included. Any other address
  given directly, IPv4 or IPv6, is refused; names are matched as
  written, never through reverse DNS. Squid caches nothing and never
  sees inside the TLS connection.
- **Where the list comes from.** Every `make configure-vm` rebuilds it
  from the connector's discovery document (fetched while the play runs;
  under `entra` without the userinfo host, so `graph.microsoft.com` is not
  listed), the keyset URL of every registered LMS, and
  `PORTIKUS_EGRESS_EXTRA_HOSTS`. The site's own
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
- **When it fails.** If Squid stops, sign-ins through the `entra`,
  `google` or `oidc` connector, and every LMS launch, stop too; Dex's own
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
the part of the student's email before the `@` (`ivy@example.edu` gives
`ivy`), if the LMS shares the email. Without that, the name is made from
the LMS's user ID, which is often a long opaque string. The tool must be
allowed to see the login (in Canvas, a privacy level that shares it). A
variable the LMS leaves unfilled, such as a literal `$User.username`, is
ignored and the next fallback is used instead. The name
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
make configure-vm TOFU_ENV=rehearsal-libvirt PORTIKUS_DEX_UPSTREAM=<as the pilot>
make restore TOFU_ENV=rehearsal-libvirt BACKUP=/var/backups/portikus/portikus/<timestamp> START_CHECK=1
```

`make restore` refuses the pilot's environment and any VM whose hostname
is not the one in the state. It refuses a target that already has any
workspace volume, workspace, project, or user other than the local
administrator, so it can never overwrite a live VM. A freshly configured
VM holds only that one account, and the restore treats it as empty. The
restore replaces the whole database with the backup's, so the target's
local administrator goes with it. If the backup has its own local
administrator, that one comes back, with its password when the set holds
a `dex.dump`. If it has none, the next `make configure-vm` makes a new one
and prints where its one-time password is. The restore loads the
database, imports each volume under its original name, and leaves every
restored workspace stopped. `START_CHECK=1` then
starts one workspace, checks its files and Git commits from inside it, and
stops it. When the exercise is over, run
`make restore TOFU_ENV=rehearsal-libvirt BACKUP=<same set> REMOVE=1` and
then `make rehearsal-destroy`.

**Onto an empty VM, for a real disaster recovery.** If the pilot is lost:

1. Rebuild it from code (`make infra-apply`, `make configure-vm` with the
   usual provider settings, and `make build-workspace-image`). It comes
   up with no workspace volumes and a database whose only user is the
   local administrator. Ignore its one-time password; the restore
   replaces that account with the backup's.
2. Check the set with `restore.sh --check` as above.
3. Run `restore.sh` directly, since `make restore` refuses the pilot:

   ```
   PORTIKUS_BACKUP_IDENTITY=<key> bash infra/host/restore.sh --start-check \
     --target-name portikus 10.100.0.120 /var/backups/portikus/portikus/<timestamp>
   ```

   With a `dex.dump` in the set, the restore also loads Dex's accounts,
   with Dex stopped, so everyone keeps their password. Without one, Dex
   keeps the rebuilt VM's accounts, including the local administrator's
   one-time password, so the restore sets the restored local
   administrator's must-change-password flag: that password works once
   more, and only to choose a new one.
4. Run `make configure-vm` again, which makes a local administrator if
   the backup had none, then `make smoke-test` and `make security-test`,
   and sign in as an administrator to check that the workspaces are
   listed.
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

## The resource guard and idle stop

The worker slows a workspace that keeps its CPUs busy, marks one that
keeps its memory near its limit, and stops one nobody has used for a
while (SPEC.md sections 6.4 and 19.4, ADR 0032). Every value is a
runtime setting; nothing is set in Ansible or an environment file.

**Settings** (admin area, Settings tab):

| Setting | Default | Allowed |
|---|---|---|
| CPU threshold | 80% | 1 to 100 (100 turns the CPU check off) |
| Memory threshold | 90% | 1 to 100 (100 turns the memory check off) |
| Window | 30 minutes | 5 to 240 minutes |
| Throttle share | 25% of the CPU limit | 5 to 100 (100 means the throttle changes nothing) |
| Idle stop | 60 minutes | 0 (never) or 10 to 1440 minutes |

A change takes effect within a minute. Lowering the idle time never
stops a workspace at once; its owner first sees "Still working?" for
five minutes.

**One workspace.** Open the workspace in the Workspaces tab. Its detail
panel has a "Resource guard" section with the current state, the last
activity time, and an overrides dialog for the same five values. An
empty field uses the platform value. Use it to raise the CPU threshold
for a course that runs long builds, or set idle stop to 0 for a
workspace that must run an unattended job.

**Lifting a throttle or clearing a flag.** Throttled and flagged
workspaces show **Throttled** or **High memory** in the Workspaces
table and are listed under "Resource guard" in the Health tab. In the
workspace's detail panel, choose **Lift throttle** or **Clear memory
flag**. The row clears at once, the workspace's usage history is
dropped so it gets a full new window, and the worker restores full CPU
within a minute. If the load is still there, the throttle returns one
window later. A student can also restore full speed themselves by
stopping and starting the workspace. Each throttle, lift and flag is in
the audit log; look there for a workspace that is throttled again and
again.

On the pilot a workspace has 2 CPUs, so the default 25% share is an
allowance of `50ms/100ms`, and the workspace's cgroup shows `cpu.max` as
`50000 100000`. The average recorded with a throttle can be above 100%
after the student rebooted the workspace from inside: the guard counts
up to a minute before each restart as full use of every CPU, because
that use is never seen.

Memory is counted without page cache, but files in the workspace's
`/tmp` live in memory (it is a tmpfs) and cannot be reclaimed, so large
files there can raise the memory flag.

**The acceptable-use statement.** Every account, administrators
included, accepts it at first sign-in and again after any change to its
text. Edit it in the Settings tab, "Acceptable use": plain text, blank
lines between paragraphs, at most 10,000 characters. **Reset to
default** returns to the built-in text. Saving any change sends
everyone, including people signed in right now, to the statement at
their next request; their workspaces keep running. Make changes outside
class time where you can.

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
- Under an `entra`, `google` or `oidc` connector, check
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
