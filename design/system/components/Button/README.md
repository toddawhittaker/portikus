# Button

The single button component: `primary` for the one main action in a view, `secondary` for alternatives, `quiet` for toolbar and low-emphasis actions, `danger` only for the confirming button of a destructive action, and `danger-secondary` for a row's own destructive action that opens that confirmation.

**Maps to:** a native `<button>`; use Radix `Slot` (`asChild`) when it must render a link. **Consumer provides:** `variant`, `size` (`sm`, `md`, `lg`), `children` (a verb phrase), optional `iconStart`, `iconEnd`, `loading`, `disabled`. `buttonClass(variant, size)` gives a link the same look, for a link that leads somewhere but should read as an action.

- Height follows density: `density-comfortable-control` (36px) for students, `density-compact-control` (32px) inside `data-density="compact"`. Administrator and course pages add `data-controls="console"`, which brings buttons back to 36px with 14px labels while rows stay compact; on a phone they grow to 44px. `lg` (`size-control-lg`) is used only for the sign-in action.
- Labels are 500 weight.
- `primary` is the `accent-fill` with `on-accent-fill` (white) text, `accent-fill-hover` on hover and `accent-fill-active` when pressed. In light that is the accent teal; in dark it is a deeper teal (`#14776b`), so the white label stays well over 4.5:1. Teal means "act here" across the product, so a page has at most one filled primary; other ways to start the same work go in a More menu beside it.
- `danger` is `danger-fill` with white `on-danger` text in both themes, `danger-hover` on hover.
- `loading` keeps the label and colour, shows the spinner, and sets `aria-busy`. Show it within 100ms of the click; never swap the label for a spinner alone.
- Labels name the result: "Start workspace", "Revoke access", "Reset Docker…". Never "OK", "Submit" or "Yes".
- Do not place `danger` buttons in toolbars or tables. Destructive actions live in a Menu and confirm in a ConfirmDialog. Where a row's delete must stay a button, because it is unavailable with a reason or shows "Deleting…" in place (the Backups lists), it is `danger-secondary`: `status-danger` text and edge on the raised face, `status-danger-soft` on hover.
- A button that cannot act, `disabled` or kept focusable with `aria-disabled`, fades whatever its variant: no fill, a solid `line` hairline edge, `ink-faint` text and the not-allowed cursor. It reads as the same button at rest, not a broken one, so the edge is never dashed, and its label still meets 4.5:1 on every surface, so the button is never faded with opacity. A busy button keeps its colour.
- Focus: `focus` outline, `ring-width`, offset `ring-offset`.
