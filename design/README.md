# Design files

This directory mirrors the two Claude Design artifacts that hold the Portikus
visual design. The files here are a copy for reading and reference; the
artifacts remain the place where the design is edited. `docs/DESIGN.md`
explains the design itself and how engineering picks it up.

## The artifacts and these files are in sync

On 2026-11-11 both artifacts were re-published from these files, so they show
the November 2026 look: warm ivory and charcoal surfaces, teal for actions and
selection, a violet agent hue, one `Badge` for every status, the 12, 14, 16,
20 and 24px type scale, and the redrawn portico mark. The design system
artifact was re-published from `system/` (pull request #1889), with its bundle,
types, React copies and previews rebuilt from `packages/ui`. The mockups
artifact was re-published from `mockups/` the same day, as described under
`mockups/` below. The blob identifiers in `design-system.json` name the new
logo uploads.

## `system/`

The Portikus design system: `README.md` (the written rules), `tokens.json`,
`design-system.json` (the artifact's own manifest), the component previews and
their READMEs under `components/`, the compiled `components/bundle.css` and
`components/bundle.js` with their React copies under `components/lib/`, the
four variable font files under `fonts/`, and the eight logo SVGs under
`assets/Logos/`.

Source: https://claude.ai/artifact/TAPoWu8R6p6Q8GiY7yFmgu, version
1794416429-1880, last changed 2026-11-11 by Todd Whittaker.

The logo SVGs are stored in the artifact under blob identifiers rather than
file names. They were renamed on import to the names listed in
`design-system.json`. The artifact stores each SVG re-serialised (explicit
closing tags), so the sizes recorded there are a few bytes larger than the
files here; the drawings are the same.

## `mockups/`

Nineteen screen mockups, each a `*.dc.html` file, in light and dark variants
with a few 1024-wide collapsed variants. `canvas.json` is the canvas manifest
and carries the handoff notes reproduced below. `portikus-tokens.css` and
`portikus-screens.css` hold the tokens and the screen-level styles the mockups
propose.

Source: https://claude.ai/artifact/RqyBryupN8TcL2pRHeh1vy, version
1794418500-bf51, created 2026-09-17T01:01:47Z and re-published 2026-11-11.

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
dark, and repeats the bundle's `--color-*` mappings on the artboard root and
the body so they resolve against the artboard's theme. `portikus-screens.css`
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

Proposed additions (portikus-screens.css, data-component on each): AppHeader, AccountMenuTrigger, WorkspaceStatusButton, AppShell, Pane (+ overlay at 1024), Rail, ProjectList, FileTree, TerminalPane, PreviewPane, StatusBar, DisconnectNotice (Notice), WorkspaceProgress, StorageMeter, ErrorState, StandalonePage, AdminNav, WorkspaceDetailPanel.

Proposed token: terminal-line (#2a2824), the hairline on terminal-bg.
Type utilities: pk-text-display … pk-text-caption, pk-mono-body, pk-mono-small map 1:1 to type tokens.

Canvas-only: is-focus-demo / is-focus-demo-inset draw the focus-visible ring on static comps.

Leave-terminal shortcut (Alt+Shift+Q) is a proposal; confirm it against browser and shell bindings.
```
