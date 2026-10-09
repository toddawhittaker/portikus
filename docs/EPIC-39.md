# Epic 39: bug fixes and student workspace polish

This plan lives only on `epic/39-workspace-polish` and is deleted by the
fold task (docs/WORKFLOW.md, "Epic plans"). Code, tests and other docs
cite SPEC.md sections or ADRs, never this file.

Base: main `39b5ea81`. No migrations (the highest is `0040`). No new
dependencies.

## Scope

- Bugs: #1302, #1303 (off-site prune), #1331 (Checks process cap), #1340
  (file tree redraw on Show more), #1343 (tree focus lost on removal).
- Student polish: #1346 voice input, #1224 search options, #1225 file tabs
  in splits, #1227 compare with a Git ref or recovery point, #1228 tabs
  follow renames, #1232 short commit id on detached HEAD, #1233 highlighted
  code in the Markdown preview, #1234 zip of a selection, #1265 CSV as a
  table, #1266 zip extraction progress, #1276 narrow layout (pending D1).
- #1215 update coding agents without an image rebuild (pending D2).

## Decisions

Pending with Todd: D1 (#1276 scope), D2 (#1215 in or out), D3 (#1302
approach), D4 (#1346 hold or latch), D5 (#1346 admin off switch). The
orchestrator records rulings here as they are made.

Architect rulings (stand unless Todd overrides):
- #1224: "Match case" off means `-i`, not smart case `-S`.
- #1227: per-file comparison only, no Changes list against a point or ref;
  the ref is typed into a text field.
- #1225: only file tabs join splits; previews stay whole tabs.
- #1234: repeated `path` query parameters on the existing GET, at most 100.

## Per issue

### #1302, #1303 off-site prune (T1, infra)
Files: `infra/host/offsite-prune.sh`, `infra/tests/backup-offsite-test.sh`,
the off-site section of `docs/INSTALL.md`.
- #1302: write the failing test first (stalled upload over 2 hours; set
  started more than a day after its name). If the set survives, close with
  the test as proof. Only if it fails: spare the newest unfinished set until
  it is KEEP days old.
- #1303: run `quota` for the account; warn when there is no block or inode
  limit on DIR's filesystem, or `quota` is missing. Warn only on runs that
  add a set. Test with a fake `quota` on PATH.
- Keep the command line `DIR [KEEP]`. Release note: operators copy the
  script again.

### #1331 Checks process cap (T2)
Start the check through `prlimit --nproc=1700:1700 -- choom …` in
`apps/workspace-agent/src/checks-route.ts` (pattern: `prlimit` in
`extract.ts`). One constant with a comment pointing at the terminals unit
(TasksMax=1700, `infra/workspace-image/portikus.yaml`) and SPEC 19.3. No
image change. Verify a fork bomb in a check on the rehearsal VM.

### #1340, #1343 file tree (T8)
- #1340: profile first. Likely cause: per-row dnd-kit `useDraggable` /
  `useDroppable` re-render every row when one registers. Move tree rows to
  native HTML5 drag and drop (`draggable`, private MIME type, `data-drop-dir`
  like the upload handlers in `useTreeDragAndDrop.ts`); remove the tree's
  `DndContext` and `DragOverlay`; dnd-kit stays for panes and tabs; the
  Move dialog stays the keyboard alternative.
- #1343: extend `repairFocus` (`FileTree.tsx`) and `reseedFocus`
  (`files/rowState.ts`) to keep the previous drawn order and pick next
  sibling, else previous row, else parent; call `.focus()` only when the
  tree held focus (track focusin/focusout; also check
  `document.activeElement === document.body`).

### #1224 search options, #1232 commit id, #1227 Git-ref half (T3)
- #1224: `regex`, `caseSensitive`, `wholeWord` on `SearchQuery`
  (`contracts/src/search.ts`, same `"true"/"false"` transform as `hidden`).
  Agent `search.ts`: drop `-F` for regex; `-s` or `-i`; `-w`; never `-P`.
  rg exit 2 maps to 400 `PATTERN_INVALID`; the panel says "That regular
  expression is not valid." API forwards the flags (`git-search.ts`). Web:
  three `aria-pressed` toggles in `search/SearchPanel.tsx`, flags in the
  query key in `search/useSearch.ts`.
- #1232: `oid: string | null` on `GitStatus` from `# branch.oid` in
  `parsePorcelainV2`; null for `(initial)` and baseline status.
  `shell/StatusBar.tsx` shows 7 characters.
