# Menu

A floating list of actions, used for the tab launcher, project actions, file tree context actions and administrator row actions.

**Maps to:** Radix `DropdownMenu` (and `ContextMenu` for right-click in the file tree) with `Menu` as the styled `Content`, `MenuItem` as `Item`, `MenuSeparator`, and `MenuLabel` as `Label`. **Consumer provides:** a trigger (usually an IconButton), items with `icon`, text, optional `shortcut`, `disabled`, `danger`, and `onSelect`.

- Items are verbs in sentence case. An item that opens a confirmation ends with an ellipsis ("Reset Docker…").
- Group destructive items at the bottom, after a separator, with `danger`. They never act immediately; they open a ConfirmDialog.
- The tab launcher lists, in this order: Terminal, Claude Code, Codex, File, Preview.
- Highlight uses `surface-hover` plus the inset focus ring when reached by keyboard. Arrow keys move, typeahead jumps, Escape returns focus to the trigger (Radix defaults; do not override).
- Break-glass administrator access is not a menu item. It lives on its own audited page.
