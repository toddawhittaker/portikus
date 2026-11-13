Portikus is a browser-based development workspace for students learning agentic software development. The name is German for portico, a covered entrance between spaces, and the identity follows from that: Portikus is the entryway, not the destination. It should feel like the calm, well-made entrance to a real workshop for adults. The real tools inside it (a shell, Git, Docker, Claude Code, Codex, Monaco) are the destination, and the interface stays quieter than they are.

## Principles

Simplify access to the development environment without simplifying the environment itself. A project is a directory, a terminal is a terminal, a preview is a running service. Never draw a parallel model on top of those facts.

Real tools stay real. Terminals are monospaced and square-cornered, dark by default and light if the student chooses, per terminal. File trees are indented lists of folders and files. The editor is Monaco with its own chrome and the product's syntax colours. Do not round, frame or decorate them.

Quiet by default, with colour that means something. The chrome is warm neutral: ivory in the light theme, charcoal in the dark. Teal marks what you can act on and what is selected. Violet belongs to the coding agents, so their activity is never confused with an action. Status colours carry state and are never decoration. The only picture is the small portico above empty, starting and error messages; no mascots, confetti, streaks, points or encouragement.

Immediate over animated. Show a skeleton or an optimistic state within 100ms. Continuous motion means something is under way: the transition spinner (the workspace is moving toward its desired state) and the agent's turning ring (an agent is working).

## Voice and copy

Write in plain sentences, in sentence case, addressing the student as "you" and the workspace as "your workspace". Name things by what the person sees: projects, folders, terminals, previews, recovery points.

Errors follow one order: user terms first, implementation second, actions last. "Your workspace could not start because its storage allocation is full. Docker is using 19.8 GB of your 20 GB Docker quota." followed by **Reset Docker…** and **Workspace details**, with no **Try again** when starting again would fail the same way. Students read the sentence; administrators can expand the technical detail (`errorCode`, `errorMessage`) under Technical details.

Buttons name their result ("Start workspace", "Reset Docker", "Open in new tab"). A menu item that opens a confirmation ends with an ellipsis. Numbers carry units and a limit ("4.1 GB of 5 GB"). Refusals are plain and final without blame: "You're signed in with your institution, but your account doesn't have access to Portikus."

Never use exclamation marks, emoji, "Oops", "Whoops", or countdown urgency beyond the facts. Never show a share link for a preview, and never show recent commands, prompts or an activity feed; the platform does not record them.

## Colour

Every colour is a semantic token with a light and a dark value. Set `data-theme="light"` or `data-theme="dark"` on the root; follow the operating system by default and let the person override it. `packages/ui/src/theme.css` holds the values; `tokens.json` lists them with their uses.

Surfaces come in three steps, so the work reads first. `surface` is the chrome: the header, the side panes, pane heads, tab strips and the status bar, a warm ivory (`#f5f1e8`) in light and a warm charcoal (`#1f1e1b`) in dark. `surface-work` is the work area's ground (the editor, terminals and chat): a step lighter in light (`#fffdf8`), and in dark the darkest step (`#171614`), so the canvas sits below the chrome there; inside the work area `surface` is repointed to it, and `surface-chrome` keeps a tab strip there on the chrome tone. `surface-raised` is anything that sits on top: cards, dialogs, menus, toasts, inputs, table bodies and the composer (white in light, `#2a2825` in dark). `surface-sunken` is a well inside a surface, such as a code block or the technical detail of an error. `surface-hover` is the hover fill. `surface-selected` (the same as `accent-soft`) marks the selected tree or table row, and in the right pane's lists (Files, Checks, Changes, Running) the picked-out row uses the neutral `surface-row-selected` with a 2px `ink` bar on its start edge, so selection never reads as a passed check or an added file. `surface-inverse` is the tooltip ground.

