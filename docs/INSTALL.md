# Installing Portikus

This guide installs Portikus on a Debian 13 x86-64 server: bare metal or a
full virtual machine, rented from any provider or your own hardware. It is
the normal way to install it: put Debian 13 on the server, add the Portikus package
repository, run `apt install portikus`, and answer a short series of text
screens. Setup then runs on its own, and you sign in as the administrator.

The tooling under `infra/` (a libvirt virtual machine built from a
workstation with Ansible) is for development only: the project's pilot and
its rehearsal machine. You do not need it.

Every command below runs on the server as root, or with `sudo` in front, as
shown. The steps were rehearsed on a fresh Debian 13 virtual machine
(`make install-test`, docs/OPERATIONS.md, "The rehearsal VM"). Where a
detail could not be checked that way, this guide says so.

## What you need

- **A server running Debian 13 ("trixie"), x86-64.** It must be a physical
  server or a full virtual machine, not a container-based VPS. It can come
  from any hosting provider or be your own hardware. docs/HOSTING.md says
  what size suits a class of about 24.
- **Storage for student files.** Best is a spare, empty disk that Portikus
  can use whole. An existing LVM volume group with free space also works
  (LVM, the Logical Volume Manager, is Linux's disk-pooling system). When
  the only disk is the system disk, or the disks are mirrored together, use
  a file on the main disk, which needs no spare disk but is slower. "Before
  you install Debian" below says how to plan this.
- **A DNS name you control**, such as `portikus.example.edu`, for the
  server. Students also get preview addresses under `preview.<that name>`.
- **A way to get the HTTPS certificate**, one of:
  - **Let's Encrypt** (recommended). It is free and every browser trusts it.
    Your domain's DNS must be hosted at Cloudflare, and you need a
    Cloudflare API token with the "Edit zone DNS" permission for that
    domain (see "Choosing the certificate" below for why).
  - **Certificate files you already have**, covering both the server's name
    and `*.preview.<that name>`, copied onto the server before you start.
  - **Portikus's own certificate authority**, for a lab or a private
    network with no public DNS. Every browser that uses the site must be
    told to trust its root certificate.
- **Outgoing internet access from the server** during setup (see "Setup").
- **SSH access** to the server as root or as a user with `sudo`.

## Before you install Debian

Install Debian 13 with your provider's installer or from the Debian
installation image. Plan the disks first:

- **With a spare disk**, install Debian on one disk only and leave the
  other completely empty, with no partitions and no software RAID (disk
  mirroring). Portikus then uses the empty disk whole, which is the
  fastest option.
- **With an existing LVM volume group** that has free space, Portikus can
  use that free space and leaves existing volumes alone.
- **With one disk, or with the disks mirrored**, Portikus keeps student
  files in a file on the main disk. Mirroring protects the system and
  student files against one disk failing, at the cost of slower student
  storage and half the total space.

Add your SSH public key during the install. Then sign in over SSH and
check the release:

```
cat /etc/debian_version
```

It should start with `13`. If your provider offers only Debian 12,
install it and upgrade to 13 by following the Debian 13 release notes
("Upgrades from Debian 12 (bookworm)"). Portikus has not been tried on a
server upgraded this way: every rehearsal starts from Debian 13's own
image. Check that `/etc/debian_version` starts with `13` and that
`sudo apt update` shows only `trixie` sources before you go on.

"Example: an OVH dedicated server" at the end of this guide walks through
one provider's steps.

## DNS records

Create these two records at your DNS provider before you install, both
pointing at the server's public IPv4 address (your provider's control
panel shows it):

| Type | Name | Value |
|---|---|---|
| A | `portikus.example.edu` | the server's address |
| A | `*.preview.portikus.example.edu` | the server's address |

Use your own name in place of `portikus.example.edu`. The first record is
the site itself. The second is a wildcard: each running student
application gets its own name under `preview.<site name>`, such as
`alice-5173.preview.portikus.example.edu`, and one wildcard record sends
all of them to the server. If your DNS is at Cloudflare, set both records
to "DNS only" (the grey cloud), not proxied. Cloudflare's free proxy
certificate covers only one level of names below your domain, so it
cannot serve `alice-5173.preview.portikus.example.edu`, and the proxy
would also stand between students and the server's own certificate.
The rehearsals made no public records, so this follows Cloudflare's
documentation rather than a test.