- #1227 ref: optional `ref` on the `git/diff` route in agent and API.
  Contract validation: at most 256 characters, no leading `-`, no control
  characters, no `..` path parts. Agent resolves with
  `git rev-parse --verify --end-of-options <ref>^{commit}`. New code in a
  new `apps/workspace-agent/src/git-compare.ts`, importing `showFromRev`,
  `readWorkingTree`, `finishDiff` exported from `git.ts`; do not grow
  `git.ts`; do not reuse `baselineDiff`. Web: "Compare with: Last commit /
  a Git ref… / a recovery point…" in `work/DiffLeaf.tsx`, local state, not
  saved in the layout.

### #1227 recovery-point half (T4)
Agent route `GET /projects/:slug/recovery-points/:pointId/diff?path=&sha256=`
returning `GitDiff` with the point's version as `before`. Read the one
member with `readArchive` (`recovery.ts`), extract to stdout, cap at
`MAX_DIFF_SIDE_BYTES + 1`, verify sha256 as restore does, with a timeout
the view explains. API route in `apps/api/src/routes/recovery.ts`: look up
the point (proves ownership), pass `sha256`; copy `restore()`; use
`agent.fetchRaw` through a relay, not a new `agent-client.ts` method. Web
part after T3 lands, reusing `apps/web/src/recovery/queries.ts`.

### #1233 highlighted fences, #1265 CSV table (T5)
- #1233: `monaco.editor.colorize` through a helper in `editor/monaco.ts`;
  map the fence language through `monaco.languages.getLanguages()` (ids and
  aliases), unknown renders plain. Use it in the `code` component of
  `editor/MarkdownPreview.tsx`, memoised on code, language and theme.
  Security (SPEC 24.2, 24.3): parse colorize output with `DOMParser` and
  rebuild only `span` elements with class matching
  `^mtk\d+( mtk[ibus])*$` plus text; test that `<img onerror>` in a fence
  renders as text. Contrast: give the preview `pre` the editor background
  or extend `tokenColours.test.ts` to the preview background.
- #1265: View/Edit/Diff toggle for `.csv` copying the SVG View pattern in
  `work/FileLeaf.tsx`. New `work/CsvView.tsx`, `work/csv.ts` (copy of the
  RFC 4180 reader in `apps/api/src/admin/csv.ts`), `work/csv.css` (table
  classes from `src/tables.css`). At most 1,000 rows drawn, "Showing the
  first 1,000 of N rows." First row is `th scope=col`; focusable scroll
  container named after the file; unparsable file offers the text view.

### #1346 voice input (T6)
New `terminal/useSpeechInput.ts` wrapping `SpeechRecognition` /
`webkitSpeechRecognition` (local minimal type, no new @types package);
states unsupported, idle, listening, error; a `network` error counts as
unsupported. Microphone `IconButton` in `terminal/PaneFrame.tsx` with
`aria-pressed`, a `ShortcutHint`, and an always-mounted polite status
region. Shortcut in `useXterm.ts`'s `attachCustomKeyEventHandler` beside
Alt+Shift+Q. Paste the final transcript only, with every C0 control
character (CR and LF included) stripped, through
`term.paste(sanitizePaste(text))`; never Enter. No server change, nothing
logged. Help section in `help/content/student.tsx` saying where audio goes.
Playwright fakes `SpeechRecognition` with `page.addInitScript`. Hold/latch
behavior per D4. Safari to be confirmed on a real Mac.

### #1234 selection zip, #1266 extraction progress (T7)
- #1234: repeated `path` on `GET …/download` (`apps/api/src/routes/projects.ts`)
  and on the agent's `GET /projects/:slug/archive`; `MAX_DOWNLOAD_PATHS = 100`
  in `contracts/files.ts`. Agent: `resolveInProject` each path, drop paths
  inside another selected path, total size against `MAX_DOWNLOAD_BYTES`
  (`checkDownloadSize` takes a list), `zip -r -y` from the common parent
  with relative names after `--`. API reuses `claimLongOperation`,
  `cappedDownload`, `check=1`.
- #1266: in `extract.ts` drop `-qq` and count unzip's per-entry lines,
  capped at the central-directory total; never log names. `{done, total}`
  per project in a `Map`. New `GET /projects/:slug/extract/progress` in
  `files-route.ts`, relayed in `apps/api/src/routes/files.ts`;
  `ExtractProgress` in `contracts/files.ts`. Web data layer in
  `files/queries.ts`; the tree menu and toast wiring is T10's.

### #1225 file tabs in splits (T9)
Drop the `hasNestedDocument` refine for `file` nodes in
`contracts/project.ts` (keep it for `preview`); add a rule that each path
appears at most once in a layout. Web: `layout/tree.ts` (split, move,
remove any leaf; a split collapsing to one file takes back `file:<path>`),
`layout/store.ts` (open finds a file anywhere), `TerminalGroup.tsx` (close
removes the leaf), `WorkArea.tsx` (dirty mark sums files in the tab),
`dropZone.ts`, `usePaneDrag.tsx`, a pane frame for file leaves
(`PaneFrame.tsx` only after T6 lands). Pattern: `migrateDiffTabs`,
`moveLeaf`. Release note: a rollback leaves split layouts unsavable until
rearranged. A move into a split remounts the editor and loses undo history
(autosave keeps the text); say so in the PR.

