# PageFrame

The frame every administrator page and instructor course page shares, read top to bottom: the rail (administrator pages), an eyebrow, the title row, an attention summary when something needs a look, the work surface, and an inspector beside a table whose rows open.

**Maps to:** `AdminPage`, `AdminNav` and `AdminSection` in `apps/web/src/admin`, and `CourseFrame` and `CourseEyebrow` in `apps/web/src/course`, styled by `apps/web/src/console.css` and `apps/web/src/admin/admin-frame.css`. It is not part of `packages/ui`, so the preview is static markup with the app's real classes and carries the app's rules itself. **Consumer provides:** a title, an optional count, the page's actions (at most one primary), the lead sentence and its About text, then the page's own content.

- `main` scrolls under a still header and rail, `data-density="compact"` with `data-controls="console"`, so rows are compact and every control is 36px with a 14px label (44px on a phone).
- The rail (`pk-adminnav`) groups the pages under overlines; the open page has the `surface-selected` fill, a 2px `accent` bar at its start and its icon in `accent-text`. Health carries a `status-warning-soft` count pill when something needs attention. On a phone the rail is one 44px control naming the page.
- The eyebrow (`pk-eyebrow`) is the portico glyph in `accent-text` and "Administration" or "Courses / CS 1210" in 13px `ink-muted`. It is decorative (`aria-hidden`); the `h2` title names the page.
- The title (`pk-admin-title`) is 28px on a 36px line; a section title on these pages is 18px; an overline (`pk-overline`, 11px spaced capitals) names a group, a tile or a column.
- The lead sentence always shows; "About {page}" opens the rest, which starts closed (PageIntro with `lead`).
- The page (`pk-admin-page`) spaces its parts with a 16px gap and sets no margins. Tables and dashboards run to 80rem; `data-measure="form"` stops a column of cards at 52rem. Running text is capped at 52ch.
- An attention summary (AttentionStrip) comes before the work; a row that opens shows its inspector beside the table (Inspector); the status bar runs along the foot of administrator pages.