Text: `ink` for primary text, `ink-muted` for secondary text and inactive tab labels, `ink-faint` for placeholders, code comments and the faintest metadata. `ink` and `ink-muted` meet 4.5:1 on every surface in both themes; `ink-faint` meets it on `surface`, `surface-work`, `surface-raised` and `surface-sunken`. Text on an accent mark (a checked box's tick) is `on-accent`; on a filled primary button, `on-accent-fill`; on a danger fill, `on-danger`; on `surface-inverse`, `ink-inverse`. Never use literal white.

Lines: `line` is a decorative hairline between panes, rows and pane heads. Any control boundary (input, secondary button, checkbox) uses `line-strong`, which meets 3:1 on `surface`, `surface-work` and `surface-raised`.

Accent (teal, `#1d6e67` light, `#2f9e8a` dark) is for actions and selection: the selected tab's foot bar, the selected project row's and table row's start bar, checked boxes, the edge of a chosen filter chip, progress and the active item in the phone's pane bar. `accent-hover` and `accent-active` are its hover and pressed tones. `accent-soft` fills a selected row, a chosen chip and the pane-bar pill. `accent-text` is for links, selected names and the icon of a selected tab or rail item.

Filled buttons have tokens of their own. `accent-fill` is the primary button, with `accent-fill-hover` and `accent-fill-active`, and `on-accent-fill` (white) for its label. In light it is the accent itself; in dark it is a deeper teal (`#14776b`), so a dark-theme primary is white on deep teal, its label well over 4.5:1, while the brighter `accent` stays for marks, dots and selection. `danger-fill` is the filled destructive button, white `on-danger` on solid red in both themes (`#b0372b` light, `#c23b30` dark), with `danger-hover`. A page has at most one filled primary button, for the action the page is for; every other action is secondary, quiet, or an item in a More menu. `status-danger` stays the colour of destructive text and edges, such as the danger-secondary button.

Agent (violet, `#6a4cc2` light, `#b4a2ff` dark) is the coding agents' own hue: agent tab icons, the turning working ring, menu items that start an agent, Claude's byline in a chat, the composer's options summary, the agent plan meters and the prompt in the state picture. `agent-text` and `agent-soft` are its text and fill. Never use it for an action or a selection.

Brand: `brand-tile`, `brand-stone` and `brand-spark` colour the mark and nothing else, except that the gold `brand-spark` is also the cursor in the state picture.

Terminal: `terminal-bg`, `terminal-fg`, `terminal-muted`, `terminal-cursor`, `terminal-selection`, `terminal-line` and the sixteen `ansi-*` tokens form the xterm.js theme. They have a dark set (the default, a warm near-black `#171614`, the dark work ground) and a light set (`#fdfcfa`), chosen per terminal by `data-terminal-theme` and independent of the page theme. Every ANSI foreground meets 4.5:1 on its own `terminal-bg`.

Code: Monaco gets two themes built from warm hues that read apart, so the editor belongs to the product: terracotta keywords and tags, sage strings, teal numbers and constants, amber types, attributes and decorators (function names too in chat code), blue for SQL built-ins, and `ink-faint` comments set in italic. Violet stays out of code, as it means an agent. Chat code blocks use the same colours. Each meets 4.5:1 on the editor ground and its current-line highlight. The editor ground is the work surface. The minimap is off; instead a clean scrollbar carries an overview ruler with coloured ticks for Git added, modified and deleted lines, warnings, errors and find matches, in the Git, status and accent colours.

## Status colour and badges

Workspace states use four tokens, each with a `-soft` fill: `status-starting` (also for setting up and stopping), `status-running`, `status-stopped`, `status-error`. Two more serve the rest of the product: `status-warning` (amber) for anything waiting on the student or near a limit, and `status-danger` for destructive actions. Error and danger share a hue today but are separate tokens so they can diverge. Git has its own five (`git-added`, `git-modified`, `git-deleted`, `git-conflict`, `git-conflict-soft`); a conflict is a magenta of its own so it never looks like an ordinary change.

Every status is drawn by one `Badge` with a tone: `success`, `warning`, `danger`, `info`, `neutral`, `accent` or `agent`. Workspace states, check results, Git letters and the needs-input tag all use it, so they share one height, radius and type. Pick a tone for a new status; do not draw a new pill.

On administrator and course pages a badge is kept for exceptions, so it stands out because it is rare: an error, a throttled or flagged workspace, a waiting invitation. A normal state there is quiet: the plain StateBadge, its glyph and word with no fill (a filled dot for Running, an open ring for Stopped). A count of errors that is zero is drawn neutral, never red, and a page shows one attention count, not the same number twice. Health's count in the rail is a small `status-warning-soft` pill.

Setting up and Starting share the blue `info` tone on purpose: motion, not alarm. Stopping takes the `neutral` tone, since the workspace is on its way to Stopped; a pending operation such as a rebuild keeps the `info` tone whatever the state. When `desiredState` differs from `state`, show the transition with the StateBadge spinner and never with the danger tone, however long it takes. Every status carries a word and a distinct glyph (filled dot, open ring, spinner, alert triangle), so colour is never the only signal. Every status foreground meets 4.5:1 on its soft fill and on `surface`, `surface-work` and `surface-raised` in both themes.

Attention has one colour. An agent that needs input shows an amber triangle and an amber state line in the project list (never a row fill, which would read as the selection), a triangle in its tab and the warning Badge; every card docked over the chat composer waiting on the student (permission, question) has a 4px amber start border and `shadow-md`. Errors in the chat and on the workspace card have a 4px `status-error` start border. Guidance under a short list, and info callouts in help, use the `info` fill with `ink` text.

## Type

Public Sans is the interface face: an open, sturdy grotesque designed for public-service interfaces, legible at 12px, with no personality to compete with code. JetBrains Mono is the monospace for terminals, Monaco and code set in the interface, with ligatures turned off so code reads literally. Both are variable fonts under the SIL Open Font License, shipped as files in `fonts/`. Paths, folders and labels in the chrome use the interface face, so chrome never reads as code.

The interface uses five sizes: 12, 14, 16, 20 and 24px (`text-xs`, `text-md`, `text-lg`, `text-xl`, `text-2xl`). 12 is metadata, captions, badges and the status bar. 14 is the body: rows, tabs, labels, buttons, menus and navigation. 16 is pane titles, the project name in the header, section and empty-state headings, and chat prose. 20 is dialog titles. 24 is page titles and standalone pages. 600 weight is for titles, selected names and badges only; button labels are 500.

Administrator and course pages have three levels of their own. The page title is 28px (36px line, 600, tracked in a little), a section title is 18px (26px line), and the overline names a group, a tile, a rail group or a table column: 11px, 600, spaced capitals (0.06em), in `ink-muted` (`ink-faint` for the rail's group labels). The overline is the one thing in the product under 12px; nothing else is. Running text on those pages is capped at 52ch, about 65 to 70 characters of Public Sans, however wide its card is.

Code has its own size: 13px (`text-sm`, in the mono face) for code set inside the interface, such as chat code blocks and shell boxes, and 14px for the editor and terminal at 100% zoom. Administrator tables at compact density use 13px.

The type utilities map onto the scale: `text-display` 24, `text-title` 20, `text-heading` 16, `text-body`, `text-compact` and `text-label` 14, `text-caption` 12, `mono-body` 13 and `mono-small` 12.

## Space, density and layout

Spacing is a 4px scale named to match Tailwind's default steps (`space-3` is 12px, `p-3` in Tailwind). Pane gutters are `space-5` at comfortable density; dialogs pad `space-6`; standalone pages pad `space-10` and sit `space-16` from the top.

Density is set with `data-density` on a container. Students get `comfortable` (36px controls, 32px rows, 28px file tree rows, 36px tabs, 14px text). Administrators get `compact` (32px controls, 28px rows, 22px file tree rows, 30px tabs, 13px text). Administrator and course pages also set `data-controls="console"`, which keeps compact rows but gives every button, field and select the student's 36px height and 14px label, so one control size runs across the console; a dialog copies both attributes from whatever opened it. On a phone (under 35rem) every control on those pages is at least 44px tall (`size-control-lg`), a row's checkbox is drawn at 20px inside a 44px target, and segments, disclosures, sort buttons and the help mark take a 44px tap area too (WCAG 2.5.8). Components read `--pk-control`, `--pk-row`, `--pk-tree-row`, `--pk-tab`, `--pk-pad` and `--pk-font`, which `bundle.css` maps from the `density-*` tokens, so a component never branches on role. The P2 roles (instructor, developer, support) choose a density rather than getting new components.

The application shell is three panes: project list on the left, tabbed work area in the centre, and the right pane (Files, Checks, Running, Monitor, Problems) on the right, separated by 1px `line` with a PaneHandle. Every pane head is the height of the tab strips, so the line under them meets across the shell. On a window 1360px or wider the side panes start at 264 and 360px; narrower, they start at 240 and 280px so both still fit beside the work area's 360px minimum at 56rem. The right pane's tabs show icon and name when the pane is wide, names alone at desktop width, and the chosen name only when the pane is under 22rem, the others named by icon, tooltip and accessible name.

Below 56rem the work area fills the shell, the width handles hide, and a pane bar along the foot holds Projects, Work and Files, each an icon over a 12px label. The item in view has an `accent-soft` pill behind an `accent` icon and an `accent-text` label. Projects and Files open their panes as drawers between the header and the pane bar, which fade in over a scrim; Work closes them. Under 40rem a drawer is opaque and full width, its rows grow to 44px and its buttons to 40px or more, and the header grows to 56px and shows the mark alone. In a short window (under 30rem tall) the bar slims to 48px and the drawers take the header's height too. An open drawer hides the rest of the shell with `aria-hidden`, not `inert`, so live regions stay heard and toasts stay reachable (ADR 0047). It closes on Escape, its close button, the scrim, Work, a chosen link or file, a change of project, or code moving focus behind it. Focus returns to its pane-bar button, or, if a wider window hid the bar, to the pane's selected tab or first control. The `size-rail` icon rail is a mockup for later.

## Shape and elevation

Corners are small. Real tools take `radius-none`. Controls, badges and menu items take `radius-sm`; tabs stay square; menus, toasts and cards `radius-md`; dialogs and the sign-in panel `radius-lg`. `radius-full` is only for status dots, spinners, the pane grip, the round Jump to latest button, the pane-bar pill and count pills.

Panes and tables are separated by lines, never shadows. Cards in the work area have one of two levels. A card that rests in the flow (the composer, a chat's step groups and shell boxes, check output) is `surface-raised` with a `line` border and `shadow-sm`. A card that asks for attention or floats (permission and question cards, the workspace starting card, menus, popovers, tooltips, toasts, the Jump to latest button) takes `shadow-md`. Dialogs take `shadow-lg`. A dragged tab lifts with `shadow-sm`. In the dark theme `shadow-md` and `shadow-lg` include a hairline so edges stay visible. Layers stack by `z-pane-handle`, `z-sticky`, `z-dialog`, `z-menu`, `z-toast`; a menu sits above a dialog because dialogs contain menus.

## Selection

There is one selected look per kind of thing, and it is the same everywhere.

- A tab in the work area is selected by a `surface-work` face, so it opens onto the canvas under it, `ink` text and a 2px `accent` bar along its foot, with its kind icon in `accent` (or `agent` for an agent tab). A right-pane tab takes the `surface-raised` face with the same bar.
- A row in the project list, including an agent row, is selected by an `accent-soft` fill, a 2px `accent` bar on its start edge and its name in `accent-text`. An agent's state stays on its mark, never on the selection. The current option of the composer's `/` and `@` list looks the same, with no ring of its own, since the message box keeps the focus.
- A row in the right pane's lists is selected by `surface-row-selected` and a 2px `ink` bar.
- An item in the admin rail is selected by the `surface-selected` fill, a 2px `accent` bar on its start edge, `ink` text at 600 and its icon in `accent-text`.
- A table row opened in an inspector (a person on Users, a line on Logs or Audit) takes the project row's look: `accent-soft` behind every cell and a 2px `accent` bar on the first.
- A filter chip that is on, and a segment that is chosen, are described under "Filter bars and dense forms".

## The composer

The chat composer is a `surface-raised` card with `shadow-sm`. Its bottom row holds only attach, the Chat options summary, the microphone, Stop and Send. The summary (for example "Opus · Extra high · Plan", in `agent-text`) opens the Chat options panel, a disclosure holding the model, effort, permission and read-aloud pickers. A value other than the start value is set in bold, and Bypass permissions carries the warning colour and icon, in the panel and on the summary. Send is the accent primary while there is something to send, and a flat `surface-sunken` circle with a muted arrow, `aria-disabled` with its reason, while the box is empty or a send is under way. Stop sits beside it while a turn runs: the same 36px circle with a 2px `ink` ring and a solid `ink` square. Under the pickers, the context figure is the slim meter ("Context", a violet bar, "58%") once more than half the window is used, amber from 80% and red from 90%, and the cache reads "Cache expires in 48:00".

## States and the state picture

Empty, starting and error states share one picture, `StateArt`: the portico of the mark on a soft round backdrop, with a violet prompt and a gold cursor in its doorway and the state's icon in a small badge at its corner. It is 96 by 72px, decorative and hidden from assistive technology. The error tone swaps the backdrop and badge to the error colours. While something is under way, such as the workspace starting, the cursor blinks (not under reduced motion). The picture is the only illustration in the product.

A loading pane keeps its shape: a stopped or starting workspace shows skeleton rows in the side panes and skeleton tabs over the work area, and a file that is opening shows a page of placeholder lines with its save state and language hidden until it arrives.

## Focus and keyboard

Every platform-owned control shows a visible focus indicator: a solid `ring-width` (2px) outline in `focus`, offset `ring-offset` (2px) for free-standing controls and `ring-offset-inset` (-2px) for tabs, rows, menu items and table cells, so the ring is never clipped by a scrolling container. `focus` meets 3:1 in both themes against every ground an outline can land on: `surface`, `surface-raised`, `surface-sunken`, `surface-hover`, `surface-selected`, `accent-soft` and `terminal-bg` (WCAG 2.2 SC 1.4.11 and 2.4.7), and sticky headers and toasts must never cover a focused element (SC 2.4.11). Never remove an outline without replacing it. Use `:focus-visible`, not `:focus`. The one exception is a modal dialog box itself (`.pk-dialog:focus`): it is a container that takes focus only so a screen reader starts inside it, so it shows no outline; every control inside it keeps its ring.

All primary controls are reachable by keyboard: Tab through regions (project list, tabs, work area, file tree), arrow keys within them. A focused terminal captures keys; publish one documented key to move focus out of it. Terminal and editor accessibility is limited by xterm.js and Monaco. Enable their screen-reader modes and document the limits in the product; do not paper over them.

## Motion

Motion is functional only. Colour changes take `duration-fast` (120ms); menus, dialogs, toasts and narrow-window drawers enter over `duration-base` (180ms) with `ease-standard`, fading and moving no more than 4px. The transition spinner and the agent's working ring turn once per `duration-spin`. Skeletons pulse slowly and the state picture's cursor blinks while busy. Under `prefers-reduced-motion: reduce`, durations become zero, the spinner and ring stop as whole rings, and skeletons and the cursor stop.

## Iconography

Icons are outlined on a 24px grid at a 1.75 stroke, drawn by the `Icon` component in `currentColor` at `size-icon-sm` (14px), `size-icon-md` (16px) or `size-icon-lg` (20px). The set is small and stroke-matched to Lucide; engineers may use `lucide-react` icons of the same names at the same stroke. Claude Code and Codex tabs share the `agent` icon, drawn in the `agent` hue, and are told apart by their labels; no vendor logos appear in the product chrome. No emoji anywhere.

The product adds names to the set as screens need them; each one is Lucide's shape at the same stroke. `help` (Lucide `circle-help`) marks a Toggletip button and the Help item in the account menu, and nothing else. `arrow-left` and `arrow-right` are Back and Forward in the preview toolbar. `arrow-up` is Send in the chat's message box. `download` marks getting a copy into the workspace or onto the computer, such as Clone repository. `shield` and `school` name the two console areas in the header (Administration and Course), and `bell` is the notifications count beside the account button. The admin rail gives each page the Lucide icon of its subject, listed in the Icon README.

## Help in the product

Two components explain the product where it is used. Both hold plain sentences only, in the voice above.

**PageIntro** is one or two sentences under a page's heading on what the page is for, in a native `details` whose summary reads "About {page}". It is open until the person closes it, and the browser remembers that per page. Given a `lead`, one short sentence on the page's purpose shown above the disclosure, it starts closed instead: every admin page works this way, so the work starts near the top. It has no card, fill or border: body text in `ink-muted`, at most 72 characters wide, with an optional "More in Help" link that opens the matching Help section in a new tab. The parent spaces it with `gap`; it sets no margin. Use it once per page, directly under the h2, and only where the page's purpose is not obvious from its heading.

**Toggletip** is a quiet 24px button with the `help` icon, named "About {subject}", that shows one to three sentences in a small raised panel when it is clicked or pressed with Enter or Space. It never opens on hover, so it works the same by touch, mouse and keyboard. Focus stays on the button while it is open, and a polite live region reads the text out; the region sits at the end of the page or of the dialog holding the tip, so the text never joins a table header's or label's name. The visible panel is hidden from screen readers and the button makes no popup claim. Tab or Shift+Tab moves on and closes it, as do Escape and a click outside; after Escape, focus is still on the button. Place it beside a field's label (the `help` slot of TextField and Select, outside the `label` element), after the text in a table header cell, beside a section heading in the same row (never inside the heading element), or beside a button in the same actions row. Never put one inside a sentence, never put a link or control inside one, never give a control more than one, and leave it out where visible text already explains. A Tooltip is still right for naming an icon-only button; a Toggletip is for explaining.

## Buttons

`primary` is the `accent-fill` with an `on-accent-fill` label, and a page has at most one: the action the page is for (Add user… on Users, Save in a Settings section while it holds a change). Other ways to start the same kind of work sit in a More menu beside it (Invite… and Import from CSV…). `secondary` is the raised face with a `line-strong` edge; `quiet` has no edge until hovered. `danger` is `danger-fill` with an `on-danger` label and appears only as the confirming button of a destructive dialog. `danger-secondary` is a row's own destructive action: `status-danger` text and edge on the raised face.

A button that cannot act, `disabled` or kept focusable with `aria-disabled` and a reason, fades whatever its variant: no fill, a solid `line` hairline edge (never dashed, which reads as broken), `ink-faint` text that still meets 4.5:1 on every surface, and the not-allowed cursor. Fading the whole button with opacity is not allowed, because its label would drop under 4.5:1 in the dark theme. A busy button keeps its colour and shows the spinner.

A row's own action on an administrator page (Restore…, Revoke…) is a quiet text button 28px tall that gains a `line-strong` edge on hover, so a column of them reads as one column. Actions a row rarely needs go in a `more` menu at the row's end, leaving at most one visible action per row.

## Filter bars and dense forms

Dense filter bars on administrator screens (the Users filters, the Logs time filter) keep the native `select`. It is faster to scan, needs no portal, and matches its neighbours' height at compact density. It drops the browser's arrow for a caret in `ink-muted`, and `color-scheme` follows the theme, so its list opens in the right colours; native checkboxes and radios tick in `accent`. A disclosure shows the `chevron-right` icon, turned a quarter when open, never the browser's triangle. Everywhere else a choice uses the `Select` component.

A page's toolbar (search, filters, a More filters toggle on a phone) sits on one line with no labels above its controls; each keeps its label for assistive technology, and its shown value ("All roles") says what it filters.

Filter chips have one off look and one on look, everywhere. Off: the raised face, a `line-strong` edge and `ink-muted` text. On: the `accent-soft` fill, an `accent` edge, `ink` text and a `check` icon before the label, so the state never rests on colour alone. A level's colour (error red, warning amber, info blue) lives only in a small dot inside the chip, in both states. A chip is a checkbox when several can be on (the Logs levels) and a pressed button when one of a set is chosen (the Course members filter); either way it never takes the filled primary look. A count inside a chip is a small `surface-sunken` pill in tabular figures.

A segmented control (`pk-segmented`, a `fieldset` of pressed buttons with a hidden legend) chooses one view of the same data, such as Health's time range. The chosen segment is `accent-soft` with `accent-text` and an inset `accent` edge, never the filled primary.

When a Settings section holds an unsaved change, each changed row carries a 2px `status-warning` bar at its start, and the section's save row floats at the foot of the window as a sticky bar (`surface-raised`, `line-strong` edge, `radius-md`, `shadow-md`) that rises 8px into place, so Save stays in reach however long the section is. It says what is unsaved on the left, with Discard changes and the section's own Save, the primary, on the right. With nothing to save it rests in the flow, Save secondary and `aria-disabled` with its reason.

## Administrator and course pages

Every administrator page and every instructor course page uses one console frame, read top to bottom.

- **Rail.** On administrator pages a section rail runs down the left edge (12rem, 14.5rem from a 64rem window), with each group named by an overline and the open page in the rail's selected look. It stays in view while the page scrolls. On a phone it folds into one 44px control naming the open page, which opens every page as a grouped list of 44px tiles.
- **Eyebrow.** A quiet line over the title: the portico glyph in `accent-text` and where the page sits ("Administration", or "Courses / CS 1210") in `text-sm` `ink-muted`. A page reached from another (a live help session) puts its one back link here instead.
- **Title row.** The 28px title, an optional count in tabular figures, and the page's actions at the end of the row. Under it, one sentence says what the page is for, with "About {page}" opening the rest and "More in Help". On a phone the actions take a full-width row under the title, primary first.
- **Attention.** When something needs a person now, an attention list comes first: one raised card with a 3px `status-warning` start edge (`status-error` when something has failed), one row per problem with an alert icon, a sentence, its evidence and its actions. Nothing to show is a quiet one-row state, not an empty card.
- **Work surface.** A table, chart or form at the measure that suits it: tables and dashboards run to 80rem, a column of cards read top to bottom stops at 52rem.
- **Inspector.** Where a row can be opened, a raised panel opens beside the table from a 62rem content width (24rem wide), stays in view while the list scrolls and scrolls inside itself. On Users it has three tabs drawn as the student right pane's strip: Overview, Activity and Account. Overview carries a small amber dot when the workspace has a problem. Every tab stays mounted, so an edit survives a switch.
- **Status bar.** The student status bar's line runs along the foot of every administrator page: the site, the image, workspaces running, memory and storage as slim meters, load, and one state ("All healthy", or "3 to look at" with the alert icon and a `status-warning` edge) that leads to Health.

Figures to read first sit in one strip of equal cells divided by hairlines, not floating cards: an 11px overline label, the figure in JetBrains Mono at 28px with its unit small in the interface face, and its detail or meter at the foot; a cell that needs attention takes a 3px `status-warning` top edge. Labels and values pair in one grid whose label column is 10.5rem on every page, stacking the label over its value in a narrow card.

Tables on these pages are reading surfaces: hairline rules between rows, no bands, and a 36px header on the table's own raised face in the overline style. Tabular figures and end alignment belong to numeric columns only (`pk-num`); names, dates and times in running text keep the face's proportional figures. A row's `more` button is drawn in `ink` at 18px with no edge of its own. A table too wide for its place scrolls sideways in its own box, and only then is the box a named region in the tab order (`TableBox`), so the keyboard can scroll it. Where its box is under 42rem the Users table becomes a stack of rows rather than losing columns.

A dialog follows the density of whatever opened it: one opened from a compact administrator screen is compact too, although it renders outside that screen's container.

## The mark

The Portikus mark is a rounded teal tile holding an ivory portico seen straight on (pediment, lintel, two columns, a step) with a gold prompt and cursor in its doorway. The entrance is the product; the prompt inside is the destination. Render it with the `NameMark` component inside the product, in the brand tokens (`brand-tile`, `brand-stone`, `brand-spark`), which read the same on every surface. Elsewhere use the SVGs in the Logos group: `-ink` on light grounds, `-paper` on dark grounds, `-mono` where only one colour is possible, `-compact` for favicons. Never add an outline, shadow or gradient, and never recolour the mark.

## Mapping to Tailwind and Radix

Tokens become the Tailwind theme in `apps/web`. Expose each colour token as `--color-<name>` inside `@theme` pointing at its CSS variable (`--color-surface-raised: var(--surface-raised)`), so utilities read `bg-surface-raised`, `text-ink-muted`, `border-line-strong`, `outline-focus`. Set `--spacing: 4px` so Tailwind's numeric steps equal the `space-*` tokens. Map `radius-*` to `--radius-*`, `shadow-*` to `--shadow-*`, and the two families to `--font-sans` and `--font-mono`. Theme switching stays on `data-theme`; density on `data-density`.

Each component is an export of `packages/ui` with the same name. Overlay and form behaviour always comes from Radix: `Menu` wraps `DropdownMenu` and `ContextMenu`, `Dialog` wraps `Dialog`, `ConfirmDialog` wraps `AlertDialog`, `Tabs` wraps `Tabs` with dnd-kit sortable, `Toast` wraps `Toast`, `Select` and `Checkbox` wrap their Radix namesakes, `IconButton` uses `Tooltip`, `Toggletip` wraps `Popover`. `PaneHandle` wraps the resizable-panel library's handle. Radix's `data-state`, `data-highlighted` and `data-disabled` attributes are the styling hooks in `bundle.css`; keep them.

## Out of scope

Do not design or build collaboration, presence, grading, instructor takeover of a student session without the student's consent (live help, which the student starts and ends, is allowed), a graphical Git client, hidden auto-commits or public preview links. Leave room for a role switch in the header and for role-conditional density, and nothing more.
