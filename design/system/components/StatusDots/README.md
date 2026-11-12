# StatusDots

The quiet ways a normal state is shown on administrator and course pages, where a badge is kept for exceptions: a plain StateBadge in a table, a small dot and a word in the status bar, and the instructor's row of dots, one per student.

**Maps to:** `StateBadge` with `plain` from `packages/ui`; the `pk-dot` and `pk-tone-*` classes in `apps/web/src/app.css`; `ClassDots` and `ClassDotsKey` in `apps/web/src/course/ClassDots.tsx`, styled by `apps/web/src/course/glance.css`. The dots are not part of `packages/ui`, so the preview carries their rules itself. **Consumer provides:** the state, or for the class the students and who is waiting for help.

- A normal workspace state in a table is the plain StateBadge: the glyph and the word in the tone's colour, no fill (a filled dot for Running, an open ring for Stopped, the spinner for a transition). Only an error, or another exception such as Throttled, keeps a filled badge.
- `pk-dot` is an 8px `radius-full` dot in `currentColor`; `pk-tone-running`, `-warning`, `-error`, `-starting` and `-stopped` give it its colour. It is always beside a word and hidden from assistive technology.
- Class now sums the class in one sentence ("10 students · 3 running · 2 waiting for help") over one dot per student, sorted so who needs the instructor comes first: amber waiting for help, red failed, green running, blue starting or stopping, a hollow ring stopped, a dashed ring with no workspace. A key names the kinds shown. The dots and key are decorative because the sentence carries the figures.
- Colour is never the only signal: every dot sits beside its word, and the stopped and empty kinds differ in shape as well as colour.
