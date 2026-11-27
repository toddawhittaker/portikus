# Epic 77: fix batch after Epic 76

Branch `epic/77-fix-batch`, base commit `efe519be` (main after Epic 76).
Scope: GitHub issues #2214, #2219, #2196, #1829 and #1263, and the
release number in the lab reply. This file goes away at the fold.

## Rulings that apply

- **The batch (Todd, 2026-11-26).** The iPad space bar first, plus the
  small items ready now. #1240 (preview ticket binding) and feature
  issues stay out.
- **#2214 fix (orchestrator).** The likely cause is that xterm 6.0.0
  does not cancel Space on keydown (its key code is below 48), so iPad
  Safari scrolls the page. The terminal's custom key handler claims
  plain Space when not composing: `preventDefault()`, send one space
  with `term.input(" ", true)`, return false, and swallow the matching
  keypress so no second space is typed. Ctrl+Space still sends NUL;
  Space during composition (`isComposing` or key code 229) is left to
  the input method. The focus fallback (focus the textarea on
  pointerdown) is added only if Todd reports that letters do not type
  either.
- **#1263 (orchestrator).** Run on the rehearsal VM: install the
  published 0.1.1910, then roll back with `PORTIKUS_VERSION=0.1.1887`
  through the existing rollback path (infra/README.md, "rollback";
  `infra/tests/rebuild-exercise.sh` `PREVIOUS_VERSION`), smoke test,
  then upgrade back. Code changes only if the run finds a fault.

## Facts checked

- `apps/web/src/terminal/useXterm.ts` lines 528 to 549 hold
  `attachCustomKeyEventHandler`; nothing there handles Space.
- `apps/api/src/routes/recovery.ts`: restore's pending-operation refusal
  records a failed operation; recovery-point create's refusal (FR8,
  #2218) releases its claim and records none.
- `packages/ui/src/overlays/dialog.tsx` line 36 finds a menu's trigger
  through `aria-labelledby`; `apps/web/src/preview/pick/PickControl.tsx`
  holds the pick menu.
- monaco-editor 0.58.0 bundles DOMPurify 3.4.17 (checked in the packed
  tarball, `esm/vs/base/browser/dompurify/dompurify.js`).
- Published releases 0.1.1887 and 0.1.1910 both exist.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 space bar | builder, Opus low | local | `apps/web/src/terminal/useXterm.ts`, its unit tests, `e2e/terminal.spec.ts` | #2214 | none | yes: Space is claimed (default prevented) and types one space; Ctrl+Space sends NUL; composing Space is left alone |
| T2 restore refusal | builder, Sonnet high | desk | `apps/api/src/routes/recovery.ts`, its unit tests | #2219 | none | no (API only; the existing `e2e/recovery.spec.ts` must stay green) |
| T3 pick menu name | builder, Sonnet high | pve | `packages/ui/src/overlays/menu.tsx`, `packages/ui/src/overlays/dialog.tsx`, their unit tests, `apps/web/src/preview/pick/PickControl.tsx`, `PickControl.test.tsx`, `e2e/preview-pick.spec.ts` | #2196 | none | yes: the menu's accessible name is "Send the picked element to"; `e2e/preview.spec.ts` "resetting preview data" focus return still passes |
| T4 Monaco | builder, Sonnet high | desk | `apps/web/package.json`, `pnpm-lock.yaml` | #1829 | none | yes: run the editor specs (`editor*.spec.ts`) unchanged |
| T5 version pin | infra, Opus low | local | the rehearsal VM; `infra/` only if the run finds a fault | #1263 | none | no |
| T6 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` (section 29 entry, and any line stating the old behavior), `docs/deployments/kitestring-lab-reply.md` (release 0.1.1910), delete this plan | all five | T1 to T5 | no |

T1 to T5 run at once in one wave. T6 is drafted while the reviews run.

## Reviews

- code-reviewer over the epic head, always.
- a11y-reviewer for T1 and T3 (`apps/web`, `packages/ui`).
- No security review: nothing touches a trust boundary in SPEC.md
  section 24. Monaco's sanitizer change is the upstream DOMPurify fix.

## After the merge (Todd)

Roll VM 140 back to its clean snapshot and install the release with
this batch. Then one iPad session of about 15 minutes: Space with the
hardware and the on-screen keyboard; the "Preview blocked by your
browser" message; and the #1260 VoiceOver pass over summary headings.
