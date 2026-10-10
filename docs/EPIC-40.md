# Epic 40: update Claude Code and Codex without rebuilding images

Plan for the epic branch `epic/40-agent-updates` only (docs/WORKFLOW.md,
"Epic plans"). The last task folds it into SPEC.md and ADR 0056 and
deletes it. Code, tests and other docs cite SPEC.md or ADRs, never this
file.

Issues: #1215 (main feature), #1373 (stopped Check, plus a real
"stopped" state), #1366 (flaky layout test), #1371 and #1393 (file pane
header). Base 4feb4b9a.

## Rulings (Todd, 2026-10-10)

- D1. Claude Code installs from the `stable` channel.
- D2. Workspaces on older images are repointed at each start: the
  controller writes `/usr/local/bin/claude` and `/usr/local/bin/codex`
  links to the shared folder into a stopped workspace's root file system,
  so every workspace moves to the shared tools at its next start.
- D3. Codex downloads are checked by GitHub's release-asset SHA-256
  cross-checked with `codex-package_SHA256SUMS`. No sigstore. Recorded as
  an accepted risk in ADR 0056.
- A Check ended by Stop is shown as a new state, `stopped`, not `failed`.

## Design (fixed names; every task relies on them)

Server folder `/var/lib/portikus/coding-agents/`, `root:root` 0755, on the
platform VM (the machine Incus runs on).

```
coding-agents/
  bin/claude -> ../claude/current/claude          (never changes)
  bin/codex  -> ../codex/current/bin/codex        (never changes)
  claude/<x.y.z>/claude
  claude/current -> <x.y.z>    claude/previous -> <x.y.z>
  codex/<x.y.z>/{bin/codex, codex-path/rg, codex-resources/...}
  codex/current -> <x.y.z>     codex/previous -> <x.y.z>
  .staging-<job id>/            (0700, only while a job runs)
```

- Links are relative. A switch writes a temporary link and renames it
  over the old one. Version names match
  `[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}` before any path join.
- The whole folder (not the `current` link, which a bind mount would
  freeze) reaches every workspace through a profile disk device
  `coding-agents`: `source=/var/lib/portikus/coding-agents
  path=/opt/portikus/coding-agents readonly=true`.
- New images: `/usr/local/bin/claude -> /opt/portikus/coding-agents/bin/claude`,
  the same for `codex`, and an empty `/opt/portikus/coding-agents`. The
  npm install of both tools leaves the recipe.
- Older images: the controller writes those same two links at each start
  (D2). `/usr/local/bin` is ahead of `/usr/bin` on the PATH.
- The root image job (`packaging/image/image-job`) gains three commands
  under its existing lock:
  - `agents-update` (a job on the admin page): download both tools,
    verify, unpack to staging, health-check each in a throwaway
    `imgcheck-<hex>` container from the default image as the student,
    switch each tool that passes on its own, prune.
  - `agents-rollback {tool}`: swap `current` and `previous` for one tool.
  - `agents-seed` (setup only, not a job): install the pinned version of
    any tool with no `current`, with its SHA-256 pinned in image-job.
- Claude Code: version from
  `https://downloads.claude.ai/claude-code-releases/stable`;
  `<v>/manifest.json` verified with `gpgv` against a keyring shipped in
  the package (fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`);
  `<v>/linux-x64/claude` checked against the manifest's SHA-256.
- Codex: `https://api.github.com/repos/openai/codex/releases/latest`,
  tag `rust-v<semver>`, asset
  `codex-package-x86_64-unknown-linux-musl.tar.gz` from a URL the job
  builds itself; digest plus `codex-package_SHA256SUMS`.
- Unpacking: only regular files and folders; no absolute paths, `..`,
  links, devices, setuid or setgid; size and member caps; then
  `root:root`, modes 0755 or 0644.
- Keep three versions per tool; never prune `current`, `previous`, or a
  version a running process uses (compare `/proc/<pid>/exe` device and
  inode).
- Job status file: `images/coding-agents.json`:
  `{claude:{current,previous,kept[]}, codex:{...}, updatedAt}`.
- Contract (`packages/contracts/src/image.ts`): `ImageJobKind` gains
  `agents-update` and `agents-rollback`; `ImageJobRequest` gains
  `{kind:"agents-update"}` and `{kind:"agents-rollback", tool}` with
  `CodingAgentTool = "claude" | "codex"` (strict: no version or URL);
  `CodingAgentsFile`; `AdminImage.codingAgents: CodingAgentsFile | null`.
  Error code `CODING_AGENT_NO_PREVIOUS` (409).
- No database migration. Audit reuses `image.job_requested` and
  `image.job_finished` with the kind in metadata.
- `apps/workspace-agent/claude-managed-settings.json` gains
  `"DISABLE_AUTOUPDATER": "1"`.

## Tasks

| Task | Agent | Owns | Starts |
|---|---|---|---|
| T1 contract and API | builder | `packages/contracts/src/image.ts`, the error code in `packages/contracts/src/workspace.ts`, `apps/api/src/routes/admin-image.ts` and its test, `apps/workspace-agent/claude-managed-settings.json` | now |
| T2 root job | builder (spike first) | `packaging/image/image-job`, `packaging/image/tests/test_coding_agents.py`, `packaging/image/claude-code-keyring.asc`, `packaging/nfpm.yaml`, `scripts/build-deb.sh` | now |
| T3 server setup and image | infra | `infra/ansible/roles/portikus_workspace_profile/`, `infra/ansible/roles/workspace_image/`, `infra/workspace-image/` (recipe, VERSION, README), `infra/tests/smoke/workspace-image.sh`, `infra/tests/smoke/workspace-agent.sh`, `infra/tests/image-job-rehearsal.py` | now |
| T7 repoint old images (D2) | builder | `apps/workspace-controller/src/` (the start path that writes `/etc/codex/config.toml`) and its tests | now |
| T8 stopped Check state | builder | `packages/contracts/src/checks.ts`, `apps/workspace-agent/src/checks-route.ts` and test, the Checks UI in `apps/web`, a Checks e2e spec | now |
| T4 admin page | ui-designer | `apps/web/src/admin/image/` (new `CodingAgentsSection`, `ImageTab.tsx`), `apps/web/src/help/content/admin.tsx`, `e2e/admin-image.spec.ts`, `e2e/image-jobs.ts`, `e2e/a11y-image.spec.ts` | after T1 |
| Reviews | code, security, a11y reviewers | none | after all code |
| T5 rehearsal VM | infra | none (verification) | after reviews |
| T6 fold | builder | `docs/SPEC.md`, `docs/STATUS.md`, ADR 0056, `docs/INSTALL.md`, `docs/OPERATIONS.md`, deletes this file | last |

Already landed: #1394 (#1366), #1395 (#1373 first half). In flight:
#1396 (#1393, #1371).

## Rehearsal (T5)

Install the epic head on the rehearsal VM (setup runs the seed). An
old-image workspace gets the mount live and, after a restart, runs the
shared tools. A new image passes its health check through the folder.
Open a `claude` session, run **Update coding agents**, confirm the open
session survives and a new `claude --version` shows the new version.
Roll back each tool. Full smoke test, no avoidable skips.

## Left out

A scheduled update check, picking a version, per-course versions
(#1246), Playwright browsers in the folder (#1361), backups of the
folder (it can be downloaded again).
