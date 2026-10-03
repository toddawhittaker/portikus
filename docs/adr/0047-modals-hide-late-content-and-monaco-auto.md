# 0047. Modals re-hide late page content with aria-hidden, and Monaco's accessibility support is "auto"

- **Status**: Accepted (Epic 33)
- **Date**: 2026-10-03
- **References**: SPEC.md section 25.8; issue #1087

## Context

A modal dialog must hide the page behind it from screen readers, yet the
page's status regions (an idle warning, a disconnect stop) must still be
heard while it is open. Radix hides the page once, when the modal opens,
and skips live regions, so content mounted beside a region later stayed
reachable behind the dialog.

Monaco's accessibility support was "off" unless the student turned on
screen-reader mode. With "off", Monaco names its text box "The editor is
not accessible at this time." and leaves out the file.

## Decision

1. **Re-hide, not `inert`.** While a modal is open, `Dialog` and
   `ConfirmDialog` in `packages/ui` watch the page for added elements and
   hide any that land outside a hidden area, at most once per animation
   frame, through the same `aria-hidden` library Radix uses. Live regions
   stay audible. Making the app root `inert` would also silence every live
   region inside it, so each region would have to move into a portal
   outside the root, and new regions would easily land in the wrong place.
2. **Monaco support "auto" when screen-reader mode is off.** Monaco then
   names the text box after its file and the Ctrl+M way out. Screen-reader
   mode still forces "on".

## Consequences

- `aria-hidden` becomes a direct dependency of `packages/ui`; it was
  already shipped through Radix.
- The watcher costs work only while a modal is open, and ignores changes
  inside already-hidden areas.
- A browser cannot detect a screen reader, so "auto" behaves as off in
  practice; it only keeps Monaco's own name for the text box.
