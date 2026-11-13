# TableBox

The box around an administrator table. Where the table is wider than its place, the box scrolls sideways, and only then is it a named region in the tab order so the keyboard can scroll it.

**Maps to:** `TableBox` in `apps/web/src/admin/TableBox.tsx`, which renders the `pk-table-wrap` from `packages/ui` and adds the focus ring rule in `apps/web/src/admin/admin-frame.css`. The preview mounts the same logic with the real classes and carries that rule itself. **Consumer provides:** `label` (the table's name, used for the region) and the table.

- A `ResizeObserver` compares the box's scroll width with its width. While the table fits, the box is a plain `div` with no role and no tab stop.
- When it overflows, the box gets `role="region"`, `aria-label` and `tabIndex={0}` (WCAG 2.1.1), so arrow keys scroll it.
- Its focus ring is inset (`ring-offset-inset`), so the box's own clip never hides it.
- Under a 45rem content width the box scrolls sideways and the table header stops sticking, so no column is cut off. The Users table stacks its rows instead once its box is under 42rem.
