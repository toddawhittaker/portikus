# NameMark

The Portikus mark and name: a rounded teal tile with an ivory portico (pediment, lintel, two columns, a step) and a gold prompt and cursor in its doorway, followed by the name.

**Consumer provides:** `size` (px of the name), optional `href` (renders a link back to the project list), and `markOnly`, which drops the name and names the mark "Portikus" for assistive technology.

- The tile is `brand-tile`, the portico `brand-stone` and the prompt `brand-spark`. They are brand tokens, so the mark reads the same on every surface; only the tile lifts a step in the dark theme.
- The mark is square on a 32-unit grid and drawn at 1.3 em of the name, with a 0.4 em gap. The name is Public Sans 700 in `ink`.
- Use 18px in the application header; on a phone the header shows the mark alone. Standalone pages (sign-in, session ended, not authorized) use 28 to 32px. Nothing larger inside the product.
- Keep clear space of a quarter of the mark's height on every side. Never add an outline, shadow or gradient, and never recolour the tile, portico or prompt.
- For places that cannot run React (favicon, email, documentation, the identity provider's client logo) use the SVG files in the Logos asset group.
