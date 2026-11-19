# Epic 73: fix batch from the STATUS open items

Branch `epic/73-fix-batch`, base commit `8281a44f` (main after
Epic 72). Scope: GitHub issues #2150 to #2155, filed from small items on
the docs/STATUS.md open list. This file goes away at the fold.

## Rulings that apply

- **The batch (Todd, 2026-11-18).** Option 2 of the post-Epic 72
  review: small user-visible fixes from the STATUS open list before the
  next feature epic.
- **#2152 notice (Todd, 2026-11-18).** The "Answered in the terminal or
  timed out" notice stays, with a close button, until the student closes
  it or a new question arrives. No timer.
- **#2151 titles (orchestrator).** A Codex subagent panel is titled by
  the first line of the prompt the parent sent it (cut to about 60
  characters), falling back to the subagent's type from its left-pane
  row, then to the numbered "Subagent N". Claude's panels keep their
  description title.
- **#2155 sockets (orchestrator).** Closing happens in the API, which
  owns the sockets; the workspace agent is unchanged.

## Facts checked

- `useAgentTerminal` (`apps/web/src/chat/ChatView.tsx`, about line 297)
  calls `terminals.create({ agent })` every time, with no look for an
  open tab of that agent.
- `ToolBlock.tsx` titles every Codex panel "Subagent" or
  "Subagent N", numbered per tool row, so panels from different rows
  share titles. Codex left-pane rows carry a `type` and an empty
  `description`.
- `TerminalQuestion.tsx` clears the notice after `GONE_MS = 4000`.
- Folder listings page at 2,000 entries (`MAX_TREE_ENTRIES`). The tree
  loads further pages with a "Show more" row (`ShowMoreRow.tsx`);
  `MoveDialog.tsx` and `FileLeaf.tsx` read only the first page.
- `admin-send.ts` issues the token, then sends, and supersedes older
  tokens only on success; on a failed send the new token stays valid.
- `language-servers.ts` (API) reads the code help switch only when a
  socket opens; the admin settings write (`routes/admin.ts`,
  `applyCodeHelpLanguages`) closes nothing.

## Design

- **#2150.** Before creating a terminal, look for an open terminal tab
  of that agent in the workspace's tabs and focus it. Create one only
  when none is open.
- **#2151.** As in the ruling. The title goes through the existing
  `openSubagent({ title })` path from both the chat row and the
  left-pane row.
- **#2152.** As in the ruling. The notice stays a polite live status;
  the close button has an accessible name.
- **#2153.** The Move to dialog's folder list shows the tree's "Show
  more" row (reuse `ShowMoreRow`). The file viewer's sibling lookup
  fetches further pages until it finds the file or runs out.
- **#2154.** A failed send revokes the token it just issued, and the
  audit row still records `result: "failed"`. The task checks the
  self-service reset and invitation paths for the same fault and fixes
  them the same way if present.
- **#2155.** The API keeps its open language-server sockets by
  language. After the admin write that turns a language off commits,
  the API closes that language's open sockets with
  `LANGUAGE_SERVER_DISABLED`, as the open-time check already does.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 chat fixes | builder, Opus low | local | `apps/web/src/chat/ChatView.tsx`, `apps/web/src/chat/ToolBlock.tsx`, `apps/web/src/chat/SubagentPanel.tsx`, the left-pane agent-row component that opens a subagent panel, their unit tests, `e2e/chat-sign-in.spec.ts`, `e2e/chat-subagent-view.spec.ts`, `e2e/agent-rows.spec.ts` | #2150, #2151 | none | yes |
| T2 question notice | builder, Sonnet high | local | `apps/web/src/terminal/TerminalQuestion.tsx`, its CSS, `TerminalQuestion.test.tsx`, `e2e/terminal-question.spec.ts` | #2152 | none | yes |
| T3 long folders | builder, Sonnet high | desk | `apps/web/src/files/MoveDialog.tsx`, `apps/web/src/work/FileLeaf.tsx`, `apps/web/src/files/ShowMoreRow.tsx` if needed, their unit tests, the Move to and file viewer e2e specs | #2153 | none | yes |
| T4 API fixes | builder, Sonnet high | pve | `apps/api/src/account-email/admin-send.ts`, `apps/api/src/account-email/tokens.ts`, the self-service reset and invitation send paths if the same fault is there, `apps/api/src/routes/language-servers.ts`, `apps/api/src/routes/admin.ts`, their unit tests | #2154, #2155 | none | no (no visible change beyond a closed socket, covered by unit tests) |
| T5 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` (section 29 entry; notes in sections 11.2 and 13.6 and the question-card and set-password lines if they state the old behavior), delete this plan | all six | T1 to T4 | no |

T1 to T4 run at once in one wave. T5 is drafted while the reviews run.

## Reviews

- code-reviewer over the epic head, always.
- security-reviewer for T4 (set-password links and language-server
  sockets, SPEC.md section 24).
- a11y-reviewer for T1, T2 and T3 (new close button, "Show more" row,
  chat titles).

## Rehearsal

None. Nothing touches install, packaging or infrastructure.
