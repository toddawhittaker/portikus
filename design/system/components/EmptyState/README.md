# EmptyState

A calm, centred message for a region that has nothing in it yet, with one or two actions that fill it.

**Consumer provides:** `icon`, `title` (states the fact: "No projects yet"), `children` (one sentence explaining the model), `actions` (a primary and at most one secondary Button).

- Reinforce the mental model in the body: a project is a folder, a preview is a running service.
- No illustrations, mascots or encouragement. The icon sits on `surface-sunken` at `size-icon-lg`.
- Inactive previews use this pattern with the exact copy "Nothing is currently listening on port 3000. Start your application to reconnect this preview."
