# 0017. Rich Markdown editing with MDXEditor

- **Status**: Accepted
- **Date**: 2026-09-18
- **References**: SPEC.md §13.2, §13.4, §24.2; STACK.md §3; ADR 0015

## Context

Pilot students asked to format Markdown without knowing Markdown (issue
#155). Until now a Markdown tab offered Edit, Preview and Split, and only the
code side could be edited; the preview was a read-only `react-markdown`
render (ADR 0015). The three views become Code, Rich and Split, both sides
editable and kept in step.

What needed deciding was which editor to put behind the rich view. The
constraint that settles it is the save path: a Markdown tab holds one buffer
of Markdown text, which autosave, Ctrl+S, the conflict view and the diff
view all work on. An editor whose own truth is HTML would need a converter
in both directions, and every round trip through it would rewrite the
student's file in whatever Markdown that converter prefers.

## Decision

The rich view is MDXEditor (`@mdxeditor/editor`, pinned at 4.2.5). It parses
Markdown into its document model and serializes Markdown back out, so the
text stays the truth and the save path is unchanged. It is a React component,
and its toolbar covers the basics the issue asked for: undo, bold, italic,
inline code, block type including headings and quotes, bullet and numbered
lists, links, code blocks, tables and horizontal rules.

It is loaded lazily, the way Monaco is: a `React.lazy` import in `FileLeaf`,
so the app's first load does not pay for it and a student who only opens code
files never downloads it.

Raw HTML processing is switched off (`suppressHtmlProcessing`), keeping ADR
0015's promise that a tag a coding agent wrote never becomes markup in the
control-plane origin (SPEC §24.2). Link URLs are limited to a protocol
allowlist by Lexical, so a `javascript:` link loses its href. What the rich
view does instead with raw HTML is under Consequences below.

`lexical` is a direct dependency of the web app, pinned to 0.48.0, the same
version MDXEditor itself uses. It is MDXEditor's own document model, and the
custom node in `verbatimMarkdown.ts` is written against it. Nothing new is
downloaded: it was already in the tree under MDXEditor.

The two sides are kept in step by the plainest guard that works, in
`apps/web/src/editor/markdownSync.ts`: each side remembers the last text it
produced or was given and ignores anything equal to it, which ends the echo
after one round trip. The rich side's edits are debounced by 300ms before
they reach the buffer, so typing does not rebuild Monaco on every keystroke.
Split-view scroll sync is unchanged: the rich editor scrolls in a plain div
this app owns, so the existing relative-position sync applies to it.

The read-only `MarkdownPreview` component and its front-matter splitter are
removed. Nothing else used them, and the rich view is now the rendered view.

**Rejected alternatives:**

- TipTap: HTML is its document model, so Markdown would need a serializer we
  own and maintain, and every save would risk rewriting the file.
- Milkdown: Markdown-native too, but a larger plugin surface to assemble and
  keep working across upgrades for the same toolbar.
- Writing a toolbar over Monaco that inserts Markdown syntax: cheapest in
  dependencies, but it is not what students asked for; they want to see the
  formatting, not type the marks.

## Consequences

The rich view is a chunk of 679 KB of JavaScript and 51 KB of CSS (213 KB and
9 KB gzipped), fetched the first time a Markdown tab is opened. Because it
replaces the 160 KB `react-markdown` chunk, and `react-markdown`, `remark-gfm`
and `remark-frontmatter` could then be dropped, the whole web build grew by
556 KB, from 6.5 MB to 7.1 MB. Nothing was added to the first load.

Markdown that goes through the rich view comes back in MDXEditor's dialect.
Configured serialization (`-` bullets, `*` emphasis, backtick fences) matches
what students usually type, and headings, lists, fences, tables, links,
quotes and front matter were all checked to come back byte for byte. One
thing does not: MDXEditor drops the file's final newline, so the sync layer
puts it back.

Raw HTML is shown in the rich view as its own source text, in the monospace
face, and never as markup. That is a deliberate second decision, because the
first attempt at it was wrong: turning HTML processing off left no visitor
for MDXEditor to use on a raw HTML node, MDXEditor throws on a node nothing
claims, and the rich view then showed only the text above the first tag and
quietly dropped every keystroke. One HTML comment written by a coding agent
was enough. `apps/web/src/editor/verbatimMarkdown.ts` adds a visitor that
claims those nodes, puts their source in the document as text, and writes the
original node back out unchanged, so the file still round-trips byte for
byte. The source text is never handed to a DOM parser, so the promise that a
tag a coding agent wrote does not become markup is kept.

Markdown images (`![alt](src)`) are rendered, because README badges are
common and a blank page in their place is confusing. The address is checked
first: only ordinary web addresses and relative paths are loaded, and
anything else - `javascript:`, `data:`, `file:` - is shown as source in the
same way. HTML images are not special-cased; they are raw HTML, so they are
shown as source too. That keeps MDXEditor's own HTML-image path, which builds
a DOM element out of the raw HTML with `innerHTML`, unreachable.

A construct no plugin claims can still turn up - a reference-style link, for
one. MDXEditor reports it, and the tab then moves to the code view and says
so, rather than showing a truncated file that cannot be typed in.
