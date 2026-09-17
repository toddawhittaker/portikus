# ConfirmDialog

The destructive confirmation: states in plain words what will be removed and what will be kept, then asks the person to confirm with a button that names the action.

**Maps to:** Radix `AlertDialog`. **Consumer provides:** `title` (a question naming the action: "Reset Docker?"), `description` (one or two sentences), `lost` and `survives` lists (from SPEC 17.3 for Reset Docker and Rebuild workspace), `confirmLabel` (the action, never "Confirm"), optional `confirmText` for a typed confirmation, `onConfirm`, `onCancel`, `pending`.

- Focus opens on Cancel, not on the destructive button.
- Use `confirmText` for actions that cannot be undone from a recovery point: Reset Docker, Rebuild workspace, Revoke access, Archive workspace. Match is exact; the danger button stays disabled until it matches.
- The "Will be removed" heading uses `status-danger`; the lists sit on `surface-sunken`. Both lists are always shown, even with one item each, so nobody has to infer what survives.
- Restoring a recovery point uses this component with the copy "This replaces the current files in {project}."
- Students never see permanent delete for projects; archive is the strongest project action.
