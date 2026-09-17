# ShortcutHint

Shows a keyboard shortcut as keycaps, rendered for the viewer's platform.

**Consumer provides:** `keys` (for example `['Mod', 'Shift', 'F']`; `Mod` is Command on macOS and Ctrl elsewhere), `platform` (`mac` or `other`, detected once at app start), optional `plain` for menus and tooltips.

- Keycaps use `text-caption` size on `surface-raised` with a `line-strong` border; `plain` drops the cap for use inside menus.
- The visual keys are hidden from assistive technology; the component exposes one spoken label ("Shortcut: Control Shift F").
- Avoid shortcuts the browser or the terminal already owns (Ctrl+W, Ctrl+T, Ctrl+C). Terminal focus takes priority over application shortcuts except the documented escape key.
