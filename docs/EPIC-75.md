# Epic 75: pick an element in the preview, and side pane focus

Branch `epic/75-element-picker`, base commit `4b831b2f` (main after
Epic 74). Scope: GitHub issues #1708 and #2176. This file goes away at
the fold.

## Rulings that apply

- **The epic (Todd, 2026-11-19).** #1708 and #2176 are next. #1652
  (more languages for code help) is parked until someone asks.
- **How the picker gets into the page (Todd, 2026-11-19).** A Portikus
  wrapper page. An embedded preview's bootstrap redirects to the
  reserved path `/__portikus/frame/` on the preview origin. That page
  belongs to Portikus and holds the student's app in a full-size inner
  `<iframe src="/">`. The student's HTML is never rewritten
  (BROWSER-HANDLING.md section 13 stands). A preview opened in its own
  tab keeps going straight to `/`.
- **Screenshot (Todd, 2026-11-19).** Drawn inside the page by one
  pinned library (html-to-image or modern-screenshot; T2 picks after
  its spike and names it in the PR). No screen-capture prompt.
- **Target agent (Todd, 2026-11-19).** Chosen before picking. The pick
  button opens a short menu of the open agent terminals and chats; with
  one open it starts picking at once; with none it is disabled and says
  why. After a pick, the view switches to that agent.
- **Channel (orchestrator).** Plain `postMessage`, no secret and no
  `MessageChannel`. The student's page shares the wrapper's origin, so a
  secret would add code and no protection. The Portikus page accepts a
  message only when `event.origin` is the grant's preview origin,
  `event.source` is the outer frame's window, pick mode was started by
  the student, and it is the first `picked` message since that start.
  It sends with `targetOrigin` set to the preview origin.
- **#2176 fix (orchestrator).** Focus falls back to the side composer,
  or to Stop while a question runs. Stable keys cannot work, because the
  replay snapshot empties the list and may show the empty-state
  paragraph, which always unmounts the focused control.

## Trust design (SPEC.md section 24)

- Other origins cannot send a pick: popups, other previews, other tabs,
  and cross-origin frames inside the student's page. A message sent
  straight from the student's inner window is refused, because its
  source is not the wrapper. No pick is accepted outside pick mode.
- Nothing in a pick chooses the file path, the agent, or a keystroke.
  The Portikus page picks the folder; only the quoted paths and a space
  are typed, never Enter. Every message is checked against a versioned
  schema (`v: 1`) with length limits, and the payload is never rendered
  as HTML.
