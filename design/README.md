# Design files

This directory mirrors the two Claude Design artifacts that hold the Portikus
visual design. The files here are a copy for reading and reference; the
artifacts remain the place where the design is edited. `docs/DESIGN.md`
explains the design itself and how engineering picks it up.

## The artifacts and these files are in sync

On 2026-11-11 both artifacts were re-published from these files with the
November 2026 look: warm ivory and charcoal surfaces, teal for actions and
selection, a violet agent hue, one `Badge` for every status, the 12, 14, 16,
20 and 24px type scale, and the redrawn portico mark. The blob identifiers in
`design-system.json` name the logo uploads of that publish.

On 2026-11-12 (Epic 64) both artifacts were re-published again from these
files, which had taken in the administrator and instructor redesign:

- `system/tokens.json` has the new `accent-fill`, `accent-fill-hover`,
  `accent-fill-active`, `on-accent-fill` and `danger-fill` tokens and the
  changed dark accent, muted and faint ink, light warning and dark danger
  values, all checked against `packages/ui/src/theme.css`.
- `system/README.md` gains the rules for filled buttons (one filled primary
  per page; white on deep teal in dark), quiet states with badges kept for
  exceptions, the console's type levels (28px titles, 18px sections, the
  11px overline), tables as reading surfaces, faded disabled buttons, filter
  chips, the segmented control, the sticky save bar, the text measure, 44px
  phone targets, and the administrator and course page frame.
- `system/components/` has nine new components for the console's patterns:
  PageFrame, Inspector, AttentionStrip, StatusDots, SegmentedControl,
  MoreMenu, SaveBar, FilterChips and TableBox. They live in `apps/web`, not
  `packages/ui`, so each preview is markup with the app's real classes and
  carries the app's rules for them in its own `style` element. Button,
  StateBadge, Badge, Dialog, Icon, Checkbox, Table, Tabs and Menu have updated
  READMEs or previews. A card is registered by the `@dsCard` comment on the
  first line of its `preview.html`; `design-system.json` lists no components.
- `system/components/bundle.css`, `bundle.js` and `index.d.ts`, and the canvas
  copy of `bundle.js`, are rebuilt from `packages/ui` the way pull request
  #1889 built them: esbuild 0.28.2 for the script, Tailwind 4.3.3 for the
  stylesheet and `tsc` declarations joined into one file. The React copies
  under `components/lib/` came out byte-identical and are unchanged.
- `mockups/` redraws the Users screens in the new frame and adds Health and
  the instructor's Course page, described under `mockups/` below.

## `system/`

