# SaveBar

The save row at the end of every Settings section, which rises to float at the foot of the window while the section holds an unsaved change.

**Maps to:** `SaveFooter` in `apps/web/src/admin/settings/SaveFooter.tsx`, styled by `pk-save-footer` and `pk-setting-row` in `apps/web/src/admin/admin-frame.css`. Not part of `packages/ui`; the preview is static markup with the real classes and real Buttons, and carries the app's rules itself. **Consumer provides:** the state line, the section's Save label, Discard changes, and any note on what saving does.

- At rest it sits in the flow: "No unsaved changes." in `ink-muted`, and Save as a secondary button kept focusable with `aria-disabled` and its reason.
- With a change it becomes sticky 12px above the window's foot: `surface-raised`, a `line-strong` edge, `radius-md` and `shadow-md`, rising 8px over 120ms (none under reduced motion). The state reads "2 unsaved changes" in `ink` at 600 after an amber dot; Discard changes is secondary and Save turns primary.
- Each changed row carries a 2px `status-warning` bar at its start, so the change is visible where it was made.
- The state line is a polite status region that stays mounted, so every change is read out. After a save it says "Saved." with a check in `status-running`; a failure says "Not saved." with what to fix.
- Discard changes moves focus to Save, since the button that had focus goes away.
