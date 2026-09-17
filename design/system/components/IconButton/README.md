# IconButton

A square button that holds a single Icon and always has an accessible name and a tooltip.

**Maps to:** `<button>` wrapped in Radix `Tooltip`. **Consumer provides:** `icon`, `label` (required; becomes `aria-label` and the tooltip text), optional `shortcut` (keys for ShortcutHint), `variant` (`quiet` default, or `secondary`), `size` (`sm` or density default), `aria-pressed` for toggles such as showing a pane.

- Tooltips open on hover after 400ms and immediately on keyboard focus; they show the label and the shortcut.
- Use for pane toggles, tab launchers, row actions (`more`) and closing overlays. If the action needs explanation, use a Button with text instead.
- "Open in new tab" on a preview is always an IconButton with the `external` icon and that exact label.
