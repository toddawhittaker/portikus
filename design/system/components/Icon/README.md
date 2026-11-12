# Icon

A small outlined icon set drawn on a 24 grid with a 1.75 stroke, sized by `size-icon-sm`, `size-icon-md` (default) and `size-icon-lg`.

**Consumer provides:** `name` (one of the names in the preview), optional `size` (`sm`, `md`, `lg`), and `label` only when the icon carries meaning on its own (otherwise it is hidden from assistive technology).

- Icons inherit `currentColor`. Colour them through the text token of their context, never directly.
- The set is deliberately small and stroke-matched to Lucide, so an engineer may substitute `lucide-react` icons of the same name at 1.75 stroke without visual drift. Add new names here before using them in a screen.
- `agent` is the one icon for Claude Code and Codex tabs. Do not use vendor logos in tabs; the tab label names the tool.
- Never use an icon as decoration beside a heading.
- `help` (Lucide `circle-help`) is for Toggletip buttons and the Help menu item.
- The admin rail gives each page one icon: `users` (Users), `activity` (Health), `list` (Logs), `clipboard-list` (Audit), `agent` (Agent usage), `globe` (Network), `archive` (Backups), `layers` (Workspace image), `lock` (Certificate), `box` (Docker), `sign-in` (Sign-in), `map-pin` (Site address), `settings` (Settings) and `terminal` (Root shell). The icon is `ink-faint` at rest and `accent-text` on the open page.
- `shield` (Lucide `shield`) and `school` (a mortarboard, after Lucide `graduation-cap`) mark the Administration and Course areas in the header. `bell` (Lucide `bell`) is the notifications count beside the account button.
- The `file-*` names and `folder`, `folder-open` are for the Files pane, one glyph per family. Page glyphs are the Lucide page, 16 wide and 20 tall, which matches the 18 square glyphs optically. A source file is the page with its lower half open and a short language tag stamped there (`py`, `jv`, `js`, `ts`, `c`, `c++`, `sql`, `sh`, `go`, `rs`, `c#`, `rb`, `php`, `kt`, `sw`); `file-pdf` is the same page tagged `pdf`. Tags are words, never vendor logos. The Files pane tints each one lightly by family or language, at least 3:1 on every row background.
