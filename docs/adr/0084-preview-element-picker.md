# 0084. Picking an element in the application preview

- **Status**: Accepted (Epic 75)
- **Date**: 2026-11-19
- **References**: SPEC.md sections 14.6, 24 and 25.8; BROWSER-HANDLING.md sections 12, 13 and 16.4; STACK.md section 15; ADR 0012, ADR 0032; issue #1708

## Context

A student building a web page often cannot say which part of it they mean.
Pointing at it gives the agent exact context. Picking needs a script that runs
inside the student's page, so it can find the element under the pointer, and a
channel from that page back to the Portikus page. The preview runs the
student's app on a separate origin, and SPEC.md section 24 says that code is
hostile: it must not forge a pick or reach the Portikus window, and a
screenshot must not show anything outside the preview. Issue #1708 asked for
this design to be reviewed against section 24 before it was built. The
security-reviewer did that, and Todd ruled on the open choices on 2026-11-19.

## Decision

1. **A Portikus wrapper page on the preview origin.** An embedded preview's
   bootstrap redirects to the reserved path `/__portikus/frame/` instead of
   `/`. That page belongs to Portikus. It holds the student's app in a
   full-size inner frame whose address is `/`, and it carries the picker.
   The student's HTML is never rewritten, so BROWSER-HANDLING.md section 13
   stands. A preview opened in its own tab still goes straight to `/`.
   Two other ways in were rejected:
   - **Caddy inserts a script tag into the app's HTML.** It rewrites the
     student's page, which section 13 forbids. It needs a third-party Caddy
     plugin we would then have to build and trust. A strict Content Security
     Policy (CSP) on the app would also switch it off.
   - **The student adds a script tag.** It teaches nothing, breaks when the
     tag is lost, and fails on any app that was not built with it.
2. **Plain `postMessage`, with checks and no secret.** The student's page
   shares the wrapper's origin, so a secret handed to the wrapper could be
   read by the student's page too. It would add code and protect nothing. The
   Portikus page accepts a message only when `event.origin` is the grant's
   preview origin, `event.source` is the outer frame's window, pick mode was
   started by the student, and it is the first `picked` message since that
   start. It sends with `targetOrigin` set to the preview origin. The wrapper
   acts on start and stop only when `event.source` is its own parent. Every
   message is checked against a versioned schema with length limits and is
   never rendered as HTML.
3. **The screenshot is drawn inside the page.** One pinned library renders the
   picked element from the preview's own document. There is no screen-capture
   prompt, and the picture cannot contain anything outside the preview,
   because the Portikus page was never part of what was drawn. It is close to
   the real page but not exact: fonts, canvases and cross-origin images may
   differ. Tab capture was rejected because it asks the student for
   permission each time and sees the whole tab, Portikus included. The
   library's requests to other origins send no credentials. The Portikus
   page checks the PNG signature and size before it builds the file, and
   sets the file type itself.
4. **What "cannot forge" means.** Another origin cannot send a pick: not a
   popup, another preview, another tab, or a cross-origin frame inside the
   student's page. A message sent straight from the student's inner window is
   refused, because its source is not the wrapper. No pick is accepted outside
   pick mode, a second pick is refused, and pick mode ends when the frame
   reloads or the grant changes. Nothing in a pick chooses the file path, the
   agent or a keystroke: the Portikus page picks the folder, and only the
   quoted paths and a space are typed, never Enter.
   It does not mean the content is true. Any script on the preview origin (the
   student's code, code the agent wrote, a third-party script) can change what
   a pick contains. We accept that. The student is picking their own page,
   which can already write files in their workspace. The risk that matters is
   prompt injection: page text that tells the agent to do something. The
   mitigation is a header in the Markdown file that says everything inside the
   code fences came from the page and is to be treated as data, not
   instructions. That reduces the risk and does not remove it.
5. **Where the files go.** `.portikus/pastes/<stamp>/picked-element.md` and
   `picked-element.png`, in the drop folder that already has the 7-day
   cleanup and the Git exclude rule. The target agent is chosen before
   picking. A terminal gets the quoted paths typed with no Enter; a chat gets
   the two files as attachments. The platform never logs the picked content
   (STACK.md section 15, ADR 0012).

## How the security review's findings are answered

1. **The wrapper must pass the preview login check (high).** A plain file
   server would let another site open the wrapper as a normal tab, and its
   inner frame's request to `/` would count as same-site and carry the
   `SameSite=Strict` preview cookie, running the app outside the sandbox.
   The route sits behind the same login check as the app, checked as if the
   path were `/`, and refuses any request whose `Sec-Fetch-Dest` header is
   present and is not `iframe`. The wrapper builds no inner frame when it is
   the top window. A stopped workspace shows the usual stopped page.
2. **Header fields are checked (medium).** The port and the time come from
   the Portikus page, never from the message. The page path must be
   printable, start with `/` and be at most 2,048 characters, or it is left
   out. The selector and tag go inside code fences too.
3. **The screenshot bytes are checked (medium).** See decision 3.
4. **The wrapper listens only to its parent (low).** See decision 2.
5. **The library sends no credentials (low).** See decision 3.

The route sends its own strict CSP, with `frame-ancestors` set to the
Portikus origin, so another site cannot frame the wrapper. The wrapper holds
no token, path or terminal list, and the outer frame's sandbox is unchanged.

## Consequences

- An embedded preview now loads one extra Portikus-owned page before the
  student's app, and the 8-second load fallback keys on a `loaded` message
  the wrapper sends, not on the inner frame's own load.
- The app's own `X-Frame-Options` and `frame-ancestors` headers still apply
  to the inner frame, and the control plane's framing check is unchanged.
- A service worker that the student's app registers at the preview origin's
  root can now also answer for `/__portikus/frame/`. It gains nothing: it
  already controls every page on that origin, and the wrapper holds no secret
  (BROWSER-HANDLING.md section 16.4).
- A hostile script on the preview origin can still shape a pick's contents.
  That is the accepted risk in decision 4.
- Picking works only for embedded previews, inside one frame. A pick stops at
  a cross-origin frame or a shadow root, and it is hidden in a Traditional
  course and in an instructor's live-help view.

## Alternatives rejected

- **A secret handshake or a `MessageChannel`.** The student's page shares the
  origin and could read the secret or the port, so it adds code and no
  protection.
- **Tab capture for the screenshot.** See decision 3.
