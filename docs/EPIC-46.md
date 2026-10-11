# Epic 46: operator tests and package leftovers

Branch `epic/46-operator-tests`, cut from main 7d1be2ac. A fix batch, so
there was no architect design (WORKFLOW.md, "Epic plans"). The last task
folds this plan into SPEC.md, STATUS.md and ADR 0061 and deletes it.

## Issues

- #1492 Purge leaves Squid's include line and setup's `/usr/local` helpers behind.
- #1497 The workspace `/tmp` cap is small for parallel Playwright screenshots.
- #1472 Rehearsal: run roster sync against the mock LMS over https.
- #1463 Smoke test: NRPS roster sync and LTI Deep Linking checks.
- #1423 Smoke test: count the LTI launch checks as skipped when no mock LMS is registered.
- #1462 item c (moved here from Epic 47 because it touches the mock LMS): the mock LMS roster `role` action is used only by its own unit test; use it in a test or remove it.
- #1272 Install test: read `ExecMainStartTimestamp` and destroy the test workspace in a trap.
- #1264 Probe the worker's refusals on `::1` and the VM's own address too.
- #1262 Run `make backup-install-timer` and `backup-install-channel` on a VM set up with `make configure-vm`.

## Rulings

- R1 (#1492): purge stops and disables Squid, because setup configured it
  only for Portikus, and leaves `squid.conf` in place; a reinstall and
  setup bring it back. Purge deletes `/usr/local/sbin/portikus-storage-attach`,
  `/usr/local/sbin/portikus-thinpool-status` and `/usr/local/bin/dex`.
  The fold adds this to ADR 0061 and INSTALL.md says how to get Debian's
  own `squid.conf` back.
- R2 (#1497): raise the tmpfs cap on `/tmp` rather than fight Playwright's
  `--disable-dev-shm-usage`. Pick the smallest round size that passes the
  issue's four-worker full-page screenshot repro on the rehearsal VM, and
  never more than half of the default workspace memory limit (tmpfs pages
  count against the workspace's memory). Document what a course lab can
  expect. The image VERSION bump is the fold's job (2026.10.4).
- R3 (#1472, ruled 2026-10-10 in the issue): do not widen the proxy to
  plain-HTTP POST. The rehearsal mock LMS serves https, so roster sync
  goes through CONNECT like a real platform.
- R4 (#1423): with no mock LMS registered, the launch checks count as
  skipped with the reason "no mock LMS registered".
- R5 (#1262): if a target fails on a configure-vm VM, fix the target in
  the rehearsal task's PR. If configure-vm itself no longer works on a
  fresh VM, record the blocker in the issue and move on.
- R6: ADR 0063 and migration 0047 are reserved for this epic, if needed.

## Tasks

| Task | Issues | Agent | Owns |
|---|---|---|---|
| T1 purge | #1492 | infra | packaging/scripts/postrm; packaging/tests/*; e2e/site-jobs.ts only if a test needs it |
| T2 tmp-cap | #1497 | infra | infra/workspace-image/portikus.yaml (the /tmp mount only), infra/workspace-image/README.md, infra/tests/smoke/workspace-image.sh |
| T3 lti-smoke | #1472 #1463 #1423 #1462c | infra | packages/mock-lms/*; infra/tests/smoke/lti.sh; infra/tests/lti-platforms-test.sh; the Makefile rehearsal-lti block; infra/tests/smoke/helpers.sh (additions only) |
| T4 install-probes | #1272 #1264 | infra | infra/tests/install-test.sh; infra/tests/smoke/egress-proxy.sh; infra/tests/smoke/sign-in.sh |
| T5 rehearsal | #1262, VM proof of T1-T4 | infra | fixes found on the VM; the Makefile backup targets |
| T6 fold | all | builder | SPEC.md, STATUS.md, ADR 0061, INSTALL.md, VERSION; deletes this plan |

The rehearsal VM is one shared machine. T2 holds it first, then T3. T4
is verified by T5, which runs `make install-test` (a fresh VM) and a
configure-vm VM for the backup targets.

After the build tasks: code and security reviews (security because the
probes and the proxy are trust boundaries), fixes, confirmations, the
rehearsal, the fold, then the epic pull request.
