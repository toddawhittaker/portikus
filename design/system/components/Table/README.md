# Table

A dense, sortable data table for administrator views: users, workspaces, audit events.

**Maps to:** a semantic `<table>` (TanStack Table may drive it; the markup and classes stay). **Consumer provides:** `columns` (`key`, `header`, optional `width`, `align: 'right'`, `mono`, `muted`, `sortable`, `sort`, `render`), `rows`, `rowKey`, optional `selectedKey`, and a `label`.

- Administrator views set `data-density="compact"`: rows are `density-compact-row` plus a two-line allowance, text `text-compact`.
- Header ground `surface-sunken`, sticky at `z-sticky`; rows divided by `line`; hover `surface-hover`; selected `surface-selected`.
- Numbers (storage, ports) are right-aligned with tabular figures; identifiers, image versions and paths use `mono-body` or `mono-small`.
- State columns use StateBadge. Row actions are a single `more` IconButton opening a Menu; never a row of buttons.
- Sort buttons set `aria-sort` on the header cell. Loading rows use Skeleton; an empty result uses EmptyState inside the table frame.
