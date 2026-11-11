# StateBadge

A Badge that shows a workspace's lifecycle state in a word, a glyph and a colour, and turns any difference between `state` and `desiredState` into motion rather than an error.

**Consumer provides:** `state` (`provisioning`, `starting`, `running`, `stopping`, `stopped`, `error`), `desiredState` (`running`, `stopped`, `restarting`), optional `plain` for status bars, `live` to announce changes politely, an optional `label` override, and `moving`, which shows the spinner whatever the state, for a pending operation such as "Rebuilding…". `resolveWorkspaceState(state, desiredState)` is exported for screens that need the same logic.

| state | desiredState | shows |
| --- | --- | --- |
| running | running | Running, filled dot, `success` tone |
| stopped | stopped | Stopped, open ring, `neutral` tone |
| error | any | Error, alert icon, `danger` tone |
| provisioning | any | Setting up, spinner, `info` tone |
| starting | running | Starting, spinner, `info` tone |
| stopped | running | Starting, spinner |
| running or stopping | stopped | Stopping, spinner, `info` tone |
| any but error | restarting | Restarting, spinner |

- Every state carries a word and a distinct glyph, so colour is never the only signal.
- It renders through `Badge`, so its height, radius and type match every other status. The tones are listed in the Badge README.
- The spinner (`pk-spin`, `duration-spin`) is a faint full ring with a solid arc that turns. Under reduced motion it stops and still reads as a ring.
- A transition never uses the `danger` tone, however long it takes. Slow transitions get explanatory copy on the workspace screen, not a red badge.
- Warning is not a state; the disconnect countdown and storage warnings use `status-warning` in their own components.
