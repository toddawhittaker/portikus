# Epic 67: fix batch (usage savings, zoom, check history, OpenAPI)

Branch `epic/67-fix-batch`, cut from main `e304c259`. A fix batch, so no
architect pass. The run goes through without a stop for plan approval,
then deploys the epic head to the pilot and measures the savings (Todd,
2026-11-14). Todd merges the epic PR into main.

## Rulings (Todd, 2026-11-14)

1. #2019 (compact at 200k) is dropped and closed: the fresh-chat estimate
   and automatic handoff from #2015 cover it.
2. #2020: seed the starting model and effort into the student's
   `~/.claude/settings.json` once, only when the student has not set them.
   Not managed settings, so a student's own default still wins.
3. #1652: build only HTML, CSS and JSON (Monaco's in-browser workers).
   Java, C/C++ and SQL stay open in the issue.
4. #2024: option B, zoom kept in the student's per-user settings on the
   server (decided in the issue).
5. #2011: the timer is off by default on a new site and turned on for the
   pilot at deploy time.

## Tasks

Migration numbers are preassigned: T8 uses 0055; T5 and T6 use 0056 and
0057 only if they need one (stored settings may already be JSON).

| Task | Issues | Owner, model | Files it may touch | Starts after |
|---|---|---|---|---|
| T1 | #2020, #2021 | builder, Opus low | `apps/workspace-controller/src/agent-instructions.ts` and the code that runs it at workspace start, their tests, SPEC 10.2, 10.3 | — |
| T2 | #2017 | infra, Opus low | the Codex config block of `infra/workspace-image/portikus.yaml`, image tests, SPEC and STACK Codex config notes | — |
| T3 | #2023 | builder, Sonnet high | `apps/workspace-agent/src/chat/shell-command.ts`, its tests, SPEC 10.2 | — |
| T4 | #2022 | builder, Sonnet high | `apps/web/src/chat/ComposerPickers.tsx` and new chat files beside it, e2e chat specs, SPEC 10.2 | — |
| T5 | #2024 | builder, Opus low | `packages/contracts/src/settings.ts`, the API settings route, `apps/web/src/layout/paneZoom.ts`, `store.ts`, `terminal/useXterm.ts`, `editor/useFileZoom.ts`, `editor/zoom.ts`, e2e zoom specs, SPEC 7.5, 13.1 | — |
| T6 | #2011 | builder, Opus low | the coding-agents update job and daily check (API or worker), the admin Workspace image tab, image-job unit or timer under `packaging/`, e2e admin image specs, SPEC 22.4, 22.6 | — |
| T7 | #1972 | tester, Opus low | `e2e/code-help.spec.ts` and the test helpers it uses | — |
| T8 | #1237 | builder, Opus low | migration 0055, `packages/db` schema, a new API route and contract file, the workspace agent's check runner, the Checks pane, e2e checks specs, SPEC 25 | — |
| T9 | #1801 | builder, Opus low | `apps/workspace-agent/package.json`, `pnpm-lock.yaml`, chat host code only if the upgrade needs it, chat Help text | — |
| T10 | #1652 (part) | builder, Opus low | `apps/web/src/editor/features.ts`, the Vite config, editor worker setup, e2e code-help specs (after T7), SPEC 13.6 | T7 |
| T11 | #1221 | builder, Opus low | `packages/contracts` build and route schemas, a new CI step, `pnpm-lock.yaml` | T5, T8, T9 |
| T12 | fold | orchestrator | `docs/STATUS.md`, SPEC 29, this plan (deleted) | all |

Waves (only a way to read the table): one is T1 to T9; two is T10 and
T11; then reviews (code, security for T5, T6 and T8, accessibility for
T4, T5, T8 and T10), a fix round, a full smoke test on the rehearsal VM
(T2 and T6 change the image and packaging), the fold, the epic PR, and
the pilot deploy with measurements.

## Left out

#1829 (no newer Monaco), #2018 and #1708 (need design first), #627 (needs
a free-text ruling), Java and C/C++ from #1652 (need measuring), and the
infrastructure and research issues.
