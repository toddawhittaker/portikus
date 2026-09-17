# TextField

A labelled single-line input with optional hint and error text.

**Maps to:** native `<input>` with Radix `Label`. **Consumer provides:** `id`, `label`, optional `hint`, `error`, `mono` (for folder names, URLs, ports, typed confirmations), and any input attributes.

- Label above, hint below, error between them with the alert icon in `status-error`. The error is linked with `aria-describedby` and the input gets `aria-invalid`.
- Border `line-strong` (3:1), hover `ink-muted`, focus ring `focus`. Placeholder `ink-faint`, never a substitute for a label.
- Validate on blur and on submit, not on every keystroke. Error text says what to do: "Use letters, numbers, dots, dashes or underscores. No spaces."