Check the first record from your own computer before going on:

```
host portikus.example.edu
```

## Adding the Portikus package repository

A fresh Debian 13 may lack the two tools this needs, `curl` to download
and `gpg` to check the key, so install them first:

```
sudo apt update
sudo apt install -y curl gpg
```

Then fetch the repository's signing key and tell apt where the repository
is. The first command downloads the key; the second adds the repository
and says that only this key may sign it.

```
sudo curl -fsSL -o /usr/share/keyrings/portikus-archive-keyring.gpg https://toddawhittaker.github.io/portikus/apt/portikus-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/portikus-archive-keyring.gpg] https://toddawhittaker.github.io/portikus/apt trixie main" | sudo tee /etc/apt/sources.list.d/portikus.list
```

Check that the key is the real one before trusting it:

```
gpg --show-keys /usr/share/keyrings/portikus-archive-keyring.gpg
```

The fingerprint it prints must be exactly:

```
9F6FD4CD5CC5C43AB5125705015D38802EF8D0F4
```

(Written in groups: `9F6F D4CD 5CC5 C43A B512 5705 015D 3880 2EF8 D0F4`.)
If it differs, stop, delete the file and the list, and report it: someone
may be tampering with your download. The package installs the same key
at the same path and writes it again on every upgrade, so apt keeps
trusting it across upgrades.

## Installing

```
sudo apt update
sudo apt install portikus
```

apt installs the package and its dependencies from Debian and then shows
the questions described next. Nothing on the server is configured until
you say Yes on the last screen.

## The install screens

The questions appear as grey dialogs on a blue screen. Move with the arrow
keys and Tab, choose with Enter. **Cancel** goes back one screen. A
screen appears only when your earlier answers make it relevant. If an
answer is not valid, a "Please check that answer" note says why, and the
question comes back:

```
       ┌───────────────────┤ Configuring portikus ├────────────────────┐
       │                                                               │
       │ Please check that answer                                      │
       │                                                               │
       │ A tenant ID looks like 12345678-90ab-cdef-1234-567890abcdef.  │
       │                                                               │
       │                            <Ok>                               │
       └───────────────────────────────────────────────────────────────┘
```

### 1. Welcome

Says what Portikus is and what will be asked. Choose Ok.

### 2. Web address of this server

The DNS name from "DNS records", such as `portikus.example.edu`. The
suggestion is the server's own full host name, which on a rented server is
usually the provider's name for it, so replace it. Use lower-case letters,
digits, hyphens and dots.

### 3. Email of the Portikus administrator

Setup creates one local administrator account with this email. It is the
name you sign in with, and it does not need to receive mail. The
suggestion is `admin@<web address>`, which is fine.

### 4. HTTPS certificate

- **Let's Encrypt** (the default): choose it if your domain's DNS is at
  Cloudflare. Two more screens follow:
  - **Email for Let's Encrypt**: where Let's Encrypt writes if a
    certificate has a problem. The suggestion is the administrator's
    email; use a mailbox someone reads.
  - **Cloudflare API token**: Let's Encrypt issues the wildcard
    certificate for student previews only after a DNS check, and Portikus
    makes that check by adding a temporary record through Cloudflare. In
    the Cloudflare dashboard, go to My Profile, API Tokens, Create Token,
    and use the "Edit zone DNS" template limited to your domain. Paste the
    token here. It is stored only in `/etc/portikus/secrets.yaml`, which
    only root can read.
- **Certificate files I already have**: two more screens ask for the full
  paths of the certificate (PEM format, intermediates after it) and its
  private key. The files must already be on the server and must cover
  both the web address and `*.preview.<web address>`.
- **Portikus's own certificate authority (testing)**: no more screens.
  Browsers will warn until each one trusts the root certificate (see
  "After setup").

### 5. How people sign in

Portikus always has local accounts, which the administrator creates. This
screen adds your institution's accounts on top:

- **Local accounts only** (the default): nothing more to answer. You can
  add single sign-on later with `sudo dpkg-reconfigure portikus`.
- **Microsoft Entra ID**: asks the tenant ID, the client ID and the client
  secret.
- **Google Workspace**: asks the allowed domains (separated by spaces), the
  client ID and the client secret.
