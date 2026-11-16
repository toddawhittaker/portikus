# Epic 69: built-in AI

Branch `epic/69-builtin-ai`, base commit `787755a7` (main after Epic 68).
Scope, rulings and checked facts: GitHub issue #2068. Pricing: #2018.
This file goes away at the fold.

## Rulings that apply

- Todd's rulings 2, 3, 5, 7, 8 and 9 in #2068, word for word, settled.
  Rulings 1, 4 and 6 are in SPEC.md section 20.4.
- Decisions D1 to D5 below.

## Facts checked before the plan (2026-11-15)

- Versions: `ai` 7.0.173, `@ai-sdk/openai-compatible` 3.0.92,
  `@ai-sdk/anthropic` 4.0.105; Apache-2.0; Node 22 or later; Zod 4.6.7
  fits.
- A small spike streamed text, a tool call, a tool result and an
  approval request through the AI SDK's test model. Every part maps onto
  the chat events in `packages/contracts/src/chat.ts`, except: streaming
  tool arguments and reasoning (dropped), and usage (no event; stored,
  not streamed). An approval is stateless: the call ends, and the answer
  goes in on the next call, so a restart loses nothing.
- `ai` ships Vercel's gateway code but uses it only for a model named by
  a plain string. The Anthropic adapter falls back to the
  `ANTHROPIC_API_KEY` environment variable. So our module builds model
  objects only and always passes the key and base address; tests pin
  both.
- The API and worker reach the outside only through the server's own
  Squid proxy (ADR 0027), port 443 to listed host names. Hosted providers
  need an entry in the proxy host list. A model on the institution's own
  network cannot be reached (D1).
- No institution model key setting exists; `launcher-env.ts` only reads
  the environment, and nothing sets it.
- Audit rows allow only `via` = `session` or `api_key` (migration 0059).

## Design (architect pass, 2026-11-15)

- **Acting as the caller.** The in-process runner (`catalog/run.ts`)
  takes either an API key or the caller's session token. For a session it
  sends the session cookie and `sec-fetch-site: same-origin` through
  `app.inject`, so the route's own role, course, second-factor and
  acceptable-use checks and audit run unchanged, looked up fresh on every
  call. The session used is the one on the socket that sent the message
  or the approval. No internal identity and no minted keys. Audit rows
  get `via = assistant` (migration 0060) from a per-call context the
  runner sets; each tool call also writes one `assistant.used` row, like
  `api_key.used`, naming no conversation.
- **The model module.** `apps/api/src/ai/model.ts` is the only file that
  imports `ai` or `@ai-sdk/*`; a Biome `noRestrictedImports` rule enforces
  it. Its interface is one streamed step: system prompt, messages, tools
  (JSON Schema) in; text, tool calls and a usage total out; plus
  `listModels()`. Our own loop decides what runs and when to ask a
  person, so we use a small part of the SDK. Its `fetch` is the proxy-aware
  `createOutboundFetch`.
- **The loop.** `apps/api/src/assistant/`. Read operations run at once;
  change and destructive ones stop at an approval card. Tools come from
  the catalog filtered by the caller's role (`mayRun`), plus
  assistant-only tools: `run_batch` (A4), `guide_search` and `guide_read`
  (A5). Tool input is checked with the operation's Zod schema before it
  runs. A conversation has a token budget, and the site has a monthly
  cap, both counted in code from each reply's usage.
- **Cards.** Drawn by code from the catalog entry and the inputs: the
  operation's description as the title, a table of inputs, the risk, and
  Approve or Deny only (no "always allow"). A destructive card asks the
  person to type the operation's name (for a batch, the row count); the
  server checks it. A denial reaches the model as a refused result.
- **Storage.** PostgreSQL only, never logs. Conversations are stored as
  our own event log (the wire events), never as the SDK's message format,
  which changes each major version. Every query filters on the owner; no
  administrator route reads another person's conversations. Deleted 30
  days after last use. A pending approval is a row, claimed once with
  `update … where status = 'pending'`, so it survives a restart and two
  tabs cannot run it twice.
- **The AI key.** Sealed in the database with the existing `sealSecret`
  helper, under its own key derived from `SECOND_FACTOR_KEY`. Write-only:
  the page shows the last four characters. Separate from any key handed
  to students (ruling 5).
- **Transport.** A WebSocket per conversation, like the student chat.
  Keys already cannot open WebSockets, so the assistant is session-only.
