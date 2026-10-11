# 0062. The image ships one pinned Playwright browser, linked into each student's home at login

- **Status**: Accepted (Epic 45)
- **Date**: 2026-10-11
- **References**: SPEC.md sections 4.4, 21.7, 23.6; issue #1361

## Context

The course teaches end-to-end tests with Playwright. A student's first
`npx playwright test` fails until the browser is downloaded (about 270 MB
into the home volume). The download needs egress, takes minutes, and every
student repeats it.

## Decision

The image ships `chromium-headless-shell` for one pinned Playwright
version in `/opt/ms-playwright`, with the libraries and one font family it
needs. A login script links the pinned build into
`~/.cache/ms-playwright`, Playwright's default location, and records it in
that folder's `.links` list so Playwright's own cleanup keeps it.
`PLAYWRIGHT_BROWSERS_PATH` stays unset.

A project on another Playwright version gets Playwright's own message and
runs `npx playwright install --only-shell chromium`, which installs into
the home volume and survives image rebuilds. The course pins
`@playwright/test` to the image's version. Each image refresh moves the
pin, to the newest release at least two weeks old.

## Consequences

- Only one Playwright version works with no download. Other versions cost
  one install per student.
- The image grows by about 136 MiB compressed and 483 MiB unpacked. Most of
  the library share comes from `libgbm1`, which pulls in Mesa and LLVM.
- Leaving the environment variable unset keeps Playwright's normal
  behavior, so a student's own installs and an `npx playwright install`
  work as the Playwright documentation says.
- In allow-list egress mode, installing another version's browser needs
  `cdn.playwright.dev` allowed (SPEC.md section 23.6).
- Only Chromium is shipped. Firefox and webkit projects that
  `npm init playwright` generates must be removed.
- The image manifest does not record the pin.
