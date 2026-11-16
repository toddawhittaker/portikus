# 0080. The built-in AI: the AI SDK behind one module, our own loop, and acting as the signed-in person

- **Status**: Accepted (Epic 69)
- **Date**: 2026-11-15
- **References**: SPEC.md sections 20.4, 20.5, 24.1, 24.8 and 24.11; STACK.md sections 4, 15 and 35; ADR 0012, ADR 0027, ADR 0077, ADR 0078, ADR 0079, ADR 0081

## Context

Epic 68 gave Portikus an operation catalog, API keys and an MCP server, so
outside tools can run what an administrator or instructor runs. Epic 69
makes Portikus call a model itself, with a key the institution supplies, so
the same people can ask it questions and have it do routine work. The model
sees student names and activity, and it can ask for changes, so the design
has to keep a person in charge, spend bounded, and the provider's library
from spreading through the code. The AI SDK has a breaking major version
about every six months.

## Decision

1. **The server half of the Vercel AI SDK, behind one module.** `ai`,
   `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` are pinned exactly.
   Only `apps/api/src/ai/model.ts` imports them (a lint rule enforces it).
   Its interface is one streamed step plus `listModels()`. Model objects
   always get the key and base address passed in, never a string id (which
   would use Vercel's gateway) and never the environment.
2. **Two provider kinds, hosted only.** An OpenAI-compatible server and
   Anthropic's own API. Requests go through the server's egress proxy, which
   refuses private ranges and plain HTTP, so a model on the institution's own
   network is not reachable yet.
3. **Our own loop.** One model step at a time, in `apps/api/src/assistant/`.
   Read operations run at once; a change or destructive one stops at an
   approval card and the turn ends. The loop rebuilds the model's messages
   from stored events before every step, so nothing waits in memory.
4. **It acts as the signed-in person.** The in-process runner sends each call
   with the session of the socket that asked, so the route's checks and audit
   run unchanged. There is no internal identity and no minted key. Audit rows
   get `via` `assistant` from a header whose name and value are random per
   process, which the auth plugin checks and removes.
5. **Cards come from code.** Title, inputs and risk are drawn from the
   catalog entry and the checked inputs. Approve or Deny only. A destructive
   card needs the operation's name typed, checked by the server.
6. **The key and the limits.** The AI key is sealed under its own key and
   write-only (SPEC.md section 24.8). Limits are in tokens, counted from each
   reply: 5,000,000 a month for the site and 200,000 for a conversation.
7. **Off until read.** The feature needs a key, an accepted privacy notice at
   its current version, and the switch. Timers (retention, the weekly price
   check) run in the API, not the worker, which gets no AI key.

## Consequences

- An SDK major upgrade changes `model.ts` and its tests. A rewrite on the
  `openai` package would change the same file.
- A person who loses a role or signs out is refused mid-conversation.
- The assistant can never do more than the person's own role, and a student
  gets nothing.
- Approvals and conversations survive an API restart.
- We own the loop, so tool-call handling and step limits are our code to test.
- A self-hosted model needs a later change to the proxy and the base address
  rules.

## Alternatives rejected

- **`@ai-sdk/react` and its components.** The chat store and components the
  students use already show messages, tool blocks and cards.
- **The SDK's own loop and `toolApproval`.** They work, but their message
  format changes with each major version, and our storage, limits and cards
  need to sit between the steps.
- **A temporary API key for the assistant.** It would be a second credential
  with a scope instead of a role, visible in key lists, and able to outlive
  the session that asked.
- **`AsyncLocalStorage` for the `assistant` mark.** The first plan. The test
  showed the store does not survive Fastify's inject, so a per-process random
  header does the job.
- **Moving the student chat onto the SDK.** That chat drives two complete
  coding agents with their own loops and sign-ins.
