# FilterChips

Chips that narrow a list: the Logs levels and services, and the Course page's member filter.

**Maps to:** the `pk-chipcheck` checkbox chip in `apps/web/src/admin/logs/LogsTab.tsx` (styled in `apps/web/src/admin/logs/logs.css`) and the `pk-chip` pressed button in `apps/web/src/course/CoursePage.tsx` (styled in `apps/web/src/course/course.css`). Not part of `packages/ui`; the preview is static markup with the real classes and carries the app's rules itself. **Consumer provides:** a `fieldset` and its legend, and per chip a label, whether it is on, and optionally a level or a count.

- One off look: the raised face, a `line-strong` edge, `ink-muted` text, `radius-md`. One on look: the `accent-soft` fill, an `accent` edge and a `check` icon before the label, so the state never rests on colour.
- A level's colour lives only in its 8px dot, in both states: error `status-error`, warn `status-warning`, info `status-starting`, debug `ink-muted`. The chip itself never turns red or amber.
- Where several can be on (Logs levels and services), the chip is a native checkbox laid clear over the whole chip, so a tap anywhere toggles it and the focus ring sits on the chip. Where one of a set is chosen (Course members), each chip is a `button` with `aria-pressed`, and a count sits in a small `surface-sunken` pill in tabular figures.
- Never the filled primary look: a filter is a view, not an action.
- On a phone each chip is 44px tall.
- The Course page's member chips do not yet show the `check` icon when on; the Logs chips are the reference.
