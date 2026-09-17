# Checkbox

A labelled on/off choice with an optional description.

**Maps to:** Radix `Checkbox` inside a `Label`. **Consumer provides:** `label`, `checked`, `onChange` (Radix `onCheckedChange`), optional `description`, `disabled`.

- Box `line-strong` on `surface-raised`; checked fills `accent` with an `on-accent` check.
- The whole label is the hit target. Focus ring sits on the box.
- Use it for settings that take effect on save, such as "Show hidden and generated files". For instant toggles in toolbars use an IconButton with `aria-pressed`.