- **LDAP or Active Directory**: asks the directory server, the kind of
  directory, the directory servers' addresses, the service account and
  its password, where people are, a filter naming who may sign in, and
  optionally where groups are and the directory's CA certificate. With a
  group location it also asks the three group names below.
- **Another OpenID Connect provider** (such as Okta, Keycloak or
  Shibboleth): asks the issuer URL, the client ID and secret, the groups
  claim, and the students', instructors' and administrators' group names.

For Entra, Google and other OpenID Connect providers, register Portikus
with the provider first. The client ID screen shows the redirect address
to register, `https://<web address>/dex/callback`. docs/OPERATIONS.md,
"Sign-in providers", has the steps for each provider. If you are not
ready, choose Local accounts only now and add the provider later.

### 6. Where to keep student files

Lists what this server has: each empty disk, each LVM volume group with
free space, and a file on the main disk. The suggestion is the empty disk
when there is exactly one, and otherwise the file.

```
   ┌───────────────────────┤  Configuring portikus ├────────────────────────┐
   │ Student files, containers and Docker data live in one storage pool.   │
   │                                                                       │
   │ An empty disk is fastest; setup erases it. An LVM volume group gives  │
   │ its free space and leaves existing volumes alone. A file on the main  │
   │ disk needs no spare disk, but is slower and shares space with the     │
   │ system.                                                               │
   │                                                                       │
   │ Where to keep student files:                                          │
   │                                                                       │
   │          /dev/sdb - an empty disk of 931 GiB (erased)                 │
   │          LVM volume group data - 200 GiB free                         │
   │          A file on the main disk - 582 GiB free and slower            │
   │                                                                       │
   │                                                                       │
   │                  <Ok>                      <Cancel>                   │
   │                                                                       │
   └───────────────────────────────────────────────────────────────────────┘
```

If you left a spare disk empty, choose that disk. If the disks are
mirrored or there is only one, choose the file.

- **A disk** is followed by **Erase /dev/...?** Choose Yes only if the
  disk holds nothing you need. If you choose No, the answers are saved but
  setup does not start until you say Yes (see "Changing your answers").
- **The file** is followed by **Size of the storage file, in GiB**. The
  suggestion is half the free space on the main disk; the most it accepts
  leaves 10 GiB or a tenth of the free space, whichever is more, for the
  system. About 1,000 GiB suits a class of about 24 (docs/OPERATIONS.md,
  "Host hardware for a class of about 24").

### 7. Save these answers and start setup?

A summary of every answer except secrets:

```
  ┌─────────────────────────┤  Configuring portikus ├─────────────────────────┐
  │                                                                          │
  │ Web address: https://portikus.example.edu                                │
  │ Administrator: admin@portikus.example.edu                                │
  │ Certificate: Let's Encrypt, notices to admin@portikus.example.edu        │
  │ Sign-in: local accounts only                                             │
  │ Student files: /dev/sdb, NOT confirmed, so setup will not start          │
  │                                                                          │
  │                                                                          │
  │ Yes saves them in /etc/portikus/portikus.yaml, with secrets in           │
  │ /etc/portikus/secrets.yaml, and starts setup in the background. No goes  │
  │ back to change an answer.                                                │
  │                                                                          │
  │ Save these answers and start setup?                                      │
  │                                                                          │
  │                    <Yes>                       <No>                      │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘
```

Yes saves the answers and starts setup. No goes back.

## Setup

When the answers are complete, apt finishes and prints:

```
Portikus setup is running in the background. It takes about ten minutes.

  1. Follow it with:  sudo portikus setup --follow
  2. When it finishes, read the administrator's one-time password with:
       sudo cat /etc/portikus/admin-password
  3. Sign in at https://portikus.example.edu as admin@portikus.example.edu and choose a new password.
```

If instead it says "Portikus is installed, but setup has not started", it
lists what is missing; run `sudo dpkg-reconfigure portikus` to answer it.

Setup runs as a background service, `portikus-setup.service`, so it keeps
going if your SSH session drops. `sudo portikus setup --follow` shows its
log as it runs and returns when setup ends. It exits with status 0 when
setup succeeded; when setup failed it says so, with how to read the log
and rerun it with `sudo portikus setup`. Pressing Ctrl-C only stops the
watching, not setup.