The Portikus design system: `README.md` (the written rules), `tokens.json`,
`design-system.json` (the artifact's own manifest), the component previews and
their READMEs under `components/`, the compiled `components/bundle.css` and
`components/bundle.js` with their React copies under `components/lib/`, the
four variable font files under `fonts/`, and the eight logo SVGs under
`assets/Logos/`.

Source: https://claude.ai/artifact/TAPoWu8R6p6Q8GiY7yFmgu, version
1794525831-ffd4, last changed 2026-11-12 by Todd Whittaker.

The logo SVGs are stored in the artifact under blob identifiers rather than
file names. They were renamed on import to the names listed in
`design-system.json`. The artifact stores each SVG re-serialised (explicit
closing tags), so the sizes recorded there are a few bytes larger than the
files here; the drawings are the same.

## `mockups/`

Twenty-three screen mockups, each a `*.dc.html` file, in light and dark
variants with a few 1024-wide variants. `canvas.json` is the canvas manifest
and carries the handoff notes reproduced below. `portikus-tokens.css` holds
the tokens, `portikus-screens.css` the screen-level styles the student
screens propose, and `portikus-console.css` the app's own stylesheet for the
administrator and course screens.

Source: https://claude.ai/artifact/RqyBryupN8TcL2pRHeh1vy, version
1794538363-92ea, created 2026-09-17T01:01:47Z and re-published 2026-11-12
(after Epic 64's review fixes, PR #1952).

The administrator and course screens (`AdminWorkspaces*`, `AdminHealth*` and
`CourseInstructor*`) are not drawn by hand. They are the markup the app
renders, taken from the end-to-end stack with the seed of
`e2e/doc-images/admin.capture.ts` (the Users page with Diego Santos open in
the inspector, Health, and the CS 1210 Course page), with only the root
element replaced so the artboard sets its size and theme. They load
`portikus-console.css` in place of `portikus-screens.css`, whose class names
would clash with the app's. That file is the CSS of the administrator and
course pages, compiled with the repo's Tailwind 4.3.3 from `apps/web/src`. It is not the whole of what
`app.css` imports. In file order it holds:

1. A one-line comment saying what the file is, then Tailwind's own
   banner and its `properties`, `theme`, `base`, `components` and `utilities`
   layers. The `theme` layer carries only the variables from the `@theme`
   block of `packages/ui/src/theme.css` that the utilities use. The
   `utilities` layer carries only the classes used under `admin`, `course`,
   `shell`, `common` and `monitor`. The `base` layer ends with the
   `@layer base` rule of `console.css`, and `components` holds the two rules
   of `@layer components` in `app.css`.
2. The stylesheets `app.css` imports from `apps/web/src`: `running/running.css`,
   `shell/header.css`, `tables.css`, `controls.css` and `console.css`.
3. `app.css` itself, without its imports.
4. The page-level stylesheets: `admin/admin-frame.css`,
   `shell/status-bar.css`, `shell/right-pane.css`, `admin/health/health.css`,
   `admin/logs/logs.css`, `admin/settings/settings.css`, `course/course.css`
   and `course/glance.css`.
5. The last part of `bundle.css`, from its type-scale `:root` rule to the end
   of its reduced-motion rule: the type scale, the light terminal colours, the
   density variables and the reduced-motion durations. It is byte-identical to
   those lines of `system/components/bundle.css`.
6. Tailwind's `@property` declarations.

Nothing else from `packages/ui` is in the file: the fonts, the primitives and
overlays styles and the rest of `theme.css` are not. Token values come from
`portikus-tokens.css` and the component styles from `bundle.css`. The 1024
Users screens add the real Reset Docker confirmation in an open
`ConfirmDialogRoot`.

These screens are Claude Design canvas documents, not ordinary web pages. Each
one loads a `support.js` runtime that is not part of the artifact's files and
uses `x-dc` and `x-import` component tags that only that runtime understands.
Opening one in a browser will not render it. Read them as source, or open the
artifact.

The screens mount the real `packages/ui` components. Where a component cannot
draw itself on a static canvas, the screen gives it the structure it needs:
an open menu sits in an open, non-modal `MenuRoot` whose trigger is an
invisible button at the menu's place; the Reset Docker dialog sits in an open
`ConfirmDialogRoot`; and the pane handles are drawn as the markup `PaneHandle`
renders, because the real one needs a resizable panel group around it. Each
dark screen is its light twin with only the theme default changed.

Menus and dialogs render into the page body, outside the artboard root, so
`portikus-tokens.css` gives the body the dark values when the artboard is
dark, and repeats the `--color-*` mappings the bundle and the console
stylesheet use on the artboard root and the body so they resolve against the
artboard's theme. `portikus-screens.css`
gives the body the app's base type, as `apps/web/src/app.css` does.

The mockup artifact also carries a `ds/portikus/` copy of the design system so
the screens can load it. `components/bundle.css`, `components/index.d.ts` and
`tokens.json` there are byte-identical to the files in `system/`, so they are
not repeated here. `components/bundle.js` is not, and is kept at
`mockups/ds/portikus/components/bundle.js`. The canvas gives every artboard
React 18, while the bundle in `system/` is built for React 19 and fails on 18.
The canvas copy is built from the same `packages/ui/src/index.ts` with the
repo's esbuild 0.28.2 (an IIFE with global name `Portikus`, minified, with
`react` and `react-dom` read from `window.React` and `window.ReactDOM`), except
that `react/jsx-runtime` is replaced by a small module whose `jsx` and `jsxs`
call `window.React.createElement`. That works on React 18 and 19 alike. Its
first line is the `@ds-bundle` header from `system/components/bundle.js`.

## Refreshing these files

There is no script. In a Claude Code session, ask it to re-pull the `project/`
files of both artifacts into `design/system/` and `design/mockups/`, keeping
the logo renaming and the `ds/` rules described above, and to open a pull
request with the result.

## Handoff notes

Copied verbatim from `mockups/canvas.json`, `notes.handoff.text`:

```
Handoff: names for packages/ui

Mounted from the Portikus system: NameMark, Icon, Button, IconButton, Menu/MenuItem/MenuLabel/MenuSeparator, Tabs, StateBadge, Table (markup + pk-table classes), TextField, Select, Checkbox, Skeleton, ShortcutHint, PaneHandle, ConfirmDialog.

Administration and Instructor course: these screens are the app's own markup, captured from the end-to-end stack, and load portikus-console.css (the apps/web stylesheet for the admin and course pages, compiled with the repo's Tailwind) in place of portikus-screens.css. Their patterns are in the design system as PageFrame, Inspector, AttentionStrip, StatusDots, SegmentedControl, MoreMenu, SaveBar, FilterChips and TableBox; they live in apps/web, not packages/ui. The earlier AdminNav (a header strip) and WorkspaceDetailPanel proposals were built as the section rail and the Inspector.

Proposed additions (portikus-screens.css, data-component on each): AppHeader, AccountMenuTrigger, WorkspaceStatusButton, AppShell, Pane (+ overlay at 1024), Rail, ProjectList, FileTree, TerminalPane, PreviewPane, StatusBar, DisconnectNotice (Notice), WorkspaceProgress, StorageMeter, ErrorState, StandalonePage.

Proposed token: terminal-line (#2a2824), the hairline on terminal-bg.
Type utilities: pk-text-display … pk-text-caption, pk-mono-body, pk-mono-small map 1:1 to type tokens.

Canvas-only: is-focus-demo / is-focus-demo-inset draw the focus-visible ring on static comps.

Leave-terminal shortcut (Alt+Shift+Q) is a proposal; confirm it against browser and shell bindings.
```
