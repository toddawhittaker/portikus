# Built-in AI: pre-plan

Status: pre-planning, written 2026-11-15 against main `fc40186d`. Todd
made every ruling in section 9 the same day. This file is not the epic
plan. The epic plan (`docs/EPIC-<n>.md`) is written on the epic branch
after the rulings and an architect pass (WORKFLOW.md, "Epic plans").

How to use this file if you are an agent picking this up:

1. Read sections 1 to 4 for the shape. Do not start building.
2. Section 9 lists Todd's rulings. They are settled; do not reopen
   them.
3. Section 10 lists facts this pre-plan did not verify. Check them
   (explorer or architect) before writing the epic plan.
4. Section 8 gives the suggested task order.

## 1. The idea in one paragraph

Issue #2018 (refresh model prices with AI help) needs Portikus itself to
call an AI model with a key the institution supplies (any
OpenAI-compatible provider, ruled 2026-11-15). Once that exists,
the same key and plumbing can power an assistant inside the app that does
administrative work by conversation and diagnoses problems, and a Model
Context Protocol server (MCP, the standard that lets outside AI tools such
as Claude Code call an application's functions) so that an administrator's
own AI tools can drive Portikus with a Portikus-issued key.

## 2. What exists today (verified in the code)

- **API.** Fastify 5 with Zod contracts in `packages/contracts`. 67 route
  files in `apps/api/src/routes/`, registered in `apps/api/src/server.ts`.
  Each route has an access class in `apps/api/src/security/route-policy.ts`
  (`public`, `self`, `owner`, `owner-or-admin`, `admin`,
  `course-instructor`, `preview-edge`).
- **No machine-readable API description.** ADR 0003 promises OpenAPI
  generated from the Zod contracts; SPEC.md line 5944 says it is not wired
  up. There is no list of operations anywhere in code.
- **Roles.** `student`, `instructor`, `administrator`
  (`packages/auth/src/types.ts`). Guards are `requireUser` and
  `requireRole` in `packages/auth/src/plugin.ts`.
- **No API keys.** Sign-in is a browser session cookie only. The only
  bearer tokens are internal (workspace agent, controller).
- **Audit.** `audit_events` table, `recordAudit` in
  `packages/db/src/index.ts`, shown in the admin Audit tab. Audit rows
  never hold tokens, prompts or file contents (STACK.md section 15).
- **Secrets.** The pattern is write-only: a secret travels once in a
  0600 request file to a root job, is stored in a root-owned file, and the
  page shows only "set" or "not set" (SPEC.md section 24.8; alerts in
  `/etc/portikus/notify.json` are the closest example, ADR 0052).
- **AI code.** Only the student chat tab: `@anthropic-ai/claude-agent-sdk`
  0.3.325 inside the workspace agent (`apps/workspace-agent/src/chat/`),
  relayed by `apps/api/src/routes/chat.ts` over a WebSocket, drawn by
  `apps/web/src/chat/` (`MessageList`, `ToolBlock`, `PermissionCard`,
  `QuestionCard`, `Composer`). No `@anthropic-ai/sdk`, no MCP library, no
  platform-held AI key, and no spec text for any of them.
- **Diagnostic data.** Health samples and request samples in PostgreSQL,
  admin Health, Logs, Audit and Agents tabs, the job log, the agent log
  ring (ADR 0060), alerts (ADR 0052), workspace detail and events.
- **Trust.** A compromised API process already equals root on the host
  through the root shell (SPEC.md section 24.1, ADR 0051). That raises
  the stakes for anything that lets a model call API operations.

## 3. The one design choice that matters most

The harness (the loop that sends messages to the model and runs the tools
it asks for) matters less than this: **one catalog of operations, used by
every door.**

Today an operation exists only as a Fastify route. The assistant and the
MCP server both need the same thing: a list of operations, each with a
name, a description, an input shape, a role rule, and a risk level. If
each door keeps its own list, the lists drift apart and the security rules
get written three times.

Proposed: an **operation catalog** built from the existing routes.

- Each route gains a small metadata record: a stable operation name (for
  example `workspaces.restart`), a one-sentence description, and a risk
  level (section 6). The Zod contract it already has supplies the input
  and output shapes.
- The catalog is the source for three things: the OpenAPI document that
  ADR 0003 already owes, the assistant's tools, and the MCP server's
  tools.
- A tool call runs the real route, in process, as the calling person.
  Fastify has a built-in way to do this (`app.inject`), so validation, the
  route policy and the audit row all run exactly as they do for a click in
  the admin page. No handler is rewritten.
- Routes that are WebSockets (terminals, the root shell, chat) are not in
  the catalog. That is wanted: section 6 keeps the root shell away from
  the model.

What it gains: "the assistant and the MCP server can do pretty much
everything" comes almost free, and neither can ever do more than the
person could do in the browser. What it costs: one pass over all 67 route
files to add metadata, and care that descriptions are good enough for a
model to pick the right operation.

Rejected simpler option: hand-write a few dozen tools that call the
database directly. Faster to a demo, but it copies authorization and audit
logic and never reaches "everything".

### How many tools

Roughly 200 operations is too many to hand a model at once. Recommended
shape, the same for the assistant and the MCP server:

- About 30 to 40 common operations as named tools.
- Two general tools for the rest: `find_operation` (search the catalog by
  words) and `run_operation` (run one by name with checked input).

The server enforces role and risk on `run_operation` exactly as on a named
tool. The architect should confirm this split or propose the provider's
own tool-search feature for the assistant instead.

## 4. Which agent harness

Ruled 2026-11-15: **any OpenAI-compatible key must work.** That means
the administrator enters a base address, a key and a model name, and
Portikus talks to it in the OpenAI Chat Completions format. That one
format covers OpenAI, OpenRouter, Azure, Groq, and models an institution
runs itself (Ollama, vLLM, LiteLLM).

This ruling removes every Claude-only harness. The Anthropic SDK Tool
Runner and the Claude Agent SDK, which an earlier draft of this file
compared, are both out. So is Claude Managed Agents.

The remaining options:

| Option | What it is | Gains | Costs |
|---|---|---|---|
| A. Our own small loop on the `openai` package (recommended) | The official `openai` client pointed at the configured base address. We write the loop: send the messages and tools, run any tools the model asks for, send the results back, repeat. | Uses only the part of the format every compatible server implements (chat, tools, streaming). One mature dependency. The loop is small, perhaps 150 lines, and we own approvals, storage and limits outright. | We write and test the loop, the streaming of partial tool calls, and retries ourselves. No provider extras (see "What we give up"). |
| B. Vercel AI SDK | A provider-neutral library with its own tool loop and adapters for OpenAI-compatible servers and for Anthropic | Loop, streaming and Zod tools come written. A native Anthropic adapter with prompt caching is one line away. | A larger, fast-moving dependency with frequent breaking major versions, and a layer between us and the wire. STACK.md prefers explicit interfaces over framework behaviour. Its approval step must be checked against our approval cards. |
| C. OpenAI Agents SDK | OpenAI's agent library, with approvals and MCP support built in | Approvals and handoffs come written | Built around OpenAI's newer Responses format; third-party servers are a side path. More machinery than one assistant needs. |
| D. No harness: the existing chat tab plus our MCP server | An administrator or instructor uses Claude Code or Codex in a workspace, pointed at the Portikus MCP server | Nothing to build beyond MCP. Works with a subscription. | No in-app features: no "Diagnose" button, no price refresh, no scheduled work. |

**Ruled 2026-11-15, after the checks below: B, the
server half of the Vercel AI SDK only, with MCP built first so that D
works on day one.** Use `ai`, `@ai-sdk/openai-compatible` and
`@ai-sdk/anthropic`. Do not use `@ai-sdk/react` or any component
library; the chat interface is ours.

Why B now beats A:

- Its approval step fits our approval cards (see the checks).
- Anthropic's own OpenAI-compatible address is not fit for regular use
  and has no prompt caching, so Claude users need a native adapter. With
  B that adapter is a second small package, not a second loop.
- The loop, the assembly of streamed tool calls and per-step token
  counts come written and tested.

What B costs, stated plainly:

- A breaking major version about every six months (4.0 in November
  2024, 5.0 in July 2025, 6.0 in December 2025, 7.0 in June 2026) and
  very frequent small releases, so many dependency updates to review.
- To contain that, all AI SDK imports live in one module behind our own
  small interface. Nothing else in the code imports `ai`.

Option A stays the fallback if a major version upgrade ever proves too
costly: the interface is the same, so the module can be rewritten on
the `openai` package.

The MCP server does not depend on any of this. It never calls a model,
and the AI SDK has an MCP client but nothing for building a server.

### Checked on 2026-11-15

From the npm registry and the libraries' documentation:

- `ai` 7.0.173, `@ai-sdk/openai-compatible` 3.0.92, `@ai-sdk/anthropic`
  4.0.105: all Apache-2.0. `@modelcontextprotocol/sdk` 1.32.2: MIT.
  `openai` 7.57.0: Apache-2.0.
- The AI SDK accepts Zod `^4.1.8`; the repository's 4.6.7 fits. It also
  accepts plain JSON Schema. It needs Node 22 or later.
- **Approval.** A `toolApproval` option on the model call decides, per
  call and from the tool's input, whether a call needs a person. The
  call does not wait: it returns an approval request, we store it, show
  the card, and call again with the answer. A denial reaches the model
  as a refused tool result. This works on the server without the React
  hook, and because nothing waits in memory, an API restart does not
  lose a pending approval.
- **Loop limit.** `stopWhen` takes a custom function, and each step
  reports its token usage, so a token budget is a few lines.
- **OpenAI-compatible adapter.** Configured with a base address, a key
  and a model name; speaks Chat Completions; supports tools with
  streaming. Token usage on streamed replies is off by default and must
  be switched on (`includeUsage`). Fixed-schema output only where the
  server supports it, so the `submit_rows` tool approach below stands.
- **Anthropic adapter.** Prompt caching is set per message or tool, and
  cache reads and writes are reported in the usage.
- **Anthropic's OpenAI-compatible address.** Its own page says it "is
  not considered a long-term or production-ready solution"; prompt
  caching is not supported there.
- **Our chat interface** (`apps/web/src/chat/`). `MessageList`,
  `ToolBlock`, `PermissionCard` and `QuestionCard` take plain props and
  can be reused as they are. Unknown tool names already get a generic
  card with the name and the input. `ChatView`, `Composer` and
  `useChatSession` are tied to a workspace, project and terminal, so the
  assistant needs its own thin view and composer. The wire events in
  `packages/contracts/src/chat.ts` (`text.delta`, `tool.started`,
  `tool.finished`, `permission.requested`, `permission.answer`) are the
  right shape for the assistant to emit, so the store's reducer can be
  shared.
- **The chat host core** (ADR 0076) cannot run in the API as it is: it
  listens on a Unix socket and expects a home and project folder. Reuse
  the wire contract and the open-cards idea, not the core.

### What the AI SDK does not replace

Asked on 2026-11-15: could it replace the custom code behind the student
chat for Claude and Codex? No, and the plan must not try.

- The student chat drives two complete coding agents (Claude Code through
  the Claude Agent SDK, and Codex through its own host). They own the
  loop, the file and shell tools, the sessions and the student's
  subscription sign-in. The AI SDK only calls models with an API key.
- The browser store handles reattaching, handoffs, modes, commands,
  rules, subagents and sign-in state. The AI SDK's React hook covers
  only a message list and streamed text.
- The saving runs the other way: the assistant reuses the existing wire
  events and the message, tool and card components, so there is one chat
  interface with two back ends.
- Moving the shared part of the store's reducer into a package is left
  unbuilt until the assistant exists and the duplication can be seen.

### What the ruling gains

- An institution can point Portikus at a model it runs itself. Then no
  student data leaves the server at all, which is the strongest answer
  to the privacy question in section 6.
- No tie to one vendor's prices or terms.

### What we give up, and what replaces it

- **Provider web search.** Issue #2018 describes a Claude model with web
  search and web fetch. Compatible servers have no common web tool.
  Replacement: Portikus fetches the pricing pages itself, from a short
  list of addresses the administrator can edit, and hands the page text
  to the model to extract rows with quoted sources. A page that refuses
  the fetch falls back to manual edit, which the issue already includes.
  This is also safer: the model never chooses an address. The issue text
  needs a note when the epic plan is written.
- **Guaranteed JSON output.** Not every server supports a fixed output
  schema. Replacement: ask for the result as a tool call (for example
  `submit_rows`), check it with the Zod schema, and retry once on
  failure. This works wherever tools work.
- **Prompt caching control.** OpenAI caches automatically; others vary.
  Keep the system prompt and tool list byte-for-byte stable so automatic
  caching helps where it exists.
- **A spending cap in dollars.** Portikus cannot know every model's
  price. Replacement: the cap is in tokens, read from the `usage` field
  of each reply. Where the model pricing table (issue #2018) knows the
  model, the page also shows dollars.
- **Even quality.** Small or local models call tools badly. The settings
  page's "test" button must run a real tool-call round trip, not only a
  greeting, and the admin guide lists the models we have tested.

Notes for whoever builds the model module (either option):

- Settings are three fields: base address, key (write-only), model name.
  Offer a model list from the server's `/models` route where it exists,
  with free text as the fallback.
- Send no provider-specific parameters by default (no reasoning or
  thinking fields). Unknown fields make some servers fail.
- Put the model client behind one small interface with one
  implementation. Do not build a second one until it is asked for.
- Stream replies. Assemble tool calls from the streamed pieces and
  validate each tool's input with its Zod schema before running it.
- Give each conversation a token budget and stop cleanly when it is
  spent.
- The price refresh is a fixed job (fetch, extract, validate, propose),
  not an open-ended agent.

### Where the loop runs

Recommended: the interactive assistant runs in `apps/api` (it already
holds the WebSocket and the routes the tools call). Scheduled work (the
weekly price check, alert summaries) runs in `apps/worker` as ordinary
jobs. No sixth process. The architect should confirm that a long model
call does not hold anything the API needs and that an API restart ends a
conversation cleanly.

## 5. Possible features

Size is a rough guess: S is a task or two, M is several tasks, L is an
epic's worth. "Take" is my opinion.

### Foundation (everything else needs these)

| # | Feature | Size | Take |
|---|---|---|---|
| F1 | Operation catalog and the OpenAPI document (section 3) | M | Required. Pays off ADR 0003 as well. |
| F2 | AI settings page: provider kind (OpenAI-compatible or Anthropic), base address, key (write-only), model name, monthly token cap, off switch, and a "test" button that runs a real tool call. Off until a key is set. | M | Required. |
| F3 | Portikus API keys for administrators and instructors: created by a person, shown once, stored as a hash, with a scope, an expiry and a last-used time; an admin page to list and revoke. They work on the plain HTTP API too. | M | Required for MCP. |
| F4 | MCP server at `/mcp` on the API, using the official `@modelcontextprotocol/sdk`, authenticated by an F3 key | M | Required. |
| F5 | Assistant core: the loop, conversation storage, approval cards, usage metering into the existing Agents tab | L | Required for in-app features. |
| F6 | Assistant panel in the admin interface, reusing the chat components | M | Required for in-app features. |

### Administrator features

| # | Feature | Size | Take |
|---|---|---|---|
| A1 | Model pricing page with AI-assisted refresh and the weekly check (issue #2018; its web search step changes, see section 4) | M | Do first; it is the stated reason for the epic and needs only F2. |
| A2 | Conversational administration: users and invitations, workspaces (stop, restart, rebuild), backups, the egress allow-list, courses, settings | S once F1 and F5 exist | Core. It is the catalog plus approval cards. |
| A3 | "Diagnose" buttons on the Health tab, a workspace's detail page, a failed job and an alert. Each opens the assistant with that item already in context; it reads health, logs, the job log and the audit trail and reports a likely cause with the evidence. Read-only. | M | Core. Highest value for a lone administrator. |
| A4 | Bulk work with a preview: "invite these 30 addresses as students in this course" shows a table of what will happen, then one approval | S | Strong. |
| A5 | Questions answered from the guides (ADMIN-GUIDE, OPERATIONS, INSTALL) with the section cited | S | Strong. Cheap, and stops the model guessing about Portikus. |
| A6 | Guided setup by conversation for the hard pages: LTI (issue #1703), certificates, sign-in. The assistant explains and checks; secrets are still typed into the form, never into the chat. | M | Strong for LTI. |
| A7 | Alert triage: when an alert fires, a worker job runs a short read-only diagnosis and adds two sentences to the notification | M | Good, later. Needs a rate limit so an alert storm cannot spend the budget. |
| A8 | Weekly digest: health, capacity against CAPACITY.md, usage, anything odd in the audit trail | S | Good, later. |
| A9 | Plain-English search of the audit trail and logs ("who rebuilt this workspace last week?") | S | Falls out of A2. |
| A10 | Root shell helper that suggests a command for the administrator to paste, and never runs one | S | Maybe. Useful, but keep the model fully outside the shell. |

### Instructor features

Instructors get the assistant (ruled 2026-11-15). It acts with the
instructor's own role, so it reaches only their courses and only the
operations an instructor can already use in the browser.

| # | Feature | Size | Take |
|---|---|---|---|
| I0 | The assistant panel for instructors, limited by the catalog to instructor operations: rosters, shares, live help, check history, course settings | S once F5 and F6 exist | Core. Needs its own authorization tests: an instructor's assistant must get the same refusals an instructor gets. |
| I1 | "Who is stuck?" for a course: a summary from check history, live help and agent usage | M | Strong. |
| I2 | Draft a project's checks and starter from an assignment description, for the instructor to edit | M | Maybe. |

### Students: none

Ruled 2026-11-15: students never get this assistant. The assistant
panel, the assistant's API routes, API key creation and the MCP server
all refuse the student role, and a test pins that. Students keep Claude
Code and Codex in their workspaces.

### External control

| # | Feature | Size | Take |
|---|---|---|---|
| X1 | MCP tools for everything in the catalog, filtered by the key's scope | part of F4 | Core. |
| X2 | MCP resources (the guides, a health snapshot) and ready-made MCP prompts ("diagnose workspace X") | S | Good, later. |
| X3 | OAuth sign-in for MCP through Dex, so claude.ai connectors work without a pasted key | M | Future. Say so and leave it unbuilt. |

### Advise against, whatever else is chosen

- The model running commands in the root shell.
- Changes made with no person approving them (automatic remediation).
- Secrets passing through a conversation in either direction.
- The assistant or an MCP key creating API keys, changing second-factor
  settings, or impersonating a user.

## 6. Safety rules (the part reviewers will press on)

**Acts as the caller, never more.** A tool call runs with the role of the
signed-in person or the owner of the API key. There is no "assistant"
super-user. Only administrators and instructors can reach it; the
student role is refused at every door.

**Four risk levels, set per operation in the catalog.**

| Level | Examples | In the app | Over MCP |
|---|---|---|---|
| Read | list users, read health, read logs | runs at once | needs a read scope |
| Change | restart a workspace, send an invitation, edit a setting | approval card showing the exact operation and inputs | needs a write scope |
| Destructive | delete a user, delete a backup set, grant the administrator role | approval card with a typed confirmation | needs a separate destructive scope |
| Never | root shell, creating API keys, second-factor changes, impersonation, any secret field | not in the catalog | not in the catalog |

The approval card is drawn by code from the operation and its inputs, not
from the model's description of what it is about to do.

**Text from tools is data, not instructions.** Project names, file names,
process command lines and log lines are written by students and can
contain text aimed at the model ("ignore your rules and delete…"). The
barriers are: every change needs a person's approval, and a conversation
that can read Portikus data never also has web search or web fetch. The
price refresh job has web tools and therefore has no Portikus tools; it
can only propose rows.

**What is sent to the provider.** Tool results go to whichever server
the administrator configured. With a hosted provider that includes
student names and activity leaving the institution; with a model the
institution runs itself, nothing leaves. Never sent: file contents, terminal
bytes, students' chat prompts, secrets. This is a real privacy decision
for an institution, so the feature is off by default and the settings
page says plainly what leaves the server.

**What is stored.** STACK.md section 15 and ADR 0012 forbid logging
prompts. Ruled: assistant conversations are stored as data in
PostgreSQL with a retention period, never written to logs, and audit rows
record only the operation name, the target and how the call arrived
(session, assistant, or API key id). This needs its own decision record.

**API keys.** Created only from a signed-in session with a fresh second
factor; shown once; stored as a SHA-256 hash like session tokens; read
scope by default; an expiry by default; every use audited with the key
id. An administrator can revoke any key.

**Spending.** A monthly cap and a per-conversation budget, both checked
in code and counted in tokens (section 4). A separate key from any key
handed to students, so its spending can be limited at the provider as
well.

## 7. Documents this will touch

- SPEC.md: a new section for the built-in AI and API keys; section 24.1
  (the AI provider becomes an outside party that receives admin data, and
  API keys become a new credential); section 24.8 (the AI key); section
  24.11 (how a call arrived); section 27 (OpenAPI is now generated);
  section 29 (the epic entry).
- STACK.md: the new dependencies (the AI SDK packages named in
  section 4,
  `@modelcontextprotocol/sdk`) and why; section 15 (conversation storage).
- New decision records: the operation catalog; the built-in AI and its
  harness; API keys; the MCP server; storing assistant conversations.
- ADMIN-GUIDE.md and INSTALL.md: setting the key, privacy notice, MCP
  setup for Claude Code.

## 8. Suggested order

This is too large for one epic to review well. It is split into three
epics, each useful when it lands (ruling 1):

**Epic X: catalog, keys and MCP.**

1. Architect pass (read-only): catalog shape, risk level for every
   route, where metadata lives, the tool split in section 3.
2. Operation catalog and OpenAPI document (F1). One builder per route
   family so no two agents edit the same files; the shared catalog file
   is owned by the first task.
3. API keys and their admin page (F3).
4. MCP server, read scope first, then write scopes (F4, X1).
5. Security review of the whole path. Guide updates.

**Epic Y: built-in AI and the assistant.**

1. AI settings page and key storage (F2).
2. Model pricing page and refresh (A1, issue #2018). Needs only step 1.
3. Assistant core and panel (F5, F6).
4. Conversational administration and bulk preview (A2, A4).
5. Diagnose buttons and answers from the guides (A3, A5).
6. The instructor panel and "Who is stuck?" (I0, I1).

**Epic Z: later, by choice.** Alert triage, weekly digest, guided LTI
setup, check drafting for instructors (I2), MCP resources.

Testing notes for the plan:

- CI never calls a real model. Unit tests use a fake client that replays
  scripted model turns; Playwright tests use a small fake model server.
- The catalog gets a test that every route is either in it with a risk
  level or on an explicit "not exposed" list, so a new route cannot be
  forgotten.
- Authorization tests run each operation through the catalog as each
  role and expect the same answer as the HTTP route gives.
- A hand-run check on the pilot before each epic's pull request: about
  30 scripted tasks, run once with an OpenAI model and once with a
  Claude model (ruling 9). It costs real money, so ask first.

## 9. Rulings (all made by Todd on 2026-11-15)

Nothing here is open. Do not ask these again; build the epic plan on
them.

1. **Epic split.** Three epics, as in section 8.
2. **Harness.** The server half of the Vercel AI SDK (`ai`), behind one
   module of our own, with our existing chat interface. No
   `@ai-sdk/react` and no component library. MCP is built first.
3. **Provider.** Any OpenAI-compatible key works (base address, key,
   model name), and Anthropic is also supported natively through the AI
   SDK's Anthropic adapter. The settings page offers those two provider
   kinds.
4. **Who gets it.** Administrators and instructors only. Students never.
   Instructors may also create API keys and use the MCP server, limited
   to instructor operations on their own courses.
5. **The AI key.** Separate from any institution key handed to students'
   coding agents (SPEC.md section 10.6).
6. **Destructive operations over MCP.** Allowed only for a key created
   with an explicit destructive scope. Keys are read-only by default.
7. **Privacy.** Real names are sent. The feature is off until an
   administrator reads a plain notice of what leaves the server and
   turns it on.
8. **Conversation storage.** In PostgreSQL, visible only to the person
   who had the conversation, deleted after 30 days. Never in logs.
9. **Tested models.** Two: one current OpenAI model and one Claude model
   through the Anthropic adapter. Each runs the scripted tasks on the
   pilot before an epic's pull request, and the admin guide lists them
   as known to work. A self-hosted model is not tested; the guide says
   it should work and is unproven.

## 10. Not yet verified (check before writing the epic plan)

- That the AI SDK's streamed events map cleanly onto the chat wire
  events in `packages/contracts/src/chat.ts`; build a small spike first.
- That `ai` pulls in `@ai-sdk/gateway` (Vercel's hosted gateway) only
  as unused code and makes no network call unless asked.
- How the control plane reaches a self-hosted model on the
  institution's network, and what the settings page must check about
  the base address.
- That `app.inject` can carry the caller's identity cleanly, given that
  sessions are read from a cookie in `packages/auth/src/plugin.ts`. A
  small internal identity hook may be needed.
- Whether the control plane's outbound calls pass through the egress
  proxy, and so whether `api.anthropic.com` needs an allow-list entry.
- Whether any setting for an institution-provided key exists today
  beyond the environment passthrough in
  `apps/api/src/workspaces/launcher-env.ts`.
- What the MCP specification currently requires for sign-in on a remote
  server, and that Claude Code and Codex both accept a static bearer key.