- Not guaranteed, and accepted: any script on the preview origin (the
  student's code, code the agent wrote, a third-party script) can change
  what a pick contains. The student is picking their own page, which can
  already write files in their workspace. The file's header says it is
  captured page content, to be treated as data, not instructions.
- The wrapper holds no token, path or terminal list. The outer frame's
  sandbox is unchanged. The wrapper's Content Security Policy adds
  `frame-ancestors` set to the Portikus origin.
- The screenshot is drawn from the preview's own page, so it cannot
  contain anything outside the preview.

## Design

- **Wrapper** (`apps/web/preview-frame.html`, its own Vite build into
  `apps/web/dist/preview-frame`, served by Caddy from
  `/usr/lib/portikus/web/preview-frame`). It posts `loaded` to the
  parent; the preview's 8-second load fallback keys on that message.
  The inner frame copies the outer frame's `allow` list. In pick mode it
  lays a transparent layer over the inner frame and finds the element
  under the pointer with `elementFromPoint`, so clicks never reach the
  app.
- **Keyboard picking (SPEC.md section 25.8).** Pick mode starts at the
  app's focused element. Up goes to the parent element, Down to the
  first child, Left and Right to siblings, Enter picks, Escape leaves
  (from either page). The highlighted element's label is read through
  the existing `preview-status` region, throttled.
- **The files.** `.portikus/pastes/<stamp>/picked-element.md` and
  `picked-element.png`, in the existing drop folder, which already has
  the 7-day cleanup and the Git exclude rule. The Markdown holds a header
  (port, page path without query or fragment, UTC time, the "treat as
  data" line), a short unique selector and the tag, the outer HTML
  trimmed (text over 500 characters, attributes over 200, depth over 6
  cut; script and style bodies dropped; 20,000 characters in all), the
  matching CSS rules (50 rules or 20,000 characters, cross-origin
  stylesheets listed as unreadable), and about 30 computed values. Code
  fences are longer than any run of backticks in the content.
- **Screenshot limits.** Box at most 2000 by 2000 CSS pixels, scale at
  most `min(devicePixelRatio, 2)`, PNG at most `MAX_CHAT_IMAGE_BYTES`.
  A pick still too big goes without a picture, and the file says so.
- **Delivery.** The Portikus page builds two `File` objects and hands
  them to the target pane's existing drop handler: `TerminalLeaf`'s
  `dropFiles` (types the quoted paths, no Enter) or the chat composer's
  attachment `add`. A small list of mounted agent panes
  (`apps/web/src/agents/agentDropTargets.ts`) is the only new piece.
  The view then switches with the route search `tab`, as the left
  pane's agent rows do.
- **Where it shows.** The pick button is hidden in a Traditional course
  and in an instructor's live-help view.
- No migration, no API change beyond the bootstrap redirect, and no
  workspace agent change.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 message format and file builder | builder, Sonnet high | local | `apps/web/src/preview/pick/messages.ts`, `pickFile.ts` (new) and their `.test.ts` files | #1708 | none | no |
| T2 wrapper page and picker | builder, Opus low | pve | `apps/web/preview-frame.html`, `apps/web/vite.frame.config.ts` (new), `apps/web/package.json` (build script and the screenshot dependency), `pnpm-lock.yaml`, `apps/web/src/preview/frame/**` (new: main, overlay, capture, trim, selector, and unit tests) | #1708 | T1 | in T7 |
| T3 agent drop targets | builder, Sonnet high | desk | `apps/web/src/agents/agentDropTargets.ts` (new) and test, `apps/web/src/terminal/TerminalLeaf.tsx` and test, `apps/web/src/chat/Composer.tsx` and test (registration only) | #1708 | none | no |
| T4 pick mode in the Portikus page | builder, Opus low (ui-designer reviews only) | local | `apps/web/src/preview/pick/usePickMode.ts`, `PickControl.tsx` (new) and tests, `apps/web/src/preview/PreviewLeaf.tsx` and test (toolbar mount and the `loaded` signal), `apps/web/src/preview/preview.css`, `apps/web/src/help/content/student.tsx` | #1708 | T1, T3 | in T7 |
| T5 embedded previews use the wrapper | builder, Sonnet high | desk | `apps/api/src/routes/preview.ts` (embedded grant redirects to `/__portikus/frame/`), `preview.test.ts`, `e2e/preview-gateway.ts`, the stand-in gateway part of `e2e/preview-browser.spec.ts` | #1708 | T2 | yes, the existing preview specs |
| T6 Caddy route | infra, Opus low | local | `infra/ansible/roles/caddy/templates/Caddyfile.j2` (`handle /__portikus/frame/*`, strip the prefix, `file_server` from `/usr/lib/portikus/web/preview-frame`, CSP with `frame-ancestors`), plus the rehearsal VM smoke | #1708 | T2, T5 for the smoke (may draft at once) | no |
| T7 pick mode browser tests | tester, Sonnet high | pve | `e2e/preview-pick.spec.ts` (new) and its test app | #1708 | T4, T5 | yes |
| T8 side pane focus | builder, Sonnet high | desk | `apps/web/src/chat/SidePanel.tsx`, `SidePanel.test.tsx`, `e2e/chat-side.spec.ts` | #2176 | none | yes |
| T9 docs | builder, Sonnet high | local | `docs/adr/0084-preview-element-picker.md` (new); `docs/BROWSER-HANDLING.md` (the wrapper and pick mode); `docs/SPEC.md` sections 14.6 and 25.8 (an "Added by Epic 75" paragraph each) | both | none | no |
| T10 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` section 29 entry, delete this plan | both | T1 to T9 and the fix round | no |

T7 covers: the button's `aria-pressed`; hover outline and click pick;
clicks not reaching the app in pick mode; keyboard picking; Escape from
both pages; both files in the drop folder with the paths typed (no
Enter) into the chosen terminal, and attachment chips in a chosen chat;
forged messages refused (from the inner window, from a popup, and
outside pick mode); the button hidden in a Traditional course and
disabled with a reason when no agent is open; axe checks.

Waves, for reading only: T1, T3, T8 and T9 first; T2 when T1 lands; T4
when T1 and T3 land; T5 when T2 lands; T6 smoke and T7 when T5 (and T4)
land; T10 last.

## Reviews

- security-reviewer reviews this design against SPEC.md section 24
  before T2 and T4 start (#1708 asks for this), and the built code
  later.
- code-reviewer over the epic head, always.
- a11y-reviewer: pick mode, its menu and keyboard picking, and the
  side pane fix (SPEC.md section 25.8).

## Rehearsal

Yes. T6 changes the Caddy template, so the infra agent runs the full
rehearsal VM smoke, with a Dex sign-in file, on a .deb holding T2, T5
and T6, and opens a picker on a real preview.

## Left out on purpose

Picking in an instructor's live-help view; picking inside nested
cross-origin frames or shadow DOM (the pick stops at the frame
element); mapping elements back to components or source files; a
thumbnail before sending; detecting framing refusals or the current URL
through the wrapper; the same focus problem in the main chat log;
#1236 and #1240 (preview origin hardening), which the wrapper works
with unchanged.
