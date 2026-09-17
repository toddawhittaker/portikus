# Toast

A brief, non-blocking message about something that just happened, with at most two actions.

**Maps to:** Radix `Toast` (`Viewport` bottom-right, `z-toast`). **Consumer provides:** `tone` (`neutral`, `success`, `warning`, `danger`), `title`, optional body `children`, optional `actions` (small Buttons), `onDismiss`.

- Error copy follows SPEC 28: user terms first (title), implementation second (body), actions last. "Your workspace could not start" / "Its storage allocation is full. Docker is using 19.8 GB of your 20 GB Docker quota." / Clean up Docker, View details.
- `success` and `neutral` toasts dismiss after 5 seconds and pause on hover or focus. `warning` and `danger` stay until dismissed.
- Danger and warning use `role="alert"`; others `role="status"`.
- Do not use a toast for workspace state. State lives in StateBadge and in the workspace screens, and a failed start is a full error state, not only a toast.
- No toasts that report agent or terminal activity; the platform does not record it.
