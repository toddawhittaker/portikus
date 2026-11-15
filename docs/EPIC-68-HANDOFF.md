# Epic 68 handoff: operation catalog, API keys and the MCP server

Written 2026-11-15 for the agent that takes this over. You are the
orchestrator (CLAUDE.md, "How work gets done here"). Follow the
`epic-run` skill. This file and `docs/EPIC-AI-PREPLAN.md` go away at the
fold; see "At the fold" below.

## Where things stand

- Branch `epic/68-catalog-keys-mcp`, local only, not pushed. It is
  `origin/main` (`85d84f03`) plus one commit that adds
  `docs/EPIC-AI-PREPLAN.md`, plus this file.
- No code is written. No milestone, issues or task branches exist yet.
- Todd has not said go on building. Your first deliverable is a plan
  for him to approve, not code.

## Read first, in this order

1. `docs/EPIC-AI-PREPLAN.md`, all of it. Section 9 holds Todd's nine
   rulings. They are settled; do not reopen them or ask them again.
2. `docs/OVERVIEW.md`, then SPEC.md sections 5, 20.3, 24.1, 24.8, 24.11
   and 27, STACK.md sections 13 and 15, and ADRs 0003, 0012, 0051.
3. The `epic-run` skill and WORKFLOW.md, "Epic plans".

## What the whole effort is

Three epics (ruling 1). This handoff covers only the first.

- **Epic 68 (this one):** the operation catalog and the OpenAPI
  document, Portikus API keys, and the Model Context Protocol (MCP)
  server. Features F1, F3, F4 and X1 in the pre-plan.
- **Next epic:** AI settings, model pricing (issue #2018), the
  assistant on the Vercel AI SDK, Diagnose buttons, the instructor
  panel.
- **Later epic:** optional work listed in the pre-plan, section 8.

## What Epic 68 must deliver

1. **Operation catalog.** Every HTTP route in `apps/api/src/routes/`
   either has a catalog record (stable name, one-sentence description,
   risk level: read, change or destructive) or is on an explicit "not
   exposed" list. A test fails when a route is in neither. The "never"
   list is fixed by the pre-plan, section 6: the root shell, creating
   API keys, second-factor changes, impersonation, any secret field.
2. **OpenAPI document** generated from the catalog and the Zod
   contracts. This pays off ADR 0003 and SPEC.md section 27.
3. **A way to run an operation in process as a given person**, so that
   validation, the route policy and the audit row run exactly as for a
   browser request. The pre-plan proposes Fastify's `app.inject`.
4. **API keys** for administrators and instructors (ruling 4): created
   from a signed-in session with a fresh second factor, shown once,
   stored as a SHA-256 hash, with scopes (read by default, write, and a
   separate destructive scope, ruling 6), an expiry and a last-used
   time. A page to create, list and revoke them. The student role is
   refused, and a test pins that.
5. **MCP server** at `/mcp` on the API, using
   `@modelcontextprotocol/sdk`, authenticated by an API key. It lists
   only the tools the key's owner and scope allow. About 30 to 40 named
   tools plus `find_operation` and `run_operation` for the rest, unless
   the architect finds a better split.
6. **Audit.** Every call records how it arrived: session or API key id.
7. **Documents.** SPEC.md, STACK.md, the admin and instructor guides,
   and decision records for the catalog, API keys and the MCP server.

## What Epic 68 must not include

- Any call to an AI model, any AI key or settings page, the assistant,
  or the Vercel AI SDK. Those belong to the next epic.
- Model pricing (issue #2018).
- OAuth sign-in for MCP. API keys only.
- Any change to the student chat (`apps/web/src/chat/`,
  `apps/workspace-agent/src/chat/`).

## Steps

1. **Verify the open facts** that touch this epic (pre-plan, section
   10). Use an explorer or a short spike, not guesses:
   - Can `app.inject` carry the caller's identity, given that sessions
     are read from a cookie in `packages/auth/src/plugin.ts`? If not,
     what small internal hook is needed?
   - What does the MCP specification currently require for sign-in on a
     remote server, and do Claude Code and Codex both accept a static
     bearer key in a header?
   - Which transport does `@modelcontextprotocol/sdk` 1.32.2 offer that
     mounts on Fastify 5 without adding Express?
2. **Architect pass** (read-only agent). Ask for: the catalog's shape
   and where route metadata lives; a risk level for every route; the
   named-tool list; the API key tables and scope model; how instructor
   keys are limited to their own courses; which files each parallel
   task owns; and migration numbers assigned up front.
3. **Write `docs/EPIC-68.md`** on this branch: rulings that apply, the
   task table with file ownership, estimates, and the rehearsal steps.
4. **Stop and report the plan to Todd.** Wait for his go before
   creating the milestone, issues or any builder.
5. After his go, run the epic by the `epic-run` skill.

## Things that will bite

- **Sixty-seven route files.** Adding metadata touches all of them.
  Split builders by route family so no two edit the same file, and give
  the shared catalog file to the first task alone.
- **Authorization parity is the security claim.** Test each operation
  through the catalog as each role and expect the same answer as the
  HTTP route. Include instructor keys against other people's courses.
- **A compromised API already equals root** through the root shell
  (SPEC.md section 24.1). Run the security-reviewer on the key path,
  the in-process call and the MCP endpoint before the epic pull
  request, not after.
- **API keys skip the second factor at use.** That is why creation
  needs a fresh one and why keys default to read-only with an expiry.
- **Tool results carry text written by students** (project names, log
  lines). In this epic that text goes only to the caller's own AI tool,
  but keep results compact and never include secrets, file contents or
  terminal bytes.
- **Rate limits.** API key requests need a limit of their own;
  check SPEC.md section 24.13 for the existing sign-in limits.
- Parallel task pull requests must not edit `docs/STATUS.md`.

## How it is verified

- `make check` and `pnpm test:e2e` green with a fresh test database.
  The API keys page ships Playwright tests, dark mode first.
- On the pilot (it is Todd's development server): connect a real
  Claude Code to `/mcp` with a read-only key and with a write key, and
  record what worked. Check that a student account cannot create a key.

## At the fold

The pre-plan covers two more epics, so it must not simply be deleted.
Before the fold deletes `docs/EPIC-68.md`, this file and the pre-plan:

- Put the lasting rules into SPEC.md and the "why" into decision
  records, as WORKFLOW.md says.
- File the next epic and the later features as GitHub issues, and copy
  the rulings that govern them (2, 3, 5, 7, 8, 9) and the checked facts
  from the pre-plan's section 4 into the issue for the next epic.

## Report format

Plain, brief English. Lead with what was done or found. For each
decision that needs Todd, give the real options with what each gains
and costs, recommend one, and ask one decision at a time. Read back
issue and pull request numbers with their titles.
