# Dialog

A modal window for short, focused tasks: creating a project, cloning a repository, renaming, choosing a preview port.

**Maps to:** Radix `Dialog` (`Overlay` = `pk-scrim`, `Content` = `pk-dialog`, `Title`, `Description`, `Close`). **Consumer provides:** `title`, optional `description`, body `children`, `footer` actions (secondary first, primary last), `onClose`, optional `size="lg"` (640px).

- Default width 480px; padding `space-6`; corners `radius-lg`; elevation `shadow-lg`; ground `surface-raised`; backdrop `scrim`.
- Focus moves to the first field on open and returns to the trigger on close. Escape and the close button always work, except while a request is pending.
- Never open a dialog on page load and never stack dialogs. Sign-in is a full-page redirect, not a dialog.
- Errors from the server appear inline under the relevant field, not as a toast behind the dialog.
