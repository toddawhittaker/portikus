# Epic 65: fix batch with editor colour schemes

Branch `epic/65-fix-batch`, cut 2026-11-13 from main `2115e96c`.
Milestone "Epic 65 fix batch". Todd approved this plan in chat on
2026-11-13.

## Issues

| Issue | What |
|---|---|
| #1959 | `design/README.md` misdescribes what `portikus-console.css` is built from |
| #1955 | Health: a worker that has never reported shows as "Controller not reachable" |
| #1944 | Announce a terminal question to screen readers when focus is in another pane |
| #1948 | More file icons: database, binary, slides, log, and mapping gaps |
| #1961 | Editor colour schemes: VS Code, IntelliJ, GitHub, Solarized, Catppuccin and high contrast, in light and dark |

Left out: #1801 (Haiku and mid-turn messages), #1829 (no Monaco release
bundles the fixed DOMPurify yet), #1263 (install test against the previous
version), and the feature-sized issues.

## Rulings

1. #1961 (Todd): the current editor scheme becomes Portikus Light and
   Portikus Dark, the default. It is the only scheme held to the 4.5:1
   contrast test of SPEC.md section 25.8. Every reference scheme is copied
   exactly as published, with no colour adjusted; a student who picks one
   with weaker contrast has chosen that.
2. #1961 (Todd): the reference schemes keep their published hues, purple
   keywords included. The violet rule of DESIGN.md section 11 covers the
   app's own interface, not a syntax scheme a student picks.
3. #1961: a scheme is a light-and-dark pair that follows the page
   appearance. The setting is `editorScheme` in `EditorSettings`, stored
   with the other editor settings (no migration: stored settings are JSON
   and missing fields take their defaults). Every scheme keeps the
   Portikus colours for the scrollbar's Git and problem marks
   (`editorOverviewRuler.*`). A colour a reference scheme does not define
   falls back to Monaco's base theme for that mode, not to Portikus.
4. #1961 is split: T5a builds the setting, the Settings control, the scheme
   format and switching, with Portikus and the VS Code pair as the first two
   schemes; T5b adds the other five reference pairs in that format.

## Tasks

No two tasks edit the same file. A task starts as soon as the PRs it
starts after have merged.

| Task | Issue | Owner, model | Files | Starts after |
|---|---|---|---|---|
| T1 | #1959 | builder, Haiku | `design/README.md` | none |
| T2 | #1955 | builder, Sonnet | `apps/api/src/routes/admin-health.ts` and test; the admin health contract in `packages/contracts/src`; `apps/web/src/admin/health/**`; the rail badge and status bar code that reads attention items; `e2e/admin-health*.spec.ts` | none |
| T3 | #1944 | builder, Sonnet | `apps/web/src/terminal/codingAgentStatus.ts`, `useCodingAgentAlerts.tsx`, `TerminalQuestion.tsx` and their tests; `apps/web/src/work/WorkArea.tsx`; `e2e/terminal-question.spec.ts` | none |
| T4 | #1948 | ui-designer, Opus | `packages/ui/src/primitives/Icon.tsx`, `apps/web/src/files/fileIcon.ts` and test, `apps/web/src/files/files.css`, `design/system/components/Icon/**`, `e2e/files-icons.spec.ts` | none |
| T5a | #1961 | builder, Sonnet | `packages/contracts/src/settings.ts` and test; `apps/api/src/users/editor-settings.ts` and test; `apps/web/src/settings/**`; `apps/web/src/editor/monaco.ts`, `tokenColours.ts` and test; new `apps/web/src/editor/schemes/`; new `e2e/editor-schemes.spec.ts`; `docs/DESIGN.md` section 11 | none |
| T5b | #1961 | builder, Sonnet | new files in `apps/web/src/editor/schemes/`; the scheme list in `packages/contracts/src/settings.ts`; `e2e/editor-schemes.spec.ts`; third-party notices | T5a |
| D | all | orchestrator | `docs/STATUS.md`, `docs/SPEC.md` (section 29 entry, section 13.1 scheme rule), delete this plan | every task and the fix round |

## Reviews

code-reviewer over the whole epic; a11y-reviewer over T3, T4 and T5a; a
light security-reviewer pass, since no task crosses a SPEC.md section 24
boundary.
