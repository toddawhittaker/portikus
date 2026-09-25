# Portikus Pilot Infrastructure

End-to-end steps to create the platform VM from a fresh Pop!_OS host.
See STACK.md sections 16 through 24 and 27 through 33 for design rationale.
Running the pilot once it exists (deploys, users, the Dex cutover, backups,
restore, the rehearsal VM, routine checks) is in `docs/OPERATIONS.md`.

## Prerequisites

A Pop!_OS machine with hardware virtualisation (KVM) enabled in BIOS/UEFI.

## 1. Bootstrap the host

Installs KVM, libvirt, OpenTofu, Ansible, age, SOPS, and supporting packages.

```
make bootstrap-host
```

If `make` itself is missing, run the script directly; it installs make
along with everything else:

```
bash infra/host/dev-libvirt/bootstrap.sh
```

## 2. Prepare secrets

Generate an age key pair and update `infra/secrets/.sops.yaml` with the
public key. Then copy the OpenTofu variables example and put your SSH
public key in it. The copy is git-ignored, so the key never sits in a
tracked file.

```
age-keygen -o infra/secrets/age-key.txt
cp infra/tofu/environments/dev-libvirt/terraform.tfvars.example \
   infra/tofu/environments/dev-libvirt/terraform.tfvars
$EDITOR infra/tofu/environments/dev-libvirt/terraform.tfvars
```

## 3. Create the platform VM

Review the plan, then apply it.

```
make infra-plan
make infra-apply
```

OpenTofu creates the Debian VM with two virtual disks (OS and data),
a libvirt NAT network, and a cloud-init ISO for first boot.

## 4. Wait for cloud-init

The VM boots and runs cloud-init, which installs Python and creates the
`deploy` user. VNC is disabled for security; use the serial console to
watch boot progress if needed:

```
virsh console portikus
```

Alternatively, wait for the SSH port to open.

## 5. Configure the VM with Ansible

The VM address is read from the OpenTofu output automatically; pass
`VM_IP=<ip>` only to override it. People sign in through Dex by default
(see "Identity provider" under section 9):

```
make configure-vm
```

On a new VM the play ends by printing a one-time setup code. Open
`https://<public-host>:<port>/setup` within the hour and enter it to
create the first administrator.

This installs Incus, creates the LVM thin pool on the data disk, sets
up the workspace network, profile, and project, and applies the firewall.
When the data disk has grown, it also grows the thin pool onto it
(docs/CAPACITY.md, "Resizing the pilot").

## 6. Build the workspace image

Build the distrobuilder-based workspace image on the VM and import it into
Incus. The recipe lives in `infra/workspace-image/`.

```
make build-workspace-image
```

This rsyncs the image definition to the VM, runs distrobuilder, and imports
the result into the `portikus` Incus project. Re-runs replace the previous
image.

## 7. Verify

```
make smoke-test
```

The Epic 2 and Epic 3 blocks of the smoke test need the workspace image,
so build it first; without it those blocks are skipped, not failed.

### Security test

```
make security-test
```

This runs the Epic 12a security suite (SPEC.md sections 23 and 24, and the
Gate C checks of section 30) against the VM. Unlike the smoke test, it is
safe to run on the live pilot while students use it:

- It makes its own users directly in PostgreSQL, under the issuer
  `urn:portikus:sectest` with subjects `sectest-<run id>-a`, `-b`,
  `-admin` and `-inst` (an instructor). Their sessions expire after one hour. It never signs in as a
  mock account.
- It creates two workspaces through the API as those users, keeps them
  running with a presence socket, and probes only those two.
- It changes no setting and restarts no service.
- Before it creates anything, it checks that the VM has the memory and
  thin-pool space for two more workspaces, and stops if not.
- Before and after, it records every other workspace (database state and
  Incus status), every other user's role and grace override, and the
  settings row. Any difference fails the run and prints the difference.
