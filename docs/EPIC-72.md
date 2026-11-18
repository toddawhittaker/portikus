# Epic 72: small fixes batch

Branch `epic/72-small-fixes`, base commit `2a90e08d` (main after
Epic 71). Scope: GitHub issues #2129, #2109, #2140 and #2141. This file
goes away at the fold.

## Rulings that apply (Todd, 2026-11-18)

- The batch is option 1 from the post-Epic 71 review: small fixes and
  quick wins before the next feature epic (#2070).
- **#2129 test alert.** A new "Send a test site alert" button in the
  Explain alerts group of the AI settings page. The per-channel "Send
  test" buttons on the Notifications page stay as they are.
- **#2109 Playwright load (orchestrator ruling).** Agent instructions
  only. No course template or new-project scaffold ships a
  `playwright.config.ts` today, and the platform must not edit files in
  a student's existing project, so there is nothing else to change.

## Facts checked

- `POST /admin/alerts/test` (`apps/api/src/routes/admin-alerts.ts`)
  calls `sendAlert` straight to the channels and writes no notification,
  so the worker's forwarder never repeats it. Real alerts are written by
  `notifyAdministrators` (`packages/db/src/index.ts`). The worker's
  forwarder (`apps/worker/src/alerts.ts`) sends each new site-alert row
  once to every channel and, when forwarding is on, waits for the
  explanation that `apps/api/src/triage/run.ts` stores on the row.
  Both the forwarder's flood control and triage's hourly limit count by
  alert title.
- `apps/workspace-agent/agent-instructions.md` is written to
  `/etc/claude-code/CLAUDE.md` and Codex's managed config at every start
  (`apps/workspace-controller/src/agent-instructions.ts`). It says
  nothing about Playwright. It is read into every student session, so
  each line costs students' agent usage.
- `supersedeAccountEmailTokens` (`apps/api/src/account-email/tokens.ts`)
  revokes only rows with `created_at` strictly earlier than the kept
  row's, so two links made in the same millisecond never revoke each
  other.
- The Dex remove route (`apps/api/src/routes/admin-dex-users.ts`) calls
  `dex.deletePassword` inside `disableUser`'s `alsoInTransaction`
  callback, before the commit. `disableUser` accepts an already
  disabled user, so pressing Remove again after a Dex failure reaches
  Dex again.

## Design

- **#2129.** A new route, `POST /admin/alerts/test-site-alert`
  (administrator only, sharing the existing per-administrator test-alert
  limit), calls `notifyAdministrators` with tone `warning`, a title that
  says it is a test and carries the time to the second (so neither the
  forwarder's flood control nor triage's per-title limit hides a second
  test), and a short body. It writes a `settings.alert_tested` audit row
  that names this kind. The route goes in `route-policy.ts` and the
  operation catalog beside `alerts.send_test`, with its contract in
  `packages/contracts`. The web button sits in `TriageGroup.tsx` and says
  what will happen: a test alert in the notifications list, explained if
  Explain alerts is on, and forwarded to the alert channels like a real
  one. It reports success or the rate-limit refusal inline.
- **#2109.** Two or three short lines in `agent-instructions.md`: run
  only the Playwright specs for what you changed, with `--workers=2`,
  and run the full suite only when the student asks or before they
  submit. The controller test pins that the lines are present.
- **#2140.** The supersede query also revokes a row whose `created_at`
  equals the kept row's when its `id` is lower, so of any tied links
  exactly one (the highest id) stays valid, whichever supersede runs
  first.
- **#2141.** Access ends before Dex is touched, the order the
  email-change path already uses (`apps/api/src/admin/dex-user-edit.ts`).
  Disable, the audit row and key revocation commit first. The Dex
  password is deleted after the commit. A Dex failure after the commit
  returns the existing Dex-unavailable error, and the account stays
  disabled and cannot sign in. Pressing Remove again finishes the job.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 test site alert | builder, Opus medium | local | `apps/api/src/routes/admin-alerts.ts`, `apps/api/src/route-policy.ts`, `apps/api/src/rate-limit.ts` if needed, `apps/api/src/catalog/families/people.ts`, `packages/contracts/src/alerts.ts`, `apps/web/src/admin/ai/TriageGroup.tsx`, `apps/web/src/admin/ai/queries.ts`, their unit tests, `e2e/admin-ai-triage.spec.ts` | #2129 | none | yes |
| T2 Playwright lines | builder, Sonnet high | desk | `apps/workspace-agent/agent-instructions.md`, `apps/workspace-controller/src/agent-instructions.test.ts` | #2109 | none | no |
| T3 sign-in fixes | builder, Sonnet high | pve | `apps/api/src/account-email/tokens.ts`, `apps/api/src/routes/admin-dex-users.ts`, `apps/api/src/admin/users.ts` only if needed, their unit tests | #2140, #2141 | none | no (no visible change) |
| T4 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` (section 29 entry; section 20.5 note on the test site alert; the agent-instructions note in section 4 if it lists their content), delete this plan | all four | T1 to T3 | no |

T1 to T3 run at once in one wave. T4 is drafted while the reviews run.

## Reviews

- code-reviewer over the epic head, always.
- security-reviewer for T1 (a new administrator route and audit row)
  and T3 (sign-in links and account removal, SPEC.md section 24).
- a11y-reviewer for T1's new button.

## Rehearsal

None. Nothing touches install, packaging or infrastructure. T2 changes
a file the package ships, but not how it is installed.
