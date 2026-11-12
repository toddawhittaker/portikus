# MoreMenu

The page's other ways to start work, gathered behind one secondary button beside the page's single primary action.

**Maps to:** `Button`, `MenuRoot`, `MenuTrigger`, `Menu` and `MenuItem` from `packages/ui`, put together in the Users page's actions (`apps/web/src/admin/WorkspacesTab.tsx`). It is a composition, not a component of its own; the preview mounts the real parts. **Consumer provides:** the primary action, and the menu's items.

- The primary sits first with the `accent-fill`; "More" follows as a secondary Button with `chevron-down` after its label.
- The menu aligns to the button's end and is named for what it holds ("More ways to add people"). Items are verbs; one that opens a dialog ends with an ellipsis (Invite…, Import from CSV…).
- On Users, Add user… is the primary with Invite… and Import from CSV… in More. Where the site has no Portikus passwords, Invite… is the primary and Import sits beside it.
- On a phone the actions take their own full-width row under the title, primary first, each 44px tall.
- A row's rarely used actions go in that row's `more` IconButton menu instead (see Table).
