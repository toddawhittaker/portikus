# 0067. Code help chosen per language

- **Status**: Accepted (Epic 53)
- **Date**: 2026-10-22
- **References**: SPEC.md sections 13.6, 20.1, 24.1, 24.11, 25.2 and 26; ADR 0065; ADR 0066; docs/CAPACITY.md

## Context

Epic 52 gave code help one site switch. It is a poor fit for a small server:
Python's servers cost about 185 MiB per student and TypeScript's about 57 MiB,
so an administrator may want one language and not the other. More languages
are planned, each with its own memory cost. The Settings page also needs to
show the cost before the administrator ticks a box.

## Decision

1. **The column stores the enabled set.** `settings.code_help_languages` is a
   text array that replaces the boolean `code_help_enabled` (migration 0051).
   A site with code help off becomes the empty set, and one with it on becomes
   `{python,typescript}`. A language added later is off on every existing site
   until an administrator ticks it, so an upgrade never adds memory use to a
   server that is already full. A set of the languages that are off would do
   the opposite, and a second boolean per language would need a migration for
   each new language. The column has no check constraint, as with
   `egress_presets`, so a new language needs no migration either.
2. **Language ids are not server ids.** The ids are `python` and `typescript`;
   `typescript` covers JavaScript. `CODE_HELP_LANGUAGE_OF_SERVER` in
   `packages/contracts` maps every server id to its language and is typed over
   all of them, so a server added without a language does not compile. Python
   and Ruff follow one box.
3. **Only the API refuses.** The relay reads the set fresh on each connect and
   closes with DISABLED (4416) when the server's language is off, before it
   dials the agent. The agent is not taught the set. It is a resource control,
   not a boundary: a student can still start a language server by hand
   (ADR 0065). The agent would only add a second copy of the set to keep in
   step. A failed read closes with a server error, so a database fault never
   opens a socket that should be refused.
4. **Strict on write, lenient on read.** The write request validates each id
   against the enum, so the API answers 400 for an id it does not ship, for a
   duplicate and for a non-array. The answers use plain strings, and readers
   drop ids they do not know, so a tab that still runs older JavaScript, or a
   stored id from a later build, still parses and cannot turn on a server that
   does not exist. The set is stored in the contract's order, and an equal set
   writes no audit row.
5. **Languages not shipped are shown, not ticked.** HTML, CSS and JSON, Java,
   C and C++ and SQL appear as "Coming later" rows with no contract id, so the
   server refuses them too. Each gets an id once its server is installed and
   measured.
6. **The estimate is a worst case, labelled "at most".** The page reads the
   server's memory from the Health data and shows memory per student and
   students per server for a Traditional and an Agentic course. It assumes
   every student opens every ticked language and counts memory only, not CPU,
   and it caps nothing. The headline reads "Code help adds at most N MiB per
   student, if every student opens every ticked language." The constants are in
   the web app, not the contracts, and a unit test keeps them equal to the table
   "Estimate on the Settings page" in docs/CAPACITY.md. Without the server's
   memory the page says so and shows no student count.

## Consequences

- An administrator can run Python's servers and not TypeScript's, or the other
  way round, and sees the cost first.
- Turning a language off does not close sockets already open. They end when
  they close for another reason, and the next connect is refused.
- A site upgraded from Epic 52 keeps its choice: off stays off, on stays on for
  both languages.
- The estimate can differ from a real class, because the load test used a
  stand-in coding agent and a real one can use more.
- Rejected: a per-language boolean column (a migration for every language),
  storing the languages that are off (a new language would turn itself on),
  teaching the agent the set (a second place to keep correct, for a control
  that is not a boundary), and a student-count cap (the page advises and does
  not stop anyone).
