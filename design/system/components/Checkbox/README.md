# Checkbox

A labelled on/off choice with an optional description.

**Maps to:** Radix `Checkbox` inside a `Label`. **Consumer provides:** `label`, `checked`, `onChange` (Radix `onCheckedChange`), optional `description`, `disabled`.

- Box `line-strong` on `surface-raised`; checked fills `accent` with an `on-accent` check.
- The whole label is the hit target. Focus ring sits on the box.
- On a phone, on administrator and course pages, a row's box is drawn at 20px inside a 44px target, and a labelled box takes at least 44px of height.
- A filter chip that several can switch on (the Logs levels) is a native checkbox laid clear over the whole chip; see FilterChips.
- Use it for settings that take effect on save, such as "Show hidden and generated files". For instant toggles in toolbars use an IconButton with `aria-pressed`.
