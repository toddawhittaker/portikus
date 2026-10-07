# 0054. Breached passwords are checked against an offline list from SecLists

- **Status**: Accepted (Epic 36)
- **Date**: 2026-10-06
- **References**: SPEC.md section 24.13; ADR 0048

## Context

SPEC.md section 24.13 refuses a new Dex password that appears in a
breached-password list. Today the list is a few hand-written entries,
which stops almost nothing. An online check (such as a range query to a
breach service) would send part of a password hash off the site at
every change and fail when that service is down.

## Decision

1. **Source.** The SecLists list
   `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`,
   pinned by SecLists commit and sha256, plus the existing hand-written
   entries. Todd approved its MIT licence on 2026-10-05; the notice ships
   beside the list.
2. **Filter.** Lower-cased, at least 15 characters (the minimum password
   length), sorted and de-duplicated. That leaves about 10,900 lines,
   about 192 KB, all ASCII. Shorter entries can never be chosen, so
   keeping them would only cost space.
3. **Shipping.** A generator script writes
   `packages/auth/data/breached-passwords.txt`, which is committed and
   shipped in the package. The auth library reads it once at start into
   a set. The check's signature does not change.
4. **No network.** Nothing about a password leaves the host.

## Consequences

- The check now refuses common long passwords, not just a handful.
- Refreshing the list is a deliberate change: bump the pin and rerun
  the generator.
- A plain text file is enough at this size. A Bloom filter only pays
  off for millions of entries.
- Passwords breached after the pinned snapshot are not caught. That is
  accepted in exchange for no outside dependency.