- At the end, it deletes only the rows and instances it recorded, and only
  rows owned by a `sectest` user. `make infra-check` proves this with
  `infra/tests/security-cleanup-scope-test.sh`, which runs the cleanup
  against a stubbed connection.

Run it from the libvirt host: the network checks probe the host's own
addresses, which only the host itself knows. A run takes about two
minutes.

If a run is interrupted before it cleans up, the next run lists the
leftover `sectest` users and workspaces. `make security-test SWEEP=1`
removes them. `PORTIKUS_SECURITY_HEAVY=1` adds the heavy resource tests,
which need a VM with no other workspace; the suite refuses to run them
otherwise. They allocate memory past a workspace's limit and check that
only that workspace's process is killed, while PostgreSQL and the API keep
running and answering (docs/CAPACITY.md, "When memory runs out").

The LTI checks work with or without a registered LMS. With none, every
`/lti` route must answer 404. With one, the suite starts real logins for
the first registered platform and posts tokens nobody signed; each must be
refused and audited, and none may create a user or a session. While a mock
LMS is registered, the run prints a warning naming it.

A check marked `KNOWN-VULN #<issue>` is a known gap with an open issue. It
does not fail the run. If such a check starts passing, the suite prints
`XPASS` and fails, so the marker is removed with the fix.

## 8. Create a test workspace

```
make workspace-create NAME=alice
```

Destroy it when done:

```
make workspace-destroy NAME=alice
```

## 9. Deploying the control plane

The control plane ships as a versioned Debian package named `portikus`
(ADR 0007). The package contains the prebuilt API, worker, and workspace
controller, and it owns the two service users, `/etc/portikus`,
`/var/lib/portikus`, and the three systemd units. Ansible installs the
package and renders only the environment files and the controller token.

`make configure-vm` therefore deploys the control plane; there is no
separate build step on the VM, and the VM has no build toolchain.

### Release and rollback

**How a release is produced.** A release is published when an epic branch
merges into `main`, or by running the Release workflow by hand from `main`.
It builds the package and publishes it as a GitHub release with two
assets: the package and a `SHA256SUMS` file holding its checksum.
The version is derived from the repository and looks like `0.1.123+gabc1234`:
the release number, the commit count, and the short commit hash. The package
asset is named `portikus_<version>_amd64.deb`.

**How a version is deployed.** Run:

```
make configure-vm
```

Ansible asks GitHub for the newest release, downloads that release's
`SHA256SUMS` file and its `.deb` asset to `/var/cache/portikus`, checks the
package against the checksum from `SHA256SUMS`, and installs it. Nothing in
the repository has to be edited to deploy a new release. The checksum is
what makes the install reproducible: a version string only names an asset,
while the checksum guarantees the bytes that get installed.

**How to roll back.** Run:

```
make configure-vm PORTIKUS_VERSION=<previous-version>
```

That installs exactly that release instead of the newest one, with its own
checksum from the same release. The install task allows downgrades, so this
replaces the running version with the older one. The override is not
recorded anywhere, so the next plain `make configure-vm` rolls forward
again; revert or fix the bad commit rather than leaving a host pinned by
hand.

If the control plane is broken badly enough that you cannot run Ansible,
install the older package on the VM by hand:

```
gh release download v<previous-version> -p '*.deb'
sudo apt-get install -y --allow-downgrades ./portikus_<previous-version>_amd64.deb
```

**Testing a branch on a fresh VM.** A branch has no published release, so
build the package and hand Ansible the file:

```
make build-deb
make rebuild-pilot PORTIKUS_DEB=dist/deb/portikus_<version>_amd64.deb
make smoke-test
```

`PORTIKUS_DEB` works on `make configure-vm` too, and `make rebuild-pilot`
passes it through because it calls `configure-vm`. On a VM that already
exists, `make deploy-app` is the quicker path.

**Development path.** `make deploy-app` builds the package on your
workstation and installs it on the VM directly. It does not go through a
release, so use it only while developing. The next `make configure-vm` puts
the newest release back.

