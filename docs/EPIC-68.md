# Epic 68: operation catalog, API keys and the MCP server

Branch `epic/68-catalog-keys-mcp`, base commit `3daf0ed5`. Scope and
exclusions: `docs/EPIC-68-HANDOFF.md`. Rulings behind it:
`docs/EPIC-AI-PREPLAN.md`, section 9. This file goes away at the fold.

## Rulings that apply

- Pre-plan rulings 1, 4 and 6: three epics, this is the first;
  administrators and instructors only, students refused; keys are
  read-only by default and destructive operations need a destructive
  scope.
- MCP software development kit: version 2 (Todd, 2026-11-15).
  `@modelcontextprotocol/server` 2.4.0 with its `createMcpHandler`,
  mounted on the existing API through a small bridge of our own (about 30
  lines) to `handler.fetch`. Not `@modelcontextprotocol/node`, which
  needs the raw request body Fastify has already read, and not
  `@modelcontextprotocol/fastify`, which builds a separate app.
- Sign-in for `/mcp` is a fixed API key in the `Authorization` header.
  The MCP specification makes OAuth optional; Claude Code and Codex both
  accept a fixed bearer header and do not start OAuth when it is set.
  `/mcp` answers a bad key with 401 and `WWW-Authenticate: Bearer` with no
  `resource_metadata`, and serves no `/.well-known/oauth-*` document.
- Decisions D1 to D5: see below.

## Design (architect pass, 2026-11-15)

- **Catalog.** Central, under `apps/api/src/catalog/`, one file per route
  family, keyed by `"METHOD url"` like `security/route-policy.ts`. No
  route file changes. Each record: name, one-sentence description, risk
  (read, change, destructive), audience (administrator, instructor or
  both), whether it is a named MCP tool, and its Zod input schemas. Routes
  validate input by hand with `parseOr400`, so the catalog names the
  schemas itself; a parity test catches drift.
- **Coverage.** 102 exposed operations; every other route is on the
  not-exposed list with a reason. The pre-plan's "never" list (root shell,
  key management, second-factor and password changes, account linking,
  any answer or field carrying a secret) is marked and tested. Owner
  workspace routes (files, terminals, projects) are not exposed, so file
  contents and terminal bytes never leave.
- **OpenAPI.** Built by hand from the catalog with Zod 4's own
  `z.toJSONSchema`, served at `GET /openapi.json`. No new dependency.
  Closes #1221, "Generate an OpenAPI document from the Zod contracts".
- **Keys on the HTTP API.** The auth plugin reads
  `Authorization: Bearer portikus_…`, looks up its SHA-256 hash, and sets
  the user. A scope gate refuses unexposed routes (403
  `NOT_AVAILABLE_TO_API_KEYS`) and routes above the key's scope (403
  `SCOPE_REQUIRED`). Keys skip the second factor at use; creation needs one
  for Dex local accounts (D2). Disabling a person or resetting their password or
  second factor revokes their keys.
- **In-process calls.** `app.inject` with the caller's own key, the real
  client address, and a path built only from the catalog's pattern. The
  route's own validation, role and course checks and audit run unchanged.
  No internal identity hook is needed.
- **MCP.** 38 named tools plus `find_operation` and `run_operation`. A
  fresh server per request lists only what the key's owner and scope
  allow. Results are compact JSON, capped at about 50,000 characters.
- **Tables.** Migration 0058 `api_keys` (hash, display prefix, scope as
  one ordered level, expiry, renewal period, last used, revoked, and
  the last expiry reminder sent). Migration 0059
  adds `via` and `api_key_id` to `audit_events`, filled from a
  request-scoped context so none of the 101 audit call sites change.
- **Rate limit.** 300 requests a minute per key; unknown keys count
  against the existing anonymous limit (SPEC.md section 24.13).
- **Decision records.** 0077 catalog and OpenAPI, 0078 API keys, 0079 MCP
  server.

## Tasks

