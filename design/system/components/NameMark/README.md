# NameMark

The Portikus mark and name: a portico (lintel, two columns, a base line) framing a small terminal, drawn inline so the stone follows the text colour.

**Consumer provides:** `size` (px of the name), optional `href` (renders a link back to the project list), `markOnly` for the collapsed 1024 rail, and `variant` (`full` or `compact`). Without a variant, a mark-only NameMark under 24px uses `compact`.

- The stone takes `currentColor`; the room is `terminal-bg`, the code lines `mark-code`, the cursor `terminal-cursor`. The room stays dark on both themes, like every terminal in the product.
- The full mark is a 2:1 shape on a 96 by 48 grid. The compact mark is square on a 32 grid, drops the capitals and uses two code lines; use it for favicons and anything 24px or smaller.
- Use 18px in the application header and 28 to 32px on standalone pages (sign-in, session ended, not authorized). Nothing larger inside the product.
- Keep clear space of one lintel height (an eighth of the mark's height) on every side. Never add a container, outline, shadow or gradient, and never recolour the code lines or cursor.
- For places that cannot run React (favicon, email, documentation, the identity provider's client logo) use the SVG files in the Logos asset group.