- **Browser.** The panel reuses `createChatStore`, `receiveChatEvent`,
  `openChatSocket`, `MessageList` and `ToolBlock` from `apps/web/src/chat/`
  as they are, with its own thin composer and a new `ApprovalCard`. No
  shared package yet (#2068).
- **Pricing (A1).** A fixed pipeline: fetch each address in an
  administrator-editable list through the proxy, turn the page into text,
  one model call whose only tool is `submit_rows`, check with Zod, retry
  once, store as proposals the administrator accepts or rejects row by
  row. No Portikus tools in that call; the model never picks an address.
  Weekly check on a timer. The student restart estimate reads the table,
  with today's built-in numbers as the fallback.
- **Diagnose (A3).** Opens a read-only conversation with its target
  (health, a workspace, a job, an alert). A fixed list of read operations
  runs first, as the person, shown as ordinary tool blocks; then the
  model reports a likely cause with the evidence.
- **Guides (A5).** The build copies ADMIN-GUIDE, OPERATIONS and INSTALL
  into the package; the guide tools search and read by heading, and the
  model cites "ADMIN-GUIDE.md § heading". No embeddings.
- **Instructors (I0, I1).** The same panel on the course page, tools
  limited to what an instructor may run. "Who is stuck?" is a new read
  operation `courses.stuck` (check failure streaks, live help requests,
  agent use over 7 days), useful as a table without AI too. A matrix test
  runs every operation through the assistant and through plain HTTP for
  each role and expects the same answer; a student gets 403 on every
  assistant route and socket.
- **Fakes.** Unit tests replay scripted steps through a fake model
  client. Playwright runs a small fake OpenAI-compatible server
  (`e2e/fake-model-server.mjs`). CI never calls a real model.

## Tasks

Machines: **local** is linux-dev (this orchestrator), **desk** is
Todd-Desktop-2, **pve** is pve1-dev. The column is the first choice; load
is measured again before each task starts (Foreman builds on all three).
Remote tasks run in their own worktree and report back by
`t3_thread_send`. Hours are rough agent time, not wall-clock.

| ID | What | Agent, model | Machine | Owns | Starts after | Size, hours |
|---|---|---|---|---|---|---|
| T1 | Data model | builder, Sonnet high | desk | Migrations 0060 (`via` allows `assistant`), 0061 `ai_settings`, 0062 conversations, events and approvals, 0063 `ai_usage_days`, 0064 prices, runs and proposals, with tests; `migrations/index.ts`; `packages/db/src/schema.ts` | none | M, 2 |
| T2 | Contracts | builder, Sonnet high | local | `packages/contracts/src/{assistant,ai,pricing}.ts` (new), `chat.ts` (export the event shapes; optional `risk` and `confirmText` on cards, `confirmation` on answers), `index.ts` | none | S, 1 |
| T3 | Model module | builder, Opus medium | pve | `apps/api/src/ai/{model,fake-model}.ts` with tests, `biome.json` import rule, `apps/api/package.json`, `pnpm-lock.yaml` | none | M, 2 |
| T4 | Fake model server | builder, Sonnet high | local | `e2e/fake-model-server.mjs`, `playwright.config.ts` | none | S, 1 |
| T5 | Runner as the caller, `via assistant` | builder, Opus low | desk | `catalog/run.ts`, `run.test.ts`, `packages/auth/src/plugin.ts`, `packages/db/src/audit-context.ts`. First test proves the per-call context survives `app.inject`; if not, fall back to a per-process header the hook checks and strips | T1 | S, 1.5 |
| T6 | AI settings API (F2) | builder, Sonnet high | pve | `routes/admin-ai.ts`, `ai-key` helper beside `secondFactorKey` in `second-factor.ts`, base-address checks, the "test" round trip (one real tool call), the privacy-notice acceptance, the proxy host offer (D5); first owner of `server.ts`, `route-policy.ts`, `catalog/not-exposed.ts` | T1, T2, T3 | M, 2 |
| T7 | Assistant core (F5) | builder, Opus medium | desk | `apps/api/src/assistant/{loop,tools,cards,store,hub,budget,retention}.ts` with tests, `routes/assistant.ts`; then `server.ts`, `route-policy.ts`, `not-exposed.ts` | T5, T6 | L, 4 |
| T8 | AI settings page (F2) | ui-designer, Opus low | pve | `apps/web/src/admin/ai/`, its line in `admin/tabs.ts` and the nav, Playwright spec | T6 | M, 2 |
| T9 | Pricing API (A1) | builder, Opus low | local | `apps/api/src/pricing/`, `routes/admin-pricing.ts`, public `GET /pricing`, weekly timer, the proxy host offer for sources (D5); then `server.ts`, `route-policy.ts`, `not-exposed.ts` | T6; PR after T7 (shared lists) | M, 2.5 |
| T10 | Assistant panel (F6) | ui-designer, Opus medium | pve | `apps/web/src/assistant/{AssistantPanel,AssistantComposer,ApprovalCard,useAssistant}.tsx`, its mount in `AdminPage.tsx`, Playwright spec on the fake model server | T2, T4; PR after T7 | M, 3 |
| T11 | Administration and bulk preview (A2, A4) | builder, Sonnet high | desk | `assistant/batch.ts`, its tool in `tools.ts`, the batch table in `ApprovalCard.tsx`, scripted e2e for invite 30, stop, restart, backup, egress | T7, T10 | S, 1.5 |
| T12 | Pricing page and student estimate (A1) | ui-designer, Opus low | local | `apps/web/src/admin/pricing/`, its tab line, `apps/web/src/chat/restartEstimate.ts`, Playwright spec | T9, T8 (tab file) | M, 2 |
| T13 | Usage in the Agents tab | builder, Sonnet high | pve | `apps/web/src/admin/agent-usage/`, its usage route | T7 | S, 1 |
| T14 | Diagnose and guides (A3, A5) | builder, Sonnet high | desk | `assistant/{diagnose,guides}.ts`, their tools in `tools.ts`, buttons in `health/HealthTab.tsx`, `WorkspaceDetail.tsx`, `site-job.tsx`, the alerts list; guide copy in `scripts/build-deb.sh` and `packaging/nfpm.yaml`; Playwright spec | T11 (`tools.ts`) | M, 2.5 |
| T15 | Instructor panel, "Who is stuck?" (I0, I1) | builder, Opus low | pve | `routes/course-stuck.ts`, `catalog/families/courses.ts`, panel mount in `course/CoursePage.tsx`, `assistant/authorization.test.ts` (every role, assistant versus HTTP; students refused everywhere); then `route-policy.ts`, `not-exposed.ts`; Playwright spec | T14, T9 (shared lists) | M, 2.5 |
| T17 | Docs | builder, Sonnet high | local | SPEC.md new section 20.5 plus 24.1, 24.8, 24.11, 29; STACK.md (the AI SDK and why; section 15 conversation storage); ADR 0080 built-in AI and its harness; ADR 0081 storing assistant conversations; ADMIN-GUIDE (key, notice, tested models), INSTALL; comment on #2018 | T7; lands after the security fixes | M, 2 |
| R1 | Code review, early pass | code-reviewer, Opus | local | read-only, epic head | T7, T9 | |
| R2 | Security review | security-reviewer, Opus high | local | read-only: runner, cards, approvals, storage, key, base-address checks, not-exposed list | T11, T15 | |
| R3 | Accessibility review | a11y-reviewer, Opus | local | read-only: T8, T10, T12, T14, T15 | T15 | |
| FR | Fix rounds | as found | any | per finding | reviews | |
| T18 | Fold | builder, Sonnet high | local | STATUS entry and open items, SPEC section 29, delete this file, `Fixes #2068` and `#2018` | last fix | S, 0.5 |

Shared files, edited in this order and never at once: `server.ts`,
`route-policy.ts` and `catalog/not-exposed.ts` (T6, T7, T9, T15);
`assistant/tools.ts` (T7, T11, T14); `ApprovalCard.tsx` (T10, T11);
`admin/tabs.ts` (T8, T12). No task edits `docs/STATUS.md`.

Waves, for reading only:
1. T1, T2, T3, T4 at once.
2. T5 when T1 lands; T6 when T1, T2, T3 land; T10 starts building when
   T2 and T4 land.
3. T7 when T5 and T6 land; T8 when T6 lands.
4. T9 builds from T6 and opens its PR after T7; T13 and T11 when T7
   lands (T11 also after T10); T17 drafts.
5. T12, T14, then T15. R1 after T7 and T9; R2 and R3 at the end.

Total agent time is about 34 hours, spread over three machines; expect
about a day and a half of wall-clock, as Epic 68 took.

## Rehearsal and verification

1. `make check` and `pnpm test:e2e` green with a fresh test database,
   split across the three machines.
2. Rehearsal VM full install test (`make install-test`, with the Dex
   sign-in) **before** the epic pull request, because the package changes
   (guides copied in, new migrations). CI never installs the package.
3. Security review fixed before the epic pull request.
4. Pilot, after Todd's go (it costs real money): about 30 scripted tasks,
   once with a current OpenAI model and once with a Claude model through
   the Anthropic adapter (ruling 9). Record what worked in the admin
   guide's tested-models list.

## Decisions (Todd, 2026-11-15)

- **D1. Hosted providers only.** A model on the institution's own
  network is not reachable in this epic: the API's sandbox, the proxy's
  private-range refusal and its refusal of plain-HTTP requests all stop
  it. The admin guide says a self-hosted model is not reachable yet
  (replacing ruling 9's "should work and is unproven"), and an issue
  tracks it. Hosted OpenAI-compatible services work.
- **D2. Backups keep conversations.** Database dumps include the
  conversation tables. The admin guide says backups hold conversations
  until each dump expires. No infra change.
- **D3. Default limits.** 5,000,000 tokens a month for the site and
  200,000 per conversation, both editable on the settings page.
- **D4. Timers in the API.** The weekly price check and the 30-day
  deletion run as API timers beside the existing ones, not as worker
  jobs. The worker gets no AI key and no new grants.
- **D5. The proxy host, offered on the page.** Saving a base address, or
  a pricing source, whose host is not on the server proxy host list shows
  "Portikus will also allow the server to reach <host> on port 443" with
  a checkbox ticked by default. Saving writes both changes, each audited
  as its own operation (the proxy change as `proxy_hosts.set`).

## Left out

- Course-scoped invitations: invitations have no course today, so "invite
  these 30 as students in this course" invites them as students; course
  membership still comes from the course system.
- Dollar caps (the cap is in tokens; dollars shown where the price table
  knows the model).
- Embedding search over the guides.
- Any assistant route for API keys, second factor, impersonation or the
  root shell (never in the catalog).
- An "always allow" button.
- Moving the chat store into a shared package; moving the student chat
  onto the AI SDK.
- Later optional features (#2069) and OAuth for MCP (#2070).
