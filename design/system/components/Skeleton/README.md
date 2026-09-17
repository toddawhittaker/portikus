# Skeleton

A placeholder in the shape of content that is on its way, used so the shell renders in under two seconds and fills in as data arrives.

**Consumer provides:** `variant` (`text`, `block`, `circle`), `width`, `height`, or `lines` for a paragraph.

- Match the real layout: tree rows with an icon block and a text bar, table rows, the terminal pane as one `block` on `terminal-bg`.
- Fill `surface-hover` with a slow opacity pulse; under reduced motion it is static.
- Skeletons are hidden from assistive technology; announce loading once on the region with `aria-busy`.
- Do not show a skeleton for anything that resolves in under 300ms, and never show one for workspace state: show the StateBadge transition instead.
