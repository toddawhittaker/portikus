# 0015. Editor stack: bundled Monaco and react-markdown

- **Status**: Accepted
- **Date**: 2026-09-18
- **References**: SPEC.md §13.1, §13.2, §13.4, §24.2, §24.3; STACK.md §3

## Context

STACK §3 names Monaco for editing and diffs and SPEC §13.4 requires Markdown
editing, preview and a side-by-side mode. What needed deciding was how much of
Monaco to load, how to load it in a Vite build, and how to render Markdown a
coding agent may have written, which is untrusted content (§24.2).

## Decision

Monaco is a pinned dependency bundled with the app and loaded lazily when a
document tab first opens. It is imported as `monaco-editor`'s `editor.api`
entry plus the Monarch highlighters and the JSON language service, and its
workers come from Vite's `?worker` imports. The TypeScript, CSS and HTML
language services are left out: their diagnostics do not know the project's
configuration and would show a student errors that are not real, and leaving
them out keeps roughly nine megabytes of workers out of the bundle. Portikus
is not a VS Code clone (§13.2). Themes are defined from the design tokens in
`packages/ui`.

Markdown is rendered with `react-markdown` plus `remark-gfm` for tables and
task lists and `remark-frontmatter`. `rehype-raw` is deliberately not
enabled, so raw HTML in a Markdown file is not rendered and a file an agent
wrote cannot inject markup into the control-plane origin. Front matter is
split off before rendering and shown as a collapsed block, because it is
metadata rather than prose. A Markdown tab opens in Preview and offers Edit,
Preview and Split.

**Rejected alternatives:**

- `@monaco-editor/react`: a wrapper around a loader we do not want, adding a
  dependency to hide about forty lines of effect code.
- `vite-plugin-monaco-editor`: another build plugin to keep working across
  Vite upgrades; the `?worker` imports Vite already supports do the job.
- Loading Monaco from a CDN: a third-party origin in the page, an offline
  failure mode, and a supply-chain surface for no gain once it is pinned.
- The TypeScript language service: see above, wrong diagnostics for a project
  whose build the editor knows nothing about.
- `markdown-it` plus a sanitizer: sanitizing untrusted HTML correctly is a
  standing risk we would own; not rendering HTML at all is a smaller promise
  to keep.
- CodeMirror: lighter, but STACK §3 chose Monaco, and the diff editor of
  §12.6 comes with it.

## Consequences

The editor and the Markdown renderer are each their own chunk, so the app's
first load does not pay for them. Highlighting is Monaco's own, so a language
it does not know shows plain text. The cost of dropping `rehype-raw` is that
Markdown with inline HTML renders as text; the cost of dropping the language
services is no IntelliSense, which the coding agent in the terminal beside the
editor is the answer to. Relative images in Markdown do not resolve, and code
blocks inside Markdown are not highlighted; both are in `docs/BACKLOG.md`.
