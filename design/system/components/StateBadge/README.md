# StateBadge

Shows a workspace's lifecycle state in a word, a glyph and a colour, and turns any difference between `state` and `desiredState` into motion rather than an error.

**Consumer provides:** `state` (`provisioning`, `starting`, `running`, `stopping`, `stopped`, `error`), `desiredState` (`running`, `stopped`, `restarting`), optional `plain` for status bars, `live` to announce changes politely, and an optional `label` override. `resolveWorkspaceState(state, desiredState)` is exported for screens that need the same logic.

| state | desiredState | shows |
| --- | --- | --- |
| running | running | Running, filled dot, `status-running` |
| stopped | stopped | Stopped, open ring, `status-stopped` |
| error | any | Error, alert icon, `status-error` |
| provisioning | any | Setting up, spinner, `status-provisioning` |
| starting | running | Starting, spinner, `status-starting` |
| stopped | running | Starting, spinner |
| running or stopping | stopped | Stopping, spinner, `status-stopping` |
| any but error | restarting | Restarting, spinner |

- Every state carries a word and a distinct glyph, so colour is never the only signal.
- The spinner (`pk-spin`, `duration-spin`) is the only continuous motion in the product. Under reduced motion it becomes a static half-ring.
- A transition never uses `status-error`, however long it takes. Slow transitions get explanatory copy on the workspace screen, not a red badge.
- Warning is not a state; the disconnect countdown and storage warnings use `status-warning` in their own components.
