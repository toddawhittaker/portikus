# 0028. Dex accounts in PostgreSQL, managed from the admin area, and a setup code for the first administrator

- **Status**: Accepted; the first-administrator part (the setup code and
  the first-account form) is superseded by ADR 0031
- **Date**: 2026-09-24
- **References**: SPEC.md sections 5, 20.1 and 24.11; docs/EPIC-14.md
  rulings 15 to 24; ADR 0023 (partly superseded); ADR 0026

## Context

ADR 0023 put Dex's accounts in a users file on the operator's workstation,
rendered into Dex's configuration as static passwords, with Dex's storage
in memory. A site with no institutional provider needs an administrator to
add people, reset passwords and remove people from the browser. Dex's gRPC
API does that, but it writes to Dex's storage, and static passwords cannot
be changed through it.

A new site also needs its first administrator. Under Google or Dex nobody
has an administrator role from the provider, and "the first person to sign
in becomes administrator" hands the site to whoever finds it first.

## Decision

Dex keeps its storage in its own PostgreSQL database, `dex`, on the
existing server, and serves its gRPC API on loopback with mutual TLS. The
API alone holds the client certificate. The Users view adds, resets and
removes Dex passwords through it; Portikus generates each password, shows
it once, and hands Dex only its bcrypt hash. An added person's Portikus
account is created at the same time under the subject Dex will give them,
so a chosen role is a `granted_role` from the start. The users file is
imported once, keeping every user ID so every subject stays the same, and
then retired.

The first administrator comes from a one-time code that a root command on
the host prints: 80 random bits, stored only as a hash, single use, valid
for an hour. A signed-in SSO account enters it on `/setup` and receives
`granted_role = 'administrator'`. Under standalone Dex, where nobody can
sign in yet, `/setup` also creates the first account, while no
administrator exists.

## Consequences

- Passwords change from the browser; `make users-*` goes away, and the
  nightly database dump now carries Dex's accounts.
- Anyone who can read the API's client key can manage Dex passwords;
  that key is `root:portikus`, mode 0640, like the API's other secrets.
- Root on the host can always make a new administrator, which is also the
  recovery path when every administrator is gone.
- Rejected: SQLite storage (a second backup path); writing Dex's tables
  directly (an undocumented schema); gRPC without mutual TLS (any local
  process could reset an administrator's password); "first sign-in wins".