The three systemd units (`portikus-api`, `portikus-worker`,
`portikus-controller`) are enabled by the package but will not start until
their environment file exists (guarded by `ConditionPathExists`). Ansible
renders those files and starts the units, after which they start on boot.

There is no `make db-migrate`. Database migrations run from the
`portikus-api` unit's `ExecStartPre`, so they are applied when the service
starts.

The units run with `ProtectSystem=strict`, so the filesystem is read-only
apart from the paths they are explicitly given. A future service that has
to write under `/var/lib/portikus` should be granted a `ReadWritePaths`
entry for the directory it needs, not a weaker `ProtectSystem`.

`/var/lib/portikus` is a shared parent directory. The package creates it
but never removes it, even on purge, because the image builder
(`image-build`, `images`) and the workspace script (`incus`) keep their
own state under it. Purging the package removes `/etc/portikus` only.

Service configuration lives in `/etc/portikus/*.env`. To override a
variable for testing without changing the Ansible-managed file, create
the corresponding `.override.env` file (for example,
`/etc/portikus/worker.override.env` with `STATUS_REFRESH_SECONDS=5`).

One value is different. `SHUTDOWN_GRACE_SECONDS` in
`/etc/portikus/worker.env` only seeds the disconnect grace period into the
database the first time the worker starts (ADR 0011). After that the
administration page at `/admin` owns it: editing the file has no effect,
and a change made on the page applies straight away with no restart.

### Browser access

Ansible installs Caddy, which is the only service listening on the VM's
public address. It terminates TLS with its own internal certificate
authority and forwards to the API and the browser bundle, both of which
stay on loopback.

The VM sits on a libvirt NAT network, so nothing on the LAN can reach it
until the host forwards to it. Publish it once per VM:

```
make publish-vm
```

