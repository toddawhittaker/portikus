# 0072. Syntax colours in the chat come from highlight.js core, loaded lazily

- **Status**: Accepted (Epic 59)
- **Date**: 2026-11-09
- **References**: SPEC.md sections 10.8, 24.3, 25.1 and 25.8; STACK.md section 35; docs/DESIGN.md; ADR 0069; issue #1784

## Context

Fenced code in a chat reply and the lines of an edit diff were shown
without syntax colours. Every chat a student compares Portikus with colours
them and names the language. The chat already carries Markdown rendering,
and the first page and the chat's own chunk have size budgets (SPEC.md
section 25.1). Reply text is untrusted (SPEC.md section 24.3), so whatever
draws it must not turn it into markup.

## Decision

1. **highlight.js core with twelve languages, registered one by one.**
   `highlight.js` is pinned exactly. `apps/web/src/chat/highlight.ts`
   registers Python, JavaScript, TypeScript, Java, C, C++, HTML (`xml`),
   CSS, JSON, SQL, shell (`bash`) and diff on a private instance. Fence
   tags and file extensions map to those twelve; any other tag is named
   above the block as written and drawn plain.
2. **Loaded only when a known-language block renders.** Core and the
   languages are dynamic imports, fetched the first time a block in a known
   language is drawn and shared afterwards. They are separate chunks (about
   74 KB, 31 KB gzipped, at Epic 59). The first page does not change, and
   the chat's chunk grows only by the language table and the token reader.
   Until the load finishes the block is plain text in the same box, so
   nothing moves when the colours arrive.
3. **Never guess.** The language comes from the fence tag, or for a diff
   from the file's extension. Automatic detection is never used. A block
   over 20,000 characters stays plain.
4. **The output is read back, never set as HTML.** highlight.js returns
   escaped text inside `<span class="hljs-…">`. The token reader accepts
   only that shape and rebuilds it as React text and spans; anything else
   draws the block plain.
5. **Colours are CSS custom properties.** Seven token colours are set with
   `light-dark()` in `chat.css`, each meeting 4.5:1 on the code background
   and on both diff backgrounds in both themes (SPEC.md section 25.8).
   Colour only decorates: the language is named in text, and a diff line
   keeps its `+` or `-` mark.

## Alternatives rejected

- **Monaco's `colorize`.** The issue first proposed it, used only once the
  editor bundle had loaded. Monaco is megabytes, so either the chat pulls it
  in by itself, or code is coloured only after the student has happened to
  open an editor tab, which makes colouring look random. Its tokenizers also
  run in workers the chat does not otherwise need.
- **Shiki.** Accurate TextMate grammars, but its grammars and the Oniguruma
  WebAssembly engine weigh several times as much as highlight.js for the
  same languages, the engine needs `wasm-unsafe-eval` in the page's CSP or
  a slower JavaScript engine, and its themes write inline colours rather
  than our CSS variables.
- **`highlight.js/common` or the full build.** Brings in thirty to nearly
  two hundred languages students do not write in our courses.
- **Automatic language detection.** It runs every grammar over the block,
  which is slow on long blocks, and it is often wrong on short ones.

## Consequences

- A thirteenth language is one import and one alias line in `highlight.ts`.
- A diff is coloured line by line, so a construct that spans lines (a block
  comment, a multi-line string) is coloured only on the line where it
  starts to be recognisable.
- A diff is coloured only where its caller passes the file's path.
