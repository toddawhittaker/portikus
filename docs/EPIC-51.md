# Epic 51: fix batch after Epics 48 to 50

A fix and polish batch for what Epics 48, 49 and 50 left behind, plus
faster browser-test CI. No migration, no ADR, no architect report (fix
batch). Branch `epic/51-fix-batch`, cut from main 90d87536. This plan
lives only on the epic branch; the fold task (T11) folds its lasting
rules into SPEC.md and deletes it (WORKFLOW.md, "Epic plans").

## Tasks

Wave 1 runs in parallel from the epic head after this plan lands. Each
task owns only its listed files.

| Task | Issue | What | Agent | Owns |
|---|---|---|---|---|
| T1 | #1585 | A linked course account's workspace is archived only after its in-flight provisioning settles, so no container is left behind | builder | the account-linking and workspace-archive code in apps/api and apps/worker |
| T2 | #1578 | Find and fix the signed apt repository check's "key is not bound" flake | infra | scripts/tests/publish-apt-repo-test.sh and the publish script it tests |
| T3 | #1562 | The fork-cap check test waits on the real condition, not a fixed time | tester | apps/workspace-agent/src/checks-route.test.ts (and the route only if the test exposes a real bug) |
| T4 | #1576 | `make deploy-app` followed by `make smoke-test` from one checkout works | infra | Makefile smoke-test and build-deb targets, packaging build scripts |
| T5 | #1577 | The instructor's live help terminal fits the window and keeps its heading visible | ui-designer | the instructor live help view in apps/web and its own styles (not app.css) |
| T6 | #1575 | A per-user rate limit on the instructor live help terminal socket route | builder | the live help terminal route in apps/api and its tests |
| T7 | #1550, #1551 | Standalone pages reflow at 320 px; pinch-zoom works inside the workspace shell on touch | ui-designer | `.pk-root` in apps/web/src/app.css, the panel touch-action override |
| T9 | #1568 | Split packaging/site/site-job along its jobs, no behaviour change | infra | packaging/site |
| T10 | re-shard | Browser tests run in 7 CI shards, with refreshed shard timings | builder | .github/workflows/ci.yml (the e2e shard matrix only), e2e/shard-timings.json |

Wave 2, from the epic head after T5, T6 and T7 land:

| Task | Issue | What | Agent | Owns |
|---|---|---|---|---|
| T8 | #1564 | Split apps/api/src/routes/preview.ts, projects.ts and apps/web/src/app.css under 800 lines, no behaviour change | builder | those three files and their new siblings |

After every task lands: code-reviewer over the epic head; security-reviewer
(T6 touches the workspace-agent socket path; T1 touches account linking);
a11y-reviewer (T5, T7). Findings are fixed through further task PRs and
confirmed by each reviewer. Then a full rehearsal-VM install and smoke
test, then the fold.

| Task | What |
|---|---|
| T11 | Fold: STATUS.md section from the task PR bodies, SPEC.md updates (lasting rules only), delete this plan, close the issues |

## Rulings

- The re-shard goes from 5 to 7 browser-test shards. The repository is
  public, so Actions minutes are free; the cost is two more concurrent
  jobs per CI run (19 of the account's 20).
- T4 should stop the build from pruning the developer's checkout if that
  is simple; a reinstall step in the smoke-test target is the fallback.
- T6 follows the pattern of the existing per-user limits on the student's
  start and typing routes; no new limiter.
