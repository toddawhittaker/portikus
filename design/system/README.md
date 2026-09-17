Portikus is a browser-based development workspace for students learning agentic software development. The name is German for portico, a covered entrance between spaces, and the identity follows from that: Portikus is the entryway, not the destination. It should feel like the calm, well-made entrance to a real workshop for adults. The real tools inside it (a shell, Git, Docker, Claude Code, Codex, Monaco) are the destination, and the interface stays quieter than they are.

## Principles

Simplify access to the development environment without simplifying the environment itself. A project is a directory, a terminal is a terminal, a preview is a running service. Never draw a parallel model on top of those facts.

Real tools stay real. Terminals are black, monospaced and square-cornered. File trees are indented lists of folders and files. The editor is Monaco with its own chrome. Do not round, tint, frame or decorate them.

Quiet by default. The interface is warm neutrals with one restrained colour, verdigris, used for selection and progress. Status colours carry meaning and are never decoration. No mascots, illustrations, confetti, streaks, points or encouragement.

Immediate over animated. Show a skeleton or an optimistic state within 100ms. The only continuous motion is the transition spinner, and it means one thing: the workspace is moving toward its desired state.

## Voice and copy

Write in plain sentences, in sentence case, addressing the student as "you" and the workspace as "your workspace". Name things by what the person sees: projects, folders, terminals, previews, recovery points.

Errors follow one order: user terms first, implementation second, actions last. "Your workspace could not start because its storage allocation is full. Docker is using 19.8 GB of your 20 GB Docker quota." followed by **Clean up Docker** and **View details**. Students read the sentence; administrators can expand the technical detail (`errorCode`, `errorMessage`) under View details.

Buttons name their result ("Start workspace", "Reset Docker", "Open in new tab"). A menu item that opens a confirmation ends with an ellipsis. Numbers carry units and a limit ("4.1 GB of 5 GB"). Refusals are plain and final without blame: "You're signed in with your institution, but your account doesn't have access to Portikus."

Never use exclamation marks, emoji, "Oops", "Whoops", or countdown urgency beyond the facts. Never show a share link for a preview, and never show recent commands, prompts or an activity feed; the platform does not record them.

## Colour

Every colour is a semantic token with a light and a dark value. Set `data-theme="light"` or `data-theme="dark"` on the root; follow the operating system by default and let the person override it.

Surfaces: `surface` is the page ground and the frame of the work area. `surface-sunken` is the side panes (project list, file tree), the tab strip and table headers. `surface-raised` is anything that sits on top: dialogs, menus, toasts, inputs, table bodies, the active tab. `surface-hover` and `surface-selected` are the only row states. `surface-inverse` fills the primary button.

Text: `ink` for primary text, `ink-muted` for secondary text and pane headings, `ink-faint` for placeholders only. All three meet 4.5:1 on `surface`, `surface-raised` and `surface-sunken` in both themes; `ink` and `ink-muted` also meet it on `surface-hover` and `surface-selected`. Text on `surface-inverse` is `ink-inverse`; on an accent fill, `on-accent`; on a danger fill, `on-danger`. Never use literal white.

Lines: `line` is a decorative hairline between panes and rows. Any control boundary (input, secondary button, checkbox) uses `line-strong`, which meets 3:1.

Accent: `accent` (verdigris) marks the active tab's top edge, checked boxes and progress. `accent-text` is for links. Use accent sparingly; a screen should read as neutral at a glance.

Terminal: `terminal-bg`, `terminal-fg`, `terminal-cursor`, `terminal-selection`, `terminal-muted` and the sixteen `ansi-*` tokens form the xterm.js theme. They are the same in both themes, because a terminal is always dark. Every ANSI foreground meets 4.5:1 on `terminal-bg`. Monaco uses its own `vs` and `vs-dark` themes with the background set to `surface-raised`; do not restyle its syntax colours.

## Workspace states and status colour

Six workspace states map to six tokens, each with a `-soft` fill for badges: `status-provisioning`, `status-starting`, `status-running`, `status-stopping`, `status-stopped`, `status-error`. Two more serve the rest of the product: `status-warning` for approaching limits (storage near 80 percent, the disconnect countdown) and `status-danger` for destructive actions. Error and danger share a hue today but are separate tokens so they can diverge.

The three transitional states share a slate blue on purpose: motion, not alarm. When `desiredState` differs from `state`, show the transition with the StateBadge spinner and never with `status-error`, however long it takes. Every status carries a word and a distinct glyph (filled dot, open ring, spinner, alert triangle), so colour is never the only signal. Every status foreground meets 4.5:1 on its soft fill and on the three main surfaces, in both themes.

## Type

Public Sans is the interface face: an open, sturdy grotesque designed for public-service interfaces, legible at 12px, with no personality to compete with code. JetBrains Mono is the monospace for terminals, Monaco, paths, ports and identifiers, with ligatures turned off so code reads literally. Both are variable fonts under the SIL Open Font License, shipped as files in `fonts/`.

Use `text-display` once per standalone page, `text-title` for page and dialog titles, `text-heading` for sections, `text-body` for comfortable UI text, `text-compact` for dense UI and administrator tables, `text-label` for form labels and table headers, `text-caption` for badges and hints. Nothing in the product is smaller than 12px. Use `mono-terminal` as the xterm.js and Monaco font settings, `mono-body` for paths and commands in the UI, and `mono-small` for image versions and error codes.

## Space, density and layout

