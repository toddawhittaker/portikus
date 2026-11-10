# Epic 60: documentation refresh

Branch `epic/60-docs`, cut from main `154ac77f`. Milestone 11. This plan is
deleted by the fold task.

## Goal

The README, the student guide, the administrator guide, a new instructor
guide, and the in-app Help pages describe Portikus as it is after Epic 59,
with new screenshots. The guides stop at Epic 25 today; Epics 48 to 59
added the GUI chat tab, agent and subagent rows, plan-usage meters, code
help, live help, course profiles and the phone layout.

## Rulings (2026-11-10)

1. **Screenshots:** a committed Playwright capture script, run against the
   end-to-end test stack with the fake agent and seeded data, makes every
   image. A few chat and meter images are then replaced with captures from
   the pilot with real agents, at the same file names.
2. **Help and the guides:** Help (`apps/web/src/help/content/*.tsx`) stays
   the source of truth. It is updated first, then the guides are rewritten
   to match it. Nothing new checks that they match.
3. **README:** written for evaluators first (a teacher or department lead):
   what Portikus is, a screenshot tour, the supported agents and
   interfaces, then short Install and Develop sections that link to
   INSTALL.md and WORKFLOW.md.
4. **Scope:** a new `docs/INSTRUCTOR-GUIDE.md` takes the instructor
   material out of ADMIN-GUIDE.md, matching the instructor Help page.
   INSTALL.md and OPERATIONS.md get an accuracy pass only.

## Facts every writer uses

- Agents: Claude Code and Codex (`apps/web/src/agents/codingAgentName.ts`).
  Claude Code runs as a TUI (text interface) in a terminal tab or as the
  GUI chat tab; Codex runs in a terminal tab. The New tab menu offers
  Terminal, Claude Code (TUI), Claude Code (GUI) and Codex
  (`apps/web/src/work/LauncherItems.tsx`).
- Right pane: Files, Checks, Running, Monitor and Problems.
- Traditional course profiles hide the agent launchers.

## Screenshot list

Light theme, 1440 by 900, reduced to 256 colours, in `docs/images/`.
Existing names are kept when the subject is the same. "Pilot" marks the
images task T3 replaces with real-agent captures.

| Image | Shows | Source |
|---|---|---|
| student-shell.png, student-shell-dark.png | Workspace with agent rows, five right-pane tabs, status bar meters | script |
| student-new-tab-menu.png (new) | The four launch choices | script |
| student-chat.png (new) | A GUI chat conversation with a tool group and a permission card | pilot |
| student-chat-composer.png (new) | The model and mode pickers and the `/` menu | pilot |
| student-chat-shell.png (new) | A `!` command shown as a Shell group | script |
| student-agent-rows.png (new) | The left pane with agent and subagent rows and status marks | pilot |
| student-agent-meter.png (new) | The plan-usage popover | pilot |
| student-editor.png | The editor with the code-help status | script |
| student-code-help.png (new) | A completion or hover, and the Problems tab | script |
| student-new-project.png, student-checks.png, student-starting.png, student-error.png, student-running-preview.png, student-settings.png | As today, current look | script |
| student-live-help.png (new) | The student's live-help bar | script |
| student-phone.png (new) | The narrow layout with a drawer open (390 by 844) | script |
| help-page.png | The Help page with the current topic list | script |
| instructor-course.png | Course page with the profile control and Live help link | script |
| instructor-live-help.png (new) | The instructor's live-help session page | script |
| admin-users.png, admin-backups.png, admin-settings.png, admin-health.png, admin-logs.png, admin-audit.png, admin-network.png, admin-certificate.png, admin-intro-toggletip.png | As today, current look | script |
| admin-sign-in.png (new) | The sign-in settings (Google groups, Entra) | script |

An image no document references after T4 and T5 is deleted by the fold.

## Tasks

| Task | Owner, model | Files | Closes | Starts after |
|---|---|---|---|---|
| T1 Help content | builder, Opus low | `apps/web/src/help/content/*.tsx` and their tests, `e2e/help.spec.ts` | | none |
| T2 Capture script | tester, Opus low | new `e2e/screenshots/` (own Playwright config and seed), `playwright.config.ts` (ignore that folder only), `Makefile` (a `screenshots` target), `docs/images/*.png` | | none; re-run its capture after T1 for help-page.png |
| T3 Pilot captures | general, Opus low; the only task that may use the pilot | the four "pilot" images in `docs/images/` | | T2 |
| T4a Student guide | builder, Opus low | `docs/STUDENT-GUIDE.md` | | T1, T2 |
| T4b Admin and instructor guides | builder, Opus low | `docs/ADMIN-GUIDE.md`, new `docs/INSTRUCTOR-GUIDE.md` | | T1, T2 |
| T5 README | builder, Opus low | `README.md` (including a link to the instructor guide) | | T1, T2 |
| T6 Install and operations pass | builder, Sonnet high | `docs/INSTALL.md`, `docs/OPERATIONS.md` | | none |
| T7 Fold | orchestrator | `docs/STATUS.md`, this plan (deleted), unreferenced images | | all |

Waves, for reading only: T1, T2 and T6 first; then T3, T4a, T4b and T5.

### What each task delivers

- **T1:** Help covers agent and subagent rows, the seven-day plan meter,
  the phone drawers and the four launch choices ("Getting started" still
  says "Start Claude Code"). Each new topic gets an anchor that
  `e2e/help.spec.ts` checks.
- **T2:** `make screenshots` starts the end-to-end stack, seeds students,
  a course, health samples, audit rows, backups and fake agent events,
  and writes every "script" image. It never runs in CI and never touches
  a real database. The images are committed.
- **T3:** the four pilot images, captured from a real Claude Code session
  on the pilot, at the same size and colour depth. Before committing,
  check each image for real names, email addresses, tokens and account
  details, and blur or re-shoot any that show them.
- **T4a, T4b:** guides rewritten from the T1 Help text, with the new
  images. The instructor guide covers courses, the Agentic and
  Traditional profile, live help, roster sync, Deep Linking, agent usage
  and shared projects. ADMIN-GUIDE.md links to it instead of holding that
  material. The admin guide adds invitations and CSV import, selecting
  several backups, and the 365-day audit retention.
- **T5:** README per ruling 3. The Status section points to STATUS.md
  rather than naming the last epic.
- **T6:** INSTALL.md and OPERATIONS.md checked against the code for
  Epics 50 and 54 to 57 (sign-in, backups, audit retention, the LTI
  platforms file); fix only what is wrong.

## Reviews

- code-reviewer: T2's script, and the accuracy of every doc against the
  code.
- a11y-reviewer: T1's Help changes.
- Security review is not needed; T3's privacy check is part of its done.

## Left out

- Generating the guides from Help, or a check that they match (ruling 2).
- A full rewrite of INSTALL.md and OPERATIONS.md (ruling 4).
- Video or animated captures.
