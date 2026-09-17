# Icon

A small outlined icon set drawn on a 24 grid with a 1.75 stroke, sized by `size-icon-sm`, `size-icon-md` (default) and `size-icon-lg`.

**Consumer provides:** `name` (one of the names in the preview), optional `size` (`sm`, `md`, `lg`), and `label` only when the icon carries meaning on its own (otherwise it is hidden from assistive technology).

- Icons inherit `currentColor`. Colour them through the text token of their context, never directly.
- The set is deliberately small and stroke-matched to Lucide, so an engineer may substitute `lucide-react` icons of the same name at 1.75 stroke without visual drift. Add new names here before using them in a screen.
- `agent` is the one icon for Claude Code and Codex tabs. Do not use vendor logos in tabs; the tab label names the tool.
- Never use an icon as decoration beside a heading.