Spacing is a 4px scale named to match Tailwind's default steps (`space-3` is 12px, `p-3` in Tailwind). Pane gutters are `space-5` at comfortable density; dialogs pad `space-6`; standalone pages pad `space-10` and sit `space-16` from the top.

Density is set with `data-density` on a container. Students get `comfortable` (36px controls, 32px rows, 36px tabs, 14px text). Administrators get `compact` (28px controls and rows, 30px tabs, 13px text). Components read `--pk-control`, `--pk-row`, `--pk-tab`, `--pk-pad` and `--pk-font`, which `bundle.css` maps from the `density-*` tokens, so a component never branches on role. The P2 roles (instructor, developer, support) choose a density rather than getting new components.

The application shell is three panes: project list on the left, tabbed work area in the centre, file tree on the right, separated by 1px `line` with a PaneHandle. At 1440 wide the side panes default to about 240px and 280px. At 1024 wide they collapse to a `size-rail` (48px) icon rail and open as overlays.

## Shape and elevation

Corners are small. Real tools take `radius-none`. Controls, badges and menu items take `radius-sm`; tabs stay square; menus, toasts and cards `radius-md`; dialogs and the sign-in panel `radius-lg`. `radius-full` is only for status dots, the spinner and the pane grip.

Panes and tables are separated by lines, never shadows. Only floating things have elevation: `shadow-sm` for a dragged tab, `shadow-md` for menus, selects, tooltips and toasts, `shadow-lg` for dialogs. In the dark theme `shadow-md` and `shadow-lg` include a hairline so edges stay visible. Layers stack by `z-pane-handle`, `z-sticky`, `z-menu`, `z-dialog`, `z-toast`.

## Focus and keyboard

Every platform-owned control shows a visible focus indicator: a solid `ring-width` (2px) outline in `focus`, offset `ring-offset` (2px) for free-standing controls and `ring-offset-inset` (-2px) for tabs, rows, menu items and table cells, so the ring is never clipped by a scrolling container. `focus` meets 3:1 in both themes against every ground an outline can land on: `surface`, `surface-raised`, `surface-sunken`, `surface-hover`, `surface-selected`, `accent-soft` and `terminal-bg` (WCAG 2.2 SC 1.4.11 and 2.4.7), and sticky headers and toasts must never cover a focused element (SC 2.4.11). Never remove an outline without replacing it. Use `:focus-visible`, not `:focus`.

All primary controls are reachable by keyboard: Tab through regions (project list, tabs, work area, file tree), arrow keys within them. A focused terminal captures keys; publish one documented key to move focus out of it. Terminal and editor accessibility is limited by xterm.js and Monaco. Enable their screen-reader modes and document the limits in the product; do not paper over them.

## Motion

Motion is functional only. Colour changes take `duration-fast` (120ms); menus, dialogs and toasts enter over `duration-base` (180ms) with `ease-standard`, fading and moving no more than 4px. The transition spinner turns once per `duration-spin`. Skeletons pulse slowly. Under `prefers-reduced-motion: reduce`, durations become zero, the spinner becomes a static half-ring and skeletons stop pulsing.

## Iconography

Icons are outlined on a 24px grid at a 1.75 stroke, drawn by the `Icon` component in `currentColor` at `size-icon-sm` (14px), `size-icon-md` (16px) or `size-icon-lg` (20px). The set is small and stroke-matched to Lucide; engineers may use `lucide-react` icons of the same names at the same stroke. Claude Code and Codex tabs share the neutral `agent` icon and are told apart by their labels; no vendor logos appear in the product chrome. No emoji anywhere.

## The mark

The Portikus mark is a portico seen straight on: a lintel, two columns with capitals and bases, and a base line, framing a small terminal with three code lines and a cursor. The entrance is the product; the terminal inside is the destination. Render it with the `NameMark` component inside the product, where the stone follows the text colour and the terminal keeps `terminal-bg`, `mark-code` and `terminal-cursor` in both themes. Below 24px use the compact variant. Elsewhere use the SVGs in the Logos group: `-ink` on light grounds, `-paper` on dark grounds, `-mono` where only one colour is possible. Never place the mark in a container, add effects, or recolour its terminal.

## Mapping to Tailwind and Radix

Tokens become the Tailwind theme in `apps/web`. Expose each colour token as `--color-<name>` inside `@theme` pointing at its CSS variable (`--color-surface-raised: var(--surface-raised)`), so utilities read `bg-surface-raised`, `text-ink-muted`, `border-line-strong`, `outline-focus`. Set `--spacing: 4px` so Tailwind's numeric steps equal the `space-*` tokens. Map `radius-*` to `--radius-*`, `shadow-*` to `--shadow-*`, and the two families to `--font-sans` and `--font-mono`. Theme switching stays on `data-theme`; density on `data-density`.

Each component is an export of `packages/ui` with the same name. Overlay and form behaviour always comes from Radix: `Menu` wraps `DropdownMenu` and `ContextMenu`, `Dialog` wraps `Dialog`, `ConfirmDialog` wraps `AlertDialog`, `Tabs` wraps `Tabs` with dnd-kit sortable, `Toast` wraps `Toast`, `Select` and `Checkbox` wrap their Radix namesakes, `IconButton` uses `Tooltip`. `PaneHandle` wraps the resizable-panel library's handle. Radix's `data-state`, `data-highlighted` and `data-disabled` attributes are the styling hooks in `bundle.css`; keep them.

## Out of scope

Do not design or build collaboration, presence, grading, instructor takeover of a student session, a graphical Git client, hidden auto-commits or public preview links. Leave room for a role switch in the header and for role-conditional density, and nothing more.
