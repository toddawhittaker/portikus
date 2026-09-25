# 0023. Dex with static users as the pilot's sign-in provider

- **Status**: Accepted; its users file and in-memory storage are superseded by ADR 0028
- **Date**: 2026-09-22
- **References**: SPEC.md §5, §24; STACK.md §8, §27; ADR 0004, ADR 0008; docs/EPIC-12B.md

## Context

The pilot signed in through the in-repo mock identity provider (ADR 0008).
Anyone who reached the site could pick any account from a list, the
administrator included (issue #408). The institution's identity provider is
not available yet, so the pilot needs a real password sign-in of its own
until it is, and the switch to the institution's provider later must stay a
change of settings, not of code.

ADR 0008 rejected Dex for two reasons. Both are out of date. Dex no longer
needs a container runtime, because it can be built from source the way
distrobuilder is (ADR 0004). And at the pinned commit, Dex's static
passwords carry `groups`, which its local connector returns in the token, so
the existing role mapping works unchanged.

## Decision

Dex runs on the platform VM as `portikus-dex.service`, installed by the
Ansible role `dex`.

- **Build.** Dex publishes no binaries and Debian has no package for it. The
  role clones `github.com/dexidp/dex` at the commit pinned in `site.yml`
  (`dex_version` and `dex_commit`), checks that the checked-out commit is the
  pin, and builds with `GOTOOLCHAIN=auto`, which verifies the Go toolchain
  against Go's checksum database. `go.sum` verifies every module. A marker
  file records the installed commit, so a run whose marker matches builds
  nothing. A failed build leaves the old binary running.
- **Pages.** Dex's sign-in pages come from the same pinned source, copied to
  `/usr/local/share/portikus/dex-web` and served through `frontend.dir`.
  They carry a Portikus theme (#532, which reverses the first "no
  restyling" decision): the dex role installs `themes/portikus/` from
  `roles/dex/files/theme/` with Public Sans, and `frontend.theme` selects
  it, so the pages look like the Portikus sign-in page in light and dark.
  Template patches, re-applied after each build, put the logo in the
  sign-in card with a text alternative and make the card the main
  landmark, make each heading a first-level heading, drop the positive
  `tabindex` from the password and device forms, and declare `lang="en"`.
  Each connector on the choice page becomes one link instead of a button
  inside a link. The sign-in fields get `autocomplete="username"` and
  `autocomplete="current-password"`. After a failed sign-in the message
  has `role="alert"`, and the password field is marked `aria-invalid` and
  described by the message. The pages also use the Portikus sign-in
  page's words: the title "Sign in, Portikus", the heading "Sign in to
  Portikus", a "Sign in" button, "Sign in with" on connector buttons,
  "Choose another way to sign in." as the back link, and "That email
  address or password is wrong." after a failed sign-in. A
  last task fails the play if any patch did not land, so a Dex upgrade
  that changes a template cannot drop one silently. CI's `dex-signin` job
  runs the same task file on the pinned commit's pages, so that failure
  shows in CI first.
- **Storage.** `storage: memory`. Every account comes from the static
  configuration, and Portikus reads the ID token once at sign-in and keeps
  its own server-side session (ADR 0008). A restart loses only sign-ins in
  flight and Dex's signing keys, which the API fetches again. There is no
  database file to back up.
- **Network.** Dex listens on `127.0.0.1:5556` over plain HTTP. Caddy serves
  it at `/dex/` on the public site with its internal certificate authority.
  The issuer is `<public URL>/dex`. The unit has the same hardening as the
  Portikus units, including `IPAddressAllow=127.0.0.0/8`.
- **Accounts.** A users file on the machine that runs Ansible, outside any
  work tree, mode 0600 (`~/.config/portikus/users.json` by default). The
  `@portikus/users-file` tool manages it through `make users-add`,
  `users-remove`, `users-list` and `users-check`. It stores only bcrypt
  hashes, at cost 12, made with `bcryptjs`: pure JavaScript, no dependencies,
  no install scripts, pinned to an exact version. The host has no Python
  bcrypt, `htpasswd` or Go, and Node has no built-in bcrypt, which is why this
  one dependency is added. No app depends on the tool, so it never reaches the
  Debian package, and `make build-deb` fails if any packaged file holds a
  bcrypt hash or `staticPasswords`.
- **Rendering.** Ansible reads the file on the controller and renders one
  `staticPasswords` entry per user into `/etc/portikus-dex/config.yaml`
  (`root:portikus-dex`, 0640), with `groups` set to `portikus-students` or
  `portikus-administrators` from the user's role. That file is the only place
  on the VM that holds the hashes.
- **Subjects.** Each user has a random `userId` fixed when the user is
  created. Dex's subject is derived from it, so Portikus can compute it in
  advance and carry existing accounts over by email before the switch. A
  reused username never inherits the previous owner's workspace.
- **Choosing the provider.** `PORTIKUS_IDP` takes `dex` (the default),
  `mock` or `external`. Only the chosen provider runs; the others' routes
  answer 404 at Caddy. With `external`, `PORTIKUS_API_IP_ALLOW` adds the
  provider's address ranges to the API unit through a systemd drop-in, so a
  move to the institution's provider needs no package change.

**Rejected:** keeping the mock with an access list in front of it, because the
list would be the only control and the mock still hands out any account. A
Dex upstream connector (LDAP, GitHub), because each needs a service the pilot
does not have. Keycloak, for the reason ADR 0008 gives. Downloading Dex's
container image and extracting the binary, because the VM has no container
runtime or extraction tooling and the build from source is already proven for
distrobuilder.

## Consequences

- Students sign in with an email address and a password the administrator
  gives them. There is no self-service password change or reset; the
  administrator resets a password with `make users-add` and `make
  users-deploy`.
- Dex has no lockout. The API's sign-in throttle covers Dex's password form
  through a Caddy `forward_auth` (#398).
- Upgrading Dex is a pull request that bumps `dex_version` and `dex_commit`
  together, after reading the upstream release notes. CI's `dex-signin` job
  builds the new commit and signs in against it before it reaches a VM.
- The first build on a VM needs GitHub and the Go module proxy, and about a
  gigabyte of disk while it runs. The role clears Dex's build cache after a
  successful build.
- Losing the users file loses nothing on the VM: it can be rebuilt from the
  rendered Dex configuration while the VM exists, and a lost `userId` can be
  carried over again by email.
- Signing out of Portikus does not end a Dex session, because Dex's password
  login keeps none; the next sign-in asks for the password again.
