# SegmentedControl

A small set of buttons that choose one view of the same data, such as Health's time range.

**Maps to:** the `pk-segmented` class in `packages/ui/src/primitives/primitives.css` on a `fieldset` of `button`s with `aria-pressed`; there is no React component. Health's range adds `pk-range` from `apps/web/src/admin/health/health.css`, which the preview carries itself. **Consumer provides:** a `legend` (hidden visually), the options, and the chosen one.

- One `line-strong` edge around the set, `radius-md`, segments divided by `line`; it is as wide as its options, never stretched across its row.
- The chosen segment is `accent-soft` with `accent-text`; Health's range adds an inset 1px `accent` edge and tabular figures. Never the filled primary: a chosen view is not an action.
- Hover is `surface-hover`; focus is the inset ring, so it stays inside the set.
- On a phone each segment is a 44px target, and Health's range spans its card in four equal segments.
- Use it for two to five short options that switch a view at once. For a setting that takes effect on save, use Select or radio buttons.
