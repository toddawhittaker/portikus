# Design files

This directory mirrors the two Claude Design artifacts that hold the Portikus
visual design. The files here are a copy for reading and reference; the
artifacts remain the place where the design is edited. `docs/DESIGN.md`
explains the design itself and how engineering picks it up.

## `system/`

The Portikus design system: `README.md` (the written rules), `tokens.json`,
`design-system.json` (the artifact's own manifest), the component previews and
their READMEs under `components/`, the compiled `components/bundle.css` and
`components/bundle.js` with their React copies under `components/lib/`, the
four variable font files under `fonts/`, and the eight logo SVGs under
`assets/Logos/`.

Source: https://claude.ai/artifact/TAPoWu8R6p6Q8GiY7yFmgu, version
1789595319-c72a, last changed 2026-09-16T21:39:12Z by Todd Whittaker.

The logo SVGs are stored in the artifact under blob identifiers rather than
file names. They were renamed on import to the names listed in
`design-system.json`, and each one's byte size matches the size recorded there.

## `mockups/`

Nineteen screen mockups, each a `*.dc.html` file, in light and dark variants
with a few 1024-wide collapsed variants. `canvas.json` is the canvas manifest
and carries the handoff notes reproduced below. `portikus-tokens.css` and
`portikus-screens.css` hold the tokens and the screen-level styles the mockups
propose.

Source: https://claude.ai/artifact/RqyBryupN8TcL2pRHeh1vy, version
1789608073-07be, created 2026-09-17T01:01:47Z.

These screens are Claude Design canvas documents, not ordinary web pages. Each
one loads a `support.js` runtime that is not part of the artifact's files and
uses `x-dc` and `x-import` component tags that only that runtime understands.
Opening one in a browser will not render it. Read them as source, or open the
artifact.

The mockup artifact also carries a `ds/portikus/` copy of the design system
bundle so the screens can load it. That copy was left out of this import
because it is byte-identical to the files already in `system/`:
`components/bundle.css`, `components/bundle.js`, `components/index.d.ts` and
`tokens.json` all matched by sha256sum at import time. The `*.dc.html` files
still reference `ds/portikus/...` paths, which is expected.

## Refreshing these files

There is no script. In a Claude Code session, ask it to re-pull the `project/`
files of both artifacts into `design/system/` and `design/mockups/`, keeping
the logo renaming and the `ds/` omission described above, and to open a pull
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
