# Epic 71: test reliability fix batch

Branch `epic/71-test-reliability`, base commit `cc57b08f` (main after
Epic 70). Scope: GitHub issues #2098, #2126, #2125, #2045 and #2074.
This file goes away at the fold.

## Rulings that apply (Todd, 2026-11-17)

- The batch is option 1 from the post-Epic 70 review: make CI and local
  runs trustworthy before the next feature epic.
- **#2074 recent activity.** The workspace detail view's recent audit
  list leaves out `api_key.used` rows. They stay in the full Audit tab.

## Facts checked

- CI installs Ubuntu packages through `.github/actions/apt-install`,
  which runs `scripts/ci-apt-install.sh`. On a cache miss that script
  downloads from kernel.org's mirror only, with `Acquire::Retries=3`.
  Ubuntu's own mirrors are skipped on purpose, because runner lookups of
  them can hang. A cache hit needs no network.
- `apps/api/src/api-keys/gate.ts` writes one `api_key.used` row in an
  `onResponse` hook for every key-signed request. An MCP tool call runs
  its operation through a second, internal request, so the hook runs for
  both `POST /mcp` and the inner route. `apps/api/src/mcp/factory.ts`
  writes its own row only for a call refused before any route sees it.
- `recentAudit` in `apps/api/src/routes/admin-workspaces.ts` feeds the
  detail view's list (`apps/web/src/admin/workspace-detail/AuditSection.tsx`).
- The smoke check's terminal creates are in `infra/tests/smoke/`
  (`projects.sh` line 122, `chat.sh` line 38, sourced from `terminals.sh`).

## Design

- **#2098 and #2126.** Replace wall-clock bounds with fake timers or
  event-based waits. Where a test does real work, do less of it (smaller
  fixture) or give that one test a longer timeout with a comment saying
  why. No global timeout raise. Each fix is checked by running the test
  under load (for example `stress-ng --cpu $(nproc)`, or the whole suite
  running at once) and showing it passes repeatedly.
- **#2125.** On a cache miss, if the kernel.org `update` or download
  fails after its retries, swap the URIs to a second non-Ubuntu mirror
  that carries the same suites and the security pocket
  (`https://mirrors.mit.edu/ubuntu/`, checked by fetching its `Release`
  file for the runner's suite first) and try once more. Add a connect
  timeout so a dead mirror fails fast. Ubuntu's own mirrors stay untried.
  If the MIT mirror lacks the suite, the builder stops and reports.
- **#2045.** Find what the second terminal create waits on (likely the
  workspace agent or tmux not yet ready after the first create, or the
  start not yet verified) and make the smoke check wait on that signal,
  with a bounded wait and a clear failure message. Look at the Codex
  chat probe's "socket error" in the same run for the same cause. If the
  root cause is in the API or agent rather than the check, stop and
  report before changing app code.
- **#2074.** The MCP tool handler marks the outer `POST /mcp` request when
  a tool call reaches an inner route (whose own row names the operation)
  or writes its own refusal row. The gate's `onResponse` skips a marked
  request. Requests that run no operation (tool list, handshake) stay
  unmarked and keep their row (SPEC.md section 24.11). `recentAudit`
  adds `action <> 'api_key.used'`.

## Tasks

| Task | Agent, model | Machine | Files it owns | Issues | Starts after | Playwright |
|---|---|---|---|---|---|---|
| T1 unit test timing | tester, Opus low | desk | `apps/workspace-agent/src/file-names.test.ts`, `apps/worker/src/reconcile.test.ts`, `apps/web/src/work/CsvView.test.tsx`, `packages/db/src/db.test.ts`, the workspace-agent watch test and the preview test it finds; the code under test only if a test cannot be fixed otherwise (named in the report) | #2098, #2126 | none | no |
| T2 CI apt fallback | builder, Sonnet high | local | `scripts/ci-apt-install.sh`, `.github/actions/apt-install/action.yml` | #2125 | none | no |
| T3 smoke terminal wait | infra, Opus medium | local (owns the rehearsal VM) | `infra/tests/smoke/*.sh`, `infra/tests/smoke-test.sh` | #2045 | none | no |
| T4 one audit row per MCP call | builder, Sonnet high | pve | `apps/api/src/api-keys/gate.ts`, `apps/api/src/mcp/factory.ts`, `apps/api/src/mcp/server.ts` if needed, `apps/api/src/routes/admin-workspaces.ts`, their tests, `e2e/admin-workspaces.spec.ts` | #2074 | none | yes (detail view) |
| T5 fold | builder, Sonnet high | local | `docs/STATUS.md`, `docs/SPEC.md` (section 29 entry; 24.11 note that one MCP call writes one row), delete this plan | all five | T1 to T4 | no |

All four work tasks run at once in one wave. T5 is drafted while the
reviews run.

## Reviews

- code-reviewer over the epic head, always.
- security-reviewer for T4 (audit trail of key use, SPEC.md section 24).
- No a11y review: the only visible change is one fewer row type in an
  existing list.

## Rehearsal

T3 changes the smoke check, so the infra agent runs the full smoke on a
fresh rehearsal VM with the Dex sign-in file, at least three times in a
row, all green.