In rehearsal on a fresh Debian 13 machine with 12 processor cores, setup
took about six minutes; allow up to fifteen on a slower machine or network
(docs/OPERATIONS.md, "The rehearsal VM"). It uses
the Ansible roles shipped in the package to set up, on this server: the
nftables firewall, the student storage pool, Incus (the container system
that runs each student's workspace) and its network, PostgreSQL, Caddy
(the web server that holds the HTTPS certificate), the egress proxy that
controls what workspaces reach on the internet, Dex (the sign-in service),
the workspace image, the Portikus services, and finally the local
administrator.

Setup needs outgoing internet access to:

- Debian's own mirrors;
- Zabbly (`pkgs.zabbly.com`), for Incus;
- Cloudsmith (`dl.cloudsmith.io`), for Caddy;
- GitHub (`github.com` and its release downloads), for Dex's source and
  the workspace image;
- the Go module proxy (`proxy.golang.org`), to build Dex;
- for Let's Encrypt, Let's Encrypt itself and Cloudflare's API.

The firewall setup installs allows SSH (port 22), HTTP (port 80) and HTTPS
(port 443) in, and nothing else. Port 80 only redirects browsers to HTTPS.
Let's Encrypt does not need it: Portikus proves it owns the domain through
a temporary DNS record (the DNS-01 check), not through port 80, so a
server whose port 80 is blocked upstream still gets its certificates.

## First sign-in

1. Read the one-time password:

   ```
   sudo cat /etc/portikus/admin-password
   ```

2. Open `https://<web address>` in a browser. On the sign-in page, choose
   "Log in with Email" and sign in with the administrator's email and that
   password.
3. Portikus shows only **Set a new password** until you choose one. Once
   you have, the one-time password stops working, and the next setup run
   deletes the file.

If the file is gone or the password is lost, `sudo portikus reset-admin`
makes a new one (docs/OPERATIONS.md, "The local administrator").

## After setup

- **Sign-in provider.** If you chose Local accounts only and want your
  institution's accounts, register Portikus with the provider
  (docs/OPERATIONS.md, "Sign-in providers") and run
  `sudo dpkg-reconfigure portikus`. Otherwise create accounts in the
  Users view (docs/ADMIN-GUIDE.md).
- **Backups.** Nightly backups are pulled by a second machine over SSH and
  encrypted there (docs/OPERATIONS.md, "Backups"). Set that up before
  students store work. Today the second machine is a Linux machine with a
  checkout of the Portikus repository, which runs `infra/host/backup.sh`
  (as `make backup` does). It signs in over SSH as an account named
  `deploy` that has passwordless `sudo` on the server, so make that
  account on the server and give it the second machine's SSH key. A
  rehearsal pulled a complete set from an apt-installed server this way.
  Keeping backups on the server itself, with no second machine, is
  planned.
- **Own certificate authority only.** Each browser that uses the site must
  trust Caddy's root certificate, which setup copies to
  `/etc/portikus/caddy-root.crt`. Copy it to your computer, for example
  with `scp you@portikus.example.edu:/etc/portikus/caddy-root.crt .`, and
  import it into the browser's or the system's trusted authorities
  (infra/README.md, "Browser access", has the per-system steps).

## Unattended installs

For a scripted rebuild, give every answer in advance with a preseed file,
so the install asks nothing. The file
`/usr/share/doc/portikus/preseed.example`, installed with the package,
lists every question, the key it writes and an example answer. Before the
package is installed, use the same file from the Portikus repository on
GitHub, `packaging/debian/preseed.example`. Copy it to the server as
`preseed.txt`, keep the
lines that apply, fill them in, and then:

```
sudo debconf-set-selections preseed.txt
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y portikus
sudo portikus setup --follow
```

The preseed holds secrets in plain text. Portikus removes them from its
answer store once written, but delete your `preseed.txt` yourself. Setup
starts only when every answer it needs is there; for a disk that includes
`portikus/storage_confirm` set to `true`.

## Changing your answers

```
sudo dpkg-reconfigure portikus
```

This shows the screens again with your current answers filled in. For a
secret, leave it blank to keep the stored one. Saying Yes on the summary
saves and starts setup again, which changes only what differs.

The answers live in `/etc/portikus/portikus.yaml` (secrets in
`/etc/portikus/secrets.yaml`). You may edit the file by hand; a hand edit
wins over the remembered answer the next time you reconfigure, though
comments in it are not kept. After a hand edit, apply it with:

```
sudo portikus setup
```

This runs setup in the foreground and is safe to run at any time.

## Upgrades

```
sudo apt update
sudo apt upgrade
```

An upgrade installs the new Portikus release, restarts its services, and
starts setup again in the background, so any change a release makes to the
server is applied too. Follow it with `sudo portikus setup --follow`.

## Troubleshooting

- **Is it running?** `sudo portikus status` prints the package version and
  whether setup and each Portikus service is active.
- **Setup failed.** Read the log with `sudo portikus setup --follow` (or
  `sudo journalctl -u portikus-setup.service` to page through it). The
  failed task is marked `fatal:` and says why. Fix the cause, then run
  `sudo portikus setup` to try again in the foreground; it carries on from
  where things stand.
- **Setup did not start because of storage.** If you picked a disk and
  answered No to "Erase ...?", setup will not touch the disk. Run
  `sudo dpkg-reconfigure portikus` and answer Yes, or choose another
  storage option.
- **Let's Encrypt or DNS failures.** Check both DNS records point at the
  server (`host portikus.example.edu` and
  `host test.preview.portikus.example.edu`), that the Cloudflare token has
  "Edit zone DNS" for the right domain, and that port 443 reaches the
  server. Port 80 plays no part in getting the certificate. To replace
  the token, run `sudo dpkg-reconfigure portikus` and paste the new one. Let's Encrypt limits repeated failures, so fix
  the cause before retrying many times. Caddy's own log is in
  `sudo journalctl -u caddy`.
- **Setup waits at the start.** Setup waits up to fifteen minutes for
  another apt or dpkg run to finish. Let it finish.
- **Downloads fail.** Check the server reaches the sites listed under
  "Setup".

## If the signing key is ever compromised

The key that signs the repository does not expire. If it were ever stolen,
the project would publish a revocation (the project holds an offline
revocation certificate for this key) and a new key, and announce both on
the project's GitHub page. Until you have imported the new key, apt
refuses updates signed by anyone else, which is the point. When a new key
is announced, fetch it over the same address as above, check its new
fingerprint against the announcement, and run `sudo apt update`. Do not
trust a new key that has not been announced on the project's GitHub page.
Do not rely on an upgrade to bring the new key either. The package writes
its own copy of the key file on every upgrade, and a package signed with a
stolen key could write any key there. Only a key whose fingerprint you
checked against the announcement is safe.

## Example: an OVH dedicated server

One way to get a server: these steps follow OVH's control panel for an
Eco dedicated server, which docs/HOSTING.md recommends. Other providers
differ. The menu names were not checked against a live OVH account; if one
differs, look on the server's page for the action that installs or
reinstalls the operating system.

1. Order the SYS-GAME-2 (docs/HOSTING.md, "Recommendation"). Pick the US
   data centre (Vint Hill, Virginia) if your students are in the US.
2. When the server is delivered, open it in the OVH control panel and
   choose **Install** (or **Reinstall**) to pick an operating system.
3. Choose the **Debian 13** template.
4. Choose how the two NVMe disks are used. You have two good choices:
   - **Keep the second disk out.** Use custom partitioning so Debian is
     installed on the first disk only, with no software RAID (disk
     mirroring), and leave the second disk completely empty: no
     partitions. Portikus then uses the second disk whole, which is the
     fastest option.
   - **Accept OVH's default**, which mirrors both disks (RAID 1) so the
     system survives one disk failing. Portikus then keeps student files
     in a file on the main disk, which is slower and shares space with the
     system.

   On the install screen "Where to keep student files", choose the second
   disk (usually `/dev/nvme1n1`) in the first case and the file in the
   second.

   The trade-off: keeping the second disk out gives students the fastest
   storage and the whole disk, but a failure of the first disk takes the
   system down. The default mirror protects the system and student files
   against one disk failing, at the cost of slower student storage and
   half the total space.
5. Add your SSH public key when the installer asks for one, and start the
   installation. OVH emails you when it is done.
6. Sign in over SSH as the user OVH names in that email (often `debian`),
   and check the release:

   ```
   cat /etc/debian_version
   ```

   It should start with `13`.

If OVH's installer does not offer Debian 13, install Debian 12 and upgrade
it to 13 by following the Debian 13 release notes ("Upgrades from Debian 12
(bookworm)"). Portikus has not been tried on a server upgraded this way
(see "Before you install Debian").