### #1228 tabs follow moves (T10)
`afterMove` in `FileTree.tsx` calls a new store action
`retargetTabs(from, to)` (`layout/store.ts`, `layout/tree.ts`) instead of
`closeTabsUnder`; it rewrites `file:` tab ids and paths, `diffBaseline`
keys, and editor view state and zoom keyed by path. `FileLeaf` is keyed by
path, so flush or carry the buffer across before the move (test with
unsaved edits). UI moves only; agent or terminal moves stay out. T10 also
wires the tree menu "Download selection" (#1234) and the extraction
progress toast (#1266, native `<progress>`, ticking numbers kept out of the
`role=status` live region).

## Tasks

| Task | Issues | Agent | Owns | Waits for |
|---|---|---|---|---|
| T1 | #1302 #1303 | infra | `infra/host/offsite-prune.sh`, `infra/tests/backup-offsite-test.sh`, INSTALL.md off-site section | none |
| T2 | #1331 | builder | agent `checks-route.ts` and its tests | none |
| T3 | #1224 #1232 #1227 ref | builder | contracts `search.ts` `git.ts`; agent `search.ts` `search-routes.ts` `git.ts` `git-routes.ts` `errors.ts` new `git-compare.ts`; api `routes/git-search.ts`; web `search/*` `shell/StatusBar.tsx` `files/useGitDiff.ts` `work/DiffLeaf.tsx` | none |
| T4 | #1227 point | builder | contracts `recovery.ts`; agent `recovery.ts` `recovery-routes.ts`; api `routes/recovery.ts`; later `DiffLeaf.tsx` `useGitDiff.ts` | T3 for the web part |
| T5 | #1233 #1265 | ui-designer | `editor/MarkdownPreview.tsx` `markdown.css` `monaco.ts` new `highlight.ts`; `work/FileLeaf.tsx` new `CsvView.tsx` `csv.ts` `csv.css` | none |
| T6 | #1346 | builder | `terminal/PaneFrame.tsx` `TerminalLeaf.tsx` `useXterm.ts` `terminal.css` new `useSpeechInput.ts`; `help/content/student.tsx` | D4, D5 |
| T7 | #1234 #1266 server + data | builder | contracts `files.ts`; agent `projects.ts` (archive) `files-route.ts` `extract.ts`; api `routes/projects.ts` (download) `routes/files.ts` (progress) `agent-client.ts`; web `files/queries.ts` | none |
| T8 | #1340 #1343 | ui-designer | `files/FileTree.tsx` `useTreeDragAndDrop.ts` `rowState.ts` `treeKeys.ts` `ShowMoreRow.tsx` `files.css` | none |
| T9 | #1225 | builder | contracts `project.ts`; `layout/tree.ts` `store.ts` `persist.ts` `SplitTree.tsx`; `work/WorkArea.tsx` `work.css` `dropZone.ts` `usePaneDrag.tsx`; `terminal/TerminalGroup.tsx` | T6 for `PaneFrame.tsx` |
| T10 | #1228 + tree wiring for #1234 #1266 | ui-designer | `files/FileTree.tsx` `layout/store.ts` `layout/tree.ts` `work/FileLeaf.tsx` `work/useFileBuffer.ts` `files/files.css` | T5 T7 T8 T9 |
| T11 | fold | builder | SPEC.md (11.5 11.6 12.1 12.6 13.4 9.3/8.3 18.1 19.3 24.9 25.8), STATUS.md, voice-input ADR, help lines; deletes this file | all |

No task edits `e2e/helpers.ts`, `docs/STATUS.md` or `docs/SPEC.md` except
T11. New Playwright specs need no shard-list edit.

## Reviews

- Security (SPEC 24): T1 (write-only target, quota check), T2 (19.3, 24.4),
  T3 (ref injection, no `-P`), T4 (member names, sha256, ownership), T5
  (Monaco HTML on the app origin), T6 (privacy 25.10, control characters,
  no Enter), T7 (path confinement, total cap, symlinks, no names logged),
  T9 (layout JSON is attacker-controlled; depth and size limits stay).
- Accessibility (SPEC 25.8): T3, T4, T5, T6, T8, T9, T10.

## Left out

Agent or terminal moves for #1228; a Changes list against a point or ref;
previews in splits; TSV, header toggle and sorting for CSV; in-browser
Whisper; an operator-set prune size limit; a virtualised file tree; checks
in tmux or a delegated cgroup; an automatic agent update check; splitting
`FileTree.tsx` and `git.ts` (#1289).
