# Logos

Outlined SVGs of the Portikus mark and wordmark for places that cannot use the `NameMark` component (favicon, email, documentation, the identity provider's client logo). The geometry is the one in `packages/ui/src/primitives/NameMark.tsx`: a rounded teal tile with an ivory portico (pediment, lintel, two columns, a step) and a gold prompt and cursor in its doorway, on a 32-unit grid.

- `portikus-mark-ink.svg`, `portikus-wordmark-ink.svg`: for light grounds. Tile `#1d6e67` (light `brand-tile`), name `#221f1a` (light `ink`).
- `portikus-mark-paper.svg`, `portikus-wordmark-paper.svg`: for dark grounds. Tile `#23857a` (dark `brand-tile`), name `#f0ebe1` (dark `ink`).
- In all four the portico is `#fffaf0` (`brand-stone`) and the prompt `#f4b942` (`brand-spark`).
- `portikus-mark-mono-ink.svg` (`#221f1a`) and `portikus-mark-mono-paper.svg` (`#f0ebe1`): one-colour versions for embossing, single-colour print and watermarks. The portico and prompt are cut out of the tile, so the ground shows through.
- `portikus-mark-compact-ink.svg` and `portikus-mark-compact-paper.svg`: the same mark at 32px for favicons. The tile mark is already simple enough for 16px, so the compact files differ from the full ones only in their default size.
- The wordmark sets the mark at the name's 1.3 em with a 0.4 em gap, as `NameMark` does, and the name is Public Sans 700 converted to outlines. Do not retype it.
- Minimum sizes: mark 16px, wordmark 96px wide.
