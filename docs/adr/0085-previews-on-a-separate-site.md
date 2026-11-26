# 0085. Previews on a separate registrable domain

- **Status**: Accepted (Epic 76)
- **Date**: 2026-11-26
- **References**: SPEC.md sections 14.6, 24.3, 24.7 and 24.10; BROWSER-HANDLING.md section 7.2; STACK.md section 13; ADR 0018, ADR 0084; issue #1236

## Context

BROWSER-HANDLING.md section 7.2 prefers a preview suffix that is a registrable
domain of its own (`portikus.school.edu` with `*.portikus-preview.net`),
because a student's page then shares no parent domain with the app and cannot
plant cookies on it. The cost is that an embedded preview is cross-site, and a
browser may drop the preview cookie as a third-party cookie. Epic 76 put
Portikus behind a Cloudflare Tunnel on two domains (the Kitestring lab) and
made this layout work. Real browsers differ on what they allow, and we could
test only some of them.

## Decision

1. **The cookie is chosen from the request, by `Sec-Fetch-Site`.** When an
   embedded grant's bootstrap arrives with `Sec-Fetch-Site: cross-site`, the
   preview cookie is `Secure; SameSite=None; Partitioned`: the browser keeps
   it per Portikus top-level site and sends it only inside that site's frame.
   In every other case (a missing header, `same-site`, `same-origin`, and every
   grant for a tab) it stays `SameSite=Strict`. The reset route expires cookies
   with the attributes they were set with. Same-site layouts change nothing.
2. **A tab is the fallback.** A preview in its own tab is a top-level page, so
   its `Strict` cookie works in every browser. The bootstrap answers 200 with
   a small page whose meta refresh moves the browser on, not a 303: a redirect
   leaves a cross-site chain that withholds the new `Strict` cookie in real
   Chromium ("Preview session ended"). This replaces the redirect in ADR 0084's
   first decision; the wrapper page address is the same.
3. **A refused cookie is detected, not guessed.** The API remembers each
   embedded bootstrap for 60 seconds (host and client address, in memory,
   10,000 entries at most). A framed request with no preview cookie at all, on
   that host and from that address inside the window, is a refused cookie, and
   the frame offers the preview in a new tab. A session that really ended still
   sends its revoked cookie, so it keeps its own message. The remembered
   window is a heuristic: a second browser behind the same address within 60
   seconds could be told the wrong thing, which costs one extra click.
4. **No public-suffix list.** Deciding "same site" from the two host names
   needs the public suffix list, a dependency that ships stale and is wrong for
   a private suffix. The browser has already decided, and says so in
   `Sec-Fetch-Site`, so the platform reads that.
5. **WebKit is an opt-in test project.** `playwright.config.ts` adds a
   `webkit` project only when `PORTIKUS_E2E_WEBKIT=1`. CI installs only
   Chromium, and Playwright's WebKit keeps no cookie that was set inside a
   cross-site frame, partitioned or not, so it cannot show that the embedded
   case works. Its tab-fallback test does pass. Playwright's Chromium stores a
   `Partitioned` cookie with no partition key, so the end-to-end tests cannot
   prove the partitioning either; real Chrome partitions it.

## Consequences

- On real Safari the embedded preview is expected to show "Preview blocked by
  your browser" with an Open in new tab link, and the tab works. The message
  has not been tried on real Safari, so this is an open item in STATUS.md.
- A cross-site reset clears only partitioned storage; a service worker a tab
  registered survives it. Cookies a student's own app sets inside a cross-site
  frame work only if the app sets `SameSite=None; Partitioned` itself.
- Hot-reload sockets (HMR) are not covered by an end-to-end test, because a
  Playwright WebSocket stand-in cannot see the upgrade's cookies.
- Nothing is added to the dependency list.

## Alternatives rejected

- **Decide with the public suffix list.** See decision 4.
- **Always set `SameSite=None; Partitioned`.** It would weaken the tab's cookie
  where `Strict` already works, and same-site installs would change for no
  gain.
- **An unpartitioned `SameSite=None` cookie.** Browsers that block third-party
  cookies drop it in a frame; that is the failure this decision works around.
- **Add WebKit to CI.** It cannot test the case that matters (decision 5), so
  it would add run time and pass without proving anything.
