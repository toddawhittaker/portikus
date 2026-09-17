# Select

A labelled single-choice picker for short, known lists: preview port, template, quota preset.

**Maps to:** Radix `Select` (`Trigger` = `pk-select`, `Content` styled as Menu, `Item` as MenuItem). **Consumer provides:** `id`, `label`, `options` (`value`, `label`), `value`, optional `placeholder`, `hint`.

- Same height, border and focus as TextField.
- Option labels may combine a value and its meaning with a middle dot: "3000 · node".
- For more than about 15 options, or when typing helps, use a combobox instead; add it to the system first.
