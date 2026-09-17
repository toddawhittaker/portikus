# Button

The single button component: `primary` for the one main action in a view, `secondary` for alternatives, `quiet` for toolbar and low-emphasis actions, `danger` only for the confirming button of a destructive action.

**Maps to:** a native `<button>`; use Radix `Slot` (`asChild`) when it must render a link. **Consumer provides:** `variant`, `size` (`sm`, `md`, `lg`), `children` (a verb phrase), optional `iconStart`, `iconEnd`, `loading`, `disabled`.

- Height follows density: `density-comfortable-control` (36px) for students, `density-compact-control` (28px) inside `data-density="compact"`. `lg` (`size-control-lg`) is used only for the sign-in action.
- `primary` is `surface-inverse` with `ink-inverse`: quiet and unmistakable next to a black terminal. Only one primary per view.
- `loading` keeps the label and colour, shows the spinner, and sets `aria-busy`. Show it within 100ms of the click; never swap the label for a spinner alone.
- Labels name the result: "Start workspace", "Revoke access", "Clean up Docker". Never "OK", "Submit" or "Yes".
- Do not place `danger` buttons in toolbars or tables. Destructive actions live in a Menu and confirm in a ConfirmDialog.
- Focus: `focus` outline, `ring-width`, offset `ring-offset`.