That adds three iptables chains on the host: `PORTIKUS_PUBLISH` in the
`nat` table and in `filter`, which forward port 8443 arriving on the
host's LAN interface to port 8443 on the VM, and
`PORTIKUS_PUBLISH_LOCAL` on the `nat` table's output hook, which does the
same for connections the host itself makes to its own LAN address. That
second one is what lets preview hostnames work from the host without
`/etc/hosts` entries (docs/WORKFLOW.md, "Using the pilot from the host
that runs it"). Nothing else is forwarded.
The site is on 8443 rather than 443 because another service on the pilot
host already owns 80 and 443, so the public address is
`https://<host-lan-address-name>:8443`. A oneshot systemd unit, `portikus-publish-vm.service`, puts the rules back
after a reboot, reading the VM address from `/etc/portikus-host/vm-ip`.
The VM address changes when the VM is rebuilt, so run `make publish-vm`
again after `make rebuild-pilot` (that target already calls it).

Then configure the VM, which names the site after the host's LAN address
so browsers on the LAN reach it through the forward. Sign-in goes through
Dex by default (see "Identity provider" below):

```
make configure-vm
```

The site name defaults to `portikus.<host-lan-ip>.nip.io`. nip.io is a
public DNS service that resolves any name of that shape back to the
address in it, so no DNS has to be edited. Open

```
https://portikus.<host-lan-ip>.nip.io/
```

from any device on the LAN. If the network blocks public DNS, or the
device cannot resolve nip.io, add a line to that device's hosts file
instead:

```
<host-lan-ip> portikus.<host-lan-ip>.nip.io
```

To use a name of your own instead, pass it through to both targets:

```
make configure-vm PORTIKUS_PUBLIC_HOST=portikus.example.test
make smoke-test PORTIKUS_PUBLIC_HOST=portikus.example.test
```

and point that name at the host's LAN address in the device's hosts file.

The browser will not trust Caddy's certificate until you import the
authority that signed it. Fetch it from the VM and add it to your
browser or system trust store:

```
ssh deploy@<vm-ip> sudo cat /etc/portikus/caddy-root.crt > portikus-caddy-root.crt
```

In Firefox: Settings, Privacy & Security, View Certificates, Authorities,
Import, and tick "Trust this CA to identify websites". Chrome uses the
system store, so `sudo cp` it into `/usr/local/share/ca-certificates/` with
a `.crt` name and run `sudo update-ca-certificates`.

Importing it makes that authority trusted for every site the browser
visits, and its private key lives on the VM that runs student workspaces,
so use a throwaway browser profile for the pilot rather than your everyday
one.

The certificate is generated on the VM, so destroying and recreating the
VM produces a new one. Import the new copy after a rebuild and remove the
old one.

Never publish a VM configured with `PORTIKUS_IDP=mock`: while the mock
sign-in is on, every device on the LAN can sign in as any mock account,
including the administrator. To take the site off the LAN:

```
make unpublish-vm
```

That deletes all three chains, the systemd unit, and the stored address. It
leaves libvirt's own rules alone, so the VM keeps its outbound access.

### Identity provider

`PORTIKUS_IDP` picks how people sign in (ADR 0023, docs/EPIC-14.md). A
site has one provider; LTI launches work beside any of them.

- `dex`, the default: Dex runs on the VM and keeps its own passwords,
  which administrators manage in the Users view. It can also sit in front
  of an LDAP or Active Directory directory, Entra or Google
  (`PORTIKUS_DEX_UPSTREAM`). This is what the pilot uses.
- `entra`: Microsoft Entra ID, one tenant, roles from app roles.
- `google`: Google Workspace, the listed domains, everyone a student
  until an administrator grants more.
- `external`: any other OpenID Connect (OIDC) provider, such as Okta,
  Keycloak or Shibboleth with its OIDC plugin.
- `mock`: the in-repo test provider (ADR 0008), where anyone who reaches
  the site can pick any account, the administrator included. For
  development and tests only; never on a VM others can reach.

docs/OPERATIONS.md, "Sign-in providers", says how to register Portikus
with each provider and which settings to pass. Only the chosen provider
runs. Ansible stops and disables the others and removes their
configuration and secrets, and Caddy answers `/dex` and `/mock-idp` with
404 when they are not the provider. The old `PORTIKUS_MOCK_IDP=true` is
refused with a message; use `PORTIKUS_IDP=mock`.

The settings, all read from the environment by `make configure-vm`:

| Setting | Used with | What it is |
|---|---|---|
| `PORTIKUS_ENTRA_TENANT_ID` | `entra`, or Dex's `microsoft` connector | The tenant's ID, a GUID. The issuer is derived from it. |
| `PORTIKUS_GOOGLE_DOMAINS` | `google`, or Dex's `google` connector | The allowed domains, separated by commas. |
| `PORTIKUS_OIDC_ISSUER` | `external` | The provider's issuer URL. |
| `PORTIKUS_OIDC_CLIENT_ID`, `PORTIKUS_OIDC_CLIENT_SECRET` | `entra`, `google`, `external` | The client Portikus is registered as. The secret needs 32 characters or more. |
| `PORTIKUS_OIDC_SCOPES` | any | Defaults to `openid profile email`, plus `groups` for Dex. |
| `PORTIKUS_OIDC_STUDENT_GROUP`, `PORTIKUS_OIDC_INSTRUCTOR_GROUP`, `PORTIKUS_OIDC_ADMIN_GROUP` | any | The group or app role names that give each role. They default to `portikus-students` and so on, or `Portikus.Student` and so on under Entra. |
| `PORTIKUS_DEX_UPSTREAM` | `dex` | `none` (the default), `ldap`, `microsoft` or `google`. |
| `PORTIKUS_DEX_UPSTREAM_CLIENT_ID`, `PORTIKUS_DEX_UPSTREAM_CLIENT_SECRET` | Dex's `microsoft` or `google` connector | The client Dex is registered as. The secret needs 16 characters or more. |
| `PORTIKUS_LDAP_HOST`, `PORTIKUS_LDAP_SCHEMA`, `PORTIKUS_LDAP_BIND_DN`, `PORTIKUS_LDAP_BIND_PASSWORD`, `PORTIKUS_LDAP_USER_BASE_DN`, `PORTIKUS_LDAP_USER_FILTER`, `PORTIKUS_LDAP_GROUP_BASE_DN`, `PORTIKUS_LDAP_ROOT_CA`, `PORTIKUS_LDAP_IP_ALLOW` | Dex's `ldap` connector | The directory. The user filter and the directory's addresses are required. |
| `PORTIKUS_EGRESS_EXTRA_HOSTS` | any | More hosts the API may reach through the egress proxy, as `host` or `host:port`. |
| `PORTIKUS_USERS_FILE` | `dex` | The retired users file, imported once (below). |

The Makefile exports these to Ansible from the environment, so the
secrets never appear in a recipe line. Keep them out of shell history too:
`read -rs NAME && export NAME`. Bad or missing settings stop the play
before anything on the VM changes.

Ansible turns them into these API settings in `/etc/portikus/api.env`:
`OIDC_PROVIDER` (`oidc`, `entra` or `google`), `OIDC_ALLOWED_TENANT`,
`OIDC_ALLOWED_DOMAINS`, `OIDC_DEFAULT_ROLE` (`student` under Dex and
Google, `none` otherwise, which refuses someone no group matches),
`OUTBOUND_PROXY_URL`, and, under Dex only, `DEX_GRPC_ADDR`, `DEX_GRPC_CA`,
`DEX_GRPC_CERT` and `DEX_GRPC_KEY`.

When no enabled administrator exists, the play ends by printing a
one-time setup code for `https://<public-host>:<port>/setup`. The first
person to enter it becomes the administrator (docs/OPERATIONS.md, "The
first administrator").

#### Dex

Dex has no Debian package and publishes no binaries, so the `dex` role
builds it on the VM from the upstream commit pinned in `site.yml`
(`dex_version` and `dex_commit`), the same way distrobuilder is built. The
first run needs GitHub and the Go module proxy and takes a few minutes. A
later run builds nothing unless the pin changed, and a failed build leaves
the running binary in place. Dex listens on `127.0.0.1:5556` and Caddy
serves it at `https://<public-host>:<port>/dex`, which is also its issuer.
Before a password form post reaches Dex, its own or the LDAP connector's,
Caddy asks the API's sign-in throttle, because Dex has no lockout of its
own (#398).

Dex keeps its accounts in its own PostgreSQL database, `dex`, owned by
the `portikus-dex` role and reached over the local socket (ADR 0028). The
nightly backup dumps it as `dex.dump`. Its gRPC API, which the Users view
uses to add, reset and remove passwords, listens on `127.0.0.1:5557` and
accepts only a client certificate from a small certificate authority that
Ansible keeps in `/etc/portikus/dex-grpc/`. The API's client key is
`root:portikus`, mode 0640. Caddy never routes to that port. A play
issues new certificates when fewer than 30 days are left, and restarts
Dex and the API when it does.

Dex's client secret is generated on the VM into
`/etc/portikus/dex-client.secret` (root, mode 0600) the first time, the
same way the controller token and session secret are, and written into
the API's environment file and Dex's configuration,
`/etc/portikus-dex/config.yaml` (`root:portikus-dex`, mode 0640). An LDAP
bind password or an upstream client secret is written there too.

**The users file is retired.** Before Epic 14, Dex's accounts came from a
users file on the machine that runs Ansible. When that file exists
(`PORTIKUS_USERS_FILE`, by default `~/.config/portikus/users.json`, mode
0600) and Dex's storage holds no passwords, the play imports every entry
through the gRPC API with its own bcrypt hash and user ID, so every
account keeps its subject and workspace. An administrator or instructor
in the file becomes that account's stored grant. The import is all or
nothing, and a later run imports nothing. After the import, delete the
file.

#### Moving existing accounts from the mock to Dex

Accounts made through the mock have the mock as their issuer, so after a
switch to Dex the same people would get new, empty accounts. When the
play has a users file, it carries each of its accounts over to the row
the mock account already has, matching by email, before the API
switches to Dex. It audits every change and signs everyone out once. The
pilot needed this once, on 2026-09-23; it is kept for restoring a backup
taken before then. To see what it would do without changing anything:

```
make identity-carry-over-dry-run
```

Each account is reported as already linked, carried (or would carry), new
(it gets an account at first sign-in), or left behind (an older duplicate,
issue #302, which is not touched).

#### The egress proxy

The API's systemd unit may reach only loopback and the workspace bridge.
It reaches its provider and each LMS's keyset through Squid, a forward
proxy that the `egress_proxy` role runs on `127.0.0.1:3128` (ADR 0027).
Squid allows only HTTPS to the named hosts, refuses a name that resolves
to a private address, and caches nothing. The play builds the list from
the provider's discovery document, the LMS keyset URLs and
`PORTIKUS_EGRESS_EXTRA_HOSTS`, prints it, and checks the configuration
with `squid -k parse` before installing it. `PORTIKUS_API_IP_ALLOW` and
its `10-idp-egress.conf` drop-in are gone; a play that still sets the
variable stops with a message. Dex's `microsoft` and `google` connectors
use the same proxy. An LDAP directory is reached directly, through Dex's
own `IPAddressAllow` drop-in built from `PORTIKUS_LDAP_IP_ALLOW`.

#### The mock, for development

```
make configure-vm PORTIKUS_IDP=mock
make smoke-test PORTIKUS_IDP=mock
```

The mock ships in the Debian package, disabled; Ansible enables it only
with `PORTIKUS_IDP=mock`. It listens on loopback and is reachable only
through Caddy at `/mock-idp`. Its accounts are `alice` and `bob`
(students), `carol` (administrator), and `dave` (no groups, so login is
refused). Its client secret is generated on the VM into
`/etc/portikus/mock-client.secret`, and any other provider removes that
file along with the mock's environment file.

Passing the client secrets through the environment is a known gap: they
belong in the SOPS-encrypted secrets under `infra/secrets`, which is not
wired up yet (STACK.md section 27). Until then a secret is visible to
anything that can read the Ansible process's environment.

The session cookie secret is different: Ansible generates it on the VM
once into `/etc/portikus/session.secret` and never regenerates it, the
same way it handles the controller token, so re-running the playbook does
not sign everyone out.

### LTI

LTI 1.3 (Learning Tools Interoperability) lets a student open Portikus
from a course in a learning management system (LMS) such as Canvas or
Moodle, without a second password (docs/EPIC-13.md). The LMS is called the
platform. docs/OPERATIONS.md says which LMS fields to fill in.

Platforms are registered in a file on the machine that runs Ansible, by
default `~/.config/portikus/lti-platforms.json` (override with
`PORTIKUS_LTI_PLATFORMS_FILE=<path>`). It holds no secret. `make
configure-vm` checks it, copies it to `/etc/portikus/lti-platforms.json`
(`root:portikus`, mode 0640) and restarts the API, which validates it in
full and refuses to start on a bad file. With no file on your machine,
Ansible removes the copy on the VM and LTI is off: every `/lti/*` route
answers 404.

Each LMS registration asks for the tool's keyset URL,
`https://<public-host>:<port>/lti/jwks`. The key behind it is generated on
the VM once, into `/etc/portikus/lti-tool-key.pem` (`root:portikus`, mode
0640), and never replaced, because every registration pins it. A new
key would mean updating every LMS.

The API fetches each platform's keyset through the egress proxy (see
"The egress proxy" above). The play adds the host of every keyset URL to
the proxy's allow list, so a cloud LMS needs nothing more. A keyset URL
that names an IP address, like the mock LMS's, is allowed at that address
and port only.

Caddy sends `frame-ancestors 'none'` on every control-plane page except
`/lti/*`, where the API names the registered platforms instead, so an LMS
can show the launch page inside a frame.

#### Trying it with the mock LMS

The mock LMS runs on this host, never on the VM, and signs a launch as any
of its seeded people. It listens on port 8765 at loopback, the host's
address on the VM network (`10.100.0.1`), and the host's LAN address
(`HOST_IP`, `192.168.10.48` for the pilot), and registers itself at the LAN
address (`MOCK_LMS_HOST` overrides). A platform's URLs must be reachable
both by the user's browser (the login redirect) and by the API on the VM
(the keyset fetch). A real LMS on the internet meets that; the mock must
use an address the browser can reach, which `10.100.0.1` is not from
another machine. Anyone on the LAN who can reach it can launch as anyone,
so keep it registered only while you use it.

```
make mock-lms              # in its own terminal; runs in the foreground
make lti-mock-register     # trust it on the VM
# open http://<HOST_IP>:8765/ in a browser and launch
make lti-mock-unregister   # stop trusting it
```

`make smoke-test` checks the LTI files and the keyset every time. With no
LMS registered it checks that every `/lti` route answers 404. With the mock
registered it launches as the student Sam and the instructor Ivy, and
checks the session, the roles, the Course page and that a second post of
the same launch is refused. If the mock is not running, the smoke test
starts it for the run and stops it afterwards. It prints a warning while
the mock is registered, and lists the accounts mock launches have made.

`make lti-mock-register` adds a `mock: true` registration named
`mock-lms` to the platforms file and runs only the play's `lti` tasks.
Because its keyset URL is `http://<MOCK_LMS_HOST>:8765/...`, the API is
allowed to reach that address (`/32`) for as long as it stays registered. `make
lti-mock-unregister` removes the registration (and the file, if nothing
else is registered) and runs the same tasks, which takes the address away
again. Both need a VM configured once with `make configure-vm` after this
change. Users created by mock launches stay in the database.

`scripts/build-deb.sh` fails if the mock ends up in the Debian package.

## Bring your own Debian host

Steps 1 to 4 exist only to produce a Debian 13 machine with a deploy
account and a spare disk. Everything after that is Ansible plus one
Debian package, so a Debian 13 host you already have — another VM, or
real hardware — can be configured the same way. Skip steps 1 to 4, do the
short list below by hand, and run the playbook.

### What the host must already have

- Debian 13 (trixie), 64-bit. See "Other distributions" below.
- A user named `deploy` with passwordless sudo, and your SSH public key in
  its `~/.ssh/authorized_keys`. The name is not configurable: it is fixed
  in `infra/ansible/inventory.ini` (line 6) and in every Make target and
  the smoke test that reach the host over SSH.
- `python3` and `python3-apt` installed, so Ansible can run and manage apt.
- An empty second block device for workspace storage. Ansible puts an LVM
  volume group on the whole device, destroying anything on it. The device
  path is the `data_disk_device` variable, which defaults to `/dev/vdb`
  (`infra/ansible/site.yml`, line 10); pass `-e data_disk_device=/dev/sdb`
  if yours is named differently.
- Nothing to do about the network interface name: the firewall takes it
  from the host's own default route at run time.
- An IP address you can reach on port 22, and that browsers can reach on
  the site's port (8443 by default; pass `PORTIKUS_PUBLIC_PORT=443` to
  serve the usual one). There is no port forward to set up, so `make
  publish-vm` is not needed.
- Hardware virtualisation is not required. Workspaces are containers, and
  the host is the container host.

### What to run

`make configure-vm` first waits for cloud-init to report finished, which a
host that was not built from a cloud image cannot do, so call the playbook
directly. `PORTIKUS_MANAGEMENT_CIDR` is the subnet the host itself sits
on; the firewall and the workspace network ACL use it to keep workspaces
away from that network, and it defaults to the libvirt subnet
`10.100.0.0/24`, which is wrong on your own host. Both also deny every
range in `workspace_egress_denied_ranges` (`infra/ansible/site.yml`), the
private and special address ranges; add your own infrastructure ranges to
that list.

```
cd infra/ansible
ansible-galaxy collection install -r requirements.yml
export PORTIKUS_VM_IP=192.0.2.10
export PORTIKUS_MANAGEMENT_CIDR=192.0.2.0/24
export PORTIKUS_PUBLIC_HOST=portikus.192.0.2.10.nip.io
ansible-playbook site.yml
```

Then build the workspace image, deploy a development build of the control
plane, and verify, from the repository root. These targets only need the
address, so `VM_IP=` is enough:

```
make build-workspace-image VM_IP=192.0.2.10
make deploy-app VM_IP=192.0.2.10
make smoke-test VM_IP=192.0.2.10 \
  PORTIKUS_PUBLIC_HOST=portikus.192.0.2.10.nip.io PORTIKUS_PUBLIC_PORT=443
```

The playbook already installed the newest published release, so `make
deploy-app` is only for testing a local build. Trust Caddy's certificate
as described under "Browser access", and claim the setup code the
playbook prints to create the first administrator (see "Identity
provider").

### Limits today

- The account name `deploy` is fixed in `infra/ansible/inventory.ini`, in
  the SSH commands in the Makefile, and in `infra/tests/smoke-test.sh`.
  `infra/ansible/roles/image_builder/tasks/main.yml` also creates three
  directories owned by `deploy`.
- The site name is derived from the address: it defaults to
  `portikus.<ip>.nip.io` (`infra/ansible/site.yml`, lines 86 to 88), and
  nip.io is a public service that resolves any name of that shape back to
  the address inside it. A real DNS name works, but only because you pass
  it in `PORTIKUS_PUBLIC_HOST`; nothing here manages DNS, and Caddy still
  issues its own certificate rather than a publicly trusted one.
- The port is a single variable, `PORTIKUS_PUBLIC_PORT`. It has to match
  in three places at once: Caddy's site address, the URLs the API builds,
  and the host's port forward. Setting it on `configure-vm` covers the
  first two; the forward in `infra/host/publish-vm.sh` is fixed at 8443.
- `PORTIKUS_PUBLIC_HOST` must be set explicitly when going through Make.
  The Makefile builds a default from your workstation's own LAN address,
  which is the wrong address for a host you did not create locally.
- The smoke test checks `/dev/vdb` directly in two places
  (`infra/tests/smoke-test.sh`, lines 133 and 218), so those two checks
  fail if your data disk has another name, even when the playbook
  succeeded with `-e data_disk_device`.
- `make configure-vm`, `make infra-plan`, `make infra-apply`,
  `make destroy-pilot`, `make rebuild-pilot`, and `make publish-vm` are
  libvirt-only. Everything else takes `VM_IP=`.
- The management network is a CIDR you assert, not something the playbook
  can discover. If the host shares a subnet with anything you care about,
  say so in `PORTIKUS_MANAGEMENT_CIDR` or workspaces will be able to reach
  it.

### Other distributions

Only Debian 13 is tested. The third-party repositories would all work
elsewhere: Incus comes from Zabbly for the host's own release codename,
Node.js 24 from NodeSource's release-independent `nodistro` suite, and
Caddy from Cloudsmith's `any-version` suite. Two things are Debian 13
specific. PostgreSQL is installed as the plain `postgresql` package, which
on Debian 13 is version 17; Ubuntu 24.04 would give 16 instead, which is
probably fine but has never been run. The image builder compiles
distrobuilder with the distribution's Go, and that path was worked out
against the Go in Debian 13 (docs/adr/0004). The control-plane package
itself only requires `nodejs (>= 24)`, so it installs on any Debian-based
system.

## Destroy and recreate

```
make destroy-pilot
```

Then repeat from step 3. User data on the data disk is destroyed when the
VM is destroyed; persistent-data backup and restore is a later epic.
