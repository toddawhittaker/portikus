# Menu

A floating list of actions, used for the tab launcher, project actions, file tree context actions and administrator row actions.

**Maps to:** Radix `DropdownMenu` (and `ContextMenu` for right-click in the file tree) with `Menu` as the styled `Content`, `MenuItem` as `Item`, `MenuSeparator`, and `MenuLabel` as `Label`. **Consumer provides:** a trigger (usually an IconButton), items with `icon`, text, optional `shortcut`, `disabled`, `danger`, and `onSelect`.

- Items are verbs in sentence case. An item that opens a confirmation ends with an ellipsis ("Reset Docker…").
- Group destructive items at the bottom, after a separator, with `danger`. They never act immediately; they open a ConfirmDialog.
- The tab launcher lists, in this order: Terminal, Claude Code, Codex, File, Preview.
- An item that starts a coding agent carries `agent` in its icon, as the agent's tab does.
- Highlight uses `surface-hover` plus the inset focus ring when reached by keyboard. Arrow keys move, typeahead jumps, Escape returns focus to the trigger (Radix defaults; do not override).
- A More menu holds the ways to start work that are not the page's one primary action: a secondary `Button` labelled "More" with a `chevron-down`, beside the primary, opening a Menu aligned to its end (on Users: Invite… and Import from CSV…, beside Add user…). See MoreMenu.
- Actions a table row rarely needs (Delete set…, Remove from course) go in that row's `more` menu, leaving at most one visible action in the row.
- Break-glass administrator access is not a menu item. It lives on its own audited page.
