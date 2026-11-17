# Epic 70: built-in AI extras

Branch `epic/70-ai-extras`, base commit `ab983c49` (main after Epic 69
and #2106, #2107). Scope: GitHub issue #2069, plus #2090 (output price).
This file goes away at the fold.

## Rulings that apply (Todd, 2026-11-17)

- #2070 (MCP sign-in through Dex) is its own epic, next. #2097 (a model
  on the institution's network) stays filed. #2090 is folded in.
- **D1 triage runs unasked, behind consent.** A fixed pipeline in the API
  (no tools, code picks every read) behind an "Explain alerts" switch on
  the AI page, off by default. The privacy notice goes to version 2, so
  the assistant pauses after upgrade until an administrator accepts it.
- **D2 limit.** One triage per alert title per hour; a daily maximum the
  administrator sets on the AI page (default 5), counted from the
  database; about 5,000 input and 300 output tokens per call; inside the
  shared monthly cap. Dollars are shown, never used as a limit.
- **D3 forwarding behind a switch.** A second switch, "Add explanations to
  email and Pushover alerts", off by default. When on, the alert
  forwarder waits up to 60 seconds for the triage and appends it.
- **D4 digest is code only.** No model call.
- **D5 guided setup on LTI and sign-in.** Read-only, administrators only.
- **D6 I2 dropped.** An Instructor Guide section instead: ask Claude Code
  or Codex in your own workspace to write `.portikus/checks.json` and
  starter files.

## Facts checked

- ADR 0080 line 47: AI timers run in the API; the worker gets no AI key.
  The worker forwarder (D3) only reads the stored triage text.
- The next migration number is 0065.
- The AI SDK's `inputTokens` already includes cache reads and writes
  (`usage()` in `apps/api/src/ai/model.ts`). Subtract them before
  pricing, or cached tokens are charged twice. Label dollars "estimate".

## Design

- **#2090.** `outputPricePerMillion` may be empty on stored rows but is
  required on every save. Two pure functions in contracts `pricing.ts`:
  `priceRowFor(model, rows)` (exact match after `normalizePriceModel`)
  and `usageDollars(counts, row)`. The usage route returns `dollars` or
  null; the digest uses the same functions.
- **X2.** MCP resources `portikus://guides/<FILE>` (guides the key
  owner's role may read, from the role map in `assistant/guides.ts`) and
  `portikus://health` (runs `health.get` through the runner as the key).
  Prompts `diagnose_workspace`, `diagnose_health` (administrators) and
  `who_is_stuck` (staff), listed only when the caller may run them.
- **A6.** Context kind `setup` with id `lms` or `signin` (stored as JSON,
  no migration). First reads: LTI `lms.get`, `proxy_hosts.get`, error
  logs; sign-in `signin.get`, `address.get`, error logs. One setup line
  in the system prompt: explain, check against the guide, never ask for a
  secret. `DiagnoseButton` gains a label prop.
- **A7.** `apps/api/src/triage/`, the price check's shape: API timer with
  an advisory lock finds new warning or danger administrator alerts with
  no triage; code collects the alert, newest health sample and recent
  error lines; one call with no tools; answer capped near 400 characters,
  shown as plain text. Usage purpose `triage`, no user; one audit row,
  actor `system`.
- **A8.** `apps/api/src/digest/`, weekly API timer tracking
  `settings.digest_sent_at`. One information notification to each
  administrator, plain lines, at most 2,000 characters: 7-day health,
  peak running workspaces against capacity (move
  `apps/web/src/admin/settings/estimate.ts` to contracts `capacity.ts`),
  usage with dollar estimate, and a fixed list of odd audit entries.

## Migrations (all owned by T1)

- 0065 `model_output_price`: `output_price_per_million` on `model_prices`
  and `price_proposals`.
- 0066 `alert_triage`: `triage`, `triaged_at` on notifications;
  `triage_enabled`, `triage_daily_limit` (default 5), `triage_forward`
  on `ai_settings`; purpose `triage` allowed in `ai_usage_days`.
- 0067 `weekly_digest`: `settings.digest_sent_at`.

## Tasks

Machines: local is linux-dev, desk is Todd-Desktop-2, pve is pve1-dev.
Load is measured before each start and a task may move to an idle
machine. "Starts after" names task PRs that must merge first.

| Task | Agent, model | Machine | Files it owns | Starts after | Playwright |
|---|---|---|---|---|---|
| T1 data model and contracts | builder, Opus low | local | the three migrations and `migrations/index.ts`; `packages/db/src/schema.ts`, `schema-ai.ts`; contracts `pricing.ts`, `ai.ts` (not the notice version), `assistant.ts`, `notifications.ts`; minimal typecheck edits in `pricing/store.ts`, `routes/admin-ai-usage.ts`, the notifications route, `AiUsageSection.tsx`, `ai/settings.ts`, `planDiagnose` | none | no |
| T3 X2 MCP resources and prompts | builder, Sonnet high | pve | `apps/api/src/mcp/server.ts`, new `mcp/resources.ts`, `mcp/prompts.ts`; one export in `assistant/guides.ts` | none | no |
| T2 #2090 output price and dollars | builder, Sonnet high | desk | `apps/api/src/pricing/*`, `routes/admin-ai-usage.ts`, `e2e/fake-model-server.mjs` (only editor), `scripts/model-check/tasks.ts` if needed, `apps/web/src/admin/pricing/*`, `apps/web/src/admin/agent-usage/*`, `e2e/admin-pricing.spec.ts`, `e2e/admin-agent-usage.spec.ts` | T1 | yes |
| T4 A6 setup help | builder, Sonnet high | local | `assistant/diagnose.ts`, `assistant/tools.ts`, `routes/assistant.ts`, `apps/web/src/assistant/DiagnoseButton.tsx`, `admin/signin/LmsGroup.tsx`, `SsoGroup.tsx`, new `e2e/assistant-setup.spec.ts`, `e2e/assistant-helpers.ts` (only editor) | T1 | yes |
| T5a A7 triage, server side | builder, Opus medium | pve | new `apps/api/src/triage/*`, `apps/api/src/index.ts` (timer start), `ai/settings.ts`, `routes/admin-ai.ts`, `ai/usage.ts`, `apps/worker/src/alerts.ts` (forwarding, D3) | T1, T3 (same machine) | no |
| T5b A7 triage, web side | ui-designer, Sonnet high | desk | `NotificationsDialog.tsx` (triage block, line breaks in bodies), `apps/web/src/admin/ai/*` (two switches, daily limit, notice text), `AI_NOTICE_VERSION` in contracts `ai.ts`, `e2e/admin-ai.spec.ts`, new `e2e/admin-ai-triage.spec.ts` | T1, T2 (same machine); opens its PR after T5a merges | yes |
| T6 A8 digest | builder, Sonnet high | local | new `apps/api/src/digest/*`; `estimate.ts` and its test moved to contracts `capacity.ts`, web importers, contracts index; one start line in `apps/api/src/index.ts` | T1, T4 (same machine); opens its PR after T5a merges | no (T5b renders a seeded digest) |
| T7 docs | builder, Sonnet high | local | `docs/SPEC.md` (20.4, 20.5, 24.1, 24.11, section 29 entry), `docs/STACK.md` (MCP), ADR 0082 (model calls no person asked for), "Amended" line on ADR 0079 and the ADR index, `ADMIN-GUIDE.md`, `INSTRUCTOR-GUIDE.md` (D6 section), `VISION.md` epic line | drafted early; finished after T2 to T6 merge | no |

Shared rules for every builder prompt: script the fake model through
`POST /__script` in each spec, never by editing the fake server; AI specs
that change AI settings take the Playwright lock `e2e-ai-settings`; only
T7 edits SPEC or any guide, and only the fold edits STATUS.

## Waves (for reading only)

1. T1 (local), T3 (pve).
2. After T1: T2 (desk), T4 (local), T5a (pve, after T3).
3. T5b (desk), T6 (local), both opening PRs after T5a.
4. Reviews start after waves 1 and 2 land: code-reviewer (local),
   security-reviewer (pve: T5a pipeline and forwarding, T3 role filter
   and health, T4 read-only setup), a11y-reviewer (desk: T2, T4, T5b).
5. Fix round, T7 finish, rehearsal VM install and upgrade test
   (migrations 0065 to 0067 and the notice change), fold, epic PR.

## Left out

- #2070 and #2097, as ruled. #2074 (MCP calls write two audit rows)
  stays separate.
- An alert-group id on notifications; email digests; digests for
  instructors; paid model-check tasks for setup and triage (need Todd's
  go).
- The pilot deploy note must say an administrator re-accepts the notice.
