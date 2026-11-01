# Epic 56: Agent status, usage and file drop

Feature epic. Branch `epic/56-agent-status`, cut from main 8e37d992. This
plan lives only on the epic branch; the fold task folds its lasting rules
into SPEC.md and an ADR and deletes it (WORKFLOW.md, "Epic plans"). The
architect's design (2026-11-01) is the basis for the tasks below.

## Issues closed

The epic pull request into `main` closes #1707, #1710 and #1709. Task
pull requests use `Refs #N`; the epic pull request body carries one
`Fixes #N` line per issue.

## What students get

- Each terminal tab running Claude Code or Codex shows whether the agent
  is working, finished, or needs input, with an unread mark until the
  student looks. The project list shows the most urgent state of each
  project, so agents in other projects are visible too (#1707).
- A toast when an agent finishes or needs input in a tab the student is
  not looking at, with "Open project" for another project. When the
  Portikus page is hidden or unfocused, an operating-system notification
  as well (#1707).
- The status bar shows each agent's plan usage and when it resets. A
  student signed in with an API key, who has no plan limit, sees today's
  tokens and cost instead (#1710).
- Dropping a file from the desktop or the file tree onto a terminal, or
  pasting an image, types its path at the cursor without pressing Enter
  (#1709).

## Rulings (Todd, 2026-11-01)

1. **Alerts reach the whole workspace**, not only the open project, with
   a state badge on each project row in the project list.
2. **Agent alert toasts are not saved** in the notification history
   (SPEC.md 8.5 gains this exception). The rare usage-limit warning is
   saved.
3. **Claude Code limits.** Portikus sets Claude Code's `statusLine` in
   the managed settings. Its script keeps only the `rate_limits` numbers,
   reports them to the workspace agent, and prints them inside Claude
   Code ("5h 42% · resets 3:00 pm"). A student's own status line is
   replaced.
4. **Codex limits.** The workspace agent briefly runs `codex app-server`
   and calls `account/rateLimits/read`, after a Codex turn and when the
   page asks, at most once every few minutes. Test it on the rehearsal VM
   first. If it disturbs Codex's sign-in or misbehaves, fall back to
   Codex's own footer (`tui.status_line` with `five-hour-limit` and
   `weekly-limit` in the system config), and the status bar says Codex
   does not report limits to Portikus.
5. **Dropped desktop files** go to `.portikus/pastes/<stamp>/<name>` and
   are pruned after 7 days, like pasted images.
6. **API-key students see today's counts** (tokens, and cost where the
   agent reports it) from `agent_usage_days`, for the current UTC day.
   This reverses ADR 0057's "no student usage view" for the current day
   and changes SPEC.md 25.10; the fold records it in a new ADR 0068.
7. **Operating-system notifications are in scope.** A per-user setting
   with three values, `ask` (default), `on`, `off`. The first agent
   alert toast on a page load offers "Turn on desktop notifications" and
   "No thanks" while the setting is `ask`; the browser permission is
   asked only from that click. Settings > Preferences has the same
   switch. A notification fires only when the page is hidden or
   unfocused. Its text is the agent and the state only ("Claude Code
   needs your input"), never project or terminal names, because lab
   computers are shared.

## Design rules every task follows

- **Signals come from the agents' own hooks**, never from guessing at
  terminal output (SPEC.md 10.8). One hook script per state posts
  `{terminal, agent, state}` to the workspace agent's loopback receiver
  on port 7401. It throws its input away unread, has a 1-second limit,
  and always exits 0, so it never blocks the agent.
- **No database migration and no workspace image rebuild.** The
  controller writes the hook and status-line settings at every workspace
  start; the scripts ship in the workspace agent's folder.
- **Nothing logged.** No prompt, tool input, reply, path or terminal
  content is read, sent or logged (STACK.md section 15, ADR 0012). Only
  state words and numbers travel.
- **Agent state travels on the existing listening socket** from the
  workspace agent to the API (`apps/api/src/preview/registry.ts`), then
  to the owner's workspace socket as a `coding-agents` message. The API
  drops any terminal id the database does not hold for that workspace.
  An administrator watching a workspace does not receive it.
- **Forged posts from inside a workspace** change only the student's own
  screen; nothing is stored or enforced. Contracts cap sizes and ranges.
- **File drop refuses control characters.** A path containing a code
  0-31, 127 or 128-159 is refused, and any path with characters outside
  `[A-Za-z0-9._/@%+=:,-]` is single-quoted. A newline is never typed.

## Tasks

Base for wave-zero tasks: 8e37d992. Wave-one tasks start from the epic
head after T1 lands.

| Task | Issue | Owner, model | Files it may touch | Wave |
|---|---|---|---|---|
| T1 Foundation | all | builder, Sonnet high | `packages/contracts/src/coding-agent-status.ts` (new), `packages/contracts/src/index.ts`, `packages/contracts/src/settings.ts`; `packages/events/src/index.ts` (`coding-agents` server message only); `apps/api/src/preview/registry.ts`; `apps/api/src/workspaces/coding-agents.ts` (new); `apps/api/src/routes/ws.ts`; `apps/api/src/routes/agent-meter.ts` (new) and its line in `apps/api/src/server.ts`; `apps/api/src/routes/agent-usage.ts` (`todayUsageFor` only); `apps/api/src/testing/fake-agent/*` | 0 |
| T5 File drop | #1709 | builder, Sonnet high | `apps/web/src/terminal/TerminalLeaf.tsx`, `apps/web/src/terminal/terminalDrop.ts` (new), `apps/web/src/files/queries.ts`, `apps/workspace-agent/src/project-files.ts` | 0 |
| T2 Workspace-agent signals | #1707, #1710 | builder, Opus low | `apps/workspace-agent/**` except `project-files.ts`; `apps/workspace-controller/src/agent-instructions.ts` and its test; the copied settings in `infra/workspace-image/portikus.yaml` | 1 |
| T3 Agent status UI | #1707 | ui-designer, Sonnet | `apps/web/src/useWorkspaceSocket.ts`, `apps/web/src/WorkspacePage.tsx`, `apps/web/src/terminal/codingAgentStatus.ts` (new), `apps/web/src/work/WorkArea.tsx`, `packages/ui/src/overlays/tabs.tsx` and its CSS, `apps/web/src/projects/ProjectPane.tsx` and its CSS | 1 |
| T4 Usage meter | #1710 | ui-designer, Sonnet | `apps/web/src/shell/StatusBar.tsx`, `apps/web/src/agents/useAgentMeter.ts` and `AgentMeter.tsx` (new) | 1 |
| T7 Desktop notifications | #1707 | ui-designer, Sonnet | `apps/web/src/notifications/desktopNotify.ts` (new), `apps/web/src/settings/SettingsDialog.tsx`, `apps/web/src/settings/sections.ts` | 1 |
| T6 Codex limits | #1710 | builder, Opus low | `apps/workspace-agent/src/codex-limits.ts` (new) and its one call in `apps/workspace-agent/src/server.ts`; if the rehearsal test fails, the footer fallback in `apps/workspace-controller/src/agent-instructions.ts` instead | 2 |
| R Rehearsal | #1707, #1710 | infra, Sonnet | none; on the rehearsal VM with real Claude Code and Codex sign-ins: hook states for both agents, Claude limits through the status line, the `codex app-server` test for T6, then the full smoke with a Dex sign-in file | 1-2 |
| F Fold | all | builder, Sonnet | `docs/STATUS.md`; `docs/SPEC.md` sections 8.5, 9.6, 9.7, 10.8, 25.10 and 29; ADR 0057 amendments; new `docs/adr/0068-*.md`; `apps/web/src/help/content/student.tsx`; delete this plan | 3 |

T3 and T7 meet at two functions fixed in both prompts, so they run in
parallel: T7 exports `notifyAgentAlert({agent, state, workspaceId,
projectId, terminalId})` and `PermissionOffer` (the toast actions
element, or null when nothing should be offered); T3 calls both.

Every UI task ships Playwright tests that drive states and limits
through the fake agent's `/__test` hooks from T1.

## Reviews

After every task lands, on a read-only worktree at the epic head:
code-reviewer; security-reviewer (the workspace agent, file uploads and
a new loopback route are SPEC.md section 24 trust boundaries);
a11y-reviewer (tabs, project list, toasts, status bar, settings).

## Blocker

Task R and T6 need a Codex sign-in with a ChatGPT plan on the rehearsal
VM (#1531). Todd signs in once; nothing else in the epic waits on it.

## Left out on purpose

- Reopening the exact tab from a toast or notification in another
  project; they open the project and the unread mark shows the way.
- Unread marks surviving a page reload.
- Per-student usage for instructors and administrators.
- Storing limits on the server, and a threshold setting (80 and 85
  percent stay fixed, as in the status bar meters).
- Counts by the student's local day; the data is stored by UTC day.
- Per-pane state inside split tabs; a tab shows its most urgent pane.
- The element picker (#1708), which gets its own epic and will reuse the
  drop folder.
