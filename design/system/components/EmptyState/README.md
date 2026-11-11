# EmptyState

A calm, centred message for a region that has nothing in it yet, with one or two actions that fill it.

**Consumer provides:** `icon`, `title` (states the fact: "No projects yet"), `children` (one sentence explaining the model), `actions` (a primary and at most one secondary Button).

- Reinforce the mental model in the body: a project is a folder, a preview is a running service.
- With an `icon`, the message sits under a `StateArt` picture: the portico of the mark on a soft round backdrop, with a prompt and cursor in its doorway and the icon in a small badge at its corner. No other illustration, mascot or encouragement.
- Title in `text-heading` (16px, 600), body in `ink-muted` at most 38 characters wide, all centred in at most 400px.
- Inactive previews use this pattern with the exact copy "Nothing is currently listening on port 3000. Start your application to reconnect this preview."

## StateArt

The one picture the product uses, shared by empty, starting and error states so they look like one family.

**Consumer provides:** optional `icon` for the corner badge, `tone` (`accent` or `error`), and `busy`.

- 96 by 72px. The backdrop is `accent-soft`, the portico `accent`, the doorway `surface-raised`, the prompt `agent` and the cursor `brand-spark`. The badge is an `accent` circle with an `on-accent` icon, ringed in the ground colour.
- `error` swaps the backdrop to `status-error-soft` and the badge to `status-error`. Use it on the workspace error card and on an error state, nowhere else.
- `busy` blinks the cursor while something is under way, such as the workspace starting card. The blink stops under reduced motion.
- It is decorative and hidden from assistive technology; the heading beside it says what the state is.