Machines: **local** is linux-dev (this orchestrator), **desk** is
Todd-Desktop-2, **pve** is pve1-dev. Remote tasks run in their own
worktree on that machine and report back by `t3_thread_send`. Test runs
for verification are spread the same way: each task's own checks run
where it was built, and the epic's full `make check` and `pnpm test:e2e`
run split across all three.

| ID | Agent, model | Machine | Owns | Starts after | Size |
|---|---|---|---|---|---|
| T1 | builder, Sonnet high | local | `apps/api/src/catalog/{types,index,not-exposed,openapi}.ts`, `catalog.test.ts`, `openapi.test.ts`; stub family files with `pending` lists | none | M |
| T2a | builder, Sonnet high | desk | Migrations 0058 and 0059 with tests (0058 grants the worker read access to `api_keys` and update access to its reminder column), `migrations/index.ts`, `packages/db/src/{schema,index,audit-context}.ts`, `packages/auth/src/{api-keys,plugin,index,second-factor}.ts` with tests, `packages/contracts/src/{api-keys,index,admin}.ts` | none | M |
| T2c | builder, Sonnet high | pve (after T7) | `apps/worker/src/api-key-reminders.ts` with tests, and its line in `apps/worker/src/index.ts`: the daily expiry reminder | T2a | S |
| T7 | infra, Sonnet | pve | `Caddyfile.j2`: add `/mcp` and `/openapi.json` to the API routes; verified on this host | none | XS |
| T2b | builder, Opus | local | `routes/api-keys.ts`, `api-keys/gate.ts`, `sessions/step-up.ts` (extracted from `routes/links.ts`), `audit-arrival.ts`; edits to `links.ts`, `rate-limit.ts`, `admin-audit.ts`, `admin-invitations.ts`, `admin.ts`, `admin-dex-users.ts`; renew, renew with a new secret, owner revoke, and the administrator expire and revoke actions (one key, one person, every key); first owner of `server.ts`, `route-policy.ts`, `authz-matrix.test.ts` | T1, T2a | L |
| T3a | builder, Sonnet high | pve | `catalog/families/people.ts` (29 operations) | T1 | M |
| T3b | builder, Sonnet high | desk | `catalog/families/workspaces.ts` (20) | T1 | S |
| T3c | builder, Sonnet high | pve (after T3a) | `catalog/families/site.ts` (39) | T1 | M |
| T3d | builder, Sonnet high | desk (after T3b) | `catalog/families/courses.ts` (14) | T1 | S |
| T4 | builder, Opus | local | `apps/api/src/mcp/`, `catalog/run.ts`, `routes/mcp.ts`, `routes/openapi.ts`, `apps/api/package.json`, `pnpm-lock.yaml`; then `server.ts`, `route-policy.ts`, `authz-matrix.test.ts` | T2b | M-L |
| T6 | ui-designer, then a11y-reviewer | desk | `apps/web/src/settings/{ApiKeysPane.tsx,sections.ts,SettingsDialog.tsx}`, `apps/web/src/admin/api-keys/` (including expire and revoke for one key, one person and every key), `admin/tabs.ts`, Renew and Renew with a new secret on the owner's page, the `via` column in `admin/audit/AuditTab.tsx`, three Playwright specs (dark mode first) | T2b | M |
| T5 | tester, Opus | pve | `security/catalog-parity.test.ts` (every exposed operation as an administrator key, an instructor key on its own and another's course, and a read key, compared with the browser answer; every unexposed route gives 403 to a key); `testing/matrix-samples.ts`; removes `pending` and the new-route allowance | T3a-d, T4 | M |
| T8 | security-reviewer, Opus | local | Read-only review of the key path, gate, runner and `/mcp` | T4, T6 | S |
| T9 | builder, Sonnet | desk | `docs/SPEC.md` (new section; 24.1, 24.8, 24.11, 24.13, 27, 29), `docs/STACK.md`, ADRs 0077-0079, `ADMIN-GUIDE.md`, `INSTRUCTOR-GUIDE.md` | T4; lands after T8's fixes | M |

Files shared in sequence, never at once: `server.ts` (T2b then T4);
`route-policy.ts` and `authz-matrix.test.ts` (T2b, T4, T5); T1's catalog
test and not-exposed list (T1, T5); each family stub (T1, then its T3
task). No task edits `docs/STATUS.md`.

Waves, for reading only: T1, T2a, T7 start at once; T2c when T2a lands. T3a-d start when T1
lands; T2b when T1 and T2a land. T4 and T6 start when T2b lands. T5 and
T8 follow T4. T9 runs alongside T5 and T8.

## Decisions (Todd, 2026-11-15)

- **D1. Key owners.** Any administrator or instructor may hold a key,
  whatever the source of their role. A role removed at the sign-in
  provider or the LMS leaves that person's keys working until they
  expire or are revoked. SPEC.md section 24.13 and the admin guide say
  so plainly.
- **D2. Creation check.** Dex local-password accounts prove a code or a
  passkey in the create dialog. SSO and course-launch sessions create
  keys with no extra check.
- **D3. Invitations.** A write key may invite students. Inviting an
  instructor or an administrator needs a destructive key (a check in
  `admin-invitations.ts`, owned by T2b, with a test).
- **D4. Audit.** Every request made with a key writes one `api_key.used`
  row with the operation name and result, reads included.
- **D5. Expiry, renewal and revocation (replaces the first D5).** A key
  is in one of three states:

  | State | Works? | Can be renewed? | How a key gets there |
  |---|---|---|---|
  | Active | Yes | Yes, to extend it | Created or renewed |
  | Expired | No | Yes, by its owner while signed in | Its expiry passed, or an administrator expired it |
  | Revoked | No | Never | Its owner or an administrator revoked it, or its owner was disabled or had a password or second-factor reset |

  - **Periods.** SSO and course-launch accounts get 30-day keys only.
    Dex local-password accounts choose 7, 30 or 90 days or "never",
    default 30. The period is stored with the key.
  - **Renew** restarts the key's own period from that moment and keeps
    the same secret, so client configuration does not change. It needs
    a signed-in session that still holds a staff role, so each renewal
    re-checks the role with the provider. There is no time limit on
    renewing an expired key. The renew screen shows the key's prefix and
    when it was last used, and offers **Renew with a new secret** beside
    plain Renew for a key that may have leaked. Each renewal is audited.
  - **Reminder.** A daily worker job sends an in-app notification seven
    days before a key expires (one day before for 7-day keys), once per
    expiry. Expiring a key early also notifies its owner.
  - **Administrators** can expire or revoke one key, all of one
    person's keys, or every key on the site. Owners can revoke their own
    keys. Revoked keys can never be renewed.
  - Why renewable expiry: an instructor who teaches in one semester and
    again months later only signs in and clicks Renew. A person removed
    at the provider cannot sign in, so cannot renew, and their key stops
    within 30 days. Prior art differs: GitHub and Azure DevOps
    "regenerate" an expired token with a new secret; Okta extends a
    token's 30 days on every use; Kerberos renews a ticket only while it
    is still valid. Renewing the same secret after expiry is our choice
    for client convenience, with "new secret" as the leak escape hatch.

## Rehearsal and verification

1. `make check` and `pnpm test:e2e` green with a fresh test database,
   split across the three machines.
2. Security review (T8) fixed before the epic pull request.
3. On the pilot: connect Claude Code to `/mcp` with a read key and a
   write key, and Codex with a read key; record what worked. Check a
   student cannot create a key, a read key cannot stop a workspace, and
   an instructor key cannot see another instructor's course. Expire a
   key as an administrator, confirm it stops, renew it as its owner and
   confirm the same key works again; revoke it and confirm Renew is
   refused.

## Left out

- Marking audit rows as made by the assistant, and forwarding a session
  cookie through the runner: the next epic.
- MCP resources and prompts, and OAuth for MCP: later.
- Browser-only routes in the OpenAPI document.
