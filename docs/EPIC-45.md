# Epic 45: workspace image and Docker cache

Branch `epic/45-image-and-docker`, cut from main 64fce435. A fix batch, so
there was no architect design (WORKFLOW.md, "Epic plans"). The last task
folds this plan into SPEC.md and deletes it.

## Issues

- #1361 Playwright's headless Chromium in the workspace image, with no setup.
- #1481 A chip on the Workspace image tab when a newer Claude Code or Codex is out.
- #1278 Dedicated error codes for the Docker cache and seed match.
- #1279 The Docker tab shows unpacked sizes and digest-pinned names.
- #1280 The first seed build is queued after setup.

## Rulings

- R1 (Todd, #1361): the image ships one pinned `chromium-headless-shell`
  in `/opt/ms-playwright`. A login script links it into each user's
  `~/.cache/ms-playwright`, so `PLAYWRIGHT_BROWSERS_PATH` stays unset and
  Playwright's default home location works. A project on another
  Playwright version gets Playwright's own message and installs
  `npx playwright install --only-shell chromium` into the home folder. The
  course pins `@playwright/test@<pinned>`. Each image refresh bumps the pin.
- R2 (#1481): the issue's proposed approach and "Must hold" list stand
  as written. There is no new outbound path from the API or the worker.
- R3 (#1280): the default seed list is written, and the first build
  queued, by the platform itself (the API or the worker at start), not by
  the Debian maintainer scripts. Epic 44 owns those scripts this run, and
  the platform already writes the list today.
- R4: ADR number 0062 is reserved for this epic, if one is needed.
  Migration number 0046 is reserved.

## Tasks

| Task | Issues | Agent | Owns |
|---|---|---|---|
| T1 docker-errors-seed | #1278 #1280 | builder | apps/api/src/routes/admin-docker.ts and its test; ApiErrorCode (packages/contracts/src/workspace.ts, index.test.ts); DockerTab.tsx, SeedCard.tsx and their tests; text.ts clearErrorText and seedListError only; e2e/admin-docker*.spec.ts |
| T2 docker-sizes | #1279 | builder | packages/contracts/src/docker-cache.ts; the seed build size measurement (workspace controller and worker); text.ts downloadSize and listSizeText only; DownloadSize.tsx; UsageCard.tsx |
| T3 playwright-image | #1361 | infra | infra/workspace-image/*; infra/tests/workspace-image-*.yml; SPEC.md section 21.7 |
| T4 agent-chip | #1481 | builder | packaging/image/*; packaging/systemd/portikus-image-check.*; packages/contracts/src/image.ts; apps/api/src/routes/admin-image.ts; apps/web/src/admin/image/*; e2e/admin-image.spec.ts |
| T5 fold | all | builder | SPEC.md, STATUS.md, the ADR if any; deletes this plan |

After the build tasks: code, security and accessibility reviews, fixes,
confirmations, a rehearsal-VM run (a new image with the browser, the
Docker tab, and the image check), the fold, then the epic pull request.
