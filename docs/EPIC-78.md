# Epic 78: fix batch (sign-in hang, password eye, recovery double-click, test fixes)

Branch `epic/78-fix-batch`, cut from main 2ebe308d. A fix batch: no
architect pass. This plan is deleted by the fold task.

## Tasks

| Task | Closes | Owner (model) | Files it may touch | Starts after |
|---|---|---|---|---|
| T1 | #2239 page hangs after saving recovery codes when acceptable use is owed | builder (Sonnet, high) | `apps/web/src/second-factor/`, `e2e/acceptable-use.spec.ts`, `e2e/second-factor.spec.ts` | none (started from 2ebe308d) |
| T2 | #2238 eye icon to show or hide the password on the Dex sign-in page | infra (Opus, low) | `infra/ansible/roles/dex/`, `infra/tests/dex-render-test.yml`, a new spec under `e2e/` if the page can be served there | none |
| T3 | #2228 recovery-point double-click gets a false "already in progress" | builder (Sonnet, high) | `apps/api/src/routes/recovery.ts`, `apps/api/src/routes/recovery.test.ts` | none |
| T4 | #2236 security test's network probe outruns the connection limit | infra (Sonnet, high) | `infra/tests/security/network.sh` | none |
| T5 | #2233 the smoke test's 20-minute Codex wait | infra (Opus, low) | `infra/tests/smoke/`, and the Codex config writer in `apps/workspace-controller/` only if the finding needs it | none |
| T7 | #2241 setup: replace the deprecated `postgresql_set` with `postgresql_alter_system` | infra (Sonnet, high) | `infra/ansible/roles/postgresql/`, `infra/ansible/requirements.yml` | none |
| T6 | fold: STATUS.md, SPEC.md lasting rules, delete this plan | orchestrator | `docs/STATUS.md`, `docs/SPEC.md`, this file | T1-T5, T7 and the fix round |

All of T1-T5 and T7 run in parallel; no two touch the same files.

## Rulings

- Todd approved this plan on 2026-11-27, with the rehearsal VM run inside
  the epic, and added #2241 as T7.

- T1 sends the user to the next gate they owe (`gatePath(me) ?? "/"`) from
  both the continue button and the fallback redirect (SPEC.md 5.1, 24.13).
  As soon as T1 is verified, its build goes on the Kitestring lab VM
  (VM 140) for Todd's testing; the epic head is deployed there again later.
- T3 copies the restore fix from Epic 77 (#2219, PR #2226) inside
  `recovery.ts`, with no shared helper (SPEC.md 15.8).
- T5 starts with a diagnosis: the two smoke checks the issue names
  (`infra/tests/smoke/workspace-image.sh`) only grep the Codex config, so
  the agent first finds where the smoke run really spends the 20 minutes.
  If nothing in the smoke waits that long, it says so and changes nothing.
- T2's Playwright requirement: the agent chooses between serving the
  patched Dex template in the e2e environment and a check on the rendered
  page in `infra/tests/dex-render-test.yml`, and says why in its PR.

## Verification

- Each task: unit and e2e tests for what it touches, CI green on its PR.
- Reviews: code-reviewer over the epic; security-reviewer (T1 touches the
  sign-in gates, T2 the Dex page); a11y-reviewer (T1, T2).
- Rehearsal VM, one infra agent, after T1-T5 and T7 land: install the epic head,
  Dex sign-in file, `make build-workspace-image`, the full smoke, then
  `make security-test`. This is what proves T2, T4, T5 and T7.
- Lab VM: never `make smoke-test` or `make security-test` without Todd.
