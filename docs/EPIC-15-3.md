# Epic 15.3 — Pilot fix batch

Plan for the fix batch after Epic 15.2. It lives only on
`epic/15-3-pilot-fixes` and is folded into SPEC.md and deleted by the
last task (WORKFLOW.md, "Epic plans"). Where this file is silent,
SPEC.md wins on behavior and STACK.md on technology.

Scope is the five open issues in the "Pilot fixes (next fix batch)"
milestone. Nothing else.

## Rulings (Todd, 2026-09-30)

1. **#887, agent restart on upgrade.** The workspace controller does it
   when it starts (it restarts on every package upgrade). It restarts
   `portikus-workspace-agent.service` in each running workspace whose
   agent started before the installed package's agent files changed.
   Workspaces on images older than 2026.09.11 are skipped and logged,
   because an agent restart there ends their terminals (SPEC.md 9.7).
   Students whose agent was restarted see a toast saying the workspace
   has been upgraded.
2. **#886, clean terminal for coding agents.** Portikus launchers clear
   the terminal before starting the CLI. For `claude` and `codex` typed
   by hand, shell functions in the image's default bash profile run
   `clear` and then the real command. This needs a new workspace image,
   2026.09.15, which a merge to main publishes.
3. **Test hosts.** Agents may use the rehearsal VM and the pilot. The
   epic build may be installed on the pilot.

## Tasks

| Task | Issue | What | Agent | Main area |
|---|---|---|---|---|
| T1 | #883 | Clone name drops emoji and pictographs | builder | `packages/contracts` |
| T2 | #885 | Remove pastes older than 7 days on the next paste | builder | `apps/workspace-agent` paste code |
| T3 | #881 | Rebuild and Reset Docker show progress in Admin | ui-designer | `apps/web/src/admin`, API if needed |
| T4 | #886 | Launchers and shell functions clear before agents start | infra | image profile, launcher code |
| T5 | #887 | Controller restarts old agents at start; student toast | builder | `apps/workspace-controller`, student toast |
| V | — | Install epic head on the pilot, image 2026.09.15, smoke | infra | host only |
| F | — | Fold: SPEC, STATUS, BACKLOG; delete this plan | builder | `docs/` |

Each task follows its issue's "Done when" list: unit tests for logic,
Playwright tests for anything a student or administrator sees. Task
pull requests do not edit `docs/STATUS.md`; each puts its STATUS line
in its pull request body. Tasks may update the SPEC.md section their
issue names.

After T1-T5 land: code-reviewer over the epic head, security-reviewer
(T5 touches the controller and Incus exec; T4 the image), a11y-reviewer
(T3, T5 toast). Fixes land as further task pull requests, then
confirmation reviews, then V, then F, then the epic pull request.
