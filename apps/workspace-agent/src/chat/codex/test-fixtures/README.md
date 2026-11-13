# Codex app-server fixtures

Recorded from a real `codex app-server` (Codex **0.167.1**, model
`gpt-6.1-sol`, effort `low` unless noted) on the development host on
2026-11-13, for Epic 66 task T0a (docs/EPIC-66.md). The Codex driver's tests
replay these instead of a live Codex.

## Format

One JSON object per line, in the order seen on the wire:

```json
{"dir": "client", "msg": { ...JSON-RPC message the client wrote... }}
{"dir": "server", "msg": { ...JSON-RPC message app-server wrote... }}
```

`client` lines are requests, notifications and replies to server requests;
`server` lines are responses, notifications and server requests. Every file
starts with `initialize` (`experimentalApi: true`) and `initialized`.
Threads are `ephemeral: true` unless noted.

## Scenarios

| File | What happens |
|---|---|
| `command-approval.jsonl` | Three threads (`approvalPolicy: untrusted`, workspace-write). Each asks for `ls`; the `item/commandExecution/requestApproval` is answered `accept`, then `decline`, then `cancel`. |
| `file-change-approval.jsonl` | `untrusted`, read-only. `apply_patch` creates a file; `item/fileChange/requestApproval` answered `accept`; `turn/diff/updated` and the `fileChange` item follow. |
| `plan-question.jsonl` | `turn/start` with `collaborationMode: {mode: "plan"}`. Codex asks one `item/tool/requestUserInput` question (options, `isOther`); the client answers with the first option; the turn ends with a `plan` item. |
| `subagent.jsonl` | Durable thread (deleted afterwards), effort `medium`. The parent spawns a child (`subAgentActivity` kind `started`), the child thread's own `turn/started`, items and `turn/completed` arrive on its thread id, the parent `wait`s (`collabAgentToolCall` tool `wait`), then sends the same child a follow-up (`subAgentActivity` kind `interacted`) and waits again. In 0.167.1 the follow-up shows as `interacted`, not as a `collabAgentToolCall` with tool `sendInput`. |
| `file-change-diff.jsonl` | workspace-write, `never`. Codex edits a file with `apply_patch`: `fileChange` item with a unified diff and `turn/diff/updated`. |
| `command-kinds.jsonl` | Four commands whose `commandActions` are `read`, `listFiles`, `search` and `unknown`. |
| `image-input.jsonl` | `turn/start` input with a `localImage` item (an 8×8 PNG). |
| `steer.jsonl` | `turn/steer` with `expectedTurnId` sent mid-turn; the steer appears as a second `userMessage` item in the same turn. |
| `interrupt.jsonl` | `turn/interrupt` after the first `item/agentMessage/delta`; the turn completes with status `interrupted`. |
| `shell-command.jsonl` | `thread/shellCommand` (`!` command): one that finishes, then `sleep 30` stopped with `turn/interrupt` on the turn the shell command started (status `interrupted`). |
| `resume-turns-list.jsonl` | Durable thread (deleted afterwards): one turn, `thread/unsubscribe`, `thread/resume`, then `thread/turns/list` with `itemsView: "full"` and with the default view. |
| `inject-items.jsonl` | `thread/inject_items` with one user and one assistant Responses `message` item, then a turn that asks about them. The answer used the injected content, so the next turn does see injected items. |
| `skills.jsonl` | `skills/list` for the project (one repo skill plus the system skills) and a `$probe-alpha go` turn. |
| `mcp-approval.jsonl` | A local stdio MCP server `echo` with tool `echo_word`, `untrusted`. Three threads, each with `mcpServerStatus/list` first. The `mcpServer/elicitation/request` (`_meta.codex_approval_kind: "mcp_tool_call"`, `persist: ["session","always"]`) is answered: (1) `{action:"accept", content:{}, _meta:null}`; (2) `{action:"accept", content:{}, _meta:{persist:"session"}}`, followed by a second call in the same thread that runs with no new request; (3) `{action:"decline", content:null, _meta:null}`, which fails the tool call. |
| `model-list.jsonl` | `model/list`. |
| `token-usage.jsonl` | Two turns in one thread with `thread/tokenUsage/updated` after each (`total` grows, `last` is per turn). Recorded with the OTLP metrics exporter pointed at a local listener (see below). |

## What was scrubbed

`scrub.py` (kept with the T0a notes, not in the repo) rewrote each raw
recording; the structure, field names, ordering, item types, statuses and
numbers are unchanged.

- Message text: every `text`, `delta`, `preview`, plan and reasoning text,
  question `header`/`question`, option `label`/`description` and the
  answers that echo them, Plan-mode `developer_instructions`, MCP tool
  result text: replaced with `<text>`, `<delta>`, `<question>` and similar.
  Commands in the prompts and `command` fields are kept (they are trivial
  test commands and the command-kind tests need them).
- Command output (`aggregatedOutput`): `<output>`.
- Diffs: headers and hunk markers kept; each content line becomes
  `+<line>`, `-<line>` or ` <line>`; blob hashes on `index` lines zeroed.
- Paths: the throwaway project became `/workspace/project`, the home
  folder `/home/user`; the host name became `host` and the OS name in
  `userAgent` became `Linux`.
- Ids: every UUID (thread, turn, session, installation, read-state) is
  replaced with `00000000-0000-7000-8000-<n>`, and `msg_`/`call_` ids with
  a counter, consistently within each file so cross-references still match.
- Account: `planType` is `<plan>`; the ChatGPT connector server
  (`codex_apps`) in `mcpServerStatus/list` keeps its entry but its tool,
  resource and metadata lists are emptied. `account/read` was never called.
